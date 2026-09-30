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
putting the credentials in a Secret, and installing the chart. Both build the
`ha` profile's redundant shape; its smaller one node per service shape is the
same chart with a different values file, reached with `helm` rather than from
here — `docs/deployment-profiles.md` has both.

**The `single` profile**, on two virtual machines: `aws-single/` and
`oci-single/`. One `pulumi up` builds an application node — the application
container and Caddy under systemd, with a public address — and a database node
running PostgreSQL 18 in a container on a private subnet with no public address
at all. Each has a data disk of its own that outlives it: the backups, the
generated secret and the settings added by hand on the first, `PGDATA` on the
second. They share `single-common/`, which holds the sizing table both read, the
certificate chain that lets the application verify the database, and the
cloud-init that turns a bare Ubuntu into either machine — from the compose files
and units in this repository rather than from a copy.

`simple-balance:databaseNode: false` builds no database node and no private
subnet, and the application node then waits for a `DATABASE_URL` you write on
it, which is what these programs did before.

`docs/deployment-profiles.md` compares the two profiles and is where the choice
is argued. The short version: start with `single`.

Four separate Pulumi projects, and that is deliberate rather than incidental.
Putting the single-machine deployment inside the EKS program would put both in
one stack, where a mistake in either is a `pulumi up` that can destroy the
other — and where `pulumi destroy` on the thing you were finished with takes the
thing you were not.

## What these do not do

Except where a line says otherwise, this applies to all four.

