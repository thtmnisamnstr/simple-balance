// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/**
 * The rows the queue holds, in the order it walks them. Served as a real page
 * because the review screen reads its own position out of it: without it there
 * is no "3 of 11" and nowhere for Next to go.
 */
function stub(
  review: StagedDuplicateReview | null,
  queueIds: string[] = ["staged-1"],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/duplicate")) {
        return review
          ? Response.json(review)
          : Response.json({ error: { code: "NOT_FOUND", message: "gone" } }, { status: 404 });
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        // Only the duplicate listing is the queue. Anything else asking this
        // path is a different question and gets nothing.
        if (url.searchParams.get("validity") !== "duplicate") {
          return Response.json({
            items: [], page: 1, pageSize: 50, totalCount: 0, totalPages: 0, nextCursor: null,
          });
        }
        return Response.json({
          items: queueIds.map((id) => ({ ...stagedSide.staged, id })),
          page: 1,
          pageSize: 200,
          totalCount: queueIds.length,
          totalPages: 1,
          nextCursor: null,
        });
      }
      if (url.pathname === "/api/v1/accounts") return Response.json(accounts);
      if (url.pathname === "/api/v1/categories") return Response.json(categories);
      return Response.json([]);
    }),
  );
}

function renderReview(path = "/staged/duplicates/staged-1") {
  window.history.replaceState(null, "", path);
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
            <Route path="/staged/duplicates" element={<DuplicateReviewPage />} />
            <Route
              path="/staged/duplicates/:id"
              element={<DuplicateReviewPage />}
            />
            <Route path="/staged" element={<p>The queue itself</p>} />
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

  /**
   * The page is about one staged row. Dropping it used to leave the page asking
   * for a review of a row that no longer exists, so a successful drop ended on a
   * red "Staged transaction not found" — the success looking exactly like a
   * failure. It now moves on instead, which is also the whole point of a queue.
   */
  it("moves to the next one when the row it is about is dropped", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview, [
      "staged-1",
      "staged-2",
      "staged-3",
    ]);
    renderReview();
    await screen.findByLabelText("Staged row under review");

    fireEvent.click(screen.getByRole("button", { name: /drop this staged row/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Drop it" }));

    await vi.waitFor(() =>
      expect(window.location.pathname).toBe("/staged/duplicates/staged-2"),
    );
    expect(screen.queryByText(/not found/i)).toBeNull();
    // The next comparison is actually on screen. Checking only the address let a
    // blank page through: the instruction to move on was held as a bare path, so
    // on arriving it was still set and sent the page to the same place again,
    // rendering nothing at all.
    expect(
      await screen.findByLabelText("Staged row under review"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/possible duplicate 2 of 3/i)).toBeInTheDocument();
  });

  it("says the run is finished when the last one is dropped", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview);
    renderReview();
    await screen.findByLabelText("Staged row under review");

    fireEvent.click(screen.getByRole("button", { name: /drop this staged row/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Drop it" }));

    // Not bounced silently back to the list: the run ended, and it says so.
    expect(
      await screen.findByText(/no duplicates left to review/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  it("says which one of how many is on screen", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview, [
      "staged-0",
      "staged-1",
      "staged-2",
    ]);
    renderReview();
    expect(
      await screen.findByText(/possible duplicate 2 of 3/i),
    ).toBeInTheDocument();
  });

  /**
   * The badge on one row is still there, but it is not the only way in. Walking
   * the whole list is what turns this from a screen you land on into a queue you
   * work through.
   */
  it("walks the queue forwards and back", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview, [
      "staged-0",
      "staged-1",
      "staged-2",
    ]);
    renderReview();
    await screen.findByLabelText("Staged row under review");

    fireEvent.click(screen.getByRole("link", { name: /next/i }));
    await vi.waitFor(() =>
      expect(window.location.pathname).toBe("/staged/duplicates/staged-2"),
    );

    fireEvent.click(screen.getByRole("link", { name: /previous/i }));
    await vi.waitFor(() =>
      expect(window.location.pathname).toBe("/staged/duplicates/staged-1"),
    );
  });

  it("stops offering a step past either end", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview);
    renderReview();
    await screen.findByLabelText("Staged row under review");

    // The only one in the queue, so neither step exists. Rendered disabled
    // rather than as a link to nowhere, which would still take focus.
    expect(screen.queryByRole("link", { name: /^next/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /^previous/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^next/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^previous/i })).toBeDisabled();
  });

  it("starts at the first one when it is entered without naming a row", async () => {
    stub({ first: stagedSide, second: committedSide } as StagedDuplicateReview, [
      "staged-7",
      "staged-8",
    ]);
    renderReview("/staged/duplicates");

    await vi.waitFor(() =>
      expect(window.location.pathname).toBe("/staged/duplicates/staged-7"),
    );
  });

  it("says so when there is nothing to review at all", async () => {
    stub(null, []);
    renderReview("/staged/duplicates");

    expect(
      await screen.findByText(/no duplicates left to review/i),
    ).toBeInTheDocument();
    // It did not send anybody to a comparison of nothing.
    expect(window.location.pathname).toBe("/staged/duplicates");
  });

  it("offers the next one when this row has stopped repeating anything", async () => {
    stub({ first: stagedSide, second: null } as StagedDuplicateReview, [
      "staged-1",
      "staged-2",
    ]);
    renderReview();

    await screen.findByText(/nothing repeats this any more/i);
    fireEvent.click(screen.getByRole("link", { name: /next duplicate/i }));
    await vi.waitFor(() =>
      expect(window.location.pathname).toBe("/staged/duplicates/staged-2"),
    );
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
