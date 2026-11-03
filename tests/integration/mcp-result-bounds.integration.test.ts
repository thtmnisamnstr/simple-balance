import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import {
  MCP_CSV_EXPORT_MAX_CHARACTERS,
  MCP_CSV_EXPORT_MAX_ROWS,
  MCP_REGISTER_MAX_ENTRIES,
} from "../../src/server/config-limits.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { exportTransactionsCsv } from "../../src/server/services/import-export.js";
import { getAccountRegister } from "../../src/server/services/reports.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * `docs/standards/mcp.md` §A reply fits the context it lands in.
 *
 * A tool reply lands whole in a model's context and is sent twice, so the two
 * tools whose replies grow with the ledger refuse past a limit of their own —
 * with the limit and the count, never a reply cut short — while the browser's
 * routes, which hand a download to a browser, keep theirs. Seeded one row past
 * both limits: the opening posting and 200 withdrawals put 201 postings on the
 * account, one over the register's 200, and 200 transactions are twice the
 * CSV's 100. And ten more, a year later on a second account, each carrying a
 * note as long as a note may be: well inside the row limit and far past the
 * size one, which is the case a row count alone let through.
 */
const connection = process.env.TEST_DATABASE_URL;
const database = scratchDatabase("mcp_bounds");
const actor = { userId: "mcp-bounds", source: "mcp" as const, clientId: "bounds" };
let accountId: string;

async function call(name: string, args: Record<string, unknown>) {
  const server = createMcpServer(actor, new Set(["ledger:read"]));
  const client = new Client({ name: "bounds", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  try {
    const reply = await client.callTool({ name, arguments: args });
    return {
      isError: reply.isError === true,
      result: (reply.structuredContent as { result: Record<string, unknown> }).result,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

describe.skipIf(!connection)("how much one MCP reply carries", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Bounds",
      email: "bounds@example.com",
      emailVerified: true,
    });
    accountId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2025-01-01",
        openingBalance: "10000",
      })
    ).id;
    for (let day = 0; day < MCP_REGISTER_MAX_ENTRIES; day += 1) {
      const date = new Date(Date.UTC(2025, 1, 1) + day * 86_400_000).toISOString().slice(0, 10);
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date,
          payee: `Shop ${day}`,
          description: null,
          fromAccountId: accountId,
          amount: "1.00",
        },
        `bounds-${day}`,
      );
    }
    const savings = (
      await createAccount(actor, {
        name: "Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2025-01-01",
        openingBalance: "10000",
      })
    ).id;
    for (let day = 0; day < 10; day += 1) {
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: `2026-03-${String(day + 1).padStart(2, "0")}`,
          payee: `Long note ${day}`,
          description: null,
          notes: "n".repeat(4_000),
          fromAccountId: savings,
          amount: "1.00",
        },
        `bounds-long-${day}`,
      );
    }
  }, 120_000);

  afterAll(() => database.drop());

  it("refuses a register one posting past the limit, saying both numbers", async () => {
    const reply = await call("get_account_register", { id: accountId });
    expect(reply.isError).toBe(true);
    expect(reply.result.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { limit: MCP_REGISTER_MAX_ENTRIES, postingCount: MCP_REGISTER_MAX_ENTRIES + 1 },
    });
    const within = await call("get_account_register", { id: accountId, start: "2025-02-01" });
    expect(within.isError).toBe(false);
    expect(within.result.entries).toHaveLength(MCP_REGISTER_MAX_ENTRIES);
    // The browser's register lists the same range whole.
    expect((await getAccountRegister(actor, accountId, {})).entries).toHaveLength(
      MCP_REGISTER_MAX_ENTRIES + 1,
    );
  });

  it("refuses a CSV past the limit rather than cutting it short", async () => {
    const reply = await call("export_transactions_csv", { end: "2025-12-31" });
    expect(reply.isError).toBe(true);
    expect(reply.result.error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { limit: MCP_CSV_EXPORT_MAX_ROWS },
    });
    const within = await call("export_transactions_csv", {
      start: "2025-02-01",
      end: "2025-05-11",
    });
    expect(within.isError).toBe(false);
    expect(within.result.rowCount).toBe(MCP_CSV_EXPORT_MAX_ROWS);
    // The download carries every one of them.
    expect((await exportTransactionsCsv(actor, {})).rowCount).toBe(MCP_REGISTER_MAX_ENTRIES + 10);
  });

  it("refuses a CSV past the size limit, however few rows it holds", async () => {
    const reply = await call("export_transactions_csv", { start: "2026-01-01" });
    expect(reply.isError).toBe(true);
    const details = (reply.result.error as { details: Record<string, number> }).details;
    expect(details).toMatchObject({ limit: MCP_CSV_EXPORT_MAX_CHARACTERS, rowCount: 10 });
    expect(details.characters).toBeGreaterThan(MCP_CSV_EXPORT_MAX_CHARACTERS);
  });
});
