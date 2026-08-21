// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/client/api.js";
import {
  moneyExtent,
  moneyRatioPercent,
  moneyScalePercent,
} from "../src/client/components.js";
import ReportsPage from "../src/client/pages/ReportsPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const report: Report = {
  report: "net-worth",
  range: { start: "2026-01-01", end: "2026-03-31" },
  asOf: "2026-03-31",
  bucket: "month",
  accumulation: "historical",
  includesArchived: false,
  buckets: [
    { start: "2026-01-01", end: "2026-01-31" },
    { start: "2026-02-01", end: "2026-02-28" },
    { start: "2026-03-01", end: "2026-03-31" },
  ],
  currencies: [
    {
      currency: "USD",
      rows: [
        {
          key: "checking",
          label: "Checking",
          kind: "checking",
          archived: false,
          values: ["100.00", "-25.00", "250.00"],
          total: "325.00",
        },
      ],
      totals: ["100.00", "-25.00", "250.00"],
    },
  ],
};

function stub(payload: Report = report) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.startsWith("/api/v1/reports/")) {
        return Response.json(payload);
      }
      return Response.json([]);
    }),
  );
}

const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

function renderReports(path = "/reports/net-worth") {
  window.history.replaceState(null, "", path);
  return render(
    <QueryClientProvider client={client()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/reports/:report" element={<ReportsPage />} />
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

describe("scaling money for a chart", () => {
  /**
   * The trap this helper exists for. `moneyRatioPercent` floors at four percent
   * and answers "4" for anything at or below zero, so a net worth of minus a
   * thousand would plot in the same place as a net worth of one pound.
   */
  it("places a negative value below a zero line rather than at the floor", () => {
    expect(moneyRatioPercent("-1000", "1000")).toBe("4");
    expect(moneyScalePercent("-1000", "-1000", "1000")).toBe("0");
    expect(moneyScalePercent("0", "-1000", "1000")).toBe("50");
    expect(moneyScalePercent("1000", "-1000", "1000")).toBe("100");
  });

  it("stays exact past what a double can hold", () => {
    const low = "0";
    const high = "9007199254740993";
    expect(moneyScalePercent("9007199254740992", low, high)).not.toBe("100");
    expect(moneyScalePercent(high, low, high)).toBe("100");
  });

  it("keeps eighteen decimal places apart", () => {
    expect(
      moneyScalePercent("0.000000000000000001", "0", "0.000000000000000002"),
    ).toBe("50");
  });

  it("puts a flat series in the middle rather than dividing by zero", () => {
    expect(moneyScalePercent("5", "5", "5")).toBe("50");
  });

  it("reads an extent without dropping negatives", () => {
    expect(moneyExtent(["-40", "10", "3"])).toEqual({ low: "-40", high: "10" });
    expect(moneyExtent([])).toBeNull();
  });
});

describe("the reports page", () => {
  it("draws every figure as text as well as in the chart", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });
    expect(screen.getAllByText("$100.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-$25.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$250.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$325.00").length).toBeGreaterThan(0);
  });

  it("labels the chart for anyone who cannot see it", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });
    expect(
      screen.getByRole("img", { name: /net worth over time, in usd/i }),
    ).toBeInTheDocument();
  });

  it("keeps the range and the report in the URL", async () => {
    stub();
    renderReports("/reports/net-worth?preset=custom&start=2026-01-01&end=2026-03-31");
    await screen.findByRole("rowheader", { name: "Checking" });
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(called).toContain("/api/v1/reports/net-worth");
    expect(called).toContain("start=2026-01-01");
    expect(called).toContain("end=2026-03-31");
  });

  it("writes the grouping to the URL rather than to component state", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });
    fireEvent.change(screen.getByLabelText("Group by"), {
      target: { value: "quarter" },
    });
    expect(new URLSearchParams(window.location.search).get("bucket")).toBe(
      "quarter",
    );
  });

  it("links every report without losing the range", async () => {
    stub();
    renderReports("/reports/net-worth?preset=custom&start=2026-01-01&end=2026-03-31");
    await screen.findByRole("rowheader", { name: "Checking" });
    const link = screen.getByRole("link", { name: "Cash flow" });
    expect(link.getAttribute("href")).toContain("/reports/cash-flow");
    expect(link.getAttribute("href")).toContain("start=2026-01-01");
  });

  /**
   * The figure will not match income and expenses whenever a credit card is
   * involved, so the reason travels with the number. Shipped without it, the
   * discrepancy reads as a defect rather than as the answer to a different
   * question.
   */
  it("explains on the page why cash flow disagrees with spending", async () => {
    stub({ ...report, report: "cash-flow", accumulation: "change" });
    renderReports("/reports/cash-flow");
    await screen.findByRole("rowheader", { name: "Checking" });
    expect(screen.getByRole("status")).toHaveTextContent(/credit card/i);
  });

  it("says nothing about credit cards on the other reports", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("falls back to net worth for a report nobody has", async () => {
    stub();
    renderReports("/reports/not-a-report");
    await screen.findByRole("rowheader", { name: "Checking" });
    const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(called).toContain("/api/v1/reports/net-worth");
  });

  it("shows a single-column report as a table with no chart", async () => {
    stub({
      ...report,
      report: "balance-sheet",
      bucket: "none",
      buckets: [{ start: "2026-01-01", end: "2026-03-31" }],
      currencies: [
        {
          currency: "USD",
          rows: [
            {
              key: "checking",
              label: "Checking",
              kind: "checking",
              archived: false,
              values: ["325.00"],
              total: "325.00",
            },
          ],
          totals: ["325.00"],
        },
      ],
    });
    renderReports("/reports/balance-sheet");
    await screen.findByRole("rowheader", { name: "Checking" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getAllByText("$325.00").length).toBeGreaterThan(0);
  });

  it("heads the trailing column of a running balance as a closing figure", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });
    expect(screen.getByRole("columnheader", { name: "Closing" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Total" })).toBeNull();
  });

  it("does not call a categories column sum a net", async () => {
    stub({
      ...report,
      report: "categories",
      accumulation: "change",
      currencies: [
        {
          currency: "USD",
          rows: [
            {
              key: "income:salary",
              label: "Salary",
              kind: "income",
              archived: false,
              values: ["3000.00", "3000.00", "3000.00"],
              total: "9000.00",
            },
            {
              key: "expense:rent",
              label: "Rent",
              kind: "expense",
              archived: false,
              values: ["1200.00", "1200.00", "1200.00"],
              total: "3600.00",
            },
          ],
          totals: ["4200.00", "4200.00", "4200.00"],
        },
      ],
    });
    renderReports("/reports/categories");
    await screen.findByRole("rowheader", { name: "Salary" });
    expect(screen.getByRole("rowheader", { name: "Total filed" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "Net" })).toBeNull();
  });

  it("does not tell a ledger it is empty when the report failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname.startsWith("/api/v1/reports/")) {
          return Response.json(
            { error: { code: "VALIDATION_ERROR", message: "Bucket is not valid" } },
            { status: 400 },
          );
        }
        return Response.json([]);
      }),
    );
    renderReports();
    expect(await screen.findByText("Bucket is not valid")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to report yet")).toBeNull();
  });
});
