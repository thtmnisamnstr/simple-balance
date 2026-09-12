// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetReport, Summary } from "../src/client/api.js";
import DashboardPage from "../src/client/pages/DashboardPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const groceries = "11111111-1111-4111-8111-111111111111";
const rent = "22222222-2222-4222-8222-222222222222";

const summary: Summary = {
  range: { start: "2026-03-01", end: "2026-03-31" },
  asOf: "2026-03-31",
  includesArchived: false,
  currencies: [
    {
      currency: "GBP",
      balance: "1000",
      deposits: "2000",
      withdrawals: "1000",
      netCashFlow: "1000",
      accounts: [
        { id: "a1", name: "Current", type: "checking", balance: "1000", archivedAt: null },
      ],
      spendingByCategory: [{ categoryId: groceries, category: "Groceries", amount: "245" }],
    },
  ],
};

/** A period holding two budgeted categories and one that is not budgeted. */
const report: BudgetReport = {
  periodUnit: "month",
  start: "2026-03-01",
  asOf: "2026-03-31",
  otherPeriodUnits: [],
  rollover: null,
  periods: [
    {
      periodStart: "2026-03-01",
      start: "2026-03-01",
      end: "2026-03-31",
      partial: true,
      currency: "GBP",
      budgeted: "700",
      spent: "845",
      carriedIn: "0",
      available: "700",
      income: "0",
      unfunded: null,
      groups: [],
      toAssign: null,
      perimeter: "0",
      rows: [
        {
          categoryId: groceries,
          category: "Groceries",
          limit: "200",
          actual: "245",
          remaining: "-45",
          source: "plan",
          carriedIn: null,
          available: "200",
          carriedOut: null,
          priority: 0,
          funded: null,
        },
        {
          categoryId: rent,
          category: "Rent",
          limit: "500",
          actual: "500",
          remaining: "0",
          source: "plan",
          carriedIn: null,
          available: "500",
          carriedOut: null,
          priority: 0,
          funded: null,
        },
        {
          categoryId: null,
          category: "Uncategorized",
          limit: null,
          actual: "100",
          remaining: null,
          source: "none",
          carriedIn: null,
          available: null,
          carriedOut: null,
          priority: 0,
          funded: null,
        },
      ],
    },
  ],
};

/**
 * Groceries carries £50 forward, so its limit and what it may spend differ.
 *
 * The case that caught a real defect: the figure said "of £200.00" while the
 * bar and the badge were drawn against £250.00.
 */
const carrying: BudgetReport = {
  ...report,
  periods: [
    {
      ...report.periods[0]!,
      // The period totals diverge too, so the header is covered by the same
      // case as the row. They used to be left equal, which is why the header
      // printing `budgeted` beside a bar drawn against `available` survived.
      budgeted: "700",
      available: "750",
      spent: "620",
      rows: [
        {
          ...report.periods[0]!.rows[0]!,
          actual: "120",
          carriedIn: "50",
          available: "250",
          remaining: "130",
        },
        ...report.periods[0]!.rows.slice(1),
      ],
    },
  ],
};

/** Two periods in range: only the newest is broken down. */
const twoPeriods: BudgetReport = {
  ...report,
  periods: [
    {
      ...report.periods[0]!,
      periodStart: "2026-02-01",
      start: "2026-02-01",
      end: "2026-02-28",
      partial: false,
    },
    report.periods[0]!,
  ],
};

/**
 * A budget nobody has spent against, and a group holding its own budget.
 *
 * The case the panel exists for and used to hide: `Rent` is budgeted at 500
 * with nothing spent, so it ranks last by how much of its money is gone and a
 * cap of six buried it. There is no cap now — the list is as long as the
 * budgets somebody set.
 */
const unspent: BudgetReport = {
  ...report,
  periods: [
    {
      ...report.periods[0]!,
      groups: [
        {
          groupId: "aaaaaaaa-1111-4111-8111-111111111111",
          name: "Fixed costs",
          policy: "standalone",
          limit: "800",
          actual: "500",
          remaining: "300",
          source: "plan",
          carriedIn: null,
          available: "800",
          carriedOut: null,
          priority: 0,
          funded: null,
        },
      ],
      rows: [
        { ...report.periods[0]!.rows[0]! },
        { ...report.periods[0]!.rows[1]!, actual: "0", remaining: "500" },
        report.periods[0]!.rows[2]!,
      ],
    },
  ],
};

