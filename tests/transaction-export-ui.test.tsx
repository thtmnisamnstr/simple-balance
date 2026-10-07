// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaginatedPage, Transaction } from "../src/client/api.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * `csv.md` §12: an export over its cap is refused with a sentence naming the
 * remedy. The button was a plain link, so that sentence arrived as a page of
 * raw JSON in place of the app, and so did the 401 of a session that had
 * lapsed. Fetched, a refusal is shown where the person is and nothing leaves
 * the page.
 */
const emptyPage: PaginatedPage<Transaction> = {
  items: [],
  nextCursor: null,
  page: 1,
  pageSize: 50,
  totalCount: 0,
  cursorAvailable: false,
  totalPages: 1,
};

function renderBrowser(onExport: () => Response) {
  window.history.replaceState(null, "", "/transactions?start=2026-07-01&end=2026-07-31");
  const fetched = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/v1/csv/export") return onExport();
    if (url.pathname === "/api/v1/transactions") return Response.json(emptyPage);
    return Response.json([]);
  });
  vi.stubGlobal("fetch", fetched);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser
            heading={{ kind: "section", title: "Transactions", description: "For this test." }}
          />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
  return fetched;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exporting the transactions in view", () => {
  it("shows a refused export in the page, with the sentence that names the way out", async () => {
    renderBrowser(() =>
      Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message:
              "Export exceeds 100,000 rows. Narrow it with a start and end date and export one range at a time.",
            details: { limit: 100_000 },
          },
        },
        { status: 422 },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Export CSV/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was exported.");
    expect(alert).toHaveTextContent("Narrow it with a start and end date");
    expect(window.location.pathname).toBe("/transactions");
  });

  it("saves the file under the name the server gave it", async () => {
    const created = vi.fn(() => "blob:export");
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    const fetched = renderBrowser(
      () =>
        new Response("simple_balance_format\r\n", {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="transactions-2026-07-31.csv"',
          },
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Export CSV/ }));
    await waitFor(() => expect(clicked).toEqual(["transactions-2026-07-31.csv"]));
    expect(created).toHaveBeenCalledOnce();
    // The view's own filters, so the file is the list on screen.
    const exported = fetched.mock.calls
      .map(([input]) => new URL(String(input), window.location.origin))
      .find((url) => url.pathname === "/api/v1/csv/export");
    expect(exported?.searchParams.get("start")).toBe("2026-07-01");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
