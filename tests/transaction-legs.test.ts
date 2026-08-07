import { describe, expect, it } from "vitest";
import {
  MAX_TRANSACTION_LEGS,
  stagedDraftSchema,
  transactionDraftSchema,
  transactionTemplateBulkPatchSchema,
  transactionTemplateDraftSchema,
} from "../src/shared/domain.js";

const fromAccountId = "11111111-1111-4111-8111-111111111111";
const toAccountId = "44444444-4444-4444-8444-444444444444";
const categoryId = "22222222-2222-4222-8222-222222222222";
const otherCategoryId = "33333333-3333-4333-8333-333333333333";
const legId = "55555555-5555-4555-8555-555555555555";

const withdrawal = {
  type: "withdrawal" as const,
  date: "2026-08-07",
  payee: "Costco",
  fromAccountId,
  amount: "100.00",
};

const legs = [
  { categoryId, amount: "60.00" },
  { categoryName: "Household", amount: "40.00" },
];

const failure = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("legs on a transaction draft", () => {
  /**
   * The draft schemas are plain objects, so Zod strips what they do not
   * declare. A staged split whose legs were stripped here would validate,
   * preview and commit cleanly, and arrive in the ledger flat — the one failure
   * in this feature that reports nothing on any surface.
   */
  it("carries legs through the discriminated union rather than stripping them", () => {
    const parsed = transactionDraftSchema.parse({ ...withdrawal, legs });
    expect(parsed).toHaveProperty("legs");
    expect(parsed.legs).toEqual(legs);
  });

  it("carries legs through a staged draft", () => {
    expect(stagedDraftSchema.parse({ ...withdrawal, legs }).legs).toEqual(legs);
  });

  it("keeps the order the legs were given in", () => {
    const reversed = [...legs].reverse();
    expect(transactionDraftSchema.parse({ ...withdrawal, legs: reversed }).legs).toEqual(
      reversed,
    );
  });

  it("refuses a split of one", () => {
    expect(
      failure(transactionDraftSchema.safeParse({ ...withdrawal, legs: [legs[0]] })),
    ).toContain("A split needs at least two legs");
  });

  it("refuses more legs than a split may have", () => {
    const many = Array.from({ length: MAX_TRANSACTION_LEGS + 1 }, () => ({
      categoryId,
      amount: "1.00",
    }));
    expect(
      transactionDraftSchema.safeParse({ ...withdrawal, legs: many }).success,
    ).toBe(false);
  });

  it("refuses a negative or zero leg, since direction comes from the entry", () => {
    for (const amount of ["-40.00", "0"]) {
      expect(
        transactionDraftSchema.safeParse({
          ...withdrawal,
          legs: [{ categoryId, amount: "60.00" }, { categoryId: otherCategoryId, amount }],
        }).success,
        amount,
      ).toBe(false);
    }
  });

  it("refuses a key the leg does not have", () => {
    expect(
      transactionDraftSchema.safeParse({
        ...withdrawal,
        legs: [{ categoryId, amount: "60.00", categoryid: "typo" }, legs[1]],
      }).success,
    ).toBe(false);
  });

  it("allows a leg with no category, which is a share left unfiled", () => {
    expect(
      transactionDraftSchema.safeParse({
        ...withdrawal,
        legs: [{ amount: "60.00" }, { categoryId, amount: "40.00" }],
      }).success,
    ).toBe(true);
  });
});

describe("legs against a single category", () => {
  it("refuses a request that sends both rather than merging them", () => {
    for (const conflict of [{ categoryId }, { categoryName: "Groceries" }]) {
      expect(
        failure(
          transactionDraftSchema.safeParse({ ...withdrawal, ...conflict, legs }),
        ),
        JSON.stringify(conflict),
      ).toContain("Send either a category or legs, not both");
    }
  });

  /** `null` says what the legs already say, so it is not a disagreement. */
  it("allows legs alongside a category being cleared", () => {
    expect(
      transactionDraftSchema.safeParse({
        ...withdrawal,
        categoryId: null,
        categoryName: null,
        legs,
      }).success,
    ).toBe(true);
  });

  it("refuses a split on a transfer, which has no counter-account side", () => {
    expect(
      failure(
        transactionDraftSchema.safeParse({
          type: "transfer",
          date: "2026-08-07",
          payee: "Moving money",
          fromAccountId,
          toAccountId,
          sourceAmount: "100.00",
          legs,
        }),
      ),
    ).toContain("A transfer cannot be split by category");
  });
});

describe("leg identity", () => {
  it("accepts a mix of named and new legs", () => {
    const parsed = transactionDraftSchema.parse({
      ...withdrawal,
      legs: [{ id: legId, categoryId, amount: "60.00" }, legs[1]],
    });
    expect(parsed.legs?.map((leg) => leg.id)).toEqual([legId, undefined]);
  });

  it("refuses the same leg named twice, which asks for two answers at once", () => {
    expect(
      failure(
        transactionDraftSchema.safeParse({
          ...withdrawal,
          legs: [
            { id: legId, categoryId, amount: "60.00" },
            { id: legId, categoryId: otherCategoryId, amount: "40.00" },
          ],
        }),
      ),
    ).toContain("Leg IDs must be unique");
  });

  /** Two shares of one shop under one category is an ordinary receipt. */
  it("allows two legs on the same category", () => {
    expect(
      transactionDraftSchema.safeParse({
        ...withdrawal,
        legs: [
          { categoryId, amount: "60.00", note: "Food" },
          { categoryId, amount: "40.00", note: "Cleaning" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("legs on a template", () => {
  it("stores legs whose amounts the template does not fix", () => {
    const parsed = transactionTemplateDraftSchema.parse({
      legs: [{ categoryName: "Groceries" }, { categoryId, amount: "40.00" }],
    });
    expect(parsed.legs).toEqual([
      { categoryName: "Groceries" },
      { categoryId, amount: "40.00" },
    ]);
  });

  /**
   * A template records the difference between a field it never had and one
   * saved as nothing, and an empty list is the first of those two.
   */
  it("reads an empty list as legs the template never had", () => {
    const parsed = transactionTemplateDraftSchema.parse({ payee: "Costco", legs: [] });
    expect(JSON.parse(JSON.stringify(parsed))).toEqual({ payee: "Costco" });
  });

  it("refuses a template that splits a transfer", () => {
    expect(
      failure(
        transactionTemplateDraftSchema.safeParse({
          type: "transfer",
          legs: [{ categoryName: "A" }, { categoryName: "B" }],
        }),
      ),
    ).toContain("A transfer cannot be split by category");
  });

  it("refuses a template holding both a category and legs", () => {
    expect(
      transactionTemplateDraftSchema.safeParse({
        categoryId,
        legs: [{ categoryName: "A" }, { categoryName: "B" }],
      }).success,
    ).toBe(false);
  });

  it("replaces or clears the whole list in a mass edit, never part of it", () => {
    const replaced = transactionTemplateBulkPatchSchema.parse({
      legs: [{ categoryName: "A" }, { categoryName: "B" }],
    });
    expect(replaced.legs).toHaveLength(2);
    expect(transactionTemplateBulkPatchSchema.parse({ legs: null }).legs).toBeNull();
    expect(
      transactionTemplateBulkPatchSchema.safeParse({ legs: [{ categoryName: "A" }] })
        .success,
    ).toBe(false);
  });
});
