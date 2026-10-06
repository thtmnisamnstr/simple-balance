# Observability

What this product says about itself while it runs: what is counted, what is
written to the log, and what neither may ever carry.

The deployment half — whether `/metrics` is on, what a container's logs are, how
a scraper authenticates — is [`docs/standards/operations.md`](../operations.md).
This is about the call site: where a counter goes, which level a line is written
at, and the sentence that decides what may appear in either.

Two channels, and they answer different questions. `/metrics` answers *how much
and how often*, across everybody, in a shape a machine reads. The log answers
*what happened to this one*, in a shape a person reads at three in the morning.
Neither substitutes for the other, and the reason is in the defaults: `/metrics`
is off unless a deployment asks for it, so the log has to carry the story a
deployment gets for free; a log has no aggregation, so the metric has to carry
the rate.

## 1. Metrics

### 1.1 One registry, one prefix, and the process says which one it is

**Binding.** Every metric is registered on the registry in
`src/server/metrics.ts:35`, named `simple_balance_*`, and carries a `component`
label of `api` or `scheduler` (`:44`). The two entrypoints run the same code and
publish the same names, so a split deployment scrapes both; without the label
the two series collide and the scheduler's proposals read as the API's.

A counter's name ends `_total` and nothing else's does. That is the Prometheus
convention rather than a preference, and the cost of breaking it is a dashboard
that computes a rate over a gauge.

*Checked by:* `tests/metrics.test.ts`, which walks the registry: the prefix on
everything of ours, the `_total` suffix on counters and on nothing else, and the
text format a scraper actually parses. `prom-client`'s own default set is
exempted by name, because three of its gauges end `_total` and that is its
convention to defend rather than this repository's to fix.

### 1.2 No label carries somebody's identity

**Binding, and it is an `AGENTS.md` invariant rather than a taste.** Not a user
id, not an email, not an account name, not an amount. A metric is read by
whoever can reach the scrape endpoint, which is not the person whose ledger it
counts, and every query in `src/server/services` is scoped by actor for exactly
that reason.

The same rule keeps cardinality bounded, which is the same defect wearing a cost
rather than a privacy label: a series per account id is a monitoring system that
falls over on a ledger somebody actually uses.

*Checked by:* `tests/observability-guide.test.ts`, which moves every metric on
the registry once and then reads the label names off the published values,
against a list of names that would break this. The list itself is
`tests/metrics.test.ts:23-41`. §1.8 is why the labels are read off the values
and not where `tests/metrics.test.ts:43-53` reads them, which is a field the
metrics library does not return.

### 1.3 A route label is the pattern, never the path

**Binding.** `/api/v1/accounts/:id` is one series; `/api/v1/accounts/<uuid>` is
one per account. `routeLabel` (`src/server/api.ts:331-338`) reads Hono's matched
pattern, and resolves the two different things that both arrive as `/*`: a
request answered by middleware mounted above the routes — which is where a 413
from the body limit lands — is labeled by its prefix from a fixed list
(`:329`), and a path that matched nothing at all is one literal, because a
mistyped URL is exactly where unbounded labels come from.

*Checked by:* `tests/metrics.test.ts`, which asks for `/api/v1/accounts/<uuid>`
and insists the id appears nowhere in the output, and asks for two nonexistent
paths and insists both land under one name.

### 1.4 Collection is always on; only the endpoint is switched

**House.** Every counter increments whether or not `METRICS_ENABLED` is set.
What the setting decides is whether `GET /metrics` is registered at all
(`src/server/api.ts:342`) — registered rather than refusing, so a deployment
that never asked has no such route.

The measurement behind that: a labeled increment costs about 130ns and does
allocate, because `prom-client` hashes the label object into a string key on
every call; an unlabeled one costs about 12ns (2M iterations of `Counter.inc`,
Node 26). Both are a rounding error beside the database round trip they sit
next to, and a branch in front of every write in the product would cost more
attention than the nanoseconds are worth.

### 1.5 Count the thing that happened, not the thing that was attempted

**Binding.** A counter goes **after** the work commits, outside the transaction,
and never on a path that did not do the work:

- Inside the transaction, a rolled-back write would be reported as a write.
  `tests/integration/metrics.integration.test.ts` refuses a create and insists
  the counter did not move.
