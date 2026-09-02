// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, PaginatedPage, StagedTransaction } from "../src/client/api.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * The queue's click-to-edit cells, at the wire.
 *
 * The queue is where imports get repaired, and the repair used to cost a trip
 * through the full modal for a one-word change. What these hold: the editor a
 * cell opens is prefilled with the draft's own value, the write it sends is
 * the same PUT the modal sends — whole draft, expected version — and the
 * fields whose answer lives elsewhere (a split's category and amount, a
 * transfer's category) offer no editor rather than a lying one.
 */
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

const groceries: Category = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Groceries",
  kind: "expense",
  version: 1,
} as Category;

const plainRow: StagedTransaction = {
  id: "33333333-3333-4333-8333-333333333333",
  draft: {
    type: "withdrawal",
    date: "2026-07-30",
    payee: "Corner shop",
    description: null,
    fromAccountId: checkingAccount.id,
    amount: "10.00",
    notes: "keep me",
  },
  validationIssues: [],
  importBatchId: null,
  version: 4,
  status: "staged",
  createdAt: "2026-07-30T12:00:00.000Z",
} as unknown as StagedTransaction;

const splitRow: StagedTransaction = {
  ...plainRow,
  id: "44444444-4444-4444-8444-444444444444",
  draft: {
    type: "withdrawal",
    date: "2026-07-29",
    payee: "Split shop",
    description: null,
    fromAccountId: checkingAccount.id,
    amount: "30.00",
    legs: [
      { categoryId: groceries.id, amount: "20.00" },
      { categoryName: "Household", amount: "10.00" },
    ],
  },
} as unknown as StagedTransaction;

function stubQueue() {
  const puts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (init?.method === "PUT") {
        puts.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        return json({});
      }
      if (
        url.pathname === "/api/v1/staged-transactions" &&
        url.searchParams.get("validity") === "duplicate"
      ) {
        return json({
          items: [],
          nextCursor: null,
          page: 1,
          pageSize: 200,
          totalCount: 0,
          cursorAvailable: false,
          totalPages: 1,
        } satisfies PaginatedPage<StagedTransaction>);
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        return json({
          items: [plainRow, splitRow],
          nextCursor: null,
          page: 1,
          pageSize: 50,
          totalCount: 2,
          cursorAvailable: false,
          totalPages: 1,
        } satisfies PaginatedPage<StagedTransaction>);
      }
      if (url.pathname === "/api/v1/import-batches") return json({ items: [], nextCursor: null });
      if (url.pathname === "/api/v1/accounts") return json([checkingAccount]);
      if (url.pathname === "/api/v1/categories") return json([groceries]);
      if (url.pathname === "/api/v1/payees/suggestions") return json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return puts;
}

