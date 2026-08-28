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
deliberate copy with a defined end.

### 1.2 A query key names the resource, then narrows

**House.** `["accounts"]`, `["session"]`, `["consent-request", code]`,
`["payees", "suggestions", term]`. Broad to narrow, left to right, so
invalidating `["payees"]` invalidates every suggestion list under it.

A key holding an object is a key that will not match. Keep them arrays of
strings and primitives.

*Checked by:* `tests/query-keys.test.ts`, which holds the shape and also the
half nobody had written down: a key something files a query under is a key
something else invalidates. A query nothing invalidates goes stale after a write
and shows the person the row they just changed, unchanged.

### 1.3 Derived values are computed, not stored

**Binding, mostly.** If it can be worked out from what is already in state, work
it out during render. `splitting`, `showsCategoryPicker`, `splitSettled` and
`entrySide` in `TransactionForm` are all plain `const`s
(`src/client/forms.tsx:1598-1605` and `:1666`), and every one of them would be a
synchronisation bug as state.

`react/set-state-in-effect` found thirteen sites and every one has been
decided. Some were derived values pretending to be state and were moved into
the render; the rest are genuine synchronisation with something outside React —
the OS colour-scheme preference in `theme.ts`, a query's result seeding a form
that is then edited — and each carries a disable comment saying which of the two
it is. That distinction is the whole rule, and it is the reason this could not
be a bulk fix: the two look identical and only one of them is a bug.

What is *not* a derived value, and the mistake to avoid when reading this
section as an instruction: a field seeded from a loaded record and then typed
into. That is a deliberate copy with a defined end, and deriving it throws away
what the person typed.

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

*Checked by:* `npm run lint`, denied rather than budgeted.

### 1.5 `useId` for anything that pairs a label with a control

**Binding.** Two of the same form can be on one page. A constant `id` or a
constant radio `name` silently merges them, and the failure looks like "clicking
this radio changed the other form".

*Checked by:* `tests/radio-groups.test.tsx`, which asserts every radio belongs
to exactly one group and that two forms on one page stay separate.

## 2. Money and dates

### 2.1 The client has its own exact money, and uses it for decisions

**Binding.** `src/client/money.ts` works in scaled `bigint`, through
`moneyUnits` (`src/client/money.ts:160`). Use
`compareMoney`, `isNegativeMoney` and `sumMoney` for anything that decides
something.

`Number()` is allowed only where the result is already approximate — a bar
width, a chart coordinate. The moment a comparison decides what a person is
shown, it is exact.

This is a rule with a scar. A budget row's state — within, close, spent, over —
was decided with `Number()` on values that are decimal strings, so a row that
was exactly spent could render as either "spent" or "within" depending on the
amount. It now compares exactly
(src/client/pages/BudgetsPage.tsx:107).

*Checked by:* `tests/client-money.test.ts` for the arithmetic;
`tests/budgets-ui.test.tsx` for that particular row.

### 2.2 The client previews server rules; it does not re-implement them

**Binding.** Where the browser needs to know what the server will do, it calls
the same function. `resolveEntrySide` lives in `src/shared/domain.ts` and is
called by both, so the sentence the form shows is the sentence the service
would have thrown.

The alternative — a hand-rolled near-match — is how the form came to offer a
split the server refused with a 422 nobody could predict from the screen.

## 3. Components

### 3.1 `Field` wraps every labelled control

**House.** Layout, label and hint in one place
(`src/client/components.tsx:389`). Two consequences worth
knowing:

- The accessible name of a control includes its hint. A test looking for a
  control by name has to account for "Password At least 12 characters".
- `jsx-a11y/label-has-associated-control` cannot see through it, which is why
  that rule is off. See [`index.md`](index.md).

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

`AGENTS.md` states the parity rule route by route. This is the same rule one
level down, at the field.

*Checked by:* `tests/new-category-kind-ui.test.tsx`.

## 4. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.1 Server state is a query | Not mechanisable. |
| 2.1 `Number()` only where approximate | A lint rule banning `Number(` in `src/client` would fire on legitimate uses; a narrower one keyed on variable names is possible and fiddly. |
| 3.3 Fields reachable from the browser | Parity checks routes, not fields. This is the gap that let `categoryKind` through. |

Three `human` rules in this guide, down from four.
`tests/query-keys.test.ts` now holds 1.2, and it also checks the half nobody had
written down: that a key some query files itself under is a key something
invalidates. Of the three left, 3.3 is the one that has already cost something —
it is the gap that let `categoryKind` reach an agent and not a person.