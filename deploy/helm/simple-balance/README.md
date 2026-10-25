# The chart

Deploys the three images `deploy/docker/` builds as three workloads:

| Workload | What it is | Replicas |
| --- | --- | --- |
| `server` | The API and the MCP endpoint, no browser bundle | 2, autoscaling to 4 |
| `frontend` | nginx, serving the bundle and proxying everything the API owns | 2, autoscaling to 6 |
| `scheduler` | Proposes recurring transactions | 1, autoscaling to 2 |

With `database.enabled` there is a fourth: one StatefulSet per Citus group,
PostgreSQL 18 under Patroni. It is off by default and the section below is what
turns it on.

Only the frontend is reachable from outside. Cookies are set by the API and read
by the browser, and both have to be on one origin — nginx — so a second way in
would be a second origin the cookies do not belong to. Nothing else here takes a
connection from outside the cluster, the database least of all.

One container is still the supported way to run this in production, and the
`single` profile is where a small deployment belongs. This chart is for people
who are already running Kubernetes and want the web tier to scale, or who want
the ledger distributed. The contract all the deployment artifacts satisfy, and
every environment variable the application reads, is in
[docs/deployment.md](../../../docs/deployment.md); this file is the chart, not
the application.

## Install

The database is bring your own unless you ask otherwise. Left alone the chart
provisions no PostgreSQL, because whoever runs it owns its backups, its version
and its `max_connections`:

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

## The database this chart can run

`database.enabled` runs PostgreSQL 18 with Citus in the cluster, under Patroni.
It is off in `values.yaml` and stays off: a values file written for 0.1.6 has no
`database` key at all, and a default that flipped would start a Citus cluster
underneath a deployment that already has a database.

Two shapes turn it on, and they are **the same profile**, not two:

| | `-f values-node-per-service.yaml` | `-f values-ha.yaml` |
| --- | --- | --- |
| Pods | 5: frontend, API, scheduler, coordinator, one worker | frontend, API and scheduler autoscaling; 3 Citus groups |
| Citus | 1 coordinator + 1 worker | 1 coordinator + 2 workers |
| Replicas per group | 1 | 2 |
| Commits wait for a standby | no — there is none | yes |
| A node lost | that group's shards are gone until it returns | a failover, or a standby short |

```sh
helm upgrade --install simple-balance deploy/helm/simple-balance \
  --namespace simple-balance --create-namespace \
  -f deploy/helm/simple-balance/values-node-per-service.yaml \
  --set config.appBaseUrl=https://books.example.com \
  --set secret.authSecret="$(openssl rand -base64 32)"
```

Swap the values file for `values-ha.yaml` and everything above the line changes
and nothing below it does: the same chart, the same Citus schema, the same
`0023`, the same backups. Growing is a rollout rather than a migration, which is
why the smaller shape is this chart at one replica instead of a profile with a
database of its own. Five pods to run what one machine could is the price of
never doing that migration, and it is deliberate; the `single` profile is there
for anyone who would rather not pay it.

`secret.databaseUrl` is refused alongside `database.enabled` — one runs a cluster
and the other points at somebody else's, and the chart will not choose for you.
The connection string is derived from the leader Service and the password the
chart generated, so a failover moves the database without the application being
redeployed.

### What it encrypts, and what it does not

Everything that crosses a pod boundary is TLS, and it is required rather than
offered:

- The API and the scheduler connect with `sslmode=verify-full` against a CA this
  chart generates and mounts into their pods. A pod without that mount fails at
  startup rather than connecting to something unverified.
- `pg_hba` carries `hostssl` for every source but loopback, so a plaintext
  connection from another pod matches no line and is refused.
- Citus reaches a worker with `sslmode=verify-ca`, and a standby streams from its
  primary the same way. `verify-ca` and not `verify-full` because both address
  each other by pod IP — an address no certificate can promise in advance.

The certificate is generated once and then kept, because a regenerated one is a
different identity and every API pod holding the old CA would stop being able to
connect at the moment of the upgrade. It lives in
`<release>-db-credentials` alongside the passwords, which makes that Secret part
of the backup: a restored volume and a regenerated CA do not know each other.
`database.tls.ca`, `.cert` and `.key` bring your own instead, all three or none.
Rotation is in [docs/citus-runbook.md](../../../docs/citus-runbook.md).

Encryption **at rest** is the storage class's job, not the chart's. Name one that
encrypts in `database.persistence.storageClass`; the `aws` Pulumi program creates
an encrypted gp3 class and names it for you, and GKE's persistent disks are
encrypted by Google by default.

