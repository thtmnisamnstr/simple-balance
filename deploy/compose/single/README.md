# The `single` profile

One machine runs the application and whatever terminates TLS. The database is
somebody else's — a managed PostgreSQL, or a server you already keep awake — and
that is the profile rather than a gap in it: losing this machine loses no data.

It grows by being given more CPU and memory, and there is nothing in it to scale
out. If you want the database inside the deployment, that is the `vps` shape and
`../compose.distributed.yml` is its starting point. That is the trade, and for one person, a
household, or a team small enough to know each other's names it is the right
one — `docs/deployment-profiles.md` is where the other profile is argued.

Three files and a Caddyfile:

| File | What it is |
| --- | --- |
| `compose.yml` | The application. Complete on its own, given a `DATABASE_URL`. |
| `compose.caddy.yml` | An overlay that adds TLS, obtained and renewed by Caddy. |
| `compose.db-tls.yml` | An overlay that mounts the database's CA certificate into the application, for a `DATABASE_URL` that names one. |
| `Caddyfile` | What Caddy serves. Read by the Caddy overlay, not by `compose.yml`. |

Skip the Caddy overlay if you already run nginx, HAProxy or a cloud load balancer.
Point it at the loopback port `compose.yml` publishes, and set `TRUST_PROXY=true`
in `.env` yourself — that is the one thing the overlay was doing for you, and
without it every visitor shares one sign-in allowance.

## Bring it up

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
`DATABASE_URL` goes in `/var/lib/simple-balance/env.local`. A machine built by
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
from its parts before every start, so there the edit goes in
`/var/lib/simple-balance/env.local`, and an edit to `.env` is overwritten at the
next start. That drop-in exists only on those machines;
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

To restore:

```sh
sudo /usr/local/bin/simple-balance-restore /var/backups/simple-balance/simple-balance-20260914T031500Z.dump
```

It reads the archive before it touches anything, stops the application so
nothing writes into a half-restored ledger, drops and recreates the database,
and starts the application again — which also applies any migration the dump
predates. That last part is the supported way to restore an old backup onto a
new release.

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
  accepts; 18 is what the two profiles that own a database deploy, so a dump
  from one of those restores into this one without a version in the way.
  `docs/deployment-profiles.md` separates the floor from the recommendation.
- **The database's collation.** Whoever runs it should create it on a glibc
  build. Alpine's musl compares text byte by byte whatever collation is
  declared, so every category, payee and account list comes back with capitals
  first and accents at the end. `docs/deployment-sizing.md` has the
  measurement.

## How this differs from the rest of `deploy/`

`../vps/` is the `vps` profile: the split containers with one machine each and
the database among them. `../compose.distributed.yml` is the same containers on
a single machine, which is a way to exercise that shape on one host rather than
a way to deploy it.

This directory is the `single` profile: one container, no database, TLS,
backups, log rotation, and a systemd unit.

`../../helm/` and `../../pulumi/aws/` and `../../pulumi/gcp/` are the `ha`
profile's material. `../../pulumi/aws-single/` and `../../pulumi/oci-single/`
stand this profile up on a cloud VM.
