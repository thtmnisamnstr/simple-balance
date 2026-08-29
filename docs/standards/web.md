# Web

The browser app. A React 19 single-page app with a hand-rolled router, TanStack
Query for server state, and 3,450 lines of hand-written CSS in
`src/client/styles.css`. No component library, no CSS framework, no token build
step, and none is coming, so every rule here has to be reachable with plain CSS
custom properties and components written by hand.

Read [`common.md`](common.md) first. Money, dates, naming, error shape, the
glossary and the voice are settled there and are not restated here. This guide
carries only what is specific to a screen: what a token is, what a scale is,
what a component is, and what a person can see, reach and hear.

**Conformance target: WCAG 2.2 level AA**, the W3C Recommendation of 12 December
2024. Named as the Recommendation rather than a rendered snapshot, because it
carries errata. Two things follow from picking it. Some level AAA criteria are
met because they are cheap, and meeting one does not move the target. And APCA
is not used: WCAG 3.0 is a Working Draft whose own status section says it is
inappropriate to cite as other than a work in progress, and its contrast
algorithm is undecided. Where a perceptual method likes a colour that the 2.x
ratio refuses, the 2.x ratio wins.

## 1. Tokens

### 1.1 One tier, and it is semantic

**House.** There is one token tier and a token's name says what it is for, never
what colour it is. Material's three tiers exist to serve dynamic colour
generation; this product has one brand and two themes, so a reference tier would
double the names and buy nothing.

*Checked by:* `tests/theme-tokens.test.ts`, which fails on any literal colour
written outside the token blocks, on a token referenced but never declared, and
on a token declared but never used.

### 1.2 The three blocks

**House, and already enforced.** Every colour lives in exactly three blocks at
the top of `src/client/styles.css`. Nothing in a specification or in
`AGENTS.md` requires this structure; the test and the reasoning at
`styles.css:73-92` are what carry it.

| Block | Lines | Answers |
| --- | --- | --- |
| `:root` | `styles.css:93-161` | The light values, unconditional, and therefore also the fallback for a browser that supports neither mechanism below |
| `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` | `styles.css:163-230` | What does the machine want |
| `:root[data-theme="dark"]` | `styles.css:232-294` | What did the person choose |

The two dark blocks carry the same declarations on purpose and cannot be merged:
either can be true without the other, the media one excludes an explicit light
choice so light on a dark machine still wins, and the attribute one is written
last so it wins on the way back. The reasoning is already in the file at
`styles.css:73-92`.

A token is added to all three blocks in the same change. A token in one block
and not another is invisible in review and obvious to whoever is using it.

*Checked by:* `tests/theme-tokens.test.ts` asserts the three blocks exist, that
the key sets are identical (`:41`), that the two dark blocks declare the same
values (`:48`, compared as parsed name-to-value maps rather than character for
character, so a reordering passes), that the attribute block comes after the
media one (`:55`), and that each block declares `color-scheme`.

### 1.3 What is a token, and what is not

**House, and the largest gap in this chapter.** Sixty tokens are declared and
all sixty are a colour or a shadow made of colours. Nothing else in
the stylesheet is a token: not a space, not a radius, not a size, not a weight,
not a duration, not a z-index, not a breakpoint. There is no stated rule for why
`--shadow` earns a name and `13px` does not.

