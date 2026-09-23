// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  Category,
  CsvPreview,
  PaginatedPage,
  Session,
  StagedTransaction,
  Transaction,
} from "../src/client/api.js";
import { TransactionForm } from "../src/client/forms.js";
import AccountDetailPage from "../src/client/pages/AccountDetailPage.js";
import AccountsPage from "../src/client/pages/AccountsPage.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
import {
  type Entitlement,
  frozenAccountRefusal,
  MAX_FREE_ACCOUNTS,
  restoreAllowance,
} from "../src/shared/domain.js";
import "./support/dialog.js";

/**
 * A frozen account, everywhere the browser could offer a write to one.
 *
 * Only the Accounts page knew an account was frozen. The register offered Add
 * transaction on one and opened the form preselected to it; the new-entry form
 * defaulted to whichever live account sorted first by name, frozen or not, and
 * so did the CSV import, which posts every row of a file against the one it
 * chose; both bulk edits' account pickers listed frozen accounts; and Restore
 * asked to be confirmed with every place in use. Each of those came back refused by the
 * server, and `docs/standards/code/errors.md` 4 is that a browser which can
 * tell in advance must, in the sentence the refusal would use.
 */
const account = (id: string, name: string, over: Partial<Account> = {}): Account => ({
  id,
  name,
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  archivedAt: null,
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
  active: true,
  frozen: false,
  ...over,
});

// First by name, which is the order the accounts list arrives in, so a default
// read off the front of the list lands on it.
const FROZEN = account("11111111-1111-4111-8111-000000000001", "Aardvark joint", {
  active: false,
  frozen: true,
});
const LIVE = account("11111111-1111-4111-8111-000000000002", "Everyday");
const OTHER = account("11111111-1111-4111-8111-000000000003", "Savings");
const categories: Category[] = [{ id: "cat-1", name: "Food", kind: "expense", version: 1 }];

const free: Entitlement = {
  billing: true,
  plan: "free",
  accountLimit: MAX_FREE_ACCOUNTS,
  source: "free",
};

const session = (accountsUsed: number) =>
  ({
    user: { id: "u1", name: "Ada", email: "ada@example.com" },
    preferences: { userId: "u1", timezone: "UTC", defaultCurrency: "USD", chosen: true },
    auth: {
      localEnabled: true,
      googleEnabled: false,
      hasLocalPassword: true,
      hasGoogleAccount: false,
    },
    plan: { entitlement: free, accountsUsed },
  }) as unknown as Session;

const queryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });

const emptyPage: PaginatedPage<Transaction> = {
  items: [],
  nextCursor: null,
  page: 1,
  pageSize: 0,
  totalCount: 0,
  cursorAvailable: false,
  totalPages: 1,
};

/** The accounts the list returns, and everything else the pages ask for. */
function stubFetch(
  accounts: readonly Account[],
  extra?: (url: URL, init?: RequestInit) => Response | undefined,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      const custom = extra?.(url, init);
      if (custom) return custom;
      if (url.pathname === "/api/v1/accounts") {
        const archived = url.searchParams.get("includeArchived") === "true";
        return Response.json(accounts.filter((entry) => archived || !entry.archivedAt));
      }
      if (url.pathname === "/api/v1/transactions") return Response.json(emptyPage);
      if (url.pathname === "/api/v1/staged-transactions") return Response.json(emptyPage);
      return Response.json([]);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const selectValues = (container: HTMLElement) =>
  [...container.querySelectorAll("select")].map((select) => select.value);

function mountForm(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">{node}</TimezoneProvider>
    </QueryClientProvider>,
  );
}

describe("the account a new entry starts on", () => {
  it("is never a frozen one, even when it sorts first", () => {
    stubFetch([]);
    const { container } = mountForm(
      <TransactionForm
        accounts={[FROZEN, LIVE, OTHER]}
        categories={categories}
        onDone={() => {}}
      />,
    );
    expect(selectValues(container)).toContain(LIVE.id);
    expect(selectValues(container)).not.toContain(FROZEN.id);
  });

  it("skips it on both sides of a transfer", () => {
    stubFetch([]);
    const { container } = mountForm(
      <TransactionForm
        accounts={[FROZEN, LIVE, OTHER]}
        categories={categories}
        initialType="transfer"
        onDone={() => {}}
      />,
    );
    expect(selectValues(container)).toEqual(expect.arrayContaining([LIVE.id, OTHER.id]));
    expect(selectValues(container)).not.toContain(FROZEN.id);
  });

  it("skips it when the type changes to a transfer", () => {
    stubFetch([]);
    const { container } = mountForm(
      <TransactionForm
        accounts={[FROZEN, LIVE, OTHER]}
        categories={categories}
        onDone={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Transfer/ }));
    expect(selectValues(container)).toEqual(expect.arrayContaining([LIVE.id, OTHER.id]));
    expect(selectValues(container)).not.toContain(FROZEN.id);
  });

  it("skips it when the list arrives after the form opened", () => {
    // The fill-a-blank effect, which reads the list a second time once the
    // query that was still empty at mount resolves.
    stubFetch([]);
    const client = queryClient();
    const tree = (accounts: Account[]) => (
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <TransactionForm accounts={accounts} categories={categories} onDone={() => {}} />
        </TimezoneProvider>
      </QueryClientProvider>
    );
    const { container, rerender } = render(tree([]));
    rerender(tree([FROZEN, LIVE, OTHER]));
    expect(selectValues(container)).toContain(LIVE.id);
    expect(selectValues(container)).not.toContain(FROZEN.id);
  });
});

