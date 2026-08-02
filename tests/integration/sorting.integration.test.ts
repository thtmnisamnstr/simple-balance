import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  createTransaction,
  listTransactions,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const actor: Actor = { userId: "integration-sorting", source: "web" };

async function payeesInOrder(sort: string, direction: string) {
  const page = await listTransactions(actor, { sort, direction, limit: 50 });
  return page.items.map((item) => item.payee);
}

integration("list ordering", () => {
  let checkingId: string;
  let savingsId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = connection;
    await runMigrations();
    await getDb().execute(sql`delete from auth_user where id = ${actor.userId}`);
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Sorting Tenant",
      email: "sorting@example.com",
      emailVerified: true,
    });

    // "Alpha" sorts before "Zulu" by name but is created second, so a name sort
    // cannot accidentally pass by falling back to insertion order.
    savingsId = (
      await createAccount(actor, {
        name: "Zulu Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2027-01-01",
        openingBalance: "0",
      })
    ).id;
    checkingId = (
      await createAccount(actor, {
        name: "Alpha Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2027-01-01",
        openingBalance: "0",
      })
    ).id;
    const travel = await createCategory(actor, { name: "Travel", kind: "expense" });
    const bills = await createCategory(actor, { name: "Bills", kind: "expense" });

    const rows = [
      { date: "2027-03-01", payee: "Yarrow", amount: "300", account: savingsId, categoryId: travel.id },
      { date: "2027-01-15", payee: "Acacia", amount: "20.50", account: checkingId, categoryId: bills.id },
      { date: "2027-02-10", payee: "Marigold", amount: "1000", account: checkingId, categoryId: undefined },
    ];
    for (const [index, row] of rows.entries()) {
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: row.date,
          payee: row.payee,
          description: null,
          categoryId: row.categoryId,
          fromAccountId: row.account,
          amount: row.amount,
        },
        `sorting-${index}`,
      );
    }
  });

  afterAll(async () => {
    if (connection) {
      await getDb().execute(sql`delete from auth_user where id = ${actor.userId}`);
    }
    await closeDb();
  });

  it("orders by date in both directions", async () => {
    expect(await payeesInOrder("date", "desc")).toEqual([
      "Yarrow",
      "Marigold",
      "Acacia",
    ]);
    expect(await payeesInOrder("date", "asc")).toEqual([
      "Acacia",
      "Marigold",
      "Yarrow",
    ]);
  });

  it("orders by payee in both directions", async () => {
    expect(await payeesInOrder("payee", "asc")).toEqual([
      "Acacia",
      "Marigold",
      "Yarrow",
    ]);
    expect(await payeesInOrder("payee", "desc")).toEqual([
      "Yarrow",
      "Marigold",
      "Acacia",
    ]);
  });

  it("orders by amount as a number rather than as text", async () => {
    // Sorted as text, 1000 would fall between 20.50 and 300.
    expect(await payeesInOrder("amount", "asc")).toEqual([
      "Acacia",
      "Yarrow",
      "Marigold",
    ]);
    expect(await payeesInOrder("amount", "desc")).toEqual([
      "Marigold",
      "Yarrow",
      "Acacia",
    ]);
  });

  it("orders by account name", async () => {
    const ascending = await payeesInOrder("account", "asc");
    expect(ascending.at(-1)).toBe("Yarrow");
    expect(ascending.slice(0, 2).sort()).toEqual(["Acacia", "Marigold"]);
  });

  it("orders by category and puts uncategorised rows last either way", async () => {
    expect(await payeesInOrder("category", "asc")).toEqual([
      "Acacia",
      "Yarrow",
      "Marigold",
    ]);
    expect(await payeesInOrder("category", "desc")).toEqual([
      "Yarrow",
      "Acacia",
      "Marigold",
    ]);
  });

  it("resumes a keyset sort through its cursor", async () => {
    const first = await listTransactions(actor, {
      sort: "payee",
      direction: "asc",
      limit: 2,
    });
    expect(first.items.map((item) => item.payee)).toEqual(["Acacia", "Marigold"]);
    expect(first.nextCursor).toBeTruthy();

    const second = await listTransactions(actor, {
      sort: "payee",
      direction: "asc",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.payee)).toEqual(["Yarrow"]);
  });

  it("refuses a cursor from a different ordering", async () => {
    const first = await listTransactions(actor, {
      sort: "payee",
      direction: "asc",
      limit: 2,
    });
    await expect(
      listTransactions(actor, {
        sort: "date",
        direction: "desc",
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow(/different sort order/);
  });

  it("pages an account or category sort by number instead of by cursor", async () => {
    const page = await listTransactions(actor, {
      sort: "account",
      direction: "asc",
      limit: 2,
    });
    expect(page.nextCursor).toBeNull();
    expect(page.totalPages).toBe(2);

    const second = await listTransactions(actor, {
      sort: "account",
      direction: "asc",
      limit: 2,
      page: 2,
    });
    expect(second.items).toHaveLength(1);
  });
});
