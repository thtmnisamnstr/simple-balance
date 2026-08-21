# Simple Balance on Kubernetes, with Pulumi

Two programs, one for AWS and one for GCP. Each builds a cluster, installs
cert-manager and an ingress controller, and installs the chart in
`deploy/helm/simple-balance`, which runs Simple Balance as the three workloads
`deploy/docker/` builds: the API (which also serves MCP), the nginx frontend
that serves the browser bundle and proxies everything the API owns, and the
recurrence scheduler.

They share `common/`, which is everything that does not differ: reading the
configuration, refusing a plan that would open more database connections than
the database allows, installing cert-manager with a Let's Encrypt ClusterIssuer,
putting the credentials in a Secret, and installing the chart.

## What these do not do

- **No database.** The database is bring your own. Nothing here provisions
  PostgreSQL, and there is no in-cluster StatefulSet. You supply a
  `DATABASE_URL` that the cluster can reach. RDS, Cloud SQL, or a server you
  already run are all fine. If the database that URL names does not exist yet,
  the connecting role needs `CREATEDB`.
- **No backups.** Of anything, database included. Everything is in PostgreSQL,
  so `pg_dump` backs up the product: see [docs/deployment.md](../../docs/deployment.md)
  and [docs/upgrades.md](../../docs/upgrades.md). Take one before every upgrade.
  Neither program will remind you.
- **No DNS record.** Each program exports the address its load balancer answers
  on, and you create the record. Nothing here owns a zone.
- **No image builds.** The release workflow publishes all three beside the
  single container, on the same tags, so the programs pull them rather than
  build them:

  ```
  ghcr.io/thtmnisamnstr/simple-balance-server:0.1.4
  ghcr.io/thtmnisamnstr/simple-balance-frontend:0.1.4
  ghcr.io/thtmnisamnstr/simple-balance-scheduler:0.1.4
  ```

  Point `simple-balance:imageRepositoryPrefix` somewhere else only when you are
  running images you built yourself.

- **No mail and no Google sign-in.** Both are chart settings and neither is
  turned on here, so a deployment from these programs has local sign-in, no
  password reset, and asks nobody to confirm an address. Add
  `config.mail.*` and `config.google.clientId` to the chart values in
  `common/index.ts` if you want them, with the matching keys in the Secret.
- **No monitoring, alerting, or log retention policy** beyond what EKS and GKE
  switch on themselves. EKS control plane logs go to CloudWatch and stay there
  until you say otherwise.
- **No WAF, no private control plane, no bastion.** The Kubernetes API endpoint
  is reachable from the internet on both clouds, because otherwise `pulumi up`
  has to run from inside the network it is building. Authentication still
  applies. Restrict it afterwards if that matters to you.
- **No secret rotation.** `AUTH_SECRET` signs sessions, so changing it signs
  everybody out. It is set once, from your Pulumi config, and never rotated.
- **Not free.** A managed control plane, three or more nodes, a load balancer
  and a NAT gateway are all billed by the hour whether or not anybody signs in.

## What you bring

- The Pulumi CLI, Node 20 or newer, and `kubectl`.
- An AWS account and the `aws` CLI (the generated kubeconfig calls
  `aws eks get-token`), or a GCP project with `gcloud` and
  `gke-gcloud-auth-plugin` (`gcloud components install gke-gcloud-auth-plugin`).
- A PostgreSQL database and its connection string.
- A DNS name you control, and the ability to add a record for it.
- An `AUTH_SECRET`: `openssl rand -base64 32`. Keep it. Startup refuses the
  published placeholders, so there is nothing to leave in by accident.

## Layout

```
deploy/pulumi/
  package.json          one set of dependencies for both projects
  tsconfig.json         the base both projects extend
  common/index.ts       config, validation, cert-manager, the chart
  aws/Pulumi.yaml       the simple-balance-aws project
  aws/index.ts          VPC, EKS, node group, load balancer controller,
                        ingress-nginx, cluster autoscaler
  gcp/Pulumi.yaml       the simple-balance-gcp project
  gcp/index.ts          VPC, GKE, node pool, node auto-provisioning,
                        the GKE ingress, reserved addresses
```

They are two Pulumi projects with one `node_modules`, which is why `npm install`
runs here rather than in `aws/` or `gcp/`.

The chart is installed from a local path, so run these from a checkout of this
repository. A copy of `deploy/pulumi/` on its own has no chart to install.

```sh
cd deploy/pulumi
npm install
```

## Configuration

Both stacks read the same `simple-balance:` namespace, so a value means the
same thing in either one.