The rule, from here: **a value becomes a token when it is a decision that has to
be the same in two places.** A colour qualifies because a theme must answer for
it twice. A spacing step qualifies because a gap that is 11px on one card and
12px on the next is not a decision, it is two accidents. A one-off geometry
value does not qualify: the six inline `style` props in the client
(`charts.tsx:270`, `charts.tsx:319`, `components.tsx:500`, `components.tsx:751`,
BudgetsPage.tsx:698`, `DashboardPage.tsx:194`) are all runtime geometry and are
correct as they are. The count matters beyond tidiness: it is what
`src/server/http-security.ts:22-29` reasons about when it declines
`'unsafe-inline'`.

*Not checked mechanically.* Section 3 proposes the ramps; the check that would
enforce them is listed in section 17 and does not exist yet.

### 1.4 Naming

**House.** `--<role>[-<property>][-<modifier>]`, with the role from a closed
list: `ground`, `surface`, `field`, `fill`, `line`, `ink`, `muted`, `track`,
`accent`, `green`, `red`, `amber`, `blue`, `focus`, `series-N`, `art`, `brand`,
`chrome`, `scrim`, `ambient`, `shadow`, `on-*`. The modifier comes from `soft`,
`wash`, `subtle`, `strong`, `deep`, `dark`, `fill`, `line`, `hover`, `disabled`.
`fill` is both a role and a modifier: `--fill-subtle` and `--fill-deep` are the
two tokens using it as a role.

Two consequences worth stating. First, do not reach for a token because its
colour happens to match; a token used outside the concept it names breaks in the
other theme. Second, `--ambient`, `--art-glow-a`, `--art-veil`, `--chrome` and
`--scrim` carry no property segment and cannot be read from their names alone.
They are exempted here by name rather than left as a hole in the list.

Adopt the Design Tokens Format Module's naming constraints as a discipline
(case-sensitive, no leading `$`, no `{`, `}` or `.`) and its type list as a
completeness checklist. Do not adopt its JSON file format and do not add Style
Dictionary. Saying so is what stops a future self adding a build step.

*Not checked mechanically.* The grammar is regex-shaped and a test could
derive the `TEXT` and `FILL` sets that `tests/theme-tokens.test.ts:117-144`
maintains by hand.

### 1.5 The field role

**House, and enforced.** A field's fill, its edge, and the fill it takes when it
cannot be edited are three decisions of their own rather than the card and
hairline tokens borrowed. `--field`, `--field-line` and `--field-disabled` carry
them. `--field-line` is the one that earns its name loudest: `--line-strong`
draws eleven other things, including a button's border, the chart's zero line
and the budget bar, so a field edge written as `--line-strong` cannot soften
without moving all of them.

`--field-disabled` closed a live defect rather than a hypothetical one. Fourteen
fields ship disabled — the mass-edit panels on transactions, staged rows and
templates (`src/client/bulk-edit.tsx`, `src/client/TransactionBrowser.tsx`,
`src/client/pages/StagingPage.tsx`, `src/client/pages/TemplatesPage.tsx`) — and
because `.input` sets its own background, colour and border, the browser's
disabled rendering was overridden and a dead field was pixel-identical to a live
one. `.bulk-edit-field.enabled` paints its row green as soon as an action is
chosen, and on the templates panel choosing "Clear so it is filled in on use"
leaves that green row holding a value field nobody can type in. A disabled
control is exempt from SC 1.4.3 and SC 1.4.11 (section 2.1), which is what lets
its edge drop to the decorative `--line`; the exemption says the contrast need
not be measured, not that the state may be invisible. Opacity is the house
answer for a disabled *button* and the wrong answer here: a field sits on
coloured rows, and dimming one lets the row's colour through instead of stating
anything.

A read-only field is not a disabled one and has not shipped. When the first one
does it either reuses `--field-disabled` or earns `--field-readonly` then;
declaring that token now would fail the unused-token check, which is the right
time for it to arrive.

*Checked by:* `tests/theme-tokens.test.ts` asserts that `.input` draws its fill
and edge from `--field` and `--field-line`, that a `.input:disabled` rule exists
and takes its fill from `--field-disabled`, and that the two fills differ in
every theme — the last of those being the difference between declaring a
disabled state and having one anybody can see.

## 2. Colour and contrast

### 2.1 Text contrast

**Binding, WCAG 2.2 SC 1.4.3 Contrast (Minimum), level AA.** 4.5:1 for text,
3:1 for large text, where large is at least 24px or 18.5px bold. Placeholder
text and hover and focus text are in scope. Disabled controls are not, and that
exemption is worth stating because people assume the opposite and then lighten
something that was already correct.

Measured across the token blocks at 0.1.5, every text pair in use clears 4.5:1
in both themes:

| Pair | Light | Dark |
| --- | --- | --- |
| `--ink` on `--surface` | 16.22 | 13.88 |
| `--ink-soft` on `--surface` | 9.04 | 8.97 |
| `--muted` on `--surface` | 5.24 | 6.82 |
| `--muted` on `--surface-soft` | 5.00 | 7.26 |
| `--muted` on `--fill-subtle` | 4.60 | 5.74 |
| `--muted` on `--green-soft` | 4.62 | 4.80 |
| `--green` on `--green-soft` | 5.71 | 5.54 |
| `--red` on `--red-soft` | 5.25 | 6.05 |
| `--amber` on `--amber-soft` | 5.31 | 6.25 |
| `--blue` on `--blue-soft` | 5.93 | 6.78 |
| `--on-accent` on `--green-fill` | 6.48 | 5.16 |

`--muted` on `--fill-subtle` at 4.60 is the tightest pair in the product and it
is where the next darkening of a subtle fill will break something. It is used at
11px and 12px, which is not large text, so the full 4.5:1 applies.

*Not checked mechanically, and it should be.* The numbers above were computed by
hand for this guide. `tests/support/css.ts` already parses the token blocks into
a name-to-value map per theme, so the test is a contrast function and a list of
sanctioned pairs. Until it exists, the table above is a snapshot and will drift.

### 2.2 Non-text contrast

**Binding, WCAG 2.2 SC 1.4.11 Non-text Contrast, level AA.** 3:1 against
adjacent colours for anything required to identify a control or its state, and
for parts of a graphic required to understand it. The enumerated exceptions are
inactive components, components whose appearance the user agent determines and
the author has not modified, and graphics whose particular presentation is
essential. "Pure decoration" is not an exception here; that phrasing belongs to
1.4.3, and decorative graphics are out of scope.

The rule for this stylesheet: **`--line-strong` for a control edge,
`--line` for a decorative separator or a card outline.** Measured:

| Pair | Light | Dark |
| --- | --- | --- |
| `--line` on `--surface` | 1.29 | 1.37 |
| `--line` on `--ground` | 1.20 | 1.52 |
| `--line-strong` on `--surface` | 3.35 | 3.82 |
| `--line-strong` on `--ground` | 3.11 | 4.26 |
| `--focus-ring` on `--surface` | 5.08 | 9.70 |
| `--focus-ring` on `--ground` | 4.71 | 10.82 |
| `--green-line` on `--surface-soft` | 1.45 | 2.38 |
| `--green-line-strong` on `--surface-soft` | 3.37 | 5.71 |

**Settled.** The reasoning is written out twice in the file, at
`styles.css:731-735` for `.input` and at `styles.css:3003-3005` for
`.chart-zero`, and it had been applied to two of the eighteen
`border: 1px solid var(--line…)` rules. Six control edges have now joined them —
`.pagination-step`, `.sort-direction`, `.bulk-edit-field`, `.transaction-type`,
`.commit-choice label` and `.report-tab` — along with `.button-secondary`
(`styles.css:595`) and `.file-drop` (`styles.css:2166`), both of which rested on
the failing token and reached the compliant one only on hover. Both now hold it
at rest, as `.input` already did; their hover states also shift `background`, so
the hover affordance survives the change.

The `--line` rules that remain are card outlines, which is what that token is
for.

*Not checked mechanically.* A test could enumerate the control-edge selectors
and assert the token, which is the same shape as the text-contrast test.

### 2.3 Colour is never the only cue

**Binding, WCAG 2.2 SC 1.4.1 Use of Color, level A.** A 3:1 lightness difference
can count as the extra cue, but where the content depends on telling one colour
from another an additional visual indicator is required regardless of ratio.

This product already mostly obeys it, deliberately: a deleted row gets
`line-through` as well as opacity, a staged row an amber badge as well as an
amber background, an archived account an "Archived" badge as well as opacity,
and the split remainder line changes its words and not only its colour. Keep
that. Section 10 covers the money case, which is the one that still slips.

*Checked by:* nothing mechanical. This is review, and it is the honest kind of
review because the judgement is whether a second cue carries the same
information.

### 2.4 Green and red in a ledger

**Contested.** Red and green are the most common confusion pair, and no source
found in research says whether a financial table should use them at all as a
redundant cue. The published guidance says only that colour cannot be the sole
cue.

This product uses them, because the sign is always present and load-bearing and
the colour is decoration on top of it (section 10). The decision is recorded
here so the next person argues with it rather than rediscovering the
disagreement. If the sign is ever suppressed in favour of the colour, this
decision is void and the colour has to go.

*Not checked mechanically.* Whether the sign is still present beside the colour
is what section 10.1 covers, and that is review.

## 3. The scales

Five scales are missing. Each of these is **House**, none is checked
mechanically today, and each proposal below is a ramp to adopt rather than a
description of what exists.

*Not checked mechanically, and not yet checkable.* The scales do not exist: every
spacing, radius, size and weight in `styles.css` is a hand-picked value. Once the
tokens land, `tests/support/css.ts` can refuse a literal outside them the way
`tests/theme-tokens.test.ts` already refuses a literal colour. Until then this
section is a proposal, and says so.

### 3.1 Spacing

**House, and a proposal rather than a rule until the tokens exist.**

Today: 279 padding, margin and gap declarations across **35 distinct pixel
values**, running 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
19, 20, 21, 22, 24, 26, 28, 30, 32, 34, 35, 38, 42, 48, 55, 72, 248. `gap` alone
takes seventeen distinct single values, the commonest being 8px eighteen times,
12px twelve, 10px ten, 7px eight and 14px eight. Nine, eleven, thirteen and
seventeen pixels are not decisions.

Proposed ramp, nine steps, Carbon-shaped rather than GOV.UK-shaped because a
dense table cell needs 2px and a page shell needs 48px:

```css
--space-1: 2px;   --space-2: 4px;   --space-3: 6px;
--space-4: 8px;   --space-5: 12px;  --space-6: 16px;
--space-7: 24px;  --space-8: 32px;  --space-9: 48px;
```

**The migration is not free and the guide should say so.** 11px maps to 12,
10px to 8 or 12, 14px to 12 or 16. Around 279 declarations move and the app
will look slightly different when they do. That is the price of a scale, and it
is paid once.

### 3.2 Radius

Today: 58 declarations across **17 distinct values**. No two cards match:
`.metric-card` and `.balance-snapshot` at 11px, `.table-card` at 12px, `.panel`
and `.account-card` at 13px, `.modal` at 15px, `.auth-ledger-card` at 18px,
`.auth-art` at 20px.

Research established no radius scale from any published system: the USWDS and
Material 3 shape pages could not be retrieved. So this is decided by inspection
of what is here, and it is four steps plus a pill:

```css
--radius-1: 3px;   /* chip, swatch, bar */
--radius-2: 8px;   /* control: input, button, icon button */
--radius-3: 12px;  /* card: panel, table card, metric card, modal */
--radius-4: 20px;  /* the sign-in art panel, and nothing else */
--radius-round: 99px;
```

### 3.3 Type

Today: 104 `font-size` declarations across nine pixel values (11, 12, 13, 14,
15, 16, 17, 20, 32) plus two `clamp()` expressions.

Proposed: seven points, and GOV.UK's rule that a new style aligns to an existing
point rather than inventing one.

```css
--text-1: 11px;  /* hint, badge, meta */
--text-2: 12px;  /* secondary cell, legend, note */
--text-3: 13px;  /* body, table cell, input */
--text-4: 15px;  /* section heading */
--text-5: 17px;  /* page heading */
--text-6: 20px;  /* the currency heading over a balance group */
--text-7: 32px;  /* the one figure a dashboard leads with */
```

Name the productive set and the expressive set separately. The expressive set
has two members and both are the `clamp()` expressions counted above:
`clamp(28px, 3.2vw, 40px)` on `.page-header h1` (`styles.css:526`), which is the
`<h1>` of every page, and `clamp(35px, 4vw, 52px)` on the sign-in shell
(`styles.css:2537`). The page title is deliberately outside the productive ramp
because it is the one size that answers to the viewport rather than to the
scale. Naming both is what stops a display size leaking into a page of
accounts.

### 3.4 Weight

Today: **26 `font-weight` declarations carrying 14 distinct values**: 400, 500,
570, 600, 620, 630, 650, 660, 700, 720, 730, 750, 760, 780. That is very nearly
a weight per component.

Four steps, and no others: 400, 500, 600, 700. The strongest argument for this
is not taste. Inter is named first in the stack (`styles.css:95-97`) and never
loaded (section 5), and `font-synthesis: none` is set at `styles.css:100`, so
the fourteen numeric weights already collapse to whatever the fallback system
font ships. Most of the fourteen are indistinguishable on screen today.

### 3.5 Z-index

Today: nine declarations, six values, no ordering document. `.sidebar` 30,
`.nav-scrim` 20, `.merge-panel` 20, `.mobile-header` 15, `.menu-popover` 10,
`.modal-header` 2, `.auth-card` 2, `.search-box > svg` 1, `.auth-ledger-card` 1.
`.merge-panel` and `.nav-scrim` at the same value is a real collision: both can
be on screen on a narrow window, and DOM order is the only thing deciding.

```css
--layer-raised: 1;    /* an icon inside its own field */
--layer-sticky: 10;   /* a sticky header or panel */
--layer-popover: 20;  /* a row menu, a scrim */
--layer-nav: 30;      /* the sidebar */
```

The modal is out of this scale on purpose: it is a native `<dialog>` opened with
`showModal()`, so the browser's top layer puts it above everything without a
z-index.

### 3.6 Breakpoints

Four hardcoded max-widths, all four now contiguous at the foot of the
stylesheet in descending order: 1050px (`styles.css:3247`), 980px
(`styles.css:3271`), 780px (`styles.css:3278`) and 560px (`styles.css:3361`).
Putting them in one place was section 7.3's doing; how many of them there should
be is still this section's question.

Three named steps, and the 980px block folded into the 1050px one:

```css
/* --break-wide: 1050px; --break-narrow: 780px; --break-mobile: 560px */
```

Custom properties cannot be used in a media query's condition, so these are
documented constants rather than tokens until container queries or
`@custom-media` make it possible. Say the constant in a comment above every
`@media` so a reader knows which step they are in.

## 4. Motion tokens

**House.** Durations and easings are tokens, and the reduced-motion block sets
those tokens in one place. Otherwise every new animation has to remember to add
itself to a second block, which is the exact failure the colour test exists to
prevent.

Today there are no motion tokens. Transitions are written inline at 120ms (six
declarations), 140ms (one) and 180ms (the mobile drawer's paired `transform` and
`visibility`, `styles.css:3282-3284`), and there are two reduced-motion
blocks: `styles.css:653-657`, which turns off the skeleton shimmer specifically
and stays beside `.skeleton` on purpose rather than joining the responsive body
(section 7.3), and `styles.css:3441-3450`, a blanket rule setting
`animation-duration`, `transition-duration` and `scroll-behavior` on
everything.

**The blanket rule has a defect, and it is user-visible.** It also sets
`animation-iteration-count: 1 !important`, which freezes the button's
`.animate-spin` loader (`styles.css:619-621`,
`src/client/components.tsx:298`) into a static icon. Somebody who asked for
reduced motion gets no busy indicator at all. `.skeleton` was exempted by hand
and the spinner was not. A slow rotation is acceptable under `reduce`, which
asks for minimised non-essential motion; no indicator is not. Exempt the spinner
by name, or replace the rotation with an opacity pulse.

*Checked by:* `tests/styles-skeleton.test.ts` asserts the shimmer animation
belongs to `.skeleton` and to no other selector, and that every card paints its
own background so nothing underneath reads as the card moving. Nothing checks
the spinner case.

## 5. The font stack

**House, and a live inconsistency.** The stack is
`Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
sans-serif` at `styles.css:95-97`. **Inter is never loaded.** There is no
`@font-face` in the stylesheet, no font file in `public/` (which holds
`apple-touch-icon.png`, `favicon.svg` and `theme-boot.js`), no stylesheet link,
and the Content-Security-Policy declares no `font-src`, so it falls back to
`default-src 'self'` and a CDN font would be blocked
(`src/server/http-security.ts:22-32`,
`deploy/docker/nginx-security-headers.conf:10`).

So the app renders in the system font on every machine that does not happen to
have Inter installed. Two honest resolutions, and the guide does not pick
between them because it is a hosting decision:

1. Ship Inter as a self-hosted subset in `public/` with an `@font-face` and a
   `font-src 'self'` addition to both CSP declarations.
2. Delete Inter from the stack and write the stack that is actually in use.

Either way the tabular-figures rule in section 10 depends on the answer, because
whether the rendered font supports the OpenType `tnum` feature was not
established and must be verified against the font that actually ships.

*Not checked mechanically.* A test asserting that every family named in the
stack is either a generic keyword or has an `@font-face` would catch this and
does not exist.

## 6. Components

### 6.1 The inventory

**House.** `src/client/components.tsx` is the component library: nineteen
components, two helpers (`compareForSort`, `useConfirm`) and two exported types.
There is no list of what it contains, which is how `.settings-note` became the
generic muted paragraph and `.section-title` grew two incompatible layouts.

| Component | For |
| --- | --- |
| `PageHeader` | Page title, eyebrow, actions |
| `Button` | Every action. Variants: primary, secondary, ghost, danger |
| `Field` | Label, hint and one control (section 8) |
| `Input`, `Select`, `Textarea` | The three form controls |
| `SortableHeader`, `SortMenu`, `compareForSort` | Sorting a table (section 9) |
| `SelectionCheckbox` | Row and select-all selection |
| `Pagination` | Page controls under a list |
| `RowMenu` | The per-row action menu |
| `Modal`, `ConfirmDialog`, `useConfirm` | Overlays and destructive confirmation |
| `DateRangeBar` | The shared period selector |
| `BulkEditToggle` | One field of a mass edit |
| `Skeleton` | A loading placeholder of known shape |
| `EmptyState` | A list with nothing in it |
| `Alert` | A form-level or page-level message |
| `Badge` | A state word beside a row |

*Not checked mechanically.* A test could assert that every exported function in
`components.tsx` has a row, which would catch an addition but not a duplicate.

### 6.2 When something becomes a component

**House.** All four have to be true:

1. A second page needs it. One use is a page's own markup.
2. It does not duplicate something in the table above. A name check catches the
   obvious case and nothing else, so this one is judgement.
3. It is reachable and operable by keyboard, and it has an accessible name.
4. It does not need a new colour, space, radius or size outside the scales.

Three things in the app are past the threshold and are not components yet:

- **A search box.** Six call sites, two markups: icon plus `aria-label` on
  `TransactionBrowser.tsx`, `StagingPage.tsx`, `CategoriesPage.tsx` and
  `PayeesPage.tsx`; an `.sr-only` span with `type="search"` and no icon on
  `TemplatesPage.tsx` and `RecurrencesPage.tsx`. `.search-box .input` applies a
  34px left gutter unconditionally (`styles.css:1529-1531`), so the two pages
  without an icon show an empty gutter.
- **A bulk-action bar.** Three toolbars, three label sets, three variant
  assignments. Fix the vocabulary at "Edit selected", "Delete selected", "Clear
  selection", "Select all N matching".
- **A blank-cell placeholder.** An em dash on ten sites
  (`TransactionBrowser.tsx:829`, `:837`, `:841`, `AccountDetailPage.tsx:101`,
  BudgetsPage.tsx:847`, `:853`, `:858`, `:873`, `StagingPage.tsx:748`,
  `:815`), an italic muted
  word on others, and `Uncategorized` styled `.subtle` on one page and bare on
  another. One of the eight, `TransactionBrowser.tsx:837`, writes the dash as
  literal cell text rather than as a fallback expression. The em-dash and
  italic-word distinction is real and worth keeping; the `Uncategorized`
  difference is not.

