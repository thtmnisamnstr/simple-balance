import { describe, expect, it } from "vitest";
import {
  draftForTransactionForm,
  stagedString,
  summarizeStagedDraft,
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
        notes: { nested: ["value"] },
        fromAccountId: ["account"],
        amount: { decimal: "12.34" },
        externalId: { reference: "STMT-1" },
      }),
    ).toEqual({
      type: "withdrawal",
      date: "",
      description: "",
      payee: "",
      categoryId: "",
      notes: "",
      fromAccountId: "",
      toAccountId: "",
      amount: "",
      externalId: "",
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
