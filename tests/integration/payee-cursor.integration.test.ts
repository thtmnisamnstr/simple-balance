import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createTransaction,
  listTransactions,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("payee_cursor");
const actor: Actor = { userId: "payee-cursor-user", source: "web" };

/**
 * Payees whose lowercase form PostgreSQL and JavaScript disagree about. The
 * dotted capital lowercases to one character in the database and to two in
 * JavaScript; the Greek word ends in a sigma that JavaScript lowercases to its
 * final form and the database does not. Whether they disagree depends on the
 * collation the database was created with, so this pins the walk rather than the
 * mapping: a cursor that carries the database's own answer is right under every
 * collation, and one that carries JavaScript's is right under none of them
 * reliably.
 */
const PAYEES = ["Aaa Shop", "İstanbul Market", "ΟΔΟΣ", "Zzz Store"];

let checkingId = "";

integration("paging a payee-sorted list", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Payee Cursor",
      email: "payee-cursor@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "10000",
      })
    ).id;
    for (const [index, payee] of PAYEES.entries()) {
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-04-01",
          payee,
          description: null,
          fromAccountId: checkingId,
          amount: "10",
        },
        `payee-cursor-${index}`,
      );
    }
  });

  afterAll(async () => {
    await database.drop();
  });

  /**
   * The ordering value is selected alongside the row so the cursor can carry the
   * database's own answer back. It is a working column, and `transactionView`
   * spreads whatever row it is handed, so leaving it on published it as a field
   * of every transaction on both the API and the MCP tool.
   */
  it.each(["date", "payee", "amount", "account"] as const)(
    "keeps its ordering column out of what a %s-sorted list returns",
    async (sort) => {
      const page = await listTransactions(actor, { sort, limit: 10 });
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) {
        expect(Object.keys(item)).not.toContain("cursorSort");
      }
    },
  );

  it.each(["asc", "desc"] as const)(
    "walks every row exactly once, %s",
    async (direction) => {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let step = 0; step <= PAYEES.length + 1; step += 1) {
        const page = await listTransactions(actor, {
          sort: "payee",
          direction,
          limit: 1,
          cursor: cursor ?? undefined,
        });
        seen.push(...page.items.map((item) => item.payee));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      expect([...seen].sort()).toEqual([...PAYEES].sort());
    },
  );
});
