# Roadmap

What is planned, in the order it is planned, and the evidence each item rests
on. Stories continue the numbering in `tasks/product.prd.json`, which records
the product as built rather than the product as intended; nothing here is
committed to until it moves there.

Two questions decide whether something belongs on this list. Does it make the
product more complete? And does it make it simpler to explain? A feature that
only answers the first is how a ledger turns into a suite.

## Where the evidence comes from

Two research passes in August 2026, each fanning out across web sources and then
putting every claim to independent reviewers whose task was to refute it. A
claim needed to survive that to appear here. Where a pass failed to establish
something, this document says so rather than filling the gap.

The first pass covered the self-hosted and open-source field: Firefly III,
Actual Budget, and the plain-text accounting engines (Ledger, hledger,
Beancount). The second covered the commercial products: Monarch, YNAB, Copilot,
Quicken Simplifi, Rocket Money, PocketGuard, PocketSmith.

**Not established, and not to be treated as covered:** Empower Personal
Dashboard, Credit Karma, NerdWallet, EveryDollar, Lunch Money, Tiller, Quicken
Classic, and where Mint's users went after it shut down. Also unestablished, and
material: whether the commercial products are usable at all without a bank
connection. Only two data points survived on that, so the manual-entry
comparison in this document rests on less than it should.

### What the field looks like

The commercial products cost roughly **$75 to $200 a year** for one household.
Verified against vendor pricing pages: Monarch Core $99.99, Monarch Plus ~$199,
Copilot $95, PocketGuard Premium $74.99, Quicken Simplifi ~$47.88 in the first
year and ~$83.88 at the standard rate. Simplifi's list price has gone from $29
in 2021 to $83.88 in 2026, and its own page says renewals bill "at the
then-current rates". Two of them charge for the exit: Rocket Money puts CSV
export behind Premium, and PocketGuard gates both import and export, delivering
export as a link that expires in 24 hours.

None of the products examined is double-entry. They are single-entry categorized
registers with budget overlays, which is why so much of what they do has no
analog here and needs none.

Agent access is not the differentiator it looked like. **Firefly III has around
ten community MCP servers and Actual Budget at least two**, and **PocketSmith
ships a genuine first-party one** — verified at the protocol level, not from its
marketing: OAuth 2.0 with PKCE, RFC 9728 discovery, dynamic client registration.

What holds up is narrower and worth stating precisely. No competitor has more
than two permission tiers, and **none has a staging tier in any form**.
PocketSmith picks its tier by hostname (57 tools at one, 38 read-only at
another) and publishes no `scopes_supported`, so an assistant sees every tool
whatever it may call. Firefly III cannot offer scopes at all: its Laravel
Passport install registers none, so every token carries the user's full API
rights. Monarch publishes no developer API — `monarch.com/developers` is a 404 —
so its community servers authenticate by copying the browser's `cookie:` header
out of DevTools, register every mutating tool unconditionally, and pass merchant
names to the model unsanitized. The leading one's README suggests the fix:
configure your client to require manual approval before any mutating tool runs.
That is a staging tier, asked for as a client setting because the server has
nowhere to put it.

---

## SB-017 — Split transactions — **done**

**Priority 160. Depends on SB-015. Shipped as migration 0005.**

One transaction, several category legs, still settling to zero in each currency
it touches. The grocery receipt that is partly food, partly household, partly
something else.

The ledger is ready for this. Arbitrary balanced posting sets are already
validated before anything is written, and cross-currency settlement already
routes through the exchange account, so a split is cardinality inside a shape
rather than a fourth shape. What it costs is everything around the ledger: the
entry form, the CSV round trip, and making mass edit and the fingerprinted
selection mean something sensible when a row has several legs.

It is parity rather than differentiation. Firefly III, Actual, and every
commercial product examined have it, and a double-entry ledger that cannot
represent one receipt across three categories is hard to defend as one.

**Acceptance criteria**

- A transaction may carry several category legs whose amounts sum to its total
- Every existing invariant holds unchanged: zero-sum per currency, append-only
  postings, corrections as deltas, deletion as reversal
- Spending by category attributes each leg to its own category
- CSV export of a split reads back as the same split, with no legs lost or
  merged
- Mass edit either handles split rows correctly or refuses them explicitly, and
  never silently flattens one
- A split is editable back down to a single leg, and a single-leg transaction is
  not shown as a split
- Reachable over MCP, with the leg structure in the tool schema rather than
  implied

**How it was met**

A split is the counter-account side of one entry cut into legs, each leg a row
in `transaction_leg` carrying one category and one amount, and each leg's share
posted under its own `posting.leg_id`. Because the legs *are* those postings,
the sum rule is the zero-sum check the ledger already ran, and every balance
query is unchanged. `assertLegsCoverTotal` adds no guarantee, only a sentence
about the receipt instead of one about postings.

Migration 0005 is additive only, so a ledger upgrading from 0.1.3 reads
identically the moment it finishes: every existing posting keeps a null leg and
goes on taking the transaction's own category.

Two decisions worth writing down rather than leaving implied:

- **A transfer carries no legs.** Both of its sides name an account, so there is
  no counter-account side left over for categories to partition. The draft
  schema, the check constraint and the form all refuse it rather than any one of
  them being the only guard.
- **Legs are deliberately out of the duplicate fingerprint.** That fingerprint
  answers whether the same money moved twice, and how somebody carved up the
  receipt afterward does not change the answer. Re-importing a statement has to
  keep catching rows that were split last month.

Mass editing category or type is refused on a split rather than flattening it,
on committed and staged rows alike, and both selection summaries report how many
splits are in the set. A split is editable back to one category, and a
single-leg transaction cannot be represented at all: the wire schema, the check
constraint and the form each fold it back to a plain category.

## SB-016 — Recurring transactions — **done**

**Priority 170. Depends on SB-015. Shipped as migration 0006.**

A recurrence is a saved shape, a schedule, and a policy for the awkward dates.
On its due date it puts an ordinary transaction onto Staged transactions, where
it waits with everything else until somebody commits it.

It proposes rather than posts, and that is the whole design. A scheduler that
writes to the ledger unattended is the one thing genuinely in tension with books
that are append-only and audited: it is a writer nobody watched, running when
nobody was there. Proposing into the queue removes the tension completely, and
makes the scheduler simply another thing that suggests work.

It also turns the failure mode inside out. Firefly III's recurrences fire only
when an operator-configured cron calls `firefly-iii:cron`, and forgetting that
entry is a frequent and frequently-reported way to end up with a ledger quietly
missing months of rent. A recurrence that proposes into a visible queue fails
where somebody can see it.

**Research.** Firefly III's own documentation says a recurring transaction "can
be a withdrawal, deposit or a transfer" — exactly the three shapes already
modeled here, so no new accounting primitive is required and generated rows
travel the same zero-sum validation as any other. Its how-to documents the
mechanics real creation needs and reminding does not: month-length fallback for
the 29th through 31st, four weekend policies, and skipping every N occurrences.
Firefly III itself draws the line between creating a transaction and reminding
you about a bill.

