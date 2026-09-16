# Citus, and what distributing this ledger costs

The `ha` profile's database. This page is what was established by running it
rather than by reading about it: Citus 14.2 on PostgreSQL 17, the real schema,
the real application. The procedure was proven on 16 first and then on 17, which
is what every profile now standardises on — `docs/deployment-profiles.md` has
the reasoning, and the short version is that 17 is the newest release Citus 14.2
supports and the oldest that survives Citus 15 dropping 16.

**Status: proven, not shipped.** The procedure below applies cleanly and the
application runs on the result. What does not exist yet is the migration that
carries it, the image that ships it, or the Helm chart that runs a cluster.
`docs/deployment-profiles.md` says which profile is which.

## What was run

The whole of `drizzle/` applies to Citus unmodified — all 23 migrations, through
the application's own startup path, recording themselves normally. Nothing about
the existing schema had to change to *install* on a Citus cluster. What has to
change is everything below, and only to *distribute* it.

`deploy/citus/distribute.sql` is the procedure, and it applies as one atomic
transaction. After it: **17 distributed tables, 14 reference tables, all 46
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

**One behaviour: `category.group_id` loses `ON DELETE SET NULL`.** Citus refuses
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

Two further reasons to build rather than adopt. The published PG16 image carries
**PostgreSQL 16.14** and the PG17 one carries **17.10**, while CVE-2026-15741 is
a PostgreSQL core defect fixed in 16.15 and 17.11 — so neither published image
is patched and the base has to be pinned forward. `postgres:17` carries 17.11
today, which is what the other two profiles run. And it must be a glibc base rather
than musl: this application compares normalized names with the database's
collation, and `docs/deployment-sizing.md` has the measurement showing Alpine
sorts every category and payee list byte-wise whatever collation it claims.

## What is left

- The migration. `deploy/citus/distribute.sql` is the proven content; it needs
  to become `0023`, gated on the Citus extension being present so it never runs
  on the `single` profile or a plain PostgreSQL.
- The image, built from a pinned glibc base with the Citus source checksummed.
- The chart. Nothing in `deploy/helm/` provisions a database at all today, so
  `ha` needs coordinator and worker StatefulSets, and Citus supplies no high
  availability of its own — `shard_replication_factor > 1` is deprecated and
  documented as not an HA mechanism, so redundancy is a streaming standby per
  node.
- A runbook: adding a worker, rebalancing shards, and what a failover does.
