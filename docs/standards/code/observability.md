# Observability

What this product says about itself while it runs: what is counted, what is
written to the log, and what neither may ever carry.

The deployment half — whether `/metrics` is on, what scrapes it and where the
figures go, what a container's logs are, how a scraper authenticates — is
[`docs/standards/operations.md`](../operations.md).
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
against an allow-list of bounded vocabularies, each with the reason its values
cannot be somebody's data (`tests/observability-guide.test.ts:59-78`). Where
`metrics.ts` exports a label's vocabulary, the entry is built from the export
rather than copied — §1.10 from the test's side — and an entry for a label no
metric publishes fails too, "excuse no label that nothing publishes", so the
list cannot keep an excuse after the label has gone. It was a deny-list of
fourteen names that would break this, so a spelling nobody had thought of
passed. §1.8 is why the labels are read off the values and not off `labelNames`,
which is a field the metrics library does not return.

### 1.3 A route label is the pattern, never the path

**Binding.** `/api/v1/accounts/:id` is one series; `/api/v1/accounts/<uuid>` is
one per account. `routeLabel` (`src/server/api.ts:383-389`) reads Hono's matched
pattern, and resolves the three different things that all arrive as `/*`: a
request answered by middleware mounted above the routes — which is where a 413
from the body limit lands — is labeled by its prefix from a fixed list
(`:381`); the browser app's shell, and the files at the bundle's root beside
it, are `spa_shell`; and a request nothing answered is one literal,
`unmatched`, because a mistyped URL is exactly where unbounded labels come
from.

`spa_shell` came last, and the reason is what `unmatched` is for. On a
deployment serving its own pages every page load came back from the catch-all as
`/*`, so `unmatched` was mostly the browser app working and a rise in it meant
nothing. The shell is recognized off the static handlers' own answer — a request
under `/*` that came back without a refusal was answered by the browser app
(`src/server/api.ts:2244`) — and after the prefixes, so a stale link to a hashed
asset is still the `/assets/*` request it was. A page that does not exist is
`spa_shell` too: the shell answers it, and only the browser app knows its pages.
On such a deployment `unmatched` is now a method no route takes, or a refusal
before any route ran. The split deployment never reaches any of it, because
nginx serves the pages there.

Better Auth's routes are the same rule on a second counter. They are one
catch-all to Hono, so `http_requests_total` calls every one of them
`/api/auth/*`. `auth_requests_total` matches the path segment by segment
against `AUTH_ROUTES` (`authRouteLabel`, `src/server/api.ts:406-416`), a
parameter standing for exactly one segment, so a reset link's token is
`:token` and a path nothing lists is the catch-all's own pattern — never the
path as it was sent.

*Checked by:* `tests/metrics.test.ts`, which asks for `/api/v1/accounts/<uuid>`
and insists the id appears nowhere in the output, and asks for two nonexistent
paths and insists both land under one name; `tests/metrics-http-pages.test.ts`,
against a built bundle under production settings, for the shell, the files
beside it, `unmatched` and a hashed asset that is not there; and
`tests/metrics-http.test.ts`, "is counted under the endpoint it named, with a
token in the path left out" and "puts a path no listed endpoint matches under
the catch-all, never as it was sent".

### 1.4 Collection is always on; only the endpoint is switched

**House.** Every counter increments whether or not `METRICS_ENABLED` is set.
What the setting decides is whether `GET /metrics` is registered at all
(`src/server/api.ts:451`) — registered rather than refusing, so a deployment
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
  (`src/server/services/transactions.ts:1158`, `:1169`, `:1195`), and the
  visible cost was a client retrying a four-thousand-row edit reporting eight
  thousand rows changed. The retry is a fact about the client, and it has its
  own counter.
- A transaction is counted once it has settled. `db_transactions_total` moves
  when drizzle's promise does, after the `commit` or the `rollback` came back
  (`src/server/db/client.ts:184-197`), and a `commit` PostgreSQL refused is a
  rollback, because PostgreSQL ended the transaction either way. A transaction
  that never began — no connection, or `begin` refused — is neither.
- A sign-in is counted from the status that went out, in the HTTP middleware
  (`src/server/api.ts:438-447`), and never in a Better Auth database hook. A
  hook sees a sign-up that may still roll back, which is counting the attempt,
  and it runs on the one connection the sign-up transaction holds.

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
happen. The transaction's own count is held by
`tests/integration/metrics-db-transactions.integration.test.ts`, "counts a
transaction as committed once its commit has returned, and not before", and
beside it the case a reader would not think of, "counts a commit PostgreSQL
refused as a rollback", which defers a unique constraint so the refusal
arrives at `commit` itself. The sign-in half is `tests/metrics-http.test.ts`,
"counts a sign-in a guard refused, as the timing middleware does".

### 1.6 A metric proved only by its failure is not proved

**House.** A counter that has only ever been exercised on the error path looks
identical to one that was never wired up: both leave the success series absent.
So the tier with a database exercises the success path — `whoami` answering
`outcome="ok"` — while the unit tier, which has no database and can only
produce refusals, is where the label itself is checked.

### 1.7 Instrument the seam, not the call sites

