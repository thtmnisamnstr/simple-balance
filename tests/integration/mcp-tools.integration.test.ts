import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";

const connection = process.env.TEST_DATABASE_URL;
const dbName = `sb_mcp_live_${process.pid}`;
const actor = { userId: "mcp-live", source: "mcp" as const, clientId: "live" };
let admin: PgClient;
let client: Client;
let server: ReturnType<typeof createMcpServer>;
let accountId: string;
let categoryId: string;

/**
 * The schema tests prove a tool publishes a contract; this proves it honours it.
 *
 * Worth having as its own file because the two can disagree silently: a tool
 * whose result does not satisfy its declared output schema has that result
 * dropped rather than reported, and every agent calling it gets nothing back
 * with no error to explain why. That is how `set_preferences` shipped returning
 * a row without the `chosen` field the schema promised, and it is what this
 * caught.
 */
describe.skipIf(!connection)("every tool answers over a real connection", () => {
  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const url = new URL(connection!); url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    await runMigrations();
    await getDb().insert(user).values({ id: actor.userId, name: "Live", email: "live@example.com", emailVerified: true });
    accountId = (await createAccount(actor, { name: "Checking", type: "checking", currency: "USD", openingDate: "2026-01-01", openingBalance: "100" })).id;
    categoryId = (await createCategory(actor, { name: "Groceries", kind: "expense" })).id;
    server = createMcpServer(actor, new Set(["ledger:read", "ledger:stage", "ledger:write"]));
    client = new Client({ name: "live", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s); await client.connect(c);
  });
  afterAll(async () => {
    await client?.close(); await server?.close(); await closeDb();
    await admin.query(`drop database if exists "${dbName}"`); await admin.end();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const out = await client.callTool({ name, arguments: args });
    const result = (out.structuredContent as { result: unknown })?.result;
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`${name}: ${JSON.stringify((result as { error: unknown }).error)}`);
    }
    return result;
  };

  it("answers each of the reads added for parity with the browser", async () => {
    expect(await call("whoami")).toMatchObject({ email: "live@example.com", clientId: "live" });
    expect(await call("get_preferences")).toMatchObject({ chosen: false, timezone: "UTC" });
    expect(await call("get_account", { id: accountId })).toMatchObject({ name: "Checking" });
    expect(await call("get_category", { id: categoryId })).toMatchObject({ name: "Groceries" });
    expect(await call("list_payee_suggestions", { search: "" })).toEqual([]);
    expect(await call("list_import_batches", {})).toMatchObject({ items: [] });
    expect(await call("summarize_own_data")).toMatchObject({ accounts: 1, categories: 1 });
    expect(await call("preview_csv", { csv: "date,payee,amount\n2026-01-01,Shop,5.00" }))
      .toMatchObject({ headers: ["date", "payee", "amount"], delimiter: "," });
  });

  it("sets a preference and reads it back", async () => {
    expect(await call("set_preferences", { timezone: "Europe/Paris", idempotencyKey: "pref-key-1" }))
      .toMatchObject({ timezone: "Europe/Paris", defaultCurrency: "USD" });
    expect(await call("get_preferences")).toMatchObject({ timezone: "Europe/Paris", chosen: true });
  });

  it("runs the whole template lifecycle", async () => {
    const created = await call("create_transaction_template", {
      name: "Weekly shop",
      draft: { type: "withdrawal", payee: "Corner Shop", fromAccountId: accountId, categoryId },
      idempotencyKey: "tpl-key-1",
    }) as { id: string; version: number; draft: Record<string, unknown> };
    expect(created.draft).not.toHaveProperty("amount");

    expect(await call("list_transaction_templates")).toHaveLength(1);
    expect(await call("get_transaction_template", { id: created.id })).toMatchObject({ name: "Weekly shop" });

    const updated = await call("update_transaction_template", {
      id: created.id, input: { name: "Shop", expectedVersion: created.version }, idempotencyKey: "tpl-key-2",
    }) as { version: number };
    expect(updated.version).toBe(2);

    expect(await call("delete_transaction_template", {
      id: created.id, expectedVersion: updated.version, idempotencyKey: "tpl-key-3",
    })).toEqual({ id: created.id, deleted: true });
    expect(await call("list_transaction_templates")).toHaveLength(0);
  });

  /**
   * Over the real transport rather than against the service, because a result
   * that fails its declared output schema is dropped without an error: the call
   * looks like it did nothing rather than like it broke.
   */
  it("changes and deletes many templates at once", async () => {
    const made = [];
    for (const name of ["Bulk one", "Bulk two"]) {
      made.push(await call("create_transaction_template", {
        name,
        draft: { type: "withdrawal", payee: "Before", fromAccountId: accountId, categoryId, amount: "9.00" },
        idempotencyKey: `bulk-create-${name}`,
      }) as { id: string; version: number });
    }

    const edited = await call("bulk_edit_transaction_templates", {
      selection: { items: made.map((t) => ({ id: t.id, expectedVersion: t.version })) },
      patch: { payee: "After", amount: null },
      idempotencyKey: "bulk-edit-1",
    }) as { dryRun: boolean; changedCount: number; items: { id: string; version: number }[] };
    expect(edited).toMatchObject({ dryRun: false, changedCount: 2 });
    expect(edited.items).toHaveLength(2);

    const listed = await call("list_transaction_templates") as {
      id: string; version: number; draft: Record<string, unknown>;
    }[];
    for (const template of listed) {
      expect(template.draft.payee).toBe("After");
      expect(template.draft).not.toHaveProperty("amount");
    }

    const deleted = await call("bulk_delete_transaction_templates", {
      selection: { items: listed.map((t) => ({ id: t.id, expectedVersion: t.version })) },
      idempotencyKey: "bulk-delete-1",
    }) as { changedCount: number };
    expect(deleted.changedCount).toBe(2);
    expect(await call("list_transaction_templates")).toHaveLength(0);
  });

  // The three keys a template refuses rather than drops, checked through the
  // transport an agent actually uses rather than against the schema directly.
  it("refuses a template carrying a date, an import reference, or a category name", async () => {
    for (const bad of [{ date: "2026-01-05" }, { externalId: "bank-ref" }, { categoryName: "Groceries" }]) {
      const out = await client.callTool({
        name: "create_transaction_template",
        arguments: { name: `Bad ${Object.keys(bad)[0]}`, draft: { type: "withdrawal", ...bad }, idempotencyKey: `bad-${Object.keys(bad)[0]}` },
      });
      expect(out.isError, `${Object.keys(bad)[0]} must be refused`).toBe(true);
    }
  });
});
