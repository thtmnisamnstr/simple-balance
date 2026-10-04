# Upgrades

Everything persistent is in PostgreSQL. The container holds nothing you need to
keep, so upgrading is swapping it for a newer one.

## Before you upgrade to 0.1.7

**This heading is the next release's slot and its number is provisional.** The
release being built is 0.2.0, and this heading is spelled 0.1.7 only because
`tests/version.test.ts` asks for the next _patch_ of whatever `package.json`
currently says. It gets its real number in the cut commit, right after
`npm run set-version` — §Cutting a release, step 2, which also opens the note
for the release after it. Nothing renames it on its own. The content below is
what matters and is written as the work lands, because a note written while a
release is being cut says whatever the person cutting it can remember.

**Nothing about an existing configuration has to change, and the application
refuses nothing 0.1.6 accepted.** Everything added is optional and off unless an
operator sets it.

**That includes `deploy/compose/compose.distributed.yml`,** the one recipe here
that bundles its own PostgreSQL: it still runs 0.1.6's `postgres:16-alpine` on
the volume you already have, because a container cannot read the previous major
version's data directory and a release that stops is not a release that
upgrades. Moving it to 18 is worth doing and is an opt-in, below.

**And one interruption to schedule, if you run the `aws` Pulumi program.** Its
next `pulumi up` turns proxy protocol on between the network load balancer and
ingress-nginx, which is what finally lets the API see who is signing in, and
the public address answers nothing, or a `400`, for seconds to about a minute
while the two ends change over. That same `up` also turns on envelope encryption
of Kubernetes Secrets, **which EKS cannot turn back off**, and rolls the VPC CNI
once so a `NetworkPolicy` is actually enforced. The `gcp` program moves no load
balancer and changes nothing unless you ask it for an in-cluster database. All
of it is below.

### What runs automatically

**Four migrations, none of which rewrites a row on a single PostgreSQL, and on
almost every deployment one of them does nothing at all.**

`0022_plans_and_billing.sql` is additive only: five new tables —
`billing_customer`, `billing_subscription`, `billing_override`,
`billing_operation` and `billing_webhook_event` — two new enum types, four
foreign keys onto `auth_user` and one index. It alters no existing table, adds no
column to one, and rewrites no rows, so it completes in the time it takes to
create five empty tables however large your ledger is.

`0023_citus_distribution.sql` **does nothing at all unless your database has the
Citus extension installed**, which is the `ha` profile and nothing else. It is
gated on that extension at the top and returns immediately without it, so a
deployment on one PostgreSQL records it as run and keeps exactly the schema it
had. A second gate stops it on a ledger that is already distributed and says so,
which matters because the runbook invites you to run this file by hand. Verified
on PostgreSQL 15 and 18, from an empty database and from one 0.1.6 left, and
again on 18 once `0025` joined them: twenty-six migrations recorded, and every
primary and foreign key exactly as `0022` left it.

On a Citus cluster it is the substantial one. It rewrites fourteen primary keys to
carry the owner, which rebuilds every index on them; drops five unique
constraints the new key makes redundant; and moves the ledger's seventeen tables
onto the workers while fourteen are replicated to every node. It runs as one
transaction — it either distributes everything or changes nothing — and it takes
a lock on `posting` for the duration. **Take a dump first**, and read
`docs/citus-runbook.md` §Moving an existing database onto a cluster before you
start, because a database that was already on this release when Citus arrived has
this migration recorded and will not run it again.

**And raise the startup budget before the first start**, which is the part that
bites without explaining itself. The chart's startup probe allows five minutes; a
migration that takes longer is killed mid-flight, rolls back, restarts and is
killed again, forever, with each event looking like a slow start rather than a
budget that is too small. `docs/citus-runbook.md` §Before the first start against
a cluster has the one values change that prevents it.

`0024_active_accounts.sql` adds one column, `ledger_account.active`, with a
constant default of true. A constant default rewrites no rows on any PostgreSQL
this release supports, so it is one catalog change however many accounts there
are, and on a cluster Citus carries it to the shards with no gate of its own.
Every account you already have arrives marked active, which is right: the column
records which accounts somebody chose to keep using on a limited plan, and
nobody has been asked yet. Nothing is frozen on a deployment that sells nothing,
whatever the column says.

`0025_subscription_cancel_at.sql` adds one column to `billing_subscription`, the
day a cancellation lands on, beside the flag saying it lands at the period end.
The two answer different questions and neither implies the other: a cancellation
set in Stripe's dashboard for a day past the current period is reported with
that flag false, so reading the flag alone made such a cancellation invisible
and the plan buttons went on offering changes that would have destroyed it. The
column is nullable with no default, which is metadata-only on any PostgreSQL —
no row is rewritten however many subscriptions you have — and
`billing_subscription` is a reference table by `0023`, which Citus carries
`ADD COLUMN` to on every node, so it needs no gate of its own. On a deployment
that has never set a Stripe key the table is empty and this is a catalog change
to nothing. It is its own file rather than a column folded into the
still-unreleased `0022`, for a reason worth knowing if you ever run a
pre-release build: the migrator compares only the recorded timestamp against the
folder's and never the file's hash, so a database that has already run `0022`
would record a regenerated one as done, migrate clean, and then fail at the
first billing read.

### What you must do by hand

Nothing is required. A deployment that sets none of the new variables sells
nothing, limits nobody, shows no advertising, and opens no connection to Stripe
— which is what an untouched `.env` keeps doing.

**Nothing in this release requires PostgreSQL 18**, including
`deploy/compose/compose.distributed.yml`, the one recipe that ships a `postgres`
service. It still runs 0.1.6's `postgres:16-alpine` on the volume it already
has, because a release upgrades cleanly from the one before it and a PostgreSQL
container cannot read the previous major version's data directory. Moving that
default would have met an operator pulling this release with a database that
refuses to start, behind `restart: unless-stopped` and the health gate the
server and the scheduler wait on. 18 is an opt-in below instead, and becomes the
default in a later release once the deprecation has been in the field.

#### Moving the bundled database to PostgreSQL 18

Optional, and worth doing: 18 is what the `ha` profile runs, so a dump restores
between profiles, and its image is Debian rather than Alpine. Alpine is musl,
whose `strcoll` compares text byte by byte whatever collation is declared, so
every category and payee list comes back with capitals first and accents at the
end — `deploy/compose/single/compose.yml` carries the measurement.

It is two settings in `deploy/compose/.env`, and they travel together:

```sh
POSTGRES_IMAGE=postgres:18
POSTGRES_DATA_MOUNT=/var/lib/postgresql
```

The second is needed because 18's image moved `PGDATA` into a versioned
subdirectory, so the volume is mounted at the parent. Setting only the first
leaves the container looping on `mkdir: cannot create directory
'/var/lib/postgresql': Permission denied` — the Alpine data directory belongs to
uid 70 and Debian's `postgres` is 999, so the entrypoint never reaches its own
explanatory check. Setting only the second is quieter and worse: 16 initialises
a second, empty cluster in a subdirectory of the volume, beside data it then
never reads. Set both, and take the dump first either way.

None of this applies to the single container, to the `single` profile, or to
anyone pointing `DATABASE_URL` at a database they run themselves: those connect
to whatever you already have, and the floor is still PostgreSQL 15.

Dump, recreate, restore:

```sh
cd deploy/compose
# Every command below is about this one file, and the directory holds more
# than one, so it is named once here rather than on every line. Without it the
# first command fails with "no configuration file provided" — after the shell
# has already created an empty simple-balance-16.dump.
export COMPOSE_FILE=compose.distributed.yml
# 1. With the database still on 16, take a dump. `-T` matters: without it
#    compose allocates a TTY and the dump arrives corrupted.
docker compose exec -T postgres \
  pg_dump -U simple_balance -Fc simple_balance > simple-balance-16.dump

# 2. Check the dump BEFORE destroying anything. A failed pg_dump still leaves a
#    file behind, and the next step is irreversible. This lists the objects in
#    the archive and exits non-zero if it cannot read it.
pg_restore --list simple-balance-16.dump > /dev/null && \
  echo "dump OK: $(wc -c < simple-balance-16.dump) bytes"
#    No pg_restore on the host? Ask the new image instead:
#    docker run --rm -i postgres:18 pg_restore --list < simple-balance-16.dump >/dev/null

# 3. Stop everything and discard the old data directory. `postgres-data` is the
#    only volume this file declares, so -v takes that and nothing else. Do not
#    run this until step 2 printed OK.
docker compose down -v

# 4. Set BOTH lines above in .env, then bring up an empty PostgreSQL 18.
docker compose up -d postgres
#    `-h 127.0.0.1` matters here as much as `-T` did above: the entrypoint runs a
#    temporary server while it initializes, and that one answers on the unix
#    socket alone. Without it this loop finishes against a server about to be
#    replaced, and the restore below meets `the database system is shutting down`.
until docker compose exec -T postgres \
  pg_isready -h 127.0.0.1 -U simple_balance -d simple_balance
do sleep 1; done

# 5. Restore.
docker compose exec -T postgres \
  pg_restore -U simple_balance -d simple_balance --clean --if-exists \
  < simple-balance-16.dump

# 6. Bring the rest up. `--build` is what replaces the images a previous
#    release built here; without it they are reused and nothing says so.
#    Migrations run at startup as they always do. (If you swapped in the
#    commented `image:` lines instead, move their tags to this release.)
docker compose up -d --build
```