**House.** Seventy-seven tools are timed and counted by wrapping `registerTool`
once (`src/server/mcp.ts:640`), and every HTTP request by one middleware
mounted above everything, including the guards (`src/server/api.ts:305`). Both
are chosen so a tool or a route added tomorrow is instrumented by existing
rather than by somebody remembering.

The middleware sits above the body limit and the content-type check on purpose:
a request refused by a guard took time and happened, and leaving it out would
report a system that is fast and idle at exactly the moment it is being hammered
by something it is refusing. The in-flight gauge and the aborted count ride it.
The gauge goes up where the timer starts and down first thing in `record()`
(`src/server/api.ts:307`, `:320`), the one function that runs exactly once per
request and, for a stream, after the last frame, so nothing later in it
throwing can leave a request in flight for good. An aborted request is read off
the request's own signal in the same place (`:328`), before the adapter writes
a byte of an ordinary answer, so what it counts is a caller who left while the
handler was still working.

**The database has two doors, and each is wrapped once.** Every transaction goes
through `getDb()`, which wraps `transaction` on the drizzle instance
(`measureTransactions`, `src/server/db/client.ts:177-200`, applied at `:56`),
and every wait for a connection goes through `connect` on the application pool,
wrapped on the instance in both the promise form a transaction uses and the
callback form `pool.query` uses (`measureAcquire`, `:235-259`, applied at
`:44`). `withTransaction` was timed, and it was one way in among thirteen:
twelve sites opened `getDb().transaction` directly — every MCP write, the
scheduler's proposals, the billing writes that hold the subscription lock — so
the histogram timed an unknown fraction of the time connections were held.
Routing the twelve through the helper was the obvious fix, and it holds until
the next site is written without it. The door covers Better Auth's adapter too,
which is handed the same instance, and a savepoint stays part of the transaction
it nests in.

It changed what `db_transaction_duration_seconds` measures, which the upgrade
notes say rather than leave to be noticed. The clock starts once drizzle holds
a connection and `begin` has returned, and stops when the `commit` or
`rollback` has. `withTransaction` started its clock before asking for a
connection, so a full pool read as slow transactions — the opposite diagnosis —
and the wait is now `db_pool_acquire_duration_seconds` alone.

**The same shape at the other edges.** `mcp_requests_total` is counted where an
HTTP request becomes JSON-RPC (`countRpcMessages`, `src/server/mcp.ts:2285`),
the one place a call the protocol refused and a call a tool answered both pass;
the tool wrapper sees only the second. A Stripe call is counted, timed and
classified in `measured` (`src/server/stripe.ts:85`). A failure nobody meant is
counted at the one place each surface turns it into an `INTERNAL_ERROR`, and
never for a refusal the caller can act on: `errorEnvelope` for a 500 and for a
streamed `error` frame, told apart by the surface its caller names
(`src/server/api.ts:483`, counted at `:538`), `runTool` for a tool
(`src/server/mcp.ts:292`), and the catch Better Auth's background tasks land in
(`src/server/auth.ts:150`). How a stream ended is counted in the stream
helper's `finally`, before it settles the request timer
(`src/server/stream.ts:169`).

Three more sit where the thing they count is decided, so nothing has to be
told about them. A 429 is counted by the limiter that sent it: the setup
code's where it refuses (`src/server/api.ts:667`), and Better Auth's in the
auth middleware, recognized by the `X-Retry-After` header only its limiter
sets (`:446`), so neither limiter has to know the other exists. The shared
limiter falling back to a tally in this process is counted in the catch of
`take`, beside the line it already wrote, and never in `clear`'s
(`src/server/http-security.ts:707`). A message is timed around the relay's
answer, accepted or refused, and not at all when there is no relay, which
`mail_messages_total{outcome="skipped"}` counts instead
(`src/server/mail.ts:154`, `:192`): a refusal is the half worth timing, since
a relay that never answers takes the transport's whole bound to fail. A
violation report is counted per violation, because one delivery can carry
several (`src/server/api.ts:1435`), and only moves on a deployment rehearsing
its policy, since only there is the route registered.

**One process is outside the HTTP half of this, and the gap is smaller than it
was.** The scheduler entrypoint builds a Hono app of its own
(`src/server/scheduler.ts:25`) and mounts three routes on it: `/health/live`
and `/health/ready` (`:30`, `:35`), and `/metrics` where a deployment asked for
it (`:65`). There is no timing middleware on that app and no per-request line,
so "a route added tomorrow is instrumented by existing" is true of `api.ts` and
false there. The chart ships the split deployment as a documented shape and
`tests/integration/scheduler-metrics.integration.test.ts` starts that process
for real, so this is a surface somebody will reach for rather than a
hypothetical.

What the gap used to cost is gone: a scheduler failing readiness was a 503 the
platform acted on and no metric saw, and its `/health/ready` is now the API's
own function, which counts the answer whichever process gives it (§1.13). The
rest is as it was. Three probes are a thin thing to count, and the API's
middleware cannot be lifted across without mounting the API, which is the one
thing a scheduler pod must not be able to answer. What is cheap is keeping the
gap the size it is, so `tests/observability-guide.test.ts` pins that route
list, fails on a fourth, and fails on that file naming the request metrics or a
timer — which is why the readiness check lives in `src/server/readiness.ts`
and not beside the routes.

