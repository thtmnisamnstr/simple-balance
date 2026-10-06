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

**There are 46 `human` rules across the eight guides** — 41 in the seven that
enforce something, and five in `comments.md`, which argues rather than enforces
and says so. **It went down in 0.2.0, for the first time, and by being worked on
rather than by being unstated** — which is the whole point of keeping it.
`testing.md` 5.3 and `services.md` 2.6 both got the mechanism their rows said
could not exist, and both rows say above their tables what the reasoning was
that kept them unbuilt, because in each case the row was wrong about *where* the
fact lives rather than about whether it was checkable. `tests/standards-citations.test.ts` counts the rows and holds the
total to them, so the number cannot drift by a guide gaining a rule and
nobody coming back here. It held the total only: the split either side of the
dash is two more numbers in prose, and the total staying still while both halves
moved is exactly what it looks like when nobody recounts them.
`tests/code-index-guide.test.ts` now holds the split, and the per-guide figure
four paragraphs down, against the same row count — so the two halves can no
longer cancel.

**It went up, and that is the honest direction.** It was 26, then seven became
tests in one pass and it read 19 — and 19 was wrong, because 34 of the 67
labeled rules named no mechanism at all. A rule that says nothing about how it
is checked is `human`, whether or not the word appears; leaving those silent
made the count flattering rather than useful. Every rule now names one, so the
count is of rules that really have nobody but a reader behind them, and it can
go down again by being worked on rather than by being unstated.

It went up twice more, for the same reason one level down. The check that reads
these pages ended a rule at the next `###`, so a `##`-level rule was never
scanned at all and the last `###` in a file borrowed the footer of the `##`
section beneath it. Four rules were answering to nothing: `comments.md` §5 and
§6, `services.md` §3.3 — **Binding**, and the one this set most wanted a test
for — and `testing.md` §4. Two of the four now have one; the other two are rows
in their own tables, which is why the number moved by two rather than by four.

It then went 33 → 40 when `observability.md` arrived carrying seven of its own,
the most of any guide until `testing.md`'s table grew to eleven — it reached
twelve and 5.3 left it again — and the honest
shape of that subject: a
label that identifies somebody and a counter that moves when nothing happened
are both properties a test holds, and both are held. Whether a line was worth
writing, and whether it was written at the level somebody would want it, are
what review is for.

Before that it went 32 → 33, which is the same honesty at a smaller scale:
`database.md` 1.2 says a migration's name stays what it was written as, and no
test can tell a name somebody chose from a slug the generator produced. It had
been sitting silent beside a test that checks its neighbor, which is exactly
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
7, which the application is on (`package.json:81`), so the realistic choice was
oxlint or nothing.

"This repository" is what that sentence used to say, and it is now the wrong
unit. There are two TypeScript programs here: the application, and
`deploy/pulumi` on `typescript@5.9.3` (`deploy/pulumi/package.json:25`), which
cannot move to 7 because 7 removed the module resolution those four Pulumi
stacks need — `typescript.md` §3.5 has that argument and the rest of the
comparison. `typescript-eslint` would have loaded over the infrastructure half
perfectly well. What keeps the decision whole is that oxlint lints both out of
one `.oxlintrc.json`, so the forced choice on one side did not buy a second
linter on the other.

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
Re-measured with `npx oxlint -A all -D <category>`, 2026-10-01: correctness 69,
`suspicious` 3,189, `perf` 950, `pedantic` 4,012, `style` 44,493, `restriction`
12,429. Five of those six are dated rather than held, which `writing.md` §A
measured number carries a test or a date allows only because holding a figure
that moves with every file added would teach people to bump it without reading.
The sixth is held, and it is the only one anybody acts on. The two columns do
not measure the same rule set, which is most of the movement between them:

