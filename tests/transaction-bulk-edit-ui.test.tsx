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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  Category,
  Page,
  Transaction,
  TransactionBulkEditResult,
  TransactionBulkSelectionPreview,
} from "../src/client/api.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
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
  balance: "100",
  balancePresentation: { label: "Balance", amount: "100" },
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

const archivedCategory: Category = {
  ...groceries,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Old category",
  archivedAt: "2026-01-01T00:00:00.000Z",
};

const allMatchingFingerprint = "a".repeat(64);
const afterExclusionFingerprint = "b".repeat(64);

const withdrawal: Transaction = {
  id: "44444444-4444-4444-8444-444444444444",
  type: "withdrawal",
  date: "2026-07-10",
  payee: "Market",
  description: "Food",
  categoryId: groceries.id,
  category: groceries,
  sourceAccountId: checking.id,
  sourceAccount: {
    id: checking.id,
    name: checking.name,
    currency: checking.currency,
  },
  sourceAmount: "12.34",
  sourceCurrency: "USD",
  version: 3,
};

const deposit: Transaction = {
  id: "55555555-5555-4555-8555-555555555555",
  type: "deposit",
  date: "2026-07-11",
  payee: "Employer",
  description: null,
  destinationAccountId: checking.id,
  destinationAccount: {
    id: checking.id,
    name: checking.name,
    currency: checking.currency,
  },
  destinationAmount: "1000",
  destinationCurrency: "USD",
  version: 7,
};

const transfer: Transaction = {
  id: "66666666-6666-4666-8666-666666666666",
  type: "transfer",
  date: "2026-07-12",
  payee: "Savings transfer",
  description: null,
  sourceAccountId: checking.id,
  destinationAccountId: savings.id,
  sourceAccount: {
    id: checking.id,
    name: checking.name,
    currency: checking.currency,
  },
  destinationAccount: {
    id: savings.id,
    name: savings.name,
    currency: savings.currency,
  },
  sourceAmount: "25",
  destinationAmount: "25",
  sourceCurrency: "USD",
  destinationCurrency: "USD",
  version: 2,
};

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulBulkResult(updatedCount = 1): TransactionBulkEditResult {
  return {
    updatedCount,
    selectionCount: updatedCount,
    selectionFingerprint: "c".repeat(64),
    activeCount: updatedCount,
    deletedCount: 0,
    transferCount: 0,
    currencies: ["USD"],
    itemsTruncated: false,
    dryRun: false,
    items: [],
  };
}

function renderBrowser(props: React.ComponentProps<typeof TransactionBrowser> = {}) {
  window.history.replaceState(
    null,
    "",
    "/transactions?start=2026-07-01&end=2026-07-31&preset=custom",
  );
  const client = queryClient();
  render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser {...props} />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
  return client;
}

