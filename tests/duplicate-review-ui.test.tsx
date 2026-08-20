// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StagedDuplicateReview } from "../src/client/api.js";
import DuplicateReviewPage from "../src/client/pages/DuplicateReviewPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const accounts = [
  {
    id: "acc-1",
    name: "Checking",
    type: "checking",
    currency: "USD",
    openingDate: "2026-01-01",
    openingBalance: "0",
    version: 1,
    balance: "0",
    balancePresentation: { label: "Balance", amount: "0" },
  },
];
const categories = [
  { id: "cat-1", name: "Groceries", kind: "expense", version: 1 },
  { id: "cat-2", name: "Coffee", kind: "expense", version: 1 },
];

const stagedSide = {
  kind: "staged" as const,
  staged: {
    id: "staged-1",
    draft: {
      type: "withdrawal",
      date: "2026-03-12",
      payee: "Blue Bottle Coffee",
      amount: "42.50",
      fromAccountId: "acc-1",
      categoryId: "cat-2",
    },
    validationIssues: [],
    version: 1,
    status: "staged" as const,
    createdAt: "2026-03-12T00:00:00.000Z",
  },
  committed: null,
};

const committedSide = {
  kind: "committed" as const,
  staged: null,
  committed: {
    id: "tx-1",
    type: "withdrawal" as const,
    date: "2026-03-10",
    payee: "SQ *BLUE BOTTLE",
    description: null,
    categoryId: "cat-1",
    sourceAccountId: "acc-1",
    sourceAmount: "42.5",
    sourceCurrency: "USD",
    legs: [],
    version: 3,
  },
};

function stub(review: StagedDuplicateReview) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/duplicate")) return Response.json(review);
      if (url.pathname === "/api/v1/accounts") return Response.json(accounts);
      if (url.pathname === "/api/v1/categories") return Response.json(categories);
      return Response.json([]);
    }),
  );
}

function renderReview() {
  window.history.replaceState(null, "", "/staged/duplicates/staged-1");
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
            <Route
              path="/staged/duplicates/:id"
              element={<DuplicateReviewPage />}
            />
          </Routes>
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("reviewing two records of one payment", () => {
  it("opens both sides for editing", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview);
    renderReview();
    await screen.findByLabelText("Staged row under review");
    expect(screen.getByLabelText("Committed transaction")).toBeInTheDocument();
    // Each side carries its own form, so each saves on its own.
    expect(screen.getAllByRole("button", { name: /save changes/i })).toHaveLength(
      2,
    );
  });

  /**
   * The way out of a duplicate is to drop the copy that has not been recorded
   * yet, so the committed side offers no delete at all rather than one that
   * refuses.
   */
  it("offers a drop on the staged side only", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview);
    renderReview();
    await screen.findByLabelText("Staged row under review");
    expect(
      screen.getAllByRole("button", { name: /drop this staged row/i }),
    ).toHaveLength(1);
    expect(
      screen.getByLabelText("Committed transaction").textContent,
    ).toMatch(/not dropped from here/i);
  });

  it("offers a drop on each side when both are staged", async () => {
    const older = {
      ...stagedSide,
      staged: { ...stagedSide.staged, id: "staged-0", version: 2 },
    };
    stub({ first: stagedSide, second: older } as StagedDuplicateReview);
    renderReview();
    await screen.findByLabelText("Staged row under review");
    expect(
      screen.getAllByRole("button", { name: /drop this staged row/i }),
    ).toHaveLength(2);
  });

  it("says so when nothing repeats the row any more", async () => {
    stub({ first: stagedSide, second: null } as StagedDuplicateReview);
    renderReview();
    await screen.findByText(/nothing repeats this any more/i);
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
  });

  it("shows each side's own figures rather than a diff", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview);
    renderReview();
    await screen.findByLabelText("Staged row under review");
    expect(screen.getByDisplayValue("Blue Bottle Coffee")).toBeInTheDocument();
    expect(screen.getByDisplayValue("SQ *BLUE BOTTLE")).toBeInTheDocument();
    expect(screen.getByLabelText("Staged row under review").textContent).toMatch(
      /waiting in the queue/i,
    );
    expect(screen.getByLabelText("Committed transaction").textContent).toMatch(
      /already recorded/i,
    );
  });
});
