# Web

The browser app. A React 19 single-page app with a hand-rolled router, TanStack
Query for server state, and 3,973 lines of hand-written CSS in
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
value does not qualify: the eight inline `style` props in the client
(`charts.tsx:273`, `charts.tsx:322`, `components.tsx:501`, `components.tsx:938`,
`BudgetsPage.tsx:1177`, `DashboardPage.tsx:292`, `DashboardPage.tsx:400`,
`DashboardPage.tsx:445`) are all runtime geometry — a bar's width, a chart's offset — and are correct as they
are. The count matters beyond tidiness: it is what
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
other theme. Second, `--ambient`, `--art-glow-a`, `--art-glow-b`, `--art-veil`, `--chrome`
and `--scrim` carry no property segment and cannot be read from their names
alone. They are exempted here by name rather than left as a hole in the list —
and `--art-glow-b` had been silently missing from that list, which is the exact
failure a by-name exemption exists to prevent.

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

`::selection` is the twelfth pair and it is the one that was failing. Selected
text is author-styled here deliberately, so SC 1.4.3 applies to it; it was
`--ink` on `--green-line-strong`, which is 4.59:1 in light and **2.59:1 in
dark**. It now takes the fill-and-on-accent pair the primary button already uses
(`styles.css:302-308`) rather than making a third decision, so it is the last
row of the table above rather than a row of its own.

*Checked by:* `tests/contrast.test.ts`, which derives the pairs rather than
listing them: every rule in the stylesheet that sets both a `color` and a
`background` is resolved through both palettes and measured, at 4.5:1 or 3:1
according to the font size the rule declares. That distinction matters, because
this table was written by hand and all eleven rows above reproduce exactly — an
enumerated check would have caught nothing, and the one real failure it found
was a pair nobody had thought to enumerate. One sanctioned exception,
`.auth-ledger-card`, whose translucent wash composites over a gradient rather
than over the token underneath and reads as 1.00:1 to a two-colour test.

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
| `--green-fill` on `--track` | 5.42 | 3.73 |

**Settled.** The reasoning is written out twice in the file, at
`styles.css:867-876` for `.input` and at `styles.css:3358-3362` for
`.chart-zero`, and it had been applied to two of the eighteen
`border: 1px solid var(--line…)` rules. Six control edges have now joined them —
`.pagination-step`, `.sort-direction`, `.bulk-edit-field`, `.transaction-type`,
`.commit-choice label` and `.report-tab` — along with `.button-secondary`
(`styles.css:643`) and `.file-drop` (`styles.css:2405`), both of which rested on
the failing token and reached the compliant one only on hover. Both now hold it
at rest, as `.input` already did; their hover states also shift `background`, so
the hover affordance survives the change.

The `--line` rules that remain are card outlines, which is what that token is
for.

*Checked by:* `tests/contrast.test.ts` holds the six non-text pairs above 3:1 in
both themes, against the palette rather than against the last person to
recompute them. The control-edge *selectors* are still read by a person: which
borders are a control and which are a card outline is a judgement, and a test
enumerating them would be a list of the answer rather than a check on it.

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

Today: 289 padding, margin and gap declarations across **35 distinct pixel
values**, running 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
19, 20, 21, 22, 24, 26, 28, 30, 32, 34, 35, 38, 42, 48, 55, 72, 248. `gap` alone
takes 17 distinct single values, the commonest being 8px seventeen times, 10px
and 12px twelve each, and 6px and 7px eight each. Nine, eleven, thirteen and
seventeen pixels are not decisions.

Proposed ramp, nine steps, Carbon-shaped rather than GOV.UK-shaped because a
dense table cell needs 2px and a page shell needs 48px:

```css
--space-1: 2px;   --space-2: 4px;   --space-3: 6px;
--space-4: 8px;   --space-5: 12px;  --space-6: 16px;
--space-7: 24px;  --space-8: 32px;  --space-9: 48px;
```

**The migration is not free and the guide should say so.** 11px maps to 12,
10px to 8 or 12, 14px to 12 or 16. Around 290 declarations move and the app
will look slightly different when they do. That is the price of a scale, and it
is paid once.

**One decision has been taken out of the pile ahead of the ramp**, because it
was not a scale problem: the distance between two sections of a page. That was
eight different numbers expressing one intent, and it is now one gap on one
container. Section 7.4 has it. It uses the literal `24px` rather than
`--space-7`, and the reason is worth recording so nobody "finishes the job" and
finds out the hard way: `tests/theme-tokens.test.ts` requires every token to be
declared in all three colour blocks and to be used somewhere, so the ramp cannot
arrive as nine tokens in `:root` — it needs the token blocks split into colour
and non-colour first. **That split is the first step of the ramp, not a detail
of it.**

### 3.2 Radius

Today: 61 declarations across **19 distinct values**. No two cards match:
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

Today: 113 `font-size` declarations across nine pixel values (11, 12, 13, 14,
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
`clamp(28px, 3.2vw, 40px)` on `.page-header h1` (`styles.css:575`), which is the
`<h1>` of every page, and `clamp(35px, 4vw, 52px)` on the sign-in shell
(`styles.css:2811`). The page title is deliberately outside the productive ramp
because it is the one size that answers to the viewport rather than to the
scale. Naming both is what stops a display size leaking into a page of
accounts.

### 3.4 Weight

Today: **30 `font-weight` declarations carrying 14 distinct values**: 400, 500,
570, 600, 620, 630, 650, 660, 700, 720, 730, 750, 760, 780. That is very nearly
a weight per component.

Four steps, and no others: 400, 500, 600, 700. The strongest argument for this
is not taste. Inter is named first in the stack (`styles.css:95-97`) and never
loaded (section 5), and `font-synthesis: none` is set at `styles.css:100`, so
the fourteen numeric weights already collapse to whatever the fallback system
font ships. Most of the fourteen are indistinguishable on screen today.

### 3.5 Z-index

Nine declarations and no ordering document, and one of the two shared values was
a real collision: `.merge-panel` and `.nav-scrim` were both 20, both can be on
screen below 780px, and the scrim is written second — so it painted over the
merge panel with nothing in either rule saying why.

The scrim moved to 25 and the ladder is now written out once, above `.sidebar`
(`styles.css:348-358`), which is what a z-index chosen alone is chosen against:

| Value | What sits there |
| --- | --- |
| 1 | A decoration inside a card — a search icon, the sign-in art |
| 2 | A header sticking inside its own scroller — the modal header, the sign-in card |
| 10 | A popover over the page — the row menu |
| 20 | A bar sticking over a list — the merge panel |
| 25 | The mobile nav scrim, which covers everything above except the drawer |
| 30 | The sidebar itself |

Tokens for these would read better and are held back for the same reason the
other scales are (section 3.1): `tests/theme-tokens.test.ts` fails on a declared
token nothing uses, so a ladder introduced ahead of its users cannot be
committed. The comment carries the ordering in the meantime.

The modal is out of this scale on purpose: it is a native `<dialog>` opened with
`showModal()`, so the browser's top layer puts it above everything without a
z-index.

*Checked by:* `tests/styles-order.test.ts`, which refuses two selectors sharing
one value unless they can never be on screen together — the sign-in surface is
rendered instead of the app shell rather than over it, so a layer there and a
layer in the app are free to coincide, and that is the one exception it carries.

### 3.6 Breakpoints

Four hardcoded max-widths, all four now contiguous at the foot of the
stylesheet in descending order: 1050px (`styles.css:3733`), 980px
(`styles.css:3757`), 780px (`styles.css:3764`) and 560px (`styles.css:3843`).
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
`visibility`, `styles.css:3662-3664`), and there are two reduced-motion
blocks: `styles.css:681-685`, which turns off the skeleton shimmer specifically
and stays beside `.skeleton` on purpose rather than joining the responsive body
(section 7.3), and `styles.css:3853-3862`, a blanket rule setting
`animation-duration`, `transition-duration` and `scroll-behavior` on
everything.

**The blanket rule had a defect, and it was user-visible.** It also sets
`animation-iteration-count: 1 !important`, which froze the button's
`.animate-spin` loader (`src/client/components.tsx:324`) into a static icon:
somebody who asked for reduced motion got no busy indicator at all. `.skeleton`
was exempted by hand and the spinner was not, and nothing said which of the two
was the oversight. A slow rotation is acceptable under `reduce`, which asks for
minimised non-essential motion; no indicator is not.

The spinner now swaps its rotation for an opacity pulse rather than stopping
(`styles.css:738-745`), which carries the same meaning with no motion across the
screen — the thing the preference is actually about.

*Checked by:* `tests/styles-skeleton.test.ts`, twice. The shimmer animation
belongs to `.skeleton` and to no other selector, and every card paints its own
background so nothing underneath reads as the card moving. And every selector
whose `animation` shorthand says `infinite` is named inside the reduced-motion
block, which is the only way a blanket `!important` can be answered — so a third
endless animation added later has to say what it does under the preference
rather than inheriting a freeze nobody chose. `tests/styles-order.test.ts` holds
the two names the block contains.

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

**House.** `src/client/components.tsx` is the component library: twenty-two
components, three helpers (`compareForSort`, `useConfirm`, `progressLabel`) and
two exported types.
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
| `ProgressBar`, `progressLabel` | How far a long write has got, and the sentence beside it (12.6) |
| `RequiredNote` | The one sentence a form says about required fields (8.4) |
| `ErrorSummary` | The submit-time error list focus lands on (8.3) |