function baseFetch(
  onRequest?: (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), window.location.origin);
    const custom = await onRequest?.(url, init);
    if (custom) return custom;
    if (url.pathname === "/api/v1/transactions") {
      const page: Page<Transaction> = {
        items: [withdrawal, deposit],
        nextCursor: null,
      };
      return jsonResponse(page);
    }
    if (url.pathname === "/api/v1/accounts") {
      return jsonResponse([checking, savings, archivedAccount]);
    }
    if (url.pathname === "/api/v1/categories") {
      return jsonResponse([groceries, archivedCategory]);
    }
    if (url.pathname === "/api/v1/payees/suggestions") {
      return jsonResponse([]);
    }
    return new Response("Not found", { status: 404 });
  });
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("transaction mass selection", () => {
  it("supports row, loaded-page, and snapshotted all-filter selection in an account view", async () => {
    const previewBodies: Record<string, unknown>[] = [];
    const bulkBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      baseFetch((url, init) => {
        if (url.pathname === "/api/v1/transactions/bulk-selection") {
          const body = JSON.parse(String(init?.body)) as {
            excludedIds: string[];
          };
          previewBodies.push(body as unknown as Record<string, unknown>);
          const preview: TransactionBulkSelectionPreview = body.excludedIds.length
            ? {
                count: 1,
                fingerprint: afterExclusionFingerprint,
                activeCount: 1,
                deletedCount: 0,
                transferCount: 0,
                currencies: ["USD"],
              }
            : {
                count: 2,
                fingerprint: allMatchingFingerprint,
                activeCount: 2,
                deletedCount: 0,
                transferCount: 0,
                currencies: ["USD"],
              };
          return jsonResponse(preview);
        }
        if (url.pathname === "/api/v1/transactions/bulk-edit") {
          bulkBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse(successfulBulkResult(1));
        }
        return undefined;
      }),
    );

    renderBrowser({ fixedAccountId: checking.id, showDateRange: false });

    const header = await screen.findByRole("checkbox", {
      name: "Select all transactions on this page",
    });
    const rows = screen.getAllByRole("checkbox", {
      name: /Select transaction /,
    });
    fireEvent.click(rows[0]!);
    expect(header).toHaveProperty("indeterminate", true);

    fireEvent.click(header);
    expect(rows[0]).toBeChecked();
    expect(rows[1]).toBeChecked();
    expect(screen.getByText("2 transactions selected")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Select all matching transactions" }),
    );
    expect(
      await screen.findByText("2 transactions matching this view selected"),
    ).toBeInTheDocument();
    expect(previewBodies[0]).toMatchObject({
      filter: {
        start: "2026-07-01",
        end: "2026-07-31",
        accountId: checking.id,
        includeDeleted: false,
      },
      excludedIds: [],
    });

    fireEvent.click(rows[0]!);
    expect(rows[0]).not.toBeChecked();
    expect(header).toHaveProperty("indeterminate", true);
    expect(
      await screen.findByText("1 transaction matching this view selected"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });
    fireEvent.click(within(dialog).getByText("Change date"));
    fireEvent.change(within(dialog).getByLabelText("New date"), {
      target: { value: "2026-07-20" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect(bulkBodies[0]).toMatchObject({
      selection: {
        mode: "filter",
        filter: {
          accountId: checking.id,
          start: "2026-07-01",
          end: "2026-07-31",
          includeDeleted: false,
        },
        excludedIds: [withdrawal.id],
        expectedCount: 1,
        expectedFingerprint: afterExclusionFingerprint,
      },
      patch: { date: "2026-07-20" },
      allowDuplicates: false,
      dryRun: false,
    });
  });

  it("sends only enabled fields and represents intentional clears as null", async () => {
    const bulkBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      baseFetch((url, init) => {
        if (url.pathname === "/api/v1/transactions/bulk-edit") {
          bulkBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse(successfulBulkResult(2));
        }
        return undefined;
      }),
    );
    renderBrowser();

    const header = await screen.findByRole("checkbox", {
      name: "Select all transactions on this page",
    });
    fireEvent.click(header);
    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });

    for (const label of [
      "Change date",
      "Change payee",
      "Change category",
      "Change account",
      "Change description",
      "Change notes",
      "Change type",
    ]) {
      fireEvent.click(within(dialog).getByText(label));
    }
    fireEvent.change(within(dialog).getByLabelText("New date"), {
      target: { value: "2026-07-25" },
    });
    fireEvent.change(within(dialog).getByLabelText("New payee"), {
      target: { value: "  New Payee  " },
    });
    fireEvent.change(within(dialog).getByLabelText("New account"), {
      target: { value: savings.id },
    });
    fireEvent.change(within(dialog).getByLabelText("New transaction type"), {
      target: { value: "deposit" },
    });
    expect(
      within(dialog).queryByRole("option", { name: /Old account/ }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("option", { name: "Old category" }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect(bulkBodies[0]).toMatchObject({
      selection: {
        mode: "ids",
        items: [
          { id: withdrawal.id, expectedVersion: withdrawal.version },
          { id: deposit.id, expectedVersion: deposit.version },
        ],
      },
      patch: {
        date: "2026-07-25",
        payee: "New Payee",
        categoryId: null,
        accountId: savings.id,
        description: null,
        notes: null,
        type: "deposit",
      },
    });
    expect(String(bulkBodies[0]?.idempotencyKey)).toHaveLength(36);
  });

  it("keeps common edits available but disables account and type for transfers", async () => {
    vi.stubGlobal(
      "fetch",
      baseFetch((url) => {
        if (url.pathname === "/api/v1/transactions") {
          return jsonResponse({ items: [transfer], nextCursor: null });
        }
        return undefined;
      }),
    );
    renderBrowser();

    fireEvent.click(
      (await screen.findAllByRole("checkbox", {
        name: /Select transaction /,
      }))[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });

    expect(within(dialog).getByLabelText("Change account")).toBeDisabled();
    expect(within(dialog).getByLabelText("Change type")).toBeDisabled();
    expect(within(dialog).getByLabelText("Change date")).toBeEnabled();
    expect(
      within(dialog).getByText(/common details, but Account and Type are unavailable/),
    ).toBeInTheDocument();
  });

  it("keeps the version captured at selection time after a background refetch", async () => {
    let listRequests = 0;
    const bulkBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      baseFetch((url, init) => {
        if (url.pathname === "/api/v1/transactions") {
          listRequests += 1;
          return jsonResponse({
            items: [
              listRequests === 1
                ? withdrawal
                : { ...withdrawal, version: withdrawal.version + 1 },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === "/api/v1/transactions/bulk-edit") {
          bulkBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return jsonResponse(successfulBulkResult());
        }
        return undefined;
      }),
    );
    const client = renderBrowser();

    fireEvent.click(
      (await screen.findAllByRole("checkbox", {
        name: /Select transaction /,
      }))[0]!,
    );
    await client.invalidateQueries({ queryKey: ["transactions"] });
    await waitFor(() => expect(listRequests).toBeGreaterThanOrEqual(2));

    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });
    fireEvent.click(within(dialog).getByText("Change description"));
    fireEvent.change(within(dialog).getByLabelText("New description"), {
      target: { value: "Version-safe edit" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(bulkBodies).toHaveLength(1));
    expect(bulkBodies[0]).toMatchObject({
      selection: {
        mode: "ids",
        items: [
          { id: withdrawal.id, expectedVersion: withdrawal.version },
        ],
      },
    });
  });

  it("retries duplicate warnings with the same idempotency key", async () => {
    const bulkBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      baseFetch((url, init) => {
        if (url.pathname === "/api/v1/transactions/bulk-edit") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          bulkBodies.push(body);
          if (!body.allowDuplicates) {
            return jsonResponse(
              {
                error: {
                  code: "DUPLICATE",
                  message: "These changes may create duplicate transactions.",
                },
              },
              409,
            );
          }
          return jsonResponse(successfulBulkResult());
        }
        return undefined;
      }),
    );
    renderBrowser();

    const row = (await screen.findAllByRole("checkbox", {
      name: /Select transaction /,
    }))[0]!;
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });
    fireEvent.click(within(dialog).getByText("Change description"));
    fireEvent.change(within(dialog).getByLabelText("New description"), {
      target: { value: "Potential duplicate" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    const applyAnyway = await within(dialog).findByRole("button", {
      name: "Apply anyway",
    });
    fireEvent.click(applyAnyway);
    await waitFor(() => expect(bulkBodies).toHaveLength(2));
    expect(bulkBodies.map((body) => body.allowDuplicates)).toEqual([false, true]);
    expect(bulkBodies[0]?.idempotencyKey).toBe(bulkBodies[1]?.idempotencyKey);
  });

  it("refreshes a stale all-filter snapshot before allowing a retry", async () => {
    let previewRequests = 0;
    const bulkBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      baseFetch((url, init) => {
        if (url.pathname === "/api/v1/transactions/bulk-selection") {
          previewRequests += 1;
          return jsonResponse({
            count: previewRequests === 1 ? 2 : 3,
            fingerprint:
              previewRequests === 1 ? "d".repeat(64) : "e".repeat(64),
            activeCount: previewRequests === 1 ? 2 : 3,
            deletedCount: 0,
            transferCount: 0,
            currencies: ["USD"],
          } satisfies TransactionBulkSelectionPreview);
        }
        if (url.pathname === "/api/v1/transactions/bulk-edit") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          bulkBodies.push(body);
          if (bulkBodies.length === 1) {
            return jsonResponse(
              {
                error: {
                  code: "STALE_VERSION",
                  message: "The selection changed.",
                },
              },
              409,
            );
          }
          return jsonResponse(successfulBulkResult(3));
        }
        return undefined;
      }),
    );
    renderBrowser();

    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Select all transactions on this page",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select all matching transactions" }),
    );
    await screen.findByText("2 transactions matching this view selected");
    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });
    fireEvent.click(within(dialog).getByText("Change description"));
    fireEvent.change(within(dialog).getByLabelText("New description"), {
      target: { value: "Snapshot retry" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    expect(
      await within(dialog).findByText(/matching transaction set changed/i),
    ).toBeInTheDocument();
    await within(dialog).findByText("3 transactions matching this view will be edited.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    await waitFor(() => expect(bulkBodies).toHaveLength(2));
    expect(bulkBodies[0]).toMatchObject({
      selection: { expectedFingerprint: "d".repeat(64), expectedCount: 2 },
    });
    expect(bulkBodies[1]).toMatchObject({
      selection: { expectedFingerprint: "e".repeat(64), expectedCount: 3 },
    });
    expect(bulkBodies[0]?.idempotencyKey).toBe(bulkBodies[1]?.idempotencyKey);
  });

  it("clears an explicit stale selection so old versions cannot be retried", async () => {
    vi.stubGlobal(
      "fetch",
      baseFetch((url) => {
        if (url.pathname === "/api/v1/transactions/bulk-edit") {
          return jsonResponse(
            {
              error: {
                code: "STALE_VERSION",
                message: "The selected transaction changed.",
              },
            },
            409,
          );
        }
        return undefined;
      }),
    );
    renderBrowser();

    const row = (await screen.findAllByRole("checkbox", {
      name: /Select transaction /,
    }))[0]!;
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "Mass edit" }));
    const dialog = screen.getByRole("dialog", { name: "Mass edit transactions" });
    fireEvent.click(within(dialog).getByText("Change description"));
    fireEvent.change(within(dialog).getByLabelText("New description"), {
      target: { value: "Will be stale" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));

    expect(
      await screen.findByText(/review the refreshed list and select the transactions again/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(row).not.toBeChecked();
  });
});
