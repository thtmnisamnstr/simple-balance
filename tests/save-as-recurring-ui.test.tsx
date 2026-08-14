// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  Category,
  PaginatedPage,
  StagedTransaction,
  Transaction,
} from "../src/client/api.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const checking: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "100",
  balancePresentation: { label: "Balance", amount: "100" },
};

const euroSavings: Account = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Euro Savings",
  type: "savings",
  currency: "EUR",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
};

const groceries: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

const imported: Transaction = {
  id: "44444444-4444-4444-8444-444444444444",
  type: "withdrawal",
  date: "2026-01-05",
  payee: "Market",
  description: "Food",
  categoryId: groceries.id,
  category: groceries,
  notes: "weekly",
  externalId: "bank-statement-row-9912",
  sourceAccountId: checking.id,
  sourceAccount: { id: checking.id, name: checking.name, currency: "USD" },
  sourceAmount: "12.34",
  sourceCurrency: "USD",
  version: 3,
  legs: [],
};

const crossCurrency: Transaction = {
  id: "66666666-6666-4666-8666-666666666666",
  type: "transfer",
  date: "2026-03-02",
  payee: "Monthly sweep",
  description: null,
  categoryId: null,
  category: null,
  notes: null,
  externalId: null,
  sourceAccountId: checking.id,
  sourceAccount: { id: checking.id, name: checking.name, currency: "USD" },
  sourceAmount: "500.00",
  sourceCurrency: "USD",
  destinationAccountId: euroSavings.id,
  destinationAccount: {
    id: euroSavings.id,
    name: euroSavings.name,
    currency: "EUR",
  },
  destinationAmount: "460.00",
  destinationCurrency: "EUR",
  version: 1,
  legs: [],
};

const namedStage: StagedTransaction = {
  id: "55555555-5555-4555-8555-555555555555",
  draft: {
    type: "withdrawal",
    date: "2026-02-11",
    payee: "Utility Co",
    description: null,
    notes: null,
    fromAccountId: checking.id,
    amount: "88.00",
    categoryName: "Utilities",
    externalId: "ofx-9912",
  },
  validationIssues: [],
  version: 1,
  status: "staged",
  createdAt: "2026-02-11T12:00:00.000Z",
};

