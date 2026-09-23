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
application container and Caddy under systemd, against a PostgreSQL you supply,
with a separate data disk for the backups, the generated secret and the settings
added by hand. They share `single-common/`, which holds the sizing table both
read and builds the cloud-init that turns a bare Ubuntu into the deployment —
from the compose files and units in this repository rather than from a copy.

`docs/deployment-profiles.md` compares the two profiles and is where the choice
is argued. The short version: start with `single`.

Four separate Pulumi projects, and that is deliberate rather than incidental.
Putting the single-machine deployment inside the EKS program would put both in
one stack, where a mistake in either is a `pulumi up` that can destroy the
other — and where `pulumi destroy` on the thing you were finished with takes the
thing you were not.

## What these do not do

Except where a line says otherwise, this applies to all four.

- **No database, in any of them.** The database is bring your own: nothing
  here provisions PostgreSQL, there is no in-cluster StatefulSet and nothing on
  the single machine, and you supply a `DATABASE_URL` the deployment can reach.
  RDS, Cloud SQL, OCI Database with PostgreSQL, or a server you already run are
  all fine, at PostgreSQL 15 or later. If the database that URL names does not
  exist yet, the connecting role needs `CREATEDB`.

  The `ha` programs take it as a stack setting. The `single` programs take it on
  the machine, in `env.local`, because anything they put on the machine arrives
  as user data and a connection string carries a password — see
  [the single-machine stacks](#the-single-machine-stacks). `oci-single` can make
  the private subnet an OCI database goes in, and stops there.
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
  AdSense is set — in `config.extraEnv`, and `frontend.adsConfigured: true`. The
  `single` programs take all of it through `env.local`.
- **No monitoring, alerting, or log retention policy** beyond what EKS and GKE
  switch on themselves. EKS control plane logs go to CloudWatch and stay there
  until you say otherwise.
- **No WAF, no private control plane, no bastion, in the `ha` programs.** The
  Kubernetes API endpoint is reachable from the internet on both clouds,
  because otherwise `pulumi up` has to run from inside the network it is
  building. Authentication still applies. Restrict it afterward if that
  matters to you.
- **No secret rotation.** `AUTH_SECRET` signs sessions, so changing it signs
  everybody out. The `ha` programs set it once, from your Pulumi config; the
  single-machine ones generate it once, on the data disk. Neither rotates it.
- **The `ha` programs are not free.** A managed control plane, three or more
  nodes, a load balancer and a NAT gateway are all billed by the hour whether or
  not anybody signs in. `oci-single`'s machine can sit inside Oracle's Always
  Free allowance. Its database is a separate question: OCI Database with
  PostgreSQL is not part of Always Free, so it is billed, and any other
  PostgreSQL 15 or later the machine can reach — one you run yourself included —
  costs whatever it runs on.

## What you bring

- The Pulumi CLI and Node 20 or newer, for all four.
- For `aws/` and `gcp/`: `kubectl`, and an AWS account with the `aws` CLI (the
  generated kubeconfig calls `aws eks get-token`), or a GCP project with
  `gcloud` and `gke-gcloud-auth-plugin`
  (`gcloud components install gke-gcloud-auth-plugin`).
- For `aws-single/`: an AWS account whose credentials the Pulumi AWS provider
  can find, and the `aws` CLI with the Session Manager plugin for the shell.
- For `oci-single/`: an Oracle Cloud tenancy, a compartment other than the root
  one (its OCID is `simple-balance:compartmentOcid`), and an API signing key for
  the provider. `oci setup config`, or Console → your profile → API keys → Add
  API key, writes the `[DEFAULT]` profile of `~/.oci/config` — `user`,
  `fingerprint`, `tenancy`, `region` and `key_file` — which the provider reads.
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
  it at launch and never again, and it is the only way onto the machine.
- A PostgreSQL 15 or later database and its connection string, for all four.
  See [Reaching the database over a network](../../docs/deployment.md#reaching-the-database-over-a-network)
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
  single-common/cloud-init.ts  the cloud-init both send, and its size checks
  aws-single/Pulumi.yaml  the simple-balance-aws-single project
  aws-single/index.ts   VPC, one subnet, security group, EBS data volume,
                        Elastic IP, an instance role granting a shell
                        through Session Manager rather than SSH
  aws-single/platform.ts  the user data it sends
  oci-single/Pulumi.yaml  the simple-balance-oci-single project
  oci-single/index.ts   VCN, one subnet, security list, block volume, an
                        ephemeral public IP (promote it to reserved in the
                        console to outlive the instance), an Ampere A1
                        shape, and optionally a private database subnet
  oci-single/platform.ts  the disk floor, the availability domain, the
                        metadata it sends
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
| `simple-balance:databaseUrl` | yes, secret | | Set with `--secret`. Never plaintext. |
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
| `simple-balance:maxConnections` | no | `100` | What your database allows. See below. |
| `simple-balance:kubernetesVersion` | no | the cloud's default | EKS only. GKE takes its version from the regular release channel. |
| `simple-balance:trustedProxyCidr` | no | the chart's `127.0.0.1`, which believes nobody | The range the frontend's nginx believes `X-Forwarded-For` from: the ingress controller's pods, and nothing wider. Passed as the chart's `frontend.trustedProxyCidr`. See [things that will surprise you](#things-that-will-surprise-you) for what else each cloud needs. |
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

Different keys from the two above, because there is no cluster and no chart,
and the database URL is supplied on the machine rather than as a stack setting —
[below](#database_url-goes-on-the-machine). Neither program creates a database;
the machine runs the application and Caddy and connects out to yours.

| Key | Required | Default | What it is |
| --- | --- | --- | --- |
| `hostname` | yes | | The public DNS name. A name and nothing else: no scheme, no port, no path. Caddy obtains a certificate for it, so it has to resolve to the machine before HTTPS works |
| `size` | | `small` | `small`, `medium` or `large`. `docs/deployment-sizing.md` is the table, and it is the same table `single-common/index.ts` implements |
| `acmeEmail` | | | Where Let's Encrypt writes about a renewal that failed. Optional to them and worth setting |
| `allowedEmails` | | | Who may register. Empty admits nobody but the first account |
| `sshCidr` | | | One IPv4 CIDR allowed to reach port 22 from outside. Unset means no public SSH ingress at all, which is the default; AWS gives a shell through Session Manager without it, and OCI through the Bastion service, which reaches 22 from inside the subnet. `0.0.0.0/0` is refused, and so is a CIDR with no `sshPublicKey` — an open port nothing can answer is a rule in a firewall and a debugging session about the wrong thing |
| `sshPublicKey` | on OCI | | The contents of a `.pub` file. Refused if it looks like anything else, because a private key here would be a private key in your stack configuration. Required on Oracle Cloud, where it is the only way onto the machine and is installed at launch only; optional on AWS |
| `imageTag` | | the release | Another published release to deploy. It reaches the machine once, in the compose file cloud-init writes, so a machine that exists already takes a new one by the upgrade below |
| `imageRepository` | | `ghcr.io/thtmnisamnstr/simple-balance` | For a private mirror |
| `timezone` | | `Etc/UTC` | The machine's clock. Not the application's — that is each person's own setting |
| `backupKeep` | | `14` | How many daily dumps to retain on the data disk |
| `compartmentOcid` | OCI only | | Which compartment to build in. OCI has no default and the root compartment is a poor choice, since policies cannot be scoped to it |
| `availabilityDomain` | | the first | OCI only. Which availability domain to build the machine and its data volume in, by full name or by number from 1. Try another when the launch fails with `Out of host capacity` — another domain rather than another region, because Always Free covers the tenancy's home region only. Set it before the first successful `up` and leave it: changing it afterward replaces the data volume, and the secret, `env.local` and the backups go with the old one |
| `databaseSubnet` | | `false` | OCI only. `true` adds a private subnet to the stack's network that answers on 5432 to the machine's subnet and nothing else, and exports its OCID as `databaseSubnetId`, for [a database for Oracle Cloud](#a-database-for-oracle-cloud) to be created in. The database itself is not created |

There are deliberately **no secret keys here.** `AUTH_SECRET` is generated on the
machine at first boot and kept on the data volume at `0600`, so it enters neither
user data — which is readable by anyone who can describe the instance — nor
Pulumi's state file. Nothing outside the machine needs it, and a rebuilt instance
that reattaches the same volume finds the same one.

```sh
cd deploy/pulumi
npm install

# AWS
pulumi -C aws-single stack init books
pulumi -C aws-single config set aws:region us-west-2
pulumi -C aws-single config set simple-balance:hostname books.example.com
pulumi -C aws-single up

# Oracle Cloud. The provider reads ~/.oci/config unless the oci: namespace
# carries the credentials instead. The key is required, before the first up.
pulumi -C oci-single stack init books
pulumi -C oci-single config set oci:region us-ashburn-1
pulumi -C oci-single config set simple-balance:compartmentOcid ocid1.compartment.oc1..xxxx
pulumi -C oci-single config set simple-balance:hostname books.example.com
pulumi -C oci-single config set simple-balance:sshPublicKey "$(cat ~/.ssh/id_ed25519.pub)"
pulumi -C oci-single up
```

Both print a `nextSteps` output saying what is left, in order: the A record,
reaching the machine, putting `DATABASE_URL` in `env.local` and starting the
deployment, and then finding the one-time setup code in the application's log —
which is not there until the deployment has a database to start against. The
certificate arrives on its own once the name resolves; Caddy keeps retrying
until it does.

**Resizing is not a rebuild.** Change `size` and deploy, and both clouds
change the machine in place, restarting it into the new shape, and grow the data
volume where it is. The filesystem on the volume stays the size it was until it
is told otherwise: `sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"`
once the volume has grown — on Oracle Cloud after the rescan its documentation
on resizing a volume describes. Neither cloud shrinks a volume, so a `size`
whose disk is smaller than the one there fails at the volume.

**Replacing the machine keeps what is on its data disk.** The instance alone is
replaced by a new machine image, taken by lifting `ignoreChanges`, or by
`pulumi up --replace` naming it — the way back from a machine that has gone
wrong, not from an upgrade. An upgrade is undone on the machine, as
[docs/upgrades.md](../../docs/upgrades.md#rolling-back) says: the old tag back in
`/opt/simple-balance/compose.yml` and the backup taken before the upgrade
restored, because a new machine brings back the image the stack names and leaves
the database as the upgrade's migrations left it. The data volume is a separate
resource and is formatted only when it is not already a filesystem, so either
replacement destroys the root disk and leaves the backups, the generated
`AUTH_SECRET` and `env.local` alone. Pulumi moves the volume across once the new
machine is running, and the new machine's first boot waits two minutes for it.
If the move takes longer, `sudo cloud-init status` there reports an error: run
`sudo /usr/local/sbin/simple-balance-firstboot`, which is safe to run again.
Two things take the volume with it: `pulumi destroy`, and on Oracle Cloud a new
`availabilityDomain`. The ledger was never on the machine; it is in the database
`DATABASE_URL` names. On Oracle Cloud a replacement also comes up on a new
public address. Promoting the old one to reserved keeps it in the tenancy but
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

### `DATABASE_URL` goes on the machine

It is not a setting here, and that is the one worth expecting. These programs
build the `single` profile, whose database is somebody else's, so the connection
string carries a password — and anything these programs put on the machine
arrives as user data. The first boot therefore leaves the deployment enabled and
stopped, with the instructions in `/etc/motd`:

```sh
sudo nano /var/lib/simple-balance/env.local
#   DATABASE_URL='postgresql://user:password@host:5432/simple_balance?sslmode=no-verify'
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
once they are set — go in `/var/lib/simple-balance/env.local` too. It is on the
data volume rather than the boot disk, and it is folded into the `.env` Compose
reads every time the deployment starts: cloud-init installs a drop-in beside the
unit that runs `/usr/local/sbin/simple-balance-env` first. So a setting is an
edit and a restart. `/opt` is destroyed when the instance is rebuilt; the data
volume is not.

Use `sslmode=no-verify` for a database whose certificate is not from a public
certificate authority, which is most managed ones, OCI's included. The backup
and restore scripts rewrite it to libpq's `require`, which is the same
guarantee — encrypted, not verified — in the spelling `pg_dump` accepts. Do not
use `verify-full` on this profile yet: the nightly dump runs from the
`postgres:18` image, which carries no certificate authorities, so it fails there
even where the application's own connection would pass.

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

OCI Database with PostgreSQL is not part of Always Free, so it is billed. Any
other PostgreSQL 15 or later the machine can reach works as well, including one
you run yourself, and costs whatever it runs on. Two ways:

**OCI Database with PostgreSQL, in the stack's own network.** It wants a private
subnet of its own, which the program makes when asked:

```sh
pulumi -C oci-single config set simple-balance:databaseSubnet true
pulumi -C oci-single up
pulumi -C oci-single stack output databaseSubnetId
```

That subnet answers on 5432 to the machine's subnet and to nothing else. Then,
in the console under Databases → PostgreSQL → DB systems, create one:

1. PostgreSQL 15 or later. OCI still offers 14, which is below this
   application's floor — see [one PostgreSQL version](../../docs/deployment-profiles.md#one-postgresql-version).
2. Networking: this stack's VCN and the subnet `databaseSubnetId` names.
3. An administrator user and password. The password rules require a special
   character, so expect the URL to need it encoded.
4. Once it is active, the DB system's page shows its private endpoint: a
   hostname and a private IP address. Either works from the machine.

Then, on the machine:

```sh
sudo nano /var/lib/simple-balance/env.local
#   DATABASE_URL='postgresql://admin:<password, URL-encoded>@<private endpoint hostname>:5432/simple_balance?sslmode=no-verify'
sudo /usr/local/sbin/simple-balance-firstboot
```

`sslmode=no-verify` because the service's certificate is signed by an Oracle
certificate authority the container does not trust: the connection is encrypted
and the certificate is not checked, and the backups get the same through
libpq's `require`. The application creates the `simple_balance` database on its
first start if the server has none, which the administrator user may do; to use
a less privileged role instead, create the database first and make that role
its owner. `docs/deployment-sizing.md` has the server settings per machine size.

The program does not create the DB system itself, for the reason `DATABASE_URL`
is not a stack setting: its administrator password would be in Pulumi's state.

**Or any PostgreSQL 15 or later the machine can reach over TLS** — another
cloud's managed service, or a server you already keep. The machine's egress is
open, so all it needs is to be admitted by the database's own firewall, by the
address `publicIp` reports. The same URL shape and the same `sslmode` apply.

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
  replaces `X-Forwarded-For` with the address it saw, which behind an ingress is
  the ingress. `TRUST_PROXY` is on, so the allowance the API applies per address
  is shared by everybody. The setting that fixes it is
  `simple-balance:trustedProxyCidr` — the chart's `frontend.trustedProxyCidr`,
  `SB_TRUSTED_PROXY_CIDR` in the image — set to the range the ingress
  controller's pods run in. No image rebuild, and recursion stays off, for the
  reason `deploy/docker/nginx.conf.template` gives. It is not the whole answer
  on either cloud as these programs build them. On AWS the network load balancer
  in front of ingress-nginx uses IP targets, which do not pass the visitor's
  address on unless client IP preservation or proxy protocol is turned on, and
  `aws/index.ts` turns on neither, so ingress-nginx itself sees the load
  balancer. On GCP the Google load balancer connects from more than one range
  and appends its own address after the visitor's, which one trusted range with
  recursion off cannot see past.
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

`npm run typecheck` compiles all four programs without deploying anything, which
is the cheapest way to find out that an SDK upgrade moved an API.