- An idempotent replay is not a second write. Five counters double-counted one
  until each mutation started signaling replay out of its transaction callback
  (`src/server/services/transactions.ts:1148`, `:1159`, `:1185`), and the
  visible cost was a client retrying a four-thousand-row edit reporting eight
  thousand rows changed. The retry is a fact about the client, and it has its
  own counter.

**That limit is closed.** Where the **caller** supplies the transaction — which
is every MCP write — the increment used to happen before that caller committed:
the transport still had an idempotency record to write and the commit itself to
survive, so a count could stand for a write that then rolled back. The comment
at the call site said so rather than claiming otherwise, and rejected the fix on
the grounds that a queue of pending counts would be shared between concurrent
requests.

It would have been, written as a module-level queue. Keyed on the **transaction
object** in a `WeakMap` it is not: two requests hold two transaction objects, so
there is nothing to share, and the entry goes when the transaction is collected
whether anybody flushed it or not. `countAfterCommit` takes the count and either
makes it — when the service owns its transaction, which is every caller but MCP
— or defers it, and `flushDeferredCounts` runs after the outer transaction has
committed, at the one place that owns it.

*Checked by:* `tests/integration/metrics.integration.test.ts`, which is the only
tier that can check any of it: a create, a delete and a restore counted as three
different operations, a refused write counted nowhere, a replayed idempotency key
counted as a replay and not as a second write, and — the case the deferral is
for — **nothing counted for a write whose transaction rolls back after the
service returned**, which is the shape of the failure without needing one to
happen.

### 1.6 A metric proved only by its failure is not proved

**House.** A counter that has only ever been exercised on the error path looks
identical to one that was never wired up: both leave the success series absent.
So the tier with a database exercises the success path — `whoami` answering
`outcome="ok"` — while the unit tier, which has no database and can only
produce refusals, is where the label itself is checked.

### 1.7 Instrument the seam, not the call sites

**House.** Seventy-seven tools are timed and counted by wrapping `registerTool`
once (`src/server/mcp.ts:626`), and every HTTP request by one middleware
mounted above everything, including the guards (`src/server/api.ts:280`). Both
are chosen so a tool or a route added tomorrow is instrumented by existing
rather than by somebody remembering.

The middleware sits above the body limit and the content-type check on purpose:
a request refused by a guard took time and happened, and leaving it out would
report a system that is fast and idle at exactly the moment it is being hammered
by something it is refusing.

**One process is outside this, and it is a gap rather than a shrug.** The
scheduler entrypoint builds a Hono app of its own (`src/server/scheduler.ts:25`)
and mounts three routes on it: `/health/live` and `/health/ready` (`:30`,
`:31`), and `/metrics` where a deployment asked for it (`:68`). There is no
timing middleware on that app and no per-request line, so "a route added
tomorrow is instrumented by existing" is true of `api.ts` and false there. The
chart now ships the split deployment as a documented shape and
`tests/integration/scheduler-metrics.integration.test.ts` starts that process
for real, so this is a surface somebody will reach for rather than a
hypothetical.

Three probes are a thin thing to count, and the API's middleware cannot be
lifted across without mounting the API, which is the one thing a scheduler pod
must not be able to answer. What is cheap is keeping the gap the size it is, so
`tests/observability-guide.test.ts` pins that route list and fails on a fourth.

### 1.8 A metric's labels are read from its values, never from its declaration

**Binding, and it is the mechanism behind 1.2 rather than a taste of its own.**
`prom-client`'s `getMetricsAsJSON()` returns `help`, `name`, `type`, `values`
and `aggregator`, and no declared label names at all. A check written over
`metric.labelNames` therefore reads an absent field for every metric and is
indistinguishable from a check that passes on everything: register a counter
labeled `email`, `user_id` and `amount`, increment it, and all three appear in
the scrape while that reading reports nothing. `tests/metrics.test.ts:43-53` is
that reading, and it has been green since it was written.

The labels are on the values. So is the registry's default label, and only
there: `setDefaultLabels` (`src/server/metrics.ts:45`) does not widen any
metric's `labelNames`, so the declaration side cannot see `component` at all —
which is the second thing 1.2's old *Checked by:* claimed it read. Both halves
of that sentence were wrong, and one reading fixes both.

Reading the declaration is the obvious alternative and it is what was in place,
chosen because that is where an author writes the label down and because it
needs no metric to have been incremented. That second property is the real cost
of reading the values, and it is worth naming rather than hiding: a metric
nothing has moved contributes no values, so it publishes no labels to check.
The answer is to move every metric once in the test rather than to go back to
the declaration — a label nothing can reach is not a label a scrape can publish
— and the driving loop is nine lines. The same trap waits in any upgrade that
changes the shape of that JSON, which is why the check asserts the key set it
was handed rather than trusting the field it wants to be there.

