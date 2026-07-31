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
import type { Category, CategoryMergeResult } from "../src/client/api.js";
import CategoriesPage from "../src/client/pages/CategoriesPage.js";
import { BrowserRouter } from "../src/client/router.js";

const groceries: Category = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Groceries",
  kind: "expense",
  version: 2,
};

const grocery: Category = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Grocery",
  kind: "expense",
  version: 4,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("category merging", () => {
  it("lets the selected categories become either the source or target", async () => {
    let mergeBody: Record<string, unknown> | undefined;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/categories/duplicates") {
          return Response.json([]);
        }
        if (
          url.pathname === "/api/v1/categories/merge" &&
          init?.method === "POST"
        ) {
          mergeBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          const result: CategoryMergeResult = {
            targetCategory: { ...groceries, version: 3 },
            mergedSourceCategoryIds: [grocery.id],
            updatedTransactionCount: 0,
            updatedStagedTransactionCount: 0,
          };
          return Response.json(result);
        }
        if (url.pathname === "/api/v1/categories") {
          return Response.json([groceries, grocery]);
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <CategoriesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: `Select ${groceries.name} for merging`,
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: `Select ${grocery.name} for merging`,
      }),
    );

    const target = screen.getByRole("combobox", { name: "Category to keep" });
    expect(
      within(target).getByRole("option", { name: groceries.name }),
    ).toBeInTheDocument();
    expect(
      within(target).getByRole("option", { name: grocery.name }),
    ).toBeInTheDocument();

    const mergeButton = screen.getByRole("button", { name: "Merge" });
    expect(mergeButton).toBeDisabled();
    fireEvent.change(target, { target: { value: groceries.id } });
    expect(mergeButton).toBeEnabled();
    fireEvent.click(mergeButton);

    await waitFor(() => {
      expect(mergeBody).toEqual({
        sourceCategoryIds: [grocery.id],
        targetCategoryId: groceries.id,
        expectedVersions: { [grocery.id]: grocery.version },
        targetExpectedVersion: groceries.version,
      });
    });
  });
});
