import type { Pool } from "pg";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { APP_VERSION } from "../shared/version.js";

/**
 * What this process can be asked about itself, in Prometheus' text format.
 *
 * Three rules hold this file together, and each is here because the obvious
 * alternative is a bug that shows up in somebody's monitoring bill rather than
 * in a test.
 *
 * **No label ever carries somebody's identity.** Not a user id, not an email,
 * not an account name. A metric is read by whoever can scrape it, which is not
 * the person whose ledger it describes, and `AGENTS.md` scopes every finance
 * read by the authenticated actor for exactly that reason. The labels here are
 * closed sets — a route pattern, a tool name, an outcome — and
 * `tests/observability-guide.test.ts` fails on a label that is not.
 *
 * **A route label is the pattern, never the path.** `/api/v1/accounts/:id` is
 * one series; `/api/v1/accounts/<uuid>` is one series per account, which is how
 * a monitoring system falls over on a ledger with ten thousand transactions.
 *
 * **Collection is always on; only the endpoint is switched.** A labeled
 * increment costs about 130ns and does allocate — `prom-client` hashes the
 * label object into a string key on every call — and an unlabeled one about
 * 12ns (2M iterations of `Counter.inc` on this machine, Node 26). That is a
 * rounding error beside the database round trip it sits next to, so gating it
 * on `METRICS_ENABLED` would buy back nothing worth a branch in front of every
 * write in the product. What the setting decides is whether `GET /metrics`
 * answers at all, which is the part with a security consequence. The earlier
 * version of this paragraph claimed no allocation, which was pleasant and
 * wrong; the number is here so the next person can re-measure rather than
 * believe it.
 */
export const registry = new Registry();

/**
 * Which process this is, as a label on everything it reports.
 *
 * The API and the scheduler run the same code and expose the same names, and a
 * deployment that has split them scrapes both. Without this, the two series
 * collide and a proposal counter reads as though the API were proposing.
 */
export function setMetricsComponent(component: "api" | "scheduler") {
  registry.setDefaultLabels({ component });
}

// Chosen for a self-hosted app on one box, not for a service behind a load
// balancer, and the tail matters because a CSV import and a balance query live
// in the same histogram family. The bottom is not as sparse as it was: from
// 0.025 the set jumped straight to 0.1, so "most requests answer inside fifty
// milliseconds" fell between two boundaries and could not be read off the
// histogram at all. 0.01 and 0.05 are what make an ordinary request measurable
// rather than merely "under a tenth of a second". Every boundary is a series
// per route and method, which is why the set grew by two and not by the dozen a
// latency-obsessed service would add.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const prefix = "simple_balance_";

