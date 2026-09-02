import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { dropScratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount, setAccountArchived } from "../../src/server/services/accounts.js";
import { createRecurrence } from "../../src/server/services/recurrences.js";
import { getSummary } from "../../src/server/services/summary.js";
import { createTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_onepool_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "one-connection", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolSize = process.env.DATABASE_POOL_SIZE;
let adminClient: PgClient;

/**
 * A deployment is allowed to run on one connection, and `DATABASE_POOL_SIZE=1`
 * is the setting that says so. Anything that opens a transaction and then reads
 * from the pool again waits for a connection its own transaction is holding, and
 * waits forever: the request never answers and never errors either, so there is
 * nothing in a log to explain it.
 *
 * Archiving an account was doing exactly that, reading the timezone preference
 * off the pool from inside the closing-entry transaction. The whole suite runs
 * on a larger pool, which is why nothing caught it.
 */
integration("running on a single database connection", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.DATABASE_POOL_SIZE = "1";
    await runMigrations();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "One Connection",
      email: "one-connection@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await dropScratchDatabase({
      admin: adminClient,
      name: databaseName,
      previousDatabaseUrl: originalDatabaseUrl,
    });
    if (originalPoolSize === undefined) delete process.env.DATABASE_POOL_SIZE;
    else process.env.DATABASE_POOL_SIZE = originalPoolSize;
  });

  it("archives an account holding a balance without waiting on itself", async () => {
    const account = await createAccount(actor, {
      name: "Closing",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "500",
    });
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Somewhere",
        description: null,
        amount: "100.00",
        fromAccountId: account.id,
      },
      "one-connection-key-1",
    );

    // The archive posts a closing entry, which is the path that used to reach
    // back into the pool. A timeout here is the deadlock, not slowness: the
    // pool's connectionTimeoutMillis is 10s and this does nothing heavy.
    const archived = await Promise.race([
      setAccountArchived(actor, account.id, account.version, true),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("archive never answered")), 20_000),
      ),
    ]);
    expect((archived as { archivedAt: unknown }).archivedAt).not.toBeNull();

    const closed = await getDb().execute(
      `select coalesce(sum(amount), 0)::text as balance from posting where account_id = '${account.id}'`,
    );
    expect((closed.rows[0] as { balance: string }).balance).toMatch(/^0\.?0*$/);
  });

  /**
   * The same shape again, one service along. An MCP write opens the transaction
   * itself so the idempotency record, the mutation and the audit events land
   * together, then hands it in; anything inside that reaches back into the pool
   * waits on the connection its own caller is holding.
   */
  /**
   * The dashboard runs its three aggregates together rather than in turn. They
   * go to the pool rather than to one transaction, so on a pool of one they
   * queue; a version that held a connection while asking for another would
   * never answer and never error either.
   */
  it("answers the dashboard with its aggregates in flight together", async () => {
    const account = await createAccount(actor, {
      name: "Summary Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "500",
    });
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-01-05",
        payee: "Shop",
        description: null,
        fromAccountId: account.id,
        amount: "25.00",
      },
      "one-connection-summary",
    );
    const summary = await Promise.race([
      getSummary(actor, { start: "2026-01-01", end: "2026-12-31" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the summary never answered")), 5_000),
      ),
    ]);
    expect(summary).toMatchObject({ currencies: expect.any(Array) });
  });

  it("creates a recurrence inside a caller's transaction without waiting on itself", async () => {
    const account = await createAccount(actor, {
      name: "Standing",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "500",
    });

    const created = await Promise.race([
      getDb().transaction((tx) =>
        createRecurrence(
          actor,
          {
            name: "Inside a transaction",
            shape: {
              type: "withdrawal",
              payee: "Landlord",
              fromAccountId: account.id,
              amount: "1200.00",
            },
            schedule: { frequency: "monthly", anchorDate: "2030-03-01" },
          },
          tx,
        ),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("create never answered")), 20_000),
      ),
    ]);
    expect((created as { name: string }).name).toBe("Inside a transaction");
  });
});
