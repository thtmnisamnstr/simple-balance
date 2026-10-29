// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PayeeDuplicateGroup, PayeeMergeResult, PayeeSummary } from "../src/client/api.js";
import PayeesPage from "../src/client/pages/PayeesPage.js";
import { BrowserRouter } from "../src/client/router.js";

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
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("payee browsing and merging", () => {
  it("uses selected payees as merge participants and keeps either one", async () => {
    window.history.replaceState(null, "", "/payees?start=2026-07-01&end=2026-07-31&preset=custom");
    let mergeBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/payees/duplicates") {
          return Response.json([]);
        }
        if (url.pathname === "/api/v1/payees/merge" && init?.method === "POST") {
          mergeBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          const result: PayeeMergeResult = {
            targetPayee: acmeMarket.name,
            mergedSourcePayees: [acmeMarkets.name],
            updatedTransactionCount: 2,
            updatedStagedTransactionCount: 0,
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

    const payeeLink = await screen.findByRole("link", {
      name: acmeMarket.name,
    });
    const detailUrl = new URL(payeeLink.getAttribute("href")!, window.location.origin);
    expect(detailUrl.pathname).toBe("/payees/transactions");
    expect(detailUrl.searchParams.get("name")).toBe(acmeMarket.name);
    expect(detailUrl.searchParams.get("start")).toBe("2026-07-01");
    expect(detailUrl.searchParams.get("end")).toBe("2026-07-31");
    expect(detailUrl.searchParams.get("preset")).toBe("custom");

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: `Select ${acmeMarket.name} for merging`,
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: `Select ${acmeMarkets.name} for merging`,
      }),
    );

    const target = screen.getByRole("combobox", { name: "Payee to keep" });
    expect(within(target).getByRole("option", { name: acmeMarket.name })).toBeInTheDocument();
    expect(within(target).getByRole("option", { name: acmeMarkets.name })).toBeInTheDocument();

    const mergeButton = screen.getByRole("button", { name: "Merge" });
    expect(mergeButton).toBeDisabled();
    fireEvent.change(target, { target: { value: acmeMarket.name } });
    expect(mergeButton).toBeEnabled();
    fireEvent.click(mergeButton);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /Merge these payees/ })).getByRole(
        "button",
        { name: "Merge payees" },
      ),
    );

    await waitFor(() => {
      expect(mergeBody).toEqual({
        sourcePayees: [acmeMarkets.name],
        targetPayee: acmeMarket.name,
        idempotencyKey: expect.any(String),
      });
    });
  });

  it("preselects every duplicate and keeps the payee the server put first", async () => {
    // The order the server sends: most used first, and on a tie the spelling
    // that is already tidy. The page takes the first entry rather than ranking
    // again, because a second copy of that rule here is a second answer, and
    // the shorter one it used to apply offered an untrimmed name as the target.
    const duplicateGroup: PayeeDuplicateGroup = {
      normalizedName: "acme market",
      count: 2,
      payees: [acmeMarket, acmeMarkets],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/payees/duplicates") {
          return Response.json([duplicateGroup]);
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

    const review = await screen.findByRole("button", { name: "Review merge" });
    // A standing condition, drawn as a list rather than as a status region per
    // group (`web.md` 12.4): five groups were five live regions. The names are
    // the button's description, which is what tells one "Review merge" from
    // the next.
    const section = screen.getByRole("region", { name: "Duplicate payees" });
    expect(within(section).queryAllByRole("status")).toEqual([]);
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(review).toHaveAccessibleDescription(`${acmeMarket.name}, ${acmeMarkets.name}`);
    fireEvent.click(review);

    expect(
      screen.getByRole("checkbox", {
        name: `Select ${acmeMarket.name} for merging`,
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: `Select ${acmeMarkets.name} for merging`,
      }),
    ).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Payee to keep" })).toHaveValue(acmeMarket.name);
    expect(screen.getByRole("button", { name: "Merge" })).toBeEnabled();
  });
});

/**
 * The page narrows its list with `list_payees`' own predicate, so a person and
 * an agent searching one ledger find the same spellings. It lower-cased the
 * spelling as typed, and a doubled space or a full-width letter found a payee
 * over MCP and missed it here.
 */
describe("searching payees", () => {
  const wide: PayeeSummary = {
    name: "ACME  Co",
    normalizedName: "acme co",
    transactionCount: 1,
    stagedTransactionCount: 0,
    totalCount: 1,
  };

  it("matches as the server does, on the name's normalized form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/payees/duplicates") return Response.json([]);
        if (url.pathname === "/api/v1/payees") return Response.json([acmeMarket, wide]);
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
    await screen.findByRole("link", { name: acmeMarket.name });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search payees" }), {
      target: { value: " acme co " },
    });
    await waitFor(() => expect(screen.queryByRole("link", { name: acmeMarket.name })).toBeNull());
    // An accessible name collapses the doubled space, as a screen reader does.
    expect(screen.getByRole("link", { name: "ACME Co" })).toBeInTheDocument();

    // Typed with one space, the doubled spelling is still found.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search payees" }), {
      target: { value: "ACME CO" },
    });
    expect(await screen.findByRole("link", { name: "ACME Co" })).toBeInTheDocument();
  });
});
