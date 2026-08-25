# The split, on one machine

`compose.distributed.yml` runs Simple Balance as the three containers
`deploy/docker/` builds, plus a PostgreSQL container for convenience:

| Service | What it is | Port |
| --- | --- | --- |
| `postgres` | The database, here so a trial takes one command | none |
| `server` | The API and the MCP endpoint, with no browser bundle in it | none |
| `frontend` | nginx, serving the bundle and proxying everything the API owns | `127.0.0.1:8080` |
| `scheduler` | Proposes recurring transactions, two replicas | none |

Only the frontend publishes a port, because cookies are set by the API and read
by the browser and both have to be reached on one origin. That origin is nginx,
and `APP_BASE_URL` on the server names it. A second way in would be a second
origin the cookies do not belong to.

This is the shape `deploy/helm/simple-balance/` deploys, without Kubernetes. One
container is still the supported way to run this in production; see
[docs/deployment.md](../../docs/deployment.md).

## Bring it up

```sh
cp deploy/compose/.env.example deploy/compose/.env
```

Fill in the two values that have no sensible default. Compose reads `.env` from
the directory the compose file lives in, so this one is separate from the
repository root `.env` the single container uses. Everything else in the file is
commented out, so uncommenting a line is what turns that setting on, and
`POSTGRES_PASSWORD` is the database container's own variable rather than one of
Simple Balance's.

```sh
POSTGRES_PASSWORD=   # letters and digits, so nothing needs percent-encoding
AUTH_SECRET=         # openssl rand -base64 32
```

Then, from anywhere in the repository:

```sh
docker compose -f deploy/compose/compose.distributed.yml up -d --build
```

The first run builds three images from the repository root and takes a few
minutes. Startup is ordered by health rather than by hope: the server waits for
PostgreSQL to answer `pg_isready`, and the frontend waits for the server's
`/health/ready`, which stays closed until the migrations have run. Both
schedulers start alongside the server, since they run the same migrations under
the same advisory lock and need only the database.

## What to open

<http://localhost:8080>.

The first visit asks for a one-time setup code, which claims the instance. Set
`SETUP_TOKEN` in `.env` to choose it, or read the generated one from the log:

```sh
docker compose -f deploy/compose/compose.distributed.yml logs server | grep -i setup
```

It stops working once an account exists. After that, set `ALLOWED_EMAILS` to say
who else may register; empty admits nobody, which is what keeps an unconfigured
deployment private. A list that already admits anybody makes the code
unreachable and none is printed, since the sign-up form lets you in without one.

To point an MCP client at it, the base URL is the same origin:
<http://localhost:8080/mcp>. Discovery is served from
`/.well-known/oauth-authorization-server` through the same proxy.

## Watch it

```sh
docker compose -f deploy/compose/compose.distributed.yml ps
docker compose -f deploy/compose/compose.distributed.yml logs -f server
docker compose -f deploy/compose/compose.distributed.yml logs -f scheduler
```

All five containers should read `healthy`. A `server` that never gets there is
nearly always the database; its log says which setting it refused and why.

There is one thing readiness will not tell you. A process with the scheduler
switched off is not an unhealthy one, so nothing here goes red if the schedulers
stop. What tells you is the Recurring page: a recurrence past its due date with
nothing proposed means whatever runs the schedule is not running.

## Tear it down

```sh
# Stop everything, keep the database.
docker compose -f deploy/compose/compose.distributed.yml stop

# Remove the containers and the network, keep the database.
docker compose -f deploy/compose/compose.distributed.yml down

# Remove the database too. This deletes the ledger.
docker compose -f deploy/compose/compose.distributed.yml down -v

# And the three images built here, if you are done with them.
docker compose -f deploy/compose/compose.distributed.yml down -v --rmi local
```

Everything is in PostgreSQL, so `down -v` is the whole product. Take a dump
first if the trial turned into something you want to keep:

```sh
# -T, or compose allocates a TTY and the redirect writes a corrupted dump.
docker compose -f deploy/compose/compose.distributed.yml exec -T postgres \
  pg_dump --format=custom -U simple_balance simple_balance > simple-balance.dump
```

## How this differs from the rest of the repository

