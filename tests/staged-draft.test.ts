import { describe, expect, it } from "vitest";
import {
  draftForTransactionForm,
  stagedString,
  summarizeStagedDraft,
  recurrenceShapeFromDraft,
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
      legs: [
        leg("11111111-1111-4111-8111-111111111111", "60"),
        leg("22222222-2222-4222-8222-222222222222", "40"),
      ],
    });
    expect(template.legs).toHaveLength(2);
    expect(template.description).toBe("Weekly shop");
    expect(template.notes).toBe("Split three ways");
    expect(template.categoryId).toBeUndefined();
  });

  /**
   * A transfer files nothing under a category, so legs left behind by switching
   * type must not travel with it. The shape converter twenty lines below has
   * always guarded this; the template converter did not, and the server would
   * have refused the template with a message about a field the form hides.
   */
  it("never carries a split on to a transfer template", () => {
    const template = templateDraftFromDraft({
      type: "transfer",
      payee: "Monthly sweep",
      fromAccountId: "11111111-1111-4111-8111-111111111111",
      toAccountId: "22222222-2222-4222-8222-222222222222",
      amount: "250",
      categoryId: "33333333-3333-4333-8333-333333333333",
      legs: [
        leg("33333333-3333-4333-8333-333333333333", "150"),
        leg("44444444-4444-4444-8444-444444444444", "100"),
      ],
    });
    expect(template.legs).toBeUndefined();
    expect(template).toMatchObject({
      type: "transfer",
      fromAccountId: "11111111-1111-4111-8111-111111111111",
      toAccountId: "22222222-2222-4222-8222-222222222222",
    });
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

/**
 * A recurrence's shape is parsed `.strict()`, so a key it does not declare is
 * refused rather than ignored and the whole save fails with nothing but
 * "Request validation failed" to go on. What this drops it has to drop here.
 */
describe("saving a row as a recurring transaction", () => {
  const account = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const groceries = "33333333-3333-4333-8333-333333333333";
  const rent = "44444444-4444-4444-8444-444444444444";

  it("drops the date, the bank's reference, and the template it came from", () => {
    const shape = recurrenceShapeFromDraft({
      type: "withdrawal",
      date: "2026-04-01",
      payee: "Landlord",
      fromAccountId: account,
      amount: "1200",
      externalId: "FITID202604010001",
      templateId: "55555555-5555-4555-8555-555555555555",
    });
    expect(shape).not.toHaveProperty("date");
    expect(shape).not.toHaveProperty("externalId");
    expect(shape).not.toHaveProperty("templateId");
    expect(JSON.stringify(shape)).not.toContain("FITID202604010001");
    expect(shape).toMatchObject({
      type: "withdrawal",
      payee: "Landlord",
      fromAccountId: account,
      amount: "1200",
    });
  });

  it("keeps a category named rather than cited, unlike a template", () => {
    const draft = {
      type: "withdrawal" as const,
      payee: "Corner shop",
      fromAccountId: account,
      amount: "12",
      categoryId: "",
      categoryName: "Groceries",
    };
    expect(recurrenceShapeFromDraft(draft).categoryName).toBe("Groceries");
    expect(templateDraftFromDraft(draft)).not.toHaveProperty("categoryName");
  });

  it("prefers the id when the row has both", () => {
    const shape = recurrenceShapeFromDraft({
      type: "withdrawal",
      payee: "Corner shop",
      fromAccountId: account,
      categoryId: groceries,
      categoryName: "Groceries",
    });
    expect(shape.categoryId).toBe(groceries);
    expect(shape).not.toHaveProperty("categoryName");
  });

  it("carries a split without its leg ids", () => {
    const shape = recurrenceShapeFromDraft({
      type: "withdrawal",
      payee: "Costco",
      fromAccountId: account,
      amount: "100",
      legs: [
        { id: "leg-one", categoryId: groceries, categoryName: "", amount: "60", note: "" },
        { id: "leg-two", categoryId: rent, categoryName: "", amount: "40", note: "Rent share" },
      ],
    });
    expect(shape.legs).toEqual([
      { categoryId: groceries, amount: "60" },
      { categoryId: rent, amount: "40", note: "Rent share" },
    ]);
    expect(JSON.stringify(shape)).not.toContain("leg-one");
  });

  it("sends a transfer both accounts and never a split", () => {
    const shape = recurrenceShapeFromDraft({
      type: "transfer",
      payee: "Monthly sweep",
      fromAccountId: account,
      toAccountId: other,
      amount: "250",
      categoryId: groceries,
      destinationAmount: "230",
      legs: [
        { id: "", categoryId: groceries, categoryName: "", amount: "150", note: "" },
        { id: "", categoryId: rent, categoryName: "", amount: "100", note: "" },
      ],
    });
    expect(shape).toMatchObject({
      type: "transfer",
      fromAccountId: account,
      toAccountId: other,
      amount: "250",
      categoryId: groceries,
    });
    expect(shape).not.toHaveProperty("legs");
    expect(shape).not.toHaveProperty("destinationAmount");
  });

  it("sends a deposit only the account it lands in", () => {
    const shape = recurrenceShapeFromDraft({
      type: "deposit",
      payee: "Payday",
      fromAccountId: other,
      toAccountId: account,
      amount: "3000",
    });
    expect(shape.toAccountId).toBe(account);
    expect(shape).not.toHaveProperty("fromAccountId");
  });
});
