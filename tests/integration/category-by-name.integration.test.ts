import { and, eq } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { categories, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createCategory,
  setCategoryArchived,
} from "../../src/server/services/categories.js";
import { createStage } from "../../src/server/services/staging.js";
import {
  createTransaction,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_catname_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "category-by-name-user", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let accountId: string;

let keySeed = 0;
const nextKey = () => `cat-by-name-${(keySeed += 1)}`.padEnd(16, "0");

const owned = () =>
  getDb().select().from(categories).where(eq(categories.userId, actor.userId));

const named = async (name: string) => {
  const rows = await owned();
  return rows.filter(
    (row) => row.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
};

integration("naming a category on a transaction instead of picking one", () => {
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
      name: "Category By Name",
      email: "category-by-name@example.com",
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
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("creates a category nobody has yet, and files the entry under it", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Corner Shop",
        description: null,
        amount: "12.00",
        fromAccountId: accountId,
        categoryName: "Groceries",
      },
      nextKey(),
    );
    const [category] = await named("Groceries");
    expect(category).toBeDefined();
    expect(category.name).toBe("Groceries");
    expect(category.kind).toBe("expense");
    expect(created.categoryId).toBe(category.id);
  });

  // The whole point of the change: a second spelling must not appear.
  it("uses the category already there when only the capitalization differs", async () => {
    const before = await named("Groceries");
    expect(before).toHaveLength(1);

    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-02",
        payee: "Corner Shop",
        description: null,
        amount: "8.00",
        fromAccountId: accountId,
        categoryName: "  gROCERIES  ",
      },
      nextKey(),
    );

    const after = await named("Groceries");
    expect(after).toHaveLength(1);
    expect(created.categoryId).toBe(before[0].id);
    // The ledger's own spelling is what survives, not the one just typed.
    expect(after[0].name).toBe("Groceries");
  });

  it("widens a category rather than duplicating it when the other side needs it", async () => {
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-02-03",
        payee: "Refund",
        description: null,
        amount: "5.00",
        toAccountId: accountId,
        categoryName: "groceries",
      },
      nextKey(),
    );
    const rows = await named("Groceries");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("both");
  });

  it("brings an archived category back when it is named again", async () => {
    const parking = await createCategory(actor, {
      name: "Parking",
      kind: "expense",
    });
    await setCategoryArchived(actor, parking.id, parking.version, true);
    expect((await named("Parking"))[0].archivedAt).not.toBeNull();

    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-04",
        payee: "Garage",
        description: null,
        amount: "4.00",
        fromAccountId: accountId,
        categoryName: "parking",
      },
      nextKey(),
    );
    const rows = await named("Parking");
    expect(rows).toHaveLength(1);
    expect(rows[0].archivedAt).toBeNull();
    expect(created.categoryId).toBe(parking.id);
  });

  it("prefers an id the caller gave over a name they also sent", async () => {
    const utilities = await createCategory(actor, {
      name: "Utilities",
      kind: "expense",
    });
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-05",
        payee: "Power Co",
        description: null,
        amount: "60.00",
        fromAccountId: accountId,
        categoryId: utilities.id,
        categoryName: "Something Else Entirely",
      },
      nextKey(),
    );
    expect(created.categoryId).toBe(utilities.id);
    expect(await named("Something Else Entirely")).toHaveLength(0);
  });

  it("resolves a name on an edit too", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-06",
        payee: "Bookshop",
        description: null,
        amount: "20.00",
        fromAccountId: accountId,
      },
      nextKey(),
    );
    expect(created.categoryId).toBeNull();

    const updated = await updateTransaction(actor, created.id, {
      draft: {
        type: "withdrawal",
        date: "2026-02-06",
        payee: "Bookshop",
        description: null,
        amount: "20.00",
        fromAccountId: accountId,
        categoryName: "Books",
      },
      expectedVersion: created.version,
    });
    const [books] = await named("Books");
    expect(books).toBeDefined();
    expect(updated.categoryId).toBe(books.id);
  });

  // Staging validates a row by preparing it. Preparing must not write, or
  // queueing a row for review would quietly change the ledger's categories.
  it("does not create a category merely because a staged row names one", async () => {
    await createStage(actor, {
      idempotencyKey: nextKey(),
      draft: {
        type: "withdrawal",
        date: "2026-02-07",
        payee: "Not Yet Real",
        description: null,
        amount: "3.00",
        fromAccountId: accountId,
        categoryName: "Phantom Category",
      },
    });
    expect(await named("Phantom Category")).toHaveLength(0);
  });

  it("keeps one person's categories out of another's reach", async () => {
    const stranger: Actor = { userId: "category-by-name-stranger", source: "web" };
    await getDb().insert(user).values({
      id: stranger.userId,
      name: "Stranger",
      email: "category-by-name-stranger@example.com",
      emailVerified: true,
    });
    const strangerAccount = await createAccount(stranger, {
      name: "Their Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "100",
    });
    await createTransaction(
      stranger,
      {
        type: "withdrawal",
        date: "2026-02-08",
        payee: "Corner Shop",
        description: null,
        amount: "9.00",
        fromAccountId: strangerAccount.id,
        categoryName: "Groceries",
      },
      nextKey(),
    );
    // Same name, and it must be their own row, not a match against ours.
    const theirs = await getDb()
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.userId, stranger.userId),
          eq(categories.name, "Groceries"),
        ),
      );
    expect(theirs).toHaveLength(1);
    expect((await named("Groceries"))[0].id).not.toBe(theirs[0].id);
  });
});
