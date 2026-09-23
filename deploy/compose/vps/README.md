# The `vps` profile

Four small machines, one per service, and the database is one of them. This is
the smallest shape that owns its whole stack: nothing here is somebody else's
managed anything.

`docs/deployment-profiles.md` compares it with the other two. The short version:
pick `single` unless you want the database inside the deployment, and pick `ha`
when losing one machine for ten minutes is unacceptable.

## The four machines

| Machine | Runs | Listens on | Reaches |
| --- | --- | --- | --- |
| `frontend` | nginx, and Caddy for TLS | **public** 80, 443 | the API machine, port 3000 |
| `server` | the API and the MCP surface | private 3000 | the database machine, port 5432 |
| `scheduler` | recurrences and notifications | nothing | the database machine, port 5432 |
| `database` | PostgreSQL 18 | private 5432 | nothing |

Only the frontend machine has anything open to the internet. The other three
publish on the provider's private network, and each compose file binds to that
address by name rather than to `0.0.0.0` — because a Docker published port
bypasses the host firewall on Linux, Docker having written its own rules ahead
of them. **The bind address is the boundary; the firewall is the second line.**

The scheduler is separate from the API for the reason the profile exists rather
than because it must be: two processes both proposing recurrences would still be
correct, since the claim is transactional. It is one job on one machine.

## Firewall

Everything below is a rule between machines. Nothing needs a route out except
the frontend for ACME, and the application machines for whatever mail and
payment provider you use.

| From | To | Port | Why |
| --- | --- | --- | --- |
| the internet | `frontend` | 80/tcp | the http→https redirect, and the ACME HTTP-01 challenge |
| the internet | `frontend` | 443/tcp+udp | the application. UDP is HTTP/3, and leaving it closed only makes connections slower to set up |
| `frontend` | `server` | 3000/tcp | every API, MCP and health request |
| `server` | `database` | 5432/tcp | the ledger |
| `scheduler` | `database` | 5432/tcp | the ledger |
| `frontend` | the internet | 80, 443/tcp | Let's Encrypt |
| `server`, `scheduler` | the internet | 587/tcp | SMTP, if mail is configured |
| `server`, `scheduler` | the internet | 443/tcp | Stripe, if billing is configured |
| you | any | 22/tcp | from your own address, not `0.0.0.0/0` |

The scheduler needs Stripe as much as the API does. On every tick it re-reads
from Stripe each subscription not heard about for twelve hours, and that sweep
is what repairs a webhook Stripe could not deliver (`docs/billing-operations.md`,
"When a webhook was missed"). Closed off, every sweep fails and a missed webhook
is never put right.

There is deliberately no rule from `database` to anything. It answers and never
calls.

## DNS

One public name, pointing at the frontend machine, and it has to resolve before
you start Caddy — Let's Encrypt proves the name is yours by connecting to it.

The other three are addressed by private IP in the `.env` files rather than by
name. That is a deliberate floor rather than a recommendation: private DNS is a
per-provider feature with a per-provider name, and an address written in one
file is one thing to change when a machine is replaced. If your provider offers
private DNS, use the names instead — nothing here parses these values.

## Bringing it up

Order matters once, on the first start: the API applies the schema, so the
database has to be there.

```sh
# 1. The database machine.
cp .env.postgres.example .env && $EDITOR .env
sudo docker compose -f compose.postgres.yml up -d

# 2. The API machine. Its first start creates the schema, which is why it is
#    second and not last.
cp .env.app.example .env && $EDITOR .env
COMPOSE_PROFILES=server sudo -E docker compose -f compose.app.yml up -d --wait

# 3. The scheduler machine. Same file, same settings, different half.
cp .env.app.example .env && $EDITOR .env
COMPOSE_PROFILES=scheduler sudo -E docker compose -f compose.app.yml up -d --wait

# 4. The frontend machine, once DNS resolves to it.
cp .env.frontend.example .env && $EDITOR .env
sudo docker compose -f compose.frontend.yml -f compose.caddy.yml up -d
```

After that the order stops mattering: every process retries its database
connection, and the frontend serves a 502 while the API is down rather than
failing to start.

## Which release

