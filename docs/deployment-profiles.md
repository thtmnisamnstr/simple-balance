# Deployment profiles

Two shapes. What separates them is how many machines there are and what runs on
each; both run the same application, serve the same API and the same MCP
surface, read the same settings, and run a PostgreSQL 18 the deployment itself
provisions.

| Profile | Machines | The database | Material |
| --- | --- | --- | --- |
| `single` | Two: an application node and a database node | **PostgreSQL 18, on the database node**, provisioned by the same `pulumi up` | `deploy/compose/single/`, `deploy/systemd/`, `deploy/pulumi/aws-single/`, `deploy/pulumi/oci-single/` |
| `ha` | A Kubernetes cluster | **PostgreSQL 18 + Citus**, a StatefulSet per Citus group under Patroni | `deploy/helm/simple-balance/`, `deploy/pulumi/aws/`, `deploy/pulumi/gcp/`, `deploy/pulumi/oci/`, `deploy/docker/citus.Dockerfile` — `docs/citus.md` and `docs/citus-runbook.md` |

The database is the distinction worth reading twice. `single` puts it on a
machine of its own with no public address, which is the smallest shape that owns
its whole stack: nothing in it is somebody else's managed anything, and the
machine serving the internet is not the machine holding the ledger. `ha` shards
it across nodes and keeps a standby for each shard.

**Start with `single`.** It is the supported shape, it is what
`docs/deployment.md` assumes, and it is measured: `docs/capacity.md` put ten
thousand people's ledgers — thirty million transactions — on the smallest size
it sells, with the database squeezed onto the same machine, and answered the
busiest hour at a 130 ms 95th percentile with no errors. A ledger is not a
workload that needs a cluster. Move to `ha` when losing one machine for ten
minutes is unacceptable, not when the load gets interesting.

**Bringing your own database is still a supported answer**, and it is a setting
rather than a profile: `simple-balance:databaseNode: false` builds no database
node, no private subnet and no NAT gateway, and the application node waits for a
`DATABASE_URL` you set in the stack's `simple-balance:secrets`. Use it when you already keep a PostgreSQL, or on AWS to avoid the NAT
gateway's bill — `docs/deployment-costs.md` prices both.

## The `ha` profile's two shapes

`ha` is one profile with two sizes, and they differ by a values file rather than
by a migration. Same chart, same images, same Citus schema, same `0023`, same
backups. What changes is three numbers.

| | One node per service | Highly available |
| --- | --- | --- |
| Values file | `values-node-per-service.yaml` | `values-ha.yaml` |
| Pods | 5: frontend, API, scheduler, coordinator, one worker | frontend, API and scheduler autoscaling, plus three Citus groups |
| Citus groups | Coordinator + 1 worker | Coordinator + 2 workers |
| Replicas per group | 1 | 2 |
| Synchronous replication | Off — there is no standby to wait for | On |
| Pod disruption budgets | Off | On |
| Losing a node | That group's shards are gone until it returns, and the deployment is down while it is | A standby is lost or one failover happens; no shard is lost and no write stops |

```sh
# One node per service.
helm upgrade --install simple-balance deploy/helm/simple-balance \
  --namespace simple-balance --create-namespace \
  -f deploy/helm/simple-balance/values-node-per-service.yaml \
  --set config.appBaseUrl=https://books.example.com \
  --set secret.authSecret="$(openssl rand -base64 32)"

# Highly available. The same command with the other file.
helm upgrade --install simple-balance deploy/helm/simple-balance \
  --namespace simple-balance --create-namespace \
  -f deploy/helm/simple-balance/values-ha.yaml \
  --set config.appBaseUrl=https://books.example.com \
  --set secret.authSecret="$(openssl rand -base64 32)"
```

**Why the small shape is Kubernetes at all**, when five pods at one replica each
is more machinery than five containers would be. Because the alternative — a
separate profile with a database of its own arranged some other way — makes
growing into the redundant shape a migration: a different PostgreSQL, a
different schema, a dump and a restore and a window. Here growing is
`-f values-ha.yaml` and a rollout. The Kubernetes overhead at the small size is
the price of never doing that migration, and it is paid deliberately.

What the small shape gives up is redundancy and nothing else. The ledger is
already distributed, every connection between components is already TLS, adding
a worker is a number, and `docs/citus-runbook.md` applies to it unchanged.

Neither shape is in `values.yaml`. `database.enabled` is `false` there and stays
false, because a values file written for 0.1.6 has no `database` key and a
default that flipped would start a Citus cluster underneath a deployment that
already has a database. Both shapes opt in with `-f`.

The Pulumi programs for EKS, GKE and OKE build the redundant shape: they exist to set
up autoscaling and disruption budgets, which the small shape turns off. Reach
the small shape with `helm` against a cluster you have.

## One PostgreSQL version

Two different questions hide here, and answering them as one is how this page
was wrong for a while. **What will we connect to** is a floor, and it is
unchanged: PostgreSQL 15 and up, which is what a `DATABASE_URL` you supply may
name. **What do we deploy** is a choice, and the answer is the newest version
both profiles can share.

**Where we deploy a database, it is PostgreSQL 18.** That is `single`, whose
database node runs `postgres:18` in a container, and `ha`, whose cluster is
Citus on top of the same major version. One version across both, because a dump
taken from one shape has to restore into the other, and because collation and
planner behavior both change between releases — `docs/upgrades.md` has the
measurement showing what a collation difference alone does to every name-sorted
list in the product.

18 is decided by the cluster, because the cluster is the constrained end.
**Citus 14.2 is the newest Citus — there is no 15** — and it gates on PostgreSQL
16, 17 and 18, refusing anything else at configure time. 18 is the newest of
those, so it is what `ha` runs and therefore what `single` runs beside it. Citus
15 is unreleased; when it arrives it drops 16, which costs us nothing from 18.

The image is `postgres:18`, Debian rather than Alpine, and that is a decision
rather than a default. musl compares text byte by byte whatever collation is
declared, and category and payee uniqueness in this application rests on the
database's collation.

