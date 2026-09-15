# Simple Balance on a cloud, with Pulumi

Four programs in two pairs, and the pairs stand up different things.

**The `ha` profile**, on Kubernetes: `aws/` and `gcp/`. Two programs, one for
AWS and one for GCP. Each builds a cluster, installs
cert-manager and an ingress controller, and installs the chart in
`deploy/helm/simple-balance`, which runs Simple Balance as the three workloads
`deploy/docker/` builds: the API (which also serves MCP), the nginx frontend
that serves the browser bundle and proxies everything the API owns, and the
recurrence scheduler.

They share `common/`, which is everything that does not differ: reading the
configuration, refusing a plan that would open more database connections than
the database allows, installing cert-manager with a Let's Encrypt ClusterIssuer,
putting the credentials in a Secret, and installing the chart.

**The `single` profile**, on one virtual machine: `aws-single/` and
`oci-single/`. One EC2 instance or one Oracle Cloud compute instance running the
application container, PostgreSQL and Caddy under systemd, with a separate data
disk the ledger lives on. They share `single-common/`, which holds the sizing
table both read and builds the cloud-init that turns a bare Ubuntu into the
deployment — from the compose files and units in this repository rather than
from a copy.

`docs/deployment-profiles.md` compares the two profiles and is where the choice
is argued. The short version: start with `single`.

Four separate Pulumi projects, and that is deliberate rather than incidental.
Putting the single-machine deployment inside the EKS program would put both in
one stack, where a mistake in either is a `pulumi up` that can destroy the
other — and where `pulumi destroy` on the thing you were finished with takes the
thing you were not.

## What these do not do

Except where a line says otherwise, this applies to all four.

- **No database, in the `ha` programs.** For `aws/` and `gcp/` the database is
  bring your own: nothing there provisions PostgreSQL, there is no in-cluster
  StatefulSet, and you supply a `DATABASE_URL` the cluster can reach. RDS, Cloud
  SQL, or a server you already run are all fine. If the database that URL names
  does not exist yet, the connecting role needs `CREATEDB`.

  The two `single` programs are the exception and do run one, on the machine,
  because a profile whose whole claim is one machine cannot send you elsewhere
  for the only stateful thing in it.
- **No backups, in the `ha` programs.** Everything is in PostgreSQL, so
  `pg_dump` backs up the product: see
  [docs/deployment.md](../../docs/deployment.md) and
  [docs/upgrades.md](../../docs/upgrades.md). Take one before every upgrade;
  neither program will remind you.

  The `single` programs are again the exception: they install a systemd timer
  that takes a daily dump onto the data disk and verifies it by reading it back.
  That protects against a mistake and not against losing the disk, so copy them
  somewhere else — see `deploy/compose/single/README.md`.
- **No DNS record.** Every program exports the address to point a record at, and
  you create the record. Nothing here owns a zone.
- **No image builds.** The release workflow publishes all three beside the
  single container, on the same tags, so the programs pull them rather than
  build them:

  ```
  ghcr.io/thtmnisamnstr/simple-balance-server:0.1.6
  ghcr.io/thtmnisamnstr/simple-balance-frontend:0.1.6
  ghcr.io/thtmnisamnstr/simple-balance-scheduler:0.1.6
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
  single-common/index.ts  the sizing table, and the cloud-init both
                        single-machine programs build from it
  aws-single/Pulumi.yaml  the simple-balance-aws-single project
  aws-single/index.ts   VPC, one subnet, security group, EBS data volume,
                        Elastic IP, an instance role granting a shell
                        through Session Manager rather than SSH
  oci-single/Pulumi.yaml  the simple-balance-oci-single project
  oci-single/index.ts   VCN, one subnet, security list, block volume,
                        reserved public IP, an Ampere A1 shape
```

They are four Pulumi projects with one `node_modules`, which is why `npm install`
runs here rather than in any of them.

The chart and the compose files are read from a local path, so run these from a
checkout of this repository. A copy of `deploy/pulumi/` on its own has no chart
to install and no deployment material to send to a machine — `single-common`
says so by name rather than failing on a path three levels from anything
recognisable.

```sh
cd deploy/pulumi
npm install
```

## Configuration

Every stack reads the same `simple-balance:` namespace, so a value means the
same thing in any of them — though the two profiles read different keys, and the
tables below say which.

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

## The single-machine stacks

Different keys from the two above, because there is no cluster, no chart and no
database URL to supply — the machine runs its own PostgreSQL.