- **No database in the `ha` programs unless you ask for one.**
  `simple-balance:database` is a closed set — `external`, the default, or
  `in-cluster`. Left alone it is exactly what every release before this one did:
  you supply `simple-balance:databaseUrl`, and RDS, Cloud SQL, OCI Database with
  PostgreSQL or a server you already run are all fine at PostgreSQL 15 or later.
  If the database that URL names does not exist yet, the connecting role needs
  `CREATEDB`. Set it to `in-cluster` and the program turns on the chart's own
  Citus cluster instead, builds an encrypted StorageClass for it and refuses a
  `databaseUrl` at plan time rather than three minutes into a rollout.

  **The `single` programs build one by default**, on a second machine, and
  `simple-balance:databaseNode: false` is how to have them build none — see
  [the single-machine stacks](#the-single-machine-stacks). `oci-single` still
  makes the private subnet an OCI managed database goes in, for anyone who wants
  that instead.
- **No backups, in the `ha` programs.** Everything is in PostgreSQL, so
  `pg_dump` backs up the product: see
  [docs/deployment.md](../../docs/deployment.md) and
  [docs/upgrades.md](../../docs/upgrades.md). Take one before every upgrade;
  neither program will remind you. That is true whether the database is yours or
  the cluster's: turning `database.enabled` on installs Patroni and Citus, not a
  backup schedule, and `docs/citus-runbook.md` is the operations half.

  The `single` programs are the exception: they install a systemd timer on the
  application node that takes a daily dump over the network from the database
  node, onto the application node's data disk, and verifies it by reading it
  back before keeping it. The dumps are deliberately on the other machine — a
  copy on the same disk as the original is not a backup — but that still
  protects against a mistake rather than against losing both, so copy them
  somewhere else; `deploy/compose/single/README.md` has the commands.
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

  Point `simple-balance:imageRepositoryPrefix` somewhere else only for a private
  mirror of them. Every program deploys the pinned release image, which until
  0.2.0 is released is 0.1.6 and predates billing, ads and the frontend's
  trusted-proxy setting; `simple-balance:imageTag` selects another published
  release.

- **No mail and no Google sign-in, in the `ha` programs.** Both are chart
  settings and neither is turned on here, so a deployment from these programs
  has local sign-in, no password reset, and asks nobody to confirm an address.
  Add `config.mail.*` and `config.google.clientId` to the chart values in
  `common/index.ts` if you want them, with the matching keys in the Secret. The
  `single` programs take mail and Google through `env.local` instead.
- **No billing and no ads, in the `ha` programs.** Neither is turned on here,
  and there is no stack setting for either. To sell the plan, edit
  `common/index.ts` in three places: add `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` to `credentialData`, read with `cfg.requireSecret`;
  put `SB_BILLING_ENABLED`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_MONTHLY_ID`
  and `STRIPE_PRICE_YEARLY_ID` in the chart's `config.extraEnv`; and set
  `frontend.billingConfigured: true`, which the frontend's content security
  policy for the plan page keys on. Ads are the same shape: `ADSENSE_CLIENT_ID`,
  `ADSENSE_BANNER_SLOT_ID`, `ADSENSE_FOOTER_SLOT_ID`, `ADSENSE_CONSENT_MANAGED`
  and `PRIVACY_POLICY_URL` — which the server refuses to start without once
  AdSense is set — in `config.extraEnv`, and `frontend.adsConfigured: true`.
  `TERMS_OF_USE_URL` goes in `config.extraEnv` too, and so does
  `PRIVACY_POLICY_URL` on a deployment with no ads: both are optional there, and
  linked from the sign-in screen and every page once set. The `single` programs
  take all of it through `env.local`.
- **No monitoring, alerting, or log retention policy** beyond what EKS and GKE
  switch on themselves. EKS control plane logs go to CloudWatch and stay there
  until you say otherwise.
- **No WAF and no bastion, in the `ha` programs.** The Kubernetes API endpoint
  is reachable from the internet on both clouds by default, because otherwise
  `pulumi up` has to run from inside the network it is building. Authentication
  still applies. `simple-balance:controlPlaneCidrs` narrows it to a list of
  CIDRs on either cloud; it is unset by default, because a wrong guess locks a
  stack out of the control plane it would need to fix itself. Nothing else the
  programs build is reachable from the internet, the database least of all.
- **No secret rotation.** `AUTH_SECRET` signs sessions, so changing it signs
  everybody out. The `ha` programs set it once, from your Pulumi config; the
  single-machine ones generate it once, on the application node's data disk.
  Neither rotates it, and neither rotates the database's certificate — see
  [rotating the database's certificate](#rotating-the-databases-certificate).
- **The provider's own key, unless you name one.** Every disk and every volume
  these programs build is encrypted at rest, and by default always with the
  provider's own key: `encrypted: true` on AWS, where encryption-by-default is
  an account setting that is off on a fresh account and the property is
  therefore the whole guarantee; Oracle Cloud's unconditional volume encryption
  on OCI; an encrypted gp3 StorageClass on EKS; Google's own keys on GKE. The
  single-machine programs take a key of your own —
  `simple-balance:kmsKeyArn` on AWS, `simple-balance:kmsVaultOcid` with
  `simple-balance:kmsKeyOcid` on Oracle Cloud — and **accept one rather than
  creating one**, because a key a program creates has the program's lifetime and
  that is the wrong lifetime for the thing that decrypts a ledger: this
  profile's own teardown keeps the data volumes and would have scheduled the
  key's deletion. **Read `docs/deployment-profiles.md` §Encryption before
  setting either.** A volume's key is fixed when the volume is created, so on
  AWS adding one to a stack that exists asks to replace both data volumes, which
  `simple-balance:kmsKeyArnIsNewStack` exists to stop you doing by accident; and a key that is
  later disabled or deleted is a volume nobody can read, with a 7-to-30-day
  window to undo it and nothing after. The `ha` programs create a key for one
  thing only, the Kubernetes Secrets in etcd, where neither cloud offers a
  managed one.
- **The database node's egress is a NAT gateway on AWS, at $36.50 a month.** It
  is 38% of the `small` bill and it buys three things: Ubuntu's archive, the
  image registry, and Session Manager — which is the only shell onto a machine
  with no public address, and the reason "just remove the gateway" is the wrong
  instinct. `simple-balance:databaseEgress` is the setting, it defaults to
  `nat`, and `ipv6` builds an egress-only internet gateway instead at no charge,
  reaching the machine by SSH from the application node rather than by Session
  Manager. Oracle Cloud charges nothing for its NAT gateway and needs none of
  this. `docs/deployment-costs.md` compares them, including the two free-looking
  answers that do not work — an S3 gateway endpoint reaches neither Ubuntu's
  mirrors nor Docker Hub, and interface endpoints cost the NAT gateway's price
  in five parts.
- **The `ha` programs are not free.** A managed control plane, three or more
  nodes, a load balancer and a NAT gateway are all billed by the hour whether or
  not anybody signs in, and `database: in-cluster` adds the database's own
  nodes and volumes. `oci-single`'s two machines can sit inside Oracle's Always
  Free allowance at `small`, and land on it exactly — `docs/deployment-costs.md`
  does the arithmetic. An OCI managed database instead is a separate question:
  OCI Database with PostgreSQL is not part of Always Free, so it is billed, and
  any other PostgreSQL 15 or later the machine can reach — one you run yourself
  included — costs whatever it runs on.

## What you bring

- The Pulumi CLI and Node 20 or newer, for all four.
- For `aws/` and `gcp/`: `kubectl`, and an AWS account with the `aws` CLI (the
  generated kubeconfig calls `aws eks get-token`), or a GCP project with
  `gcloud` and `gke-gcloud-auth-plugin`
  (`gcloud components install gke-gcloud-auth-plugin`).
- For `aws-single/`: an AWS account whose credentials the Pulumi AWS provider
  can find, and the `aws` CLI with the Session Manager plugin for the shell.
  The credentials may come from the environment or a profile; the region may
  not: the program requires `aws:region` in the stack and refuses to run
  without it, so the machine is built where the stack says rather than
  wherever the `AWS_REGION` of whoever runs `pulumi up` points.
- For `oci-single/`: an Oracle Cloud tenancy, a compartment other than the root
  one (its OCID is `simple-balance:compartmentOcid`), and an API signing key for
  the provider. `oci setup config`, or Console → your profile → API keys → Add
  API key, writes the `[DEFAULT]` profile of `~/.oci/config` — `user`,
  `fingerprint`, `tenancy`, `region` and `key_file` — which the provider reads
  for everything but the region: the program requires `oci:region` in the
  stack and refuses to run without it, so the machine is built where the stack
  says rather than wherever the profile of whoever runs `pulumi up` points.
  Or give it the same values as `oci:tenancyOcid`, `oci:userOcid`,
  `oci:fingerprint` and `oci:privateKeyPath` (or `oci:privateKey`), and
  `oci:configFileProfile` picks a profile other than `DEFAULT`. `pulumi up`
  needs no `oci` CLI; the Bastion commands `nextSteps` prints do, and the
  console does the same by hand. An administrator needs nothing more. Anybody
  else needs a group with these policies:

  ```
  Allow group <group> to manage virtual-network-family in compartment <compartment>
  Allow group <group> to manage instance-family in compartment <compartment>
  Allow group <group> to manage volume-family in compartment <compartment>
  Allow group <group> to manage bastion-family in compartment <compartment>
  ```

  and whatever the PostgreSQL service's own documentation asks for, if the
  database is to be an OCI one.

- For `oci-single/`, an SSH key pair. The public half is required: OCI installs
  it at launch and never again, and it is the only way onto either machine.
- **A PostgreSQL 15 or later database and its connection string**, for `aws/`
  and `gcp/` unless `simple-balance:database` is `in-cluster`, and for the
  single-machine programs only when `simple-balance:databaseNode` is `false`.
  Otherwise the program builds one and generates the string. See
  [Reaching the database over a network](../../docs/deployment.md#reaching-the-database-over-a-network)
  for which `sslmode`.
- A DNS name you control, and the ability to add a record for it.
- For `aws/` and `gcp/`, an `AUTH_SECRET`: `openssl rand -base64 32`. Keep it.
  Startup refuses the published placeholders, so there is nothing to leave in by
  accident. The single-machine programs generate their own.

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
  single-common/index.ts  the sizing table and the settings both
                        single-machine programs read
  single-common/cloud-init.ts  the two cloud-init documents they send, one
                        per machine, and their size checks
  single-common/tls.ts  the private CA and the database's server certificate
  aws-single/Pulumi.yaml  the simple-balance-aws-single project
  aws-single/index.ts   VPC, a public subnet and a private one, two security
                        groups, two encrypted EBS data volumes, the database
                        subnet's egress — a NAT gateway, or an egress-only
                        internet gateway with `databaseEgress: ipv6` — an
                        Elastic IP, two instances, and instance roles granting
                        a shell through Session Manager rather than SSH
  aws-single/platform.ts  the user data it sends, the region, and the
                        internal DNS name the certificate has to carry
  oci-single/Pulumi.yaml  the simple-balance-oci-single project
  oci-single/index.ts   VCN, a public subnet and a private one, two security
                        lists, two block volumes, a NAT gateway, an
                        ephemeral public IP on the application node only
                        (promote it to reserved in the console to outlive
                        the instance), two Ampere A1 shapes
  oci-single/platform.ts  the disk floor, the availability domain and when
                        a data volume refuses a new one, the region, the
                        metadata it sends, the database node's own firewall
                        commands, and the VCN-internal DNS name
```

The two `platform.ts` files and `cloud-init.ts` import nothing from Pulumi, so
`tests/cloud-init.test.ts` renders exactly what a `pulumi up` sends and holds it
under both providers' limits on user data.

They are four Pulumi projects with one `node_modules`, which is why `npm install`
runs here rather than in any of them.

The chart and the compose files are read from a local path, so run these from a
checkout of this repository. A copy of `deploy/pulumi/` on its own has no chart
to install and no deployment material to send to a machine — `single-common`
says so by name rather than failing on a path three levels from anything
recognizable.

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
| `simple-balance:database` | no | `external` | `external` or `in-cluster`. `external` is what every release so far has done: you supply `databaseUrl`. `in-cluster` turns on the chart's PostgreSQL 18 with Citus under Patroni, derives the connection string with `sslmode=verify-full` against a CA the chart generates, names the encrypted StorageClass the program creates, and refuses a `databaseUrl` set alongside it rather than letting the chart refuse it mid-rollout. |
| `simple-balance:databaseUrl` | yes with `database: external`, secret | | Set with `--secret`. Never plaintext. Refused with `database: in-cluster`. |
| `simple-balance:controlPlaneCidrs` | no | open | Which addresses may reach the Kubernetes API endpoint, separated by commas or spaces. Unset leaves both clouds as they were, which is open to the internet with authentication in front; narrowing it is the operator's call because a wrong guess locks the stack out of the control plane it would need to fix itself. |
| `simple-balance:authSecret` | yes, secret | | Set with `--secret`. Sessions are signed with it. |
| `simple-balance:directDatabaseUrl` | no, secret | | A string that reaches PostgreSQL past a transaction pooler. Migrations and the first-account claim hold session-level advisory locks, which through a pooler are taken on one connection and released on another. Leave it unset when there is no pooler. |
| `simple-balance:setupToken` | no, secret | | The one-time code that claims the first account, at least 16 characters. Set with `--secret`. Left unset, one is generated and stored in the database, and printed to the startup log of whichever API pod reads it first. |
| `simple-balance:acmeStaging` | no | `false` | Issue from Let's Encrypt's staging endpoint, whose rate limits are generous and whose certificates no browser trusts. Worth using while you are still getting DNS wrong. |
| `simple-balance:allowedEmails` | no | `""` | Who may register: addresses, domains, or `*`. Empty admits nobody but the first account. |
| `simple-balance:namespace` | no | `simple-balance` | |
| `simple-balance:imageRegistry` | no | `ghcr.io` | |
| `simple-balance:imageRepositoryPrefix` | no | `thtmnisamnstr` | The owner half of the three repository names. |
| `simple-balance:imageTag` | no | the chart's appVersion | Another published release, for all three images. |
| `simple-balance:databasePoolSize` | no | `10` | Connections each API and scheduler replica holds. |
| `simple-balance:serverMaxReplicas` | no | `4` | The API tier's HPA ceiling. |
| `simple-balance:frontendMaxReplicas` | no | `4` | |
| `simple-balance:schedulerMaxReplicas` | no | `2` | |
| `simple-balance:maxConnections` | no | `100`, or `200` with `database: in-cluster` | What the database allows. Unset, it stands for a stock PostgreSQL; with an in-cluster database it is read from the chart's own `max_connections` instead, because 100 there would refuse replica ceilings the cluster could serve. See below. |
| `simple-balance:kubernetesVersion` | no | the cloud's default | EKS only. GKE takes its version from the regular release channel. |
| `simple-balance:trustedProxyCidr` | no | the program's own: on AWS the VPC's `10.0.0.0/16`, recursion off; on GCP `130.211.0.0/22`, `35.191.0.0/16` and the Ingress's reserved address, recursion on | What the frontend's nginx believes `X-Forwarded-For` from: one address or CIDR, or several separated by commas or spaces, each a proxy's own and nothing wider. Passed as the chart's `frontend.trustedProxyCidr`. Set, it replaces the program's list whole, with recursion off unless `simple-balance:realIpRecursive` says otherwise. Leave it unset unless you have changed what sits in front: the program's list is worked out for the network it built, and [things that will surprise you](#things-that-will-surprise-you) says why each cloud's is what it is. |
| `simple-balance:realIpRecursive` | no | the program's (AWS off, GCP on); off beside your own `trustedProxyCidr` | Passed as the chart's `frontend.realIpRecursive`. On, nginx walks `X-Forwarded-For` from the right past every trusted address to the first that is not, which a chain of proxies that each append needs; off, it takes the last entry, which is right behind one that replaces the header. Set, it wins over the program's choice either way. |
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
behind a network load balancer that speaks proxy protocol to it, the Kubernetes
cluster autoscaler, cert-manager, a Let's Encrypt ClusterIssuer, and the chart.

Three things worth knowing about the shape of it:

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
- **The load balancer hands ingress-nginx the visitor's address by proxy
  protocol.** An NLB with IP targets connects from its own address and passes
  nothing on, so without it ingress-nginx sees the load balancer and every
  visitor's sign-in attempts count against one allowance. The program turns
  proxy protocol v2 on at both ends in the one ingress-nginx release — the
  Service's `aws-load-balancer-proxy-protocol: "*"` and the controller's
  `use-proxy-protocol` — because each end refuses what the other sends without
  it. ingress-nginx believes the header only from the three public subnets
  (`proxy-real-ip-cidr`), which are where the load balancer's nodes take their
  addresses, and never from the private subnets every pod is in, so a pod that
  writes a header of its own is counted as itself. It then replaces
  `X-Forwarded-For` with the visitor's address, and the frontend trusts the
  VPC's range, where ingress-nginx's pods are, with recursion off. The load
  balancer's health check is HTTP `/healthz` on port 80 rather than the
  controller's 10254: AWS sends the proxy protocol header on health checks too,
  and the controller's own server on 10254 cannot parse it.

And three that the database in the cluster needs, built whether or not you ask
for it because the first two are worth having either way:

- **A KMS key and `encryptionConfigKeyArn` on the cluster**, so the Secrets
  holding `DATABASE_URL`, `AUTH_SECRET`, any Stripe key and the database's own
  passwords are envelope-encrypted in etcd rather than merely base64. **On an
  existing cluster this is an in-place change and it cannot be undone** — EKS
  has no way to turn envelope encryption back off. The cluster keeps serving;
  `docs/upgrades.md` says so where an operator will meet it.
- **The VPC CNI's network policy agent**, because a `NetworkPolicy` the plugin
  ignores is worse than none: the cluster then looks guarded in
  `kubectl get networkpolicy` and enforces nothing. The program stops using
  EKS's default managed add-on so it can set that option, which rolls the
  `aws-node` DaemonSet once — pods keep running, address assignment pauses per
  node.
- **The `aws-ebs-csi-driver` add-on with an IRSA role, and a
  `simple-balance-gp3-encrypted` StorageClass** — gp3, `encrypted: "true"`,
  `WaitForFirstConsumer`, expansion on, `Retain`. Without the driver a
  PersistentVolumeClaim from the database StatefulSet sits `Pending` forever on
  EKS 1.23 and later, which is the failure that looks like a hung install.

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

Three things worth knowing about the shape of it:

- **The ingress controller is a GKE addon, not a Helm release.** There is
  nothing to install for it. The program keeps `httpLoadBalancing` explicitly
  enabled, because turning it off leaves every Ingress unanswered.
- **The ACME solver reuses the Ingress the chart creates** rather than making
  its own. On GKE a new Ingress means a new load balancer on a new address,
  which is not the address your DNS record names, and the challenge would go
  unanswered forever.
- **The frontend's Service names container-native load balancing**,
  `cloud.google.com/neg: '{"ingress": true}'`, rather than inheriting GKE's
  default, which holds only while the cluster keeps four properties this one
  has. Through network endpoint groups Google's front ends connect to the
  frontend pod itself; through instance groups kube-proxy would hand the pod a
  node's address instead. The load balancer connects from `130.211.0.0/22` and
  `35.191.0.0/16` and appends `<client-ip>,<load-balancer-ip>` to whatever
  `X-Forwarded-For` the visitor sent, so the frontend trusts both ranges and the
  Ingress's reserved address, with recursion on: nginx walks past the load
  balancer's address and stops at the one the load balancer wrote from its own
  socket, and never reads anything the visitor wrote before it.

And two the database in the cluster needs:

- **Cloud KMS and `databaseEncryption` on the cluster**, envelope-encrypting the
  same Secrets in etcd, and a `simple-balance-pd-balanced` StorageClass for the
  database's volumes. Persistent disks are encrypted with Google's own keys and
  there is no customer key on them, deliberately.
- **Dataplane V2**, `datapathProvider: ADVANCED_DATAPATH`, which is what
  enforces a `NetworkPolicy` on GKE. Deliberately **not** the legacy Calico
  addon: `networkPolicyConfig` disables container-native load balancing, which
  would take the frontend's client-address handling with it. **The provider
  treats this as a property that replaces the cluster**, so an existing
  external-database stack that switches to `in-cluster` will see a replacement
  in `pulumi preview`. Run
  `gcloud container clusters update <name> --enable-dataplane-v2` first and the
  plan is then a no-op.

Exports: `ingressIpAddress` (the reserved address to point an A record at, known
before anything else finishes), `egressAddress` (Cloud NAT's address, for a
database that allows by source), `clusterName`, `namespace`, `kubeconfig`,
`appUrl`, `dnsRecord`.

```sh
pulumi stack output ingressIpAddress
gcloud container clusters get-credentials "$(pulumi stack output clusterName)" --region "$(pulumi config get gcp:region)"
```

## The single-machine stacks

Different keys from the two above, because there is no cluster and no chart.
Each program builds **two machines**: an application node with a public address,
running the application container and Caddy, and a database node with none,
running PostgreSQL 18 in a container on a private subnet. The application
reaches it over the provider's private network under `sslmode=verify-full`,
against a certificate the program issues. Nothing on the internet can reach the
database node at all, and nothing but the application node can reach 5432 on it.

`simple-balance:databaseNode: false` builds neither the second machine nor the
private subnet nor the NAT gateway, and the application node then waits for a
`DATABASE_URL` you write on it —
[below](#database_url-goes-on-the-machine).

| Key | Required | Default | What it is |
| --- | --- | --- | --- |
| `hostname` | yes | | The public DNS name. A name and nothing else: no scheme, no port, no path. Caddy obtains a certificate for it, so it has to resolve to the machine before HTTPS works |
| `size` | | `small` | The **application half** of the row `small`, `medium` or `large`: the application node's machine and its data disk, which holds the nightly dumps and grows with `backupKeep` rather than with the machine. `docs/deployment-sizing.md` is the table, and it is the same table `single-common/index.ts` implements |
| `databaseNode` | | `true` | Whether to build the database node, its private subnet, its NAT gateway, its volume and its certificate. `false` builds none of it and leaves the machine exactly as it was before this profile had a database: write your own `DATABASE_URL` into `env.local`, and firstboot's gate holds the deployment stopped until you do. It is the answer for somebody who already keeps a PostgreSQL, and on AWS it is one way to avoid the NAT gateway's $36.50 a month — no longer the only one, since `databaseEgress: ipv6` keeps the node and drops the gateway |
| `databaseSize` | | whatever `size` is | The **database half** of the same row: the database node's machine, its `PGDATA` disk, and the five PostgreSQL settings the compose file applies as `-c` flags. Separate from `size` because the two machines want opposite things — the application is a mostly idle Node process and PostgreSQL turns every spare byte into cache. Raising this alone gives you a database the backup disk cannot hold dumps of, so raise `size` with it or lower `backupKeep` |
| `databaseMaxConnections` | | `50` | `max_connections` on the database node, floor 10. Eleven for the application, one for `psql`, one for the nightly `pg_dump`, and the rest is slack; PostgreSQL's own default of 100 costs memory `shared_buffers` would rather have |
| `databasePassword` | secret | generated | The application role's password. Unset, a 32-character alphanumeric one is generated. Set, yours wins. Letters and digits only, at least 16 of them, and that is narrower than PostgreSQL would accept on purpose: the value travels through a URL, a Compose `.env` and a shell script, each with its own escaping, and an encoding applied in one of the three and not the others is a password that works until the nightly backup runs. The **superuser's** password is not this and is not a setting — it is generated on the database node at first boot and exists in no state file and no user data |
| `acmeEmail` | | | Where Let's Encrypt writes about a renewal that failed. Optional to them and worth setting |
| `allowedEmails` | | | Who may register. Empty admits nobody but the first account |
| `sshCidr` | | | One IPv4 CIDR allowed to reach port 22 on the **application node** from outside. Unset means no public SSH ingress at all, which is the default; AWS gives a shell through Session Manager without it, and OCI through the Bastion service, which reaches 22 from inside the subnet. `0.0.0.0/0` is refused, and so is a CIDR with no `sshPublicKey` — an open port nothing can answer is a rule in a firewall and a debugging session about the wrong thing. It opens nothing on the database node, which has no public address for it to open anything to |
| `sshPublicKey` | on OCI | | The contents of a `.pub` file. Refused if it looks like anything else, because a private key here would be a private key in your stack configuration. Required on Oracle Cloud, where it is the only way onto the machine and is installed at launch only; optional on AWS |
| `imageTag` | | the release | Another published release to deploy. It reaches the machine once, in the compose file cloud-init writes, so a machine that exists already takes a new one by the upgrade below |
| `imageRepository` | | `ghcr.io/thtmnisamnstr/simple-balance` | For a private mirror |
| `timezone` | | `Etc/UTC` | The machine's clock. Not the application's — that is each person's own setting |
| `backupKeep` | | `14` | How many daily dumps to retain on the data disk |
| `databaseEgress` | | `nat` | AWS only. How the database node reaches the internet — Ubuntu's archive, the image registry and Session Manager. `nat` is the NAT gateway every stack so far has had, at $36.50 a month. `ipv6` builds an egress-only internet gateway instead, which AWS charges nothing for, and is refused without `sshPublicKey`: it takes Session Manager away, because `ssm.<region>.amazonaws.com` publishes no IPv6 address, so the shell becomes SSH from the application node and a rule for 22 from its security group — the one inbound rule on that machine besides 5432, and it exists only under this setting. It also rewrites the node's apt sources to `archive.ubuntu.com`, which publishes IPv6 where the in-region mirror does not. Unset plans no change on a stack that exists. **Setting it on a stack whose machines exist may not be a no-op:** if `sshPublicKey` was not already set, adding it gives both instances a `keyName`, which EC2 cannot change on a running machine, so both plan a replacement and the database node is deleted before its replacement is made. The data volumes are separate protected resources and survive it, but it is two rebuilds of downtime — set the key on its own, `up`, and set this afterwards. `docs/deployment-costs.md` compares them and says what the free-looking alternatives do not do |
| `kmsKeyArn` | | | AWS only. A KMS key of yours for both data volumes and both boot volumes, instead of the AWS-managed one. It must be enabled, customer-managed, symmetric and for encrypt/decrypt, and its policy must let the principal running `pulumi up` call `kms:GenerateDataKeyWithoutPlaintext`, `kms:CreateGrant` (with `kms:GrantIsForAWSResource`), `kms:Decrypt` and `kms:DescribeKey` — the default policy `aws kms create-key` writes with no `--policy` already does, and without them a volume is created and deleted moments later. The program checks the key's state before it declares anything encrypted, so a key in the wrong state fails the preview rather than half-building a stack; it cannot check the policy, which is why it is written out here. **Set it before the first `up`**, and set `kmsKeyArnIsNewStack` with it |
| `kmsKeyArnIsNewStack` | with `kmsKeyArn` | `false` | AWS only. Your statement that this `up` changes no volume's key: the volumes do not exist yet, or they were already created with this key, so a stack already built with one sets this and plans nothing. A volume's key cannot be changed afterward, so naming one on a stack that already has volumes asks to replace them — an empty volume where the ledger was. Pulumi's `protect` usually refuses that, but it lives in the state snapshot rather than in this config, and both `protectDataVolume: false` and `pulumi state unprotect` clear it there while the config still says `true`; neither is visible to the program, so it asks instead. `docs/deployment-profiles.md` §Encryption has the by-hand migration and what a disabled or deleted key does |
| `kmsVaultOcid`, `kmsKeyOcid` | | | Oracle Cloud only, and both or neither: the key cannot be looked up without the vault's management endpoint. An AES key — the Block Volume service refuses an RSA-wrapped one — and enabled, checked the same way and at the same point. Adding it to a stack that exists is not destructive here: OCI re-wraps a block volume's data key in place. Create the key with `--protection-mode SOFTWARE` unless you mean to pay for HSM, which cannot be changed afterward |
| `aws:region` | on AWS | | The region to build in, such as `us-west-2`, exported as `region`. Required in the stack, and `preview` stops before anything is declared without it: otherwise the provider takes `AWS_REGION` or `AWS_DEFAULT_REGION` from the shell, so where the machine and its data volume live would depend on who runs `pulumi up`. Version 7 of the provider records a region on every resource, so a stack run from a shell pointed at another region plans to replace every one of them there, the data volume included. Set it once and never change it: see [tearing down on AWS](#tearing-down-on-aws) for what a new one does. Any region is accepted |
| `oci:region` | on OCI | | The region to build in, such as `us-ashburn-1`, exported as `region`. Required in the stack even when `~/.oci/config` names one, and `preview` stops before anything is declared without it: otherwise the provider takes `TF_VAR_region`, `OCI_REGION` or the profile's region, so where the machine and its data volume live would depend on who runs `pulumi up`, and a stack run from another shell would look for its resources somewhere they are not. For Always Free it is the tenancy's home region, because Ampere A1 capacity is free there and nowhere else; the home region is chosen at sign-up and cannot be changed afterward, and Profile → Tenancy in the console shows it. A paid tenancy may name any region it subscribes to. The hosted Simple Balance deployment builds in a US home region because its privacy policy says its data is stored in the United States — a promise that deployment makes, not one this program enforces, so any region is accepted |
| `compartmentOcid` | OCI only | | Which compartment to build in. OCI has no default and the root compartment is a poor choice, since policies cannot be scoped to it |
| `availabilityDomain` | | the first | OCI only. Which availability domain to build both machines and both data volumes in, by full name or by number from 1. Try another when a launch fails with `Out of host capacity` — another domain rather than another region, because Always Free covers the tenancy's home region only. Set it before the first successful `up` and leave it: changing it afterward would replace the data volumes, and the secret, `env.local`, the backups and the ledger would go with the old ones, so while `protectDataVolume` is `true` the program refuses that `up` before it touches a machine or a volume, and names the domain to set back. Until a launch succeeds it is free to change: the volumes are built after the machines, so a launch refused for capacity leaves nothing in the domain |
| `databaseSubnet` | | `false` | OCI only, and **deprecated in favour of `databaseNode`**. It asks for the private subnet with nothing in it, for an OCI managed database you build by hand — see [a database for Oracle Cloud](#a-database-for-oracle-cloud). It is still honoured, and a stack that sets it logs a deprecation line and carries on, because nothing that was accepted is refused. The subnet, its route to the NAT gateway and its security list are built when either this or `databaseNode` asks for them, and its OCID is exported as `databaseSubnetId` either way; only the PostgreSQL machine inside it belongs to `databaseNode` |
| `protectDataVolume` | | `true` | Marks **both** data volumes with Pulumi's `protect`, so `pulumi destroy` fails at its preview and deletes nothing, and so does an `up` that would replace either. On Oracle Cloud a new `availabilityDomain` is refused before a machine or a volume is touched, `--skip-preview` included; on AWS two settings would replace them — a new `aws:region`, which the preview refuses at the volume, and a `kmsKeyArn`, which is why the program refuses that setting unless `kmsKeyArnIsNewStack` says the volumes do not exist yet. **This setting is not the guard for that one**, and could not be: `protect` is a flag in the state snapshot, and `pulumi state unprotect` clears it there while this still reads `true`. Either would otherwise take the generated secret, `env.local`, every backup — and, on the database node, the ledger. A resize and a replaced machine still go through. `false` is how to mean it — see [tearing down on AWS](#tearing-down-on-aws) and [on Oracle Cloud](#tearing-down-on-oracle-cloud) |

**The only secret key here is `databasePassword`, and it is optional.**
`AUTH_SECRET` is generated on the application node at first boot and kept on its
data volume at `0600`, so it enters neither user data — which is readable by
anyone who can describe the instance — nor Pulumi's state file. The database
node's superuser password is generated there the same way, on its own volume, and
is generated only when the file is absent, so a rebuilt machine against a live
volume does not rotate itself out of its own cluster. What the stack does hold is
the CA's private key, which reaches neither machine, and the application role's
password, which has to reach both because one of them puts it in a connection
string.

```sh
cd deploy/pulumi
npm install

# AWS. The region is required, in the stack, before the first up.
pulumi -C aws-single stack init books
pulumi -C aws-single config set aws:region us-west-2
pulumi -C aws-single config set simple-balance:hostname books.example.com
pulumi -C aws-single up

# Oracle Cloud. The provider reads its credentials from ~/.oci/config unless the
# oci: namespace carries them instead. The region and the key are required, in
# the stack, before the first up; for Always Free the region is the home region.
pulumi -C oci-single stack init books
pulumi -C oci-single config set oci:region us-ashburn-1
pulumi -C oci-single config set simple-balance:compartmentOcid ocid1.compartment.oc1..xxxx
pulumi -C oci-single config set simple-balance:hostname books.example.com
pulumi -C oci-single config set simple-balance:sshPublicKey "$(cat ~/.ssh/id_ed25519.pub)"
pulumi -C oci-single up
```

Both print a `nextSteps` output saying what is left, in order: the A record,
reaching the application node, the database — which with a database node is
"nothing to do", and without one is putting a `DATABASE_URL` in `env.local` and
running firstboot — and then finding the one-time setup code in the
application's log. The certificate arrives on its own once the name resolves;
Caddy keeps retrying until it does.

Other outputs worth knowing: `databaseHostName` is the internal name in the
certificate and in `DATABASE_URL`, `databaseInstanceId` and `databaseVolumeId`
the machine and its disk, and `databaseMachine` a one-line description of the
shape it was built at. On AWS, `databaseShell` is the Session Manager command
that reaches it; on Oracle Cloud, `databasePrivateIpAddress` and
`databaseSubnetId` are what a Bastion session needs. All of them are absent when
`databaseNode` is false, with one exception: `databaseSubnetId` is also present
when `databaseSubnet` asked for the subnet on its own, because that is the case
it exists for.

**Resizing is not a rebuild.** Change `size` or `databaseSize` and deploy, and
both clouds change that machine in place, restarting it into the new shape, and
grow its data volume where it is. The filesystem on the volume does not follow
on its own: `simple-balance-growfs.service` grows it at every boot, so the
restart the resize already causes is usually all it takes. On a machine built
before that unit existed — cloud-init runs once per instance, so it never
arrives on one — run
`sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"`
once the volume has grown, on Oracle Cloud after the rescan its documentation
on resizing a volume describes. Neither cloud shrinks a volume, so a size whose
disk is smaller than the one there fails at the volume. On the database node the
restart is a database restart, so take it when nobody is using the deployment.

**Replacing a machine keeps what is on its data disk**, and that goes for both
of them: the database node's volume holds `PGDATA`, so a replaced database node
comes back to the ledger it had. An instance alone is
replaced by a new machine image, taken by lifting `ignoreChanges`, or by
`pulumi up --replace` naming it — the way back from a machine that has gone
wrong, not from an upgrade. An upgrade is undone on the machine, as
[docs/upgrades.md](../../docs/upgrades.md#rolling-back) says: the old tag back in
`/opt/simple-balance/compose.yml` and the backup taken before the upgrade
restored, because a new machine brings back the image the stack names and leaves
the database as the upgrade's migrations left it. Each data volume is a separate
resource and is formatted only when it is not already a filesystem, so either
replacement destroys that machine's root disk and leaves its volume alone — the
backups, the generated `AUTH_SECRET` and `env.local` on one, the ledger and the
superuser password on the other. The server certificate and its key are on the
database node's **root** disk rather than its volume, deliberately: cloud-init
re-delivers them to a replacement, so there is nothing to keep. Pulumi moves the volume across once the new
machine is running, and the new machine's first boot waits up to forty
minutes for it, which is as long as the providers give Pulumi to finish the
move before failing the `up`; on Oracle Cloud a first launch waits the same way
for the volume to be built.
If the move takes longer, `sudo cloud-init status` there reports an error: run
`sudo /usr/local/sbin/simple-balance-firstboot`, which is safe to run again,
once a `pulumi up` has finished the move.
Two things take the volume with it: `pulumi destroy`, and a change that
replaces the volume — a new `aws:region` on AWS, a new `availabilityDomain` on
Oracle Cloud — though neither does while `simple-balance:protectDataVolume` is
`true`, the default: the destroy fails at its preview, and so does the change,
which on Oracle Cloud is refused before the machine or the volume is touched.
[Tearing down on AWS](#tearing-down-on-aws) and
[on Oracle Cloud](#tearing-down-on-oracle-cloud) are how to mean it, and there
is now a ledger on one of those two volumes, which is why the protection is on
by default and why a backup lives on the other machine.
On Oracle Cloud a replaced application node also comes up on a new
public address; the database node has none to change. Promoting the old one to reserved keeps it in the tenancy but
does not move it: delete the new instance's ephemeral address and assign the
reserved one to its private IP in the console, or point the A record at the new
one — see [DNS](../../docs/deployment-profiles.md#dns). Both programs pin the
machine image with `ignoreChanges` for the opposite reason: without it a new
Canonical build every few weeks would replace the instance on every `pulumi up`,
which costs an outage nobody asked for.

**But a second `pulumi up` does not reconfigure the machine.** Cloud-init runs
once per instance, and neither program touches the instance when the compose
files, the units, the scripts or the image tag change: both ignore changes to
the user data they send, `oci-single` to the whole of the instance's `metadata`.
Deliberately — on Oracle Cloud a change there replaces the instance, which is
minutes of downtime and a new address, and on AWS it stops and starts it, and
either way the new text would run nowhere. These programs provision a machine;
they do not keep managing it. So a new release, a setting, or on OCI a new SSH
key is applied on the machine:

```sh
# An application upgrade.
sudo nano /opt/simple-balance/compose.yml       # the pinned image tag
sudo docker compose -f /opt/simple-balance/compose.yml pull
sudo systemctl restart simple-balance

# A setting.
sudo nano /var/lib/simple-balance/env.local
sudo systemctl restart simple-balance

# Another SSH key, on OCI.
nano ~/.ssh/authorized_keys

# A data volume this stack grew, on a machine built before
# simple-balance-growfs.service existed. Newer machines do it at every boot.
sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"
```

Take a backup first either way: `sudo systemctl start simple-balance-backup`.
Through the unit rather than by running the script, because the unit reads
`/etc/default/simple-balance`, which is what puts the dump on the data volume;
the script run bare writes to its own default on the boot disk.

The files cloud-init writes are this repository's own, with their comment lines
left out: both providers cap user data — OCI at 32,000 bytes of metadata, EC2 at
16,384 before base64 — and the commented originals, gzipped, came within a few
hundred bytes of EC2's. Read the originals in `deploy/compose/single/` and
`deploy/systemd/`. `pulumi preview` refuses a document that would not fit rather
than leaving the provider to refuse the launch.

### The database these programs build

With `simple-balance:databaseNode` at its default, there is nothing to do here.
The program builds the second machine, generates the role's password, issues the
certificate, and writes the connection string into
`/opt/simple-balance/env.db` at `0600` on the application node:

```
postgresql://simple_balance:<password>@<internal DNS name>:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem
```

`simple-balance-env` folds `env.base`, then `env.db`, then `secrets.env`, then
`env.local`, and Compose reads the last assignment — so writing a `DATABASE_URL`
of your own into `env.local` still wins, on a machine whose program generated
one, with nothing to turn off first.

**The certificate.** `@pulumi/tls` issues a private CA and a server certificate
at plan time, before either machine exists. The CA's key stays in Pulumi's
state and reaches neither machine; the server certificate and key go only to the
database node, at `0600`, and the CA certificate — which is public — only to the
application node. The SAN is the provider's own internal name for the database
node, which is knowable in advance because its private address is pinned:
`db.db.simplebalance.oraclevcn.com` on Oracle Cloud,
`ip-10-20-1-10.<region>.compute.internal` on AWS, and
`ip-10-20-1-10.ec2.internal` in `us-east-1`, which spells it differently and is
a trap worth naming. The pinned address is in the certificate too, as an IP SAN,
so `psql "host=10.20.1.10 … sslmode=verify-full"` works for somebody debugging —
but the generated URL uses the name, because node-postgres sends no server name
for an address and checks the certificate against `localhost` instead.

**The server enforces TLS rather than trusting the client to ask.**
`pg_hba.conf` is mounted and named with `-c hba_file=`, so the rules are this
repository's file rather than the one the image generates, and every line
crossing a machine boundary is `hostssl`. The superuser is refused over the
network entirely, even under TLS; the application signs in as `simple_balance`,
which is not a superuser and owns only its own database.

**Reaching the database node for a shell.** On AWS, Session Manager, exactly as
on the application node — the role carries `AmazonSSMManagedInstanceCore` and no
port is open for it. Under `databaseEgress: ipv6` that is not available, because
the agent's endpoint is IPv4-only and the subnet has no IPv4 route: there the
shell is a Session Manager port forward through the *application* node to 22 on
the database node, which is what the second inbound rule that setting adds is
for. On Oracle Cloud, a Bastion in the database node's *own*
subnet, because that is where an OCI Bastion's private endpoint has to sit:
`--target-subnet-id "$(pulumi -C oci-single stack output databaseSubnetId)"` and
`--target-private-ip "$(pulumi -C oci-single stack output databasePrivateIpAddress)"`,
otherwise the same commands as
[reaching the Oracle Cloud machine](#reaching-the-oracle-cloud-machine). Once
there:

```sh
sudo docker compose -f /opt/simple-balance/compose.postgres.yml exec postgres \
  psql -U postgres simple_balance
```

### Rotating the database's certificate

By hand, and the reason is worth stating rather than working around. Both
instances carry `ignoreChanges` on their user data — without it a change to the
deployment material would replace the machine on every `pulumi up`, which is
minutes of downtime and, on Oracle Cloud, a new address. So a certificate
re-issued by a later `pulumi up` would sit in Pulumi's state and never reach a
running machine. They are therefore long-lived: ten years for the CA, five for
the server certificate.

To replace one before then: put the new CA certificate on the application node
as `/var/lib/simple-balance/tls/db-ca.pem` and the new server certificate and
key on the database node in `/opt/simple-balance/db-tls/` (`server.crt` `0644`,
`server.key` `0600` owned by the container's postgres user, which is uid 999),
then restart each unit. Do the application node's CA **first** if the new
certificate is from a new CA, or the application will meet a certificate it
cannot verify for as long as the two disagree; a CA certificate holding both the
old and the new issuer removes even that window. `docs/upgrades.md` has the
precedent, which is the same shape as installing `compose.db-tls.yml` on a
machine built before it existed.

### `DATABASE_URL` goes on the machine

This is the `simple-balance:databaseNode: false` path, and it is what these
programs did before they built a database. There is no stack setting for the
URL, and that is the one worth expecting: the connection string carries a
password, and anything these programs put on the machine arrives as user data,
which is readable by anyone who can describe the instance. The first boot
therefore leaves the deployment enabled and stopped, with the instructions in
`/etc/motd`:

```sh
sudo install -m 0644 ca.pem /var/lib/simple-balance/tls/db-ca.pem   # the database's CA, below
sudo nano /var/lib/simple-balance/env.local
#   DATABASE_URL='postgresql://user:password@host:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem'
sudo /usr/local/sbin/simple-balance-firstboot
```

Single quotes, so nothing in the value is expanded, and a password with any of
`@ : / ? # [ ] % & $` or a space in it written URL-encoded:
`python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' 'the password'`
prints it. If that URL goes through a transaction pooler, which managed services
often hand out, put `DIRECT_DATABASE_URL` beside it, written the same way and
reaching the same database past the pooler: migrations and the first-account
claim hold a session-level advisory lock that a pooler cannot carry.

The first-boot script rebuilds the configuration and starts the deployment and
its nightly backup timer; it is written to be safe to re-run, which is what
makes that a real instruction rather than a suggestion. Run it, rather than a
restart, the first time: a restart would start the deployment but not the timer,
which would wait for the next reboot, and would leave `/etc/motd` saying nothing
is running. Once the deployment is running, a plain
`sudo systemctl restart simple-balance` applies a change to the URL like any
other setting.

Settings that genuinely come from outside — an SMTP password, a Stripe key, the
AdSense ids and the `PRIVACY_POLICY_URL` the server refuses to start without
once they are set, the optional `TERMS_OF_USE_URL` — go in
`/var/lib/simple-balance/env.local` too. It is on the data volume rather than
the boot disk, and it is folded into the `.env` Compose reads every time the
deployment starts: cloud-init installs a drop-in beside the unit that runs
`/usr/local/sbin/simple-balance-env` first. So a setting is an edit and a
restart. `/opt` is destroyed when the instance is rebuilt; the data volume is
not.

Use `sslmode=verify-full`, and name the certificate of the CA that signed the
database's with `sslrootcert=/var/lib/simple-balance/tls/db-ca.pem`. Most
managed databases, OCI's and Amazon RDS's included, are signed by a CA of the
provider's own that neither the container nor the backup trusts until it is
handed that file; `deploy/compose/single/README.md`, "The database's
certificate", says where each provider publishes it. The directory is on the
data volume, first boot makes it before anything starts, and
`compose.db-tls.yml`, which `COMPOSE_FILE` in `/etc/default/simple-balance`
names on these machines, mounts it into the application at the same path. The
nightly backup and the restore mount the same file into their `postgres:18`
client, which carries no certificate authorities of its own, so the one URL is
checked the same way by all three. Leave `sslrootcert` out for a certificate
from a public CA: the application checks it against Node's roots and the backup
against the machine's CA bundle. The host has to be a name the certificate
carries, not an IP address, because node-postgres checks an address against
the name `localhost`.

`sslmode=no-verify` still works: encrypted, and nothing checks who answers. The
backup and restore hand libpq `require` in its place, which is the same
guarantee in the spelling `pg_dump` accepts. `verify-ca` with no `sslrootcert`
is refused by the backup and the restore, because libpq would then take a
certificate any public CA issued, for any host, as the database's.

A machine these programs built before `compose.db-tls.yml` existed has neither
the overlay nor the directory, and a second `pulumi up` will not add them. Copy
`deploy/compose/single/compose.db-tls.yml` to `/opt/simple-balance`, append
`:compose.db-tls.yml` to `COMPOSE_FILE` in `/etc/default/simple-balance`, run
`sudo install -d -m 0755 /var/lib/simple-balance/tls`, and install the current
`simple-balance-backup` and `simple-balance-restore` in `/usr/local/bin` and
`simple-balance-firstboot` in `/usr/local/sbin`, all from `deploy/systemd/`,
before naming a file.

### Reaching the Oracle Cloud machine

There is no Session Manager on OCI, and with `sshCidr` unset nothing publishes
port 22. What the program opens instead is 22 from the machine's own subnet,
which is where an OCI Bastion's private endpoint sits, and the Bastion plugin of
Oracle Cloud Agent. The Bastion service is free.

```sh
# Once: a bastion on the stack's subnet, admitting your own address.
oci bastion bastion create --bastion-type STANDARD \
  --compartment-id "$(pulumi -C oci-single config get simple-balance:compartmentOcid)" \
  --target-subnet-id "$(pulumi -C oci-single stack output subnetId)" \
  --client-cidr-list '["203.0.113.7/32"]'

# Each time: a session, which works on any image because it needs no plugin.
oci bastion session create-port-forwarding --bastion-id <bastion OCID> \
  --target-private-ip "$(pulumi -C oci-single stack output privateIp)" \
  --target-port 22 --ssh-public-key-file ~/.ssh/id_ed25519.pub
oci bastion session get --session-id <session OCID>   # the ssh command, under ssh-metadata
```

That command forwards a local port to the machine; `ssh -p <that port>
ubuntu@localhost` in a second terminal logs in with the same key. The console's
Bastion page does all of this with a _Copy SSH command_ button, and offers a
managed SSH session too, which goes through the plugin. The alternative is
`simple-balance:sshCidr` set to your own address and another `pulumi up`, which
opens 22 to that address alone; then `ssh ubuntu@<publicIp>`.

### A database for Oracle Cloud

This is for a deployment that would rather not run its own, so it sets
`simple-balance:databaseNode false` and points the machine at something else.
OCI Database with PostgreSQL is not part of Always Free, so it is billed. Any
other PostgreSQL 15 or later the machine can reach works as well, including one
you run yourself, and costs whatever it runs on. Two ways:

**OCI Database with PostgreSQL, in the stack's own network.** It wants a private
subnet of its own, which the program makes:

```sh
pulumi -C oci-single config set simple-balance:databaseNode false
pulumi -C oci-single config set simple-balance:databaseSubnet true
pulumi -C oci-single up
pulumi -C oci-single stack output databaseSubnetId
```

`simple-balance:databaseSubnet true` is the older spelling and is deprecated in
favour of `databaseNode`, which builds a PostgreSQL 18 machine in that same
subnet instead of leaving it empty. It is still honoured — this is the one
combination it exists for — and logs a deprecation line rather than refusing,
because nothing this program accepted is refused later. With a database node the
subnet is built anyway, and it is the one that node sits in, so setting both
changes nothing and says so.

That subnet answers on 5432 to the machine's subnet and to nothing else. Then,
in the console under Databases → PostgreSQL → DB systems, create one:

1. PostgreSQL 15 or later. OCI still offers 14, which is below this
   application's floor — see [one PostgreSQL version](../../docs/deployment-profiles.md#one-postgresql-version).
2. Networking: this stack's VCN and the subnet `databaseSubnetId` names.
3. An administrator user and password. The password rules require a special
   character, so expect the URL to need it encoded.
4. Once it is active, the DB system's page shows its private endpoint: a
   hostname (its FQDN) and a private IP address. Use the FQDN. The certificate
   names it, and under `verify-full` node-postgres checks an IP address against
   the name `localhost`, which fails.
5. The same page's **Connection details** has the CA certificate that signed
   the service's. Download it, or print it where the `oci` CLI runs:
   `oci psql connection-details get --db-system-id <DB system OCID> --query 'data."ca-certificate"' --raw-output > ca.pem`.
   Copy it to the machine the way you reach it.

Then, on the machine:

```sh
sudo install -m 0644 ca.pem /var/lib/simple-balance/tls/db-ca.pem
sudo nano /var/lib/simple-balance/env.local
#   DATABASE_URL='postgresql://admin:<password, URL-encoded>@<private endpoint FQDN>:5432/simple_balance?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem'
sudo /usr/local/sbin/simple-balance-firstboot
```

`verify-full` with `sslrootcert`, because the service's certificate is issued by
a private CA that OCI manages, which neither the container nor the backup's
client trusts until it is handed that CA's certificate. With it, the
application, the nightly backup and the restore all check that the server
answering is the DB system. `sslmode=no-verify` still works in its place, with
no file: the connection is encrypted and the certificate is not checked, and
the backups get the same through libpq's `require`. The application creates the
`simple_balance` database on its first start if the server has none, which the
administrator user may do; to use a less privileged role instead, create the
database first and make that role its owner. `docs/deployment-sizing.md` has
the server settings per machine size.

The program does not create the DB system itself, for the reason `DATABASE_URL`
is not a stack setting: its administrator password would be in Pulumi's state.
The database node it *does* build answers that objection rather than dodging it.
Its superuser password is generated on that machine and never leaves it, and the
only password the stack holds is the unprivileged application role's — which has
to be somewhere the application node can read, because the application node has
to put it in a connection string. There is no arrangement in which that one is
secret from Pulumi and still reaches the machine that needs it.

**Or any PostgreSQL 15 or later the machine can reach over TLS** — another
cloud's managed service, or a server you already keep. The machine's egress is
open, so all it needs is to be admitted by the database's own firewall, by the
address `publicIp` reports. The same URL shape applies: `verify-full`, with
`sslrootcert` naming the provider's CA certificate unless it is a public CA's.

### Tearing down on Oracle Cloud

The two data volumes are the things in `oci-single`'s stack the next
`pulumi up` cannot rebuild. The application node's holds the generated
`AUTH_SECRET`, `env.local` and every nightly dump; a new one means a new secret,
which signs everybody out, every setting typed in again, and no backups at all.
**The database node's holds the ledger**, and losing it is losing the books. So
the program marks both with Pulumi's
[`protect`](https://www.pulumi.com/docs/iac/concepts/options/protect/) option
unless `simple-balance:protectDataVolume` is `false`, and while it is marked:

- `pulumi destroy` fails at its preview and deletes nothing. Pulumi's message
  suggests removing `protect` from the program; here the setting below is that
  edit.
- A new `availabilityDomain`, which would replace the volume, is refused before
  the machine or the volume is touched, with or without a preview, and the
  message names the domain to set back. The program finds the volume by its
  name, `simple-balance-<stack>-data`, because a program cannot read its own
  state, so a volume of that name left behind by a removed stack of the same
  name is refused the same way; rename it or delete it in the console.
- A new `size` or `databaseSize` grows that machine's volume in place, which is
  an update and goes through.
- `pulumi destroy --exclude-protected` and `pulumi destroy --skip-preview`
  delete only the volumes' attachments. Pulumi keeps everything a protected
  resource was built after, and each volume is built after its machine, so the
  network and both running machines stay, and each is without its disk
  until the next `pulumi up` attaches it again and a reboot mounts it. Neither
  is a way to keep the volumes and drop the rest.
- It stops Pulumi and nothing else. The console and the `oci` CLI can still
  delete either volume.

To take it all down on purpose, first copy off what you want to keep — the
dumps are in `/var/lib/simple-balance/backups` on the application node — or take
a volume backup, which outlives the volume and counts toward the five volume
backups Always Free includes. `dataVolumeId` and `databaseVolumeId` are the two
volumes' OCIDs, and the second is the one with the ledger on it:

```sh
oci bv backup create --volume-id "$(pulumi -C oci-single stack output dataVolumeId)" --type FULL
oci bv backup create --volume-id "$(pulumi -C oci-single stack output databaseVolumeId)" --type FULL
```

A volume backup is not a substitute for a dump: it is a copy of a running
database's files and restores as a crash-recovered cluster of that exact
PostgreSQL major version. Take the dump too —
`sudo systemctl start simple-balance-backup` on the application node — because
that is the copy that restores anywhere.

Then say so in the stack, deploy the setting, and destroy:

```sh
pulumi -C oci-single config set simple-balance:protectDataVolume false
pulumi -C oci-single up        # changes no resource: it clears the flag in Pulumi's state
pulumi -C oci-single destroy
```

Or clear the flag for one destroy without changing the setting. The next
`pulumi up` sets it again. `pulumi -C oci-single stack --show-urns` lists the
volume's URN if the one below does not match.

```sh
stack=$(pulumi -C oci-single stack --show-name)
pulumi -C oci-single state unprotect \
  "urn:pulumi:${stack}::simple-balance-oci-single::oci:Core/volume:Volume::simple-balance-${stack}"
pulumi -C oci-single destroy
```

A stack left at `false` builds its next volume unprotected, so run
`pulumi -C oci-single config rm simple-balance:protectDataVolume` before
building it again.

### Tearing down on AWS

The two data volumes are the things in `aws-single`'s stack the next
`pulumi up` cannot rebuild, for the same reasons as on Oracle Cloud above: one
holds the generated `AUTH_SECRET`, `env.local` and every nightly dump, and a new
one means everybody signed out, every setting typed in again and no backups; the
other holds the ledger. So the program marks both with Pulumi's
[`protect`](https://www.pulumi.com/docs/iac/concepts/options/protect/) option
unless `simple-balance:protectDataVolume` is `false`, and while it is marked:

- `pulumi destroy` fails at its preview and deletes nothing.
- A new `size` or `databaseSize` grows that machine's volume in place, and
  `pulumi up --replace` on either instance replaces the machine, its attachment
  and any address association and leaves the volume alone: each volume was
  built before its machine and takes nothing from it.
- A new `aws:region` is refused at the volume by the preview. It is the one
  setting that replaces the volumes, because the provider records a region on
  every resource. Under `--skip-preview` Pulumi has already rebuilt much of the
  network in the new region, the Elastic IP and the NAT gateway included, by the
  time it reaches the volume, and a stack left like that is one no `pulumi up`
  sets right, in either region: each plans to replace the volumes, and the
  protection refuses. Never change it: build a new stack in the other region and
  restore a dump into it.
- `pulumi destroy --exclude-protected` and `pulumi destroy --skip-preview` keep
  the volumes and the subnets and VPC they were built in, because Pulumi keeps
  what a protected resource was built from, and delete everything else — both
  machines, the Elastic IP and the NAT gateway included. `--skip-preview` then
  exits with an error about a volume. The next `pulumi up` builds the rest again
  and attaches the same volumes, on a new public address, so the A record has to
  follow.
- It stops Pulumi and nothing else. The console and the `aws` CLI can still
  delete either volume.

To take it all down on purpose, first copy off what you want to keep — the
dumps are in `/var/lib/simple-balance/backups` on the application node — or take
snapshots, which outlive the volumes and are billed by the gigabyte-month until
you delete them. `dataVolumeId` and `databaseVolumeId` are the two volumes' ids
and `region` their region; the second is the one with the ledger on it:

```sh
for volume in dataVolumeId databaseVolumeId; do
  aws ec2 create-snapshot --region "$(pulumi -C aws-single stack output region)" \
    --volume-id "$(pulumi -C aws-single stack output "$volume")" \
    --description "simple-balance $volume before teardown"
done
```

A snapshot of the database's volume is a copy of a running database's files and
restores as a crash-recovered cluster of that exact PostgreSQL major version.
Take the dump too — `sudo systemctl start simple-balance-backup` on the
application node — because that is the copy that restores anywhere.

Then say so in the stack, deploy the setting, and destroy:

```sh
pulumi -C aws-single config set simple-balance:protectDataVolume false
pulumi -C aws-single up        # changes no resource: it clears the flag in Pulumi's state
pulumi -C aws-single destroy
```

Or clear the flag for one destroy without changing the setting. The next
`pulumi up` sets it again. `pulumi -C aws-single stack --show-urns` lists the
volume's URN if the one below does not match.

```sh
stack=$(pulumi -C aws-single stack --show-name)
pulumi -C aws-single state unprotect \
  "urn:pulumi:${stack}::simple-balance-aws-single::aws:ebs/volume:Volume::simple-balance-${stack}"
pulumi -C aws-single destroy
```

A stack left at `false` builds its next volume unprotected, so run
`pulumi -C aws-single config rm simple-balance:protectDataVolume` before
building it again.

**`state unprotect` leaves the config saying `true`,** which is the point of it
and also the thing to remember afterwards: the flag Pulumi obeys is in the state
snapshot, so between that command and the next `up` the volume is replaceable
although nothing in `pulumi config` says so. If the destroy is abandoned — you
change your mind, or it fails partway — run the `unprotect`'s opposite, or an
`up`, before making any change that would replace a volume. This is why
`kmsKeyArn` is guarded by `kmsKeyArnIsNewStack` rather than by
`protectDataVolume`: the config value cannot tell you what the state says.

## After the first `pulumi up`

This is the `ha` programs'. The single-machine stacks print their own
`nextSteps`, above.

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

against the database's `max_connections`. At the defaults here that is
`(4 + 2) x 11 = 66`. `readSettings` refuses to plan a stack where it exceeds
`simple-balance:maxConnections`, so raise `max_connections` and say so, lower
the pool, lower a ceiling, or put a pooler in front and set
`simple-balance:directDatabaseUrl`.

What `simple-balance:maxConnections` stands for when it is unset depends on
where the database is. With `database: external` it is 100, which is what a
stock PostgreSQL allows and the conservative guess about a server this program
cannot see. With `database: in-cluster` it is the chart's own 200, read from the
same place the chart sets it — 100 there would be a program refusing replica
ceilings the database it just built would have served.

The single-machine programs have one process and no ceilings to add up:
`1 x (10 + 1) = 11` against `simple-balance:databaseMaxConnections`, which
defaults to 50.

The scheduler tier scales freely. A tick claims each recurrence with
`for update skip locked`, so there is no leader and no lease: replicas divide
the due rows between them.

## Things that will surprise you

- **Until the deployed image is 0.2.0, sign-in rate limiting still counts every
  visitor as one.** Both programs now carry the visitor's address from the load
  balancer to the API — the [AWS](#aws) and [GCP](#gcp) sections say how — and
  pass the chart the trusted list and the recursion that go with it, as
  `frontend.trustedProxyCidr` and `frontend.realIpRecursive`. But the last hop
  is the frontend image's own nginx, and every program deploys the pinned
  release, which is 0.1.6 until 0.2.0 is released. That frontend reads neither
  value and reports the ingress's address for everybody, so the `TRUST_PROXY`
  allowance the API applies per address is still shared. On AWS the load
  balancer's half takes effect at the next `pulumi up`; the frontend's half,
  on either cloud, arrives with an image of 0.2.0 or later.
- **On AWS, the first `pulumi up` that turns proxy protocol on interrupts the
  site for seconds to about a minute.** nginx expecting the header refuses a
  connection without one, nginx not expecting it answers the binary header with
  a `400`, and the target groups' change and ingress-nginx's reload do not land
  at the same instant. A new stack starts with both ends on and is not
  affected. Schedule it for a stack that is serving people.
- **A stack's own `simple-balance:trustedProxyCidr` replaces the program's list
  whole, with recursion off.** That is right for a proxy you added in front and
  wrong on GCP as the program builds it, where recursion off takes the load
  balancer's address for everybody. Leave the setting unset unless something
  else is in front, or set `simple-balance:realIpRecursive=true` with a list
  that keeps the program's three entries. On AWS, a value set to the load
  balancer's public subnets as a workaround brings the shared allowance back:
  the frontend's peer is now an ingress-nginx pod in the private subnets.
- **A pod inside the cluster can still name its own address, unless the policies
  are on.** On AWS the frontend trusts the whole VPC, because ingress-nginx's
  pods draw addresses from the same subnets as every other pod, so a pod that
  connects to the frontend directly can write its own `X-Forwarded-For`. That
  reaches nothing a pod could not reach before: on both clouds a pod can connect
  to the API directly, and with `TRUST_PROXY` on the API believes that header
  from anyone who can reach its Service. Neither is a way in from the internet.
  The chart's `networkPolicy.enabled` closes them, with `frontendIngressFrom`
  naming whatever really reaches the frontend — on AWS the `ingress-nginx`
  namespace. Both `ha` values files turn it on, because the database is in the
  cluster there and a policy is what stops any pod opening 5432 on the
  coordinator; a `database: external` stack leaves it off, because a policy
  naming the wrong source takes the site down without a word. A pod the policy
  sends around through ingress-nginx is counted as itself, because ingress-nginx
  believes a proxy protocol header from the load balancer's subnets alone.
  Enforcement is the plugin's: EKS needs the VPC CNI's network policy agent and
  GKE needs Dataplane V2, and both programs now ask for them.
- **On GCP the site answers on plain HTTP as well as HTTPS.** `allow-http` has
  to stay on for the ACME challenge, which is answered on this Ingress every
  time the certificate renews, and neither program adds a redirect. HSTS, which
  both the API and the frontend set, upgrades a browser that has been once.
- **The GKE Ingress ignores `nginx.ingress.kubernetes.io/proxy-body-size`.** It
  is in the chart's defaults, so it renders on the GKE Ingress too, where it
  does nothing. What bounds a CSV import there is `CSV_MAX_BYTES` and the
  frontend's `SB_MAX_UPLOAD_SIZE`, plus whatever the Google load balancer caps
  outside Kubernetes.
- **`pulumi destroy` takes the database with it now, wherever the program built
  one.** That used to be the reassuring bullet here — the database was always
  somebody else's and a destroy could not reach it — and it is no longer true of
  any default. On the `ha` programs with `database: in-cluster`, deleting the
  stack deletes the cluster and the StatefulSet's volumes with it. On the
  single-machine programs each destroy refuses while its data volumes are
  protected, which they are by default, and that protection is now the only
  thing between `pulumi destroy --yes` and the ledger — see
  [tearing down on AWS](#tearing-down-on-aws) and
  [on Oracle Cloud](#tearing-down-on-oracle-cloud). With `database: external`
  the old sentence still holds: the cluster goes, certificates and load balancer
  included, and your database is untouched.

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
| PostgreSQL on the database node | `deploy/compose/single/compose.postgres.yml` | `postgres:18` |
| PostgreSQL with Citus, in the cluster | the chart's `database.image` | `14.2.0-pg18` |

The two database pins name a major version and never float. A `docker compose
pull` or an image tag that moved to 19 would restart against a data directory 19
refuses to read, and the deployment would be down until somebody worked out why.

`npm run typecheck` compiles all four programs without deploying anything, which
is the cheapest way to find out that an SDK upgrade moved an API.
`@pulumi/tls` and `@pulumi/random` are in `package.json` for the single-machine
programs alone: the first issues the database's certificate chain, the second
generates the application role's password when the stack names none.
