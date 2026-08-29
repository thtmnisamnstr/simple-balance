# Testing

Four tiers. What each one can see, what it cannot, and what makes a test worth
keeping.

| Tier | Files | Runs with | Needs |
| --- | --- | --- | --- |
| Unit (node) | 74 | `npm test` | nothing |
| Unit (jsdom) | 36 | `npm test` | nothing |
| Integration | 55 | `npm test` **or** `npm run test:integration` | PostgreSQL |
| Browser | 1 | `npm run test:browser` | PostgreSQL, Chromium |

**`npm test` collects the integration tier too**, which surprises people and is
worth stating plainly. `vitest.config.ts` excludes only `tests/browser`, so
`tests/integration` is collected on every run and each file skips itself when
`TEST_DATABASE_URL` is unset (5.1). What you get therefore depends on the
environment, not on the command:

| | Files | Tests |
| --- | --- | --- |
| `npm test`, no database | 111 pass, 54 skip | **1,089 pass, 633 skip** |
| `npm test`, database set | 165 pass | **1,722 pass** |
| `npm run test:integration` | 55 pass | 634 pass |

The third row is one test larger than the second row's skip count, and the odd
one out is worth knowing: `bulk-transactions-mcp.integration.test.ts` has one
`describe` outside the database guard, because discovering which tools a scope
exposes needs no ledger. It runs on every `npm test`, database or not.

The first row is what CI and `npm run verify` see, and 1,089 is the number that
actually gates a change by default. The second is what a developer with a local
PostgreSQL sees, and it is strictly better. Reporting the second as though it
were the first overstates what the gate covers, which is a mistake worth naming
because it is easy to make: both commands print a large green number.

The file counts in both tables are held by `tests/testing-guide-counts.test.ts`,
which counts the files on disk and reads the numbers back out of this page. The
test counts beside them are not: they move with every test anyone adds, and a
check that has to be updated by the change it is checking teaches people to
update it without reading it. Read those four as the ratio they illustrate.

## 1. Choosing a tier

**House.** Put a test in the cheapest tier that can actually see the thing.
"Can see" is the whole rule, and it is easy to get wrong in both directions.

- **Node unit** for pure functions: money arithmetic, recurrence dates, name
  normalisation, `resolveEntrySide`. Most of the value in this repository is
  here because most of the rules are pure.
- **jsdom** for what a form does with what it is given. It renders React
  properly and it is fast.
- **Integration** for anything involving SQL, transactions, locks or versions.
  A mocked database tests the mock.
- **Browser** for what only a browser computes.

### 1.1 What jsdom cannot see

**Binding**, in the sense that getting it wrong produces a test that passes
while the product is broken. Two known cases, both found the hard way:

- **Implicit ARIA roles.** jsdom does not give `<input list="…">` the `combobox`
  role that HTML-AAM specifies. A `getByRole("combobox")` that passes in
  Playwright fails in jsdom, and vice versa after an ARIA change.
- **Layout, focus order, and anything computed from CSS.** There is no layout
  engine.

Two budget defects were invisible to jsdom and visible in a browser, which is
why the browser tier exists at all.

*Checked by:* `human`. Both cases are covered where they were found and nowhere
else: `tests/browser/budgets.spec.ts` reaches the payee `<input list>` by the
`combobox` role jsdom withholds, and its "keyboard reaches the whole page"
presses Tab against a real layout. A page with no browser spec makes the same
two assumptions with nothing watching.

### 1.2 The browser tier is small on purpose

**House.** Eleven tests, one file, one worker, against a real API and a real
PostgreSQL. It is slow and it is the only tier that proves the whole stack
works, so it covers a path per capability rather than a case per branch.

Everything it asserts that a cheaper tier could assert is a test in the wrong
place.

**CI runs it, on one combination.** It was written and then run only by
whoever remembered, which is how two of its assertions came to be pinning a
header value the code had stopped sending: the tier that exists to prove the
whole stack was the tier nothing exercised. It runs on one Postgres and one Node
rather than on the four-way matrix, because what it proves does not vary with
either and it starts three processes to prove it.

**It has to survive being run twice.** It signs up a fresh person per run, and
on an empty database that person is the first account and lands on the sign-up
form; on every run after, the same database already has one and the form starts
at sign-in. The helper used to ask whether the toggle between them was visible
without waiting, which is a question asked before the options query answers: it
passed on an empty database and failed on every subsequent run against the same
one. A browser spec that only passes once is a spec that will be declared flaky
and deleted.

