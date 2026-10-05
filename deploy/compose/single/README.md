# The `single` profile

**Two machines.** One runs the application and whatever terminates TLS; the
other runs PostgreSQL and has no public address at all. The application machine
is the only thing in the profile the internet can reach, and losing it loses no
data — that is what the split is for, and it is the same trade the profile has
always made, with the database end now built by the same `pulumi up` instead of
left to you.

Each grows by being given more CPU and memory, and there is nothing in either to
scale out: one node lost is that half down until it comes back. The other
profile is `ha`, which is the Helm chart, and
[`docs/deployment-profiles.md`](../../../docs/deployment-profiles.md) is where the
choice between them is argued.

You can still bring your own database. Set `simple-balance:databaseNode: false`
and the second machine is never built; set `simple-balance:secrets.DATABASE_URL`
in the stack and the application machine behaves exactly as it did before this
directory had a `compose.postgres.yml` in it.

The application machine:

| File | What it is |
| --- | --- |
| `compose.yml` | The application. Complete on its own, given a `DATABASE_URL`. |
| `compose.caddy.yml` | An overlay that adds TLS, obtained and renewed by Caddy. |
| `compose.db-tls.yml` | An overlay that mounts the database's CA certificate into the application, for a `DATABASE_URL` that names one. |
| `Caddyfile` | What Caddy serves. Read by the Caddy overlay, not by `compose.yml`. |
| `.env.example` | Copy to `.env` on that machine. |

The database machine, which is a Compose project of its own and shares nothing
with the one above but the directory it is kept in:

| File | What it is |
| --- | --- |
| `compose.postgres.yml` | PostgreSQL 18, serving TLS, published on this machine's private address alone. |
| `pg_hba.conf` | Who may connect and how. Mounted over the one `initdb` writes, so every line that crosses a network says `hostssl`. |
| `db-init.sh` | Creates the unprivileged role the application signs in as, and hands it the database. Run once, by the entrypoint, on the boot that creates the cluster. |
| `.env.postgres.example` | Copy to `.env` on that machine. |

Skip the Caddy overlay if you already run nginx, HAProxy or a cloud load balancer.
Point it at the loopback port `compose.yml` publishes, and set `TRUST_PROXY=true`
in `.env` yourself — that is the one thing the overlay was doing for you, and
without it every visitor shares one sign-in allowance.

## Bring it up

The database machine goes first — see the section below, which is written
second because this is the machine you will spend your time on. The
application's first start runs the migrations, so it has nothing to do until
there is something to migrate.

```sh
cp deploy/compose/single/.env.example deploy/compose/single/.env
$EDITOR deploy/compose/single/.env          # DATABASE_URL, AUTH_SECRET, APP_BASE_URL
cd deploy/compose/single
docker compose up -d --wait
```

`--wait` is worth typing every time. Without it the command returns as soon as
the containers exist, which on a first start is several minutes before the
migrations have finished and the application is answering.

With TLS, once `SITE_ADDRESS` resolves to this machine and ports 80 and 443
reach it:

```sh
docker compose -f compose.yml -f compose.caddy.yml up -d --wait
```

The first start against an empty database creates the schema. There is no
migration step to run and no `initdb` to perform: point the application at a
PostgreSQL and it takes care of the rest, which is true however you run it.

## Bring the database machine up

On the other machine, and before the one above — the application waits for its
migrations and will sit failing readiness until there is something to migrate.

```sh
cp deploy/compose/single/.env.postgres.example deploy/compose/single/.env
$EDITOR deploy/compose/single/.env   # SB_BIND_ADDRESS, POSTGRES_PASSWORD, POSTGRES_APP_PASSWORD
cd deploy/compose/single
sudo install -d -m 0755 db-tls
sudo install -m 0644 server.crt db-tls/server.crt
sudo install -m 0600 -o 999 -g 999 server.key db-tls/server.key
sudo install -d -m 0700 -o 999 -g 999 /var/lib/simple-balance/postgresql
docker compose -f compose.postgres.yml up -d --wait
```

Four things there are not obvious and each one is a failure you would otherwise
meet later:

- **`999:999` on the key and the data directory.** That is the uid and gid the
  `postgres` Debian image gives its own user. PostgreSQL refuses a private key
  anybody but the database user or root can read — it exits with `private key
  file "..." has group or world access` — and the entrypoint chowns `PGDATA`
  but not the directory it is mounted at, so a root-owned parent leaves the
  server unable to traverse into its own files. On a machine
  `deploy/pulumi/` built, `simple-balance-db-firstboot` does both.