*Checked by:* `tests/observability-guide.test.ts`, which reads the labels off
the published values for every metric; proves the reading by registering a
counter with three identifying labels and catching it; asserts that
`getMetricsAsJSON` returns exactly those five keys and no `labelNames`; and
asserts that `component` is on every metric's values and in no metric's
declaration.

### 1.9 A route with more exits than status codes counts through one function

**House, and mechanizable.** The Stripe webhook has one way out, and the
docstring above it says why (`src/server/api.ts:1162-1177`). Counted
2026-10-01: seven of its exits answer the same `200 {"received":true}` under
six outcome names, so `http_requests_total` — method, route, status — cannot
tell a delivery that granted an entitlement from one that was acknowledged and
ignored, and five of the seven write nothing to the log either. `answered`
(`:1178`) takes the branch's name, increments
`billing_webhook_deliveries_total` and writes the body, so counting each
delivery exactly once is structural: there is no other way to return a 2xx.

An increment beside each `return` is what the route started as, and it is wrong
for the reason 1.5 already gives one level down — a count somebody has to
remember is the count missing from the branch added next release. On this route
the missing branch is also invisible, because its status matches six others.
The cost of having no such counter at all is already written down:
`docs/deployment.md:252` sends anybody asking whether the subscription path
worked to `simple_balance_billing_sweeps_total`, which is the twelve-hourly
catch-up and reports a webhook that has been failing for hours as healthy right
up to the tick that repairs it.

It is also the only arrangement under which a closed label set can be asserted
at all, which is what keeps 1.2 true on the one route whose body an
unauthenticated caller supplies: a single exit is what makes the set
enumerable, and the outcome is the branch's own name rather than the event
type, which is Stripe's vocabulary and grows whenever Stripe ships an event.
One exit sits outside the funnel and says so — the signature refusal
(`src/server/api.ts:1193`), which is the only answer carrying a status of its
own.

The shape recurs for any route whose interesting outcomes are finer than its
status codes.

*Checked by:* `tests/stripe-webhook-route.test.ts:786-818`, which drives all
seven branches and asserts the whole outcome map rather than a subset, and
`tests/observability-guide.test.ts`, which holds the structure the map depends
on: two increments in the handler however many branches it grows to, one place
the 200 body is written, and every outcome a string literal.

## 2. Logging

### 2.1 One gate, and nothing names `console`

**Binding, with one named exception.** Every line goes through `log`
(`src/server/log.ts:57`), which reads `LOG_LEVEL` once and drops what sits below
it. `error` is the top of the order and is never silenced.

The rule is about the identifier, not the call. `console.info(` was banned and
nothing said `console.info(`; two modules took `logger = console` as a default
parameter and logged through it, so "SIGTERM received, shutting down" printed at
every level including the one an operator chose to silence it with. A default is
a call site one hop away, and the hop was enough to hide it for a release.

A library that logs for itself is the same hop one step further out, where the
check cannot look: Better Auth called `console` from `node_modules` at a level
it was merely told, until `src/server/auth.ts` handed it a `log` function. Its
lines go through `log.fromLibrary` now, which 2.4 describes. Its router had a
second hop of its own: an error that was not the library's own `APIError` fell
through to `console.error("# SERVER_ERROR: ", error)`, whole, bound parameters
and all. `authReporting`'s `onAPIError` throws that error on to Hono's handler,
which narrows it through `log.failure` like any other. What is left outside the
gate is a few notices about the library's own setup, written through a
module-level logger no option reaches, none of them carrying anything from a
request.

**The exception is the configuration layer**, and it is three files —
`config.ts`, `config-files.ts` and `config-limits.ts`, with `log.ts` itself on
the same list for the obvious reason that it is the file that calls `console`
on everybody's behalf. The three warn from inside `getConfig()`, and the gate
reads `getConfig()` to learn the level: routing them through it would be
re-entrant during the first read, which is a stack overflow rather than a quiet
line. A warning about configuration also should not be gated by a configuration
value that may be the thing that is wrong.

