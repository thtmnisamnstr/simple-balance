// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  PaginatedPage,
  StagedTransaction,
} from "../src/client/api.js";
import { TransactionForm } from "../src/client/forms.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const account: Account = {
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

const malformedStage: StagedTransaction = {
  id: "22222222-2222-4222-8222-222222222222",
  draft: {
    type: { nested: "withdrawal" },
    date: ["2026-07-30"],
    description: { text: "Groceries" },
    payee: ["Market"],
    categoryId: { id: "category" },
    notes: { unsafe: true },
    fromAccountId: ["account"],
    amount: { value: "12.34" },
  },
  validationIssues: [{ field: "draft", message: "Malformed draft" }],
  version: 1,
  status: "staged",
  createdAt: "2026-07-30T12:00:00.000Z",
};

/**
 * An agent may stage a row naming its category by name and no id, and a CSV
 * import defers the name the same way when the token may only stage. Opening
 * such a row to review it and pressing Save used to write null over the name,
 * and the row then committed uncategorised.
 */
describe("a staged row filed by category name", () => {
  const namedStage: StagedTransaction = {
    id: "33333333-3333-4333-8333-333333333333",
    draft: {
      type: "withdrawal",
      date: "2026-07-30",
      payee: "Market",
      description: null,
      notes: null,
      fromAccountId: account.id,
      amount: "12.34",
      categoryName: "Groceries",
    },
    validationIssues: [],
    version: 1,
    status: "staged",
    createdAt: "2026-07-30T12:00:00.000Z",
  };

  const renderStaged = (
    staged: StagedTransaction,
    onBody: (body: { draft?: Record<string, unknown> }) => void,
  ) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname.startsWith("/api/v1/staged-transactions/")) {
          onBody(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify(staged), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(["payees", "suggestions", ""], []);
    return render(
      <QueryClientProvider client={client}>
        <TransactionForm
          accounts={[account]}
          categories={[]}
          staged={staged}
          onDone={() => undefined}
        />
      </QueryClientProvider>,
    );
  };

  it("shows the name in the picker", () => {
    renderStaged(namedStage, () => undefined);
    expect(screen.getByPlaceholderText("Type to search or add")).toHaveValue(
      "Groceries",
    );
  });

  it("sends it back on save rather than clearing it", async () => {
    let body: { draft?: Record<string, unknown> } | undefined;
    renderStaged(namedStage, (next) => (body = next));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.draft).toMatchObject({ categoryName: "Groceries" });
  });

  // A transfer has no counter-account side to file, so the picker is not
  // rendered at all and nothing may go out under it.
  it("sends no category at all once the row is made a transfer", async () => {
    let body: { draft?: Record<string, unknown> } | undefined;
    renderStaged(namedStage, (next) => (body = next));
    fireEvent.click(screen.getByRole("radio", { name: /Transfer/ }));
    expect(screen.queryByPlaceholderText("Type to search or add")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body?.draft).toMatchObject({ categoryId: null, categoryName: null });
  });
});

describe("staged transaction editor", () => {
  it("renders malformed object and array fields as safe empty inputs", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["payees", "suggestions", ""], []);

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <TransactionForm
          accounts={[account]}
          categories={[]}
          staged={malformedStage}
          onDone={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Date")).toHaveValue("");
    expect(screen.getByLabelText(/Description/)).toHaveValue("");
    expect(screen.getByLabelText("Payee")).toHaveValue("");
    expect(screen.getByLabelText("Amount (USD)")).toHaveValue("");
    expect(container.querySelector("textarea")).toHaveValue("");
  });

  it("renders a malformed staged row without passing unknown values to React", () => {
    window.history.replaceState(
      null,
      "",
      "/staged?start=2026-07-01&end=2026-07-30",
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    const page: PaginatedPage<StagedTransaction> = {
      items: [malformedStage],
      nextCursor: null,
      page: 1,
      pageSize: 100,
      totalCount: 1,
      totalPages: 1,
    };
    queryClient.setQueryData(["import-batches", "active"], {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(
      [
        "staged",
        {
          search: undefined,
          validity: undefined,
          accountId: undefined,
          importBatchId: undefined,
          start: "2026-07-01",
          end: "2026-07-30",
          limit: "100",
        },
        1,
        { field: "date", direction: "desc" },
      ],
      page,
    );
    queryClient.setQueryData(["accounts"], [account]);
    queryClient.setQueryData(["categories"], []);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <StagingPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Incomplete row")).toBeInTheDocument();
    expect(screen.getByText("Unknown type")).toBeInTheDocument();
    expect(screen.getByText("Unknown account")).toBeInTheDocument();
  });
});
