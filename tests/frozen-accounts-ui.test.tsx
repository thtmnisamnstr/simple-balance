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
  ARCHIVED_ACCOUNT_DELETE_REFUSAL,
  type Entitlement,
  frozenAccountRefusal,
  MAX_FREE_ACCOUNTS,
  restoreAllowance,
} from "../src/shared/domain.js";
import { blocks, stylesheet } from "./support/css.js";
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

/**
 * The opacity a viewer actually sees on an element: the one the stylesheet
 * gives it, times every one it gives an ancestor.
 *
 * Opacity composites down the subtree, and that is the whole reason this is
 * here. `web.md` 1.5 says a disabled control in a family that paints itself
 * dims to `0.5` to say so. A voided row was at `0.5` and an archived card at
 * `0.65`, which made that `0.25` and `0.325` — not a dim but a disappearance —
 * and the containers' own fade took their text under 4.5:1. They are muted
 * now rather than faded, so a dead control inside one is dimmed exactly as it
 * is anywhere else, and this measures that. Neither is visible to a test that
 * reads the stylesheet as text: jsdom computes no cascade, so
 * `getComputedStyle` here reports the inline style and nothing else.
 *
 * Matching is jsdom's own, against the real rendered tree, so the answer is
 * about the markup the page produces rather than one written out again here.
 * Where two rules match, the later one wins: specificity is not computed, and
 * the stylesheet is ordered so that a narrowing exception follows the family
 * it narrows — which is also the higher specificity, so the two agree.
 */
function seenOpacity(element: Element): number {
  const rules = blocks(stylesheet()).filter(
    (block) => block.context.length === 0 && /(^|[;\s])opacity\s*:/.test(block.body),
  );
  let seen = 1;
  for (let at: Element | null = element; at; at = at.parentElement) {
    let own = 1;
    for (const rule of rules) {
      const matches = rule.selector.split(",").some((one) => {
        // A selector jsdom cannot parse — a pseudo-element, say — matches
        // nothing here rather than stopping the walk.
        try {
          return at!.matches(one.trim());
        } catch {
          return false;
        }
      });
      if (matches) own = Number(/opacity:\s*([\d.]+)/.exec(rule.body)?.[1] ?? 1);
    }
    seen *= own;
  }
  return seen;
}

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

