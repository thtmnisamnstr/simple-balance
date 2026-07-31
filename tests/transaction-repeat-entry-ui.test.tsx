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
  Page,
  StagedTransaction,
  Transaction,
} from "../src/client/api.js";
import { TransactionForm } from "../src/client/forms.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const checkingAccount: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
};

const savingsAccount: Account = {
  ...checkingAccount,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Savings",
  type: "savings",
};

const groceriesCategory: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

const utilitiesCategory: Category = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Utilities",
  kind: "expense",
  version: 1,
};

const transaction: Transaction = {
  id: "55555555-5555-4555-8555-555555555555",
  type: "withdrawal",
  date: "2026-07-31",
  payee: "Acme Market",
  description: "Weekly groceries",
  categoryId: groceriesCategory.id,
  category: groceriesCategory,
  sourceAccountId: checkingAccount.id,
  sourceAccount: {
    id: checkingAccount.id,
    name: checkingAccount.name,
    currency: checkingAccount.currency,
  },
  sourceAmount: "12.34",
  sourceCurrency: "USD",
  version: 1,
};

const staged: StagedTransaction = {
  id: "66666666-6666-4666-8666-666666666666",
  draft: {
    type: "withdrawal",
    date: "2026-07-31",
    payee: "Acme Market",
    description: "Weekly groceries",
    categoryId: groceriesCategory.id,
    fromAccountId: checkingAccount.id,
    amount: "12.34",
  },
  validationIssues: [],
  version: 1,
  status: "staged",
  createdAt: "2026-07-31T12:00:00.000Z",
};

function queryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["payees", "suggestions", ""], []);
  return client;
}

function renderTransactionForm(
  props: Partial<Parameters<typeof TransactionForm>[0]> = {},
) {
  const client = queryClient();
  const onDone = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <TransactionForm
          accounts={[checkingAccount, savingsAccount]}
          categories={[groceriesCategory, utilitiesCategory]}
          onDone={onDone}
          {...props}
        />
      </TimezoneProvider>
    </QueryClientProvider>,
  );
  return { ...result, onDone };
}

