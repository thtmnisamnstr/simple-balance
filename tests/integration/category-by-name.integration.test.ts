import { and, eq } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { dropScratchDatabase } from "./support/scratch-database.js";
import { categories, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory, setCategoryArchived } from "../../src/server/services/categories.js";
import { createStage } from "../../src/server/services/staging.js";
import { createTransaction, updateTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_catname_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "category-by-name-user", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let accountId: string;

let keySeed = 0;
// Padded on the counter rather than the whole string, because padding the
// string to a fixed width made different counters collide: "…-1" and "…-10"
// both filled out to the same key, and two calls with the same payload then
// returned the first transaction instead of making a second one — a test that
// passes having written nothing.
const nextKey = () => `cat-by-name-${String((keySeed += 1)).padStart(4, "0")}`;

const owned = () => getDb().select().from(categories).where(eq(categories.userId, actor.userId));

const named = async (name: string) => {
  const rows = await owned();
  return rows.filter((row) => row.name.trim().toLowerCase() === name.trim().toLowerCase());
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
    await dropScratchDatabase({
      admin: adminClient,
      name: databaseName,
      previousDatabaseUrl: originalDatabaseUrl,
    });
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

  /**
   * This used to assert the opposite, and its own fixture gave the game away by
   * calling the payee "Refund". Widening was right while a deposit could not
   * name a spending category at all; now that it can, and means a refund,
   * widening destroys the thing that makes it one. `both` agrees with whichever
   * direction it is handed, so the widened category credits income for ever
   * after and the budget it should lower never moves.
   */
  it("keeps a spending category as spending when a refund names it", async () => {
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
    expect(rows[0].kind).toBe("expense");
  });

  /** A category genuinely used both ways still widens, because that pairing is
   *  an ambiguity rather than a reversal. */
  it("widens a category when one side of the pairing already covers both", async () => {
    const flexible = await createCategory(actor, {
      name: "Reimbursements",
      kind: "both",
    });
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-04",
        payee: "Paid out",
        description: null,
        amount: "3.00",
        fromAccountId: accountId,
        categoryName: "reimbursements",
      },
      nextKey(),
    );
    const rows = await named("Reimbursements");
    expect(rows[0].kind).toBe("both");
    expect(rows[0].id).toBe(flexible.id);
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
      .where(and(eq(categories.userId, stranger.userId), eq(categories.name, "Groceries")));
    expect(theirs).toHaveLength(1);
    expect((await named("Groceries"))[0].id).not.toBe(theirs[0].id);
  });
  /**
   * Saying which kind a name should be created as.
   *
   * The direction is a good guess and a bad rule. A deposit naming something
   * new made an income category, so the one entry that most needs a spending
   * category — a refund arriving before any spending was ever filed under that
   * name — was the one entry that could not make one. `categoryKind` is how a
   * caller says so, and it is consulted for exactly that case: a name, nothing
   * behind it yet, and a direction that would guess wrong.
   */
  describe("saying which kind a new category should be", () => {
    it("creates a spending category from a deposit when told to", async () => {
      const created = await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-10",
          payee: "Electronics Store",
          description: null,
          amount: "30.00",
          toAccountId: accountId,
          categoryName: "Gadgets",
          categoryKind: "expense",
        },
        nextKey(),
      );
      const [category] = await named("Gadgets");
      expect(category).toBeDefined();
      // Not "income", which is what the direction alone would have made, and
      // not "both", which is what a widening resolve used to make.
      expect(category.kind).toBe("expense");
      expect(created.categoryId).toBe(category.id);
    });

    it("creates an income category from a withdrawal when told to", async () => {
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-02-11",
          payee: "Client Refunded",
          description: null,
          amount: "40.00",
          fromAccountId: accountId,
          categoryName: "Consulting Returned",
          categoryKind: "income",
        },
        nextKey(),
      );
      expect((await named("Consulting Returned"))[0].kind).toBe("income");
    });

    it("still follows the direction when nothing says otherwise", async () => {
      await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-12",
          payee: "Employer",
          description: null,
          amount: "500.00",
          toAccountId: accountId,
          categoryName: "Salary",
        },
        nextKey(),
      );
      expect((await named("Salary"))[0].kind).toBe("income");
    });

    // A category that exists has a right answer already, and this field is not
    // a licence to overwrite it. Letting it through would be the widening bug
    // again wearing a different hat.
    it("leaves a category that already exists alone", async () => {
      const before = await named("Groceries");
      expect(before[0].kind).toBe("expense");
      await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-13",
          payee: "Supermarket Refund",
          description: null,
          amount: "6.00",
          toAccountId: accountId,
          categoryName: "GROCERIES",
          categoryKind: "income",
        },
        nextKey(),
      );
      const after = await named("Groceries");
      expect(after).toHaveLength(1);
      expect(after[0].kind).toBe("expense");
      expect(after[0].version).toBe(before[0].version);
    });

    it("ignores it when an id already answers the question", async () => {
      const [existing] = await named("Gadgets");
      const created = await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-14",
          payee: "Electronics Store",
          description: null,
          amount: "7.00",
          toAccountId: accountId,
          categoryId: existing.id,
          categoryKind: "income",
        },
        nextKey(),
      );
      expect(created.categoryId).toBe(existing.id);
      expect((await named("Gadgets"))[0].kind).toBe("expense");
    });

    // Every leg is a share of one movement, so one answer covers them all.
    it("applies to the legs of a split", async () => {
      await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-15",
          payee: "Two Refunds",
          description: null,
          amount: "25.00",
          toAccountId: accountId,
          categoryKind: "expense",
          legs: [
            { categoryName: "Returned Boots", amount: "10.00" },
            { categoryName: "Returned Coat", amount: "15.00" },
          ],
        },
        nextKey(),
      );
      expect((await named("Returned Boots"))[0].kind).toBe("expense");
      expect((await named("Returned Coat"))[0].kind).toBe("expense");
    });

    it("works on an edit as well as a create", async () => {
      const created = await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-16",
          payee: "Later Refund",
          description: null,
          amount: "11.00",
          toAccountId: accountId,
        },
        nextKey(),
      );
      await updateTransaction(actor, created.id, {
        draft: {
          type: "deposit",
          date: "2026-02-16",
          payee: "Later Refund",
          description: null,
          amount: "11.00",
          toAccountId: accountId,
          categoryName: "Edited Into Spending",
          categoryKind: "expense",
        },
        expectedVersion: created.version,
      });
      expect((await named("Edited Into Spending"))[0].kind).toBe("expense");
    });

    // The field decides how to create a category; it is not itself stored on
    // the entry. A staged row keeps it so the commit, which sees one row at a
    // time, still knows what the row said.
    it("does not survive onto the saved transaction", async () => {
      const created = await createTransaction(
        actor,
        {
          type: "deposit",
          date: "2026-02-17",
          payee: "No Residue",
          description: null,
          amount: "4.00",
          toAccountId: accountId,
          categoryName: "Residue Check",
          categoryKind: "expense",
        },
        nextKey(),
      );
      expect(created).not.toHaveProperty("categoryKind");
    });
  });
});