### Patroni's REST API

Patroni's port is the cluster's control plane: `/switchover`, `/failover`,
`/restart` and `/reinitialize` live on it. It now demands a credential for those
— `database.restapi.username` and a password generated beside the other three.
The read-only endpoints stay open, which is what keeps the kubelet's probes
working without handing them a secret.

`networkPolicy.enabled` is the other half, and both values files turn it on. It
gives the database a policy of its own: 5432 from the API, the scheduler and the
other database pods, the Patroni port from the database pods and the probe
sources, and nothing else. A NetworkPolicy is only as real as the CNI under it,
so the `aws` program turns on the VPC CNI's network policy agent and the `gcp`
program asks for Dataplane V2 rather than assuming either.

### Uninstalling, and why it needs a hook

Patroni keeps this cluster's state in Kubernetes objects it creates itself at
runtime — a leader Endpoints per Citus group, plus `-config`, and `-sync` and
`-failover` when they apply. Helm did not create them, so `helm uninstall` does
not delete them, and what they leave behind is not inert: the `-config`
endpoint's `initialize` annotation tells the *next* install under the same
release name that a cluster already exists and a member is mid-bootstrap. No pod
ever claims leadership. Every one of them logs `waiting for leader to bootstrap`
every ten seconds, forever, Running and 0/1, with nothing crashing and no event
saying anything is wrong. Deleting the claims is the obvious reach and is what
*produces* it rather than fixing it.

So the chart ships a `post-delete` hook — a Job with a Role of its own — that
removes exactly this release's Patroni objects once the database pods are gone.
`database.patroniCleanup.enabled` turns it off.

Three properties are worth knowing, because this is a hook that deletes database
cluster state:

- **It cannot run at any other moment.** Helm fires `post-delete` from
  `uninstall` alone, and `--dry-run` returns before hooks run.
- **It cannot reach a neighbour.** It finds objects by Patroni's own label set,
  which carries the release name twice — in `app.kubernetes.io/instance` and
  inside `cluster-name` — never by a name prefix. Anything labelled
  `managed-by: Helm` it leaves alone and reports, because that would mean the
  uninstall itself did not finish.
- **A hook that cannot run does not strand the release.** `post-delete` failures
  are collected rather than returned, so the uninstall completes, the history is
  purged, and `helm uninstall` exits non-zero with the Job's logs printed. What
  is left behind is the endpoints — exactly the state you would have had without
  the hook, and [docs/citus-runbook.md](../../../docs/citus-runbook.md) still
  has the namespace-delete recovery for it. That is the reason it is
  `post-delete` and not `pre-delete`: a failing `pre-delete` hook refuses the
  uninstall outright, and at that point in the uninstall the database is still
  running and Patroni would rewrite whatever the Job deleted within ten seconds.
  It does still exit non-zero, which under Pulumi fails the `destroy` at the
  Release even though the release itself is gone; the runbook has the
  `pulumi state delete` that clears it, and says when to turn the hook off
  instead.

Turning it off has its own cost, which is why it is a switch rather than a
constant. Reinstalling over intact claims is a normal restart, and without the
hook Patroni finds its own configuration where it left it; with the hook it
rebuilds that configuration from the chart's `bootstrap.dcs`, so anything
applied with `patronictl edit-config` is reverted. The data is untouched either
way.

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

## Where a request came from

The API counts sign-in attempts per client address, and the address it sees is
whatever the frontend's nginx puts in `X-Forwarded-For`. Behind an ingress that
is the ingress, for every visitor, until nginx is told whose word to take:

- **`frontend.trustedProxyCidr`** — the addresses nginx believes about where a
  request came from. One address or CIDR, or several: a string separated by
  commas or spaces, or a YAML list
  (`--set 'frontend.trustedProxyCidr={10.0.0.0/16,10.1.0.0/16}'`). Every entry
  is an IPv4 or IPv6 address, a CIDR, or `unix:`; the schema refuses anything
  else, and the image refuses it again at startup, because nginx would resolve
  a host name here and trust whatever it answered. Name the proxies' own
  ranges and nothing wider. `127.0.0.1`, the default, is the off position and
  trusts nobody, and `helm install` prints a warning while it is left there.
