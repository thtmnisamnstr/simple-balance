// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { draftForTransactionForm } from "../src/client/staged-draft.js";

describe("staged draft", () => {
  it("carries the import reference through the form", () => {
    const draft = draftForTransactionForm({
      type: "withdrawal",
      date: "2026-03-01",
      payee: "Market",
      amount: "10",
      externalId: "STMT-4021-88",
    });
    expect(draft.externalId).toBe("STMT-4021-88");
  });

  it("leaves it blank when a row never had one", () => {
    expect(draftForTransactionForm({ type: "deposit" }).externalId).toBe("");
  });
});
