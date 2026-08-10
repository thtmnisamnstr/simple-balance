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
} from "../../src/server/services/categories.js";
import { createStage, listStages } from "../../src/server/services/staging.js";
import {
  createTransaction,
  listTransactions,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("splits_audit");
const actor: Actor = { userId: "integration-splits-audit", source: "web" };

integration("defects the audit claimed", () => {
  let usdId: string;
  let eurId: string;
  let foodId: string;
  let householdId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Audit Tenant",
      email: "audit@example.com",
      emailVerified: true,
    });
    usdId = (
      await createAccount(actor, {
        name: "USD Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      })
    ).id;
    eurId = (
      await createAccount(actor, {
        name: "EUR Checking",
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    householdId = (
      await createCategory(actor, { name: "Household", kind: "expense" })
    ).id;
    await createCategory(actor, { name: "Pets", kind: "expense" });
  });

  afterAll(async () => {
    await database.drop();
  });

  const split = (key: string, accountId = usdId) =>
    createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-03-01",
        payee: `Costco ${key}`,
        fromAccountId: accountId,
        amount: "100.00",
        legs: [
          { categoryId: foodId, amount: "60.00" },
          { categoryId: householdId, amount: "40.00" },
        ],
      } as never,
      key,
    );

  it("moves a split onto an account in another currency", async () => {
    const created = await split("audit-currency");
    await updateTransaction(actor, created.id, {
      expectedVersion: created.version,
      draft: {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Costco audit-currency",
        fromAccountId: eurId,
        amount: "100.00",
        legs: created.legs.map((leg) => ({
          id: leg.id,
          categoryId: leg.categoryId,
          amount: leg.amount,
        })),
      },
    } as never);

    const after = (await listTransactions(actor, { limit: 50 })).items.find(
      (item) => item.id === created.id,
    )!;
    expect(after.sourceCurrency).toBe("EUR");
    expect(after.legs.map((leg) => leg.amount)).toEqual(["60", "40"]);
  });

  it("merges a category without corrupting a staged split", async () => {
    await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-03-05",
        payee: "Staged split",
        fromAccountId: usdId,
        amount: "100.00",
        categoryId: null,
        categoryName: null,
        legs: [
          { categoryId: householdId, amount: "60.00" },
          { categoryId: foodId, amount: "40.00" },
        ],
      },
      idempotencyKey: "audit-staged-split",
    });

    const household = (await listCategorySummaries(actor)).find(
      (one) => one.name === "Household",
    )!;
    const pets = (await listCategorySummaries(actor)).find(
      (one) => one.name === "Pets",
    )!;
    await mergeCategories(actor, {
      targetCategoryId: pets.id,
      targetExpectedVersion: pets.version,
      sourceCategoryIds: [household.id],
      expectedVersions: { [household.id]: household.version },
    });

    const staged = (await listStages(actor, { limit: 50 })).items.find(
      (item) => (item.draft as { payee?: string }).payee === "Staged split",
    )!;
    const draft = staged.draft as {
      categoryId?: unknown;
      legs?: { categoryId?: string }[];
    };
    expect(draft.legs?.map((leg) => leg.categoryId)).toEqual([pets.id, foodId]);
    expect(draft.categoryId ?? null).toBeNull();
    expect(staged.validationIssues).toEqual([]);
  });

  it("survives a staged draft whose legs are not a list", async () => {
    await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-03-06",
        payee: "Malformed",
        fromAccountId: usdId,
        amount: "5.00",
        legs: null,
      },
      idempotencyKey: "audit-malformed-legs",
    });

    const unused = await createCategory(actor, {
      name: "Unused",
      kind: "expense",
    });
    await expect(listCategorySummaries(actor)).resolves.toBeDefined();
    await expect(
      deleteCategory(actor, unused.id, unused.version),
    ).resolves.toBeDefined();
  });

  it("counts a staged split's legs against its categories", async () => {
    const summaries = await listCategorySummaries(actor);
    const pets = summaries.find((one) => one.name === "Pets")!;
    const stagedRows = (await listStages(actor, { limit: 50 })).items.filter(
      (item) => {
        const legs = (item.draft as { legs?: unknown }).legs;
        return (
          Array.isArray(legs) &&
          legs.some((leg) => (leg as { categoryId?: string }).categoryId === pets.id)
        );
      },
    );
    expect(stagedRows.length).toBeGreaterThan(0);
    expect(pets.stagedTransactionCount).toBeGreaterThan(0);
  });
});