*Checked by:* the instances, never the judgment, which is §4's row. The
database's two doors by
`tests/integration/metrics-db-transactions.integration.test.ts` — "times the
transaction an MCP write opens for itself", "times every wait for a
connection, a single statement's as well as a transaction's" and "keeps the
wait for a connection out of the transaction's time", which holds the whole
pool and reads a 0.3-second wait in the acquire histogram and not in the
transaction's — and by `tests/metrics-db-pool.test.ts` against a refused port.
The MCP edge by `tests/metrics-mcp-requests.test.ts`, "a call the protocol
refused before any tool ran"; the rest of the HTTP edge, streams, internal
errors, both limiters and in-flight requests included, by
`tests/metrics-http.test.ts`, which holds the aborted count over a real socket
because it rests on the adapter's behavior rather than Hono's. The relay's
timing by `tests/metrics-mail-duration.test.ts`, and the violation reports by
`tests/metrics-http-pages.test.ts`.

### 1.8 A metric's labels are read from its values, never from its declaration

**Binding, and it is the mechanism behind 1.2 rather than a taste of its own.**
`prom-client`'s `getMetricsAsJSON()` returns `help`, `name`, `type`, `values`
and `aggregator`, and no declared label names at all. A check written over
`metric.labelNames` therefore reads an absent field for every metric and is
indistinguishable from a check that passes on everything: register a counter
labeled `email`, `user_id` and `amount`, increment it, and all three appear in
the scrape while that reading reports nothing. `tests/metrics.test.ts` held
that reading, green from the day it was written until 0.2.1 removed it.

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
the published values for every metric and holds each to an allow-list of
bounded vocabularies, every entry with the reason its values cannot be
somebody's data — it was a deny-list of fourteen exact names, so `account_name`
or `memo` would have passed it; proves the reading by registering a counter with
three identifying labels and catching it; asserts that
`getMetricsAsJSON` returns exactly those five keys and no `labelNames`; and
asserts that `component` is on every metric's values and in no metric's
declaration.

### 1.9 A route with more exits than status codes counts through one function

**House, and mechanizable.** The Stripe webhook has one way out, and the
docstring above it says why (`src/server/api.ts:1276-1291`). Counted
2026-10-01: seven of its exits answer the same `200 {"received":true}` under
six outcome names, so `http_requests_total` — method, route, status — cannot
tell a delivery that granted an entitlement from one that was acknowledged and
ignored, and five of the seven write nothing to the log either. `answered`
(`:1292`) takes the branch's name, increments
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
(`src/server/api.ts:1307`), which is the only answer carrying a status of its
own.

The shape recurs for any route whose interesting outcomes are finer than its
status codes.

*Checked by:* `tests/stripe-webhook-route.test.ts:790-822`, which drives all
seven branches and asserts the whole outcome map rather than a subset, and
`tests/observability-guide.test.ts`, which holds the structure the map depends
on: two increments in the handler however many branches it grows to, one place
the 200 body is written, and every outcome a string literal.

### 1.10 A caller's string is mapped onto a vocabulary exported beside the metric

**Binding, and it is how 1.2 survives a value somebody else writes.** Four
labels here take their value from something a caller or a vendor controls: the
path under `/api/auth`, a JSON-RPC method, the directive a violation report
names, and a Stripe error. Each vocabulary is an `as const` tuple exported from
`src/server/metrics.ts` beside the metric it labels, its type derived from it —
`CSP_DIRECTIVES` (`:148`), `AUTH_ROUTES` (`:271`), `MCP_RPC_METHODS`
(`:427`), `STRIPE_FAILURE_REASONS` (`:767`) — and the value is made by a
function that maps onto it with a bucket for everything else: the catch-all's
own `/api/auth/*`, or `other`. What leaves is a member however hostile what
arrived. The internal vocabularies take the same shape, so every closed label
here reads the same way: `INTERNAL_ERROR_SURFACES`, `SCHEDULER_SWEEPS`,
`CHECKED_DEPENDENCIES` and the rest.

The label is never the caller's string, and each case shows why: a violation
report is posted by anybody who can reach the path, a JSON-RPC method is
whatever a client writes, and a reset link carries its token in the path, so
copying it would publish a credential to whoever can scrape. Matching a Stripe
error goes by its class and its code and never its message, which can quote a
customer or an amount. And where a log line and a metric both classify the
same thing, one is derived from the other: `isKeyRefusal`, which decides the
line naming a key's missing permission, is two names out of `failureReason`
(`src/server/stripe.ts:137`, `:154`), so the line and the count cannot
disagree about which failures were the key's.

Exported rather than written at the call site, because three readers need the
list and a copy in each is three lists. The allow-list in §1.2 builds its
reason from the export, so the reason and the list a caller maps onto cannot
come apart; the mapping derives its own lookup from it, so a method added to
the tuple is recognized by existing (`NAMED_RPC_METHODS`,
`src/server/mcp.ts:2224`); and a test can hold its cases to the whole tuple.
The obvious alternative — copy the caller's value and strip the characters a
label cannot carry — bounds the characters and not the count, which is the
property 1.2 is about.

