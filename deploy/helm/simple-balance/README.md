# The chart

Deploys the three images `deploy/docker/` builds as three workloads:

| Workload | What it is | Replicas |
| --- | --- | --- |
| `server` | The API and the MCP endpoint, no browser bundle | 2, autoscaling to 4 |
| `frontend` | nginx, serving the bundle and proxying everything the API owns | 2, autoscaling to 6 |
| `scheduler` | Proposes recurring transactions | 1, autoscaling to 2 |

Only the frontend is reachable from outside. Cookies are set by the API and read
by the browser, and both have to be on one origin — nginx — so a second way in
would be a second origin the cookies do not belong to.

One container is still the supported way to run this in production. This chart is
for people who are already running Kubernetes and want the web tier to scale. The
contract all three deployment artefacts satisfy, and every environment variable
the application reads, is in
[docs/deployment.md](../../../docs/deployment.md); this file is the chart, not
the application.

## Install

The database is bring your own. Nothing here provisions one, because whoever runs
it owns its backups, its version and its `max_connections`.

```sh
helm upgrade --install simple-balance deploy/helm/simple-balance \
  --namespace simple-balance --create-namespace \
  --set config.appBaseUrl=https://books.example.com \
  --set secret.databaseUrl='postgresql://user:pass@host:5432/simple_balance' \
  --set secret.authSecret="$(openssl rand -base64 32)"
```

Those three have no sensible default and the chart refuses to render without
them. It also refuses an `authSecret` shorter than 32 characters, or one of the
placeholders published in this repository — both would install cleanly and then
crashloop every tier, which is a worse failure than a refusal.

## The three things that have to line up

Most of what goes wrong here is one of these, so the chart checks all three at
render time and says which.

1. **`config.appBaseUrl` and `ingress.host` name the same host.** The API sets
   the cookies the browser reads and compares every write against this origin. If
   the Ingress answers on a host `appBaseUrl` does not name, sign-in appears to
   work and then does not persist.
2. **Replicas times pool size fits `max_connections`.** The peak is while
   replicas start: `replicas x (databasePoolSize + 1)`. The shipped ceilings come
   to 66 of PostgreSQL's default 100. `helm install` prints the arithmetic for
   your values and warns if it does not fit.
3. **`frontend.maxUploadSize` stays above the API's own CSV limit.** A CSV
   arrives as a JSON string, so the API sizes its limit at `CSV_MAX_BYTES` x 6
   plus overhead. Set this lower and nginx refuses a file the API would have
   taken.

## Claiming the first account

Set `secret.setupToken` to choose the one-time code, or leave it empty and read
the generated one out of the log:

```sh
kubectl -n simple-balance logs deploy/simple-balance-server | grep -i setup
```

The generated code belongs to the deployment rather than to a pod, so it is the
same code whichever replica answers the form. It stops working the moment an
account exists.

With `secret.create=false` the chart renders no Secret at all, so
`secret.setupToken` is not read — put `SETUP_TOKEN` in your own Secret instead,
alongside `DATABASE_URL` and `AUTH_SECRET`.

## Scaling

The scheduler scales freely. A tick claims each recurrence with
`for update skip locked`, so there is no leader and no lease: replicas divide the
due rows between them. Migrations run on startup under an advisory lock, so
several replicas booting together is safe.

Through a connection pooler, set `secret.directDatabaseUrl` as well. Migrations
and the first-account claim hold session-level advisory locks, and in transaction
mode those are taken on one connection and released on another, which is to say
not held at all.

## Metrics

Off unless asked for. `config.metrics.enabled=true` makes both workloads answer
`GET /metrics` on their own container port, and both are worth scraping: the API
reports requests, MCP tool calls, ledger writes and its connection pool, the
scheduler reports ticks, proposals, reminders and mail. Every series carries
`component="api"` or `component="scheduler"`.

Nothing in a metric names a person, and a path with an id in it is counted under
its route pattern rather than the path, so a large ledger is not a large number
of time series. What it does publish is how busy this deployment is, so
`secret.metricsToken` is there when the pods are reachable by anything the
NetworkPolicy does not already decide about: set it and the endpoint answers
only `Authorization: Bearer <token>`.

With `networkPolicy.enabled`, name the scraper in `networkPolicy.serverIngressFrom`
and `networkPolicy.schedulerIngressFrom`. The scheduler's policy allows any
source in the cluster on its one port until `probeSourceCidrs` narrows it, at
which point a scraper that is not named there cannot reach the process that
reports ticks, proposals and mail.

The Service publishes no separate port for it and the frontend does not proxy
it, so a scrape reaches the pods directly — `kubernetes-pods` discovery with the
usual `prometheus.io/scrape` annotations through `server.podAnnotations` and
`scheduler.podAnnotations`, or a ServiceMonitor pointed at the existing port.

## Everything else

`values.yaml` documents every value where it is defined, including why the
defaults are what they are. `values.schema.json` is what `helm install` checks
before any of it renders.
