# Database

Drizzle, PostgreSQL, and the traps this schema has actually hit.

PostgreSQL is the only supported database — `AGENTS.md`: "PostgreSQL is the only
persistent dependency. Do not add Redis, SQLite, an object store, sidecar, or
writable-volume requirement." There is no abstraction layer over it and there
should not be one: the reports lean on `date_trunc`, `generate_series` and
`numeric`, and pretending otherwise would cost more than it bought.

One vendor, two shapes. The `single` and `vps` profiles run one PostgreSQL; the
Helm chart runs PostgreSQL with Citus, and `drizzle/0023_citus_distribution.sql`
makes the two schemas differ on purpose — composite primary keys, fourteen
tables replicated whole, one foreign key that cannot be `SET NULL`.
`src/server/db/schema.ts` is the single-node schema and is the one a reader
opens, so "the primary key" below means the narrow one unless it says otherwise.
1.6 is where the difference lives.

## 1. Migrations

### 1.1 A shipped migration is frozen

**Binding.** `AGENTS.md`: "Every migration that has shipped is frozen:"
Twenty-six migrations, `0000_initial.sql` through
`0025_subscription_cancel_at.sql`. Frozen is about shipping, not about existing:
`0000` through `0021` went out in released versions and may never change — the
budget set, `0013` through `0021`, shipped in 0.1.6 — while `0022` through
`0025` are written and unreleased, so `AGENTS.md` says those four may still be
regenerated. They freeze when 0.2.0 ships, and the next schema change after them
starts at `0026`. A change to what has shipped is a new forward-only migration,
generated with `npm run db:generate`.

The freeze line moves at every cut and this paragraph has to move with it. It
did not, once: it went on naming `0013` through `0021` as the regenerable set
for a whole release after that set shipped, which reads as an invitation to
regenerate a file that databases in the field have already run. 1.5 is what
that costs and why it is a rule of its own rather than a clause here.

*Checked by:* `tests/migrations.test.ts`, which reads `AGENTS.md` as text and
fails on any `.sql` in `drizzle/` the prose does not name. That is one
direction, and it is the one that went wrong: the prose stopped at 0012 while
the directory held 0013. The other direction is not covered. A file deleted on
its own is caught by the journal and snapshot counts beside it, but a name left
in `AGENTS.md` after its file, its journal entry and its snapshot have all gone
passes, so the frozen list can still outlive what it lists. Neither direction
reads *which* of the names are shipped, which is the half 1.5 answers for.

### 1.2 A migration has a name, not a number and a slug from a generator

**House.** `0013_budget_plans_and_entries.sql` says what it did. Drizzle's
default names it after a Marvel character. Rename it on generation, and record
it in `AGENTS.md` in the same change.

*Checked by:* nothing that reads a name for what it says. The recording half is
held by 1.1: a freshly generated file that nobody listed fails the moment it
lands in `drizzle/`. `tests/migrations.test.ts` also pins the first five
journal tags to the words they shipped with, and holds every later file to its
own tag, so a rename after the fact fails. What no test does is tell
`0026_payee_merge_audit` from `0026_lucky_moon_knight`: both are strings it has
not seen before, and only review stands between the second one and the
directory. §5 carries this.

### 1.3 Additive by default

**House.** A migration adds tables, columns and indexes. Dropping a column is a
separate decision from the change that stopped using it, and they do not belong
in one migration: the deploy that stops writing a column and the deploy that
drops it should be far enough apart that a rollback is possible in between.

*Checked by:* `tests/migrations.test.ts`, file by file rather than as a rule.
Ten of the twenty-six are asserted to add and never remove — `0005` through
`0011`, and the three unreleased additive ones, `0022`, `0024` and `0025` — and
several go further: a column added to an existing table carries a constant
default, so PostgreSQL fills it without rewriting a row. `0000` is held
separately, to adding no column to anything and running no `UPDATE`. `0010` is
the one that takes an index away rather than a constraint, and it is held to
taking away only indexes another index already covers. `0023` is not additive at
all — it takes sixty-seven constraints off and puts them back — and is held by
its own gates instead; see 1.6.

What has no mechanism is the rule, as opposed to these ten instances of it.
§5 carries that: the twenty-seventh migration is asserted by nothing, and a
`drop column` in it would be caught by review or not at all.

### 1.4 A new table names its cascade