*Checked by:* `tests/observability-guide.test.ts`, whose allow-list entries for
these labels are built from the exported tuples; `tests/closed-sets.test.ts`,
which refuses a hand-written union whose members equal a tuple that already
exists; and the mappings, driven with what a hostile caller would send —
`tests/metrics-http-pages.test.ts`, "never makes a label of what the caller
wrote", `tests/metrics-mcp-requests.test.ts`, "is mapped onto the closed set and
never appears in a label", which sends a method carrying a UUID, and
`tests/metrics-stripe-failures.test.ts`, which builds every error with the real
SDK and holds its case table to the whole of `STRIPE_FAILURE_REASONS`.

### 1.11 A shipped metric's labels are a contract, and so are the scraper's

**House.** Three decisions in this release were one decision, and the next
metric will face it too.

**A new dimension on a metric that has shipped is a new metric.**
`stripe_request_failures_total` sits beside `stripe_requests_total` rather than
giving it a `reason`; `db_transactions_total` sits beside the transaction
histogram rather than giving it an `outcome`; `mail_messages_total` gained no
`kind`. A label added to a shipped series splits it: a query reading it by the
labels it had gets several series where it had one, and an alert comparing one
series to a threshold compares several. `AGENTS.md` says what a release owes
the one before it — "every client that worked against it still works" — and a
dashboard is a client. The same rule is why nothing here is renamed and no
label value is removed. A new label *value* is how a shipped metric grows, and
even that moves somebody's query, so it is named in the upgrade notes:
`spa_shell` took most of what `unmatched` used to count.

**A label is never a name the scrape writes.** Prometheus writes `job` and
`instance` on every series, a Prometheus Operator `ServiceMonitor` adds
`endpoint`, `namespace`, `pod`, `service` and `container`, and the chart's own
collector adds `pod`. A metric label of the same name is renamed
`exported_<name>` by the scrape, on exactly the deployments that took that
advice. So the scheduler's jobs are `sweep` and not `job`
(`src/server/metrics.ts:639-640`), and the auth endpoints are `route` and not
`endpoint` (`:317-321`), where `route` is also what `http_requests_total`
already calls the same paths.

**The help says what the metric leaves out.** It is what a dashboard's author
reads, and often the only thing. `mcp_tool_calls_total` says it excludes calls
the protocol refused, `mail_send_duration_seconds` that a message skipped for
want of a relay is not timed, `log_messages_total` that the configuration
layer's warnings bypass the gate, and `dependency_up` which of its series are
checked once and which follow every check. A help that claims more than the
metric counts is the same defect as a wrong label, met later:
`log_messages_total` described every warning until a review narrowed it to
the lines written through the gate.

*Checked by:* nothing general, which is §4's row: nothing records which
metrics shipped with which labels.

### 1.12 A histogram ends at the bound of what it times

**House, and mechanized.** The last finite bucket is the longest the thing can
take before something gives up, so `+Inf` means exactly that something gave
up. Every boundary is a series per label combination besides, so the set is
otherwise as short as the question allows.

- A pool wait ends at ten seconds, the pool's own `connectionTimeoutMillis`
  (`src/server/db/client.ts:30`; buckets at `src/server/metrics.ts:536`).
- A Stripe request ends at sixty. One attempt is ten seconds and
  `maxNetworkRetries: 2` makes three, with the SDK's backoff between them, so a
  request that timed out every time reads about 31.5 seconds; the old top of
  ten put exactly those in `+Inf` (`:751`).
- A tick ends at three hundred, `RECURRENCE_TICK_SECONDS`' default, so `+Inf`
  is a tick that overran the interval it is scheduled on and delayed the next
  (`:591`).
- A mail send ends at sixty, past the forty the transport's three bounds add
  up to (`:708`).
- The request set gained 0.01 and 0.05 at the bottom (`:57`), because "inside
  fifty milliseconds" fell between 0.025 and 0.1 and could not be read off it
  at all. Two boundaries and not a dozen: each is a series per route and
  method.

The obvious alternative is a client library's default set, and it is wrong
both ways: it stops at ten seconds, which is where the Stripe give-ups and the
slow ticks begin, and its boundaries are chosen for nobody's operation in
particular.

*Checked by:* `tests/metrics.test.ts`, "a histogram's buckets", which reads
each bound out of the source that sets it — the pool's timeout from
`client.ts`, the timeout and the retry count from `stripe.ts`, the default
interval, the three transport timeouts from `mail.ts` — so a bound that moves
under a bucket that does not fails. Every case failed against the set it
replaced.

### 1.13 One readiness function, and its answer is recorded

**House.** Both entrypoints answer `/health/ready` with one function
(`answerReadiness`, `src/server/readiness.ts:63-66`), and the check under it
counts every answer and sets a gauge from it (`checkReadiness`, `:37-51`):
`readiness_checks_total{outcome}` and `ready`. The scheduler used to answer
from a copy of the API's lines on an app with no timing middleware, so a
scheduler failing readiness was a 503 the platform acted on and no metric ever
saw. One function is what makes two processes report one check in the same
words, and the counter is labeled in the words the body already answered with,
`ready` and `not_ready`, so the probe's log and the scrape cannot describe it
differently.

