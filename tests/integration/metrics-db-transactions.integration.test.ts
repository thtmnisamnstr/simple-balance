import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sql } from "drizzle-orm";
import { Client as PgClient, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb, getPool } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { log } from "../../src/server/log.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { registry } from "../../src/server/metrics.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * What a transaction and a connection add to the database metrics, against a
 * real PostgreSQL.
 *
 * Every claim here is about when something happened relative to a `commit`, a
 * `begin` or a wait for a connection, and none of those exist without a
 * database. The unit tier holds the case that needs no database — a connection
 * that could not be had (`tests/metrics-db-pool.test.ts`).
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("metrics_db");
const actor: Actor = { userId: "metrics-db-user", source: "web" };

/** One counter's value, summed across its labels, or 0 if it has never moved. */
async function counter(name: string, labels: Record<string, string> = {}) {
  const metric = (await registry.getMetricsAsJSON()).find((one) => one.name === name);
  const values = (metric?.values ?? []) as { value: number; labels: Record<string, string> }[];
  return values
    .filter((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value))
    .reduce((total, entry) => total + entry.value, 0);
}

/** A histogram's `_count` or `_sum`, read where a scrape reads it. */
async function histogram(name: string, part: "count" | "sum") {
  const metric = (await registry.getMetricsAsJSON()).find((one) => one.name === name);
  const values = (metric?.values ?? []) as { value: number; metricName?: string }[];
  return values
    .filter((entry) => entry.metricName === `${name}_${part}`)
    .reduce((total, entry) => total + entry.value, 0);
}

const committed = () => counter("simple_balance_db_transactions_total", { outcome: "committed" });
const rolledBack = () =>
  counter("simple_balance_db_transactions_total", { outcome: "rolled_back" });
const timed = () => histogram("simple_balance_db_transaction_duration_seconds", "count");
const acquires = () => histogram("simple_balance_db_pool_acquire_duration_seconds", "count");

/** Everything a test reads, before it acts, so each one asserts its own difference. */
async function snapshot() {
  return {
    committed: await committed(),
    rolledBack: await rolledBack(),
    timed: await timed(),
    acquires: await acquires(),
  };
}

