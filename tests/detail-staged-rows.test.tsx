// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  PaginatedPage,
  StagedTransaction,
  Transaction,
} from "../src/client/api.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
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

const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

const stagedRow: StagedTransaction = {
  id: "33333333-3333-4333-8333-333333333333",
  draft: {
    type: "withdrawal",
    date: "2026-04-01",
    payee: "Staged Only Payee",
    description: null,
    categoryId: CATEGORY_ID,
    fromAccountId: account.id,
    amount: "12.00",
  },
  validationIssues: [],
  importBatchId: null,
  version: 1,
  status: "staged",
  createdAt: "2026-04-01T12:00:00.000Z",
};

function stub({ committed }: { committed: Transaction[] }) {
  const stagedQueries: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/api/v1/transactions") {
        return json({
          items: committed,
          nextCursor: null,
          page: 1,
          pageSize: 50,
          totalCount: committed.length,
          totalPages: 1,
        } satisfies PaginatedPage<Transaction>);
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        stagedQueries.push(url);
        return json({
          items: [stagedRow],
          nextCursor: null,
          page: 1,
          pageSize: 100,
          totalCount: 1,
          totalPages: 1,
        } satisfies PaginatedPage<StagedTransaction>);
      }
      if (url.pathname === "/api/v1/accounts") return json([account]);
      if (url.pathname === "/api/v1/categories") return json([]);
      if (url.pathname === "/api/v1/payees/suggestions") return json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return stagedQueries;
}

function renderBrowser(props: Record<string, unknown>) {
  window.history.replaceState(
    null,
    "",
    "/categories/x?preset=custom&start=2026-01-01&end=2026-12-31",
  );
  return render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser {...props} />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("staged rows on category and payee detail", () => {
  it("lists staged rows when the view has no committed transactions", async () => {
    stub({ committed: [] });
    renderBrowser({ includeStaged: true, fixedCategoryId: CATEGORY_ID });

    expect(await screen.findByText("Staged Only Payee")).toBeInTheDocument();
    const row = screen.getByText("Staged Only Payee").closest("tr")!;
    expect(within(row).getByText("Staged")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/staged",
    );
  });

  it("never offers staged rows to a committed bulk edit", async () => {
    stub({ committed: [] });
    renderBrowser({ includeStaged: true, fixedCategoryId: CATEGORY_ID });

    expect(await screen.findByText("Staged Only Payee")).toBeInTheDocument();
    const row = screen.getByText("Staged Only Payee").closest("tr")!;
    // A checkbox here would let a staged row into an explicit-ID bulk edit.
    expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("scopes the staged lookup to the category being viewed", async () => {
    const stagedQueries = stub({ committed: [] });
    renderBrowser({ includeStaged: true, fixedCategoryId: CATEGORY_ID });

    expect(await screen.findByText("Staged Only Payee")).toBeInTheDocument();
    expect(stagedQueries[0]?.searchParams.get("categoryId")).toBe(CATEGORY_ID);
  });

  it("scopes the staged lookup to the payee being viewed", async () => {
    const stagedQueries = stub({ committed: [] });
    renderBrowser({ includeStaged: true, fixedPayee: "Staged Only Payee" });

    expect(await screen.findByText("Staged Only Payee")).toBeInTheDocument();
    expect(stagedQueries[0]?.searchParams.get("payee")).toBe(
      "Staged Only Payee",
    );
  });

  it("leaves the main transaction list alone", async () => {
    const stagedQueries = stub({ committed: [] });
    renderBrowser({ fixedCategoryId: CATEGORY_ID });

    // Without the opt-in the staged endpoint is never queried.
    expect(await screen.findByText(/No transactions/i)).toBeInTheDocument();
    expect(stagedQueries).toHaveLength(0);
  });
});
