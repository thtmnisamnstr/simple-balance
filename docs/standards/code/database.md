# Database

Drizzle, PostgreSQL, and the traps this schema has actually hit.

PostgreSQL is the only supported database. There is no abstraction layer over
it and there should not be one: the reports lean on `date_trunc`, `generate_series`
and `numeric`, and pretending otherwise would cost more than it bought.

## 1. Migrations

### 1.1 A shipped migration is frozen

**Binding.** `AGENTS.md`: "Every migration that has shipped is frozen." Fourteen
migrations, `0000_initial.sql` through `0013_budget_plans_and_entries.sql`. A
change is a new forward-only migration, generated with `npm run db:generate`.

*Checked by:* `tests/migrations.test.ts`, which reads the list out of
`AGENTS.md` and fails when the directory and the list disagree — in both
directions, so an unnamed migration is as much a failure as a missing file.

### 1.2 A migration has a name, not a number and a slug from a generator

**House.** `0013_budget_plans_and_entries.sql` says what it did. Drizzle's
default names it after a Marvel character. Rename it on generation, and record
it in `AGENTS.md` in the same change.

*Checked by:* `tests/migrations.test.ts`.

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
(src/server/db/schema.ts:273).
Drizzle returns `numeric` as a string, which is exactly what the rest of the
codebase wants, so nothing casts.

The scale looks absurd for currency and is not for exchange rates, which is what
`effectiveRate` holds in the same precision.

### 2.2 An enum column is generated from the shared tuple

**Binding.** `pgEnum` takes the same `as const` array the domain and the UI use
(src/server/db/schema.ts:194).
There is no second list of the members anywhere.

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

*Checked by:* `tests/integration/budgets.integration.test.ts`, including an
exhaustive pass over every (plan, period) window pair.

### 3.3 `ORDER BY` cannot see an expression over a `UNION`'s output

**Binding**, by PostgreSQL. This is a note rather than a rule because it is a
thing you have to learn once:

```sql
-- refused: (category_id is null) is an expression over an output column
select ... union all select ... order by (category_id is null), name
```

Wrap the union in a subquery and select the flag as a column. The budget report
does exactly that.

### 3.4 A count is `::int`

**House.** `count(*)` comes back as a string, because PostgreSQL's `bigint`
does not fit a JS number. Where the count is genuinely small — rows a user owns —
cast it in SQL (`sql<number>\`count(*)::int\``) rather than parsing it in
JavaScript. Where it might not be small, keep it a string.

### 3.5 Nothing computes money from `ledger_transaction`

**Binding.** `AGENTS.md`: "Never compute a monetary figure from
`ledger_transaction` columns." Balances, cash flow and spending all read the
posting table. The transaction row holds what somebody typed; the postings hold
what the books say, and after a correction those differ on purpose.

## 4. Locks

### 4.1 Uniqueness by name takes an advisory lock, not a unique index

**House, with a reason.** Names are compared after normalisation — case folded,
whitespace collapsed, NFKC — so a unique index on the raw column would not
express the rule. The lock serialises the read-then-create
(src/server/services/helpers.ts:255),
and it is scoped per user so two people naming a category at once do not queue
behind each other.

### 4.2 Migrations run under an advisory lock at startup

**Binding.** `AGENTS.md`. Startup is the only production migration path, so two
instances starting together must not both migrate.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.3 Additive by default | A migration linter could catch `drop column`; none exists. |
| 3.1 One grid query | Nothing stops a second one being written. |
| 3.4 Counts are cast | Grep-able, not grepped. |
| 4.1 Locks before name reads | A missing lock produces a rare duplicate, which no test will reliably reproduce. |

Four `human` rules in this guide.