- **`correctness` reads 69, and `npm run lint` still reads zero.** That command
  overrides every exception `.oxlintrc.json` writes down, and the 69 are
  exactly those exceptions: `prefer-tag-over-role` 29,
  `no-noninteractive-tabindex` 14, `no-autofocus` 11,
  `control-has-associated-label` 7, `no-control-regex` 4,
  `label-has-associated-control` 3, `anchor-has-content` 1. The category is
  denied and clean; this is what denying it with exceptions looks like from
  outside.

  **Seven rules, not six, and the seventh is why this bullet is checked now.**
  Six are off by name and are the two tables below. The seventh,
  `no-noninteractive-tabindex`, is *narrowed* rather than off — and `-A all`
  throws the narrowing away with everything else, so all fourteen of its sites
  reappear under a command that was being read as a census of the off list. A
  sentence saying "exactly those six" is the one somebody auditing that list
  acts on, so it is held by `tests/code-index-guide.test.ts` against both the
  linter and `.oxlintrc.json`: a rule silenced without a row here, or a row here
  for a rule nothing silences, fails.
- **`suspicious` went 191 → 3,189 on one rule that cannot be right here.**
  2,645 of them are `react-in-jsx-scope`, which React 19's automatic runtime
  makes wrong in every file that renders anything. The `react` and `jsx-a11y`
  plugins were adopted after the original pass, so that column was measured
  without them.
- **`perf` went 172 → 950, and the shape of the argument is unchanged.** 271 are
  `no-await-in-loop`, which this codebase does on purpose — see `services.md`
  §3.2. Of the other 679, 636 are `react-perf` rules on inline props
  (`jsx-no-new-function-as-prop` 448, `jsx-no-new-array-as-prop` 90,
  `jsx-no-new-object-as-prop` 52, `jsx-no-jsx-as-prop` 46) — a category this
  repository would have to be rewritten around rather than fixed into.

Every number in the paragraph and the first bullet above moved between two
releases while the paragraph went on calling itself a re-measurement, and not
one of the three arguments changed: the category is still denied and clean, the
plugin is still wrong about React 19, and this codebase still awaits in loops on
purpose. That is the useful shape to notice. An argument that survives its
evidence tripling is an argument; a number that nothing recounts is decoration,
which is why the correctness bullet now has a test under it and the other two
say plainly that they do not.

Plugins, measured the same way. `import`, `promise`, `node` and `react-perf`
each added **zero** findings, so they are on for free and will catch the first
thing they ever see:

| Plugin | Added | Verdict |
| --- | --- | --- |
| `typescript`, `unicorn`, `oxc` | — | On by default, and listed explicitly in `.oxlintrc.json` so that the set is readable from one place rather than being partly implicit. They contribute nothing today; `unicorn` and `oxc` between them found four of the original eight findings. |
| `import`, `promise`, `node`, `react-perf` | 0 each | On. |
| `jsx-a11y` | 38 | On, with five rules off. See below. |
| `react` | 31 | **Denied**, at zero. It found 31 — `react-hooks/exhaustive-deps` (17), `react/set-state-in-effect` (13), `react/use-memo` (1) — which were carried under a per-rule budget until each had been decided one at a time. See `client.md` §1.3 and §1.4; §1.4's last section is the third of the three, which this pointer dangled over for a release because its one site was *removed* rather than disabled and so left nothing in the tree to find. |
| `vitest` | 231 | **Off.** A large majority were false against Vitest's own API. `testing.md` §4 is the decision and the current reading; it has re-measured twice and explicitly retires the two numbers this cell used to quote, so quote it rather than this column. 231 is the adoption-day figure, like every other number in this table. |

One `eslint` rule is off. **`no-control-regex`** flags a regular expression that
matches control characters, and all four sites here exist *to reject* them: two
sanitize user input (`src/shared/domain.ts:350-351`), one is the CSV-injection
defense (`src/shared/csv.ts:513`), and one scrubs a CSP report before it reaches
the log (`src/server/api.ts:1268`), where the body is attacker-controlled and a
newline would let one report write several log lines with a forged error among
them. The rule exists to catch a control character written by accident; every
one of these was written on purpose, and the code that strips control characters
is necessarily code that names them. The fourth arrived with the report
endpoint, extended the argument without changing it, and went unlisted here for
a release — which is what the census above is now checked against.