**Binding.** `AGENTS.md`: "A table that holds somebody's data references
`auth_user` with `on delete cascade`, because deleting an account is one delete
of that row and nothing enumerates tables."

The reason runs the opposite way from how this section used to state it, and the
inversion was expensive: account deletion does **not** enumerate the tables it
clears. `src/server/services/account-deletion.ts:24` is one delete of the
person's row, and its own docstring says why — "A hand-written list of tables to
empty is a list somebody will forget to add to, and the thing it would forget is
somebody's data left behind after they asked for it to be gone." Under the old
sentence, somebody meeting a failing deletion went looking for a list that does
not exist.

A table added without its cascade makes deletion fail rather than silently
orphan rows, which is the right failure and still a bug.

One table must **not** cascade, and naming it is part of the rule rather than an
aside. `billing_webhook_event` (`src/server/db/schema.ts:1634`) carries no
`user_id` and hangs from nobody: it records which deliveries Stripe has already
been answered for, which is the deployment's fact rather than any person's.
Letting it cascade would drop that record with the account and let a retry
inside Stripe's 72-hour window be handled a second time as new.

*Checked by:* `tests/integration/account-deletion.integration.test.ts` for the
cascade, and `tests/migrations.test.ts` for the exception, which reads
`0022_plans_and_billing.sql` and asserts that exactly four of the five billing
tables take `ON DELETE cascade` and that the fifth takes no constraint at all.
Neither is a check on the next table: the integration test catches a missing
cascade only where its fixture puts a row in the table that is missing one.

### 1.5 An unreleased migration may be regenerated, and the migrator cannot tell you which is which

**Binding**, and mechanized. `AGENTS.md`: "regenerate one only while no database
anywhere has run it, and add a file wherever one has."

1.1 says which files may still change. This says what happens when that
judgement is wrong, and the reason it needs saying is that nothing reports it.
Drizzle's migrator decides what to run by comparing the timestamp recorded for
the last applied migration against each file's folder timestamp (in
pg-core/dialect.js), and never compares the file's hash. So a database that has
already run `0022` records a regenerated `0022` as done, migrates clean, passes
readiness, and then fails at the first read of whatever the regeneration added —
`column "cancel_at" does not exist` — with nothing said at startup.

The obvious alternative is the one that was taken on this branch and undone:
fold the new column into `0022`, which 1.1 permits, because `0022` has not
shipped. Permitted is not free, and it is this branch's own databases that pay.
One did. The browser tier had `0000` through `0024` recorded and
`billing_subscription` without the column. The column is now
`drizzle/0025_subscription_cancel_at.sql`, a file of its own.

So the rule is not "unreleased means safe" but "unrun means safe": regenerate
only while no database anywhere has run the file, and add a file wherever one
has. Those differ precisely on the development databases nobody counts.

*Checked by:* `tests/migrations.test.ts`, "adds cancel_at as its own migration,
not a fold into 0022". It asserts both halves — the column is in `0025`, and it
is not in `0022` — because either one alone passes while the trap is back. What
it holds is this one column in these two files; the next fold will be into some
other unreleased migration, and only 1.1 being true stands in front of it.

### 1.6 A schema change is right on one PostgreSQL and on a cluster, and a table added after `0023` distributes nothing

**Binding.** `AGENTS.md`: "where a profile cannot enforce something in the
schema, the service enforces it everywhere rather than the behavior depending on
where it runs."

Two halves. They fail differently and are checked differently.

**Where the two schemas cannot agree, the service decides.** The worked case is
a category's group. `drizzle/0016_category_groups.sql:26` installs the foreign
key as `on delete set null`, which on a single PostgreSQL clears the column
without anybody writing code. Citus refuses `SET NULL` whenever the distribution
column is part of the constraint — in every spelling, including PostgreSQL 15's
column list — so `drizzle/0023_citus_distribution.sql:259` reinstalls the same
key as `NO ACTION`, under which deleting a group that still holds categories
fails outright rather than orphaning them. The service clears the column itself
(`src/server/services/category-groups.ts:279`), and that statement is what makes
the two schemas behave the same way. It deliberately does not bump the
category's `version`: the foreign key never did, and a cluster refusing an edit
a single node accepts is the same divergence one step along.

The obvious alternative is to let each schema do what it can — the key here, the
service there — and that is the bug rather than an economy. The behavior would
depend on which profile somebody deployed, and the profile that diverges is the
one almost nobody can reproduce.

