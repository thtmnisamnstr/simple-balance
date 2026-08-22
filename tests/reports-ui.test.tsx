// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/client/api.js";
import {
  bucketLabel,
  labelBudget,
  labelledBuckets,
  niceTicks,
} from "../src/client/charts.js";
import {
  moneyExtent,
  moneyRatioPercent,
  moneyScalePercent,
} from "../src/client/money.js";
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

/**
 * A chart with no numbers beside it is a shape. These were drawn for a year
 * without a value scale or a date under them, which made a line that ended
 * higher than it started the only thing either chart actually said.
 */
describe("the axis a chart is read against", () => {
  it("puts the gridlines on round numbers, not on quarters of the range", () => {
    // Four equal slices of this range would be 1247.83, 2495.66, 3743.49.
    expect(niceTicks("0", "4991.32")).toEqual([
      "0",
      "1000",
      "2000",
      "3000",
      "4000",
    ]);
  });

  it("crosses zero when the range does, so the line is one of the ticks", () => {
    expect(niceTicks("-1800", "3200")).toContain("0");
  });

  it("holds to the scale money is stored at", () => {
    // Eighteen decimal places, where a step worked out in floating point would
    // land the tick a hair off the round number it is printed as.
    expect(niceTicks("0", "0.000000000000000005")).toEqual([
      "0",
      "0.000000000000000001",
      "0.000000000000000002",
      "0.000000000000000003",
      "0.000000000000000004",
      "0.000000000000000005",
    ]);
  });

  it("draws one line for a series that never moves", () => {
    expect(niceTicks("5", "5")).toEqual(["5"]);
  });

  it("never returns a single tick for a range that has two ends", () => {
    for (const [low, high] of [
      ["0", "1"],
      ["-1", "1"],
      ["0", "0.000000000000000001"],
      ["1000000000000", "1000000000001"],
    ]) {
      expect(niceTicks(low!, high!).length, `${low}..${high}`).toBeGreaterThan(1);
    }
  });

  /**
   * A report will draw up to six hundred columns, and six hundred dates under
   * one is a grey smear. Both ends are always named, or the axis stops saying
   * where the series begins and ends.
   */
  it("thins the dates evenly, and labels a year of months in full", () => {
    expect(labelledBuckets(4)).toEqual([0, 1, 2, 3]);
    // Twelve months all get a label. Spreading a fixed count across the range
    // instead rounded to 0, 1, 2, 4, 5, 6, 7 and skipped April on its own.
    expect(labelledBuckets(12)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);

    const many = labelledBuckets(600);
    expect(many.length).toBeLessThanOrEqual(12);
    expect(many[0]).toBe(0);
    // Every gap identical, because a stride cannot bunch.
    const gaps = many.slice(1).map((at, index) => at - many[index]!);
    expect(new Set(gaps).size).toBe(1);
  });

  /**
   * Twelve dates read well across a report panel and are a grey smear across a
   * phone, where they overlapped into one illegible line. The budget comes from
   * the measured width of the drawing rather than from a breakpoint, because the
   * same chart is wide on this page and narrow in a card at the same viewport.
   */
  it("spends fewer labels on a narrower chart", () => {
    expect(labelBudget(1130)).toBe(12);
    expect(labelBudget(600)).toBe(7);
    // A phone, where twelve became a smear and four still touched.
    expect(labelBudget(300)).toBe(3);
    // Never one, which says less than none, and never zero.
    expect(labelBudget(40)).toBe(2);
    expect(labelBudget(0)).toBe(12);
    expect(labelBudget(Number.NaN)).toBe(12);
  });

  it("thins to whatever budget it is given", () => {
    expect(labelledBuckets(12, 4)).toEqual([0, 3, 6, 9]);
    expect(labelledBuckets(12, 12)).toHaveLength(12);
    // A budget of nothing still returns something rather than dividing by zero.
    expect(labelledBuckets(4, 0)).toEqual([0]);
  });

  /**
   * The full date belongs in the table's column header, which has the room for
   * it. Under the chart it only has to say which period this is, and the
   * shorter it is the more of them fit before the axis has to start skipping.
   */
  it("writes each bucket the way that bucket is named", () => {
    expect(bucketLabel("2026-04-01", "year")).toBe("2026");
    expect(bucketLabel("2026-04-01", "quarter")).toBe("Q2 2026");
    expect(bucketLabel("2026-10-01", "quarter")).toBe("Q4 2026");
    expect(bucketLabel("2026-04-01", "month")).toBe("Apr 2026");
    expect(bucketLabel("2026-04-06", "week")).toBe("Apr 6");
    // A date the calendar does not have is shown as it arrived rather than
    // throwing inside a render.
    expect(bucketLabel("nonsense", "month")).toBe("nonsense");
  });

  it("labels nothing when there is nothing to label", () => {
    expect(labelledBuckets(0)).toEqual([]);
  });
});

