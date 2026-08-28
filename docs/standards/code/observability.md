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

*Checked by:* `tests/metrics.test.ts:23-41`, which holds a list of label names
that would break it and fails on a metric declaring one. The list is read
against every metric's `labelNames`, including the default `component`, rather
than exempting the labels we add ourselves.

### 1.3 A route label is the pattern, never the path

**Binding.** `/api/v1/accounts/:id` is one series; `/api/v1/accounts/<uuid>` is
one per account. `routeLabel` (`src/server/api.ts:223-230`) reads Hono's matched
pattern, and resolves the two different things that both arrive as `/*`: a
request answered by middleware mounted above the routes — which is where a 413
from the body limit lands — is labelled by its prefix from a fixed list
(`:221`), and a path that matched nothing at all is one literal, because a
mistyped URL is exactly where unbounded labels come from.

*Checked by:* `tests/metrics.test.ts`, which asks for `/api/v1/accounts/<uuid>`
and insists the id appears nowhere in the output, and asks for two nonexistent
paths and insists both land under one name.

### 1.4 Collection is always on; only the endpoint is switched

**House.** Every counter increments whether or not `METRICS_ENABLED` is set.
What the setting decides is whether `GET /metrics` is registered at all
(`src/server/api.ts:234`) — registered rather than refusing, so a deployment
that never asked has no such route.

