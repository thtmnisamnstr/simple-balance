import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { dropScratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { registry } from "../../src/server/metrics.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";

/**
 * The counters that only move when something is actually written.
 *
 * Every other metrics test reads the registry or the endpoint; this one is
 * about the thing being counted. A counter incremented inside a transaction
 * would report a write that rolled back as a write that happened, and a counter
 * incremented at the transport would miss the same write made over MCP, so the
 * placement is the whole claim and only a real database can check it.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_metrics_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "metrics-user", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let accountId: string;

let keySeed = 0;
const nextKey = () => `metrics-${String((keySeed += 1)).padStart(4, "0")}`;

/**
 * How many observations a histogram has taken.
 *
 * A histogram is one metric in the registry and its `_count` is a value inside
 * it, not a metric of its own — asking for `..._seconds_count` by name finds
 * nothing and reads as zero, which is a test that passes on a metric that was
 * never wired up.
 */
async function observationCount(name: string) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((candidate) => candidate.name === name);
  const values = (metric?.values ?? []) as { value: number; metricName?: string }[];
  return values
    .filter((entry) => entry.metricName?.endsWith("_count"))
    .reduce((total, entry) => total + entry.value, 0);
}

/** One counter's value, summed across its labels, or 0 if it has never moved. */
async function counterValue(name: string, labels: Record<string, string> = {}) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((candidate) => candidate.name === name);
  const values = (metric?.values ?? []) as { value: number; labels: Record<string, string> }[];
  return values
    .filter((entry) =>
      Object.entries(labels).every(([label, expected]) => entry.labels[label] === expected),
    )
    .reduce((total, entry) => total + entry.value, 0);
}

integration("what a write adds to the metrics", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Metrics",
      email: "metrics@example.com",
      emailVerified: true,
    });
    const account = await createAccount(actor, {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "1000",
    });
    accountId = account.id;
  });

  afterAll(async () => {
    await dropScratchDatabase({
      admin: adminClient,
      name: databaseName,
      previousDatabaseUrl: originalDatabaseUrl,
    });
  });

  it("counts a create, a delete and a restore as the three things they are", async () => {
    const before = {
      create: await counterValue("simple_balance_ledger_writes_total", { operation: "create" }),
      remove: await counterValue("simple_balance_ledger_writes_total", { operation: "delete" }),
      restore: await counterValue("simple_balance_ledger_writes_total", { operation: "restore" }),
    };
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Groceries",
        description: null,
        fromAccountId: accountId,
        amount: "12.34",
      },
      nextKey(),
    );
    const deleted = await setTransactionDeleted(actor, created.id, created.version, true);
    await setTransactionDeleted(actor, created.id, deleted.version, false);

    expect(await counterValue("simple_balance_ledger_writes_total", { operation: "create" })).toBe(
      before.create + 1,
    );
    // Deleting and restoring are one function with a flag, and counting them
    // under one name would make "somebody is undoing things" unreadable.
    expect(await counterValue("simple_balance_ledger_writes_total", { operation: "delete" })).toBe(
      before.remove + 1,
    );
    expect(await counterValue("simple_balance_ledger_writes_total", { operation: "restore" })).toBe(
      before.restore + 1,
    );
  });

  it("counts a refused write nowhere", async () => {
    const before = await counterValue("simple_balance_ledger_writes_total");
    await expect(
      createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-02-02",
          payee: "Nowhere",
          description: null,
          fromAccountId: "00000000-0000-4000-8000-000000000000",
          amount: "1.00",
        },
        nextKey(),
      ),
    ).rejects.toThrow();
    // The reason the counter sits outside the transaction rather than beside
    // the insert: this write never happened, and a metric that said it did
    // would make a broken deployment look busy.
    expect(await counterValue("simple_balance_ledger_writes_total")).toBe(before);
  });

  it("counts a replayed key as a replay and not as a second write", async () => {
    const key = nextKey();
    const draft = {
      type: "deposit" as const,
      date: "2026-02-03",
      payee: "Salary",
      description: null,
      toAccountId: accountId,
      amount: "100.00",
    };
    const first = await createTransaction(actor, draft, key);
    const replays = await counterValue("simple_balance_idempotency_replays_total", {
      operation: "transaction.create",
    });
    const writes = await counterValue("simple_balance_ledger_writes_total", {
      operation: "create",
    });
    const second = await createTransaction(actor, draft, key);

    // Same row back, so the ledger changed once. The retry is a fact about the
    // client rather than about the books, and the two counters split it that
    // way: `ledger_writes_total` does not move and `idempotency_replays_total`
    // does. Counting both was the defect — a client retrying a four-thousand-row
    // edit reported eight thousand rows changed.
    expect(second.id).toBe(first.id);
    expect(await counterValue("simple_balance_ledger_writes_total", { operation: "create" })).toBe(
      writes,
    );
    expect(
      await counterValue("simple_balance_idempotency_replays_total", {
        operation: "transaction.create",
      }),
    ).toBe(replays + 1);
  });

  it("counts an MCP tool that could be served as a call that worked", async () => {
    const server = createMcpServer(
      { userId: actor.userId, source: "mcp", clientId: "metrics-test" },
      new Set(["ledger:read"]),
    );
    const client = new Client({ name: "metrics", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const before = await counterValue("simple_balance_mcp_tool_calls_total", {
        tool: "whoami",
        outcome: "ok",
      });
      await client.callTool({ name: "whoami", arguments: {} });
      // The half the unit tier cannot show. Without a database `whoami` cannot
      // answer at all, so `outcome="ok"` is only reachable where there is a
      // ledger to answer from — and a counter that only ever recorded failures
      // would look identical up there.
      expect(
        await counterValue("simple_balance_mcp_tool_calls_total", {
          tool: "whoami",
          outcome: "ok",
        }),
      ).toBe(before + 1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("times the transaction it opened, and not the one it was handed", async () => {
    const before = await observationCount("simple_balance_db_transaction_duration_seconds");
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-02-04",
        payee: "Interest",
        description: null,
        toAccountId: accountId,
        amount: "0.50",
      },
      nextKey(),
    );
    const after = await observationCount("simple_balance_db_transaction_duration_seconds");
    // One observation for one service call. A nested `withTransaction` inside
    // the same call reuses the connection and must not be timed again, or one
    // write reads as several and the total time spent holding connections comes
    // back larger than the wall clock.
    expect(after).toBe(before + 1);
  });
});