**A table added after `0023` lands on the coordinator as a plain local table.**
`drizzle/0023_citus_distribution.sql:44` returns early once anything is
distributed. That is correct — `docs/citus-runbook.md` invites an operator to
feed the file to psql by hand, so it has to be safe twice — and it means the
migration will never pick up a table created after it ran. Nothing else picks it
up either: this repository sets no `citus.use_citus_managed_tables`, so the new
table is uncolocated, cannot carry a composite foreign key into a distributed
one, and is perfectly happy on every profile CI can run. `0023` is also the only
place the cluster's schema is written down, which is why a reader takes its list
for a standing description. It was a complete one exactly once, on the day it
was written.

*Checked by:* `tests/database-guide.test.ts` for the second half, in both
directions — every `pgTable` in `src/server/db/schema.ts` is named by `0023` as
either distributed or replicated, and `0023` names no table the schema has
stopped declaring. Proven by mutation: a table added beside `billing_override`
fails the first, a distributed name spelled differently fails both.
`tests/integration/category-group-cluster-fk.integration.test.ts` holds the one
worked case of the first half, and installs the cluster's foreign key on a
scratch database before asserting anything, because on the schema the rest of
the suite runs the key would do the service's work and the test would pass with
the statement deleted.

The first half in general is not mechanizable. "This profile cannot say it, so
the service says it everywhere" is a judgement about where a rule belongs, and
review is what makes it. §5 carries it.

## 2. Columns

### 2.1 Money is `numeric(44, 18)`

**Binding.** `AGENTS.md`. Every amount column, without exception
(`src/server/db/schema.ts:293`).
Drizzle returns `numeric` as a string, which is exactly what the rest of the
codebase wants, so nothing casts.

The scale looks absurd for currency and is not for exchange rates, which is what
`effectiveRate` holds in the same precision.

*Checked by:* `tests/integration/migrations.integration.test.ts`, which asks a
migrated database what `posting.amount` really is rather than reading the
migration text back — `numeric`, precision 44, scale 18. That is the column every
balance is summed from, and the only one it names: a money column added somewhere
else at some other scale would pass.

### 2.2 An enum column is generated from the shared tuple

**Binding.** `pgEnum` takes the same `as const` array the domain and the UI use
(`src/server/db/schema.ts:199`), so there is no second list of the members —
with one exception the next paragraph owns up to.

*Checked by:* `npm run typecheck`, in both directions. A member the schema drops
is refused where a parsed value is inserted, and one the schema adds alone is
refused where a stored row is read back into shared-typed code. A copy that
agrees today is caught as well, because each of these fifteen tuples is named
exactly once outside its import, so writing the members out again leaves the
import unread and `noUnusedLocals` fails — which holds by arithmetic rather
than by design, and would stop holding the day a tuple earns a second use in
the file.

`staged_status` was the exception and no longer is. It was an inline literal
with no shared tuple behind it, written out again in
`src/server/mcp-output-schemas.ts` and `src/client/api.ts`, so the mechanism
above could not fire for it: the inline literal imports nothing for
`noUnusedLocals` to catch, and a member added to the `pgEnum` alone would have
surfaced only when a tool's output validation refused the reply in front of an
agent. It now reads `stagedStatuses` from `src/shared/domain.ts`, like the other
fourteen.

*Also checked by:* `tests/closed-sets.test.ts`, which refuses any `pgEnum` given
an array literal rather than an identifier. That is the half `npm run typecheck`
structurally cannot do — `pgEnum` takes an array, so a fourth value added to the
tuple and not to the enum compiles everywhere and is refused by the database at
run time — and it is what stops a sixteenth enum arriving the way this one did.

`billing_subscription.status` is the one column that deliberately is not an enum
and argues for itself in the schema: the set is Stripe's rather than ours, and a
`pgEnum` would refuse to store what Stripe actually said.

### 2.3 Every user-owned table carries `userId`, and every read of one is scoped by it

**Binding.** `AGENTS.md`: "Never accept a public `userId`. Derive it from the
authenticated `Actor`, and scope every finance read/write by that ID." The one
rule in this file whose violation is a security incident rather than a bug.

"Every query filters on it" is how this read, and there is now exactly one
correct unscoped read, so the absolute sentence had to go. A rule that admits no
exception on this subject has two futures and both are bad: somebody edits it
into something that cannot hold, or the next unscoped read gets waved through by
analogy to the one already there.

