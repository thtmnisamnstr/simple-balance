# Deployment profiles

Two shapes, and the difference between them is machines rather than features.
Both run the same application, serve the same API and the same MCP surface, and
read the same settings.

| | `single` | `ha` |
| --- | --- | --- |
| Machines | One | A Kubernetes cluster |
| Containers | One, plus PostgreSQL and a TLS terminator | Four tiers, scaled independently |
| Database | PostgreSQL on the same host | Bring your own, or the Citus shape |
| Survives losing a machine | No | Yes |
| Upgrade | Seconds of downtime while the container restarts | Rolling, no downtime |
| Material | `deploy/compose/single/`, `deploy/systemd/`, `deploy/pulumi/aws-single/`, `deploy/pulumi/oci-single/` | `deploy/helm/`, `deploy/pulumi/aws/`, `deploy/pulumi/gcp/` |
| Read | `deploy/compose/single/README.md` | `deploy/helm/simple-balance/README.md`, `deploy/pulumi/README.md` |

**Start with `single`.** It is the supported shape, it is what `docs/deployment.md`
assumes, and a ledger is not a workload that needs a cluster — one machine
serves a household or a small team with room to spare, and
`docs/deployment-sizing.md` says how much room. Move to `ha` when losing one
machine for ten minutes is not acceptable, not when the load gets interesting.

There is a third thing in `deploy/compose/compose.distributed.yml` that is
neither profile: the split containers on one machine, which exists to exercise
the shape the Helm chart deploys. It is a demonstration, not a deployment.

## What terminates TLS

The application refuses an `APP_BASE_URL` that is neither HTTPS nor loopback
when `NODE_ENV=production`, which every image sets. So reaching a deployment
from another machine means something terminates TLS, and that thing has two
jobs beyond the certificate.

| It must | Because |
| --- | --- |
| Send `X-Forwarded-Proto` | The application builds absolute URLs and sets cookie flags from the scheme it believes it is serving |
| Put the visitor's address in `X-Forwarded-For`, as the first entry | Sign-in attempts are counted per address. Get this wrong and every visitor shares one allowance |
| Not buffer responses | A commit or an import of several thousand rows reports its progress as it goes |
| Not time a slow response out | The same request can take a minute |
| Allow a body of `CSV_MAX_BYTES × 6 + 64 KiB` | A CSV arrives inside a JSON string, and the default limits of most proxies are far below it |

Caddy needs to be told none of it: it streams by default, does not time a slow
response out, has no body limit of its own, and writes the two headers
correctly. `compose.caddy.yml` is three services' worth of configuration because
of that. nginx needs `proxy_read_timeout`, `proxy_buffering off`,
`client_max_body_size` and both headers said explicitly — `docs/deployment.md`
has the block to copy.

### The `X-Forwarded-For` rule, stated once

The application reads the **first** entry of `X-Forwarded-For` when
`TRUST_PROXY` is on, and the address of the connection when it is off. Both
answers are wrong in the other's situation, which is why the setting exists and
why the server says at startup which of the two it is doing.

That makes exactly one thing the terminator's responsibility: **the first entry
must be the visitor.** Two ways to get it, and both are fine:

- **Replace the header**, which is what nginx's
  `proxy_set_header X-Forwarded-For $remote_addr` does and what Caddy does by
  default. One entry, and it is the visitor.
- **Append, from an honest chain**, which is what a CDN in front of a
  terminator produces. The CDN discards what the caller sent and writes the
  visitor first; each hop after it appends its own.

The way to get it wrong is to append while trusting the caller. Caddy does that
only if its global `servers { trusted_proxies … }` option is set, and only for
addresses that option covers — so set it to the ranges of whatever really is in
front of Caddy, and never to `0.0.0.0/0`. Measured: with `0.0.0.0/0` a request
carrying `X-Forwarded-For: 203.0.113.7` reached the application as
`203.0.113.7, <real client>`, and the limiter would have counted it against the
address the caller chose.

### And the split shape, which has a second hop

In the `ha` profile and in `compose.distributed.yml`, the frontend container's
nginx sits between the terminator and the API, and it sends `$remote_addr` —
which without help is the terminator, for every visitor alike.

`SB_TRUSTED_PROXY_CIDR` is what fixes it. Set it to the range the terminator
connects from — the ingress controller's pod CIDR under Kubernetes — and nginx
resolves `$remote_addr` back to the visitor before passing it on. Its default,
`127.0.0.1`, is the off position: nothing reaches the container from loopback,
so a deployment that sets nothing behaves exactly as it did before the setting
existed.

Name the proxy's range and nothing wider. This decides whose word is taken for
an address, so a range that includes callers lets a caller choose their own.

## The firewall

The `single` profile, with the TLS terminator on the same machine:

