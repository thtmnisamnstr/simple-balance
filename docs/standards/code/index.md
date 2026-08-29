# Code standards

How this product is written, as opposed to how it behaves.

The guides beside this one, in [`docs/standards/`](../index.md), govern what a
person or an agent sees: the browser app, the MCP surface, the HTTP contract,
the CSV format, the container, the prose. These govern the source. A rule
belongs here if changing the code to obey it changes nothing anybody outside the
repository could observe.

## The division, in one line each

- **`AGENTS.md`** — break it and the books are wrong. Invariants.
- **`docs/standards/`** — break it and the product is inconsistent. Interfaces.
- **`docs/standards/code/`** — break it and the next person is slower. Source.

The third is the weakest of the three, deliberately. A coding standard earns its
place by saving somebody time, and it should be dropped the moment it stops
doing that. Where one of these rules would force a worse program, the program
wins and the rule records the exception, because a standard that cannot survive
contact with a real case was never a standard.

## The set

| File | Governs |
| --- | --- |
| [`typescript.md`](typescript.md) | The language: strictness, types, modules, what the compiler is set to refuse. |
| [`services.md`](services.md) | The server service layer: actors, transactions, versions, idempotency, audit. |
| [`database.md`](database.md) | Schema, migrations, and queries: Drizzle, raw SQL, and the traps this one has hit. |
| [`client.md`](client.md) | React: state, effects, queries, and the three rules that went from budgeted to denied. |
| [`errors.md`](errors.md) | Failing: which error, carrying what, phrased how. |
| [`testing.md`](testing.md) | Four tiers, what each can see, and what makes a test worth keeping. |
| [`observability.md`](observability.md) | What the running product says about itself: what is counted, what is logged, and what neither may carry. |
| [`comments.md`](comments.md) | The one convention here that is genuinely unusual, and why it pays. |

Read `typescript.md` first if you are new; read `comments.md` first if you are
about to write something.

## Every rule carries a label

The same three the interface guides use, and they mean the same things.

| Label | Means |
| --- | --- |
| **Binding** | A compiler setting, a denied lint rule, or an `AGENTS.md` invariant. Not a preference. Breaking one fails a check. |
| **House** | Defensible taste. Consistency is the point, so change it here rather than in one file. |
| **Contested** | Published guidance disagrees with itself, or a tool disagrees with this codebase. The guide records both sides and says which won. |

## Every rule says how it is checked

Four mechanisms, and every rule names exactly one:

| Mechanism | What it means |
| --- | --- |
| `tsc` | `npm run typecheck` fails. |
| `lint` | `npm run lint` fails, or `npm run format:check` does. |
| `test` | A named test fails. |
| `human` | Nothing catches it. A rule marked `human` is a candidate for deletion, and the count below is a number that should be going down. |

**There are 40 `human` rules across the eight guides** — 35 in the seven that
enforce something, and five in `comments.md`, which argues rather than enforces
and says so. `tests/standards-citations.test.ts` counts the rows and holds this
sentence to them, so the number cannot drift by a guide gaining a rule and
nobody coming back here.

**It went up, and that is the honest direction.** It was 26, then seven became
tests in one pass and it read 19 — and 19 was wrong, because 34 of the 67
labelled rules named no mechanism at all. A rule that says nothing about how it
is checked is `human`, whether or not the word appears; leaving those silent
made the count flattering rather than useful. Every rule now names one, so the
count is of rules that really have nobody but a reader behind them, and it can
go down again by being worked on rather than by being unstated.

It then went 33 → 40 when `observability.md` arrived carrying seven of its own,
which is the most of any guide here and is the honest shape of that subject: a
label that identifies somebody and a counter that moves when nothing happened
are both properties a test holds, and both are held. Whether a line was worth
writing, and whether it was written at the level somebody would want it, are
what review is for.

Before that it went 32 → 33, which is the same honesty at a smaller scale:
`database.md` 1.2 says a migration's name stays what it was written as, and no
test can tell a name somebody chose from a slug the generator produced. It had
been sitting silent beside a test that checks its neighbour, which is exactly
the shape that made 19 wrong.

