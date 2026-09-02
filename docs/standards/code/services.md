# Services

`src/server/services` is where the rules live. Everything above it — the HTTP
routes, the MCP tools, the scheduler — is transport.

310 top-level declarations across 24 modules, 155 of them exported functions.
This guide is what they have in common.

## 1. Shape

### 1.1 A service function takes an actor first

**Binding.** Three shapes, and which one a function has says what it is. All
three rows count the same 310 declarations — everything at the top level of the
directory, exported or not — because the second shape is mostly not exported and
a table that counted only entry points would report the helpers as a handful:

| First parameter | What it is | Count |
| --- | --- | --- |
| `actor: Actor` | A public entry point. Scopes every query by `actor.userId`. | 91 |
| `tx: DbTransaction` | A helper that runs inside somebody else's transaction. Takes `actor` second when it needs scoping. | 61 |
| anything else | Mostly a pure function — `canonicalDecimal`, `encodeCursor`, `categoryKindForDraft` — touching no database and needing no actor. | 158 |

The three add up because they are one population read one way. Splitting them
by export tells you something the totals hide: 82 of the 91 are exported and 30
of the 61 are, which is the shape working. An entry point is reachable and a
helper mostly is not.

The third row is the one to read carefully, because *mostly* is doing work: 137
of the 158 touch no database at all, and the other 21 do. Most of those are the
second row under another name:
`selectBulkFilterRows(executor: Database | DbTransaction, …)` and
`legsByTransaction(db, …)` are helpers whose first parameter is spelled to admit
the pool as well. The rest are entry points with no actor to take, either
because no request made them run (`runDueNotifications`, `runDueRecurrences`) or
because of the exception below. None of the 21 is a fourth shape, and a
genuinely new one belongs in the table rather than in this paragraph.

There are 193 `userId, actor.userId` comparisons in this directory, which is
roughly one per query, and that is the right ratio.

`AGENTS.md` is the authority: "Never accept a public `userId`. Derive it from
the authenticated `Actor`."

**One named exception.** `revokeAllConnectedApps(userId: string, …)`
(src/server/services/connected-apps.ts:206)
takes a bare id because both its callers run where no `Actor` exists yet: one
from a session (`identity.user.id`) and one from a password reset, which happens
before anybody has signed in. Neither reads the id from the request, which is
what the invariant actually forbids. A second function of this shape needs the
same paragraph or it does not get written.

`AGENTS.md` is the authority here: a query that forgets the scope is a
cross-tenant read, which is the one class of bug in this product that cannot be
apologised for.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts`, which
walks the surface with two users and asserts neither can see the other.

### 1.2 The transport layer decides nothing

**House.** A route parses, calls one service function, and serialises. It does
not branch on business rules. The test for whether a line is in the wrong place:
if the MCP and the HTTP API would both need it, it belongs in the service.

This is why `tests/mcp-parity.test.ts` can compare the two transports service by
service at all — there is something to compare because neither transport holds
logic of its own.

Five lines in the two transports do reach the database, and none of them is
bookkeeping: the readiness probe's `select 1`, the first-account claim's
advisory lock — which `AGENTS.md` requires to be taken outside the application
pool — two reads of Better Auth's own tables behind the consent screen, which is
reachable from a session and has no MCP counterpart, and the transaction an MCP
tool call is made idempotent inside. Each is named in the test below with its
reason, so a sixth has to be argued for rather than merely added.

*Checked by:* `tests/transport-database-access.test.ts`. It cannot ask the
question this rule asks — would both surfaces need this line? — so it asks the
one a program can: is a transport querying the database at all. Every ledger
read and write goes through a service, so anything else here is either on the
list or is a decision that has left the layer both surfaces share.

### 1.3 One public function per intent, not per table

**House.** `setTransactionDeleted(actor, id, expectedVersion, deleted)` rather
than a `delete` and an `undelete`, because they are one intent with a boolean.
`setAccountArchived` is the same shape. Where two operations differ only in a
flag, they are one function.

## 2. Writing

### 2.1 A write is one database transaction

**Binding.** `AGENTS.md`: postings are append-only and balanced. That guarantee
is only worth anything if the postings, the row they belong to, the version bump
and the audit entry commit or fail together.

So a service mutation runs inside exactly one transaction — but not necessarily
one it opened. The shape is an optional trailing parameter, run through one
helper:

```ts
export async function createBudgetPlan(actor: Actor, input: unknown, transaction?: DbTransaction) {
  return withTransaction(transaction, async (tx) => { … });
}
```

`withTransaction` joins the caller's transaction when it is given one and opens
its own when it is not
(src/server/db/client.ts:116). 41 declarations here take that parameter. 40 of
them are mutations, and every one of those 40 goes through the helper, which is
the claim worth making and not the same one as the count of the parameter.

The odd one out is `listConnectedApps`
(src/server/services/connected-apps.ts:40),
which runs two selects and joins with `transaction ?? getDb()`. Wrapping a read
in a transaction of its own would buy nothing, so the helper is asked of
mutations and a declaration that writes nothing is left alone rather than
exempted by name.

Four places in this directory reach for `getDb().transaction` directly, and none
of the four advertises the parameter, so nothing is being ignored: two reads
that want every query on one snapshot (`getTransaction`, `listAllTransactions`),
and two entry points the scheduler calls, which own their boundary on purpose —
`proposeDueOccurrences` keeps one transaction to one recurrence so a tick does
not hold a one-connection deployment for its whole length, and
`claimDueNotification` moves the watermark in the transaction that claims the
row. A fifth has to argue that nothing will ever want to compose with it.

The parameter is not decoration. The MCP transport passes its transaction in
(src/server/mcp.ts:304-314`, and every `runIdempotentMcpMutation` call under it)
so that
its idempotency record, the mutation and the audit events land on one connection
and commit together. Take it away and an agent's write could record its
idempotency key and then fail, leaving a key that answers for a transaction that
does not exist.

