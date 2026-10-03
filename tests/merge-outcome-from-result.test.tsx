// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CategoryMergeResult,
  CategorySummary,
  PayeeMergeResult,
  PayeeSummary,
} from "../src/client/api.js";
import CategoriesPage from "../src/client/pages/CategoriesPage.js";
import PayeesPage from "../src/client/pages/PayeesPage.js";
import { BrowserRouter } from "../src/client/router.js";

/**
 * What a merge reports is read off the merge's own answer.
 *
 * `web.md` 11.9 is Binding: a field the server computes and the page drops is
 * an answer somebody is not getting, and it fails silently because the page
 * renders fine without it. Both merge results carry three fields —
 * `mergedSource*`, `updatedTransactionCount`, `updatedStagedTransactionCount` —
 * and neither page's `onSuccess` took an argument at all. The sentence was
 * built from the REQUEST: `sourceCategories.length` on one,
 * `selectedPayees.length - 1` on the other.
 *
 * Two defects in one. The answer nobody was getting is how much of the ledger
 * just moved: "9 categories folded" says nothing about the 1,284 transactions
 * and 40 staged rows that were rewritten, which is the figure somebody wants
 * before they go looking for damage. And a count derived from the request is
 * wrong whenever the server folded fewer than were asked for — an idempotent
 * replay of the same key, or a source another tab had already folded — so the
 * one message shown after an irreversible write was the one figure not read
 * from that write's own result.
 *
 * Both tests answer a merge of two with a result naming ONE source and a
 * different target name, because a result that agrees with the request cannot
 * tell the two sources apart.
 */
const groceries: CategorySummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Groceries",
  kind: "expense",
  version: 2,
  transactionCount: 6,
  stagedTransactionCount: 0,
  totalCount: 6,
};

const grocery: CategorySummary = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Grocery",
  kind: "expense",
  version: 4,
  transactionCount: 1,
  stagedTransactionCount: 2,
  totalCount: 3,
};

const acmeMarket: PayeeSummary = {
  name: "Acme Market",
  normalizedName: "acme market",
  transactionCount: 4,
  stagedTransactionCount: 1,
  totalCount: 5,
};

const acmeMarkets: PayeeSummary = {
  name: "ACME MARKET",
  normalizedName: "acme market",
  transactionCount: 2,
  stagedTransactionCount: 0,
  totalCount: 2,
};

function queryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("what a merge says it did", () => {
  it("counts the categories the server folded and the rows it rewrote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/categories/duplicates") return Response.json([]);
        if (url.pathname === "/api/v1/categories/merge" && init?.method === "POST") {
          const result: CategoryMergeResult = {
            // A name the request never named, so a sentence quoting the
            // request's target reads differently from one quoting the answer.
            targetCategory: { ...groceries, name: "Food", version: 3 },
            mergedSourceCategoryIds: [grocery.id],
            updatedTransactionCount: 1284,
            updatedStagedTransactionCount: 40,
          };
          return Response.json(result);
        }
        if (url.pathname === "/api/v1/categories/summaries") {
          return Response.json([groceries, grocery]);
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    render(
      <QueryClientProvider client={queryClient()}>
        <BrowserRouter>
          <CategoriesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("checkbox", { name: `Select ${groceries.name} for merging` }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${grocery.name} for merging` }));
    fireEvent.change(screen.getByRole("combobox", { name: "Category to keep" }), {
      target: { value: groceries.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /Merge these categories/ })).getByRole(
        "button",
        { name: "Merge" },
      ),
    );

    const notice = await screen.findByText(/folded into/);
    expect(notice).toHaveTextContent("1 category folded into “Food”");
    expect(notice).toHaveTextContent("1284 committed entries");
    expect(notice).toHaveTextContent("40 staged rows");
  });

  it("counts the spellings the server folded and the rows it rewrote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/payees/duplicates") return Response.json([]);
        if (url.pathname === "/api/v1/payees/merge" && init?.method === "POST") {
          const result: PayeeMergeResult = {
            targetPayee: "Acme Co",
            mergedSourcePayees: [acmeMarkets.name],
            updatedTransactionCount: 2,
            updatedStagedTransactionCount: 1,
          };
          return Response.json(result);
        }
        if (url.pathname === "/api/v1/payees") {
          return Response.json([acmeMarket, acmeMarkets]);
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    render(
      <QueryClientProvider client={queryClient()}>
        <BrowserRouter>
          <PayeesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("checkbox", { name: `Select ${acmeMarket.name} for merging` }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Select ${acmeMarkets.name} for merging` }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Payee to keep" }), {
      target: { value: acmeMarket.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /Merge these payees/ })).getByRole(
        "button",
        { name: "Merge" },
      ),
    );

    const notice = await screen.findByText(/folded into/);
    expect(notice).toHaveTextContent("1 spelling folded into “Acme Co”");
    expect(notice).toHaveTextContent("2 committed entries");
    expect(notice).toHaveTextContent("1 staged row");
  });
});
