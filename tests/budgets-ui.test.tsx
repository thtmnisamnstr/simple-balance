// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetReport, Category, Session } from "../src/client/api.js";
import BudgetsPage from "../src/client/pages/BudgetsPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const groceries = "11111111-1111-4111-8111-111111111111";
const rent = "22222222-2222-4222-8222-222222222222";
const transport = "44444444-4444-4444-8444-444444444444";

const categories: Category[] = [
  { id: groceries, name: "Groceries", kind: "expense", archivedAt: null, version: 1 },
  { id: rent, name: "Rent", kind: "expense", archivedAt: null, version: 1 },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Salary",
    kind: "income",
    archivedAt: null,
    version: 1,
  },
];

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
      partial: false,
      currency: "GBP",
      budgeted: "700",
      spent: "845",
      carriedIn: "0",
      available: "0",
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
          available: null,
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
          source: "entry",
          carriedIn: null,
          available: null,
          carriedOut: null,
          priority: 0,
          funded: null,
        },
        {
          categoryId: transport,
          category: "Transport",
          limit: "100",
          actual: "10",
          remaining: "90",
          source: "plan",
          carriedIn: null,
          available: null,
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

function stub(payload: BudgetReport = report) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      // Exact, not startsWith: the query string belongs after a "?", and
      // building the URL without one produced "/api/v1/budget-reportstart=..."
      // which a loose matcher would have accepted and nobody would have seen.
      if (url.pathname === "/api/v1/budget-report") return Response.json(payload);
      if (url.pathname === "/api/v1/categories") return Response.json(categories);
      return Response.json([]);
    }),
  );
}

const session = {
  user: { id: "u1", name: "Test", email: "test@example.com" },
  preferences: { timezone: "UTC", defaultCurrency: "GBP", chosen: true, theme: "system" },
  auth: { hasLocalPassword: true, hasGoogle: false },
} as unknown as Session;