integration("what a transaction adds to the database metrics", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Metrics",
      email: "metrics-db@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Read from inside the callback, which is as late as a count could be made
   * and still be inside the transaction. A count made there is a count of
   * attempts: the `commit` that decides whether the write happened has not
   * been sent yet.
   */
  it("counts a transaction as committed once its commit has returned, and not before", async () => {
    const before = await snapshot();
    let during = -1;
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      during = await committed();
    });

    expect(during).toBe(before.committed);
    expect(await committed()).toBe(before.committed + 1);
    expect(await rolledBack()).toBe(before.rolledBack);
    expect(await timed()).toBe(before.timed + 1);
  });

  it("counts a transaction whose callback threw as rolled back, and never as committed", async () => {
    const before = await snapshot();
    const refused = new Error("rolled back on purpose");
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        throw refused;
      }),
    ).rejects.toBe(refused);

    expect(await rolledBack()).toBe(before.rolledBack + 1);
    expect(await committed()).toBe(before.committed);
    // A rollback held its connection as surely as a commit did.
    expect(await timed()).toBe(before.timed + 1);
  });

  /**
   * The callback finished and the transaction still did not commit: the
   * deferred constraint is checked at `commit`, which PostgreSQL refuses and
   * ends the transaction over. Reading the outcome off the callback rather than
   * off the commit would count this as a write that happened.
   */
  it("counts a commit PostgreSQL refused as a rollback", async () => {
    const before = await snapshot();
    let finished = false;
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(
          sql.raw(
            "create temp table deferred_probe (id integer, constraint deferred_probe_id unique (id) deferrable initially deferred) on commit drop",
          ),
        );
        await tx.execute(sql.raw("insert into deferred_probe values (1), (1)"));
        finished = true;
      }),
    ).rejects.toThrow();

    expect(finished).toBe(true);
    expect(await rolledBack()).toBe(before.rolledBack + 1);
    expect(await committed()).toBe(before.committed);
  });

  /**
   * A savepoint shares its parent's connection and its parent's commit, so it
   * is part of that transaction rather than a second one. Counting it again
   * would report one write as two and add its time to the parent's, which
   * already contains it.
   */
  it("counts a savepoint as part of the transaction it nests in", async () => {
    const before = await snapshot();
    await getDb().transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await inner.execute(sql`select 1`);
      });
    });

    expect(await committed()).toBe(before.committed + 1);
    expect(await timed()).toBe(before.timed + 1);
  });

  /**
   * The case that was untimed. Every MCP write opens its transaction itself, so
   * the idempotency record, the write and the audit entry share one connection,
   * and it did so with `getDb().transaction` directly while only
   * `withTransaction` carried a timer. One write is one transaction: the
   * service inside joins the one it is handed rather than opening its own.
   */
  it("times the transaction an MCP write opens for itself", async () => {
    const server = createMcpServer(
      { userId: actor.userId, source: "mcp", clientId: "metrics-db" },
      new Set(["ledger:write"]),
    );
    const client = new Client({ name: "metrics-db", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const before = await snapshot();
      const result = await client.callTool({
        name: "create_category",
        arguments: { name: "Groceries", kind: "expense", idempotencyKey: "metrics-db-0001" },
      });
      expect(result.isError).not.toBe(true);

      expect(await committed()).toBe(before.committed + 1);
      expect(await timed()).toBe(before.timed + 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * A statement outside a transaction goes through `pool.query`, which takes
   * its connection through the same `connect` a transaction calls, in its
   * callback form. Both are waits for a connection, and a full pool is felt by
   * the plain reads first.
   */
  it("times every wait for a connection, a single statement's as well as a transaction's", async () => {
    const before = await snapshot();
    await getDb().execute(sql`select 1`);
    expect(await acquires()).toBe(before.acquires + 1);

    await getDb().transaction(async (tx) => {
      await tx.execute(sql`select 1`);
    });
    expect(await acquires()).toBe(before.acquires + 2);
  });

  /**
   * The transaction's clock starts once it has a connection, so a wait for one
   * is in the acquire histogram and only there. Measured by making the wait
   * long and the transaction trivial: every connection is held, a transaction
   * asks for one, and one is let go a third of a second later.
   */
  it("keeps the wait for a connection out of the transaction's time", async () => {
    const pool = getPool();
    const held: PoolClient[] = [];
    for (let index = 0; index < pool.options.max; index += 1) held.push(await pool.connect());
    const waitedBefore = await histogram("simple_balance_db_pool_acquire_duration_seconds", "sum");
    const heldBefore = await histogram("simple_balance_db_transaction_duration_seconds", "sum");

    const queued = getDb().transaction(async (tx) => {
      await tx.execute(sql`select 1`);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    held.pop()?.release();
    await queued;
    for (const client of held) client.release();

    const waited =
      (await histogram("simple_balance_db_pool_acquire_duration_seconds", "sum")) - waitedBefore;
    const heldFor =
      (await histogram("simple_balance_db_transaction_duration_seconds", "sum")) - heldBefore;
    // The queued transaction waited at least the 0.3 s before a connection came
    // free, and then ran one statement, which is milliseconds. Starting the
    // clock before the wait — what `withTransaction` did — would have put the
    // whole 0.3 s in the second figure as well.
    expect(waited).toBeGreaterThanOrEqual(0.29);
    expect(heldFor).toBeLessThan(0.2);
  });

  /**
   * An idle connection the server drops is reported on the pool rather than on
   * any request, so it had a log line and no number: a database restart was
   * invisible to a dashboard until the requests after it started failing. It
   * ends every connection the pool holds, and the pool opens new ones for
   * whatever runs next, so it sits last for tidiness and passes shuffled.
   */
  it("counts every idle connection the database dropped", async () => {
    const failure = vi.spyOn(log, "failure").mockImplementation(() => undefined);
    await getDb().execute(sql`select 1`);
    const idle = getPool().idleCount;
    expect(idle).toBeGreaterThan(0);
    const before = await counter("simple_balance_db_pool_errors_total");

    const admin = new PgClient({ connectionString: connection });
    await admin.connect();
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [new URL(process.env.DATABASE_URL!).pathname.slice(1)],
      );
    } finally {
      await admin.end();
    }

    await vi.waitFor(async () =>
      expect(await counter("simple_balance_db_pool_errors_total")).toBe(before + idle),
    );
    expect(failure).toHaveBeenCalledWith("Idle database client error", expect.anything());
  });
});
