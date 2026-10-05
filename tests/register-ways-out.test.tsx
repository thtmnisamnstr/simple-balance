// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, PaginatedPage, StagedTransaction, Transaction } from "../src/client/api.js";
import { noAccountReason } from "../src/client/list-filters.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * The register's empty screen names every control that is keeping rows off it.
 *
 * `web.md` 12.1, and `list-filters.ts`'s own contract: a filter is only what the
 * reader can reach, and **a control that is in force before anybody touches it
 * names a way out without making the list narrowed**. The register's bar
 * carries four narrowing controls and the `emptyScreen` call named three. The
 * fourth is "Show deleted", which ships off and is sent as
 * `includeDeleted: undefined`, so it hides rows before anybody touches it.
 *
 * `AGENTS.md`: "Deleting voids an entry by posting its reversal" — the rows are
 * still there and the view is hiding them. So somebody who deleted everything
 * matching the view was told "No transactions yet" and sent off to add a
 * transaction, with no mention of the one checkbox on screen that would show
 * the rows they were looking for. That is word for word the defect 12.1
 * records against Accounts, on the busiest list in the product, reached from
 * five pages.
 *
 * `tests/ui-copy.test.ts` passes on this and says so itself: it reads the
 * `emptyScreen` call's own text and asks that three things are absent from it,
 * so a filter left out is invisible to it. This renders the screen instead.
 */
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

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function stub({ accountsFail = false } = {}) {
  const transactionQueries: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      const empty = {
        items: [],
        nextCursor: null,
        page: 1,
        pageSize: 50,
        totalCount: 0,
        cursorAvailable: false,
        totalPages: 1,
      };
      if (url.pathname === "/api/v1/transactions") {
        transactionQueries.push(url);
        return json(empty satisfies PaginatedPage<Transaction>);
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        return json(empty satisfies PaginatedPage<StagedTransaction>);
      }
      if (url.pathname === "/api/v1/accounts") {
        return accountsFail
          ? new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Down" } }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            })
          : json([account]);
      }
      if (url.pathname === "/api/v1/categories") return json([]);
      if (url.pathname === "/api/v1/payees/suggestions") return json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return transactionQueries;
}

function renderRegister() {
  window.history.replaceState(null, "", "/transactions?preset=all-time");
  return render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser
            heading={{ kind: "section", title: "Transactions", description: "For this test." }}
          />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the register's empty screen", () => {
  it("names Show deleted as a way out while it is hiding rows", async () => {
    stub();
    renderRegister();

    // Not "No transactions match this view": a default in force is not a filter
    // the reader set, and reading it as one would put "nothing yet" out of
    // reach on a ledger that really is empty.
    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    expect(screen.getByText(/turn on Show deleted/i)).toBeInTheDocument();
  });

  it("says nothing yet once the reader has turned it on", async () => {
    stub();
    renderRegister();

    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show deleted"));

    // Nothing is in force now, so the third of 12.1's three reads applies and
    // the screen is the constructive one.
    expect(await screen.findByText("No transactions yet")).toBeInTheDocument();
    expect(screen.queryByText(/turn on Show deleted/i)).toBeNull();
  });

  it("keeps it a way out rather than a reason to say nothing matches", async () => {
    stub();
    renderRegister();

    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter by type"), { target: { value: "deposit" } });

    // A filter the reader set decides the screen; the default rides along as a
    // second way out rather than deciding anything.
    expect(await screen.findByText("No transactions match this view")).toBeInTheDocument();
    expect(screen.getByText(/clear the type filter/i)).toBeInTheDocument();
    expect(screen.getByText(/turn on Show deleted/i)).toBeInTheDocument();
  });
});

describe("the Add button when the accounts did not load", () => {
  it("says they did not load, rather than that there are none", async () => {
    // It said "Create an account first." to somebody whose accounts merely
    // failed to arrive, which is a false sentence on a disabled button.
    stub({ accountsFail: true });
    renderRegister();
    const add = await screen.findByRole("button", { name: /Add transaction/ });
    await waitFor(() =>
      expect(add).toHaveAccessibleDescription(noAccountReason({ isPending: false, isError: true })),
    );
    expect(noAccountReason({ isPending: false, isError: false })).toBe("Create an account first.");
    expect(noAccountReason({ isPending: true, isError: false })).toBeUndefined();
  });
});
