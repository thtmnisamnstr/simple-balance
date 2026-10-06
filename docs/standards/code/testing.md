# Testing

Four tiers. What each one can see, what it cannot, and what makes a test worth
keeping.

| Tier | Files | Runs with | Needs |
| --- | --- | --- | --- |
| Unit (node) | 208 | `npm test` | nothing |
| Unit (jsdom) | 63 | `npm test` | nothing |
| Integration | 80 | `npm test` **or** `npm run test:integration` | PostgreSQL |
| Browser | 7 | `npm run test:browser` | PostgreSQL, Chromium |

**`npm test` collects the integration tier too**, which surprises people and is
worth stating plainly. `vitest.config.ts:21` excludes four things and only two
of them are about tests: `tests/browser`, which belongs to Playwright and fails
at import under this runner, and `**/.claude/worktrees/**`, because a worktree
checked out inside the repository is a second copy of every test and the two
copies of the integration tier then race each other for one database. Neither is
an exception to the tiers; both are other people's files arriving in the glob.
`tests/integration` is collected on every run and each file skips itself when
`TEST_DATABASE_URL` is unset (5.1). What you get therefore depends on the
environment, not on the command:

| | Files | Tests |
| --- | --- | --- |
| `npm test`, no database | 273 pass, 78 skip | **2,939 pass, 903 skip** |
| `npm test`, database set | 351 pass | **3,842 pass** |
| `npm run test:integration` | 80 pass | 906 pass |

The integration tier reports 906 tests on its own and 903 skips inside a
database-less `npm test`, and the three-test difference is not an error: three
cases in that tier need no database and so run either way. They are counted
among the 2,939 rather than among the skips, which is why the two rows add up
to 3,842 both times.

The third row is three tests larger than the first row's skip count, and the
odd ones out are worth knowing. `bulk-transactions-mcp.integration.test.ts` has
one `describe` outside the database guard, because discovering which tools a
scope exposes needs no ledger, and `tenant-isolation-routes.integration.test.ts`
has two, because whether every route that names a record has a probe is a
question about the router rather than about a ledger. All three run on every
`npm test`, database or not, and that file therefore counts as passing rather
than skipped in the first row.

The first row is what CI and `npm run verify` see, and 2,939 is the number that
actually gates a change by default. The second is what a developer with a local
PostgreSQL sees, and it is strictly better. Reporting the second as though it
were the first overstates what the gate covers, which is a mistake worth naming
because it is easy to make: both commands print a large green number.

The file counts in both tables are held by `tests/testing-guide-counts.test.ts`,
which counts them on disk and reads the numbers back out of this page. The test
counts beside them are held differently and less: the filesystem cannot count
tests — `it.each` and a `describe` in a loop each produce a number only a run
knows — so what is checked is that the three figures agree with each other and
with the sentence below this table that quotes the total.

That is worth being precise about, because it is the weaker half that matters.
Arithmetic catches a figure edited on its own and catches nothing at all when
all three are edited together, which is exactly what a careless update does.
**Nothing checks that any of them is a number a run actually printed**, and all
three can therefore be wrong at once with the suite green. They were. Re-measure
rather than adjust: `npm test` prints the first row and `npm run test:integration`
the third.

## 1. Choosing a tier

**House.** Put a test in the cheapest tier that can actually see the thing.
"Can see" is the whole rule, and it is easy to get wrong in both directions.

- **Node unit** for pure functions: money arithmetic, recurrence dates, name
  normalization, `resolveEntrySide`. Most of the value in this repository is
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

**House.** Seven files, one worker, against a real API and a real PostgreSQL.
`budgets.spec.ts` is the one that drives flows — twenty-three tests of a
person getting through the budgets page — and the other six are each here
rather than in jsdom for the reason 1.1 gives: what they assert is something
only a layout, paint or focus engine computes. `plan-buttons.spec.ts` measures an
offset between two buttons, `progress-paint.spec.ts` reads a progress bar's
pixels, `reflow.spec.ts` and `target-size.spec.ts` measure the document and
every target, `selection-bar.spec.ts` measures one bar in each state its
controls can take, and `smoke-test-fixes.spec.ts` holds what a smoke test of a
0.2.0 deployment found — where focus lands after a dialog closes, whether a
transitioned drawer can take focus, whether a long figure pushes the page
sideways. The tier is slow and it is the only one that proves the
whole stack works, so it covers a path per capability rather than a case per
branch. `tests/testing-guide-counts.test.ts` holds the first of those numbers
to the file it counts, because it sat at eleven while the file grew to eighteen
and nothing noticed; the others are held by nothing finer than the tier table
above.

