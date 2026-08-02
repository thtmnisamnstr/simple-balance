// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const PAYEE = "Acme Supply";

const stagedRow: StagedTransaction = {
  id: "33333333-3333-4333-8333-333333333333",
  draft: {
    type: "withdrawal",
    date: "2026-04-01",
    payee: PAYEE,
    description: "monthly consumables",
    categoryId: null,
    fromAccountId: account.id,
    amount: "12.00",
  },
  validationIssues: [],
  importBatchId: null,
  version: 1,
  status: "staged",
  createdAt: "2026-04-01T12:00:00.000Z",
};

function stub() {
  const stagedQueries: URL[] = [];
  const committedQueries: URL[] = [];
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
        committedQueries.push(url);
        // The server honours `search`: nothing matches "refund".
        const items: Transaction[] = [];
        return json({
          items,
          nextCursor: null,
          page: 1,
          pageSize: 50,
          totalCount: items.length,
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
  return { stagedQueries, committedQueries };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("probe: staged rows versus the search box", () => {
  it("keeps staged rows on screen after a search that matches nothing", async () => {
    const { stagedQueries, committedQueries } = stub();
    window.history.replaceState(
      null,
      "",
      "/payees/transactions?name=Acme+Supply&preset=custom&start=2026-01-01&end=2026-12-31",
    );
    render(
      <QueryClientProvider client={queryClient()}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <TransactionBrowser includeStaged fixedPayee={PAYEE} showDateRange={false} />
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(PAYEE)).toBeInTheDocument();
    const stagedRequestsBefore = stagedQueries.length;

    fireEvent.change(screen.getByLabelText("Search transactions"), {
      target: { value: "refund" },
    });

    // The committed list re-queried with the search term.
    await vi.waitFor(() => {
      expect(
        committedQueries.some((url) => url.searchParams.get("search") === "refund"),
      ).toBe(true);
    });

    // The staged row is still rendered even though nothing matched.
    const row = screen.getByText(PAYEE).closest("tr")!;
    expect(within(row).getByText("Staged")).toBeInTheDocument();

    // No staged request ever carried the search term.
    console.log(
      "staged URLs:",
      stagedQueries.map((url) => url.search),
      "count before/after:",
      stagedRequestsBefore,
      stagedQueries.length,
    );
    expect(stagedQueries.every((url) => !url.searchParams.get("search"))).toBe(true);

    // Pagination summary for the committed list.
    console.log(
      "pagination summary present:",
      Boolean(document.querySelector(".pagination-summary")?.textContent),
      document.querySelector(".pagination-summary")?.textContent ?? null,
    );
    console.log("table rows:", document.querySelectorAll("tbody tr").length);
  });
});