The exception is the webhook path, which has no actor at all. Stripe names a
customer; `src/server/services/billing.ts:484` reads `billing_customer` by
`stripe_customer_id` alone to find out whose it is. There is nothing to scope it
by, because this read is *how* the user is derived. It is safe for one reason,
and the reason is what a second unscoped read would have to supply too:
`src/server/db/schema.ts:1445` makes `stripe_customer_id` unique across the
table, and the value is issued by Stripe rather than typed by anybody, so the
row it returns is the only row it could return. A read keyed on something a
person can choose has no such argument, and everything downstream of this one is
scoped again by the id it produced.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts`.

## 3. Queries

### 3.1 A grid query lives in one place

**House.** Budgets and reports both bucket money by period, and they do it with
one shared query builder in `src/server/services/report-sql.ts` rather than two
that agree today. `PERIOD_STEPS` and `PERIOD_UNITS` live beside it, so "what is
a month" has one answer.

This is the result of an actual divergence: the budget report was written with
its own bucketing and got the period boundaries subtly different from the
reports page.

### 3.2 A period is snapped, and a stored period start is a name

**Binding.** Both ends of a plan's window are snapped to period starts on write.
A stored `periodStart` is therefore a **name for a period**, not a boundary to
compare dates against.

The read side widens spending to whole periods at **both** ends
(`src/server/services/budgets.ts:1181`):

```sql
and p.date >= date_trunc(${unit}, ${queryStart}::date)::date
and p.date <= ${countedTo}::date
```

Widening one end and not the other is a defect that survived two rounds of
review, because it only shows when the range starts mid-period: a month's limit
compared against part of a month's spending, and every figure looks plausible.

*Checked by:* `tests/integration/budgets.integration.test.ts`, and in
particular its `describe.each` over the four period units. Each unit gets one
plan starting mid-period and one override named by a day inside a period, and
asserts the plan covers the period its start falls in and no earlier one, with
the dates read back from what the service snapped rather than computed by hand.
Eight cases, not every (plan, period) pair: a window starting mid-period is the
shape the defect needed, and every other test that reports a figure is monthly.
The only two naming another unit ask for a refusal and for the list of units a
monthly report left out, so neither could have seen it.

### 3.3 `ORDER BY` cannot see an expression over a `UNION`'s output

**Binding**, by PostgreSQL. This is a note rather than a rule because it is a
thing you have to learn once:

```sql
-- refused: (category_id is null) is an expression over an output column
select ... union all select ... order by (category_id is null), name
```

Wrap the union in a subquery and select the flag as a column. The budget report
does exactly that.

*Checked by:* `tests/integration/budgets.integration.test.ts`, which runs the
union arm in nearly every case because `includeUnbudgeted` defaults to true, so a
regression comes back as `invalid UNION/INTERSECT/EXCEPT ORDER BY clause` rather
than as a wrong order. It covers this query, not the trap: a union written where
no test runs one is refused just as loudly, in front of somebody using the
product.

### 3.4 A count is `::int`

**House.** `count(*)` comes back as a string, because PostgreSQL's `bigint`
does not fit a JS number. Where the count is genuinely small — rows a user owns —
cast it in SQL (`sql<number>\`count(*)::int\``) rather than parsing it in
JavaScript. Where it might not be small, keep it a string.

*Checked by:* `tests/count-casts.test.ts`, which knows which of the two each
count in this schema is rather than refusing every `count(*)` it finds, and
reads the SQL with comments blanked, because `count(*)` appears in three of them
as prose.

### 3.5 Nothing computes money from `ledger_transaction`

**Binding.** `AGENTS.md`: "Never compute a monetary figure from
`ledger_transaction` columns." Balances, cash flow and spending all read the
posting table. The transaction row holds what somebody typed; the postings hold
what the books say, and after a correction those differ on purpose.

*Checked by:* `tests/integration/account-balances.integration.test.ts`, which
keeps a voided 999 deposit in its fixture and expects a balance that leaves it
out. The transaction row still says 999 while its postings net to zero, so a
balance read from the wrong table is wrong by exactly that. One figure, though:
nothing reads the source, so a report written tomorrow is covered only once
somebody gives it a case where the two tables disagree.

### 3.6 A `GROUP BY` names the whole key it leans on

**Binding**, by PostgreSQL, and not about the cluster at run time at all.