The seven that became tests are worth reading for how, and one especially,
because it looked impossible. A rule about where a decision belongs cannot be
checked by a program. What can be checked is what that rule going wrong leaves
behind — a transport reaching for the database on its own — and that turned out
to be five lines, each with a reason, and a sixth now has to be argued for.

## The toolchain, and what it was chosen over

Two decisions were open when this set was written. Both were measured on this
repository rather than argued from reputation, because the answer is a property
of the codebase and not of the tools.

### Linter: oxlint

**Forced, then confirmed.** `typescript-eslint` does not load under TypeScript
7, which this repository is on (`package.json`, `typescript: ^7.0.2`), so the
realistic choice was oxlint or nothing.

Measured before adopting: **8 findings across 218 files** at the default
`correctness` category. That number is the argument for turning it on — it costs
almost nothing — and also the argument against expecting much from it.

What was declined, and why, because a rule set is defined as much by what it
leaves out:

| Category | Findings | Verdict |
| --- | --- | --- |
| `correctness` | 8 | **Denied.** Now zero. |
| `suspicious` | 191 | Declined. 76 are `no-array-sort` and 70 are `consistent-function-scoping`, which fires on nearly every React component. |
| `perf` | 172 | Declined. 147 are `no-await-in-loop`, and this codebase awaits in loops **on purpose** — see `services.md`. A rule that fights a documented invariant is worse than no rule. |
| `pedantic` | 1,557 | Declined. |
| `style` | 17,976 | Declined. |
| `restriction` | 5,085 | Declined. |

**Those are the numbers the decision was made on, and they are not today's.**
Re-measured with `npx oxlint -A all -D <category>` on the current tree:
correctness 35, `suspicious` 2,438, `perf` 731, `pedantic` 1,835, `style`
24,673, `restriction` 7,296. Nothing holds either column — they are a
measurement, and the two of them do not measure the same rule set, which is most
of the movement:

- **`correctness` reads 35, and `npm run lint` still reads zero.** That command
  overrides the six rules `.oxlintrc.json` turns off by name, and the 35 are
  exactly those six: `label-has-associated-control` 8,
  `control-has-associated-label` 9, `prefer-tag-over-role` 8, `no-autofocus` 6,
  `anchor-has-content` 1, `no-control-regex` 3. The category is denied and
  clean; this is what denying it with exceptions looks like from outside.
- **`suspicious` went 191 → 2,438 on one rule that cannot be right here.**
  2,160 of them are `react-in-jsx-scope`, which React 19's automatic runtime
  makes wrong in every file that renders anything. The `react` and `jsx-a11y`
  plugins were adopted after the original pass, so that column was measured
  without them.
- **`perf` went 172 → 731, and the shape of the argument is unchanged.** 157 are
  `no-await-in-loop`, which this codebase does on purpose — see `services.md`
  §3.2. The other 547 are `react-perf` rules on inline props
  (`jsx-no-new-function-as-prop` 381, `jsx-no-new-array-as-prop` 76,
  `jsx-no-jsx-as-prop` 58, `jsx-no-new-object-as-prop` 32) — a category this
  repository would have to be rewritten around rather than fixed into.

Plugins, measured the same way. `import`, `promise`, `node` and `react-perf`
each added **zero** findings, so they are on for free and will catch the first
thing they ever see:

| Plugin | Added | Verdict |
| --- | --- | --- |
| `typescript`, `unicorn`, `oxc` | — | On by default, and listed explicitly in `.oxlintrc.json` so that the set is readable from one place rather than being partly implicit. They contribute nothing today; `unicorn` and `oxc` between them found four of the original eight findings. |
| `import`, `promise`, `node`, `react-perf` | 0 each | On. |
| `jsx-a11y` | 38 | On, with five rules off. See below. |
| `react` | 31 | **Denied**, at zero. It found 31 — `react-hooks/exhaustive-deps` (17), `react/set-state-in-effect` (13), `react/use-memo` (1) — which were carried under a per-rule budget until each had been decided one at a time. See `client.md`. |
| `vitest` | 231 | **Off.** 163 of the 231 are false against Vitest's own API. See `testing.md`. |

