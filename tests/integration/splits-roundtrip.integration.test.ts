import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  exportTransactionsCsv,
  stageCsv,
} from "../../src/server/services/import-export.js";
import { commitStages, listStages } from "../../src/server/services/staging.js";
import {
  createTransaction,
  listTransactions,
} from "../../src/server/services/transactions.js";
import {
  bulkEditTransactionTemplates,
  createTransactionTemplate,
  listTransactionTemplates,
} from "../../src/server/services/transaction-templates.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("splits_roundtrip");
const actor: Actor = { userId: "integration-splits-roundtrip", source: "web" };

integration("carrying a split in and out of the app", () => {
  let checkingId: string;
  let secondAccountId: string;
  let foodId: string;
  let householdId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Round Trip Tenant",
      email: "roundtrip@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Roundtrip Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      })
    ).id;
    secondAccountId = (
      await createAccount(actor, {
        name: "Roundtrip Second",
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

    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Costco",
        fromAccountId: checkingId,
        amount: "100.00",
        legs: [
          { categoryId: foodId, amount: "60.00", note: "Groceries" },
          { categoryId: householdId, amount: "40.00" },
        ],
      } as never,
      "roundtrip-split",
    );
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
      "roundtrip-flat",
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  const exported = () => exportTransactionsCsv(actor, {});

  /**
   * The header row is taken from the first row's keys, and the first
   * transaction here is not a split, so a column only written for splits would
   * be missing from the file every row after it depends on.
   */
  it("carries the split column whether or not the first row is one", async () => {
    const { csv } = await exported();
    const [header, ...lines] = csv.split("\r\n");
    expect(header.split(",")).toContain("legs_json");
    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.includes("Groceries"))).toHaveLength(1);
  });

  it("reads a split back into a different account without losing a leg", async () => {
    const { csv } = await exported();
    const preview = await stageCsv(actor, {
      csv,
      fileName: "roundtrip.csv",
      idempotencyKey: "roundtrip-restage",
      defaultAccountId: secondAccountId,
      dryRun: false,
    });
    expect(preview.rowCount).toBe(2);
    expect(preview.validCount).toBe(2);

    const staged = await listStages(actor, { limit: 50 });
    const split = staged.items.find(
      (item) => (item.draft as { payee?: string }).payee === "Costco",
    )!;
    const draft = split.draft as {
      legs?: { categoryId?: string; amount: string; note?: string | null }[];
      categoryId?: string | null;
    };
    expect(draft.legs).toHaveLength(2);
    expect(draft.legs!.map((leg) => leg.amount)).toEqual(["60", "40"]);
    expect(draft.legs![0]!.note).toBe("Groceries");
    // Resolved by name against the categories this ledger already has, the same
    // rule the rest of the import follows, rather than by an id from elsewhere.
    expect(draft.legs!.map((leg) => leg.categoryId)).toEqual([foodId, householdId]);
    expect(split.validationIssues).toEqual([]);

    await commitStages(actor, {
      stagedIds: staged.items.map((item) => item.id),
      expectedVersions: Object.fromEntries(
        staged.items.map((item) => [item.id, item.version]),
      ),
      idempotencyKey: "roundtrip-commit",
      allowDuplicates: true,
      dryRun: false,
    });

    const page = await listTransactions(actor, {
      limit: 50,
      accountId: secondAccountId,
    });
    const committed = page.items.find((item) => item.payee === "Costco")!;
    expect(committed.category).toBeNull();
    expect(committed.legs.map((leg) => leg.amount)).toEqual(["60", "40"]);
    expect(committed.legs.map((leg) => leg.category?.name)).toEqual([
      "Food",
      "Household",
    ]);
  });

  it("stores a split on a template, with the amounts left open", async () => {
    const created = await createTransactionTemplate(actor, {
      name: "Costco run",
      draft: {
        type: "withdrawal",
        payee: "Costco",
        legs: [{ categoryName: "Food" }, { categoryId: householdId }],
      },
    });
    expect(created.draft.legs).toHaveLength(2);
    expect(created.draft.categoryId).toBeUndefined();

    const listed = await listTransactionTemplates(actor);
    expect(listed.find((one) => one.id === created.id)!.draft.legs).toHaveLength(2);
  });

  /**
   * The gate this ordering exists for: a mass edit re-parses every stored draft
   * through the strict template schema, so a template holding legs would make
   * every mass edit of every template throw if the schema did not know them.
   */
  it("mass edits a split template without touching its split", async () => {
    const before = (await listTransactionTemplates(actor)).find(
      (one) => one.name === "Costco run",
    )!;

    await bulkEditTransactionTemplates(actor, {
      selection: {
        items: [{ id: before.id, expectedVersion: before.version }],
      },
      patch: { payee: "Costco Wholesale" },
      idempotencyKey: "template-split-payee",
      dryRun: false,
    });

    const after = (await listTransactionTemplates(actor)).find(
      (one) => one.id === before.id,
    )!;
    expect(after.draft.payee).toBe("Costco Wholesale");
    expect(after.draft.legs).toHaveLength(2);
  });

  it("refuses a mass edit that would file a split template under one category", async () => {
    const template = (await listTransactionTemplates(actor)).find(
      (one) => one.draft.legs?.length,
    )!;

    await expect(
      bulkEditTransactionTemplates(actor, {
        selection: {
          items: [{ id: template.id, expectedVersion: template.version }],
        },
        patch: { categoryId: foodId },
        idempotencyKey: "template-split-flatten",
        dryRun: true,
      }),
    ).rejects.toThrow(/single category cannot be set here/);
  });

  it("replaces a template's whole split, and clears it on request", async () => {
    let template = (await listTransactionTemplates(actor)).find(
      (one) => one.draft.legs?.length,
    )!;

    await bulkEditTransactionTemplates(actor, {
      selection: {
        items: [{ id: template.id, expectedVersion: template.version }],
      },
      patch: { legs: [{ categoryId: foodId }, { categoryId: householdId }] },
      idempotencyKey: "template-split-replace",
      dryRun: false,
    });
    template = (await listTransactionTemplates(actor)).find(
      (one) => one.id === template.id,
    )!;
    expect(template.draft.legs!.map((leg) => leg.categoryId)).toEqual([
      foodId,
      householdId,
    ]);

    await bulkEditTransactionTemplates(actor, {
      selection: {
        items: [{ id: template.id, expectedVersion: template.version }],
      },
      patch: { legs: null },
      idempotencyKey: "template-split-clear",
      dryRun: false,
    });
    template = (await listTransactionTemplates(actor)).find(
      (one) => one.id === template.id,
    )!;
    expect(template.draft.legs).toBeUndefined();
  });
});
