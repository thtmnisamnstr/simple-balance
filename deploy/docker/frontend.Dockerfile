# The browser bundle, served by nginx, with everything the API owns proxied
# through to the server container. Build from the repository root:
#
#   docker build -f deploy/docker/frontend.Dockerfile -t simple-balance-frontend .
#
# Point SB_API_ORIGIN at the API Service. Cookies are set by the API and read by
# the browser, so both have to be reached on one origin: this container is that
# origin, and APP_BASE_URL on the server has to name it.
#
# Both bases are pinned by digest as well as by tag, for the reason the three
# Node images give: a tag moves, so the tag alone is not a build anybody can
# reproduce, and the digest is what the `base.digest` label below claims of the
# runtime stage. `.github/dependabot.yml` watches Docker so neither pin freezes,
# and the `apk upgrade` below still takes whatever Alpine has published since.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build:client

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS runtime
ARG APP_VERSION=0.1.5
# `created` and `revision` are deliberately absent. A Dockerfile cannot emit a
# label conditionally, so a defaulted ARG would give every hand-built image
# `org.opencontainers.image.revision=""`, which reads to a consumer as known and
# empty rather than as absent. They belong to the builder that knows them, which
# is the release workflow.
LABEL org.opencontainers.image.title="Simple Balance frontend" \
  org.opencontainers.image.description="Simple Balance browser bundle, served by nginx" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.licenses="AGPL-3.0-only" \
  org.opencontainers.image.source="https://github.com/thtmnisamnstr/simple-balance" \
  org.opencontainers.image.url="https://github.com/thtmnisamnstr/simple-balance" \
  org.opencontainers.image.documentation="https://github.com/thtmnisamnstr/simple-balance#readme" \
  org.opencontainers.image.base.name="nginxinc/nginx-unprivileged:1.29-alpine" \
  org.opencontainers.image.base.digest="sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6"
# The three Node images apply this too. Left out here, the one image that
# actually terminates traffic was the one shipping whatever its base last built
# with. Root only for the upgrade: the base image runs as uid 101 and everything
# after this has to run as that user again.
USER root
RUN apk upgrade --no-cache
USER 101
# 8080 rather than 80: the unprivileged image runs as a non-root user, which
# cannot bind a privileged port.
ENV SB_FRONTEND_PORT=8080
ENV SB_API_ORIGIN=http://simple-balance-server:3000
# A CSV arrives as a JSON string, and the API sizes its own limit for those
# routes at CSV_MAX_BYTES x 6 plus 64 KiB for worst-case escaping. 12m was under
# that, so nginx refused bodies the server behind it would have taken.
ENV SB_MAX_UPLOAD_SIZE=61m
# Only SB_ names are substituted, so nginx's own $host and $remote_addr are not
# blanked out by an envsubst pass that does not know the difference.
ENV NGINX_ENVSUBST_FILTER=^SB_
# The rendered result replaces the image's own default server rather than
# sitting beside it. Two servers listening on one port with server_name _ is a
# conflict nginx resolves by picking whichever the include glob reached first.
COPY deploy/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
# Outside /etc/nginx/templates on purpose: the entrypoint runs envsubst over
# everything in there, and outside /etc/nginx/conf.d, which the main config
# includes into http{} where a location-scoped directive is a syntax error.
COPY deploy/docker/nginx-security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist/client /usr/share/nginx/html
COPY LICENSE /usr/share/licenses/simple-balance/
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -q -O /dev/null http://127.0.0.1:${SB_FRONTEND_PORT}/ || exit 1"]