function successfulCreateFetch(requestBodies: Record<string, unknown>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (
        url.pathname === "/api/v1/transactions" ||
        url.pathname === "/api/v1/staged-transactions"
      ) {
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(JSON.stringify({ id: crypto.randomUUID() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/v1/payees/suggestions") {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    }),
  );
}

function fillRequiredWithdrawal(container: HTMLElement) {
  const form = within(container);
  fireEvent.change(form.getByLabelText("Payee"), {
    target: { value: "Corner Cafe" },
  });
  fireEvent.change(form.getByLabelText("Amount (USD)"), {
    target: { value: "7.25" },
  });
  return form;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("transaction repeat-entry controls", () => {
  it("shows create-only repeat controls and reveals reset only when repeat is checked", () => {
    const { container, unmount } = renderTransactionForm();
    const form = within(container);
    const repeat = form.getByRole("checkbox", {
      name: "After saving/staging, return to create another",
    });

    expect(repeat).not.toBeChecked();
    expect(
      form.queryByRole("checkbox", { name: "Reset after saving/staging" }),
    ).not.toBeInTheDocument();

    fireEvent.click(repeat);
    expect(
      form.getByRole("checkbox", { name: "Reset after saving/staging" }),
    ).toBeEnabled();

    fireEvent.click(repeat);
    expect(
      form.queryByRole("checkbox", { name: "Reset after saving/staging" }),
    ).not.toBeInTheDocument();

    unmount();
    const committedEdit = renderTransactionForm({ transaction });
    expect(
      within(committedEdit.container).queryByRole("checkbox", {
        name: "After saving/staging, return to create another",
      }),
    ).not.toBeInTheDocument();

    committedEdit.unmount();
    const stagedEdit = renderTransactionForm({ staged });
    expect(
      within(stagedEdit.container).queryByRole("checkbox", {
        name: "After saving/staging, return to create another",
      }),
    ).not.toBeInTheDocument();
  });

  it("closes after a successful create by default", async () => {
    const requests: Record<string, unknown>[] = [];
    successfulCreateFetch(requests);
    const { container, onDone } = renderTransactionForm();
    fillRequiredWithdrawal(container);

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(requests).toHaveLength(1));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("stays open, preserves the saved values, and uses a fresh idempotency key for the next create", async () => {
    const requests: Record<string, unknown>[] = [];
    successfulCreateFetch(requests);
    const { container, onDone } = renderTransactionForm();
    const form = fillRequiredWithdrawal(container);
    fireEvent.change(form.getByLabelText(/Description/), {
      target: { value: "Morning coffee" },
    });
    fireEvent.change(form.getByLabelText(/Notes/), {
      target: { value: "Met a friend" },
    });
    fireEvent.change(form.getByLabelText(/Category/), {
      target: { value: utilitiesCategory.name },
    });
    fireEvent.click(
      form.getByRole("checkbox", {
        name: "After saving/staging, return to create another",
      }),
    );

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(onDone).not.toHaveBeenCalled();
    expect(form.getByLabelText("Payee")).toHaveValue("Corner Cafe");
    expect(form.getByLabelText("Amount (USD)")).toHaveValue("7.25");
    expect(form.getByLabelText(/Description/)).toHaveValue("Morning coffee");
    expect(form.getByLabelText(/Notes/)).toHaveValue("Met a friend");
    expect(form.getByLabelText(/Category/)).toHaveValue("Utilities");

    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.idempotencyKey).not.toBe(
      requests[1]?.idempotencyKey,
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it("stays open and resets entered values back to the original context defaults", async () => {
    const requests: Record<string, unknown>[] = [];
    successfulCreateFetch(requests);
    const { container, onDone } = renderTransactionForm({
      initialAccountId: checkingAccount.id,
      initialCategoryId: groceriesCategory.id,
      initialPayee: "Context Payee",
      initialType: "withdrawal",
      initialMode: "stage",
    });
    const form = within(container);
    const initialDate = (form.getByLabelText("Date") as HTMLInputElement).value;

    fireEvent.change(form.getByLabelText("Date"), {
      target: { value: "2026-07-15" },
    });
    fireEvent.change(form.getByLabelText("Payee"), {
      target: { value: "Changed Payee" },
    });
    fireEvent.change(form.getByLabelText("Amount (USD)"), {
      target: { value: "48.99" },
    });
    fireEvent.change(form.getByLabelText(/Description/), {
      target: { value: "Changed description" },
    });
    fireEvent.change(form.getByLabelText(/Notes/), {
      target: { value: "Changed notes" },
    });
    fireEvent.change(form.getByLabelText(/Category/), {
      target: { value: utilitiesCategory.name },
    });
    fireEvent.change(form.getByLabelText("Account"), {
      target: { value: savingsAccount.id },
    });
    fireEvent.click(
      form.getByRole("checkbox", {
        name: "After saving/staging, return to create another",
      }),
    );
    fireEvent.click(
      form.getByRole("checkbox", { name: "Reset after saving/staging" }),
    );

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(onDone).not.toHaveBeenCalled();
    expect(form.getByLabelText("Date")).toHaveValue(initialDate);
    expect(form.getByLabelText("Payee")).toHaveValue("Context Payee");
    expect(form.getByLabelText("Account")).toHaveValue(checkingAccount.id);
    expect(form.getByLabelText(/Category/)).toHaveValue("Groceries");
    expect(form.getByRole("radio", { name: /Withdrawal/ })).toBeChecked();
    expect(form.getByLabelText("Amount (USD)")).toHaveValue("");
    expect(form.getByLabelText(/Description/)).toHaveValue("");
    expect(form.getByLabelText(/Notes/)).toHaveValue("");
    expect(form.getByRole("radio", { name: /Stage for review/ })).toBeChecked();
  });
});

describe("manual staging entry point", () => {
  it("labels the action Stage transaction", () => {
    window.history.replaceState(
      null,
      "",
      "/staged?start=2026-07-01&end=2026-07-31",
    );
    const client = queryClient();
    const emptyPage: Page<never> = { items: [], nextCursor: null };
    client.setQueryData(["import-batches", "active"], {
      pages: [emptyPage],
      pageParams: [undefined],
    });
    client.setQueryData(
      [
        "staged",
        "",
        "",
        "",
        "",
        "2026-07-01",
        "2026-07-31",
      ],
      { pages: [emptyPage], pageParams: [undefined] },
    );
    client.setQueryData(["accounts"], [checkingAccount]);
    client.setQueryData(["categories"], []);

    render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <StagingPage />
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Stage transaction" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stage manually" }),
    ).not.toBeInTheDocument();
  });
});