Everything it asserts that a cheaper tier could assert is a test in the wrong
place.

**One spec does not drive the whole stack, and that is the boundary.** `plan-buttons.spec.ts:110` intercepts the one response the plan tab
reads and answers it from the spec. The reason is not convenience: a priced
button exists only at a price Stripe gave, so reaching that state for real needs
a Stripe account, its keys in the server's environment, and a subscription
already running against them — and the last of those charges a card. Everything
below the response is the real server, the real stylesheet and the real
components, which is the half the measurement is about.

The rule above is hardest to apply to exactly this spec, so it is worth saying
where the line falls. `tests/plan-page-ui.test.tsx` already reads the fix out of
the stylesheet and already fakes the same response; what it cannot do is ask the
browser where the two buttons ended up, because jsdom has no layout engine
(1.1). So the browser spec earns its place by the measurement and by nothing
else, and a faked response is the cheapest way to reach the state it measures —
not a second, worse copy of the jsdom test. A spec that faked a response and
then asserted what the page said about it would be in the wrong place.

**Holding a request is not faking one.** `selection-bar.spec.ts` intercepts the
staged commit too, and answers nothing: it holds the request open while it
measures the bar in its busy state, then aborts it. A busy state lasts as long
as the request does, which on a fast machine is shorter than a measurement, so
a timer would make the check pass or fail by the machine it ran on. Every
response the page acts on is still the real server's, and the abort is what
keeps the queue the spec seeded the queue it leaves.

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
`tests/browser` on disk against the tier table at the top of this page: a spec
file cannot appear without somebody editing the sentences that say how many
there are. It did not stop this section saying "one file" and "the two specs"
for three releases after there were five, because it counts the table and not
the prose — so the prose names the files, and the same test holds that list to
`tests/browser` ("names every browser spec in 1.2"). What the specs choose to
assert is nobody's check but a reviewer's.

### 1.3 Deployment material is read as text here and rendered where the tool is

**House.** The four tiers above are about the product. A fifth body of work sits
outside all of them and the table has no row for it: the chart, the compose
files, the Dockerfiles, the cloud programs and the workflows. Thirty-seven of
the node tier's files read something under `deploy/`, and all but three of those
import nothing from `src` at all — nearly a quarter of the tier this page otherwise
describes as pure functions, doing something the tier table does not mention.

**The division is by what is on the PATH.** `helm` is not on this job's, so what
a test here can hold is what the chart *says*: that `database.enabled` starts
false, that a values file written for the previous release still installs, that
a hook carries the weight it needs. What the chart *produces* is held beside the
render, in the `deployment material` job of `.github/workflows/verify.yml:134`,
which runs the real tool through a pinned image.

**Neither half is sufficient, and they fail differently.** A template that
renders nothing satisfies every text check anybody writes about it — that is why
the NetworkPolicy and the `ha` database are rendered separately, each with its
feature turned on, and checked by kind. And a template whose program deletes in
the wrong order renders perfectly; only `helm` applying weights in order can say
otherwise. So the text half may not quietly become the only one, which is what
this rule is really protecting: the render lives in a workflow, and a workflow
job is one line away from being deleted by somebody who sees the local suite
still green.

Parsing the YAML ourselves is the obvious alternative and it is wrong for the
reason the workflow states in a comment of its own: a chart that lints can still
fail to template, so a parser written here would be a second implementation of
the tool, and every disagreement between the two would be a defect in the one
that nobody deploys with.