| From | To | Port | Why |
| --- | --- | --- | --- |
| Anywhere | The host | 80/tcp | The redirect to HTTPS, and the ACME challenge |
| Anywhere | The host | 443/tcp | The application |
| Anywhere | The host | 443/udp | HTTP/3, which Caddy serves by default. Closing it costs a little connection setup time and nothing else |
| One named address | The host | 22/tcp | Optional, and off by default. Both cloud programs give a shell without it |
| The host | Anywhere | 443/tcp | Container images, Let's Encrypt, and any Stripe endpoint configured |
| The host | The SMTP relay | 587 or 465 | Only where mail is configured |

Nothing opens 5432 or 3000. The application and PostgreSQL reach each other over
the container network inside the machine, and a rule that exposed either would
be a second way in that the application's own origin checks do not cover.

The `ha` profile, where the tiers are separate:

| From | To | Port | Why |
| --- | --- | --- | --- |
| The load balancer | frontend | 8080 | Every request, including `/api` and `/mcp` — the frontend proxies them, which is what puts the browser and the API on one origin |
| frontend | server | 3000 | The proxied half |
| server, scheduler | postgres | 5432 | |
| server, scheduler | Anywhere | 443, 587/465 | Stripe and mail, where configured |

The server is not publicly reachable in either shape, and a second ingress rule
sending `/api` straight to it would bypass the `X-Forwarded-For` handling
`TRUST_PROXY` depends on. The chart's `NetworkPolicy` enforces the table above
when `networkPolicy.enabled` is set.

## DNS

One A record, pointing at the address the cloud program outputs. Both programs
reserve the address rather than taking an ephemeral one, so replacing the
machine does not mean waiting for a DNS change to propagate.

The name has to resolve **before** a certificate can be issued: Let's Encrypt
proves the name by connecting to it. Caddy retries until it works, so the order
does not matter much — the machine simply serves nothing over HTTPS until the
record exists.

There is no private DNS in the `single` profile and nothing to configure. The
application reaches PostgreSQL as `postgres` and Caddy reaches the application
as `app`, which are Compose service names resolved by the container runtime's
own resolver on a network that exists inside one host.

## Connection budgets

Each API and scheduler process holds `DATABASE_POOL_SIZE` connections and one
more while it starts. PostgreSQL's default `max_connections` is 100.

| Profile | Processes | Connections at peak |
| --- | --- | --- |
| `single` | 1 | `1 × (10 + 1)` = **11** |
| `compose.distributed.yml` | 1 server + 2 schedulers | `3 × (10 + 1)` = **33** |
| `ha`, at the chart's default ceilings | 4 server + 2 scheduler | `6 × (10 + 1)` = **66** |

The `single` number does not move, because there is nothing to scale out — which
is the profile's whole shape, and why the rest of the hundred is left for
`psql`, `pg_dump`, and the connection somebody opens while wondering why
something is slow. Under `ha` the number moves with every replica ceiling, so
the chart refuses to install a combination that would exceed
`config.maxConnections` and prints the arithmetic either way.

## Host lifecycle, in the `single` profile

**Boot order.** systemd starts `simple-balance.service` after `docker.service`
and after the network is up. The unit is `Type=oneshot` with
`RemainAfterExit=yes`, so systemd treats the whole deployment as one thing that
is either up or down.

**Who restarts what.** systemd owns ordering and intent — boot, `systemctl
start`, `systemctl stop`. Docker owns crash recovery, through
`restart: unless-stopped`. They do not fight because the unit's `ExecStop` runs
`docker compose down`, which removes the containers, so a deliberate stop leaves
nothing for Docker's restart policy to bring back.

**The first start is slow and that is fine.** Against an empty database it runs
every migration under an advisory lock before readiness opens. The unit allows
600 seconds for it, which is twice the 300 the health check allows, because
systemd's default of 90 would kill a first migration two thirds of the way
through.

**Logs.** Docker's `json-file` driver keeps every line forever by default, which
on a 20 GiB boot disk is how the disk fills. Every service in
`compose.yml` caps itself at 10 MiB across 5 files. PostgreSQL's own slow-query
log goes to the same place and is bounded by the same cap.

**Disks.** The boot disk holds the operating system, the images and the logs,
and does not grow. The data disk holds the database, the backups and the two
generated secrets, and is a separate volume on both clouds — so replacing the
machine keeps the ledger. `docs/deployment-sizing.md` sizes both.

**Backups.** A daily `pg_dump` in PostgreSQL's own compressed format, verified
by reading it back before it is kept. `deploy/compose/single/README.md` has the
commands, including the restore.

## Secrets

The two the deployment cannot run without — `AUTH_SECRET` and
`POSTGRES_PASSWORD` — are generated on the machine at first boot and kept on the
data volume at `0600`. They are in no user data, no Pulumi state file and no
cloud API response, because nothing outside the machine has any use for either
value, and a rebuilt instance that reattaches the same volume finds the same
ones.

Everything an operator genuinely supplies — an SMTP password, a Stripe key —
goes in `/opt/simple-balance/env.local`, which survives a redeploy and is
appended to `.env` on every boot. `docs/deployment.md` describes the `_FILE`
variants for a deployment that keeps secrets somewhere else entirely.