describe("entries on a frozen account, in the transaction list", () => {
  const entry = (id: string, payee: string, over: Record<string, unknown>): Transaction =>
    ({
      id,
      type: "withdrawal",
      date: "2026-07-10",
      payee,
      description: null,
      sourceAccountId: LIVE.id,
      sourceAccount: { id: LIVE.id, name: LIVE.name, currency: "USD" },
      sourceAmount: "12.34",
      sourceCurrency: "USD",
      version: 3,
      legs: [],
      ...over,
    }) as unknown as Transaction;
  const onFrozen = { sourceAccountId: FROZEN.id, sourceAccount: FROZEN };
  const ON_FROZEN = entry("44444444-4444-4444-8444-000000000001", "Frozen market", onFrozen);
  const ON_LIVE = entry("44444444-4444-4444-8444-000000000002", "Live market", {});
  // Into the frozen account from a live one: the frozen side is the second.
  const TOP_UP = entry("44444444-4444-4444-8444-000000000003", "Top up", {
    type: "transfer",
    destinationAccountId: FROZEN.id,
    destinationAccount: FROZEN,
    destinationAmount: "50.00",
    destinationCurrency: "USD",
  });
  const VOIDED = entry("44444444-4444-4444-8444-000000000004", "Old refund", {
    ...onFrozen,
    deletedAt: "2026-07-11T00:00:00.000Z",
  });
  // The server's sentence, naming the account it is about.
  const reason = frozenAccountRefusal(MAX_FREE_ACCOUNTS, FROZEN.name);

  function mountList(
    items: readonly Transaction[],
    extra?: (url: URL, init?: RequestInit) => Response | undefined,
  ) {
    stubFetch(
      [FROZEN, LIVE, OTHER],
      (url, init) =>
        extra?.(url, init) ??
        (url.pathname === "/api/v1/transactions"
          ? Response.json({
              ...emptyPage,
              items,
              pageSize: items.length,
              totalCount: items.length,
            })
          : undefined),
    );
    mountBrowser(2);
  }

  const rowOf = async (payee: string) =>
    within((await screen.findByRole("link", { name: payee })).closest("tr")!);

  it("disables Edit and Delete on them with the refusal's sentence, and names the account", async () => {
    mountList([ON_FROZEN, ON_LIVE]);
    const frozen = await rowOf("Frozen market");
    // After the accounts list has arrived, which is what says the row is frozen.
    await waitFor(() => expect(frozen.getByRole("button", { name: "Edit" })).toBeDisabled());
    for (const name of ["Edit", "Delete"]) {
      const button = frozen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
    }
    expect(frozen.getByText("Frozen")).toBeInTheDocument();

    // Beside it, an entry on an account in use keeps both, with nothing to explain.
    const live = await rowOf("Live market");
    for (const name of ["Edit", "Delete"]) {
      const button = live.getByRole("button", { name });
      expect(button).toBeEnabled();
      expect(button).not.toHaveAccessibleDescription();
    }
    expect(live.queryByText("Frozen")).not.toBeInTheDocument();
  });

  it("disables them when the frozen account is the other side of a transfer", async () => {
    mountList([TOP_UP]);
    const row = await rowOf("Top up");
    await waitFor(() => expect(row.getByRole("button", { name: "Delete" })).toBeDisabled());
    expect(row.getByRole("button", { name: "Edit" })).toHaveAccessibleDescription(reason);
  });

  it("disables Restore on a deleted one, because restoring posts to it too", async () => {
    mountList([VOIDED]);
    const row = await rowOf("Old refund");
    await waitFor(() => expect(row.getByRole("button", { name: "Restore" })).toBeDisabled());
    expect(row.getByRole("button", { name: "Restore" })).toHaveAccessibleDescription(reason);
  });

  it("dims that Restore as a dead action is dimmed anywhere, and never the row", async () => {
    // A voided row shows Restore alone, so the dim that says "disabled" lands
    // on the row's only remaining action. It used to land on top of the row's
    // own fade and multiply to nearly nothing; the row is muted now, not
    // faded, so its dead action is exactly as dim as one in an ordinary row.
    mountList([VOIDED, ON_FROZEN]);
    const voided = await rowOf("Old refund");
    const restore = voided.getByRole("button", { name: "Restore" });
    await waitFor(() => expect(restore).toBeDisabled());
    expect(seenOpacity(restore.closest("tr")!), "a voided row is not faded").toBe(1);

    const ordinary = await rowOf("Frozen market");
    const edit = ordinary.getByRole("button", { name: "Edit" });
    expect(edit).toBeDisabled();
    expect(seenOpacity(edit.closest("tr")!), "an ordinary row is not faded").toBe(1);
    expect(seenOpacity(edit), "a dead action is dimmed").toBeLessThan(1);
    expect(seenOpacity(restore), "and the same amount in a voided row").toBe(seenOpacity(edit));
  });

  it("disables the selection's Delete and Edit while a selected entry is on one", async () => {
    mountList([ON_FROZEN, ON_LIVE]);
    const live = await rowOf("Live market");
    await waitFor(() => expect(live.getByRole("button", { name: "Edit" })).toBeEnabled());
    fireEvent.click(live.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Delete selected" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit selected" })).toBeEnabled();

    fireEvent.click((await rowOf("Frozen market")).getByRole("checkbox"));
    for (const name of ["Delete selected", "Edit selected"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
    }
  });

  // A selection that outlives the page it was made on: two rows a page, a
  // list longer than one, and the preview a filter selection is counted by.
  const PAGE_TWO = entry("44444444-4444-4444-8444-000000000005", "Page two market", {});
  function mountPages(pageOf: (url: URL) => readonly Transaction[], totalCount: number) {
    const bulkCalls: string[] = [];
    mountList([], (url, init) => {
      if (url.pathname === "/api/v1/transactions") {
        return Response.json({
          ...emptyPage,
          items: pageOf(url),
          page: Number(url.searchParams.get("page") ?? 1),
          pageSize: 2,
          totalCount,
          totalPages: Math.ceil(totalCount / 2),
        });
      }
      if (url.pathname === "/api/v1/transactions/bulk-selection") {
        const { excludedIds } = JSON.parse(String(init?.body)) as { excludedIds: string[] };
        const count = totalCount - excludedIds.length;
        return Response.json({
          count,
          fingerprint: "d".repeat(64),
          activeCount: count,
          deletedCount: 0,
          transferCount: 0,
          splitCount: 0,
          currencies: ["USD"],
        });
      }
      if (url.pathname.startsWith("/api/v1/transactions/bulk-")) bulkCalls.push(url.pathname);
      return undefined;
    });
    return bulkCalls;
  }
  const byPage = (url: URL) =>
    url.searchParams.get("page") === "2" ? [PAGE_TWO] : [ON_FROZEN, ON_LIVE];
  const expectBulkBlocked = () => {
    for (const name of ["Delete selected", "Edit selected"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(reason);
    }
  };
  const expectBulkOffered = () => {
    for (const name of ["Delete selected", "Edit selected"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
  };

  it("keeps them disabled when Select all matching takes in a frozen row on screen", async () => {
    // A filter selection read only the account filter, and this view has none,
    // so both buttons went live beside a row still ticked and badged Frozen.
    const bulkCalls = mountPages(byPage, 5);
    const live = await rowOf("Live market");
    await waitFor(() => expect(live.getByRole("button", { name: "Edit" })).toBeEnabled());
    fireEvent.click(live.getByRole("checkbox"));
    expectBulkOffered();
    fireEvent.click(screen.getByRole("button", { name: "Select all 5 matching" }));
    await screen.findByText("5 transactions matching this view selected");
    expect((await rowOf("Frozen market")).getByRole("checkbox")).toBeChecked();
    expectBulkBlocked();

    // Excluding it is what the reason asks for, and it is enough.
    fireEvent.click((await rowOf("Frozen market")).getByRole("checkbox"));
    await screen.findByText("4 transactions matching this view selected");
    expectBulkOffered();
    expect(bulkCalls).toEqual([]);
  });

  it("remembers a frozen row ticked on page one after the page turns", async () => {
    // `versions` goes on sending the row from page two, so the server refuses
    // the whole request; the check read only the rows on screen and forgot it.
    mountPages(byPage, 3);
    const frozen = await rowOf("Frozen market");
    await waitFor(() => expect(frozen.getByRole("button", { name: "Edit" })).toBeDisabled());
    fireEvent.click(frozen.getByRole("checkbox"));
    fireEvent.click((await rowOf("Live market")).getByRole("checkbox"));
    expectBulkBlocked();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await rowOf("Page two market");
    expect(screen.getByText("2 transactions selected")).toBeVisible();
    expectBulkBlocked();

    // Unticked, it no longer holds the selection back from another page.
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    fireEvent.click((await rowOf("Frozen market")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await rowOf("Page two market");
    expect(screen.getByText("1 transaction selected")).toBeVisible();
    expectBulkOffered();
  });

  it("remembers a frozen row a filter selection showed on a page it has left", async () => {
    mountPages(byPage, 3);
    const live = await rowOf("Live market");
    await waitFor(() => expect(live.getByRole("button", { name: "Edit" })).toBeEnabled());
    fireEvent.click(live.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Select all 3 matching" }));
    await screen.findByText("3 transactions matching this view selected");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await rowOf("Page two market");
    expectBulkBlocked();
  });

  it("blocks a filter selection once a page it turns to shows a frozen row", async () => {
    // Taken in by the selection without ever being ticked or remembered: it
    // arrives on screen already selected, so the rows on screen are read in
    // this mode too.
    mountPages(
      (url) => (url.searchParams.get("page") === "2" ? [ON_FROZEN] : [ON_LIVE, PAGE_TWO]),
      3,
    );
    const live = await rowOf("Live market");
    await waitFor(() => expect(live.getByRole("button", { name: "Edit" })).toBeEnabled());
    fireEvent.click(live.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Select all 3 matching" }));
    await screen.findByText("3 transactions matching this view selected");
    expectBulkOffered();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect((await rowOf("Frozen market")).getByRole("checkbox")).toBeChecked();
    expectBulkBlocked();
  });

  it("remembers a frozen row shown before a reorder took it off the page", async () => {
    // Seen but never ticked: it joins the selection only when every matching
    // row does, which is after the sort has already replaced the page.
    mountPages(
      (url) => (url.searchParams.get("sort") === "payee" ? [ON_LIVE, PAGE_TWO] : byPage(url)),
      3,
    );
    await waitFor(async () =>
      expect((await rowOf("Frozen market")).getByRole("button", { name: "Edit" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Payee/ }));
    await rowOf("Page two market");
    fireEvent.click((await rowOf("Live market")).getByRole("checkbox"));
    expectBulkOffered();
    fireEvent.click(screen.getByRole("button", { name: "Select all 3 matching" }));
    await screen.findByText("3 transactions matching this view selected");
    expectBulkBlocked();
  });

  it("names the entry when a delete is refused anyway", async () => {
    // The list said the account was in use and the server has since frozen
    // it — the one way a refusal still reaches the list-level alert.
    const refusal = frozenAccountRefusal(MAX_FREE_ACCOUNTS, LIVE.name);
    mountList([ON_LIVE], (url) =>
      url.pathname.endsWith("/deleted")
        ? Response.json({ error: { code: "VALIDATION_ERROR", message: refusal } }, { status: 422 })
        : undefined,
    );
    const live = await rowOf("Live market");
    await waitFor(() => expect(live.getByRole("button", { name: "Delete" })).toBeEnabled());
    fireEvent.click(live.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete this transaction?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(`“Live market” was not deleted. ${refusal}`)).toBeVisible();
  });
});

describe("a frozen account's card on the Accounts page", () => {
  const CASH = account("11111111-1111-4111-8111-000000000004", "Cash");

  async function menuOf(name: string) {
    stubFetch([FROZEN, LIVE, OTHER, CASH]);
    render(
      <QueryClientProvider client={queryClient()}>
        <BrowserRouter>
          <AccountsPage session={session(MAX_FREE_ACCOUNTS)} />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByLabelText(`Actions for ${name}`);
    return within(trigger.closest("details") as HTMLElement);
  }

  it("says why Edit is unavailable, in the refusal's own sentence", async () => {
    const menu = await menuOf(FROZEN.name);
    const edit = menu.getByRole("button", { name: "Edit", hidden: true });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAccessibleDescription(frozenAccountRefusal(MAX_FREE_ACCOUNTS, FROZEN.name));
  });

  it("leaves Archive and Delete open, with nothing to explain", async () => {
    // Putting a frozen account away gives it no place, so somebody who
    // downgraded can tidy away the accounts they no longer use.
    const menu = await menuOf(FROZEN.name);
    for (const name of ["Archive", "Delete if unused"]) {
      const item = menu.getByRole("button", { name, hidden: true });
      expect(item).toBeEnabled();
      expect(item).not.toHaveAccessibleDescription();
    }
  });

  it("leaves an account in use with all three and nothing to explain", async () => {
    const menu = await menuOf(LIVE.name);
    for (const name of ["Edit", "Archive", "Delete if unused"]) {
      const item = menu.getByRole("button", { name, hidden: true });
      expect(item).toBeEnabled();
      expect(item).not.toHaveAccessibleDescription();
    }
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

  /**
   * The server refuses to delete an archived account and said so only after
   * the press, with a word — "Unarchive" — that is a button nowhere here. The
   * item is gray on an archived card and carries the same sentence the server
   * would have refused with.
   */
  it("offers no delete on an archived card, and says to restore it first", async () => {
    const restore = await openArchived(MAX_FREE_ACCOUNTS - 1);
    const menu = restore.closest("details")! as HTMLElement;
    const remove = within(menu).getByRole("button", { name: /Delete if unused/, hidden: true });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription(ARCHIVED_ACCOUNT_DELETE_REFUSAL);
  });

  it("is offered while a place is free", async () => {
    const restore = await openArchived(MAX_FREE_ACCOUNTS - 1);
    expect(restore).toBeEnabled();
  });

  it("dims the refused item as a dead action is dimmed anywhere, and never the card", async () => {
    // The second place a disabled control sat inside something faded. An
    // archived card was at 0.65 and its refused item multiplied below that;
    // the card is muted now, so the item carries the house dim and nothing
    // else.
    const restore = await openArchived(MAX_FREE_ACCOUNTS);
    const card = restore.closest("article")!;
    expect(card.className, "the card is the archived one").toContain("archived");
    expect(seenOpacity(card), "an archived card is not faded").toBe(1);
    expect(seenOpacity(restore), "its refused item carries the house dim").toBe(0.5);
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

  it("lists no frozen account, and stages against the one chosen", async () => {
    // Every row of the file lands on this one account, so a frozen default
    // stages the whole file with the same issue on every row. With two live
    // accounts nothing is chosen for the person at all — the first of several
    // was, until the 0.2.0 sandbox smoke test — so the choice is made here.
    const { container, staged } = mountImport([FROZEN, LIVE, OTHER]);
    await screen.findByRole("heading", { name: "Choose a CSV file" });
    const csv = "date,payee,amount\n2026-07-31,Market,-12.34";
    const file = new File([csv], "bank.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => csv });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    const picker = (await screen.findByLabelText("Account")) as HTMLSelectElement;
    expect(picker.value).toBe("");
    fireEvent.change(picker, { target: { value: LIVE.id } });
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