- **`frontend.realIpRecursive`** — off by default. Leave it off behind an
  ingress that replaces `X-Forwarded-For`, which ingress-nginx does unless
  `use-forwarded-headers` and `compute-full-forwarded-for` are both on: the
  last entry is the visitor. Turn it on
  behind a chain whose every hop appends and is in the list — Google's load
  balancer appends `<client-ip>,<load-balancer-ip>` — so nginx walks past the
  trusted hops to the client's address, which the load balancer wrote, and never
  reads anything the client wrote before it. A range holding every address is
  refused with it on.

The `aws` and `gcp` Pulumi programs set both for the network they build, unless
the stack names its own `simple-balance:trustedProxyCidr`, and on each cloud
that takes more than these two values. On AWS the program also turns proxy
protocol on between the network load balancer and ingress-nginx, which would
otherwise see the load balancer rather than the visitor; the frontend then
trusts the VPC's range, where ingress-nginx's pods take their addresses, with
recursion off. On GCP it trusts Google's two front-end ranges, `130.211.0.0/22`
and `35.191.0.0/16`, and the Ingress's reserved address, with recursion on, and
names container-native load balancing on the frontend Service, since through
instance groups the pod would see a node's address instead. Only a frontend
image of 0.2.0 or later reads either value; the 0.1.6 image ignores both and
keeps the shared allowance.

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

## Where the credentials come from

`secret.create` builds one, `secret.existingSecret` names one you built, and
naming both is refused — two sources of `DATABASE_URL` with no stated precedence
is a deployment nobody can reason about.

With `database.enabled` the two are allowed together, for one shape: the
connection string can only be derived here, because the password is generated
here, while the rest of the credentials should not travel through chart values,
which land in the release Secret and in Helm's history. So the chart's Secret
carries `DATABASE_URL` and yours carries everything else. The pods read the
chart's first and yours second, and a duplicate key is won by the later source —
so what you supplied beats what the chart worked out. That is what the `aws` and
`gcp` Pulumi programs do with `simple-balance:database` set to `in-cluster`.

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

With `networkPolicy.enabled`, name a scraper of your own in
`networkPolicy.serverIngressFrom` and `networkPolicy.schedulerIngressFrom`; the
chart's own collector, below, needs no naming. The scheduler's policy allows any
source in the cluster on its one port until `probeSourceCidrs` narrows it, at
which point a scraper that is not named there cannot reach the process that
reports ticks, proposals and mail.

The Service publishes no separate port for it and the frontend does not proxy
it, so a scrape reaches the pods directly — `kubernetes-pods` discovery with the
usual `prometheus.io/scrape` annotations through `server.podAnnotations` and
`scheduler.podAnnotations`, or a ServiceMonitor pointed at the existing port.

### The collector this chart can run

Or the chart scrapes them itself and sends the result on. `collector.enabled`
runs one OpenTelemetry Collector pod that finds every API and scheduler pod of
this release in its namespace, scrapes each one, and exports to one backend —
New Relic, or anything else that takes OTLP or Prometheus remote write. It is
the collector the compose recipes run under their `metrics` profile, with the
same export pipeline word for word, so a series means the same thing whichever
profile sent it.

```sh
kubectl -n simple-balance create secret generic simple-balance-metrics-export \
  --from-literal=SB_METRICS_EXPORT_HEADERS='{"api-key":"<license key>"}'
helm upgrade --install simple-balance deploy/helm/simple-balance \
  --reset-then-reuse-values \
  --set collector.enabled=true \
  --set collector.export.endpoint=https://otlp.nr-data.net \
  --set collector.export.existingSecret=simple-balance-metrics-export
```

`--reset-then-reuse-values` (Helm 3.14 or later), or the values file you
installed with, and not `--reuse-values`: that one carries the previous release's
defaults instead of this chart's, so a release installed before the collector
existed has no `collector.image` to run, and the schema refuses the upgrade
before anything changes.

| Value | Default | What it is |
| --- | --- | --- |
| `collector.enabled` | `false` | Runs the collector, and turns `config.metrics.enabled` on with it |
| `collector.export.endpoint` | none; required | OTLP base URL (`https://otlp.nr-data.net`, EU `https://otlp.eu01.nr-data.net`), or the whole remote-write URL |
| `collector.export.protocol` | `otlp` | `otlp` (HTTP, protobuf, gzip) or `prometheus_remote_write` |
| `collector.export.headers` | `{}` | The backend's credential as a header map, written into a Secret of the collector's own |
| `collector.export.existingSecret` | empty | Or a Secret you built, holding that map as JSON under `collector.export.existingSecretKey` |
| `collector.scrapeInterval` | `30s` | Minutes and seconds, under `5m` |
| `collector.environment` | `production` | `deployment.environment.name` on every series |

