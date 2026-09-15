# The `single` profile

One machine runs everything: the application container, PostgreSQL beside it,
and whatever terminates TLS. It grows by being given more CPU and memory, and
there is nothing in it to scale out. That is the trade, and for one person, a
household, or a team small enough to know each other's names it is the right
one — `docs/deployment-profiles.md` is where the other profile is argued.

Two files and a Caddyfile:

| File | What it is |
| --- | --- |
| `compose.yml` | The application and the database. Complete on its own. |
| `compose.caddy.yml` | An overlay that adds TLS, obtained and renewed by Caddy. |
| `Caddyfile` | What Caddy serves. Read by the overlay, not by `compose.yml`. |

Skip the overlay if you already run nginx, HAProxy or a cloud load balancer.
Point it at the loopback port `compose.yml` publishes, and set `TRUST_PROXY=true`
in `.env` yourself — that is the one thing the overlay was doing for you, and
without it every visitor shares one sign-in allowance.

## Bring it up

```sh
cp deploy/compose/single/.env.example deploy/compose/single/.env
$EDITOR deploy/compose/single/.env          # POSTGRES_PASSWORD, AUTH_SECRET, APP_BASE_URL
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

The division of labour is worth knowing because two process managers over the
same containers is a question people expect to be a problem:

- **systemd owns ordering and intent.** Boot, `systemctl start`,
  `systemctl stop`.
- **Docker owns crash recovery**, through `restart: unless-stopped`.

They do not fight, and the reason is one line: the unit's `ExecStop` runs
`docker compose down`, which removes the containers, so there is nothing left
for Docker's restart policy to bring back after a deliberate stop.

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
docker compose down                 # stop everything, keep the database
docker compose down -v              # and delete the database. This deletes the ledger.
```

`-v` removes the named volume. Where `POSTGRES_DATA_DIR` points at a bind mount,
the directory stays and its contents go.

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
- **`POSTGRES_DATA_DIR` and the disk it is on.** It should be the data disk.
  `docs/deployment-sizing.md` sizes the two separately, and a PostgreSQL that
  fills a boot disk takes the machine with it.
- **The PostgreSQL image and glibc.** Stay on a Debian-based one. The Alpine
  images are musl, which compares text byte by byte whatever collation is
  declared, so every category, payee and account list comes back with capitals
  first and accents at the end. `compose.yml` carries the measurement.

## How this differs from the rest of `deploy/`

`../compose.distributed.yml` runs the *split* containers on one machine. It
exists to exercise the shape the Helm chart deploys, with a bundled PostgreSQL
for convenience. This directory is a deployment somebody's books live in: one
container rather than three, a database tuned rather than defaulted, TLS,
backups, log rotation, and a systemd unit.

`../../helm/` and `../../pulumi/aws/` and `../../pulumi/gcp/` are the `ha`
profile's material. `../../pulumi/aws-single/` and `../../pulumi/oci-single/`
stand this profile up on a cloud VM.
