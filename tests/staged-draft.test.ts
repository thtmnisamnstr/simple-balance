import { describe, expect, it } from "vitest";
import {
  draftForTransactionForm,
  stagedString,
  summarizeStagedDraft,
  templateDraftFromDraft,
} from "../src/client/staged-draft.js";

describe("malformed staged draft presentation", () => {
  it("normalizes objects and arrays to editable string fields", () => {
    expect(
      draftForTransactionForm({
        type: { unexpected: true },
        date: ["2026-07-30"],
        description: { text: "Not a React child" },
        payee: ["Shop"],
        categoryId: { id: "category" },
        categoryName: { name: "Groceries" },
        notes: { nested: ["value"] },
        fromAccountId: ["account"],
        amount: { decimal: "12.34" },
        externalId: { reference: "STMT-1" },
      }),
    ).toEqual({
      type: "withdrawal",
      legs: [],
      date: "",
      description: "",
      payee: "",
      categoryId: "",
      categoryName: "",
      notes: "",
      fromAccountId: "",
      toAccountId: "",
      amount: "",
      externalId: "",
      templateId: "",
      destinationAmount: "",
    });
  });

  it("summarizes malformed known fields without returning objects to React", () => {
    const summary = summarizeStagedDraft(
      {
        type: "withdrawal",
        fromAccountId: { nested: "account-id" },
        amount: ["12.34"],
      },
      [{ id: "account-id", name: "Checking", currency: "USD" }],
    );
    expect(summary).toEqual({
      account: "Unknown account",
      amount: "",
      currency: "",
    });
    expect(stagedString({ unsafe: "React child" })).toBe("");
  });
});

describe("saving a split as a template", () => {
  const leg = (categoryId: string, amount: string) => ({
    id: "",
    categoryId,
    categoryName: "",
    amount,
    note: "",
  });

  /**
   * The split branch used to return early, so a template made from a split
   * arrived with no description and no notes and nothing said so.
   */
  it("keeps everything a single-category template keeps", () => {
    const template = templateDraftFromDraft({
      type: "withdrawal",
      payee: "Costco",
      description: "Weekly shop",
      notes: "Split three ways",
      categoryId: "",
      legs: [leg("11111111-1111-4111-8111-111111111111", "60"), leg("22222222-2222-4222-8222-222222222222", "40")],
    });
    expect(template.legs).toHaveLength(2);
    expect(template.description).toBe("Weekly shop");
    expect(template.notes).toBe("Split three ways");
    expect(template.categoryId).toBeUndefined();
  });

  it("keeps the single category when there is no split", () => {
    const template = templateDraftFromDraft({
      type: "withdrawal",
      payee: "Corner shop",
      description: "Milk",
      categoryId: "11111111-1111-4111-8111-111111111111",
      legs: [],
    });
    expect(template.legs).toBeUndefined();
    expect(template.categoryId).toBe("11111111-1111-4111-8111-111111111111");
    expect(template.description).toBe("Milk");
  });
});