Recorded from the check that ran, and never run for a scrape: the platform's
probes keep it fresh, and a scrape that asked the database would be a scrape
opening a connection, which §3 refuses. Each process runs one check as the
last thing it does on starting (`src/server/index.ts:123`,
`src/server/scheduler.ts:134`), because a gauge with no labels publishes 0
from the moment it is registered, and a process that has only just started
listening is not one that failed. Last, so a database slow to answer delays
nothing above it — shutdown handling included. Read beside the counter, the
gauge tells the two zeros apart either way.

What the check asks is `operations.md` §Health checks' rule, unchanged: one
statement against the database. It lives in `src/server/readiness.ts` rather
than in `scheduler.ts`, which §1.7 pins to three routes and no instrumentation,
and the API has no business importing the scheduler's entrypoint to reach it.

*Checked by:* `tests/metrics-http.test.ts`, "a readiness check" — ready, not
ready with the gauge following it down, and never asked by a scrape;
`tests/metrics-http-entrypoints.test.ts`, "as its port opens", in both
entrypoints, including that shutdown is armed while the check is still
waiting on a database that never answers; `tests/scheduler-startup.test.ts`,
"records each readiness answer it gives, and the last one as a gauge"; and
against a real database `tests/integration/metrics-http.integration.test.ts`
and `tests/integration/scheduler-metrics.integration.test.ts`.

### 1.14 A liveness timestamp per sweep, and a sweep that is off is not stuck

**House, and the shape for anything that runs on a timer.** A count of ticks
cannot tell a scheduler that stopped an hour ago from one that is quiet without
a window chosen to match the interval. A timestamp can: now minus it is how
long since the last success, whatever the interval. So each of the four sweeps
a tick runs stamps `scheduler_last_success_timestamp_seconds{sweep}` when it
runs to the end (`ranToTheEnd`, `src/server/recurrence-scheduler.ts:121-123`),
and the process publishes `scheduler_enabled` and
`scheduler_tick_interval_seconds` beside it (`:147-152`), so a staleness alert
is a multiple of the interval rather than a number right only for the default.

Four things the stamp gets right, each because the wrong version was the
obvious one:

- **Inside the sweep's own `try`, after it resolved, and never in a
  `finally`.** A sweep that threw on every tick would otherwise read fresh
  forever, which is the stopped scheduler the series exists to show.
- **Per sweep, not per tick.** The three after the proposals each have their
  own `try`, so a reminder sweep failing for a week sits beside proposals that
  succeed every five minutes, and one stamp at the end of the tick would call
  that tick healthy. A proposal step that throws ends the tick before the
  others run, and then none of the four is stamped.
- **A sweep that returned because it is switched off is stamped.** Billing
  where nothing is sold, retention left at forever: it ran to the end. Left
  unstamped it reads as a sweep that stopped on the day the process started,
  and every deployment that sells nothing would page for it. How often each
  finds itself off is `outcome="off"` on `idempotency_sweeps_total` and
  `billing_sweeps_total`. A billing sweep with failed rows — Stripe down — also
  ran to the end, and its failures are `billing_sweeps_total{outcome="failed"}`
  and `stripe_request_failures_total`.
- **Unix seconds.** `time()` answers in seconds, and a stamp in milliseconds
  makes `time()` minus it a large negative number no threshold ever crosses.

`scheduler_enabled` is what makes it work on every profile. A single machine
runs the scheduler inside the API process, so its series arrive under
`component="api"`; a split deployment runs it in a process of its own. An
alert pinned to one component is silent on the other profile, and the sum of
`scheduler_enabled` across a deployment is not: zero is a deployment where
nothing is proposing anything. A process that runs no scheduler publishes no
stamps and an interval of 0, so the staleness alert has nothing to match
there.

*Checked by:* `tests/recurrence-scheduler.test.ts`, "what the scheduler
publishes about itself", on a frozen clock: the enabled and disabled values,
exact seconds, an off sweep stamped and read through the alert expression
itself, each of the four throwing, and an earlier stamp surviving a later
failure. `tests/integration/scheduler-metrics.integration.test.ts` reads
`scheduler_enabled` and the interval off the real process.

### 1.15 A check's gauge says when it was checked

**House.** `dependency_up{dependency}` publishes what the relay and Stripe
checks found, 1 passed and 0 failed, and it is the one gauge here whose
freshness differs by series. So each series is one kind or the other, the help
says which, and none pretends to be the other.

- **Checked once, as the process starts: `smtp` and `stripe_access`.** Written
  from the answers the startup checks already gave (`recordDependencyChecks`,
  `src/server/readiness.ts:97-114`), and never by asking again. A relay fixed
  since boot still reads 0, and `mail_messages_total` is where to read whether
  mail is going out now.
