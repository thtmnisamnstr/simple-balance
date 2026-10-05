# Client

React in `src/client`. What the browser app does the same way everywhere, and
the three rules that were a warning budget until the budget reached zero and
they were denied.

This is the code half. How the app should *look and behave* is
[`docs/standards/web.md`](../web.md), which is a much longer document because
there is much more to say about an interface than about the code that draws it.

## 1. State

### 1.1 Server state is a query; form state is `useState`

**House.** Anything the server owns is a TanStack Query. Anything a person is
mid-way through typing is component state. The mistake this prevents is copying
a query's result into `useState`, which produces two sources of truth and a
stale one.

The exception is a form editing something loaded: the query result seeds the
initial state and then the state is the truth until the save. That is a
deliberate copy with a defined end, and `src/client/forms.tsx:1726` is the site
that cites this sentence for it.

*Checked by:* nothing, and §4 says why — the two shapes are the same three
lines of code and only a reader can tell which one is in front of them.

### 1.2 A query key names the resource, then narrows

**House.** `["accounts"]`, `["session"]`, `["consent-request", code]`,
`["payees", "suggestions", term]`. Broad to narrow, left to right, so
invalidating `["payees"]` invalidates every suggestion list under it.

A key may carry an object where the object is the question — the filter a list
is showing, the sort it is under. TanStack Query v5 hashes a key structurally,
with object keys sorted, so two equal filters produce one cache entry and match
the same invalidation; three keys in `src/client/TransactionBrowser.tsx` do
exactly this and are correct. What a key must not carry is anything that does
not survive `JSON.stringify` — a function, a class instance, a `Map` — because
structural hashing flattens those and two different questions become one entry.
An earlier version of this sentence banned objects outright, which would have
flagged all three — `:287`, `:315` and `:351` — and
`tests/query-keys.test.ts:16-24` records why the check declines to.

**That three is a hand count, and nothing holds it.** It was written in two
places and drifted in one of them: this sentence and the test's comment both
read five while the paragraph above read three. It stays a hand count because
the exact check is not cheap — `["transactions", params, page, sort]` names an
object and a number as bare identifiers, and nothing a reader of the text can
do tells those two apart.

*Checked by:* `tests/query-keys.test.ts`, which holds the shape — every key is
an array opening with a string somebody wrote — and one direction of the
matching: an invalidation naming a resource no query files itself under fails,
because that write refetches nothing and says nothing. The other direction is
deliberately open. A query nothing invalidates passes, because invalidation is
not the only sanctioned way to stay fresh: the reports page files
`["report", ...]` (`src/client/pages/ReportsPage.tsx:145`) and refetches on
every mount instead (`:159-160`), since no mutation knows which report a change
touches. A new query whose data a mutation does change still needs its
invalidation written by hand, and no test will remind you.

### 1.3 Derived values are computed, not stored

**Binding, mostly.** If it can be worked out from what is already in state, work
it out during render. `splitting`, `showsCategoryPicker`, `splitSettled` and
`entrySide` in `TransactionForm` are all plain `const`s
(`src/client/forms.tsx:1795-1807` and `:1863`), and every one of them would be
a synchronization bug as state.

`react/set-state-in-effect` found thirteen sites and every one has been
decided. Some were derived values pretending to be state and were moved into
the render; the rest are genuine synchronization with something outside React —
the OS color-scheme preference in `theme.ts`, a query's result seeding a form
that is then edited — and each carries a disable comment saying which of the two
it is. That distinction is the whole rule, and it is the reason this could not
be a bulk fix: the two look identical and only one of them is a bug.

What is *not* a derived value, and the mistake to avoid when reading this
section as an instruction: a field seeded from a loaded record and then typed
into. That is a deliberate copy with a defined end, and deriving it throws away
what the person typed.

The other thing that is not a derived value: an answer a handler needs before
the next render can deliver it. The staged list's inline editors keep
`inlineInFlight`, `inlineCanceled` and `focusAfterInline` in refs
(`src/client/pages/StagingPage.tsx:607-618`) even though the first shadows
`isPending`, because the deciding read happens in the same event burst as the
write: Enter commits, and the blur that follows a click away runs before the
render that would have set `isPending`, so the state version double-submits —
two identical PUTs, the second refused as stale by the version the first just
bumped. A ref is right exactly when no render reads the value; the moment one
does, it is state hiding in a ref, which is the same bug from the other side. Do
not "fix" these to `isPending` — that is the obvious edit and the wrong one, and
the comments at the three sites say so.