Two rules fall out, and they are the ones to follow:

- **A public mutation takes `transaction?: DbTransaction` and uses
  `withTransaction`.** Never `getDb().transaction` directly in a new one; that
  is the form that cannot be composed.
- **A helper takes a required `tx: DbTransaction`** — 60 of them do — and never
  reaches for the pool. A helper that opens its own transaction is the bug this
  shape exists to prevent, because it commits independently of the caller that
  is about to fail.

*Checked by:* `tests/service-transactions.test.ts`, which reads each
mutation's parameter list rather than grepping for `withTransaction`, so a
mutation that delegates its writes to a helper still satisfies it. It holds both
counts as floors rather than equalities — the point is that the reader still
finds the two shapes, not that the directory has stopped growing — so the
numbers above are today's and the test is what keeps the rule.

### 2.2 A write that changes something takes the version it expects

**Binding.** Optimistic concurrency, everywhere, no exceptions. The caller sends
the version it read; the service compares, throws `staleVersion` if it moved,
and bumps on success
(`updateAccount`, src/server/services/accounts.ts:662).

Two windows have to be closed, not one. Comparing before the update leaves a
gap between the read and the write, so the update itself also filters on the
version and throws when it matches no row
(the `.where` on the update itself, a few lines below).
The first check exists to produce a good message; the second is what makes it
correct.

`staleVersion` carries `currentVersion` so a client can offer "reload and try
again" rather than "something went wrong". See `errors.md`.

*Checked by:* `tests/integration/mcp-tools.integration.test.ts`, "tells an agent
to read the row again, and hands it the version to use", which sends a version
the row never had and asserts the refusal comes back naming the version it
actually holds. That is the first of the two windows — the one that exists to
produce a good message. The second needs two writers overlapping on one row, and
nothing here arranges that, so the filter on the update is argued for rather
than demonstrated.

### 2.3 A write that creates something takes an idempotency key

**Binding.** A create is retried by every client eventually — a dropped
response, a scheduler that fires twice, an agent that loses its connection. The
key makes the retry safe.

The mechanism is worth understanding rather than copying. `getIdempotent` looks
the key up **and hashes the request**
(src/server/services/helpers.ts:90-121).
Same key and same request returns the stored response. Same key and a
*different* request is a `conflict`, because the caller has reused a key for
something else and silently returning the old answer would be worse than
refusing.

The hash is over a canonicalised payload
(src/server/services/helpers.ts:124):
keys sorted, `undefined` dropped, dates as ISO strings. Without that, two
identical requests whose JSON key order differed would hash differently and the
retry would be refused.

**A trap this repository fell into.** Four integration tests built keys as
`` `prefix-${n}`.padEnd(16, "0") ``, which makes `prefix-1` and `prefix-10` the
same string. Where the payloads also matched, the second call returned the
first call's transaction and the test passed having written nothing. All four
now pad the counter rather than the string
(tests/integration/category-by-name.integration.test.ts:28).

*Checked by:* `tests/integration/duplicates.integration.test.ts`, "binds direct
transaction and staging idempotency keys to their request": the same request
twice comes back as one row, the same key over a changed amount is refused as a
`conflict`, and a stage whose `rawData` keys arrive in the other order still
replays, which is the canonicalisation being exercised rather than the key.
Two simultaneous retries are covered a few cases below it. That a create takes a
key at all is held only on the agent surface, by
`tests/mcp-measurements.test.ts`, which counts the mutating tools from their
annotations and fails on one carrying neither a key nor an expected version. A
service function reached from a route has nothing equivalent behind it.