- **Checked again whenever the prices are read: `stripe_prices`.** The plan
  tab, the point of sale and the billing sweep each read them, the point of
  sale refuses on the newest verdict, and every verdict is written over the
  last (`recordPriceCheck`, `src/server/stripe.ts:1474-1481`); a gauge that
  kept the boot's would read 1 beside a deployment refusing every sale. The
  boot writes it as well, and the two writers agree: a read that never reached
  Stripe writes nothing and keeps the verdict it had, as the point of sale
  does, and at boot there is no verdict yet to keep.
- **A startup check that could not run is 0**, because it passed nothing. That
  needed the check to say so: `checkStripeAccess` returns the resources the
  key was refused, and `null` where it refused none but could not ask about
  them all (`src/server/stripe.ts:1686`), so an unreachable Stripe no longer
  reads as a key that may read everything. A standard `sk_` key holds every
  permission and is never asked, so it reads 1.
- **A dependency the deployment does not use is absent, not 0.** `AGENTS.md`:
  "Mail is optional and everything that needs it degrades rather than breaks."
  No relay configured is a supported deployment and not a broken one, and
  billing off is the same.

None of it reaches readiness, and that is the reason for the gauge: taking a
process out of rotation because a relay refused would lock everybody out of
the books over the one thing in them that is optional. Nor is it probed on a
scrape, for §3's reason.

*Checked by:* `tests/metrics-http-entrypoints.test.ts`, "what the startup
checks found", in both entrypoints — nothing configured, a relay that refused
and one that answered, prices that do not fit beside a key that cannot read,
Stripe unreachable reading 0 on both, and everything passing; and
`tests/stripe-prices.test.ts`, "keeps dependency_up on the newest verdict, as
the point of sale does", which walks it 1, 0, 0 while unreachable, then 1, with
"says it could not look when Stripe does not answer, and never throws" for the
`null` beside it.

### 1.16 The application speaks Prometheus, and the collector translates

**House, and the owner's decision.** The application publishes `/metrics` in
the Prometheus text format through `prom-client`, and that is its whole
instrumentation API. It does not take the OpenTelemetry SDK, does not push
OTLP itself, and grows no second metrics API beside the registry in
`src/server/metrics.ts`. Where a deployment wants OpenTelemetry on the wire,
the collector in `operations.md` §A deployment's collector scrapes `/metrics`
and speaks OTLP to the backend, or remote write where that is what the backend
takes, and the application never knows it is there.

The temptation is specific, which is why it is written down. The collector is
OpenTelemetry's, its pipeline sends OTLP, and instrumenting the application
with the SDK and dropping the scrape reads like the tidy end state. The owner
has declined it as too heavy for what it buys: a meter provider and an
exporter inside every API and scheduler process, beside a registry whose
increments cost 12 to 130 ns (§1.4) and an endpoint that costs nothing until
something scrapes it. The translation runs once per deployment instead of once
per process, is off unless asked for, and can be switched off without touching
the application. Nor was the collector chosen for being OpenTelemetry's: it
was chosen over Prometheus in agent mode because it measured lighter at the
same series, and `operations.md` keeps the numbers.

The move `operations.md` §Metrics keeps open is a different one:
`prom-client` to `@prometheus-io/client`, the same project renamed, which keeps
everything this section says.

*Checked by:* nothing, which is §4's row. A dependency added to
`package.json` is review's to notice.

## 2. Logging

### 2.1 One gate, and nothing names `console`

**Binding, with one named exception.** Every line goes through `log`
(`src/server/log.ts:58`), which reads `LOG_LEVEL` once and drops what sits below
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

**And the gate counts what it is handed before it decides.** Every `warn` and
`error` that reaches `log` is counted as `log_messages_total{level}` ahead of
the level check (`src/server/log.ts:117-124`), because a deployment that set
`LOG_LEVEL=error` to quiet its warnings has not stopped having them, and most of
what degrades rather than fails says so only in the log — a sweep that threw,
an idle connection dropped, the limiter falling back, a Stripe key refused.
`failure` and `fromLibrary` reach those two methods, so a line counts once
however it arrived. `debug` would be a second request counter and `info` is the
ordinary story of a process doing its job, so neither is counted, and nor is
`announce`. What goes around the gate goes around the count too: the
configuration layer's warnings, and Better Auth's notices about its own setup.
The metric's help says so (§1.11).

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
fails too, so the excuse cannot outlive what it excuses. The count is
`tests/log-level.test.ts` again, "counts a warning the level drops, beside an
error it prints" and "counts a line once, however it reached the gate".

### 2.2 The level says who the line is for

**House.** Four levels, and the question each answers:

| Level | For | Examples |
| --- | --- | --- |
| `debug` | Somebody diagnosing this deployment right now. | A request served, an MCP tool call, a tick that found nothing due, a message handed to the relay. |
| `info` | An operator reading the log without being prompted. | Startup and the port, mail configured and the address it sends as, a tick that proposed or reminded, a signal received. |
| `warn` | A setting that is wrong and survivable. | A bounded integer out of range, both `NAME` and `NAME_FILE` set, `/metrics` open with no token in production. |
| `error` | Something failed. | A tick that threw, a relay that refused, a query that failed. |