- **The data directory must exist before `up`.** `compose.postgres.yml` sets
  `create_host_path: false` on that bind, so a missing one is refused by name.
  With it left on, Docker would make the directory — on the boot disk — and
  PostgreSQL would initialise a brand new empty cluster into it and report
  itself healthy. A deployment that comes up green with an empty ledger is the
  worst thing this file could do.
- **The certificate's name has to be the name `DATABASE_URL` uses, and that
  name has to be a hostname.** The application connects under
  `sslmode=verify-full`, which checks the subject alternative name against the
  host in the URL. The Pulumi programs issue a certificate for the provider's
  own internal DNS name for the machine and put the pinned private address in
  it as well — but only one of those two spellings works from the application,
  and it is the hostname. `node-postgres` sets the TLS server name from the
  URL's host *only when that host is not an IP literal*
  (`net.isIP(host) === 0`, `pg/lib/connection.js`), and Node then falls back to
  checking the certificate against the string `localhost`, so a `DATABASE_URL`
  written with the address fails `verify-full` with `Host: localhost. is not in
  the cert's altnames` however many IP entries the certificate carries.
  Measured against `pg` 8.23 and a real PostgreSQL 18, not read off anything.
  `libpq` does verify an IP entry properly, which is what the second name is
  for: `psql "host=10.30.1.10 ... sslmode=verify-full"` works, and so do
  `simple-balance-backup` and `-restore`, which are `libpq` too.
- **`POSTGRES_APP_PASSWORD` is the application's, not the superuser's.**
  `POSTGRES_PASSWORD` belongs to `postgres`, which `pg_hba.conf` refuses over
  the network entirely; the application signs in as `simple_balance`, which
  `db-init.sh` creates and which owns the database and nothing else. The value
  that goes in the application machine's `DATABASE_URL` is the second one.

The five sizing numbers in `.env.postgres.example` are
[`docs/deployment-sizing.md`](../../../docs/deployment-sizing.md)'s smallest row,
applied as `-c` flags. Raise them with **this** machine's memory, not with the
application machine's — the two are sized separately, and only this one runs
PostgreSQL. Three more that describe the disk rather than the memory —
`random_page_cost`, `effective_io_concurrency` and `wal_compression` — are
literals in `compose.postgres.yml`, the same at every size, and are not in the
`.env` at all.

Growing the volume under `/var/lib/simple-balance` does not grow the filesystem
on it, on either cloud or by hand: the extra space is there, paid for, and
unreachable until `sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"`
has run. It is online, so nothing has to be stopped, and it says
`Nothing to do!` when there is none. On a machine `deploy/pulumi/` built,
`simple-balance-growfs.service` runs that at every boot for exactly this reason,
so a reboot is enough there — the first-boot scripts cannot be it, because
cloud-init runs them once per instance and a `pulumi up` that grows a volume
replaces no machine.

## The database's certificate

A database on another machine should be reached over TLS that checks who is
answering, or whoever can stand at that address is handed the password. That
takes the certificate of the CA that signed the database's, saved in one
place, named in `DATABASE_URL`, and mounted into the application by the
`compose.db-tls.yml` overlay:

```sh
sudo install -d -m 0755 /var/lib/simple-balance/tls
sudo install -m 0644 ca.pem /var/lib/simple-balance/tls/db-ca.pem
```

```sh
DATABASE_URL='postgresql://user:password@db.example.com:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem'
```

```sh
docker compose -f compose.yml -f compose.caddy.yml -f compose.db-tls.yml up -d --wait
```

Under the systemd unit the same list is `COMPOSE_FILE` in
`/etc/default/simple-balance`:
`COMPOSE_FILE=compose.yml:compose.caddy.yml:compose.db-tls.yml`, with
`compose.db-tls.yml` copied to `/opt/simple-balance` beside the others.

One string, read by two programs, and the same file to both. The overlay
mounts `/var/lib/simple-balance/tls` into the application, read-only and at that
same path, and node-postgres reads `sslrootcert` as a file and trusts it alone.
The nightly backup and the restore run `pg_dump` and `pg_restore` from a stock
`postgres:18` image, which trusts nothing — it has no CA bundle at all — so they
mount the file the URL names into that container, at that path, and point
libpq at it with `PGSSLROOTCERT`. A `verify-full` URL whose file is not there
is refused before anything connects, with the path it looked for. So is one
whose path has a `%`, a `+` or a comma in it: write it as it is on disk,
because node-postgres decodes a `+` to a space where libpq does not, and the
two would be reading different files.