One `eslint` rule is off. **`no-control-regex`** flags a regular expression that
matches control characters, and all three sites here exist *to reject* them: two
sanitise user input (`src/shared/domain.ts:251-252`) and one is the
CSV-injection defence (`src/shared/csv.ts:466`).
The rule exists to catch a control character written by accident; every one of
these was written on purpose, and the code that strips control characters is
necessarily code that names them.

Five `jsx-a11y` rules are off, and each is off for a reason that is about this
codebase rather than about accessibility:

| Rule | Why off |
| --- | --- |
| `jsx-a11y/label-has-associated-control` | Cannot see through `Field`, which wraps every control (`src/client/components.tsx:389`). Every site it flagged was correctly labelled. |
| `jsx-a11y/control-has-associated-label` | Same, and it also flags `<option>` inside `<datalist>`, which needs no label. |
| `jsx-a11y/prefer-tag-over-role` | Flags `<svg role="img">`, which is the recommended way to expose an SVG, and a `<summary role="button">` whose comment already explains itself (`src/client/components.tsx:490`). |
| `jsx-a11y/anchor-has-content` | Content arrives through `children`, which it cannot follow. |
| `jsx-a11y/no-autofocus` | **Contested.** jsx-a11y bans it; WCAG does not. This product autofocuses the first field of a form somebody deliberately opened, which is where the argument for it is strongest. Six sites, all that shape. |

Two more are denied but disabled at two individual sites, each carrying its
reason in the code: `jsx-a11y/no-static-element-interactions` at
src/client/forms.tsx:497`, and both that and `click-events-have-key-events` at
`src/client/components.tsx:497`. Both are elements catching events that bubble
from real controls inside them.

*Checked by:* `npm run lint`, in `npm run verify`.

### Formatter: oxfmt

**Adopted.** The concern that held this up was that a formatter would reflow the
comments, and this codebase keeps its reasoning in comments — see
[`comments.md`](comments.md). So it was measured rather than assumed:

| | |
| --- | --- |
| Files reformatted | 199 |
| Runtime | 31ms |
| Comment lines whose **prose** changed | **0 of the 8,604 then in the tree** |
| Comment lines re-indented | 80 |

oxfmt does not reflow comment prose at all. It re-indents comments when the code
around them moves, and touches nothing else. That measurement is what turned a
"no" into a "yes".

One thing it does that had to be stopped: it formats CSS as well, and rewriting
`src/client/styles.css` broke `tests/theme-tokens.test.ts`, which reads that file
as text. So `.oxfmtrc.json` ignores `**/*.css`. The stylesheet is hand-formatted
and stays that way, because a test reads its layout.

*Checked by:* `npm run format:check`, in `npm run verify`.

### The compiler

Six settings were free — zero errors — and are on. `erasableSyntaxOnly` cost
five sites and is on. Three were measured and declined:

| Setting | Errors | Verdict |
| --- | --- | --- |
| `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`, `verbatimModuleSyntax` | 0 | On. |
| `erasableSyntaxOnly` | 5 | On. Two classes lost their constructor parameter properties. |
| `noImplicitReturns` | 3 | **Declined.** All three are Hono middleware, where returning nothing is the contract. See `typescript.md`. |
| `exactOptionalPropertyTypes` | 71 | Declined for now. |
| `noUncheckedIndexedAccess` | 440 | Declined for now, and it is the one most worth coming back to. See `typescript.md`. |
| `noPropertyAccessFromIndexSignature` | 666 | Declined. |

*Checked by:* `npm run typecheck`, in `npm run verify`.

## What `npm run verify` now runs

```
typecheck → lint → format:check → test → build
```

Integration and browser tests are not in it, because both need a PostgreSQL to
point at. `npm run test:integration` and `npm run test:browser` are run
separately and are named in `testing.md` with what each requires.

## Changing a rule

Change it here, and change the code it governs in the same commit. Where a rule
turns out to be wrong, delete it rather than carving an exception — an exception
list longer than two entries means the rule was wrong.

Where one of these guides and `AGENTS.md` disagree, `AGENTS.md` wins and the
guide records the disagreement instead of quietly losing it.