The split that matters is `debug` against `info`, and the scheduler is the case
that defines it (`src/server/recurrence-scheduler.ts:267-283`): a tick that
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
(`src/server/log.ts:156-167`) redacts a whole object graph before it gates —
`redacted` (`:225`) walks the graph to a bounded depth, copying objects,
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
(`src/server/services/billing.ts:2194`) is the shape — and between them they
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
  (`src/server/api.ts:342`) and never the query string, because a filter carries
  payees and search terms.
- **An MCP tool call** logs the tool name and the outcome
  (`src/server/mcp.ts:666`) and never the arguments, which are somebody's ledger
  by definition.
- **A message** logs `message.about` — "the password reset", "the reminder" —
  and never the recipient or the subject (`src/server/mail.ts:177`, `:182`), and
  the failure line logs a narrowed error rather than the whole one, because the
  whole one carries `envelope` and `rejected` holding the address.
- **A failed query** logs the statement and never its bound parameters, because
  one of those parameters is the OAuth access token the MCP token endpoint looks
  a grant up by, and the rest are somebody's payees and amounts. That narrowing
  is `log.failure` (`src/server/log.ts:76-102`) rather than a line at each
  transport, because for a release it *was* a line at one transport: the HTTP
  handler narrowed the error and the MCP tool path logged it whole, so an
  agent's failing call wrote what a browser's failing call did not.
- **A line the auth library writes** goes through `log.fromLibrary`
  (`src/server/log.ts:156`), tagged `[Better Auth]`, with every email address
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

**Including the last line a process writes.** Both entrypoints register an
`uncaughtExceptionMonitor` that writes through `log.failure`
(`src/server/index.ts:132`, `src/server/scheduler.ts:141`), so the line a crash
leaves is narrowed, gated and counted like every other failure. A monitor
rather than an `uncaughtException` handler, because a handler decides whether
the process survives, and one in a state nobody expected should exit; its
restarts are read off `process_start_time_seconds`, which needs no metric of
its own. What that leaves is Node's own report of the error, printed whole
after the monitor returns, and §5 records it.

**That holds everywhere but the billing subsystem, where it is false at
seventeen sites.** Measured 2026-10-01: 17 log calls across the same two files
hand an identifier bound by a `catch` in the same file to `String()` — fifteen
in `src/server/services/billing.ts` and two in `src/server/stripe.ts` — and
several of them wrap plain database writes, such as the locked write at
`src/server/services/billing.ts:2183` and the deferral at `:2217`.
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
and holds the count to this page. The crash line is
`tests/metrics-http-entrypoints.test.ts`, in both entrypoints: "writes its last
line through the gate, narrowed like every other failure", and "is a monitor
and nothing more, so the process still exits". Whether a line somebody adds
tomorrow carries something it should not is still review.

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
entrypoints make at boot — the prices (`src/server/stripe.ts:1583`) and what
the key may read (`:1668-1683`) — and the reconciliation sweep carrying on
past a subscription Stripe cannot answer about
(`src/server/services/billing.ts:2194`). Each logs and continues,
because the alternative — a `catch` with an empty body — produces a deployment
that is quietly doing half its job, which is the failure mode the degradation
was designed to avoid in the first place.

An empty `catch` is for a case where nothing went wrong, and it says which in a
comment. There are two in `src/server`, both canceling a request body the peer
may have closed already (`src/server/http-security.ts:472` and `:1022`), and both
carry that sentence.

*Checked by:* `tests/log-level.test.ts`, which finds every `catch` whose body is
empty or comment-only and fails on one that says nothing. It cannot tell a good
reason from a bad one — that is review — but it can tell a decision from an
oversight, which is the difference that matters when a failure disappears.

## 3. Where a measurement belongs

**House.** With the thing it measures, at the level that knows the fact:

- A transport fact — a request, a status, a tool call, a JSON-RPC message — is
  counted in the transport.
- A domain fact — a ledger write, a staged row committed, a CSV row queued — is
  counted in the service, because both transports call the same service and a
  count in one of them is a count of half the product.
- A process fact — pool depth, heap, event loop lag — is a gauge with a
  `collect()` that reads what already exists (`src/server/metrics.ts:927-947`),
  never a poller of its own.
- A fact about a check — whether the process is ready, whether the relay
  answered — is recorded where the check runs, from the answer it gave, and
  never asked again for a scrape (§1.13, §1.15).

The pool gauge shows what "reads what already exists" is protecting: it holds
the pool through a setter (`src/server/metrics.ts:921-925`) rather than
importing `getPool()`, because that function *creates* a pool if none exists,
and a scrape must never be the thing that opens a database connection. A
process that has not touched the database reports no pool series at all, which
is the honest answer. Its `max` state is read off the pool's own options rather
than off `DATABASE_POOL_SIZE` for the same reason one step along: those are
what the pool was built with, and a scrape that parsed the environment would be
reporting a size the pool may not have.

**It covers one pool of two, and the `total` it reports means one of them.**
`src/server/db/client.ts` opens the application pool at `:27` and hands it over
at `:49`; it opens a second, single-connection pool at `:92` for the two things
a transaction pooler cannot carry — the migration lock and the first-account
claim. Nothing hands that one over, so a process holding the bootstrap lock
reports one connection fewer than it holds. This is older than this release and
the under-report is one connection, which is why it is a sentence here rather
than a fix made during a guides pass. What would be wrong is leaving the gauge
reading as though it covered the process.