*Checked by:* `tests/testing-guide-deployment.test.ts`, from both sides. It
discovers the files that read `deploy/`, refuses any test that invokes `helm`,
`kubectl`, `pulumi` or `docker`, and asserts that the workflow still lints the
chart and still renders it with each gated feature turned on. The first half is
why a test cannot silently become machine-dependent; the second is the only
thing standing between a deleted CI job and a chart nobody renders again.

## 2. What makes a test worth keeping

### 2.1 A test name is a sentence about behavior

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

**The footer below was a command that failed about two runs in five**, and the
four tests that did it are worth knowing because none of them was sloppy. Each
read a figure that is true of what it created and is also a property of
something larger:

- `rollover.from` is the earliest `activeFrom` across *every* plan the actor
  holds (`src/server/services/budgets.ts:1111`). The forecast tests anchor one
  in 2020 to give a stepped chain a base, so shuffled ahead of it the carry
  origin answered 2020.
- `period.unfunded` is null when nobody anywhere set a funding order, which the
  ranked tests set.
- Two more read `periods.every(…)` and `periods.at(-1)` on a report with no
  budgets in it yet. `every` over an empty list is true, so one of them asserted
  nothing and then failed on the `false` it expected; the other threw. That is
  2.6 happening inside a test rather than to one.

The first two now own a person nobody else writes to, which is what makes a
ledger-wide figure a figure about them; the last two create a budget first and
say that they found one. Subtracting the fixture's contribution was the obvious
alternative and is the change detector 2.3 is about: the expected value would
then be derived from whatever the rest of the file happens to do.

*Checked by:* `npx vitest run -c vitest.integration.config.ts tests/integration/budgets.integration.test.ts --sequence.shuffle`,
which needs `TEST_DATABASE_URL`. Twenty-five consecutive shuffled runs pass. It
is a command rather than a test because one shuffle proves nothing — a green run
is evidence only in quantity, which is also why this rule is Binding for one
file and not for the suite.

### 2.5 An absence is only checked beside a presence

**Binding for the browser tier; house elsewhere.**

`toHaveCount(0)` is true of a page that has not finished loading, of a table
mid-re-read, and of a subject that was never created. So an assertion that
something is gone is paired with one that something else is there, in the same
state, and the pair is what makes the absence mean anything.

The test this comes from checked a control that hides unbudgeted rows by
asserting that no cell on the page read `—`. Two things were wrong with it and
CI found both. The dash is not only what an unbudgeted row shows — a budget that
does not roll over prints one under "carried in" whenever something else in the
period carries — so the assertion could only pass in the moment between
unchecking the box and the table coming back with its answer. A fast machine won
that race and CI's did not, four times. And the report at that point held no
unbudgeted row at all, so the passes were about nothing either way.

It now makes a category with spending and no budget, watches that row leave, and
checks a budgeted row is still there in the same breath. Only a table that has
re-read can satisfy both.

*Checked by:* `human`. A lint rule could find a bare `toHaveCount(0)` but not
whether the positive beside it is about the same state, which is the whole
rule.

### 2.6 A check about a kind of file discovers its population

**Binding.** A test that makes a claim about *every* file of some kind finds them
by walking the tree. It does not carry a list of their paths.

The distinction that matters is between a population and an exception. The
population is what the claim is about, and it is discovered — `sourceFiles` for
modules under `src/`, `repoFiles` for anything else
(`tests/support/source.ts`). An exception is a member of that population the rule
deliberately excuses, and it *is* written down, named, and argued: the
`CONFIGURATION_LAYER` array in `tests/log-level.test.ts` and `ALLOWED` in
`tests/transport-database-access.test.ts` are correct precisely because they are
exceptions rather than populations.

**A list is a claim about what exists, made once, by somebody who could not see
what would be added.** This is not a hypothetical, and 0.2.0 is where it was paid
for three times over:

- `tests/deployment-docs.test.ts` checked that a readiness probe waits for the
  real PostgreSQL rather than the temporary one initdb runs. It listed the files
  to read, and missed four of the five places that wait — including the `vps`
  profile's own recipe and the upgrade note's own procedure.
- `tests/dockerfile.test.ts` held "every image pins its base by digest and labels
  itself", over four hardcoded paths, while the tree held five. The database
  image added that release was checked by nothing at all, in a release where
  `docs/standards/operations.md` claimed every image was.