*Checked by:* `tests/testing-guide-counts.test.ts` for the size, which counts
`tests/browser` on disk against the tier table at the top of this page: a second
spec file cannot appear without somebody editing the sentence that says why
there is one. What the eleven tests choose to assert is nobody's check but a
reviewer's.

## 2. What makes a test worth keeping

### 2.1 A test name is a sentence about behaviour

**House.** "lowers the category a refund came back to", not "test refund case
2". The name is what somebody reads when it fails at 2am, and it should tell
them what the product promised.

*Checked by:* `human`.

### 2.2 A test asserts the outcome, not the mechanism

**House.** Assert that the budget moved, not that a particular function was
called with particular arguments. Mechanism assertions fail on refactors that
changed nothing and pass through rewrites that changed everything.

The strongest form is money: `tests/integration/budgets.integration.test.ts`
proves a refund into a spending category by reading the budget report and
finding less spent. Nothing about how it got there.

*Checked by:* `human`.

### 2.3 A test that only your understanding could have written is dangerous

**House, and the most important entry in this guide.**

A test asserts what its author believed. When the author is wrong, the test pins
the bug. This happened here: a budget test asserted that a range starting
mid-period should compare a month's limit against part of a month's spending.
It passed for two rounds of review, because it was the defect written down as a
requirement.

Three things reduce it, and none of them eliminate it:

- **Derive the expected value independently.** Compute 200 − 155.50 − 30 by hand
  in the comment. If the expected number comes out of the implementation, the
  test is a change detector.
- **Ask what would be true if the feature worked.** Not "what does it return".
- **Prefer end-to-end proof for anything about money.** A report figure is
  harder to be confidently wrong about than an intermediate.

*Checked by:* `human`. Mutation testing (3.1) is the nearest thing to a check
and it is a technique somebody runs, not a gate.

### 2.4 A test is order-independent

**Binding for `tests/integration/budgets.integration.test.ts`; aspirational elsewhere.**

Each test creates the data it needs. Run under `--sequence.shuffle`, the budget
integration file passes. The wider integration suite does not — 68 failures
across 26 files — because much of it is written as a sequence against shared
fixtures.

That is recorded rather than fixed because fixing it is a large change with a
small payoff, and pretending otherwise would be worse than saying so. New files
are order-independent.

*Checked by:* `npx vitest run tests/integration/budgets.integration.test.ts --sequence.shuffle`.

### 2.5 An idempotency key generator cannot collide

**Binding.** See `services.md` 2.3. Pad the counter, not the string.

*Checked by:* `human` for the keys a test builds — where two collide the second
call returns the first one's row, and every assertion after it reads something
nobody wrote. `tests/idempotency-key.test.ts` holds the other generator, the one
the product ships: "does not repeat itself" draws 500 keys from the path taken
when `crypto.randomUUID` is missing and counts them.

## 3. Techniques that found real defects

### 3.1 Mutation testing

Break the implementation on purpose and check that a test notices. Measured at
**31%** on the budget code before this was taken seriously, meaning two thirds
of deliberate breakages went undetected by a suite that looked thorough.

It is not wired into `npm run verify` — it is slow and it is a review technique
rather than a gate. Use it when a piece of code matters and the tests feel
generous to themselves. Both defects that survived two review rounds were found
this way.

### 3.2 Property testing

Generate randomised ledgers and assert the laws rather than the cases. 100
random ledgers and an exhaustive 3,754 (plan, period) window pairs found the
period-independence violation that every hand-written case had agreed with.

Use it where a rule is stated as an invariant — "a range chooses which periods
to show, it does not slice them" — because that phrasing *is* a property.

### 3.3 Reverse parity

`tests/mcp-parity.test.ts` checks both directions: every route has a tool, and
every route is called from `src/client`. The second direction is what stops the
agent surface growing past the browser.

Its known limit: it compares **routes**, not fields. `categoryKind` was a
request field the MCP documented and the browser never sent, and parity was
green throughout. `tests/new-category-kind-ui.test.tsx` closes that one case;
the general gap is open and named in `client.md` 4.

