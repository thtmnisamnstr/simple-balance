// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  AccountBalanceSnapshot,
  AccountRegister,
} from "../src/client/api.js";
import AccountDetailPage from "../src/client/pages/AccountDetailPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const accountId = "11111111-1111-4111-8111-111111111111";

const account: Account = {
  id: accountId,
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "1000",
  version: 1,
  archivedAt: null,
  balance: "900",
  balancePresentation: { label: "Balance", amount: "900" },
};

const balances: AccountBalanceSnapshot = {
  accountId,
  currency: "USD",
  range: { start: null, end: null, today: "2026-08-21" },
  beginning: { balance: "1000", balancePresentation: { label: "Balance", amount: "1000" } },
  ending: { balance: "900", balancePresentation: { label: "Balance", amount: "900" } },
  current: { balance: "900", balancePresentation: { label: "Balance", amount: "900" } },
  future: { balance: "900", balancePresentation: { label: "Balance", amount: "900" } },
};

const register: AccountRegister = {
  accountId,
  accountName: "Checking",
  type: "checking",
  currency: "USD",
  archivedAt: null,
  range: { start: null, end: null },
  asOf: "2026-08-21",
  openingBalance: "0",
  closingBalance: "900",
  entries: [
    {
      postingId: "p1",
      transactionId: null,
      date: "2026-01-01",
      amount: "1000",
      balanceBefore: "0",
      balanceAfter: "1000",
      origin: "opening",
    },
    {
      postingId: "p2",
      transactionId: "22222222-2222-4222-8222-222222222222",
      date: "2026-02-01",
      amount: "-100",
      balanceBefore: "1000",
      balanceAfter: "900",
      origin: "transaction",
    },
  ],
};

/** Counted so the test can prove the register is not fetched until it is asked for. */
let registerRequests = 0;

function stub(registerPayload: AccountRegister | "error" = register) {
  registerRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/register")) {
        registerRequests += 1;
        if (registerPayload === "error") {
          return Response.json(
            { error: { code: "VALIDATION_ERROR", message: "That range holds too many postings" } },
            { status: 400 },
          );
        }
        return Response.json(registerPayload);
      }
      if (url.pathname.endsWith("/balances")) return Response.json(balances);
      if (url.pathname === `/api/v1/accounts/${accountId}`) return Response.json(account);
      return Response.json([]);
    }),
  );
}

function renderPage() {
  window.history.replaceState(null, "", `/accounts/${accountId}`);
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
            <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
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

/**
 * The register was reachable over the API and MCP and nowhere in the browser, so
 * an agent could answer "which row did this balance go wrong on" and the person
 * whose ledger it is could not.
 */
describe("an account's register", () => {
  it("is not fetched until it is asked for", async () => {
    stub();
    renderPage();
    await screen.findByRole("heading", { name: "Register" });

    expect(registerRequests).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Show register" }));

    expect(await screen.findByRole("rowheader", { name: "Feb 1, 2026" })).toBeInTheDocument();
    expect(registerRequests).toBe(1);
  });

  it("shows every posting with the balance before and after it", async () => {
    stub();
    renderPage();
    await screen.findByRole("heading", { name: "Register" });
    fireEvent.click(screen.getByRole("button", { name: "Show register" }));

    const row = await screen.findByRole("row", { name: /Feb 1, 2026/ });
    const cells = within(row).getAllByRole("cell").map((cell) => cell.textContent);
    // Origin, amount, before, after — the balance either side of the row is the
    // whole reason the register exists.
    expect(cells).toEqual(["Transaction", "-$100.00", "$1,000.00", "$900.00"]);

    expect(
      within(await screen.findByRole("row", { name: /Jan 1, 2026/ })).getByText(
        "Opening balance",
      ),
    ).toBeInTheDocument();
  });

  it("names the range it is reporting for", async () => {
    stub();
    renderPage();
    await screen.findByRole("heading", { name: "Register" });
    fireEvent.click(screen.getByRole("button", { name: "Show register" }));

    expect(await screen.findByText(/Opening \$0\.00, closing \$900\.00/)).toBeInTheDocument();
    expect(screen.getByText(/as of Aug 21, 2026/)).toBeInTheDocument();
  });

  it("hides again without losing the page", async () => {
    stub();
    renderPage();
    await screen.findByRole("heading", { name: "Register" });
    fireEvent.click(screen.getByRole("button", { name: "Show register" }));
    await screen.findByRole("rowheader", { name: "Feb 1, 2026" });

    fireEvent.click(screen.getByRole("button", { name: "Hide register" }));

    expect(screen.queryByRole("rowheader", { name: "Feb 1, 2026" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Checking" })).toBeInTheDocument();
  });

  it("says what went wrong rather than showing an empty table", async () => {
    stub("error");
    renderPage();
    await screen.findByRole("heading", { name: "Register" });
    fireEvent.click(screen.getByRole("button", { name: "Show register" }));

    expect(
      await screen.findByText("That range holds too many postings"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so when the range holds nothing", async () => {
    stub({ ...register, entries: [], openingBalance: "900", closingBalance: "900" });
    renderPage();
    await screen.findByRole("heading", { name: "Register" });
    fireEvent.click(screen.getByRole("button", { name: "Show register" }));

    expect(await screen.findByText("No postings in this range.")).toBeInTheDocument();
  });
});