**The browser is not in scope, and that is deliberate rather than an
oversight.** `src/client` has no `log` and no `LOG_LEVEL` to read: its one
`console.error` sits in the error boundary (`src/client/error-boundary.tsx:32`),
where the browser's console is the only channel there is and the person reading
it is the person the error happened to. The rule and its check are about
`src/server`.

*Checked by:* `tests/log-level.test.ts`, which holds both halves — the gate's
behavior at each level, and that no file under `src/server` outside the
configuration layer names `console` in code at all. The exception list is
checked too, and more narrowly than this page used to claim:
`tests/log-level.test.ts:204-221` asserts only that each named file still
writes a `console` line somewhere in it, which
a file whose warning had left the first configuration read would also pass —
and that read is the whole of what the exception is for. The structural half is
`tests/observability-guide.test.ts`: none of the three imports `log`, so none
of them has anywhere else to write. Where inside each file is
`tests/config-console-scope.test.ts`, which reads the enclosing function off the
brace scope and holds it to a register: `getConfig` in `config.ts`, and nothing
else there; `warnOnce` in `config-files.ts`; `boundedEnvironmentInteger` and
`configuredIdempotencyRetentionHours` in `config-limits.ts`. Those last three
are not inside `getConfig`, and the argument is the same one step along — they
are read before anything has a level, and two of them on a schedule afterwards.
A register entry naming a function that has stopped writing a `console` line
fails too, so the excuse cannot outlive what it excuses.

### 2.2 The level says who the line is for

**House.** Four levels, and the question each answers:

| Level | For | Examples |
| --- | --- | --- |
| `debug` | Somebody diagnosing this deployment right now. | A request served, an MCP tool call, a tick that found nothing due, a message handed to the relay. |
| `info` | An operator reading the log without being prompted. | Startup and the port, mail configured and the address it sends as, a tick that proposed or reminded, a signal received. |
| `warn` | A setting that is wrong and survivable. | A bounded integer out of range, both `NAME` and `NAME_FILE` set, `/metrics` open with no token in production. |
| `error` | Something failed. | A tick that threw, a relay that refused, a query that failed. |

The split that matters is `debug` against `info`, and the scheduler is the case
that defines it (`src/server/recurrence-scheduler.ts:221-237`): a tick that
proposed a row, sent a reminder or failed at either is `info`, and a tick that
found nothing due is `debug`. Most ticks find nothing, and an `info` line every
five minutes saying so is how a log stops being read.

**A line's message is built whether or not its level is on**, because `log`
takes the finished string. For the two per-request lines that is one template
literal against a request that has just been through the database, which is not
worth an `enabled()` predicate and the two call sites that would then have to
remember to use it.

**The sentence that used to follow named its own expiry condition, and the
condition has been met.** It said the trade would be worth revisiting for a line
that had to serialize something in order to say itself, and that there was no
such line. There are now two kinds. `log.fromLibrary`
(`src/server/log.ts:145-156`) redacts a whole object graph before it gates —
`redacted` (`:214`) walks the graph to a bounded depth, copying objects,
rebuilding errors and rewriting every string through a regular expression — and
only then calls
`log[level]`, which is where the gate is. And seventeen sites in the billing
subsystem hand a caught error to `String()` inside the argument list, which
runs before the call does.

Measured on this machine, Node 26: a 63 KiB library line with a context object
beside it costs about 280µs at `LOG_LEVEL=error`, which drops it; the gated
line it is compared against costs about 0.03µs. Four orders of magnitude, on
the sign-in path, to produce output nobody will read. The answer is one
`enabled()` check inside `fromLibrary` rather than a predicate at seventeen call
sites, and it is a change to `log.ts` this pass did not make — §5. What the
guide owes until then is the number rather than the silence.

**`announce` is not a fifth level.** It prints at any setting and exists for the
handful of lines that are the product's only channel for something the operator
must have — today the first-run setup code, and nothing else. `LOG_LEVEL=warn`
on a fresh production instance printed nothing at all, which turned a supported
setting into a deployment nobody could claim. `tests/log-level.test.ts` holds
the call sites to two, so a third is a decision somebody makes in a diff.

### 2.3 Sentences, not JSON

**House.** Every line here is written for a person reading it while a container
refuses to start. The machine-readable half of observability is `/metrics`,
which is a better shape for it than a log somebody has to reread through `jq`. A
deployment that wants structured logs puts a collector in front, and that is the
collector's job.