The claim that recurring transactions matter only to people who do not import
CSVs was put to three reviewers and **refuted 3-0**. It must not be used to
defer this.

The cost is the execution path rather than the schedule arithmetic. There is no
scheduler here at all today — no cron, no `setInterval`, no worker, nothing.

**Acceptance criteria**

- A recurrence names a shape, its accounts, an optional amount, a schedule, and
  policies for month length and weekends
- On its due date it writes an ordinary staged row, and never a posting
- A recurrence that has never run and one that ran and was discarded are
  distinguishable, so a silent scheduler is visible rather than inferred
- Catch-up after downtime proposes each missed occurrence once, and running the
  scheduler twice for the same occurrence proposes it once
- Generated rows carry no bank import reference, and are dated their occurrence
  rather than the day the scheduler happened to run
- A recurrence naming an account or category that no longer resolves proposes
  the row anyway, flagged, rather than failing silently
- Deleting a recurrence leaves rows already proposed or committed untouched
- Reachable over MCP under the same scope rules as everything else

**How it was met**

The scheduler runs inside the server process and is on by default, so the
documented single container keeps working with nothing added to it.
`RECURRENCE_SCHEDULER=false` turns it off on replicas that serve the API, which
is what a Kubernetes deployment does when it runs the scheduler container from
`deploy/docker/scheduler.Dockerfile`. Every replica sweeps the due list and
claims each recurrence with `for update skip locked`, so they divide the work
rather than wait on one another, and a per-occurrence unique key refuses a
second proposal of the same date even if a claim were bypassed entirely.

A recurrence naming an account that has since been archived or deleted proposes
its row anyway, with the issue against the field at fault rather than against the
draft as a whole. Nobody was watching when it fired, so the row itself has to say
what to fix.

Two decisions worth writing down rather than leaving implied:

- **No holiday calendar.** A business day means Monday through Friday, said in
  the tool description and beside the weekend-policy picker, because per-country
  holiday data aging inside a container nobody updates is worse than not having
  it.
- **A proposed row points back at its recurrence and is not owned by it.**
  `staged_transaction.recurrence_id` carries no foreign key, so deleting a
  recurrence leaves every row it already proposed alone. Two check constraints
  keep the provenance honest instead: `recurrence_id` and `occurrence_date` are
  null together or not at all, and a row may not claim both a recurrence and a
  bank import batch.

## SB-018 — Reporting — **done**

**Priority 180. Depends on SB-015. Shipped in 0.1.5, needing no migration.**

Net worth over time, income against expense, and category trends across a range.

This is the cheapest item on the list and among the most visible. Postings carry
their own dates, so a balance as of any past date is already an indexed range
query — the data has been there since the ledger was built and nothing reads it
back out. There is no write surface, no new invariant, and nothing an agent
could damage, which makes it the only item here with essentially no risk
attached.

The dashboard currently stops at balances, cash flow, and spending by category.

**Acceptance criteria**

- Net worth over a range, per currency, derived from postings alone
- Income against expense over a range, agreeing with the dashboard's cash flow
  for the same range and accounts
- Category trends over time, agreeing with the existing spending-by-category
  figures for a single period
- Every figure stops at today in the person's own timezone, like every other
  figure in the product
- Archived accounts are included or excluded consistently across every report,
  with a closed account contributing the zero it actually holds
- The range lives in the URL, as it does elsewhere
- Every report is reachable over MCP as a read tool

**How it was met**

One parameterized aggregation with named presets, after hledger: a statement is
a preset over one query differing by which accounts it reads, whether it reports
a period's movement or the balance it ends on, and how time is bucketed. That is
why six reports cost one route and one tool, and why the seventh will cost an
enum value.

Net worth is a vector, never a scalar. There is no exchange rate in this ledger,
so a figure spanning currencies could only come from the rates implied by
transfers already made — what those transfers cost, not what the money is worth.
The response has no field above `currencies` for such a number to occupy, so it
cannot be added back by accident.

Two things were measured rather than assumed, against a seeded ledger of a
hundred thousand postings on PostgreSQL 15 and 16. A balance series accumulates
with a window function over one pass of the postings; asking the database for a
balance as of each bucket's end instead is fifty times slower and worsens as the
series lengthens. And no index was added: the candidate for the register's
ordering costs fifteen megabytes, buys under a millisecond, and the planner
declines to use it. Both properties are pinned by plan assertions that price
sorts and sequential scans out of the way, so they answer whether an index can
serve the query rather than whether the planner bothers on a handful of rows.

**Beyond the criteria**

A cash flow statement, asked for after the plan was drawn. It is the direct
method — the movements themselves, not net income adjusted for non-cash items,
which would need accruals this ledger does not record. Its segmentation is
structural rather than a classification anybody maintains: every posting on a
spendable account belongs to a transaction whose other side in the same currency
names exactly one account, and that account's type decides whether the money was
earned, invested, borrowed, moved between your own accounts, or converted. It
goes further than the field ships — hledger and GnuCash segment nothing, and
Fava has no cash flow report at all — so it carries its one caveat on the page:
it will not agree with income and expense wherever a credit card is involved,
and both figures are right.

Also a per-account register, which Firefly III positions as an error-finding
tool rather than an analytical one, and the two canonical statements every
strict double-entry tool ships. The balance sheet is net worth with one column,
and the trial balance is the same query with the counter-accounts left in, so
both were nearly free once the engine existed.

## SB-019 — Budgeting — **done**

**Priority 190. Depends on SB-018. Built, unreleased, and carrying migration
0013.** The first of six. SB-025 to SB-029 are the other five and are all built,
carrying migrations 0014 to 0019 between them, with 0020 adding the indexes the
audit priced. 0021 is not part of this arc: it indexes the idempotency keys a
deployment may now prune.

Every kind of budgeting, from one model. That sounds like scope and it is
mostly arithmetic: of the sixteen rows in the table below, four need no storage
at all, five are one column each, two share a column, the sinking fund takes
two, and the rest are the same two tables — and the group table — read
differently. The expensive decision was never which methods to support. It was
whether an assignment is a posting, and it is not.

**A method is not a mode anybody picks.** There is no method chooser and the
word does not appear in the product. Set two hundred a month on Groceries and
that is a category limit, without hearing a name for it. Turn rollover on for
that category and it is an envelope. Set its amount from a rule instead of a
number and it is a trailing average. Put it in a group with a percentage and
that group is 50/30/20. The unit of choice is the category, because a global
mode forces a durable selector, a migration path, and a totals row that means
two different things depending on it.

### The fourteen methods, and where each one went

Sixteen rows for fourteen named methods, because the build added two the survey
had folded into others: an amount for one period only, and 50/30/20 as a
reading of three groups.

All six stories are built, so the claim at the top of this section can be
checked rather than promised. Nothing below is a mode: each is what the product
does when a plan carries a particular parameter.

