# Web

The browser app. A React 19 single-page app with a hand-rolled router, TanStack
Query for server state, and 4,461 lines of hand-written CSS in
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
algorithm is undecided. Where a perceptual method likes a color that the 2.x
ratio refuses, the 2.x ratio wins.

## 1. Tokens

### 1.1 One tier, and it is semantic

**House.** There is one token tier and a token's name says what it is for, never
what color it is. Material's three tiers exist to serve dynamic color
generation; this product has one brand and two themes, so a reference tier would
double the names and buy nothing.

*Checked by:* `tests/theme-tokens.test.ts`, which fails on any literal color
written outside the token blocks, on a token referenced but never declared, and
on a token declared but never used.

### 1.2 The three blocks

**House, and already enforced.** Every color lives in exactly three blocks at
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
the key sets are identical (`:43`), that the two dark blocks declare the same
values (`:50`, compared as parsed name-to-value maps rather than character for
character, so a reordering passes), that the attribute block comes after the
media one (`:57`), and that each block declares `color-scheme`.

### 1.3 What is a token, and what is not

**House, and the largest gap in this chapter.** Sixty tokens are declared and
all sixty are a color or a shadow made of colors. Nothing else in
the stylesheet is a token: not a space, not a radius, not a size, not a weight,
not a duration, not a z-index, not a breakpoint. There is no stated rule for why
`--shadow` earns a name and `13px` does not.

The rule, from here: **a value becomes a token when it is a decision that has to
be the same in two places.** A color qualifies because a theme must answer for
it twice. A spacing step qualifies because a gap that is 11px on one card and
12px on the next is not a decision, it is two accidents. A one-off geometry
value does not qualify: nine of the ten inline `style` props in the client
(`charts.tsx:273`, `charts.tsx:322`, `components.tsx:920`, `components.tsx:1297`,
`BudgetsPage.tsx:1236`, `DashboardPage.tsx:274`, `DashboardPage.tsx:415`,
`DashboardPage.tsx:475`, `DashboardPage.tsx:521`) are runtime geometry — a bar's
width, a chart's offset — and are correct as they are.

**The tenth is not geometry at all**, and it is named rather than left to look
like one of the nine. `ads.tsx:143` writes `display: block` on the AdSense
`<ins>`, which is how Google documents its own tag, and the stylesheet then
outranks it deliberately: an unfilled unit is collapsed by
`styles.css:3696-3698` with `!important`, because an important declaration is
the one thing that beats an inline style. So this prop is a vendor requirement
held in check by a rule written against it, which is a decision rather than a
coordinate, and nothing about the token rule covers it.

The count matters beyond tidiness: it is what
`src/server/http-security.ts:217-221` reasons about when it declines
`'unsafe-inline'`. Ten is also why the list is enumerated rather than
summarized — the argument rests on every member being accounted for, and the
tenth sat outside an enumeration that read as complete for a release.

*Checked by:* `tests/web-guide.test.ts` holds the number and the files to the
client, so an eleventh cannot arrive unenumerated. Section 3 proposes the ramps;
the check that would enforce them is listed in section 17 and does not exist
yet.

### 1.4 Naming

**House.** `--<role>[-<property>][-<modifier>]`, with the role from a closed
list: `ground`, `surface`, `field`, `fill`, `line`, `ink`, `muted`, `track`,
`accent`, `green`, `red`, `amber`, `blue`, `focus`, `series-N`, `art`, `brand`,
`chrome`, `scrim`, `ambient`, `shadow`, `on-*`. The modifier comes from `soft`,
`wash`, `subtle`, `strong`, `deep`, `dark`, `fill`, `line`, `hover`, `disabled`.
`fill` is both a role and a modifier: `--fill-subtle` and `--fill-deep` are the
two tokens using it as a role.

Two consequences worth stating. First, do not reach for a token because its
color happens to match; a token used outside the concept it names breaks in the
other theme. Second, `--ambient`, `--art-glow-a`, `--art-glow-b`, `--art-veil`, `--chrome`
and `--scrim` carry no property segment and cannot be read from their names
alone. They are exempted here by name rather than left as a hole in the list —
and `--art-glow-b` had been silently missing from that list, which is the exact
failure a by-name exemption exists to prevent.

Adopt the Design Tokens Format Module's naming constraints as a discipline
(case-sensitive, no leading `$`, no `{`, `}` or `.`) and its type list as a
completeness checklist. Do not adopt its JSON file format and do not add Style
Dictionary. Saying so is what stops a future self adding a build step.

*Checked by:* `tests/token-grammar.test.ts`, which reads both closed lists out
of the paragraph above — so the guide is the one place a role is added — and
parses every declared token against them. The six exempted by name are a
register there, held to this paragraph in both directions: a seventh fails
until it is named here, and a name here that no longer matches a token fails
too. `tests/support/token-grammar.ts` derives the `TEXT` and `FILL` sets from
the parse, and `tests/theme-tokens.test.ts` now imports them rather than
keeping two lists by hand.

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
because `.input` sets its own background, color and border, the browser's
disabled rendering was overridden and a dead field was pixel-identical to a live
one. `.bulk-edit-field.enabled` paints its row green as soon as an action is
chosen, and on the templates panel choosing "Clear so it is filled in on use"
leaves that green row holding a value field nobody can type in. A disabled
control is exempt from SC 1.4.3 and SC 1.4.11 (section 2.1), which is what lets
its edge drop to the decorative `--line`; the exemption says the contrast need
not be measured, not that the state may be invisible. Opacity is the house
answer for a disabled *button* and the wrong answer here: a field sits on
colored rows, and dimming one lets the row's color through instead of stating
anything.

**Three button families ship disabled and now carry that answer**, which they
did not when freezing first gave a reason to disable the row icons in the
transaction list and the items inside an account's row menu. Each sets its own
`color`, `background` and `cursor` — `.row-actions button`
(`styles.css:2201-2211`), `.menu-popover button` (`styles.css:1873-1886`) and
`.link-button` (`styles.css:3259-3267`) — so the browser's disabled rendering
was overridden exactly as `.input`'s was, and a dead control was
pixel-identical to a live one down to the hover fill. The house answer applies
unchanged and is now written three times, at `styles.css:2313-2316`,
`:1859-1862` and `:3275-3278`: `cursor: not-allowed` and `.button`'s own
`opacity: 0.5` (`:656-659`), read from there rather than chosen again —
the pagination controls' `0.45` (`:1814-1817`) is the one divergence and is not
the number to copy.

The third was found rather than remembered, and how it was found is the rule
worth keeping. The split editor's "Add a category" goes dead at the fifty-leg
cap, and in Chrome 152 the dead link computed `opacity: 1, cursor: pointer` and
the same green underline as the live one beside it. Nothing in the stylesheet
could have said so: a family nobody wrote an answer for is in no list the
stylesheet keeps. What names it is the source — every element rendered with a
`disabled` and a class of its own — which is where the population of families
has to come from.

The hover half is done by narrowing rather than by answering: the three hover
rules became `:hover:not(:disabled)` (`:2303-2306`, `:1845-1847`, `:3219-3221`)
instead of gaining a second rule that repaints what the first painted. Two
rules fighting leaves both spellings live and makes the next hover state added
to that family remember the second one. This is the shape for any family that
ships disabled, not a fact about these three.

**The one place the house `0.5` is the wrong number is a control that already
sits inside something dimmed.** Opacity composites down the subtree, so the two
multiply: a voided transaction row is at `0.5` (`.row-deleted`,
`styles.css:2238-2241`) and an archived account card at `0.65`
(`.account-card.archived`, `:1621-1623`), which put a disabled control in one at
`0.25` and the other at `0.325` — `--muted` at 1.39:1 and `--ink-soft` at
1.75:1 on `--surface`, a control that has vanished rather than one stating a
condition. Both are reachable and both are what disabling these families
created: a voided entry on a frozen account shows **Restore** alone, and an
archived card's **Restore** is refused while every place is in use. So the dim
is dropped there rather than scaled (`:2336-2339`), and inside such a container
what separates a dead control from a live one is the cursor, the hover that
does not light, and the reason it points at. The next container that dims a
subtree joins that rule, because a descendant combinator cannot say "no
ancestor dims" and the exception has to be written out.

*Checked by:* `tests/theme-tokens.test.ts` ("a disabled button"), which asserts
each family declares `:disabled` with `not-allowed` and the opacity it reads
off `.button:disabled`; that no `:hover` rule on a family with a `:disabled`
rule is left unnarrowed, over the whole stylesheet rather than these selectors;
and — read from `src/client` rather than from the stylesheet — that every
element the browser ships `disabled` while naming a class belongs to a family
that answers. The composite is in `tests/frozen-accounts-ui.test.tsx`, which
renders both dimmed containers and asserts the disabled control in each is
exactly as dim as the container and no dimmer; jsdom computes no cascade, so
the opacities are resolved against the real tree from the parsed stylesheet.

What else carries the state differs by family, and none of it carries it alone
any more. Both of the frozen surfaces show a **Frozen** badge — in the row's
Account column, and on the card — and both point every disabled control at a
reason with `aria-describedby`. The card also renders that reason visibly, as
the `.menu-reason` `<small>` directly under the item it explains — **Edit**,
because a frozen card's **Archive** and **Delete if unused** stay open: putting
a frozen account away gives it no place, so nothing refuses it. Only the
transaction row sets
a `title`, and whether a pointer user ever sees one depends on the engine
delivering hover to a `disabled` button at all — Chrome 152 does, measured — so
it is a bonus on one family rather than a route to rely on.

A read-only field is not a disabled one and has not shipped. When the first one
does it either reuses `--field-disabled` or earns `--field-readonly` then;
declaring that token now would fail the unused-token check, which is the right
time for it to arrive.

*Checked by:* `tests/theme-tokens.test.ts` asserts that `.input` draws its fill
and edge from `--field` and `--field-line`, that a `.input:disabled` rule exists
and takes its fill from `--field-disabled`, and that the two fills differ in
every theme — the last of those being the difference between declaring a
disabled state and having one anybody can see.

## 2. Color and contrast

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
than over the token underneath and reads as 1.00:1 to a two-color test.

### 2.2 Non-text contrast

**Binding, WCAG 2.2 SC 1.4.11 Non-text Contrast, level AA.** 3:1 against
adjacent colors for anything required to identify a control or its state, and
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
`styles.css:979-987` for `.input` and at `styles.css:3798-3804` for
`.chart-zero`, and it had been applied to two of the eighteen
`border: 1px solid var(--line…)` rules. Six control edges have now joined them —
`.pagination-step`, `.sort-direction`, `.bulk-edit-field`, `.transaction-type`,
`.commit-choice label` and `.report-tab` — along with `.button-secondary`
(`styles.css:775`) and `.file-drop` (`styles.css:2686`), both of which rested on
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

### 2.3 Color is never the only cue

**Binding, WCAG 2.2 SC 1.4.1 Use of Color, level A.** A 3:1 lightness difference
can count as the extra cue, but where the content depends on telling one color
from another an additional visual indicator is required regardless of ratio.

This product already mostly obeys it, deliberately: a deleted row gets a
**Deleted** badge as well as `line-through` and opacity — the badge is also the
one of the three a screen reader announces — a staged row an amber badge as well as an
amber background, an archived account an "Archived" badge as well as opacity,
and the split remainder line changes its words and not only its color. Keep
that. Section 10 covers the money case, which is the one that still slips.

*Checked by:* nothing mechanical. This is review, and it is the honest kind of
review because the judgement is whether a second cue carries the same
information.

### 2.4 Green and red in a ledger

**Contested.** Red and green are the most common confusion pair, and no source
found in research says whether a financial table should use them at all as a
redundant cue. The published guidance says only that color cannot be the sole
cue.

This product uses them, because the sign is always present and load-bearing and
the color is decoration on top of it (section 10). The decision is recorded
here so the next person argues with it rather than rediscovering the
disagreement. If the sign is ever suppressed in favor of the color, this
decision is void and the color has to go.

*Not checked mechanically.* Whether the sign is still present beside the color
is what section 10.1 covers, and that is review.

## 3. The scales

Five scales are missing. Each of these is **House**, none is checked
mechanically today, and each proposal below is a ramp to adopt rather than a
description of what exists.

*Not checked mechanically, and not yet checkable.* The scales do not exist: every
spacing, radius, size and weight in `styles.css` is a hand-picked value. Once the
tokens land, `tests/support/css.ts` can refuse a literal outside them the way
`tests/theme-tokens.test.ts` already refuses a literal color. Until then this
section is a proposal, and says so.

### 3.1 Spacing

**House, and a proposal rather than a rule until the tokens exist.**

Today: 295 padding, margin and gap declarations across **35 distinct pixel
values**, running 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
19, 20, 21, 22, 24, 26, 28, 30, 32, 34, 35, 38, 42, 48, 55, 72, 248. `gap` alone
takes 16 distinct single values, the commonest being 8px seventeen times, 10px
thirteen, 12px twelve, 6px eleven and 24px ten. Nine, eleven, thirteen and
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
declared in all three color blocks and to be used somewhere, so the ramp cannot
arrive as nine tokens in `:root` — it needs the token blocks split into color
and non-color first. **That split is the first step of the ramp, not a detail
of it.**

### 3.2 Radius

Today: 63 declarations across **19 distinct values**. No two cards match:
`.metric-card` at 11px, `.table-card` at 12px, `.panel` and `.account-card` at
13px, `.modal` at 15px, `.auth-ledger-card` at 18px, `.auth-art` at 20px.
`.balance-snapshot` used to be a second 11px card beside `.metric-card`, and
was deleted along with the four other numbers it differed from it by.

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

Today: 117 `font-size` declarations across nine pixel values (11, 12, 13, 14,
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
`clamp(28px, 3.2vw, 40px)` on `.page-header h1` (`styles.css:603`), which is the
`<h1>` of every page, and `clamp(35px, 4vw, 52px)` on the sign-in shell
(`styles.css:3144`). The page title is deliberately outside the productive ramp
because it is the one size that answers to the viewport rather than to the
scale. Naming both is what stops a display size leaking into a page of
accounts.

### 3.4 Weight

Today: **34 `font-weight` declarations carrying 14 distinct values**: 400, 500,
570, 600, 620, 630, 650, 660, 700, 720, 730, 750, 760, 780. That is very nearly
a weight per component.

Four steps, and no others: 400, 500, 600, 700. The strongest argument for this
is not taste. Inter is named first in the stack (`styles.css:95-97`) and never
loaded (section 5), and `font-synthesis: none` is set at `styles.css:100`, so
the fourteen numeric weights already collapse to whatever the fallback system
font ships. Most of the fourteen are indistinguishable on screen today.

### 3.5 Z-index

Ten declarations across **eight distinct values**, and no ordering document
until this table. One of the two shared values was a real collision:
`.merge-panel` and `.nav-scrim` were both 20, both can be on screen below 780px,
and the scrim is written second — so it painted over the merge panel with
nothing in either rule saying why.

The scrim moved to 25, and this is the ladder, which is what a z-index chosen
alone is chosen against:

| Value | What sits there |
| --- | --- |
| 1 | A decoration inside a card — the search icon (`styles.css:1896`), the sign-in art (`:3417`) |
| 2 | A header sticking inside its own scroller — the modal header (`:2578`), the sign-in card (`:3083`) |
| 10 | A popover over the page — the row menu (`:1850`) |
| 15 | The mobile header, below 780px (`:4248`) |
| 20 | A bar sticking over a list — the merge panel (`:3047`) |
| 25 | The mobile nav scrim, which covers everything above except the drawer (`:4213`) |
| 30 | The sidebar itself (`:362`) |
| 40 | The skip link (`:3497`), above everything because it is the first thing a keyboard user meets |

**Two of the eight were on neither the ladder nor the comment that reproduces
it**, which is the failure this section was written about, one release on. The
copy above `.sidebar` (`styles.css:348-358`) still carries six rungs: it was
written when 15 and 40 did not exist, and neither arrival was read against it.
A ladder missing a quarter of its rungs is a ladder a new layer is chosen
without. **So the table here is the complete one** and a test holds it that way;
the in-file comment is a convenience beside the rule it belongs to, not the
register.

One pair in it has never been argued anywhere and is recorded rather than
asserted. 15 under 20 means a merge panel sticking at `top: 12px` paints over
the mobile header sticking at `top: 0`, so on a phone the merge controls cover
the header while a merge is open. That may well be right — the panel exists
because the list is long enough to scroll — but nothing chose it, and the next
person to touch either should know they are choosing.

Tokens for these would read better and are held back for the same reason the
other scales are (section 3.1): `tests/theme-tokens.test.ts` fails on a declared
token nothing uses, so a ladder introduced ahead of its users cannot be
committed.

The modal is out of this scale on purpose: it is a native `<dialog>` opened with
`showModal()`, so the browser's top layer puts it above everything without a
z-index.

*Checked by:* `tests/styles-order.test.ts`, which refuses two selectors sharing
one value unless they can never be on screen together — the sign-in surface is
rendered instead of the app shell rather than over it, so a layer there and a
layer in the app are free to coincide, and that is the one exception it carries.
And `tests/web-guide.test.ts`, which reads every `z-index` out of the stylesheet
and fails on a value with no row above, so a ninth layer cannot arrive the way
the eighth did. It holds the declaration and value counts in the opening
sentence to the same reading, because two numbers for one measurement is how
this section came apart.

### 3.6 Breakpoints

Four hardcoded max-widths, all four now contiguous at the foot of the
stylesheet in descending order: 1050px (`styles.css:4169`), 980px
(`styles.css:4200`), 780px (`styles.css:4207`) and 560px (`styles.css:4313`).
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
itself to a second block, which is the exact failure the color test exists to
prevent.

Today there are no motion tokens. Transitions are written inline at 120ms (six
declarations), 140ms (one) and 180ms (the mobile drawer's `transform`, with
`visibility` held until it ends on the way out, `styles.css:4213-4215`), and
there are two reduced-motion
blocks: `styles.css:845-848`, which turns off the skeleton shimmer specifically
and stays beside `.skeleton` on purpose rather than joining the responsive body
(section 7.3), and `styles.css:4436-4445`, a blanket rule setting
`animation-duration`, `transition-duration` and `scroll-behavior` on
everything.

**The blanket rule had a defect, and it was user-visible.** It also sets
`animation-iteration-count: 1 !important`, which froze the button's
`.animate-spin` loader (`src/client/components.tsx:389`) into a static icon:
somebody who asked for reduced motion got no busy indicator at all. `.skeleton`
was exempted by hand and the spinner was not, and nothing said which of the two
was the oversight. A slow rotation is acceptable under `reduce`, which asks for
minimized non-essential motion; no indicator is not.

The spinner now swaps its rotation for an opacity pulse rather than stopping
(`styles.css:855-862`), which carries the same meaning with no motion across the
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
`apple-touch-icon.png`, `favicon.svg` and `theme-boot.js`), and no stylesheet
link. On the policy every page carries by default the Content-Security-Policy
declares no `font-src` at all, so it falls back to `default-src 'self'` and a
CDN font is blocked.

