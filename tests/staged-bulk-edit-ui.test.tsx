// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  Category,
  PaginatedPage,
  StagedBulkEditResult,
  StagedTransaction,
} from "../src/client/api.js";
import type { StagedDraft } from "../src/shared/domain.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const checking: Account = {
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

const savings: Account = {
  ...checking,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Savings",
};

const archivedAccount: Account = {
  ...checking,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Old account",
  archivedAt: "2026-01-01T00:00:00.000Z",
};

const groceries: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

function staged(
  id: string,
  draft: StagedDraft,
  version = 1,
  validationIssues: StagedTransaction["validationIssues"] = [],
): StagedTransaction {
  return {
    id,
    draft,
    validationIssues,
    importBatchId: null,
    version,
    status: "staged",
    createdAt: "2026-07-30T12:00:00.000Z",
  };
}

const withdrawal = staged(
  "44444444-4444-4444-8444-444444444444",
  {
    type: "withdrawal",
    date: "2026-07-30",
    payee: "Market",
    fromAccountId: checking.id,
    amount: "10.00",
  },
  3,
);

const deposit = staged(
  "55555555-5555-4555-8555-555555555555",
  {
    type: "deposit",
    date: "2026-07-29",
    payee: "Employer",
    toAccountId: checking.id,
    amount: "1000.00",
  },
  7,
);

const transfer = staged("66666666-6666-4666-8666-666666666666", {
  type: "transfer",
  date: "2026-07-28",
  payee: "To savings",
  fromAccountId: checking.id,
  toAccountId: savings.id,
  amount: "25.00",
});

// The row a parser could not read: it kept what it managed and nothing else.
const untyped = staged(
  "77777777-7777-4777-8777-777777777777",
  { date: "2026-07-27", payee: "Unreadable line" },
  2,
  [{ field: "type", message: "Type is required" }],
);

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const bulkResult = (updatedCount: number): StagedBulkEditResult => ({
  dryRun: false,
  updatedCount,
  validCount: updatedCount,
  invalidCount: 0,
  items: [],
});