type Write = { path: string; method: string; body: Record<string, unknown> };

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function stubLedger(transactions: Transaction[] = [imported]) {
  const writes: Write[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method && init.method !== "GET") {
        writes.push({
          path: url.pathname,
          method: init.method,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return jsonResponse({ id: "written" }, 201);
      }
      if (url.pathname === "/api/v1/transactions") {
        const page: PaginatedPage<Transaction> = {
          items: transactions,
          nextCursor: null,
          page: 1,
          pageSize: transactions.length,
          totalCount: transactions.length,
          totalPages: 1,
        };
        return jsonResponse(page);
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        const page: PaginatedPage<StagedTransaction> = {
          items: [namedStage],
          nextCursor: null,
          page: 1,
          pageSize: 1,
          totalCount: 1,
          totalPages: 1,
        };
        return jsonResponse(page);
      }
      if (url.pathname === "/api/v1/import-batches") {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.pathname === "/api/v1/accounts")
        return jsonResponse([checking, euroSavings]);
      if (url.pathname === "/api/v1/categories") return jsonResponse([groceries]);
      if (url.pathname === "/api/v1/transaction-templates") return jsonResponse([]);
      if (url.pathname === "/api/v1/payees/suggestions") return jsonResponse([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return writes;
}

function renderAt(path: string, page: "transactions" | "staged") {
  window.history.replaceState(null, "", path);
  render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          {page === "transactions" ? <TransactionBrowser /> : <StagingPage />}
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

async function openRecurrenceEditor(payee: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${payee}` }));
  fireEvent.click(
    screen.getByRole("button", { name: /Save as recurring transaction/ }),
  );
  return within(
    screen.getByRole("dialog", { name: "Save as recurring transaction" }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The row already knows what the recurrence is for. Retyping it is where the
 * payee, the account and the amount get to differ from the entry the person was
 * looking at when they decided to make one.
 */
describe("saving a transaction as a recurring transaction", () => {
  it("offers the action beside the template one, on the same menu", async () => {
    stubLedger();
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const trigger = await screen.findByRole("button", {
      name: "Actions for Market",
    });
    const menu = trigger.closest("details");
    expect(menu).toContainElement(
      screen.getByRole("button", { name: /Save as template/ }),
    );
    expect(menu).toContainElement(
      screen.getByRole("button", { name: /Save as recurring transaction/ }),
    );
  });

  it("opens on the row's own values rather than an empty form", async () => {
    stubLedger();
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Market");
    expect(dialog.getByLabelText(/^Payee/)).toHaveValue("Market");
    expect(dialog.getByLabelText(/^Amount/)).toHaveValue("12.34");
    expect(dialog.getByLabelText("Account")).toHaveValue(checking.id);
    expect(dialog.getByLabelText(/^Description/)).toHaveValue("Food");
    expect(dialog.getByLabelText(/^Notes/)).toHaveValue("weekly");
    expect(dialog.getByPlaceholderText("Type to search or add")).toHaveValue(
      "Groceries",
    );
  });

  /**
   * The anchor is what fixes the day of the month a schedule repeats on. Left at
   * today it would silently make a schedule for a different day than the entry
   * the person is looking at, and the preview would agree with it.
   */
  it("anchors the schedule to the day the transaction fell on", async () => {
    stubLedger();
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Market");
    expect(dialog.getByLabelText(/^Starting/)).toHaveValue("2026-01-05");
  });

  it("posts the row's shape and never its date or its bank reference", async () => {
    const writes = stubLedger();
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Market");
    fireEvent.change(dialog.getByLabelText(/^Name/), {
      target: { value: "Weekly shop" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Create recurrence" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toBe("/api/v1/recurrences");
    expect(writes[0]!.method).toBe("POST");
    expect(writes[0]!.body).toMatchObject({
      name: "Weekly shop",
      shape: {
        type: "withdrawal",
        payee: "Market",
        fromAccountId: checking.id,
        amount: "12.34",
        categoryId: groceries.id,
        description: "Food",
        notes: "weekly",
      },
      schedule: { frequency: "monthly", anchorDate: "2026-01-05" },
    });
    expect(writes[0]!.body.shape).not.toHaveProperty("date");
    expect(JSON.stringify(writes[0]!.body)).not.toContain(
      "bank-statement-row-9912",
    );
  });

  /**
   * A category arrives without anybody having chosen it under the type now on
   * screen. Kept, it would be refused once per proposal at commit and never at
   * a moment anybody could connect to this form.
   */
  it("drops a category the type it is switched to cannot cover", async () => {
    stubLedger();
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Market");
    expect(dialog.getByPlaceholderText("Type to search or add")).toHaveValue(
      "Groceries",
    );
    fireEvent.click(dialog.getByRole("radio", { name: /Deposit/ }));
    await waitFor(() =>
      expect(dialog.getByPlaceholderText("Type to search or add")).toHaveValue(""),
    );
  });

  /**
   * The one field a proposal cannot carry. A rate belongs to the day it was
   * got, so the shape keeps no destination amount and every occurrence waits in
   * the queue for one. Left unsaid, that arrives as a refusal per row.
   */
  it("says up front that a cross-currency transfer needs its rate each time", async () => {
    const writes = stubLedger([crossCurrency]);
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Monthly sweep");
    expect(
      dialog.getByText(/waits in the queue for the amount received/),
    ).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText(/^Name/), {
      target: { value: "Euro sweep" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Create recurrence" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      shape: {
        type: "transfer",
        fromAccountId: checking.id,
        toAccountId: euroSavings.id,
        amount: "500.00",
      },
    });
    expect(writes[0]!.body.shape).not.toHaveProperty("destinationAmount");
  });

  /**
   * A transfer's category is carried on purpose, and the form hides the picker
   * rather than emptying it. A kind-reset that fired for transfers deleted a
   * category nobody could see it delete, including one already saved.
   */
  it("keeps a transfer's category rather than clearing it", async () => {
    const writes = stubLedger([{ ...crossCurrency, categoryId: groceries.id, category: groceries }]);
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Monthly sweep");
    fireEvent.change(dialog.getByLabelText(/^Name/), {
      target: { value: "Euro sweep" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Create recurrence" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      shape: { type: "transfer", categoryId: groceries.id },
    });
  });

  /**
   * An archived account is absent from the list the form offers, so both
   * lookups can miss. Comparing what two misses returned made a genuinely mixed
   * pair read as matched, and one miss made a matched pair read as mixed.
   */
  it("says nothing about a rate when it cannot see both accounts", async () => {
    const toArchived: Transaction = {
      ...crossCurrency,
      id: "77777777-7777-4777-8777-777777777777",
      payee: "Archived sweep",
      destinationAccountId: "88888888-8888-4888-8888-888888888888",
      destinationAccount: {
        id: "88888888-8888-4888-8888-888888888888",
        name: "Retired Savings",
        currency: "USD",
      },
      destinationAmount: "500.00",
      destinationCurrency: "USD",
    };
    stubLedger([toArchived]);
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Archived sweep");
    expect(
      dialog.queryByText(/waits in the queue for the amount received/),
    ).not.toBeInTheDocument();
  });

  it("does not put the row into the template dialog by mistake", async () => {
    stubLedger();
    renderAt("/transactions?start=2026-01-01&end=2026-12-31&preset=custom", "transactions");
    const dialog = await openRecurrenceEditor("Market");
    expect(
      dialog.getByRole("button", { name: "Create recurrence" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Save as template" }),
    ).not.toBeInTheDocument();
  });
});

/**
 * The queue's copy of the action, which had no test of its own before this. A
 * staged row is looser than a posted one: it can name its category rather than
 * cite one, and the shape a recurrence keeps can hold that name.
 */
describe("saving a staged row as a recurring transaction", () => {
  it("keeps a category the row names rather than cites", async () => {
    const writes = stubLedger();
    renderAt("/staged?start=2026-02-01&end=2026-02-28", "staged");
    const dialog = await openRecurrenceEditor("Utility Co");
    expect(dialog.getByPlaceholderText("Type to search or add")).toHaveValue(
      "Utilities",
    );
    fireEvent.change(dialog.getByLabelText(/^Name/), {
      target: { value: "Electricity" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Create recurrence" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      name: "Electricity",
      shape: {
        type: "withdrawal",
        payee: "Utility Co",
        fromAccountId: checking.id,
        amount: "88.00",
        categoryName: "Utilities",
      },
      schedule: { anchorDate: "2026-02-11" },
    });
    expect(writes[0]!.body.shape).not.toHaveProperty("categoryId");
    expect(JSON.stringify(writes[0]!.body)).not.toContain("ofx-9912");
  });
});
