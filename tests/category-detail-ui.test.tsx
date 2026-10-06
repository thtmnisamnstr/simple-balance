// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CategoryDetailPage from "../src/client/pages/CategoryDetailPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * `common.md`: "Zero is a value." A figure the page could not load is not
 * zero, and the category detail rendered a failed report as $0.00 — and an
 * all-time read that failed on its own showed $0.00 with no alert at all.
 */
const CATEGORY = "33333333-3333-4333-8333-333333333333";

function renderPage(allTimeFails: boolean) {
  window.history.replaceState(
    null,
    "",
    `/categories/${CATEGORY}?preset=custom&start=2026-07-01&end=2026-07-31`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === `/api/v1/categories/${CATEGORY}`) {
        return Response.json({ id: CATEGORY, name: "Groceries", kind: "expense", version: 1 });
      }
      if (url.pathname === "/api/v1/reports/categories") {
        const ranged = url.searchParams.has("start");
        if (!ranged && allTimeFails) {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "The report could not be read." } },
            { status: 500 },
          );
        }
        return Response.json({
          currencies: [{ currency: "USD", rows: [{ key: `expense:${CATEGORY}`, total: "42.50" }] }],
        });
      }
      if (url.pathname === "/api/v1/transactions") {
        return Response.json({
          items: [],
          nextCursor: null,
          page: 1,
          pageSize: 50,
          totalCount: 0,
          totalPages: 1,
          cursorAvailable: true,
        });
      }
      return Response.json([]);
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
            <Route path="/categories/:categoryId" element={<CategoryDetailPage />} />
          </Routes>
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a category's figures", () => {
  it("says a figure did not load rather than calling it zero", async () => {
    renderPage(true);
    expect(await screen.findByText("The report could not be read.")).toBeInTheDocument();
    const tiles = screen.getByRole("region", { name: "What this category holds" });
    const allTime = [...tiles.querySelectorAll("article")].find((tile) =>
      tile.textContent?.includes("All time"),
    )!;
    expect(allTime).toHaveTextContent("—");
    expect(allTime).not.toHaveTextContent("$0.00");
  });

  it("shows what did load", async () => {
    renderPage(false);
    const allTime = (await screen.findAllByText("$42.50"))[0]!;
    expect(allTime).toBeInTheDocument();
  });
});