The server and scheduler images in `compose.app.yml` and the frontend image in
`compose.frontend.yml` each name the release they pull, written out, and all
three name the same one. `npm run set-version` rewrites them when a release is
cut, so these files always pull the release they came from. Moving to another is
changing that tag in both files, to the same value on every machine, after a
dump: see [docs/upgrades.md](../../../docs/upgrades.md).

## As a service

`deploy/systemd/` is the same units the `single` profile uses, and they work here
unchanged — the unit runs `docker compose up -d --wait` in `/opt/simple-balance`
and reads which files and profiles from `/etc/default/simple-balance`. So each
machine gets the same unit and a different environment file:

```sh
# on the database machine
COMPOSE_FILE=compose.postgres.yml

# on the API machine
COMPOSE_FILE=compose.app.yml
COMPOSE_PROFILES=server

# on the scheduler machine
COMPOSE_FILE=compose.app.yml
COMPOSE_PROFILES=scheduler

# on the frontend machine
COMPOSE_FILE=compose.frontend.yml:compose.caddy.yml
```

Install it the same way on each:

```sh
sudo install -d -m 0755 /opt/simple-balance
sudo cp <this machine's compose files, and Caddyfile on the frontend> /opt/simple-balance/
sudo cp .env /opt/simple-balance/.env && sudo chmod 0600 /opt/simple-balance/.env
sudo cp deploy/systemd/simple-balance.service /etc/systemd/system/
sudo $EDITOR /etc/default/simple-balance     # the two lines above
sudo systemctl enable --now simple-balance.service
```

## Backups

On the database machine, and only there.

```sh
sudo cp deploy/systemd/simple-balance-backup /usr/local/bin/
sudo cp deploy/systemd/simple-balance-restore /usr/local/bin/
sudo cp deploy/systemd/simple-balance-backup.service deploy/systemd/simple-balance-backup.timer /etc/systemd/system/
sudo systemctl enable --now simple-balance-backup.timer
```

The script works out how to reach the database by reading the Compose project's
own service list: here it finds a `postgres` service and takes the dump inside
it, with no client on the host and no password anywhere. On the `single` profile
it finds none and goes over the network instead. One script, and no setting that
can disagree with the compose file about which database is being backed up.

Restoring stops the application first, and on this profile that means stopping
it on the *other two machines* — the script runs `docker compose stop app`, which
on the database machine matches nothing. Do it by hand:

```sh
# on the API and scheduler machines
sudo systemctl stop simple-balance

# on the database machine
sudo /usr/local/bin/simple-balance-restore /var/backups/simple-balance/<dump>

# then start the other two again
sudo systemctl start simple-balance
```

## Sizing

`docs/deployment-sizing.md` sizes a machine for a given number of people, and its
table is about the database — which here is a machine of its own, so read it for
the database machine and give the other three the smallest thing your provider
sells. The API is the only one of the three that does any real work, and
`docs/capacity.md` measured it answering a busy hour at a 130 ms 95th percentile
on two cores.

## The things that have to line up

- **`APP_BASE_URL`, `SITE_ADDRESS` and DNS.** All three name the same host. The
  API compares every state-changing request's `Origin` against `APP_BASE_URL`,
  so a mismatch loads pages and refuses every write.
- **`AUTH_SECRET`, on both application machines.** Sessions are signed with it.
  Two machines with two secrets sign each other's visitors out.
- **`TRUST_PROXY` and `SB_TRUSTED_PROXY_CIDR`.** One decision in two places. The
  application machines trust `X-Forwarded-For` because only the frontend reaches
  them; the frontend decides whose word it takes for that header. Get the second
  wrong and every visitor shares one sign-in allowance — four wrong passwords
  from anywhere locks out everybody.
- **`SB_MAX_UPLOAD_SIZE` and `CSV_MAX_BYTES`.** nginx refuses a body over its
  limit before the API sees it, and the API sizes its own at `CSV_MAX_BYTES` × 6
  plus 64 KiB because a CSV travels as a JSON string.
- **`DATABASE_POOL_SIZE` and `POSTGRES_MAX_CONNECTIONS`.** Two machines at 10,
  plus one each while they start, is 22 of the 50 the database is configured for.
- **The database's collation.** `postgres:18` is Debian and therefore glibc,
  which is the point: musl compares text byte by byte whatever collation is
  declared, and this application's category and payee uniqueness rests on the
  difference. `docs/deployment-sizing.md` has the measurement.