Two members of the library live in `src/client/forms.tsx` rather than here:
`PayeeInput` and `CategoryPicker`. Both are exported, both are used off their
home file (the review queue's inline cells render them), and both carry a
component-level API (`ariaLabel`, `autoFocus`, and commit/cancel callbacks for
inline use). They stay in `forms.tsx` because each wraps a domain decision —
what counts as the same payee, how a half-typed category resolves — that the
form logic beside them owns. The point of listing them is 6.2's duplicate
check: a control absent from the inventory is a control the check cannot fire
for, which is how `TransactionForm` carried a byte-for-byte copy of
`PayeeInput` for a release.

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

- **A search box.** Six call sites, one markup now: an icon and an `aria-label`
  at every one. Two of them — Templates and Recurring — used an `.sr-only` span
  and no icon, which left the 34px gutter `.search-box .input` reserves
  unconditionally standing empty. That is fixed; what is left is that six sites
  repeat the same three elements, which is what makes it a component.
- **A bulk-action bar.** Three toolbars, three label sets, three variant
  assignments. Fix the vocabulary at "Edit selected", "Delete selected", "Clear
  selection", "Select all N matching".
- **A blank-cell placeholder.** An em dash on seventeen sites and an italic muted
  word on others. The em-dash and italic-word distinction is real and worth
  keeping, so what remains here is the repetition rather than a defect. Two
  defects that were in this bullet are fixed: one of the seventeen wrote the dash
  as literal cell text rather than as a fallback, so a staged row on the
  transactions list read as having no category while the review queue showed the
  one it had; and `Uncategorized` was `.subtle` on one page and bare on another,
  which is one state rendered two ways on two screens a person moves between.
  Both are held by `tests/ui-copy.test.ts`. The word stays plain inside the two
  inline-edit cells, where it is a button's own label and takes the button's
  colour, and the test says so rather than skipping them.

*Not checked mechanically.* Whether something has crossed the threshold is
judgement; that a repeated markup has one owner is what a component test would
catch once the component exists.

### 6.3 Class naming

**House.** A class is component-scoped and named for the component:
`.account-card-main`, not `.card2`. A page-scoped name is not used off its page.

**The code disagreed, in two places.** `.settings-note` appeared **26 times
across 8 files** — `App.tsx`, `forms.tsx` and six pages, none of them Settings.
It was the generic muted paragraph, named after the page it was born on. This
guide offered two ways out and the second is taken: it is a `Note` component
now, which also puts it in 6.1's inventory, where the duplicate check has
something to fire against next time somebody writes a muted `<p>` by hand.
`.settings-section` was the same debt one size up — `display: grid; gap: 20px`,
used on Categories as well — and is `.panel-stack`, named for what it does.

The four utilities that are legitimate and should stay utilities: `.align-right`,
`.nowrap`, `.subtle`, `.sr-only`.

*Checked by:* `tests/page-stack.test.ts`, which derives each page's prefix from
its own filename — **both spellings**, because `AccountsPage` names its classes
singular and `SettingsPage` names its plural, and deriving only one is how a
`.settings-` class dropped on the dashboard escaped the first version of this
check. A prefixed class used off its page is either a defect or a component that
happens to share a page's word, and **no pattern tells those apart**:
`.settings-note` was used on its own page too. So the test carries a register of
the twenty-one that are components, one line of reason each, and its value is
that a *new* off-page use has to be classified — which is the reading
`.settings-note` never got in 26 uses. A register entry whose class no longer
exists fails as well, so the register cannot drift the way the class did.

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
scrolling wrapper within eight lines above it, and that `.table-wrap` declares
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
why. `.report-tabs` and the chart grid appear in no breakpoint block, and
neither is a gap. `.report-tabs` carries `flex-wrap: wrap`
(`styles.css:3198-3202`), which reflows at every width rather than at three
chosen ones and is the better answer; and `.chart-grid` is an SVG stroke with no
layout to change. This sentence used to call both a gap "somebody can fill",
which is how a list of work comes to include work nobody should do — the
absence of a breakpoint is only a defect where something needs one.

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

### 7.4 The page stack

**House, and it was the largest unstated rule in this guide.** A page is a
single column of sections, and **the distance between two of them is decided by
the container, not by either section.** `.content` is `display: flex;
flex-direction: column; gap: 24px`, and no block that sits at page level carries
a vertical margin of its own.

It used to be the other way round, and the result is worth recording because
three separate complaints turned out to be one absence. Every gap was a margin
on whichever block happened to be there: `.page-header` 26px, `.date-bar`,
`.filter-bar` and `.toolbar` 20, `.account-type-section` 28, `.category-toolbar`
20 and 12, `.report-tabs` 16, `.settings-grid` 14 — eight numbers for one
decision. And the five blocks that most often sit at page level carried none at
all: `.panel`, `.table-card`, `.alert`, `.empty-state` and
`.category-page-list`. So four stacked panels on the budgets page touched at
**0px**, the categories page ran four different gaps in one screen, and a block
moved to a new page brought a spacing opinion with it that nobody could see in
the markup.

**Flex rather than grid, and it is load-bearing rather than taste.**
`.merge-panel` (`styles.css:2733`) is `position: sticky` and sits at page level
on Categories and Payees. A sticky *grid item* is bounded by its own grid area,
which in a single-column grid is its own height, so it would stop following the
list with nothing on screen to say why. A sticky *flex item* is bounded by the
container, which is what it does today.

**24px, and not a new number.** It is the gap between a page's title block and
its actions (`.page-heading`), it sits in the middle of the 20/26/28 cluster it
replaces, and it is `--space-7` on the ramp section 3.1 proposes, so it survives
that ramp landing.
Section 3.1 stays a proposal — see the note there for why the ramp cannot be
tokens yet.

*Checked by:* `tests/page-stack.test.ts`, which asserts that `.content` carries
the flex column and the gap, that it is not a grid and that `.merge-panel` is
still sticky, that no page-level block declares a non-zero vertical margin, and
that nothing positions itself with a negative one.

### 7.5 Where a page's actions live

**House.** A page's primary actions go through `PageHeader`'s `actions` prop and
nowhere else, and they sit in the **title row** — beside the `h1`, above the
description — so their position does not depend on how long the description is.

Two failures, both of which shipped:

- **Transactions had no `actions` at all.** Its two buttons were a body element
  dragged up into the header band by `margin: -48px 0 18px`, with a second
  hand-tuned `margin-top: -42px` for the four detail pages that embed the same
  browser (`styles.css`, both rules now deleted). A negative margin is a guess
  at one particular header height, and it stopped being true the moment a
  description changed. The buttons could not simply move, because the export
  link's href is built from filter state the browser owns — so the *heading*
  moved down into `TransactionBrowser` instead, as a `heading` prop that says
  whether this is a page or a section.
- **The header bottom-aligned its actions against the whole text block.** With a
  one-line description the button landed in one place and with a two-line
  description a line lower, which is the entire difference between Templates and
  Recurring. `.page-header` is now two rows — `.page-heading` holding the
  eyebrow, `h1` and actions, then the description beneath — so the actions are
  bottom-aligned to the heading and the description cannot move them.

*Checked by:* `tests/page-stack.test.ts` for the absence of the hoist.
*Not checked:* that a page with actions puts them in `PageHeader` rather than in
its body. That is a JSX-shape assertion and would want a parser; the negative
margin was the symptom worth catching, and it is caught.

### 7.6 The filter bar

**House.** A filter bar holds **bare controls with an `aria-label`**, never a
control wrapped in `Field`.

A filter is not a form field. It takes effect on change, has no error state, no
required state, no submit, and never appears in an error summary. `Field` stacks
a visible label above its control, which made the one filter that used it —
Templates' Type select — twenty pixels taller than the search box beside it, and
`align-items: center` rendered that as two boxes at two different heights. Every
other filter in the app was already bare.

This is the one place where this guide and
[`code/client.md`](code/client.md#31-field-wraps-every-labelled-control-in-a-form)
disagreed, and the disagreement is recorded rather than resolved by silence:
that rule says "`Field` wraps every labelled control", and it has been amended
to carve out the filter bar rather than left to be rediscovered by the next
person who adds a filter.

A search box carries its magnifying-glass icon. `.search-box .input` reserves
34px of left padding unconditionally, so a search box without the icon renders
an empty gutter — which is what Templates and Recurring both did.

*Checked by:* `tests/page-stack.test.ts` asserts that no `.filter-bar`,
`.toolbar` or `.category-toolbar` contains a `<Field`. *Not checked:* that every
bare control carries an `aria-label`; that is section 17.2 item 7's job, and
`eslint-plugin-jsx-a11y` would cover it off the shelf.

## 8. Forms

### 8.1 The Field contract

**Binding, WCAG 2.2 SC 1.3.1 Info and Relationships and SC 4.1.2 Name, Role,
Value, both level A. The largest single piece of work in this guide.** A label
that is not programmatically associated, a hint the control does not point at,
and a composite control with no accessible name are failures of those two
criteria rather than preferences.

`Field` was wrong in three specific ways rather than absent, and all three were
the same omission from different angles: the label, the hint and the error were
on screen and none of them was connected to the control.

1. **Implicit association by wrapping.** W3C's forms tutorial asks for explicit
   `for`/`id`, where the `for` exactly matches the control's `id`. There was
   exactly one `htmlFor` in the whole client.
2. **The hint rendered after the control, with no `id` and no
   `aria-describedby`.** GOV.UK's order is label, hint, error, then the input,
   all wired by `aria-describedby`.
3. **There was no error slot.** Zero `aria-invalid`, zero `aria-errormessage`,
   and no per-field error markup anywhere in `src/client`.

All three are closed. `Field` takes a `useId`, names its control explicitly,
takes an `error` prop, and composes `aria-describedby` from the hint id and the
error id. Three things about how, each of which was a way to get it wrong:

- **The wiring travels by context, not by cloning the child.** `Field` is used
  at 96 sites and its children are arbitrary JSX — an `<Input>`, a `<Select>`, a
  `CategoryPicker` that renders one three levels down — so `cloneElement` would
  have reached the first case and silently missed the rest. `Input`, `Select` and
  `Textarea` read the context, which reaches all of them, changes nothing at the
  call sites, and lets a prop the caller passed win: the queue's inline cells
  label themselves and must keep doing so.
- **The hint and the error sit outside the `<label>`.** This is not tidiness. A
  name computed from `<label for>` is the label element's *entire* text content,
  so a hint inside the label becomes part of the control's **name** — "Amount Up
  to eighteen decimal places" — rather than its description. The old markup got
  away with it only because the hint was not associated at all. The field's
  wrapper is a `<div>` and the `<label>` holds the label. The cost is that
  clicking the field's whitespace no longer focuses the control; clicking the
  label still does, which is what GOV.UK ships.
- **A wrong field says so in three places that agree**: the sentence,
  `aria-invalid` on the control, and `aria-describedby` naming the sentence. The
  sentence is red text on the page's own background rather than a tinted box,
  because a box here would stack with `ErrorSummary`'s at the top of the same
  form and two boxes saying one thing read as two problems.

**House, the ordering.** The hint goes above the control, following GOV.UK's
label, hint, error, input order. Nothing in WCAG decides where a hint sits; what
is Binding is that the control points at it.

**Second defect, from the same component, and also closed.** A wrapping
`<label>` is correct around one control and wrong around a composite.
`<Field label="Category">` wraps `CategoryLegs` at three sites, which renders up
to fifty rows of three inputs; the label bound to the first leg's
`CategoryPicker`, so legs two onward had no accessible name at all while the
amount and note inputs in the same rows did — which is what made it look
deliberate. `CategoryPicker` had taken an `ariaLabel` prop since the review
queue's inline cells needed one, and `CategoryLegs` passed none, so the defect
stood with the fix sitting unused beside it.

`Field` now takes `as="group"`, rendering `<div role="group" aria-labelledby>`,
and the three call sites use it. A group names the composite and hands out no
control id, because there is no one control to point at — so **every** picker
inside has to name itself, including the single one in the unsplit shape. That
was the trap: making the field a group without naming that picker moved the
defect from legs two-and-up to the only leg there is.

*Checked by:* `tests/field-contract.test.tsx`, which renders a field and reads
back the association, the hint, the error and the group, and holds the last
thing this section said was not yet possible: **every `<input>`, `<select>` and
`<textarea>` in `src/client` goes through the three shared components**, so
every one of them is reachable by a `Field`. Two categories are excluded with
their reasons — a checkbox or a radio is named by the `<label>` it sits in or by
the `radiogroup` around it, and the CSV drop zone is named by name, being a
hidden `type="file"` inside a wrapping label whose text is the whole affordance
(13.2).

### 8.2 When errors appear

**House, following GOV.UK.** Errors appear on submit, not on blur and not as
you type. As-you-type validation causes problems for people who type slowly, and
validating on blur punishes moving away from a field.

**The exception is arithmetic.** A split's remainder telling you what is left is
feedback, not validation, and it updates live. `moneyRemainder` is arithmetic;
it says how much is unallocated, never that you are wrong.

**The second exception is a click-to-edit cell, whose submit *is* blur.** The
review queue's inline editors (8.10) have no submit button: leaving the cell is
the commit gesture, so a server refusal surfaces after blur by construction.
That is still errors-on-submit — the timing rule this section states is about
not judging a field while somebody is typing in it, and the inline cells judge
nothing until the edit is handed over.

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
field. The blocker this note used to give — that `Field` gives its control no
`id` — is gone: section 8.1 landed and every field hands its control one. What
is left is the wiring, and it is the harder half. `errorMessages` returns
sentences, having used each issue's `path` to deduplicate and then dropped it,
so the summary no longer knows which field a line is about; and a `useId` is
opaque, so knowing the path would not give the id either. Anchors need a path
kept beside each message and a registry a `Field` puts its (name, id) into, per
form rather than per page — two forms open at once, a modal over the list
behind it, both have a `payee`. Shipping links before that would mean anchors
pointing nowhere or at the wrong form, which is worse than plain text.

**Still to do: the other eleven forms.** The auth forms (`src/client/App.tsx`)
stack a client-side string and a mutation error as two separate red boxes, which
is the case this section exists for. Section 8.1's `error` prop has since landed,
so the blocker is gone and what remains is deciding, per form, which of the two
boxes is the field's and which is the summary's. The bulk forms in `TransactionBrowser.tsx`,
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
a bug in the form, and nothing finds them. Most of the 29 unmarked fields are
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
fail on correct code: `src/client/forms.tsx:1294` and `:3014` both use it for
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

`TransactionTypeChoice` (`src/client/forms.tsx:493`, the group markup at
`:538`) is the reference
implementation: a real radio group with roving tabindex and arrow, Home and End
handling that wraps at both ends when a type is mandatory, `aria-pressed`
toggles when "no type" is a real answer, and a discriminated union prop pair so
only the `allowNone` shape can report an empty selection.

*Checked by:* `tests/radio-groups.test.tsx` walks every radio on every form,
asserts each belongs to exactly one group, asserts two forms on one page stay in
separate groups, and covers the roving tabindex and the wraparound.

### 8.9 Comboboxes

**House, settled.** An input offering a `<datalist>` declares no widget ARIA of
its own: `src/client/forms.tsx:339`, `:630` and `src/client/bulk-edit.tsx:96`
carry `list`, plus an `aria-label` where no visible `<label>` wraps them — a
name, which every control owes, not a role. All three used to add
`role="combobox"`, `aria-autocomplete="list"` and
`aria-controls`, which was wrong twice over. A `<datalist>` is not a listbox, so
the declaration promised a widget that was not there and left out the
`aria-expanded` an explicit combobox is required to carry. And it was redundant:
HTML-AAM already maps an `<input>` with a `list` attribute to the combobox role,
which is why removing all three left every selector that finds them by that role
still passing, in `tests/browser/budgets.spec.ts` against a real browser.

The rule is therefore the plain one: let the native control carry its own
semantics, and add ARIA only where there is no native element to lean on.

`TransactionForm` used to re-implement the payee combobox byte for byte, which
is exactly what `PayeeInput`'s docstring exists to prevent — a second copy is a
second answer to "what counts as the same payee". The copy is retired
(`forms.tsx:2188-2191` now renders the component under a comment saying so),
and 6.1's inventory listing `PayeeInput` is what gives the duplicate check a
row to fire against next time.

*Checked by:* `npm run lint`. `jsx-a11y/role-has-required-aria-props` is denied,
and it was what found these three; re-adding the role without `aria-expanded`
fails the build. Note that jsdom does **not** compute the implicit role, so a
jsdom test looking for `getByRole("combobox")` on one of these fails while the
same query passes in a browser — which is why the browser tier owns that check.

### 8.10 Click-to-edit cells

**House, shipped in the review queue and owned here rather than by the code
comments that first specified it.** The queue is where imports get repaired,
and repairing a date or a payee through the full modal is four clicks for a
one-word change, so a row's date, payee, category and amount cells open an
editor in place (`src/client/pages/StagingPage.tsx:520-530`). The pattern has
six rules, and each exists because the obvious alternative shipped a bug or an
inconsistency during review:

1. **The editors are the modal's own components, never copies.** The cells
   render `PayeeInput` and `CategoryPicker` through the `onCommit`/`onCancel`
   API added for exactly this (`src/client/forms.tsx:312-318`), and the write
   is the same PUT the modal sends — the whole draft plus the expected
   version — so everything the server enforces about a draft is enforced here
   identically, and a concurrent edit is refused rather than overwritten.
2. **A field whose answer lives elsewhere offers no editor rather than a lying
   one.** A split's category and amount live on its legs, and a transfer has no
   category by design; those cells stay read-only and the modal stays the one
   honest editor for them.
3. **Blur commits; Escape cancels; Enter commits only where a keydown cannot
   race a pick.** The date and amount take Enter as commit. The payee and
   category editors are datalist-backed, and picking from a datalist lands on
   Enter too — committing on the keydown raced the picked value and created a
   category named by the half-typed prefix — so there blur is the only commit
   gesture (`StagingPage.tsx:1063-1067`). This is the second exception 8.2
   records: a cell with no submit button makes blur the submit.
4. **Emptying a date or an amount reads as abandoning the edit, not as a
   request to erase the field** (`StagingPage.tsx:616-620`). The modal is where
   a deliberate clear belongs, beside everything else the emptiness affects.
5. **A same-value blur writes nothing** (`StagingPage.tsx:643-646`): no version
   bump, no invalidated bulk-selection fingerprint, no audit entry saying an
   edit happened.
6. **The trigger's accessible name leads with its visible text** — `30 Jul
   2026 — edit the date of Corner shop` — because SC 2.5.3 Label in Name wants
   what a voice user reads aloud to be how the control is addressed, and the
   visible text of these triggers is the value itself.

Closing an editor puts focus back on the trigger it replaced
(`StagingPage.tsx:543-550`); commit, refusal and Escape all remove the focused
element, and without the handoff a keyboard user lands on `<body>`. Event-order
guards around commit and cancel are refs, not state, for the reason
`code/client.md` §1.3 records: the blur that follows Enter or Escape runs
before the render that would update state.

*Checked by:* `tests/staged-inline-edit-ui.test.tsx` — the whole-draft PUT, the
Escape and empty-value cancels, the same-value silence, the categoryKind drop,
and the editors a split does not get.

### 8.11 What never travels on a copy

**House.** Cloning a transaction prefills the staging form from the source, and
three fields are scrubbed rather than carried
(`src/client/forms.tsx:1507-1534`): leg ids, so the copy grows its own legs
rather than claiming the source's; `externalId`, because it is a bank file's
identity for one real row, and a copy carrying it would be swallowed by the
duplicate check as already-imported; and `templateId`, because provenance
belongs to the source, not the copy. The test of membership is the same for any
future field: identity and provenance never travel, values always do.

The same reasoning holds one level down in the queue's inline category editor,
which drops a stored `categoryKind` when the category is re-chosen
(`StagingPage.tsx:656-660`): the stored kind was somebody's answer about the
old name, and riding along it would file a brand-new category on a side nobody
chose.

*Checked by:* `tests/client-regressions.test.tsx` (the clone lands on the queue
minus the scrubbed fields) and `tests/staged-inline-edit-ui.test.tsx` (the
categoryKind drop).

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
(`src/client/components.tsx:613-616`). A transactions row carries a checkbox
and a row menu; a review-queue row now carries up to ten stops — the checkbox,
four click-to-edit triggers (8.10), sometimes a duplicate link, three icon
buttons and the menu — so the tab-sequence cost the APG worries about is real
here and grew with the inline cells. The decision holds anyway: every stop is a
control somebody came to press, and Tab past a row is still one keystroke per
control rather than a second navigation model to learn. Recording that the APG
leans the other way is what makes this read as a decision.

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
(`src/client/components.tsx:52-99`) now emits `scope="col"` alongside its
`aria-sort`, which was the fix worth making because that one change covers every
sortable column in the product.

**Settled.** The identifying cell in those four was a `<td><strong>`, so a row
was announced without the thing that names it. All four now use
`<th scope="row">`. It could not be a shared fix: which cell is a table's subject
is a decision per table — the payee on a register, the name on a template.
`.data-table th` had to be split at the same time, because a rule written for
column headers rendered thirteen row names in uppercase muted 11px on a header
fill the moment they became `th`.

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
figures, through `.data-table :is(th, td).align-right` at `styles.css:792-803`.

**The sentence above was not true of the CSS, and now is.** The selector was
`.data-table td.align-right`, so a `<th className="align-right">` — Reports and
Budgets both have them — got the alignment and not the figures: a header row of
period totals that failed to line up with the identical column beneath it. It is
`:is(th, td)` now, which also covers a `th[scope="row"]` holding a date.

Two loose ends remain. `.amount` is declared as a money hook in the same rule
and is used by nothing; delete it or adopt it at the 69 `formatMoney` call
sites, some of which render currency outside a table in proportional digits. And
`.money`'s weight and `white-space: nowrap` reach three files rather than the
transaction register alone — `BudgetsPage.tsx` seventeen times,
`ImportPage.tsx:657` and `TransactionBrowser.tsx:1096` — so folding them into
`.data-table :is(th, td).align-right` is still the right cleanup, but the
argument for it is consistency rather than a rule that only fires on one page.

*Checked by:* `tests/page-stack.test.ts`, which holds the three to one rule.

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
(`src/client/components.tsx:182-197`) takes an `indeterminate` prop and writes it
onto the DOM node in an effect, because React does not expose it, and all three
select-all checkboxes pass it: `TransactionBrowser.tsx:795`,
`TemplatesPage.tsx:474`, `StagingPage.tsx:899`.

*Checked by:* `tests/bulk-row-cap.test.ts` and the server-side selection tests
cover the contract. The two sentences are review.

### 9.6 Overflow

**Binding, WCAG 2.2 SC 2.1.1 Keyboard, level A.** A horizontally scrolling
container must be reachable by keyboard. `.data-table` carries `min-width:
760px` and always sits in a container that scrolls, so on a narrow panel it
always scrolls. **Every `.table-card`, `.table-wrap` and `.preview-table-wrap`
carries `tabIndex={0}`, `role="region"` and an accessible name.**

The third class is named because leaving it out is what the defect was. The rule
is about a container that scrolls, and this section used to enumerate two class
names as though they were the same thing — so the import preview, which scrolls
harder than anything else here (six columns of arbitrary CSV headers inside a
300px aside), was the one scrolling container in the client a keyboard could not
reach. Nothing was wrong with the rule; the check and the sentence had both been
written against the classes that existed the day they were written. The pairing is good practice; the
`tabindex` is the rule, and a focusable region with no name is an unlabelled tab
stop, which is why the two travel together. The name repeats the table's
`.sr-only` caption, so the two cannot describe different tables.

`jsx-a11y/no-noninteractive-tabindex` refuses this by default — its `roles`
option lists `tabpanel` alone — so it is narrowed to accept `region` rather than
turned off. [`code/index.md`](code/index.md) records that beside the rules that
are off.

**House.** Prefer priority columns to whole-table horizontal scroll. On a
transaction list the essential three are date, payee and amount; account,
category and status may drop or move to a second line below a breakpoint.

*Checked by:* `tests/table-overflow.test.ts` covers the wrapper.
`tests/page-stack.test.ts` covers the `tabindex`: all fourteen scrolling
containers in `src/client` carry one, with a role and a name. It asserts the
count as well as the absence of offenders, so widening the pattern is a decision
somebody makes rather than something that slips in — and so a pattern that
matches nothing fails instead of passing quietly.

### 9.7 Sticky regions

**Binding, WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum), level AA.** A
focused component must not be entirely hidden by author content. The named
hazards are sticky footers, sticky headers and non-modal dialogs, and the
sufficient technique is CSS `scroll-padding`.

There were **no `scroll-padding` or `scroll-margin` declarations anywhere in
`styles.css`**, against eight sticky or fixed regions:

| Selector | Line | Position |
| --- | --- | --- |
| `.sidebar` | `styles.css:359` | fixed |
| `.row-menu-popover` | `styles.css:1685` | fixed |
| `.modal` | `styles.css:2267` | fixed |
| `.modal-header` | `styles.css:2300` | sticky |
| `.import-preview` | `styles.css:2444` | sticky |
| `.merge-panel` | `styles.css:2733` | sticky |
| `.nav-scrim` | `styles.css:3785` | fixed |
| `.mobile-header` | `styles.css:3795` | sticky |

`.merge-panel` was the live case. It exists because the list is long enough to
scroll, which is the same condition that puts a focused row underneath it. Every
scroll container holding a sticky element sets `scroll-padding-top` (or
`-bottom`) to at least that element's height.

There are two scroll containers, so there are two declarations: `html` carries
`scroll-padding-top: 80px` (`styles.css:321`), which clears the mobile header
and the merge panel alike, and `.modal-card` carries 64px
(`styles.css:2269`) for the sticky `.modal-header` inside it. The other six
regions are inside one of those two or are the container itself.

*Checked by:* `tests/page-stack.test.ts`, which pairs each sticky or fixed
selector with the container that must carry the padding, so a ninth sticky
region added with no container named is a failure rather than a row that
scrolls under something.

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
| `DashboardPage`, `AccountsPage`, `ReportsPage`, `AccountDetailPage` | `money-negative` on the value, with Intl's own minus sign. Still the rule for a computed total, which has a sign of its own |
| `TransactionBrowser` | Coloured and signed by transaction *type*, with a hand-prefixed `+` or `−` |
| `StagingPage`, `TemplatesPage`, `RecurrencesPage` | No colour and no sign |

Page names without line numbers, for 12.2's reason: the table records a state
the code is no longer in — the queue's amount cell now colours and signs
through `movementSign` like the rest — and a line number into it could only
ever go stale.

One rule, and it is **direction** rather than the value's own sign: a stored
amount is always positive, because `AGENTS.md` keeps direction in the type. So a
deposit reads `+` in green, a withdrawal `−` in red, and a transfer is signed
but uncoloured — money moving between somebody's own accounts is not spending.

`movementSign` (`src/client/money.ts`) is that rule, and five lists share it —
the register, the review queue, the templates, the recurrences and the import
preview.
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

**Settled, with two named exceptions.** Calendar dates go through `formatDate`,
including the two "As of" lines that printed raw ISO directly above formatted
tables (`DashboardPage.tsx:183` and `ReportsPage.tsx:257` were the offenders).
Instants go through `formatTimestamp(instant, timezone)`
(`src/client/money.ts:333-348`), whose zone comes from `useTimezone()`: the
activity log (`src/client/pages/ActivityPage.tsx:60`) and the connected-apps
panel (`src/client/pages/SettingsPage.tsx:535-536`) each rolled their own in the
*browser's* zone, so an audit trail read while travelling disagreed with the
dates on the entries it audits. A date column is right-aligned or left-aligned
by taste, but it gets tabular figures either way.

The two exceptions both format an axis or a heading rather than a date in a
row, and both are pinned to UTC because the value they render is a bucket
boundary rather than an instant: `chartBucketLabel`
(`src/client/charts.tsx:219-223`) writes a chart's time axis, where the year is
already in the caption below it, and `periodName`
(`src/client/budget-display.ts:24-28`) names a budget period, where "June 2026"
is the answer and "1 June" is a boundary somebody would misread. Naming them is
what keeps the grep below meaningful: an unnamed third one is drift.

*Checked by:* `tests/recurrence-dates.test.ts` and
`tests/locale-detection.test.ts` cover the arithmetic. The rendering paths are
review, and a grep for `toLocaleString`, `toLocaleDateString` and
`Intl.DateTimeFormat` outside `money.ts` and the two exceptions above would
catch the drift.

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
each other or the graduated lines". `.chart-grid` at `styles.css:3292-3299` is
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

This product keeps ten, on measured grounds recorded at `styles.css:3320-3332`.
The previous six-colour set had a worst dichromatic pair of 1.78 in CIEDE2000
under simulated deuteranopia and protanopia, where the green and the pink were
the same colour; the current ten reach 5.6 in light and 4.7 in dark. Going from
six to ten made colour-blind separation better, not worse. The number of series
here is also not an author's editorial choice: it is how many accounts somebody
has.

**Where the source's rule does bite, and where the code failed it.** Measured
against each other, adjacent series pairs run from 1.05 to 2.09 in light and
1.19 to 2.03 in dark. Not one pair reaches 3:1. For the line chart that is
allowed by the Understanding document, quoted above. **For the grouped bar chart
it was not.** `BarChart` lays each series' bar at `index * barWidth` with no gap
(`src/client/charts.tsx:399`), so bars within a group touch, and `.chart-bar`
set `stroke: none`. Two touching bars at 1.05:1 had no visible boundary.

The fix was geometry rather than a repainted palette: `.chart-bar` now carries a
one-pixel `--surface` stroke (`styles.css:3321-3324`), which separates every
adjacent pair against the page they are drawn on and disturbs none of the
measured dichromatic separation the ten-colour set was chosen for.

*Checked by:* `tests/theme-tokens.test.ts`, which asserts `.chart-bar` declares a
stroke and that the stroke is not `none` — the state it was in. The ratio
between two *series* tokens is deliberately not asserted: this section argues at
length that the ten-colour set beats a compliant six-colour one on the measure
that matters here, and a test demanding 3:1 between adjacent series would be a
test that contradicts the guide it is attached to.

### 11.3 A second channel that is not colour

**Binding, SC 1.4.1, level A, plus the source guidance.** Ten categorical
colours cannot all be told apart under dichromatic vision, and no choice of ten
fixes that: the palette in 11.2 is the best available set and reaches 5.6 in
light, which is three times better than the six it replaced and still not enough
on its own.

**The remedy the CSS comment named has landed.** Nine of the ten line series
carry a `stroke-dasharray` (`styles.css:3366-3374`) and series 0 stays solid,
because that is what a single-series chart gets and what a plain line should look
like. A dash pattern is orthogonal to hue, which is the whole point: two series
that look alike to one reader are still two different lines. The patterns differ
in **rhythm** rather than only in length — a long dash against a short one is
easy to tell apart, a 6-4 against an 8-4 is not — and `stroke-linecap: round`
turns the one-unit dashes into dots, which is a third rhythm rather than a
defect.

**And the legend carries the same rhythm**, which is the half that was
backwards. `ChartLegend` renders the swatch with `aria-hidden="true"` and the
label as text, so a screen reader gets the label and a colour-blind sighted
reader got only a block of colour to match against a line. A swatch that shows
the line's pattern can be matched by shape. It is a repeating gradient rather
than a border, because the swatch is a `<span>` and has no stroke to dash, and
the stops are the dash arrays scaled to a 10px box so the two rhythms are the
same rather than similar.

Direct labelling is the other published answer, and both the Analysis Function
and Okabe and Ito recommend it over a legend for lines. Use it where a chart has
few enough series to fit labels; keep the legend where it does not.

*Checked by:* `tests/theme-tokens.test.ts`, which requires nine dashed series and
no two sharing a rhythm — two series on one pattern would put them back on colour
alone for the reader this exists for — and a patterned swatch for every dashed
line. And `tests/browser/budgets.spec.ts` for the half only a browser resolves:
jsdom computes no styles for an SVG `<path>` and no gradients at all, so it can
say the rules exist and nothing about whether the engine applies them.

### 11.4 Every chart ships its table

**House, satisfying a binding requirement cheaply.** A chart is a complex image
and takes a two-part text alternative: a short description identifying it, and a
long one carrying the content. The ledger has already computed the long
description, so the table is free.

The table goes **in the page**, not behind `aria-describedby`. A described-by
target is flattened to one continuous paragraph and a screen reader loses the
table structure entirely. `ReportsPage.tsx:302-315` already does this correctly,
with a real table carrying an `.sr-only` caption and `scope` on every header.
`.chart-figure` uses `<figure>` and `<figcaption>`, which is the recommended
structure.

*Not checked mechanically.* A test asserting a table alongside every chart
component is structural and worth writing.

### 11.5 Pixels may be lossy

**Binding.** The rule and its two examples are in
[`common.md`](common.md#money). What this guide adds is the line reference:
`niceTicks` at `src/client/charts.tsx:95-135` is where the conversion happens,
and it is the only place in the chart code that is allowed to make one.

*Checked by:* `tests/client-money.test.ts`.

### 11.6 A series keeps its colour when the visible set shrinks

**House.** A series' colour is bound to its place in the full set, never to its
index in whatever subset is currently drawn. Colours were dealt by array
position, so excluding one category from the categories report recoloured every
line and swatch after it — and the moment somebody most wants to compare before
and after is the moment everything changed clothes. `Series.paint`
(`src/client/charts.tsx:15-26`) carries the full-set position past the filter,
and the categories report assigns it from the unfiltered rows
(`src/client/pages/ReportsPage.tsx:272`); a chart whose set cannot shrink may
leave it out, because there position and identity are the same number.

*Not checked mechanically.* A jsdom test excluding one series and asserting the
survivors' `chart-series-N` classes did not move is cheap and worth writing.

### 11.7 A link into a filtered list carries the filter that shows its subject

**Binding.** A link that says "Review these 250 rows" and lands on a page whose
default filter hides all 250 is a page calling its own link a liar. Any link
whose text promises specific rows — a count, a batch, a recurrence's waiting
proposals — pins in its query string whatever range or filter makes those rows
visible, because the destination's defaults were chosen for a person arriving
cold, not for one arriving with a claim in hand.

The audit found the same hole three times in one afternoon: the post-import
review link dropped the date range, so a September import of August rows opened
an empty queue under a this-month default; the recurrence list's waiting-count
link did the same to proposals that were overdue from an earlier month, which
are exactly the rows that link exists for; and the template used-count link
dropped the range every sibling detail link carries.

*Checked by:* `tests/recurrences-page-ui.test.tsx` pins the recurrence link's
query string. The class is review: whether a link's text makes a promise is a
reading of the text.

### 11.8 Where a view choice lives

**House.** A choice about what the reader is looking at lives in one of three
places, and which one is decided by who the choice is *about*, not by what is
easiest to wire:

- **The URL**, when the choice defines the view itself: the range, the report,
  the grouping bucket, the archived flag. A report somebody sends somebody else
  is the report they were looking at (`src/client/pages/ReportsPage.tsx:107-108`),
  and 11.7's link rule only works if the filter has a query string to ride in.
- **Component state**, when the choice is a reading gesture rather than a view
  definition: the categories report's exclusions
  (`src/client/pages/ReportsPage.tsx:60-67`). Putting the one huge category
  aside is how the remaining lines become readable; it changes nothing stored,
  an agent asking over MCP still sees every category, and navigating away
  forgets it.
- **The server**, when the choice is about the person rather than the page:
  theme, timezone, currency. Those follow them to the next browser.

The middle case cuts against 11.7, and deliberately: a shared categories link
shows lines the sender had excluded. The other reading — exclusions in the URL —
makes a scale gesture into a claim the link is making about its subject, and a
recipient has no way to see the pills they should question. If somebody asks
for shareable exclusions, that argument is the one to beat; until then the
decision is recorded here rather than left to look like an oversight.

### 11.9 A field the API sends is rendered, or its absence is argued

**Binding, and the parity rule one level down.** `AGENTS.md` already says a
request field only an agent can set is a parity defect; the mirror holds for
responses. A field the server computes and the page drops is an answer somebody
is not getting — the forecast's uncovered-budget slice, a recurrence's
discarded-proposal count, a connected agent's last token — and it fails
silently, because the page renders fine without it. When a page deliberately
drops a field, the drop is a comment naming the field and the reason, so the
next reader can tell restraint from oversight.

*Checked by:* `human`. The client types in `src/client/api.ts` mirror the
server's views, so an unused declared field is at least greppable; nothing
mechanical can say whether an omission was argued.

### 11.10 A named figure links to the thing it is about

**House.** Where a summary names something the app has a page for, the name is a
link to that page, and the link carries `location.search` so the range travels
with it — 11.7's rule, one level down.

The overview's spending-by-category rows were plain `<span>`s for a release. The
data was there — `Summary.spendingByCategory` has carried `categoryId` since it
was written — and every other list in the product links its subject, so this was
an omission rather than a decision. A figure a person wants to ask a question
about is exactly the figure worth linking, and "why is Groceries $182?" is the
question that panel provokes.

**Two conditions.** The link appears only where there is something to link to:
the uncategorised row has a null id, because it is the absence of a category
rather than one of them, and `/categories/null` is a 404. And a linked name
inside a row takes the row's own colour rather than the global anchor green,
greening on hover — the treatment `.account-mini-row` already had and
`.spending-row` did not, or the name reads as a second green thing beside a
green bar.

*Checked by:* `human`. Whether a figure has a subject worth linking is a
judgement; what a test could catch — that the link carries the search string —
is 11.7's, and it is not caught there either.

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
and the button carries the imperative. `EmptyState` is used at 16 sites — the
sixteenth is the categories list, which says "no categories yet" and "no
categories match this search" as the two screens this rule asks for.

Two amendments have landed. **The icon is required.** It was optional and three
of the sixteen omitted it, which left a heading and a sentence floating in a
card — a page that reads as having failed to load rather than as having
answered. **And the heading level is a prop**, defaulting to `<h3>`, because a
component that hard-codes one misstates the document wherever it is used: the
duplicate review's "nothing left to review" *is* the page's content and takes
`level={2}`. Same reasoning as `ErrorSummary`'s in 8.3.

*Checked by:* `npm run typecheck`, which is the whole check for the required
icon and is why making it required was worth more than a test — the three sites
that omitted it were three compile errors. `tests/ui-copy.test.ts` holds two
more: that a filtered list's title is a conditional rather than one sentence for
two situations, and that an empty state sits *behind* its query's error rather
than beside it.

That last one had been three screens and a banner on six lists. React Query's
`isPending` is `status === "pending"`, so a query that errored is not pending
and fell past the loading branch into the empty state — the page said "No
transactions yet" over the top of an alert explaining that it could not tell.
The check reads the slot rather than the file, because every one of these pages
mentions its query's `error` somewhere anyway: a first version grepped the
source and passed on all six defects. Two empty states are exempt and named with
the reason each is: the account register guards at the head of the same ternary
ninety lines up, and the CSV preview's "No file yet" has no query behind it at
all. Whether the two empty *sentences* are the right sentences is still review.

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

Today it is twenty-three `Skeleton` sites and four paragraphs. The last two are
the categories page's group list and the overview's budget panel, both of which
were rendering their empty sentence while still loading — a list that says
"none yet" before it has looked is the shape this rule exists to prevent.

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
(`components.tsx:280-306`). A spinner is a picture of waiting, which is nothing
at all to somebody who cannot see it, and a disabled button otherwise goes
silent at exactly the moment a person most wants to know their click landed. See
section 4 for the reduced-motion half of the same defect.

**A disabled submit always says why, next to itself.** Eight controls are
disabled on a computed predicate and one had a sentence beside it — the split
remainder line, which is the model the rest now follow. It is the one control
that can go completely silent: nothing has been typed wrongly, so there is no
field error, and nothing has been submitted, so there is no summary. The button
is grey and the person guesses which of the form's conditions is unmet.

`Button` takes `disabledReason`, rendered only while `disabled` is true and
`loading` is not — a button that is working already says so, and a reason for
that state would be a second answer to a question already answered. Wired with
`aria-describedby` rather than left as a neighbouring paragraph: a sighted
person reads what is beside the button, and somebody on a screen reader is told
the button's name and its state and then has to go looking.

Two things about it worth knowing, because both were the obvious version being
wrong. **The reason names the first unmet condition, not all of them** — a
person reads down a form and wants to know what to do next. And **the wrapper is
unconditional**, `display: contents` until it has a reason to show: wrapping only
when a reason exists remounts the button as the reason comes and goes, which
takes focus off it at the moment it becomes usable, which is the defect 13.3 is
about.

*Checked by:* `tests/field-contract.test.tsx`, which holds the behaviour — shown
when disabled, absent when enabled, absent while working, and the same element
across the change — and requires the prop at every `<Button>` in the client with
a computed `disabled`. That last part is what this section said it had nothing to
key on; the prop is the thing to key on.

The census walks brace depth rather than matching a regular expression, and the
reason is worth recording because the first version of it claimed this coverage
without having it. It read a hand-written list of five files and matched
`/<Button[^>]*?\sdisabled=\{[^}]*\}/`, where `[^>]*?` cannot cross the `>` in
`onClick={() => …}` — so an arrow-function-first button was invisible even in
the five. Eight buttons carried the prop and the check saw exactly those eight,
which is what a passing check looks like when it is measuring itself. Walking
the client properly finds 22, and the fourteen it had never seen were fourteen
controls that went grey and said nothing. Four of those are exempt and named in
`WORKING_NOT_BLOCKED`: the unpressed half of a pair, greyed while its sibling
works, where the answer is the sibling's spinner.

### 12.4 One live region per page

**House.** A page has one polite live region, `role="status"`, for
confirmations and progress, and reaches for `role="alert"` only for something
time-sensitive that interrupts.

Announcement is already handled: `Alert` sets `role={kind === "error" ? "alert"
: "status"}` (`src/client/components.tsx:986`), so a success alert is a polite
live region and an error alert interrupts. The two real defects are elsewhere.
There are three separate `aria-live="polite"` regions in the client
(`components.tsx:230`, `TransactionBrowser.tsx:756`, `TemplatesPage.tsx:424`),
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

### 12.6 A progress bar

**House, with two Binding clauses named inline.** Section 12.2 answers what to
show while a *list* loads. This answers what to show while a *write* runs, which
is a different question: a person who has pressed Commit on four thousand rows
is not waiting for a screen to paint, they are waiting to find out whether their
books changed, and for a minute or more nothing on screen said anything at all.

The rules, in the order they matter:

- **A bar is determinate or it is not shown.** `<progress>` with no `value` is
  indeterminate and animates in every engine, and the blanket reduced-motion
  block at `styles.css:3853-3862` freezes it into a bar that reads as stuck.
  That is section 4's spinner defect a second time, and a determinate bar is the
  fix for that class of failure rather than a new instance of it.
- **A bar never appears before its total is a real count.** A commit does fixed
  setup before its first row — the idempotency record, the row read, the locks —
  and reports nothing during it. Until a count arrives the busy control is the
  whole indicator (12.3). Nothing on this screen is ever drawn from an estimate
  of how long something will take.
- **Every bar is paired with words, and the words are its accessible name.** A
  bar alone is a picture of waiting, which 12.3 has already settled is nothing at
  all to somebody who cannot see it. `ProgressBar` takes a `label` and points
  `aria-labelledby` at the visible sentence, so the name is the sentence rather
  than a second copy of it (10.3).
- **The words are the house count form**: `2,140 of 3,400 checked`. Both figures
  through `toLocaleString`, the past participle from the phase vocabulary
  (`PROGRESS_VERB`, `src/shared/progress.ts`), sentence case, no full stop. It is
  9.5's form for a selection and `BudgetsPage.tsx`'s for a budget, and it is
  built in one place — `progressLabel` (`src/client/components.tsx`) — so two
  pages cannot word the same thing differently.
- **A bar is not a live region and does not add one.** 12.4 already counts three
  polite regions in this client, and a fourth updating four times a second is a
  machine gun rather than an announcement. `<progress>` carries the
  `progressbar` role, which is not a live region; the *outcome* is announced by
  the `Alert` that takes the bar's place.
- **A bar reports rows done, never time elapsed and never an estimate.** Where
  the bar is weighted across phases of unequal cost — a commit validates,
  compares and posts, and posting is roughly three quarters of the round trips —
  the weights are named in `src/shared/progress.ts` and the sentence beside the
  bar carries the phase's own true figures. The weighting is a presentation
  choice about smoothness; the numbers a person reads are not weighted.
- **A bar is removed on failure, not frozen, and the message beside it says what
  did not happen — when that is known.** These writes are atomic, so a bar left
  at 61% beside a refusal is a claim that 61% of the work stuck, and that claim
  is false. A refusal's own sentence is therefore followed by "Nothing was
  committed." or "Nothing was staged.", because no other copy on either page
  says so and somebody who watched the bar climb has no other way to know.
  **A connection that died is not a refusal and gets no such sentence.** The
  work is never cancelled because a browser went away, so the outcome is
  genuinely unknown and the page says exactly that instead. `writeDidNotHappen`
  (`src/client/api.ts`) is the one place the two are told apart, because a page
  that guessed would guess wrong in the direction that matters: telling somebody
  their four thousand rows did not post when they did.
- **The threshold at which a bar earns its row of layout is
  `PROGRESS_STREAM_MIN_ROWS`** (`src/shared/domain.ts:1226`), not a literal in a
  page. Fifty is a judgement rather than a boundary in nature — below it the work
  is over before a bar could be read, and a bar that flashes is worse than none.
  It sits under the cap `AGENTS.md` fixes: "Ten thousand rows is the cap, and it
  is the same number everywhere: a mass edit, a mass delete, a commit, and a CSV
  import."
- **Binding, SC 1.4.11.** The fill is `--green-fill` on `--track`, measured in
  2.2, and the bar keeps the `--line-strong` edge 2.2 requires of a control.
- **Three bars now, and a fourth has to say which of them it is not.**
  `.progress-track` (`styles.css:1340`, `DashboardPage.tsx:287`) is a decorative
  share-of-total meter under a row that already states its figure.
  `.budget-bar` (`styles.css:3686`, `BudgetsPage.tsx:1168`) is money, with an
  over state. `.progress-meter` is work in flight. Neither of the first two
  appeared in this guide before this section, which by 17.3's closing test was a
  defect in the guide.

*Checked by:* `tests/progress-bar-ui.test.tsx`, which queries by role and by
accessible name throughout rather than by class — that is the claim `<progress>`
is used to make. It holds that a batch over the threshold asks for frames and
one under it does not, that the bar is not drawn before the first frame nor for
a total under the threshold, that it is removed rather than frozen when the work
settles or is refused, that the sentence beside it names the phase and its
figures, and that a connection ending without an answer earns no claim about
what was written. `tests/progress-frames.test.ts` holds the fraction monotonic
across a phase change and the threshold below the bulk cap. **Not covered:**
that the bar is *painted*. jsdom has no layout engine and the fill comes from
vendor pseudo-elements, so only 13.5 could see it and nothing there does; it was
checked by hand in Chromium in both themes and is listed in 17.3.

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

**The code covered two element types out of the set**, and three of the gaps
were live SC 2.4.7 failures. `summary` is the `RowMenu` trigger
(`components.tsx:491`) and fell to the user agent default; checkboxes and radios
got only `accent-color`; and `.file-drop`'s `<input>` is visually hidden, so
tabbing to the CSV file picker showed nothing at all.

One rule now covers the set (`styles.css:922-932`):
`:is(button, a, summary, input, select, textarea, [tabindex]):focus-visible`
plus `.file-drop:focus-within`, which is where the wrapper takes the indicator
its hidden input cannot show. `.input:focus` stays as it is — a field's ring is
wanted on a pointer focus too, which is the case `:focus-visible` deliberately
excludes.

*Checked by:* `tests/page-stack.test.ts`, which asserts the union of selectors
carrying `:focus-visible`, `:focus` or `:focus-within` covers every focusable
element type and that `.file-drop` carries `:focus-within` by name. The list is
the check: a ninth focusable type added to the markup has to be added here or
the test says which one is bare.

### 13.3 Focus management

**House.** This was the largest hole in this section, and it was four holes:
each one something that moved or vanished with focus left wherever it had been,
so the next Tab started from the top of the document. On a page whose first
eleven stops are navigation links, that is the difference between carrying on
and starting again.

- **A skip link.** There was none. There is one now, first in the DOM and so
  first in the tab order, before the eleven links rather than after them. A
  plain anchor rather than a `Link`, so the browser moves focus to the fragment
  itself, and `<main>` carries `id="main"` and `tabIndex={-1}` — without which
  the browser scrolls and leaves focus on the link, which looks like it worked
  and did not. It is off-screen by transform rather than by `display: none` or a
  1px box: it has to be focusable to be reachable, and a zero-size box is a
  focus ring nobody can see.
- **Route change.** `router.tsx` navigates by `pushState` and moves neither
  focus nor scroll, so following a link from the foot of the transactions table
  landed mid-page with focus on an anchor that no longer existed. Navigation now
  resets scroll and moves focus to `<main>`. **The region rather than the
  `<h1>`**, which both satisfy the rule: entering the region announces the
  landmark and reads from the top, where focusing the heading announces one line
  and leaves the reader to find the rest. Keyed on the **pathname alone** — every
  filter, sort and page change on this app rewrites the query string, and moving
  focus on those would take it out of the control somebody is still typing in —
  and skipped on the first render, because stealing focus on load is worse than
  leaving it where the browser put it.
- **After an action.** Two halves, and the platform already had one. A modal is
  a native `<dialog>`, so `close()` returns focus to whatever opened it, and
  `RowMenu` returns focus itself. The half that was missing is a **bulk action**:
  the button is inside the selection bar and finishing the work unmounts the
  bar, so focus fell to `<body>`. It now lands on the sentence saying what
  happened — `Alert` takes an opt-in `takeFocus`, used on the three pages that
  unmount their own button. That is both the thing somebody wants to read and
  the place their next Tab should start from; `role="status"` already announces
  it to a screen reader, and this is for the sighted keyboard user, who is
  announced nothing. Opt-in because most alerts render beside a control that
  still exists, where moving focus away would be the defect rather than the fix.
- **The mobile drawer.** An `<aside>` toggled by an `.open` class is not a
  dialog, so opening it left focus on the hamburger and Tab walked the page
  behind the scrim. The column behind it now carries **`inert`**, which is the
  platform's answer: it takes the whole column out of the tab order and out of
  the accessibility tree in one attribute, where a hand-rolled trap has to
  enumerate what is focusable and be wrong about the next thing somebody adds.
  The scrim stays outside that column on purpose, so Escape is not the only way
  out. Focus moves in on open and back to the hamburger on close, and Escape
  closes — the three things a `<dialog>` gives for nothing.

  **The dialog semantics are conditional, and have to be.** The same `<aside>`
  is the permanent sidebar above 780px, so marking it a modal unconditionally
  would announce a visible navigation landmark as one. Rather than read the
  width in two places, the drawer closes itself when the media query stops
  matching — which also fixes opening it and then widening the window, which
  used to leave a scrim over a page nobody could dismiss.

Modals were already correct: a native `<dialog>` driven by `showModal()` and
`close()`, labelled by `aria-labelledby` from a `useId()`, with `onCancel`
intercepted (`components.tsx:480-530`), and with the form body mounted only while
the dialog is open so closing discards what was half-typed.

*Checked by:* `tests/shell-focus.test.tsx` for all four, and `tests/browser/budgets.spec.ts`
for the two halves only a browser can see — that pressing the skip link actually
moves focus into `<main>`, and that following a navigation link lands focus on
the page it opened. jsdom has neither layout nor fragment navigation, so it can
say the link exists and nothing about whether it works, which is exactly the
split section 1.1 of `testing.md` is about. `tests/modal-layout.test.ts` pins the
dialog centring and `tests/row-menu.test.tsx` covers the menu's dismissal. The
keyboard pass in section 14 remains a person's job.

### 13.4 Target size

**Binding, SC 2.5.8 Target Size (Minimum), level AA.** 24 by 24 CSS pixels,
subject to the spacing exception: if a 24px circle centred on each target's
bounding box does not intersect another target's circle, the target passes.

This is already solved, deliberately. `.icon-button` is 31 by 31
(`styles.css:2255-2266`) with an `::after` at `inset: -7px` giving a 45px hit
area without growing the row, and a comment saying why
(`styles.css:2043-2047`). **That is the house answer for a dense-row control.**

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
- The skip link works and lands in `<main>`. **This one is now a test rather
  than a pass** — `tests/browser/budgets.spec.ts` presses Tab, presses Enter and
  reads back where focus went — and it is on this list because a person could
  not complete it while there was no skip link to try.
- A horizontally scrolling table can be scrolled from the keyboard.
- No control needs a mouse, including the file picker on the import page.

## 15. Responsive

**Binding for the requirement, House for the steps.** SC 1.4.10 Reflow (level
AA) asks for no two-dimensional scrolling at 320 CSS pixels wide. `html` and
`body` both set `min-width: 320px` (`styles.css:308-321`).

Four steps, described as what actually changes. Section 3.6 proposes folding the
980px one into the 1050px one and this table is why it is a proposal rather than
a rule: it does one thing, for one page. Naming it here is what keeps this table
and `tests/styles-order.test.ts` — which knows there are four — from disagreeing
about how many steps this product has.

| Step | What happens |
| --- | --- |
| 1050px | Card grids drop to two columns; the import and settings two-column layouts become one; `.import-preview` stops being sticky |
| 980px | The duplicate-review comparison drops to one column, and nothing else |
| 780px | The sidebar translates off-screen and becomes a drawer with a scrim; a `.mobile-header` appears; the page header and its actions stack; the sign-in art panel is dropped |
| 560px | Every card grid drops to one column; the date bar, filter bar, search box, bulk actions and selection bar stack; a panel header stacks its title above what is said about it; buttons go full width |

Two rules that follow:

- **A table does not reflow; it scrolls.** `.data-table` keeps its 760px
  `min-width` at every step, inside a container that scrolls and is keyboard
  reachable (section 9.6). Prefer dropping non-essential columns to shrinking
  the text.
- **`dvh`, not `vh`, for anything full-height.** There were seven `100vh` uses
  and no `dvh`; on a mobile browser with a retracting toolbar `100vh` is taller
  than the viewport and the bottom of the page is unreachable until the toolbar
  hides. All seven are `dvh` now, including the modal's `max-height`, which is
  where it mattered most: a tall form's last field and its submit button sat
  below the fold until somebody scrolled the toolbar away. The two `100vw` in
  the same arithmetic stay, because nothing retracts horizontally.

Two more things are missing and should exist: a print stylesheet, because
Reports is a page people print, and `prefers-contrast` and `forced-colors`
handling. Neither exists today.

*Checked by:* `tests/styles-order.test.ts` for the breakpoint list and its
order, and `tests/page-stack.test.ts` for the reflow rules a class can carry.
The `dvh` half is one grep and is held there too. The responsive *pass* in
`AGENTS.md`'s definition of done stays review: whether a page is usable at
320px is a judgement about a screen.

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
and is dropped where there is nothing to say. It repeated the title on Accounts
and Overview, which is a line of uppercase text above a heading saying the same
word — decoration that reads as structure, and a second thing for a screen
reader to announce. Both are dropped.

*Checked by:* `tests/ui-copy.test.ts`, in four parts. The banned words, in every
string literal a person can reach — and across `src/server` too, because
`common.md` settles the voice for both surfaces and a service's refusal is
rendered on a screen: six shipped there, including a cursor that "is invalid"
and a setup code the sign-up screen called invalid to somebody who had just
copied it out of a log. Every `<Button>` with a literal child carries a verb
phrase or one of the four bare actions, which is where two bare `Save`s were.
The three bulk-action bars use the four sanctioned strings and no fifth
spelling. And no eyebrow equals its own title.

Two limits, stated rather than implied. Only twenty of roughly a hundred
`<Button>` uses have a literal child; the rest compute their label and need
rendering to read, and the failure this catches is one somebody types as a
literal. And whether a message names the *right* next action is review and
always will be.

## 17. What is checked, and what is not

A rule with no check is a rule that is going to rot. This is the ledger of which
is which.

### 17.1 Enforced today

| Test | What it holds |
| --- | --- |
| `tests/theme-tokens.test.ts` | Three token blocks exist, share a key set, and the two dark ones parse to the same token map; the attribute block is last; `color-scheme` per block; no literal colour outside the blocks; no undeclared or unused token; no text token used as a fill or fill token used as text; one token per series in both themes, all distinct; every `.chart-series-N` draws from its token; `.input` draws its fill and edge from `--field` and `--field-line`, `.input:disabled` exists and takes its fill from `--field-disabled`, and that fill differs from `--field` in every theme |
| `tests/table-overflow.test.ts` | Every `.data-table` sits in a scrolling wrapper; `.table-wrap` carries `overflow-x` and none of the card chrome |
| `tests/styles-skeleton.test.ts` | The shimmer animation belongs to `.skeleton` alone; every card paints its own background; every selector whose animation says `infinite` is answered by name under `prefers-reduced-motion` (4) |
| `tests/styles-order.test.ts` | No top-level rule follows the responsive body; the four breakpoint blocks are contiguous and in descending order; the two preference blocks above them are named and so are the two selectors the motion one qualifies; no two independently-triggered layers share a `z-index` (3.5, 3.6, 4) |
| `tests/contrast.test.ts` | Every rule painting text on a fill clears 4.5:1 (or 3:1 where the rule says it is large) in both themes, derived from the token values rather than quoted; the six published non-text pairs clear 3:1 (2.1, 2.2, 11.1) |
| `tests/modal-layout.test.ts` | `.modal` centres independently of the global margin reset |
| `tests/error-summary-ui.test.tsx` | A refusal's every sentence is rendered, two fields sharing one sentence stay two lines, one field refused twice shows once, the summary takes focus and retakes it on an identical repeat, its heading is an `h3` under a dialog's `h2`, and a parser's own errors leave the app's sentence standing (8.3) |
| `tests/radio-groups.test.tsx` | Every radio belongs to exactly one group; two forms on one page stay separate; the transaction type choice is one tab stop with arrow wraparound |
| `tests/new-category-kind-ui.test.tsx` | The form asks which kind a name with nothing behind it should become, stays quiet when the category exists or the picker is empty, sends the answer only when one was given, and forgets it when the direction changes |
| `tests/nav-order.test.ts` | The sidebar order, and that every item names a route the app serves, both directions |
| `tests/theme-boot.test.ts` | `public/theme-boot.js` and `applyTheme` give the same answers |
| `tests/client-money.test.ts` | The money arithmetic every figure on screen is computed from |
| `tests/row-menu.test.tsx` | The row menu's dismissal and focus return (13.3) |
| `tests/bulk-row-cap.test.ts` | The ten thousand row cap behind the selection contract (9.5) |
| `tests/page-stack.test.ts` | The page's rhythm comes from `.content` and no page-level block carries a vertical margin or a negative one; no filter bar wraps a control in `Field`; every one of the twelve scrolling table containers is a named, focusable region; the focus-indicator selectors cover every focusable element type and `.file-drop` carries `:focus-within`; every sticky or fixed region is paired with a container declaring `scroll-padding` (7.4, 7.5, 7.6, 9.5, 9.6, 13.2) |
| `tests/theme-tokens.test.ts` (chart palette) | `.chart-bar` declares a stroke, and not `none`, so two adjacent bars at 1.05:1 have an edge; nine of the ten line series carry a distinct dash rhythm and every dashed series' legend swatch carries the same one (11.2, 11.3) |
| `tests/progress-bar-ui.test.tsx`, `tests/progress-frames.test.ts` | When a progress bar is drawn, what it says, and that it is removed rather than frozen (12.6) |
| `tests/recurrence-dates.test.ts`, `tests/locale-detection.test.ts` | The date and locale arithmetic every rendered date rests on (10.4) |
| `tests/page-stack.test.ts` (continued) | A page-prefixed class is used on its own page, or is one of twenty-one registered components; every full-height rule measures `dvh`; a right-aligned cell gets tabular figures whether it is a header or not (6.3, 9.3, 15) |
| `tests/field-contract.test.tsx` | Every `<Button>` with a computed `disabled` carries a `disabledReason`, which is shown and pointed at while disabled, absent while enabled or working, and does not remount the button (12.3); a field names its control explicitly, points it at the hint and the error, marks it invalid, and is a labelled group around a composite; every `<input>`, `<select>` and `<textarea>` in the client goes through the three shared components, with two named exceptions (8.1) |
| `tests/shell-focus.test.tsx`, `tests/browser/budgets.spec.ts` | The skip link is first and lands in `<main>`; a route change moves focus and resets scroll; the drawer makes the page behind it inert, moves focus in and out, and closes on Escape; a finished bulk action puts focus on the sentence saying so (13.3) |
| `tests/ui-copy.test.ts` | No banned word in any string a person reads, in all three of client, shared and server; every literal button label is a verb phrase or one of the four bare actions; the three bulk bars use the four sanctioned strings; no eyebrow repeats its title; a blank cell's dash is a fallback and never cell text; `Uncategorized` is styled once; and every worked sentence in `common.md`'s table appears verbatim in `src` (6.2, 16) |

### 17.2 Worth building, ranked by bugs caught per hour

1. **No spacing, radius, size or weight literal outside the scales.** The same
   trick the colour test uses, with an allow-list for `1px` borders, `0` and
   percentages. This is the largest unmanaged surface in the stylesheet: 289
   spacing declarations across 35 values. The census itself is now derived
   rather than recounted — `tests/standards-citations.test.ts` holds section 3's
   numbers to the file, which is what stopped this item and section 3.1 quoting
   two different totals for one measurement.
2. **Every token name matches the grammar and its role is in the closed list.**
   Turns the hand-maintained `TEXT` and `FILL` sets at
   `tests/theme-tokens.test.ts:117-144` into something derivable.
3. **Duration and easing tokens exist and the reduced-motion block sets them**,
   so a new animation cannot forget the second block. The bar separation half of
   what used to be item 5 has landed; the adjacent-series half is deliberately
   not here, because section 11.2 argues at length that the ten-colour set beats
   a compliant six-colour one on the measure that matters, and a test demanding
   3:1 between adjacent series would contradict the guide it is attached to.
   Section 11.3's dash patterns were the honest successor and have landed.
4. **No `type="number"` on a field bound to a decimal-string money value.**
   Scope it, or it fails on the recurrence interval at `forms.tsx:1297` and
   `:3014` and gets deleted on first contact.
5. **`th[scope="col"]` on every column header of every `.data-table`.**
   `tests/table-overflow.test.ts` covers the caption and that every `th` carries
   *a* scope; which one it should be is still uncounted, and a `scope="row"` in a
   `thead` would pass today.
6. **No loading paragraph.** The `Skeleton` migration is done — 23 skeletons
   against four deliberate paragraphs, at `App.tsx:205`,
   `AccountDetailPage.tsx:72`, `CategoryDetailPage.tsx:24` and
   `TemplateDetailPage.tsx:19`, each of which is a whole-page swap rather than a
   region — so this is a grep with a four-line allow-list rather than a grep
   waiting on a migration.
7. **The progress bar is actually painted.** Moved here from 17.3, where it was
   filed as untestable. Chromium resolves `::-webkit-progress-value` through
   `getComputedStyle(element, "::-webkit-progress-value")`, so the browser tier
   can see it; filing it as review meant the one tier built to catch it would
   never be asked.

`eslint-plugin-jsx-a11y` used to be item 7 here and has been removed rather than
demoted: it is enabled at `.oxlintrc.json:15` with 38 rules, and the two this
item wanted are off **by name with recorded reasons** at
`docs/standards/code/index.md:167-176`, because neither can see through `Field`.
`code/index.md` owns that decision and has made it; listing shipped-and-refused
work under "worth building" is how a backlog stops being one.

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
- Whether a link's text makes a promise its destination's defaults would break
  (11.7), and whether a dropped response field was restraint or oversight
  (11.9).
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