That citation named `:598-609` for a release, which is the two `useState` calls
immediately above — the opposite of what the sentence says, in the sentence
that says it. `tests/standards-citations.test.ts` cannot catch that kind, because
the lines it pointed at exist and have something on them. The habit that avoids
it is to open the range on the comment carrying the reason rather than on the
first line that happens to be nearby: a range anchored to an argument moves
when the argument does.

*Checked by:* `npm run lint`. The rule is denied now that the count is zero,
which is stronger than the budget that held it while it was not.

### 1.4 A dependency array is exhaustive or it explains itself

**House, and clear.** `react-hooks/exhaustive-deps` found seventeen, and they
were not all the same thing. Two shapes:

- **Missing a dependency.** Usually a real bug in waiting.
- **An unnecessary dependency.** Harmless — an extra recompute — but it is
  almost always a leftover, and it tells you the code inside changed and the
  array did not.

The second kind is worth reading as archaeology, and one of these was the
clearest example the repository has produced. The category picker's `useMemo`
listed `type` long after the filter that used `type` was removed — because a
category running against the direction became a refund and the list stopped
narrowing. The dependency outlived the reason for it by a whole feature, and
nothing but the linter noticed.

A dependency array that is wrong in the other direction is worse and one of
these was too: the recurrence schedule preview keyed on the raw fields rather
than on the parse result it actually read, so typing an unparseable interval
over a parseable one left the previous list on screen. Fixing the array fixed
the screen.

**And the third denied rule, which this guide owed a sentence.**
[`index.md`](index.md) sends a reader here for all three — `exhaustive-deps`
(17), `set-state-in-effect` (13) and **`react/use-memo`** (1) — and the third
had no entry, because the one site it found left no trace to read: it was
*removed* rather than disabled, so no `oxlint-disable` comment anywhere names
it. `react/use-memo` wants a dependency list of simple expressions, and the
reminder preview's was `JSON.stringify(parsedReminder?.data ?? null)` — a memo
keyed on a value rebuilt every render, stringified so it would compare equal at
a cost larger than the five dates it was saving. It is computed during render
now (`src/client/forms.tsx:1091-1097`), which is the same fix as 1.3's and why
the rule sits in this section rather than in one of its own: both findings were
a dependency array admitting that the thing above it was not worth memoizing.
The obvious alternative was to key the memo on the raw fields instead, which
*is* a list of simple expressions and passes — and is exactly what the
recurrence preview two paragraphs up did before it went stale.

*Checked by:* `npm run lint`, denied rather than budgeted, for all three.

### 1.5 `useId` for anything that pairs a label with a control

**Binding.** Two of the same form can be on one page. A constant `id` or a
constant radio `name` silently merges them, and the failure looks like "clicking
this radio changed the other form".

*Checked by:* `tests/radio-groups.test.tsx`, which asserts every radio belongs
to exactly one group and that two forms on one page stay separate.

## 2. Money, and the rules the server owns

### 2.1 The client has its own exact money, and uses it for decisions

**Binding.** `src/client/money.ts` works in scaled `bigint`, through
`moneyUnits` (`src/client/money.ts:186`). Use
`compareMoney`, `isNegativeMoney` and `sumMoney` for anything that decides
something.

`Number()` is allowed only where the result is already approximate — a bar
width, a chart coordinate. The moment a comparison decides what a person is
shown, it is exact.

This is a rule with a scar. A budget row's state — within, close, spent, over —
was decided with `Number()` on values that are decimal strings, so a row that
was exactly spent could render as either "spent" or "within" depending on the
amount. It now compares exactly, through `isNegativeMoney` and `compareMoney`
in `rowState` (`src/client/budget-display.ts:63-84`), which moved out of the
page so the dashboard's budget section and the budgets page cannot answer the
same question two ways.

**One value in this client is money-shaped and outside this rule.** The plan
tab divides a float to render a price: `formatPrice`
(`src/client/pages/PlanPage.tsx:588-608`) takes Stripe's integer count of minor
units and divides by the scale `Intl` already knows. The membership test is
[`common.md`](../common.md) §Money that is not a ledger amount, which owns the
carve-out for the whole guide set — all four of its clauses, because a value
passing three of them is a ledger amount.

The exception is named here rather than only argued at the call site and in
`common.md`, which is where it was. The argument there is sound; it is in the
one place a reader of *this* rule will not look, so the sentence above was
simply false of the client and both ways of acting on it did damage. A money
audit reading this guide files working code as a violation. A reader taking the
silence as the boundary copies the division into something that **is** a ledger
amount, which is the half that costs money. A Binding rule with a known
exception says so where the rule is written, and points at the one document
that decides membership.