Keep the dump until you have signed in and seen your balances. `docs/upgrades.md`
§Rolling back applies unchanged: going back means restoring that dump into a
PostgreSQL 16 container, because 16 cannot read an 18 data directory either —
which is also what unsetting the two lines above needs.

**`pg_dump` rather than `pg_upgrade --link`**, and the reason is collation.
`postgres:16-alpine` is musl and `postgres:18` is glibc; the two do not sort
text the same way, and this product compares normalized category and payee names
with the database's collation. `pg_upgrade` carries indexes across as bytes, so
a `--link` upgrade would leave every text index sorted under the old library and
a uniqueness check quietly reading the wrong page. A dump and restore rebuilds
them under the collation the new server actually has.

**One thing is worth doing, if you run the split containers behind anything
that terminates TLS**, which under Kubernetes is always. Set
`SB_TRUSTED_PROXY_CIDR` on the frontend — `frontend.trustedProxyCidr` in the
chart — to the range that terminator connects from, or to several, separated by
commas or spaces, when more than one proxy connects.

Without it the frontend tells the API that every request came from the
terminator, so with `TRUST_PROXY` on, every sign-in attempt in the deployment
counts against one allowance and four wrong passwords from anywhere lock out
everybody else. That has been true since 0.1.0; what is new is that it can now
be fixed with a setting instead of by editing the nginx template and rebuilding
the image. The chart prints a warning while it is unset and `config.trustProxy`
is on.

Name the terminator's range and nothing wider. This decides whose word is taken
for a visitor's address, so a range that includes callers lets a caller choose
their own. Leave `SB_REAL_IP_RECURSIVE` — `frontend.realIpRecursive` — off
unless every proxy in front appends to `X-Forwarded-For` and is in the list.
`docs/deployment-profiles.md` has the reasoning and the measurement.

**If you run the `aws` Pulumi program, take the next `pulumi up` at a quiet
hour.** It changes the ingress-nginx release in three ways at once, because
each end of the hop fails without the other: the controller's Service gains
`service.beta.kubernetes.io/aws-load-balancer-proxy-protocol: "*"`, which is
proxy protocol v2 on every target group; ingress-nginx's configuration gains
`use-proxy-protocol: "true"` and `proxy-real-ip-cidr` naming the three public
subnets, `10.0.0.0/24,10.0.1.0/24,10.0.2.0/24`; and the load balancer's health
check moves from port 10254 to 80, still HTTP on `/healthz`, because AWS sends
the header on health checks too and the controller's own server on 10254
cannot read it. nginx expecting the header refuses a connection that has none,
nginx not expecting it answers the header with a `400`, and the target groups'
change and ingress-nginx's reload do not land at the same instant — hence the
interruption above. Take a dump first, as before any upgrade.

What it buys is the visitor's own address at ingress-nginx, which it then puts
in `X-Forwarded-For` in place of whatever the visitor sent. It believes a proxy
protocol header only from the public subnets, where the load balancer's nodes
take their addresses, so a pod that sends one is counted as itself. The
frontend's default trust becomes the VPC's range, `10.0.0.0/16`, with recursion
off, because ingress-nginx's pods take their addresses there. A
`simple-balance:trustedProxyCidr` of your own is kept, with recursion off, and
replaces that default. If you set it to the load balancer's public subnets as a
way around the shared allowance, unset it: the frontend's peer is now an
ingress-nginx pod in the private subnets, and that value brings the shared
allowance back.

**If you run the `gcp` Pulumi program**, the next `pulumi up` moves no load
balancer. The frontend's Service gains
`cloud.google.com/neg: '{"ingress": true}'`, which GKE already applies on the
cluster the program builds, so no backend changes; it is written down because
what the frontend trusts depends on it. The frontend's default trust becomes
`130.211.0.0/22`, `35.191.0.0/16` and the Ingress's reserved address, with
recursion on, because Google's load balancer appends its own address after the
visitor's and only a walk past it reaches the visitor. A
`simple-balance:trustedProxyCidr` of your own is kept, with recursion off, and
on this load balancer that still takes its address for everybody: unset it, or
set `simple-balance:realIpRecursive=true` with a list that keeps those three.

**On either cloud, the frontend's half waits for the image.** Both programs
deploy the release image their checkout pins, which is 0.1.6 until 0.2.0 is
released, and that frontend reads neither setting. On AWS the ingress half
takes effect at the next `pulumi up`, but the 0.1.6 frontend still reports
ingress-nginx's pod to the API, so the allowance stays shared until the image
is 0.2.0 or later; on GCP nothing about the frontend changes until then.
`deploy/pulumi/README.md` §Things that will surprise you has what is still
open, including the pods inside the cluster that only the chart's
`NetworkPolicy` shuts out.

**And two more things the `aws` program's next `pulumi up` does to an existing
cluster, neither of which stops it serving.** Both are about the Secrets holding
your `DATABASE_URL`, `AUTH_SECRET` and any Stripe key, and about whether a
`NetworkPolicy` is enforced at all:

- **Envelope encryption of Secrets in etcd is turned on, and it cannot be turned
  off again.** The program creates a KMS key and sets `encryptionConfigKeyArn`.
  EKS applies that to a running cluster in place — no node moves, no pod
  restarts — but it has no operation to remove it afterward. If that is not
  something you want on this cluster, take it out of `aws/index.ts` before the
  `up`, because there is no undoing it after.
- **The VPC CNI stops being the default managed add-on** so the program can turn
  its network policy agent on, which is what makes a `NetworkPolicy` mean
  anything on EKS. The `aws-node` DaemonSet is adopted and rolled once: pods keep
  running, and address assignment pauses per node while each one restarts.

**If you run the `gcp` program, nothing changes until you ask for an in-cluster
database.** `datapathProvider: ADVANCED_DATAPATH` is set only with
`simple-balance:database: in-cluster`, and the provider treats it as a property
that **replaces the cluster** — so an existing stack that switches will see a
replacement in `pulumi preview`. Do not take it. Run
`gcloud container clusters update <name> --enable-dataplane-v2` first, wait for
it, and then set the stack setting: the plan is a no-op after that.

**Moving an existing chart deployment onto the in-cluster database is a dump and
a restore, not a setting.** `simple-balance:database: in-cluster` and
`database.enabled` build a new, empty Citus cluster; nothing copies your data
into it. And the copying is not a plain `pg_dump` restore either, because `0023`
widens fourteen primary keys on the way in —
`docs/citus-runbook.md` §Moving an existing database onto a cluster is the
procedure, and **the dump has to be taken before the keys are widened**, because
every dump after that carries the widened schema. If you have no reason to move,
do not: `database: external` is the default and is exactly what you have now.

**Two deployment profiles exist, and neither is anything you have to do.**
`single` is two machines — the application container and Caddy on one, a
PostgreSQL 18 container on a second with no public address — stood up by one
`pulumi up` from `deploy/pulumi/aws-single/` or `oci-single/`, out of
`deploy/compose/single/` and `deploy/systemd/`. `ha` is a Kubernetes cluster
(`deploy/helm/simple-balance/`), and it has two shapes: one node per service and
fully redundant, which differ by a values file rather than by a migration. Both
are new shapes rather than changes to yours: **the chart's `database.enabled`
stays `false`**, so a values file written for 0.1.6 renders exactly what it
rendered before — no Citus cluster appears underneath anybody, and no pod
template churns. Verified by rendering 0.1.6's own values against both the old
chart and this one and diffing: byte-identical, in both the
`secret.databaseUrl` shape and the `secret.create: false` + `existingSecret`
shape the Pulumi programs use. `docs/deployment-profiles.md` compares the two
and says plainly that `single` is still the one to pick unless you have a
reason.

**`helm uninstall` cleans up after Patroni, and that is worth knowing before
you rely on either behaviour.** Patroni keeps its cluster state in Kubernetes
objects it creates at runtime rather than in anything the chart ships, and Helm
deletes only what it created — so without help, `helm uninstall` followed by
`helm install` under the same release name left the database permanently unable
to start: the surviving state told the new pods a cluster already existed and to
wait for a leader that could never be elected, every pod logging
`waiting for leader to bootstrap` every ten seconds, `Running` and `0/1`, with
nothing crashing or reporting an error. **Deleting the PersistentVolumeClaims is
not the fix and is exactly what causes it**; deleting the namespace was the only
recovery. The chart now runs a Job on uninstall that removes those objects for
that release and no other, so a reinstall bootstraps cleanly. Nothing about this
reaches a 0.1.6 deployment — the `ha` profile is new in this release and the
chart's `database.enabled` stays `false` — but two things are worth knowing
before you use it:

