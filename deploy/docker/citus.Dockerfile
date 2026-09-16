# PostgreSQL with Citus, for the `ha` profile's database. Build from the
# repository root:
#
#   docker build -f deploy/docker/citus.Dockerfile -t simple-balance-citus .
#
# This is the one image here that is not this product. It carries no application
# code, and its tag names Citus and PostgreSQL rather than the release — a
# database image's version belongs to its database, and coupling it to
# APP_VERSION would force a rebuild of PostgreSQL on every application release
# that never touched it. `scripts/set-version.mjs` therefore does not know about
# this file, deliberately, and `.github/workflows/citus-image.yml` publishes it
# on its own schedule.
#
# Built rather than adopted, for three reasons that are all about what upstream
# publishes rather than about Citus itself:
#
#   * Of the hundreds of tags in `citusdata/citus`, exactly one carries arm64 —
#     the floating `alpine` tag. Every `-pgNN` tag is amd64 only, by construction:
#     upstream's `publish_docker.py` hardcodes the amd64 platform for every image
#     type except alpine. This repository already publishes four multi-platform
#     images, so building a fifth is the smaller problem.
#   * That one arm64 tag is musl, and musl is the one base this application must
#     not have. Category and payee uniqueness rests on comparing normalized names
#     with the database's collation, and musl compares byte-wise whatever
#     collation is declared — `docs/deployment-sizing.md` carries the measurement.
#     So the platform we need and the libc we need do not meet in any published
#     artifact, from either direction.
#   * CVE-2026-15741 is a PostgreSQL core defect fixed in 18.0, and the published
#     Citus images sit on bases that predate the fixes for their own branches.
#     Pinning the base forward is the fix, and that means choosing the base.
#
# Pinned by digest as well as by tag, like every other image here: a tag moves,
# so `postgres:18` alone is not a build anybody can reproduce. The digest is the
# multi-platform index's rather than one architecture's, so an arm64 build still
# resolves its own image. `docs/citus-runbook.md` §Rebuilding says how to raise
# both together.
ARG POSTGRES_IMAGE=postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280

FROM ${POSTGRES_IMAGE} AS build

# 14.2.0 is the newest Citus there is. There is no 15: `main` gates PostgreSQL
# 17, 18 and 19 and has not been tagged, which is where the belief that "Citus 15
# drops 16" comes from — a statement about an unreleased branch. 14.2 gates on
# 16, 17 and 18, refusing anything else at configure time, so 18 is the newest
# database it can carry and therefore what every profile that owns its database
# runs.
ARG CITUS_VERSION=14.2.0
# Checked, not trusted. A source tarball fetched over the network and compiled
# into a database that holds people's money is exactly the place a supply-chain
# substitution would be worth making, and the checksum is what makes the build
# fail instead of succeed quietly. Raise it in the same commit as the version.
ARG CITUS_SHA256=df221da519cea3740b3a538b846ce0ce5bdc082c5f05321f0361b8f5edc57ff7

# Build dependencies only, and only in this stage — none of it reaches the image
# that runs. `postgresql-server-dev-18` is what supplies pg_config and the server
# headers the extension compiles against, and it comes from the same PGDG
# repository the base image is built from, so it matches the server exactly.
# libcurl is here because on PostgreSQL 18 it cannot be avoided, and the reason
# is worth writing down because `--without-libcurl` looks like it works.
#
# Citus uses libcurl for exactly one thing: reporting anonymous usage statistics
# to reports.citusdata.com. `./configure --without-libcurl` duly leaves
# `HAVE_LIBCURL` undefined in Citus's own `citus_config.h` — and then
# `statistics_collection.c` guards its `#include <curl/curl.h>` with a bare
# `#ifdef HAVE_LIBCURL`, which on PostgreSQL 18 is satisfied by *PostgreSQL's*
# `pg_config.h` instead: 18 added OAuth device-flow support and defines
# `HAVE_LIBCURL 1` for its own reasons. So the statistics code compiles while
# `-lcurl` is left out of the link, and the result is a `citus.so` that
# PostgreSQL refuses to load with `undefined symbol: curl_easy_perform`. That is
# what the first build of this file produced, and configure reported success
# throughout.
#
# So it is built with libcurl, which links, and the collection is turned off
# where it is actually decided — `citus.enable_statistics_collection` in the
# runtime stage below. The GUC defaults to on whenever libcurl is compiled in,
# which is now always, so leaving it unset would mean a self-hosted ledger
# phoning home.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        flex \
        libcurl4-openssl-dev \
        libicu-dev \
        libkrb5-dev \
        liblz4-dev \
        libssl-dev \
        libzstd-dev \
        postgresql-server-dev-18 \
    ; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN set -eux; \
    curl -fsSL -o citus.tar.gz \
        "https://github.com/citusdata/citus/archive/refs/tags/v${CITUS_VERSION}.tar.gz"; \
    echo "${CITUS_SHA256}  citus.tar.gz" | sha256sum -c -; \
    tar -xzf citus.tar.gz --strip-components=1; \
    rm citus.tar.gz