export const httpRequests = new Counter({
  name: `${prefix}http_requests_total`,
  help: "HTTP requests served, by matched route and status.",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: `${prefix}http_request_duration_seconds`,
  help: "How long a request took, by matched route.",
  labelNames: ["method", "route"] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

/**
 * Requests this process has begun and not yet finished answering.
 *
 * The one reading the two above cannot give. Both are written when a request
 * ends, so a request that does not end — a handler queued behind a lock, a
 * client draining a stream a byte at a time — is absent from them for exactly
 * as long as it is the problem. It goes up where the timing middleware starts
 * its timer and down where that middleware records, and for a streamed request
 * that is when the last frame is out rather than when the head is, because the
 * connection is held until then.
 */
export const httpRequestsInFlight = new Gauge({
  name: `${prefix}http_requests_in_flight`,
  help: "Requests this process has started and not finished answering. A streamed one counts until its last frame.",
  registers: [registry],
});

/** How a streamed request can end; see `httpStreamOutcomes`. */
export const STREAM_OUTCOMES = ["result", "refused", "error"] as const;
export type StreamOutcome = (typeof STREAM_OUTCOMES)[number];

/**
 * How each streamed request ended, by route.
 *
 * A stream spends its status line on the first frame, so a ten-thousand-row
 * commit that failed on its last row is a 200 in `http_requests_total` and an
 * `error` frame on the wire, and until this the log was the only place the
 * difference existed. `refused` is a failure the caller can act on — a
 * validation error, a stale version — and `error` is one they cannot, so the
 * second is the one to alert on and the first is somebody correcting a form.
 * `route` is the matched pattern, exactly as the request counter spells it.
 */
export const httpStreamOutcomes = new Counter({
  name: `${prefix}http_stream_outcomes_total`,
  help: "Streamed requests by how the stream ended. http_requests_total records each as the 200 its first frame carried.",
  labelNames: ["route", "outcome"] as const,
  registers: [registry],
});

/**
 * Requests whose caller had gone before the answer was finished, by route.
 *
 * `http_requests_total` records the status the handler produced, and a handler
 * that took ninety seconds produced a 200 whether or not anybody was still
 * there to read it. A proxy that gave up at sixty, or a person who closed the
 * tab, made that 200 an answer nobody received, and the only trace was a slow
 * bucket. Read from the request's own abort signal, which `@hono/node-server`
 * fires when the connection closes before the response has finished —
 * `tests/metrics-http.test.ts` holds that over a real socket, because a
 * counter resting on an adapter's behavior is only as true as the adapter.
 * `route` is the matched pattern, as the request counter spells it, and each
 * of these is also counted there under whatever status it got.
 */
export const httpRequestsAborted = new Counter({
  name: `${prefix}http_requests_aborted_total`,
  help: "Requests whose client disconnected before the answer was finished, by matched route. Each is in http_requests_total too, under the status the handler produced.",
  labelNames: ["route"] as const,
  registers: [registry],
});

/**
 * The directives a violation report is counted under, and `other` for the rest.
 *
 * The report is posted by anybody who can reach the path, so the directive it
 * names is the caller's string and never becomes a label as it arrived: it is
 * matched against this list and counted under the match. The list is every
 * directive CSP Level 3 can report a violation of, rather than the ones this
 * policy happens to set today, because a browser reports the effective
 * directive — `script-src-elem` under a policy that only says `script-src` —
 * and because a policy that grows a directive should not need this list to
 * grow with it before its reports are counted by name.
 */
export const CSP_DIRECTIVES = [
  "default-src",
  "child-src",
  "connect-src",
  "font-src",
  "frame-src",
  "img-src",
  "manifest-src",
  "media-src",
  "object-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "worker-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "require-trusted-types-for",
  "trusted-types",
  "other",
] as const;
export type CspDirective = (typeof CSP_DIRECTIVES)[number];

/**
 * Violation reports received while the policy is rehearsing, by directive.
 *
 * `SB_CSP_REPORT_ONLY` exists so an operator can find out what the policy would
 * block before it blocks it, and the answer was a log line per report: fine for
 * reading one, and no way to see whether they stopped after a change to the
 * policy. Counted per violation rather than per request, since one `report-to`
 * delivery carries several. Only ever moves on a deployment rehearsing, because
 * only there is the route registered.
 */
export const cspViolations = new Counter({
  name: `${prefix}csp_violations_total`,
  help: "Content security policy violations reported while the policy is in report-only mode, by directive. Anything not a known directive is other.",
  labelNames: ["directive"] as const,
  registers: [registry],
});

/**
 * Where an unexpected failure is turned into an answer, one name for each.
 *
 * `http` is the error handler's 500. `stream` is an `error` frame carrying that
 * same envelope after the status line has already gone. `mcp` is a tool call
 * answered `INTERNAL_ERROR`. `auth_background` is a task Better Auth handed off
 * after answering — sending a reset or confirmation link — which has no
 * response left to fail and was, until this, a log line and nothing else.
 */
export const INTERNAL_ERROR_SURFACES = ["http", "stream", "mcp", "auth_background"] as const;
export type InternalErrorSurface = (typeof INTERNAL_ERROR_SURFACES)[number];

/**
 * Failures nobody meant, from every transport, in one series.
 *
 * Each transport knew, and only one said so anywhere a machine could read: a
 * 500 is in `http_requests_total`, but a streamed commit that failed is a 200
 * there, and so is an MCP tool that failed, because every MCP reply is JSON
 * over a 200. A refusal the caller can act on — a validation error, a stale
 * version, a record that is not there — is deliberately not counted, which is
 * what makes a rise here mean a bug or a dependency rather than somebody
 * mistyping.
 */
export const internalErrors = new Counter({
  name: `${prefix}internal_errors_total`,
  help: "Failures nobody meant, answered as an internal error, by surface. Refusals the caller can act on are not counted.",
  labelNames: ["surface"] as const,
  registers: [registry],
});

/** What a readiness check can answer, in the words `/health/ready` answers with. */
export const READINESS_OUTCOMES = ["ready", "not_ready"] as const;
export type ReadinessOutcome = (typeof READINESS_OUTCOMES)[number];

/**
 * Readiness checks answered, by outcome.
 *
 * Counted by the check rather than by the request. The scheduler answers
 * `/health/ready` from a little app of its own with no timing middleware on
 * it, so a scheduler failing readiness produced no metric at all. The
 * platform's probes keep this moving — the image's and the Compose recipes'
 * health checks, the chart's startup and readiness probes, every few seconds —
 * so a scrape never has to ask the database anything to report it.
 */
export const readinessChecks = new Counter({
  name: `${prefix}readiness_checks_total`,
  help: "Readiness checks this process answered, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * Whether this process's last readiness check passed: 1 or 0.
 *
 * The result of a check that ran, never a check run for the scrape, for the
 * reason the pool gauge below gives: a scrape must never be the thing that
 * opens a database connection. It reads 0 until a check has run, because a
 * gauge without labels publishes 0 from the moment it is registered, and a
 * process that has only just started listening is not one that failed. Checking
 * once as the process starts listening closes that window; reading it beside
 * `readiness_checks_total` tells the two zeros apart either way.
 */
export const processReady = new Gauge({
  name: `${prefix}ready`,
  help: "1 if this process's last readiness check reached the database, 0 if it did not or none has run yet.",
  registers: [registry],
});

/**
 * The paths under `/api/auth` that get a series of their own.
 *
 * Every endpoint this product's pages and agents reach, spelled the way
 * `http_requests_total` spells a route this repository mounts itself, so
 * `/api/auth/sign-up/email` reads the same in both. A parameter is written as
 * one: the reset link carries its token in the path and the OAuth callback its
 * provider, and a token in a label is a credential published to whoever can
 * scrape. Anything not listed is counted under the catch-all's own pattern,
 * `/api/auth/*`, which is what `http_requests_total` already calls every route
 * Better Auth answers.
 */
export const AUTH_ROUTES = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-in/social",
  "/api/auth/callback/:id",
  "/api/auth/sign-up/email",
  "/api/auth/sign-out",
  "/api/auth/get-session",
  "/api/auth/list-sessions",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/reset-password/:token",
  "/api/auth/change-password",
  "/api/auth/verify-email",
  "/api/auth/send-verification-email",
  "/api/auth/link-social",
  "/api/auth/methods",
  "/api/auth/mcp/authorize",
  "/api/auth/mcp/token",
  "/api/auth/mcp/register",
  "/api/auth/mcp/jwks",
  "/api/auth/mcp/get-session",
  "/api/auth/oauth2/consent-request",
  "/api/auth/oauth2/consent",
  "/api/auth/.well-known/oauth-protected-resource",
  "/api/auth/*",
] as const;
export type AuthRoute = (typeof AUTH_ROUTES)[number];

/**
 * How an auth request ended, read off its status.
 *
 * `redirected` is a class of its own rather than part of `ok`, because the
 * OAuth callback redirects whether the sign-in worked or not — into the app on
 * success, to `/auth-error` on failure — and counting every redirect as a
 * success would claim something the status cannot see. A 429 is `rate_limited`
 * rather than `refused`: a run of refusals on sign-in is wrong passwords, and a
 * run of 429s is the limiter already doing something about them.
 */
export const AUTH_OUTCOMES = ["ok", "redirected", "refused", "rate_limited", "error"] as const;
export type AuthOutcome = (typeof AUTH_OUTCOMES)[number];

/**
 * Requests to the auth routes, by route and outcome.
 *
 * Better Auth answers behind one catch-all, so in `http_requests_total` a wave
 * of failed sign-ins, a session read on every page load and the limiter's 429s
 * were one series. Labeled `route` rather than the more obvious `endpoint`,
 * because `endpoint` is the label a Prometheus Operator `ServiceMonitor` writes
 * on every target it scrapes, and the Helm chart's README suggests one: the
 * scrape would rename this one `exported_endpoint` on exactly the deployments
 * that took that advice. `route` is also what these paths already are in
 * `http_requests_total`. Counted at the HTTP layer, where the status is final;
 * a database hook sees a sign-up that may still roll back, which is counting
 * the attempt rather than the thing that happened.
 */
export const authRequests = new Counter({
  name: `${prefix}auth_requests_total`,
  help: "Requests to the auth routes under /api/auth, by route and outcome.",
  labelNames: ["route", "outcome"] as const,
  registers: [registry],
});

/** The two limiters that answer 429: Better Auth's own, and the setup code's. */
export const RATE_LIMITERS = ["auth", "setup_code"] as const;
export type RateLimiter = (typeof RATE_LIMITERS)[number];

/**
 * Requests a rate limiter turned away, by limiter.
 *
 * `auth` is Better Auth's limiter, counted in PostgreSQL across replicas.
 * `setup_code` is the attempt limiter in front of the first-account setup
 * code, which Better Auth never sees because a wrong code is refused before
 * its handler runs. A rise in the second is somebody guessing at the one code
 * that claims a deployment, and it was otherwise one 429 among every other.
 */
export const rateLimited = new Counter({
  name: `${prefix}rate_limited_total`,
  help: "Requests a rate limiter refused with a 429, by limiter.",
  labelNames: ["limiter"] as const,
  registers: [registry],
});

/**
 * Attempts the shared limiter could not record, and so counted locally.
 *
 * When its table cannot be reached the attempt limiter falls back to a tally
 * in this process, which is right — refusing every sign-in during a database's
 * bad minute is worse — and weaker by the replica count. It logged that and
 * nothing else, so a deployment could run on the weaker bound for a day with
 * no number saying so.
 */
export const rateLimitStoreFailures = new Counter({
  name: `${prefix}rate_limit_store_failures_total`,
  help: "Attempts the shared rate limiter could not record in PostgreSQL, and so counted in this process alone.",
  registers: [registry],
});

/** The levels counted: the two that mean somebody should look. */
export const COUNTED_LOG_LEVELS = ["warn", "error"] as const;
export type CountedLogLevel = (typeof COUNTED_LOG_LEVELS)[number];

/**
 * Lines written through `log` at `warn` or `error`, counted before `LOG_LEVEL`
 * decides whether they print.
 *
 * Most of what degrades rather than fails says so only in the log — a sweep
 * that threw, an idle connection dropped, the limiter falling back, a Stripe
 * key refused — and a log has no rate. Before the gate, because a deployment
 * that set `LOG_LEVEL=error` to quiet its warnings has not stopped having
 * them. Two levels rather than four: `debug` is a line per request, which would
 * make this a second request counter, and `info` is the ordinary story of a
 * process doing its job.
 *
 * The configuration layer's warnings are not in it. `config.ts`,
 * `config-files.ts` and `config-limits.ts` write to `console` directly,
 * because the gate reads its level from `getConfig()` and going through it
 * would recurse (`docs/standards/code/observability.md` §2.1). Each of those
 * is written at most once per process, and the log is where they are. Said on
 * the metric too, as `mcp_tool_calls_total` says what it leaves out, because
 * the help is what a dashboard's author reads.
 */
export const logMessages = new Counter({
  name: `${prefix}log_messages_total`,
  help: "Log lines written through the log gate at warn or error, counted whether or not LOG_LEVEL prints them. Excludes the configuration layer's warnings, which bypass the gate.",
  labelNames: ["level"] as const,
  registers: [registry],
});

export const mcpToolCalls = new Counter({
  name: `${prefix}mcp_tool_calls_total`,
  // What it does not count is worth saying on the metric itself: this is
  // incremented around the tool's own handler, so a call the protocol refuses
  // first — arguments the schema rejects, a tool that does not exist, a tool
  // outside the connection's scope — appears nowhere in it.
  // `mcp_requests_total` is counted at the transport and is where those are.
  help: "MCP tool calls that reached a tool, by tool and outcome. Excludes calls the protocol refused first.",
  labelNames: ["tool", "outcome"] as const,
  registers: [registry],
});

export const mcpToolDuration = new Histogram({
  name: `${prefix}mcp_tool_duration_seconds`,
  help: "How long an MCP tool call took, by tool.",
  labelNames: ["tool"] as const,
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

/**
 * The JSON-RPC methods worth a series of their own.
 *
 * `notification` is every `notifications/*` method, which a client sends and
 * expects no answer to. Anything else is `other`: the method is a string the
 * client writes, so it is mapped onto this list and never copied, or a client
 * could mint a series per string it cared to send.
 */
export const MCP_RPC_METHODS = [
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "notification",
  "other",
] as const;
export type McpRpcMethod = (typeof MCP_RPC_METHODS)[number];

/**
 * How the endpoint answered a JSON-RPC message.
 *
 * `tool_error` is a `tools/call` answered with `isError: true`, and it is wider
 * than `mcp_tool_calls_total{outcome="error"}` on purpose. The SDK (1.32)
 * answers a tool that does not exist, and arguments its schema rejects, in that
 * same shape before any tool runs, so the difference between the two series is
 * the calls the protocol refused. `insufficient_scope` is the step-up
 * challenge, a 403 sent before the SDK sees the call. The next three are
 * JSON-RPC's own error codes by name, with `invalid_request` covering both
 * -32700 and -32600 because each means the body was not a message at all.
 *
 * On the SDK (1.32) no reply carrying either of those two codes reaches this
 * seam. The transport answers a body it cannot parse, an over-long batch, an
 * `initialize` batched with anything else, the wrong `Accept` or content type,
 * or an unsupported protocol version itself, before any message reaches the
 * server, and those refusals — which name no method, so they are counted under
 * `other` — are what `invalid_request` counts in practice. Nor does the SDK
 * send -32602: it answers malformed params, such as a `tools/call` with no
 * tool name, as -32603, and an unknown tool or rejected arguments as
 * `tool_error`. So `invalid_params` is mapped ahead of an SDK that answers bad
 * params by their code, and the -32603 pin in
 * `tests/metrics-mcp-requests.test.ts` fails when that changes; dropping the
 * mapping would let the change land in `error` unnoticed. `error` is -32603,
 * or anything this seam did not expect.
 */
export const MCP_RPC_OUTCOMES = [
  "ok",
  "tool_error",
  "insufficient_scope",
  "invalid_request",
  "method_not_found",
  "invalid_params",
  "error",
] as const;
export type McpRpcOutcome = (typeof MCP_RPC_OUTCOMES)[number];

/**
 * Every JSON-RPC message the MCP endpoint answered, by method and outcome.
 *
 * The tool counter above wraps `registerTool`, so it sees only calls that
 * reached a tool, and a call refused by the protocol existed nowhere but the
 * response. This is counted where the HTTP request becomes JSON-RPC, which is
 * the one place both kinds pass. Anything but a POST carries no message — the
 * endpoint answers it 405 — and is in `http_requests_total` alone, and so is an
 * empty batch, which holds nothing to count. A body the step-up challenge
 * refuses counts every message in it as `insufficient_scope`, since the 403 is
 * the answer each of them got.
 */
export const mcpRequests = new Counter({
  name: `${prefix}mcp_requests_total`,
  help: "JSON-RPC messages the MCP endpoint answered, by method and outcome, including calls refused before any tool ran.",
  labelNames: ["rpc_method", "outcome"] as const,
  registers: [registry],
});

export const databaseTransactionDuration = new Histogram({
  name: `${prefix}db_transaction_duration_seconds`,
  help: "How long a transaction held its connection, from begin to commit or rollback. The wait for the connection is db_pool_acquire_duration_seconds.",
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

/** How a transaction can end. */
export const TRANSACTION_OUTCOMES = ["committed", "rolled_back"] as const;
export type TransactionOutcome = (typeof TRANSACTION_OUTCOMES)[number];

/**
 * Transactions this process opened, by how they ended.
 *
 * Beside the duration rather than a label on it: that histogram has shipped
 * without one, and a label added now would split every series somebody's
 * dashboard already reads. Counted once the transaction has settled, which is
 * §1.5 of the observability guide one level down — a transaction counted as
 * committed before its commit returned would be a count of attempts.
 */
export const databaseTransactions = new Counter({
  name: `${prefix}db_transactions_total`,
  help: "Database transactions this process opened, by whether they committed or rolled back.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * How long a caller waited for a connection from this process's pool.
 *
 * The pool gauge's `waiting` is read at scrape time, so a queue that formed and
 * drained between two scrapes — a burst of requests each waiting its turn
 * behind a pool of ten — never appears in it. Every wait appears here. A wait
 * that failed is observed too, so a timeout reads as the longest wait rather
 * than vanishing: the last finite bucket is the pool's own
 * `connectionTimeoutMillis`, ten seconds in `src/server/db/client.ts`, and
 * anything past it is an acquire that gave up. The bottom bucket separates an
 * idle connection handed straight over, which takes microseconds, from one
 * opened for the caller.
 */
export const databasePoolAcquireDuration = new Histogram({
  name: `${prefix}db_pool_acquire_duration_seconds`,
  help: "How long a caller waited for a connection from this process's pool, including waits that ended in failure.",
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Connections the pool lost or could not get.
 *
 * Two events and one question — can this process reach its database — so one
 * series. An idle client dropped by a database restart, a network blip or a
 * proxy's idle timeout, which `pg` reports on the pool rather than on any
 * request, and which had a log line and no number. And an acquire that failed
 * or timed out, which fails the request that asked but says nothing about why
 * in the request's own series.
 */
export const databasePoolErrors = new Counter({
  name: `${prefix}db_pool_errors_total`,
  help: "Connections this process's pool lost while idle or could not open for a caller.",
  registers: [registry],
});

export const migrationDuration = new Histogram({
  name: `${prefix}startup_migration_duration_seconds`,
  help: "How long the startup migration run took, including waiting for the advisory lock.",
  // Wider than the rest on purpose: this one waits on another process's
  // migration run, so tens of seconds is a normal reading rather than an
  // outlier, and a bucket set that tops out at 30 would hide it.
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300],
  registers: [registry],
});

export const migrationRuns = new Counter({
  name: `${prefix}startup_migration_runs_total`,
  help: "Startup migration runs, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const schedulerTicks = new Counter({
  name: `${prefix}scheduler_ticks_total`,
  help: "Recurrence scheduler ticks, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const schedulerTickDuration = new Histogram({
  name: `${prefix}scheduler_tick_duration_seconds`,
  help: "How long one scheduler tick took, all four sweeps together.",
  // Out past the request set, to the default interval. A tick runs the billing
  // sweep too, up to fifty subscriptions each read from Stripe, and a Stripe
  // read can take half a minute to give up, so minutes are a reading rather
  // than an outlier — and with the old top of thirty seconds every slow tick
  // landed in `+Inf`, where how slow could not be read at all. Three hundred is
  // `RECURRENCE_TICK_SECONDS`'s default, so `+Inf` now means a tick that ran
  // past the interval it is scheduled on, which is the reading worth alerting
  // on: the next tick waits for this one to finish.
  buckets: [...DURATION_BUCKETS, 60, 120, 300],
  registers: [registry],
});

/**
 * Whether this process runs the scheduler: 1 or 0.
 *
 * The answer moves between profiles and nothing said which. On a single
 * machine the API process runs it, so its ticks, mail and sweeps arrive under
 * `component="api"`; a split deployment turns it off there and runs it in a
 * process of its own. An alert written against one component never fires on
 * the other, and this series is right on both: a sum of zero is a deployment
 * where nothing is proposing anything.
 */
export const schedulerEnabled = new Gauge({
  name: `${prefix}scheduler_enabled`,
  help: "1 where this process runs the recurrence scheduler, 0 where it was told not to.",
  registers: [registry],
});

/**
 * The interval the scheduler waits between ticks, in seconds.
 *
 * Published so a staleness alert can be written as a multiple of it, rather
 * than as a number that is right only for the default. 0 in a process that
 * runs no scheduler, which is also what a gauge without labels reads before
 * anything sets it.
 */
export const schedulerTickInterval = new Gauge({
  name: `${prefix}scheduler_tick_interval_seconds`,
  help: "Seconds the recurrence scheduler waits between ticks, as configured. 0 where this process runs none.",
  registers: [registry],
});

/** The four jobs a tick runs, in the order it runs them. */
export const SCHEDULER_SWEEPS = ["recurrences", "reminders", "idempotency", "billing"] as const;
export type SchedulerSweep = (typeof SCHEDULER_SWEEPS)[number];

/**
 * When each sweep last ran to the end, in Unix seconds.
 *
 * The counters say how many ticks happened, and a rate over them cannot tell a
 * scheduler that stopped an hour ago from one that is merely quiet without a
 * window chosen to match the interval. A timestamp can: now minus this is how
 * long since the last success, whatever the interval. A sweep that found
 * itself switched off — billing where nothing is sold, retention left at
 * forever — still ran to the end and counts, or a deployment that sells
 * nothing would read as a stuck billing sweep forever. One that threw does
 * not. `sweep` rather than `job`, because `job` is the label every Prometheus
 * scrape writes on its own and the two would collide.
 */
export const schedulerLastSuccess = new Gauge({
  name: `${prefix}scheduler_last_success_timestamp_seconds`,
  help: "When each scheduler sweep last ran to the end, in Unix seconds. A sweep switched off still counts; one that threw does not.",
  labelNames: ["sweep"] as const,
  registers: [registry],
});

export const recurrenceOccurrences = new Counter({
  name: `${prefix}recurrence_occurrences_total`,
  help: "Recurrences a tick examined and what became of them.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const reminderSweeps = new Counter({
  name: `${prefix}reminder_sweeps_total`,
  help: "Template reminder sweeps, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * Idempotency records the retention sweep removed, by outcome.
 *
 * `off` rather than a silent zero: retention is off unless a deployment asks
 * for it, and a sweep that ran and pruned nothing looks identical in a bare
 * count to one that never ran — which is the same "a metric that was never
 * wired up looks like one nothing has reached" problem `observability.md` 1.6
 * is about. An operator who turned it on can see that it is doing something.
 */
export const idempotencySweeps = new Counter({
  name: `${prefix}idempotency_sweeps_total`,
  help: "Idempotency records the retention sweep removed, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const mailMessages = new Counter({
  name: `${prefix}mail_messages_total`,
  help: "Messages this process handed to the relay, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * How long the relay took to accept or refuse one message.
 *
 * Only for a message handed to a relay. One skipped because none is configured
 * kept nobody waiting and is `mail_messages_total{outcome="skipped"}` instead,
 * so a deployment without mail reads an empty histogram rather than a fast
 * one. The buckets run out past the transport's own bounds — ten seconds to
 * connect, ten for the greeting and twenty of silence on the socket, in
 * `smtpOptions` — so a send that hit every one of them lands at forty rather
 * than off the end.
 *
 * No `kind` label, here or on the counter. The source to hand is
 * `message.about`, and the notification sweeps write a recurrence or template
 * id into it, which is a series per row. A closed kind would be a new required
 * field on every message for a split that says little, since a relay that
 * refuses one kind of message is refusing the rest, and the same label on
 * `mail_messages_total` would split the series every existing query reads.
 * Which message failed is the log line's job, and it already names it.
 */
export const mailSendDuration = new Histogram({
  name: `${prefix}mail_send_duration_seconds`,
  help: "How long the relay took to accept or refuse a message. Messages skipped because no relay is configured are not timed.",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 60],
  registers: [registry],
});

/**
 * Requests this process made to Stripe, by what it asked for and how it went.
 *
 * Labeled by operation and outcome and by nothing else. A Stripe request is
 * always about one person's money, so a customer id, a subscription id or an
 * amount here would put somebody's payment history in front of whoever can
 * reach the scrape endpoint — `observability.md` 1.2 — and would be unbounded
 * cardinality besides. The operation names are a closed set written in this
 * repository, which is what keeps the series count fixed.
 *
 * Counted at the adapter seam rather than in each service, so a new call cannot
 * be added without being counted.
 */
export const stripeRequests = new Counter({
  name: `${prefix}stripe_requests_total`,
  help: "Requests this process made to Stripe, by operation and outcome.",
  labelNames: ["operation", "outcome"] as const,
  registers: [registry],
});

/**
 * How long a Stripe request took, by operation.
 *
 * Separate from `httpDuration`: that measures requests this server answers, and
 * a plan tab that feels slow because Stripe is slow looks identical in it to one
 * that is slow for any other reason.
 *
 * The buckets run out past the longest the client can take to give up, which
 * is not its timeout. Ten seconds is one attempt, and `maxNetworkRetries: 2` in
 * `stripe.ts` makes three, with the SDK's backoff between them — half a second,
 * then at most one — so a request that timed out every time reads about 31.5
 * seconds. The buckets stopped at ten, which put exactly the requests worth
 * looking at in `+Inf`; thirty and sixty give a give-up after two attempts and
 * after three a bucket each.
 */
export const stripeDuration = new Histogram({
  name: `${prefix}stripe_request_duration_seconds`,
  help: "How long a Stripe request took, by operation.",
  labelNames: ["operation"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/**
 * Why a Stripe request failed, in the SDK's own classification.
 *
 * One name per error class the SDK throws, plus the split `stripe.ts` already
 * makes between the two refusals that are about the key. `permission` is a key
 * missing a permission — `StripePermissionError`, or the
 * `more_permissions_required` code on any class — and `approval_required` is a
 * call Stripe is holding for a person to approve, which no new key fixes.
 * `connection` is a request that never got an answer, the client's own timeout
 * included. `api` is Stripe's own 5xx. `other` is anything that is not a
 * Stripe error at all.
 */
export const STRIPE_FAILURE_REASONS = [
  "card",
  "invalid_request",
  "authentication",
  "permission",
  "approval_required",
  "rate_limit",
  "idempotency",
  "connection",
  "api",
  "other",
] as const;
export type StripeFailureReason = (typeof STRIPE_FAILURE_REASONS)[number];

/**
 * Failed Stripe requests, by operation and why.
 *
 * A metric of its own rather than a label on `stripe_requests_total`, which
 * would split every series an existing dashboard reads. With it, "Stripe is
 * down" — `api`, `connection` — and "this deployment's key is wrong" —
 * `authentication`, `permission` — stop being one rising line. The reason
 * comes from the error's class and code, never its message, which can quote a
 * customer or an amount.
 */
export const stripeRequestFailures = new Counter({
  name: `${prefix}stripe_request_failures_total`,
  help: "Failed Stripe requests, by operation and the kind of failure. Each is also in stripe_requests_total as outcome failed.",
  labelNames: ["operation", "reason"] as const,
  registers: [registry],
});

/** What a startup check reaches; see `dependencyUp`. */
export const CHECKED_DEPENDENCIES = ["smtp", "stripe_prices", "stripe_access"] as const;
export type CheckedDependency = (typeof CHECKED_DEPENDENCIES)[number];

/**
 * What the dependency checks found, as a number an alert can read: 1 or 0.
 *
 * Both entrypoints check the relay and, where something is sold, the two
 * prices and what the key may read. Each degrades rather than stops the
 * process, and each said so in the log and nowhere an alert could read. This
 * records what a check found where the check runs and is never re-run for a
 * scrape, so it says what was last checked rather than what is true now.
 * `smtp` and `stripe_access` are checked only as the process starts: a relay
 * fixed since boot still reads 0, and `mail_messages_total` is where to read
 * whether mail is going out. `stripe_prices` follows every price check the
 * process makes — the plan tab, the point of sale and the billing sweep all
 * make one — because the point of sale refuses on the newest. A startup check
 * that could not reach the dependency is 0, since it passed nothing; a later
 * price read that could not reach Stripe leaves the verdict it had, as the
 * point of sale does. A dependency this deployment does not use is absent
 * rather than 0, because no relay configured is a supported deployment and not
 * a broken one.
 */
export const dependencyUp = new Gauge({
  name: `${prefix}dependency_up`,
  help: "1 if a dependency passed the last check this process made of it, 0 if it failed or, at startup, could not be made. smtp and stripe_access are checked at startup, stripe_prices whenever the prices are read. Absent where the deployment does not use it.",
  labelNames: ["dependency"] as const,
  registers: [registry],
});

/**
 * What the billing reconciliation sweep found, by outcome.
 *
 * `off` for the same reason the idempotency sweep has one: a deployment that
 * sells nothing is the default, and a sweep that examined nothing because there
 * was nothing to examine looks identical in a bare count to one that never ran.
 */
export const billingSweeps = new Counter({
  name: `${prefix}billing_sweeps_total`,
  help: "Subscriptions the reconciliation sweep re-read, by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * What the Stripe webhook did with each delivery it was handed.
 *
 * Beside the sweep's counter because the two answer the same operator question
 * from the two ends, and only one of them could answer it: every exit of the
 * route but the signature refusal replies `200 {"received":true}`, so
 * `http_requests_total` — route, method and status — cannot tell a delivery
 * that granted or revoked an entitlement from one that was acknowledged and
 * ignored. `docs/deployment.md` therefore sent anybody asking "did the
 * subscription path work?" to the *sweep*, which is the wrong instrument: the
 * sweep is the twelve-hourly catch-up, so reading it as the answer reports a
 * webhook that has been silently failing for hours as healthy right up to the
 * tick that repairs it.
 *
 * `outcome` is a closed set the route enumerates and nothing else can widen. It
 * names a branch, never a customer, an event id, an amount or an address, so
 * the identity rule and the cardinality it also protects both hold: the series
 * count is the branch count whatever arrives on the public URL, which is the
 * one route an unauthenticated caller supplies the body of.
 */
export const billingWebhookDeliveries = new Counter({
  name: `${prefix}billing_webhook_deliveries_total`,
  help: "Stripe deliveries answered, by what the handler did with each.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const ledgerWrites = new Counter({
  name: `${prefix}ledger_writes_total`,
  help: "Writes that changed the books, by operation.",
  labelNames: ["operation"] as const,
  registers: [registry],
});

export const stagedRowsCommitted = new Counter({
  name: `${prefix}staged_rows_committed_total`,
  help: "Staged rows turned into transactions.",
  registers: [registry],
});

export const csvRowsStaged = new Counter({
  name: `${prefix}csv_rows_staged_total`,
  help: "CSV rows placed in the review queue.",
  registers: [registry],
});

/**
 * What is deployed, as the one gauge every Prometheus setup expects.
 *
 * A scrape that cannot say which version produced it is a scrape you cannot
 * correlate with a deploy, which is most of what metrics are for on the day
 * something changes. Constant 1 with the version in a label is the convention;
 * the value carries nothing.
 */
new Gauge({
  name: `${prefix}build_info`,
  help: "Always 1. The labels say which build is running.",
  labelNames: ["version"] as const,
  registers: [registry],
  collect() {
    this.set({ version: APP_VERSION }, 1);
  },
});

export const idempotencyReplays = new Counter({
  name: `${prefix}idempotency_replays_total`,
  help: "Requests answered from a stored idempotency record instead of being run again.",
  labelNames: ["operation"] as const,
  registers: [registry],
});

/**
 * The pool, once something has actually opened one.
 *
 * Read through a holder rather than by importing `getPool()`, because that
 * function creates a pool if none exists and a scrape must never be the thing
 * that opens a database connection. A process that has not touched the database
 * reports no pool series at all, which is the honest answer.
 */
let trackedPool: Pool | undefined;

export function trackDatabasePool(pool: Pool) {
  trackedPool = pool;
}

new Gauge({
  name: `${prefix}db_pool_connections`,
  help: "Connections in this process's pool, by state.",
  labelNames: ["state"] as const,
  registers: [registry],
  collect() {
    if (!trackedPool) return;
    this.set({ state: "total" }, trackedPool.totalCount);
    this.set({ state: "idle" }, trackedPool.idleCount);
    // The one to alert on. `DATABASE_POOL_SIZE` defaults to a small number and
    // a request waiting here is a request that has already been admitted and is
    // now queued behind somebody else's transaction.
    this.set({ state: "waiting" }, trackedPool.waitingCount);
    // The ceiling, so `total` can be read as a share of something. From the
    // pool's own options rather than from configuration: those are what the
    // pool was built with, and reading `DATABASE_POOL_SIZE` again here would
    // have a scrape parse the environment to report a size the pool may not
    // have.
    this.set({ state: "max" }, trackedPool.options.max);
  },
});

let defaultsStarted = false;

/**
 * Heap, event loop lag, GC pauses and the rest, from `prom-client` itself.
 *
 * Started once per process, because a second start registers every name a
 * second time and the registry throws on that. `api.ts` and `scheduler.ts`
 * both start them at import, so anything that imports `api.ts` starts them
 * too. `tests/metrics.test.ts` does, which is why its naming checks exempt
 * `prom-client`'s own names rather than assuming they are absent. What they
 * read is whatever the process has done so far, so a test may look for one of
 * them and never at its value.
 */
export function startDefaultMetrics() {
  if (defaultsStarted) return;
  defaultsStarted = true;
  collectDefaultMetrics({ register: registry, prefix });
}

export function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;

/** For tests, which need each file to start from nothing. */
export function resetMetrics() {
  registry.resetMetrics();
  trackedPool = undefined;
}