- The compose hardening check read one file by name. Five more arrived in the
  same release, and the capacity harness turned out to be running the application
  image with no `cap_drop` and no `no-new-privileges` — which makes a measurement
  taken against a container configured unlike the deployment.

Each of those tests passed throughout. That is the property worth fearing: a list
does not fail when the world grows past it, it just quietly stops being about
everything.

**Discovery needs one assertion of its own**, because an empty population passes
every claim made over it. A sweep whose matcher stops matching is
indistinguishable from a tree that complies, so each of these asserts that it
found what it expected to find before asserting anything about it.

That half took two passes to land, which is the part worth remembering. The
readiness sweep was the example this section was written from and was the one
that went on discovering its files and never counting them, for a release: a
probe spelled some other way would have emptied its population and left the
check green over nothing, exactly the failure the list it replaced had.
`tests/deployment-docs.test.ts:163` is the assertion, a floor and one named
path, in the shape the compose sweep below it was already using.

The obvious alternative — listing the files, and adding to the list when you add
a file — is what was already being done. It asks the person adding a file to
remember a test they have never read, which is the kind of discipline that works
until the day it matters.

**The 0.2.1 sweep found nine more, every one of them passing over less than it
claimed.** The browser tier's reflow and target-size specs visited thirteen and
three of the twenty-six URLs the router declares, and read the router now. The
parity check compared seven of forty write tools and now takes every tool
`tools/list` does not annotate read-only. The radio-group check missed the
Settings page's group; the page-header check read twelve of twenty-one
headers; the money-control check found fourteen of sixteen controls; the
cluster encryption check read one of three programs; the startup read of the
bounded limits named six of seven; the closed-set settings table held two of
the four booleans `getConfig` reads; and the page-level blocks missed five.
Each now derives its population from the source it is about, and three of them
were hiding real defects: two money fields labeled by hand, two StorageClasses
that state no encryption, and a limit nothing read at startup.

*Checked by:* nothing mechanical, and the honest reason is that "this array is a
population rather than an exception" is a judgement a test cannot make. What can
be said is that all three sweeps now discover *and* count, each proved by
breaking it on purpose and watching it name the breakage: a non-compliant file
for the claim, and a renamed matcher for the population.

There is no general check of the population half either, and the reason is worth
stating rather than leaving as an absence. Every sweep that discovers one does
assert it today, in one of two shapes: a floor with a named member where the
tree is expected to grow, and an exact list where it is not —
`tests/transport-database-access.test.ts:132` names the two transports outright,
and `tests/forecast-boundary.test.ts:48` names everything allowed to import the
forecast. A grep that knew only the first shape would call both of those silent,
and a rule that fires on a correct test is a rule people turn off. Which shape a
sweep should use is the same judgement as population-versus-exception, one step
along.

### 2.7 An idempotency key generator cannot collide

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

The plan tab and the Stripe seam were done this way throughout, which is the
largest use of it here: every behavior change broken on purpose, the named test
watched to fail, the file restored, the test watched to pass. It paid for
itself the way this section predicts — five tests were green and proving
nothing, among them one that accepted any wording where the wording was the
point, and one that never rendered under `StrictMode`, where a guard against
the double invoke was the whole of what it claimed to hold. Each was
strengthened before the mutation was thrown away, which is the
half worth insisting on: a survivor is a finding about the test, and deleting
the mutation without fixing the test converts it back into nothing.

### 3.2 Property testing

Generate randomized ledgers and assert the laws rather than the cases. 100
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

**Contested, decided.** `oxlint --vitest-plugin` reports 625 findings on this
suite. 397 of them are false against Vitest's own API:

- **`valid-expect`, 263.** It refuses `expect(value, message)`. That is a Jest
  rule; in Vitest the second argument is the assertion message and is correct.
- **`valid-describe-callback` and `valid-title`, 134.** Both fire on
  `const integration = describe.skipIf(!connection)` — the alias every
  integration file uses to skip cleanly without a database — one of each in the
  sixty-seven files that declare it, and in no file that does not. The plugin
  cannot see through the alias.