| Key | Required | Default | What it is |
| --- | --- | --- | --- |
| `hostname` | yes | | The public DNS name. A name and nothing else: no scheme, no port, no path. Caddy obtains a certificate for it, so it has to resolve to the machine before HTTPS works |
| `size` | | `small` | `small`, `medium` or `large`. `docs/deployment-sizing.md` is the table, and it is the same table `single-common/index.ts` implements |
| `acmeEmail` | | | Where Let's Encrypt writes about a renewal that failed. Optional to them and worth setting |
| `allowedEmails` | | | Who may register. Empty admits nobody but the first account |
| `sshCidr` | | | One IPv4 CIDR allowed to reach port 22. Unset means no SSH ingress at all, which is the default; AWS gives a shell through Session Manager without it, and OCI through the Bastion service. `0.0.0.0/0` is refused, and so is a CIDR with no `sshPublicKey` — an open port nothing can answer is a rule in a firewall and a debugging session about the wrong thing |
| `sshPublicKey` | | | The contents of a `.pub` file. Refused if it looks like anything else, because a private key here would be a private key in your stack configuration. Allowed without `sshCidr`, which is how the OCI Bastion service reaches a machine that publishes no SSH port |
| `imageTag` | | the release | Which image tag to deploy |
| `imageRepository` | | `ghcr.io/thtmnisamnstr/simple-balance` | For a private mirror |
| `timezone` | | `Etc/UTC` | The machine's clock. Not the application's — that is each person's own setting |
| `backupKeep` | | `14` | How many daily dumps to retain on the data disk |
| `compartmentOcid` | OCI only | | Which compartment to build in. OCI has no default and the root compartment is a poor choice, since policies cannot be scoped to it |

There are deliberately **no secret keys here.** `AUTH_SECRET` and
`POSTGRES_PASSWORD` are generated on the machine at first boot and kept on the
data volume at `0600`, so neither enters user data — which is readable by
anyone who can describe the instance — nor Pulumi's state file. Nothing outside
the machine needs either value, and a rebuilt instance that reattaches the same
volume finds the same ones.

Settings that genuinely come from outside — an SMTP password, a Stripe key — go
in `/var/lib/simple-balance/env.local` on the machine, which is on the data
volume rather than the boot disk and is folded into `.env` whenever the setup
runs. `/opt` is destroyed when the instance is rebuilt; the data volume is not.

```sh
cd deploy/pulumi
npm install

# AWS
pulumi -C aws-single stack init books
pulumi -C aws-single config set aws:region us-west-2
pulumi -C aws-single config set simple-balance:hostname books.example.com
pulumi -C aws-single up

# Oracle Cloud. The provider reads ~/.oci/config unless the oci: namespace
# carries the credentials instead.
pulumi -C oci-single stack init books
pulumi -C oci-single config set oci:region us-ashburn-1
pulumi -C oci-single config set simple-balance:compartmentOcid ocid1.compartment.oc1..xxxx
pulumi -C oci-single config set simple-balance:hostname books.example.com
pulumi -C oci-single up
```

Both print a `nextSteps` output saying what is left, which is the A record and
finding the one-time setup code in the application's log. The certificate
arrives on its own once the name resolves; Caddy keeps retrying until it does.

**Replacing the machine keeps the ledger.** The data volume is a separate
resource from the instance and is formatted only when it is not already a
filesystem, so resizing — change `size`, deploy — destroys the root disk and
leaves the database, the backups, the two generated secrets and `env.local`
alone. Both programs pin the machine image with `ignoreChanges` for the opposite
reason: without it a new Canonical build every few weeks would replace the
instance on every `pulumi up`, which costs an outage nobody asked for.

**But a second `pulumi up` does not reconfigure the machine.** Cloud-init runs
once per instance, and neither program replaces the instance when the compose
files, the units or the image tag change — deliberately, because an instance
replacement on every edit is minutes of downtime and, on Oracle Cloud, a new
address. These programs provision a machine; they do not keep managing it. Do it
on the machine:

```sh
# An application upgrade.
sudo $EDITOR /opt/simple-balance/compose.yml       # the pinned image tag
sudo docker compose -f /opt/simple-balance/compose.yml pull
sudo systemctl restart simple-balance

# A setting.
sudo $EDITOR /var/lib/simple-balance/env.local
sudo systemctl restart simple-balance
```

Take a backup first either way: `sudo /usr/local/bin/simple-balance-backup`.

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
