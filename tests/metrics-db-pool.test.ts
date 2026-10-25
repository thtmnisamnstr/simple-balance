import { createServer } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getPool } from "../src/server/db/client.js";
import { registry, resetMetrics } from "../src/server/metrics.js";

/**
 * The pool's half of the database metrics, against a database that is not
 * there.
 *
 * An acquire that fails is the case that needs no PostgreSQL to produce, and
 * it is the one that matters most to see: the request that asked fails, and
 * its own series can only say that it did. The success path — waits that end
 * in a connection, transactions that commit and roll back, an idle connection
 * the server drops — is
 * `tests/integration/metrics-db-transactions.integration.test.ts`.
 */
const previousDatabaseUrl = process.env.DATABASE_URL;

/** A port on this machine that was free a moment ago, so a connect is refused at once. */
async function refusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port was assigned");
  return address.port;
}

async function counter(name: string, labels: Record<string, string> = {}) {
  const metric = (await registry.getMetricsAsJSON()).find((one) => one.name === name);
  const values = (metric?.values ?? []) as { value: number; labels: Record<string, string> }[];
  return values
    .filter((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value))
    .reduce((total, entry) => total + entry.value, 0);
}

/** How many observations a histogram has taken, read off its `_count`. */
async function observations(name: string) {
  const metric = (await registry.getMetricsAsJSON()).find((one) => one.name === name);
  const values = (metric?.values ?? []) as { value: number; metricName?: string }[];
  return values
    .filter((entry) => entry.metricName === `${name}_count`)
    .reduce((total, entry) => total + entry.value, 0);
}

const acquires = () => observations("simple_balance_db_pool_acquire_duration_seconds");
const poolErrors = () => counter("simple_balance_db_pool_errors_total");

describe("a connection the pool could not get", () => {
  beforeAll(async () => {
    await closeDb();
    process.env.DATABASE_URL = `postgresql://nobody@127.0.0.1:${await refusedPort()}/nothing`;
  });
  afterAll(async () => {
    await closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    resetMetrics();
  });
  beforeEach(() => {
    resetMetrics();
  });

  /**
   * Both shapes `connect` is called in. A transaction awaits its promise; a
   * statement outside one goes through `pool.query`, which calls `connect` with
   * a callback and never passes anything `getDb()` hands out — so a wrapper on
   * the drizzle instance alone would have counted the first and not the second.
   */
  it("is timed and counted as a pool error, whichever way it was asked for", async () => {
    await expect(getPool().connect()).rejects.toThrow();
    await expect(getPool().query("select 1")).rejects.toThrow();
    await expect(getDb().execute(sql`select 1`)).rejects.toThrow();

    expect(await acquires()).toBe(3);
    expect(await poolErrors()).toBe(3);
  });

  /**
   * No connection, so no `begin`, so no transaction: counting it as rolled back
   * would report a rollback of something that never started, and timing it
   * would put a refused connect into a histogram of how long transactions held
   * one. The acquire that failed is counted, once, where it belongs.
   */
  it("opens no transaction, so counts none and times none", async () => {
    let ran = false;
    await expect(
      getDb().transaction(async () => {
        ran = true;
      }),
    ).rejects.toThrow();

    expect(ran).toBe(false);
    expect(await counter("simple_balance_db_transactions_total")).toBe(0);
    expect(await observations("simple_balance_db_transaction_duration_seconds")).toBe(0);
    expect(await poolErrors()).toBe(1);
  });
});

/**
 * The pool's size, by state, read from the pool when a scrape asks and never
 * by opening one. pg builds a pool without connecting, so all of it is
 * observable with nothing listening.
 */
describe("the pool's connections, by state", () => {
  const previousPoolSize = process.env.DATABASE_POOL_SIZE;
  const states = async () => {
    const metric = (await registry.getMetricsAsJSON()).find(
      (one) => one.name === "simple_balance_db_pool_connections",
    );
    const values = (metric?.values ?? []) as { value: number; labels: Record<string, string> }[];
    return Object.fromEntries(values.map((entry) => [entry.labels.state, entry.value]));
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = `postgresql://nobody@127.0.0.1:${await refusedPort()}/nothing`;
    // Not the default of ten, so `max` can only have come from the pool this
    // process built.
    process.env.DATABASE_POOL_SIZE = "7";
    // Both: `resetMetrics()` forgets the tracked pool while the client module
    // keeps its own, and `getPool()` tracks only a pool it has just built.
    resetMetrics();
    await closeDb();
  });
  afterAll(async () => {
    await closeDb();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousPoolSize === undefined) delete process.env.DATABASE_POOL_SIZE;
    else process.env.DATABASE_POOL_SIZE = previousPoolSize;
    resetMetrics();
  });

  it("publishes nothing before a pool exists, because a scrape never opens one", async () => {
    expect(await states()).toEqual({});
  });

  /**
   * `max` from the pool's own options rather than from the environment: those
   * are what the pool was built with, and `total / max` is the share a
   * dashboard reads.
   */
  it("publishes the ceiling beside the counts once one does", async () => {
    const pool = getPool();

    expect(pool.options.max).toBe(7);
    expect(await states()).toEqual({ total: 0, idle: 0, waiting: 0, max: 7 });
  });
});