*Not checked mechanically.* Whether something has crossed the threshold is
judgement; that a repeated markup has one owner is what a component test would
catch once the component exists.

### 6.3 Class naming

**House.** A class is component-scoped and named for the component:
`.account-card-main`, not `.card2`. A page-scoped name is not used off its page.

**The code disagrees, in one place that matters.** `.settings-note` appears **28
times across 12 files**: `App.tsx`, `forms.tsx`, and ten pages including
`BudgetsPage`, `ReportsPage` and `ImportPage`. **Eight of those are a loading
message.** It is the generic muted paragraph, named after the page it was born
on. Rename it `.note`, or better, replace the loading uses per section 12 and
the rest with a real component.

The four utilities that are legitimate and should stay utilities: `.align-right`,
`.nowrap`, `.subtle`, `.sr-only`.

*Not checked mechanically.* A test asserting that a page-prefixed class is used
only on that page would catch this class of drift.

## 7. Layout primitives

### 7.1 The shell

**House, describing what exists.** `.app-shell` holds a fixed `.sidebar` and a
`.main-column`. Below 780px the sidebar translates off-screen and a
`.mobile-header` with a `.nav-scrim` takes over. `.content` is the page body.
Inside it: `.panel` for a titled region, `.table-card` for a table that is the
card, `.metric-grid` and `.account-card-grid` for card grids.

*Not checked mechanically.* This is a description of what exists rather than a
rule with a failure mode of its own.

### 7.2 Card and table wrappers

**House, already enforced.** `.table-card` carries a card's border,
background and shadow and is used when the table *is* the card. `.table-wrap` is
unstyled apart from `overflow-x: auto` and is used when the table sits inside a
`.panel`, which already carries the same three. Using `.table-card` inside a
panel draws a second card around the first, which is taste. Using neither lets a
table wider than its panel spill past the edge with no way to reach the far
columns, which is not: that half is SC 1.4.10 and SC 2.1.1 and is covered in
9.6.

*Checked by:* `tests/table-overflow.test.ts` asserts every `.data-table` has a
scrolling wrapper within three lines above it, and that `.table-wrap` declares
`overflow-x: auto` and no border, background or box-shadow.

### 7.3 One body, then the responsive body

**House, and enforced.** The stylesheet is three colour blocks (section 1.2),
then one body of component rules, then one body of responsive and preference
blocks, and nothing after them. It was not always: component rules used to
resume below the breakpoints and run for another 426 lines, with a stray 980px
block stranded among them. Media queries add no specificity, so a rule down
there silently outranked the responsive overrides above it —
`@media (max-width: 780px) { .chart-grid { … } }` written in the obvious place
would have lost to `.chart-grid` written later, with nothing on screen to say
why. `.report-tabs` and the chart grid still have no responsive treatment, and
that is now a gap somebody can fill rather than a trap.

Two blocks are outside the responsive body on purpose and are named here rather
than left as holes. The dark-token block belongs to the three colour blocks at
the top, which section 1.2 requires and which this rule does not override. And
the reduced-motion block that stops the skeleton shimmer sits directly beneath
`.skeleton`, four lines qualifying the rule six lines above it: that is part of
a component's own rule, not a second body, and the hazard this section exists to
prevent is a *component rule after the responsive body*.

The four breakpoints run in descending order at the foot of the file, each under
the comment naming its constant, with the blanket reduced-motion block last.

*Checked by:* `tests/styles-order.test.ts` asserts that every top-level
construct from the first `@media (max-width` block onward is an at-rule, that
the breakpoints read 1050, 980, 780, 560 in source order, and that the only
preference block above them is the skeleton's.

## 8. Forms

### 8.1 The Field contract

**Binding, WCAG 2.2 SC 1.3.1 Info and Relationships and SC 4.1.2 Name, Role,
Value, both level A. The largest single piece of work in this guide.** A label
that is not programmatically associated, a hint the control does not point at,
and a composite control with no accessible name are failures of those two
criteria rather than preferences.

`Field` exists. It is at `src/client/components.tsx:294-389` and it is used at
87 sites. It is wrong in three specific ways rather than absent:

```tsx
export function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string }>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
```

1. **Implicit association by wrapping.** W3C's forms tutorial asks for explicit
   `for`/`id`, where the `for` exactly matches the control's `id`. There is
   exactly one `htmlFor` in the whole client, at `components.tsx:117`.
2. **The hint renders after the control, with no `id` and no
   `aria-describedby`.** GOV.UK's order is label, hint, error, then the input,
   all wired by `aria-describedby`. There is exactly one `aria-describedby` in
   the whole client, at `components.tsx:539`, and it belongs to `Modal`.
3. **There is no error slot.** Zero `aria-invalid`, zero `aria-errormessage`,
   and no per-field error markup anywhere in `src/client`.

The amendment: add `useId`, switch to explicit `for`/`id`, add an `error` prop,
and compose `aria-describedby` from the hint id and the error id.

**House, the ordering.** The hint goes above the control, following GOV.UK's
label, hint, error, input order. Nothing in WCAG decides where a hint sits; what
is Binding is that the control points at it.