Five `jsx-a11y` rules are off, and each is off for a reason that is about this
codebase rather than about accessibility:

| Rule | Why off |
| --- | --- |
| `jsx-a11y/label-has-associated-control` | Cannot see through `Field`, which wraps every control (`src/client/components.tsx:617`). Every site it flagged was correctly labeled. |
| `jsx-a11y/control-has-associated-label` | Same, and it also flags `<option>` inside `<datalist>`, which needs no label. |
| `jsx-a11y/prefer-tag-over-role` | Twenty-nine sites in five shapes, and the two this row named are six of them: five `<svg role="img">`, which is the recommended way to expose an SVG, and one `<summary role="button">` whose comment already explains itself (`src/client/components.tsx:910`). Of the rest, five `role="status"` sit on a loading line and four `role="group"` on a date bar — and **fourteen `role="region"`, the largest shape by far, are the named scroll region the narrowed rule one table down exists for.** That is the case this row has to answer and never did: there is no tag to prefer. `web.md` §9.6 requires `tabIndex={0}`, `role="region"` and a name on anything that scrolls sideways, so for half these sites the rule is asking for an element HTML does not have. |
| `jsx-a11y/anchor-has-content` | Content arrives through `children`, which it cannot follow. |
| `jsx-a11y/no-autofocus` | **Contested.** jsx-a11y bans it; WCAG does not. This product autofocuses two things: the first field of a form somebody deliberately opened, and the inline editor a click on a staged-list cell just summoned. Eleven sites, all one of those two shapes — four inline editors on the staging page and seven form fields, two of which are the pass-through props that carry the flag into the payee and category pickers (`src/client/forms.tsx:357`, `:665`) rather than fresh decisions. In both shapes focus lands where the person's own gesture was already headed. The one page that lays forms out rather than opening one — the duplicate review, a transaction form on each side — passes `autoFocus={false}` to both: nobody opened them, and each claiming focus left the cursor in whichever rendered last, halfway down the page. |

One is denied but reconfigured rather than silenced, and it is here because a
rule that is *narrowed* is the same kind of decision as one turned off:

| Rule | Why narrowed |
| --- | --- |
| `jsx-a11y/no-noninteractive-tabindex` | `roles` widened to accept `region`. `web.md` §9.6 is Binding under SC 2.1.1 — a container that scrolls horizontally has to be reachable by keyboard — and the sanctioned way to do that is `tabIndex={0}` plus `role="region"` and a name. The rule's default `roles` list is `["tabpanel"]` alone, so it refuses the exact pattern the accessibility rule requires. Every one of the fourteen sites is a named scroll region, and they are the same fourteen the `prefer-tag-over-role` row above is mostly about — two rules objecting to the two halves of one required pattern. |

Two more are denied but disabled at two individual sites, each carrying its
reason in the code: `jsx-a11y/no-static-element-interactions` at
`src/client/forms.tsx:569`, and both that and `click-events-have-key-events` at
`src/client/components.tsx:917`. Both are elements catching events that bubble
from real controls inside them.

*Checked by:* `npm run lint`, in `npm run verify`, for the rules themselves;
`tests/code-index-guide.test.ts` for the census above and the exemption tables,
which the linter cannot check because its whole job is to say nothing about
them.

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

### The formatter's scope is the repository, not three paths

**House**, and mechanized. The two halves of the toolchain do not agree about
what this repository is. `npm run lint` is bare `oxlint` (`package.json:26`),
which walks everything outside `.oxlintrc.json`'s five ignore patterns.
`npm run format` is `oxfmt src tests *.ts` (`package.json:28`), and
`format:check` the same three paths (`package.json:29`). Twenty-eight tracked
TypeScript and JavaScript files sit outside them — thirteen Pulumi modules under
`deploy/pulumi`, fourteen scripts under `scripts/`, and
`public/theme-boot.js`, which `.oxfmtrc.json` ignores anyway — and the linter
reads all of them while the formatter has never been pointed at one. The two
`*Checked by:*` footers above say `npm run lint` and `npm run format:check`
in the same breath, which reads as one toolchain over one tree.