- **It changes reinstall-over-intact-claims.** That was a normal restart and
  still is, except that the cleanup removes the config object too, so the
  dynamic configuration is rebuilt from the chart's `bootstrap.dcs` and anything
  applied with `patronictl edit-config` is reverted.
  `database.patroniCleanup.enabled: false` keeps the old behaviour, and then the
  deadlock above is yours to avoid. Turning that flag off is the right switch;
  `helm uninstall --no-hooks` is not, because it disables every hook the chart
  has.
- **A hook that cannot run — no permissions, image unavailable — does not
  strand the release.** It is a `post-delete` hook, whose failure Helm collects
  rather than returns, so the uninstall completes, the history is purged, and
  the command exits non-zero. What is left is the four endpoints: the old
  behaviour, with the old recovery.
- **It can still fail a `pulumi destroy`, and that one needs a `pulumi state
  delete`.** The uninstall completes, but Helm's exit is non-zero and
  `k8s.helm.v3.Release` returns it, so the destroy stops with the Release in
  state and the release gone from the cluster. A second `destroy` cannot fix it
  — the history was purged, so Helm answers `release: not found` — and
  `pulumi state delete` on that one URN followed by `pulumi destroy` does.
  Tearing down a whole cluster, set `database.patroniCleanup.enabled: false`
  first instead: the endpoints go with the namespace, so the hook has nothing to
  do. `docs/citus-runbook.md` has the commands.

`docs/citus-runbook.md` §Uninstalling, and the state that used to outlive it has
the procedure and the reasoning, including why this could not be the
`pre-delete` hook it obviously wants to be.

**There was a third, `vps`, on this release's branch, and it is gone.** It was a
machine per service with the database among them, in `deploy/compose/vps/`. It
never shipped — 0.1.6 carried none of those files — so this breaks nobody, and
what it was for is now the `ha` profile's one-node-per-service shape: the same
chart at one replica, which grows into the redundant shape by changing a values
file rather than by moving the data. Its PostgreSQL recipe was not thrown away:
it is `deploy/compose/single/compose.postgres.yml`, the `single` profile's
database machine, with TLS added and the application no longer connecting as the
superuser.

**If you built a `single` stack from this release's branch before it was cut,
the things below changed under it.** None of this touches a 0.1.6 deployment,
because none of these programs or files was in 0.1.6.

**The `single` profile grew a second machine, and it is on by default.** A stack
built from an earlier state of this branch has one machine and a `DATABASE_URL`
you wrote in `env.local`. Its next `pulumi up` will build a database node, a
private subnet, a NAT gateway, a second data volume and a certificate — and on
AWS the NAT gateway is $36.50 a month, its hours plus the Elastic IP it holds. The application node keeps using
your `env.local` either way, because `simple-balance-env` folds `env.db` before
`env.local` and the last assignment wins, so you would be paying for a database
nothing connects to. Decide before the `up`:

- **Keep bringing your own:** `pulumi config set simple-balance:databaseNode false`
  first, and the plan is what it was.
- **Move onto the database node:** let it build, take a dump from your old
  database, restore it into the new one, and then delete the `DATABASE_URL` line
  from `/var/lib/simple-balance/env.local` so the generated one in `env.db`
  takes effect, followed by `sudo systemctl restart simple-balance`.
  `deploy/compose/single/README.md` has the restore command.

**The `single` machines' settings moved out of `env.local` and into the stack.**
SMTP, Stripe, AdSense, the legal pages and a `DATABASE_URL` of your own are now
`simple-balance:env` and `simple-balance:secrets` in the stack, and the program
writes them into the cloud's own secret store — OCI Vault for `oci-single`,
AWS Secrets Manager for `aws-single` — and lets the application machine, alone,
read them. The machine fetches them before every start and checks every five
minutes, so `pulumi up` changes a setting. `deploy/pulumi/README.md`, "The
application's settings", has both ways to set them, one at a time or from a
`.env` file with `deploy/pulumi/settings-from-env.mjs`.

A machine built before this still runs the scripts it was built with, which read
`env.local` and know nothing of the store: cloud-init runs once, and a second
`pulumi up` does not reach it. The `up` creates the vault or the Secrets Manager
secret, its key and the grant, and changes nothing on the machine. To move
over:

1. Copy every setting in `/var/lib/simple-balance/env.local` into the stack —
   `node deploy/pulumi/settings-from-env.mjs deploy/pulumi/<program> env.local`
   on a copy of the file does it, and leaves `DATABASE_URL` for you to set
   deliberately with `--secret` if you keep your own database.
2. `pulumi up`.
3. Take a backup, then replace the application instance, which keeps its data
   volume — `pulumi up --replace <the instance's URN>`, the URN from
   `pulumi stack --show-urns`. The new machine fetches every setting at its
   first start.
4. Once it is running, delete `/var/lib/simple-balance/env.local`. The new fold
   does not read it and says so on every start until it is gone.

`simple-balance:databaseSubnet`, which some branch READMEs described, is
accepted and superseded: it logs a line naming `databaseNode` and carries on.
It is never refused.

**`oci-single` now requires `oci:region` in the stack.** Its next
`pulumi preview` or `pulumi up` stops before anything is declared, and changes
nothing, until the stack sets it, with a message that says so. Set it to the
region the stack is already in: the region of the `~/.oci/config` profile it
was built with, unless `TF_VAR_region` or `OCI_REGION` was set in that shell,
and the instance's OCID (`pulumi stack output instanceId`,
`ocid1.instance.oc1.<region>…`) names it. Adding the key replaces nothing.
Never set a different region: the provider would then look for the stack's
resources where they are not. This is the one place in the release where a
configuration that ran before is refused, and it does not break the rule that
a release starts on the configuration the previous one accepted, because no
release accepted it — `oci-single` is new here. It is also the refusal that
prevents the harm: left to fall back to the shell's region, a stack run from
another machine would build, or look, somewhere else.

**The same `pulumi up` protects its data volume.** It shows `[diff: ~protect]`
with every resource unchanged, makes no call to OCI beyond one more read
(`ListVolumes`, which the README's `manage volume-family` policy already
grants), and adds the outputs `region` and `dataVolumeId`. From then on
`pulumi destroy` fails at its preview and deletes nothing, so anything scripted
as `pulumi destroy --yes` now exits 1; a new `availabilityDomain` is refused
before the machine or the volume is touched, with or without a preview; and a
resize goes through as before. `pulumi destroy --exclude-protected` and
`--skip-preview` delete only the volume's attachment and leave the machine
running without its disk, so neither is a way to tear down.
`deploy/pulumi/README.md` §Tearing down on Oracle Cloud is the way, and
`simple-balance:protectDataVolume=false` the setting. A stack that already took
a `pulumi up --skip-preview` to a new domain under the earlier program has its
machine in the new domain and its volume in the old one, and the new program
refuses to go further: set `availabilityDomain` back to the volume's domain and
run `pulumi up`, which relaunches the machine there and reattaches the volume,
and on Always Free may meet `Out of host capacity` first.

**`aws-single` now requires `aws:region` in the stack, and protects its data
volume the same way.** Its next `pulumi preview` or `pulumi up` stops before
anything is declared, and changes nothing, until the stack sets it. Set it to
the region the stack was built in, which `pulumi stack output shell` names after
`--region`: whether that came from `aws:region` or from the shell's
`AWS_REGION`, the provider recorded it, and the same region set in the stack
changes nothing — run against the provider on a stand-in of this program, every
resource came back unchanged. Never set another: version 7 of the provider
records a region on every resource, so a different one plans to replace all of
them in that region, the data volume included, which is also what running the
earlier program from a shell pointed elsewhere planned. That `up` marks the
EBS data volume with `protect`, which changes no resource, and adds the outputs
`region` and `dataVolumeId`. From then on `pulumi destroy` fails at its preview
and deletes nothing, so anything scripted as `pulumi destroy --yes` now exits 1;
a new `aws:region` is refused at the volume; a resize and a replaced machine go
through as before. `pulumi destroy --exclude-protected` and `--skip-preview`
keep the volume and the VPC and subnet it was built in, and delete everything
else, the Elastic IP included, so the next `pulumi up` comes back on a new
address. `deploy/pulumi/README.md` §Tearing down on AWS is the way, and
`simple-balance:protectDataVolume=false` the setting. Refusing a stack whose
region came from the shell alone is the same narrowing as `oci-single`'s, and
acceptable for the same reason: no release carried `aws-single`.

**A `single` machine can now verify its database.** A `DATABASE_URL` of
`?sslmode=verify-full&sslrootcert=/var/lib/simple-balance/tls/db-ca.pem` is
checked by the application, the nightly backup and the restore alike, where
before the backup could not use `verify-full` at all. A machine built before the
`compose.db-tls.yml` overlay existed needs it by hand, since a second
`pulumi up` does not reconfigure a machine: install the current
`simple-balance-backup` and `simple-balance-restore` in `/usr/local/bin` (0755)
and `simple-balance-firstboot` in `/usr/local/sbin` (0700) from
`deploy/systemd/` — the current firstboot also waits up to forty minutes for
the data volume, as long as the providers give Pulumi to attach it, where the
earlier one gave up after two — copy `deploy/compose/single/compose.db-tls.yml` to
`/opt/simple-balance` (0644), change `COMPOSE_FILE` in
`/etc/default/simple-balance` to
`compose.yml:compose.caddy.yml:compose.db-tls.yml`, run
`sudo install -d -m 0755 /var/lib/simple-balance/tls`, install the CA
certificate there as `db-ca.pem` (0644), change `DATABASE_URL` where that
machine keeps it — `/var/lib/simple-balance/env.local` on a machine that
predates the settings moving into the stack, `simple-balance:secrets` and a
`pulumi up` on one that does not — then
`sudo systemctl restart simple-balance` and
`sudo systemctl start simple-balance-backup.service` to see a verified dump. A
hand install does the same with its own copies. `sslmode=no-verify` goes on
working exactly as it did, so none of this is required.

