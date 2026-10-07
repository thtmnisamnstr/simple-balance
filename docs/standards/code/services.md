# Services

`src/server/services` is where the rules live. Everything above it — the HTTP
routes, the MCP tools, the scheduler — is transport.

388 top-level declarations across 25 modules, 183 of them exported functions.
This guide is what they have in common.

Every count on this page is `topLevelDeclarations` (`tests/support/source.ts`)
over `src/server/services`, which is the sweep the tests use: a declaration is a
line at column zero that starts a `function` or a `const`, which the formatter
guarantees is unambiguous. Measure the same way or the numbers will not match.

## 1. Shape

### 1.1 A service function takes an actor first

**Binding.** Three shapes, and which one a function has says what it is. All
three rows count the same 388 declarations — everything at the top level of the
directory, exported or not — because the second shape is mostly not exported and
a table that counted only entry points would report the helpers as a handful:

| First parameter | What it is | Count |
| --- | --- | --- |
| `actor: Actor` | A public entry point. Scopes every query by `actor.userId`. | 111 |
| `tx: DbTransaction` | A helper that runs inside somebody else's transaction. Takes `actor` second when it needs scoping. | 81 |
| anything else | Mostly a pure function — `canonicalDecimal`, `encodeCursor`, `categoryKindForDraft` — touching no database and needing no actor. | 196 |

The three add up because they are one population read one way. Splitting them
by export tells you something the totals hide: 97 of the 111 are exported and 36
of the 81 are, which is the shape working. An entry point is reachable and a
helper mostly is not.

The third row is the one to read carefully, because *mostly* is doing work: 177
of the 196 touch no database at all, and the other 19 do. Most of those are the
second row under another name:
`selectBulkFilterRows(executor: Database | DbTransaction, …)` and
`legsByTransaction(db, …)` are helpers whose first parameter is spelled to admit
the pool as well. The rest are entry points with no actor to take, either
because no request made them run or because of the exception below. Thirteen of
the 19 are exported and the table below is exactly those; the other six —
`storeSubscriptionGone`, `deferSubscriptionRead`, `isWebhookEventClaimed`,
`recipientOf`, `claimDueNotification` and `earliestPostingDate` — are
module-private and reached only from an entry point in that table, each with a
`userId` its caller had already derived from an actor.

Naming the thirteen in a sentence was how this paragraph fell behind twice. It
once named four, and `pruneIdempotencyRecords` arrived as the fifth after the
sentence was written while nothing asked it again. The thirteenth fell behind a
second way and is worth the
warning: `applySetupIntentSucceeded` was in the test's list and not in this
table, because the sweep's body reader mistook a parameter's object type for a
function body and never classified it — so the split above counted it among the
177 while the table simply had no row. A number taken from a sweep is only as
good as what the sweep can see. The table below is the list, and the test reads
it, which is why the ones that arrived with billing could not repeat the first
mistake.

| Entry point | Why it has no actor |
| --- | --- |
| `runDueRecurrences` | The proposal sweep, on the scheduler's tick |
| `runDueNotifications` | The reminder sweep, on the same tick |
| `pruneIdempotencyRecords` | The retention sweep, on the same tick |
| `runBillingReconciliation` | The subscription re-read sweep, on the same tick: its subject is every stale row in the deployment, so there is no one person it is about |
| `pruneAbandonedClients` | A scheduled sweep of OAuth clients nobody completed |
| `reconcileArchivedAccountClosings` | A repair of somebody's postings, run at startup rather than by a request |
| `revokeAllConnectedApps` | The exception below: a `userId`, reached from a session or a password reset rather than from a request naming one |
| `userForStripeCustomer` | A lookup from a Stripe customer id to the person it belongs to, which is how the webhook finds an actor at all |
| `applyStripeDelivery` | The same delivery, claimed and written in one transaction |
| `reconcileSubscription` | Stripe's delivery names a customer, not a person, so there is no request naming an actor |
| `claimWebhookEvent` | The deployment's record of which deliveries Stripe has been answered for, which belongs to nobody |
| `applyCustomerDeletion` | The same delivery, claimed and applied in one transaction |
| `applySetupIntentSucceeded` | The same again: a card Stripe says was set up, named by customer rather than by person, and claimed after the work because the work is two Stripe calls |

None of the 19 is a fourth shape.

*Checked by:* `tests/service-entry-points.test.ts`, which walks every exported
service function, sorts it into "takes an actor", "takes an executor" or
"reaches the database with neither", and requires the third kind to be on that
list — **and requires this table to name it too**, because a reader meets the
paragraph before the test and the two came apart once already. A name left
behind after the sweep it excused was renamed fails as well.

There are 222 `userId, actor.userId` comparisons in this directory, which is
roughly one per query, and that is the right ratio.

`AGENTS.md` is the authority: "Never accept a public `userId`. Derive it from
the authenticated `Actor`, and scope every finance read/write by that ID." The
second half is the half that does the work, and this guide had been quoting the
first half alone — which reads as a rule about a parameter rather than a rule
about every query below it.

**One named exception.** `revokeAllConnectedApps(userId: string, …)`
(`src/server/services/connected-apps.ts:206`)
takes a bare id because both its callers run where no `Actor` exists yet: one
from a session (`identity.user.id`) and one from a password reset, which happens
before anybody has signed in. Neither reads the id from the request, which is
what the invariant actually forbids. A second function of this shape needs the
same paragraph or it does not get written.

