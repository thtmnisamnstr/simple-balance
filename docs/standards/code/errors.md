# Errors

Failing: which error, carrying what, phrased how.

The wire format — RFC 9457, status codes, the envelope — is
[`docs/standards/http.md`](../http.md). This is about the throw site.

## 1. One error type

**Binding, with one named exception.** Anything a caller could act on is an
`AppError` (`src/server/services/errors.ts:31`). It carries a code, a message, an
HTTP status, optional details, and an optional second message for an agent
(see 2.2 and 2.4). Both transports render it: HTTP into a problem document, MCP
into a tool error — and the MCP one puts `agentMessage` where the message would
go wherever a throw site set one (`src/server/mcp.ts:293`), so the fifth field
is wire-visible rather than a note to ourselves.

The distinction is the question **is there something the caller could do
differently?** If yes, it is an `AppError`. If no, it is a bug, and a bug should
throw a bare `Error` or `TypeError` and become a 500 — because a 500 is what
"this should be impossible" means, and dressing it as a 422 would tell the
caller to fix something they did not do.

Twelve throws in `src/server/services` are that second kind, and all twelve are
correct. They come in four shapes: three `TypeError`s in the idempotency
canonicalizer for payload shapes that cannot occur
(`src/server/services/helpers.ts:230`, `:246` and `:252`); two for a reference
count that came back non-numeric after being cast to one in SQL
(`src/server/services/payees.ts:58` and `src/server/services/categories.ts:469`);
three for an `insert().returning()` that came back empty, which either throws or
returns the row (`src/server/services/budgets.ts:568`, `:945` and
`src/server/services/category-groups.ts:132`); and four in billing, each
doubting something established moments earlier — the route's own registration,
the actor's user row, a customer row whose insert had just lost a conflict, and
a subscription Stripe cannot return without a price
(`src/server/services/billing.ts:679`, `:993`, `:1022` and `:1600`). The reason
each cannot happen is written beside it in the test rather than copied here.

So the rule is not "never throw a bare `Error` here". It is "never throw one for
something the caller could have got right".

*Checked by:* `tests/service-errors.test.ts`, which is that list rather than a
ban, and which now holds it from three sides: each of the twelve carries the
reason it cannot happen and a thirteenth fails until somebody writes down which
kind it is; an entry whose throw has been deleted fails too, so a licence cannot
outlive the line it was written for; and the population is counted, so a scan
that has stopped matching cannot pass for a clean sweep. Whether the reason is
honest is still review; whether the throw was thought about at all is now a test.

## 2. Five constructors, and choosing between them

**Binding in `src/server/services`.** Never construct `AppError` directly there;
use the constructor that names the situation.

| Constructor | Status | Use when |
| --- | --- | --- |
| `notFound` | 404 | The record is not there, or is not theirs. Both, deliberately — see 2.1. |
| `conflict` | 409 | The request contradicts the current state in a way retrying will not fix. |
| `staleVersion` | 409 | Specifically: it moved since they read it. |
| `duplicate` | 409 | A name or a reference already exists. |
| `validationError` | 422 | The request is well-formed and asks for something impossible. |

**The transport is the named exception, and it is two lines.**
`src/server/api.ts` constructs `AppError` directly at `:1636` and `:1654`, and
both carry a code no service raises at all: `FORBIDDEN` and
`REAUTHENTICATION_REQUIRED` belong to the two operations that are reachable
from a session and never from a token, which is exactly the pair `AGENTS.md`
names as the boundary between the surfaces.

**The type is not what keeps them out, and believing it is would mislead.**
Both are in `serviceErrorCodes` already (`src/shared/domain.ts:2705-2715`),
which is why `new AppError("FORBIDDEN", …)` type-checks anywhere at all; what
`ServiceErrorCode` narrows against is the transport list beside it
(`src/shared/domain.ts:2727-2744`), and neither of these is in that. So the
reason there is no sixth constructor is an argument rather than a compiler
error, and it has to be made rather than assumed: a constructor is an
invitation, and what it would invite is a service raising
`REAUTHENTICATION_REQUIRED` — a refusal whose only answer is signing in again,
on the surface where there is no session to sign in to.

So the rule is scoped rather than absolute: a service uses the constructors, and
the transport may name a status the service half has no word for. It was four
lines rather than two, and shrinking it is what the other two paragraphs of this
section used to be about. The already-configured-password site was byte-for-byte
what `conflict()` produces and now calls it (`src/server/api.ts:1645`). The malformed-body guard
was a `VALIDATION_ERROR` **400** where the constructor is 422 by definition,
which is why it could not use one — it is now a `TransportError`
(`src/server/api.ts:1519`, the class at `src/server/services/errors.ts:13-23`),
a separate enumeration for the refusals that are about the request rather than
about the ledger, so `VALIDATION_ERROR` means one status again and the code an
MCP tool can raise stays the service half alone.

