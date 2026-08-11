import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { stagedTransactions, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createCategory,
  listCategorySummaries,
  setCategoryArchived,
} from "../../src/server/services/categories.js";
import {
  commitStages,
  createStage,
  deleteStages,
  listStages,
} from "../../src/server/services/staging.js";
import {
  createTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_catuse_${process.pid}_${Date.now()}`;
const owner: Actor = { userId: "category-usage-owner", source: "web" };
const stranger: Actor = { userId: "category-usage-stranger", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;

let adminClient: PgClient;
let checkingId: string;
let savingsId: string;
let strangerAccountId: string;

let keySeed = 0;
const nextKey = () => `category-usage-key-${(keySeed += 1)}`;

const summaryFor = async (name: string, includeArchived = false) => {
  const summaries = await listCategorySummaries(owner, includeArchived);
  return summaries.find((summary) => summary.name === name);
};

const category = async (name: string, kind: "income" | "expense" | "both" = "expense") =>
  (await createCategory(owner, { name, kind })).id;

let spendSeed = 0;
async function spend(categoryId: string, amount: string, date = "2026-05-01") {
  return createTransaction(
    owner,
    {
      type: "withdrawal",
      date,
      payee: `Somewhere ${(spendSeed += 1)}`,
      description: null,
      amount,
      fromAccountId: checkingId,
      categoryId,
    },
    nextKey(),
  );
}

integration("how much each category is used", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();

    await getDb().insert(user).values([
      {
        id: owner.userId,
        name: "Category Usage",
        email: "category-usage@example.com",
        emailVerified: true,
      },
      {
        id: stranger.userId,
        name: "Stranger",
        email: "category-usage-stranger@example.com",
        emailVerified: true,
      },
    ]);
    const opening = {
      type: "checking" as const,
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "10000",
    };
    checkingId = (await createAccount(owner, { ...opening, name: "Checking" })).id;
    savingsId = (
      await createAccount(owner, {
        ...opening,
        name: "Savings",
        type: "savings",
        openingBalance: "0",
      })
    ).id;
    strangerAccountId = (
      await createAccount(stranger, { ...opening, name: "Their Checking" })
    ).id;
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("counts committed and staged rows separately, and adds them up", async () => {
    const groceries = await category("Groceries");
    await spend(groceries, "10.00");
    await spend(groceries, "20.00");
    await createStage(owner, {
      idempotencyKey: nextKey(),
      draft: {
        type: "withdrawal",
        date: "2026-05-03",
        payee: "Shop",
        amount: "5.00",
        fromAccountId: checkingId,
        categoryId: groceries,
      },
    });

    expect(await summaryFor("Groceries")).toMatchObject({
      transactionCount: 2,
      stagedTransactionCount: 1,
      totalCount: 3,
    });
  });

  /**
   * `count(*)` is a bigint, and the driver hands those back as strings, so with
   * nothing casting them the total is the two counts written next to each other
   * rather than added: two and one would read as twenty-one. Three separate
   * things prevent it - the cast in each subquery, the cast on each coalesce,
   * and the coercion on the way out - so no one of them can be removed to see
   * this fail. What is asserted here is the outcome, which is what a reader of
   * the page sees.
   */
  it("adds the counts rather than joining them together", async () => {
    const utilities = await category("Utilities");
    for (const amount of ["1.00", "2.00"]) await spend(utilities, amount);
    await createStage(owner, {
      idempotencyKey: nextKey(),
      draft: {
        type: "withdrawal",
        date: "2026-05-04",
        payee: "Power",
        amount: "3.00",
        fromAccountId: checkingId,
        categoryId: utilities,
      },
    });

    const summary = (await summaryFor("Utilities"))!;
    expect(typeof summary.transactionCount).toBe("number");
    expect(typeof summary.stagedTransactionCount).toBe("number");
    expect(summary.totalCount).toBe(3);
  });

  // Nothing filed here is exactly what somebody scanning this page is looking
  // for, so the row has to survive rather than drop out of the join.
  it("shows a category nothing uses, as zero", async () => {
    await category("Never Used");
    expect(await summaryFor("Never Used")).toMatchObject({
      transactionCount: 0,
      stagedTransactionCount: 0,
      totalCount: 0,
    });
  });

  it("stops counting a transaction once it is deleted", async () => {
    const hobbies = await category("Hobbies");
    const kept = await spend(hobbies, "40.00");
    const removed = await spend(hobbies, "50.00");
    expect(await summaryFor("Hobbies")).toMatchObject({ transactionCount: 2 });

    await setTransactionDeleted(owner, removed.id, removed.version, true);
    expect(await summaryFor("Hobbies")).toMatchObject({
      transactionCount: 1,
      totalCount: 1,
    });

    // Restoring brings it back, so the number tracks the list rather than a
    // running tally.
    const current = await setTransactionDeleted(
      owner,
      removed.id,
      removed.version + 1,
      false,
    );
    expect(current.deletedAt).toBeNull();
    expect(await summaryFor("Hobbies")).toMatchObject({ transactionCount: 2 });
    expect(kept.id).not.toBe(removed.id);
  });

  /**
   * A staged row keeps its draft after it is committed, and the transaction it
   * became is counted on the other side. Counting both would report every
   * imported row twice, which is the number somebody would notice first.
   */
  it("hands a row from the staged count to the committed one, not to both", async () => {
    const travel = await category("Travel");
    const stageTravel = (payee: string) =>
      createStage(owner, {
        idempotencyKey: nextKey(),
        draft: {
          type: "withdrawal",
          date: "2026-05-05",
          payee,
          amount: "300.00",
          fromAccountId: checkingId,
          categoryId: travel,
        },
      });

    const committing = (await stageTravel("Airline")) as {
      id: string;
      version: number;
    };
    expect(await summaryFor("Travel")).toMatchObject({
      transactionCount: 0,
      stagedTransactionCount: 1,
      totalCount: 1,
    });

    await commitStages(owner, {
      stagedIds: [committing.id],
      expectedVersions: { [committing.id]: committing.version },
      allowDuplicates: false,
      dryRun: false,
      idempotencyKey: nextKey(),
    });
    expect(await summaryFor("Travel")).toMatchObject({
      transactionCount: 1,
      stagedTransactionCount: 0,
      totalCount: 1,
    });

    // Discarding one takes it out of the count entirely; nothing was posted.
    const discarding = (await stageTravel("Hotel")) as {
      id: string;
      version: number;
    };
    expect(await summaryFor("Travel")).toMatchObject({ totalCount: 2 });
    await deleteStages(owner, {
      stagedIds: [discarding.id],
      expectedVersions: { [discarding.id]: discarding.version },
    });
    expect(await summaryFor("Travel")).toMatchObject({
      transactionCount: 1,
      stagedTransactionCount: 0,
      totalCount: 1,
    });
  });

  // A transfer can be filed under a category, and the category's own page lists
  // it. Leaving it out of the count would make the badge disagree with the list
  // it links to.
  it("counts a transfer that carries a category", async () => {
    const moves = await category("Moves", "both");
    await createTransaction(
      owner,
      {
        type: "transfer",
        date: "2026-05-06",
        payee: "To savings",
        description: null,
        sourceAmount: "100.00",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        categoryId: moves,
      },
      nextKey(),
    );
    expect(await summaryFor("Moves")).toMatchObject({
      transactionCount: 1,
      totalCount: 1,
    });
  });

  /**
   * A staged draft is unvalidated on purpose, so this slot can hold anything a
   * CSV put there. Reading it as a uuid would raise for the whole query and
   * take the categories page down for that person, with nothing they could do
   * about it from the UI.
   */
  it("survives a staged draft whose category is not an id at all", async () => {
    const survives = await category("Survives");
    await spend(survives, "2.00");
    await getDb()
      .insert(stagedTransactions)
      .values([
        {
          userId: owner.userId,
          draft: { type: "withdrawal", payee: "Bad row", categoryId: "not-a-uuid" },
          validationIssues: [],
        },
        {
          userId: owner.userId,
          draft: { type: "withdrawal", payee: "Numeric", categoryId: 7 },
          validationIssues: [],
        },
        {
          userId: owner.userId,
          draft: { type: "withdrawal", payee: "Null", categoryId: null },
          validationIssues: [],
        },
      ]);

    const summaries = await listCategorySummaries(owner);
    expect(summaries.find((entry) => entry.name === "Survives")).toMatchObject({
      transactionCount: 1,
      stagedTransactionCount: 0,
    });
    // None of the three attaches itself to some other category either.
    for (const summary of summaries) {
      expect(summary.totalCount).toBe(
        summary.transactionCount + summary.stagedTransactionCount,
      );
    }
  });

  it("reports an archived category's real usage, and only when asked for it", async () => {
    const oldName = await category("Retired");
    await spend(oldName, "60.00");
    const archived = await setCategoryArchived(owner, oldName, 1, true);
    expect(archived.archivedAt).not.toBeNull();

    expect(await summaryFor("Retired")).toBeUndefined();
    expect(await summaryFor("Retired", true)).toMatchObject({
      transactionCount: 1,
      totalCount: 1,
    });
    // Asking for archived rows must not change anybody else's numbers.
    expect(await summaryFor("Groceries", true)).toMatchObject({ totalCount: 3 });
  });

  it("counts only this tenant's rows", async () => {
    const shared = await category("Shared Name");
    await spend(shared, "11.00");

    const theirs = await createCategory(stranger, {
      name: "Shared Name",
      kind: "expense",
    });
    for (const amount of ["1.00", "2.00", "3.00"]) {
      await createTransaction(
        stranger,
        {
          type: "withdrawal",
          date: "2026-05-07",
          payee: "Theirs",
          description: null,
          amount,
          fromAccountId: strangerAccountId,
          categoryId: theirs.id,
        },
        nextKey(),
      );
    }
    await createStage(stranger, {
      idempotencyKey: nextKey(),
      draft: {
        type: "withdrawal",
        date: "2026-05-08",
        payee: "Theirs",
        amount: "4.00",
        fromAccountId: strangerAccountId,
        categoryId: theirs.id,
      },
    });

    expect(await summaryFor("Shared Name")).toMatchObject({
      transactionCount: 1,
      stagedTransactionCount: 0,
      totalCount: 1,
    });
    const theirSummaries = await listCategorySummaries(stranger);
    expect(theirSummaries).toHaveLength(1);
    expect(theirSummaries[0]).toMatchObject({
      name: "Shared Name",
      transactionCount: 3,
      stagedTransactionCount: 1,
      totalCount: 4,
    });
  });

  /**
   * The committed side cannot reach across tenants whatever it asks for: a
   * foreign key ties a transaction's category to the same owner. The staged
   * side has no such protection, because a draft names its category as free
   * JSON text that nothing validates, so another person's row can perfectly
   * well carry this person's category id. Only the scoping in the query stops
   * it counting.
   */
  it("does not count another tenant's staged row naming this tenant's category", async () => {
    const mine = await category("Mine Alone");
    await spend(mine, "13.00");
    const before = await summaryFor("Mine Alone");
    expect(before).toMatchObject({ transactionCount: 1, stagedTransactionCount: 0 });

    await createStage(stranger, {
      idempotencyKey: nextKey(),
      draft: {
        type: "withdrawal",
        date: "2026-05-09",
        payee: "Reaching over",
        amount: "99.00",
        fromAccountId: strangerAccountId,
        // The id of a category belonging to somebody else entirely.
        categoryId: mine,
      },
    });

    expect(await summaryFor("Mine Alone")).toMatchObject({
      transactionCount: 1,
      stagedTransactionCount: 0,
      totalCount: 1,
    });
  });

  /**
   * The count and the list have to agree. Everything that counts a category
   * counts legs, so a staged split shows in the badge; the queue's own filter
   * read only the entry's top-level category, so following that badge produced
   * an empty list.
   */
  it("finds a staged split under the category one of its legs names", async () => {
    const household = await createCategory(owner, {
      name: "Split Filter Household",
      kind: "expense",
    });
    const groceries = await createCategory(owner, {
      name: "Split Filter Groceries",
      kind: "expense",
    });
    await createStage(owner, {
      draft: {
        type: "withdrawal",
        date: "2026-05-04",
        payee: "Supermarket",
        fromAccountId: checkingId,
        amount: "100.00",
        legs: [
          { categoryId: groceries.id, amount: "60.00" },
          { categoryId: household.id, amount: "40.00" },
        ],
      },
      idempotencyKey: nextKey(),
    });

    for (const category of [groceries, household]) {
      expect(
        (await summaryFor(category.name))?.stagedTransactionCount,
        category.name,
      ).toBe(1);
      const listed = await listStages(owner, {
        limit: 50,
        categoryId: category.id,
      });
      expect(listed.items, category.name).toHaveLength(1);
    }
  });

  it("still reports the columns the page already relied on", async () => {
    const summary = (await summaryFor("Groceries"))!;
    expect(summary).toMatchObject({
      name: "Groceries",
      kind: "expense",
      userId: owner.userId,
      version: 1,
    });
    expect(summary.archivedAt).toBeNull();
    expect(summary.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
