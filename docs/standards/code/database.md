# Database

Drizzle, PostgreSQL, and the traps this schema has actually hit.

PostgreSQL is the only supported database. There is no abstraction layer over
it and there should not be one: the reports lean on `date_trunc`, `generate_series`
and `numeric`, and pretending otherwise would cost more than it bought.

## 1. Migrations

### 1.1 A shipped migration is frozen

**Binding.** `AGENTS.md`: "Every migration that has shipped is frozen."
Twenty-one migrations, `0000_initial.sql` through `0020_reference_indexes.sql`.
Frozen is about shipping, not about existing: `0000` through `0012` went out in
released versions and may never change, while `0013` through `0020` are written
and unreleased, so `AGENTS.md` says they may still be regenerated — they freeze
when they ship. A change to what has shipped is a new forward-only migration,
generated with `npm run db:generate`.

*Checked by:* `tests/migrations.test.ts`, which reads `AGENTS.md` as text and
fails on any `.sql` in `drizzle/` the prose does not name. That is one
direction, and it is the one that went wrong: the prose stopped at 0012 while
the directory held 0013. The other direction is not covered. A file deleted on
its own is caught by the journal and snapshot counts beside it, but a name left
in `AGENTS.md` after its file, its journal entry and its snapshot have all gone
passes, so the frozen list can still outlive what it lists.

### 1.2 A migration has a name, not a number and a slug from a generator

**House.** `0013_budget_plans_and_entries.sql` says what it did. Drizzle's
default names it after a Marvel character. Rename it on generation, and record
it in `AGENTS.md` in the same change.

*Checked by:* nothing that reads a name for what it says. The recording half is
held by 1.1: a freshly generated file that nobody listed fails the moment it
lands in `drizzle/`. `tests/migrations.test.ts` also pins the first five
journal tags to the words they shipped with, and holds every later file to its
own tag, so a rename after the fact fails. What no test does is tell
`0021_budget_carryover` from `0021_lucky_moon_knight`: both are strings it has
not seen before, and only review stands between the second one and the
directory. §5 carries this.

### 1.3 Additive by default

**House.** A migration adds tables, columns and indexes. Dropping a column is a
separate decision from the change that stopped using it, and they do not belong
in one migration: the deploy that stops writing a column and the deploy that
drops it should be far enough apart that a rollback is possible in between.

### 1.4 A new table names its cascade

**Binding.** `AGENTS.md`. Account deletion enumerates the tables it clears, and
nothing enumerates them for it. A table added without its cascade makes deletion
fail rather than silently orphan rows, which is the right failure and still a
bug.

*Checked by:* `tests/integration/account-deletion.integration.test.ts`.

## 2. Columns

### 2.1 Money is `numeric(44, 18)`

**Binding.** `AGENTS.md`. Every amount column, without exception
(`src/server/db/schema.ts:287`).
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
(`src/server/db/schema.ts:196`), so there is no second list of the members —
with one exception the next paragraph owns up to.

*Checked by:* `npm run typecheck`, in both directions. A member the schema drops
is refused where a parsed value is inserted, and one the schema adds alone is
refused where a stored row is read back into shared-typed code. A copy that
agrees today is caught as well, because each of these twelve tuples is named
exactly once outside its import, so writing the members out again leaves the
import unread and `noUnusedLocals` fails — which holds by arithmetic rather
than by design, and would stop holding the day a tuple earns a second use in
the file.

The exception is `staged_status` (`src/server/db/schema.ts:198`), an inline
literal with no shared tuple behind it, whose three members are written out
again in `src/server/mcp-output-schemas.ts:296` and
`src/client/api.ts:340`. Nothing in `src/shared` lists staged statuses, so the
mechanism above cannot fire for it: the inline literal imports nothing for
`noUnusedLocals` to catch, and a member added to the `pgEnum` alone surfaces
only when a tool's output validation refuses the reply in front of an agent.
Give it a shared tuple the day it changes; until then it is the one enum drift
the typechecker will not see coming.

### 2.3 Every user-owned table carries `userId`, and every query filters on it

**Binding.** The one rule in this file whose violation is a security incident
rather than a bug.

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

The read side widens spending to whole periods at **both** ends:

```sql
and p.date >= date_trunc(${unit}, ${start}::date)::date
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

## 4. Locks

### 4.1 Uniqueness by name takes an advisory lock, not a unique index

**House, with a reason.** Names are compared after normalisation — case folded,
whitespace collapsed, NFKC — so a unique index on the raw column would not
express the rule. The lock serialises the read-then-create
(`src/server/services/helpers.ts:263`),
and it is scoped per user so two people naming a category at once do not queue
behind each other.

### 4.2 Migrations run under an advisory lock at startup

**Binding.** `AGENTS.md`. Startup is the only production migration path, so two
instances starting together must not both migrate.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.2 A name rather than a generator's slug | A test holds a name steady once it is written; none can tell a chosen name from a generated one. |
| 1.3 Additive by default | A migration linter could catch `drop column`; none exists. |
| 3.1 One grid query | Nothing stops a second one being written. |
| 4.1 Locks before name reads | A missing lock produces a rare duplicate, which no test will reliably reproduce. |
| 4.2 Migrations under a lock | Only a second process starting against the same database at the same moment can tell the lock is there, and nothing starts one. The suite runs `runMigrations()` and would run it unlocked just as happily. |

Five `human` rules in this guide, two more than it used to say. 4.2 was never
counted, and 1.2 was counted as checked because a test with `migrations` in its
name sits beside it and does check its other half. Both are the same defect:
nothing held the rule and nothing said so.
`tests/count-casts.test.ts` still holds 3.4, and it knows the shapes this schema
actually writes rather than refusing every `count(*)` it sees.