*Checked by:* `tests/mcp-parity.test.ts`, once per direction: "has a tool for
every route that is not a named exception", and "calls every route that is not a
named agent-only exception", which looks for each route's literal prefix
anywhere under `src/client`. An entry in either exception list has to carry a
reason long enough to be one.

## 4. The vitest plugin is off

**Contested, decided.** `oxlint --vitest-plugin` reports 272 findings on this
suite. 189 of them are false against Vitest's own API:

- **`valid-expect`, 89.** It refuses `expect(value, message)`. That is a Jest
  rule; in Vitest the second argument is the assertion message and is correct.
- **`valid-describe-callback` and `valid-title`, 100.** Both fire on
  `const integration = describe.skipIf(!connection)` — the alias every
  integration file uses to skip cleanly without a database — one of each in the
  fifty files that declare it, and in no file that does not. The plugin cannot
  see through the alias.

A plugin that is 69% wrong on this codebase would train everybody to ignore
lint output. Off, and this section is the reason so nobody turns it back on.

Those four numbers read 231, 163, 65 and 98 when this was written, and nothing
holds them to the suite. They climb with it, because the two shapes the plugin
misreads are the shapes a new integration file and a new message-carrying
assertion both use, so the finding count grows fastest exactly where it is
wrongest. Re-measure with `npx oxlint --vitest-plugin --format=json` rather than
quoting these. What decides the section is the proportion, and two points in the
proportion is not a change of mind.

## 5. Support

### 5.1 A test file that needs a database says so, once

**House.** `describe.skipIf(!process.env.TEST_DATABASE_URL)`, so the file skips
rather than fails when the fast suite runs. `npm run test:integration` uses a
separate config whose global setup **requires** the variable
(`vitest.integration.config.ts`), so the integration run cannot pass by
skipping everything — the one failure mode that pattern otherwise invites.

*Checked by:* `npm run test:integration` for that second half:
`tests/integration/support/require-database.ts` throws before a file is
collected when `CI` is set and the variable is empty. The first half is nobody's
check — a new file that forgets the guard does not skip, it tries to connect,
which fails where there is no database to reach and quietly succeeds where there
is.

### 5.2 Each integration file owns its database

**House.** Create a scratch database named for the file and the process, migrate
it, drop it in `afterAll`. Files then do not race, which matters because
`fileParallelism` is off but worktrees and repeat runs still overlap.

### 5.3 Stubbed globals are unstubbed

**Binding.** `unstubGlobals: true` in `vitest.config.ts`, because
`vi.restoreAllMocks` does not undo `vi.stubGlobal`. Without it a file that stubs
`fetch` serves the next file's requests, and the failure surfaces somewhere
unrelated.

*Checked by:* `human`. Nothing reads `vitest.config.ts` back, and six files stub
a global and leave the undoing to the runner, so deleting the line breaks
whichever file happens to run after one of them rather than anything that names
the setting.

## 6. Tests that hold this guide set

| Test | Holds |
| --- | --- |
| `tests/standards-citations.test.ts` | Every citation a guide makes, in all three forms, plus every internal link and heading anchor. |
| `tests/testing-guide-counts.test.ts` | The file counts in both tables at the top of this page, recounted from disk. The test counts beside them are deliberately left alone. |
| `tests/comment-density.test.ts` | The density `AGENTS.md` and `comments.md` both quote: one number in both places, within a point and a half of what `src` measures, and the counts behind it exactly. |
| `tests/lint-budget.test.ts` | The lint warning budget, per rule and ratcheted down only. All three rules it once held are cleared and now denied outright, so every budget in it reads zero and the linter fails before this test is reached. What is left is the rule that starts warning and that nobody has decided about. |
| `tests/lint-config-documented.test.ts` | Every rule `.oxlintrc.json` silences or downgrades, and every plugin it enables, is explained in a guide. |
| `tests/mcp-measurements.test.ts` | Every number `mcp.md` quotes, against the live tool list. Four had drifted when it was written. |
| `tests/mcp-instructions.test.ts` | The server instructions carry each rule an agent otherwise learns by being refused. |
| `tests/table-overflow.test.ts` | Every table has a caption and every header cell a `scope`, alongside the scroll containment it started with. |
| `tests/transport-database-access.test.ts` | `services.md` 1.2, by the thing that goes wrong when it is broken: a query in `api.ts` or `mcp.ts` that is not one of the five carrying a written reason, and a reason still listed after the line it explains has gone. |
| `tests/migrations.test.ts` | The migration list in `AGENTS.md` matches the directory, both directions. |
| `tests/mcp-parity.test.ts` | Route parity between the two transports, both directions. |

