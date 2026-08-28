# Errors

Failing: which error, carrying what, phrased how.

The wire format — RFC 9457, status codes, the envelope — is
[`docs/standards/http.md`](../http.md). This is about the throw site.

## 1. One error type

**Binding, with one named exception.** Anything a caller could act on is an
`AppError` (`src/server/services/errors.ts:10`). It carries a code, a message, an
HTTP status and optional details, and both transports render it: HTTP into a
problem document, MCP into a tool error.

The distinction is the question **is there something the caller could do
differently?** If yes, it is an `AppError`. If no, it is a bug, and a bug should
throw a bare `Error` or `TypeError` and become a 500 — because a 500 is what
"this should be impossible" means, and dressing it as a 422 would tell the
caller to fix something they did not do.

Five throws in `src/server/services` are that second kind, and all five are
correct: three `TypeError`s in the idempotency canonicaliser for payload shapes
that cannot occur (`src/server/services/helpers.ts:131`, `:147` and `:153`), and
two `Error`s for a reference count that came back non-numeric after being cast
to one in SQL (`src/server/services/payees.ts:52` and
`src/server/services/categories.ts:486`).

So the rule is not "never throw a bare `Error` here". It is "never throw one for
something the caller could have got right".

*Checked by:* `tests/service-errors.test.ts`, which is that list rather than a
ban — each of the five carries the reason it cannot happen, and a sixth throw
fails until somebody writes down which kind it is. Whether the reason is honest
is still review; whether the throw was thought about at all is now a test.

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

**The transport is the named exception, and it is four lines.**
`src/server/api.ts` constructs `AppError` directly at `:983`, `:1028`, `:1037`
and `:1050`. One carries a code a constructor covers and three carry codes no
service raises at all: `FORBIDDEN` and `REAUTHENTICATION_REQUIRED` belong to the
two operations that are reachable from a session and never from a token, which
is exactly the pair `AGENTS.md` names as the boundary between the surfaces. A
constructor for them would put a transport-only code in the service vocabulary
that `ServiceErrorCode` narrows on purpose.

So the rule is scoped rather than absolute: a service uses the constructors, and
the transport may name a status the service half has no word for. This said
there were two `VALIDATION_ERROR` sites that should use `validationError` and
did not. One of them now does — the failed password update at `:1062`, which was
a 422 with a message and had no reason to spell the constructor out. The other
cannot: the malformed-body guard at `:983` is a **400**, not a 422, because a
body that is not JSON is a malformed request rather than an impossible one, and
`validationError` is 422 by definition. That is an exception with a reason
rather than the defect this paragraph used to call it.

*Checked by:* `tests/service-errors.test.ts` for the service half, which is
where the rule bites. Nothing checks the transport half.

### 2.1 "Not yours" is "not found"

**Binding.** A record belonging to another user is a 404, never a 403. A 403
confirms the id exists, which is a cross-tenant leak of exactly one bit, and one
bit is enough to enumerate.

Because every query is scoped by `actor.userId` (see `services.md` 1.1), this
falls out naturally: the row simply is not in the result.

*Checked by:* `tests/integration/tenant-isolation.integration.test.ts`, which
reaches for one person's accounts, categories, transactions and budgets as
somebody else and insists the refusal is the not-found one — the budget calls on
`status: 404` outright, the older ones on the sentence. It walks the services it
names rather than the surface, so a service added later goes unchecked until
somebody adds it there, and the suite needs a `TEST_DATABASE_URL`, which
`npm run verify` does not have.

### 2.2 `staleVersion` is its own thing for a reason

**House.** It could be a `conflict` with a message. It is separate because it is
the one conflict a client can resolve automatically — reload, re-apply, retry —
and it carries `currentVersion` in its details so the client can say what
happened rather than "something went wrong".

Its message is fixed at the constructor
(`src/server/services/errors.ts:59-68`)
because there is nothing per-site to add. Two messages are fixed there now, one
per audience: `message` tells a browser to reload, and `agentMessage` — read by
the MCP transport and by nothing else — tells an agent to read the row again and
retry with the version, naming `details.currentVersion` only where the throw
site carried one. Same diagnosis, different next move, which is what
[`common.md`](../common.md#errors) asks for.

*Checked by:* `npm run typecheck` for the fixed message, since `staleVersion`
takes details and nothing else and a throw site therefore has no parameter to
put a sentence in; and `tests/error-messages.test.ts` for the two audiences, which
reads both halves of one refusal — "tells the browser to reload", "tells an
agent where the version it needs is, when the throw site sent one" — and pins
the code, the status and the details as the same for both. What nothing reaches
is the judgement at the throw site: whether this conflict is the automatic kind,
and whether it passed the version it could have. Thirteen of the fifty sites
carry no details, and the constructor drops the field name rather than pointing
at something that is not there, so the omission costs the agent its next move
and costs the suite nothing.

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
error occurred" is three words of apology and no information.

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
(`src/client/api.ts:63-72`) and shows those
in preference to the envelope. Which means schema messages are user-facing:
write them that way.

*Checked by:* `human` on the phrasing; `tests/domain.test.ts` pins several
specific messages.

## 4. Refusing early, and previewing the refusal

**House.** Some rules the browser has to know before it submits, or the person
gets a 422 the screen never hinted at. Those live in `src/shared` as a function
returning a result rather than throwing
(src/shared/domain.ts:127):

```ts
{ ok: false, message: "An entry is either income or a refund, not both." }
```

The service calls it and throws the message; the form calls it and renders the
message. One sentence, one source, and the screen can never disagree with the
server about what is allowed.

The rule for deciding: if the browser can tell in advance, it must, and the
sentence must be the same one.

## 5. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 3.1 Messages say what to do | Editorial. |
| 3.2 Refusals name the specific case | Editorial. |

Two `human` rules in this guide, down from three. The first looked
unmechanisable and was — a blanket ban on `throw new Error` under
`src/server/services` would flag the five correct ones, and which kind a throw is
cannot be read off its syntax. So `tests/service-errors.test.ts` inverts it: it
holds the list of throws already argued to be impossible, and fails on a new one
nobody has argued for. A rule that could not be checked became a rule about its
exceptions, which can be.