*Checked by:* `tests/client-money.test.ts` for the arithmetic;
`tests/budgets-ui.test.tsx` for that particular row;
`tests/common-guide.test.ts` for the carve-out, which names the files allowed
to touch Stripe's minor-unit integer and refuses a fifth; and
`tests/money-never-floated.test.ts` for the rule's negative half, which is the
one the scar came from — a money-named identifier inside a `Number()` or a
`parseFloat` anywhere in `src`. It is keyed on names, so it cannot see money
under a name that does not say so, and §4 below is where that limit is
already argued. `typescript.md` §3.4 states the same rule for the server and
carries the one live reading that is declared rather than flagged.

### 2.2 The client previews server rules; it does not re-implement them

**Binding.** Where the browser needs to know what the server will do, it calls
the same function. `resolveEntrySide` lives in `src/shared/domain.ts` and is
called by both, so the sentence the form shows is the sentence the service
would have thrown.

The alternative — a hand-rolled near-match — is how the form came to offer a
split the server refused with a 422 nobody could predict from the screen.

Read this with 2.3, which is its boundary: a preview is of what a refusal will
*say* and whether a form is valid, never of who is entitled to what.

*Checked by:* one test per previewed rule, and
`tests/frozen-accounts-ui.test.tsx:280` is the worked example — it calls the
shared `frozenAccountRefusal` and asserts the disabled button's accessible
description *equals* it, so a near-match in the client fails on the string. §4
says what that technique does and does not reach.

### 2.3 The server decides an entitlement; the browser renders the answer

**Binding.** 2.2 reads as unconditional — where the browser needs to know what
the server will do, it calls the same function — and applied to a plan that is
exactly the wrong move. The browser previews a **refusal**; it never computes
an **entitlement**.

The two deciders live in `src/shared/domain.ts` and are imported by no file in
`src/client`: `resolveEntitlement`, which turns a plan and an override into
what somebody may do, and `frozenAccountIds`, which turns that into a set of
ids. Both are reachable — the module boundary allows it — and both are named in
the client only in comments explaining why they are not called
(`src/client/api.ts:503-507`, `src/client/TransactionBrowser.tsx:433`). What
the browser reads instead is the answer: `frozen` on each account
(`src/client/api.ts:511`), and an ad that exists only because the server sent a
placement at all (`src/server/api.ts:1467`, `src/client/ads.tsx:7-14`).

**The obvious alternative was to compute it in the browser from the session**,
which is one import and looks like 2.2 being obeyed. It is wrong three times
over. A gate written in the browser has to be written the right way round, and
it has to wait for an entitlement that arrives after first paint — both failing
towards showing an ad to somebody who paid not to see one, and towards a slot
that fetched the vendor's script before the answer landed. `AGENTS.md` adds the
third and worst: entitlements change with nobody present, so a browser that
computed one would be answering from the session it loaded with, and an
override that expired an hour ago would still be in force on that tab.

What stays on the browser's side is 2.2's half, and the plan tab is full of it:
`accountAllowance` and `restoreAllowance` for the sentence a refusal would use,
`frozenAccountRefusal` for the sentence it would use about one account,
`activeChoicePending` for whether a question is still open, and
`planChangeTakesEffect` for what a press will do. Every one of those renders
something the server already decided or will decide; none of them decides it.

*Checked by:* `tests/client-guide.test.ts`, which holds that no file in
`src/client` imports either decider for a value, and that both names still
exist in `src/shared/domain.ts` so a rename cannot void the check quietly.

## 3. Components and third-party scripts

### 3.1 `Field` wraps every labeled control in a form

**House.** Layout, label, hint, error **and the word "optional"** in one place
(`src/client/components.tsx:617`). The fourth is the newest and the one this
enumeration left out for a release, which matters because of the direction a
reader acts in: somebody marking a field optional from a list of three writes
the word into the label, and a name computed from `<label for>` is the label's
entire text, so "(optional)" becomes part of the control's accessible **name**
— the defect the `optional` prop was added to remove
(`src/client/components.tsx:637-648`). `web.md` §8.4 owns the scheme, the
census and the WCAG argument; what belongs here is that the slot is a prop and
never a per-page decision. Three consequences worth knowing, and the first of
them used to be the opposite:

- **The accessible name of a control no longer includes its hint.** It used to,
  because the hint lived inside the wrapping `<label>` and a name computed from
  a label is that element's whole text content — so a test reaching for a
  control by name had to ask for "Password At least 12 characters". The hint is
  now outside the label and reaches the control through `aria-describedby`,
  which is the point of the fix rather than a side effect of it: a hint is a
  description, and a name that swallows it is a name nobody can predict.
  **A test looking for a control by its label now asks for the label**, and one
  written against the old behavior asks for a string nothing has.
