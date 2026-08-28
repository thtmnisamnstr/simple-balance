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
 * `tests/metrics.test.ts` fails on a label that is not.
 *
 * **A route label is the pattern, never the path.** `/api/v1/accounts/:id` is
 * one series; `/api/v1/accounts/<uuid>` is one series per account, which is how
 * a monitoring system falls over on a ledger with ten thousand transactions.
 *
 * **Collection is always on; only the endpoint is switched.** A labelled
 * increment costs about 130ns and does allocate — `prom-client` hashes the
 * label object into a string key on every call — and an unlabelled one about
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
// balancer: the interesting range is "did that take a moment" rather than
// single-digit milliseconds, and the tail matters because a CSV import and a
// balance query live in the same histogram family.
const DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

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

export const mcpToolCalls = new Counter({
  name: `${prefix}mcp_tool_calls_total`,
  // What it does not count is worth saying on the metric itself: this is
  // incremented around the tool's own handler, so a call the protocol refuses
  // first — arguments the schema rejects, a tool that does not exist, a tool
  // outside the connection's scope — appears nowhere in it.
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

export const databaseTransactionDuration = new Histogram({
  name: `${prefix}db_transaction_duration_seconds`,
  help: "How long a service transaction held its connection.",
  buckets: DURATION_BUCKETS,
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
  help: "How long one scheduler tick took, proposals and reminders together.",
  buckets: DURATION_BUCKETS,
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

export const mailMessages = new Counter({
  name: `${prefix}mail_messages_total`,
  help: "Messages this process handed to the relay, by outcome.",
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
  },
});

let defaultsStarted = false;

/**
 * Heap, event loop lag, GC pauses and the rest, from `prom-client` itself.
 *
 * Started once and never in a test: the GC observer and the event-loop probe
 * are process-wide, and a suite that starts them in one file and reads the
 * registry in another gets numbers from whichever ran first.
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