*Checked by:* `tests/service-errors.test.ts` for both halves, in two assertions
that name neither half and close both. One holds every code constructed
anywhere under `src/server` to a single status — which is the exact defect the
paragraph above narrates, `VALIDATION_ERROR` meaning 400 at one site and 422 at
the rest. The other bans an error body assembled anywhere but three named
constructs — `errorEnvelope` and `transportError` in `api.ts`, `errorResponse`
in `http-security.ts` — each counted, since a shape built at a route is a shape
no enumeration covers. It excused the two files whole until a narrower read
found three bodies built inline in `api.ts`: the session gate's 401 goes through
`transportError` now, and the two catch-all 404s throw `notFound`.
`tests/errors-guide.test.ts` holds the count the prose claims: the direct
constructions stay at those two lines and those two codes, the thrown
`TransportError` stays at its one, and no service builds either by hand.

### 2.1 "Not yours" is "not found"

**Binding.** A record belonging to another user is a 404, never a 403. A 403
confirms the id exists, which is a cross-tenant leak of exactly one bit, and one
bit is enough to enumerate.

Because every query is scoped by `actor.userId` (see `services.md` 1.1), this
falls out naturally: the row simply is not in the result.

**One 403 says "not yours", and it is not about a record.** An MCP consent
started in one account and answered in another is refused with
`CONSENT_NOT_YOURS` and a 403 (`src/server/api.ts:894-901` and `:935-942`).
The consent code is a single-use secret the authorization link carries, not an
id anybody can enumerate, so the bit the 403 confirms is one the person holding
the link already has. And the sentence is the move that works — sign in as the
account that started it — which a 404's "not found" would hide. It stays a 403
because it shipped as one: a client that reads the status would break on a
404.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts`, which
reaches for one person's accounts, categories, category groups, payees,
transactions and budgets as somebody else and insists the refusal is the
not-found one — the budget and group calls on `status: 404` outright, the older
ones on the sentence. The group is the one worth having: its reference is
single-column rather than composite, so the database does not stop a category
pointing at somebody else's, and only the service does.

It walks the services it names rather than the surface, so a service added later
goes unchecked until somebody adds it there — and billing is in exactly that
position now. Nothing reaches `billing_customer` or `billing_subscription` as
the wrong tenant. The suite also needs a `TEST_DATABASE_URL`, which
`npm run verify` does not have.

### 2.2 `staleVersion` is its own thing for a reason

**House.** It could be a `conflict` with a message. It is separate because it is
the one conflict a client can resolve automatically — reload, re-apply, retry —
and it carries `currentVersion` in its details so the client can say what
happened rather than "something went wrong".

Its message is fixed at the constructor
(`src/server/services/errors.ts:102-115`)
because there is nothing per-site to add. **Four** sentences are fixed there
now, two per audience, and the constructor picks the pair from the shape of the
details rather than from the throw site: `message` is what a browser reads,
`agentMessage` — read by the MCP transport and by nothing else — is what an
agent reads, and each has a second form for a refusal that arrived with a
selection fingerprint.

That second form is not a refinement, it is a different refusal wearing the same
code. A mass change describes its set with a server-issued count and fingerprint
rather than with a version, so "read the row again" is advice its caller cannot
take and "reload to see the current version" names no row to reload. Both halves
say to preview the selection again, which is what issues the next count and
fingerprint. Same diagnosis, different next move, which is what
[`common.md`](../common.md#errors) asks for — and the bulk selection contract in
`AGENTS.md` is why the pair is two sentences and not one.

*Checked by:* `npm run typecheck` for the fixed message, since `staleVersion`
takes details and nothing else and a throw site therefore has no parameter to
put a sentence in; `tests/error-messages.test.ts` for the single-row pair, which
reads both halves of one refusal — "tells the browser to reload", "tells an
agent where the version it needs is, when the throw site sent one" — and pins
the code, the status and the details as the same for both; and
`tests/domain.test.ts` for the fingerprint pair, which also holds the browser
half to the sentence `common.md` publishes.

One throw site's judgement **is** reached, over a real agent connection:
`tests/integration/mcp-tools.integration.test.ts` calls `update_account` with a
version that has moved and insists the agent sentence arrives rather than the
browser one, *and* that the `currentVersion` it points at is the row's real
version — the sentence and the field it names, checked together. What nothing
reaches is that judgement at the other fifty-two sites: whether this conflict is
the automatic kind, and whether it passed the version it could have. Thirteen of
the fifty-three carry no details, and the constructor drops the field name
rather than pointing at something that is not there, so the omission costs the
agent its next move and costs the suite nothing.

### 2.3 `duplicate` carries the id of what it collided with

**House.** `duplicateCategoryId` and `normalizedName`, so a client can offer
"use the existing one" instead of making the person retype. An error that only
says no is doing half its job.

*Checked by:* `tests/integration/categories.integration.test.ts`, whose "rejects
normalized duplicates on create and update" matches both fields against the
category actually collided with, on each of the two paths. Only the category
refusal is held to it. The account, template and recurrence duplicates carry an
id nothing asserts, and the offer the fields exist for has not been built:
`duplicateCategoryId` occurs once in `src`, at the throw, so what is checked is
that the error is carrying it and not that anything acts on it.

### 2.4 Where the fix is a move only a person can make, the agent gets its own sentence

**House**, and now mechanized. The second audience has outgrown 2.2, which still
frames it as a property of one constructor. `conflict` takes an `agentMessage`
too (`src/server/services/errors.ts:75`), and the comment above it makes the
argument: this **widens** the constructor rather than adding a sixth, because
the five-constructor rule in 2 is about how a service raises a refusal, not
about how many arguments the refusal carries.

The two callers show the rule running in both directions, which is what makes it
a rule rather than a workaround for billing. The account allowance
(`src/server/services/accounts.ts:731`) tells a browser to upgrade under
Settings, and tells an agent that only the person who owns the ledger can raise
the limit: billing is session-only by `AGENTS.md`, so an agent told to upgrade
is told to do something it holds no credential for, which is the same fault as
telling it to reload. The active-account chooser
(`src/server/services/accounts.ts:967`) goes the other way. This is a call an
agent *can* make, so its sentence names the call, says what a valid one looks
like, and — where nothing is frozen — says that no list at all is valid, so the
agent stops trying different ones instead of guessing.

Six throw sites carry one today and the shape recurs: the archive restore meets
the same ceiling from the other side
(`src/server/services/accounts.ts:1204`), the frozen-account refusal is the same
argument under a 422 (`src/server/services/accounts.ts:861`), and the two in
`closeBillingForDeletion` (`src/server/services/billing.ts:1998` and `:2005`)
give a person the move each cause leaves them — whoever runs the server, where
the keys cannot vouch for Stripe's answer, and a retry in a few minutes, where
Stripe could not be reached — while naming the cause, and whether retrying
helps, for a program. Those last two are reached only from the
session-only deletion path, so nothing renders them today — written that way
because the browser's sentence would be the wrong one if it ever widens, which
is cheaper than noticing later. Every refusal whose remedy is browser-only has
this shape, so there will be more.

**What the obvious alternatives were.** One sentence for both audiences is what
2.2 already rejects, and it fails in whichever direction it is written: the
browser gets tool names it cannot use, or the agent gets a button it cannot
press. A constructor per audience — `conflictForAgent`, say — is what the source
rejects, and for a reason worth keeping: the audience is not a kind of refusal.
`notFound` does not split in two because a person and a program read "not found"
the same way, and a constructor set indexed on who is listening would double
every row of 2's table to express nothing about the ledger.

The rule carries one constraint the prose around it does not: **the agent half
may not name a field the refusal is not carrying.** That is why the `carries`
guard exists (`src/server/services/errors.ts:86`) — thirteen of the fifty-three
`staleVersion` sites send no details at all, and pointing an agent at
`details.currentVersion` when nothing is there is the same fault as telling it
to refresh, one field deeper.

*Checked by:* `tests/errors-guide.test.ts`, which is a census rather than a ban,
the shape 1 uses and for the same reason — whether two callers need different
advice cannot be read off a call's syntax, but who claimed they did can be. It
finds every `conflict` and `validationError` given a third argument, holds the
set to the six argued for, fails on an entry whose throw has gone, counts them,
and refuses a sentence naming a `details.` field its own declaration neither
guards nor builds. It also holds `agentMessage` to one reader: `src/server/mcp.ts`
renders it and `src/server/api.ts` must not, or browser copy would change
without anybody editing a browser sentence.

## 3. Messages

### 3.1 A message says what to do, in the words the product uses

**Binding**, shared with `docs/standards/common.md`.

The message goes on a screen. It says what went wrong and what would work,
in the vocabulary of the product rather than of the schema:

> That category's budget already starts on 2026-03-01, which is this period or
> later. Change that budget's amount instead, or set an amount for one period
> only.

That is one message from the budget overlap refusal. It names the date, says why
the obvious fix will not work, and offers the two that will. The version it
replaced said the window overlapped, which was true and useless — it described
the check rather than the situation.

**No apologies, no "unexpected", no exception text.** "Sorry, an unexpected
error occurred" is three words of apology and no information. The 500 both
transports send said exactly "An unexpected error occurred" until 0.2.1; it is
`INTERNAL_ERROR_MESSAGE` now (`src/server/services/errors.ts`), which says the
server could not finish and the one move left. `tests/ui-copy.test.ts` refuses
"unexpected" and "an error occurred" with the other banned words, over template
literals and JSX text as well as quoted strings.

### 3.2 A refusal names the specific case when it can

**House.** The same overlap refusal branches on whether the clash starts in the
same period, because the advice differs. Two sentences beat one general one
whenever the caller's next move differs.

### 3.3 A Zod message is the one somebody wrote

**Binding.** Zod refusals arrive wrapped: the envelope says "Request validation
failed" and the sentence somebody actually wrote is buried in the details
array. Showing the envelope is how "A budget cannot be negative" reached the
screen as "Request validation failed".

The client digs the messages out of the details
(`src/client/api.ts:143-149`, discriminating on `path` so a CSV parser's errors
fall through), deduplicates them on the field-and-sentence pair rather than the
sentence (`:157-165`), and shows those in preference to the envelope (`:169`).
Which means schema messages are user-facing: write them that way.

Nineteen request schemas left their length rules to Zod, so typing a space where
a category name goes read "Too small: expected string to have >=1 characters".
Every free-text field now passes its sentence beside its number — `enter(…)`
for an empty one, in the GOV.UK form `common.md`'s table uses, and `atMost(…)`
for one too long — and a template mass edit's empty string says that `null` is
the clear, since that refusal is deliberate and only an agent can reach it.

*Checked by:* `tests/schema-messages.test.ts`, which refuses any `.min` or
`.max` on a `z.string()` in `src/shared/domain.ts` that passes no message, with
a register of the output schemas no refusal is ever read from, and samples the
sentences at both ends; `tests/domain.test.ts` pins several specific messages;
and `human` on the phrasing, which is the half a source check cannot judge.

## 4. Refusing early, and previewing the refusal

**House.** Some rules the browser has to know before it submits, or the person
gets a 422 the screen never hinted at. Those live in `src/shared` as a function
returning a result rather than throwing
(`src/shared/domain.ts:174`):

```ts
{
  ok: false,
  message: "A deposit is either income or a refund, not both. Enter it as two transactions.",
}
```

A withdrawal gets its twin — "either spending or income coming back" — because
3.2 asks a refusal to name the specific case, and here the direction *is* the
case (`src/shared/domain.ts:183-184`).

The service calls it and throws the message; the form calls it and renders the
message. One sentence, one source, and the screen can never disagree with the
server about what is allowed.

The rule for deciding: if the browser can tell in advance, it must, and the
sentence must be the same one.

Four more arrived with the plan and the frozen account, and each was a screen
that let somebody start something the server would refuse.
`PLAN_ENDING_REFUSAL` is thrown by `PUT /api/v1/billing/subscription` and is
what the plan tab disables both plan buttons with, imported rather than
retyped. `subscriptionAction` decides on both sides which of the moves a press
is, so a button is disabled exactly where the route would refuse it.
`PLAN_GRANTED_REFUSAL` is the same shape for an operator's grant, thrown by
that route and by `POST …/payment-setups/confirmations`, and `planIsGranted`
is the predicate both sides ask. It is the one of the four where the browser
has to be told *when* to blame it: a plan already held and a plan set to end
are disabled on their own account, so the tab offers the grant's sentence only
where `planChangeTakesEffect` says the press would have spent money, which is
the same line the route draws with `sellsSomething`.
`frozenAccountRefusal` (`src/shared/domain.ts:4012`) is thrown by
`assertAccountsWritable` (`src/server/services/accounts.ts:856`) and is the
reason an account card's **Edit**, **Archive** and **Delete** now carry, and a
transaction row's **Edit**, **Delete** and **Restore** with them.

**The third of those took two rounds to become one sentence, and the shape of
the mistake is the lesson.** It began as a browser prefix — a transaction row
wrote `` `${account.name}: ` `` in front of the shared refusal, because a
transfer has two sides and the shared sentence named neither, while the
server's named no account at all. That is a second sentence about one rule,
which is what this section exists to prevent, so the name moved to the shared
side: `frozenAccountRefusal(limit, name?)`, with `assertAccountsWritable`
passing the name it already had. The optional half is not a hedge — the one
caller that still leaves it off is **Add transaction**, which is dead because
*every* account is frozen, so there is no one account to name.

**Landing it on one surface and not the other was the same defect again.** The
transaction row read the named sentence and the account card went on building
the unnamed one, so two screens a person reaches from the same page disagreed
about what the server would say. A refusal that moves to the shared side has
to move at every call site in the same change, or the divergence has simply
changed address.

*Checked by:* four suites, three of them built with the plan and the frozen
account. `tests/domain.test.ts` pins `resolveEntrySide`'s two refusals at the
source. The other three use the technique worth naming — **the rendered sentence
is compared to the shared function's own return value rather than to a retyped
string**, which is what catches a hand-rolled near-match rather than only a
deletion. `tests/frozen-accounts.test.ts` holds `frozenAccountRefusal` named and
unnamed, including that leaving the name off is byte-for-byte passing
`undefined`; `tests/frozen-accounts-ui.test.tsx` asserts the account card's and
the transaction row's disabled controls carry `frozenAccountRefusal(…)` itself
as their accessible description; and `tests/plan-page-ui.test.tsx` asserts both
plan buttons carry `PLAN_ENDING_REFUSAL`, imported rather than retyped. The
server halves are held to the same constants where a database is available —
`tests/integration/frozen-accounts.integration.test.ts` and
`tests/integration/billing-stripe.integration.test.ts`, neither of which
`npm run verify` runs. What stays review is the first half of the rule: whether
a browser that *could* tell in advance does.

### 4.1 A check constraint has a Zod twin, and the twin names the field

**Binding.** What the database would refuse, the schema refuses first, as a 422
naming the field — because the constraint's own refusal arrives as a 500 with a
stack trace for what is only ever a mistyped value. The twin covers the WHOLE
constraint: the budget percent rules validated the floor while the constraint
capped both ends, so a mistyped 10000 passed Zod and died on the check; and the
control-character refinements existed for most text fields while a NUL in a
bulk patch traveled all the way to a jsonb write PostgreSQL refuses. When a
constraint moves — 0018 widened the incremental floor — the twin moves in the
same change, which is why the twin lives beside the schema field rather than in
a service.

*Checked by:* `tests/constraint-twins.test.ts` for the half a program can do,
and a reader for the other half. A program can enumerate the check constraints
in `src/server/db/schema.ts` — fifty-five today — but cannot prove a refinement
is the same predicate, so the test refuses a constraint nobody has paired with
anything and leaves what the pairing *means* in the register's reason column.
An entry either names the shared symbol carrying the twin, which has to exist
in `src/shared`, or argues that no request reaches the column at all: a posting
nothing outside the services writes, a hash the server computes, a status that
is the queue's own state machine. The pattern's instances stay under test as
well — `tests/domain.test.ts` for the refinements, the integration suites for
the constraints.

### 4.2 What is read back is validated more loosely than what is written

**House.** A write schema is a gate; a read-back schema is a description. The
queue deliberately admits payees the strict schema refuses — a bad import goes
there to be FIXED — so validating the read of the payee listing with the write
schema meant one staged control character broke its owner's whole payee page at
the parse step. A read-back schema refuses only what would make the answer
unusable (missing keys, wrong types), never what makes a row ugly: ugliness is
the row's own issue list's job.

*Checked by:* `human`. The instance is pinned where it bit
(`src/shared/domain.ts:1231-1236`, the comment on `payeeSummarySchema.name`).

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 3.1 Messages say what to do | Editorial. |
| 3.2 Refusals name the specific case | Editorial. |
| 4.1 Constraint twins, the predicate half | A program can list the constraints and refuse an unpaired one, which `tests/constraint-twins.test.ts` does; it cannot prove a refinement is the same predicate. |
| 4.2 Read-back looseness | Which strictness a schema needs is a fact about who reads it. |

Three `human` rules in this guide and a half: 3.1, 3.2 and 4.2 whole, and 4.1's
predicate half. 4.1 was whole until `tests/constraint-twins.test.ts` took the
enumeration, which is the smallest useful move a `human` rule can make — the
part a program can refuse is split off and the part it cannot is left saying so.
Section 1 is not among them, and how it stopped being one is the pattern the rest of
this guide copies: a blanket ban on `throw new Error` under
`src/server/services` would flag the twelve correct ones, and which kind a throw
is cannot be read off its syntax. So `tests/service-errors.test.ts` inverts it —
it holds the list of throws already argued to be impossible, and fails on a new
one nobody has argued for. A rule that could not be checked became a rule about
its exceptions, which can be. 2.4 is the second rule here built that way, over a
population nobody can enumerate in a type.