### 2.4 Namespaces are locked before they are read

**Binding.** Anything that decides "does this name already exist?" takes an
advisory lock on that namespace first
(src/server/services/helpers.ts:263,
and the same for payees, templates and recurrences). Otherwise two concurrent
requests both read "no", and both create.

The lock is per user and per namespace, so it serialises the smallest thing that
has to be serialised.

*Checked by:* `tests/integration/duplicate-lock.integration.test.ts` for the
mechanism, from a second connection under a 400ms statement timeout: a blocked
waiter either expires or does not, and it expires. That is the duplicate
fingerprint lock rather than a name, and it is the only one under test — nothing
asserts that a path deciding a name reaches `lockCategoryNamespace` or one of
its siblings first. Sequentially the outcome is covered, by
`tests/integration/transaction-templates.integration.test.ts`, "refuses a second
template whose name differs only by case or spacing". The unique constraints
behind those names are on the raw text, so they catch an exact repeat and
nothing else; under concurrency a case variant has only the lock behind it, and
a payee has no row to constrain at all.

### 2.5 Every write is audited

**Binding.** 42 `writeAudit` calls, nine `writeAuditMany`, and seven
`auditedTransaction`. The audit row carries the entity, the
operation, and the row before and after, serialised through `serializeRow` so a
`Date` does not end up in JSON as something unparseable.

An operation name is a sentence about intent, not a table verb:
`create_from_transaction` says a category was created as a side effect of
somebody entering money, which is a different event from creating one on the
Categories page, and a year later that difference is the whole value of the row.

*Checked by:* `tests/integration/ledger.integration.test.ts`, "writes scoped
audit history", which asserts the rows are there, that a second tenant sees none
of them, and that they parse as the shape the MCP tool declares; and
`tests/integration/splits-audit.integration.test.ts`, "records which categories a
split's legs held, before and after", for the payload carrying the legs. The
same ledger file separates `create` from `create_from_stage` by requiring both
to appear, which is as close as anything comes to holding an operation name to
its intent. The word left unchecked is *every*: nothing enumerates the mutations
in this directory the way `tests/service-transactions.test.ts` enumerates their
parameter lists, so a new write that audits nothing passes.

### 2.6 A merge rewrites every table that names the merged thing

**Binding.** A merge's whole promise is "these two are one now", and every
reference the loser leaves behind is a place where they are still two. The
list of tables that name a category or a payee is enumerated where the merge
is written, not remembered: transactions, legs, staged drafts, recurrence
shapes, template drafts, and — for categories — budget plans and entries.

Written down because it was broken twice, the same way, one door apart. The
category merge rewrote transactions, staged rows, recurrences and budgets,
then hard-deleted the sources out from under template drafts — leaving
templates that cannot be saved and cannot be used, the exact state
`deleteCategory` refuses to create. The payee merge missed both standing
references, and a recurrence re-created the merged-away spelling on its next
occurrence: the merge quietly undid itself on a schedule. The reference-
counting guard (`countCategoryUses`) and the merge must agree about what a
reference is; when the counter learns a new table, the merge learns it in the
same change.

