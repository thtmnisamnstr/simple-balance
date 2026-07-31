// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  ImportBatchSummary,
  Page,
  StagedTransaction,
} from "../src/client/api.js";
import { AccountForm, TransactionForm } from "../src/client/forms.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("account opening balances", () => {
  it("round-trips a positive liability credit without changing its sign", async () => {
    const card: Account = {
      ...checkingAccount,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Credit card",
      type: "credit_card",
      openingBalance: "42.50",
      balance: "42.50",
      balancePresentation: { label: "Credit balance", amount: "42.50" },
    };
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(card), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const client = queryClient();
    client.setQueryData(["accounts"], [card]);
    const { container } = render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <AccountForm
            account={card}
            defaultCurrency="USD"
            onDone={() => undefined}
          />
        </TimezoneProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Starting balance type")).toHaveValue("credit");
    expect(screen.getByLabelText("Starting amount")).toHaveValue("42.50");
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(requestBody?.openingBalance).toBe("42.50");
    });
  });

  it("preserves an amount owed when changing a liability into an asset", async () => {
    const card: Account = {
      ...checkingAccount,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Credit card",
      type: "credit_card",
      openingBalance: "-500",
      balance: "-500",
      balancePresentation: { label: "Amount owed", amount: "500" },
    };
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ ...card, type: "checking", openingBalance: "-500" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const client = queryClient();
    client.setQueryData(["accounts"], [card]);
    const { container } = render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <AccountForm
            account={card}
            defaultCurrency="USD"
            onDone={() => undefined}
          />
        </TimezoneProvider>
      </QueryClientProvider>,
    );

    const form = within(container);
    expect(form.getByLabelText("Starting amount")).toHaveValue("500");
    fireEvent.change(form.getByLabelText("Account type"), {
      target: { value: "checking" },
    });
    expect(form.getByLabelText("Opening balance")).toHaveValue("-500");
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => {
      expect(requestBody?.openingBalance).toBe("-500");
    });
  });
});

describe("configured timezone defaults", () => {
  it("uses the ledger timezone for a new transaction date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T06:30:00.000Z"));
    const client = queryClient();
    client.setQueryData(["payees"], []);

    render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="America/Los_Angeles">
          <TransactionForm
            accounts={[checkingAccount]}
            categories={[]}
            onDone={() => undefined}
          />
        </TimezoneProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Date")).toHaveValue("2026-07-31");
  });
});