const heading = { kind: "section", title: "Transactions", description: "For this test." } as const;

function mountBrowser(accountsUsed: number) {
  window.history.replaceState(
    null,
    "",
    "/transactions?start=2026-07-01&end=2026-07-31&preset=custom",
  );
  const client = queryClient();
  // What the app shell has already loaded by the time any page renders.
  client.setQueryData(["session"], session(accountsUsed));
  render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser heading={heading} />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

describe("the transaction list, with frozen accounts in the ledger", () => {
  it("disables Add transaction with the server's sentence when every account is frozen", async () => {
    stubFetch([FROZEN, { ...OTHER, active: false, frozen: true }]);
    mountBrowser(0);
    const add = await screen.findByRole("button", { name: /Add transaction/ });
    await waitFor(() => expect(add).toBeDisabled());
    expect(add).toHaveAccessibleDescription(frozenAccountRefusal(MAX_FREE_ACCOUNTS));
  });

  it("leaves frozen accounts out of the bulk edit's account picker", async () => {
    const withdrawal = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "withdrawal",
      date: "2026-07-10",
      payee: "Market",
      description: null,
      sourceAccountId: LIVE.id,
      sourceAccount: { id: LIVE.id, name: LIVE.name, currency: "USD" },
      sourceAmount: "12.34",
      sourceCurrency: "USD",
      version: 3,
      legs: [],
    } as unknown as Transaction;
    stubFetch([FROZEN, LIVE, OTHER], (url) =>
      url.pathname === "/api/v1/transactions"
        ? Response.json({ ...emptyPage, items: [withdrawal], pageSize: 1, totalCount: 1 })
        : undefined,
    );
    mountBrowser(2);
    const add = await screen.findByRole("button", { name: /Add transaction/ });
    await waitFor(() => expect(add).toBeEnabled());

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select all transactions on this page" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit selected" }));
    const dialog = screen.getByRole("dialog", { name: "Edit selected transactions" });
    fireEvent.click(within(dialog).getByText("Change account"));
    const picker = within(dialog).getByLabelText("New account");
    const names = [...(picker as HTMLSelectElement).options].map((option) => option.textContent);
    expect(names.join(" ")).toContain("Savings");
    expect(names.join(" ")).not.toContain(FROZEN.name);
  });
});

describe("a frozen account's own page", () => {
  it("says it is frozen and offers no new entry", async () => {
    stubFetch([FROZEN, LIVE], (url) =>
      url.pathname === `/api/v1/accounts/${FROZEN.id}`
        ? Response.json(FROZEN)
        : url.pathname.endsWith("/balances")
          ? Response.json({})
          : undefined,
    );
    window.history.replaceState(null, "", `/accounts/${FROZEN.id}`);
    render(
      <QueryClientProvider client={queryClient()}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <Routes>
              <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
            </Routes>
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: FROZEN.name });
    expect(screen.getByText("Frozen")).toBeInTheDocument();
    await screen.findByRole("heading", { name: "Transactions" });
    expect(screen.queryByRole("button", { name: /Add transaction/ })).not.toBeInTheDocument();
  });
});