**`compose.dev.yml`,** at the repository root, is a development database and
nothing else. It runs PostgreSQL for `npm run dev` and the integration suite, and
the application runs on your machine from source with Vite in front of it. It
publishes 5432 so those commands can reach it; this file publishes nothing but
the frontend.

**The single container** is what [docs/deployment.md](../../docs/deployment.md)
documents and the supported way to deploy this: one image serving the bundle,
the API, the MCP endpoint and the scheduler from one process, run with `docker run --env-file
.env`. It is the supported way to deploy this, and none of the settings below
have to line up there, because there is nothing to line them up between.

**The Helm chart,** at `deploy/helm/simple-balance/`, deploys these same three
images to Kubernetes with an Ingress, cert-manager, autoscaling and network
policies. The differences here are the ones a single machine forces:

- The chart provisions no database. A cluster's PostgreSQL is bring your own,
  since whoever runs it owns its backups, its version and its
  `max_connections`. Here it is a container, because a trial on one machine
  should take one command.
- The chart runs two API replicas and one scheduler; this runs one API and two
  schedulers, which is the arrangement that shows the scheduler dividing work.
- nginx gets `SIGQUIT` here rather than the chart's preStop hook, because
  `docker compose down` sends `SIGTERM`, which nginx reads as a *fast* shutdown.
- The tmpfs mounts carry `uid=101`, which the chart's emptyDirs do not need.
  Docker gives a tmpfs the mode of the directory it covers and leaves it owned
  by root, and an unwritable `/etc/nginx/conf.d` means the entrypoint never
  renders the config and nginx comes up serving nothing.

## The things that have to line up

Split into three, four settings stop being defaults and start being decisions.
They are set in the compose file, with the reasoning beside each:

- **`APP_BASE_URL` names the frontend**, not the server. It is `http://localhost:8080`
  here, matching the published port.
- **`TRUST_PROXY=true`,** because nginx is now the address every connection to
  the API arrives from. Left false, every visitor shares one sign-in allowance.
- **`RECURRENCE_SCHEDULER=false` on the server,** because the scheduler service
  owns the job. The scheduler entrypoint ignores the flag and always ticks.
- **Two schedulers, and as many as you like.** There is no leader and no lease:
  each recurrence is claimed with `for update skip locked`, so replicas divide
  the due list by racing for rows. `--scale scheduler=4` on `up` overrides the
  count in the file.

The arithmetic that bounds all of it is connections. Each node process holds
`DATABASE_POOL_SIZE` of them, plus one more while it starts, so this file peaks
at `3 x (10 + 1) = 33` of the 100 PostgreSQL allows by default. Lower the pool
before raising any replica count.

## Changing it

**Published images.** Every `build:` block has an `image:` line commented above
it. All three publish to ghcr.io alongside the single container, on the same
release and under the same tags, so swapping the comment turns a build into a
pull. They are pinned to a version rather than `latest`, because an upgrade
moves the schema and should be a decision rather than whatever a restart
happened to pull. Take a dump first; see [docs/upgrades.md](../../docs/upgrades.md).

**Your own database.** Delete the `postgres` service and its volume, drop the
`depends_on` entries that name it, and point `DATABASE_URL` at the real server.
The role it names needs `CREATEDB` if the database does not exist yet. See
[docs/deployment.md](../../docs/deployment.md) for which `sslmode` to use.

**Reaching it from another machine.** The images run with `NODE_ENV=production`,
which refuses an `APP_BASE_URL` that is neither HTTPS nor loopback, and that is
the setting that also decides secure cookies and the OAuth issuer. So this needs
a reverse proxy terminating TLS in front of the frontend and an `https://` origin
in `.env`, not a wider port binding. Give that proxy the `X-Forwarded-For`
handling `docs/deployment.md` shows, and add `set_real_ip_from` to
`deploy/docker/nginx.conf.template`, or `$remote_addr` inside nginx is the proxy
and every visitor shares one sign-in allowance again.

**Mail.** Off unless `SMTP_HOST` and `MAIL_FROM` are both set in `.env`. With
neither there is no password reset and nobody is asked to confirm an address,
which is the right answer for a deployment of one.
