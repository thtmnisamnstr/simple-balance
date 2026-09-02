// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategorySummary } from "../src/client/api.js";
import CategoriesPage from "../src/client/pages/CategoriesPage.js";
import { BrowserRouter } from "../src/client/router.js";

const summary = (
  id: string,
  name: string,
  transactionCount: number,
  stagedTransactionCount: number,
  extra: Partial<CategorySummary> = {},
): CategorySummary => ({
  id,
  name,
  kind: "expense",
  version: 1,
  transactionCount,
  stagedTransactionCount,
  totalCount: transactionCount + stagedTransactionCount,
  ...extra,
});

const groceries = summary("11111111-1111-4111-8111-111111111111", "Groceries", 4, 1);
const rent = summary("22222222-2222-4222-8222-222222222222", "Rent", 1, 0);
const unused = summary("33333333-3333-4333-8333-333333333333", "Unused", 0, 0);
const salary = summary("44444444-4444-4444-8444-444444444444", "Salary", 2, 7, {
  kind: "income",
});

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function stubCategories(rows: CategorySummary[]) {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/categories/duplicates") return Response.json([]);
      if (url.pathname === "/api/v1/categories/summaries") {
        requested.push(url.search);
        return Response.json(rows);
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return requested;
}

function renderCategories() {
  window.history.replaceState(null, "", "/categories");
  render(
    <QueryClientProvider client={queryClient()}>
      <BrowserRouter>
        <CategoriesPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const rowFor = (name: string) => screen.getByText(name).closest(".category-row") as HTMLElement;

const listedNames = () =>
  screen
    .getAllByRole("link")
    .map((link) => link.textContent)
    .filter((text): text is string => Boolean(text));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("how much each category is used", () => {
  it("splits the count into committed and staged, and totals them", async () => {
    stubCategories([groceries, rent]);
    renderCategories();

    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    const row = within(rowFor("Groceries"));
    expect(row.getByText(/4 committed · 1 staged/)).toBeInTheDocument();
    expect(row.getByText("5 transactions")).toBeInTheDocument();
  });

  it("says one transaction rather than one transactions", async () => {
    stubCategories([rent]);
    renderCategories();

    expect(await screen.findByText("1 transaction")).toBeInTheDocument();
    expect(screen.queryByText("1 transactions")).not.toBeInTheDocument();
  });

  // The row somebody opened this page to find. A count query that inner-joined
  // would drop it, and the page would quietly stop listing categories.
  it("still lists a category nothing has been filed under", async () => {
    stubCategories([groceries, unused]);
    renderCategories();

    expect(await screen.findByText("Unused")).toBeInTheDocument();
    const row = within(rowFor("Unused"));
    expect(row.getByText(/0 committed · 0 staged/)).toBeInTheDocument();
    expect(row.getByText("0 transactions")).toBeInTheDocument();
  });

  /**
   * The badge column is hidden on a narrow screen, so anything that lives only
   * in a badge is invisible there. The counts and the kind both have to be in
   * the first column's subtitle to survive.
   */
  it("keeps the kind alongside the counts, where a narrow screen can still read it", async () => {
    stubCategories([salary]);
    renderCategories();

    expect(await screen.findByText("Salary")).toBeInTheDocument();
    const row = within(rowFor("Salary"));
    expect(row.getByText(/Income · 2 committed · 7 staged/)).toBeInTheDocument();
  });

  it("orders by whichever count is asked for", async () => {
    stubCategories([groceries, rent, unused, salary]);
    renderCategories();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();

    const sortBy = screen.getByRole("combobox", { name: "Sort by" });
    fireEvent.change(sortBy, { target: { value: "total" } });
    // Ascending: 0, 1, 5, 9.
    expect(listedNames()).toEqual(["Unused", "Rent", "Groceries", "Salary"]);

    fireEvent.change(sortBy, { target: { value: "staged" } });
    // Ascending: 0, 0, 1, 7. Ties fall back to name.
    expect(listedNames()).toEqual(["Rent", "Unused", "Groceries", "Salary"]);

    fireEvent.change(sortBy, { target: { value: "committed" } });
    // Ascending: 0, 1, 2, 4.
    expect(listedNames()).toEqual(["Unused", "Rent", "Salary", "Groceries"]);
  });

  it("asks the server for archived rows rather than filtering them out here", async () => {
    const requested = stubCategories([groceries]);
    renderCategories();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(requested).toEqual([""]);

    fireEvent.click(screen.getByRole("checkbox", { name: /Show archived/ }));
    await screen.findByText("Groceries");
    expect(requested).toContain("?includeArchived=true");
  });
});