The measurement behind that: a labelled increment costs about 130ns and does
allocate, because `prom-client` hashes the label object into a string key on
every call; an unlabelled one costs about 12ns (2M iterations of `Counter.inc`,
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
  until each mutation started signalling replay out of its transaction callback
  (`src/server/services/transactions.ts:1047`, `:1058`, `:1084`), and the
  visible cost was a client retrying a four-thousand-row edit reporting eight
  thousand rows changed. The retry is a fact about the client, and it has its
  own counter.

The honest limit: where the **caller** supplies the transaction — which is every
MCP write — the increment happens before that caller commits. The comment at the
call site says so rather than claiming otherwise.

*Checked by:* `tests/integration/metrics.integration.test.ts`, which is the only
tier that can check it: a create, a delete and a restore counted as three
different operations, a refused write counted nowhere, and a replayed
idempotency key counted as a replay and not as a second write.

### 1.6 A metric proved only by its failure is not proved

**House.** A counter that has only ever been exercised on the error path looks
identical to one that was never wired up: both leave the success series absent.
So the tier with a database exercises the success path — `whoami` answering
`outcome="ok"` — while the unit tier, which has no database and can only
produce refusals, is where the label itself is checked.

### 1.7 Instrument the seam, not the call sites

**House.** Seventy-one tools are timed and counted by wrapping `registerTool`
once (`src/server/mcp.ts:543`), and every HTTP request by one middleware mounted
above everything, including the guards (`:188`). Both are chosen so a tool or a
route added tomorrow is instrumented by existing rather than by somebody
remembering.

The middleware sits above the body limit and the content-type check on purpose:
a request refused by a guard took time and happened, and leaving it out would
report a system that is fast and idle at exactly the moment it is being hammered
by something it is refusing.

## 2. Logging

### 2.1 One gate, and nothing names `console`

**Binding, with one named exception.** Every line goes through `log`
(`src/server/log.ts:53`), which reads `LOG_LEVEL` once and drops what sits below
it. `error` is the top of the order and is never silenced.

The rule is about the identifier, not the call. `console.info(` was banned and
nothing said `console.info(`; two modules took `logger = console` as a default
parameter and logged through it, so "SIGTERM received, shutting down" printed at
every level including the one an operator chose to silence it with. A default is
a call site one hop away, and the hop was enough to hide it for a release.

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
behaviour at each level, and that no file under `src/server` outside the
configuration layer names `console` in code at all. The exception list is itself
checked: a file on it that has stopped warning from inside `getConfig()` fails,
because an exception nobody needs any more proves nothing.

### 2.2 The level says who the line is for

**House.** Four levels, and the question each answers:

| Level | For | Examples |
| --- | --- | --- |
| `debug` | Somebody diagnosing this deployment right now. | A request served, an MCP tool call, a tick that found nothing due, a message handed to the relay. |
| `info` | An operator reading the log without being prompted. | Startup and the port, mail configured and the address it sends as, a tick that proposed or reminded, a signal received. |
| `warn` | A setting that is wrong and survivable. | A bounded integer out of range, both `NAME` and `NAME_FILE` set, `/metrics` open with no token in production. |
| `error` | Something failed. | A tick that threw, a relay that refused, a query that failed. |

The split that matters is `debug` against `info`, and the scheduler is the case
that defines it (`src/server/recurrence-scheduler.ts:154-161`): a tick that
proposed a row, sent a reminder or failed at either is `info`, and a tick that
found nothing due is `debug`. Most ticks find nothing, and an `info` line every
five minutes saying so is how a log stops being read.

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

### 2.4 A line carries counts and ids, never contents

**Binding.** No payee, no amount, no note, no subject line, no email address, no
bound query parameter. The operator reading the log is frequently not the person
whose ledger it describes, and a log is a copy of whatever it names that
outlives the request by however long the container's logs are kept.

The four sites that show what the rule costs, each with the thing it
deliberately leaves out:

- **A request** logs the method, the path and the status
  (`src/server/api.ts:206`) and never the query string, because a filter carries
  payees and search terms.
- **An MCP tool call** logs the tool name and the outcome
  (`src/server/mcp.ts:569`) and never the arguments, which are somebody's ledger
  by definition.
- **A message** logs `message.about` — "the password reset", "the reminder" —
  and never the recipient or the subject (`src/server/mail.ts:174`, `:180`), and
  the failure line logs a narrowed error rather than the whole one, because the
  whole one carries `envelope` and `rejected` holding the address.
- **A failed query** logs the statement and never its bound parameters, because
  one of those parameters is the OAuth access token the MCP token endpoint looks
  a grant up by, and the rest are somebody's payees and amounts. That narrowing
  is `log.failure` (`src/server/log.ts:71-97`) rather than a line at each
  transport, because for a release it *was* a line at one transport: the HTTP
  handler narrowed the error and the MCP tool path logged it whole, so an
  agent's failing call wrote what a browser's failing call did not.

**An id is allowed, and the difference from a metric label is the point.** A
label costs a time series per distinct value and must stay bounded; a line costs
one line. `/api/v1/accounts/<uuid>` in the log is what lets an operator follow a
request; the same id in a metric is ten thousand series. So the two rules point
opposite ways on ids and the same way on contents.

*Checked by:* `tests/log-level.test.ts`, which asserts the id is present in the
request line, the search term is absent from it, the payee an agent filtered by
is absent from the tool line, and — serialising the call rather than
stringifying it, because `String(error)` hides the difference — that a failing
statement is logged while the values bound into it are not. Whether a line
somebody adds tomorrow carries something it should not is review.

### 2.5 Warn once, not once per read

**House.** A condition read on a schedule warns on the first read and not again.
`configuredRecurrenceTickSeconds` runs on every scheduler tick, so a
misconfigured `RECURRENCE_TICK_SECONDS` would otherwise fill a log with one
mistake (`src/server/config-limits.ts:75`, and `warnOnce` at
`src/server/config-files.ts:64`).

### 2.6 A recovered failure is logged, never swallowed

**Binding.** Everything this product degrades rather than fails on says so: a
relay that refuses its credentials at startup, a reminder sweep that throws, a
tick that throws, an OAuth client sweep that fails. Each logs and carries on,
because the alternative — a `catch` with an empty body — produces a deployment
that is quietly doing half its job, which is the failure mode the degradation
was designed to avoid in the first place.

An empty `catch` is for a case where nothing went wrong, and it says which in a
comment. There are two in `src/server`, both cancelling a request body the peer
may have closed already (`src/server/http-security.ts:147` and `:615`), and both
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
  `collect()` that reads what already exists (`src/server/metrics.ts:207-221`),
  never a poller of its own.

The pool gauge shows what "reads what already exists" is protecting: it holds
the pool through a setter rather than importing `getPool()`, because that
function *creates* a pool if none exists, and a scrape must never be the thing
that opens a database connection. A process that has not touched the database
reports no pool series at all, which is the honest answer.

## 4. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.4 Collection is always on | A decision, not a property. The measurement behind it is a comment. |
| 1.6 The success path is exercised too | Nothing can tell a metric that was never wired up from one nothing has reached yet. |
| 1.7 Instrument the seam | Judgement about where a seam is. |
| 2.2 The level says who the line is for | Editorial, except for `announce`, whose call sites are pinned. |
| 2.3 Sentences, not JSON | Editorial. |
| 2.5 Warn once | Two sites, both with the counter they need; a third would be caught by review or not at all. |
| 3 Where a measurement belongs | A grep cannot tell a transport fact from a domain one. |

Seven `human` rules, which is the most of any guide here, and the reason is
worth stating rather than apologising for: the two channels are checkable in
their mechanics and not in their judgement. Whether a label is identifying, and
whether a counter moved when it should not have, are properties a test can hold
— and both are held. Whether a line was worth writing at all, and whether it was
written at the level somebody would want it, are what code review is for.