The acquire histogram and the pool-error counter leave the same pool out, and
that one is a decision rather than an inheritance
(`src/server/db/client.ts:230-233`). It serves the first-account claim and
nothing else, and a second claim in the same process is refused before it asks,
so it never queues: what it would add to a histogram about queueing is a
connection being opened, read as a wait.

## 4. What is not enforced

| Rule | Why it is only a sentence |
| --- | --- |
| 1.4 Collection is always on | A decision, not a property. The measurement behind it is a comment. |
| 1.6 The success path is exercised too | Nothing can tell a metric that was never wired up from one nothing has reached yet. |
| 1.7 Instrument the seam | Judgment about where a seam is. The instances are held, and so is the scheduler's route list, so the one exception cannot grow quietly. |
| 1.11 A shipped metric's labels are a contract | Nothing records which metrics shipped with which labels. A new label *name* needs an allow-list entry under 1.2, so a `job` or an `endpoint` would be a decision written in a diff; a known name added to a shipped metric is caught by nothing. |
| 1.16 The application speaks Prometheus | A dependency is a line in `package.json`, and whether it is the SDK this declines is review's to notice. |
| 2.2 The level says who the line is for | Editorial, except for `announce`, whose call sites are pinned. |
| 2.3 Sentences, not JSON | Editorial. The disagreement in §5 is bounded by a test; the rule itself is not. |
| 2.5 Warn once | Two sites, both with the counter they need; a third would be caught by review or not at all. |
| 3 Where a measurement belongs | A grep cannot tell a transport fact from a domain one. |

Nine `human` rules — only `testing.md` carries more — and the reason is
worth stating rather than apologizing for: the two channels are checkable in
their mechanics and not in their judgment. Whether a label is identifying, and
whether a counter moved when it should not have, are properties a test can hold
— and both are held. Whether a line was worth writing at all, and whether it was
written at the level somebody would want it, are what code review is for. The
two that arrived with the metrics work are of the same kind: a contract with
dashboards nobody here can see, and a dependency declined on cost.

## 5. Where this guide and the repository disagree

Recorded rather than resolved, because each needs a decision rather than an
edit. A rule that silently describes a shrinking majority is how a guide stops
being believed, and the six below were all found by reading the code against
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

- **A metric's labels, read from the declaration (§1.8). Closed in 0.2.1.**
  `tests/metrics.test.ts` read `labelNames` off `getMetricsAsJSON()`, which
  never returns it, so it was green over a counter labeled with an email
  address. It is deleted, and the working reading in
  `tests/observability-guide.test.ts` holds labels to an allow-list.

- **The redaction that runs before the gate (§2.2), and the second pool (§3).**
  `log.fromLibrary` redacts a whole object graph and then calls the gated
  method, which costs about 280µs for a dropped 63 KiB line against 0.03µs for
  a gated plain one; the fix is one `enabled()` check inside `fromLibrary` in
  `src/server/log.ts`. And `simple_balance_db_pool_connections` covers the
  application pool and not the single-connection bootstrap pool, so a process
  holding the first-account claim reports one connection fewer than it holds.
  Both are small. Both files changed in the metrics work — the gate gained its
  count, and the pool its acquire timing — and neither fix was made, because
  neither was what that work was about; the acquire timing left the bootstrap
  pool out on purpose, which §3 argues, and the gauge's under-report is the
  older half. Both are here so the next person meets them as decisions rather
  than as surprises.

- **A stale count in the code §1.9 argues from, one of two.** The `answered`
  function's docstring (`src/server/api.ts:1280`) says five exits answer
  `200 {"received":true}` and four of them write nothing to the log. Counted
  2026-10-01 they are seven and five: the `setup_intent.succeeded` branch
  arrived after the sentence was written. The second copy, in the webhook
  counter's docstring in `src/server/metrics.ts`, was corrected in the metrics
  work to "every exit of the route but the signature refusal", which stays true
  as branches are added and is the shape the other one wants. §1.9 gives the
  measured numbers rather than quoting the stale one, which is the smaller of
  the two drifts a guide can have — but the comment is what somebody reads
  first.

- **An uncaught exception is printed whole (§2.4).** The monitor writes a
  narrowed line, and then Node prints the error itself to stderr, outside the
  gate and whole — and a Drizzle error whole is its statement and every value
  bound into it. That was true before the monitor existed. Stopping it means an
  `uncaughtException` handler, which changes whether a process in a state
  nobody expected survives, and that is a decision about crashing rather than
  about logging; the metrics work declined to make it in passing.

- **A failure nobody meant, missed on one surface (§1.7).** An MCP tool whose
  result does not satisfy its output schema fails the call — `AGENTS.md` says
  so — but the SDK raises that after `runTool` has returned, so it reaches
  `mcp_tool_calls_total` as `ok` and `mcp_requests_total` as `tool_error`, and
  never `internal_errors_total{surface="mcp"}`. Catching it means wrapping the
  SDK's own validation, which nothing here does yet.
