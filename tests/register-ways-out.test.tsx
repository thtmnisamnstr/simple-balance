// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, PaginatedPage, StagedTransaction, Transaction } from "../src/client/api.js";
import { noAccountReason } from "../src/client/list-filters.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import { MAX_FREE_ACCOUNTS, frozenAccountRefusal } from "../src/shared/domain.js";

/**
 * The register's empty screen names every control that is keeping rows off it.
 *
 * `web.md` 12.1, and `list-filters.ts`'s own contract: a filter is only what the
 * reader can reach, and **a control that is in force before anybody touches it
 * names a way out without making the list narrowed**. The register's bar
 * carries four narrowing controls and the `emptyScreen` call named three. The
 * fourth is "Show deleted", which ships off and is sent as
 * `includeDeleted: undefined`, so it hides rows before anybody touches it.
 *
 * `AGENTS.md`: "Deleting voids an entry by posting its reversal" — the rows are
 * still there and the view is hiding them. So somebody who deleted everything
 * matching the view was told "No transactions yet" and sent off to add a
 * transaction, with no mention of the one checkbox on screen that would show
 * the rows they were looking for. That is word for word the defect 12.1
 * records against Accounts, on the busiest list in the product, reached from
 * five pages.
 *
 * `tests/ui-copy.test.ts` passes on this and says so itself: it reads the
 * `emptyScreen` call's own text and asks that three things are absent from it,
 * so a filter left out is invisible to it. This renders the screen instead.
 */