A plugin that is 64% wrong on this codebase would train everybody to ignore
lint output. Off, and this section is the reason so nobody turns it back on.

**The remainder is not 228 real findings either.** The second-largest rule in
the whole output is `require-mock-type-parameters`, 146 of them, and every one
says the same thing: `vi.fn()` should have been `vi.fn<() => void>()`. That is a
style preference about a call Vitest types perfectly well without it, and this
repository has not adopted it. Counting it among the findings a reviewer would
act on is what the first two paragraphs warn about, one level down — so the
remainder that is actually about this suite's behavior is 82, not 228. The four
smaller rules that make it up are the ones worth a look if the plugin is ever
reconsidered.

Those numbers read 272, 189, 89 and 100 one release ago, and before that 231,
163, 65 and 98. Nothing holds them to the suite. They climb with it, because the
shapes the plugin misreads are the shapes a new integration file and a new
message-carrying assertion both use, so the finding count grows fastest exactly
where it is wrongest. Re-measure with
`npx oxlint --vitest-plugin --format=json` rather than quoting these. What
decides the section is the proportion, and two points in the proportion is not a
change of mind — but a rule arriving with a fifth of the output and no mention
here would be.

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

The sequence has a helper, and a new file should take it rather than re-roll
it: `scratchDatabase()` in `tests/integration/support/scratch-database.ts`
creates, migrates and registers the drop in one call, and 43 of the 70 files
use it. The files that predate it manage their own admin client, and their
teardowns had drifted to an unguarded four-step sequence where the first step
throwing strands the database and the connection both — the exact failure the
helper exists to end, and its docstring says so. `dropScratchDatabase` covers
the 13 hand-rolled files that only need the guarded teardown.

Forty-three, thirteen and fourteen, which is the whole seventy. The last
fourteen take neither helper and hand-roll all of it — their own admin client,
their own `create database`, their own `runMigrations`, their own drop. They are
not doing anything else; they are the group the helper was written for and the
group nothing has converted yet. Counting them is the point of writing the three
numbers down.

### 5.3 Stubbed globals are unstubbed

**Binding.** `unstubGlobals: true` in `vitest.config.ts`, because
`vi.restoreAllMocks` does not undo `vi.stubGlobal`. Without it a file that stubs
`fetch` serves the next file's requests, and the failure surfaces somewhere
unrelated.

*Checked by:* `tests/vitest-settings.test.ts`, which imports the configuration
and reads the value the runner is handed rather than the file's text. Nothing
read `vitest.config.ts` back for four releases, and seven files stub a global
and leave the undoing to the runner, so deleting the line broke whichever file
happened to run after one of them rather than anything that named the setting —
the worst debugging shape in the suite, and the reason this is worth two lines.
5.4's `fileParallelism` is held in the same file and for the same argument.

### 5.4 A file that turns a feature on turns it off again

**House.** `unstubGlobals` above does the globals and does nothing at all for
the environment, and 5.3's argument applies to it unchanged: file parallelism is
off, so every file in a tier shares one process and a variable one of them sets
is still set for whatever runs next.

That became load-bearing with billing. Turning the vendor on means setting
`STRIPE_SECRET_KEY` and four more, and a file that forgets to put them back
hands the next file a product that sells subscriptions. Thirty-four files flip a
switch today, in three spellings — a key at a time in thirteen of them,
`vi.stubEnv` in three, and a whole object merged into `process.env` in eighteen.
Thirty-three of them restore, by discipline rather than by machinery. The
thirty-fourth did not: `ledger.integration.test.ts` left Google credentials,
`AUTH_MODE=both` and an `ALLOWED_EMAILS` behind, which is a sign-in path and a
registration rule the next file never asked for, and nothing anywhere would have
said so.

**The variables are only half of it.** `src/server/config.ts:227` caches the
parsed configuration in a module-level variable, so a file that turns something
on also has to call `vi.resetModules()` before the next read. The environment
can be perfectly restored and the configuration still answer out of the previous
file's keys, which is the failure that reads as "this test passes alone and not
in the suite".