/** The same range, with every limit gone: spending, and nothing budgeted. */
const nothingBudgeted: BudgetReport = {
  ...report,
  periods: [
    {
      ...report.periods[0]!,
      budgeted: "0",
      available: "0",
      rows: [report.periods[0]!.rows[2]!],
    },
  ],
};

function stub(budget: BudgetReport | "error" = report) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/summary") return Response.json(summary);
      if (url.pathname === "/api/v1/budget-report") {
        if (budget === "error")
          return Response.json({ error: { message: "nope" } }, { status: 500 });
        return Response.json(budget);
      }
      return Response.json([]);
    }),
  );
}

function renderOverview() {
  window.history.replaceState(null, "", "/?start=2026-03-01&end=2026-03-31");
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
          </Routes>
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

/**
 * The budget panel alone.
 *
 * A category name appears twice on this page — once under "Spending by
 * category" and once here — so an unscoped query finds both and the failure
 * reads as a missing element rather than as a duplicate.
 */
async function budgetPanel() {
  const heading = await screen.findByRole("heading", { name: "Budget" });
  return heading.closest("section") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The Overview's budget panel, which had no test at all.
 *
 * That is how an unreachable branch shipped: the panel is gated on
 * `isError || isPending || periods.length`, and the empty state inside it is
 * gated on `!isError && !isPending && periods.length === 0` — the exact
 * complement, so the message could never render and the whole panel vanished
 * instead. A reader with budgets set in another month saw no panel and no
 * reason, which reads as the section never having been built.
 */
describe("the Overview's budget panel", () => {
  it("says nothing is budgeted rather than disappearing", async () => {
    stub(nothingBudgeted);
    renderOverview();
    expect(await screen.findByRole("heading", { name: "Budget" })).toBeInTheDocument();
    expect(screen.getByText(/No category budgeted in this range/)).toBeInTheDocument();
  });

  it("says no CATEGORY is budgeted, because a group budget is not counted here", async () => {
    // The sentence used to say "Nothing budgeted in this range", which is false
    // for a ledger budgeted entirely at the group level: `period.budgeted` sums
    // category limits only, so the panel filtered the period out and then
    // asserted something the figure behind it does not know. The budgets page
    // has the same care in its own summary — "budgeted across the categories".
    stub(nothingBudgeted);
    renderOverview();
    const panel = await budgetPanel();
    expect(within(panel).getByText(/No category budgeted in this range/)).toBeInTheDocument();
  });

  it("shows the period and what it stands at", async () => {
    stub();
    renderOverview();
    expect(await screen.findByRole("heading", { name: "Budget" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/March 2026/)).toBeInTheDocument());
  });

  it("breaks the period down by category, linked and with the range", async () => {
    stub();
    renderOverview();
    const panel = await budgetPanel();
    const groceries = await within(panel).findByRole("link", { name: "Groceries" });
    // The range travels, so the category page opens on the month just read.
    expect(groceries.getAttribute("href")).toContain("start=2026-03-01");
    expect(within(panel).getByRole("link", { name: "Rent" })).toBeInTheDocument();
    // Spent against the limit, both formatted as money.
    expect(within(panel).getByText(/£245\.00 of £200\.00/)).toBeInTheDocument();
  });

  it("shows a budget with nothing spent against it", async () => {
    // The panel is about budgets, not about spending: a category budgeted at
    // 500 and spent nothing on is exactly the row somebody opens this to see.
    stub(unspent);
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Rent" });
    expect(within(panel).getByText(/£0\.00 of £500\.00/)).toBeInTheDocument();
  });

  it("shows a group that holds a budget, badged for how it is budgeted", async () => {
    stub(unspent);
    renderOverview();
    const panel = await budgetPanel();
    expect(await within(panel).findByText("Fixed costs")).toBeInTheDocument();
    // The badge is what says a group and its categories are not to be added.
    expect(within(panel).getByText("Own budget")).toBeInTheDocument();
    expect(within(panel).getByText(/£500\.00 of £800\.00/)).toBeInTheDocument();
  });

  it("caps nothing: every budget somebody set is shown", async () => {
    stub(unspent);
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Rent" });
    expect(within(panel).queryByText(/more categor/i)).not.toBeInTheDocument();
  });

  it("leaves out a category nobody budgeted", async () => {
    // "Spending by category" above already reports it, and a row reading
    // "£100.00 of —" is a budget that does not exist.
    stub();
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    expect(within(panel).queryByText("Uncategorized")).not.toBeInTheDocument();
  });

  it("says which categories are over, in words as well as colour", async () => {
    stub();
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    // Groceries spent 245 of 200. The bar's accessible name carries the same
    // judgement the badge does, so the state never reaches somebody as colour
    // alone.
    expect(
      screen.getByRole("img", { name: /Groceries: Over, £245\.00 of £200\.00/ }),
    ).toBeInTheDocument();
    // Rent spent exactly its 500, which is neither over nor nearly there.
    expect(screen.getByRole("img", { name: /Rent: All spent/ })).toBeInTheDocument();
  });

  it("puts the category with most of its money gone first", async () => {
    // The cap is six; ordering the report's own way and taking the first six
    // could hide the one in trouble, so the order is most-consumed first.
    stub();
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    const names = within(panel)
      .getAllByRole("img")
      .map((bar) => bar.getAttribute("aria-label") ?? "")
      .filter((label) => /^(Groceries|Rent):/.test(label))
      .map((label) => label.split(":")[0]);
    expect(names).toEqual(["Groceries", "Rent"]);
  });

  it("says so when the figures could not be loaded", async () => {
    stub("error");
    renderOverview();
    expect(await screen.findByRole("heading", { name: "Budget" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/budget figures could not be loaded/)).toBeInTheDocument(),
    );
  });
});

describe("what the overview's budget panel leaves out", () => {
  it("measures a carrying category against what it may actually spend", async () => {
    // `remaining` is `available` minus spent, so the figure, the bar and the
    // badge all have to use `available`. Printing the bare limit beside a bar
    // drawn against `available` is one row disagreeing with itself.
    stub(carrying);
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    expect(within(panel).getByText(/£120\.00 of £250\.00/)).toBeInTheDocument();
    expect(within(panel).queryByText(/£120\.00 of £200\.00/)).not.toBeInTheDocument();
  });

  it("measures the period line against what the period may spend", async () => {
    // Same rule as the row beneath it: the figure, the bar and the badge take
    // one denominator. With £50 carried in, the line reads against £750 and
    // not against the £700 that was planned.
    stub(carrying);
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    expect(within(panel).getByText(/£620\.00 of £750\.00/)).toBeInTheDocument();
    expect(within(panel).queryByText(/£620\.00 of £700\.00/)).not.toBeInTheDocument();
  });

  it("breaks down only the period the range ends in", async () => {
    // A year of months would otherwise put seventy-two rows on a glance page,
    // per currency. The settled periods keep their one-line summary.
    stub(twoPeriods);
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByText(/February 2026/);
    expect(within(panel).getByText(/March 2026/)).toBeInTheDocument();
    // One breakdown, not two.
    expect(within(panel).getAllByRole("link", { name: "Groceries" })).toHaveLength(1);
  });

  it("says when the carry was folded from as far back as it looks", async () => {
    stub({ ...report, rollover: { from: "2025-01-01", clipped: true } });
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    expect(within(panel).getByText(/as far back as this looks/)).toBeInTheDocument();
  });

  it("stays quiet when the carry reached the beginning", async () => {
    stub({ ...report, rollover: { from: "2026-01-01", clipped: false } });
    renderOverview();
    const panel = await budgetPanel();
    await within(panel).findByRole("link", { name: "Groceries" });
    expect(within(panel).queryByText(/as far back as this looks/)).not.toBeInTheDocument();
  });
});