**The billing subsystem does the opposite, and this records it rather than
losing it.** Measured 2026-10-01: 22 lines in `src/server/services/billing.ts`
and `src/server/stripe.ts` are written as a dotted event key and a field object
— `log.warn("billing.reconcile.failed", { error: String(error) })`
(`src/server/services/billing.ts:2052`) is the shape — and between them they
are the entire log output of the subsystem an operator is most likely to be
reading during an outage. Nothing in either file argues for an exception. So
this rule describes two thirds of the server while the newest third does the
reverse, which is the state a guide cannot be left in: §5 holds what has to
happen about it. `tests/observability-guide.test.ts` bounds it meanwhile — the
shape appears in those two files and nowhere else, and the count above is
measured against this page, so a third subsystem adopting it fails and so does
a fix to the two that have it, which is the signal to rewrite this paragraph
rather than the number.

### 2.4 A line carries counts and ids, never contents

**Binding.** No payee, no amount, no note, no subject line, no email address, no
bound query parameter. The operator reading the log is frequently not the person
whose ledger it describes, and a log is a copy of whatever it names that
outlives the request by however long the container's logs are kept.

The five sites that show what the rule costs, each with the thing it
deliberately leaves out:

- **A request** logs the method, the path and the status
  (`src/server/api.ts:305`) and never the query string, because a filter carries
  payees and search terms.
- **An MCP tool call** logs the tool name and the outcome
  (`src/server/mcp.ts:653`) and never the arguments, which are somebody's ledger
  by definition.
- **A message** logs `message.about` — "the password reset", "the reminder" —
  and never the recipient or the subject (`src/server/mail.ts:174`, `:179`), and
  the failure line logs a narrowed error rather than the whole one, because the
  whole one carries `envelope` and `rejected` holding the address.
- **A failed query** logs the statement and never its bound parameters, because
  one of those parameters is the OAuth access token the MCP token endpoint looks
  a grant up by, and the rest are somebody's payees and amounts. That narrowing
  is `log.failure` (`src/server/log.ts:75-101`) rather than a line at each
  transport, because for a release it *was* a line at one transport: the HTTP
  handler narrowed the error and the MCP tool path logged it whole, so an
  agent's failing call wrote what a browser's failing call did not.
- **A line the auth library writes** goes through `log.fromLibrary`
  (`src/server/log.ts:145`), tagged `[Better Auth]`, with every email address
  in the message and in whatever is passed beside it replaced by
  `[email address]`, and a failed query cut to its statement the way
  `log.failure` cuts one. Better Auth wrote to `console` on its own, outside the
  gate, and at `info` it wrote `Sign-up attempt for existing email: <address>`
  for every sign-up naming an account already here. Redacted by the address's
  shape rather than that one line dropped, because a match on a library's
  wording holds until the release that rewords it and then fails with nothing
  to say so, and the line itself is worth keeping: a run of them is what
  probing for accounts looks like, and the sign-up response hides it. The
  message may be an error rather than a string, whatever the library's type
  says: its OAuth sign-up catch hands over the error itself, and reading that
  as a string threw inside the catch and turned a refused Google sign-up into
  an empty 500. Nothing in it may throw, for the same reason. The pattern is
  anchored where a run of characters begins, because part of what it reads is
  the request — the social sign-in route logs the provider name it was sent —
  and unanchored it was quadratic: 63 KiB held the thread for 2.4 seconds. Each
  string is cut at 4 KiB, after redacting and never before.

**An id is allowed, and the difference from a metric label is the point.** A
label costs a time series per distinct value and must stay bounded; a line costs
one line. `/api/v1/accounts/<uuid>` in the log is what lets an operator follow a
request; the same id in a metric is ten thousand series. So the two rules point
opposite ways on ids and the same way on contents.

**And so a caught error object never reaches a log call whole.** The rule above
is only as strong as its weakest catch block: a Drizzle error's *message*
embeds the failing statement's bound parameters, so `log.error(context, error)`
is the contents rule being broken by the error type rather than by the caller.
Every catch that might hold a database error goes through
`log.failure(context, error)`, which keeps the statement and drops the values —
including the top-level catches in both entrypoints, which is where an audit
found eleven raw-error sites after the rule was first written. `log.failure` on
an error with no query falls back to logging it whole, so routing a doubtful
catch through it costs nothing when the doubt was wrong.