function renderStaging() {
  window.history.replaceState(null, "", "/staged?start=2026-07-01&end=2026-07-31");
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("editing staged fields in place", () => {
  it("edits the payee where it is, sending the whole draft and the version", async () => {
    const puts = stubQueue();
    renderStaging();
    fireEvent.click(await screen.findByRole("button", { name: "Edit the payee of Corner shop" }));
    const editor = screen.getByPlaceholderText(/merchant, employer/i);
    expect(editor).toHaveValue("Corner shop");
    fireEvent.change(editor, { target: { value: "Corner Bakery" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.path).toBe(`/api/v1/staged-transactions/${plainRow.id}`);
    // The whole draft travels, not a patch: nothing else moved, and the
    // version is the one the row was read at.
    expect(puts[0]!.body).toEqual({
      draft: { ...(plainRow.draft as object), payee: "Corner Bakery" },
      expectedVersion: 4,
    });
  });

  it("edits the date, and Escape closes without writing", async () => {
    const puts = stubQueue();
    renderStaging();
    fireEvent.click(await screen.findByRole("button", { name: "Edit the date of Corner shop" }));
    const editor = screen.getByLabelText("Date of Corner shop");
    expect(editor).toHaveValue("2026-07-30");
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(puts).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Edit the date of Corner shop" }));
    const reopened = screen.getByLabelText("Date of Corner shop");
    fireEvent.change(reopened, { target: { value: "2026-07-15" } });
    fireEvent.keyDown(reopened, { key: "Enter" });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({
      draft: { date: "2026-07-15", payee: "Corner shop", notes: "keep me" },
      expectedVersion: 4,
    });
  });

  it("edits the amount in place", async () => {
    const puts = stubQueue();
    renderStaging();
    fireEvent.click(await screen.findByRole("button", { name: "Edit the amount of Corner shop" }));
    const editor = screen.getByLabelText("Amount of Corner shop");
    expect(editor).toHaveValue("10.00");
    fireEvent.change(editor, { target: { value: "12.50" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ draft: { amount: "12.50" }, expectedVersion: 4 });
  });

  it("edits the category to an existing one by id, clearing the name", async () => {
    const puts = stubQueue();
    renderStaging();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit the category of Corner shop" }),
    );
    const editor = screen.getByLabelText("Category of Corner shop");
    fireEvent.change(editor, { target: { value: "Groceries" } });
    // Blur, not Enter: the datalist's own pick lands on Enter, and committing
    // on the keydown raced the picked value — so blur is the commit gesture.
    fireEvent.blur(editor);
    await waitFor(() => expect(puts).toHaveLength(1));
    // The picker's contract carried through: a name that matches a live
    // category travels as its id, and the name key is settled to null so the
    // draft never holds two answers.
    expect(puts[0]!.body).toMatchObject({
      draft: { categoryId: groceries.id, categoryName: null },
      expectedVersion: 4,
    });
  });

  it("writes nothing when the value did not change", async () => {
    const puts = stubQueue();
    renderStaging();
    fireEvent.click(await screen.findByRole("button", { name: "Edit the payee of Corner shop" }));
    const editor = screen.getByPlaceholderText(/merchant, employer/i);
    // Opened and left alone: a same-value blur must not bump the version,
    // invalidate a bulk selection's fingerprint, or write an audit entry
    // saying an edit happened.
    fireEvent.blur(editor);
    await screen.findByRole("button", { name: "Edit the payee of Corner shop" });
    expect(puts).toHaveLength(0);
  });

  it("drops a stored categoryKind when the category is re-chosen inline", async () => {
    const puts = stubQueue();
    renderStaging();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit the category of Corner shop" }),
    );
    const editor = screen.getByLabelText("Category of Corner shop");
    fireEvent.change(editor, { target: { value: "Groceries" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(puts).toHaveLength(1));
    // The stored kind was somebody's answer about the OLD name; riding along
    // it would file a brand-new category on a side nobody chose here.
    expect(puts[0]!.body).toMatchObject({ draft: { categoryKind: null } });
  });

  it("offers no category or amount editor on a split", async () => {
    stubQueue();
    renderStaging();
    await screen.findByRole("button", { name: "Edit the payee of Split shop" });
    // A split's categories and total live on its legs; the modal is the only
    // honest editor for them. Date and payee still edit in place.
    expect(
      screen.queryByRole("button", { name: "Edit the category of Split shop" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit the amount of Split shop" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit the date of Split shop" })).toBeInTheDocument();
  });

  it("clones a staged row into the stage form, prefilled", async () => {
    stubQueue();
    renderStaging();
    const menu = await screen.findByRole("button", { name: "Actions for Corner shop" });
    fireEvent.click(menu);
    // Scoped to the row: a details-based menu keeps its items in the document
    // for every row, open or not.
    const row = menu.closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /clone transaction/i }));
    const dialog = await screen.findByRole("dialog", { name: "Stage a transaction" });
    // Prefilled from the source, as a new row: the payee travels, and the
    // submit button offers staging rather than saving an edit. Scoped to the
    // dialog, because the page's own header carries a Stage button too.
    expect(within(dialog).getByDisplayValue("Corner shop")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Stage transaction" })).toBeInTheDocument();
  });
});