One deployment shape is the exception, and it does not change the conclusion. A
deployment serving advertising carries `font-src 'self' https: data:`, because
Google's consent message loads its own faces — so a CDN font *would* load there.
That is a hole opened for a vendor rather than a decision about this product's
typography: the stylesheet still links nothing, so the app still renders in the
system font on that deployment exactly as on every other. Naming it here because
the sentence above was written as though the policy were the reason Inter is not
loaded, and it is not — the reason is that nothing asks for it.

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

**House.** `src/client/components.tsx` is the component library: thirty
components, four helpers (`compareForSort`, `useConfirm`, `selectionCount`,
`progressLabel`) and two exported types.
There is no list of what it contains, which is how `.settings-note` became the
generic muted paragraph and `.section-title` grew two incompatible layouts.

The table below is that list, plus one row — `AdSlot` — for a component that
lives in `src/client/ads.tsx` rather than here and is in the inventory anyway,
for the reason three paragraphs down. So the table carries one more row than the
file has components, and the count above is the file's.

| Component | For |
| --- | --- |
| `PageHeader` | Page title, eyebrow, actions |
| `Button` | Every action. Variants: primary, secondary, ghost, danger |
| `Field` | Label, hint and one control (section 8) |
| `Input`, `Select`, `Textarea` | The three form controls |
| `SortableHeader`, `SortMenu`, `compareForSort` | Sorting a table (section 9) |
| `SelectionCheckbox` | Row and select-all selection |
| `SelectionBar`, `selectionCount` | The bar that appears when rows are selected, and the one count format in it |
| `SearchBox` | The search control in a filter bar (7.6) |
| `MetricTile` | One figure in a row of them: the overview's metrics, an account's balances |
| `Pagination` | Page controls under a list |
| `RowMenu` | The per-row action menu |
| `Modal`, `ConfirmDialog`, `useConfirm` | Overlays and confirmation: destructive by default, `confirmVariant="primary"` for the one that charges a card rather than destroying anything (the plan tab's move to annual) |
| `DateRangeBar` | The shared period selector |
| `BulkEditToggle` | One field of a mass edit |
| `Skeleton` | A loading placeholder of known shape |
| `EmptyState` | A list with nothing in it |
| `Alert` | A form-level or page-level message |
| `Note` | The muted paragraph a section says one thing in (6.3) |
| `Badge` | A state word beside a row |
| `ProgressBar`, `progressLabel` | How far a long write has got, and the sentence beside it (12.6) |
| `RequiredNote` | The one sentence a form says about required fields (8.4) |
| `ErrorSummary` | The submit-time error list focus lands on (8.3) |
| `Form`, `FormErrors` | A form whose refusal reaches both its summary and the fields it names (8.3) |
| `TransferCategory` | A transfer's category cell: a dash, and the words a screen reader needs (6.2) |
| `SettingsTabs` | The Settings section strip, and the one navigation in the app that reloads the document on purpose (6.1) |
| `AdSlot` | One ad unit, in `src/client/ads.tsx` rather than here, and it renders nothing unless the server said to (6.1) |

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

**One component lives outside this file on purpose.** `AdSlot`
(`src/client/ads.tsx`) is the only control this product renders that a person
did not ask for, and it is the only one whose markup belongs to somebody else:
what fills it is Google's, inside an iframe this app cannot reach into. Keeping
it beside the loader that fetches that vendor's script — rather than in the
library beside `Button` and `Field` — is what makes "who renders an ad, and
when" one file to read instead of two.

It renders `null` unless the server sent an `AdPlacement`, which it does not for
anybody entitled to more than a free plan. The gate is not in the browser at
all: the page is simply never given the ids. That is deliberate, and the reason
is in 6.2's terms — the decision is a server one and putting a copy of it here
would be a second place for it to be written differently.

**One component here navigates by document load, and it is the only one.**
`SettingsTabs` renders plain anchors rather than `Link`, because Settings and
the plan tab are served under different content security policies — the plan tab
mounts Stripe's payment form — and a policy belongs to the document it arrived
with. A client-side push between them carries the wrong policy: into the plan
tab the payment form never appears, and out of it every page showing balances
runs with Stripe's origins allowed. `src/client/router.tsx` enforces the second
half, so leaving that document is a load however it is reached.

**One screen renders controls this library did not make.** The plan and billing
tab mounts Stripe's `PaymentElement` (`PlanPage.tsx:1741-1758`), which draws its
own card fields inside an iframe from `js.stripe.com`. They are not in the
inventory and cannot be: the markup is Stripe's and no script on this side can
reach into a cross-origin document. That is the point — no card number ever
touches this app — and it is also why that tab is the one place in the product
where a form control does not come from `components.tsx`. Everything around it,
including the submit button and the error message, does.

**The markup being out of reach does not put the colors out of reach, and this
section used to say it did.** `Elements` takes an `appearance` option and is now
given one, built from this page's own tokens, so the card fields follow the
theme the panel around them is drawn in. That is 6.4's rule and 6.4 is where it
is argued; the sentence that used to sit here was not a description of a limit
but the reason nobody looked for one.

*Checked by:* `tests/web-guide.test.ts`, which asserts every export of
`components.tsx` has a row and that the counts above match the file. It catches
an addition and a miscount — `Note` was promoted into the library with no row,
which is exactly what 6.2's duplicate check needs one to fire against — and not
a duplicate, which stays 17.3's.

### 6.2 When something becomes a component

**House.** All four have to be true:

1. A second page needs it. One use is a page's own markup.
2. It does not duplicate something in the table above. A name check catches the
   obvious case and nothing else, so this one is judgement.
3. It is reachable and operable by keyboard, and it has an accessible name.
4. It does not need a new color, space, radius or size outside the scales.

Two things in the app are past the threshold and are not components yet. Two
others were, and both are worth recording because the second shows what being
named here and left unbuilt costs:

- **A search box** is `SearchBox`, and the thing that only a component could
  hold was not the markup: two of the six call sites passed `type="search"` and
  four left the default, so two of them had a native clear button and an Escape
  that clears, on the same control one click apart in the nav. Accounts, the
  only list page with no search at all, has one now — which also fixed the
  look of its bar, because with no flexible child `.sort-menu`'s `margin-left:
  auto` threw the sort control to the far right of an otherwise empty row.
- **A bulk-action bar** is `SelectionBar`. This bullet recorded the debt in
  three parts and **only the label sets were ever closed**, by
  `tests/ui-copy.test.ts` — so the vocabulary agreed while the bars did not.
  Two pages shared a standalone band; the staged queue rendered its own as a
  CHILD of the filter bar, so ticking a row grew the filter row into a second
  and third line and pushed the filters down the page, and that one carried no
  live region on the one queue where selecting everything stops at the
  ten-thousand cap. Everything else followed from there being no component: two
  stacking rules at 560px, Delete-then-Edit on one bar and Edit-then-Delete on
  the other two, icons on two of three, and thousands grouped on one of three.
  **Mechanizing part of a debt and leaving the rest is how a bullet comes to
  read as closed.**
- **A section heading.** `PageHeader` is a component and cannot drift; the
  heading one level down — the same job on Settings, Plan, Accounts,
  Categories, Payees, Reports, Budgets, Dashboard, Import, Duplicate review and
  all four detail pages — is hand-written at 26 sites under two class names.
  `.section-title` is a `<header>` at ten of its fifteen and a `<div>` at five,
  carries a leading icon at twelve and none at three. `.panel-header` is the
  other spelling, and 6.1's own sentence about `.section-title` growing two
  incompatible layouts is this debt seen a release earlier. What the absence
  already cost is in the stylesheet: the only text rule either had was written
  against `h3`, so Reports' per-currency panel — which sits directly under the
  page's `h1` and correctly reached for an `h2` — matched nothing and fell back
  to the UA's 1.5em bold beside an 11px muted span in a row tuned for 14px, and
  the review queue hit the same thing and answered it with a second rule of its
  own. Both are now one rule off the class, and Budgets' five panel titles are
  the `<h2>` their outline wanted; a `SectionHeader` taking `icon`, `level`,
  `title`, `description` and `actions` is what stops the next one.
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
  color, and the test says so rather than skipping them. A third was a transfer
  reading `Uncategorized` on the transactions list while the queue gave it a
  dash: a transfer can never have a category, so the word read as work left
  undone. Both lists now render `TransferCategory`, a dash with the words a
  screen reader needs, from one component so they cannot part again.

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

**And in a third place nothing could see.** The check below derives a page's
prefix by stripping a trailing `s`, which turns `categories` into `categorie` —
a string no class starts with — so **no `.category-` class was ever examined**
and the whole family walked past this rule onto four files. Four of them were
the record-list shape Categories and Payees share, so a page listing payees was
built out of classes named for categories; they are `.record-list`,
`.record-list-card`, `.record-row` and `.record-name` now, named for what they
are. The rest are genuine components — the category picker and the split
editor's legs — and are in the register with a line of reason each. **A check
that derives its own population examines nothing at all when the derivation is
wrong, and reports green either way**, which is the shape 17 is about.

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

### 6.4 A third-party iframe answers for both themes

**Binding, by way of 1.2.** Every color in this product answers three questions —
the light value, what the machine wants, what the person chose — and a surface
drawn inside the page is part of the page to the person reading it, whoever owns
its markup. **A vendor surface that accepts a theming interface is given one,
derived from the tokens the rest of the page is drawn from. A vendor surface
that accepts none is named here with the consequence stated.**

Two exist, and they are the two halves of the rule.

- **Stripe's `PaymentElement` accepts one and is given it.** For two releases it
  was not: the plan tab passed `options={{ clientSecret }}` and nothing else and
  the word appeared nowhere in `src`, so the card fields rendered in the vendor's
  default light theme and on a dark deployment the one screen that takes
  somebody's money was a white rectangle inside a dark panel — the only surface
  in the product answering for one of the two themes 1.2 requires.
  `stripeAppearance` (`PlanPage.tsx:454-472`) now builds one and `Elements` is
  given it (`PlanPage.tsx:1741-1758`). **Every value in it is read rather than
  re-typed**, which is the half of this that is easy to get wrong: the colors
  come off `:root` through `getComputedStyle`, and the radius and font size are
  measured off a `span.input` the stylesheet draws, because a hex or a radius
  typed there would be a fourth place a color is written and 1.2's whole
  argument would be lost. The base theme is picked by what is painted rather
  than overridden variable by variable, because Stripe's sub-elements have
  defaults no variable reaches, and `usePaintedTheme`
  (`src/client/theme.ts:238-253`) is what says which — it observes the
  `data-theme` attribute and the machine, the same two inputs the stylesheet
  consults, so it cannot end up disagreeing with what is on screen.
- **The ad unit accepts none.** `ads.tsx:141-148` renders Google's `<ins>` and what
  fills it is an advertiser's creative inside a cross-origin iframe; there is no
  theming interface to pass and no prospect of one. Naming it is the whole
  obligation, and what follows from the naming is that the slot is collapsed
  when it is empty (`styles.css:3696-3702`) rather than left as a light band.

**The obvious alternative is what 6.1 used to say**: the markup is somebody
else's, so the surface is out of scope. That is right about the markup and wrong
about the color, and the two had been collapsed into one sentence — which is why
a one-line gap stayed open for a release with the guide reading as though it had
been considered. Scope here follows what a person sees, not what a selector can
reach.

*Checked by:* `tests/stripe-appearance.test.tsx`, for the half on this side.
There is now an appearance to assert about, and the test sets the tokens to
values no stylesheet uses and requires those exact values back out — so a
hardcoded hex, which would satisfy a check that only asked whether the key was
present, fails. **The far half still cannot be checked from either tier**: jsdom
renders no iframe content and the browser tier cannot read into a cross-origin
document, so no test here can see what color the vendor's own surface came out.
Section 17.3 carries that half.

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

**House, and enforced.** The stylesheet is three color blocks (section 1.2),
then one body of component rules, then one body of responsive and preference
blocks, and nothing after them. It was not always: component rules used to
resume below the breakpoints and run for another 426 lines, with a stray 980px
block stranded among them. Media queries add no specificity, so a rule down
there silently outranked the responsive overrides above it —
`@media (max-width: 780px) { .chart-grid { … } }` written in the obvious place
would have lost to `.chart-grid` written later, with nothing on screen to say
why. `.report-tabs` and the chart grid appear in no breakpoint block, and
neither is a gap. `.report-tabs` carries `flex-wrap: wrap`
(`styles.css:3607-3611`), which reflows at every width rather than at three
chosen ones and is the better answer; and `.chart-grid` is an SVG stroke with no
layout to change. This sentence used to call both a gap "somebody can fill",
which is how a list of work comes to include work nobody should do — the
absence of a breakpoint is only a defect where something needs one.

Two blocks are outside the responsive body on purpose and are named here rather
than left as holes. The dark-token block belongs to the three color blocks at
the top, which section 1.2 requires and which this rule does not override. And
the reduced-motion block that stops the skeleton shimmer sits directly beneath
`.skeleton`, four lines qualifying the rule six lines above it: that is part of
a component's own rule, not a second body, and the hazard this section exists to
prevent is a *component rule after the responsive body*.

The four breakpoints run in descending order at the foot of the file, each under
the comment naming its constant, then the blanket reduced-motion block
(`styles.css:4436-4445`), then the print block (`:4451-4455`) and nothing after
it. **Print is last and that is the rule, not an accident of when it arrived**:
it is the one query that describes a different medium rather than a different
width or preference, so anything it needs to undo has already been written.
The comment above the reduced-motion block still calls that block last, because
it was when it was written and the print block landed afterward without being
read against it.

Where a block for a new medium or preference goes is therefore decided here
rather than per block: at the end, after print, unless it has to qualify print
itself. The hazard this section exists to prevent is a *component* rule after
the responsive body; the tail order is the second half of the same argument,
because a media query adds no specificity there either.

*Checked by:* `tests/styles-order.test.ts` asserts that every top-level
construct from the first `@media (max-width` block onward is an at-rule, that
the breakpoints read 1050, 980, 780, 560 in source order, and that the only
preference block above them is the skeleton's. It says nothing about the order
of the at-rules after the first breakpoint, which is how the print block came to
follow a block documented as last; `tests/web-guide.test.ts` holds that tail —
the four widths, the reduced-motion block, the print block, in that order — and
holds this paragraph to it.

### 7.4 The page stack

**House, and it was the largest unstated rule in this guide.** A page is a
single column of sections, and **the distance between two of them is decided by
the container, not by either section.** `.content` is `display: flex;
flex-direction: column; gap: 24px`, and no block that sits at page level carries
a vertical margin of its own.

It used to be the other way round, and the result is worth recording because
three separate complaints turned out to be one absence. Every gap was a margin
on whichever block happened to be there: `.page-header` 26px, the three filter
bars 20, `.account-type-section` 28, `.category-toolbar` 20 and 12,
`.report-tabs` 16, `.settings-grid` 14 — eight numbers for one decision. And the
five blocks that most often sit at page level carried none at all: `.panel`,
`.table-card`, `.alert`, `.empty-state` and `.record-list-card`. So four stacked
panels on the budgets page touched at **0px**, the categories page ran four
different gaps in one screen, and a block moved to a new page brought a spacing
opinion with it that nobody could see in the markup.

**The same absence runs one level down and is only partly closed.** This rule
was legislated, mechanized and migrated at exactly one level — blocks sitting
directly in `.content` — and nothing said anything about a container inside
one. So four two-column page grids ran at 14, 20, 24 and 24px, three card grids
at 11, 11 and 13, `.two-columns` at 13 under a `.form-grid` of 16, the report
page's per-currency stack at 34 for a repeat Budgets does at 24, and five
blocks on four pages decided their own distance with a margin. Every one of
those is now one number on one container, including `.account-type-section`,
`.account-mini-list` and `.import-preview`, which each gained a `gap` where a
child used to carry a margin. **A collapsed two-column grid's gutter IS the
page's vertical rhythm**, which is why the four of them settle on `.content`'s
own 24px rather than on an average.

What is **not** closed is `.panel` itself: it declares padding and no gap, so
the distance under a card's heading is 20px where a page reached for
`.panel-stack`, 0px where it used `.panel-header`, and whatever a child's own
margin happens to be otherwise. Giving `.panel` the treatment `.content` has —
`display: grid; grid-template-columns: minmax(0, 1fr); gap: <one number>`, and
the `minmax(0, 1fr)` is not optional because a grid item takes its min-content
width and a wide table would push past the card instead of scrolling in it — is
the remaining work, and it is work that has to be looked at: it changes the
inside of some thirty panels at once and jsdom can see none of it.

**Flex rather than grid, and it is load-bearing rather than taste.**
`.merge-panel` (`styles.css:3039`) is `position: sticky` and sits at page level
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

**This section settled where a page's actions go and said nothing about what
may go in the slot or what shape its children are**, and three pages drifted,
one into each silence. The rule, from here: **the `actions` slot holds buttons
and status badges, as direct children of the fragment — never a wrapper
element, and never decoration. The `description` slot holds authored copy, and
a fact that varies goes to a `Badge` in `actions`.**

- **A wrapper defeats the responsive rule, which is the part that is not
  taste.** The 780px treatment the page stack depends on is
  `.page-heading > .page-actions { width: 100% }` with
  `.page-heading > .page-actions .button { flex: 1 }`, and the child combinator
  means it only reaches a slot whose children are the controls. Duplicate
  review was the one page that passed a `<div className="duplicate-queue-nav">`
  holding three controls, and that class declared `display: flex` with neither
  `flex: 1` nor `width: 100%` — so it stayed content-sized inside a now
  full-width `.page-actions`, and `flex: 1` divided the wrapper's box rather
  than the screen. On a phone its three controls huddled at the left while
  Staged's and Templates' stretched edge to edge. The wrapper bought nothing
  `.page-actions` does not already supply, and it is deleted.
- **Decoration is not an action and not a status.** Payee detail was the one
  page whose slot held neither: a 36px green `.account-icon` tile, where its
  three sibling detail pages put badges and the six list pages put buttons. At
  780px that is one small green square alone on a full-width row, and the tile
  said "payee", which is the word the eyebrow two lines above already says. A
  payee has no archived state and no kind, so the honest answer is no `actions`
  at all.
- **A data value in the description is the same silence one slot along.**
  Account detail read `description={account.data.institution || "Transactions
  and balances for this account."}`, which renders a bare noun — "Chase" —
  where every other detail page renders a sentence, and which hid the page's one
  authored sentence from every account that names its bank. The institution is
  a `Badge` beside the currency now, which is where category and template detail
  already put the fact that varies, and all four are one shape: eyebrow, name,
  badges, sentence.
- **Below the header the shape is a band of figures, where the page has
  figures.** Account detail has had four tiles since it was written and category
  detail had none, which on the page somebody opens to ask what a category costs
  them reads as a page that failed to load its middle rather than as a page with
  nothing to say. It has two now, In this range and All time, one pair per
  currency where a category spans more than one
  (`src/client/pages/CategoryDetailPage.tsx:153-178`). **Where the figures come
  from is the part worth copying.** They are read out of the categories report,
  which already computes a sum per category over a range, rather than out of a
  route of this page's own: a new `/api/v1` route arrives with an MCP tool beside
  it by `AGENTS.md`'s parity invariant, and a summary band is not worth widening
  the agent surface for. Payee and template detail still have none, and that is
  the honest state rather than a decision — a payee is not a reporting dimension
  in this product, so there is nothing to read without building one.

*Checked by:* `tests/page-stack.test.ts` for the absence of the hoist, and for
the two silences above that a grep can reach: that no `PageHeader`'s `actions`
expression opens an HTML container element, and that no `PageHeader`'s
`description` reads from a query's `.data`.
*Not checked:* that a page with actions puts them in `PageHeader` rather than in
its body. That is a JSX-shape assertion and would want a parser; the negative
margin was the symptom worth catching, and it is caught. Not checked either:
decoration that arrives as a *component* rather than as a `<span>`. The first
check sees the tag name, so `<Avatar />` in the slot would walk past it.

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
[`code/client.md`](code/client.md#31-field-wraps-every-labeled-control-in-a-form)
disagreed, and the disagreement is recorded rather than resolved by silence:
that rule says "`Field` wraps every labeled control", and it has been amended
to carve out the filter bar rather than left to be rediscovered by the next
person who adds a filter.

A search box is `SearchBox` and carries its magnifying-glass icon.
`.search-box .input` reserves 34px of left padding unconditionally, so a search
box without the icon renders an empty gutter — which is what Templates and
Recurring both did.

**This section settled what a filter bar HOLDS and said nothing about what it
IS, so everything else about it drifted.** One section, three container names:
`.filter-bar` on two pages, `.toolbar` on Accounts alone, and
`.category-toolbar` on four. Two gaps between them, and only one of the three
wrapped — which is the difference that breaks rather than the one that shows,
because `.search-box` is `min-width: 260px` and `.select` is 130px, so between
roughly 560px and 900px four pages held a bar that could neither shrink nor
wrap. It is **one class, one gap and `flex-wrap: wrap`** now, and the other two
names are deleted.

Four more things this section is no longer silent about, each of which had
drifted into two answers:

- **Selects before checkboxes.** Five pages put every toggle after every
  select and Accounts led with its checkbox.
- **A refusal goes above the bar; a read failure goes where the list would
  have been.** These are two different alerts and the rule used to treat them
  as one, which made it wrong in both directions. It said "alerts above the
  bar, never below it" and named Accounts as the only offender; a count found
  three pages above and four below, and the four were mostly right. A refusal
  is the answer to something somebody pressed, so it belongs beside the control
  that caused it. A list that failed to load is a hole, and the explanation
  belongs in the hole — hoisting it leaves a header, a filter bar and nothing,
  with the one sentence that would explain it scrolled off the top. Budgets,
  Settings and the category-groups table already render theirs in the slot.

  **Folding the two into one `error` is what made this hard to see, and it
  cost more than placement.** Templates and Recurring each had
  `const error = read ?? read ?? deletion.error` and then `error ? null` in the
  list slot, so a delete the server turned down blanked the whole list. A
  refused delete is not a reason to stop showing somebody their templates.
- **`Filter by X` is the accessible name of a filter**, against `X` alone. It
  was five uses to two, and it is also what tells a filter apart from a form
  field of the same name — a register has both an "Account" select in its
  filter bar and an "Account" select in its form.
- **`archived`, never `closed`**, for `ledger_account.archived_at`. The word
  appeared nowhere else in the product, and somebody who archives an account on
  Accounts and then asks Reports whether it is counted is looking for the word
  they just used.

*Checked by:* `tests/page-stack.test.ts` asserts that no `.filter-bar` contains
a `<Field`. *Not checked:* that every bare control carries an `aria-label`. The
off-the-shelf answer was `eslint-plugin-jsx-a11y`, which used to be an item in
17.2 and is not one any more: it is enabled, and the two rules that would cover
this are off by name with recorded reasons at
[`code/index.md`](code/index.md):175-184, because neither can see through
`Field`. That decision is `code/index.md`'s to revisit.

**One of the four grep-shaped rules now has its grep.** `tests/ui-copy.test.ts`
holds **`archived`, never `closed`** over every literal and every run of JSX
text in `src/client` and `src/shared`, with a named register for the uses that
are a control (`Close navigation`) or the accounting sense (`Closing balance`)
and one pattern for the frozen sense, which is the only phrasing allowed to put
the word beside an account. It was written because the sweep found the rule
broken four times on Reports — the page its own argument names — and once in a
shared schema description that said it to the browser and to every agent at
once. **Its first version could not fail**: `(closed)` was JSX text rather than
a string literal, so mutation-proving it is what found the gap and `jsxText` is
what closed it.

Still not checked: the control order, the alert placement, and `Filter by X`.
The sweep found all three clean, which is why they are not worth a grep yet —
and the alert placement is the one that would need to tell a query's error from
a mutation's, which a source scan cannot do without naming every page's
variables.

### 7.7 Where an advertisement sits in the document

**Binding, WCAG 2.2 SC 1.3.1 Info and Relationships and SC 2.4.1 Bypass Blocks,
both level A.** 6.1 settles who renders an ad and when. This settles where the
slot goes, which is a different question and the one with a success criterion
behind it.

**Both units sit outside `<main>` and below it, each as its own labeled
`<aside>`, and neither is hidden from assistive technology**
(`App.tsx:1059-1075`, the markup at `ads.tsx:132-149`).

Three decisions, and each has an obvious alternative that is wrong for a
different reason.

- **Outside the main landmark, not inside it.** `<main>` is what the skip link
  targets (`App.tsx:897`) and what focus moves to on every route change (13.3),
  and a screen reader entering a landmark reads from its top. A slot inside it
  therefore puts an advertisement in front of the page on **every** navigation,
  for exactly the people who reached it by skipping the navigation — the ones
  least able to get past it again. The obvious alternative is a banner above the
  content, which is where almost every ad-supported site puts one and what makes
  this look like a layout preference. It is not: above the content and inside
  the landmark is the one position that defeats the bypass mechanism the rest of
  the shell is built around.
- **A labeled `aside` each, so it can be passed by landmark.** A bare `<div>`
  would leave the unit as unstructured content a reader has to walk through; a
  named complementary landmark is one jump. The label is passed in rather than
  hard-coded, and it is the same word on both, because two differently-named
  landmarks would read as two kinds of thing.
- **Not hidden from assistive technology.** `aria-hidden` is deliberately absent
  and the code says so. Hiding an ad from a screen reader while showing it to
  everybody else reads as a kindness and is concealment: it is content, the
  person is being shown it, and the honest version is to name it and let them
  pass it. This is the alternative most likely to be proposed as an improvement,
  which is why the reason is written down rather than left in a diff.

**A second operator-configured unit already exists** — `footerSlotId`, off
unless an operator asked for it — so this is a shape rather than a fact about
one slot. A third lands in the same position, under the same landmark rule, and
inherits 1.2's answer from 6.4: there is no theming interface, so the obligation
is the collapse rule, not a color.

*Checked by:* `tests/ad-slot-ui.test.tsx` holds what the component renders —
nothing at all without a placement, and a collapsed unit and slot when Google
returns an unfilled one. `tests/web-guide.test.ts` holds the placement: that
every `<AdSlot>` in the shell is written after `</main>`, and that the slot is a
labeled `aside` carrying no `aria-hidden`. That second half is a source check
rather than a rendered one on purpose — the defect is a slot moved up the file,
and jsdom would report the same accessible name either side of the landmark.

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
  at 88 sites and its children are arbitrary JSX — an `<Input>`, a `<Select>`, a
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
- **The server's sentence reaches the field too.** Given `name` — the request
  path its value is sent as — a `Field` inside a `Form` shows the refusal's
  sentences about that path as its error, with the same three agreeing signals,
  and registers itself for the summary's link. 8.3 has the wiring.

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

**The links, and the sentence beside the field.** GOV.UK's list entries are
anchors to the failing field, and each failing field says its own sentence
again beside itself. Both landed after the 0.2.0 sandbox smoke test found
refusals only at the top of the form. The two things this note used to name as
missing are what made it possible. The path is kept: `ApiClientError.issues`
(`src/client/api.ts:52`) carries each sentence with the dotted request path it
is about, and `errorIssues` (`:160`) hands the summary that list, with `path:
null` for anything that is not a field's — a duplicate-name conflict, a network
failure. And there is a registry, per form rather than per page: `Form` and
`FormErrors` (`src/client/components.tsx:454-475`) put one refusal in a context
that a `Field` reads, and a `Field` given `name` — `"name"`, `"draft.payee"`,
`["draft.amount", "draft.sourceAmount"]` for an amount that is either — both
shows the sentences claimed by those paths as its own error (`:672`) and
records the id of its wrapper for the summary to find. A path claims the paths
below it (`claimsPath`, `:444`), so `draft.legs` speaks for every leg.

Two choices in that wiring look like fussiness and are not. A summary line
moves focus with a click handler rather than following its `href`, so nothing
is written into the address and a dialog's own history is left alone; the
`href` stays so the line is a link to everything that reads one. And a
sentence the field computed itself still wins over the server's: it is about
what is on screen now, where the server's is about what was last sent.

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
dialog's `h2`, that a Papa-shaped `details` with no `path` leaves the app's
own sentence standing, that a claimed sentence appears beside its field with
`aria-invalid` and `aria-describedby` and its summary line moves focus to the
control, and that a sentence no field claims stays plain text in the summary.

### 8.4 Required and optional

**House, and the code disagrees with itself.** `required` is set on controls 55
times and surfaced neither visually nor to assistive technology. The only signal
is that sixteen fields say so the other way round.

Marking the optional ones is a coherent scheme and it is the one this product
picked, so it is now stated: `RequiredNote` (`src/client/components.tsx:424`)
sits before the account, transaction, template and recurrence forms and reads
"Every field is required unless it says otherwise", which is where W3C puts an
instruction covering a whole form. A person meeting an unmarked field previously
had no way to know which of the two schemes they were in.

"Says otherwise" rather than "says Optional" because some fields say it in
better words — a budget's end date says "Leave blank to keep running", which is
more useful than the label would be.

**The word goes in the hint, and `Field`'s `optional` prop is how it gets
there** (`components.tsx:622`, `:648`, `:682`). This is the half this section
was a release behind on, and the reason is 8.1's: a name computed from
`<label for>` is the label element's *entire* text content, so "(optional)"
written into a label becomes part of the control's **name** — "Saving up for
(optional)" is then what a voice user has to say to reach it, which is SC 2.5.3
Label in Name. Three fields on Budgets did exactly that. The prop renders
`Optional.` into the hint, ahead of whatever else the hint says, so the slot
stops being a per-page decision and the shorter claim leads.

The census, and it is one number rather than two: **sixteen fields are marked
optional** — three through the prop (`BudgetsPage.tsx:540`, `:582`, `:594`) and
thirteen writing the hint by hand, two of which already write the prop's exact
`Optional. …` shape and should simply pass it. A reader marking a new field
optional from this section writes the prop; writing the word into the label is
the defect the prop was added to remove.

**Still to do:** a field that is neither marked optional nor actually required
is a bug in the form, and nothing finds them. Most of the unmarked fields are
`<Select>`s that always hold a value and so are required in fact, but the list
has not been walked one by one.

*Checked by:* `tests/web-guide.test.ts` holds the two counts above to the
client, so the scheme's arithmetic cannot drift the way it did. *Not checked:*
that a field is marked optional when it is. A test could assert that every
`Field` whose control lacks `required` carries a hint, which is weaker than
reading each one but would catch a field with no guidance at all.

### 8.5 Money fields

**Binding, from `AGENTS.md` rather than from WCAG.** "Never represent money
with JavaScript/JSON floating-point numbers. Use validated decimal strings and
PostgreSQL `numeric(44,18)`." A money field is `type="text"` with
`inputmode="decimal"`, never `type="number"`, because a number input hands you a
float. GOV.UK's reasons (accidental scroll increments, no feedback on a
non-numeric entry) are secondary and point the same way.

**Scope this exactly.** A blanket ban on `type="number"` in the client would
fail on correct code: `src/client/forms.tsx:1338` and `:3132` both use it for
the recurrence interval, with `min` and `max`, which is an integer count where a
spinner is arguably right. The rule is: no `type="number"` on a field bound to a
decimal-string money value.

**Binding, SC 3.3.2 Labels or Instructions, level A.** The criterion asks that
"labels or instructions are provided when content requires user input". A
currency symbol rendered as an input prefix is not part of the control's label
and is not announced, so the instruction is missing for anybody who does not see
it. Put the currency in the label: "Amount (USD)".

*Checked by:* `tests/money-field-controls.test.ts` for the `type="number"` half.
The population is every money-bound control in `src/client` rather than every
`type="number"`, which is the scoping §17.2 item 4 said this check would need or
"it fails on the recurrence interval and gets deleted on first contact". The two
integer counts that legitimately spin — the recurrence interval and the reminder
interval — are registered by the value they bind rather than by line number,
because both have moved since this section first cited them. The tag walk is
brace- and quote-aware, so a prop sitting after a multi-line `onChange` arrow is
still read; a self-test pins fifteen such elements, because the first version of
it stopped at the opening tag's first `>` and reported the product clean.

The currency-in-the-label half stays review. Whether "Amount (USD)" names the
currency the field is actually bound to is a reading of the form, not a shape.

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

*Checked by:* `tests/auth-autocomplete.test.ts`, in two populations derived
from the product rather than from the presence of a token: every
`type="password"` control anywhere in the client, which is SC 3.3.8's own
population and names itself, and every control inside an auth form, found by
the form's class. It holds the two tokens, that neither is `off`, and that
nothing has been added to take the field away from a clipboard or a manager.
Read from the source, because these forms branch on what the deployment offers
and a rendered pass would check whichever branch it reached.

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
generated by `useId()` inside a `role="radiogroup"` container that has a name of
its own: an `aria-label`, or `aria-labelledby` pointing at visible words where
the group asks a question nothing else on screen asks. The new-category kind
question is that case (`src/client/forms.tsx:2367-2375`): with an `aria-label`
alone, a sighted person met two radio buttons with nothing saying what they were
choosing between. A constant name is forbidden, because two instances of one
form can be on a page at once and a shared name silently merges them.

`TransactionTypeChoice` (`src/client/forms.tsx:516`, the group markup at
`:561`) is the reference
implementation: a real radio group with roving tabindex and arrow, Home and End
handling that wraps at both ends when a type is mandatory, `aria-pressed`
toggles when "no type" is a real answer, and a discriminated union prop pair so
only the `allowNone` shape can report an empty selection.

*Checked by:* `tests/radio-groups.test.tsx` walks every radio on every form,
asserts each belongs to exactly one group and that every group has a name, read
from `aria-label` or from the words `aria-labelledby` points at (removing one
`aria-label` fails it), asserts two forms on one page stay in separate groups,
and covers the roving tabindex and the wraparound. The kind question only
renders once a new category is named, so its visible wording is held by
`tests/new-category-kind-ui.test.tsx` instead.

### 8.9 Comboboxes

**House, settled.** An input offering a `<datalist>` declares no widget ARIA of
its own: `src/client/forms.tsx:356`, `:643` and `src/client/bulk-edit.tsx:96`
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
(`forms.tsx:2249-2252` now renders the component under a comment saying so),
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
editor in place (`src/client/pages/StagingPage.tsx:577-587`). The pattern has
six rules, and each exists because the obvious alternative shipped a bug or an
inconsistency during review:

1. **The editors are the modal's own components, never copies.** The cells
   render `PayeeInput` and `CategoryPicker` through the `onCommit`/`onCancel`
   API added for exactly this (`src/client/forms.tsx:330-336`), and the write
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
   gesture (`StagingPage.tsx:1203-1214`). This is the second exception 8.2
   records: a cell with no submit button makes blur the submit.
4. **Emptying a date or an amount reads as abandoning the edit, not as a
   request to erase the field** (`StagingPage.tsx:675-680`). The modal is where
   a deliberate clear belongs, beside everything else the emptiness affects.
5. **A same-value blur writes nothing** (`StagingPage.tsx:702-713`): no version
   bump, no invalidated bulk-selection fingerprint, no audit entry saying an
   edit happened.
6. **The trigger's accessible name leads with its visible text** — `30 Jul
   2026 — edit the date of Corner shop` — because SC 2.5.3 Label in Name wants
   what a voice user reads aloud to be how the control is addressed, and the
   visible text of these triggers is the value itself.

Closing an editor puts focus back on the trigger it replaced
(`StagingPage.tsx:601-610`); commit, refusal and Escape all remove the focused
element, and without the handoff a keyboard user lands on `<body>`. Event-order
guards around commit and cancel are refs, not state, for the reason
`code/client.md` §1.3 records: the blur that follows Enter or Escape runs
before the render that would update state.

*Checked by:* `tests/staged-inline-edit-ui.test.tsx` — the whole-draft PUT, the
Escape and empty-value cancels, the same-value silence, the categoryKind drop,
and the editors a split does not get. Rule 6's naming shape is
`tests/client-inline-edit-names.test.ts`, and it reads the source rather than a
rendered name: the rule is about the *order* of two things inside one string, and
a rendered name is already interpolated, so "Corner shop — edit the payee" and
"Edit the payee of Corner shop" are both a name containing the visible text.
Three of the four triggers led with it and the payee one read it out last.

### 8.11 What never travels on a copy

**House.** Cloning a transaction prefills the staging form from the source, and
three fields are scrubbed rather than carried
(`src/client/forms.tsx:1558-1585`): leg ids, so the copy grows its own legs
rather than claiming the source's; `externalId`, because it is a bank file's
identity for one real row, and a copy carrying it would be swallowed by the
duplicate check as already-imported; and `templateId`, because provenance
belongs to the source, not the copy. The test of membership is the same for any
future field: identity and provenance never travel, values always do.

The same reasoning holds one level down in the queue's inline category editor,
which drops a stored `categoryKind` when the category is re-chosen
(`StagingPage.tsx:685-689`): the stored kind was somebody's answer about the
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
(`src/client/components.tsx:852-855`). A transactions row carries a checkbox
and a row menu; a review-queue row now carries up to ten stops — the checkbox,
four click-to-edit triggers (8.10), sometimes a duplicate link, three icon
buttons and the menu — so the tab-sequence cost the APG worries about is real
here and grew with the inline cells. The decision holds anyway: every stop is a
control somebody came to press, and Tab past a row is still one keystroke per
control rather than a second navigation model to learn. Recording that the APG
leans the other way is what makes this read as a decision.

*Checked by:* `tests/sorting-and-grid-roles.test.tsx`, over `grid`, `treegrid`
and `gridcell` — the pattern's own roles and nothing wider, since `role="region"`
is required by 9.6 and `role="status"` by 12.2. It is worth roughly nothing
until somebody reaches for one, which is exactly the moment it is worth
something: the rest of the pattern follows the role.

### 9.2 Semantics

**Binding, WCAG 2.2 SC 1.3.1 Info and Relationships, level A, for the header
association**: `scope="col"` on every column header and `<th scope="row">` on
the identifying cell, so a cell's row and column headers are programmatically
determinable.

**House for the caption.** Every `.data-table` also gets an `.sr-only`
`<caption>`. No level A or AA criterion requires one; a table announced without
a name is harder to place, and the caption is the cheapest way to give it one.
The caption is shown, as `.table-caption`, where the page stacks several tables
of one shape and only the caption tells them apart: the Budgets forecast draws
one per currency, and with the captions hidden a sighted person met identical
columns of figures with nothing saying which money each was counting.

**Settled for captions and `scope`.** Every table in the client carries a
`<caption>`, and every header cell carries a `scope`. Four of the tables people
live in had neither — the register, the review queue, templates and recurrences
— while reports and budgets did. `SortableHeader`
(`src/client/components.tsx:57-104`) now emits `scope="col"` alongside its
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
identically. That check cannot see a cell that is not a `<th>` at all, which is
the shape the defect took, so `tests/table-row-headers.test.ts` asks the
question of the `<tbody>` instead: a table that heads one of its rows heads all
of them. The register renders two kinds of row into one body, and the staged
branch opened the payee column as a bare `<td>` while the committed branch a
hundred lines below opened it as `<th scope="row">` — one table, one column, two
markup branches, both green.

Neither of those asks *which* scope a header carries, and a `scope="row"` in a
`thead` would have passed both. `tests/table-column-headers.test.ts` asserts the
scope **value**: every column header of every `thead` is `scope="col"`, and no
body or footer cell is. `SortableHeader` is registered as a header component,
because its single `scope` is the only copy twenty-five of the product's column
headers have — which is also why a check reading call sites alone would see
almost none of them, and why the same register refuses a `SortableHeader` used
inside a `tbody`.

### 9.3 Numeric columns

**House, and it is ours rather than GOV.UK's.** A numeric column is **one
decision**: header alignment, cell alignment and `font-variant-numeric:
tabular-nums` travel together, applied through one class. GOV.UK right-aligns
both the header and the cell but applies tabular figures to the cell only; the
stronger rule is this product's.

Implemented: `className="align-right"` aligns, and the figures come from the
cell rather than from the class — `.data-table :is(th, td)` and
`.preview-table :is(th, td)` at `styles.css:870-886`.

**The selector said something narrower twice, and each narrowing lost a real
column.** It was `.data-table td.align-right` first, so a
`<th className="align-right">` — Reports and Budgets both have them — got the
alignment and not the figures: a header row of period totals that failed to
line up with the identical column beneath it. Keyed on `.align-right` it still
missed three things. 10.4 wants tabular figures on dates whether or not the
column is right-aligned, and **no date column in the product had them**. A money
table that is not a `.data-table` got none at all, which is the CSV preview.
And a cell holding nothing but a row of buttons was switching the feature on
for no digits, which is what stopped a grep for numeric columns from finding
them. `font-variant-numeric` touches digits alone, so naming every cell of
every table costs a column of words nothing and takes the decision off the call
site.

One loose end remains. `.amount` is declared as a money hook in the same rule
and is used by nothing; delete it or adopt it at the 78 `formatMoney` call
sites, some of which render currency outside a table in proportional digits.
`.money`'s weight and `white-space: nowrap` are still applied by hand, and the
case for making the money CELL a component rather than a class is the staged
branch of the register: a second hand-written `<td>` in the same file, 148
lines above the committed one, rendered the amount with no sign, no direction
color and no weight, directly above rows showing −$45.00 in red. That one is
fixed; what the fix does not stop is the next one.

*Checked by:* `tests/page-stack.test.ts`, which holds the figures to the cell
and holds `.align-right` to alignment alone. `tests/web-guide.test.ts` holds the
call-site count, because the size of the loose end is the argument for closing
it and a stale number argues for nothing.

### 9.4 Sorting

**House, already implemented.** `SortableHeader` and `SortMenu` are the only two
sanctioned sorting affordances. `SortableHeader` makes the whole `<th>` the hit
target, sets `aria-sort` on the `<th>`, sets `none` on inactive columns (ARIA
1.2 asks for `aria-sort` on one header at a time), and carries an `.sr-only`
sentence naming the current order and what activating will do.

Its `lean` prop is a real decision and is written down here because most systems
leave it implicit: **text columns start ascending, dates and amounts start
descending.** Somebody sorting by amount wants the largest first.

*Checked by:* `tests/sorting-and-grid-roles.test.tsx`, in three parts, because
ARIA 1.2's rule is about the table and no one of them reaches it alone:
`aria-sort` has exactly one writer in the client; every `SortableHeader` inside
one `<thead>` is handed the same sort state, which is the half a rendered test
cannot see — two states in one table renders two sorted columns and leaves each
page's own test green; and the component marks the active column and says
`none` on the rest rather than omitting the attribute.

### 9.5 Selection

**Binding, from `AGENTS.md`.** "Transaction and staged mass edits are atomic and
share one selection contract. Explicit rows carry expected versions; all-filtered
selections carry a server-issued count and `id:version` fingerprint."

The interface consequence: **the selection bar states the count and the scope,
and the two are different sentences.** "12 selected" and "All 4,318 matching
selected" come from two different code paths and the second must never be
produced by the first.

The mixed state is already handled. `SelectionCheckbox`
(`src/client/components.tsx:187-202`) takes an `indeterminate` prop and writes it
onto the DOM node in an effect, because React does not expose it, and all three
select-all checkboxes pass it: `TransactionBrowser.tsx:1073`,
`TemplatesPage.tsx:495`, `StagingPage.tsx:1025`.

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
`tabindex` is the rule, and a focusable region with no name is an unlabeled tab
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

### 9.8 Row actions

**House.** A row offers its actions one of two ways and there is no third. The
one or two a person repeats are icon buttons inside `.row-actions`; everything
else goes behind the `RowMenu` that sits after them. A row with only two actions
puts both in the menu and shows no icon at all.

The register is the full shape — Edit and Delete as icons, then a menu holding
Clone, Save as template and Save as recurring
(`src/client/TransactionBrowser.tsx:1352-1409`) — and the staged queue is the
same with Commit in front (`src/client/pages/StagingPage.tsx:1342-1386`).
Templates and Recurring have exactly two and put both in the menu
(`TemplatesPage.tsx:654-667`, `RecurrencesPage.tsx:316-329`). Nine
`.row-actions` and seven `RowMenu`s across the client say the same thing.

**Categories was a third shape and that is what this rule is for**: three bare
icons, no menu, in a product that already had two patterns and did not need a
third. It keeps Edit and Delete, which is what the two richest lists do, and
Archive moved into a menu — the action a person reaches for least often on a
category they are already looking at.

**The obvious alternative is "every action is an icon", and the register
disproves it.** Five icons in a table cell is a row of unlabeled glyphs a reader
has to hover to read, and the three that moved into the menu there are the three
that carry a sentence rather than a verb. The other obvious alternative, "every
action is in the menu", costs two clicks on the two actions every list uses most.

**A per-row destructive action is a trash icon, never a text button naming the
row.** `BudgetsPage.tsx:722-728` records the argument from the time it was one:
a column of buttons reading "Delete Groceries" in a row whose first cell already
said Groceries was the widest column on the table and said the name three times.
The name a screen reader needs is in the `aria-label`. Two cells were still text
buttons — the category group and the budget override — and are icons now.

**An action that runs with no dialog in between has to say so somewhere focus
can reach.** Archiving a zero-balance account is the only one on Accounts that
does, so the menu closed, the button went with the card, and focus fell to
`<body>`; it renders the sentence every other finished action on that page
already renders, and the sentence takes focus. That is 13.3 rather than a rule
of its own, and it is named here because the row menu is where it keeps
happening.

*Checked by:* `tests/row-menu.test.tsx` for the menu's dismissal and focus
return, and `tests/success-alert-focus.test.ts` for the sentence taking focus.
**Which actions are icons and which are in the menu is `human`** — it is a
judgement about how often a person reaches for each, and a test that counted
icons would only pin whatever is there today.

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
| `.row-menu-popover` | `styles.css:1867` | fixed |
| `.modal` | `styles.css:2543` | fixed |
| `.modal-header` | `styles.css:2576` | sticky |
| `.import-preview` | `styles.css:2727` | sticky |
| `.merge-panel` | `styles.css:3039` | sticky |
| `.nav-scrim` | `styles.css:4236` | fixed |
| `.mobile-header` | `styles.css:4246` | sticky |

`.merge-panel` was the live case. It exists because the list is long enough to
scroll, which is the same condition that puts a focused row underneath it. Every
scroll container holding a sticky element sets `scroll-padding-top` (or
`-bottom`) to at least that element's height.

There are two scroll containers, so there are two declarations: `html` carries
`scroll-padding-top: 80px` (`styles.css:321`), which clears the mobile header
and the merge panel alike, and `.modal-card` carries 64px
(`styles.css:2573`) for the sticky `.modal-header` inside it. The other six
regions are inside one of those two or are the container itself.

*Checked by:* `tests/page-stack.test.ts`, which pairs each sticky or fixed
selector with the container that must carry the padding, so a ninth sticky
region added with no container named is a failure rather than a row that
scrolls under something.

## 10. Money and dates on screen

The substance is in [`common.md`](common.md#money) and is not repeated. What
follows is only what a screen adds. In particular the arithmetic every figure
below rests on — that a monetary value is a string everywhere, that a
comparison is arithmetic and goes through `isNegativeMoney` or `compareMoney`,
and that pixels may be lossy and nothing else may — is settled there, as
`common.md`'s Money rules, and this guide points at them rather than keeping a
second copy that would drift.

### 10.1 The sign carries the meaning

**Binding, SC 1.4.1 Use of Color, level A, for the sign; and
[`common.md`](common.md#money) "A comparison is arithmetic" for how negative is
decided.** The minus sign is load-bearing and the color is decoration on top of
it. Which way a figure reads is a money comparison, so it is made where every
other money comparison is made.

**The code disagreed with itself in three ways, and the same withdrawal read
three ways in three places.** The table is what it was; the paragraph below it
is what replaced it.

| Where | Treatment |
| --- | --- |
| `DashboardPage`, `AccountsPage`, `ReportsPage`, `AccountDetailPage` | `money-negative` on the value, with Intl's own minus sign. Still the rule for a computed total, which has a sign of its own |
| `TransactionBrowser` | Colored and signed by transaction *type*, with a hand-prefixed `+` or `−` |
| `StagingPage`, `TemplatesPage`, `RecurrencesPage` | No color and no sign |

Page names without line numbers, for 12.2's reason: the table records a state
the code is no longer in — the queue's amount cell now colors and signs
through `movementSign` like the rest — and a line number into it could only
ever go stale.

One rule, and it is **direction** rather than the value's own sign: a stored
amount is always positive, because `AGENTS.md` keeps direction in the type. So a
deposit reads `+` in green, a withdrawal `−` in red, and a transfer is signed
but uncolored — money moving between somebody's own accounts is not spending.

`movementSign` (`src/client/money.ts`) is that rule, and five lists share it —
the register, the review queue, the templates, the recurrences and the import
preview.
The register already did this; the review queue, the templates and the
recurrences showed no sign at all, so the same withdrawal read three ways in
three places and one of the three did not read at all. The register may
additionally show direction through `.transaction-icon`, because a color and an
icon fail in different conditions.

**One asymmetry survives, deliberately.** An inbound transfer takes the deposit
color and an outbound one takes none. That is the register's own behavior and
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
"Net worth, $1,234.56", not "$1,234.56". A screen reader reading the number
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
tables (`DashboardPage.tsx:187` and `ReportsPage.tsx:335` were the offenders).
Instants go through `formatTimestamp(instant, timezone)`
(`src/client/money.ts:356-381`), whose zone comes from `useTimezone()`: the
activity log (`src/client/pages/ActivityPage.tsx:157`) and the connected-apps
panel (`src/client/pages/SettingsPage.tsx:619`) each rolled their own in the
*browser's* zone, so an audit trail read while traveling disagreed with the
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
`tests/locale-detection.test.ts` cover the arithmetic. A grep for
`toLocaleString`, `toLocaleDateString` and `Intl.DateTimeFormat` outside
`money.ts` and the two exceptions above would catch a *second* formatter, and is
still unwritten. `tests/raw-dates-on-screen.test.ts` is the inverse and is the
shape the defect took: no formatter at all. Five sites on the budgets page
interpolated a `YYYY-MM-DD` straight into an `.sr-only` caption or an
`aria-label` while the visible heading beside them read "June 2026" — so the two
surfaces of one panel disagreed, and the one that disagreed was the one nobody
looks at. Which fields count as dates is derived from what the client already
passes to a formatter rather than listed.

## 11. Charts

`src/client/charts.tsx` renders a line chart and a grouped bar chart. There is
no pie chart, which decides a question below.

### 11.1 Series against the background

**Binding, SC 1.4.11, level AA.** Every series color clears 3:1 against the
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
each other or the graduated lines". `.chart-grid` at `styles.css:3788-3796` is
correctly faint and says why; `.chart-zero` is correctly held to 3:1 because it
is where money in becomes money out, and says why.

*Checked by:* `tests/theme-tokens.test.ts` asserts one token per series in both
themes, that no two series in a theme share a value, and that every
`.chart-series-N` draws from its token. It checks uniqueness, **not contrast**;
two adjacent slices at 1.8:1 against the page would pass today.

### 11.2 Adjacent series

**Contested, and this is where the guide departs from the research behind it.**

The UK Government Analysis Function publishes a six-color categorical palette
where all adjacent colors clear 3:1 against each other, caps categories at four
as best practice, and treats five and six as "only when essential". Read
literally, that says this product should cut ten series to six.

This product keeps ten, on measured grounds recorded at `styles.css:3861-3873`.
The previous six-color set had a worst dichromatic pair of 1.78 in CIEDE2000
under simulated deuteranopia and protanopia, where the green and the pink were
the same color; the current ten reach 5.6 in light and 4.7 in dark. Going from
six to ten made color-blind separation better, not worse. The number of series
here is also not an author's editorial choice: it is how many accounts somebody
has.

**Where the source's rule does bite, and where the code failed it.** Measured
against each other, adjacent series pairs run from 1.05 to 2.09 in light and
1.19 to 2.03 in dark. Not one pair reaches 3:1. For the line chart that is
allowed by the Understanding document, quoted above. **For the grouped bar chart
it was not.** `BarChart` lays each series' bar at `index * barWidth` with no gap
(`src/client/charts.tsx:430`), so bars within a group touch, and `.chart-bar`
set `stroke: none`. Two touching bars at 1.05:1 had no visible boundary.

The fix was geometry rather than a repainted palette: `.chart-bar` now carries a
one-pixel `--surface` stroke (`styles.css:3817-3820`), which separates every
adjacent pair against the page they are drawn on and disturbs none of the
measured dichromatic separation the ten-color set was chosen for.

*Checked by:* `tests/theme-tokens.test.ts`, which asserts `.chart-bar` declares a
stroke and that the stroke is not `none` — the state it was in. The ratio
between two *series* tokens is deliberately not asserted: this section argues at
length that the ten-color set beats a compliant six-color one on the measure
that matters here, and a test demanding 3:1 between adjacent series would be a
test that contradicts the guide it is attached to.

### 11.3 A second channel that is not color

**Binding, SC 1.4.1, level A, plus the source guidance.** Ten categorical
colors cannot all be told apart under dichromatic vision, and no choice of ten
fixes that: the palette in 11.2 is the best available set and reaches 5.6 in
light, which is three times better than the six it replaced and still not enough
on its own.

**The remedy the CSS comment named has landed.** Nine of the ten line series
carry a `stroke-dasharray` (`styles.css:3922-3930`) and series 0 stays solid,
because that is what a single-series chart gets and what a plain line should look
like. A dash pattern is orthogonal to hue, which is the whole point: two series
that look alike to one reader are still two different lines. The patterns differ
in **rhythm** rather than only in length — a long dash against a short one is
easy to tell apart, a 6-4 against an 8-4 is not — and `stroke-linecap: round`
turns the one-unit dashes into dots, which is a third rhythm rather than a
defect.

**And the legend carries the same rhythm**, which is the half that was
backwards. `ChartLegend` renders the swatch with `aria-hidden="true"` and the
label as text, so a screen reader gets the label and a color-blind sighted
reader got only a block of color to match against a line. A swatch that shows
the line's pattern can be matched by shape. It is a repeating gradient rather
than a border, because the swatch is a `<span>` and has no stroke to dash, and
the stops are the dash arrays scaled to a 10px box so the two rhythms are the
same rather than similar.

Direct labeling is the other published answer, and both the Analysis Function
and Okabe and Ito recommend it over a legend for lines. Use it where a chart has
few enough series to fit labels; keep the legend where it does not.

*Checked by:* `tests/theme-tokens.test.ts`, which requires nine dashed series and
no two sharing a rhythm — two series on one pattern would put them back on color
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
table structure entirely. `ReportsPage.tsx:395-408` already does this correctly,
with a real table carrying an `.sr-only` caption and `scope` on every header.
`.chart-figure` uses `<figure>` and `<figcaption>`, which is the recommended
structure.

*Checked by:* `tests/chart-alternatives.test.tsx`, which derives the chart
components from `charts.tsx` — every export rendering a `.chart-figure` — and
asserts a real `<table>` beside each of their call sites, so a chart added on a
page nobody listed is covered. It also renders the categories report and holds
the table to the two properties named above, an `.sr-only` caption and a `scope`
on every header, since a table failing either is a grid of numbers rather than a
long description.

### 11.5 Pixels may be lossy

**Binding.** The rule and its two examples are in
[`common.md`](common.md#money). What this guide adds is the line reference:
`niceTicks` at `src/client/charts.tsx:95-135` is where the conversion happens,
and it is the only place in the chart code that is allowed to make one.

*Checked by:* `tests/client-money.test.ts`.

### 11.6 A series keeps its color when the visible set shrinks

**House.** A series' color is bound to its place in the full set, never to its
index in whatever subset is currently drawn. Colors were dealt by array
position, so excluding one category from the categories report recolored every
line and swatch after it — and the moment somebody most wants to compare before
and after is the moment everything changed clothes. `Series.paint`
(`src/client/charts.tsx:15-26`) carries the full-set position past the filter,
and the categories report assigns it from the unfiltered rows
(`src/client/pages/ReportsPage.tsx:329`); a chart whose set cannot shrink may
leave it out, because there position and identity are the same number.

*Checked by:* `tests/chart-alternatives.test.tsx`, which excludes the second of
four categories and asserts the survivors kept `chart-series-2` and
`chart-series-3`. Dealt by position they become 1 and 2, which is the recorded
defect exactly: with `paint` removed the test reports that pair moving.

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
query string, and `tests/count-link-range.test.ts` holds the one shape of this
rule a program can decide: a link whose text interpolates a count, landing on a
page that mounts a `DateRangeBar`, pins a preset unless the page it leaves has a
bar of its own to forward. Which pages are ranged is read off `App.tsx`'s
`<Route>` table and one hop into the component each route renders, which is how
`/transactions` qualifies through `TransactionBrowser`. The rest is review:
whether a link's text makes a promise is a reading of the text, and the
record-name links on Categories and Payees are the open case — their text is the
record's name and the all-time count sits in a badge beside them, so 11.7's
trigger does not plainly reach them. `allTimeSearch`
(`src/client/date-range.ts`) is in place if it is ever widened to.

### 11.8 Where a view choice lives

**House.** A choice about what the reader is looking at lives in one of three
places, and which one is decided by who the choice is *about*, not by what is
easiest to wire:

- **The URL**, when the choice defines the view itself: the range, the report,
  the grouping bucket, the archived flag. A report somebody sends somebody else
  is the report they were looking at (`src/client/pages/ReportsPage.tsx:142-143`),
  and 11.7's link rule only works if the filter has a query string to ride in.
- **Component state**, when the choice is a reading gesture rather than a view
  definition: the categories report's exclusions
  (`src/client/pages/ReportsPage.tsx:95-102`). Putting the one huge category
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

*Checked by:* `tests/api-fields-rendered.test.ts`, which derives the population
from the client's own declarations — the field names in `src/client/api.ts`'s
type bodies **and** the six shared Zod shapes it re-exports, which is the half
that hid the payee merge drop — and fails any field whose name appears nowhere
else in `src/client` and in no comment. The register is the comment itself, kept
beside the declaration rather than in a list, so the argument sits where the
next reader meets it. Twelve drops were argued that way when it was first run.
`tests/merge-outcome-from-result.test.tsx` holds the case this rule was written
from, at the other end: both merge panels are answered with a result naming one
source and a *different* target name from the request, so a sentence built from
the request reads differently from one built from the answer.

What a test cannot decide is whether a field that *is* mentioned is really
rendered, or whether an argued omission was restraint rather than oversight.
That half stays in 17.3.

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

**The reports page was the same omission at larger scale and is fixed the same
way.** Every row name on every report was a plain heading, on the page that
provokes that question more often than the overview does. `rowSubject`
(`src/client/pages/ReportsPage.tsx:43-48`) reads the destination off the payload
rather than off a second copy of the server's preset table: `accumulation` is how
`getReport` itself chooses the cell builder, so historical accumulation means
`balanceCells`, whose `key` is the account id, and the categories report means
`flowCells` with `byCategory`, whose key is `"<kind>:<categoryId>"`. Deriving it
from the report *name* would have been that second copy, and it would go wrong
the first time a report changed accumulation.

**Three kinds of row link nowhere, and the rule's first condition is why.**
Income and expenses buckets by kind alone, so its key is the word "income"; cash
flow's keys are segments of an arithmetic; and an uncategorized row is the
absence of a category, so `/categories/uncategorized` is the 404 this rule
already names.

**Two conditions.** The link appears only where there is something to link to:
the uncategorized row has a null id, because it is the absence of a category
rather than one of them, and `/categories/null` is a 404. And a linked name
inside a row takes the row's own color rather than the global anchor green,
greening on hover — the treatment `.account-mini-row` already had and
`.spending-row` did not, or the name reads as a second green thing beside a
green bar.

*Checked by:* `human`. Whether a figure has a subject worth linking is a
judgement; what a test could catch — that the link carries the search string —
is 11.7's, and `tests/count-link-range.test.ts` catches it only where the link's
text is a **count**. A named figure is not one, so these links are still outside
it. That is a scope the check states rather than a gap it hides: widening it to
every link that interpolates anything would fire on every row of every table.

## 12. Empty, loading and error states

Research found no primary source on empty-state categories, on when to show a
spinner versus a skeleton, or on how long before either. Carbon's and Polaris's
pages could not be retrieved. So this section is reasoning, not citation, and it
is labeled accordingly.

### 12.1 Four states per list

**House.** Every list has four states and they are four different screens:
loading, empty because nothing exists yet, empty because nothing matches the
filter, and error. "No transactions yet" and "No transactions match this view"
are different sentences with different next actions, and collapsing them is the
most common way a list lies to somebody.

**The four states are states of the page's BODY, and nothing said so**, so six
pages wrote `if (query.isPending) return <Skeleton/>` at the top of the
component and took the header, the eyebrow, the tab strip and the back link
down with it. `document.title` is set inside `PageHeader`'s effect, whose own
argument is that two windows of this app are otherwise indistinguishable in a
task switcher — so a fresh tab on `/accounts/<id>` read the bare product name
until the query resolved and forever if it failed, with no `h1` and no way back
to the list. The plan tab was the sharpest: its error branch dropped
`SettingsTabs` too, leaving an alert saying "Reload the page to try again" on a
screen that had removed its own navigation. A page renders its header, its tab
strip and its back link **before** any of the four, and the eyebrow waits for
the name rather than repeating the generic word beneath it.

**Which of the two empty screens to show is one function, not a boolean each
page writes.** `src/client/list-filters.ts` takes the narrowing controls the
reader can actually reach and returns the screen plus the ways out of it, and
the argument for one place is the same one `AGENTS.md` makes about
`resolveEntrySide`. Every page counted a different set before it. The register
counted the page's own SUBJECT — `fixedCategoryId`, `fixedTemplateId`,
`fixedPayee` and `fixedAccountId` went in beside the search box — so a category
created a minute ago was told to "clear the search and filters above", with
nothing above to clear because the Account select is not rendered when the page
is about one account. The subject is not passed to that function at all, which
is what makes "the subject is not a filter" true by construction. Three pages
had it the other way: Categories split on `search.trim()` and ignored the
archived toggle beside it, and Templates and Recurring blamed the search to
somebody who had only used the Type select.

**A control that is in force before anybody touches it names a way out without
making the list narrowed.** Hiding archived rows is the only one in the
product, and counting it would make "nothing yet" unreachable on the two pages
that have one — this rule's own failure from the other side. Those two read
three ways rather than two: nothing set at all, only the default in force, and
a filter the reader set.

**The check asked this of four pages until 0.2.0, and the four were the ones
already right.** It named them in an array, on the reasoning that whether a list
can be filtered is a fact about its controls rather than something to derive —
which is true, and is why four attempts at deriving it produced four false
positives. The answer was not a better pattern but the opposite shape: ask every
page that renders an empty state, and name the exceptions with the argument.
Payees and Accounts had been collapsing two situations into one message the
whole time, and Payees was telling somebody who had mistyped a search to go and
commit a transaction they had already committed.

The title states the situation in the plural, the body carries the explanation,
and the button carries the imperative. **`EmptyState` is used at 23 sites**, and
that is the one count this section keeps: it said sixteen in one paragraph and
eighteen thirteen lines later, which is the two-numbers-for-one-measurement
failure section 3's census test was built to stop, inside a single section.

Two amendments have landed. **The icon is required.** It was optional and three
sites omitted it, which left a heading and a sentence floating in a card — a
page that reads as having failed to load rather than as having answered. **And
the heading level is a prop**, defaulting to `<h3>`, because a component that
hard-codes one misstates the document wherever it is used: the duplicate
review's "nothing left to review" *is* the page's content and takes `level={2}`.
Same reasoning as `ErrorSummary`'s in 8.3.

**The icon's SIZE is the component's too.** It was an opaque `ReactNode`, so
the size was written at the call site and came out five ways — 20, 22, 23, 24
and 25 — varying by a quarter inside a tile that is a fixed 48px either way, on
pages one click apart. It is a component type now and
the size is not something anybody types. And a `compact` variant exists for a
list inside a panel: the full card is `min-height: 250px`, which inside the
dashboard's per-currency panels would be the tallest thing on screen saying the
least, and that is why six such lists answered with a bare muted paragraph
instead — putting all six outside this section's check as well as outside its
look.

*Checked by:* `npm run typecheck`, which is the whole check for the required
icon and is why making it required was worth more than a test — the three sites
that omitted it were three compile errors. `tests/ui-copy.test.ts` holds two
more: that every **list** rendering an empty state decides the screen through
`emptyScreen` or is named with a one-sentence argument for why it has no
question to ask, and that an empty state sits *behind* its query's error rather
than beside it. `tests/app-name.test.tsx` holds the page half: a page
component's first JSX return has to carry its header. And
`tests/web-guide.test.ts` holds the site count, which is the part that came
apart twice inside one section.

**The first of those was asked per FILE until 0.2.0, and let a file off for
having two `<EmptyState>` elements**, on the reasoning that two elements say the
same thing as one conditional. They do — but the short-circuit skipped the whole
file, so Categories sat outside the check entirely while its condition ignored
the archived toggle, and one `emptyScreen(` anywhere in a file excused every
other list in it. An opt-out that costs nothing is taken by accident. It now
asks the question of each of the 23 elements, keyed by file and by the longest
literal in its title — not the first, because the register's title expression
carries a `"0"` out of `compareMoney` — and the register is keyed the same way.
Four lists were being excused by one file-level row each: the Categories groups
table and all three on Budgets.

`tests/register-ways-out.test.tsx` holds the register's three screens where only
a render can see them, because `tests/ui-copy.test.ts` reads the `emptyScreen`
call's own text and says so. The register is the one list in the product whose
default hides rows before anybody touches a control — "Show deleted" ships off —
so it reads three ways, and somebody who had deleted everything matching the
view was told "No transactions yet".

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

Today it is twenty-four `Skeleton` sites and four paragraphs. The last two are
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
not where the skeleton is used. `tests/web-guide.test.ts` holds the two counts
in this section, which is the number 17.2 item 6 reads rather than recounting.
`tests/loading-paragraph.test.ts` is the grep that was missing: the population
is every `<p>` in the client whose own text says it is waiting, the four that
survive are a register keyed by file and sentence rather than by line, and the
register fails in both directions — a fifth paragraph, and an entry excusing
one that has become a skeleton. It also holds the `role="status"` those four
owe.

### 12.3 Busy controls

**House, settled.** A working `Button` is `aria-disabled`, never `disabled`, and
says so: `aria-busy` while it works and an `.sr-only` "Working…" beside the
spinner (`components.tsx:359-392`). Not `disabled`, because a browser blurs an
element it disables, so a button that disabled itself for its own request let go
of focus the moment it was pressed (13.3); the click is swallowed instead. A
spinner is a picture of waiting, which is nothing at all to somebody who cannot
see it, and a busy button otherwise goes silent at exactly the moment a person
most wants to know their click landed. See section 4 for the reduced-motion half
of the same defect.

**The spinner takes the icon's place, and only the work that is running spins.**
Drawn beside the icon, the spinner and its gap made every button with an icon
24px wider the moment it started working, and a row of them reflowed on the
click: on the staged queue Commit selected and Delete selected both grew while
a commit ran, which moved every button in the selection bar and rewrapped the
count. So a busy `.button` hides its own icons
(`styles.css:811-813`) and keeps its width; a button with no icon still gains
the spinner, because there is nothing for it to stand in for. And both of those
buttons spun, because one mutation runs both actions and each asked only
whether it was pending — Delete selected showed a spinner for the whole of a
commit, on the button that destroys rows. Where one mutation serves several
buttons, each asks *which* action is running
(`loading={pending && variables === "delete"}`,
`src/client/pages/StagingPage.tsx:963`) and the others are held, which is the
pair the census below exempts.

*Checked by:* `tests/browser/selection-bar.spec.ts`, which presses Commit with
the request held, asserts the button is the width it was, and that Delete is
held and not busy. Mutation-proved both ways: the spinner beside the icon fails
it by 24px, and a bare `loading={pending}` fails it by name.

**A disabled submit always says why, next to itself.** Thirty-six controls
are disabled on a computed predicate and one had a sentence beside it — the
split remainder line, which is the model the rest now follow. It is the one control
that can go completely silent: nothing has been typed wrongly, so there is no
field error, and nothing has been submitted, so there is no summary. The button
is gray and the person guesses which of the form's conditions is unmet.

`Button` takes `disabledReason`, rendered only while `disabled` is true and
`loading` is not — a button that is working already says so, and a reason for
that state would be a second answer to a question already answered. Wired with
`aria-describedby` rather than left as a neighboring paragraph: a sighted
person reads what is beside the button, and somebody on a screen reader is told
the button's name and its state and then has to go looking. The reason is added
to a description the caller already gave rather than replacing it: the plan
tab's pay button is described by the renewal terms, and it is disabled while
Stripe's form loads, which is when somebody is reading them.

Two things about it worth knowing, because both were the obvious version being
wrong. **The reason names the first unmet condition, not all of them** — a
person reads down a form and wants to know what to do next. And **the wrapper is
unconditional**, `display: contents` until it has a reason to show: wrapping only
when a reason exists remounts the button as the reason comes and goes, which
takes focus off it at the moment it becomes usable, which is the defect 13.3 is
about.

*Checked by:* `tests/field-contract.test.tsx`, which holds the behavior — shown
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
the client properly found fourteen more, every one a control that went gray and
said nothing — twenty-two then, **36 today**, which is the number this section
keeps and the one the census reports. The exempt ones live in the four files
`WORKING_NOT_BLOCKED` names: the unpressed half of a pair, grayed while its
sibling works, where the answer is the sibling's spinner. The newest is the
staged queue's Delete selected, held while a commit runs — the busy state
below says why it is held rather than drawn as working.

**A button that can be disabled for two reasons gives the one that applies.**
The census above asks whether a reason is *present*, so it drops a tag the
moment it finds a `disabledReason` -- and the buttons that have one are
therefore the buttons it never looks at again, `WORKING_NOT_BLOCKED` included.
The plan tab's two were both: each is `disabled={its own refusal || anyPending}`
and each handed over a reason computed for the first half alone. Pressing
Monthly with no subscription at all disabled Annual and described it, through
`aria-describedby`, as "You are on the annual plan already." A reason beside a
sibling's spinner was already the thing this section forbids; a *false* one is
that plus a sentence nobody can act on. So where the predicate is compound and
one half of it is a busy flag, the reason is withheld in that half --
`annualButton.disabled ? annualButton.reason : undefined`
(`src/client/pages/PlanPage.tsx:1978`), never the bare expression.

*Checked by:* `tests/field-contract.test.tsx` ("withholds the reason where a
busy flag is what disabled the button"), which reads the compound predicates the
census already collects and fails on a reason handed over unconditionally. It
was mutation-proved against the defect it was written for: restoring the bare
expression fails it by name and prints the line.

**Where the reason sits decides whether the row still lines up.** The reason is
a line under its button, so the wrapper showing one is the tallest thing in its
row, and a row that centers its items centers every neighbor in that height:
half the reason lower than the button beside it, 8.5px with a one-line reason
and 15px with a two-line one on a phone. The plan tab showed it on every visit,
because one of its two plan buttons is always disabled with a reason. Two
shapes answer it, and each is wrong for the other row. A form's action row and
a modal's footer line up on the tops while a reason is showing
(`styles.css:764-767`): every `.button` is `min-height: 39px`, so equal tops are
equal midlines, and a line of text in such a row is given a button's height to
center in so it keeps the line it had (`:769-773`). Only while a reason shows,
because a row without one is centered correctly and lining it up on the tops
would lift that text off the buttons' midline. A wrapping toolbar — the bulk
actions and the selection bar — drops the reason to a line of its own beneath
the whole bar instead (`:744-755`), because there the wrapper is as wide as its
sentence and would pull the button out to match.

**Dropping the sentence was not enough, and this section said it was.** The
line drops only inside a group that has a width of its own to wrap in, and the
selection bar's actions took theirs from their content, never shrinking. A
wrapping group's content width counts everything it holds as though on one
line — so the sentence, moved below the buttons, still inflated the group to
the buttons plus 400px. Selecting across pages on the staged queue with a
duplicate among the rows did it on every visit: the actions ran out past the
bar's right edge, cutting the checkbox to "Co", the count beside them was
crushed to one word a line, and its icon shrank to nothing. Ticking the box
enabled Commit, the sentence went, and the bar came back — which is what made
it look like a checkbox bug rather than a layout one.

The fix is a basis that nothing in the group can inflate
(`styles.css:2029-2032`): the count takes the width it needs, the actions share
its line only while 30rem of it is left, and below that the bar wraps and the
actions take a line of their own (`:1963-1969`). The obvious alternative was a
zero basis, and it was tried: the count kept its line and the actions were
starved instead, squeezed into one column under about 1050px with labels
wrapping inside their buttons. The bar lines up on the tops with the count
given a button's height, for the same reason as the form row above — the
actions can grow a second line, and a centered count would float between the
two. Until this was measured, the stylesheet carried a long and accurate-sounding
comment about this exact sentence in this exact bar, and this section cited it
as the answer. The comment was right about the cause and wrong about the cure,
and nothing could tell the difference without a browser.

*Checked by:* `tests/browser/selection-bar.spec.ts`, which seeds more than a
page of staged rows with duplicates among them, selects all of them, and
measures the bar in three states — the reason showing, the duplicates allowed,
and a commit held in flight — at nine widths from 1440px to 390px. At each it
asks that nothing runs past the bar's edge, that the count is on one line
wherever one line fits, that its icon keeps its size, that no button's label
wraps inside the button, and that a count sharing a line with buttons sits on
their midline. Mutation-proved against the original rule (overflow at
1440px), the zero basis (a wrapped label at 820px) and a centered row (22px
off the midline).

*Checked by:* `tests/plan-page-ui.test.tsx` ("the plan buttons' row"), which
reads the stylesheet and asserts the rule, that it is conditional, and the
text's height — and it cannot see the offset itself, because jsdom has no
layout. **The offset is held by `tests/browser/plan-buttons.spec.ts`**, which
measures the two buttons' tops against a real engine at desktop width and again
at 390px where the reason wraps to a second line, and asserts the disabled one
is disabled first, because two enabled buttons also line up. It cites this
section as the gap it closes, and `code/testing.md` §1.2 records it as the
second file in that tier and why it is there. So a later rule on these rows
cannot bring the lift back with the suite green, which is what this paragraph
used to say it could.

### 12.4 One live region per page

**House.** A page has one polite live region, `role="status"`, for
confirmations and progress, and reaches for `role="alert"` only for something
time-sensitive that interrupts.

Announcement is already handled: `Alert` sets `role={kind === "error" ? "alert"
: "status"}` (`src/client/components.tsx:1466`), so a success alert is a polite
live region and an error alert interrupts. The two real defects are elsewhere.
There are two separate `aria-live="polite"` regions in the client
(`components.tsx:271`, `:1273`), so a page can carry three polite regions at
once and nothing decides which speaks first. It was four in three files until
the selection bar became `SelectionBar`: the register and the templates list
each carried a hand-written copy, and the staged queue's bar — the one list
where selecting everything stops at the ten-thousand cap — carried no live
region at all. Making it a component did not settle 12.4, but it did take the
count from four to three and put the one that was missing inside the rule. And
a success alert persists until the next render, with no rule for how long it
stays.

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

The four leaf guards stay, because each keeps a specific screen *useful* rather
than merely non-blank, and this is the backstop for everything nobody
predicted. They are named one by one because the list had drifted and read as
though it had been checked:

- **`theme.ts` catches** (`theme.ts:33-38`): a machine with no `matchMedia`
  counts as light rather than throwing the shell away.
- **`money.ts` catches, twice, and guards as well** — this is the one the list
  used to leave out. `formatMoney` renders `amount currency` when `Intl`
  refuses a symbol (`money.ts:140-142`), `formatTimestamp` falls back to the
  browser's zone when the stored one is unknown (`:369-379`), and both check
  `Number.isNaN` first, because an unreadable value is not an exception.
- **`idempotency.ts` feature-checks** `crypto.randomUUID` and builds a v4 by
  hand where there is none (`idempotency.ts:16`), since that API exists only in
  a secure context.
- **`timezone.tsx` does neither, and that is the correct shape for it**
  (`timezone.tsx:20`). There is nothing to throw: a missing provider is a
  missing context value, so `??` falls through to the browser's zone. The list
  used to call this one a catch, which is how a guard that could never fire
  would have been left in place by anybody tidying.

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
  block at `styles.css:4436-4445` freezes it into a bar that reads as stuck.
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
  work is never canceled because a browser went away, so the outcome is
  genuinely unknown and the page says exactly that instead. `writeDidNotHappen`
  (`src/client/api.ts`) is the one place the two are told apart, because a page
  that guessed would guess wrong in the direction that matters: telling somebody
  their four thousand rows did not post when they did.
- **The threshold at which a bar earns its row of layout is
  `PROGRESS_STREAM_MIN_ROWS`** (`src/shared/domain.ts:1291`), not a literal in a
  page. Fifty is a judgement rather than a boundary in nature — below it the work
  is over before a bar could be read, and a bar that flashes is worse than none.
  It sits under the cap `AGENTS.md` fixes: "Ten thousand rows is the cap, and it
  is the same number everywhere: a mass edit, a mass delete, a commit, and a CSV
  import."
- **Binding, SC 1.4.11.** The fill is `--green-fill` on `--track`, measured in
  2.2, and the bar keeps the `--line-strong` edge 2.2 requires of a control.
- **Three bars now, and a fourth has to say which of them it is not.**
  `.progress-track` (`styles.css:1557`, `DashboardPage.tsx:273`) is a decorative
  share-of-total meter under a row that already states its figure.
  `.budget-bar` (`styles.css:4142`, `BudgetsPage.tsx:1229`) is money, with an
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
across a phase change and the threshold below the bulk cap. **That the bar is
*painted* is now covered**, by `tests/browser/progress-paint.spec.ts` in the
browser tier, in both themes: filing it as review was itself the defect,
because the one tier built to catch it was never asked.

**It is measured from the painted image, and the mechanism this guide proposed
does not work.** `getComputedStyle(element, "::-webkit-progress-value")` does
not resolve that pseudo-element in Playwright's Chromium — it answers with the
*element's* own computed style, so it reports `--track` for the fill and would
pass a stylesheet with both vendor rules deleted. `::-moz-progress-bar` comes
back blank from the same call, which is what an unrecognized pseudo-element
does, so the webkit one is accepted and then ignored. The spec screenshots the
element, decodes it with `sharp`, and samples a pixel either side of the value:
deleting `.progress-meter::-webkit-progress-value` leaves Chromium's own
`rgb(0, 128, 0)` in the bar, which is neither the brand green nor a color that
answers the theme, and the check names it. Sampling also sees the clipping case,
which no computed style could.

## 13. Focus and keyboard

### 13.1 The indicator

**Binding, SC 1.4.11 for the contrast; House for the composition.** The focus
indicator is two colors so that one of them always contrasts, which is GOV.UK's
reasoning for pairing yellow with a thick black border. `--focus-ring` and
`--focus-inner` already are that pair, and `--focus-ring` measures 5.08:1 light
and 9.70:1 dark against `--surface`. The reasoning is recorded here so a future
simplification to one color reads as a regression rather than a tidy-up.

Meeting SC 2.4.13 Focus Appearance (level AAA) is cheap here, a 2px perimeter at
3:1, and meeting it does not move the target.

*Checked by:* `tests/contrast.test.ts`, which derives both ratios from the
palette and holds them to the two figures printed above, read out of this
sentence rather than copied — so a token that moves fails naming the row to
update, and so does a figure edited here that the palette does not support. It
was the precision that was unheld rather than the criterion: the check beside it
asks only that the pair clears 3:1, and `--focus-ring` can fall to 4.02:1 light
while that stays green. The pointer this replaced sent a reader to 17.2 item 1,
which is the spacing and radius scales.

### 13.2 `:focus-visible`, and what it covers

**Binding, SC 2.4.7 Focus Visible, level AA.** Every focusable thing shows a
focus indicator.

**The code covered two element types out of the set**, and three of the gaps
were live SC 2.4.7 failures. `summary` is the `RowMenu` trigger
(`components.tsx:910`) and fell to the user agent default; checkboxes and radios
got only `accent-color`; and `.file-drop`'s `<input>` is visually hidden, so
tabbing to the CSV file picker showed nothing at all.

One rule now covers the set (`styles.css:1029-1039`):
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
  `RowMenu` returns focus itself. The half that was missing is a **control whose
  own success removes or disables the control**. That is the shape, and stating
  it as a shape is the amendment: it was written here as a count of pages —
  "the three pages that unmount their own button and on the plan tab" — so it
  was applied to the four instances somebody had counted and **three more of
  the identical shape shipped afterwards**. The staged queue's Commit selected
  and Delete selected empty the selection, which unmounts the bar and the
  button, and wrote no notice at all because the page's only notice was set by
  the bulk EDIT modal. The merge panels on Payees and Categories empty the
  participant set, and the panel renders only at two or more, so the button
  goes and the only `Alert` in either was the error one — a merge of nine
  spellings reported nothing. And `Pagination` disables every page number and
  both steps while a page turn is in flight, which is the next bullet's case
  one level down and the only one of the three no per-page edit can reach,
  because the control belongs to the component.

  Focus lands on the sentence saying what happened — `Alert` takes an opt-in
  `takeFocus` — or, where the control comes back, on the control itself:
  `Pagination` remembers which one was pressed and returns focus to it when
  `busy` clears, falling back to the page number that is now current when the
  step it came from has gone disabled. That is both the thing somebody
  wants to read and the place their next Tab should start from;
  `role="status"` already announces it to a screen reader, and this is for the
  sighted keyboard user, who is announced nothing. Opt-in because most alerts
  render beside a control that still exists, where moving focus away would be
  the defect rather than the fix.

  **A button that disables itself while it works has let go of focus too**,
  which is the case the plan tab found. The button survives, but a disabled
  element cannot hold focus, so the browser blurs it as the request starts and
  focus is on `<body>` when the answer arrives. Every button on that tab is one,
  so every result there — a payment, a saved payment method, a refusal, and a
  change that needs no payment, such as canceling or scheduling a switch — is a
  sentence that takes focus, worded after the plan has been read again so any
  date in it is the new one (`src/client/pages/PlanPage.tsx:84-100`). **A form
  that opens from a press takes focus as well**, because the button that opened
  it has gone or let go: the payment panel is a labeled region with
  `tabIndex={-1}` (`PlanPage.tsx:1722-1727`), focused whenever a new form mounts
  (`:1127-1130`), and the region rather than its heading for the reason `<main>`
  is the target on a route change. Neither moves focus on a page load. Coming
  back from a bank's confirmation page is a fresh document, and its sentence is
  announced by its role and left where a reader finds it.
- **The mobile drawer.** An `<aside>` toggled by an `.open` class is not a
  dialog, so opening it left focus on the hamburger and Tab walked the page
  behind the scrim. The column behind it now carries **`inert`**, which is the
  platform's answer: it takes the whole column out of the tab order and out of
  the accessibility tree in one attribute, where a hand-rolled trap has to
  enumerate what is focusable and be wrong about the next thing somebody adds.
  The scrim stays outside that column on purpose, so Escape is not the only way
  out. Focus moves in on open and back to the hamburger on close, and Escape
  closes — the three things a `<dialog>` gives for nothing. The hamburger says
  which state it is in with `aria-expanded` and names the drawer with
  `aria-controls`.

  **Two ways that came undone, both found by the 0.2.0 sandbox smoke test.**
  The drawer's `visibility` was transitioned, and a transitioned `visibility`
  holds its old value until partway through, so at the moment the effect asked
  the close button to take focus the drawer was still hidden and focus stayed
  on `<body>`. Opening now makes it visible at once and only closing waits for
  the slide (`src/client/styles.css`, the 780px block). And following a link in
  the drawer closed it after the route change had already put focus on
  `<main>`, so "back to the hamburger" took focus straight out of the page that
  had just been asked for. A close caused by navigating away leaves focus
  where the route change put it (`src/client/App.tsx`, `closingForNavigation`).

  **The dialog semantics are conditional, and have to be.** The same `<aside>`
  is the permanent sidebar above 780px, so marking it a modal unconditionally
  would announce a visible navigation landmark as one. Rather than read the
  width in two places, the drawer closes itself when the media query stops
  matching — which also fixes opening it and then widening the window, which
  used to leave a scrim over a page nobody could dismiss.

Modals were already correct: a native `<dialog>` driven by `showModal()` and
`close()`, labeled by `aria-labelledby` from a `useId()`, with `onCancel`
intercepted (`components.tsx:931-981`), and with the form body mounted only while
the dialog is open so closing discards what was half-typed.

*Checked by:* `tests/shell-focus.test.tsx` for all four. Its population used to
be a hand-kept array of three files while seven more had grown the same shape,
which is the listing failure this rule has now suffered twice; it derives two
shapes from the product instead — every `<SelectionBar>`, and every panel gated
on two or more selected rows — and counts per surface rather than per file,
accepting a `takeFocus` `Alert` or a ref that returns focus.

All three of the 0.2.0 defects fell outside both shapes, so
`tests/success-alert-focus.test.ts` derives a third from the **answer** rather
than from the trigger: every `<Alert kind="success">` in the browser takes focus
or is named with the reason it does not. A success alert exists to report a
finished action, which is the moment this rule is about, and every one of the
seven defects showed up as one. `tests/client-success-focus.test.tsx` then
renders the three the source check cannot speak for — the account chooser in
both its branches, the duplicate queue's last drop, and both auth panels —
asserting for each that the sentence carries `role="status"` and that
`document.activeElement` is that sentence rather than `<body>`.

**A button that works keeps focus, which settles what this register left
open.** `Button` rendered `disabled={loading || props.disabled}`, and a browser
blurs an element it disables, so after *any* pending submit focus was on
`<body>` whether or not the control came back. The 0.2.0 sandbox smoke test
found it on Add category, Stage all rows and every "create another". While
`loading`, `Button` is now `aria-disabled` and never `disabled`, whatever the
caller passed beside it, and swallows its own click — which also stops a
form's implicit submission, since the browser delivers that as a click on the
default button. It keeps focus, `aria-busy` and the spinner say it is working,
and the four in-form success alerts no longer rest on the argument from
reading order this paragraph used to record.

**A sentence confirmed in a dialog takes focus once the dialog has gone.** The
work a confirmation dialog starts finishes while the dialog is still open, and
a modal dialog makes everything outside it inert, so the `takeFocus` sentence
cannot take focus as it mounts; closing the dialog then hands focus back to the
button that opened it, which the work removed. A bulk edit's "N transactions
updated." landed focus on `<body>` exactly that way. `Alert` listens for the
open dialog's `close`, which fires after the dialog restored focus, and takes
focus there. A single delete and restore now say what they did in the same
notice, and a refused row action on Categories or Accounts names the record and
takes focus beside the notices rather than appearing at the top of the page.

*Checked by:* `tests/field-contract.test.tsx` (a working button keeps focus and
submits nothing), `tests/shell-focus.test.tsx` (the sentence takes focus again
on the dialog's `close`), and `tests/browser/smoke-test-fixes.spec.ts`, which
holds all of it in a real browser: the drawer's focus on open and after a link,
a single delete, a bulk edit, a refused delete, and a busy button.

`tests/browser/budgets.spec.ts` holds
the two halves only a browser can see — that pressing the skip link actually
moves focus into `<main>`, and that following a navigation link lands focus on
the page it opened. jsdom has neither layout nor fragment navigation, so it can
say the link exists and nothing about whether it works, which is exactly the
split section 1.1 of `testing.md` is about. `tests/modal-layout.test.ts` pins the
dialog centring and `tests/row-menu.test.tsx` covers the menu's dismissal.
`tests/plan-page-ui.test.tsx` holds the plan tab's half: "after the form is
confirmed", "a saved payment method", "a refused change of plan", "a change
that needs no payment" and "a form that opens" each focus the button first,
press it, and assert where `document.activeElement` lands, and "a return from a
redirect" asserts that a page load moves nothing. The keyboard pass in section
14 remains a person's job.

### 13.4 Target size

**Binding, SC 2.5.8 Target Size (Minimum), level AA.** 24 by 24 CSS pixels,
subject to the spacing exception: if a 24px circle centered on each target's
bounding box does not intersect another target's circle, the target passes.

This is already solved, deliberately. `.icon-button` is 31 by 31
(`styles.css:2601-2612`) with an `::after` at `inset: -7px` giving a 45px hit
area without growing the row, and a comment saying why
(`styles.css:2286-2290`). **That is the house answer for a dense-row control.**

The spacing exception never has to be reached here. It applies only to targets
under 24 by 24 CSS pixels, and `.icon-button` is 31 by 31, so it passes on size
alone and no spacing constraint follows. The exception is what would govern if a
control ever dropped below 24px, which is the reason to know it exists — and
the row checkbox is exactly that, 15 by 15 by the stylesheet's own rule, so the
spacing branch is reached there and nowhere else.

*Checked by:* `tests/browser/target-size.spec.ts`, in the browser tier and not
in jsdom, which is the correction §17.2 item 7 already made for the progress
bar. A source read gets as far as `width: 15px` and can reason about row
padding; whether two 24px circles intersect on a row that has wrapped needs a
layout engine. The spec measures every interactive target at desktop width and
at 390px and applies both branches of the criterion — 24 by 24 outright, else
centers 24 pixels apart — with the criterion's own exclusions and no exclusion
for being small.

### 13.5 The browser tier

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
- Anything whose failure mode is "the element is correct and the behavior is
  not".

What does not: rules about markup, which jsdom checks faster; anything a
structural test can read out of the source; and coverage for its own sake. A
browser test costs seconds and a database, so the tier stays small and every
spec in it earns its place by naming the class of defect it catches.

**There are two specs, not one.** This section and 17.1 both described a
one-file tier after the second file landed, which is the kind of claim that
makes a reader reach for jsdom for something jsdom cannot see — 12.3's offset
between two buttons being exactly that, and exactly what the second spec
measures. How many there are, what each is for, and why the second is here
rather than in jsdom are
[`code/testing.md`](code/testing.md) §1.2's to state, held by
`tests/testing-guide-counts.test.ts` against the directory. This guide points at
that count rather than keeping one of its own, because a tier size written down
twice is a tier size that disagrees with itself.

*Checked by:* `npm run test:browser`, which requires `BROWSER_DATABASE_URL`
pointing at a throwaway database. It is deliberately not part of `npm run verify`:
that command runs with `TEST_DATABASE_URL` blank on purpose, and a tier needing
three processes does not belong in the fast gate.

### 13.6 A link that leaves the app

**House.** Five anchors in this product point at a document the operator
configured and this deployment does not serve: `LegalLinks`, which both the
sign-in screen and the sidebar render (`App.tsx:127`, `:132`); the sign-up
acceptance sentence (`:164`, `:170`); and the terms in the plan tab's renewal
paragraph (`PlanPage.tsx:577`). They are the only anchors written in
`src/client` with a destination outside this app — every other one is a literal
route, or `Link`, which builds its href out of the router's own location. The
rule has three parts that belong together because each of them was written
three different ways before there was a rule.

- **It opens a new tab**, `target="_blank"` with `rel="noreferrer"`. This is the
  part that is argued rather than conventional: both documents are read
  *partway through something a person should not lose* — a sign-up form half
  filled in, a plan about to be paid for — and a same-tab navigation discards
  it. The alternative is the usual advice, which is that a link should not
  decide where it opens; that advice is about links in prose, and these two
  appear beside a submit button.
- **A document the operator did not configure is absent, never present and
  dead.** `privacyPolicyUrl` and `termsOfUseUrl` are optional, so each anchor
  renders only when its own URL is set, and the sentence around it changes
  shape rather than naming a document that is not there
  (`App.tsx:123`, `:160`, `PlanPage.tsx:573-582`). A link to nothing is worse
  than no link: it reads as a promise the deployment has made.
- **The new tab is not announced**, and this is the one most reviewers will ask
  to change, so the reason is here rather than waiting to be rediscovered.
  Warning about a new window is SC 3.2.5 Change on Request, **level AAA**, and
  this product's stated conformance target is AA. Meeting a AAA criterion
  because it is cheap is something this guide does elsewhere (13.1); this one is
  not cheap in the only currency that matters here, which is the sentence a
  screen reader reads: "Privacy policy, link, opens in a new tab" on five links
  in two places, to say something every modern screen reader already announces
  from the attribute itself. If the target ever moves to AAA, this is the first
  rule to revisit.

**Any further operator-configured document lands in exactly this shape**, which
is why this is a rule and not a note about two URLs. The wire already carries
both as optional fields and nothing stops a third.

*Checked by:* `tests/legal-links-ui.test.tsx` renders the real screens and holds
the behavior — both links present when both are set, the sentence reshaped when
only one is, nothing drawn when neither is, and `target` and `rel` on each.
`tests/web-guide.test.ts` holds the population, which is the half a rendered
test cannot. It takes every anchor in `src/client` whose `href` is not a
literal route, excluding `Link` and `SettingsTabs` by name because theirs is a
route by construction and no pattern can say so, and requires the attributes and
the silence of all of them. So a sixth is inside this rule by construction
rather than by somebody remembering to add a case, which is 17.2's first rule
about where a check gets its population.

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
`body` both set `min-width: 320px` (`styles.css:312-331`).

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
- **A responsive remedy belongs at base, or in every band it is needed, and
  the band to check is the one above 780px.** `.filter-bar` was given
  `flex-wrap: wrap` unconditionally after a bar "could neither shrink nor wrap"
  between 560px and 900px; its sibling `.date-bar` got the same remedy inside
  the 560px block alone, and went on overflowing in exactly the band the note
  describes. `.inline-form` collapsed to one column at 560px and nowhere else.
  `.section-title` carrying actions never stacked at all. Three containers, one
  mistake: the fix was filed against the width where the author was looking.
  **Above 780px the sidebar is 248px of the viewport**, so content is at its
  most cramped relative to the window at 820px, not at 390px — which is why a
  check at a phone width and a desktop width found none of the three.
- **A width is half of what decides a layout; what the bar holds is the
  other half, so a bar is checked in each state its contents can take.**
  `reflow.spec.ts` walks every route at every width and visits `/staged` with
  nothing selected, where there is no selection bar at all — so the bar that
  overflowed at 1440px, once a duplicate disabled Commit with a sentence and a
  multi-page selection added a button, was invisible to it at every width.
  Those are states, not widths: a disabled button's reason, a busy button, the
  longest count, the extra button a filtered selection brings. A bar whose
  contents change is measured with each of them present, at the same widths,
  and reaching a state is part of the check rather than left to whoever
  happens to have the data — a staged queue with duplicates in it, a request
  held open with `page.route` so the busy state lasts as long as the
  measuring. *Checked by:* `tests/browser/selection-bar.spec.ts` for the
  selection bar (12.3); every other bar is review.
- **`dvh`, not `vh`, for anything full-height.** There were seven `100vh` uses
  and no `dvh`; on a mobile browser with a retracting toolbar `100vh` is taller
  than the viewport and the bottom of the page is unreachable until the toolbar
  hides. All seven are `dvh` now, including the modal's `max-height`, which is
  where it mattered most: a tall form's last field and its submit button sat
  below the fold until somebody scrolled the toolbar away. The two `100vw` in
  the same arithmetic stay, because nothing retracts horizontally.

**There is a print stylesheet, and it holds one rule.**
`@media print` at `styles.css:4457-4461` hides `.ad-slot`, because a statement
of accounts somebody prints or saves as a PDF is a record they may keep and hand
on, and an advertisement in one is not a thing this product does. The block is
last in the file for 7.3's reason, and that is where a second print rule goes —
**extending this block, not opening another**, because two `@media print` blocks
at different depths in the tail is exactly the ordering hazard 7.3 exists to
prevent. Reports is still the page people print and still gets no treatment of
its own, so the work that remains is a rule rather than a stylesheet.

What is genuinely absent is the other half: there is no `prefers-contrast` and
no `forced-colors` handling anywhere in the file. This paragraph used to call
both halves missing, which would have sent somebody to write a second print
block rather than add to the one that is there.

*Checked by:* `tests/browser/reflow.spec.ts` for the one half a layout engine
can settle — every route, at each breakpoint, at each breakpoint minus one, in
the middle of each gap and at 320px, asserting the *document* never scrolls
sideways (SC 1.4.10). It measures `document.documentElement` and not a
container, because a `.data-table` scrolling inside `.table-wrap` is the rule
directly above this one. `tests/styles-order.test.ts` for the breakpoint list
and its order, and `tests/page-stack.test.ts` for the reflow rules a class can
carry. The `dvh` half is one grep and is held there too.
`tests/web-guide.test.ts` holds the print block — that there is exactly one,
that it is last, and that what it hides is the ad slot — so "a print stylesheet
exists" stays a fact rather than a sentence. What stays review is everything
after "does not overflow": whether a page is *usable* at 320px, and whether a
bar four lines deep still reads as one bar, are judgements about a screen.

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
Archive, Merge, Restore), so the rule mostly formalizes what exists.

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

> "$1,240.00 is posted out of "Old current account" to Opening Balances, so the
> account closes at zero and that amount stops counting toward your totals. The
> books stay balanced and its history stays readable. Restoring the account posts
> the balance back."

**House.** Error wording follows GOV.UK's construction, and the sentences are in
[`common.md`](common.md#errors)'s table: an instruction for an empty field
("Enter an amount"), a description for a malformed one ("Amount must be a
number. Check the decimal and thousands separators."), used consistently. Both
of those are quoted from that table rather than composed here — the second one
used to be quoted as "Amount must be a number, like 24.50", which is in no table
and in no source file, so this guide was the only place it existed and a
reviewer checking the wording against the product would have found neither.
Banned outright: "please", "sorry", "valid", "invalid", "oops", "forbidden",
"illegal", "you forgot". The inline message and the summary entry are the same
sentence, word for word.

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
| `tests/theme-tokens.test.ts` | Three token blocks exist, share a key set, and the two dark ones parse to the same token map; the attribute block is last; `color-scheme` per block; no literal color outside the blocks; no undeclared or unused token; no text token used as a fill or fill token used as text; one token per series in both themes, all distinct; every `.chart-series-N` draws from its token; `.input` draws its fill and edge from `--field` and `--field-line`, `.input:disabled` exists and takes its fill from `--field-disabled`, and that fill differs from `--field` in every theme; the three button families that paint over the browser's disabled rendering declare `:disabled` with `not-allowed` and `.button:disabled`'s own opacity, no `:hover` rule on a family that ships disabled is left unnarrowed, and every element `src/client` renders `disabled` under a class of its own belongs to a family that answers (1.5) |
| `tests/table-overflow.test.ts` | Every `.data-table` sits in a scrolling wrapper; `.table-wrap` carries `overflow-x` and none of the card chrome |
| `tests/styles-skeleton.test.ts` | The shimmer animation belongs to `.skeleton` alone; every card paints its own background; every selector whose animation says `infinite` is answered by name under `prefers-reduced-motion` (4) |
| `tests/styles-order.test.ts` | No top-level rule follows the responsive body; the four breakpoint blocks are contiguous and in descending order; the two preference blocks above them are named and so are the two selectors the motion one qualifies; no two independently-triggered layers share a `z-index` (3.5, 3.6, 4) |
| `tests/contrast.test.ts` | Every rule painting text on a fill clears 4.5:1 (or 3:1 where the rule says it is large) in both themes, derived from the token values rather than quoted; the six published non-text pairs clear 3:1 (2.1, 2.2, 11.1) |
| `tests/modal-layout.test.ts` | `.modal` centers independently of the global margin reset |
| `tests/error-summary-ui.test.tsx` | A refusal's every sentence is rendered, two fields sharing one sentence stay two lines, one field refused twice shows once, the summary takes focus and retakes it on an identical repeat, its heading is an `h3` under a dialog's `h2`, and a parser's own errors leave the app's sentence standing (8.3) |
| `tests/radio-groups.test.tsx` | Every radio belongs to exactly one group; two forms on one page stay separate; the transaction type choice is one tab stop with arrow wraparound |
| `tests/new-category-kind-ui.test.tsx` | The form asks which kind a name with nothing behind it should become, stays quiet when the category exists or the picker is empty, sends the answer only when one was given, and forgets it when the direction changes |
| `tests/nav-order.test.ts` | The sidebar order, and that every item names a route the app serves, both directions |
| `tests/theme-boot.test.ts` | `public/theme-boot.js` and `applyTheme` give the same answers |
| `tests/client-money.test.ts` | The money arithmetic every figure on screen is computed from |
| `tests/row-menu.test.tsx` | The row menu's dismissal and focus return (13.3) |
| `tests/bulk-row-cap.test.ts` | The ten thousand row cap behind the selection contract (9.5) |
| `tests/page-stack.test.ts` | The page's rhythm comes from `.content` and no page-level block carries a vertical margin or a negative one; no filter bar wraps a control in `Field`; every one of the fourteen scrolling table containers is a named, focusable region; the focus-indicator selectors cover every focusable element type and `.file-drop` carries `:focus-within`; every sticky or fixed region is paired with a container declaring `scroll-padding` (7.4, 7.5, 7.6, 9.5, 9.6, 13.2) |
| `tests/theme-tokens.test.ts` (chart palette) | `.chart-bar` declares a stroke, and not `none`, so two adjacent bars at 1.05:1 have an edge; nine of the ten line series carry a distinct dash rhythm and every dashed series' legend swatch carries the same one (11.2, 11.3) |
| `tests/progress-bar-ui.test.tsx`, `tests/progress-frames.test.ts` | When a progress bar is drawn, what it says, and that it is removed rather than frozen (12.6) |
| `tests/browser/progress-paint.spec.ts` | That the bar's fill is actually painted, in both themes, measured from the screenshot rather than from a computed style that does not resolve the pseudo-element (12.6, 17.2 item 7) |
| `tests/token-grammar.test.ts` | Every declared token parses against 1.4's grammar, with the two closed lists read out of 1.4 itself and the six by-name exemptions held to that paragraph in both directions; `TEXT` and `FILL` are derived from the parse rather than listed (1.4, 17.2 item 2) |
| `tests/auth-autocomplete.test.ts` | Every password control names `current-password` or `new-password` and nothing blocks a clipboard or a manager; every control in an auth form carries a purpose (8.6) |
| `tests/sorting-and-grid-roles.test.tsx` | No grid-pattern role in the client; `aria-sort` has one writer; every sortable header of one table shares one sort state; the active column is marked and the rest say `none` (9.1, 9.4) |
| `tests/loading-paragraph.test.ts` | No loading paragraph outside the four registered by file and sentence, and those four announce themselves (12.2, 17.2 item 6) |
| `tests/table-row-headers.test.ts` | A table that heads one of its row branches heads all of them, asked of every `<tbody>` in the client — the shape a scope check cannot see, because the offending cell is not a `<th>` at all (9.2) |
| `tests/table-column-headers.test.ts` | Every column header of every `thead` is `scope="col"` and no body or footer cell is; `SortableHeader` is registered as the one copy twenty-five of the product's headers share, and is refused inside a `tbody` (9.2, 17.2 item 5) |
| `tests/money-field-controls.test.ts` | No `type="number"` on a control bound to a decimal-string money value, over a population of money-bound controls rather than of number inputs, with the two integer counts registered by what they bind (8.5, 17.2 item 4) |
| `tests/count-link-range.test.ts` | A link whose text interpolates a count, landing on a page that mounts a range bar, pins a preset unless its own page has a bar to forward; which pages are ranged is read off the `<Route>` table and one hop into each page component (11.7) |
| `tests/api-fields-rendered.test.ts` | Every field `src/client/api.ts` declares — in its type bodies and in the six shared Zod shapes it re-exports — is mentioned somewhere in the client or is argued in a comment naming it (11.9) |
| `tests/merge-outcome-from-result.test.tsx` | Both merge panels report the server's answer rather than their own request, answered with a result whose target name and counts differ from what was asked for (11.9) |
| `tests/register-ways-out.test.tsx` | The register's three empty screens rendered: the default in force names "Show deleted" as a way out, turning it on reaches "nothing yet", and a filter the reader set still says "match this view" (12.1) |
| `tests/success-alert-focus.test.ts`, `tests/client-success-focus.test.tsx` | Every `<Alert kind="success">` in the browser takes focus or is registered with the reason it does not — the third shape of 13.3, derived from the answer rather than the trigger — and the three the source check cannot speak for are rendered, each asserting `role="status"` and where `document.activeElement` lands (13.3) |
| `tests/stripe-appearance.test.tsx` | The appearance handed to Stripe's `Elements` is read off the live tokens and never re-typed, its base theme follows what is painted, and it follows a theme switched while the form is open (6.4, 17.3) |
| `tests/chart-alternatives.test.tsx` | Every chart component call site has a real table beside it, with an `.sr-only` caption and scoped headers in a real render; a series keeps its color when the visible set shrinks (11.4, 11.6) |
| `tests/raw-dates-on-screen.test.ts` | No date-shaped field reaches JSX text, an `aria-label` or a `title` without a formatter; which names are date-shaped is derived from the fields the client already formats, so no list goes stale (10.4) |
| `tests/client-inline-edit-names.test.ts` | Every click-to-edit trigger's accessible name leads with its visible value, read through a brace-aware tag walk that follows one hop into a named `const` (8.10 rule 6) |
| `tests/browser/reflow.spec.ts` | No route's document scrolls sideways, at each breakpoint, each breakpoint minus one, the middle of each gap and 320px — the band above 780px included, where the sidebar takes 248px and a check at phone and desktop widths sees nothing (15) |
| `tests/browser/target-size.spec.ts` | Every interactive target on three screens measured at desktop width and at 390px, against both branches of SC 2.5.8 — 24 by 24 outright, else centers 24 pixels apart (13.4, 13.5) |
| `tests/recurrence-dates.test.ts`, `tests/locale-detection.test.ts` | The date and locale arithmetic every rendered date rests on (10.4) |
| `tests/page-stack.test.ts` (continued) | A page-prefixed class is used on its own page, or is one of the registered components — in both spellings, and with the English singular, because stripping a trailing `s` made `categories` into `categorie` and examined no `.category-` class at all; every full-height rule measures `dvh`; every table cell gets tabular figures, and `.align-right` means alignment alone (6.3, 9.3, 15) |
| `tests/pagination-focus.test.tsx` | A page turn gives focus back to the control that was pressed, or to the page number now current when that control has gone disabled (13.3) |
| `tests/app-name.test.tsx` | A page component's first JSX return carries its header, so a skeleton or an alert cannot take the title, the eyebrow, the tab strip and the back link down with it (12.1) |
| `tests/field-contract.test.tsx` | Every `<Button>` with a computed `disabled` carries a `disabledReason`, which is shown and pointed at while disabled, absent while enabled or working, and does not remount the button; a button disabled by its own refusal *or* by a busy flag withholds the reason in the second case (12.3); a field names its control explicitly, points it at the hint and the error, marks it invalid, and is a labeled group around a composite; every `<input>`, `<select>` and `<textarea>` in the client goes through the three shared components, with two named exceptions (8.1) |
| `tests/shell-focus.test.tsx`, `tests/browser/budgets.spec.ts` | The skip link is first and lands in `<main>`; a route change moves focus and resets scroll; the drawer makes the page behind it inert, moves focus in and out, and closes on Escape; a finished bulk action puts focus on the sentence saying so (13.3) |
| `tests/plan-page-ui.test.tsx` | Every result on the plan tab is a sentence that takes focus, a form opening from a press takes it too, and a page load moves nothing (13.3); a form's action row and a modal's footer line up on the tops only while a reason shows, and a line of text in one keeps the buttons' height (12.3); while a payment form is open it is the only way to pay, every plan button disabled by its own refusal gives the reason the route would refuse with, and one disabled only because its sibling's press is in flight gives none |
| `tests/frozen-accounts-ui.test.tsx`, `tests/ad-slot-ui.test.tsx` | A frozen account's disabled Edit and row actions each point at a reason while its Archive and Delete stay open, and its rows carry the badge that says so, beside a stylesheet that now dims and un-hovers both — and does not dim twice, which is asserted against the rendered tree in a voided row and an archived card (1.5, 12.3); an ad slot renders nothing and fetches nothing without a placement, and an unfilled unit and the slot around it are collapsed rather than left as a band (7.7) |
| `tests/legal-links-ui.test.tsx` | Both operator documents are linked where a person meets them, each opens a new tab, the sentence reshapes when only one is configured, and nothing is drawn when neither is (13.6) |
| `tests/browser/selection-bar.spec.ts` | The selection bar with a reason showing, with none, and with a commit in flight, at nine widths: nothing past its edge, the count on one line where one fits and on the buttons' midline, its icon whole, no label wrapping inside a button, the working button its own width and the idle one not drawn as working (12.3, 15) |
| `tests/browser/plan-buttons.spec.ts` | Two priced buttons keep the same top while one of them shows a reason, measured against a real layout engine at desktop width and at 390px where the reason wraps — the half 12.3 could not check (12.3, 13.5) |
| `tests/web-guide.test.ts` | The numbers and lists this guide argues from, derived rather than recounted: the component inventory and its three counts (6.1), the ten inline `style` props (1.3), every `z-index` having a rung (3.5), the stylesheet's tail order and its one print block (7.3, 15), the `Field`, optional, `formatMoney`, `EmptyState`, `Skeleton`, computed-disabled and scrolling-container censuses (8.1, 8.4, 9.3, 9.6, 12.1, 12.2, 12.3), where an ad slot sits in the shell (7.7), and the shape of every link that leaves the app (13.6) |
| `tests/ui-copy.test.ts` (vocabulary) | An account that has been put away is **archived**, never *closed*, in every literal and every run of JSX text in `src/client` and `src/shared`, with a named register for the control and accounting senses and one pattern for the frozen one (7.6) |
| `tests/ui-copy.test.ts` | No banned word in any string a person reads, in all three of client, shared and server; every literal button label is a verb phrase or one of the four bare actions; the three bulk bars use the four sanctioned strings; no eyebrow repeats its title; a blank cell's dash is a fallback and never cell text; `Uncategorized` is styled once; every worked sentence in `common.md`'s table appears verbatim in `src`; every page rendering a list's empty state decides the screen through `emptyScreen` or carries a one-sentence argument for having no question to ask, and no `emptyScreen` call names a row count, the shared date range or the page's own subject; and an empty state sits behind its query's error rather than beside it, with three named exceptions (6.2, 12.1, 16) |

### 17.2 Worth building, ranked by bugs caught per hour

**First, the rule every one of these has to be written to.** A check derives its
population **from the product** — every page, every list-rendering branch, every
`Field` call site, every bar — and **never from the presence of the thing it is
checking**. Otherwise opting out of a rule is free and silent, and roughly
twenty of this release's findings survived a green suite that way. Nine of
them, each a different spelling of the same mistake: a copy check whose
population was "files containing `<EmptyState`", so a list answering with a
`Note` was outside it; the same check skipping a whole file for having two of
them; a bulk-verb check walking three hard-coded paths; a page-level block list
maintained by hand with six blocks missing; a prefix derivation that turned
`categories` into `categorie` and matched nothing; a `Field` error contract
green at zero real call sites; and a header test that rendered the component
directly and never asked whether a page reached it. **And where a check cannot
see something, it says so in its own docstring rather than leaving this guide
to claim otherwise.** `tests/migrations.test.ts` already makes this argument
about its frozen list, and `AGENTS.md` states it: a list of what may never
change is worth nothing if it can quietly fall behind.

1. **No spacing, radius, size or weight literal outside the scales.** The same
   trick the color test uses, with an allow-list for `1px` borders, `0` and
   percentages. This is the largest unmanaged surface in the stylesheet: 295
   spacing declarations across 35 values. The census itself is now derived
   rather than recounted — `tests/standards-citations.test.ts` holds section 3's
   numbers to the file, which is what stopped this item and section 3.1 quoting
   two different totals for one measurement.
2. **Landed.** Every token name matches the grammar and its role is in the
   closed list: `tests/token-grammar.test.ts`, reading both lists out of 1.4 so
   a new role is an edit to that paragraph. The hand-maintained `TEXT` and
   `FILL` sets are gone — `tests/support/token-grammar.ts` derives them from the
   parse and `tests/theme-tokens.test.ts` imports them. Kept here with its
   number rather than struck out, because four other files cite these items by
   position.
3. **Duration and easing tokens exist and the reduced-motion block sets them**,
   so a new animation cannot forget the second block. The bar separation half of
   what used to be item 5 has landed; the adjacent-series half is deliberately
   not here, because section 11.2 argues at length that the ten-color set beats
   a compliant six-color one on the measure that matters, and a test demanding
   3:1 between adjacent series would contradict the guide it is attached to.
   Section 11.3's dash patterns were the honest successor and have landed.
4. **Landed.** No `type="number"` on a field bound to a decimal-string money
   value: `tests/money-field-controls.test.ts`. This item's warning was the
   whole design problem and it was right — the population is every money-**bound**
   control rather than every `type="number"`, so the recurrence interval and the
   reminder interval are outside it by binding rather than by line number, which
   is what stops the register going stale when they move. They have moved since
   this item named them. Kept here with its number rather than struck out,
   because other files cite these items by position.
5. **Landed.** `th[scope="col"]` on every column header:
   `tests/table-column-headers.test.ts`, which asserts the scope *value* and the
   inverse on body and footer cells. `tests/table-overflow.test.ts` covers the
   caption and that every `th` carries *a* scope, which is what left a
   `scope="row"` in a `thead` passing. `SortableHeader` is registered as a header
   component: its one `scope` is the only copy twenty-five of the product's
   column headers have, so a check reading call sites alone sees almost none of
   them.
6. **Landed.** No loading paragraph: `tests/loading-paragraph.test.ts`. The
   population is every `<p>` in the client whose own text says it is waiting,
   and the four deliberate ones — the sign-in options and the three detail
   pages, each a whole-page swap rather than a region — are a register keyed by
   file and sentence rather than by the line numbers this item used to carry,
   which drift the first time anything above them moves.
7. **Landed, by a different mechanism than this item proposed.** The progress
   bar is actually painted: `tests/browser/progress-paint.spec.ts`, in both
   themes. This item said Chromium resolves `::-webkit-progress-value` through
   `getComputedStyle(element, "::-webkit-progress-value")`. It does not — that
   call returns the element's own computed style, so it reports `--track` for
   the fill and passes a stylesheet with both vendor rules deleted. The spec
   screenshots the element and samples pixels either side of the value instead,
   which also sees the clipping case. 12.6 has the detail. The premise was
   wrong and the conclusion was right: filing it as review meant the one tier
   built to catch it was never asked.

`eslint-plugin-jsx-a11y` used to be item 7 here and has been removed rather than
demoted: it is enabled at `.oxlintrc.json:15` with 38 rules, and the two this
item wanted are off **by name with recorded reasons** at
`docs/standards/code/index.md:228-229`, because neither can see through `Field`.
`code/index.md` owns that decision and has made it; listing shipped-and-refused
work under "worth building" is how a backlog stops being one.

### 17.3 Review, and honestly so

These cannot be tested and the guide says so rather than pretending.

- Whether an empty state's two sentences are the *right* two. That a filtered
  list has two rather than one is checked as of 0.2.0 (12.1); whether either
  names the action that gets somebody out is not, and a page can satisfy the
  check with two sentences that are both useless.
- Whether a chart with more than a few series wants direct labels or a different
  chart.
- Whether a new component duplicates one in the inventory.
- Whether a dense form's tab order is the order a person works in.
- Whether an error message names the *right* next action.
- Whether a glossary term is used correctly, as opposed to being present.
- Whether a link's text makes a promise its destination's defaults would break
  (11.7), and whether a dropped response field was restraint or oversight
  (11.9). Both lost their decidable half in 0.2.0 and keep the rest: a link
  whose text is a *count* is now held by `tests/count-link-range.test.ts`, and
  that a dropped field was at least *argued* by `tests/api-fields-rendered.test.ts`.
  What neither can read is whether the words promise anything, or whether the
  argument is a good one.
- Whether a field bound to money names its currency in the label (8.5). The
  spinner half landed; "Amount (USD)" naming the right currency is a reading of
  the form.
- **What color a third-party iframe came out (6.4).** Neither tier can see it:
  jsdom renders no iframe content and the browser tier cannot read into a
  cross-origin document. So the card form on the plan tab is checked by somebody
  opening it in both themes. The half a test *could* hold — that the appearance
  handed to `Elements` is built from the live token values — now exists and is
  `tests/stripe-appearance.test.tsx`, which sets the tokens to values no
  stylesheet uses so a re-typed hex cannot pass it.
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
recorded rather than quietly lost. **This guide records no such conflict**, and
what makes that claim checkable rather than comfortable is that every binding
rule here comes from one of exactly three places: WCAG 2.2, an `AGENTS.md`
invariant, or a rule [`common.md`](common.md#money) already settles.

The money rules are the third kind, and they are the ones most likely to drift
into an argument. Section 8.5's ban on `type="number"` and section 10.1's
"which way does this figure read" are both `common.md`'s Money rules reaching a
screen — a monetary value is a string everywhere, and a comparison is
arithmetic — rather than this guide restating the invariant in its own words. A
restatement is where a conflict would come from, because two spellings of one
rule diverge the first time either is edited. So those two sections point, and
what they point at is owned one level up.

What it does record is four places where published guidance and this product
disagree, each labeled Contested and each naming the position it did not take:
green and red in a ledger (2.4), the dense transaction form against one question
per page (8.7), a table rather than a grid (9.1), and ten series colors rather
than six (11.2). Section 10.2 records a fifth departure, from GOV.UK's prose rule
about trailing zeros, which is a reversal rather than a disagreement: the rule is
right for a sentence and wrong for a column.