# Installed into a staging root rather than over the build stage's own
# PostgreSQL, so the runtime stage below copies an exact, known set of files
# instead of inheriting whatever the build left behind.
# `touch` in dependency order before configuring. A GitHub source archive gives
# every file the same timestamp, which is enough for make to decide `configure`
# is older than `configure.ac` and regenerate it mid-build. Stamping them in the
# order the Makefile expects stops that happening at all; the checks below catch
# it if it happens anyway.
RUN set -eux; \
    touch configure.ac; \
    touch aclocal.m4 2>/dev/null || true; \
    touch configure; \
    touch src/include/citus_config.h.in

RUN set -eux; \
    ./configure --with-libcurl; \
    make -j "$(nproc)"; \
    make install DESTDIR=/staging

# Proved, not assumed. The first build of this file reported success and produced
# a database that could not start, because nothing read the artifact. This does:
# the library must be there, and if it references curl it must also declare the
# library that resolves it. An unresolvable reference is the exact failure that
# got through before.
RUN set -eux; \
    lib=/staging/usr/lib/postgresql/18/lib/citus.so; \
    test -f "$lib"; \
    if grep -q curl_easy_perform "$lib" && ! grep -q 'libcurl\.so' "$lib"; then \
        echo "citus.so references libcurl without linking it — it will not load" >&2; \
        exit 1; \
    fi; \
    echo "citus.so links what it references"

FROM ${POSTGRES_IMAGE} AS runtime

ARG CITUS_VERSION=14.2.0

# Just the extension: the shared objects and the SQL that defines it. Nothing
# from the build stage's toolchain comes with them.
COPY --from=build /staging/usr/lib/postgresql/18/lib/ /usr/lib/postgresql/18/lib/
COPY --from=build /staging/usr/share/postgresql/18/extension/ /usr/share/postgresql/18/extension/

# Citus has to be loaded before the server accepts connections, and
# `shared_preload_libraries` is only read at startup. Appending to the sample is
# how it reaches a data directory initdb has not created yet — a setting written
# anywhere else would apply to every cluster except the first one this image
# starts, which is the one that matters.
# The runtime half of the libcurl decision above: the shared library so the
# extension loads, and nothing else from the toolchain.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends libcurl4; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    printf "\n# Added by simple-balance's Citus image. Citus must be preloaded.\nshared_preload_libraries='citus'\n" \
        >> /usr/share/postgresql/18/postgresql.conf.sample; \
    printf "# Off because this is somebody's ledger, not a product telemetry\n# sample. The GUC defaults to on wherever libcurl is compiled in, which on\n# PostgreSQL 18 is unavoidable — see the build stage.\ncitus.enable_statistics_collection = off\n" \
        >> /usr/share/postgresql/18/postgresql.conf.sample; \
    grep -q "shared_preload_libraries='citus'" /usr/share/postgresql/18/postgresql.conf.sample; \
    grep -q 'citus.enable_statistics_collection = off' /usr/share/postgresql/18/postgresql.conf.sample

# Runs once, on a data directory being created. `IF NOT EXISTS` because the
# coordinator of an existing cluster may be restored into a fresh volume, and a
# hard failure there would turn a restore into an outage.
RUN set -eux; \
    printf "CREATE EXTENSION IF NOT EXISTS citus;\n" \
        > /docker-entrypoint-initdb.d/001-citus.sql

LABEL org.opencontainers.image.title="simple-balance-citus" \
      org.opencontainers.image.description="PostgreSQL 18 with Citus for the Simple Balance ha profile" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance"