| Method | How it is done | What it needed |
| --- | --- | --- |
| A limit per category per period | A plan with an amount | SB-019 |
| An amount for one period only | A `budget_entry` | SB-019 |
| Rollover budgeting | `rollover` on the plan | SB-025, one column |
| A cap on what carries | `rollover_cap` | SB-025, one column |
| Sinking funds | `target_amount` with `target_date` | SB-025, two columns |
| Trailing average | `rule_lookback` | SB-026, one column |
| Incremental budgeting | `rule_percent` as a step on the period before | SB-026, shares a column |
| Percent-of-income | `rule_percent` as a share of the period before's income | SB-026, shares a column |
| Priority-order funding | `priority` | SB-026, one column |
| Pay yourself first | A savings category ranked first | SB-026, no storage |
| Anti-budget | Budget the savings and rank it first; leave the rest unbudgeted | No storage |
| Bucket and flex budgeting | A group with its own budget | SB-027 |
| 50/30/20 | Three groups, each with its own budget | SB-027, no extra storage |
| Hierarchical budgeting | A group budgeted as the sum of its categories | SB-027 |
| Zero-based envelopes | Rollover, plus what is left to assign | SB-028, one column |
| Forecasting | A projection over recurrences and plans | SB-029, no storage |

Four need no storage at all, five are one column each, two share a column, the
sinking fund takes two, and the rest are the same two tables — and the group
table — read differently: which is what "mostly arithmetic" meant when this
section was written before any of it existed.

### The model

**As designed, across the six stories.** `budget_plan` is the standing
instruction for one target: how the amount is decided, whether it rolls over,
its funding priority, and the window it is active in. One row covers every
period, so nothing is materialized and no scheduler writes a budget figure.
`budget_entry` is an explicit amount for one target in one period, which is the
exception rather than the rule: three hundred for December only is a row, two
hundred a month is not. `category_group` is one level of grouping, and a target
is a category or a group, never both.

Resolving an amount is three lines. An explicit entry wins; otherwise the plan's
rule is evaluated; otherwise nothing is budgeted and the row shows what was
spent against no limit.

**As built, in this story.** `budget_plan` carried the amount, the period unit,
the currency and the window, and nothing else: no rule column, no rollover flag,
no priority. `budget_entry` was the per-period override, as designed. There was
no `category_group` table. Resolving an amount was therefore two of the three
lines — an explicit entry wins, otherwise the plan's amount, otherwise nothing
is budgeted.