Three of those rows arrived after the table did, and two more tests were
considered for it and left out. `tests/log-level.test.ts` and
`tests/metrics.test.ts` hold what the product does — a level gate that drops
what sits below it, a label set that carries nobody's identity — and both
`operations.md` and `observability.md` name each as its check, as these guides
between them name eighty-nine test files. A row here is the narrower case: the rule is written
down in the prose and nowhere else, so a repository that quietly stopped
following it would leave a true-sounding document and nothing that noticed.
Widen the table to every `*Checked by:*` line and it stops being a list and
becomes an index of the suite.

### 6.1 Citations come in three shapes, and the test knows all of them now

The guides cite the code three ways:

| Shape | Example |
| --- | --- |
| Full path | `` src/client/forms.tsx:312` `` |
| Bare filename | `` forms.tsx:312` `` — resolved by basename |
| Continuation | `` `:576` `` — inherits the last file the prose named |

The test knew only the first for a while, and that gap was expensive. Adopting
the formatter moved every line in `src`; the relocation pass repaired the
prefixed citations and left **120 bare and 104 continuation citations stale**,
with the test green throughout. Six checked by hand were all wrong.

A continuation's antecedent is genuine ambiguity, not a limitation of the test:
where a reader could not tell which file a bare `:NNN` follows either, the
citation is
now written out in full. Five were rewritten that way rather than guessed at.

### 6.2 What the citation test still cannot do

**Stated so nobody trusts it too far.** It proves a cited file exists, that the
line is inside it, and that the line has something on it. It cannot prove the
line still holds what the sentence claims.

That third check earns its place. A one-off scan for citations landing on a
closing brace found seven, and every one of the seven was pointing at the wrong
thing entirely — so "landed on a fragment" is a cheap proxy for "drifted", and
it is now part of the test rather than something somebody remembered to run. It
went in beside a fix to how a continuation finds its antecedent: a `*Checked
by:* ` line names its file without a line number, and until this the walk moved
its antecedent only on a citation that carried one, so three continuations under
one such line were being checked against a stylesheet named three paragraphs
above.

What is left is a citation that drifted onto a plausible line, and that is a
person's read. Line numbers in prose are evidence that rots. The test slows the
rot; it does not stop it.

**A renumbering pass matches content, not position.** Two passes here shifted
citations by the amount the file had moved, which is right for a citation whose
target moved by that amount and silently wrong for every other. 154 of 506 were
aiming at something else by the time anybody looked. If code moves under a
citation, find what the sentence names and cite where it is now; a pass that
cannot do that should leave the number alone and fail loudly instead.

## 7. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1 Cheapest tier that can see it | Judgement. |
| 1.1 What jsdom cannot see | A defect jsdom is blind to is one no jsdom run reports, so the only check is somebody deciding a case needs a browser. |
| 2.1 A test name is a sentence about behaviour | Editorial. |
| 2.2 Outcome, not mechanism | Judgement. A rule banning `toHaveBeenCalledWith` would fire on the tests where the call *is* the outcome, of which `tests/idempotency-key.test.ts` is one. |
| 2.3 A test only your understanding could have written | Judgement, and the reason for reviewing tests as carefully as code. |
| 2.4 Order independence, outside budgets | The wider suite does not hold it and is not going to soon. |
| 2.5 The keys a test builds | Nothing reads the key builders under `tests/`, and the suite cannot: the collision is what makes the test green. |
| 5.2 One database per file | Convention. |
| 5.3 Stubbed globals, if the setting goes | Nothing reads the runner configuration back, and the file that would fail is not the file that changed. |

Nine `human` rules in this guide, and it said four. Three of the difference is
rules that named no mechanism anywhere on the page, which is the state this
count exists to make uncomfortable; the rest is one row that read 2.1–2.3 and
counted once. Two of the nine are worth an attempt: 2.5 is a scan of `tests/`
for the `padEnd` shape it was, and 5.3 is a test that reads one line of
`vitest.config.ts`, which is what `tests/theme-tokens.test.ts` already does to a
stylesheet.