**The backup and the restore refuse `sslmode=verify-ca` with no `sslrootcert`**,
with exit status 2 and before any client runs, because libpq would then take a
certificate any public CA issued, for any host, as the database's. They never
worked with it — libpq looked for a root file the client image does not have —
so no backup that runs today stops. The application still accepts that URL and
reads it as `verify-full`; writing `verify-full` means the same to both.

**The sizing table now sizes the two machines apart, and on an existing branch
stack the next `pulumi up` acts on it.** A row used to carry one machine shape
and one data-disk figure, read twice; it now carries an application half and a
database half. What that does to a stack depends on the row:

- **`small` on Oracle Cloud: nothing.** Both data disks are under OCI's 50 GB
  floor before and after, so the tenancy sees the same four 50 GB volumes. The
  machines are unchanged.
- **`small` on AWS:** the database node's data disk goes from 20 to 30 GiB. The
  machines are unchanged.
- **`medium` and `large`:** the **application** node comes down to a smaller
  machine — `m7g.xlarge` to `t4g.medium` at `medium`, `m7g.2xlarge` to
  `t4g.large` at `large` — because `docs/capacity.md` measured it using half a
  core and 745 MiB and the cores it was buying do nothing for a machine that
  stores no ledger. That is a resize, which both clouds make in place and which
  restarts the machine, so take it at a quiet moment. The database node's
  machine does not change. Both data disks grow.

**No disk gets smaller, and that is a rule the table is now held to**, because
AWS refuses to shrink a volume and OCI would replace one. Where the arithmetic
asked for less than a row already gave, the row keeps what it had.

**A disk that grows needs a reboot, or one command.** Both clouds enlarge the
block device in place, and first boot formats a device only when it is not
already a filesystem — so after an `up` that grew a disk the extra space is a
number in a console until the filesystem on it is grown too.

A machine built from this release does it itself: `simple-balance-growfs.service`
runs at every boot, after the data volume is mounted, and `resize2fs` on a
filesystem that already fills its device prints `Nothing to do!` and exits 0. So
rebooting the machine is enough.

**A machine built before this release has no such unit**, because cloud-init
runs once per instance and a `pulumi up` that grows a volume replaces no
machine. There, and any time you would rather not reboot, run on the machine:

```sh
sudo resize2fs "$(findmnt -no SOURCE /var/lib/simple-balance)"
df -h /var/lib/simple-balance
```

That is the same command the unit runs, and it is online — nothing has to be
stopped. It asks the mount which device it is on rather than naming one, which
is what makes it right on both clouds: neither data volume carries a partition
table (first boot runs `mkfs.ext4` on the whole device), the AWS device is a
`/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_…` symlink and the OCI one is
`/dev/oracleoci/oraclevdb`, and `lsblk` distinguishes neither from the root disk.
`growpart` has no partition to grow here and fails; reach for it only on a
volume somebody partitioned by hand, and then against that partition.

On the database node the mount point is the same path. Nothing breaks without
any of this; the disk simply stays the size it was, which matters most on the
database node, where a full `PGDATA` is a cluster that will not restart.

**`simple-balance:databaseEgress` is new, defaults to `nat`, and unset plans
nothing.** It is AWS-only and it exists for the NAT gateway, which is $36.50 a
month in a US region — more elsewhere — and 38% of a `small` bill. There are two
ways off it and they are not equivalent.

`ssm` is **$14.60 a month in us-east-1 or us-west-2**, and it gives up no shell:
`pulumi stack output databaseShell` is the same command doing the same thing. It
builds an egress-only internet gateway, which carries Ubuntu's archive and the
image registry for nothing, plus `com.amazonaws.<region>.ssm` and
`…ssmmessages` interface endpoints, which carry Session Manager. Both halves are
one setting on purpose: interface endpoints reach AWS services, and neither
Ubuntu's archive nor Docker Hub is one, so endpoints alone would build a machine
that boots, answers its shell, and never installs Docker or pulls `postgres:18`.
It needs no SSH key, which also means it avoids the rebuild described below.
Both hours are regional and the gateway's moves further than the endpoint's, so
the saving grows outside the US rather than shrinking: $16.06 against $38.69 in
eu-west-1, $18.98 against $46.72 in ap-southeast-2, and $30.66 against $71.54 in
sa-east-1 — $40.88 a month, the largest saving this setting offers anywhere.
The US $21.90 is the smallest of any commercial region, so wherever you are the
saving is at least that. `docs/deployment-costs.md` has both columns region by
region.

`ipv6` is that gateway alone, at no charge — and takes Session Manager away from
the database node, because there is then no IPv4 route out and
`ssm.<region>.amazonaws.com` publishes no IPv6 address. It therefore requires
`simple-balance:sshPublicKey` and is refused without one, and reaches the
machine by SSH from the application node instead. Decide it deliberately: it is
the only shell onto the machine holding the ledger.

**Setting `ipv6` on a stack whose machines already exist may rebuild both of
them**, and that is the half the setting's name does not warn about. `ssm` does
not have this problem, because it needs no key. If
`simple-balance:sshPublicKey` was not already set — it is optional on AWS —
then setting it is what gives both instances a `keyName`, and EC2 has no API to
give a running instance a key pair, so both plan a replacement and the database
node is deleted before its replacement is made. The data volumes are separate
protected resources and firstboot reformats nothing it finds a filesystem on, so
the ledger survives; the outage does not. Set the key on its own, run
`pulumi up`, and set `databaseEgress` afterwards. With a key already in the stack
this changes routes, a security group and one address, and replaces nothing.

**On a stack that already exists, read the plan before you accept it, under
either value.** Both `ssm` and `ipv6` give the database node an IPv6 address,
and whether the provider treats that as a modification or as a replacement is
the provider's decision rather than this program's. If the plan says `replace`
on the database instance, the data volume is a separate protected resource and
first boot reformats nothing it finds a filesystem on — so the ledger survives
and the downtime does not. On a stack that has not been created yet, none of
this arises.

**Customer-managed keys are new, optional, and on AWS you cannot add one to a
stack that already exists.** Unset, every volume is encrypted exactly as it was,
with the provider's key. `simple-balance:kmsKeyArn` on AWS and
`simple-balance:kmsVaultOcid` with `simple-balance:kmsKeyOcid` on Oracle Cloud
name one of yours.

- **A volume's key is fixed when the volume is created.** On AWS, setting
  `kmsKeyArn` on a stack that exists plans to *replace* both data volumes — a
  new empty volume and the old one deleted, which on the database node is the
  ledger — and both boot volumes with them, which replaces both machines. So
  **`kmsKeyArn` is refused unless `simple-balance:kmsKeyArnIsNewStack` is
  `true`**, which is your statement that this `up` changes no volume's key —
  they do not exist yet, or they were already created with this key, so a branch
  stack already built with one sets it and plans nothing. The refusal arrives
  before anything is declared and carries the migration in its message. The guard is that setting rather than `protectDataVolume`
  because `protect` is a flag in the state snapshot while `protectDataVolume` is
  a flag in config, and both `protectDataVolume: false` *and*
  `pulumi state unprotect` — this document's own teardown uses one or the other
  — clear it in the state while the config still reads `true`. Set the key
  before the first `up`, or migrate by snapshot copy: stop the compose stack,
  snapshot the data volume, copy the snapshot under the new key, create a volume
  from the copy, swap it in, and bring the stack's state back into line.
- **The key's policy has to allow it, and no check can see that.** On AWS the
  principal running `pulumi up` needs `kms:GenerateDataKeyWithoutPlaintext`,
  `kms:CreateGrant` with `kms:GrantIsForAWSResource`, `kms:Decrypt` and
  `kms:DescribeKey` on that key. The default policy `aws kms create-key` writes
  with no `--policy` already has them; a hand-written one may not, and then the
  volume is created and deleted moments later with nothing but an empty state
  entry to show for it.
- **On Oracle Cloud it is an in-place update** on a block volume — the data key
  is re-wrapped and the contents are untouched — so it can be added later, and
  it reaches **all four** volumes rather than only the two data ones. Both
  instances name individual properties in `ignoreChanges`
  (`sourceDetails.sourceId`, `sourceDetails.bootVolumeSizeInGbs`, `metadata`)
  precisely so a key added later is not swallowed with the parent, so there is
  no `oci bv boot-volume-kms-key update` step to run. Preview it against your
  tenancy first; it is the one behaviour here worth seeing before you rely on
  it.