- A `Field` holding a composite is `as="group"`, and hands out no id. Every
  control inside then has to name itself — see `web.md` 8.1, where forgetting
  the single unsplit picker was the trap.
- `jsx-a11y/label-has-associated-control` still cannot see through it, which is
  why that rule is off. See [`index.md`](index.md).

**In a form that stacks.** Two shapes take a bare control and an `aria-label`
instead: a filter bar, which `web.md` §7.6 governs, and `.inline-form` — the
one-row "add a category" (`src/client/pages/CategoriesPage.tsx:472`) and "add a
group" (`:524`) bars, which are both of them. This sentence named a third, "add
a payee", which does not exist and never did: the payees page has no form on it
at all, and a carve-out listing a site that is not there invites the next one
to be written because the list implied a pattern. In the second shape, a
stacked label per control would treble the row's height for three words that the
button beside them already implies, and a field-level error has nowhere to go
because the refusal comes back as one `Alert` under the row. The carve-out is written here rather
than left implicit because this sentence used to say "every labeled control"
without qualification, and the one page that obeyed it literally — Templates,
which wrapped its Type filter in a `Field` — ended up with a filter twenty
pixels taller than the search box beside it. A filter takes effect on change,
has no error state, no required state, no submit and never reaches an error
summary; none of what `Field` carries is about it.

*Checked by:* `tests/field-contract.test.tsx` for the half a test can reach —
every `<input>`, `<select>` and `<textarea>` in `src/client` going through the
three shared components — and `tests/web-guide.test.ts` for the `optional`
census. §4 has the half that is still a reader's job.

### 3.2 A native control keeps its native semantics

**Binding.** Do not declare a role a native element already has. Three inputs
used to add `role="combobox"` beside a `<datalist>`, which promised a widget
that was not there **and** duplicated the implicit role HTML-AAM already gives
an `<input list>`. All three now carry `list` and nothing else.

Removing them changed nothing in a real browser, which is the proof: every
`getByRole("combobox")` in `tests/browser/budgets.spec.ts` still passes. jsdom
does not compute that implicit role, so the same query fails there — a
difference worth knowing before writing the test in the wrong tier.

*Checked by:* `npm run lint`, via `jsx-a11y/role-has-required-aria-props`.

### 3.3 A form sends what its fields mean, not what the server can infer

**House.** Where the server accepts a field, the browser can set it. The
counter-example that produced this rule: `categoryKind` was documented for the
MCP and unreachable from the form, so a refund into a new spending category was
recordable by an agent and not by a person — and the form did not fail, it
quietly filed the money as income.

`AGENTS.md` now states this at the field itself — "a request field only an
agent ever sets is the same defect one level down, and it is invisible to a
comparison of route lists" — and names `categoryKind` as the scar while doing
it. That sentence used to read the other way round here, as though this rule
extended a route-by-route invariant to the field; it does not, the invariant
already reaches the field, and `AGENTS.md` wins. Recorded rather than deleted,
because a rule whose reason moved into `AGENTS.md` and left no forwarding
address is a rule somebody re-derives from scratch.

What is left for this guide is the code-side half: where in `src/client` the
field has to become reachable. A request type in `api.ts` that carries the
field is not reachability — it makes the field settable by code and by nobody
at a screen. The control is what closes it, and the shape has recurred three
times: a body field (`src/client/forms.tsx:2886-2893`), a creation field
(`src/client/pages/CategoriesPage.tsx:282-285`) and a list filter
(`src/client/pages/StagingPage.tsx:833-837`), each site carrying the same note
about the one before it. Three instances is a pattern rather than a scar: when
a shared schema gains a field, the form gains a control in the same change.

*Checked by:* `tests/new-category-kind-ui.test.tsx`, for that one field. The
general case is §4's last row.

### 3.4 A third-party script is fetched by what needs it, never by an import

**Binding.** Two vendors landed on this branch and both had to be rewired the
same way, which is what makes this a rule rather than a bug report: the next
one meets the same trap.

The payment SDK's default entry appends its `<script>` one microtask after the
module is **imported**, whether or not `loadStripe` is ever called. `PlanPage`
imports it and the app shell imports `PlanPage`, so every page of every
deployment fetched Stripe.js: the sign-in screen, a subscriber reading
balances, a deployment that sells nothing at all. The fix is the `/pure` entry
plus a loader keyed by the publishable key, called on the plan tab when there
is something to confirm (`src/client/pages/PlanPage.tsx:19-26` and `:367-386`).
The ad script is the same shape by hand — keyed by publisher id, fetched by the
first `AdSlot` that mounts and by nothing else (`src/client/ads.tsx:24-57`).
The schema library's `eval` probe is the third face of it: a library doing
something at import time that the page's policy refuses, fixed by a module
imported first for its ordering (`src/client/zod-jitless.ts:32-38`).

