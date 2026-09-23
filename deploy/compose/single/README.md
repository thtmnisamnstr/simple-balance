# The `single` profile

One machine runs the application and whatever terminates TLS. The database is
somebody else's — a managed PostgreSQL, or a server you already keep awake — and
that is the profile rather than a gap in it: losing this machine loses no data.

It grows by being given more CPU and memory, and there is nothing in it to scale
out. If you want the database inside the deployment, that is the `vps` shape and
`../compose.distributed.yml` is its starting point. That is the trade, and for one person, a
household, or a team small enough to know each other's names it is the right
one — `docs/deployment-profiles.md` is where the other profile is argued.

Two files and a Caddyfile:

| File | What it is |
| --- | --- |
| `compose.yml` | The application. Complete on its own, given a `DATABASE_URL`. |
| `compose.caddy.yml` | An overlay that adds TLS, obtained and renewed by Caddy. |
| `Caddyfile` | What Caddy serves. Read by the overlay, not by `compose.yml`. |

Skip the overlay if you already run nginx, HAProxy or a cloud load balancer.
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
retained. Run one by hand with `sudo /usr/local/bin/simple-balance-backup`.

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