Turning on `unstubEnvs` in the runner is the obvious alternative and it closes
neither half. It undoes `vi.stubEnv` and nothing else, so the thirty-one files
that assign or merge directly are untouched — and it says nothing about the
cache, which is what actually carries the leak.

*Checked by:* `tests/testing-guide-environment.test.ts`, which discovers the
files that set a switch in any of the three spellings, counts them so a spelling
that stopped matching cannot pass for a clean suite, and fails any that never
puts the switch back. It holds the variables and not the cache: eleven of the
thirty-four never call `vi.resetModules`, and most of those are right not to,
because they set their keys before anything imports the configuration and never
read it twice. Which of them needs the reset is a judgement about what each file
imports and when, and that is not a property of its text.

## 6. Tests that hold this guide set

| Test | Holds |
| --- | --- |
| `tests/standards-citations.test.ts` | Every citation a guide makes, in all three forms, plus every internal link and heading anchor — and, where a sentence names a CSS class beside a `styles.css` line, that the line is that class's own rule rather than merely non-blank. Seven had drifted onto other rules at once, which the line check passed. |
| `tests/testing-guide-counts.test.ts` | The file counts in both tables at the top of this page, recounted from disk, and the arithmetic the test counts beside them have to satisfy — including the total the prose quotes. Whether any of those is a figure a run printed is still nobody's check. |
| `tests/testing-guide-deployment.test.ts` | 1.3 from both ends: that no test runs `helm`, `kubectl`, `pulumi` or `docker`, and that the workflow still renders the chart with each gated feature on. The second is the only thing holding the half that does not live here. |
| `tests/testing-guide-environment.test.ts` | 5.4: every file that turns a feature on, found in all three spellings, puts it back. |
| `tests/http-route-table.test.ts` | The route tables in `http.md` against the routes `src/server/api.ts` registers, both directions, plus the path conventions each row follows and the deprecation window a renamed path promises. |
| `tests/comment-density.test.ts` | The density `AGENTS.md` and `comments.md` both quote: one number in both places, within a point and a half of what `src` measures, and the counts behind it exactly. |
| `tests/lint-budget.test.ts` | The lint warning budget, per rule and ratcheted down only. All three rules it once held are cleared and now denied outright, so every budget in it reads zero and the linter fails before this test is reached. What is left is the rule that starts warning and that nobody has decided about. |
| `tests/lint-config-documented.test.ts` | Every rule `.oxlintrc.json` silences or downgrades, and every plugin it enables, is explained in a guide. |
| `tests/mcp-measurements.test.ts` | Every number `mcp.md` quotes, against the live tool list. Four had drifted when it was written. |
| `tests/mcp-instructions.test.ts` | The server instructions carry each rule an agent otherwise learns by being refused. |
| `tests/table-overflow.test.ts` | Every table has a caption and every header cell a `scope`, alongside the scroll containment it started with. |
| `tests/transport-database-access.test.ts` | `services.md` 1.2, by the thing that goes wrong when it is broken: a query in `api.ts` or `mcp.ts`, on any receiver, that is not one of the seven lines carrying a written reason, and a reason still listed after the line it explains has gone. |
| `tests/migrations.test.ts` | The migration list in `AGENTS.md` matches the directory, both directions. |
| `tests/mcp-parity.test.ts` | Route parity between the two transports, both directions. |

Seven of those rows arrived after the table did, and two more tests were
considered for it and left out. `tests/log-level.test.ts` and
`tests/metrics.test.ts` hold what the product does — a level gate that drops
what sits below it, a label set that carries nobody's identity — and both
`operations.md` and `observability.md` name each as its check, as these guides
between them name 175 test files. A row here is the narrower case: the rule is
written down in the prose and nowhere else, so a repository that quietly stopped
following it would leave a true-sounding document and nothing that noticed.
Widen the table to every `*Checked by:*` line and it stops being a list and
becomes an index of the suite — 175 rows, which is most of a suite of 282 and is
not a table anybody reads.

That number was ninety-four a release ago and nothing holds it, so re-measure
rather than trusting it: it is the count of distinct test filenames named
anywhere under `docs/standards/`. It carries the argument above and the argument
gets stronger as it climbs, which is the unusual case where a stale number
weakens a rule by being too small.