- **A key you disable or schedule for deletion locks you out of your own
  ledger.** On AWS it does so silently: nothing fails while the volume stays
  attached, and the failure lands at the next detach — a stop, a resize, a
  replacement — possibly weeks later and possibly after the recovery window has
  closed, at which point the data is gone for good. Set a CloudWatch alarm on
  use of a key pending deletion on the day you set `kmsKeyArn`; nothing else
  will warn you. On Oracle Cloud it fails immediately, which is kinder, and the
  way out is to **cancel the deletion first and only then unassign the key**,
  because a key in pending deletion cannot be unassigned from anything.
  `docs/deployment-profiles.md` §Encryption is the whole of it.

### What changed under you

The bundled PostgreSQL in `deploy/compose/compose.distributed.yml` moved from 16
to 18, which is one of the two changes in this release that an operator cannot
ignore; the other is the `aws` Pulumi program's proxy protocol, above, and
everything else here is opt-in. `docs/deployment-profiles.md` has the reasoning,
and the short version is that where a deployment owns its database it runs the
newest version the `ha` cluster can also run.

Otherwise no setting changes meaning unless you opt in. `SB_TRUSTED_PROXY_CIDR`
defaults to `127.0.0.1`, which is the off position rather than a trusted range —
nothing reaches the container from loopback — so a deployment that sets nothing
behaves exactly as it did before the setting existed, and one address or CIDR
renders exactly the configuration it did before a list was accepted.
`SB_REAL_IP_RECURSIVE` defaults to off, the only behavior the image ever had,
and the chart's `frontend.realIpRecursive` to false; the two compose recipes
with a frontend pass it through from the same `.env` as
`SB_TRUSTED_PROXY_CIDR`, off when it is not set. The frontend refuses to
start on a trusted entry that is not an address, a CIDR or `unix:`, and on a
recursion value other than on, off, true or false; no release before this one
had either setting, so that narrows nothing that was accepted. The chart now
takes `frontend.trustedProxyCidr` as a YAML list as well as a string, and
`--set frontend.trustedProxyCidr=null` renders the off position where it
rendered an empty value and a pod that never started. The one default that
moves is the Pulumi programs': `simple-balance:trustedProxyCidr` left unset now
means the list each program works out for the network it built, above, rather
than the chart's `127.0.0.1`. Three new settings groups
exist and all three default to absent. Two are the five `STRIPE_*` settings with
`SB_BILLING_ENABLED` and the `ADSENSE_*` settings, and `docs/monetization.md` has
the table of what each combination turns on. The third is `PRIVACY_POLICY_URL`
with `TERMS_OF_USE_URL`, the addresses of your own privacy policy and terms of
use: each is linked from the sign-in screen and every page once it is set, and
refused at startup unless it is absolute and https. Two names join the seven that
already take a `_FILE` form, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`,
taking that list to nine.

**Some sentences an agent reads changed, and nothing it sends or receives
did.** A handful of tool descriptions now say "every two weeks", "Monday through
Friday", "at once" and "one-time" where they used British wording, and
`set_active_accounts` is new and annotated destructive, so a client may ask the
person before it runs. A refusal naming a frozen account now carries a second
sentence written for an agent, which names `whoami` for the plan and its
ceiling, `list_accounts` for which accounts are frozen, and the person as the
one who can lift a limit, and the server's instructions say once, to every
connection, that a frozen account refuses every write. Nothing an agent sends
changes, and that refusal's code and status are unchanged. No tool, argument,
field or stored value was renamed or removed. A prompt or a test of your own
that quotes a description word for word is the one thing that notices. One more
moved late: `budget-report`'s `includeArchived` said "an account you have since
closed" and now says "since archived", which is the word the rest of the product
uses for an account that has been put away.

**One field is new on the plan and billing response, and nothing else about it
moved.** `GET /api/v1/billing` now carries `advertises`, a boolean saying
whether this deployment serves advertising at all — read from the configuration
rather than from the reader's plan, so it answers the same before and after
somebody subscribes. The tab uses it to say that the paid plan takes the ads
away, which is half of what the paid plan does and was said nowhere on that
screen. It is additive: a client that has never heard of it is unaffected, no
field was renamed or removed, and the route's scope and status codes are
unchanged. A deployment with no `ADSENSE_CLIENT_ID` sends `false` and the tab
says nothing about ads.

**The same screen stopped saying "up to 3 accounts" and now says "up to 3
accounts in use at once".** The short phrasing is the limit this product stopped
enforcing when freezing arrived two releases ago, and the marketing site had
already been corrected. Nothing about the limit itself changed.

**What this product says it is changed on every surface that says it**, which
matters to you only if you publish something downstream of `docs/product/`. The
feature list is reordered so that being able to follow a figure back leads, and
the three places that said bank statements "file themselves" — the README, the
page description and the sign-in screen — now describe the file you downloaded,
because there is no bank connection and there never was. No setting, route,
tool or stored value is involved.

**If you run your own copy of a compose file, take this release's.** Every
compose shape now passes `DIRECT_DATABASE_URL` through to the application, which
the split recipe never did — so a pooled deployment that set it got no bypass
and no word about it — and passes the new `PRIVACY_POLICY_URL`, without which a
deployment that turns AdSense on refuses to start. An older copy drops both in
silence.

**The split deployment has five new frontend settings.** nginx serves the
application shell in that shape, so it — not the API — decides the headers each
page arrives with. Two of them are the ones easiest to miss, because no
`.env.example` carries them: `SB_BILLING_CONFIGURED` and `SB_ADS_CONFIGURED`
default to false, which is exactly today's behavior. Set Stripe on the server
without the first and the plan tab opens with no card fields; set AdSense
without the second and no ad renders. The compose recipe derives both from
settings you are already providing, and so does the Helm chart:
`SB_BILLING_CONFIGURED` is on when `config.extraEnv` carries a non-blank
`STRIPE_PUBLISHABLE_KEY` or `frontend.billingConfigured` is true, and
`SB_ADS_CONFIGURED` the same way from `ADSENSE_CLIENT_ID` and
`frontend.adsConfigured`. Set a switch by hand only where its key lives in an
`existingSecret`, which the render never sees. Only a hand-assembled deployment
has to set both itself. The other three are `SB_TRUSTED_PROXY_CIDR` and
`SB_REAL_IP_RECURSIVE`, above, and `SB_CSP_REPORT_ONLY`, the plan tab's
rehearsal, which the frontend needs as well as the server. `docs/deployment.md`
lists every frontend setting.

**Building the frontend image yourself now needs BuildKit**, for the
`COPY --chmod` that makes the script checking the trusted-proxy settings
executable. It is Docker's builder by default since 23.0 and what `buildx` and
Compose use, and the published images are built with it, so only a build forced
onto the legacy builder notices: it stops with `the --chmod option requires
BuildKit`.

**The auth library's log lines look different, and carry no address.** Better
Auth's lines arrived as `<timestamp> INFO [Better Auth]: <message>`, written by
the library itself; they now come through this product's logger as
`[Better Auth] <message>`, at whatever `LOG_LEVEL` allows, with every email
address in them replaced by `[email address]`. At `info` the library used to log
the address of every sign-up that named an account already here. A log alert or
filter that matches the old prefix is the one thing that notices.

An unexpected failure inside an auth route changes with it. It was written to
the console as `# SERVER_ERROR:` and the whole error, and answered with an empty
500; it is now logged as `Request failed:` and the statement that failed,
without its values, and answered with the `INTERNAL_ERROR` body every other
route sends. An alert on `# SERVER_ERROR` stops matching, and the status is 500
either way.

**The refusal a TLS database meets at startup says something else.** When
node-postgres cannot verify the server's certificate, the process still refuses
to start, and the message now leads with naming the CA's certificate —
`?sslmode=verify-full&sslrootcert=/path/to/ca.pem` — and offers
`sslmode=no-verify` only where there is no certificate to name. For an expired
certificate it says a renewal is what fixes it, and for a name the certificate
does not carry that the CA is not what failed. A log alert that matches the old
wording word for word is the one thing that notices.

**If you do turn advertising on**, know what the policy costs before you do.
AdSense publishes no list of the hosts it loads from, so every page but the plan
tab then allows scripts, frames, styles, fonts and connections to any HTTPS
origin, plus `unsafe-eval`. Those pages also send `Referrer-Policy:
strict-origin-when-cross-origin` rather than `same-origin`, because Google's
consent message does not serve under `same-origin`: another origin is told this
site's address and never a page's path. Ads are never shown to a paying account,
never on the plan and billing tab, never on sign-in and never on paper, and the
publisher id is the only identifier of yours that leaves — but the address of
the page an ad sits on goes to Google too, and this app's addresses name
records.

An ad is shown only where a plan is for sale, so AdSense without
`SB_BILLING_ENABLED=true` and Stripe widens the policy, serves `/ads.txt`, and
shows nobody an ad — the process says so at startup rather than refusing.
`PRIVACY_POLICY_URL` is required beside the AdSense ids. `docs/monetization.md`
has the checklist, in order, of what is yours to do at Google and here.

