/**
 * What the capacity proof runs and what it has to beat.
 *
 * One file because three things read it — the driver that applies the load,
 * `docs/capacity.md`, and `tests/capacity-schedule.test.ts`, which holds the
 * document to these numbers. A threshold that lives only in prose is a
 * threshold nobody is held to.
 */

/**
 * The shape of an hour of use.
 *
 * The warm-up is excluded from every figure and is not politeness: the first
 * minutes are PostgreSQL filling a cold `shared_buffers` from disk, and
 * measuring them would report the latency of a machine that has just started
 * rather than one that is running.
 */
export const SCHEDULE = {
  warmupMinutes: 10,
  measureMinutes: 60,

  /**
   * Ten thousand people do not all press a key at once. 25 requests a second
   * is roughly every user making ninety requests an hour at the busiest hour of
   * the day, which for a ledger — opened, read, one or two entries added — is
   * generous rather than conservative.
   */
  rps: 25,

  /**
   * And the spike that is not an average: four times the rate for five minutes,
   * replacing the steady load rather than adding to it. This is the arm that
   * finds a connection pool too small or an index that was only ever fast
   * because nothing else was running.
   */
  burstRps: 100,
  burstAtMinute: 40,
  burstMinutes: 5,

  /**
   * Ten CSV imports at once, from minute twenty, each the largest the product
   * accepts. They overlap the steady load on purpose: an import holds a
   * transaction open and writes tens of thousands of postings, and what matters
   * is what that does to the person reading their register at the same time.
   */
  importsAtMinute: 20,
  concurrentImports: 10,
  importRows: 10_000,

  /**
   * Recurrences the scheduler finds due during the run, so its tick is doing
   * real work rather than finding an empty list. The scheduler shares the
   * process with the API in this profile, which is exactly why it is here.
   */
  dueRecurrences: 500,

  /**
   * Sessions held open. Not ten thousand: a virtual user is a concurrent
   * *visitor*, and the population is what they are drawn from. Five hundred
   * concurrent sessions against ten thousand accounts is a busy hour.
   */
  virtualUsers: 500,

  reports: ["net-worth", "income-expense", "categories", "cash-flow"],
};

/**
 * Where the requests go, by share of the total.
 *
 * Weighted towards reading because that is what people do with a ledger, and
 * deliberately not all reading: a proof with no write path measures the half of
 * the system that never takes a lock.
 */
export const MIX = [
  { kind: "register", percent: 35, what: "GET /api/v1/transactions — the page people live on" },
  { kind: "summary", percent: 20, what: "GET /api/v1/summary — the dashboard" },
  { kind: "accounts", percent: 15, what: "GET /api/v1/accounts/:id/balances" },
  { kind: "report", percent: 10, what: "GET /api/v1/reports/:report" },
  { kind: "write", percent: 10, what: "POST /api/v1/transactions — the write path" },
  { kind: "edit", percent: 5, what: "PATCH /api/v1/transactions/:id — a rename, which posts nothing" },
  { kind: "budget", percent: 5, what: "GET /api/v1/budget-report" },
];

/**
 * What a pass means.
 *
 * The latency numbers are what a person notices rather than what a machine can
 * do: a quarter of a second is a page that feels immediate, and two seconds is
 * where somebody looks at the tab to see whether it is still loading. They are
 * for the whole mix, because a p99 that excludes the slow route is not a p99.
 */
export const THRESHOLDS = {
  p50Ms: 100,
  p95Ms: 500,
  p99Ms: 2_000,
  /**
   * Zero would be the wrong target and a dishonest one: a rolling restart, a
   * connection reset, a 409 from two virtual users editing the same entry are
   * all real and all fine. What is not fine is a rate that says the machine is
   * shedding load.
   */
  errorRate: 0.001,
  cpuPercent: 85,
  memoryPercent: 90,
  /** Of POSTGRES_MAX_CONNECTIONS, which the single profile leaves at 100. */
  connections: 40,
  diskPercent: 80,
};
