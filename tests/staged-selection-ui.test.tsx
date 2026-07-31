// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  PaginatedPage,
  StagedTransaction,
} from "../src/client/api.js";
import StagingPage from "../src/client/pages/StagingPage.js";
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

const checkingAccount: Account = {
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

function staged(id: string, payee: string): StagedTransaction {
  return {
    id,
    draft: {
      type: "withdrawal",
      date: "2026-07-30",
      payee,
      description: null,
      fromAccountId: checkingAccount.id,
      amount: "10.00",
    },
    validationIssues: [],
    importBatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    version: 1,
    status: "staged",
    createdAt: "2026-07-30T12:00:00.000Z",
  };
}

const pageOne = [
  staged("33333333-3333-4333-8333-333333333333", "Visible one"),
  staged("44444444-4444-4444-8444-444444444444", "Visible two"),
];
const pageTwo = [staged("55555555-5555-4555-8555-555555555555", "Offscreen")];

/** Serves a two-page staged queue and records which pages were fetched. */
function stubStagedQueue() {
  const stageCursors: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url.pathname === "/api/v1/staged-transactions") {
        const requested = url.searchParams.get("page");
        stageCursors.push(requested);
        const second = requested === "2";
        const page: PaginatedPage<StagedTransaction> = {
          items: second ? pageTwo : pageOne,
          nextCursor: null,
          page: second ? 2 : 1,
          pageSize: 2,
          totalCount: 3,
          totalPages: 2,
        };
        return json(page);
      }
      if (url.pathname === "/api/v1/import-batches") {
        return json({ items: [], nextCursor: null });
      }
      if (url.pathname === "/api/v1/accounts") return json([checkingAccount]);
      if (url.pathname === "/api/v1/categories") return json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return stageCursors;
}

function renderStaging() {
  window.history.replaceState(
    null,
    "",
    "/staged?start=2026-07-01&end=2026-07-31",
  );
  return render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <StagingPage />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

const pageCheckbox = () =>
  screen.getByRole("checkbox", {
    name: "Select all staged transactions on this page",
  }) as HTMLInputElement;
const rowCheckbox = (payee: string) =>
  screen.getByRole("checkbox", { name: `Select ${payee}` });
const selectAllMatching = () =>
  screen.queryByRole("button", { name: "Select all 3 matching" });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("staged transaction selection", () => {
  it("shows the mixed state while only part of the page is selected", async () => {
    stubStagedQueue();
    renderStaging();
    expect(await screen.findByText("Visible one")).toBeInTheDocument();

    expect(pageCheckbox().checked).toBe(false);
    expect(pageCheckbox().indeterminate).toBe(false);

    fireEvent.click(rowCheckbox("Visible one"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(pageCheckbox().checked).toBe(false);
    expect(pageCheckbox().indeterminate).toBe(true);

    fireEvent.click(rowCheckbox("Visible two"));
    expect(pageCheckbox().checked).toBe(true);
    expect(pageCheckbox().indeterminate).toBe(false);
  });

  it("selects only the rows on the page without fetching the rest", async () => {
    const stageCursors = stubStagedQueue();
    renderStaging();
    expect(await screen.findByText("Visible one")).toBeInTheDocument();

    fireEvent.click(pageCheckbox());

    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.queryByText("Offscreen")).not.toBeInTheDocument();
    expect(stageCursors.filter((requested) => requested === "2")).toHaveLength(
      0,
    );
  });

  it("offers whole-list selection whenever the list runs past the page", async () => {
    stubStagedQueue();
    renderStaging();
    expect(await screen.findByText("Visible one")).toBeInTheDocument();

    // Nothing is selected yet, so the bulk bar is hidden entirely.
    expect(selectAllMatching()).not.toBeInTheDocument();

    fireEvent.click(rowCheckbox("Visible one"));
    // A partial page selection can still be widened to the whole list.
    expect(selectAllMatching()).toBeInTheDocument();
  });

  it("extends the selection across every remaining page", async () => {
    const stageCursors = stubStagedQueue();
    renderStaging();
    expect(await screen.findByText("Visible one")).toBeInTheDocument();

    fireEvent.click(pageCheckbox());
    fireEvent.click(selectAllMatching()!);

    expect(
      await screen.findByText("All 3 matching staged transactions selected"),
    ).toBeInTheDocument();
    // The page on screen never moves, so the offscreen row stays offscreen.
    expect(screen.queryByText("Offscreen")).not.toBeInTheDocument();
    expect(stageCursors.filter((requested) => requested === "2")).toHaveLength(
      1,
    );
    // Everything matching is already held, so the escalation is withdrawn.
    expect(selectAllMatching()).not.toBeInTheDocument();
  });

  it("keeps rows selected on other pages when paging", async () => {
    stubStagedQueue();
    renderStaging();
    expect(await screen.findByText("Visible one")).toBeInTheDocument();

    fireEvent.click(pageCheckbox());
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(await screen.findByText("Offscreen")).toBeInTheDocument();

    // The two rows from page one are still selected even though they are gone.
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(pageCheckbox().checked).toBe(false);
    expect(pageCheckbox().indeterminate).toBe(false);
  });

  it("clears the selection", async () => {
    stubStagedQueue();
    renderStaging();
    expect(await screen.findByText("Visible one")).toBeInTheDocument();

    fireEvent.click(pageCheckbox());
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
    expect(pageCheckbox().checked).toBe(false);
    expect(pageCheckbox().indeterminate).toBe(false);
  });
});
