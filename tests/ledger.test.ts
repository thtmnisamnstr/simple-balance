import { describe, expect, it } from "vitest";
import type { Actor, TransactionDraft } from "../src/shared/domain.js";
import { presentAccountBalance } from "../src/server/services/accounts.js";
import { canonicalDecimal, decimal } from "../src/server/services/helpers.js";
import { buildPreparedTransaction } from "../src/server/services/transactions.js";

const actor: Actor = { userId: "test-user", source: "web" };
const checking = "11111111-1111-4111-8111-111111111111";
const savings = "22222222-2222-4222-8222-222222222222";
const euros = "33333333-3333-4333-8333-333333333333";
const accounts = new Map([
  [checking, { id: checking, currency: "USD" }],
  [savings, { id: savings, currency: "USD" }],
  [euros, { id: euros, currency: "EUR" }],
]);
const common = {
  date: "2026-07-30",
  description: "Test transaction",
};

function prepare(draft: TransactionDraft) {
  return buildPreparedTransaction(actor, draft, accounts);
}

describe("signed ledger postings", () => {
  it("posts a deposit positively", () => {
    const prepared = prepare({
      type: "deposit",
      toAccountId: checking,
      amount: "100.25",
      ...common,
    });
    expect(prepared.postings).toMatchObject([
      { accountId: checking, amount: "100.25", currency: "USD" },
    ]);
  });

  it("posts a withdrawal negatively, including on liability accounts", () => {
    const prepared = prepare({
      type: "withdrawal",
      fromAccountId: checking,
      amount: "42.10",
      ...common,
    });
    expect(prepared.postings[0].amount).toBe("-42.1");
  });

  it("balances a same-currency transfer by account", () => {
    const prepared = prepare({
      type: "transfer",
      fromAccountId: checking,
      toAccountId: savings,
      sourceAmount: "55.00",
      ...common,
    });
    expect(prepared.postings.map(({ accountId, amount, currency }) => ({
      accountId,
      amount,
      currency,
    }))).toEqual([
      { accountId: checking, amount: "-55", currency: "USD" },
      { accountId: savings, amount: "55", currency: "USD" },
    ]);
    expect(prepared.transaction.effectiveRate).toBe("1");
  });

  it("retains distinct per-account amounts for cross-currency transfers", () => {
    const prepared = prepare({
      type: "transfer",
      fromAccountId: checking,
      toAccountId: euros,
      sourceAmount: "110",
      destinationAmount: "100",
      ...common,
    });
    expect(prepared.postings).toMatchObject([
      { accountId: checking, amount: "-110", currency: "USD" },
      { accountId: euros, amount: "100", currency: "EUR" },
    ]);
    expect(prepared.transaction.effectiveRate).toBe("0.909090909091");
  });

  it("keeps all numeric(38,12) digits during arithmetic", () => {
    expect(
      canonicalDecimal(
        decimal("99999999999999999999999999.999999999999").minus(
          "0.000000000001",
        ),
      ),
    ).toBe("99999999999999999999999999.999999999998");
  });

  it("rejects implied FX rates that numeric(38,12) cannot represent", () => {
    expect(() =>
      prepare({
        type: "transfer",
        fromAccountId: checking,
        toAccountId: euros,
        sourceAmount: "0.000000000001",
        destinationAmount: "99999999999999999999999999.999999999999",
        ...common,
      }),
    ).toThrow(/implied exchange rate cannot be represented/i);

    expect(() =>
      prepare({
        type: "transfer",
        fromAccountId: checking,
        toAccountId: euros,
        sourceAmount: "99999999999999999999999999.999999999999",
        destinationAmount: "0.000000000001",
        ...common,
      }),
    ).toThrow(/implied exchange rate cannot be represented/i);
  });

  it("requires the received amount only when currencies differ", () => {
    expect(() =>
      prepare({
        type: "transfer",
        fromAccountId: checking,
        toAccountId: euros,
        sourceAmount: "110",
        ...common,
      }),
    ).toThrow(/Destination amount is required/);
    expect(() =>
      prepare({
        type: "transfer",
        fromAccountId: checking,
        toAccountId: savings,
        sourceAmount: "110",
        destinationAmount: "109",
        ...common,
      }),
    ).toThrow(/must match/);
  });
});

describe("natural liability presentation", () => {
  it("shows a negative card ledger balance as amount owed", () => {
    expect(presentAccountBalance("credit_card", "-850.25")).toEqual({
      balance: "-850.25",
      balancePresentation: { label: "Amount owed", amount: "850.25" },
    });
  });

  it("shows overpaid cards as a credit balance", () => {
    expect(presentAccountBalance("credit_card", "20")).toEqual({
      balance: "20",
      balancePresentation: { label: "Credit balance", amount: "20" },
    });
  });

  it("does not relabel an overdrawn checking account", () => {
    expect(presentAccountBalance("checking", "-20")).toEqual({
      balance: "-20",
      balancePresentation: { label: "Balance", amount: "-20" },
    });
  });
});
