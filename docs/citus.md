# Citus, and what distributing this ledger costs

The `ha` profile's database. This page is what was established by running it
rather than by reading about it: Citus 14.2 on PostgreSQL 18, the real schema,
the real application. The procedure was proven on 16 first, then 17, then 18 —
`docs/deployment-profiles.md` has the reasoning, and the short version is that
Citus 14.2 is the newest Citus and gates on 16, 17 and 18, so 18 is the newest
database the cluster can run and therefore the one every profile that owns its
database deploys.

**Status: built and exercised, not yet run in production.** The migration, the
image and the chart all exist, and a cluster stood up from them has taken a
coordinator failover and a shard rebalance. What it has not had is a cloud, a real dataset,
or anybody else's storage class — see §What is left.
`docs/deployment-profiles.md` says which profile is which, and
`docs/citus-runbook.md` is how to operate this one.

## What was run

Every migration before the distribution applies to Citus unmodified — the 23
from `0000` through `0022`, through the application's own startup path,
recording themselves normally. Nothing about the existing schema had to change
to *install* on a Citus cluster. What has to
change is everything below, and only to *distribute* it.

`drizzle/0023_citus_distribution.sql` is the procedure, and it applies as one
atomic transaction. After it: **17 distributed tables, 14 reference tables, all 46
foreign keys restored.**

## The shape

| | Tables | Why |
| --- | --- | --- |
| Distributed on `user_id` | 17 | The ledger. Colocated, so a person's transactions and postings share a node and a join between them is local |
| Reference | 14 | Replicated whole to every node |

Three different reasons put a table in the reference set, and they are worth
separating because only one of them is a limitation.

**No tenant to distribute on.** `auth_user` itself, and the five tables with no
`user_id` at all — `auth_verification`, `auth_rate_limit`,
`auth_owner_setup_token`, `auth_mcp_signing_key`, `billing_webhook_event`.
Nothing to shard by.

**Uniqueness that is global by nature.** Citus refuses any unique constraint
that does not contain the distribution column, because it cannot enforce it
across shards it would have to search. Six exist on tenant tables, and five of
them are unique for reasons that have nothing to do with a tenant:

| Table | Constraint | Whose namespace |
| --- | --- | --- |
| `auth_session` | `(token)` | A session token |
| `auth_account` | `(provider_id, account_id)` | The identity provider's |
| `billing_customer` | `(stripe_customer_id)` | Stripe's |
| `billing_operation` | `(stripe_idempotency_key)` | Stripe's |
| `billing_subscription` | `(stripe_subscription_id)` | Stripe's |

`auth_session` is the happy case rather than the compromise. Every
authenticated request looks a session up by its token, and distributing that
table would turn the most frequent query in the product into a scatter-gather
across every node. Replicating it makes that lookup local.

**The sixth is scopable and was scoped.** `template_notification (template_id)`
becomes `(user_id, template_id)`, which narrows nothing — a template id was
already unique — and costs nothing.

**The OAuth trio** — `auth_oauth_application`, `auth_oauth_access_token`,
`auth_oauth_consent` — are reference tables because their `user_id` is nullable
and a distribution column cannot be null.

## What it costs

**One behavior: `category.group_id` loses `ON DELETE SET NULL`.** Citus refuses
it with `SET NULL or SET DEFAULT is not supported in ON DELETE operation when
distribution key is included in the foreign key constraint`. That is the whole
reason, and it is worth being precise about because the obvious guess is wrong:
it is not that `SET NULL` would try to null the non-nullable `user_id`.
PostgreSQL 15's `ON DELETE SET NULL (group_id)` spelling, which nulls only the
column named, is refused for the same reason. No spelling helps. The key becomes
`NO ACTION` and the nulling moves into the delete, in the service.

**Nothing, now.** `/api/v1/forecast` was the one endpoint that failed, and it
was not a Citus limitation: `forecast.ts` joined a budget plan to its category
on the category id alone, with no owner, while every equivalent query in
`budgets.ts` carried `user_id` on both sides. On a cluster the owner *is* the
distribution column, so a join that omits it is a join across every tenant's
shard and Citus refused it. Scoping the join fixed both problems at once.

**Twenty-five of twenty-five endpoints** now answer on a distributed schema,
including every report, the trial balance, the CSV export, the budget report and
the forecast, and the books balance across shards.

