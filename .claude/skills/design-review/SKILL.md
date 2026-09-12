---
name: design-review
description: Review the browser app page by page and section by section against docs/standards/web.md — layout rhythm, action placement, alignment, states, focus, responsive and cross-page consistency. Use when asked to review the design, check pages against the design standards, fix UI or layout problems, or when screenshots of the app are provided.
---

# Review the design, section by section across every page

`docs/standards/web.md` is the rule source — eighteen numbered sections, from
tokens to the keyboard pass (`grep -n '^## ' docs/standards/web.md`). This skill is how to apply it to the whole app without missing
the findings that matter.

## The method: compare down the columns, not across the rows

The instinct is to open a page, read it against the rules, then open the next.
That finds the wrong defects.

Almost every real finding is a **cross-page inconsistency** — the same section
built differently on different pages. From the session this skill came from:
Templates' search box and Type dropdown were not aligned with each other;
Recurring had no Type filter while Templates did; Transactions and Recurring put
their header buttons somewhere Accounts, Stage and Templates did not; Categories'
vertical spacing did not match the rest of the site. Every one is invisible
while looking at a single page, and obvious the moment two are put side by side.

So build a **section × page matrix** and compare down each column:

```sh
ls src/client/pages/    # 18 pages, plus TransactionBrowser.tsx and App.tsx
```

The sections worth a column each:

- Page header — title, description, and where the actions sit
- Filter bar — which controls, in what order, aligned how
- The list — table or cards, columns, alignment, sort affordances
- Row actions — menu or inline, same trigger everywhere
- Selection and bulk actions
- Pagination
- Empty, loading, error and busy states
- Forms and modals
- Detail panels and summaries

For each column, read every page's version and find the odd one out. A page that
differs is either a defect or a deliberate exception — and a deliberate one
should be arguable in a sentence.

## What to check in each column

Read the relevant `web.md` section rather than working from memory. The ones
that catch the most:

**§7.4 The page stack and §7.5 Where a page's actions live.** One vertical
rhythm, decided in one place. Buttons in the same position on every page.

**§7.6 The filter bar.** Controls aligned with each other; bare controls carry
an `aria-label` by rule.

**§12.1 Four states per list.** Empty, loading, error, and content — and empty
must distinguish "nothing yet" from "nothing matches this view", because the way
out of each is the opposite. Read the filters actually set. A date range that
every view has is not a filter for this purpose: counting it reports every empty
ledger as filtered.

**§3.1 Spacing** and the scales. Inconsistent vertical spacing is the single
most-reported defect in this app's history and it is always a page inventing its
own gap instead of using the stack.

**§8 Forms.** Every control inside a `Field`, with label, hint and error
reaching it. §8.4: a field neither marked optional nor actually required is a
bug in the form.

**§9 Tables.** Semantics, numeric column alignment, overflow scrolling inside
its own container, sticky regions.

**§10 Money and dates.** The sign carries the meaning; trailing zeros stay; a
standalone figure carries its whole sentence.

**§11 Charts.** Never colour alone; every chart ships its table; §11.9 a field
the API sends is rendered or its absence is argued; §11.10 a named figure links
to the thing it is about, carrying `location.search`.

**§13 Focus and keyboard**, and **§14 The keyboard pass**. Where focus goes when
something unmounts — a bulk action's button lives in a bar that its own success
destroys.

**§15 Responsive** and **§2 Colour and contrast**.

## What code can answer and what needs eyes

Grep and the test suite answer: which pages use the shared components, whether
controls sit in a `Field`, whether tokens are used instead of literals, whether
a table scrolls in its own container, class naming, and everything the meta-tests
already hold.

Only a rendered page answers: vertical rhythm, alignment, balance and blank
space, whether a section is in a sensible position, and whether a layout holds
at each breakpoint. jsdom has no layout, so unit tests cannot see any of it.

If screenshots were provided, work from them — they are evidence and usually
contain more findings than were reported. If a visual question cannot be settled
from them, say so and ask, rather than guessing. The browser tier
(`BROWSER_DATABASE_URL=... npm run test:browser`) exercises real rendering and is
where a keyboard or responsive assertion belongs.

## Read the whole report before fixing

When a batch of defects is reported at once, list every one first, then group
them — the eleven in the source session were really four causes. Fixing them
one at a time produces four inconsistent fixes; fixing the cause fixes all of
them and usually removes code.

Watch for the finding that is not cosmetic. "Expected in and Expected Out always
show zero" was reported alongside spacing complaints and was a projection bug in
the service, not a design problem. Sort each report into *layout*, *behaviour* or
*data* before starting, and send the last two to the service that owns them.

## Fix at the right level

A fix that touches one page when the rule is app-wide is a fix that will be
reported again on the next page. If three pages do something differently and one
is right, change the other two; if none is right, change the shared component and
all three.

When a defect exists because the standard is silent, the standard changes too.
That is `guides-update`, and `web.md` §18 says how this guide is changed. A new
component or pattern earns a rule with its argument and its `*Checked by:*`.

## Verify

```sh
npm run verify
BROWSER_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:browser
```

Then check the keyboard by hand on anything that changed: tab order, focus
visibility, Escape, and that focus does not fall to `<body>` when something
unmounts. Check each breakpoint. `web.md` §14 is the pass to follow.

## Report

The matrix: which sections were compared across which pages. Findings grouped by
cause rather than by page, each with `file:line`. What was fixed at the shared
level and what needed a per-page fix, with the reason. Anything that needs eyes
you do not have — say which page and what to look at. And any rule that changed,
with a pointer to the guide section that now records it.