**Second defect, from the same component.** `Field` is a wrapping `<label>`,
which is correct around one control and wrong around a composite. `<Field
label="Category">` wraps `CategoryLegs` at src/client/forms.tsx:1116`, `:2192`
and `:2815`, which renders up to fifty rows of three inputs.
The label binds to the first leg's `CategoryPicker`, which carries no
`aria-label` of its own, so legs two onward have no accessible name at all, while
the amount and note inputs in the same rows do. Give `Field` an `as="group"`
variant rendering `<div role="group" aria-labelledby>`, and give `CategoryPicker`
an `aria-label` prop passed `Category for split {n}`.

*Not checked mechanically.* Once `Field` carries the contract, a test asserting
that every `<input>`, `<select>` and `<textarea>` in JSX is inside a `Field`
becomes possible and is worth writing. `eslint-plugin-jsx-a11y` covers the
label-association half off the shelf and is cheaper than writing it.

### 8.2 When errors appear

**House, following GOV.UK.** Errors appear on submit, not on blur and not as
you type. As-you-type validation causes problems for people who type slowly, and
validating on blur punishes moving away from a field.

**The exception is arithmetic.** A split's remainder telling you what is left is
feedback, not validation, and it updates live. `moneyRemainder` is arithmetic;
it says how much is unallocated, never that you are wrong.

Client-side validation never replaces server-side validation. `AGENTS.md`:
"A rule the browser previews and the server enforces has to be one function, or
the preview eventually shows something the server refuses." The rule lives in
`src/shared`, and the browser and the server both call it.

*Checked by:* the shared-schema half is structural and covered by the domain
tests. The timing half is review.

### 8.3 The error summary

**House, half settled.** `ErrorSummary` (`src/client/components.tsx`) follows
GOV.UK's contract as far as this app can currently take it: the first child of
the form, above `RequiredNote`; a heading reading "There is a problem"; every
sentence the refusal carried; and focus moved to it. It is wired to the four
forms that submit a Zod-validated body — account, transaction, template and
recurrence (`src/client/forms.tsx`).

Three adaptations, all of which GOV.UK's own markup already accommodates. Focus
is moved with a ref, because nothing reloads: GOV.UK's contract assumes a page
load has already put the person at the top of the document, and that is
precisely what was missing here — the message was announced by `role="alert"`
and then left up to fifty split rows above the button that had just been
pressed. `role="alert"` sits on an inner `<div>` inside the container, so the
live region can be mounted empty and populated later and the container can still
be focused. And the heading level is a prop defaulting to `h3` rather than
GOV.UK's fixed `h2`, because all four call sites are inside `Modal`, whose title
is already an `<h2>` and is the dialog's accessible name. Same reasoning as
`EmptyState` in section 12.1: a component that hard-codes a level misstates the
document wherever it is used.

What the component watches is the failure, not the sentences it produced, and
that is the part most likely to be "simplified" back into a bug. A refusal
nobody has yet satisfied repeats word for word, so a person who presses the
button again would otherwise be left at the bottom of the form with nothing
having moved; and the pending render that would blank the set in between never
commits, because React batches the mutation's `pending` and `error` updates into
one render. TanStack Query's `failureCount` is no use either — it is reset to
zero on every `mutate()`, so it reads the same after the second failure as after
the first. A fresh refusal is a fresh object, which is the one thing that always
differs.

**The collecting half was a client defect, not a missing component.**
`src/client/api.ts` took the *first* Zod issue out of `details` and threw that
one sentence, so a 422 naming three bad fields showed one, and you found the
second by fixing the first and pressing the button again. The whole array was
already on `ApiClientError.details` and nothing in the client had ever read it.
It is now kept as `messages`, one entry per failing field, with `message` still
the first of them, so every `<Alert>` still rendering a single message is
unaffected.

Two details of that collection are load-bearing and both look like fussiness.
The list is discriminated on `path`, not on `message`, because Zod issues always
carry one and an `AppError` passing an array of its own does not: the CSV
refusal in `src/server/services/import-export.ts` hands over Papa's parser
errors, and reading those as field messages is how "CSV contains malformed
quoted data" became "Quoted field unterminated" on screen. And what is
deduplicated is the (path, sentence) pair rather than the sentence, because Zod
gives identical wording to different fields — two blank fields are two
"Invalid input: expected string, received undefined", and three split legs left
at zero are three "Amount must be greater than zero". Collapsing those by
wording would say one amount is wrong when three are, which is the case a
summary exists for.

**Still to do: the links.** GOV.UK's list entries are anchors to the failing
field, and there is nothing to anchor to — `Field` gives its control no `id`
(section 8.1). The links arrive with that change. Shipping them first would have
meant anchors pointing nowhere, which is worse than plain text.

**Still to do: the other eleven forms.** The auth forms (`src/client/App.tsx`)
stack a client-side string and a mutation error as two separate red boxes, which
is the case this section exists for, but folding them together wants section
8.1's error prop first. The bulk forms in `TransactionBrowser.tsx`,
`StagingPage.tsx` and `TemplatesPage.tsx` fail per row and want a different
shape, not this one.

The native half needs nothing. No form sets `noValidate`, so constraint
validation still blocks submit, focuses the first invalid control and announces
its message. GOV.UK's objection to native bubbles is styling, persistence and
multiplicity, not that they fail a success criterion.

*Checked by:* `tests/error-summary-ui.test.tsx` — that a refusal carrying two
issues renders both, that two fields sharing one sentence stay two lines, that
the same field refused twice shows once, that the container takes focus, that an
identical second failure re-announces, that the heading is an `h3` under a
dialog's `h2`, and that a Papa-shaped `details` with no `path` leaves the app's
own sentence standing.

### 8.4 Required and optional

**House, and the code disagrees with itself.** `required` is set on inputs 54
times and surfaced neither visually nor to assistive technology. The only signal
is that twelve optional fields say "Optional" in the hint.

Marking the optional ones is a coherent scheme and it is the one this product
picked, so it is now stated: `RequiredNote` (`src/client/components.tsx`) sits
before the account, transaction, template and recurrence forms and reads "Every
field is required unless it says otherwise", which is where W3C puts an
instruction covering a whole form. A person meeting an unmarked field previously
had no way to know which of the two schemes they were in.

"Says otherwise" rather than "says Optional" because eleven fields say
`hint="Optional"` and others say it in better words — a budget's end date says
"Leave blank to keep running", which is more useful than the label would be.

**Still to do:** a field that is neither marked optional nor actually required is
a bug in the form, and nothing finds them. Most of the 32 unmarked fields are
`<Select>`s that always hold a value and so are required in fact, but the list
has not been walked one by one.

*Not checked mechanically.* A test could assert that every `Field` whose control
lacks `required` carries a hint, which is weaker than reading each one but would
catch a field with no guidance at all.

### 8.5 Money fields

**Binding, from `AGENTS.md` rather than from WCAG.** "Never represent money
with JavaScript/JSON floating-point numbers. Use validated decimal strings and
PostgreSQL `numeric(44,18)`." A money field is `type="text"` with
`inputmode="decimal"`, never `type="number"`, because a number input hands you a
float. GOV.UK's reasons (accidental scroll increments, no feedback on a
non-numeric entry) are secondary and point the same way.

**Scope this exactly.** A blanket ban on `type="number"` in the client would
fail on correct code: src/client/forms.tsx:1204` and `:2878` both use it for
the recurrence interval, with `min` and `max`, which is an integer count where a
spinner is arguably right. The rule is: no `type="number"` on a field bound to a
decimal-string money value.

**Binding, SC 3.3.2 Labels or Instructions, level A.** The criterion asks that
"labels or instructions are provided when content requires user input". A
currency symbol rendered as an input prefix is not part of the control's label
and is not announced, so the instruction is missing for anybody who does not see
it. Put the currency in the label: "Amount (GBP)".

*Not checked mechanically.* A grep test scoped to money-bound fields is listed
in section 17.

### 8.6 Autocomplete and redundant entry

**Binding, SC 1.3.5 Identify Input Purpose, level AA.** `autocomplete` tokens on
sign-in, sign-up and settings fields, because those collect information about
the user.

Not on ledger fields, and **state the exclusion as a scope argument**. WCAG §7
does define `transaction-amount` and `transaction-currency`, so an "there is no
token for it" argument is false and a reviewer will find the token and reopen
the question. The correct argument is the criterion's own scope: information
about the user, with §7's preamble that these purposes pertain only to
information related to that individual. A transaction's amount is a fact about
the ledger, not about the person.

**Binding, SC 3.3.8 Accessible Authentication (Minimum), level AA.** Never block
paste in a password field, never disable autofill, and always set
`autocomplete="current-password"` or `"new-password"`. Note 2 of the criterion
names password-manager support and copy-and-paste as the qualifying mechanisms.

**Binding, SC 3.3.7 Redundant Entry, level A.** Anything the person already
supplied in the same process is prefilled or offered for selection. This is the
standards backing for templates, for payee autocomplete, and for the CSV import
flow carrying its column mapping and default account forward into the staged-row
commit path.

*Not checked mechanically.* A grep for `autocomplete` on the auth forms would
cover the first half.

### 8.7 The dense form exception

**Contested, and the disagreement is worth recording.** GOV.UK's default is one
question per page, on the evidence that low-confidence users find it easier,
that it works better on mobile, and that it handles errors, branches and saving
progress better. All of that evidence is about first-time public users
completing a one-off transaction.

GOV.UK itself carves out the other case: "if you're designing an internal
service for government users who need to repeat and switch between tasks
quickly", related questions may be grouped, with a statement as the heading.
Research found no study behind that carve-out, so **the exception this product
takes is permitted by the source and not evidenced by it.** Saying so is the
point of the label.

This product takes the exception. The transaction form is one person's books,
used dozens of times a week. **The price is paid in full or the exception is not
taken:**

- A deliberate tab order, in the order a person actually works.
- Enter submits from any single-line field.
- A per-field error contract (section 8.1).
- No field that requires a mouse.

*Checked by:* the keyboard pass, which `AGENTS.md` already requires: "For UI
changes, verify keyboard use and responsive layouts." Section 14 gives it a
checklist so it means something.

### 8.8 Radio groups and choice controls

**House, already implemented and already tested.** Radios share a `name`
generated by `useId()` inside a `role="radiogroup"` container with an
`aria-label`. A constant name is forbidden, because two instances of one form can
be on a page at once and a shared name silently merges them.

