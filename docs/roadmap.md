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

None of the products examined is double-entry. They are single-entry categorised
registers with budget overlays, which is why so much of what they do has no
analogue here and needs none.

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
names to the model unsanitised. The leading one's README suggests the fix:
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
  receipt afterwards does not change the answer. Re-importing a statement has to
  keep catching rows that were split last month.

Mass editing category or type is refused on a split rather than flattening it,
on committed and staged rows alike, and both selection summaries report how many
splits are in the set. A split is editable back to one category, and a
single-leg transaction cannot be represented at all: the wire schema, the check
constraint and the form each fold it back to a plain category.

## SB-016 — Recurring transactions — **done**

**Priority 170. Depends on SB-015. Shipped as migration 0006.**

A recurrence is a saved shape, a schedule, and a policy for the awkward dates.
On its due date it puts an ordinary transaction into the review queue, where it
waits with everything else until somebody commits it.

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
modelled here, so no new accounting primitive is required and generated rows
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

**Shipped as.** The scheduler runs inside the server process and is on by
default, so the documented single container keeps working with nothing added to
it. `RECURRENCE_SCHEDULER=false` turns it off on replicas that serve the API,
which is what a Kubernetes deployment does when it runs the scheduler container
from `deploy/docker/scheduler.Dockerfile`. Every replica sweeps the due list and
claims each recurrence with `for update skip locked`, so they divide the work
rather than wait on one another, and a per-occurrence unique key refuses a
second proposal of the same date even if a claim were bypassed entirely.

No holiday calendar. A business day means Monday to Friday, said in the tool
description and beside the weekend-policy picker, because per-country holiday
data ageing inside a container nobody updates is worse than not having it.

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

## SB-018 — Reporting — **done**

**Priority 180. Depends on SB-015. Shipped with no migration.**

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

One parameterised aggregation with named presets, after hledger: a statement is
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

## SB-019 — Budgeting

**Priority 190. Depends on SB-018.**

Which kind is undecided, and there is a case for supporting both. They are
different enough to need naming.

**Category limits** — a cap per category per period, and a bar showing spending
against it. Monarch, Simplifi, and Copilot work this way. It is an overlay on
figures SB-018 already computes: no new posting type, no new accounting concept,
and a limit that is deleted leaves nothing behind.

**Zero-based envelopes** — income is assigned to categories before it is spent,
and what is unspent rolls into next month. YNAB, EveryDollar, and Actual work
this way, and for the people who want it, it is the product rather than a
feature of it. In double-entry an envelope is an equity sub-account and
assigning to it is a transfer, which is how plain-text accounting has always
done it. That is real modelling: a second dimension over the ledger, a monthly
rollover, and a second mental model to explain.

Sequence matters. Category limits first leaves the door open to envelopes;
starting with envelopes does not leave the door open to anything, because the
envelope model swallows the simpler one.

**Acceptance criteria**

- A limit is set per category per period and compared against spending computed
  the same way the reports compute it
- Deleting or archiving a category leaves no orphaned limit, and a limit is
  never a reason a category cannot be deleted
- Nothing in this story writes a posting, and no budget figure is derived from
  anything except postings and the limits themselves
- Where envelopes ship, an assignment is a posting like any other, subject to
  zero-sum validation, and the rollover is an ordinary dated transaction rather
  than a stored running total
- Reachable over MCP, reads and writes on the same scope rules as everything else

## SB-020 — Widen what an agent may propose

**Priority 200. Depends on SB-016.**

Today `ledger:stage` covers five tools, and every one of them is
transaction-shaped: create, update, delete, and mass-edit a staged row, and
stage a CSV. An agent that has only this scope can propose new transactions and
nothing else.

So the useful thing people will actually want — let the agent suggest
recategorising six months of groceries, and look at the suggestion before it
lands — has no home. Recategorising committed rows is `bulk_edit_transactions`,
which is `ledger:write`, and granting that also grants
`bulk_delete_transactions`, `delete_account`, and everything else. The tier
exists, it is simply too narrow to be the answer to anything but an import.

This is new modelling and not plumbing, and the earlier research claimed
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

- Synced rows land in the review queue and are committed the same way imported
  ones are
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
new idea. It is last because the review queue already catches most of what
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

---

## Deliberately not planned

**Market prices and investment valuation.** A price feed is a live external
dependency, a rate limit, and a source of numbers that can be wrong in a product
whose whole argument is that its numbers are right. Holding crypto as a native
quantity says exactly what is known and nothing more.

**A rules engine for auto-categorisation.** The agent is the rules engine. One
holding `ledger:read` and `ledger:stage` categorises better than any pattern
list and leaves its work somewhere it can be looked at. A second, dumber
automation path would duplicate the surface and undercut the reason MCP is here.
The counter-argument is real and worth recording: the agent is not present
during an import unless somebody invokes it, and the research lists rules-based
categorisation among the things a manual-entry user genuinely misses. If the
staging queue plus a stage-scoped agent turns out not to cover it in practice,
this is the entry to revisit first.

**Advertising, lead generation, and anything that monetises the data.** Not a
product decision.