const account: Account = {
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

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function stub({ accountsFail = false, accounts = [account] } = {}) {
  const transactionQueries: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      const empty = {
        items: [],
        nextCursor: null,
        page: 1,
        pageSize: 50,
        totalCount: 0,
        cursorAvailable: false,
        totalPages: 1,
      };
      if (url.pathname === "/api/v1/transactions") {
        transactionQueries.push(url);
        return json(empty satisfies PaginatedPage<Transaction>);
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        return json(empty satisfies PaginatedPage<StagedTransaction>);
      }
      if (url.pathname === "/api/v1/accounts") {
        return accountsFail
          ? new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Down" } }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            })
          : json(accounts);
      }
      if (url.pathname === "/api/v1/categories") return json([]);
      if (url.pathname === "/api/v1/payees/suggestions") return json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return transactionQueries;
}

function renderRegister(
  search = "?preset=all-time",
  props: Partial<ComponentProps<typeof TransactionBrowser>> = {},
) {
  window.history.replaceState(null, "", `/transactions${search}`);
  return render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser
            heading={{ kind: "section", title: "Transactions", description: "For this test." }}
            {...props}
          />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the register's empty screen", () => {
  it("names Show deleted as a way out while it is hiding rows", async () => {
    stub();
    renderRegister();

    // Not "No transactions match this view": a default in force is not a filter
    // the reader set, and reading it as one would offer the toggle alone where
    // this screen also says what to add. Nor "yet": the page cannot tell an
    // empty ledger from one whose every entry is deleted, so a new ledger reads
    // this title on purpose (`web.md` 12.1) — and so the way out must not claim
    // a history it cannot see. It said "the entries you have removed" to
    // somebody who had never deleted anything.
    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    expect(
      screen.getByText(/Turn on Show deleted to include any deleted entries\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/you have removed/)).toBeNull();
  });

  it("says nothing yet once the reader has turned it on", async () => {
    stub();
    renderRegister();

    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show deleted"));

    // Nothing is in force now, so the third of 12.1's three reads applies and
    // the screen is the constructive one.
    expect(await screen.findByText("No transactions yet")).toBeInTheDocument();
    expect(screen.queryByText(/turn on Show deleted/i)).toBeNull();
  });

  /**
   * "Yet" is a claim about the whole ledger, and a bounded range cannot make
   * it: a view of July said "No transactions yet" with June full. The range is
   * still not a filter (`web.md` 12.1) — the screen is the constructive one,
   * about the range, with widening it named first.
   */
  it("says nothing in this range, rather than nothing yet, while a range is set", async () => {
    stub();
    renderRegister("?preset=custom&start=2026-07-01&end=2026-07-31");

    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show deleted"));
    expect(await screen.findByText("No transactions in this range")).toBeInTheDocument();
    expect(screen.getByText(/^Widen the date range, or add/)).toBeInTheDocument();
    expect(screen.queryByText("No transactions yet")).toBeNull();
  });

  it("keeps it a way out rather than a reason to say nothing matches", async () => {
    stub();
    renderRegister();

    expect(await screen.findByText("No transactions in this view")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter by type"), { target: { value: "deposit" } });

    // A filter the reader set decides the screen; the default rides along as a
    // second way out rather than deciding anything.
    expect(await screen.findByText("No transactions match this view")).toBeInTheDocument();
    expect(screen.getByText(/clear the type filter/i)).toBeInTheDocument();
    expect(screen.getByText(/turn on Show deleted/i)).toBeInTheDocument();
  });
});

/**
 * The empty register offers adding only where the page does.
 *
 * An archived account's register withheld the Add button, in the header and in
 * the empty state, and its body still said "add a deposit, a withdrawal or a
 * transfer, or import a CSV" — both writes the account refuses, named as the
 * way out by the page that had just refused them. A frozen account, and the
 * Transactions page with every account frozen, said the same. The button and
 * the sentence are one read now, and where there is no offer the screen says
 * why instead.
 */
describe("the empty register on a subject that refuses a new entry", () => {
  const offersAdding = /add a deposit|import a CSV/i;
  /** The empty state's sentence, which is the `<p>` under its heading. */
  const emptyBody = async () =>
    (await screen.findByRole("heading", { name: "No transactions in this view" }))
      .nextElementSibling;

  it("says the page's own reason, and still names Show deleted", async () => {
    stub();
    renderRegister("?preset=all-time", {
      fixedAccountId: account.id,
      allowCreate: false,
      createRefusal: "This account is archived. Restore it from Accounts to add to it.",
    });

    expect(await emptyBody()).toHaveTextContent(
      /^This account is archived\. Restore it from Accounts to add to it\. Turn on Show deleted to include any deleted entries\.$/,
    );
    expect(screen.queryByText(offersAdding)).toBeNull();
    expect(screen.queryByRole("button", { name: /Add transaction/ })).toBeNull();
  });

  it("says a frozen subject's sentence without being handed one", async () => {
    stub({ accounts: [{ ...account, frozen: true }] });
    renderRegister("?preset=all-time", { fixedAccountId: account.id, allowCreate: false });

    const body = await emptyBody();
    await waitFor(() =>
      expect(body).toHaveTextContent(frozenAccountRefusal(MAX_FREE_ACCOUNTS, account.name)),
    );
    expect(screen.queryByText(offersAdding)).toBeNull();
  });

  it("does not offer adding when every account is frozen", async () => {
    stub({ accounts: [{ ...account, frozen: true }] });
    renderRegister();

    // The header's button is disabled with this sentence, and the body under
    // it now says the same rather than the opposite.
    const body = await emptyBody();
    await waitFor(() => expect(body).toHaveTextContent(frozenAccountRefusal(MAX_FREE_ACCOUNTS)));
    expect(screen.queryByText(offersAdding)).toBeNull();
  });

  it("still offers adding where the page does", async () => {
    stub();
    renderRegister();

    const body = await emptyBody();
    await waitFor(() => expect(body).toHaveTextContent(offersAdding));
    expect(await screen.findAllByRole("button", { name: /Add transaction/ })).toHaveLength(2);
  });
});

describe("the Add button when the accounts did not load", () => {
  it("says they did not load, rather than that there are none", async () => {
    // It said "Create an account first." to somebody whose accounts merely
    // failed to arrive, which is a false sentence on a disabled button.
    stub({ accountsFail: true });
    renderRegister();
    const add = await screen.findByRole("button", { name: /Add transaction/ });
    await waitFor(() =>
      expect(add).toHaveAccessibleDescription(noAccountReason({ isPending: false, isError: true })),
    );
    expect(noAccountReason({ isPending: false, isError: false })).toBe("Create an account first.");
    expect(noAccountReason({ isPending: true, isError: false })).toBeUndefined();
  });
});
