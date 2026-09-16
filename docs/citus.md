# Citus, and what distributing this ledger costs

The `ha` profile's database. This page is what was established by running it
rather than by reading about it: Citus 14.2 on PostgreSQL 16, the real schema,
the real application.

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

**One query shape.** `/api/v1/forecast` fails with `complex joins are only
supported when all distributed tables are joined on their distribution
columns`. The join in `budgets.ts` does carry `user_id` on both sides — the
problem is the star: two outer joins from one table to two different distributed
tables, which Citus's planner will not push down. It needs restructuring, and
that is application work rather than a schema change.

Everything else works. Sixteen of eighteen endpoints answered on a distributed
schema, including every report, the trial balance, the CSV export and the
budget report, and the books balanced across shards.

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
**PostgreSQL 16.14**, and CVE-2026-15741 is a PostgreSQL core defect fixed in
16.15 — so the base has to be pinned forward. And it must be a glibc base rather
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
- The forecast query.
- A runbook: adding a worker, rebalancing shards, and what a failover does.