**That holds everywhere but the billing subsystem, where it is false at
seventeen sites.** Measured 2026-10-01: 17 log calls across the same two files
hand an identifier bound by a `catch` in the same file to `String()` — fifteen
in `src/server/services/billing.ts` and two in `src/server/stripe.ts` — and
several of them wrap plain database writes, such as the locked write at
`src/server/services/billing.ts:2041` and the deferral at `:2075`.
`String(error)` on a Drizzle error yields its message, which is the statement
plus every value bound into it: exactly what the narrowing exists to strip, got
at one remove.

The mechanism below misses all seventeen, and on both counts, which is worth
saying plainly because the rule above reads as enforced.
`tests/mail-logging.test.ts:104` scans `log.error(` alone, and within it looks
only for a **bare identifier** among the top-level arguments. Every one of the
seventeen is a `log.warn` whose caught error is wrapped in `String()` inside an
object literal: the wrong method, and the wrong shape. §5 holds what has to
happen about it.

*Checked by:* `tests/log-level.test.ts`, which asserts the id is present in the
request line, the search term is absent from it, the payee an agent filtered by
is absent from the tool line, and — serializing the call rather than
stringifying it, because `String(error)` hides the difference — that a failing
statement is logged while the values bound into it are not.
`tests/auth-log.test.ts` drives the logger Better Auth builds from
`src/server/auth.ts` with the sentence its sign-up route writes, spying on
`console.log` as well as the gate's four methods because that is where the
library's own fallback wrote, and
`tests/integration/multi-tenant-registration.integration.test.ts` makes the
real sign-up and reads the line back without the address. And
`tests/mail-logging.test.ts` for the rule this paragraph used to write out and
leave to a person: no `log.error` call anywhere in `src/server` receives, as a
bare argument, an identifier bound by a `catch` in the same file. `log.failure`
is the only call allowed one, because it is where the narrowing lives and it
falls back to logging the error whole when there is nothing to narrow — so it is
never the worse choice. The one site the check found was `mail.ts`, which passed
the caught `sender.verify()` error straight through. For the shape it cannot
see, `tests/observability-guide.test.ts` holds the seventeen to those two files
and holds the count to this page. Whether a line somebody adds tomorrow carries
something it should not is still review.

### 2.5 Warn once, not once per read

**House.** A condition read on a schedule warns on the first read and not again.
`configuredRecurrenceTickSeconds` runs on every scheduler tick, so a
misconfigured `RECURRENCE_TICK_SECONDS` would otherwise fill a log with one
mistake (`src/server/config-limits.ts:75`, and `warnOnce` at
`src/server/config-files.ts:59`).

### 2.6 A recovered failure is logged, never swallowed

**Binding.** Everything this product degrades rather than fails on says so: a
relay that refuses its credentials at startup, a reminder sweep that throws, a
tick that throws, an OAuth client sweep that fails, the two Stripe checks both
entrypoints make at boot — the prices (`src/server/stripe.ts:1528`) and what
the key may read (`:1608-1623`) — and the reconciliation sweep carrying on
past a subscription Stripe cannot answer about
(`src/server/services/billing.ts:2052`). Each logs and continues,
because the alternative — a `catch` with an empty body — produces a deployment
that is quietly doing half its job, which is the failure mode the degradation
was designed to avoid in the first place.

An empty `catch` is for a case where nothing went wrong, and it says which in a
comment. There are two in `src/server`, both canceling a request body the peer
may have closed already (`src/server/http-security.ts:471` and `:1007`), and both
carry that sentence.

*Checked by:* `tests/log-level.test.ts`, which finds every `catch` whose body is
empty or comment-only and fails on one that says nothing. It cannot tell a good
reason from a bad one — that is review — but it can tell a decision from an
oversight, which is the difference that matters when a failure disappears.

## 3. Where a measurement belongs

**House.** With the thing it measures, at the level that knows the fact:

- A transport fact — a request, a status, a tool call — is counted in the
  transport.
- A domain fact — a ledger write, a staged row committed, a CSV row queued — is
  counted in the service, because both transports call the same service and a
  count in one of them is a count of half the product.
- A process fact — pool depth, heap, event loop lag — is a gauge with a
  `collect()` that reads what already exists (`src/server/metrics.ts:300-314`),
  never a poller of its own.

The pool gauge shows what "reads what already exists" is protecting: it holds
the pool through a setter (`src/server/metrics.ts:294-298`) rather than
importing `getPool()`, because that function *creates* a pool if none exists,
and a scrape must never be the thing that opens a database connection. A
process that has not touched the database reports no pool series at all, which
is the honest answer.