**If you do turn billing on**, `docs/billing-operations.md` is the page to read
first: setting up the Stripe account in order, going live from test mode,
granting a plan by hand, what a refund does and does not change, what
`SB_BILLING_ENABLED=false` stops and what it deliberately does not, and the
order to shut billing down in.

**Two things about the key itself, because Stripe will not always tell you.**
§Setting up Stripe step 2 builds a restricted key, `rk_…`, and its table of
permissions now includes **PaymentIntents: Write**. That one is not optional
and was not in an earlier draft of the table: paying a failed renewal from the
plan tab marks the invoice's PaymentIntent so the card that pays it becomes the
card the subscription bills, and without the grant the next renewal goes back
to the card that had already failed. And **a key is tagged for an agent when
you create it**, by answering Stripe's question about the key's intended use
with *Authorizing agent access to your account*, so a replacement key made the
same way is tagged the same way. The tag brings Stripe's default approval
rules, which cover exactly two actions — a refund created and a subscription
canceled — of which this deployment makes only the second, in one place:
abandoning an unpaid first payment when somebody asks for the other interval.
That press fails with `approval_required` rather than happening. Create the key
without that intended use, or keep it and delete the "Subscription is canceled"
rule under **Settings → Approvals → Rules**; step 2 has both. Both are also
visible after the fact, which is what answers *is the replacement key tagged
too*: a tagged key carries an **Agent** badge in the API keys list
(`docs.stripe.com/mcp`), and the rules are listed on that Approvals page, where
any of them can be deactivated or deleted at any time
(`docs.stripe.com/account/approvals`). A key belongs to one mode, so the
intended use is answered again when you make the live one; whether the rules
are per-mode Stripe does not say, so look at that page in live mode rather than
assume it either way. Stripe also sometimes answers a missing permission with
nothing more useful than "An unknown error occurred", which is why the process
now checks at startup and names any refusal as it happens;
§What to check afterwards has the lines.

**What this deployment asks Stripe for, in payment methods.** Changing a
payment method narrows the account's own list to a card — which is how Apple
Pay and Google Pay arrive — and Link, and it narrows rather than demands, so a
Stripe account with Link turned off offers a card and nothing is refused. Link
is off until it is turned on under **Wallets**, and is not offered at all in
India. Starting a subscription names no methods, so its invoices offer whatever
the Stripe account allows for invoices, narrowed to the currency. That is the
one list this deployment does not control, so keep it to cards and Link:
anything else an operator enables for invoices — a bank debit, a
buy-now-pay-later — can reach the first payment and **Pay now** untried, and a
saved method the subscription cannot be billed with is refused with a sentence
rather than charged. `docs/billing-operations.md` step 6 has it.

**Know what it does to anybody who already has more than three accounts,
because it happens the moment the process starts.** `SB_BILLING_ENABLED=true`
puts everybody without a subscription or an override on the free plan, and the
free plan keeps three accounts in use. Nobody at or under three notices
anything. Above it, nothing is archived, hidden or deleted: every account stays
listed, readable, and counted in every balance, report and export. But only three
stay usable — the three oldest, until the person makes their one-time choice on
the Accounts page, or an agent makes it with `set_active_accounts` — and the
rest are frozen. A frozen account refuses every write: a new entry, an edit, a
delete, a rename, and a payee or category merge that would touch it, which
refuses whole. A staged or imported row that names one gets an issue instead of
committing. Nothing is frozen while billing is off.

So before you set it, give everybody who should keep every account — yourself
included — an override. `docs/billing-operations.md` §Granting a plan by hand
has the statement, and `docs/monetization.md` has the whole rule, including why
the choice is made only once.

### What to check afterwards

`docs/capacity.md` is new and changes nothing about an upgrade, but it is the
answer to the question an operator asks before a big import or a second
household: one machine of the smallest size the `single` profile sells holds ten
thousand ledgers and thirty million transactions inside the stated times.
`scripts/capacity/README.md` reproduces it against your own hardware.

`/health/ready`, as with any upgrade. If you set the Stripe or AdSense
variables, the process refuses to start on a half-configured pair and names the
missing half, so a clean start is itself the check.

On the split containers, this release's frontend says what it trusts in the
first lines of its log — `18-sb-real-ip.envsh: believing X-Forwarded-For from
10.0.0.0/16, real_ip_recursive off`, say — and stops before nginx starts, naming
the entry, when a trusted address is one it cannot read. After the `aws`
program's `pulumi up`, the load balancer's target groups show every
ingress-nginx pod healthy on port 80; a target unhealthy there after a few
minutes is an end of the hop that did not get the change.

If you turned billing on, five more. **Read the log for the prices first.** Both
price ids are checked against Stripe when the API and the scheduler start, again
at most every ten minutes when they are read, before every subscription is
started, and on every reconciliation sweep — and the first check that succeeds
says `Stripe is configured, and both prices fit the plans they are sold as.` A
price that does not fit is an error line saying what is wrong with it, and until
it is fixed nothing is for sale: the plan tab offers no plan, and starting a
subscription answers `409` and charges nobody. Changing the payment method,
canceling, paying a renewal's open invoice and letting go of a switch still
waiting for the renewal keep working, because none of them sells anything.
`docs/billing-operations.md` §Setting up Stripe says what the two prices have to
be.

**Then read the log for the key.** A restricted key is asked at startup, once,
whether it can read the seven things this deployment reads — customers,
subscriptions, subscription schedules, setup intents, invoices, payment intents
and prices. It asks for one item of each, writes nothing, and never refuses to
start. A key that can read them all says
`STRIPE_SECRET_KEY can read everything this deployment uses at Stripe.` One
that cannot gets a single error line naming every resource it was refused —
`STRIPE_SECRET_KEY cannot read PaymentIntents, and this deployment uses each of
them, so the plan tab will fail where it reaches one` — and the fix is step 2's
table. A Stripe that did not answer gets a warning instead, naming what it
could not ask about; that is a slow network rather than a bad key, and the
process carries on. A standard secret key, `sk_…`, is asked nothing, because it
can already read everything.

The probe proves reads and cannot prove writes, so the other half is per call:
any call Stripe refuses for a missing permission logs one error line naming the
call, the code and the fix, and a call Stripe *holds* — `approval_required`,
which means the key is agent-tagged and that rule is still in place — says so
and says it has not happened. If either line appears, the key or a rule is
wrong rather than the deployment; nothing retries it for you.

`SB_CSP_REPORT_ONLY=true` is worth one pass before you rely on the plan tab: it
makes that page report what its content security policy would have blocked
instead of blocking it. The policy is Stripe's published Stripe.js and Link
sets plus four hosts this project added, and whether a live account contacts
those four has not been observed by anybody yet, so the pass is where the answer
shows up — in your log, rather than as a payment form that will not load. It
covers that page and no other: every page that can carry an ad goes on
enforcing, and what the ads policy refuses is read from the browser console
instead (`docs/monetization.md`). Turn it off again — the process warns at every
start while it is on.

Then two more. Open `/settings/plan` and confirm the two
prices show the figures you set in Stripe — they are read from Stripe rather than
from your settings, so a blank there means this deployment could not reach it.
And point a Stripe webhook endpoint at
`https://your-host/api/billing/webhook`, subscribed to the event types
`docs/deployment.md` lists — the selection is Stripe's and this deployment
cannot see what you chose, so an endpoint subscribed to the wrong set fails
silently. A test delivery answering `200` with `{"received": true}` means the
signature verified; it does not mean the subscription is right, because that is
also what an event with no opinion returns. A `404` there means the `STRIPE_*`
settings did not reach the container, because the route is registered only when
they did.

## Before you upgrade to 0.1.6

Nothing refuses to start that 0.1.5 accepted, and nothing about an existing
configuration has to change. Five things are worth knowing.

**It closes twenty-seven dependency advisories**, eleven of them rated high, in
`fast-uri`, `js-yaml`, `nodemailer`, `hono` and `qs`. Nothing about this needs
an action from you — they ship inside the image — but it is the strongest reason
to take this release rather than stay where you are. The Node base image moves
to the current `24-alpine` build for the same reason; the major stays at 24, so
nothing about the runtime changes under you.

**Nine migrations run at startup, and none rewrites a row.** They create the
budget tables, the category-group table and the types they use; they add
columns to `budget_plan`, `budget_entry`, `category` and `ledger_account` —
every one nullable or with a default, so nothing is backfilled; they add
indexes, including one on `idempotency_record.created_at` for the retention
sweep below; one swaps a check constraint on the new budget tables for a wider
one and another trades two unique constraints for partial unique indexes,
touching no data because the tables they sit on ship in this same release. The pause is the length of a handful of `create table`,
`alter table` and `create index` statements whatever the size of your ledger.
The one new column on an existing table anybody will notice is
`ledger_account.in_budget`, which defaults to true: every account you already
have is inside the budget's perimeter, which is what the budget page assumes
until you say otherwise.

