---
name: guides-comply
description: Sweep the whole product against the standards guides and close the gaps the guides record about themselves. Audits every page section, API route, MCP tool and service against the rules, fixes what violates them, then builds mechanisms for rules nothing checks. Use when asked to make the app or its services comply with the guides, to verify every part of every surface against the standards, or to close the gaps in the guides.
---

# Make every surface comply, and mechanise what nothing checks

Two directions, run as one pass:

- **Code → guides.** Every page section, route, tool and service audited against
  the rules. Fix what violates them.
- **Guides → mechanisms.** The guides record their own unchecked rules. Build
  the missing checks.

They run together and in this order because the sweep is what *ranks* the
mechanising: a rule that nothing checks and nothing breaks is a worse investment
than one the sweep just caught being broken three times.

**Never fix a violation by weakening the rule**, and never fix it by breaking
the upgrade guarantee. If a rule is wrong, `guides-update` changes it on the
record. If a fix would break a release, see `release-prep` phase 1 — the answer
is almost always warn-and-carry-on, and if there is no safe fix, declare the
problem in writing rather than shipping the break.

## 1. Build the rule inventory

```sh
for label in Binding House Contested; do
  printf "%-10s %s\n" "$label" "$(grep -rc "^\*\*$label" docs/standards/ | awk -F: '{s+=$2} END{print s}')"
done
grep -rn "\*Checked by:\*" docs/standards/ | wc -l
```

For each rule record: the guide and heading, the label, and its `*Checked by:*`
— a named test, `human`, or nothing. That is several hundred rules across some
eleven thousand lines, so work guide by guide rather than trying to hold it all
at once. Take the counts from the commands rather than from memory; they move
every release.

Binding first, always. A Binding rule is one `AGENTS.md`, WCAG or a wire
contract stands behind; a House rule is a settled preference and a violation is
untidiness. Never spend the Binding budget on House rules.

Every guide has a `## What is checked, and what is not` section listing what it
knows it does not check. That section is the starting inventory for direction
two, not the whole of it — the markers are scattered:

```sh
grep -rn "Not checked mechanically\|Still to do\|Worth building\|\*Checked by:\* \`human\`" docs/standards/
```

## 2. Enumerate the surface

Nothing may be swept "generally". Build the actual lists:

```sh
ls src/client/pages/                        # 18 pages, plus TransactionBrowser and App
grep -n "\.\(get\|post\|patch\|put\|delete\)(" src/server/api.ts
grep -n "registerTool(" src/server/mcp.ts
ls src/server/services/
```

A page is not one item. Break it into its **sections** — header and actions,
filter bar, table or cards, empty state, loading state, error state, forms,
modals, pagination. The source session's request was explicit about this, and it
is where the findings are: three lists were showing one empty state for two
different situations, and that is invisible from a page-level glance.

## 3. Machine-check first

Cheap, exhaustive, and it tells you what is already covered:

```sh
npm run verify
```

Anything green here needs no reading. Spend the reading on what nothing checks.

## 4. Sweep: surface × rule

For each surface item, walk the rules for its guide. Write findings down as you
go, with `file:line`.

Where a whole class needs checking, an **ad-hoc script is the right tool** —
enumerate the hits, then read each one. Do not trust the script's verdict.
Almost every hit in the source session was a false positive, and each one was
fixed by *narrowing the rule*, never by changing the code:

- Money alignment fired on cards, where the rule is about tables.
- `<thead>` was "missing" because the pattern matched `<th`.
- A `Field` window of 260 characters truncated multi-line props.
- `icon={<Repeat />}`'s `/>` ended the slice early.
- A service's `userId` scope lived in a helper, or in a pre-built conditions
  array, so the scope looked absent.
- `getDb|tx` matched mentions inside nested closures.

A script that reports zero hits has usually broken, not passed. Prove it can
report something before believing a clean run.

The checks that repeatedly find real defects:

