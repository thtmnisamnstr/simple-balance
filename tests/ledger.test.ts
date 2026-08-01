import { describe, expect, it } from "vitest";
import type { Actor, TransactionDraft } from "../src/shared/domain.js";
import { presentAccountBalance } from "../src/server/services/accounts.js";
import { canonicalDecimal, decimal } from "../src/server/services/helpers.js";
import {
  buildPreparedTransaction,
  systemAccountKey,
} from "../src/server/services/transactions.js";

const actor: Actor = { userId: "test-user", source: "web" };
const checking = "11111111-1111-4111-8111-111111111111";
const savings = "22222222-2222-4222-8222-222222222222";
const euros = "33333333-3333-4333-8333-333333333333";
const accounts = new Map([
  [checking, { id: checking, currency: "USD" }],
  [savings, { id: savings, currency: "USD" }],
  [euros, { id: euros, currency: "EUR" }],
]);
const incomeUsd = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const expenseUsd = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const exchangeUsd = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const exchangeEur = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const systemAccounts = new Map([
  [systemAccountKey("income", "USD"), { id: incomeUsd, currency: "USD" }],
  [systemAccountKey("expense", "USD"), { id: expenseUsd, currency: "USD" }],
  [systemAccountKey("exchange", "USD"), { id: exchangeUsd, currency: "USD" }],
  [systemAccountKey("exchange", "EUR"), { id: exchangeEur, currency: "EUR" }],
]);

/** Every entry must net to zero in each currency it touches. */
function currencyTotals(postings: { amount: string; currency: string }[]) {
  const totals = new Map<string, string>();
  for (const entry of postings) {
    totals.set(
      entry.currency,
      canonicalDecimal(decimal(totals.get(entry.currency) ?? "0").plus(entry.amount)),
    );
  }
  return Object.fromEntries(totals);
}
const common = {
  date: "2026-07-30",
  payee: "Test transaction",
  description: "Test transaction",
};

function prepare(draft: TransactionDraft) {
  return buildPreparedTransaction(actor, draft, accounts, systemAccounts);
}

describe("signed ledger postings", () => {
  it("balances a deposit against the income account", () => {
    const prepared = prepare({
      type: "deposit",
      toAccountId: checking,
      amount: "100.25",
      ...common,
    });
    expect(prepared.postings).toMatchObject([
      { accountId: checking, amount: "100.25", currency: "USD" },
      { accountId: incomeUsd, amount: "-100.25", currency: "USD" },
    ]);
    expect(currencyTotals(prepared.postings)).toEqual({ USD: "0" });
  });

  it("balances a withdrawal against the expense account", () => {
    const prepared = prepare({
      type: "withdrawal",
      fromAccountId: checking,
      amount: "42.10",
      ...common,
    });
    expect(prepared.postings).toMatchObject([
      { accountId: checking, amount: "-42.1", currency: "USD" },
      { accountId: expenseUsd, amount: "42.1", currency: "USD" },
    ]);
    expect(currencyTotals(prepared.postings)).toEqual({ USD: "0" });
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
    expect(currencyTotals(prepared.postings)).toEqual({ USD: "0" });
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
    // A conversion settles through the exchange account so each currency
    // balances on its own instead of netting across the pair.
    expect(prepared.postings).toMatchObject([
      { accountId: checking, amount: "-110", currency: "USD" },
      { accountId: exchangeUsd, amount: "110", currency: "USD" },
      { accountId: exchangeEur, amount: "-100", currency: "EUR" },
      { accountId: euros, amount: "100", currency: "EUR" },
    ]);
    expect(currencyTotals(prepared.postings)).toEqual({ USD: "0", EUR: "0" });
    expect(prepared.transaction.effectiveRate).toBe("0.909090909090909091");
  });

  it("keeps all numeric(44,18) digits during arithmetic", () => {
    expect(
      canonicalDecimal(
        decimal("99999999999999999999999999.999999999999999999").minus(
          "0.000000000000000001",
        ),
      ),
    ).toBe("99999999999999999999999999.999999999999999998");
  });

  it("rejects implied FX rates that numeric(44,18) cannot represent", () => {
    expect(() =>
      prepare({
        type: "transfer",
        fromAccountId: checking,
        toAccountId: euros,
        sourceAmount: "0.000000000000000001",
        destinationAmount: "99999999999999999999999999.999999999999999999",
        ...common,
      }),
    ).toThrow(/implied exchange rate cannot be represented/i);

    expect(() =>
      prepare({
        type: "transfer",
        fromAccountId: checking,
        toAccountId: euros,
        sourceAmount: "99999999999999999999999999.999999999999999999",
        destinationAmount: "0.000000000000000001",
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
