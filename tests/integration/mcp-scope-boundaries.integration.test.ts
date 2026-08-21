import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { categories, ledgerAccounts, user } from "../../src/server/db/schema.js";
import { createMcpServer } from "../../src/server/mcp.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createCategory,
  setCategoryArchived,
} from "../../src/server/services/categories.js";

const connection = process.env.TEST_DATABASE_URL;
const dbName = `sb_mcp_scope_${process.pid}`;
const actor = { userId: "mcp-scope", source: "mcp" as const, clientId: "scoped" };
let admin: PgClient;
let accountId: string;
let archivedId: string;

async function connectWith(scopes: string[]) {
  const server = createMcpServer(actor, new Set(scopes));
  const client = new Client({ name: "scoped", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  return { server, client };
}

const csv = (categoryName: string) =>
  `date,payee,amount,category\n2026-03-01,Shop,12.00,${categoryName}\n`;

/**
 * `ledger:stage` is the scope for an agent that may propose and never decide.
 * A CSV naming a category it does not have is a way to make one, and a CSV
 * naming an archived one is a way to bring it back: both are changes to the
 * ledger's own records that nobody with only staging authority approved.
 */
describe.skipIf(!connection)("what a staging-only agent may change", () => {
  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const url = new URL(connection!);
    url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Scoped",
      email: "scoped@example.com",
      emailVerified: true,
    });
    accountId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "100",
      })
    ).id;
    const archived = await createCategory(actor, {
      name: "Old Subscriptions",
      kind: "expense",
    });
    archivedId = archived.id;
    await setCategoryArchived(actor, archivedId, archived.version, true);
  });

  afterAll(async () => {
    await closeDb();
    await admin.query(`drop database if exists "${dbName}"`);
    await admin.end();
  });

  const stage = async (
    scopes: string[],
    categoryName: string,
    idempotencyKey: string,
  ) => {
    const { server, client } = await connectWith(scopes);
    try {
      const out = await client.callTool({
        name: "stage_csv",
        arguments: {
          csv: csv(categoryName),
          fileName: "statement.csv",
          defaultAccountId: accountId,
          mapping: {
            date: "date",
            payee: "payee",
            amount: "amount",
            category: "category",
          },
          idempotencyKey,
        },
      });
      const result = (out.structuredContent as { result: unknown })?.result as {
        referenceResolution: {
          categories: { inputName: string; categoryId: string | null; resolution: string }[];
        };
      };
      expect(result, JSON.stringify(out.structuredContent)).toBeTruthy();
      return result;
    } finally {
      await client.close();
      await server.close();
    }
  };

  const categoryNamed = async (name: string) =>
    getDb()
      .select()
      .from(categories)
      .where(and(eq(categories.userId, actor.userId), eq(categories.name, name)));

  it("does not create a category a CSV names", async () => {
    const result = await stage(["ledger:stage"], "Hardware", "stage-only-new");
    expect(result.referenceResolution.categories).toEqual([
      expect.objectContaining({
        inputName: "Hardware",
        categoryId: null,
        resolution: "deferred",
      }),
    ]);
    expect(await categoryNamed("Hardware")).toEqual([]);
  });

  it("does not bring an archived category back", async () => {
    const result = await stage(
      ["ledger:stage"],
      "Old Subscriptions",
      "stage-only-archived",
    );
    expect(result.referenceResolution.categories).toEqual([
      expect.objectContaining({
        inputName: "Old Subscriptions",
        categoryId: null,
        resolution: "deferred",
        unarchived: false,
      }),
    ]);
    const [row] = await categoryNamed("Old Subscriptions");
    expect(row!.archivedAt).not.toBeNull();
  });

  it("creates one when the same call is made with ledger:write", async () => {
    const result = await stage(
      ["ledger:stage", "ledger:write"],
      "Hardware",
      "write-new",
    );
    expect(result.referenceResolution.categories).toEqual([
      expect.objectContaining({ inputName: "Hardware", resolution: "new" }),
    ]);
    const [row] = await categoryNamed("Hardware");
    expect(row).toBeTruthy();
    expect(result.referenceResolution.categories[0]!.categoryId).toBe(row!.id);
  });

  /**
   * Preparing a draft is meant to answer whether it would balance, and nothing
   * else. It used to open the counter-account it needed on the way, so an agent
   * with nothing but propose rights wrote a ledger account and put a new zero
   * row in the trial balance.
   */
  it("does not open a counter-account a draft would need", async () => {
    // A currency nothing has settled in yet, so the counter-account this draft
    // needs genuinely does not exist. Against the USD account the expense
    // account is already there and the write has nothing to show.
    const euro = (
      await createAccount(actor, {
        name: "Euro Current",
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "100",
      })
    ).id;
    const systemAccounts = () =>
      getDb()
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.userId, actor.userId),
            isNotNull(ledgerAccounts.systemKind),
          ),
        );
    const before = await systemAccounts();

    const { server, client } = await connectWith(["ledger:stage"]);
    try {
      const out = await client.callTool({
        name: "create_staged_transaction",
        arguments: {
          draft: {
            type: "withdrawal",
            date: "2026-05-05",
            payee: "Papeterie",
            amount: "12.00",
            fromAccountId: euro,
          },
          idempotencyKey: "stage-only-counter-account",
        },
      });
      expect(out.isError, JSON.stringify(out.structuredContent)).toBeFalsy();
    } finally {
      await client.close();
      await server.close();
    }

    const after = await systemAccounts();
    expect(after.map((row) => row.name).sort()).toEqual(
      before.map((row) => row.name).sort(),
    );
  });

  it("brings an archived one back with ledger:write", async () => {
    const result = await stage(
      ["ledger:stage", "ledger:write"],
      "Old Subscriptions",
      "write-archived",
    );
    expect(result.referenceResolution.categories).toEqual([
      expect.objectContaining({ resolution: "updated", unarchived: true }),
    ]);
    const [row] = await categoryNamed("Old Subscriptions");
    expect(row!.archivedAt).toBeNull();
  });
});