**Settings that used to fail in silence now say so, and one that refused now
warns.** A bounded integer out of range — `CSV_MAX_ROWS=50000`,
`RECURRENCE_TICK_SECONDS=0`, and the three other bounded numbers beside them —
used to fall back to its default without a word. It still starts the container
and still runs on the default, but it now names itself in the log with the
value it was given and the number in force instead. So does a name set both
ways, such as `DATABASE_URL` beside `DATABASE_URL_FILE`, where the environment
variable wins as it always did. `DATABASE_POOL_SIZE` moved the other way:
0.1.5 refused to start over an out-of-range value, and this release starts,
warns, and runs on the default, so a container that would not boot yesterday
boots today. An empty value stays as quiet as ever on purpose, because
`.env.example` ships blanks and a blank means the default. If you have been
carrying one of these, this release tells you so for the first time; the
release that refuses it is a later one.

**Four `/api/v1` paths were renamed and the old spellings still answer.**
`POST /accounts/{id}/archive` is now `/archived`, `POST /categories/{id}/archive`
is now `/archived`, `POST /staged-transactions/delete` is now `/bulk-delete`, and
`GET /staged/{id}/duplicate` is now `/staged-transactions/{id}/duplicate`. The old
paths carry `Deprecation` and `Sunset` headers and stop answering after March 1, 2027. Nothing you run needs changing today; a browser tab left open across the
upgrade keeps working.

**An agent's arguments are checked more strictly.** Every MCP tool now declares a
closed argument object, so a tool call carrying a field the tool does not declare
comes back as an error naming it rather than having the field dropped in silence.
Nothing an agent could successfully do before is impossible now — the dropped
field never had any effect — but a call that returned success may now return a
failure, which is the point: an open object teaches a model that an argument it
invented works.

**New, and off unless you ask.** `METRICS_ENABLED=true` makes both the API and
the scheduler answer `GET /metrics` in Prometheus' format, and `METRICS_TOKEN`
puts a bearer token in front of it. A deployment that sets neither has no such
route and nothing changes. `LOG_LEVEL` now governs this application's own log
lines as well as the auth library's, so `warn` and `error` are quieter than they
were; the first-run setup code prints at every level.

**Used idempotency keys can be pruned now, and are not pruned unless you ask.**
`IDEMPOTENCY_RETENTION_HOURS` sets how long a used key keeps replaying, and it
defaults to zero, which means forever — exactly what every release before this
one did. Nothing about your data changes on upgrade. Set it if the table has
grown: every create, commit and bulk write stores a copy of its response there,
and on a busy deployment it outgrows the ledger it protects. It is safe to set
because the record makes a retry _quiet_ rather than safe — a repeated create
still meets the duplicate check, a repeated commit finds its rows already
committed, and a repeated bulk write still carries a count and fingerprint that
no longer match. The sweep rides the recurrence scheduler's tick, so it needs
`RECURRENCE_SCHEDULER` on somewhere, and it removes a bounded batch per pass so
a first sweep after a year drains rather than locking the table.

**Pagination cursors are signed now, and 0.1.5's are still accepted.** A
`nextCursor` this release hands out carries an HMAC keyed to your
`AUTH_SECRET`, so a cursor cannot be hand-built and a client cannot come to
depend on what is inside one. Nothing you do changes: a cursor a 0.1.5 client is
still holding when you swap the container keeps working, which is what makes
this safe to deploy while somebody is halfway down a list. **The unsigned form
stops being accepted on March 1, 2027**, which is the same date the four renamed
paths above stop answering — one date for everything this release deprecates —
and by then no build in the field will be issuing one. Two consequences worth knowing: replacing `AUTH_SECRET`
invalidates every outstanding cursor along with every session, so whoever is
mid-list starts again from page one — which is the same thing a sign-out already
does to them; and every replica needs the same `AUTH_SECRET`, which is already
true of everything else.

## Before you upgrade to 0.1.5

Nothing refuses to start that 0.1.4 accepted, and nothing about an existing
configuration has to change. Five things are worth knowing.

**Five migrations run at startup.** One adds the reminders table and one column
on `recurrence`, defaulting to off, so no recurrence you already have starts
emailing you. One adds a one-row table holding the first-run setup code, which
matters only on a deployment that has never been set up. One adds a `theme`
column defaulting to `system`, which is a constant default and therefore
metadata-only — no table rewrite, and every existing account lands on "follow the
machine", which is what it should be. One drops four indexes whose leading column
another unique constraint on the same table already leads with; no query loses a
plan, and the statements are `if exists`, so a database restored from a dump that
never had them upgrades cleanly. The fifth adds two indexes on the expression
payee names are compared by, which is what keeps every transaction write from
scanning your own rows to find the spelling already on file — on a large ledger
that one takes a moment to build while the container starts, before it opens
readiness.

**Emailed reminders need a mail server and the scheduler.** Setting a recurrence
to write when it proposes, or giving a template a reminder, is saved either way,
and starts sending once `SMTP_HOST` and `MAIL_FROM` are configured. Nothing
queues in the meantime: a reminder whose moment passed while there was nowhere
to send it is not sent later. On a split deployment, give the scheduler
container those settings too — it is the process that sends them, and without
them it proposes rows and sends nothing, with no error to see.

**The first-run setup code now works on more than one replica.** It used to be
generated per process and held in memory, so on a web tier running two or more
pods — which the chart does by default — the code printed in the log was rejected
by every other pod, and first-run setup failed about half the time. It is stored
now, so every replica agrees on it. This affects only a deployment whose owner
account has not been created yet; an existing one has nothing to do. An
operator-chosen `SETUP_TOKEN` still never touches the database and still takes
precedence.

**Dark mode arrives set to follow the machine.** Nobody has to do anything: an
existing account keeps looking exactly as it did on a light machine, and starts
dark on a dark one. The setting lives on the account rather than in the browser,
so it follows somebody to another device, and there is a third state — Light and
Dark, which stay put, and Follow my system, which is the default and changes when
the machine does.

Three things change in the light theme as a consequence, all of them repairs. Six
grays carrying real text were below the contrast a person needs to read them —
the input placeholder was the worst at 2.65:1 — and they now sit on one three-step
ramp that clears it. The border on an input was 1.39:1 against the field it edges,
which is not a boundary — and an input here is white on a white card, so that
border is the only thing telling you where the field is; a field's edge now holds
the 3:1 that makes it visible, and a focused field is darker again rather than
only greener.
And the focus ring was semi-transparent, so how well it showed depended on
whatever happened to be behind it; it is opaque now and the same everywhere.
Inputs, captions and the focus ring therefore look more defined than they did.

**The duplicate check on Staged transactions got looser, and only as advice.** It
now anchors on the amount with three days of latitude on the date rather than
demanding the same day and the same payee, so an import will flag rows it would
have let past before. What refuses a commit is unchanged. Nothing already in the
queue is re-examined until it is listed again.

## Before you upgrade to 0.1.4

0.1.4 refuses to start on three configurations 0.1.3 accepted. Each refusal is
deliberate: all three were ways a deployment could look fine while running with
protections silently off. Check these before you swap the image, because the
container will not start and will not tell you until it has.

| If your configuration has                                                            | 0.1.4 does                                                                                      | What to do                                                                                                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET` still set to the placeholder `.env.example` shipped                    | Refuses to start, naming the variable                                                           | Generate one: `openssl rand -base64 32`                                                                               |
| `NODE_ENV` set to anything but `production`, `development` or `test`, empty included | Refuses to start                                                                                | Set `NODE_ENV=production`. The images already do.                                                                     |
| `NODE_ENV` unset                                                                     | Reads as `development`, so the setup code, sign-in rate limiting and secure cookies are all off | Set `NODE_ENV=production`. Unset is the one value that does not announce itself, which is what the row below catches. |
| `NODE_ENV` not `production` while `APP_BASE_URL` names anything but localhost        | Refuses to start                                                                                | Set `NODE_ENV=production`, and give `APP_BASE_URL` the HTTPS origin your proxy terminates                             |

**Replacing `AUTH_SECRET` signs everybody out** and disconnects every MCP
client, because sessions are signed with it. Everyone signs in again with the
password they already have, and each connected agent has to be authorized once
more from Settings. Plan the upgrade for a moment when that is acceptable.

Two other things change without stopping the server:

- `CSV_MAX_ROWS` above 10,000 is silently reduced to 10,000, which is now also
  the most rows one mass edit, commit or delete covers. If you had it higher,
  large imports now arrive in more than one file.
- MCP access tokens issued by 0.1.3 stop working. Clients holding a refresh
  token get a new one on their next call without anybody doing anything; a
  client that cannot refresh has to be authorized again.

The first start after the upgrade re-closes any account you archived while it
held a transaction dated in the future, and says so in the log. It writes
nothing for an account that is already correct, and running it again writes
nothing at all.

## How to upgrade

1. Read the [changelog](../CHANGELOG.md) for the version you are moving to, and
   check whether it asks anything new of PostgreSQL or your configuration.
2. Back the database up, and confirm the backup is good:

   ```sh
   pg_dump --format=custom \
     --file=simple-balance-before-upgrade.dump \
     "$DATABASE_URL"
   ```

   Let PostgreSQL handle the password through `~/.pgpass` or the environment
   rather than typing it into a shell that remembers it.

3. Pull the image by its version tag, not `latest`, so you know what you are
   getting.
4. Stop and remove the application container. Leave PostgreSQL running.
5. Start the new image with the same settings you had before, after checking
   the section above for anything that release refuses.
6. Watch the log, and wait for `curl -f http://127.0.0.1:3000/health/ready`.
7. Keep the backup until you have used the app enough to trust it.

