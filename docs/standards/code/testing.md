# Testing

Four tiers. What each one can see, what it cannot, and what makes a test worth
keeping.

| Tier | Files | Runs with | Needs |
| --- | --- | --- | --- |
| Unit (node) | 71 | `npm test` | nothing |
| Unit (jsdom) | 36 | `npm test` | nothing |
| Integration | 52 | `npm test` **or** `npm run test:integration` | PostgreSQL |
| Browser | 1 | `npm run test:browser` | PostgreSQL, Chromium |

**`npm test` collects the integration tier too**, which surprises people and is
worth stating plainly. `vitest.config.ts` excludes only `tests/browser`, so
`tests/integration` is collected on every run and each file skips itself when
`TEST_DATABASE_URL` is unset (5.1). What you get therefore depends on the
environment, not on the command:

| | Files | Tests |
| --- | --- | --- |
| `npm test`, no database | 108 pass, 51 skip | **1,032 pass, 582 skip** |
| `npm test`, database set | 159 pass | **1,614 pass** |
| `npm run test:integration` | 52 pass | 583 pass |

The first row is what CI and `npm run verify` see, and 1,032 is the number that
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

### 1.2 The browser tier is small on purpose

**House.** Eleven tests, one file, one worker, against a real API and a real
PostgreSQL. It is slow and it is the only tier that proves the whole stack
works, so it covers a path per capability rather than a case per branch.

Everything it asserts that a cheaper tier could assert is a test in the wrong
place.

## 2. What makes a test worth keeping

### 2.1 A test name is a sentence about behaviour

**House.** "lowers the category a refund came back to", not "test refund case
2". The name is what somebody reads when it fails at 2am, and it should tell
them what the product promised.

### 2.2 A test asserts the outcome, not the mechanism

**House.** Assert that the budget moved, not that a particular function was
called with particular arguments. Mechanism assertions fail on refactors that
changed nothing and pass through rewrites that changed everything.

The strongest form is money: `tests/integration/budgets.integration.test.ts`
proves a refund into a spending category by reading the budget report and
finding less spent. Nothing about how it got there.

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

## 4. The vitest plugin is off

**Contested, decided.** `oxlint --vitest-plugin` reports 231 findings on this
suite. 163 of them are false against Vitest's own API:

- **`valid-expect`, 65.** It refuses `expect(value, message)`. That is a Jest
  rule; in Vitest the second argument is the assertion message and is correct.
- **`valid-describe-callback` and `valid-title`, 98.** Both fire on
  `const integration = describe.skipIf(!connection)` — the alias every
  integration file uses to skip cleanly without a database. The plugin cannot
  see through it.

A plugin that is 71% wrong on this codebase would train everybody to ignore
lint output. Off, and this section is the reason so nobody turns it back on.

## 5. Support

### 5.1 A test file that needs a database says so, once

**House.** `describe.skipIf(!process.env.TEST_DATABASE_URL)`, so the file skips
rather than fails when the fast suite runs. `npm run test:integration` uses a
separate config whose global setup **requires** the variable
(`vitest.integration.config.ts`), so the integration run cannot pass by
skipping everything — the one failure mode that pattern otherwise invites.

### 5.2 Each integration file owns its database

**House.** Create a scratch database named for the file and the process, migrate
it, drop it in `afterAll`. Files then do not race, which matters because
`fileParallelism` is off but worktrees and repeat runs still overlap.

### 5.3 Stubbed globals are unstubbed

**Binding.** `unstubGlobals: true` in `vitest.config.ts`, because
`vi.restoreAllMocks` does not undo `vi.stubGlobal`. Without it a file that stubs
`fetch` serves the next file's requests, and the failure surfaces somewhere
unrelated.

## 6. Tests that hold this guide set

| Test | Holds |
| --- | --- |
| `tests/standards-citations.test.ts` | Every citation a guide makes, in all three forms, plus every internal link and heading anchor. |
| `tests/lint-budget.test.ts` | The 31 open lint warnings, per rule, ratcheted down only. Also fails on a warning nobody has budgeted. |
| `tests/lint-config-documented.test.ts` | Every rule `.oxlintrc.json` silences or downgrades, and every plugin it enables, is explained in a guide. |
| `tests/mcp-measurements.test.ts` | Every number `mcp.md` quotes, against the live tool list. Four had drifted when it was written. |
| `tests/mcp-instructions.test.ts` | The server instructions carry each rule an agent otherwise learns by being refused. |
| `tests/table-overflow.test.ts` | Every table has a caption and every header cell a `scope`, alongside the scroll containment it started with. |
| `tests/migrations.test.ts` | The migration list in `AGENTS.md` matches the directory, both directions. |
| `tests/mcp-parity.test.ts` | Route parity between the two transports, both directions. |

### 6.1 Citations come in three shapes, and the test knows all of them now

The guides cite the code three ways:

| Shape | Example |
| --- | --- |
| Full path | `` `src/client/forms.tsx:294` `` |
| Bare filename | `` `forms.tsx:294` `` — resolved by basename |
| Continuation | `` `:558` `` — inherits the last file the prose named |

The test knew only the first for a while, and that gap was expensive. Adopting
the formatter moved every line in `src`; the relocation pass repaired the
prefixed citations and left **120 bare and 104 continuation citations stale**,
with the test green throughout. Six checked by hand were all wrong.

A continuation's antecedent is genuine ambiguity, not a limitation of the test:
where a reader could not tell which file `:93` follows either, the citation is
now written out in full. Five were rewritten that way rather than guessed at.

### 6.2 What the citation test still cannot do

**Stated so nobody trusts it too far.** It proves a cited file exists and the
line is inside it. It cannot prove the line still holds what the sentence
claims. The relocation left a handful pointing at a closing brace, and that was
found by a separate one-off check for meaningless target lines, not by the test.

Line numbers in prose are evidence that rots. The test slows the rot; it does
not stop it.

## 7. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1 Cheapest tier that can see it | Judgement. |
| 2.1–2.3 What makes a test good | Judgement, and the reason for reviewing tests as carefully as code. |
| 2.4 Order independence, outside budgets | The wider suite does not hold it and is not going to soon. |
| 5.2 One database per file | Convention. |

Four `human` rules in this guide.