| Key | Required | Default | What it is |
| --- | --- | --- | --- |
| `simple-balance:hostname` | yes | | The name the site answers on. A DNS name only: no scheme, no port, no path. `APP_BASE_URL` is built from it. |
| `simple-balance:acmeEmail` | yes | | The Let's Encrypt account address. Expiry warnings go here. |
| `simple-balance:databaseUrl` | yes, secret | | Set with `--secret`. Never plaintext. |
| `simple-balance:authSecret` | yes, secret | | Set with `--secret`. Sessions are signed with it. |
| `simple-balance:directDatabaseUrl` | no, secret | | A string that reaches PostgreSQL past a transaction pooler. Migrations and the first-account claim hold session-level advisory locks, which through a pooler are taken on one connection and released on another. Leave it unset when there is no pooler. |
| `simple-balance:setupToken` | no, secret | | The one-time code that claims the first account, at least 16 characters. Set with `--secret`. Left unset, one is generated and stored in the database, and printed to the startup log of whichever API pod reads it first. |
| `simple-balance:acmeStaging` | no | `false` | Issue from Let's Encrypt's staging endpoint, whose rate limits are generous and whose certificates no browser trusts. Worth using while you are still getting DNS wrong. |
| `simple-balance:allowedEmails` | no | `""` | Who may register: addresses, domains, or `*`. Empty admits nobody but the first account. |
| `simple-balance:namespace` | no | `simple-balance` | |
| `simple-balance:imageRegistry` | no | `ghcr.io` | |
| `simple-balance:imageRepositoryPrefix` | no | `thtmnisamnstr` | The owner half of the three repository names. |
| `simple-balance:imageTag` | no | the chart's appVersion | |
| `simple-balance:databasePoolSize` | no | `10` | Connections each API and scheduler replica holds. |
| `simple-balance:serverMaxReplicas` | no | `4` | The API tier's HPA ceiling. |
| `simple-balance:frontendMaxReplicas` | no | `4` | |
| `simple-balance:schedulerMaxReplicas` | no | `2` | |
| `simple-balance:maxConnections` | no | `100` | What your database allows. See below. |
| `simple-balance:kubernetesVersion` | no | the cloud's default | EKS only. GKE takes its version from the regular release channel. |
| `aws:region` | yes, AWS | | |
| `gcp:project`, `gcp:region` | yes, GCP | | |

## AWS

```sh
cd deploy/pulumi/aws
pulumi stack init production
pulumi config set aws:region us-west-2
pulumi config set simple-balance:hostname balance.example.com
pulumi config set simple-balance:acmeEmail ops@example.com
pulumi config set --secret simple-balance:databaseUrl 'postgresql://user:pass@host:5432/simple_balance'
pulumi config set --secret simple-balance:authSecret "$(openssl rand -base64 32)"
pulumi up
```

What it builds: a VPC across three availability zones with public and private
subnets, one NAT gateway, an EKS cluster using access entries rather than the
deprecated `aws-auth` ConfigMap, a managed node group of `t3.large` instances
that scales from two to six, the AWS Load Balancer Controller, ingress-nginx
behind a network load balancer, the Kubernetes cluster autoscaler, cert-manager,
a Let's Encrypt ClusterIssuer, and the chart.

Two things worth knowing about the shape of it:

- **ingress-nginx sits behind the load balancer controller rather than instead
  of it.** An ALB can only serve a certificate that lives in ACM, and
  cert-manager issues into a Kubernetes Secret. So the controller does what it
  is good at here, which is putting a network load balancer in front of a
  Service, and nginx terminates TLS with the Let's Encrypt certificate behind
  it. Swap in an ALB Ingress and an ACM certificate if you would rather have
  that, and the ClusterIssuer becomes decoration.
- **The cluster autoscaler needs no ASG tags from this program.** EKS tags a
  managed node group's autoscaling group with the two keys auto-discovery looks
  for.

Exports: `ingressAddress` (the load balancer hostname to point a CNAME at),
`egressAddress` (the NAT gateway's address, for a database that allows by
source), `clusterName`, `namespace`, `kubeconfig`, `appUrl`, `dnsRecord`.

```sh
pulumi stack output ingressAddress
aws eks update-kubeconfig --name "$(pulumi stack output clusterName)"
```

## GCP

```sh
cd deploy/pulumi/gcp
pulumi stack init production
pulumi config set gcp:project my-project
pulumi config set gcp:region us-central1
pulumi config set simple-balance:hostname balance.example.com
pulumi config set simple-balance:acmeEmail ops@example.com
pulumi config set --secret simple-balance:databaseUrl 'postgresql://user:pass@host:5432/simple_balance'
pulumi config set --secret simple-balance:authSecret "$(openssl rand -base64 32)"
pulumi up
```

What it builds: a VPC-native network with secondary ranges for pods and
services, Cloud NAT on a reserved address, a regional GKE cluster on the regular
release channel with workload identity, a node pool of `e2-standard-2` machines
that scales from one to three per zone, node auto-provisioning for pods that fit
in no existing pool, a reserved global address for the ingress, cert-manager, a
Let's Encrypt ClusterIssuer, and the chart.

Two things worth knowing about the shape of it:

- **The ingress controller is a GKE addon, not a Helm release.** There is
  nothing to install for it. The program keeps `httpLoadBalancing` explicitly
  enabled, because turning it off leaves every Ingress unanswered.