`TransactionTypeChoice` (src/client/forms.tsx:439-567`, the function itself
at `:454`) is the reference
implementation: a real radio group with roving tabindex and arrow, Home and End
handling that wraps at both ends when a type is mandatory, `aria-pressed`
toggles when "no type" is a real answer, and a discriminated union prop pair so
only the `allowNone` shape can report an empty selection.

*Checked by:* `tests/radio-groups.test.tsx` walks every radio on every form,
asserts each belongs to exactly one group, asserts two forms on one page stay in
separate groups, and covers the roving tabindex and the wraparound.

### 8.9 Comboboxes

**House, settled.** An input offering a `<datalist>` declares no ARIA of its
own: src/client/forms.tsx:315`, `:586` and `:2082` carry `list` and nothing
else. All three used to add `role="combobox"`, `aria-autocomplete="list"` and
`aria-controls`, which was wrong twice over. A `<datalist>` is not a listbox, so
the declaration promised a widget that was not there and left out the
`aria-expanded` an explicit combobox is required to carry. And it was redundant:
HTML-AAM already maps an `<input>` with a `list` attribute to the combobox role,
which is why removing all three left every selector that finds them by that role
still passing, in `tests/browser/budgets.spec.ts` against a real browser.

The rule is therefore the plain one: let the native control carry its own
semantics, and add ARIA only where there is no native element to lean on.

Also: `TransactionForm` re-implements the payee combobox rather than using
`PayeeInput`, whose docstring exists to prevent exactly that. One component.

*Checked by:* `npm run lint`. `jsx-a11y/role-has-required-aria-props` is denied,
and it was what found these three; re-adding the role without `aria-expanded`
fails the build. Note that jsdom does **not** compute the implicit role, so a
jsdom test looking for `getByRole("combobox")` on one of these fails while the
same query passes in a browser — which is why the browser tier owns that check.

## 9. Tables

### 9.1 Table, not grid

**Contested.** The ARIA Authoring Practices Guide leans the other way for
link-heavy tables: rather than a static table with every link in the tab
sequence, it says the grid pattern gives more efficient keyboard navigation and
a shorter tab sequence.

This product stays a table. A grid means writing arrow-key focus management
across thousands of rows to shorten a tab sequence nobody has complained about,
and there is no roving tabindex anywhere else in the client, which is the same
reason `RowMenu` deliberately refuses `role="menu"`
(`src/client/components.tsx:432-435`). Rows carry a checkbox and a row menu and
both are reachable by Tab. Recording that the APG leans the other way is what
makes this read as a decision.

*Not checked mechanically.* A test asserting no `role="grid"` in `src/client`
would hold the decision and is worth roughly nothing until somebody reaches for
one.

### 9.2 Semantics

**Binding, WCAG 2.2 SC 1.3.1 Info and Relationships, level A, for the header
association**: `scope="col"` on every column header and `<th scope="row">` on
the identifying cell, so a cell's row and column headers are programmatically
determinable.

**House for the caption.** Every `.data-table` also gets an `.sr-only`
`<caption>`. No level A or AA criterion requires one; a table announced without
a name is harder to place, and the caption is the cheapest way to give it one.

**Settled for captions and `scope`.** Every table in the client carries a
`<caption>`, and every header cell carries a `scope`. Four of the tables people
live in had neither — the register, the review queue, templates and recurrences
— while reports and budgets did. `SortableHeader`
(`src/client/components.tsx:49-96`) now emits `scope="col"` alongside its
`aria-sort`, which was the fix worth making because that one change covers every
sortable column in the product.

**Still to do:** the identifying cell in those four is a `<td><strong>` rather
than a `<th scope="row">`, so a row is announced without the thing that names
it. That is a per-table change to the cell each table considers its subject, not
a shared one.

*Checked by:* `tests/table-overflow.test.ts` asserts a caption on every table
and a `scope` on every header cell, read from the source because jsdom computes
no layout and would report a captioned table and an uncaptioned one
identically.

### 9.3 Numeric columns

**House, and it is ours rather than GOV.UK's.** A numeric column is **one
decision**: header alignment, cell alignment and `font-variant-numeric:
tabular-nums` travel together, applied through one class. GOV.UK right-aligns
both the header and the cell but applies tabular figures to the cell only; the
stronger rule is this product's.

Implemented: `className="align-right"` on a money cell is what turns on tabular
figures, through `.data-table td.align-right` at `styles.css:659-664`.

Two loose ends. `.amount` is declared as a money hook in the same rule and is
used by nothing; delete it or adopt it at the roughly 30 `formatMoney` call
sites that render currency outside a table in proportional digits. And
`.money`'s weight and `white-space: nowrap` (`styles.css:1758-1762`) apply only
inside the transaction register; fold them into `.data-table td.align-right`.

*Checked by:* nothing today. A test asserting that tabular figures and right
alignment are declared in the same rule would pin the pairing.

### 9.4 Sorting

**House, already implemented.** `SortableHeader` and `SortMenu` are the only two
sanctioned sorting affordances. `SortableHeader` makes the whole `<th>` the hit
target, sets `aria-sort` on the `<th>`, sets `none` on inactive columns (ARIA
1.2 asks for `aria-sort` on one header at a time), and carries an `.sr-only`
sentence naming the current order and what activating will do.

Its `lean` prop is a real decision and is written down here because most systems
leave it implicit: **text columns start ascending, dates and amounts start
descending.** Somebody sorting by amount wants the largest first.

*Not checked mechanically.* The `aria-sort` single-header rule is assertable.

### 9.5 Selection

**Binding, from `AGENTS.md`.** "Transaction and staged mass edits are atomic and
share one selection contract. Explicit rows carry expected versions; all-filtered
selections carry a server-issued count and `id:version` fingerprint."

The interface consequence: **the selection bar states the count and the scope,
and the two are different sentences.** "12 selected" and "All 4,318 matching
selected" come from two different code paths and the second must never be
produced by the first.

The mixed state is already handled. `SelectionCheckbox`
(`src/client/components.tsx:179-194`) takes an `indeterminate` prop and writes it
onto the DOM node in an effect, because React does not expose it, and all three
select-all checkboxes pass it: `TransactionBrowser.tsx:776`,
`TemplatesPage.tsx:465`, `StagingPage.tsx:681`.

*Checked by:* `tests/bulk-row-cap.test.ts` and the server-side selection tests
cover the contract. The two sentences are review.

### 9.6 Overflow

**Binding, WCAG 2.2 SC 2.1.1 Keyboard, level A.** A horizontally scrolling
container must be reachable by keyboard. `.data-table` carries `min-width:
760px` (`styles.css:1603`) and always sits in a container that scrolls, so on a
narrow panel it always scrolls. **No scroll container in the client has
`tabindex="0"`**: the two `tabIndex` values in `src/client` are the roving one at
forms.tsx:522` and the `-1` that lets the error summary take focus without
becoming a tab stop (`components.tsx:370`). Add `tabIndex={0}` to `.table-card` and `.table-wrap`, and pair
it with `role="region"` and an accessible name so it is not an unnamed tab stop.
The pairing is good practice; the `tabindex` is the rule.

**House.** Prefer priority columns to whole-table horizontal scroll. On a
transaction list the essential three are date, payee and amount; account,
category and status may drop or move to a second line below a breakpoint.

*Checked by:* `tests/table-overflow.test.ts` covers the wrapper. Nothing covers
the `tabindex`.

### 9.7 Sticky regions

**Binding, WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum), level AA.** A
focused component must not be entirely hidden by author content. The named
hazards are sticky footers, sticky headers and non-modal dialogs, and the
sufficient technique is CSS `scroll-padding`.

There are **no `scroll-padding` or `scroll-margin` declarations anywhere in
`styles.css`**, and eight sticky or fixed regions:

| Selector | Line | Position |
| --- | --- | --- |
| `.sidebar` | `styles.css:339` | fixed |
| `.row-menu-popover` | `styles.css:1482` | fixed |
| `.modal` | `styles.css:2042` | fixed |
| `.modal-header` | `styles.css:2068` | sticky |
| `.import-preview` | `styles.css:2200` | sticky |
| `.merge-panel` | `styles.css:2442` | sticky |
| `.nav-scrim` | `styles.css:3300` | fixed |
| `.mobile-header` | `styles.css:3310` | sticky |

`.merge-panel` is the live case. It exists because the list is long enough to
scroll, which is the same condition that puts a focused row underneath it. Every
scroll container holding a sticky element sets `scroll-padding-top` (or
`-bottom`) to at least that element's height.

*Not checked mechanically.* The list is short enough to enumerate in a test.

## 10. Money and dates on screen

The substance is in [`common.md`](common.md) and is not repeated. What follows
is only what a screen adds.

### 10.1 The sign carries the meaning

**Binding, SC 1.4.1 Use of Color, level A, and `AGENTS.md` for the arithmetic.**
The minus sign is load-bearing and the colour is decoration on top of it.
Whether a figure is negative is decided by `isNegativeMoney`, never by
`Number(x) < 0`.

**The code disagreed with itself in three ways, and the same withdrawal read
three ways in three places.** The table is what it was; the paragraph below it
is what replaced it.

| Where | Treatment |
| --- | --- |
| `DashboardPage.tsx:118`, `:150`, `AccountsPage.tsx:233`, `ReportsPage.tsx:247`, `:254`, `:272`, `AccountDetailPage.tsx:212` | `money-negative` on the value, with Intl's own minus sign. Still the rule for a computed total, which has a sign of its own |
| `TransactionBrowser.tsx:876-881` | Coloured and signed by transaction *type*, with a hand-prefixed `+` or `−` |
| `StagingPage.tsx:812`, `TemplatesPage.tsx:550`, `RecurrencesPage.tsx:216` | No colour and no sign |

One rule, and it is **direction** rather than the value's own sign: a stored
amount is always positive, because `AGENTS.md` keeps direction in the type. So a
deposit reads `+` in green, a withdrawal `−` in red, and a transfer is signed
but uncoloured — money moving between somebody's own accounts is not spending.

`movementSign` (`src/client/money.ts`) is that rule, and the four lists share it.
The register already did this; the review queue, the templates and the
recurrences showed no sign at all, so the same withdrawal read three ways in
three places and one of the three did not read at all. The register may
additionally show direction through `.transaction-icon`, because a colour and an
icon fail in different conditions.

**One asymmetry survives, deliberately.** An inbound transfer takes the deposit
colour and an outbound one takes none. That is the register's own behaviour and
it was preserved rather than tidied, because tidying it would repaint a screen
nobody asked to have repainted. It is recorded here so the next person finds a
decision rather than a bug.

*Checked by:* `tests/movement-sign.test.ts`, including that the minus is U+2212
rather than a hyphen, and that a staged row whose type a parser could not read
gets no sign rather than a guessed one.

*Checked by:* `tests/client-money.test.ts` covers the arithmetic. The rendering
rule is review, and a grep for `formatMoney` call sites not wrapped in a sign
decision would narrow it.

### 10.2 Trailing zeros stay

**House, and it reverses GOV.UK deliberately.** The GOV.UK style guide says "Do
not use decimals unless pence are included: £75.50 but not £75.00". That is right
for prose and wrong for a ledger column: every row needs the same number of
fraction digits or the decimal points do not line up and tabular figures buy
nothing. `formatMoney` already renders ISO currencies at their own precision and
keeps every stored digit for non-ISO ones. Leave it alone.

*Checked by:* `tests/client-money.test.ts` covers `formatMoney`'s digits. That
no site strips them afterwards is not checked mechanically.

### 10.3 A standalone figure carries its whole sentence

**House.** A figure in a card gets the whole sentence as its accessible name:
"Net worth, £1,234.56", not "£1,234.56". A screen reader reading the number
alone gives no way back to what it counts. `SortableHeader` already uses this
technique with its `.sr-only` sentence.

*Not checked mechanically.* Whether an accessible name is a whole sentence is
review; that one exists at all is what `eslint-plugin-jsx-a11y` covers.

### 10.4 Dates

**House, by deferral.** No rule of its own: dates are settled in
[`common.md`](common.md#dates-and-times), and what a screen adds is only which
code path renders them.

Dates render through four code paths today, and two of them print raw ISO
directly above tables whose dates are formatted: `DashboardPage.tsx:129` and
`ReportsPage.tsx:191` both print `As of {asOf}` raw. `ActivityPage.tsx:54-57`
inlines an `Intl.DateTimeFormat` in the *browser's* zone rather than the
account's, and `SettingsPage.tsx:529` uses a bare `toLocaleString()`.

`formatDate` for calendar dates, and a `formatTimestamp(instant, timezone)`
taking its zone from `useTimezone()` for the two instant cases. A date column is
right-aligned or left-aligned by taste, but it gets tabular figures either way.

*Checked by:* `tests/recurrence-dates.test.ts` and
`tests/locale-detection.test.ts` cover the arithmetic. The rendering paths are
review, and a grep for `toLocaleString` and `Intl.DateTimeFormat` outside
`money.ts` would catch the drift.

## 11. Charts

`src/client/charts.tsx` renders a line chart and a grouped bar chart. There is
no pie chart, which decides a question below.

### 11.1 Series against the background

**Binding, SC 1.4.11, level AA.** Every series colour clears 3:1 against the
surface it is drawn on. Measured, all ten do, in both themes:

| Series | Light | Dark | | Series | Light | Dark |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 5.62 | 5.37 | | 5 | 4.88 | 5.48 |
| 1 | 5.88 | 4.52 | | 6 | 4.60 | 6.85 |
| 2 | 5.00 | 9.17 | | 7 | 9.60 | 4.51 |
| 3 | 3.64 | 4.64 | | 8 | 7.89 | 5.65 |
| 4 | 6.27 | 6.78 | | 9 | 8.80 | 4.67 |

Series 3 at 3.64 light is the tightest and is the one to watch.

Gridlines do not have to contrast with the data. The Understanding document for
1.4.11 says data lines "should have 3:1 contrast against their background, but
as there is little overlap with other lines they do not need to contrast with
each other or the graduated lines". `.chart-grid` at `styles.css:2992-3000` is
correctly faint and says why; `.chart-zero` is correctly held to 3:1 because it
is where money in becomes money out, and says why.

*Checked by:* `tests/theme-tokens.test.ts` asserts one token per series in both
themes, that no two series in a theme share a value, and that every
`.chart-series-N` draws from its token. It checks uniqueness, **not contrast**;
two adjacent slices at 1.8:1 against the page would pass today.

### 11.2 Adjacent series

**Contested, and this is where the guide departs from the research behind it.**

The UK Government Analysis Function publishes a six-colour categorical palette
where all adjacent colours clear 3:1 against each other, caps categories at four
as best practice, and treats five and six as "only when essential". Read
literally, that says this product should cut ten series to six.

This product keeps ten, on measured grounds recorded at `styles.css:3044-3070`.
The previous six-colour set had a worst dichromatic pair of 1.78 in CIEDE2000
under simulated deuteranopia and protanopia, where the green and the pink were
the same colour; the current ten reach 5.6 in light and 4.7 in dark. Going from
six to ten made colour-blind separation better, not worse. The number of series
here is also not an author's editorial choice: it is how many accounts somebody
has.

**Where the source's rule does bite, and where the code fails it.** Measured
against each other, adjacent series pairs run from 1.05 to 2.09 in light and
1.19 to 2.03 in dark. Not one pair reaches 3:1. For the line chart that is
allowed by the Understanding document, quoted above. **For the grouped bar chart
it is not.** `BarChart` at `src/client/charts.tsx:417-424` lays each series' bar
at `index * barWidth` with no gap (`charts.tsx:392`, `:421`), so bars within a group
touch, and `.chart-bar` sets `stroke: none` (`styles.css:3017-3019`). Two
touching bars at 1.05:1 have no visible boundary.

The fix is geometry, not a repainted palette: a gap between bars within a group,
or a one-pixel `--surface` stroke on `.chart-bar`. Either is cheap and neither
disturbs the measured dichromatic separation.

*Not checked mechanically.* Extend the chart-palette test to compute contrast
rather than uniqueness, and to assert the bar separation.

### 11.3 A second channel that is not colour

**Binding, SC 1.4.1, level A, plus the source guidance.** Ten categorical
colours cannot all be told apart under dichromatic vision, and no choice of ten
fixes that. The CSS comment says this out loud and names the remedy: a dash
pattern per series.

Until that lands, two things carry identity and both are always present: the
legend and the table under every chart. But the legend as built is the wrong way
round for the reader who needs it. `ChartLegend` (`src/client/charts.tsx:439-449`)
renders the swatch with `aria-hidden="true"` and the label as text, so a screen
reader gets the label and a colour-blind sighted reader gets only a swatch they
may not be able to match. A dash pattern in the swatch fixes both halves at once.

Direct labelling is the other published answer, and both the Analysis Function
and Okabe and Ito recommend it over a legend for lines. Use it where a chart has
few enough series to fit labels; keep the legend where it does not.

*Not checked mechanically.* A test asserting that every series swatch carries a
dash pattern becomes possible once the patterns exist, and is item 5 in 17.2.

### 11.4 Every chart ships its table

**House, satisfying a binding requirement cheaply.** A chart is a complex image
and takes a two-part text alternative: a short description identifying it, and a
long one carrying the content. The ledger has already computed the long
description, so the table is free.

The table goes **in the page**, not behind `aria-describedby`. A described-by
target is flattened to one continuous paragraph and a screen reader loses the
table structure entirely. `ReportsPage.tsx:194-244` already does this correctly,
with a real table carrying an `.sr-only` caption and `scope` on every header.
`.chart-figure` uses `<figure>` and `<figcaption>`, which is the recommended
structure.

*Not checked mechanically.* A test asserting a table alongside every chart
component is structural and worth writing.

### 11.5 Pixels may be lossy

**Binding.** The rule and its two examples are in
[`common.md`](common.md#money). What this guide adds is the line reference:
`niceTicks` at `src/client/charts.tsx:86-126` is where the conversion happens,
and it is the only place in the chart code that is allowed to make one.

*Checked by:* `tests/client-money.test.ts`.

## 12. Empty, loading and error states

Research found no primary source on empty-state categories, on when to show a
spinner versus a skeleton, or on how long before either. Carbon's and Polaris's
pages could not be retrieved. So this section is reasoning, not citation, and it
is labelled accordingly.

### 12.1 Four states per list

**House.** Every list has four states and they are four different screens:
loading, empty because nothing exists yet, empty because nothing matches the
filter, and error. "No transactions yet" and "No transactions match this view"
are different sentences with different next actions, and collapsing them is the
most common way a list lies to somebody.

The title states the situation in the plural, the body carries the explanation,
and the button carries the imperative. `EmptyState` is used at 15 sites. The
icon is optional today (`icon?: ReactNode`, `src/client/components.tsx:767`,
rendered conditionally at `:724`) and three of the fifteen omit it; make it
required. The heading is always `<h3>`; make the level a prop, because an empty
state is not a document section under the page `<h1>`.

*Not checked mechanically.* Whether the copy actually distinguishes the two
empty states is review, and honestly so.

### 12.2 Loading

**House. The code disagreed with itself five ways; the table is what it was and
the paragraphs below are what replaced it.** Page names without line numbers,
deliberately: this records a state the code is no longer in, and a line number
into it could only ever go stale.

| Treatment | Count | Where |
| --- | --- | --- |
| `<Skeleton />` | 9 | `DuplicateReviewPage` (3), `BudgetsPage` (2), `DashboardPage` (2), `AccountDetailPage` (1), `ReportsPage` (1) |
| `<p className="settings-note">Loading X…</p>` | 8 | `AccountsPage`, `ActivityPage`, `CategoriesPage`, `RecurrencesPage`, `TemplatesPage`, `SettingsPage` (2), `ImportPage` |
| `<p>Loading X…</p>` | 6 | `App`, `TransactionBrowser`, `AccountDetailPage`, `PayeesPage`, `CategoryDetailPage`, `TemplateDetailPage` |
| Nothing at all | 1 | `StagingPage` |
| A full-screen block | 1 | `App`, session boot |

Today it is twenty-one `Skeleton` sites and four paragraphs. The twenty-first is
the budget page's forecast panel, which arrived with the story that projects
balances forward; a page that already had a skeleton for its report got one for
its projection, which is the rule doing its job rather than an exception.

The rule: **`Skeleton` for anything whose shape is known, the full-screen block
for session boot only, and retire the paragraph.** Fifteen sites moved, and the
review queue — the busiest list in the product, and the one that showed nothing
at all — got one. The docstring explaining why a skeleton preserves the layout
has been moved back above `Skeleton`, having sat above `BulkEditToggle`.

**A skeleton had to learn to speak first.** It is `aria-hidden`, because a
picture of a paragraph is not a paragraph, so swapping "Loading accounts…" for a
silent shimmer would have traded a consistency defect for an accessibility one.
`Skeleton` now takes a `label` that renders an `.sr-only` `role="status"`, and
the sentence each paragraph used to say is kept there. Pass it on the first
skeleton of a group: eight rows should announce once, not eight times.

**Four paragraphs survive on purpose.** `App.tsx` sign-in options and the three
detail pages stand in for a record that does not exist yet, so their shape is
genuinely unknown and a skeleton would be a picture of a guess. They keep the
sentence and gained `role="status"`.

*Checked by:* `tests/styles-skeleton.test.ts` covers the shimmer's containment,
not where the skeleton is used. A grep test for a loading paragraph would.

### 12.3 Busy controls

**House, settled.** `Button` couples `loading` to `disabled` and now says so:
`aria-busy` while it works and an `.sr-only` "Working…" beside the spinner
(`components.tsx:277-305`). A spinner is a picture of waiting, which is nothing
at all to somebody who cannot see it, and a disabled button otherwise goes
silent at exactly the moment a person most wants to know their click landed. See
section 4 for the reduced-motion half of the same defect.

Six submit controls are disabled on a computed predicate: forms.tsx:2307`
(`!splitSettled`), `TemplatesPage.tsx:669` (`!anyChange`), `SettingsPage.tsx:475`
(`!matches`), `PayeesPage.tsx:189` (`!selectedTarget`), CategoriesPage.tsx:105`
(`!trimmed`) and CategoriesPage.tsx:394` (`!target || sourceCategories.length
=== 0`). Only the first sits beside a sentence saying which condition is unmet,
the split remainder line at forms.tsx:756-760`. A disabled submit button always
says why, next to itself.

*Not checked mechanically.* A test asserting that a `disabled` submit has a
sibling explaining it is structural and has nothing to key on today.

### 12.4 One live region per page

**House.** A page has one polite live region, `role="status"`, for
confirmations and progress, and reaches for `role="alert"` only for something
time-sensitive that interrupts.

Announcement is already handled: `Alert` sets `role={kind === "error" ? "alert"
: "status"}` (`src/client/components.tsx:788`), so a success alert is a polite
live region and an error alert interrupts. The two real defects are elsewhere.
There are three separate `aria-live="polite"` regions in the client
(`components.tsx:229`, `TransactionBrowser.tsx:666`, `TemplatesPage.tsx:408`),
so a page can carry four polite regions at once and nothing decides which speaks
first. And a success alert persists until the next render, with no rule for how
long it stays.

*Not checked mechanically.* Counting live regions per rendered page is a test
worth writing once the count is meant to be one.

### 12.5 An error boundary

**House, settled.** `ErrorBoundary` (`src/client/error-boundary.tsx`) sits
above the app in `main.tsx`, so a render throw shows a message and a way back
instead of blanking the page. An `ApiClientError` keeps its own sentence,
because somebody wrote that one to be read; anything else gets a general
sentence, because its message is a stack-trace fragment. Both say the data is
safe, which is the first thing somebody wants to know when an accounting app
disappears.

The four leaf guards stay — `timezone.tsx` and `theme.ts` catch, `money.ts`
guards with `Number.isNaN`, `idempotency.ts` checks for `crypto.randomUUID` —
because each keeps a specific screen *useful* rather than merely non-blank. This
is the backstop for everything nobody predicted.

*Checked by:* `tests/error-boundary.test.tsx`, including that it recovers when
the throw stops and that a raw error message is never shown.

## 13. Focus and keyboard

### 13.1 The indicator

**Binding, SC 1.4.11 for the contrast; House for the composition.** The focus
indicator is two colours so that one of them always contrasts, which is GOV.UK's
reasoning for pairing yellow with a thick black border. `--focus-ring` and
`--focus-inner` already are that pair, and `--focus-ring` measures 5.08:1 light
and 9.70:1 dark against `--surface`. The reasoning is recorded here so a future
simplification to one colour reads as a regression rather than a tidy-up.

Meeting SC 2.4.13 Focus Appearance (level AAA) is cheap here, a 2px perimeter at
3:1, and meeting it does not move the target.

*Not checked mechanically.* The two ratios above are hand-computed, and the
contrast test in 17.2 item 1 is what would hold them.

### 13.2 `:focus-visible`, and what it covers

**Binding, SC 2.4.7 Focus Visible, level AA.** Every focusable thing shows a
focus indicator.

**The code covers two element types out of the set.**
`styles.css:778-783` styles `button:focus-visible` and `a:focus-visible`.
`.input:focus` at `styles.css:768-776` handles fields, on `:focus` rather than
`:focus-visible`. Not covered:

- `summary`, the `RowMenu` trigger (`components.tsx:490`), falls to the user
  agent default.
- Checkboxes and radios get only `accent-color` (`styles.css:863-866`).
- `.file-drop` has no `:focus-within` and its `<input>` is visually hidden at
  `styles.css:2191-2197`, so tabbing to the CSV file picker shows nothing at all.

One rule keyed on `:is(button, a, summary, [tabindex], input, select, textarea)`
plus `.file-drop:focus-within`, and settle whether fields use `:focus` or
`:focus-visible` rather than having it both ways.

*Not checked mechanically.* A test enumerating focusable element types against
the selector list would hold it.

### 13.3 Focus management

**House, and the largest hole in this section.**

- **A skip link.** There is none. Add one before the sidebar, targeting the
  `<main>`.
- **Route change.** `router.tsx` navigates by `pushState` and moves neither
  focus nor scroll, so following a link from the bottom of the transactions
  table lands mid-page with focus on a link that no longer exists. Move focus to
  the page heading and reset scroll on navigation.
- **After an action.** Nothing says where focus goes when a modal closes, a row
  is deleted, or a mass edit lands. The rule: back to the control that opened the
  overlay, or to the nearest surviving row's first cell when the focused row is
  gone.
- **The mobile drawer.** It is an `<aside>` toggled by an
  `.open` class (`App.tsx:645`) with a scrim button beside it (`App.tsx:716`),
  not a dialog. Opening it leaves focus on the hamburger and Tab
  walks the page behind the scrim. Either trap focus in it or make it a
  `<dialog>`.

Modals are correct as they are: a native `<dialog>` driven by `showModal()` and
`close()`, labelled by `aria-labelledby` from a `useId()`, with `onCancel`
intercepted (`components.tsx:479-529`), and with the form body mounted only while
the dialog is open so closing discards what was half-typed. `RowMenu` is also
correct: it closes on Escape and returns focus.

*Checked by:* `tests/modal-layout.test.ts` pins the dialog centring against the
global margin reset. `tests/row-menu.test.tsx` covers the menu's dismissal. The
rest is the keyboard pass.

### 13.4 Target size

**Binding, SC 2.5.8 Target Size (Minimum), level AA.** 24 by 24 CSS pixels,
subject to the spacing exception: if a 24px circle centred on each target's
bounding box does not intersect another target's circle, the target passes.

This is already solved, deliberately. `.icon-button` is 31 by 31
(`styles.css:2092-2103`) with an `::after` at `inset: -7px` giving a 45px hit
area without growing the row, and a comment saying why
(`styles.css:1821-1831`). **That is the house answer for a dense-row control.**

The spacing exception never has to be reached here. It applies only to targets
under 24 by 24 CSS pixels, and `.icon-button` is 31 by 31, so it passes on size
alone and no spacing constraint follows. The exception is what would govern if a
control ever dropped below 24px, which is the reason to know it exists.

*Not checked mechanically.*

## 13.5 The browser tier

**House.** A rule about the browser that only jsdom has ever checked is not
checked. `tests/browser/` runs the real client in Chromium against the real API
and a real database, and it exists because two defects in one story were
invisible to every other tier: a checkbox that changed nothing in either
position, because the query-string helper drops a falsy value and the markup was
perfect; and a form that offered a split combining an income leg with an expense
leg, which the server refuses with a 422, because the rule was enforced on one
side only. Both are the same shape. The markup is right and the wire is wrong,
and jsdom renders markup.

What belongs here, and only here:

- A figure on screen after a round trip through the API.
- What actually went over the wire, when a control's whole job is to change it.
- Keyboard reachability of a page, which needs real focus order.
- That a page produces no console error and no failed request.
- Anything whose failure mode is "the element is correct and the behaviour is
  not".

What does not: rules about markup, which jsdom checks faster; anything a
structural test can read out of the source; and coverage for its own sake. A
browser test costs seconds and a database, so the tier stays small and every
spec in it earns its place by naming the class of defect it catches.

*Checked by:* `npm run test:browser`, which requires `BROWSER_DATABASE_URL`
pointing at a throwaway database. It is deliberately not part of `npm run verify`:
that command runs with `TEST_DATABASE_URL` blank on purpose, and a tier needing
three processes does not belong in the fast gate.

## 14. The keyboard pass

**Binding.** `AGENTS.md`: "For UI changes, verify keyboard use and responsive
layouts." The requirement is the invariant's; this checklist is what makes it
mean something rather than an instruction to be careful.

- Everything is reachable by Tab, in DOM order, with no positive `tabindex`.
- Escape closes any overlay and returns focus to what opened it.
- Enter submits from any single-line field.
- The row menu is operable and dismissible from the keyboard alone.
- Every icon-only control has an accessible name.
- The skip link works and lands in `<main>`.
- A horizontally scrolling table can be scrolled from the keyboard.
- No control needs a mouse, including the file picker on the import page.

## 15. Responsive

**Binding for the requirement, House for the steps.** SC 1.4.10 Reflow (level
AA) asks for no two-dimensional scrolling at 320 CSS pixels wide. `html` and
`body` both set `min-width: 320px` (`styles.css:308-321`).

Three steps, described as what actually changes:

| Step | What happens |
| --- | --- |
| 1050px | Card grids drop to two columns; the import and settings two-column layouts become one; `.import-preview` stops being sticky |
| 780px | The sidebar translates off-screen and becomes a drawer with a scrim; a `.mobile-header` appears; the page header and its actions stack; the sign-in art panel is dropped |
| 560px | Every card grid drops to one column; the date bar, filter bar, search box, bulk actions and selection bar stack; buttons go full width |

Two rules that follow:

- **A table does not reflow; it scrolls.** `.data-table` keeps its 760px
  `min-width` at every step, inside a container that scrolls and is keyboard
  reachable (section 9.6). Prefer dropping non-essential columns to shrinking
  the text.
- **`dvh`, not `vh`, for anything full-height.** There are seven `100vh` uses
  and no `dvh` or `svh`. On a mobile browser with a retracting toolbar, `100vh`
  is taller than the viewport and the bottom of the page is unreachable until
  the toolbar hides.

Two more things are missing and should exist: a print stylesheet, because
Reports is a page people print, and `prefers-contrast` and `forced-colors`
handling. Neither exists today.

*Checked by:* nothing mechanical. The responsive half of `AGENTS.md`'s
definition of done is review.

## 16. Words

The voice is settled in [`common.md`](common.md) and is not repeated. What a
screen adds:

**House.** Sentence case everywhere: page titles, headings, buttons, options,
badges, empty states, alerts, table headers, navigation. An eyebrow is authored
in sentence case and uppercased by CSS, never by the string.

**House.** A button leads with a verb, in the verb-plus-noun form, with articles
dropped: "Add menu item", not "Add a menu item". Bare verbs are allowed for four
labels and only four: Done, Close, Cancel, OK. "Save" is not one of them and
takes an object. This product's verbs are already domain verbs (Commit, Stage,
Archive, Merge, Restore), so the rule mostly formalises what exists.

**House.** *Create* generates something from nothing; *add* brings in something
that already exists. This distinction matters more in a ledger than the usual
"Create order versus New order" framing does.

**House.** One word per concept, decided by the glossary in `common.md`. Staged,
draft, proposal and queue all currently describe rows in the staging table.
Bulk-action verbs drift the same way: "Mass edit" against "Edit selected",
"Delete" against "Delete selected", "Clear" against "Clear selection".

**House, and it is the strongest convention in this product.** A confirmation
names the specific thing, says exactly what happens to it, says what does **not**
happen, and says whether it can be undone. The `ConfirmDialog` descriptions are
the model:

> "£1,240.00 is posted out of "Old current account" to Opening Balances, so the
> account closes at zero and that amount stops counting toward your totals. The
> books stay balanced and its history stays readable. Restoring the account posts
> the balance back."

**House.** Error wording follows GOV.UK's construction, and the sentences are in
`common.md`'s table. An instruction for an empty field ("Enter an amount"), a
description for a malformed one ("Amount must be a number, like 24.50"), used
consistently. Banned outright: "please", "sorry", "valid", "invalid", "oops",
"forbidden", "illegal", "you forgot". The inline message and the summary entry
are the same sentence, word for word.

**House.** The `PageHeader` eyebrow names a section, never repeats the title,
and is dropped where there is nothing to say. It repeats the title on two pages
today.

*Not checked mechanically, and two halves of it could be.* A regex over
`src/client` and `src/shared` for the banned words is one grep. A check that
button labels start with an approved verb, or are one of the four bare actions,
is nearly as cheap. Whether a message names the *right* next action is review
and always will be.

## 17. What is checked, and what is not

A rule with no check is a rule that is going to rot. This is the ledger of which
is which.

### 17.1 Enforced today

| Test | What it holds |
| --- | --- |
| `tests/theme-tokens.test.ts` | Three token blocks exist, share a key set, and the two dark ones parse to the same token map; the attribute block is last; `color-scheme` per block; no literal colour outside the blocks; no undeclared or unused token; no text token used as a fill or fill token used as text; one token per series in both themes, all distinct; every `.chart-series-N` draws from its token; `.input` draws its fill and edge from `--field` and `--field-line`, `.input:disabled` exists and takes its fill from `--field-disabled`, and that fill differs from `--field` in every theme |
| `tests/table-overflow.test.ts` | Every `.data-table` sits in a scrolling wrapper; `.table-wrap` carries `overflow-x` and none of the card chrome |
| `tests/styles-skeleton.test.ts` | The shimmer animation belongs to `.skeleton` alone; every card paints its own background |
| `tests/styles-order.test.ts` | No top-level rule follows the responsive body; the four breakpoint blocks are contiguous and in descending order, and the only preference block above them is the skeleton's |
| `tests/modal-layout.test.ts` | `.modal` centres independently of the global margin reset |
| `tests/error-summary-ui.test.tsx` | A refusal's every sentence is rendered, two fields sharing one sentence stay two lines, one field refused twice shows once, the summary takes focus and retakes it on an identical repeat, its heading is an `h3` under a dialog's `h2`, and a parser's own errors leave the app's sentence standing (8.3) |
| `tests/radio-groups.test.tsx` | Every radio belongs to exactly one group; two forms on one page stay separate; the transaction type choice is one tab stop with arrow wraparound |
| `tests/new-category-kind-ui.test.tsx` | The form asks which kind a name with nothing behind it should become, stays quiet when the category exists or the picker is empty, sends the answer only when one was given, and forgets it when the direction changes |
| `tests/nav-order.test.ts` | The sidebar order, and that every item names a route the app serves, both directions |
| `tests/theme-boot.test.ts` | `public/theme-boot.js` and `applyTheme` give the same answers |
| `tests/client-money.test.ts` | The money arithmetic every figure on screen is computed from |
| `tests/row-menu.test.tsx` | The row menu's dismissal and focus return (13.3) |
| `tests/bulk-row-cap.test.ts` | The ten thousand row cap behind the selection contract (9.5) |
| `tests/recurrence-dates.test.ts`, `tests/locale-detection.test.ts` | The date and locale arithmetic every rendered date rests on (10.4) |

### 17.2 Worth building, ranked by bugs caught per hour

1. **Contrast, computed from the token values.** Every sanctioned text pair at
   4.5:1 and every border, focus and series colour at 3:1, in both themes, with
   the matrix published in sections 2 and 11. `tests/support/css.ts` already
   parses the blocks into a per-theme map, so this is a contrast function and a
   list. It is first because two tables in this guide are hand-computed
   snapshots until it exists.
2. **No spacing, radius, size or weight literal outside the scales.** The same
   trick the colour test uses, with an allow-list for `1px` borders, `0` and
   percentages. This is the largest unmanaged surface in the stylesheet: 279
   spacing declarations across 35 values.
3. **Every token name matches the grammar and its role is in the closed list.**
   Turns the hand-maintained `TEXT` and `FILL` sets at
   `tests/theme-tokens.test.ts:117-144` into something derivable.
4. **Duration and easing tokens exist and the reduced-motion block sets them**,
   so a new animation cannot forget the second block.
5. **Adjacent series contrast and bar separation**, extending the chart palette
   test past uniqueness.
6. **No `type="number"` on a field bound to a decimal-string money value.**
   Scope it, or it fails on the recurrence interval at forms.tsx:1204` and
   `:2878` and gets deleted on first contact.
7. **`eslint-plugin-jsx-a11y`.** Covers label association and accessible names
   off the shelf, more cheaply than writing either.
8. **Every form control is inside a `Field`**, once `Field` carries the full
   contract. Structural, and it is what makes the error contract enforceable by
   inspection.
9. **An `.sr-only` caption and `scope` on every `.data-table`.** Same shape as
   `tests/table-overflow.test.ts`.
10. **`scroll-padding` on every scroll container holding a sticky or fixed
    descendant.** The list is eight long and enumerable.
11. **Banned words in UI strings**, one regex over `src/client` and `src/shared`.
12. **Button labels start with an approved verb**, or are one of the four bare
    actions.
13. **No loading paragraph.** A grep, once `Skeleton` covers the sites.

### 17.3 Review, and honestly so

These cannot be tested and the guide says so rather than pretending.

- Whether an empty state's copy distinguishes "nothing yet" from "nothing
  matching" in a way a person understands.
- Whether a chart with more than a few series wants direct labels or a different
  chart.
- Whether a new component duplicates one in the inventory.
- Whether a dense form's tab order is the order a person works in.
- Whether an error message names the *right* next action.
- Whether a glossary term is used correctly, as opposed to being present.
- The keyboard pass in section 14, and the responsive pass beside it.

A rule that appears in none of these three lists is a rule nobody is responsible
for, and that is a defect in this guide rather than in the code.

## 18. Changing this guide

How a rule changes is settled in [`index.md`](index.md#changing-a-rule). What
this guide adds is the shape of the change: two stages, borrowed from GOV.UK's
contribution criteria and rescaled to one author. Propose the rule and say what
it replaces, then develop it, meaning write the code, write the check, and
migrate the existing call sites in the same change. A rule that governs new code
only is a rule that describes an intention.

Where this guide and `AGENTS.md` conflict, `AGENTS.md` wins and the conflict is
recorded rather than quietly lost. **This guide records no such conflict.** Every
binding rule here either comes from WCAG 2.2 or follows from an `AGENTS.md`
invariant, and the money-field ban in section 8.5 is the invariant reaching a
screen rather than an argument with it.

What it does record is four places where published guidance and this product
disagree, each labelled Contested and each naming the position it did not take:
green and red in a ledger (2.4), the dense transaction form against one question
per page (8.7), a table rather than a grid (9.1), and ten series colours rather
than six (11.2). Section 10.2 records a fifth departure, from GOV.UK's prose rule
about trailing zeros, which is a reversal rather than a disagreement: the rule is
right for a sentence and wrong for a column.