The directory is 0755 and the file 0644 because the application reads it as
the image's own unprivileged user. A CA certificate is not a secret; it is what
the server hands every client that asks. The overlay never makes the
directory: when it is not there, `up` refuses and names it, which is why it is
made first. That is also why the mount is an overlay rather than a line in
`compose.yml`. A rootless Docker daemon cannot make a directory under
`/var/lib`, and a mount it cannot satisfy stops the application starting
whatever the URL says, so it is there only for a deployment that asked for it.

On a machine one of the Pulumi programs built, the directory is on the data
volume and already exists, `COMPOSE_FILE` already names the overlay, and
`DATABASE_URL` goes in the stack's `simple-balance:secrets`. A machine built by
an earlier release has neither: copy the overlay to `/opt/simple-balance`, add
it to that `COMPOSE_FILE` line, and make the directory, before naming a file.

`db.example.com` has to be a name the certificate carries. Use the hostname,
not an IP address, even one the certificate lists: node-postgres passes no
server name for an address and so checks the certificate against the name
`localhost`, which a database on another machine does not carry. libpq would
accept the address, so the backup working is no sign the application will.

**OCI Database with PostgreSQL.** Its certificates are issued by a private CA
that OCI manages ([Oracle's SSL tutorial](https://docs.oracle.com/en/learn/oci-pgsql-ssl/index.html)),
so the file is needed. The DB system's details page has a **Connection
details** section, and the CA certificate is there to download
([Connecting to a database](https://docs.oracle.com/en-us/iaas/Content/postgresql/connect-to-db.htm));
Oracle's page saves it as `dbsystem.pub`, and the name does not matter once it
is `db-ca.pem` here. The same certificate is the `caCertificate` of the DB
system's connection details in the API
([`ConnectionDetails`](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/psql/models/oci.psql.models.ConnectionDetails.html)),
which the CLI prints:

```sh
oci psql connection-details get --db-system-id <DB system OCID> \
  --query 'data."ca-certificate"' --raw-output > ca.pem
```

The host is the **FQDN** from the same section, which is the name Oracle's own
`verify-full` example connects to. The CLI prints that as well:

```sh
oci psql connection-details get --db-system-id <DB system OCID> \
  --query 'data."primary-db-endpoint".fqdn' --raw-output
```

```sh
DATABASE_URL='postgresql://admin:<password, URL-encoded>@<FQDN>:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem'
```

**Amazon RDS for PostgreSQL.** Its certificates are signed by Amazon's own RDS
root CAs, which neither Node nor Ubuntu carries, so the file is needed too:
the bundle AWS publishes for every commercial Region
([Using SSL/TLS to encrypt a connection](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)),
saved as it is. The host is the instance's endpoint.

```sh
curl -fsSo ca.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

**A provider whose certificate is from a public CA** — Neon's chains to Let's
Encrypt's ISRG Root X1 ([Neon's docs](https://neon.com/docs/connect/connect-securely)) —
needs no file. Leave `sslrootcert` out:

```sh
DATABASE_URL='postgresql://user:password@db.example.com/simple_balance?sslmode=verify-full'
```

The application checks that against the roots Node carries, and needs no
overlay. The backup and the restore mount this machine's own CA bundle for
libpq instead, the first of
`/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`,
`/etc/ssl/ca-bundle.pem` and `/etc/ssl/cert.pem` that exists, or the file
`SB_PG_CA_BUNDLE` names, and refuse to run when there is none. The nightly
unit and the restore read `SB_PG_CA_BUNDLE` from `/etc/default/simple-balance`;
a backup run by hand as `sudo /usr/local/bin/simple-balance-backup` sees it
only if it is in that command's own environment, and
`sudo systemctl start simple-balance-backup.service` is the run by hand that
reads the file. Neon's page suggests naming the operating system's bundle,
`sslrootcert=/etc/ssl/certs/ca-certificates.crt`. On Ubuntu, which is what the
Pulumi programs build, that works here too — the application image's own
bundle in one container and this machine's in the other — but leaving it out
says the same thing on any host. If your provider's documentation offers a
CA file, saving it as `db-ca.pem` and naming it is never wrong.

**A server you run yourself.** The CA that signed its `server.crt`, or, for a
certificate it signed itself, that `server.crt`.

Three spellings to avoid, each for a reason:

- `sslrootcert=system`. libpq's word for OpenSSL's default roots, and not
  node-postgres's: it reads `system` as a file name and the application does
  not start. In the `postgres:18` image it finds no roots either. The backup
  refuses it, as it refuses any relative path.
- `verify-ca`. Read two ways: node-postgres treats it as `verify-full` and
  checks the name, libpq checks the chain and not the name. With a file it is
  accepted, and the backup checks less than the application does. Without one
  the backup and the restore refuse it: all libpq would ask for is a chain to
  some public CA, which anybody can get for a host they control, and libpq
  refuses `verify-ca` with `sslrootcert=system` for that reason. `verify-full`
  means the same thing to both.
- `require`. node-postgres reads it as `verify-full` with no file, so it fails
  against exactly the private CA it is usually chosen for. With a file the
  application checks the certificate and the backup still does not.

What worked before still does, and the backup reads it exactly as it did.
`sslmode=no-verify` encrypts without checking, and the backup hands libpq its
spelling of that, `require`. Under `no-verify`, `require`, `prefer` or no
`sslmode` at all the backup mounts nothing, even when the URL names a file
that is there, so libpq goes on unverified as it always has. Mounting it would
change that: libpq handed a root file under `require` checks the chain with
it, and a `no-verify` URL naming a file that was never the right one would
start failing a backup that has always worked. Only `verify-full` and
`verify-ca` get the file, and only `verify-full` the bundle.

## The first account

While no account exists the server prints a one-time setup code to its log.

```sh
docker compose logs app | grep -i setup
```

Set `ALLOWED_EMAILS` to an address, or a domain, or `*`, and the code is not
needed at all — it is only ever read for an address the list would have turned
away. `docs/deployment.md` has the whole of that reasoning.

## Watch it

```sh
docker compose ps
docker compose logs -f app
curl -fsS http://127.0.0.1:3000/health/ready
```

`/health/ready` reports whether the migrations have run and the database
answers. `/health/live` reports only that the process is up, and touches no
database — which is why it is the one a restart policy should watch.

## Running it as a service

The compose file describes the deployment; systemd is what starts it after a
reboot and gives an operator one place to stop it. `../../systemd/` holds the
units, and `deploy/systemd/simple-balance.service` carries the installation
commands in its own header.

The division of labor is worth knowing because two process managers over the
same containers is a question people expect to be a problem:

- **systemd owns ordering and intent.** Boot, `systemctl start`,
  `systemctl stop`.
- **Docker owns crash recovery**, through `restart: unless-stopped`.

They do not fight, and the reason is one line: the unit's `ExecStop` runs
`docker compose down`, which removes the containers, so there is nothing left
for Docker's restart policy to bring back after a deliberate stop.

A setting changes the same way however the machine was built: edit it, then
`sudo systemctl restart simple-balance`, which takes the containers down and
brings them up on the new values. What you edit differs. Installed by hand, it
is `/opt/simple-balance/.env`, the copy the unit's header installs: the unit
runs from `/opt/simple-balance`, and `deploy/compose/single/.env` is read only
by a `docker compose` run in this directory, never by the unit. A machine one of
the single-machine Pulumi programs built has a drop-in beside the unit,
`simple-balance.service.d/env.conf`, that reassembles `/opt/simple-balance/.env`
from its parts before every start, so there a setting is the stack's —
`simple-balance:env` or `simple-balance:secrets`, then `pulumi up` — and an edit
to `.env` is overwritten at the next start. That drop-in exists only on those machines;
`deploy/pulumi/README.md` describes them.

## Backups

```sh
sudo systemctl enable --now simple-balance-backup.timer
systemctl list-timers simple-balance-backup.timer
```

A daily `pg_dump` in PostgreSQL's own compressed format, verified by reading it
back before it is kept, into `SB_BACKUP_DIR` with `SB_BACKUP_KEEP` generations
retained. Run one by hand with `sudo /usr/local/bin/simple-balance-backup`. It
connects with the application's own `DATABASE_URL`, and under `verify-full` it
checks the database's certificate exactly as the application does: [the
database's certificate](#the-databases-certificate) is how. Under two other
modes the two part ways. With `require` and a file, the application checks the
certificate and the backup does not; with `verify-ca`, the application checks
the name and the backup only the chain. Both are reasons to write
`verify-full`. Running a backup by hand straight after changing the URL finds
most mistakes in it, but not all: the application's check can still fail on a
URL whose host is an IP address, for the reason above.

A dump is a copy of the data and not of the machine. The question worth asking
about `SB_BACKUP_DIR` is whether it is somewhere that outlives the host.

`SB_BACKUP_KEEP + 1` is what that disk has to hold, not `SB_BACKUP_KEEP`: the
dump being written sits beside the kept ones until it has verified, and only
then is the oldest pruned. So the space is `(keep + 1) × 0.145 ×` the live
ledger — 0.145 is the measured ratio of a `pg_dump -Fc` to the database it came
from, and `docs/deployment-sizing.md` derives it — which at any real size is the
largest thing on this machine's disk —
larger than the ledger is on the other one. Setting `SB_BACKUP_KEEP` to 3 and
copying the dumps off is a quarter of the disk for the same protection.

To restore:

```sh
sudo /usr/local/bin/simple-balance-restore /var/backups/simple-balance/simple-balance-20260914T031500Z.dump
```

Run it on the application machine, which is where the backups are. It reads the
archive before it touches anything, stops the application so nothing writes into
a half-restored ledger, empties the database, restores into it, and starts the
application again — which also applies any migration the dump predates. That
last part is the supported way to restore an old backup onto a new release.

How it empties the database depends on where the database is, and the difference
is worth knowing if you are watching the output. On a machine that runs the
database as a service in its own Compose project, it drops and recreates the
database over the container's socket as the superuser. Across the network — the
two-machine shape — it connects as the application's own role and runs
`drop schema public cascade` instead, because that role can reach exactly one
database and has no `CREATEDB`. Both leave nothing the dump does not mention,
and neither needs a privilege the profile does not already grant.

## Tear it down

```sh
docker compose down
```

That is the whole of it, and it deletes nothing: this profile runs the
application and whatever terminates TLS, and the ledger is in a database
somewhere else. There is no `-v` to be careful about here, because there is no
volume holding anybody's money — removing this deployment removes a web server.
Deleting the ledger means deleting the database you pointed `DATABASE_URL` at,
wherever that is, which is a decision taken over there.

## The things that have to line up

- **`APP_BASE_URL` and the address in the browser.** The API sets the cookies
  the browser reads and compares every state-changing request's `Origin`
  against this value. Get it wrong and pages load while every write is refused.
- **`SITE_ADDRESS` and the host in `APP_BASE_URL`**, when Caddy is terminating.
  Same reason.
- **`TRUST_PROXY` and what is actually in front.** True with nothing in front
  lets a caller write their own address and take as many sign-in attempts as
  they like. False behind a terminator puts every visitor in one bucket. The
  server says at startup which of the two it is doing.
- **The host in `DATABASE_URL` and the name in the database's certificate**,
  under `verify-full`. A hostname the certificate carries, never an address.
- **The file `sslrootcert` names and the directory `compose.db-tls.yml`
  mounts.** The URL is read inside the application container and on the host,
  so the file has to be under `/var/lib/simple-balance/tls`, which is the same
  path in both, and the overlay has to be one of the files the deployment
  runs.
- **The database's PostgreSQL version.** 15 or newer is what this application
  accepts; 18 is what both profiles deploy where they own the database, so a
  dump from either restores into this one without a version in the way.
  `docs/deployment-profiles.md` separates the floor from the recommendation.
- **The database's collation.** Whoever runs it should create it on a glibc
  build. Alpine's musl compares text byte by byte whatever collation is
  declared, so every category, payee and account list comes back with capitals
  first and accents at the end. `docs/deployment-sizing.md` has the
  measurement.

## How this differs from the rest of `deploy/`

`../compose.distributed.yml` runs the three split containers on one machine.
It is a way to read the shape the Helm chart deploys, on a host, rather than a
way to deploy anything: nothing in it holds a ledger anybody depends on. There
used to be a `vps` profile that deployed those containers one machine each, with
the database among them; it is gone, and what it was for — a node per service —
is now the smaller of the `ha` profile's two shapes, so that growing into the
bigger one is a values file rather than a migration.

This directory is the `single` profile: the application container with TLS,
backups, log rotation and a systemd unit on one machine, and PostgreSQL on
another.

`../../helm/` and `../../pulumi/aws/` and `../../pulumi/gcp/` are the `ha`
profile's material. `../../pulumi/aws-single/` and `../../pulumi/oci-single/`
stand this profile up on a cloud VM.