// The chart palette moved to tests/theme-tokens.test.ts, which checks it in both
// themes. Counting the rules here could not survive that: a colour set matched
// with `new Set` collapses a duplicated dark palette back to ten and passes while
// two definitions of the palette exist, which is the drift that mattered.

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

  it("puts a value scale beside the chart and dates under it", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });

    // The values run -25 to 250, so the axis covers that in round steps.
    const scale = [
      ...document.querySelectorAll(".chart-axis-value"),
    ].map((node) => node.textContent);
    expect(scale.length).toBeGreaterThan(1);
    expect(scale).toContain("$0.00");
    // Every label is money, formatted the way the table formats it.
    for (const label of scale) expect(label).toMatch(/^-?\$[\d,]+\.\d\d$/);

    // One label per bucket here, because three is under the thinning limit.
    const timeAxis = document.querySelector(".chart-axis-x")!;
    expect(
      [...timeAxis.querySelectorAll("span")].map((node) => node.textContent),
    ).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
  });

  /**
   * Positioned by percentage against the drawing's own box, so a label lands on
   * the line it names at every width. Read off the style rather than trusted,
   * because getting this wrong puts "$0.00" beside a gridline that is not zero.
   */
  it("lines each value up with its own gridline", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });

    const labels = [
      ...document.querySelectorAll<HTMLElement>(".chart-axis-value"),
    ];
    const tops = labels.map((node) => Number.parseFloat(node.style.top));
    // Down the box as the value falls, and inside it at both ends.
    expect(tops).toEqual([...tops].sort((left, right) => right - left));
    for (const top of tops) {
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(100);
    }

    const gridlines = [...document.querySelectorAll("line")];
    // A line for every label, and one of them is the zero line.
    expect(gridlines.length).toBeGreaterThanOrEqual(labels.length);
    expect(document.querySelector(".chart-zero")).not.toBeNull();
  });

  it("keeps the axes out of the accessible name of the chart", async () => {
    stub();
    renderReports();
    await screen.findByRole("rowheader", { name: "Checking" });

    // Read linearly an axis is a run of bare numbers, and the table beside it
    // already carries every figure as text.
    expect(document.querySelector(".chart-axis-y")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.querySelector(".chart-axis-x")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
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

  it("asks for closed accounts through the URL, and says what that changed", async () => {
    stub();
    renderReports("/reports/net-worth");
    await screen.findByRole("rowheader", { name: "Checking" });

    // A balance report: the figures are the same either way, and the page says so.
    expect(
      screen.getByText(/still in these figures/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Include closed accounts"));

    await vi.waitFor(() => {
      expect(window.location.search).toContain("archived=1");
    });
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0]),
    );
    expect(urls.some((url) => url.includes("includeArchived=true"))).toBe(true);
  });

  it("says a movement report counts closed accounts only when asked", async () => {
    stub({ ...report, report: "income-expense", accumulation: "change" });
    renderReports("/reports/income-expense");
    await screen.findByRole("rowheader", { name: "Checking" });

    expect(screen.getByText(/is left out/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Include closed accounts"));
    expect(await screen.findByText(/is counted here/)).toBeInTheDocument();
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
