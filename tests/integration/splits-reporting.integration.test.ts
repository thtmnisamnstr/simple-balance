import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createCategory,
  deleteCategory,
  listCategorySummaries,
  mergeCategories,
  updateCategory,
} from "../../src/server/services/categories.js";
import { getSummary } from "../../src/server/services/summary.js";
import {
  bulkEditTransactions,
  createTransaction,
  getBulkTransactionSelection,
  listTransactions,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("splits_reporting");
const actor: Actor = { userId: "integration-splits-reporting", source: "web" };
const range = { start: "2026-01-01", end: "2026-12-31" };

integration("what a split looks like in the reports", () => {
  let checkingId: string;
  let foodId: string;
  let householdId: string;
  let petsId: string;
  let splitId: string;
  let flatId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Split Reporting Tenant",
      email: "split-reporting@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Reporting Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    householdId = (
      await createCategory(actor, { name: "Household", kind: "expense" })
    ).id;
    petsId = (await createCategory(actor, { name: "Pets", kind: "expense" })).id;

    splitId = (
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-01",
          payee: "Costco",
          fromAccountId: checkingId,
          amount: "100.00",
          legs: [
            { categoryId: foodId, amount: "60.00" },
            { categoryId: householdId, amount: "40.00" },
          ],
        } as never,
        "reporting-split",
      )
    ).id;
    flatId = (
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-02",
          payee: "Corner shop",
          fromAccountId: checkingId,
          amount: "25.00",
          categoryId: foodId,
        } as never,
        "reporting-flat",
      )
    ).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  const spending = async () => {
    const summary = await getSummary(actor, range);
    const usd = summary.currencies.find((one) => one.currency === "USD")!;
    return {
      total: usd.withdrawals,
      byCategory: Object.fromEntries(
        usd.spendingByCategory.map((row) => [row.category, row.amount]),
      ),
    };
  };

  /**
   * The whole design in one assertion. A leg is not a second record of the
   * money, so nothing is counted twice: the categories add up to exactly the
   * cash that left the account, not to a multiple of it.
   */
  it("attributes each leg to its own category without double counting", async () => {
    const { total, byCategory } = await spending();
    expect(byCategory).toEqual({ Food: "85", Household: "40" });
    expect(total).toBe("125");
  });

  it("moves past spending when a leg is recategorised, and still adds up", async () => {
    const before = await spending();
    const current = (await listTransactions(actor, { limit: 50 })).items.find(
      (item) => item.id === splitId,
    )!;

    await updateTransaction(actor, splitId, {
      expectedVersion: current.version,
      draft: {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Costco",
        fromAccountId: checkingId,
        amount: "100.00",
        legs: [
          { id: current.legs[0]!.id, categoryId: petsId, amount: "60.00" },
          { id: current.legs[1]!.id, categoryId: householdId, amount: "40.00" },
        ],
      },
    } as never);

    const after = await spending();
    expect(after.byCategory).toEqual({ Pets: "60", Food: "25", Household: "40" });
    expect(after.total).toBe(before.total);
  });

  it("lists a split under every category it names, once each", async () => {
    for (const [categoryId, expected] of [
      [petsId, [splitId]],
      [householdId, [splitId]],
      [foodId, [flatId]],
    ] as const) {
      const page = await listTransactions(actor, { limit: 50, categoryId });
      expect(page.items.map((item) => item.id), categoryId).toEqual(expected);
      expect(page.totalCount).toBe(expected.length);
    }
  });

  it("sorts a split under the first of its categories alphabetically", async () => {
    const page = await listTransactions(actor, {
      limit: 50,
      sort: "category",
      direction: "asc",
    });
    // Food for the flat row, Household for the split: Household beats Pets.
    expect(page.items.map((item) => item.id)).toEqual([flatId, splitId]);
  });

  it("hands a reader the legs it needs to edit them, and leaves the zeroed ones out", async () => {
    const page = await listTransactions(actor, { limit: 50 });
    const split = page.items.find((item) => item.id === splitId)!;
    expect(split.category).toBeNull();
    expect(split.legs).toHaveLength(2);
    expect(split.legs.map((leg) => leg.category?.name)).toEqual([
      "Pets",
      "Household",
    ]);
    expect(split.legs.map((leg) => leg.amount)).toEqual(["60", "40"]);
    expect(split.legs.every((leg) => typeof leg.id === "string")).toBe(true);
    expect(page.items.find((item) => item.id === flatId)!.legs).toEqual([]);
  });

  it("counts a split once against each category it names", async () => {
    const summaries = await listCategorySummaries(actor);
    const counts = Object.fromEntries(
      summaries.map((one) => [one.name, one.transactionCount]),
    );
    expect(counts).toMatchObject({ Pets: 1, Household: 1, Food: 1 });
  });

  it("tells a mass edit how many of the rows it selected are splits", async () => {
    const snapshot = await getBulkTransactionSelection(actor, {
      filter: {},
      excludedIds: [],
    });
    expect(snapshot.count).toBe(2);
    expect(snapshot.splitCount).toBe(1);
  });

  const everything = async () => {
    const snapshot = await getBulkTransactionSelection(actor, {
      filter: {},
      excludedIds: [],
    });
    return {
      mode: "filter" as const,
      filter: {},
      excludedIds: [],
      expectedCount: snapshot.count,
      expectedFingerprint: snapshot.fingerprint,
    };
  };

  it("refuses a mass category or type change that would flatten a split", async () => {
    for (const patch of [{ categoryId: foodId }, { type: "deposit" as const }]) {
      await expect(
        bulkEditTransactions(actor, {
          selection: await everything(),
          patch,
          idempotencyKey: `flatten-${JSON.stringify(patch)}`,
          dryRun: true,
        }),
        JSON.stringify(patch),
      ).rejects.toThrow(/cannot include split transactions/);
    }
  });

  /**
   * A leg's category is a real reference with a foreign key behind it, so a
   * merge that rewrote only the transaction's own column would leave a leg
   * pointing at a category it was about to delete and fail outright.
   */
  it("carries a leg over when its category is merged into another", async () => {
    const spare = await createCategory(actor, { name: "Pet food", kind: "expense" });
    const current = (await listTransactions(actor, { limit: 50 })).items.find(
      (item) => item.id === splitId,
    )!;
    await updateTransaction(actor, splitId, {
      expectedVersion: current.version,
      draft: {
        type: "withdrawal",
        date: current.date,
        payee: "Costco",
        fromAccountId: checkingId,
        amount: "100.00",
        legs: [
          { id: current.legs[0]!.id, categoryId: spare.id, amount: "60.00" },
          { id: current.legs[1]!.id, categoryId: householdId, amount: "40.00" },
        ],
      },
    } as never);

    const before = (await listTransactions(actor, { limit: 50 })).items.find(
      (item) => item.id === splitId,
    )!;
    const pets = (await listCategorySummaries(actor)).find(
      (one) => one.name === "Pets",
    )!;
    const merged = await mergeCategories(actor, {
      targetCategoryId: pets.id,
      targetExpectedVersion: pets.version,
      sourceCategoryIds: [spare.id],
      expectedVersions: { [spare.id]: spare.version },
    });
    expect(merged.updatedTransactionCount).toBe(1);

    const after = (await listTransactions(actor, { limit: 50 })).items.find(
      (item) => item.id === splitId,
    )!;
    expect(after.legs.map((leg) => leg.category?.name)).toEqual([
      "Pets",
      "Household",
    ]);
    // A relabelled leg has to move the row's version, or a mass edit's
    // description of the set it is about to change agrees about a row that
    // changed underneath it.
    expect(after.version).toBeGreaterThan(before.version);
    expect((await spending()).byCategory).toEqual({
      Pets: "60",
      Food: "25",
      Household: "40",
    });
  });

  /**
   * A category a split names is as much in use as one a transaction column
   * names, and the foreign key behind a leg says so. Without the guard seeing
   * legs, this would pass and then fail on the key, with a database error where
   * the sentence offering to archive should be.
   */
  it("refuses to delete a category only a split leg uses, and offers archiving", async () => {
    const pets = (await listCategorySummaries(actor)).find(
      (one) => one.name === "Pets",
    )!;
    await expect(
      deleteCategory(actor, pets.id, pets.version),
    ).rejects.toThrow(/Archive it instead/);
  });

  /** Every leg answers to the direction of the entry it belongs to. */
  it("refuses to narrow a category a split withdrawal leg uses to income", async () => {
    const pets = (await listCategorySummaries(actor)).find(
      (one) => one.name === "Pets",
    )!;
    await expect(
      updateCategory(actor, pets.id, {
        kind: "income",
        expectedVersion: pets.version,
      }),
    ).rejects.toThrow();
  });

  it("lets a mass date change through, and reposts the split as a split", async () => {
    await bulkEditTransactions(actor, {
      selection: await everything(),
      patch: { date: "2026-04-15" },
      idempotencyKey: "split-mass-date",
      dryRun: false,
    });

    const page = await listTransactions(actor, { limit: 50 });
    const split = page.items.find((item) => item.id === splitId)!;
    expect(split.date).toBe("2026-04-15");
    expect(split.legs.map((leg) => leg.amount)).toEqual(["60", "40"]);
    expect((await spending()).byCategory).toEqual({
      Pets: "60",
      Food: "25",
      Household: "40",
    });
  });
});