**It covers one pool of two, and the `total` it reports means one of them.**
`src/server/db/client.ts` opens the application pool at `:21` and hands it over
at `:39`; it opens a second, single-connection pool at `:82` for the two things
a transaction pooler cannot carry — the migration lock and the first-account
claim. Nothing hands that one over, so a process holding the bootstrap lock
reports one connection fewer than it holds. This is older than this release and
the under-report is one connection, which is why it is a sentence here rather
than a fix made during a guides pass. What would be wrong is leaving the gauge
reading as though it covered the process.

## 4. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.4 Collection is always on | A decision, not a property. The measurement behind it is a comment. |
| 1.6 The success path is exercised too | Nothing can tell a metric that was never wired up from one nothing has reached yet. |
| 1.7 Instrument the seam | Judgment about where a seam is. The scheduler's three uncounted routes are pinned, so the exception cannot grow quietly. |
| 2.2 The level says who the line is for | Editorial, except for `announce`, whose call sites are pinned. |
| 2.3 Sentences, not JSON | Editorial. The disagreement in §5 is bounded by a test; the rule itself is not. |
| 2.5 Warn once | Two sites, both with the counter they need; a third would be caught by review or not at all. |
| 3 Where a measurement belongs | A grep cannot tell a transport fact from a domain one. |

Seven `human` rules — only `testing.md` carries more — and the reason is
worth stating rather than apologizing for: the two channels are checkable in
their mechanics and not in their judgment. Whether a label is identifying, and
whether a counter moved when it should not have, are properties a test can hold
— and both are held. Whether a line was worth writing at all, and whether it was
written at the level somebody would want it, are what code review is for.

## 5. Where this guide and the repository disagree

Recorded rather than resolved, because each needs a decision rather than an
edit. A rule that silently describes a shrinking majority is how a guide stops
being believed, and the four below were all found by reading the code against
the page rather than by anything failing.

- **Sentences, not JSON (§2.3), and a caught error never logged whole (§2.4).**
  Both are true of the rest of `src/server` and false of the billing subsystem,
  which is the newest third of it: 21 dotted-key lines and 17 stringified
  catches across `src/server/services/billing.ts` and `src/server/stripe.ts`,
  measured 2026-10-01. The resolution these want is a change to the code — a
  sentence per line, and `log.failure` for the catches — after which both
  sections say what was found and fixed. The state that is not available is the
  one this pass found: two rules describing most of the server while the newest
  part of it does the reverse, with nothing on the page saying so.
  `tests/observability-guide.test.ts` holds the two shapes to those two files
  and holds both counts to this page, so the disagreement can grow no further
  without somebody deciding to, and cannot be fixed without this section being
  rewritten.

- **A metric's labels, read from the declaration (§1.8).**
  `tests/metrics.test.ts:43-53` still reads `labelNames` off
  `getMetricsAsJSON()`, which never returns it. It is green, and it would stay
  green on a counter labeled with an email address — the one failure mode an
  `AGENTS.md` invariant is standing behind. The working reading is in
  `tests/observability-guide.test.ts`; rewriting or deleting the vacuous one is
  the next edit to that file, which this pass did not own.

- **The redaction that runs before the gate (§2.2), and the second pool (§3).**
  `log.fromLibrary` redacts a whole object graph and then calls the gated
  method, which costs about 280µs for a dropped 63 KiB line against 0.03µs for
  a gated plain one; the fix is one `enabled()` check inside `fromLibrary` in
  `src/server/log.ts`. And `simple_balance_db_pool_connections` covers the
  application pool and not the single-connection bootstrap pool, so a process
  holding the first-account claim reports one connection fewer than it holds.
  Both are small, both are in files this pass did not change, and both are here
  so the next person meets them as decisions rather than as surprises.

- **Two stale counts in the code §1.9 argues from.** The webhook's own
  docstring (`src/server/api.ts:1162-1177`) says five exits answer
  `200 {"received":true}` and four of them write nothing to the log, and
  `src/server/metrics.ts:220` repeats the five. Counted 2026-10-01 they are
  seven and five: the `setup_intent.succeeded` branch arrived after both
  sentences were written. §1.9 gives the measured numbers rather than quoting
  the stale ones, which is the smaller of the two drifts a guide can have — but
  the comments are what somebody reads first, and correcting them is an edit to
  files this pass did not own.
