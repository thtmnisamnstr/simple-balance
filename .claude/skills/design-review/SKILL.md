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

**§11 Charts.** Never color alone; every chart ships its table; §11.9 a field
the API sends is rendered or its absence is argued; §11.10 a named figure links
to the thing it is about, carrying `location.search`.

**§13 Focus and keyboard**, and **§14 The keyboard pass**. Where focus goes when
something unmounts — a bulk action's button lives in a bar that its own success
destroys.

**§15 Responsive** and **§2 Color and contrast**.

## What code can answer and what needs eyes

Grep and the test suite answer: which pages use the shared components, whether
controls sit in a `Field`, whether tokens are used instead of literals, whether
a table scrolls in its own container, class naming, and everything the meta-tests
already hold.

Only a rendered page answers: vertical rhythm, alignment, balance and blank
space, whether a section is in a sensible position, and whether a layout holds
at each breakpoint. jsdom has no layout, so unit tests cannot see any of it.

If screenshots were provided, work from them — they are evidence and usually
contain more findings than were reported. If they arrive blank or unreadable,
say so and reproduce the state yourself (below) rather than reasoning from the
description: a description says where something looked wrong, not why. The browser tier
(`BROWSER_DATABASE_URL=... npm run test:browser`) exercises real rendering and is
where a keyboard or responsive assertion belongs.

**If none were provided, take them.** Do not ask, and do not review the layout
from source — the whole point of the previous paragraph is that source cannot
answer. A throwaway spec under `tests/browser/` that signs up, seeds a ledger
through the forms and photographs every route is about forty lines and runs in
under a minute; `budgets.spec.ts` has the sign-up and the seeding to copy, and
`playwright.config.ts` starts PostgreSQL, the API and Vite on its own. Point
`BROWSER_DATABASE_URL` at a throwaway database, write the files somewhere
outside the repository, **and delete the spec when the review is over** —
`tests/testing-guide-counts.test.ts` counts the files in that directory and
will tell you if you forget.

**Measure what eyes judge badly.** Horizontal overflow is the one to automate
while you are in there: `document.documentElement.scrollWidth > clientWidth` is
a yes-or-no answer per route per width, and it found four pages this way that
three rounds of looking at screenshots had not. A `.table-wrap` scrolling
sideways is allowed; the *document* scrolling is the defect, so measure the
document.

**Photograph the states, not just the routes.** A route visited at rest shows
each bar empty or in its default state, and the defect usually lives in a state
somebody has to reach: a selection across pages (the extra "Select all N
matching" button, the longest count), a button disabled with its reason
showing, a button busy mid-request, a row with an error under it. The staged
queue's selection bar overflowed at 1440px once a duplicate disabled Commit —
and `reflow.spec.ts`, which walks every route at every width, never saw it,
because at rest there is no selection bar. So for each section that changes
with its contents, list its states, seed the data that reaches each one through
the real API, and photograph each at the widths below. A transient state is
made to last with `page.route`: hold the request, measure, then abort it, so a
fast machine cannot outrun the screenshot and the seeded data survives.
`tests/browser/selection-bar.spec.ts` has the seeding and the hold to copy.

**A layout fix is measured, never argued.** That same bar had been fixed once
already, in a long and accurate-sounding stylesheet comment that `web.md` cited
as the answer — right about the cause, wrong about the cure, and never opened in
a browser. Before calling a layout defect fixed, photograph the state that
showed it at the widths that matter, and turn the measurement into a browser
spec so the next rule on that row cannot bring it back with the suite green.

**And measure the band above the largest breakpoint, not just a phone.** The
sidebar is 248px and it is present above 780px, so the narrowest the content
ever gets relative to the window is around 820px — not 390px, where the sidebar
is gone. Every responsive defect found in the source session lived between
780px and 1050px, and a check at a phone width and a desktop width saw none of
them.

## Read the whole report before fixing

When a batch of defects is reported at once, list every one first, then group
them — the eleven in the source session were really four causes. Fixing them
one at a time produces four inconsistent fixes; fixing the cause fixes all of
them and usually removes code.

Watch for the finding that is not cosmetic. "Expected in and Expected Out always
show zero" was reported alongside spacing complaints and was a projection bug in
the service, not a design problem. Sort each report into *layout*, *behavior* or
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

**The browser tier wants ports 3000 and 5173, and a person testing has them.**
`playwright.config.ts` refuses to reuse a running server, so with `npm run dev`
up it stops at "already used". Do not stop somebody's dev server to get the
ports back. Start a second pair instead: a scratch Vite config proxying to
another API port, and a scratch Playwright config pointing both `webServer`
entries and `baseURL` at them. Check a port is free before taking it — an old
orphaned server can be holding the obvious next one — and delete both scratch
configs afterwards.

## Report

The matrix: which sections were compared across which pages. Findings grouped by
cause rather than by page, each with `file:line`. What was fixed at the shared
level and what needed a per-page fix, with the reason. Anything that needs eyes
you do not have — say which page and what to look at. And any rule that changed,
with a pointer to the guide section that now records it.
