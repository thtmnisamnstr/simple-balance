// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Session } from "../src/client/api.js";
import { BrowserRouter } from "../src/client/router.js";
import AccountsPage from "../src/client/pages/AccountsPage.js";
import DashboardPage from "../src/client/pages/DashboardPage.js";

const session: Session = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  preferences: {
    userId: "u1",
    timezone: "UTC",
    defaultCurrency: "USD",
    chosen: true,
  },
  auth: {
    localEnabled: true,
    googleEnabled: false,
    hasLocalPassword: true,
    hasGoogleAccount: false,
  },
} as unknown as Session;

const account = (name: string, type: string): Account =>
  ({
    id: `id-${name}`,
    name,
    type,
    currency: "USD",
    openingDate: "2026-01-01",
    openingBalance: "0",
    version: 1,
    balance: "10.00",
    balancePresentation: { label: "Balance", amount: "10.00" },
  }) as unknown as Account;

/** Deliberately not in display order, so ordering cannot pass by accident. */
const accounts = [
  account("Mortgage", "loan"),
  account("Everyday", "checking"),
  account("Wallet", "cash"),
  account("Amex", "credit_card"),
  account("Rainy day", "savings"),
  account("Brokerage", "investment"),
];

function stub(extra: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/accounts") return Response.json(accounts);
      if (url.pathname === "/api/v1/summary") {
        return Response.json({
          asOf: "2026-08-06",
          currencies: [
            {
              currency: "USD",
              balance: "60.00",
              deposits: "0",
              withdrawals: "0",
              netCashFlow: "0",
              accounts: accounts.map((one) => ({
                id: one.id,
                name: one.name,
                type: one.type,
                balance: one.balance,
                archivedAt: null,
              })),
              spendingByCategory: [],
            },
          ],
          ...extra,
        });
      }
      return Response.json([]);
    }),
  );
}

const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

const headings = (selector: string) =>
  [...document.querySelectorAll(selector)].map((node) =>
    node.textContent?.replace(/\d+ accounts?$/, "").trim(),
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("accounts grouped by type", () => {
  it("heads each type on the accounts page, in order", async () => {
    stub();
    render(
      <QueryClientProvider client={client()}>
        <BrowserRouter>
          <AccountsPage session={session} />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("Wallet");

    expect(headings(".account-type-heading")).toEqual([
      "Cash",
      "Checking",
      "Savings",
      "Credit Card",
      "Loan",
      "Investment",
    ]);
  });

  it("heads each type on the overview, in the same order", async () => {
    stub();
    render(
      <QueryClientProvider client={client()}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("Wallet");

    expect(headings(".account-mini-heading")).toEqual([
      "Cash",
      "Checking",
      "Savings",
      "Credit Card",
      "Loan",
      "Investment",
    ]);
  });

  /**
   * The balance is what somebody is looking at when they decide to open an
   * account, so the row is the target rather than the name alone. The range
   * travels with them: without it the account page recomputes the month from
   * its own default and shows a different period from the one they clicked on.
   */
  it("opens an account from the overview, keeping the range", async () => {
    stub();
    window.history.replaceState(null, "", "/?preset=custom&start=2026-03-01&end=2026-03-31");
    render(
      <QueryClientProvider client={client()}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("Wallet");

    const row = screen.getByText("Wallet").closest("a");
    expect(row).not.toBeNull();
    const href = row!.getAttribute("href")!;
    expect(href.startsWith("/accounts/id-Wallet?")).toBe(true);
    const asked = new URL(href, window.location.origin).searchParams;
    expect(asked.get("start")).toBe("2026-03-01");
    expect(asked.get("end")).toBe("2026-03-31");
    // The balance is inside the link, so the whole row is clickable rather
    // than just the name.
    expect(row!.textContent).toContain("Wallet");
    expect(row!.textContent).toContain("$10.00");
    window.history.replaceState(null, "", "/");
  });

  it("keeps every account it was given", async () => {
    stub();
    render(
      <QueryClientProvider client={client()}>
        <BrowserRouter>
          <AccountsPage session={session} />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("Wallet");
    for (const one of accounts) {
      expect(screen.getAllByText(one.name).length).toBeGreaterThan(0);
    }
  });
});