*Checked by:* `tests/integration/categories.integration.test.ts` ("rewrites
template drafts when merging" and the recurrence twin) and
`tests/integration/payees.integration.test.ts` ("rewrites recurrence shapes
and template drafts to the merged spelling"). Not checked mechanically: that
the counter and the merge agree table for table — a new reference table needs
both by hand.

### 2.7 A guard holds for every sibling of the path it guards

**Binding.** A rule enforced on one path and not on the paths beside it is not
a rule; it is a trap that fires on whichever door somebody walks through
second. When a refinement, filter or refusal exists anywhere, every path that
answers the same question carries it — by sharing the expression, never by
copying it.

Three shapes of the same failure, all found in one audit. The counter-account
exclusion lived on `getAccount` with a comment saying every other path hides
them, while the writes beside it — update, archive, delete — obeyed whoever
guessed the id; the fix is one shared where-clause
(`userAccountById`, src/server/services/accounts.ts), which is also the shape
the fix should always take. The refund-direction refusal on bulk edits ran
when the patch named a category and not when it named a type, though either
half of the pair makes the reversal. And the `oneLine`/`freeText` control-
character refinements guarded most name fields while the bulk patches and
group names took raw strings to a jsonb write PostgreSQL refuses as a 500.

The test for whether you are about to lay this trap: when a review comment on
one site says "so that X cannot happen", grep for the other sites where X can
happen. If the guard cannot be shared as one expression, the sites are not
siblings and the comment should say why.

*Checked by:* `tests/integration/account-closing.integration.test.ts`
("answers not-found for every write against a counter-account") and
`tests/integration/bulk-transactions.integration.test.ts` ("refuses a type
flip that would turn retained categories into refunds") pin the two ledger
instances. The class is `human`: no program knows which paths are siblings.

## 3. Reading

### 3.1 A read that a write depends on happens first, and inside the transaction

**Binding.** Order matters more than it looks. `prepareTransaction` reads the
categories a draft names **before** resolving which counter-account each half
posts to, because the answer depends on the kind of category the draft is
pointing at, and a category created by this very draft has to exist first.

Getting this backwards is not a crash. It is a refund that posts to income, and
nothing tells you.

### 3.2 Awaiting in a loop is sometimes the point

**Contested**, and this is the entry that made the whole `perf` lint category
not worth having. `no-await-in-loop` finds 51 sites in this directory and 163
across the whole repository; the count quoted in `index.md`, where the category
was declined, is the repository-wide one. The 112 sites outside this directory
are almost all tests, most of them integration tests awaiting one request at a
time, which is a different thing from a service resolving names in order. Some
of the 51 here are opportunities. At least one is load-bearing:

```
Legs resolve one at a time rather than in a batch, so that two legs naming
the same new category end up on one category rather than two: the second
lookup sees what the first created.
```

(src/server/services/categories.ts:199.)

Run those in parallel and a split naming "Groceries" twice creates two
categories. The sequence *is* the algorithm. A linter cannot tell that apart
from an accident, so the rule is off and the reasoning lives in the comment
beside the loop.

The rule for a reader: parallelise reads that do not see each other's writes;
never parallelise a loop whose iterations resolve names.

*Checked by:* `tests/integration/splits.integration.test.ts`, "creates a category
named by a leg, and reuses it for a second leg naming the same one" — the outcome
the sequence exists for, on two legs spelled "Garden supplies" and "garden
supplies", asserting they land on one id. Resolution matches on a normalised name
and stores the raw one, so two legs resolved side by side would insert two rows
that `category_user_name_unique` is perfectly happy with, and the assertion
fails. Nothing checks the other half, that the loop stays sequential, because the
rule with an opinion about it is the one turned off.

### 3.3 Money is summed in the database or in `decimal.js`, never in JavaScript numbers

**Binding.** `AGENTS.md`. On the server that means `decimal()`
(src/server/services/helpers.ts:21)
and `canonicalDecimal` on the way out, so every amount that crosses a boundary
is the same string for the same value.

`numeric(44, 18)` in, canonical decimal string out. No stage in between is a
`number`.

## 4. Naming a category, and why it is in this guide

**Binding**, because it is the rule most recently got wrong.

Resolving a category by name never widens the category it finds
(src/server/services/categories.ts:154).
Widening to `both` was correct while an entry could only name a category of its
own direction. It stopped being correct when a category running against the
direction became a refund, and it stopped quietly: `both` agrees with whichever
direction it is handed, so every later refund into that category credits income
instead of lowering the spending.

Where the direction genuinely cannot decide — a name with nothing behind it
yet — the caller says so with `categoryKind`
(src/server/services/categories.ts:209),
and that field is ignored when the category already exists, because that one has
an answer already.

*Checked by:* `tests/integration/category-by-name.integration.test.ts`, whose
last eight cases are exactly this, and
`tests/integration/budgets.integration.test.ts` for the money proof — a refund
into a spending category it created itself has to move a budget.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.3 One public function per intent | Whether two operations are one intent with a boolean is the judgement being asked for, and anything able to settle it would not need the rule written down. The nearest check belongs to another guide: `tests/http-route-table.test.ts` refuses a route ending `/archive` or `/delete`, which is this split where it reaches a URL and nowhere else. |
| 2.6 The counter and the merge agree | The two instances that existed are pinned by tests; whether a NEW reference table reaches both lists is a fact about a diff, which only a reviewer sees. |
| 2.7 Guards hold for siblings | No program knows which paths are siblings. The two ledger instances are pinned; the class is a review question. |
| 3.1 Reads before dependent writes | Only the outcome is testable, and it is: the refund tests are that check wearing a different hat. |

Four `human` rules in this guide, and two of them are new to the table rather
than newly unchecked: 1.3 had never said either way, which from a distance reads like
a rule that is checked. `tests/service-transactions.test.ts` holds 2.1, reading
the parameter list rather than grepping for a name, so a mutation that delegates
its writes to a helper still counts. `tests/transport-database-access.test.ts`
holds as much of 1.2 as a program can be asked: not "does this line belong
here", which is judgement, but "is a transport querying the database", which is
what that judgement going wrong looks like. Three more — 2.2, 2.4 and 2.5 — are
held in part, and each says underneath it which part.