For New Relic the header map is `{"api-key":"<license key>"}` over OTLP, or
`{"Authorization":"Bearer <license key>"}` over remote write. It never goes in the
Secret the API and the scheduler read, because every key of that one is in their
environment; the collector reads it from its own, and reads `METRICS_TOKEN` from
the one the pods check it against.

There is one collector and never more: two would send every series twice, and a
backend that turns a cumulative counter into a rate — New Relic does — computes
nonsense from two copies of it. So the Deployment has no replica count to set,
no autoscaler, and recreates rather than rolls. It writes nothing anywhere, runs
as its image's non-root user with a read-only root filesystem and no
capabilities, and takes 128Mi, which the pipeline's memory limiter is written
against. It is the one pod in the release that mounts a service-account token,
because finding the pods is a watch on the API server; its Role reads pods in
this namespace and nothing else.

It scrapes no node, no ingress controller and no database: the cloud's own
monitoring has the nodes, and the rest is outside what it is for.

With `networkPolicy.enabled` it needs naming nowhere. It is admitted to the API
pods, and to the scheduler pods whenever `probeSourceCidrs` or
`schedulerIngressFrom` has narrowed that policy — while it has not, every source
in the cluster is admitted already. Its own policy is closed both ways whatever
`restrictEgress` says: nothing reaches it but the probes, and it reaches DNS, the
pods it scrapes, the export endpoint's port, and the Kubernetes API server on
`networkPolicy.apiServerPorts` (443 and 6443), which is the one destination named
by port alone because its address is the cluster's.

The `aws`, `gcp` and `oci` Pulumi programs turn it on when the stack sets
`SB_METRICS_EXPORT_ENDPOINT` in `simple-balance:env`, with the protocol, interval
and environment beside it and `SB_METRICS_EXPORT_HEADERS` in
`simple-balance:secrets`, which they put in a Secret of the collector's own.

Turning it on turns `config.metrics.enabled` on with it, over an explicit
`false` too, so the API and the scheduler roll once as their ConfigMap changes.
The collector rolls itself when its configuration, the headers Secret the chart
built or `secret.metricsToken` changes, and not when a Secret the chart did not
build does: after rotating a token or headers held in one of those — the
Pulumi programs' `simple-balance-metrics-export` among them — run
`kubectl -n <namespace> rollout restart deploy/<fullname>-collector`. Its own
series arrive under the job `collector` at `127.0.0.1:8888`.
[`docs/deployment.md`](../../../docs/deployment.md#metrics) has what each
backend wants and the alerts worth setting.

## Selling a plan and serving ads

Both arrive through `config.extraEnv`, with their secrets in the Secret:
`SB_BILLING_ENABLED`, `STRIPE_PUBLISHABLE_KEY` and the two
`STRIPE_PRICE_*_ID` values in `config.extraEnv`, and `secret.stripeSecretKey`
and `secret.stripeWebhookSecret`. The `ADSENSE_*` ids go in `config.extraEnv`
too, with `PRIVACY_POLICY_URL` beside them, because the server refuses to start
with AdSense configured and no policy to link to. `PRIVACY_POLICY_URL` and
`TERMS_OF_USE_URL` are optional otherwise and go there as well; either is linked
from the sign-in screen and every page once it is set. `SB_HOUSE_AD`, this
product's own advertisement for the paid plan, goes in `config.extraEnv` too,
and needs nothing below: it loads nothing, so nginx has no policy to widen for
it.

nginx serves every page here, so it decides the content security policy each
arrives with, and Stripe's payment form and AdSense each need a wider one than
the rest of the app allows. The chart tells it, the way the compose recipes do:
a `STRIPE_PUBLISHABLE_KEY` in `config.extraEnv` turns on
`SB_BILLING_CONFIGURED`, and an `ADSENSE_CLIENT_ID` turns on
`SB_ADS_CONFIGURED`. `frontend.billingConfigured` and `frontend.adsConfigured`
turn them on as well, for a key that reaches the pods by a route the render
cannot read, such as an `existingSecret` or a post-renderer. Without them the plan tab opens with no
card fields, or every page blocks the script AdSense asks it to run.

## Everything else

`values.yaml` documents every value where it is defined, including why the
defaults are what they are. `values.schema.json` is what `helm install` checks
before any of it renders.