describe("restoring an archived account", () => {
  const ARCHIVED = account("11111111-1111-4111-8111-000000000009", "Old savings", {
    archivedAt: "2026-02-01T00:00:00.000Z",
  });

  async function openArchived(accountsUsed: number) {
    stubFetch([LIVE, OTHER, account("11111111-1111-4111-8111-000000000004", "Cash"), ARCHIVED]);
    render(
      <QueryClientProvider client={queryClient()}>
        <BrowserRouter>
          <AccountsPage session={session(accountsUsed)} />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByLabelText("Show archived accounts"));
    await screen.findByText(ARCHIVED.name);
    const menu = screen.getByLabelText(`Actions for ${ARCHIVED.name}`).closest("details")!;
    return within(menu as HTMLElement).getByRole("button", { name: /Restore/, hidden: true });
  }

  it("is disabled with the refusal's own sentence while every place is in use", async () => {
    const restore = await openArchived(MAX_FREE_ACCOUNTS);
    const refusal = restoreAllowance(free, MAX_FREE_ACCOUNTS);
    expect(refusal.ok).toBe(false);
    expect(restore).toBeDisabled();
    if (!refusal.ok) expect(restore).toHaveAccessibleDescription(refusal.message);
  });

  it("is offered while a place is free", async () => {
    const restore = await openArchived(MAX_FREE_ACCOUNTS - 1);
    expect(restore).toBeEnabled();
  });
});

describe("the CSV import, with frozen accounts in the ledger", () => {
  const preview: CsvPreview = {
    delimiter: ",",
    headers: ["date", "payee", "amount"],
    rows: [{ date: "2026-07-31", payee: "Market", amount: "-12.34" }],
    errors: [],
  };

  /** The page, and every stage request it sends. */
  function mountImport(accounts: readonly Account[]) {
    const staged: Record<string, unknown>[] = [];
    stubFetch(accounts, (url, init) => {
      if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
      if (url.pathname !== "/api/v1/csv/stage") return undefined;
      staged.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        fileName: "bank.csv",
        rowCount: 1,
        validCount: 1,
        invalidCount: 0,
        sample: [],
        referenceResolution: { categories: [], payees: [] },
      });
    });
    const view = render(
      <QueryClientProvider client={queryClient()}>
        <BrowserRouter>
          <ImportPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    return { ...view, staged };
  }

  it("starts on an account the rows can be posted to, and lists no frozen one", async () => {
    // Every row of the file lands on this one account, so a frozen default
    // stages the whole file with the same issue on every row.
    const { container, staged } = mountImport([FROZEN, LIVE, OTHER]);
    await screen.findByRole("heading", { name: "Choose a CSV file" });
    const csv = "date,payee,amount\n2026-07-31,Market,-12.34";
    const file = new File([csv], "bank.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => csv });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    const picker = (await screen.findByLabelText("Account")) as HTMLSelectElement;
    expect(picker.value).toBe(LIVE.id);
    const names = [...picker.options].map((option) => option.textContent);
    expect(names.join(" ")).toContain(OTHER.name);
    expect(names.join(" ")).not.toContain(FROZEN.name);
    // And the request says so too. A select whose value matches none of its
    // options shows the first one anyway, so the picker alone would read right
    // over a default that was still the frozen account.
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
    await waitFor(() => expect(staged).toHaveLength(1));
    expect(staged[0]).toMatchObject({ defaultAccountId: LIVE.id });
  });

  it("says so when every account is frozen, rather than offering an empty picker", async () => {
    mountImport([FROZEN, { ...OTHER, active: false, frozen: true }]);
    expect(await screen.findByRole("heading", { name: "Every account is frozen" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Choose a CSV file" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
  });
});

describe("the staged queue's bulk edit, with frozen accounts in the ledger", () => {
  it("leaves frozen accounts out of its account picker", async () => {
    // The server files a move onto a frozen account as an issue on every row
    // it was asked to move, so offering one offers an edit that fixes nothing.
    const row: StagedTransaction = {
      id: "55555555-5555-4555-8555-555555555555",
      draft: {
        type: "withdrawal",
        date: "2026-07-30",
        payee: "Market",
        fromAccountId: LIVE.id,
        amount: "10.00",
      },
      validationIssues: [],
      importBatchId: null,
      version: 1,
      status: "staged",
      createdAt: "2026-07-30T12:00:00.000Z",
    };
    stubFetch([FROZEN, LIVE, OTHER], (url) =>
      url.pathname === "/api/v1/staged-transactions"
        ? Response.json({ ...emptyPage, items: [row], pageSize: 1, totalCount: 1 })
        : url.pathname === "/api/v1/import-batches"
          ? Response.json({ items: [], nextCursor: null })
          : undefined,
    );
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
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Market" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));
    const dialog = screen.getByRole("dialog", { name: "Edit selected staged rows" });
    fireEvent.click(within(dialog).getByText("Change account"));
    const options = within(within(dialog).getByLabelText("New account")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Choose an account",
      `${LIVE.name} (USD)`,
      `${OTHER.name} (USD)`,
    ]);
  });
});