/** Serves one page of the queue and records every bulk-edit body sent. */
function stubQueue(
  rows: StagedTransaction[],
  onBulkEdit: () => Response = () => jsonResponse(bulkResult(rows.length)),
) {
  const bulkBodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/staged-transactions") {
        const page: PaginatedPage<StagedTransaction> = {
          items: rows,
          nextCursor: null,
          page: 1,
          pageSize: rows.length,
          totalCount: rows.length,
          cursorAvailable: false,
          totalPages: 1,
        };
        return jsonResponse(page);
      }
      if (url.pathname === "/api/v1/staged-transactions/bulk-edit") {
        bulkBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return onBulkEdit();
      }
      if (url.pathname === "/api/v1/import-batches") {
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.pathname === "/api/v1/accounts") {
        return jsonResponse([checking, savings, archivedAccount]);
      }
      if (url.pathname === "/api/v1/categories") return jsonResponse([groceries]);
      if (url.pathname === "/api/v1/payees/suggestions") return jsonResponse([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return bulkBodies;
}

function renderStaging() {
  window.history.replaceState(null, "", "/staged?start=2026-07-01&end=2026-07-31");
  render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <StagingPage />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

const select = (payee: string) =>
  fireEvent.click(screen.getByRole("checkbox", { name: `Select ${payee}` }));

async function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));
  return screen.getByRole("dialog", { name: "Mass edit staged rows" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("editing staged rows in bulk", () => {
  it("sends only the fields that were switched on, with the versions they were read at", async () => {
    const bulkBodies = stubQueue([withdrawal, deposit]);
    renderStaging();
    expect(await screen.findByText("Market")).toBeInTheDocument();

    select("Market");
    select("Employer");
    const dialog = await openEditor();
    expect(within(dialog).getByText("2 selected staged rows will be edited.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByText("Change category"));
    fireEvent.change(within(dialog).getByLabelText("New category"), {
      target: { value: groceries.id },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect(bulkBodies[0]).toMatchObject({
      selection: {
        mode: "ids",
        items: [
          { id: withdrawal.id, expectedVersion: 3 },
          { id: deposit.id, expectedVersion: 7 },
        ],
      },
      patch: { categoryId: groceries.id },
      dryRun: false,
    });
    // Date, payee, account, description, notes and type were never touched, so
    // none of them may appear: an absent key leaves the draft alone, and a
    // present one overwrites it.
    expect(Object.keys((bulkBodies[0] as { patch: object }).patch)).toEqual(["categoryId"]);
  });

  it("represents an emptied field as an explicit clear", async () => {
    const bulkBodies = stubQueue([withdrawal]);
    renderStaging();
    expect(await screen.findByText("Market")).toBeInTheDocument();

    select("Market");
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByText("Change category"));
    fireEvent.click(within(dialog).getByText("Change notes"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect((bulkBodies[0] as { patch: Record<string, unknown> }).patch).toEqual({
      categoryId: null,
      notes: null,
    });
  });

  // A transfer has two accounts, so there is no single one to move and no answer
  // for which side survives becoming a deposit.
  it("withholds account and type while a transfer is selected", async () => {
    stubQueue([withdrawal, transfer]);
    renderStaging();
    expect(await screen.findByText("To savings")).toBeInTheDocument();

    select("Market");
    select("To savings");
    const dialog = await openEditor();

    expect(within(dialog).getByText(/This selection contains 1 transfer\./)).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "Change account" })).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "Change type" })).toBeDisabled();
    // Everything they do share stays available.
    expect(within(dialog).getByRole("checkbox", { name: "Change payee" })).toBeEnabled();
  });

  it("will not set an account on a row that has no type until the type is set too", async () => {
    const bulkBodies = stubQueue([untyped]);
    renderStaging();
    expect(await screen.findByText("Unreadable line")).toBeInTheDocument();

    select("Unreadable line");
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByText("Change account"));
    fireEvent.change(within(dialog).getByLabelText("New account"), {
      target: { value: checking.id },
    });

    const apply = within(dialog).getByRole("button", { name: "Apply changes" });
    expect(apply).toBeDisabled();

    fireEvent.click(within(dialog).getByText("Change type"));
    fireEvent.change(within(dialog).getByLabelText("New transaction type"), {
      target: { value: "withdrawal" },
    });
    expect(apply).toBeEnabled();

    fireEvent.click(apply);
    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect((bulkBodies[0] as { patch: Record<string, unknown> }).patch).toEqual({
      accountId: checking.id,
      type: "withdrawal",
    });
  });

  it("refuses to submit nothing", async () => {
    stubQueue([withdrawal]);
    renderStaging();
    expect(await screen.findByText("Market")).toBeInTheDocument();

    select("Market");
    const dialog = await openEditor();
    expect(within(dialog).getByRole("button", { name: "Apply changes" })).toBeDisabled();
  });

  it("leaves an archived account out of the list", async () => {
    stubQueue([withdrawal]);
    renderStaging();
    expect(await screen.findByText("Market")).toBeInTheDocument();

    select("Market");
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByText("Change account"));
    const options = within(within(dialog).getByLabelText("New account")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Choose an account",
      "Checking (USD)",
      "Savings (USD)",
    ]);
  });

  it("says how the queue looks afterwards and drops the selection", async () => {
    stubQueue([withdrawal, deposit], () =>
      jsonResponse({
        dryRun: false,
        updatedCount: 2,
        validCount: 1,
        invalidCount: 1,
        items: [],
      } satisfies StagedBulkEditResult),
    );
    renderStaging();
    expect(await screen.findByText("Market")).toBeInTheDocument();

    select("Market");
    select("Employer");
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByText("Change payee"));
    fireEvent.change(within(dialog).getByLabelText("New payee"), {
      target: { value: "Corner Shop" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    expect(
      await screen.findByText(
        "2 staged rows updated. 1 ready to commit, 1 still needing attention.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
  });

  // A row that moved underneath makes the whole request stale. Leaving the
  // captured versions on screen would fail every retry the same way.
  it("clears a stale selection and says to look again", async () => {
    stubQueue([withdrawal], () =>
      jsonResponse(
        {
          error: {
            code: "STALE_VERSION",
            message: "A staged transaction changed",
          },
        },
        409,
      ),
    );
    renderStaging();
    expect(await screen.findByText("Market")).toBeInTheDocument();

    select("Market");
    const dialog = await openEditor();
    fireEvent.click(within(dialog).getByText("Change payee"));
    fireEvent.change(within(dialog).getByLabelText("New payee"), {
      target: { value: "Corner Shop" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    expect(
      await screen.findByText(
        "A selected row changed. Review the refreshed queue and select the rows again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });
});
