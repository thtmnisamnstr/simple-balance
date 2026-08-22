// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Account, Category, Transaction } from "../src/client/api.js";
import { RecurrenceForm, TemplateForm, TransactionForm } from "../src/client/forms.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import "./support/dialog.js";

/**
 * Which accounts a form will let somebody choose.
 *
 * The rule the server keeps is that an archived account may be KEPT by an entry
 * that already names it and never newly pointed at, so a select that offers every
 * archived account offers choices the save refuses, and one that offers none of
 * them hides the account an existing entry uses. Three forms each had their own
 * answer and two of them disagreed with the third.
 */
const account = (
  id: string,
  name: string,
  archivedAt: string | null = null,
): Account => ({
  id,
  name,
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  archivedAt,
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
});

const LIVE = account("live-1", "Everyday");
const OTHER = account("live-2", "Savings");
const CLOSED = account("closed-1", "Closed last year", "2026-02-01");
const accounts = [LIVE, OTHER, CLOSED];
const categories: Category[] = [
  { id: "cat-1", name: "Food", kind: "expense", version: 1 },
];

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">{node}</TimezoneProvider>
    </QueryClientProvider>,
  );
}

const offered = (container: HTMLElement) =>
  [...container.querySelectorAll("option")]
    .map((option) => option.textContent ?? "")
    .filter((text) => text.includes("·"));

afterEach(cleanup);

describe("the accounts a form offers", () => {
  const blank = [
    ["a transaction", <TransactionForm accounts={accounts} categories={categories} onDone={() => {}} />],
    ["a template", <TemplateForm accounts={accounts} categories={categories} onDone={() => {}} />],
    ["a recurring transaction", <RecurrenceForm accounts={accounts} categories={categories} onDone={() => {}} />],
  ] as const;

  for (const [what, form] of blank) {
    it(`leaves a closed account out of a new ${what}`, () => {
      const { container } = mount(form);
      const options = offered(container);
      expect(options.join(" "), "the live accounts are offered").toContain("Everyday");
      expect(
        options.join(" "),
        "a closed account is not something new money can be pointed at",
      ).not.toContain("Closed last year");
    });
  }

  it("keeps offering the closed account an existing transaction already names", () => {
    // Otherwise the select renders blank while still holding the id, and saving
    // reroutes the entry to whatever gets picked instead.
    const existing: Transaction = {
      id: "txn-1",
      type: "withdrawal",
      date: "2026-01-15",
      payee: "Corner Shop",
      description: "Corner Shop",
      sourceAccountId: CLOSED.id,
      sourceAmount: "12.00",
      sourceCurrency: "USD",
      destinationAccountId: null,
      destinationAmount: null,
      destinationCurrency: null,
      categoryId: null,
      notes: null,
      legs: [],
      legCount: 0,
      version: 1,
    } as unknown as Transaction;
    const { container } = mount(
      <TransactionForm
        accounts={accounts}
        categories={categories}
        transaction={existing}
        onDone={() => {}}
      />,
    );
    const options = offered(container);
    expect(
      options.join(" "),
      "the account this entry is already on stays choosable",
    ).toContain("Closed last year");
    // And the select really is showing it, rather than holding an id with no
    // matching option.
    const selects = [...container.querySelectorAll("select")];
    const holding = selects.find((select) => select.value === CLOSED.id);
    expect(holding, "a select holds the closed account as its value").toBeDefined();
    expect(
      [...holding!.options].some((option) => option.value === CLOSED.id),
      "and has an option for it",
    ).toBe(true);
  });
});