**It is a live divergence rather than a latent one.** Five of those files fail a
format check today: `scripts/capacity/load.mjs`, `scripts/capacity/schedule.mjs`,
`scripts/ralph/git-guard.mjs`, `scripts/ralph/runner.mjs`, and
`scripts/set-version.mjs` — the tool the release procedure runs first
(`docs/upgrades.md:1379`). The infrastructure half is the reason nothing has
broken: all thirteen Pulumi modules happen to be clean, so the gap has stayed
invisible while `npm run verify` went on passing. `typescript.md` §3.5 records
the same gap from the other end, in the row of its comparison table that reads
`oxfmt` / yes / **no**.

**The obvious alternative is `oxfmt --check .`, and it does not work.** oxfmt
parses YAML, the Helm chart is nineteen Go-templated YAML files
(`deploy/helm/simple-balance/templates/`), and `{{- if .Values… }}` is not YAML:
the run dies with `Syntax error: unexpected indicator` and exits 2 before
checking anything. So widening this is a real decision with two forms — name the
TypeScript and JavaScript explicitly, or grow `.oxfmtrc.json`'s ignore list to
cover the templates — and not a one-word fix. Until one is taken, the honest
statement is that the formatter covers `src`, `tests` and the root configs, and
that the five files above are unformatted on purpose only in the sense that
nobody has formatted them.

*Checked by:* `tests/code-index-guide.test.ts`, which reads the scope out of the
`format` command itself and holds every count in this section to what that
leaves out — including the direction, so widening the command fails the test
until this section stops describing a gap that has closed. It also runs oxfmt
over the chart templates, because the paragraph above is the whole argument for
why widening is not free, and a tool that learned to skip them would retire it.

### The compiler

Seven settings were free — zero errors — and are on. `erasableSyntaxOnly` cost
five sites and is on. Four were measured and declined:

| Setting | Errors | Verdict |
| --- | --- | --- |
| `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`, `verbatimModuleSyntax` | 0 | On. |
| `erasableSyntaxOnly` | 5 | On. Two classes lost their constructor parameter properties. |
| `noImplicitReturns` | 3 | **Declined.** All three are Hono middleware, where returning nothing is the contract. See `typescript.md`. |
| `exactOptionalPropertyTypes` | 110 | Declined for now. |
| `noUncheckedIndexedAccess` | 575 | Declined for now, and it is the one most worth coming back to. See `typescript.md` §1.4. |
| `noPropertyAccessFromIndexSignature` | 966 | Declined. |

**The last three are readings, and this table needed saying so.** The lint
section above has carried that caveat for two releases; this one did not, so it
read as a current cost while standing at 71, 440 and 666 — about 40% under what
the work actually is, for the one row that tells somebody to come back to it.
They are `npx tsc --noEmit -p tsconfig.json --<flag>`, and `typescript.md` §1.4
is where they are argued, split and kept: the 575 is a reading there too, and
the 59 of it that are in `src` is the half a test holds, because a number every
new test file moves is one a check teaches people to bump without reading. The
first three rows are properties of the configuration rather than measurements
and stay put.

The obvious alternative was to re-measure all three here on every pass, which is
what left them stale: three numbers in two guides, re-measured in one of them.
So this table quotes `typescript.md` rather than the compiler, and
`tests/code-index-guide.test.ts` holds the two in agreement — a re-measurement
in either guide now fails until the other follows.

*Checked by:* `npm run typecheck`, in `npm run verify`, for the settings
themselves; `tests/code-index-guide.test.ts` for the three declined counts
agreeing with `typescript.md`.

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