**Nobody on an existing deployment is moved silently.** A PostgreSQL major
version cannot read the previous major's data directory; the container refuses
to start and says so. `docs/upgrades.md` carries the one-time procedure, and an
operator who would rather stay on the version they have can point
`DATABASE_URL` at it and build no database node.

`deploy/compose/compose.distributed.yml` is neither profile: it runs the split
containers on **one** machine, which exists to exercise the shape the Helm chart
deploys without standing up a cluster. It is a demonstration, with a plain
bundled PostgreSQL and no Citus, and nothing in it holds a ledger anybody
depends on.

## What this does not add

`AGENTS.md` holds that PostgreSQL is the only persistent dependency, and that
nothing may add a sidecar or a writable-volume requirement. Neither profile
breaks it, and it is worth saying which of the two clauses each piece answers to
rather than leaving a reader to wonder.

The application container still writes nothing: it runs read-only with a 16 MiB
`tmpfs` for `/tmp`, exactly as `docs/deployment.md` has always described. The
ledger still lives in PostgreSQL alone, and PostgreSQL is still the only thing
in either profile with a volume that matters.

The `single` profile has two data volumes now, one per machine, and they hold
different things. The application node's holds the nightly dumps, the generated
`AUTH_SECRET` and the database's CA certificate —
see [host lifecycle](#host-lifecycle-in-the-single-profile). The database node's
holds `PGDATA` and the superuser password generated on that machine, and nothing
else: the server certificate and its key stay on the boot disk, because
cloud-init re-delivers them to a rebuilt machine and the data volume does not
need to.

What the application node keeps beyond that belongs to the host and to Caddy
rather than to the application. The container logs are bounded rather than
stored — 10 MiB across five files per service, which is Docker's own rotation
and not state. Caddy keeps its certificates and its ACME account key in one
volume and its saved configuration in another, which is genuine persistent state
and is also entirely regenerable: losing them costs a re-issue, and the only
reason to care is Let's Encrypt's rate limit of five duplicate certificates per
name per week. Neither holds anybody's data, and a deployment that terminates
TLS elsewhere has neither.

Caddy itself is not a new dependency. `docs/deployment.md` has required a
reverse proxy in front of this application since 0.1.0, because production
refuses an `APP_BASE_URL` that is neither HTTPS nor loopback. What
`compose.caddy.yml` adds is a default answer to a question that was already
being asked.

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
resolves `$remote_addr` back to the visitor before passing it on. It takes a
list, separated by commas or spaces, for more than one proxy, and it refuses to
start on an entry that is not an address, a CIDR or `unix:`, because nginx
would otherwise resolve a host name and trust the answer. Its default,
`127.0.0.1`, is the off position: nothing reaches the container from loopback,
so a deployment that sets nothing behaves exactly as it did before the setting
existed.

Name the proxy's range and nothing wider. This decides whose word is taken for
an address, so a range that includes callers lets a caller choose their own.

`SB_REAL_IP_RECURSIVE` stays off behind a terminator that replaces the header,
which is the case above: nginx takes the last entry, and that is the visitor.
It is for a chain whose every hop appends and is in the list, where off would
take the last hop's own address for everybody; on, nginx walks back past every
trusted hop to the first address that is not one, which the outermost hop wrote
from its own socket. That is Google's load balancer, which appends
`<client-ip>,<load-balancer-ip>`, and it is the one place the programs here turn
it on.

The `ha` programs set both for the network they build. On AWS the load balancer
in front of ingress-nginx would otherwise hand it the load balancer's own
address, so the program turns proxy protocol on between the two, and
ingress-nginx believes that header only from the load balancer's subnets, never
from the pods'; the frontend trusts the VPC's range, where ingress-nginx's pods
take their addresses, with recursion off. On GCP the load balancer is the
ingress, and the frontend trusts Google's two front-end ranges and the
Ingress's reserved address with recursion on. On both, a pod inside the cluster
that reaches the API directly — or on AWS the frontend — could still write its
own `X-Forwarded-For` if nothing stopped it; both `ha` shapes set
`networkPolicy.enabled`, and the firewall table below is what that enforces.
`deploy/pulumi/README.md` has the detail, including that only a frontend image
of 0.2.0 or later reads either setting.

## Encryption

Stated per profile rather than left to each provider's defaults. Where a
provider makes encryption optional the program sets it as a property, because a
setting is the provider's current behavior in one account and not a promise to
this deployment, and a property can be read in a plan and tested where a setting
is invisible in both. Where the provider encrypts every volume and offers no way
not to, the row says so and names the provider's key.

### At rest

| Where | What encrypts it |
| --- | --- |
| `single` on AWS, both data volumes and both boot volumes | `encrypted: true` on each, with an AWS-managed key unless `simple-balance:kmsKeyArn` names one of yours. Explicit because on AWS it is **not** a default: EBS encryption-by-default is an account setting that is off on a fresh account, so the property is the whole guarantee |
| `single` on Oracle Cloud, both data volumes and both boot volumes | OCI encrypts every boot and block volume at rest and offers no way to turn it off. The key is Oracle's own unless `simple-balance:kmsVaultOcid` and `simple-balance:kmsKeyOcid` name one of yours, and `tests/single-encryption.test.ts` holds the program to that: no key appears unless one is configured |
| `ha` on EKS, the database's volumes | A `simple-balance-gp3-encrypted` StorageClass the program creates, `encrypted: "true"`, named into `database.persistence.storageClass`. EKS also needs the `aws-ebs-csi-driver` addon and its IRSA role, which the program now installs — without it a PVC from the StatefulSet sits `Pending` forever |
| `ha` on GKE, the database's volumes | Google-encrypted persistent disks, on a `simple-balance-pd-balanced` StorageClass the program creates |
| `ha` on OKE, the database's volumes | Oracle-encrypted block volumes, on a `simple-balance-block` StorageClass the program creates, at the balanced performance tier. No `kms-key-id`, for the reason the single profile gives: a key of our own here buys a key policy to get wrong and a way to be locked out of the ledger's own volume |
| `ha`, the Kubernetes Secrets holding `DATABASE_URL`, `AUTH_SECRET`, `STRIPE_SECRET_KEY` and the database's own passwords | Envelope encryption in etcd against a KMS key each program creates: `encryptionConfigKeyArn` on EKS, `databaseEncryption` on GKE. This is the one place a program *creates* a key rather than accepting one, because neither cloud offers a managed key for it — and it is the one exception to the rule below, which is that a program accepts a key and never makes one |

### A customer-managed key, if you ask for one

**Unset is the default, and unset is a provider-managed key on every volume.**
That stays the right answer for most deployments: a CMK is a key policy to get
wrong, a monthly charge, and a documented way to lock yourself permanently out
of your own ledger. A deployment with a key-management policy that says
otherwise sets one, and these are the settings:

| Setting | Cloud | What it takes |
| --- | --- | --- |
| `simple-balance:kmsKeyArn` | AWS | The ARN of a symmetric `ENCRYPT_DECRYPT` KMS key you already have. It encrypts both data volumes and both boot volumes |
| `simple-balance:kmsKeyArnIsNewStack` | AWS | `true`, and required alongside `kmsKeyArn`. Your statement that this `up` changes no volume's key — the volumes do not exist yet, or they were already created with this key. The next section says why the program has to ask |
| `simple-balance:kmsVaultOcid` and `simple-balance:kmsKeyOcid` | Oracle Cloud | The vault and the key. Both, because the key cannot be looked up without the vault's management endpoint. AES, not RSA: the Block Volume service refuses a key wrapped with RSA |

**What the key's policy has to allow, on AWS.** This is the half no check can
see: `DescribeKey` answers about the key and says nothing about whether anybody
may *use* it, so a key that passes every check below can still produce a volume
that is created and then deleted moments later. The provider states the
requirement in as many words — it must run "with credentials which have the
`GenerateDataKeyWithoutPlaintext` permission on the specified KMS key... to
prevent a volume from being created and almost immediately deleted". So the key
policy has to grant, to the principal running `pulumi up`:

- `kms:DescribeKey` and `kms:Decrypt`,
- `kms:GenerateDataKeyWithoutPlaintext`, which is what `CreateVolume` calls,
- `kms:CreateGrant`, with the `kms:GrantIsForAWSResource` condition, which is
  what EC2 needs for the two root block devices.

**The default key policy is already all of it.** A key made with
`aws kms create-key` and no `--policy` gets a policy delegating to IAM in that
account, so an administrator or a role with the matching IAM permissions has
every one of those. That is the spelling to prefer, and a hand-written policy is
the case to check against this list. A key from another account needs the grant
on both sides, which this profile does not try to help with.

The failure mode is worth knowing because it is quiet: `CreateVolume` succeeds,
EBS deletes the volume seconds later, and Pulumi records two volumes in state
that no longer exist — marked `protect: true`, so the next `up` refuses to
reconcile them and the stack is stuck. On a first build the loss is an empty
volume. On the snapshot-copy migration below it happens at the step where the
copy is the only intact ledger.

**The program accepts a key and never creates one**, and that is the decision
worth arguing. A key a program creates has the program's lifetime, and that is
the wrong lifetime for the thing that decrypts a ledger:
`pulumi destroy --exclude-protected` is this profile's documented teardown and
it deliberately *keeps* both data volumes — a key the program owned would be
scheduled for deletion by the same command that kept the data, and
`pulumi stack rm` or a teardown with `protectDataVolume: false` would take it
with nothing keeping it at all. On Oracle Cloud it is worse, because a key needs
a vault and deleting a vault puts every key in it into pending deletion too. An
operator who wants a CMK has one, or has a policy that says where keys come
from. So the program's blast radius stays "machines and disks" and never reaches
"the key that decrypts them".

**It is checked before anything it would encrypt is built.** Both programs read
the key at plan time, and the refusal arrives before any volume, boot disk or
machine exists — the usability check is a `DescribeKey` whose result is consumed
as each encrypted resource's own input, so nothing the key would encrypt is
registered while it is unresolved, and `pulumi preview` shows the refusal with
nothing created. Be precise about what that does *not* cover: under
`pulumi up --skip-preview` the network is built from settings the key has no
part in, so a VPC, two subnets, an Elastic IP and possibly the NAT gateway can
exist by the time the refusal lands. Preview first. (The settings themselves —
a key named without `kmsKeyArnIsNewStack`, a vault named without its key — are
refused synchronously above the first resource, and that one is absolute.) AWS
refuses a key that is not `Enabled`, not customer-managed, not
`SYMMETRIC_DEFAULT` or not for `ENCRYPT_DECRYPT` — EBS supports nothing else.
Oracle Cloud refuses one that is not `ENABLED` or that is RSA-wrapped, and
**warns** rather than refusing on an HSM-protected key, because HSM is a
compliance decision an operator may have made on purpose — but it is billed per
key version where software-protected ones are free, it cannot be changed after
the key is created, and on Oracle Cloud it is the first thing in this profile
that takes a `small` stack off $0.

#### It is not retroactive, and on AWS that is destructive

**A volume's key is fixed when the volume is created.** AWS says so plainly:
you cannot change the key on an existing volume or snapshot, only on a copy. So
adding `kmsKeyArn` to a stack that already exists asks Pulumi to *replace* both
data volumes — a new empty volume, the old one deleted, and on the database node
that is the ledger.

**Pulumi's `protect` is not the guard, and it is worth knowing why.** It refuses
a replacement, it is on by default, and it would close this — except that
`protect` is a flag in the **state snapshot** while
`simple-balance:protectDataVolume` is a flag in the **stack config**, and the
two come apart in two documented ways. Setting `protectDataVolume: false` clears
it, which is step one of this repository's own teardown; and
`pulumi state unprotect <urn>` clears it in the state for a single destroy while
leaving the config saying `true`. A guard that read the config would pass
happily in the second case, the volume would diff on a ForceNew property against
a snapshot that says unprotected, and Pulumi would go ahead.

So the program asks the question that actually decides the outcome, of the only
party that knows the answer: **`kmsKeyArn` is refused unless
`simple-balance:kmsKeyArnIsNewStack` is `true`**, which is your statement that
these volumes are about to be created rather than replaced. A stack that was
*already* built with this key sets it too and plans nothing, because it is the
same claim either way: this `up` changes no volume's key. It stays set for the
life of the stack — it records *when* the key was chosen, not a mode — and the
refusal carries the migration below. The program deliberately does not look the
volumes up instead: `aws.ebs.getVolume` errors when it finds nothing, which is
every first `pulumi up`, so the lookup would refuse the one case it was added to
allow, and a lookup that found volumes could not tell a stack setting the key
for the first time from the daily `up` of one that has had it since it was
built. Check `pulumi preview` says **create** and not **replace** for both
`aws:ebs/volume` resources before you run the `up`.

Both boot volumes are replaced too, which replaces both machines — an outage
rather than a loss, since the data volumes survive and firstboot formats only an
unformatted device, but not something to meet by accident.

So on AWS, **set it before the first `up`, or migrate by hand**: stop the
compose stack, snapshot the data volume, copy the snapshot with the new key,
create a volume from the copy, detach the old one and attach the new one at the
same device, and bring the stack's state back into line. In that order it
destroys nothing, and it is not a `pulumi up`.

**On Oracle Cloud it is not destructive, and it reaches all four volumes.**
`kmsKeyId` on a block volume is updatable: OCI re-wraps the volume's data key and
leaves the contents alone, with no detach and no downtime. The boot volumes take
it too, and that is deliberate rather than lucky: `@pulumi/oci` marks
`InstanceSourceDetails.kmsKeyId` updatable, and both instances name *properties*
in `ignoreChanges` — `sourceDetails.sourceId`, `sourceDetails.bootVolumeSizeInGbs`
and `metadata` — rather than the whole of `sourceDetails`. Ignoring the parent
would ignore everything under it, so a key added later would be swallowed on
every stack that already exists while a fresh stack took it: the same
configuration, different encryption, and nothing said. So an existing OCI stack
takes the key on all four volumes with no by-hand step, and
`oci bv boot-volume-kms-key update` is not part of adding one. It is still the
right command for taking a key *off* a boot volume, which is the lock-out escape
hatch below. This is the one behaviour worth a `pulumi preview` against a real
tenancy before you rely on it.

#### Locking yourself out, and getting back in

A key that is disabled, scheduled for deletion, or whose policy loses the
principal that needs it is a volume nobody can read, including you. The two
clouds fail at opposite ends of the same 7-to-30-day window, and the difference
decides how you find out:

**AWS gives no warning at all, and then gives none.** Disabling a key or
scheduling it for deletion has *no immediate effect*: the volume is already
attached and EC2 encrypts disk traffic with a data key held in the Nitro
hardware, not with the KMS key. The deployment serves perfectly, for up to
thirty days. It dies at the next detach and reattach — a stop/start, an instance
replacement, a resize — and a stop/start detaches the root volume too, so the
machine transitions straight back to `stopped`.

- **While the deletion is pending:** `aws kms cancel-key-deletion`, or
  `aws kms enable-key` for a key that is merely disabled. The window is 7 to 30
  days, defaults to 30, and AWS says the real one may run up to 24 hours longer
  than the one scheduled.
- **After it:** nothing. The data is unrecoverable, and there is no way back
  even with the same key material — AWS will not let you create a key that can
  decrypt a deleted key's ciphertexts.
- **The only warning that exists** is one you set up: a CloudWatch alarm on use
  of a key that is pending deletion. Worth doing on the day you set `kmsKeyArn`,
  because nothing else will tell you.

**Oracle Cloud fails immediately and loudly, and has a way out AWS does not.**
A key in `Pending Deletion` makes everything encrypted by it inaccessible at
once — which is far better, because you find out in minutes rather than in weeks.

- **While the deletion is pending:** cancel it, or re-enable a disabled key.
- **The escape hatch, and the order is what matters.** A volume can be moved
  back onto Oracle's own key in place — `oci bv volume-kms-key delete` and
  `oci bv boot-volume-kms-key delete` — but a key in `Pending Deletion`
  **cannot be assigned or unassigned to anything**, so the hatch is shut until
  the deletion is cancelled. **Cancel the deletion first, then unassign from all
  four volumes, then schedule the key's deletion again.** Do it in the other
  order and you wait out a thirty-day window you did not have to.
- **After the window:** all key material and metadata is irreversibly destroyed.

`docs/deployment-costs.md` §Customer-managed keys prices both, and names the two
traps that cost money rather than data: an Oracle key's `protectionMode`
defaults to the billed one and cannot be changed afterward, and a
`VIRTUAL_PRIVATE` vault is billed by the hour.

### In transit

| Hop | How |
| --- | --- |
| Browser to the edge | HTTPS. Caddy on the application node in `single`, with a Let's Encrypt certificate it obtains itself; the ingress controller in `ha` |
| Caddy to the application, in `single` | Plaintext, over a Docker bridge inside one machine's network namespace. Nothing leaves the host, and there is no second machine for it to leave to |
| Application to database, in `single` | `sslmode=verify-full` with `sslrootcert` naming a CA this stack issued. The server enforces it: every non-local line of the mounted `pg_hba.conf` is `hostssl`, so a client that dropped `sslmode` is refused rather than served in the clear |
| Backup and restore client to database, in `single` | The same `DATABASE_URL`, through the same CA file, which the scripts mount into the `postgres:18` client container |
| Application and scheduler to database, in `ha` | `sslmode=verify-full` against a CA the chart generates, mounted into both pods at `/etc/simple-balance/db-ca.pem` |
| Citus coordinator to workers, and streaming replication, in `ha` | `sslmode=verify-ca`. Not `verify-full`, deliberately: Patroni registers members by pod address, which no certificate can promise, so a name check would fail a healthy cluster |
| Hypervisor to block storage, AWS | Automatic on Nitro when the volume is encrypted. There is no property for it, so the guarantee rests on the instance-type tables being Nitro throughout — `t4g` on the application node, `t4g` and `m7g` on the database node — which a test pins rather than trusting the comment |
| Hypervisor to block storage, Oracle Cloud, in `single` | `isPvEncryptionInTransitEnabled: true`, on both instance launches and on both volume attachments. Two flags because they are two hops: the launch flag covers the boot volume and the attachment flag the attached one, and both need a paravirtualized attachment, which is what the program uses |
| Node to block storage, `ha` on OKE | `isPvEncryptionInTransitEnabled: true` on the node pool, which the CSI driver reads from the node when it attaches a volume, and `attachment-type: paravirtualized` on the StorageClass, the only attachment OCI encrypts in transit. Since 0.2.1: before it the class spelled that key `attachmentType`, which the driver ignores, so the volumes and nodes made before then are iSCSI and unflagged, and keep what they were made with |

**Why `verify-full` and not `require`.** The same connection string is read by
node-postgres and by libpq, in `psql`, `pg_dump` and the restore script. For
libpq, `require` checks nothing at all about who answered; node-postgres reads
it as `verify-full` and fails against a CA it was not given. `verify-full` is
the one spelling both read the same way, and it is what the programs generate.
`docs/deployment.md` §Reaching the database over a network has every mode.

**Rotation is by hand, and the reason is written down rather than pretended
away.** Both `single` instances carry `ignoreChanges` on their user data, so a
certificate re-issued by a later `pulumi up` would sit in Pulumi state and never
reach a running machine. The certificates are therefore long-lived — ten years
for the CA, five for the server — and replacing one is a procedure:
`deploy/pulumi/README.md` §Rotating the database's certificate has it. In the
chart, deleting the four TLS keys from the `<release>-db-credentials` Secret and
running `helm upgrade` reissues them.

**Nothing is refused that a previous release accepted.** A `DATABASE_URL` with
`sslmode=disable`, or with no `sslmode` at all, still works: `simple-balance-env`
warns about it in the journal on every start and carries on. Nothing in `src/`
changed.

## The firewall

Written as source and port, per machine, because "only what needs inbound
internet access gets any" is a claim that has to be checkable rather than
asserted. `tests/single-ingress.test.ts` reads every rule both programs declare
and counts them, so a rule added here fails a test rather than a review.

### `single`, the application node

| From | To | Port | Why |
| --- | --- | --- | --- |
| Anywhere, IPv4 and IPv6 | The application node | 80/tcp | The redirect to HTTPS, and the ACME HTTP-01 challenge |
| Anywhere, IPv4 and IPv6 | The application node | 443/tcp | The site. This is the one service in the profile that genuinely needs inbound internet: it is the browser's only way in |
| Anywhere, IPv4 and IPv6 | The application node | 443/udp | HTTP/3, which Caddy serves by default. Closing it costs a little connection setup time and nothing else, so it is opened to match 443/tcp rather than leaving a silent fall back |
| One named address | The application node | 22/tcp | Optional, and off by default: `simple-balance:sshCidr`, which refuses `0.0.0.0/0`. AWS gives a shell through Session Manager without it, and Oracle Cloud through the Bastion service and the next row |
| The application subnet, `10.30.0.0/24` | The application node | 22/tcp | `oci-single` only, and always: an OCI Bastion's private endpoint sits in the subnet it serves, and with no `sshCidr` it is the only way onto the machine |
| The host | Anywhere | 443/tcp | Container images, Let's Encrypt, and any Stripe endpoint configured |
| The host | The database | 5432 | The ledger, and the nightly dump. Outbound only |
| The host | The SMTP relay | 587 or 465 | Only where mail is configured |

**Nothing opens 3000**, on either machine. Caddy reaches the application over
the Docker network inside the machine, and a rule for 3000 would be a second way
in that the application's own origin checks do not cover. **Nothing opens 5432
here either**: this machine connects out to the database node.

**Why this machine keeps a public address**, deliberately and not by omission.
Caddy terminates TLS here and obtains its certificate by the ACME HTTP-01
challenge, which requires Let's Encrypt to reach the machine on port 80 at the
name in the certificate. There is no load balancer in this profile — adding one
is what `ha` is — so the application node *is* the edge, and an edge that cannot
be reached from the internet serves nobody. The alternative, DNS-01, would need
the program to hold an API token for the operator's DNS provider: a credential
to a third system in Pulumi state, and a different integration per registrar.

### `single`, the database node

| From | To | Port | Why |
| --- | --- | --- | --- |
| The application node's security group | The database node | 5432/tcp | AWS. The only inbound rule by default. A source-security-group rule rather than a CIDR, so it stays correct when the application node is replaced or re-addressed |
| The application subnet, `10.30.0.0/24` | The database node | 5432/tcp | Oracle Cloud. A security list takes CIDRs, so the application subnet is the tightest source available, and it holds exactly one machine |
| The database subnet, `10.30.1.0/24` | The database node | 22/tcp | Oracle Cloud. An OCI Bastion's private endpoint must sit in the subnet it serves, and this is the only way to get a shell on a machine with no public address |
| The application node's security group | The database node | 22/tcp | AWS, and **only under `simple-balance:databaseEgress: ipv6`**. That setting takes Session Manager away from this machine — its agent resolves an IPv4-only endpoint and the subnet then has no IPv4 route — and ssh from the application node is the replacement shell. A source-security-group rule again, so it names that one machine and nothing from the internet can reach it |
| The database node | Anywhere | 443/tcp, 80/tcp | Egress, through a NAT gateway by default: Ubuntu's archive at first boot and every day after for unattended-upgrades, the image registry once, and — on AWS — Session Manager, which is the only shell onto a machine with no public address. `simple-balance:databaseEgress: ipv6` routes the same traffic through an egress-only internet gateway instead, at no charge and without Session Manager; `ssm` is that gateway plus two SSM interface endpoints, which keeps Session Manager for $14.60 a month in a US region and adds no inbound rule here. `docs/deployment-costs.md` compares all three |
| The two node security groups | The SSM interface endpoints | 443/tcp | AWS, and **only under `simple-balance:databaseEgress: ssm`**. Not a rule on either machine: it is on the endpoints' own security group, and it names **both** node security groups as sources rather than only the database node's. Private DNS on an interface endpoint overrides `ssm.<region>.amazonaws.com` for the whole VPC and not for one subnet, so the application node resolves it to the endpoint too — a rule admitting only the database node would silently take Session Manager away from the machine that had a working shell |

**Nothing from `0.0.0.0/0` or `::/0`, on any port, on either cloud.** On AWS,
with `databaseEgress` unset — which is every stack that does not change it —
there is one inbound rule and it is 5432: the shell is Session Manager through
egress, and the node's role carries `AmazonSSMManagedInstanceCore`. Under
`databaseEgress: ipv6` there are two, and the second is 22 from the application
node's security group, because that setting is what takes Session Manager away.
Under `databaseEgress: ssm` there is one again, and it is 5432: the endpoints
keep the agent reaching Systems Manager without a route out, so nothing has to
open a port to replace the shell. The 443 rule that setting adds is on the
endpoints' security group rather than on either machine, and its sources are
security groups rather than CIDRs, like every other rule here.
On Oracle Cloud there is no `sshCidr` rule, because the machine has no public
address for one to admit anybody to; such a rule would read as an exposure that
is not one.

**No public address, twice over.** The subnet refuses one —
`mapPublicIpOnLaunch: false` on AWS, `prohibitPublicIpOnVnic: true` on Oracle
Cloud — and the instance asks for none.

**The other half of the firewall, on Oracle Cloud.** The OCI Ubuntu image ships
a netfilter ruleset that accepts 22 and rejects the rest, so a security list
that opens 5432 meets a host that still refuses it. The database node's platform
commands insert an `ACCEPT` for 5432 and run `netfilter-persistent save`, before
the database starts. Only 5432: this machine serves neither 80 nor 443.

**The scheduler has no node of its own in this profile.** It runs inside the
all-in-one image on the application node and is reachable from nothing outside
it. That was already true and this work did not change it.

### `ha`

| From | To | Port | Why |
| --- | --- | --- | --- |
| The load balancer | frontend | 8080 | Every request, including `/api` and `/mcp` — the frontend proxies them, which is what puts the browser and the API on one origin |
| frontend | server | 3000 | The proxied half |
| server, scheduler | database | 5432 | |
| database | database | 5432 | A standby streaming from its primary, and a coordinator running a distributed query |
| database | database | `database.restApiPort` | Patroni's REST API, between database pods only, plus whatever `probeSourceCidrs` names |
| server, scheduler | Anywhere | 443, 587/465 | Stripe and mail, where configured |

The server is not publicly reachable in either shape, and a second ingress rule
sending `/api` straight to it would bypass the `X-Forwarded-For` handling
`TRUST_PROXY` depends on. The database is behind ClusterIP and headless
Services and has no Ingress, LoadBalancer or NodePort of any kind.

Two rows are worth reading twice. **The frontend is not a peer of the
database** — it proxies to the API and has no reason to open 5432 — and
**neither the server nor the scheduler may reach Patroni's REST API**, which
before this release any pod in the cluster could, well enough to `POST
/switchover`, `/failover`, `/restart` or `/reinitialize`. That endpoint now
takes a username and a generated password as well.

**A policy a CNI ignores is worse than none**, because the cluster then looks
guarded in `kubectl get networkpolicy`. Both shapes set `networkPolicy.enabled`;
the `aws` program turns on the VPC CNI's network policy agent and the `gcp`
program asks for Dataplane V2. Calico is deliberately not used on GKE: it would
disable container-native load balancing and break the frontend's client-address
handling. Egress from the database pods stays open, because Patroni keeps
cluster state in the Kubernetes API, whose address this chart cannot know, and a
restricted cluster that loses that rule stops failing over.

`simple-balance:controlPlaneCidrs` narrows the Kubernetes API endpoint itself on
all three clouds. It is unset by default, because a wrong guess locks a stack out
of the control plane it would need to fix itself.

The three do it in different places, and on one of them it is the deployment's
own job rather than the cloud's. EKS and GKE manage the endpoint and take the
allowed sources as a property of the cluster, so the only question is how wide.
OKE puts the endpoint in a subnet of the deployment's own and applies that
subnet's security list to it — so the same list decides whether the workers may
reach the API *at all*, and a list carrying only 80 and 443 builds a cluster that
reports itself ACTIVE and never produces a ready node.
`tests/cluster-control-plane.test.ts` holds all of it, and it stands in for a
`pulumi up` nobody has run: a preview plans the rules and the cluster cleanly,
so nothing short of a real build would otherwise meet the empty node pool.

## DNS

**One public A record**, pointing at the address the cloud program outputs, and
it is the application node's. The database node has no public address and needs
no public name.

The two clouds differ here, and the difference is a constraint rather than a
choice. AWS gets an Elastic IP, which outlives the instance. Oracle Cloud gets
the ephemeral address its VNIC is created with, because OCI maps at most one
public IP to a private IP at a time: attaching a reserved address to a VNIC that
already has an ephemeral one is refused, and creating the VNIC without one
leaves the machine with no route to the internet while cloud-init is installing
Docker. In practice it is stable for the life of the instance, because a later
`pulumi up` leaves the instance alone and a new `size` reshapes it in place. An
instance that is replaced — destroyed and built again, by hand or by a change
that forces it — comes back on a new address, and the record has to follow it.
Promoting the ephemeral address to reserved in the OCI console keeps it past
the machine, but it does not follow a replacement: the new instance comes up
on a fresh ephemeral address, and the reserved one has to be moved onto it by
hand, or the record moved instead.

The name has to resolve **before** a certificate can be issued: Let's Encrypt
proves the name by connecting to it. Caddy retries until it works, so the order
does not matter much — the machine simply serves nothing over HTTPS until the
record exists.

**And one private name, which nobody configures.** The database node is reached
at the internal name its own provider already gives it:

| Cloud | The name |
| --- | --- |
| Oracle Cloud | `db.db.simplebalance.oraclevcn.com` — the host label, the subnet's DNS label and the VCN's |
| AWS | `ip-10-20-1-10.<region>.compute.internal`, and in `us-east-1` alone `ip-10-20-1-10.ec2.internal` |

That name is known before the machine exists, because the database node's
private address is pinned. It is what the server certificate's SAN carries, and
what `DATABASE_URL` names, so `verify-full` has a name to check. It needs no
`/etc/hosts`, no `extra_hosts`, no `--add-host` and no private hosted zone:
Docker's resolver forwards to the host's, which is the VPC or VCN resolver.

**Use the name and not the address**, even though the pinned address is also in
the certificate. node-postgres passes no server name for an IP literal, so
Node's TLS client checks the certificate against the string `localhost` and
`verify-full` fails with an altnames error against a certificate that does carry
the address. libpq verifies an IP SAN correctly, which is why the address is
there at all: `psql "host=10.20.1.10 sslmode=verify-full"` works for an operator
debugging by hand. The generated URL always uses the name.

Inside the application node, Caddy reaches the application as `app`, a Compose
service name resolved by the container runtime's own resolver on a network that
exists inside one host.

## Connection budgets

Each API and scheduler process holds `DATABASE_POOL_SIZE` connections and one
more while it starts.

| Profile | Processes | Connections at peak | Against |
| --- | --- | --- | --- |
| `single` | 1 | `1 × (10 + 1)` = **11** | `simple-balance:databaseMaxConnections`, default **50** |
| `compose.distributed.yml` | 1 server + 2 schedulers | `3 × (10 + 1)` = **33** | PostgreSQL's default 100 |
| `ha`, one node per service | 1 server + 1 scheduler | `2 × (10 + 1)` = **22** | The chart's `max_connections`, 200 |
| `ha`, at the chart's default ceilings | 4 server + 2 scheduler | `6 × (10 + 1)` = **66** | The same 200 |

The `single` number does not move, because there is nothing to scale out — which
is the profile's whole shape. **50 rather than PostgreSQL's 100** because the
profile now owns the setting and can size it: eleven for the application, one
for `psql`, one for `pg_dump`, and the rest is slack on a machine whose memory
every allowed connection costs something of. Raise it with
`simple-balance:databaseMaxConnections`, which has a floor of 10 and is applied
as a `-c` flag on the server.

Under `ha` the number moves with every replica ceiling, so the chart refuses to
install a combination that would exceed `config.maxConnections` and prints the
arithmetic either way. With `simple-balance:database: in-cluster`, the Pulumi
programs derive that ceiling from the chart's own 200 rather than from the 100 a
stock PostgreSQL allows — which is wrong in the conservative direction once the
chart owns the database, and would refuse replica counts the cluster could
serve.

## Host lifecycle, in the `single` profile

**Two machines, one unit.** `deploy/systemd/simple-balance.service` is the same
unit on both, switched by `COMPOSE_FILE` in `/etc/default/simple-balance`:
`compose.yml:compose.caddy.yml:compose.db-tls.yml` on the application node and
`compose.postgres.yml` on the database node. Nothing branches on a profile name,
because there is nothing to branch on.

**Boot order.** systemd starts the unit after `docker.service` and after the
network is up. It is `Type=oneshot` with `RemainAfterExit=yes`, so systemd treats
the whole deployment as one thing that is either up or down. On a machine a
cloud program built, a drop-in beside it
(`/etc/systemd/system/simple-balance.service.d/env.conf`) adds two things: the
unit waits for the data volume to be mounted, and every start first runs
`/usr/local/sbin/simple-balance-env`, which rebuilds `.env` from its parts — see
[secrets](#secrets). Both machines have that drop-in, and the database node
needs it for a reason of its own: fstab mounts the volume `nofail`, and a start
that raced the mount would initialize an empty cluster on the boot disk. A
machine set up by hand from `deploy/systemd/` has no drop-in and starts on the
`.env` it has.

**Who restarts what.** systemd owns ordering and intent — boot, `systemctl
start`, `systemctl stop`. Docker owns crash recovery, through
`restart: unless-stopped`. They do not fight because the unit's `ExecStop` runs
`docker compose down`, which removes the containers, so a deliberate stop leaves
nothing for Docker's restart policy to bring back.

**And the application node waits for the database before Compose is asked for
anything**, which is ordering and so is systemd's half of that split. Both
machines boot at once and the database node takes about four minutes longer —
it formats a volume, chowns a key, initializes a cluster and runs its own
first-run SQL — while the application node is ready in ninety seconds. Without
the wait, `docker compose up -d --wait` finds nothing listening on 5432, and the
damage is not the failed health check that Docker recovers from on its own: it
is that `--wait` abandons the rest of the project on the way out, so Caddy is
*created and never started*. The machine ends up with a healthy application on
loopback, nothing on 80 or 443, and a unit in `failed` that nothing retries,
because `ExecStart` has already run. `systemctl restart` fixes it instantly,
which is the tell that it was ordering all along. The wait does nothing at all
when there is no remote database to wait for — on the database node itself, on a
hand install pointed at something already running, or on a machine nobody has
configured yet — because being wrong in that direction costs one boot and
refusing would strand a machine that worked before the check existed.

**The first start is slow and that is fine.** Against an empty database it runs
every migration under an advisory lock before readiness opens. The unit allows
600 seconds for it, which is twice the 300 the health check allows, because
systemd's default of 90 would kill a first migration two thirds of the way
through.

**Logs.** Docker's `json-file` driver keeps every line forever by default, which
on AWS's 20 GiB boot disk is how the disk fills. Every service in `compose.yml`,
`compose.caddy.yml` and `compose.postgres.yml` caps itself at 10 MiB across 5
files.

**Disks.** Each machine has a boot disk that holds the operating system, the
images and the logs and does not grow, and a data volume that outlives it. The
application node's data volume holds the backups, the generated secret in
`secrets.env` and the database's CA certificate in `tls/`. The stack's settings
are on neither volume: they are fetched from the cloud's secret store at every
start. The database node's holds `PGDATA` and the superuser password generated
on that machine. Both are separate volumes on both clouds, so replacing either
machine keeps what was on it, and on Oracle Cloud neither is ever made smaller
than 50 GB, which is that provider's minimum.
`docs/deployment-sizing.md` sizes all four — and sizes the two data volumes
**separately**, because they hold unrelated things: `PGDATA` grows with the
ledger, while the backup disk grows with the ledger times fifteen daily dumps,
so at `medium` and `large` the application node's is the larger of the two.
A key of your own on any of them is `simple-balance:kmsKeyArn` or
`simple-balance:kmsKeyOcid`, and §Encryption above is what to read first,
because on AWS the key cannot be changed after the volume exists.

**Adding a volume's key later replaces the volume on AWS.** That is the one
change in this profile that a single config line can make destructive, and both
`protectDataVolume` and a check in the program stand in front of it — see
§Encryption. On Oracle Cloud the same change is an in-place re-wrap and destroys
nothing.

`simple-balance:protectDataVolume` governs both data volumes. While it is on, as
it is by default, Pulumi's `protect` makes `pulumi destroy` refuse rather than
take either, and so does the one change that would replace them on each cloud —
a new availability domain on Oracle Cloud, a new region on AWS;
`deploy/pulumi/README.md` §Tearing down on AWS and §Tearing down on Oracle Cloud
are how to mean it.

**Backups stay on the application node**, and that is worth stating because it
is the one thing a reader expects to have moved. A daily `pg_dump` in
PostgreSQL's own compressed format, taken over the network from a `postgres:18`
client container onto the application node's data volume, and verified by
reading it back before it is kept. The timer's unit requires the deployment to be
running rather than starting it, so a deployment stopped on purpose stays
stopped and that night's backup fails instead. It connects with the
application's own `DATABASE_URL`, and under `sslmode=verify-full` it checks the
database's certificate exactly as the application does: the `postgres:18` client
carries no certificate authorities, so the script mounts the CA certificate
`sslrootcert` names into it, and without one the machine's own CA bundle. That
file lives in `/var/lib/simple-balance/tls/`, on the data disk, where the
`compose.db-tls.yml` overlay mounts it into the application at the same path.

Keeping them there is deliberate: the dumps are a copy of the ledger, and a copy
that lives on the same disk as the ledger is not a backup. It also keeps
`simple-balance-backup` free of any statement about which profile it is in — it
decides whether to dump from inside the deployment or over the network by
reading the Compose project's own service list, and on the application node that
list has no `postgres` in it. `docs/standards/operations.md` §A deployment
profile is a shape, not a setting is the argument.
[`docs/deployment.md`](deployment.md#reaching-the-database-over-a-network) has
every `sslmode`, and `deploy/compose/single/README.md` the commands, the restore
included.

## Secrets

**On the application node**, the one the deployment generates, `AUTH_SECRET`, is
generated there at first boot and kept on the data volume, in `secrets.env` at
`0600`. It is in no user data, no Pulumi state file and no cloud API response,
because nothing outside the machine has any use for the value, and a rebuilt
instance that reattaches the same volume finds the same one.

**On the database node**, the superuser password is generated the same way at
first boot, by the same recipe, and kept on that machine's data volume at `0600`.
It is in no user data and no Pulumi state either, and a rebuild against a live
volume does not rotate it — the script generates one only when the file is
absent, because rotating it out from under an initialized cluster would lock the
machine out of its own database.

**What each machine is told, and what it is not**, deliberately asymmetric so
each gets the minimum:

| | Application node | Database node |
| --- | --- | --- |
| The CA certificate | Yes, it is public | No |
| The CA private key | No | No — it exists only in Pulumi state |
| The server certificate and key | No | Yes, the key at `0600`, owned by the server's own user |
| The application role's password | Yes, inside `DATABASE_URL` | Yes |
| The superuser password | No | Generated there, and nowhere else |
| `AUTH_SECRET` | Generated there | No |

The generated `DATABASE_URL` is written by cloud-init into
`/opt/simple-balance/env.db` at `0600`, holding that one line and nothing else.

Everything an operator genuinely supplies is the stack's: an SMTP password, a
Stripe key, the AdSense ids — and a `DATABASE_URL` of your own, if you would
rather point this machine at a database you keep — in `simple-balance:env` and
`simple-balance:secrets`. The program writes them into one secret in the
cloud's store, OCI Vault or AWS Secrets Manager, and grants the application
machine's own identity read on that secret and nothing else. The machine fetches
it every time the deployment starts, through a drop-in that runs
`/usr/local/sbin/simple-balance-settings` and then `simple-balance-env`, and a
timer checks it every five minutes, so a setting is a `pulumi up` and reaches
the machine with nobody logged in. `deploy/pulumi/README.md`, "The
application's settings", has both ways to set them.

That replaces a file on the data volume that settings used to be typed into
over SSH, and the reason it could not have been the stack before is the reason
it can be now: anything a program put on the machine arrived as user data,
which anyone who can describe the instance can read. The settings now travel
by a fetch only the machine can make, so a Stripe key is in the stack's
encrypted config and the cloud's secret store, and in nobody's shell history.
A rebuilt machine has every setting it had, without anybody having kept a copy.

**The fold order is what makes the stack's setting win.**
`simple-balance-env` folds `env.base`, then `env.db`, then `secrets.env`, then
the fetched settings, and Compose reads the last assignment of a variable. So
an operator who sets their own `DATABASE_URL` gets theirs, on a machine whose
program generated one, with nothing to turn off first. A machine built with
`simple-balance:databaseNode: false` has no `env.db` at all; firstboot's gate
then holds the deployment installed-and-stopped, and writes `/etc/motd` saying
so, until the stack has a `DATABASE_URL`.

The first time, when there is no `DATABASE_URL` yet and nothing started,
`sudo /usr/local/sbin/simple-balance-firstboot` after the `pulumi up` does it.
A machine set up by hand has no drop-in and no parts to fold, so there the
settings are `/opt/simple-balance/.env` itself, followed by a restart. `docs/deployment.md` describes the `_FILE` variants for a
deployment that keeps secrets somewhere else entirely.

**A `pulumi up` does not re-run any of this, on either machine.** Cloud-init's
`runcmd` is per-instance, and neither program replaces an instance when the
deployment material changes — deliberately, because that would be minutes of
downtime on every edit and, on Oracle Cloud, a new address. These programs
provision machines; they do not keep managing them. Apply an application
upgrade, a setting or, on Oracle Cloud, another SSH key on the machine itself,
which the generated user data explains in its own header and
`deploy/pulumi/README.md` repeats.