That defect is worth keeping in view because of what it says about the exercise.
It was a tenant-scoping hole that a single-node database could not expose — two
people cannot hold the same category id while the key is `(id)` alone, so the
bare join had nothing wrong to match. Widening the key for the cluster is
exactly what makes it reachable. `tests/integration/forecast-tenancy.test.ts`
widens the key on its own scratch database and gives two people a category with
the same id, which is the only arrangement in which the defect can be seen at
all.

## The one that is not about Citus at all

Changing a primary key from `(id)` to `(user_id, id)` breaks `GROUP BY` in a way
that has nothing to do with clustering. PostgreSQL lets a select list name any
column functionally determined by the grouping — `group by a.id` permits
`a.name` — but only when the grouping covers the *whole* primary key. Widen the
key and those queries fail with `column "a.name" must appear in the GROUP BY
clause`, on plain PostgreSQL, with no Citus anywhere.

Five were found this way and all five are already fixed, because the fix is
correct under both keys and therefore safe to ship long before any migration:

- `accounts.ts` — the balances query and the register query
- `summary.ts` — the dashboard
- `category-groups.ts` and `import-export.ts` — the two Drizzle groupings

That is the pattern for the rest of this workstream: make the application
correct under the future key first, ship that, and let the migration come to a
codebase that is already ready for it.

## What the image has to be

No published artifact fits. `citusdata/citus:14.2.0-pg16` is amd64 only —
there is no multi-platform manifest — and the one arm64 image Citus publishes,
`citusdata/citus:alpine`, carries PostgreSQL 18.4.

Citus 14.2 publishes `-pg16` and `-pg17` variants and no `-pg18` at all; the
only place its PG18 support is published is that floating `alpine` tag, which is
musl. So the version we want and the platform we want do not meet in any
published artifact, from either direction.

Two further reasons to build rather than adopt. The published PG16 image carries
**PostgreSQL 16.14** and the PG17 one carries **17.10**, while CVE-2026-15741 is
a PostgreSQL core defect fixed in 16.15, 17.11 and 18.0 — so neither published
image is patched and the base has to be pinned forward regardless. `postgres:18`
carries 18.6 today, which is what the other profile runs. And it must be a glibc
base rather than musl: this application compares normalized names with the
database's collation, and `docs/deployment-sizing.md` has the measurement showing
Alpine sorts every category and payee list byte-wise whatever collation it
claims. That rules out the one arm64 image Citus publishes, which is the same
tag that carries the PG18 support — so the build is what gets us both.

## What is left

Nothing structural. The four things this page listed as missing all exist:

- **The migration** is `drizzle/0023_citus_distribution.sql`, gated on the Citus
  extension so it does nothing on the two profiles whose database is a single
  PostgreSQL. Verified both ways — the 24 through `0023` recorded and the schema
  untouched on a plain PostgreSQL 18, and the full distribution on a cluster.
  `0024` came after those runs. It adds one column with a constant default,
  which Citus carries to every shard of a distributed table on its own, so it
  needs no gate — argued rather than run.
- **The image** is `deploy/docker/citus.Dockerfile`: PostgreSQL 18 pinned by
  digest, Citus 14.2.0 built from a checksummed source tarball, Patroni beside
  it, built for amd64 and arm64 by `.github/workflows/citus-image.yml`.
- **The chart** provisions the cluster: one StatefulSet per Citus group with
  Patroni running them, synchronous replication on by default, and a
  post-install Job for the one thing Citus needs that Patroni does not do.
- **The runbook** is `docs/citus-runbook.md`, and every procedure in it was run
  rather than written from documentation.

What remains is not construction but exposure:

- **It has run on kind and on no cloud.** Three nodes, six then eight pods, real
  failovers and a real rebalance — but not on EKS or GKE, where the storage class
  is somebody else's and a node can disappear rather than be deleted politely.
  `deploy/pulumi/aws/` and `deploy/pulumi/gcp/` stand up the clusters; neither has
  been pointed at this.
- **The measurements here are a laptop's.** The rebalance figure — 10 moves in
  under two minutes — is a cluster with a schema and almost no rows. What that
  becomes at the capacity target in `docs/capacity.md` is not known, and a
  rebalance on a real ledger is the number an operator would actually want.
- **Nothing has been restored into it.** A dump from a single PostgreSQL should
  restore into a cluster and distribute on the way, and that path is argued here
  rather than exercised.