**As built across all six.** The third line arrived with SB-026, and the model
is now the one this section describes: a plan says how the amount is decided
(fixed, a trailing average, last period plus a percentage, a share of income, or
a sinking fund's own arithmetic), whether it rolls over and how far, its funding
priority, and the window it is active in. A target is a category or a group.
`category_group` exists with the one-level rule and the two policies. Nothing
materializes a period, nothing stores a carry, and no budget figure comes from
anywhere but plans, entries and postings.

### An assignment is not a posting

The acceptance criteria below used to say it was. That was written when
envelopes were hypothetical, and it is wrong.

Actual Budget implements the whole YNAB model with no postings and no stored
balance, and fava-envelope does the same inside a real double-entry journal. The
one system that does post assignments, refried, documents what it costs: the
movements "will wreak havoc with your (non-budgeting) expense reports", so every
assignment carries an automatic tag and ordinary reports exclude it. This ledger
would inherit that exclusion on every report built after this story, and a trial
balance that excluded something would not be a trial balance.

The schema also refuses the specific shape. `ledger_account_system_kind_unique`
permits one equity account per user per currency, accounts have no parent
column, and no transaction may name a counter-account as a side. Envelopes as
equity sub-accounts means amending an index from the initial migration and
relaxing a rule recorded as non-negotiable. It would also cost the property that
relabeling a leg writes no postings, because depleting an envelope by posting
would make recategorizing write compensating postings.

The justification the plan rested on does not hold either. Equity sub-accounts
are not how plain-text accounting has always done it: hledger's three placements
are real accounts, virtual subaccounts of a real account, and virtual accounts
off to the side, and the only primary source using equity is the Ledger manual,
which uses balanced virtual postings behind a `--real` escape hatch this ledger
does not have.

The counter-argument is real and is recorded rather than dropped. Postings would
put an envelope balance in the trial balance and in the audit log as a movement,
and for a product whose argument is auditability that is a genuine benefit. It
is a choice, and the evidence runs the other way.

### What refunds cost, settled first

A budget that cannot see a refund is wrong in the way somebody notices first,
and until this story the ledger could not represent one: a deposit's other half
always credited income, so thirty dollars back from the store raised income
instead of lowering groceries.

Settled before any budget code, as its own change. A deposit credits income and
a withdrawal debits expense only when no category contradicts it. A category
whose kind runs against the direction makes the entry a refund, and its other
half goes to the counter-account the direction would not have chosen. The rule
is one function the browser previews and the services enforce. An entry naming
an income category and an expense category at once is refused, because two
counter-accounts would be two movements and only one of them is the one somebody
entered, and a bulk edit will not turn rows into refunds for the same reason it
will not flatten a split.

Nothing in the reports needed changing, which is the part worth recording. Both
counter-accounts already segment as operating in the cash flow statement, and
spending by category already sums signed postings, so a refund lowers the
category it came from without any figure being taught what a refund is.

### Acceptance criteria

- A limit is set per category per period and compared against spending computed
  the same way the reports compute it
- Deleting or archiving a category leaves no orphaned limit, and a limit is
  never a reason a category cannot be deleted
- Nothing in this story writes a posting, and no budget figure is derived from
  anything except postings, plans and entries
- An assignment is not a posting, and a rollover is derived rather than stored
- A standing budget needs no row per period and nothing materializes one
- Reachable over MCP, reads and writes on the same scope rules as everything else

**How it was met**

The budget is a standing rule and the period is the unit. A plan covers
every period in its window from one row, both ends snapped to whole periods in
PostgreSQL rather than in JavaScript, so a limit and the spending it is compared
against cannot land on different months. Nothing materializes a period and no
scheduler writes a budget figure, which is what makes an open-ended budget one
row rather than one row a month forever.

Spending is the reports' own query. It sums signed postings on the expense
counter-account over the same `date_trunc` grid the reports bucket by, so a
refund is negative and lowers the category it came back to, a split attributes
each leg through its own `leg_id`, and a transfer contributes nothing — none of
which needed a rule of its own, because none of them is a special case once the
figure comes from postings.

Two decisions worth writing down rather than leaving implied:

An assignment is not a posting, and the acceptance criteria above used to say it
was. Actual Budget implements the whole YNAB model with no postings, and the one
system that does post assignments documents what it costs. This ledger would
have inherited that cost on every report built after this story.

Archived accounts are counted, unlike every other report. Elsewhere an archived
account's balance is closed out and leaving it in would double count; a budget
was never scoped to an account, so money spent on a card since closed is money
the budget covered, and filtering it makes a budget spent to the penny read as
underspent.

## SB-031 — Sign-in on better-auth 1.7

**Priority 195. Next, alongside SB-032. Depends on nothing; lifts two holds in
`.github/dependabot.yml`.**

Every security fix better-auth publishes now lands on 1.7 only, and this product
is pinned to 1.6.33, the last of the 1.6 line. Four advisories against it were
published on 2026-10-27, each fixed in 1.7 and in no 1.6 release:

| Advisory | Severity | Needs | Reaches this product |
| --- | --- | --- | --- |
| [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm), an OAuth state accepted as a Magic Link token | Critical | The Magic Link plugin | No: `src/server/auth.ts` enables only `mcp()` |
| [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf), the OAuth Proxy trusting any profile it can decrypt | High | The OAuth Proxy plugin | No |
| [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm), device login approval not naming the client | High | `deviceAuthorization()` | No |
| [GHSA-44jh-23m7-hpcf](https://github.com/advisories/GHSA-44jh-23m7-hpcf), database rate limits exceeded by concurrent requests | Low | Rate limits stored in PostgreSQL through the Drizzle adapter | **Yes**: sign-in limits are counted in PostgreSQL so every replica shares them, and a burst of simultaneous attempts can pass the limit by about the number of concurrent connections |

None of the four is a reason to rush and all of them together are a reason not
to wait, because the next one may need nothing this product lacks.

It is a story rather than a version bump because 1.7 is a minor by its number
and a rewrite by its contents, which is why `.github/dependabot.yml` holds it.
The MCP plugin moves out into `@better-auth/mcp`, so `mcp`, `withMcpAuth`,
`oAuthDiscoveryMetadata` and `oAuthProtectedResourceMetadata` no longer exist
on `better-auth/plugins` and the server does not compile against it. The
`oauthApplication` model is renamed `oauthClient`, two tables are new, and
`Account.issuer` wants a backfill, which here is a migration of this product's
own, `0027`, because every shipped one is frozen.

The design question to settle first is the rename under a rolling update. The
split deployment and the chart run two releases side by side while a rollout
moves, and a replica still on 0.2.2 reads `oauth_application` by that name. A
rename in one step breaks every agent's sign-in on the old replicas for the
length of the rollout; copying into the new table and keeping the old one until
the release after is the shape `AGENTS.md`'s upgrade rule asks for, at the cost
of two tables saying the same thing for one release.

**Acceptance criteria**

- better-auth at the then-current 1.7 in both manifests, and `npm audit` reports
  none of the four advisories above
- Every agent authorized before the upgrade keeps working after it: its
  dynamically registered client, its access token and its refresh token all
  survive, checked against a database written by 0.2.2 rather than a fresh one
- The discovery documents answer at every path they answered at, with the same
  narrowed scopes, and `tests/mcp-parity.test.ts` and the OAuth integration
  tests pass unchanged
- A rolling update from 0.2.2 leaves no replica, old or new, unable to sign an
  agent in at any point during it
- Concurrent sign-in attempts against the database-stored limit stop at the
  limit, held by an integration test that fires them at once
- Local and Google sign-in, the first-account claim, `ALLOWED_EMAILS` and the
  setup code behave exactly as before; `tests/auth-policy-paths.test.ts` passes
  unchanged
- Both holds in `.github/dependabot.yml` are lifted in the same change:
  better-auth's own, and vitest 5's, which exists only because 1.6's peer range
  makes the npm that ships with Node 22 crash `npm ci`

## SB-032 — Budgets, the next round

**Priority 196. Next, alongside SB-031. Depends on SB-019 and SB-025 through
SB-029.**

Scope not decided. The owner named budgets as the next area to grow once the
budgeting arc had shipped, and this entry holds its place in the order until
there is something to write in it. It gets its evidence and its acceptance
criteria before anything is built, like every item above it; the table under
SB-019 of what each method needed is where the design starts, since it records
what the model already covers without a mode of its own.

## SB-033 — CSV export and import across accounts

**Priority 197. Next, alongside SB-031 and SB-032. Depends on nothing; reverses
a rule in `docs/standards/csv.md` §6, on the record.**

A CSV export can already cover every account: the Transactions page exports
whatever its filters show, and with no account filter that is the whole ledger.
What the file does not do is say plainly which account a row belongs to. It
names accounts in four columns split by direction — `source_account_name` and
`source_account_id` for money leaving, `destination_account_name` and
`destination_account_id` for money arriving — so a deposit's account is in one
pair, a withdrawal's in the other, and a transfer's in both. Correct, and not
something a person filtering a spreadsheet by account can use without knowing
the convention.

The import is the harder half. Every CSV import lands in one account, chosen on
the page or passed as `defaultAccountId`, and the four account columns are
written and deliberately never read: they name accounts in the ledger the file
came from, which a different account, person or install resolves none of
(`docs/standards/csv.md` §6). `tests/integration/import-export.integration.test.ts`
holds it ("posts an export against the account chosen for the import"). So a
whole-ledger CSV can only come back one account at a time, by hand, and a bank
or another product's export that lists several accounts in one file has to be
split before it can be imported at all.

The Simple Balance file already moves whole ledgers with their accounts. This is
for the CSV: the file people open in a spreadsheet, and the file other products
write.

**What the design has to settle**

- **An account column a person can read**, one per row, written beside the four
  that exist. It goes outside the recognition set, because adding to that set
  would stop every file written so far from being recognized
  (`docs/standards/csv.md` §6, "The recognition set is frozen").
- **How a name in the file finds an account here.** The rule already exists for
  categories and payees (`docs/standards/csv.md` §9): `normalizeHumanName`. What
  is new is what the preview offers for a name that matches nothing: use an
  account here, create one, or leave its rows for review — the choices a Simple
  Balance file's add already offers for a record it only names, which is the
  precedent to reuse rather than invent beside. An account in another currency
  is never a match.
- **A transfer between two accounts the file names** should arrive as one
  transfer with both sides filled in, where today staging asks for the other
  side at commit. The same transfer appears twice when a person exports two
  accounts separately and imports both files, so the duplicate rule has to know
  it is one movement.
- **Mapping an account column in a bank file**, so a file the app did not write
  can name its account per row, with the account chosen on the page kept as the
  fallback for a row that names none.

Not established for this entry: which other products' exports carry an account
column, and what they call it. That decides the mapping's defaults and was not
researched.

**Acceptance criteria**

- An export carries one column naming each row's account, in every file, and
  every file written before it still imports exactly as it does today
- One CSV import can stage rows into several accounts, each named in the file
  and matched to an account here, with the preview showing every name and what
  it will land in before anything is staged
- A name that matches nothing is the person's to decide in the preview, and no
  account is created or picked without them
- A transfer between two accounts in the file stages once, complete on both
  sides, and importing two single-account exports that both carry it stages it
  once
- A file with no account column, or a row naming none, lands in the account
  chosen on the page, as today
- The CSV standard, the MCP tools `preview_csv` and `stage_csv`, and the page
  change together, and the parity test passes
- The ten-thousand-row cap and every existing CSV refusal are unchanged

## SB-034 — Bulk writes in batches of 500

**Priority 198. Next, alongside SB-031 through SB-033. Depends on nothing;
rewrites three invariants in `AGENTS.md`, on the record.**

Committing more than about seven thousand staged rows at once fails on
app.smpl.money, which runs 0.2.1, and the way through today is to select and
commit smaller batches by hand. Staging a large CSV may do the same; that has
not been tried.

The likeliest cause is fixed in 0.2.2 and is not the argument for this story.
Through 0.2.1 a commit, a mass edit and a move part took one advisory lock per
row, and PostgreSQL's shared lock table is sized by `max_connections`: on a
database allowing 50, as the `single` profile's does, 9,000 locks fitted and
10,000 failed with SQLSTATE 53200, and a busy server has fewer to spare. 0.2.2
takes one lock per person instead (`docs/standards/code/database.md` §4.3).

The argument is the shape of the write. Every one of these actions is one
database transaction over everything it touches — up to ten thousand rows —
and for its whole length it holds its locks and its row versions on a database
every tenant shares. One person's import should not be able to take that much
of it, however rarely it happens. **Five hundred rows is the unit of one
transaction**, chosen by the owner as a size that is safe on a multi-tenant
deployment. Ten thousand stays the limit on one action, so nothing anybody can
ask for today is refused.

It covers every write that takes a batch:

- committing staged rows;
- staging a CSV;
- the transaction mass edit and mass delete, and the staged mass edit;
- adding and moving a Simple Balance file, whose parts ship in 0.2.2 at up to
  ten thousand rows each.

**What it reverses.** `AGENTS.md` says bulk commits are "explicit-ID,
validate-first, and atomic", that transaction and staged mass edits are atomic,
and that each ledger-file part is atomic. Batching makes each batch atomic and
the action as a whole resumable instead, which is the contract the ledger file's
parts already keep with the browser, and the rewrite of those three sentences
belongs in the same change as the code.

**What the design has to settle**

- **Where the batching happens.** In the server, inside one request, keeps every
  client that sends ten thousand rows today working, which the upgrade rule
  requires, and keeps the browser and an agent on one behavior. The browser
  sending batches itself would be simpler to show progress for and would need
  every client changed.
- **Validate first, still.** Everything that can be known before writing — a
  frozen account, a stale fingerprint, a row that cannot commit — should still
  refuse the whole action before the first batch, so the only partial result is
  one nobody could have predicted.
- **A failure partway.** What committed stays committed, because postings are
  append-only. The answer says how far it got, and sending the same action
  again finishes it without writing anything twice: idempotent by key, and by
  row id and version for what is already done.
- **A selection that moves between batches.** A mass edit checks its `id:version`
  fingerprint once, before the first batch. Each batch checks its own rows'
  versions again, and a row somebody changed in between is refused and
  reported rather than overwritten.
- **A move part's balance check.** Today the part carrying the file's balances
  is refused when an account comes out different, which is checked after the
  writes inside the part's one transaction. Across batches that check has to
  be worked out before anything is written, or a failed check leaves a move
  half done with nothing to undo it.

Not measured for this entry: how long a ten-thousand-row commit, CSV stage or
move part holds its transaction today, and what that costs the other tenants'
requests while it does. The first step is to measure both, so the change can be
shown to have helped.

**Acceptance criteria**

- No transaction opened by a bulk write touches more than 500 rows, held by a
  test rather than by reading the code
- A ten-thousand-row commit, CSV stage, mass edit, mass delete, Simple Balance
  file add and move part each complete on a database allowing 50 connections,
  with another tenant's requests answering throughout
- Anything that can refuse the whole action still refuses it before anything is
  written
- A failure partway says exactly what was written and what was not, and sending
  the action again finishes it without duplicating a row, a posting or an audit
  entry
- A client that sends up to ten thousand rows in one request today gets the
  same answer it gets now, and the MCP tools behave as the browser does
- `AGENTS.md`'s three atomicity sentences are rewritten in the same change

## SB-035 — QIF, OFX, QFX and camt import and export, beside CSV

**Priority 199. Next, alongside SB-031 through SB-034. Depends on SB-033;
reverses `docs/standards/csv.md` §1 and §14, on the record.**

CSV is the only file a bank statement can arrive in today, and every bank's CSV
needs its columns mapped by hand the first time. Most banks also offer their
statements as OFX, QFX (Quicken's branded OFX) or QIF, and European banks as
camt.053, the ISO 20022 end-of-day statement; all four carry the same fields in
fixed places and need no mapping at all. And somebody leaving Quicken, Money,
GnuCash or most desktop ledgers holds their history in QIF or OFX rather than
in a CSV. CSV stays exactly as it is; the goal is that a statement in any of the
five imports, and a ledger exports to any of them.

`docs/standards/csv.md` §1 decided against this: "CSV is the interchange format
… There is no second one and no plan for one", on the grounds that OFX needs a
bank relationship, QFX is proprietary and camt.053 "arrives from a bank or not
at all". That reasoning was about which format
a self-hosted ledger can count on *receiving*, and it holds: nobody is promised
an OFX file. It does not argue against reading one when a bank hands it over,
and the section's own evidence points the other way — OFX carries an id per
transaction (`FITID`), and Actual Budget recommends it over CSV for exactly
that reason, which §10 quotes. This entry reverses §1 and the "No second
interchange format" line of §14, and the rewrite belongs in the same change.

What the formats have in common with a CSV import is everything after the read:
rows stage for review, duplicates are flagged, nothing reaches the books
without a commit. What is new is the reader, and whether a file can describe
more than one account, which is SB-033's question and the reason this depends
on it.

**What the design has to settle**

- **Export.** Import is the case people have most; export is for leaving, and
  the owner asked for both. QIF is what most desktop ledgers still import, OFX
  keeps an id per transaction, and camt.053 is what a European tool expects.
  Writing camt.053 means producing a bank's statement document from a ledger
  that is not a bank, so its required account and servicer fields need a
  decided answer rather than a filler.
- **The id.** OFX and QFX carry `FITID` per transaction and camt.053 an
  `AcctSvcrRef` (and often an `EndToEndId`), each of which maps to the existing
  `externalId` and makes re-importing an overlapping statement skip what is
  already here. QIF carries none, so it falls back to the duplicate heuristic a
  CSV gets.
- **Accounts.** An OFX statement names its account, a camt.053 document
  carries one `Stmt` per account identified by IBAN, and a QIF file can hold
  several (`!Account` blocks), so all of them need SB-033's matching and preview rather
  than the single account a CSV import takes today.
- **Dates and amounts.** QIF writes dates in the exporting program's locale
  with no marker for which, and uses `'` for two-digit years in some producers;
  the reader has to ask, as the CSV import already asks for a date format,
  rather than guess. camt.053 states direction in `CdtDbtInd` beside an
  unsigned amount, the shape `csv.md` §14 lists as the CSV reader's cheapest
  missing feature. Amounts are decimal in all four, and go
  through the same decimal-string path as a CSV's, never a float.
- **Investment records.** OFX's investment statements and QIF's `!Type:Invst`
  describe holdings, prices and lots, which this ledger does not model
  ("Market prices and investment valuation" is deliberately not planned). They
  are refused by name rather than half read.

Not established for this entry: which banks in practice still serve OFX or
QFX downloads without a paid aggregator, which QIF dialects (Quicken,
Microsoft Money, GnuCash, banks) differ in what ways, and which camt.053
versions (`.001.02` through `.001.13`) banks actually send. Both decide how much of
the reader is quirks rather than format, and neither was researched.

**Acceptance criteria**

- A QIF, OFX, QFX or camt.053 bank or card statement stages for review the way
  a CSV does, with no column mapping, through the page and through the MCP tools
- A transaction's `FITID` or `AcctSvcrRef` becomes its external id, and importing an
  overlapping statement twice stages nothing twice
- A file naming an account, or several, goes through SB-033's account matching
  and preview
- A QIF date the reader cannot place unambiguously is asked about, not guessed
- An investment statement is refused with a sentence saying why
- A ledger, or chosen accounts, exports to each of the four, and a file this
  product writes reads back to the same rows
- The ten-thousand-row cap, the duplicate rules and every CSV behavior are
  unchanged, and `csv.md` §1 and §14 are rewritten in the same change

## SB-020 — Widen what an agent may propose

**Priority 200. Depends on SB-016.**

Today `ledger:stage` covers five tools, and every one of them is
transaction-shaped: create, update, delete, and mass-edit a staged row, and
stage a CSV. An agent that has only this scope can propose new transactions and
nothing else.

So the useful thing people will actually want — let the agent suggest
recategorizing six months of groceries, and look at the suggestion before it
lands — has no home. Recategorizing committed rows is `bulk_edit_transactions`,
which is `ledger:write`, and granting that also grants
`bulk_delete_transactions`, `delete_account`, and everything else. The tier
exists, it is simply too narrow to be the answer to anything but an import.

This is new modeling and not plumbing, and the earlier research claimed
otherwise. `staged_transaction` holds drafts of new transactions. There is no
representation for "a proposed change to transaction X", and giving it one means
deciding what a proposal does when the row underneath it moves, how a proposal
is reviewed against what is already there, and whether a rejected proposal is
kept.

The prize is a default posture worth recommending: grant `ledger:read` and
`ledger:stage`, never `ledger:write`, and the agent can do useful work all day
without being able to change the books. No competitor can offer that, and
Monarch's community servers ask the user's client config to simulate it.

**Acceptance criteria**

- An agent holding only `ledger:stage` can propose a change to an existing
  committed transaction, a category or payee merge, and a mass edit
- A proposal is not a posting, and nothing it says is true of the ledger until
  it is committed
- Committing a proposal goes through the same validation as making the change
  directly, and is atomic
- A proposal whose target moved underneath it is refused rather than applied to
  what is there now
- A person can see what a proposal would change, against what is there now,
  before committing it
- `ledger:write` keeps every capability it has today, including creating
  committed transactions directly and committing staged rows
- The parity test still passes: everything reachable in the browser stays
  reachable to an agent

## SB-021 — Bank sync

**Priority 210. Depends on SB-020.**

Approach deliberately unspecified. What follows is the ground it will be
designed on rather than a design.

The market moved against this while nobody was looking. The free European and UK
aggregator path closed to new registration in October 2025 and its sunset notice
has stood unretracted since. Actual Budget removed its Plaid integration
outright in 2024 and, two years later, still does not pull data automatically —
the person clicks a button. Firefly III's remaining importers are files, a
sales-gated commercial aggregator, and a paid North-America-only service, and
its own documentation says of the free one that it "supports very few American
and Asian banks. There is little I can do about this."

The models differ mainly in who holds the credential and who carries the
liability, which is the axis to choose on rather than coverage.

Whatever is chosen, it should arrive as another importer feeding the review
queue rather than as a second way to write to the ledger. The queue, the
duplicate detection, the mass edit, and the all-or-nothing commit already exist
and are the strongest thing here; a sync that bypasses them would be a second
ingestion path to keep correct forever.

**Acceptance criteria**

- Synced rows land on Staged transactions and are committed the same way
  imported ones are
- Duplicate detection covers rows that arrive by sync and by file, including the
  same row arriving both ways
- A connection that fails, expires, or is revoked says so plainly and loses
  nothing already staged
- No bank credential is stored in a form the deployment can use on its own
  behalf
- Sync is optional, and every part of the product works without it

## SB-022 — Account sharing with roles

**Priority 220. Depends on SB-020.**

More than one person on one set of books, with a role deciding what each may do.

The hard part is not the sharing. Authorization today has one dimension: a row
belongs to a `userId` and every service query is scoped by it. Sharing makes it
three — user, book, and role — and every one of the MCP tools then
asks a per-book, per-role question instead of a per-user one. That multiplies
against the three scopes already there, and the resulting matrix is the thing
most likely to develop a hole nobody notices.

Worth settling before any of it is built: whether a role is a property of the
book or of the invitation, what happens to shared data when one participant
deletes their account, and whether an agent's token is scoped to the person or
to the book. That last one decides the shape of everything else.

**Acceptance criteria**

- A book may be shared with named people, each holding a role
- Roles are enforced in the services rather than in the UI, so an agent and a
  browser get the same answer
- Tenant isolation still holds for everything unshared, proven the way it is
  proven now
- An agent's scopes intersect with its holder's role, and never widen it
- Every action records who did it, in which book, in the audit log
- Withdrawing access takes effect immediately, for sessions and agent tokens
  alike
- Deleting an account removes that person's own books and their access to
  others', and takes nobody else's data with it

## SB-023 — Attachments

**Priority 230. Depends on SB-017.**

A receipt or a statement kept against the transaction it belongs to.

Commonly asked for, and it brings things this product has been able to avoid: a
place to put bytes, a much larger backup, content types and everything that
comes with accepting files, and a new class of material an agent could be handed
by somebody else. Deployment is currently one container and one database, and
this is the first feature that pushes on that.

If it is built, an agent should get metadata and never the file, and never the
ability to upload one.

**Acceptance criteria**

- A file is attached to a transaction and survives export and re-import, or its
  absence is stated plainly
- Deleting a transaction and deleting an account both dispose of attached files
- Backup and restore are documented for whatever storage this introduces
- Uploads are bounded in size and type, and a rejected upload changes nothing
- An agent may learn that an attachment exists and never read or write one

## SB-024 — Reconciliation

**Priority 240. Depends on SB-018.**

Mark a set of transactions as cleared against a statement balance, and post an
adjusting entry for whatever is left over.

It fits the ledger exactly. The adjustment is a delta rather than a rewrite,
which is what corrections and closing entries already do, so it introduces no
new idea. It is last because Staged transactions already catches most of what
reconciliation is for: a file arrives, gets checked, and gets committed
deliberately. Reconciliation earns its place for people entering by hand, and
for the once-a-year case where the books and the statement have quietly drifted.

**Acceptance criteria**

- A reconciliation names an account, a statement date, and a statement balance
- Transactions are marked cleared against it, and a cleared row is
  distinguishable from an uncleared one
- The difference is posted as an ordinary adjusting entry, dated the statement
  date, never as an edit to anything already there
- A completed reconciliation is a record, and reopening one is itself recorded
- Balances and reports are unaffected except by the adjusting entry

## SB-025 — Rollover and sinking funds — **done**

**Priority 250. Depends on SB-019. Built, unreleased, and carrying migrations
0014 and 0019.**

Two columns on the plan and a fold at read time. Unspent money carries forward,
overspending carries forward as a debt, and a cap keeps either from running
away. A sinking fund is the same machinery with a target and a date, funding
itself over the periods remaining.

This is the first budget figure that depends on more than one period, which
means a back-dated correction changes every later period. That is correct and it
will surprise people, so the page says so.

**It does not ship without a measurement.** The reporting work priced its
queries against a hundred thousand postings on PostgreSQL 15 and 16, with plan
assertions that answer whether an index can serve a query rather than whether
the planner bothers on a handful of rows. The research behind this story did not
meet that standard and said so. If the recursive CTE will not hold, the fallback
is a bounded window with the bound stated on the page, and never a cache.

**How it was met**

The fold is not a recursive CTE and not a cache. It is one widened read and a
loop: the report already asks for spending and limits per period, so a carry
asks for the same thing over more periods and walks them in order. Each period's
available money is its own limit plus what the period before handed it; what it
does not spend it hands on; what it overspends it hands on as a debt. Nothing is
stored, so turning rollover off leaves no rows behind and no figure to recompute
— which is also what lets a back-dated correction change every later period
correctly rather than only the one it landed in.

**The bound is the fallback the story named, and it is stated.**
`MAX_ROLLOVER_PERIODS` is 120, so a fold reaches ten years of months or two and
a half of weeks before it stops, and a report that stopped there says so in
`rollover.clipped` and on the page. Ten years of months over a hundred thousand
postings costs **292ms** on the development machine, and
`tests/integration/budgets-scale.integration.test.ts` holds the shape rather
than that number: the spending behind a folded report comes from one indexed
pass with no `SubPlan`, which is what a per-period subquery would look like from
the database's side, and the carry it produces is checked against the ledger's
own sum rather than against a number somebody typed.

A sinking fund is the same fold with the amount worked out instead of read: what
is still needed, over the periods left before the target date. Nothing about it
is a mode anybody picks. A budget with a target and a date is a sinking fund
because of what it says, and the stored `amount_rule` column is derived from
that rather than chosen — the word "method" appears nowhere on the page, which
is the rule SB-019 set for all six of these stories.

Three refusals rather than three silent behaviors: a fund whose rollover is off
(it would save nothing), a fund with an amount beside its target (a number
nothing reads), and a cap on a budget that carries nothing. Each says which half
is missing.

## SB-026 — Derived amounts — **done**

**Priority 260. Depends on SB-019. Built, unreleased, and carrying migrations
0015 and 0018.**

A trailing average of what was actually spent, last period plus a percentage, a
share of income, and a funding order for when there is not enough to go around.
Two columns and a small evaluator over aggregates the reports already compute.

Deliberately few, and typed rather than a language. Actual built a template
grammar in a free-text field and is migrating away from it. The position here is
already that the agent is the rules engine, and a stage-scoped agent proposing a
limit from a trailing window is the most natural thing on this surface.

**How it was met**

Two columns, as designed: a lookback and a percentage, with the rule derived
from whichever one the row carries. Three rules and no chooser — a lookback is a
trailing average, a percentage of the last period is an incremental budget, a
percentage of income is a share of what came in — and naming two of them is
refused rather than resolved, because a row that named both would have to decide
which one it meant.

The evaluator is a `switch` in the same fold SB-025 built, over aggregates the
report already reads. A trailing average uses the finished periods before this
one and never this one, or a budget would chase the spending it is meant to be
measuring; it averages the periods that exist rather than treating the ones
before the budget started as zeroes. An incremental budget compounds on the
period before rather than on the original amount. A share of income takes the
period before, because a share of a period still running is a figure that
changes every time somebody looks at it.

An amount somebody typed for one period beats every rule, and the chain carries
on from what they typed. That falls out of the fold reading the resolved limit
rather than the plan's column, and it is the behavior anybody would expect from
an override that did not have to be argued for.

**The funding order is the fourth rule, and the one with an opinion.** Lower
goes first; zero means unranked, and unranked is funded last — because a funding
order names what comes first, and every budget in a ledger that never used the
feature defaults to zero. Whether a period funds anything is answered per period
rather than per report, so a priority set on a budget starting in June says
nothing about March. A ledger that never ranked anything gets `funded: null` and
no shortfall figure at all: a report that told everybody their budgets were
unfunded because income landed in a different period would be true, useless and
alarming.

## SB-027 — Category groups — **done**

**Priority 270. Depends on SB-019. Built, unreleased, and carrying migration
0016.**

One level. A category belongs to at most one group, and a group may hold a
budget of its own, which is what bucket budgeting, flex budgeting and 50/30/20
are.

Whether a group's budget stands alone or is the sum of its children is declared
on the group. Monarch's is standalone and hledger's is the sum, both are
defensible, and the failure is picking one silently.

Arbitrary depth is refused. hledger shows what it costs: spending in an
unbudgeted grandchild rolls up to the nearest budgeted ancestor, and the totals
stop agreeing with themselves. One level has no grandchild, so there is nothing
to misattribute.

**How it was met**

A `category_group` table, a nullable `group_id` on a category, and a budget
target that is a category or a group and never both. **A group is filled from
the categories list**: every row carries a group picker and the add-category form
takes one, which is the half this story shipped without — the only way in was a
select inside an edit modal behind an unlabeled pencil, and a page showing a
group with "0 categories" and no visible way to change that reads as a feature
that does not work. `groupId` on create was also a request field only an agent
could set until then. The policy is declared when
the group is created and has no default, because the whole point of writing this
story down was that having Monarch's behavior and expecting hledger's is a page
of figures all wrong in the same direction. A `sum_of_children` group is refused
a budget of its own: it already has an amount, and a second one would have an
equal claim to be the group's with nothing on the page able to say which was
being shown.

A group's line sits beside the category rows rather than among them. Both are
readings of the same money, so a period's `budgeted` and `spent` count the
category rows alone and no total counts a grocery bill twice.

**The one place this departs from the composite-key habit**, and it is written
where somebody will hit it: a category's group is a single-column foreign key.
`on delete set null` nulls *every* column of the constraint it is on, so the
usual `(user_id, id)` pair would null the tenant as well and fail against
`user_id not null`. PostgreSQL 15 can name the column to clear and Drizzle
cannot emit that, so the tenant check moved to `resolveCategoryGroup`, on the
one path that writes the column, with
`tests/integration/tenant-isolation.integration.test.ts` holding it there.

A group's history follows its current members: moving a category into a group
changes what that group spent last March too. Dating the membership would be a
second history to keep straight for a figure nothing reconciles against, and
what makes the choice safe is that no money moves — the categories' own rows are
untouched and the ledger says exactly what it said before.

Deleting a group leaves every category exactly where it was and takes the
group's own budget with it. Both fall out of the foreign keys rather than out of
a sweep somebody has to remember, which is what keeps them true of a delete that
arrives from anywhere.

## SB-028 — Envelopes — **done**

**Priority 280. Depends on SB-025 and SB-027. Built, unreleased, and carrying
migration 0017.**

Income assigned to categories before it is spent, and what is unspent rolls
forward. It is SB-025's fold read differently, plus one figure: what is left to
assign.

That figure needs a perimeter, and the perimeter includes credit cards. A card
sits outside the cash flow statement's set deliberately, but leaving it out here
would mean spending on a card empties an envelope while no cash leaves the
perimeter, so the product would say there is more money than there is. Each
account can be taken out of the perimeter, and the page explains why the figure
sits below the bank balance.

**How it was met**

One column — `ledger_account.in_budget`, on by default and on for cards — and
one figure. What is left to assign is what the perimeter held at the end of the
period, less every envelope with money still in it. An overspent envelope claims
nothing, because the money has already left the accounts and counting it again
would take it twice.

An envelope is a budget that carries, so this story added no new kind of budget:
it is SB-025's fold read differently, exactly as the plan said. A budget that
does not carry is a limit rather than a claim on cash, which is why a ledger
with no envelopes is told nothing about assigning rather than being told its
whole balance is unassigned.

The perimeter balance is a running total over the same grid the rest of the
report uses, with everything before the window folded into its first bucket, so
it is a real balance rather than a balance of the window — and it is one pass
rather than a correlated subquery per period, which is the shape this repository
prices out of its reports.

## SB-029 — Forecast — **done**

**Priority 290. Depends on SB-016 and SB-025. Built and unreleased. It carries
no migration: a projection stores nothing.**

Balances projected forward from the recurrences already generating dated
occurrences and the plans already saying what each period intends.

Money dated in the future has not moved. So this is a projection surface with
its own vocabulary, and no figure it produces may reach a balance, a report
total, or the trial balance. That is the invariant this story is at risk of, and
it gets a test rather than a paragraph.

**How it was met**

`tests/forecast-boundary.test.ts` is the paragraph made mechanical. Nothing
outside the two transports may import the forecast, so no balance and no report
can hold one of its figures; the service writes nothing at all, so no projection
can become a posting; and a field with `balance` in its name has to be either
the one fact in the reply — what the accounts hold today — or explicitly
`projectedBalance`.

The two sources are kept apart because they overlap. A recurrence is a dated
intention with an amount and projects directly; a budget is what a period
intends to spend, and most of that is already covered by the recurrences that
pay it. Counting both would spend the rent twice. So the projection is the
recurrences, `basis: "recurring_and_budgets"` adds only the part of each
category's budget its recurrences do not cover, and the budgeted figure is
reported either way — a period whose budgets dwarf its recurrences is a period
whose projection is optimistic, and nothing else on the page says so.

**A third basis was added after the story shipped, because the first two share
a blind spot.** Both read intentions — a schedule or a budget — and a ledger
that has neither yet has months of real spending the projection was ignoring: it
answered $0.00 in both money columns, which is a confident wrong answer rather
than a cautious one. `basis: "recurring_and_history"` averages recent *finished*
periods, per category for spending and in total for income, and subtracts what a
recurrence already covers by the same rule the budget arm uses. The current
period is never part of its own average — the rule `trailing_average` already
follows on the budgets side, so the two surfaces cannot answer one question with
two numbers. The history term is reported on its own as `typicalSpending` and
`typicalIncome`, so an inferred figure can always be told from a dated one, and
the page defaults to this basis while the wire default stays `recurring`, so no
client's answer moved.

Two smaller decisions worth recording. A recurrence with no amount is a real
schedule with no figure: it comes back in `unprojectable` with the reason,
because counting it as nothing would quietly flatter every period it falls in. A
transfer between two accounts in one currency changes no total in that currency
and is counted nowhere; across currencies it uses the schedule's own destination
amount, because this ledger holds no exchange rate of its own and a projection
is not the place to invent one.

## SB-030 — Programmatic HTTP access

**Priority 300. Depends on nothing in the budgeting arc.**

`/api/v1` authenticates with a cookie and nothing else, and every state-changing
request must be same-origin and declare JSON, so nothing outside a browser can
reach it. That was a reasonable place to stop while MCP was the answer for
programmatic access, and it stops being one the moment the HTTP contract is
documented as public.

The cheap correct version reuses what is already here: accept the OAuth bearer
tokens the MCP server issues, on the same three scopes, with the actor's source
distinguishing them in the audit log. No second authentication system and no new
token format. The same-origin requirement then applies to cookie-authenticated
requests, which is where it belongs, because a bearer request carries no ambient
credential for another site to forge.

---

## Deliberately not planned

**Market prices and investment valuation.** A price feed is a live external
dependency, a rate limit, and a source of numbers that can be wrong in a product
whose whole argument is that its numbers are right. Holding crypto as a native
quantity says exactly what is known and nothing more.

**A rules engine for auto-categorization.** The agent is the rules engine. One
holding `ledger:read` and `ledger:stage` categorizes better than any pattern
list and leaves its work somewhere it can be looked at. A second, dumber
automation path would duplicate the surface and undercut the reason MCP is here.
The counter-argument is real and worth recording: the agent is not present
during an import unless somebody invokes it, and the research lists rules-based
categorization among the things a manual-entry user genuinely misses. If the
staging queue plus a stage-scoped agent turns out not to cover it in practice,
this is the entry to revisit first.

**OpenTelemetry inside the application.** Metrics reach New Relic, or any
other backend, through a collector that scrapes the Prometheus text format the
process already serves, so moving the process itself onto the OpenTelemetry SDK
would buy the same series again at the cost of an export pipeline in the
request path and the backend's credential in every process. Decided in October
2026, for the release after 0.2.1; `docs/architecture.md` §Metrics, and why the
process does not speak OTLP has the argument. The counter-argument is real:
traces are a signal the text format cannot carry, and if this product ever
needs one request followed across the API, the database and Stripe, the SDK is
the way to get it and this is the entry to revisit.

**Lead generation, and anything that monetizes the data.** Not a product
decision.

**Advertising was in that sentence until 0.2.0, and half of it still is.** This
entry used to read "Advertising, lead generation, and anything that monetizes the
data", and it is edited rather than deleted because the reasoning is what
changed, not the mind.

What shipped is an operator's choice, off unless they set `ADSENSE_CLIENT_ID`
and sell the paid plan — an ad goes only to an account on a limited plan — and
it monetizes no data: the server decides placement and the browser is never
told the rule, so a subscriber's page never fetches Google's script at all;
requests are non-personalized unless a consent platform is collecting consent;
and nothing about anybody's ledger leaves the deployment. `docs/monetization.md`
states the cost to the operator in their own words before they turn it on, and
`docs/standards/operations.md` §One process, one database counts what the browser
reaches separately from what the server does, precisely because they are
different promises to different people. A second kind is built and unreleased:
the house ad, this product's own advertisement for its paid plan, off unless
`SB_HOUSE_AD` is set, on the same placement rule, and loading nothing from
anywhere, so there is no third party in it at all.

The part of the original position that stands is the part that was really load
bearing: this product does not sell what it knows about anybody. An operator
choosing to show advertisements on their own deployment is a different thing from
this project turning a ledger into an audience, and the design is what keeps the
two apart rather than the intention.