### 6.1 Citations come in three shapes, and the test knows all of them now

The guides cite the code three ways:

| Shape | Example |
| --- | --- |
| Full path | `` `src/client/forms.tsx:353` `` |
| Bare filename | `` `forms.tsx:356` `` — resolved by basename |
| Continuation | `` `:654` `` — inherits the last file the prose named |

The full-path example used to name line 342, where that file opens a return
with a bare `<>`. 6.2 calls a citation that has landed on a fragment a cheap
proxy for one that has drifted, two paragraphs below — and the pattern it does
that with could not see this spelling, so the illustration of a good citation
was the defect the next section describes. The pattern reads `<>` and `</>` as
fragments now (`tests/standards-citations.test.ts:387`); a named tag stays a
line, because `<p>` is thin evidence and is still an element somebody meant.

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
| 2.1 A test name is a sentence about behavior | Editorial. |
| 2.2 Outcome, not mechanism | Judgement. A rule banning `toHaveBeenCalledWith` would fire on the tests where the call *is* the outcome, of which `tests/stripe-schedule-phases.test.ts:248` is one: the idempotency key sent to Stripe has no other observable, and sending the same one twice replays the first response and writes no phases. |
| 2.3 A test only your understanding could have written | Judgement, and the reason for reviewing tests as carefully as code. |
| 2.4 Order independence, outside budgets | The wider suite does not hold it and is not going to soon. |
| 2.5 An absence beside a presence | Judgement about state, not syntax. A rule could find a bare `toHaveCount(0)`; only a person can say whether the assertion beside it is about the same moment. |
| 2.6 Population, not list | Both halves are judgement. Whether an array is a population or an exception is one, and so is whether a sweep should assert a floor or an exact list — the three that assert exact lists would fail a grep written around the other shape. Each sweep is proved by mutation instead. |
| 2.7 The keys a test builds | Nothing reads the key builders under `tests/`, and the suite cannot: the collision is what makes the test green. |
| 5.2 One database per file | Convention. |
| 4 The vitest plugin is off | The four counts in that section move with the suite and this page says to re-measure rather than quote them; what decides the section is the proportion, and no test can hold a proportion it has to recompute by running a linter. |

Eleven `human` rules in this guide. **It reached twelve and then went down for
the first time**, which is the direction `index.md` says the count is supposed
to move: 5.3 left the table in 0.2.0. Its row read "Nothing reads the runner
configuration back, and the file that would fail is not the file that changed",
and the answer was the one the paragraph under this table had already named —
`tests/vitest-settings.test.ts` imports the configuration and reads
`unstubGlobals` back off the object, so a value inside a commented-out block or
under a replaced `test` key cannot pass. 5.4's premise, `fileParallelism`, is
held in the same file.

It said four when the count was first
written, and nine was the true figure: three of the difference is rules that
named no mechanism anywhere on the page, which is the state this count exists to
make uncomfortable, and the rest is one row that read 2.1–2.3 and counted once.
The tenth is 2.5, added after CI found the test that rule is about. The eleventh
is section 4, which had been counted as nothing at all: it is a `##`-level rule,
and the check that reads this page only ever looked at `###` headings.

**The twelfth is 2.6, and it is the one worth learning from**, because two
mechanisms agreed it was fine. The check that gives every labeled rule a
mechanism stops at the literal `*Checked by:*` string, and 2.6 has one that
reads "nothing mechanical"; the set's total is summed from these tables, and 2.6
had no row to sum. So a rule that said plainly it was unchecked was counted as
checked by one and as nothing by the other, and the number in
`docs/standards/code/index.md` was a rule short for a release. A footer that
names `human` in prose rather than in the table is invisible to both.

One of the eleven is worth an attempt: 2.7, a scan of `tests/` for the `padEnd`
shape it was. The other one this paragraph named was 5.3, "a test that reads one
line of `vitest.config.ts`, which is what `tests/theme-tokens.test.ts` already
does to a stylesheet" — which is exactly what was written, except that it reads
the imported object rather than the line, because a line can be commented out
and still be a line.