The new process applies every pending migration before it opens readiness,
holding a PostgreSQL advisory lock so two containers starting at once cannot
race. Any data reshaping a release needs travels inside its migrations. You
never run a migration command, copy rows, or retype anything.

## Rolling back

Do not run two versions with different schema expectations against one database.
A migration can leave the schema unreadable to the older image, so rolling back
means stopping the app and restoring the backup you took in step 2, unless the
release you moved to says otherwise.

This is the reason step 2 is not optional.

### Rolling back from 0.2.0

Three of this release's changes decide how far back you can go, and they are
different for each profile. The short version: **on `single`, and on `ha` while
its database is one you brought, a rollback is the ordinary restore above; on an
`ha` whose ledger is distributed it is not a rollback at all.**

**`single`, and `ha` with `database: external`.** `0022` is additive — five
tables the older image does not read — and `0024` adds one column the older
image never names: its inserts leave `ledger_account.active` to the default and
nothing it reads mentions it. So 0.1.6 runs against a 0.2.0 schema unchanged.
`0023` did nothing where there is no Citus extension, which is every
single-node PostgreSQL. You can put the older image back without restoring
anything, and the five billing tables and the new column sit unread until you
upgrade again.

Two things to undo separately on `single`. The compose recipe's PostgreSQL
version, if you moved it: a 16-series container cannot read an 18-series data
directory either, so going back there is a dump and a restore in the other
direction. And, if you moved from a database you brought onto the profile's own
database node, the older image is fine but the data is now on the new machine —
rolling the image back does not move it back, and pointing 0.1.6 at the old
database gives you the ledger as it was when you copied it.

**An `ha` deployment whose ledger is distributed cannot be rolled back to 0.1.6
by putting the old image back**, and this is the one worth knowing before you
distribute anything. That is `database.enabled` in either of its two shapes:
one node per service and highly available run the same Citus schema, so this
applies to both equally — the small shape is not a lesser case. `0023` widens
fourteen primary keys to carry the owner, and PostgreSQL then refuses a
`GROUP BY` that names only part of a key while the select list reads other
columns — which is what 0.1.6's balances, register, dashboard, category-group
and import-batch queries all do. They were corrected in this release precisely
so the widened key would be safe, and the older image does not have those
corrections. It will start, pass its health check, and fail those five reads.

So rolling back a distributed deployment means restoring a dump taken before the
cluster into a single PostgreSQL and running 0.1.6 against that. **Take that dump
before you distribute**, not after: once the keys are widened, every dump you
take carries the widened schema.

**Moving between the two `ha` shapes is not a rollback and needs none of this.**
`-f values-node-per-service.yaml` and `-f values-ha.yaml` are the same chart,
the same images and the same schema at different replica counts, so going either
way is a `helm upgrade` and a rollout. Going down, from the redundant shape to
the small one, does shed standbys and a worker group, so let a rebalance finish
first — `docs/citus-runbook.md` has it.

**The `aws` program's proxy protocol is outside the schema.** A `pulumi up` from
the previous checkout turns it off at both ends again, and the frontend's trust
back to the chart's `127.0.0.1`, with the same seconds-to-a-minute interruption
the upgrade had, and the shared sign-in allowance returns with it.

**Stripe is outside all of this.** A subscription that exists at Stripe goes on
existing after a rollback, and 0.1.6 has no code that knows about it — nobody is
charged differently, and nothing is lost, but the deployment stops reflecting
what Stripe thinks. If the rollback is permanent, cancel the subscriptions at
Stripe rather than leaving them to renew against a product that no longer reads
them.

## Cutting a release

`docs/acceptance.md` is the list of what this release claims and what closes
each claim, with a second table of what is outstanding. Read that before the
steps below: three of its open rows are gates that no amount of work in this
repository closes.

1. `npm run set-version 0.2.0`, which sets the version in the twenty files
   where it has to agree: the three manifests and their three lockfiles, all
   four Dockerfiles' default build argument, the chart's `appVersion` and its
   own `version`, the constant the MCP server reports, the product backlog, the
   release the three product-kit files in `docs/product/` say they describe,
   and the pinned image tags in the split compose file, the `single` profile's
   `compose.yml`, the Pulumi README and the single-machine Pulumi programs.
   Twenty rather than the twenty-two of the branch's earlier state: the `vps`
   profile's `compose.app.yml` and `compose.frontend.yml` went with the
   profile, and `deploy/compose/single/compose.postgres.yml` does not replace
   them — it runs `postgres:18`, which carries no tag of ours to rewrite.
   `tests/version.test.ts` checks every one of
   those against `package.json`, asserts the script names each, and runs the
   script over a scratch copy of the files to prove it rewrites them, so a
   location the script forgets fails the suite rather than shipping.
2. Give this release's upgrade note its number, and open the next one, in the
   same commit. `set-version` does not touch this file, and the moment it has
   run the suite asks for two headings the provisional one cannot supply.
   Rename the provisional `## Before you upgrade to 0.1.7` at the top of this
   file to `## Before you upgrade to 0.2.0` — a prerelease such as `0.2.0-rc.1`
   takes the release's number too, because it upgrades on to the same schema —
   and delete its paragraph saying the number is provisional. Then add
   `## Before you upgrade to 0.2.1` above it, with one paragraph saying nothing
   has landed for it yet: the shape the 0.1.6 cut gave 0.1.7 in `035da59`.

   Skip the renaming when the previous version was a prerelease of this one —
   0.2.0 after 0.2.0-rc.1. That cut already gave the note this release's number
   and opened the next patch's, so renaming the first heading here would turn
   the empty 0.2.1 placeholder into a second `## Before you upgrade to 0.2.0`,
   and `tests/version.test.ts`, which reads the first, would pass on the empty
   copy. Check only that what landed since the prerelease is written under this
   release's heading, then run that test.

   The note itself should already be written: what runs automatically, what an
   operator has to do by hand, what changed under them, and what to check
   afterward. Write it as the work lands rather than here — the suite asks for
   the _next_ version's note as well as this one's, so a release whose note was
   left to the last minute has already been failing. Write it even when the
   answer is that nothing changed, because a missing heading and an unwritten
   note look the same from the outside.
3. Confirm the product kit describes the tree being cut. `set-version` stamps
   the kit's `appVersion` rather than rebuilding it, which is honest only
   because `release-prep` phase 4a rebuilt the kit on this same tree, and a cut
   changes nothing a screen shows. The script cannot tell whether 4a ran, so
   compare the capture with the last change to the browser app, and run the
   `product-kit` skill first if a screen changed after it:

   ```sh
   grep -m1 capturedAt docs/product/screenshots.json
   git log -1 --format='%cs %h %s' -- src/client
   npx vitest run tests/product-kit.test.ts tests/product-facts.test.ts tests/version.test.ts
   ```

4. Date the `## Unreleased` heading in `CHANGELOG.md`, since nothing does that
   for you and the upgrade notes above send people there to read it.
5. Add that release's migrations to the frozen list in `AGENTS.md`. Once an
   image has run one against somebody's data it can never be edited again, and
   the list is what says so.
6. `npm run verify`, then commit and push on the default branch. The publish
   runs the same suite first, so a failure here is one the release would have
   met anyway.
7. Cut a release on GitHub against tag `v0.2.0`, from the UI or with
   `gh release create v0.2.0`.

Publishing keys off the release itself, not off the tag push, so it runs once
whether the tag existed beforehand or GitHub creates it. The workflow runs the
full verification suite first, refuses to publish if the tag and the manifest
disagree, and then pushes a multi-architecture image to GHCR tagged with the
version. `latest` moves to it unless the release is marked as a prerelease or
the version carries a suffix, in which case only the version tag is published.

If a publish fails for a reason that has nothing to do with the code, run the
release workflow by hand from the Actions tab and give it the tag; it publishes
the same version tag without needing a new release. It leaves `latest` alone
unless you check the box asking for it, because a run started by hand cannot see
whether the release was marked as a prerelease and should not guess.

## The schema contract

Once a migration ships in a release it is frozen, starting with the ones in
0.1.0. A released migration has run against somebody's data by then, and editing
it would leave their schema and its recorded history disagreeing.

Every schema change is therefore a new migration, and each one:

- is a new forward-only migration, checked into version control;
- preserves every ledger, authentication, provenance, idempotency, and audit
  row;
- fills in any new required column for existing rows deterministically;
- runs inside a transaction wherever PostgreSQL allows one, and states plainly
  what it does when it cannot;
- survives being interrupted and restarted, and fails readiness rather than
  leaving the schema half-changed;
- ships with an integration test that starts from the previous release's schema
  with real data in it, runs the migrations, and checks both the shape and the
  contents afterward.

Migrations run inside the application rather than as a separate step because
that is what makes an upgrade one action. Swap the image, start it, and the
database catches up on its own.