- **Four states per list** (`web.md` 12.1). Empty must distinguish "nothing yet"
  from "nothing matches this view" — the ways out are opposite. Read the filters
  actually set. A date range every view has is not a filter for this purpose;
  counting it reports every empty ledger as filtered.
- **Every control inside a `Field`** (`web.md` 8.1), with label, hint and error
  reaching it.
- **MCP parity**, both directions, and *one level down*: a request field only an
  agent can set is the same defect as a missing tool, and no route-by-route
  comparison sees it. `categoryKind` was documented for the MCP and absent from
  the form, so the browser filed refunds as income.
- **A response field the client drops** (`web.md` 11.9) — restraint or oversight,
  and the drop is a comment naming the field.
- **Closed sets spelled twice** (`typescript.md` 2.3), including as a property
  type, not only as a `type X = "a" | "b"` alias.
- **Service entry points** taking an `Actor` and scoping every read and write by
  it.
- **Nothing outside the configuration layer naming `console`**, including as a
  default parameter.

## 5. Fix, with a test each

Every fix that changes behaviour gets a focused test, and every new check gets
**mutation-proved**: break the guarded thing, watch the check fail by name,
restore, watch it pass. Non-negotiable. Three checks in this repository could
not fail at all, and each was found this way; one had lost a `.push()` during an
edit and silently passed forever.

## 6. Triage what nothing checks

Now that the sweep has shown which rules actually get broken, sort every
unmechanised rule into four:

- **Mechanisable.** A test can decide it. Build it — see 7.
- **Judgment.** No test can decide it: whether a figure has a subject worth
  linking, whether phrasing is right, whether an omission was argued. Leave
  `*Checked by:* human` and make sure the guide says *why* it cannot be checked.
  That sentence is the deliverable.
- **Blocked.** Wants something that does not exist yet. Record the blocker
  precisely, and re-check it every pass — the source session had two notes whose
  blockers had been removed by its own earlier commits.
- **Release-breaking.** The mechanism would force a change that breaks the
  upgrade guarantee. Do not build it. Record the disagreement in writing, with
  the reasoning, and leave the rule unenforced on purpose.

## 7. Build mechanisms

Where a pattern cannot separate a defect from correct code, do not write a fuzzy
rule. Build a **named-exception register**: the check is strict, and every
legitimate exception is listed with the argument for it. The repository already
uses this shape — `NOT_A_FIELD`, `NOT_A_TOOL`, `COINCIDENCE`, `BEFORE_THE_RULE`
— and it works because adding an entry is a decision somebody has to defend, not
a silent pass.

Keep registers small and comment each entry with its reason. A register holding
`file:line` drifts when the file moves and nothing watches it, so prefer a
stable key where one exists.

Two habits the guides call out that look like mistakes and are not: comments are
dense on purpose (about 20% of non-blank lines in `src`), and some loops must
not be parallelised — legs resolve one at a time so two naming the same new
category land on one category.

## 8. Update the guides

Every rule newly mechanised moves out of "not checked" and into the guide's
`## What is checked` section, naming the test. Every rule found wrong goes to
`guides-update`. Every deliberate non-enforcement gets its reasoning written
down where the rule is.

## 9. Recount and verify

Adding tests moves the tier tables and the density figures; editing source moves
citations. Run the meta-tests and take the numbers they report, then all three
tiers:

```sh
npx vitest run tests/standards-citations.test.ts tests/comment-density.test.ts \
  tests/testing-guide-counts.test.ts tests/mcp-measurements.test.ts
npm run verify
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:integration
BROWSER_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/simple_balance_test npm run test:browser
```

## 10. Report

Surfaces swept and how many items each held. Violations found and fixed, with
`file:line`. Rules newly mechanised, and that each was mutation-proved. Rules
deliberately left unmechanised, in which of the four categories, and why. And
say plainly where the sweep found nothing — a clean surface is a result, and
manufacturing findings to look thorough is worse than reporting it clean.