`AGENTS.md` is the authority here: a query that forgets the scope is a
cross-tenant read, which is the one class of bug in this product that cannot be
apologized for.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts`, which
walks the services with two users and asserts neither can see the other;
`tests/integration/tenant-isolation-routes.integration.test.ts`, which does the
same over every route that names a record, read from the router; and
`tests/service-write-scope.test.ts` for the half that suite is structurally
blind to. A read that forgets the owner shows somebody another tenant's row and
two users will find it; a *write* that forgets the owner can only be caught
behaviourally if two tenants' rows collide on the key it does use, and every key
here is a UUID, so they never do. `claimDueNotification` updated
`template_notification` by id alone for a release on exactly that blind spot.

### 1.2 The transport layer decides nothing

**House.** A route parses, calls one service function, and serializes. It does
not branch on business rules. The test for whether a line is in the wrong place:
if the MCP and the HTTP API would both need it, it belongs in the service.

This is why `tests/mcp-parity.test.ts` can compare the two transports service by
service at all — there is something to compare because neither transport holds
logic of its own.

Seven lines in the two transports do reach the database, and they are five
things, none of them bookkeeping: the readiness probe's `select 1`, the
first-account claim's advisory lock — which `AGENTS.md` requires to be taken
outside the application pool, and which takes two statements on its own client
— two reads of Better Auth's own tables behind the consent screen, which is
reachable from a session and has no MCP counterpart, and the transaction an MCP
tool call is made idempotent inside. Each is named in the test below with its
reason, so another has to be argued for rather than merely added. The test
counted five lines because its patterns could not see a query run through a
transaction handle or on a client by another name; it reads any builder on any
receiver now, which is how the lock's two statements were found.

*Checked by:* `tests/transport-database-access.test.ts`. It cannot ask the
question this rule asks — would both surfaces need this line? — so it asks the
one a program can: is a transport querying the database at all. Every ledger
read and write goes through a service, so anything else here is either on the
list or is a decision that has left the layer both surfaces share.

### 1.3 Withhold rather than gate, where the browser could get it wrong

**House, and new in 0.2.0.** `AGENTS.md` settles the usual shape: a rule the
browser previews and the server enforces has to be one function, so the two
cannot disagree. `resolveEntrySide` and `subscriptionAction` are that — shared,
pure, and called from both sides. So are the three smaller rules the plan tab
reads off the second, and each exists because the tab's own copy said
something the server did not do: `planChangeTakesEffect` answers whether a move
to annual happens now or at the renewal, after the tab promised a past-due
subscriber "takes effect now" for a press that was scheduled; `periodIsPaid`
answers whether a period end is a date the plan runs to, after the tab printed
"renews" beside a period nobody had paid for; and `graceEndsAt` is the moment
`resolveEntitlement` drops a failed renewal, so the date in the alert is the
date enforced. Where the page cannot have a rule's inputs it says nothing
rather than approximate it: how many accounts ending the paid plan would freeze
depends on account rows the tab never loads, so that sentence waits for the
server to send the count, and a server that sends none gets no sentence.

There is a second shape, for when the browser has no business previewing at all.
Rather than send the data and a rule for using it, **send nothing and let the
absence be the answer.** `getAdPlacement` (`src/server/services/billing.ts:2582`)
returns the publisher and slot ids, or `null`: a session belonging to somebody
who should see no advertising simply carries no ad configuration, so the page
has nothing to render a slot from. `AdSlot` (`src/client/ads.tsx:70`) has no
entitlement logic in it, because there is nothing for it to decide.

The obvious alternative — put the entitlement on the session and have the
component check it — was tried first, and it fails in two ways that are both
invisible in review. The condition has to be written as "a *limited* plan is in
force" and not as "not on Plus", and the two differ only on a deployment that
has stopped selling while its subscribers are still being charged, which is the
one state nobody writes a test for. And the entitlement arrives a round trip
after first paint, so a slot rendered eagerly shows an advertisement to somebody
who paid not to see one, for as long as the session query takes.

Withholding removes both. There is no condition to invert and no window to
render in, and every bug in the area fails towards showing nothing.

Use it where the cost of the browser being wrong is borne by somebody other than
the person using it — money, privacy, a promise made to a third party. Do not
use it where a screen genuinely needs the value to explain itself: a disabled
button still needs the sentence saying why (`errors.md` 4), and hiding the
reason would be this rule misapplied.

*Checked by:* `tests/integration/ad-placement.integration.test.ts` and
`tests/integration/ad-placement-wound-down.integration.test.ts`, which call the
service itself against a real database. The second exists only for the
wound-down state, because that is the sole state where the two spellings of the
condition differ — a gate inverted in the real function passed every other test
in this repository, including the one that pins the rule's shape. The shared
rules are held where they are written: `tests/subscription-action.test.ts`
("when a change of plan takes effect", "whether the current period has been
paid for") and `tests/entitlements.test.ts` ("names the moment the grace ends,
and the plan drops exactly then"). That the tab reads them rather than a copy
is held by `tests/plan-page-ui.test.tsx`, which renders the sentences each one
decides.

### 1.4 One public function per intent, not per table

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
(`src/server/db/client.ts:116`). 48 declarations here take that parameter. 45 of
them are mutations, and every one of those 45 goes through the helper, which is
the claim worth making and not the same one as the count of the parameter.

The other three are reads — `getEntitlement`, `userForStripeCustomer` and
`listConnectedApps`
(`src/server/services/connected-apps.ts:40`) — and all three join the same way,
with `transaction ?? getDb()`. Wrapping a read in a transaction of its own would
buy nothing, so the helper is asked of mutations and a declaration that writes
nothing is left alone rather than exempted by name. `transaction ?? getDb()` is
the whole shape for a read: take the caller's connection when there is one, and
never open a boundary the caller did not ask for.

Nine places in this directory open a transaction directly — whether spelled
`getDb().transaction` or through a `db` alias, which is the same decision made
harder to grep — and none of the nine advertises the parameter, so nothing is
being ignored. Six are the original argument: three reads that want every query
on one snapshot (`getTransaction`, `listAllTransactions`, and
`listTransactions`' hydration pass), two entry points the scheduler calls, which
own their boundary on purpose — `proposeDueOccurrences` keeps one transaction to
one recurrence so a tick does not hold a one-connection deployment for its whole
length, and `claimDueNotification` moves the watermark in the transaction that
claims the row — and `deleteOwnAccount`, which is reachable only from a browser
session and ends the tenant whose work anything composing with it would be
doing.

Billing added the other three, and each argues it where it is written rather
than here — `beginBillingOperation` cites this rule by name
(`src/server/services/billing.ts:586-597`). The seventh carries a reason none of
the first six has, and it is the one to copy: **the row has to be durable before
the network call.** `beginBillingOperation` records the intent to call Stripe
and commits it, because a process that dies mid-call otherwise leaves no record
of the key it already spent, and the retry spends a second one. The eighth is
`setSubscription`'s inner transaction, which holds `lockBillingState` from the
read to the store so a second press cannot create a second subscription, and
lets the lock go before re-reading what Stripe then said. The ninth is
`confirmPaymentSetup`'s, which holds the same lock from reading the grant to
paying what is owed, so a subscribe and a card replacement for one person cannot
both be collecting at once; it warms the price check before taking the lock, so
the only calls it holds the lock across are the two that charge. Both of these
hold a pooled connection across a network call, which `docs/capacity.md` names
the first thing to run out — the trade is a slower request against somebody
charged twice. A tenth has to argue that nothing will ever want to compose with
it, or — like these three — that composing with it is exactly what must not
happen.

The parameter is not decoration. The MCP transport passes its transaction in
(`src/server/mcp.ts:310-343`, and every `runIdempotentMcpMutation` call under it)
so that
its idempotency record, the mutation and the audit events land on one connection
and commit together. Take it away and an agent's write could record its
idempotency key and then fail, leaving a key that answers for a transaction that
does not exist.

Two rules fall out, and they are the ones to follow:

- **A public mutation takes `transaction?: DbTransaction` and uses
  `withTransaction`.** Never `getDb().transaction` directly in a new one; that
  is the form that cannot be composed.
- **A helper takes a required `tx: DbTransaction`** — 69 of them do — and never
  reaches for the pool. A helper that opens its own transaction is the bug this
  shape exists to prevent, because it commits independently of the caller that
  is about to fail. Where the same answer is also wanted without a transaction,
  the way out is a second entry point rather than making `tx` optional: see 2.8.

*Checked by:* `tests/service-transactions.test.ts`, which reads each
mutation's parameter list rather than grepping for `withTransaction`, so a
mutation that delegates its writes to a helper still satisfies it. It holds both
counts as floors rather than equalities — the point is that the reader still
finds the two shapes, not that the directory has stopped growing — so the
numbers above are today's and the test is what keeps the rule.

### 2.2 A write that changes something takes the version it expects

**Binding**, for a write that changes something somebody edited. The caller sends
the version it read; the service compares, throws `staleVersion` if it moved,
and bumps on success
(`updateAccount`, `src/server/services/accounts.ts:1064`).

This said "everywhere, no exceptions" for a release, and that was false in both
halves by the time it was written. `setActiveAccounts` takes no expected version
and bumps none, and `markFittingAccountsActive` writes the same column from
inside `createAccount`, `setAccountArchived` and `deleteAccount`, which take no
version for it either; `AGENTS.md` sanctions both, because `active` is the
person's answer to a question about their plan rather than a field on the
account form. Which writes may leave `version` alone, and what they owe instead,
is 2.9. Left as "no exceptions" the sentence costs twice: a reviewer rejects the
shape `AGENTS.md` asked for, or an author adds the bump and invalidates the
expected version in every form anybody had open.

Two windows have to be closed, not one. Comparing before the update leaves a
gap between the read and the write, so the update itself also filters on the
version and throws when it matches no row
(the `.where` on the update itself, a few lines below).
The first check exists to produce a good message; the second is what makes it
correct.

`staleVersion` carries `currentVersion` so a client can offer "reload and try
again" rather than "something went wrong". See `errors.md`.

**And a write that changes nothing is not a write.** After the version check,
every update compares what it would store with what is stored and, when they
agree, returns the row as it is: no new version, no audit entry, no posting
(`patchChangesNothing` and `sameStoredValue`, `src/server/services/helpers.ts`).
Until the 0.2.0 sandbox smoke test, saving an entry unchanged moved its version
from 1 to 2, and a bumped version is not harmless: every other form and every
mass-edit fingerprint holding the record is now stale and refuses its next
save, over a change nobody made. The comparison reads values the way a screen
does — amounts as numbers, blank and absent as the same thing, a JSON column by
content — because a column hands back eighteen places and a request as many as
somebody typed. A transaction compares its legs by id as well
(`changesNothing`, `src/server/services/transactions.ts`), since a leg sent
without one is a new leg even when its figures agree. Asking a record for the
state it is already in — archiving an archived account, deleting a deleted
entry — is the same nothing, and a mass edit writes only the rows its patch
changes, reports those rows' versions unmoved, and counts only the changed ones
in `updatedCount`. Checked by
`tests/integration/unchanged-edits.integration.test.ts`, which saves every
record a form edits without changing it, and by `tests/unchanged-writes.test.ts`,
which finds every exported service function that bumps a version — any
`version: … + 1`, where it used to know six operands by name and so never saw
`existing.version + 1` — and requires it to compare first or be named with the
reason its writes always change something: a merge, and the queue's delete and
commit.

*Checked by:* `tests/integration/mcp-tools.integration.test.ts`, "tells an agent
to read the row again, and hands it the version to use", which sends a version
the row never had and asserts the refusal comes back naming the version it
actually holds. That is the first of the two windows — the one that exists to
produce a good message. The second needs two writers overlapping on one row, and
nothing here arranges that, so the filter on the update is argued for rather
than demonstrated.

### 2.3 A create that writes postings takes an idempotency key; a create somebody names is protected by the name

**Binding**, and `AGENTS.md` is the authority: "Commits, and creates that write
postings, require idempotency; a record somebody names is protected by its own
name being unique, so a second submit fails rather than duplicating." A create
is retried by every client eventually — a dropped response, a scheduler that
fires twice, an agent that loses its connection — and something has to make the
retry safe. A key is one way. A unique constraint on what the caller already
said is the other, and it is free.

This guide stated the broad half for a release — *every* create takes a key —
and the broad half is the wrong one, because the directory does not do it and
never did. Six create schemas carry none: `accountCreateSchema`,
`categoryCreateSchema`, `categoryGroupCreateSchema`,
`transactionTemplateCreateSchema` and `recurrenceCreateSchema` are each
protected by a unique name, and `budgetPlanCreateSchema` by
`budget_plan_category_window_unique` and its group twin — the window is what
somebody named, so a second submit collides with the first. Three carry one:
`directTransactionCreateSchema`, `stageCreateSchema` and
`paymentSetupCreateSchema`.

`accountCreateSchema` is the case that makes the rule worth stating this way
rather than the other. It writes postings — an opening balance posts against the
equity account — so by the broad rule it needs a key, and it has none. The name
is the protection, and it is a better one: a second submit of the same account
fails on the unique index whatever key it carries, and a key would only have
made the *first* submit replay.

So: ask what a second identical submit collides with. If the answer is nothing
the caller supplied, it needs a key.

The mechanism is worth understanding rather than copying. `getIdempotent` looks
the key up **and hashes the request**
(`src/server/services/helpers.ts:146-177`).
Same key and same request returns the stored response. Same key and a
*different* request is a `conflict`, because the caller has reused a key for
something else and silently returning the old answer would be worse than
refusing.

The hash is over a canonicalized payload
(`src/server/services/helpers.ts:223`):
keys sorted, `undefined` dropped, dates as ISO strings. Without that, two
identical requests whose JSON key order differed would hash differently and the
retry would be refused.

**A trap this repository fell into.** Four integration tests built keys as
`` `prefix-${n}`.padEnd(16, "0") ``, which makes `prefix-1` and `prefix-10` the
same string. Where the payloads also matched, the second call returned the
first call's transaction and the test passed having written nothing. All four
now pad the counter rather than the string
(`tests/integration/category-by-name.integration.test.ts:28`).

*Checked by:* `tests/integration/duplicates.integration.test.ts`, "binds direct
transaction and staging idempotency keys to their request": the same request
twice comes back as one row, the same key over a changed amount is refused as a
`conflict`, and a stage whose `rawData` keys arrive in the other order still
replays, which is the canonicalization being exercised rather than the key.
Two simultaneous retries are covered a few cases below it. That a create takes a
key at all is held only on the agent surface, by
`tests/mcp-measurements.test.ts`, which counts the mutating tools from their
annotations and fails on one carrying neither a key nor an expected version. A
service function reached from a route has nothing equivalent behind it.

There is a third, argued way to earn `idempotentHint`, and it is named in that
test rather than derived: `WHOLE_STATE`. **A request that states the whole of
what it sets leaves exactly the state the first call left**, which is what makes
a PUT a PUT, and `set_active_accounts` is the one. A key there would be ceremony
that changes nothing and the annotation would be no truer for it. The next
whole-state setter goes in that set with its reason, not behind a key the test
would not have asked for — "the request replaces the whole resource" is a
property of the operation and not of its schema, which is why no sweep can find
it.

### 2.4 Namespaces are locked before they are read

**Binding.** Anything that decides "does this name already exist?" takes an
advisory lock on that namespace first, and there are five namespaces:
accounts, categories, payees, templates and recurrences
(`src/server/services/helpers.ts:362-423`). Otherwise two concurrent requests
both read "no", and both create.

Accounts were the fifth and were added late, which is the point of listing them.
`createAccount` called `assertAccountNameAvailable` under no lock at all, and
`updateAccount` held only the per-account-id reference lock — which does not
serialize two *different* accounts being renamed to the same name. Two
concurrent `POST /api/v1/accounts` naming one account both succeeded. There was
no `lockAccountNamespace` to have forgotten, which is why a walk of the call
sites would not have found it: nothing named a lock that did not exist.

The lock is per user and per namespace, so it serializes the smallest thing that
has to be serialized.

**What "already exists" means is the same in all five.** A name is compared
folded — case and spacing ignored, `normalizeHumanName` in
`src/shared/names.ts` — and accounts were the one namespace that compared
exactly, so "Checking" and "CHECKING" could sit side by side as two accounts
nobody could tell apart in a picker. They now compare folded too, inside the
lock (`assertAccountNameAvailable`, `src/server/services/accounts.ts`). In the
service rather than by a unique index on the folded name, because a deployment
that already holds two such accounts would fail the migration that added one;
this way they keep both and can rename either.

**The account lock now serializes two different questions, and the heading only
names one of them.** The second is "is there a free place?", which a plan that
caps active accounts makes a question two requests can both answer yes to.
Three of its five call sites check no name at all — `setActiveAccounts`,
`setAccountArchived` and `deleteAccount` — and they hold it because every path
that changes the live set has to, or two of them racing both take the last
place (`AGENTS.md`, which also lists the five: create, archive, restore, delete
and the choice itself). So the rule a new path has to pass is the wider one:
**take the namespace lock if you are about to decide a name *or* count what is
in use.** Read as a rule about names alone, a new live-set path that invents no
name would skip it correctly and still be wrong.

Two more rules ride on the locks, and both live in comments a new path will not
stumble on by itself. First, the order is fixed: all account locks in sorted id
order, then the account namespace, then the category namespace, then the payee
namespace (`src/server/services/helpers.ts:345-350`), with the template and
recurrence locks after those. Two writers that take the same locks in
different orders deadlock under concurrency, and nothing but the order stops
it. Second, the category lock is not only for paths deciding a name: a write
that merely *references* a category takes it too, because a category delete
counts references before it archives, and a create sitting between its
ownership check and its insert is invisible to that count — the recurrence
lands naming a dead category (`src/server/services/recurrences.ts:536-548`,
and the same guard in `transaction-templates.ts` and `budgets.ts`). A new write
that names or references a category needs the lock even though no name is
being invented.

The same holds for an account, and was missed until 0.2.1. `deleteAccount`
counts what names an account under that account's reference lock, and a
template or a recurrence checked the accounts it named under no lock at all, so
an account deleted while a recurrence naming it was being created left the
recurrence proposing flagged rows for good. Both now take the reference lock
first, ahead of the category lock, which is where every entry takes it. And
rows come after every namespace: voiding and restoring an entry took the
duplicate fingerprint and wrote the row before `prepareTransaction` reached the
namespaces, the reverse of a mass edit or a payee merge holding them and waiting
on that row, and voiding took no account lock at all, so it raced archiving the
same account. A commit now writes its staged rows in id order too, the order a
delete locks them in.

A sixth lock now sits in that range and is **not** part of the ordering.
`lockBillingState` (`src/server/services/helpers.ts:398-414`) is the same
mechanism for a different purpose: it serializes the read-decide-write in
`reconcileSubscription`, because Stripe guarantees no ordering between
deliveries and two replicas holding snapshots of one subscription would
otherwise both decide theirs is newer. It is taken alone, and its own comment
puts a constraint on future code that the ordering sentence above would
otherwise hide: **no path may take it together with a name lock**, because the
billing tables and the ledger tables have no reason to be written in one
transaction. Adding it to the order would be the easy mistake and would license
exactly the transaction that must not exist.

*Checked by:* `tests/integration/lock-order.integration.test.ts` for the order,
recorded through the real lock functions on an edit off a category, a void, and
a recurrence and a template naming an account and a category;
`tests/service-transactions.test.ts` for the two orders no recorder can see,
read from the source — the duplicate fingerprint in `setTransactionDeleted` and
the commit's row order. `tests/integration/duplicate-lock.integration.test.ts` for the
mechanism, from a second connection under a 400ms statement timeout: a blocked
waiter either expires or does not, and it expires. That is the duplicate
fingerprint lock rather than a name. `tests/name-locks.test.ts` holds the rule
itself, in two halves, because the accounts gap needed both: every function body
that reaches a name check reaches its namespace lock earlier in the same body,
and every one of the five namespaces has a lock to be reached. It reads the
source rather than racing two connections, which is the right tool for "did this
body take the lock" and not a claim that a race cannot be tested.

It can, and the free-places half of the lock is held that way:
`tests/integration/account-limit.integration.test.ts` races it four times —
"lets exactly one of two requests take the last slot", "…of a restore and a
create…", "…of two restores…" and "…of a restore and the chooser…" — and every
one passes deterministically. That is the lock working rather than luck. A
blocked waiter *blocks*: the second request sleeps on `pg_advisory_xact_lock`
until the first commits and then counts a set that includes it, so there is
exactly one winner every run. Without the lock there is no interleaving to hope
for either; both read the same count and both insert, every run. The fourth case
is the one to copy when the two paths are of very different lengths: the chooser
is a few statements and a restore is a dozen, so fired together the chooser
usually commits before the restore counts anything and the race passes with or
without the lock. It holds the chooser's transaction open after its write, so
the interleaving the lock exists for is *arranged* rather than waited for.

Sequentially the name half is covered by
`tests/integration/transaction-templates.integration.test.ts`, "refuses a second
template whose name differs only by case or spacing". The unique constraints
behind those names are on the raw text, so they catch an exact repeat and
nothing else; under concurrency a case variant has only the lock behind it, and
a payee has no row to constrain at all.

### 2.5 Every write to somebody's books is audited

**Binding.** 47 `writeAudit` calls, eleven `writeAuditMany`, and seven
`auditedTransaction`. The audit row carries the entity, the
operation, and the row before and after, serialized through `serializeRow` so a
`Date` does not end up in JSON as something unparseable.

An operation name is a sentence about intent, not a table verb:
`create_from_transaction` says a category was created as a side effect of
somebody entering money, which is a different event from creating one on the
Categories page, and a year later that difference is the whole value of the row.

**One module is outside this, and the heading says which writes are inside it.**
`billing.ts` is the second-largest file in the directory and the largest added in
0.2.0, it has ten write statements, and the word *audit* does not appear in it
once. That is a decision, not an omission. The audit log is somebody's history
of their own books, read back through `listAuditEvents` scoped to their
`userId`; a billing row is not their bookkeeping and mostly is not even their
request. Eight of the ten writes run from a Stripe webhook or the reconciliation
sweep, where there is no `Actor` to attribute a row to — `writeAudit` takes one,
and every one of those functions is in 1.1's table of entry points with none to
take. The other two record an intent to call Stripe and a customer id, which are
this deployment's bookkeeping with a payment processor. Stripe keeps the event
log for that side, and `billing_webhook_event` keeps the record of which
deliveries were answered — which is why `AGENTS.md` makes that table the one
that cascades from nobody.

A new write in `billing.ts` is therefore not automatically exempt: ask whether a
person would ever read this row back as something they did. If yes, it audits.

*Checked by:* `tests/integration/ledger.integration.test.ts`, "writes scoped
audit history", which asserts the rows are there, that a second tenant sees none
of them, and that they parse as the shape the MCP tool declares; and
`tests/integration/splits-audit.integration.test.ts`, "records which categories a
split's legs held, before and after", for the payload carrying the legs. The
same ledger file separates `create` from `create_from_stage` by requiring both
to appear, which is as close as anything comes to holding an operation name to
its intent.

The word *every* was unchecked until 0.2.0 and is now
`tests/service-audit-coverage.test.ts`, which derives the population the way
this paragraph said nothing did: every exported declaration in this directory
that writes a row, itself or through something here that does, and each one
reaching `writeAudit`, `writeAuditMany` or `auditedTransaction`. Reading
`writeAudit` alone would have called every bulk delete unaudited, since
`writeAuditMany` writes the table itself. The billing exemption is registered as
a **module**, which is the shape the paragraph above argues for, beside ten
named declarations. It has caught nothing yet, and that is the honest report: the
hand enumeration that preceded it came back clean. What it buys is that the next
unaudited write has to come here and join the register.

What it still cannot decide is whether an operation *name* is a sentence about
intent. That stays review, and the paragraph above is the only statement of it.

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
and template drafts to the merged spelling"). That the counter and the merge
agree table for table is `tests/reference-tables-merge.test.ts`, which derives
the population from `schema.ts` rather than listing it — a `category_id`
column, a `payee` column, or a `jsonb` one, because the three transaction-shaped
payloads hold both as fields rather than as columns — and names every table
deliberately outside it with the argument. `auditEvents` is the entry worth
reading: it is the one table a merge must *not* rewrite, because `before` and
`after` are what a row looked like at a moment that has passed.

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

### 2.8 An entitlement is read inside the transaction that enforces it, never stored

**Binding.** The largest guard added in 0.2.0 is the account freeze, and it is
built the only way a guard over a plan can be: `accountFreeze(tx, actor)`
(`src/server/services/accounts.ts:802`) reads the entitlement **on the caller's
transaction**, and `assertAccountsWritable(freeze, ids)`
(`src/server/services/accounts.ts:856`) refuses against what that read said.
Fifteen declarations across five modules take the freeze, and ten of them call
the assertion.

`AGENTS.md` is the authority for why it cannot be a column, and the argument is
not repeated here: entitlements change with nobody present, an override expires
at a moment no code observes, and a deployment that stops selling answers
`{billing: false}` while Stripe goes on charging its subscribers. A column
written on the way down would go on saying what it said then, and that last case
would lock paying customers out of their own books. `ledger_account.active` is
the person's choice and nothing else; `frozenAccountIds`
(`src/shared/domain.ts:3713`) combines it with the entitlement at read time.

The obvious alternative is to resolve the entitlement once at the edge — in the
route, or in a middleware — and pass the answer down. It is wrong for the reason
every read-then-write is wrong: the plan can change between the edge and the
write, and the write is the thing that has to be refused. Reading it on the
transaction that does the writing closes the window the same way the version
filter in 2.2 does.

Two details belong here because both look like mistakes.

**The refusal is a validation error, not a conflict**, and the choice decides
behavior two layers away: `validateDraft` catches a validation error and files
it as an issue on the staged row, so a frozen account makes one import row
repairable instead of killing the batch it arrived in. It is also what archiving
already throws, and a frozen account is the same kind of no.

**The pool-side read is a second function, not an optional parameter.**
`readAccountFreeze(actor)` (`src/server/services/accounts.ts:792`) exists for
`getAccount`, which holds no transaction. Giving `accountFreeze` an optional
`tx` would have been one function instead of two, and it is exactly the shape
2.1's second half forbids: a helper handed a transaction must never be able to
fall back to the pool, because that connection commits independently of the
caller that is about to fail. Splitting the function is how you obey that rule
without duplicating the decision — both call `frozenWithNames`, so there is one
rule and two ways in.

Every future plan limit wants this shape, and there will be more of them.

Read once per transaction, not once per row: a batch takes the freeze at its
boundary and hands it down, so an import of twelve rows reads the entitlement
exactly as many times as an import of two.

*Checked by:* `tests/services-guide.test.ts`, "an entitlement is read on the
transaction that enforces it", in four parts: no declaration holding a
transaction calls `readAccountFreeze`, `accountFreeze` itself never names
`getDb()`, the refusal is a `validationError` and not a `conflict`, and no
table stores a `frozen` column. The behavior is held by
`tests/integration/frozen-accounts.integration.test.ts`, which walks the
refusals — a new entry, a transfer from either side, a delete that names no
account at all, an edit moving money off, a payee merge — and by
`tests/integration/freeze-per-batch.integration.test.ts`, which counts the
entitlement reads for an import, a commit and a recurrence tick and finds one
each. What is argued rather than demonstrated is the consequence of the
validation error two layers down: no integration case yet stages an import row
against a frozen account and asserts the batch survives it. That case is worth
writing.

### 2.9 A write that leaves `version` alone says so, and says why

**House**, and the correction 2.2 needed. Optimistic concurrency is not uniform
here, and the exceptions are a shape rather than a list of accidents: **a column
a person cannot reach through the entity's own edit schema does not bump that
entity's `version`.**

Nine update statements in this directory take it, in seven declarations, and
every one argues it in a comment beside the write. They cross-cite each other,
which is how you can tell it is one decision made once:

- `setActiveAccounts` (`src/server/services/accounts.ts:929`) — "`active` is not
  part of `accountUpdateSchema` and nothing edits it through that path, so a
  bump here would invalidate the expected version in every form somebody had
  open for a reason that has nothing to do with what they were editing."
- `markFittingAccountsActive` (`src/server/services/accounts.ts:884`) — the same
  column from the other direction, and it says "like `setActiveAccounts`".
- `proposeDueOccurrences` (`src/server/services/recurrences.ts:316`) — "a tick
  advancing a watermark is not a change to what they configured".
- The four reference rewrites in the two merges
  (`src/server/services/categories.ts:1181`, `:1263`,
  `src/server/services/payees.ts:458`) — "a merge relabels what a recurrence
  points at without changing what somebody configured". 2.6 owns why the
  rewrites happen at all; this is why they are silent.
- `deleteCategoryGroup` (`src/server/services/category-groups.ts:281`) — and
  this one `AGENTS.md` states outright: the foreign key never bumped it, so
  bumping it would make a Citus cluster refuse an edit a single node accepts.

The obvious alternative is to bump always, because optimistic concurrency ought
to be uniform. It is wrong twice over. A bump is a refusal somebody has to
spend: it invalidates every open form on that row, and here it would do so for a
change they did not make and cannot see. And in the cluster case it would make
two deployments of the same release disagree about which edits succeed, which is
the divergence `AGENTS.md` wrote the category-group rule to prevent.

What these writes owe instead is the rest of the contract, and they pay it: the
row is locked or the statement is idempotent, `updatedAt` moves, and the person
can still see it happened — `setActiveAccounts` and `markFittingAccountsActive`
both write an `activate` or `freeze` audit entry per account, and the merges
select `for update` before rewriting so the audit row can say what each
reference held. Silence about the version is not silence about the change.

The shape recurs wherever a service writes a derived or server-owned column on a
row somebody else is editing, which entitlements and the cluster profile will
keep producing.

*Checked by:* `tests/services-guide.test.ts`, "every write that leaves `version`
alone is named with its reason", which sweeps every `.update(table).set({…})` in
the directory against the tables that have a `version` column and requires one
that does not set it to be on the list, with a line of reason each. A tenth
arriving unargued fails; so does an entry whose declaration has gone, which is
how the list in 1.1 learned to stay true.

### 2.10 A side effect waits for the commit, and the transaction's owner releases it

**Binding.** 2.1 settles when a transaction is opened and says nothing about
what must not happen before it closes. Three subsystems need that answer now,
and they answer it the same way: **anything that is not a write inside the
transaction — a metric, a message, a read through the pool, a follow-up write
that must not hold the lock — happens after the transaction has settled, and the
function that opened it is the one that releases it.**

**Metrics.** `ledger_writes_total` names the books rather than the traffic, so a
count standing for a write that rolled back is a lie about the books. Every
service counts through `countAfterCommit`
(`src/server/services/helpers.ts:205`), which counts immediately when the
service opened its own transaction and otherwise queues; the MCP transport
flushes with `flushDeferredCounts` after `getDb().transaction` resolves
(`src/server/mcp.ts:341`). Seven call sites, in `transactions.ts`, `staging.ts`
and `import-export.ts`, which counts the rows a CSV import staged.

The keying is the part a new author gets wrong, and the source says so where it
is written (`src/server/services/helpers.ts:197`): the queue is a
`WeakMap<DbTransaction, …>`. **A module-level queue would be shared between
concurrent requests and one request could flush another's counts** — the worse
bug in place of the one being fixed. Two requests hold two transaction objects,
so there is nothing to share, and the entry goes when the transaction is
collected whether anybody flushed it or not.

**Mail.** A message about rows that were then rolled back names a queue with
nothing in it, so it is sent after the transaction that earned it commits, never
inside it (`AGENTS.md`). `proposeDueOccurrences` collects what to announce
through a callback and `runDueRecurrences` sends it outside, awaited rather than
left running (`src/server/services/recurrences.ts:413`); the reminder sweep
sends after `claimDueNotification`'s transaction has moved the watermark and
committed.

**A follow-up write, and a follow-up read.** `deferSubscriptionRead`
(`src/server/services/billing.ts:2271`) stamps a failed attempt *after* the
locked write it follows has let its lock go, "so it can land where the locked
write above timed out". And `setActiveAccounts` returns `listAccounts(actor)`
from outside its own transaction, because `listAccounts` reads through the pool
and at `READ COMMITTED` a second connection cannot see writes the first has not
committed — inside, it would answer with the state from before the change, and
on a one-connection pool it would not answer at all.

Who releases it is the half worth stating, because it is not obvious: **the
opener**, because only the opener knows the commit happened. A service handed
somebody else's transaction cannot know, which is why `countAfterCommit` queues
rather than deciding, and why the flush is one line in `mcp.ts` rather than a
line at each of the six places that count.

The obvious alternative is to do the side effect last inside the transaction, on
the grounds that it is about to commit anyway. It is wrong for the case the
whole mechanism exists for: "about to commit" includes the commit failing, and
for MCP there are statements after the service returns — an idempotency record
to write and the commit itself to survive. A count made there stands for a write
that may never have happened.

*Checked by:* `tests/services-guide.test.ts`, "a metric about the books waits
for the commit", which holds the two halves a program can see: every
increment of a metric a service imports is inside a `countAfterCommit`
callback — every one, after `csv_rows_staged` was counted straight inside
`stageCsv` while the check asked only about `ledgerWrites` — except the
idempotency replay count, which is traffic rather than the books and is named
with that reason,
and the deferred queue is keyed on the transaction rather than on a module-level
collection. Mail is held by `tests/integration/notifications.integration.test.ts`
— "writes when it proposes, and says what it proposed", "says nothing on a tick
that proposes nothing", "collapses a backlog into one message" — which is the
outcome the ordering exists for: nothing is announced that a rollback took
back. That the send is *outside* the transaction rather than merely after the
last statement in it is argued in the source and not mechanized, because no
source read can tell "after" from "outside".

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
not worth having. `no-await-in-loop` finds 58 sites in this directory and 270
across the whole repository; the repository-wide figure is the one in
`index.md`'s re-measured column, where the category was declined — the 147 in
its decision-time table is the same measurement taken on an older tree. Both
guides quote the same `npx oxlint -A all -D no-await-in-loop .`, so the two
figures move together or one of them is wrong. The 212 sites outside this
directory are 188 in `tests`, 18 in `scripts` — the capacity harness and the
product-kit build, neither of which is shipped — and six elsewhere in `src`.
The test sites are almost all integration tests awaiting one request at a
time, which is a different thing from a service resolving names in order. Some
of the 58 here are opportunities. At least one is load-bearing:

```ts
Legs resolve one at a time rather than in a batch, so that two legs naming
the same new category end up on one category rather than two: the second
lookup sees what the first created.
```

(`src/server/services/categories.ts:182-184`, the docstring on
`resolveDraftCategory` rather than the signature under it.)

Run those in parallel and a split naming "Groceries" twice creates two
categories. The sequence *is* the algorithm. A linter cannot tell that apart
from an accident, so the rule is off and the reasoning lives in the comment
beside the loop.

The rule for a reader: parallelize reads that do not see each other's writes;
never parallelize a loop whose iterations resolve names.

*Checked by:* `tests/integration/splits.integration.test.ts`, "creates a category
named by a leg, and reuses it for a second leg naming the same one" — the outcome
the sequence exists for, on two legs spelled "Garden supplies" and "garden
supplies", asserting they land on one id. Resolution matches on a normalized name
and stores the raw one, so two legs resolved side by side would insert two rows
that `category_user_name_unique` is perfectly happy with, and the assertion
fails. Nothing checks the other half, that the loop stays sequential, because the
rule with an opinion about it is the one turned off.

### 3.3 Money is summed in the database or in `decimal.js`, never in JavaScript numbers

**Binding.** `AGENTS.md`. On the server that means `decimal()`
(`src/server/services/helpers.ts:22`)
and `canonicalDecimal` on the way out, so every amount that crosses a boundary
is the same string for the same value.

`numeric(44, 18)` in, canonical decimal string out. No stage in between is a
`number`.

*Checked by:* `tests/quality-fixes.test.ts`, which refuses `Number(` or
`parseFloat(` reaching a value whose name is money. Refusing the conversion
outright would be the wrong rule and the first run said so: every site in the
services is a count — periods, entries, staged rows — and a count is a number.
So it is the vocabulary that decides, read word by word through camelCase and
underscores so `sourceAmount` and `opening_balance` are money as well as
`amount` — it matched whole names, and missed every compound — and the
contract's own fields are derived rather than listed: every field
`src/shared/domain.ts` builds from `DECIMAL_DIGITS`, which is how `rolloverCap`
is money with no money word in it. A money word nobody has used yet still has
to be added to the list, and that is the honest limit of a source read.

## 4. Naming a category, and why it is in this guide

**Binding**, because it is the rule most recently got wrong.

Resolving a category by name never widens the category it finds
(`src/server/services/categories.ts:142`).
Widening to `both` was correct while an entry could only name a category of its
own direction. It stopped being correct when a category running against the
direction became a refund, and it stopped quietly: `both` agrees with whichever
direction it is handed, so every later refund into that category credits income
instead of lowering the spending.

Where the direction genuinely cannot decide — a name with nothing behind it
yet — the caller says so with `categoryKind`
(`src/server/services/categories.ts:197`),
and that field is ignored when the category already exists, because that one has
an answer already.

*Checked by:* `tests/integration/category-by-name.integration.test.ts`, whose
last eight cases are exactly this, and
`tests/integration/budgets.integration.test.ts` for the money proof — a refund
into a spending category it created itself has to move a budget.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.4 One public function per intent | Whether two operations are one intent with a boolean is the judgement being asked for, and anything able to settle it would not need the rule written down. The nearest check belongs to another guide: `tests/http-route-table.test.ts` refuses a route ending `/archive` or `/delete`, which is this split where it reaches a URL and nowhere else. |
| 2.7 Guards hold for siblings | No program knows which paths are siblings. The two ledger instances are pinned; the class is a review question. |
| 3.1 Reads before dependent writes | Only the outcome is testable, and it is: the refund tests are that check wearing a different hat. |

Three `human` rules in this guide. It was four until 0.2.0 closed 2.6, and the
row that left is worth one sentence because its reasoning is what kept it
unbuilt: it said that "whether a NEW reference table reaches both lists is a
fact about a diff, which only a reviewer sees", and that was wrong about where
the fact lives. `tests/reference-tables-merge.test.ts` derives the population
from `schema.ts` — a `category_id` column, a `payee` column, or any `jsonb`
column — rather than from either list, so a new reference table is a fact about
the *schema* and no diff is needed to see it. A sentence here used to say which of
them were "new to the table", and it named 1.3; it survived a renumbering and
went on resolving, to a rule that now carries five tests and is not in the table
at all. Nothing checks a section number against the heading it was written for,
so a number is a pointer that is never dangling and often wrong — which is why
this paragraph claims nothing about the table that the table above does not
say.

Everything else is held, in whole or in part, and each section says underneath
it which part. `tests/service-transactions.test.ts` holds 2.1, reading the
parameter list rather than grepping for a name, so a mutation that delegates its
writes to a helper still counts. `tests/transport-database-access.test.ts` holds
as much of 1.2 as a program can be asked: not "does this line belong here",
which is judgement, but "is a transport querying the database", which is what
that judgement going wrong looks like. `tests/services-guide.test.ts` holds the
three rules added in 0.2.0 — 2.8's "read it on the transaction", 2.9's list of
writes that leave `version` alone, and 2.10's "every count waits for the
commit". Three more — 2.2, 2.4 and 2.5 — are held in part.