describe("browser mutation idempotency", () => {
  it("reuses the direct-create key when a lost response is retried", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    let transactionAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/payees") {
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/transactions") {
          requestBodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          transactionAttempts += 1;
          if (transactionAttempts === 1) {
            throw new TypeError("Response was lost");
          }
          return new Response(JSON.stringify({ id: "created" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const onDone = vi.fn();
    const { container } = render(
      <QueryClientProvider client={queryClient()}>
        <TimezoneProvider timezone="UTC">
          <TransactionForm
            accounts={[checkingAccount]}
            categories={[]}
            onDone={onDone}
          />
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    const form = within(container);
    fireEvent.change(form.getByLabelText("Description"), {
      target: { value: "Idempotent retry" },
    });
    fireEvent.change(form.getByLabelText("Amount (USD)"), {
      target: { value: "12.34" },
    });
    fireEvent.submit(container.querySelector("form")!);
    expect(await form.findByText("Response was lost")).toBeInTheDocument();

    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.idempotencyKey).toBe(
      requestBodies[1]?.idempotencyKey,
    );
  });
});

function staged(
  id: string,
  description: string,
  importBatchId: string,
): StagedTransaction {
  return {
    id,
    draft: {
      type: "withdrawal",
      date: "2026-07-30",
      description,
      fromAccountId: checkingAccount.id,
      amount: "10.00",
    },
    validationIssues: [],
    importBatchId,
    version: 1,
    status: "staged",
    createdAt: "2026-07-30T12:00:00.000Z",
  };
}

describe("staged queue pagination", () => {
  it("keeps initial requests and rendering bounded, then loads more on demand", async () => {
    window.history.replaceState(
      null,
      "",
      "/staged?start=2026-07-01&end=2026-07-31",
    );
    const first = staged(
      "33333333-3333-4333-8333-333333333333",
      "First page",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const second = staged(
      "44444444-4444-4444-8444-444444444444",
      "Second page",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    const requestedStageCursors: (string | null)[] = [];
    const requestedBatchCursors: (string | null)[] = [];
    const firstBatch: ImportBatchSummary = {
      id: first.importBatchId!,
      fileName: "first.csv",
      rowCount: 1,
      stagedCount: 1,
      createdAt: "2026-07-30T12:00:00.000Z",
    };
    const secondBatch: ImportBatchSummary = {
      id: second.importBatchId!,
      fileName: "second.csv",
      rowCount: 1,
      stagedCount: 1,
      createdAt: "2026-07-29T12:00:00.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/staged-transactions") {
          const cursor = url.searchParams.get("cursor");
          requestedStageCursors.push(cursor);
          const page: Page<StagedTransaction> = cursor
            ? { items: [second], nextCursor: null }
            : { items: [first], nextCursor: "next-page" };
          return new Response(JSON.stringify(page), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/import-batches") {
          const cursor = url.searchParams.get("cursor");
          requestedBatchCursors.push(cursor);
          const page: Page<ImportBatchSummary> = cursor
            ? { items: [secondBatch], nextCursor: null }
            : { items: [firstBatch], nextCursor: "older-batch" };
          return new Response(JSON.stringify(page), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/accounts") {
          return new Response(JSON.stringify([checkingAccount]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/categories") {
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    render(
      <QueryClientProvider client={queryClient()}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <StagingPage />
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("First page")).toBeInTheDocument();
    expect(screen.queryByText("Second page")).not.toBeInTheDocument();
    expect(
      requestedStageCursors.filter((cursor) => cursor === "next-page"),
    ).toHaveLength(0);
    expect(
      screen.getByRole("option", { name: "first.csv (1)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "second.csv (1)" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load older batches" }));
    expect(
      await screen.findByRole("option", { name: "second.csv (1)" }),
    ).toBeInTheDocument();
    expect(
      requestedBatchCursors.filter((cursor) => cursor === "older-batch"),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Load more transactions" }),
    );
    expect(await screen.findByText("Second page")).toBeInTheDocument();
    expect(
      requestedStageCursors.filter((cursor) => cursor === "next-page"),
    ).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select all staged transactions",
      }),
    );
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("reuses a staged-commit key when a lost response is retried", async () => {
    window.history.replaceState(
      null,
      "",
      "/staged?start=2026-07-01&end=2026-07-31",
    );
    const row = staged(
      "55555555-5555-4555-8555-555555555555",
      "Retry staged commit",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    const commitBodies: Record<string, unknown>[] = [];
    let commitAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (
          url.pathname === "/api/v1/staged-transactions/commit" &&
          init?.method === "POST"
        ) {
          commitBodies.push(
            JSON.parse(String(init.body)) as Record<string, unknown>,
          );
          commitAttempts += 1;
          if (commitAttempts === 1) throw new TypeError("Commit response lost");
          return new Response(
            JSON.stringify({
              committed: [{ stagedId: row.id, transactionId: "committed" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.pathname === "/api/v1/staged-transactions") {
          return new Response(
            JSON.stringify({ items: [row], nextCursor: null }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.pathname === "/api/v1/import-batches") {
          return new Response(
            JSON.stringify({ items: [], nextCursor: null }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (url.pathname === "/api/v1/accounts") {
          return new Response(JSON.stringify([checkingAccount]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/v1/categories") {
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const { container } = render(
      <QueryClientProvider client={queryClient()}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <StagingPage />
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    const page = within(container);
    const commitButton = await page.findByRole("button", {
      name: "Commit staged transaction",
    });
    fireEvent.click(commitButton);
    expect(await page.findByText("Commit response lost")).toBeInTheDocument();
    fireEvent.click(commitButton);

    await waitFor(() => expect(commitBodies).toHaveLength(2));
    expect(commitBodies[0]?.idempotencyKey).toBe(
      commitBodies[1]?.idempotencyKey,
    );
  });
});