**The obvious alternative is to put the tag in the shell page, or to let the
import do it.** Both appear to work, and both silently undo two things. The
entitlement gate, because under 2.3 the only way to render a slot is to be
handed the ids — so somebody who paid not to see ads never fetches the script
and is never counted as an impression, while a tag in `index.html` hands the
network an impression before the session has even resolved. And the content
security policy, which refuses the request everywhere it has not been widened
and fills the console with a violation on every load — noise that invites
exactly the wrong fix, a new host or an unsafe directive.

**This is a jsdom rule and not a browser-tier one**, which is the part to know
before writing the test for the next vendor. The dev server sends no policy, so
Playwright sees a page where everything loaded and nothing complained; the
production console is the only place it ever showed, and nobody reads that on
the sign-in screen.

*Checked by:* `tests/client-guide.test.ts`, which imports the app shell and
fails on any cross-origin `<script>` the import appended, and reads
`index.html` for a cross-origin tag put there by hand;
`tests/stripe-script-loading.test.tsx` for Stripe specifically, including the
grep that keeps the default entry out of every file in `src/client`; and
`tests/ad-slot-ui.test.tsx` for the slot that is handed no placement fetching
nothing.

## 4. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.1 Server state is a query | Not mechanizable. |
| 2.1 `Number()` only where approximate | Half checked now. The narrower rule this row called "possible and fiddly" was written: `tests/money-never-floated.test.ts` flags a money-*named* identifier inside a `Number()` or a `parseFloat` anywhere in `src`, which is what a lint rule banning `Number(` outright could not do without firing on every pixel. What stays a sentence is money under a name that does not say so — `fillPercent(limit, actual)` in `budget-display.ts` takes two decimal strings and a `Number(actual)` added there passes. The check states that limit in its own docstring. |
| 2.2 The preview calls the rule rather than copying it | Checked one rule at a time, and the technique works: `tests/frozen-accounts-ui.test.tsx:280` calls the shared `frozenAccountRefusal` and asserts the rendered accessible description *equals* it, so a hand-rolled near-match fails on the string rather than passing a grep for the import. The cost is one test per previewed rule, written by whoever adds the preview. What stays open is the preview nobody wrote a test for — a copy of a rule that has no shared home yet reads as ordinary client code, and `tests/module-boundaries.test.ts` proves the import is allowed, not that it was taken. |
| 3.1 `Field` wraps every labeled control in a form | Half checked now. `tests/field-contract.test.tsx` holds that every `<input>`, `<select>` and `<textarea>` in `src/client` goes through the three shared components, so every one of them is *reachable* by a `Field`; whether a given call site wrapped it is still a reader's job, because the lint rule that would see that is off precisely because it cannot see through `Field`. A control labeled by hand beside a `Field` fails nothing, since the accessible name comes out the same either way. |
| 3.3 Fields reachable from the browser | Half checked now, on the write side. `tests/mcp-parity.test.ts` compares route lists, and a field is one level below anything a route list can see — `AGENTS.md` now says so in the invariant itself. Its `WRITTEN_FORMS` register closes six of those pairs by name, comparing 52 fields a tool writes against the fields the matching form sends, and the request reader was widened to three shapes to do it: a plain object, an array field-list, and a mutation whose request travels through `json(…)`. What stays a sentence is every tool outside those six, and the read side entirely. The gap has been hit three times, most expensively by `categoryKind`. |

Five `human` rules in this guide. It said three until 2.2 and 3.1 were counted:
both named no mechanism at all, which is not the same as being checked, and a
count that quietly leaves those out is the one number here worth nothing.
`tests/query-keys.test.ts` took 1.2 over, and it also checks the half nobody had
written down: that an invalidation names a key some query files itself under.
The reverse stays a person's job — a query nothing invalidates passes, and 1.2
says when that is right rather than a bug. Of the five, 3.3 is the one that has
already cost something — it is the gap that let `categoryKind` reach an agent
and not a person.

**Still five, and that is the number to check when a rule is added.** 2.3 and
3.4 both arrived with `tests/client-guide.test.ts` rather than after it, which
is the only reason the count did not move; a rule written without a mechanism
belongs in the table above on the same day it is written, not on the day
somebody notices. 2.2's row stays here although it now has a worked example,
because one checked preview is not the rule.