- **The ACME solver reuses the Ingress the chart creates** rather than making
  its own. On GKE a new Ingress means a new load balancer on a new address,
  which is not the address your DNS record names, and the challenge would go
  unanswered forever.

Exports: `ingressIpAddress` (the reserved address to point an A record at, known
before anything else finishes), `egressAddress` (Cloud NAT's address, for a
database that allows by source), `clusterName`, `namespace`, `kubeconfig`,
`appUrl`, `dnsRecord`.

```sh
pulumi stack output ingressIpAddress
gcloud container clusters get-credentials "$(pulumi stack output clusterName)" --region "$(pulumi config get gcp:region)"
```

## After the first `pulumi up`

1. **Create the DNS record.** `pulumi stack output dnsRecord` prints the record
   to create: a CNAME on AWS, an A record on GCP.
2. **Wait for the certificate.** cert-manager cannot answer an HTTP-01 challenge
   until the name resolves to the ingress, so the certificate arrives some
   minutes after the record does.

   ```sh
   kubectl -n simple-balance get certificate
   kubectl -n simple-balance describe certificate simple-balance-tls
   ```

   A challenge that failed before DNS existed is retried with a backoff that
   grows to about an hour. If you would rather not wait, delete the failed order
   and cert-manager starts over:
   `kubectl -n simple-balance delete order --all`.
3. **Claim the first account** at `https://<hostname>/`. If you set
   `simple-balance:setupToken`, that is the one-time code. Otherwise one is
   generated once for the deployment and stored, so every API pod prints the same
   one and any pod's log has it:
   `kubectl -n simple-balance logs deploy/simple-balance-server | grep -i setup`.
   Then set `simple-balance:allowedEmails` to say who else may register. Left
   empty, nobody but that first account can.

Upgrading is `simple-balance:imageTag` and `pulumi up`. Migrations run at
startup under an advisory lock, so concurrent replicas cannot race, and
readiness stays closed until they finish. Back up first.

## Scaling and the connection ceiling

Every API and scheduler replica holds `databasePoolSize` connections and takes
one more while it starts. The frontend is nginx and holds none. So the number
that has to fit is

```
(serverMaxReplicas + schedulerMaxReplicas) x (databasePoolSize + 1)
```

against your server's `max_connections`, which PostgreSQL defaults to 100. At
the defaults here that is `(4 + 2) x 11 = 66`. `readSettings` refuses to plan a
stack where it exceeds `simple-balance:maxConnections`, so raise
`max_connections` and say so, lower the pool, lower a ceiling, or put a pooler
in front and set `simple-balance:directDatabaseUrl`.

The scheduler tier scales freely. A tick claims each recurrence with
`for update skip locked`, so there is no leader and no lease: replicas divide
the due rows between them.

## Things that will surprise you

- **Sign-in rate limiting counts every visitor as one.** The frontend's nginx
  replaces `X-Forwarded-For` with `$remote_addr`, which is right when it is the
  first hop and wrong when an ingress terminating TLS sits in front of it, which
  is the case here. `TRUST_PROXY` is on, so the allowance the API applies per
  address is shared by everybody. The fix is `set_real_ip_from` in
  `deploy/docker/nginx.conf.template` and a rebuilt frontend image; see
  "Splitting it into separate containers" in
  [docs/deployment.md](../../docs/deployment.md).
- **On GCP the site answers on plain HTTP as well as HTTPS.** `allow-http` has
  to stay on for the ACME challenge, which is answered on this Ingress every
  time the certificate renews, and neither program adds a redirect. HSTS, which
  both the API and the frontend set, upgrades a browser that has been once.
- **The GKE Ingress ignores `nginx.ingress.kubernetes.io/proxy-body-size`.** It
  is in the chart's defaults, so it renders on the GKE Ingress too, where it
  does nothing. What bounds a CSV import there is `CSV_MAX_BYTES` and the
  frontend's `SB_MAX_UPLOAD_SIZE`, plus whatever the Google load balancer caps
  outside Kubernetes.
- **`pulumi destroy` leaves nothing behind except what it never made**, which is
  your database. Delete the stack and the cluster goes with it, certificates and
  load balancer included.

## Version pins

Everything is pinned so an install is repeatable, and every pin ages. The
Kubernetes version is deliberately not one of them: EKS creates its current
default and GKE follows the regular release channel.

| What | Where | Version |
| --- | --- | --- |
| Pulumi SDKs | `package.json` | see the file |
| cert-manager | `common/index.ts` | `v1.21.1` |
| AWS Load Balancer Controller | `aws/index.ts` | `3.5.0` |
| ingress-nginx | `aws/index.ts` | `4.15.1` |
| Kubernetes cluster autoscaler | `aws/index.ts` | `9.59.0` |

`npm run typecheck` compiles both programs without deploying anything, which is
the cheapest way to find out that an SDK upgrade moved an API.
