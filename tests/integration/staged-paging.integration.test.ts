import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createStage, listStages } from "../../src/server/services/staging.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_staged_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
const actor: Actor = { userId: "staged-paging-user", source: "mcp", clientId: "test" };

let adminClient: PgClient;
let accountId: string;

/**
 * Walking the queue a page at a time has to reach every row exactly once.
 *
 * A staged row is allowed to be incomplete: a CSV line the parser could not
 * read keeps whatever it managed and nothing else, which is precisely the row
 * somebody opened the queue to fix. So the paging has to hold up when the field
 * it is ordering by is not there at all.
 */
async function walk(direction: "asc" | "desc", limit: number) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await listStages(actor, { limit, direction, ...(cursor ? { cursor } : {}) });
    seen.push(...result.items.map((item) => item.id));
    if (!result.nextCursor) return { seen, total: result.totalCount };
    cursor = result.nextCursor;
  }
  throw new Error("paging did not terminate");
}

integration("walking the staged queue by cursor", () => {
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
      name: "Staged Paging",
      email: "staged-paging@example.com",
      emailVerified: true,
    });
    accountId = (
      await createAccount(actor, {
        name: "Staged Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;

    // Three rows a bank file gave a date to, and three it did not.
    for (const [index, date] of ["2026-03-01", "2026-03-02", "2026-03-03"].entries()) {
      await createStage(actor, {
        draft: {
          type: "withdrawal",
          date,
          payee: `Dated ${index}`,
          fromAccountId: accountId,
          amount: "10.00",
        },
        idempotencyKey: `staged-dated-${index}`,
      });
    }
    for (const index of [0, 1, 2]) {
      await createStage(actor, {
        draft: { payee: `Undated ${index}` },
        idempotencyKey: `staged-undated-${index}`,
      });
    }
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("counts every staged row, dated or not", async () => {
    const page = await listStages(actor, { limit: 50 });
    expect(page.totalCount).toBe(6);
    expect(page.items).toHaveLength(6);
  });

  for (const direction of ["asc", "desc"] as const) {
    // A limit of two forces the page boundary to land on an undated row.
    it(`reaches every row exactly once paging ${direction}`, async () => {
      const { seen, total } = await walk(direction, 2);
      expect(total).toBe(6);
      expect(new Set(seen).size).toBe(6);
      expect(seen).toHaveLength(6);
    });
  }

  it("puts the undated rows at one end rather than losing them", async () => {
    const ascending = await listStages(actor, { limit: 50, direction: "asc" });
    const names = ascending.items.map((item) => (item.draft as { payee?: string }).payee);
    expect(names.filter((n) => n?.startsWith("Undated"))).toHaveLength(3);
    // Ascending, an absent date sorts before every real one.
    expect(names.slice(0, 3).every((n) => n?.startsWith("Undated"))).toBe(true);
  });
});