function renderBudgets() {
  window.history.replaceState(null, "", "/budgets");
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
            <Route path="/budgets" element={<BudgetsPage session={session} />} />
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

describe("the budgets page", () => {
  /**
   * The state has to be readable without seeing the colour. A bar that is red
   * and nothing else says nothing to anybody who cannot separate red from
   * green, and nothing at all in a printout.
   */
  it("says what each row is doing in words, not only in colour", async () => {
    stub();
    renderBudgets();
    expect(await screen.findByText("Over")).toBeInTheDocument();
    // Spent to the penny is neither over nor nearly there.
    expect(screen.getByText("All spent")).toBeInTheDocument();
    expect(screen.getByText("Within budget")).toBeInTheDocument();
    expect(screen.getByText("No budget")).toBeInTheDocument();
  });

  it("shows the limit, the spending and what is left for each category", async () => {
    stub();
    renderBudgets();
    const groceriesRow = (
      await screen.findByRole("rowheader", {
        name: /Groceries/,
      })
    ).closest("tr")!;
    const cells = [...groceriesRow.querySelectorAll("td")].map((cell) => cell.textContent?.trim());
    expect(cells[0]).toContain("200");
    expect(cells[1]).toContain("245");
    expect(cells[2]).toContain("45");
  });

  /**
   * A category budgeted and not spent on is the row a budget page exists for,
   * and the row the obvious query drops. Nothing in the page may reintroduce
   * that: a limit with no spending still renders.
   */
  it("renders a budgeted category that was never spent on", async () => {
    stub({
      ...report,
      periods: [
        {
          ...report.periods[0]!,
          budgeted: "200",
          spent: "0",
          carriedIn: "0",
          available: "0",
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
              actual: "0",
              remaining: "200",
              source: "plan",
              carriedIn: null,
              available: null,
              carriedOut: null,
              priority: 0,
              funded: null,
            },
          ],
        },
      ],
    });
    renderBudgets();
    expect(await screen.findByRole("rowheader", { name: /Groceries/ })).toBeInTheDocument();
    expect(screen.getByText("Within budget")).toBeInTheDocument();
  });

  /** An override is a different thing from a standing budget, and says so. */
  it("marks a period that was overridden", async () => {
    stub();
    renderBudgets();
    expect(await screen.findByText(/This month only/)).toBeInTheDocument();
  });

  /**
   * The server refuses a limit on an income category, so offering one here
   * would be a refusal with no visible cause.
   */
  it("offers only categories that can carry spending", async () => {
    stub();
    renderBudgets();
    // Waiting on the option rather than the field: the select renders with its
    // placeholder before the categories have arrived.
    const groceriesOption = await screen.findByRole("option", {
      name: "Groceries",
    });
    const picker = groceriesOption.closest("select")!;
    const options = [...picker.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toContain("Groceries");
    expect(options).not.toContain("Salary");
  });

  /**
   * The page tells somebody to end a budget rather than rewrite it, so it has
   * to give them a way to end one. It did not, and the copy was the only place
   * the capability existed.
   */
  it("can end a standing budget without rewriting what past periods intended", async () => {
    const plan = {
      id: "55555555-5555-4555-8555-555555555555",
      categoryId: groceries,
      categoryName: "Groceries",
      groupId: null,
      groupName: null,
      // What the page calls the budget, whichever kind of thing it is about.
      targetName: "Groceries",
      currency: "GBP",
      periodUnit: "month" as const,
      amount: "200",
      activeFrom: "2026-01-01",
      activeTo: null,
      rollover: false,
      rolloverCap: null,
      targetAmount: null,
      targetDate: null,
      lookbackPeriods: null,
      percentOfPrevious: null,
      percentOfIncome: null,
      priority: 0,
      amountRule: "fixed" as const,
      version: 1,
    };
    const calls: { url: string; body: unknown; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/budget-report") {
          return Response.json({ ...report, periods: [] });
        }
        if (url.pathname.startsWith("/api/v1/budget-plans")) {
          if (init?.method === "PUT") {
            calls.push({
              url: url.pathname,
              method: init.method,
              body: JSON.parse(String(init.body)),
            });
            return Response.json({ ...plan, activeTo: "2026-06-30", version: 2 });
          }
          return Response.json([plan]);
        }
        if (url.pathname === "/api/v1/categories") {
          return Response.json(categories);
        }
        return Response.json([]);
      }),
    );
    renderBudgets();

    fireEvent.click(await screen.findByRole("button", { name: "Change Groceries" }));
    fireEvent.change(screen.getByLabelText(/Ends after/), {
      target: { value: "2026-06-30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save budget" }));

    // Rendered as the period it names, never the raw snapped date: "to
    // June 2026", not "to 2026-06-01", which reads a whole month short.
    await screen.findByText(/onward|June 2026/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      activeTo: "2026-06-30",
      expectedVersion: 1,
    });
  });

  /**
   * The gap this closes: the tools could set a single period and the page
   * could not, so an agent had a capability its owner did not.
   */
  it("sets an amount for one period without touching the standing budget", async () => {
    const writes: { body: unknown; method?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/budget-report") return Response.json(report);
        if (url.pathname === "/api/v1/categories") return Response.json(categories);
        if (url.pathname === "/api/v1/budget-entries") {
          if (init?.method === "PUT") {
            writes.push({ method: init.method, body: JSON.parse(String(init.body)) });
            return Response.json({});
          }
          return Response.json([]);
        }
        return Response.json([]);
      }),
    );
    renderBudgets();

    const groceriesRow = (
      await screen.findByRole("rowheader", {
        name: /Groceries/,
      })
    ).closest("tr")!;
    fireEvent.click(within(groceriesRow).getByRole("button", { name: /Just this month/ }));
    const dialog = within(screen.getByRole("dialog", { name: /Groceries, March 2026/ }));
    fireEvent.change(dialog.getByLabelText(/Amount/), {
      target: { value: "300.00" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      categoryId: groceries,
      currency: "GBP",
      periodUnit: "month",
      periodStart: "2026-03-01",
      amount: "300.00",
    });
    // No version on a period that had none: sending one would claim to be
    // changing something that is not there.
    expect(writes[0]!.body).not.toHaveProperty("expectedVersion");
  });

  it("puts a period back on the standing budget", async () => {
    const entry = {
      id: "66666666-6666-4666-8666-666666666666",
      categoryId: rent,
      categoryName: "Rent",
      currency: "GBP",
      periodUnit: "month" as const,
      periodStart: "2026-03-01",
      amount: "500",
      version: 3,
    };
    const deletes: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/budget-report") return Response.json(report);
        if (url.pathname === "/api/v1/categories") return Response.json(categories);
        if (url.pathname === "/api/v1/budget-entries") return Response.json([entry]);
        if (url.pathname.startsWith("/api/v1/budget-entries/")) {
          deletes.push({ path: url.pathname, body: JSON.parse(String(init!.body)) });
          return Response.json({ id: entry.id });
        }
        return Response.json([]);
      }),
    );
    renderBudgets();

    // Scoped to the report table: an override also appears in the
    // single-periods panel, so an unscoped rowheader now matches twice.
    const reportTable = await screen.findByRole("table", {
      name: /Budget against spending/,
    });
    const rentRow = within(reportTable).getByRole("rowheader", { name: /Rent/ }).closest("tr")!;
    // The row already carries an override, so the action says so.
    fireEvent.click(within(rentRow).getByRole("button", { name: /Change this month/ }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /Rent, March 2026/ })).getByRole("button", {
        name: /Use the standing budget/,
      }),
    );

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]!.path).toBe(`/api/v1/budget-entries/${entry.id}`);
    expect(deletes[0]!.body).toMatchObject({ expectedVersion: 3 });
  });

  /**
   * A list that failed to load must not read as a list that is empty. Both said
   * "you have none", which is a different and wrong answer.
   */
  it("says the standing budgets failed rather than that there are none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/budget-report") return Response.json(report);
        if (url.pathname === "/api/v1/categories") return Response.json(categories);
        if (url.pathname === "/api/v1/budget-plans") {
          return Response.json(
            { error: { code: "INTERNAL_ERROR", message: "Database is away" } },
            { status: 500 },
          );
        }
        return Response.json([]);
      }),
    );
    renderBudgets();
    expect(
      await screen.findByText(/could not be loaded, so this is not a list/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("No standing budgets yet.")).not.toBeInTheDocument();
  });

  /** A period that has not finished is not a period somebody stayed within. */
  it("says a running period is so far rather than within budget", async () => {
    stub({
      ...report,
      periods: [{ ...report.periods[0]!, partial: true }],
    });
    renderBudgets();
    expect(await screen.findByText("So far")).toBeInTheDocument();
    expect(screen.queryByText("Within budget")).not.toBeInTheDocument();
    // Over is still over: a period being unfinished does not unspend anything.
    expect(screen.getByText("Over")).toBeInTheDocument();
  });

  it("says nothing is budgeted rather than showing an empty table", async () => {
    stub({ ...report, periods: [] });
    renderBudgets();
    expect(await screen.findByText(/Nothing budgeted in this range/)).toBeInTheDocument();
  });

  /**
   * The carry columns, which appear only where something carries.
   *
   * A ledger that has never ticked the box would otherwise grow two columns of
   * dashes, which says a budget has a feature it does not have.
   */
  it("shows what was carried in only when a budget carries something", async () => {
    stub(report);
    renderBudgets();
    expect(await screen.findByRole("rowheader", { name: /Groceries/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Carried in" })).not.toBeInTheDocument();

    stub({
      ...report,
      rollover: { from: "2026-01-01", clipped: false },
      periods: [
        {
          ...report.periods[0]!,
          carriedIn: "60",
          available: "260",
          rows: [
            {
              categoryId: groceries,
              category: "Groceries",
              limit: "200",
              actual: "245",
              remaining: "15",
              source: "plan",
              carriedIn: "60",
              available: "260",
              carriedOut: "15",
              priority: 0,
              funded: null,
            },
          ],
        },
      ],
    });
    renderBudgets();
    expect(await screen.findByRole("columnheader", { name: "Carried in" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Available" })).toBeInTheDocument();
    // And the page says how far back the figure was worked out from, because a
    // carry with no visible history is a number nobody can check.
    expect(screen.getByText(/worked out from/i)).toBeInTheDocument();
  });

  it("says when the carry was folded from as far back as it looks", async () => {
    stub({
      ...report,
      rollover: { from: "2020-01-01", clipped: true },
      periods: [
        {
          ...report.periods[0]!,
          carriedIn: "10",
          available: "210",
          rows: [
            {
              ...report.periods[0]!.rows[0]!,
              carriedIn: "10",
              available: "210",
              carriedOut: "0",
              priority: 0,
              funded: null,
            },
          ],
        },
      ],
    });
    renderBudgets();
    expect(await screen.findByText(/as far back as this page looks/i)).toBeInTheDocument();
  });

  /**
   * The funded column, which is the funding order made visible.
   *
   * Same rule as the carry columns and for the same reason: a ledger that never
   * ranked anything should not be told its budgets are unfunded because income
   * happened to land in another period.
   */
  it("shows what the income funds only where somebody ranked something", async () => {
    stub(report);
    renderBudgets();
    expect(await screen.findByRole("rowheader", { name: /Groceries/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Funded" })).not.toBeInTheDocument();

    stub({
      ...report,
      periods: [
        {
          ...report.periods[0]!,
          income: "150",
          unfunded: "550",
          rows: [
            {
              ...report.periods[0]!.rows[0]!,
              priority: 1,
              funded: "150",
            },
          ],
        },
      ],
    });
    renderBudgets();
    expect(await screen.findByRole("columnheader", { name: "Funded" })).toBeInTheDocument();
    expect(screen.getByText(/came in, leaving/i)).toBeInTheDocument();
  });
});