PostgreSQL lets a select list name a column that is functionally determined by
the grouping, and only when the grouping covers the **whole** primary key.
`src/server/services/accounts.ts:526` groups by `a.user_id, a.id` and selects
`a.*`. Under the key `0023` installs — `(user_id, id)` where the single-node
schema has `(id)` — a grouping on the id alone determines nothing, and the
statement fails with `column "a.name" must appear in the GROUP BY clause`.
Widening the key to carry the owner is what turns a legal query into an error,
so this is a plain-PostgreSQL rule that happens to be triggered by a migration.

Five sites were found this way and all five name both columns:
`src/server/services/accounts.ts:526` and `:631`,
`src/server/services/summary.ts:59`, and the two written in Drizzle's builder,
`src/server/services/category-groups.ts:74` and
`src/server/services/import-export.ts:195`.

The obvious alternative is to leave it until there is a cluster to fail on.
Grouping by the id alone is legal today, passes the entire suite, and breaks the
moment one exists; naming both is correct under either key and costs a word,
because `user_id` is already fixed by the `WHERE` above. That is why the fix
shipped long before the migration did — and why the suite could never have found
it, since the suite runs the narrow key and a new site is legal everywhere it is
exercised.

A grouping that names every column the statement reads leans on nothing and
needs no owner: `src/server/services/summary.ts:123` groups `c.id, c.name` and
selects exactly those two. The rule is about the dependency, not about the word.

*Checked by:* `tests/database-guide.test.ts`, which reads both spellings and
reads the select list beside each grouping, so it asks for the owner only where
the statement reads a column the grouping does not name. Proven by mutation in
both spellings, and it holds its own population, because a scan that stopped
matching would pass in silence. What it cannot see is a grouping by ordinal —
`group by 1, 2` names no column at all, and the select list it refers to is
positional.

## 4. Locks

### 4.1 Uniqueness by name takes an advisory lock, not a unique index

**House, with a reason.** Names are compared after normalization — case folded,
whitespace collapsed, NFKC — so a unique index on the raw column would not
express the rule. The lock serializes the read-then-create
(`src/server/services/helpers.ts:242`), and it is scoped per user so two people
naming a category at once do not queue behind each other.
`src/server/services/helpers.ts:320` is the account namespace's, taken by every
path that changes the live set.

*Checked by:* `tests/name-locks.test.ts` for the shape, and
`tests/integration/account-limit.integration.test.ts` for the account
namespace, which races it four times for real: two creates, a restore against a
create, two restores, and a restore against the one-time active choice. Each
wants exactly one winner. §5 carries what is left, which is the name half
specifically.

### 4.2 Migrations run under an advisory lock at startup

**Binding.** `AGENTS.md`. Startup is the only production migration path, so two
instances starting together must not both migrate.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.2 A name rather than a generator's slug | A test holds a name steady once it is written; none can tell a chosen name from a generated one. |
| 1.3 Additive by default | Ten of the twenty-six migrations are asserted additive one file at a time, which is not the same as holding the rule: the twenty-seventh is read by nobody. A migration linter could catch `drop column` in it; none exists. |
| 1.6 The service standing in for what a profile's schema cannot say | Its second half is checked. Its first is a judgement about where a rule belongs, and the only thing that makes it is somebody knowing both profiles. |
| 3.1 One grid query | Nothing stops a second one being written. |
| 4.2 Migrations under a lock | Only a second process starting against the same database at the same moment can tell the lock is there, and nothing starts one. The suite runs `runMigrations()` and would run it unlocked just as happily. |

4.1 used to be a row here, and its stated reason was wrong rather than merely
out of date: "a missing lock produces a rare duplicate, which no test
will reliably reproduce" is true of a name and false of a count.
`tests/integration/account-limit.integration.test.ts` races the account
namespace lock four times, and each race is deterministic in the direction that
matters — without the lock both transactions read the same count and both
succeed, so the test fails every run rather than rarely. What stays a person's
job is narrower than the row claimed: the name comparison itself, where two
transactions each find a normalized name free and the duplicate they leave is
a row rather than a count.

Five `human` rules in this guide, the same number as before and not the same
five. 1.6 arrived with one half mechanized and one half not; 4.1 left, because
the thing it said could not be tested is tested four times over.
`tests/count-casts.test.ts` still holds 3.4, and it knows the shapes this schema
actually writes rather than refusing every `count(*)` it sees.
