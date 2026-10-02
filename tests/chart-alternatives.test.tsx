// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report } from "../src/client/api.js";
import ReportsPage from "../src/client/pages/ReportsPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import { sourceFiles } from "./support/source.js";

/**
 * The two things `web.md` section 11 says about charts and does not check.
 *
 * 11.4, every chart ships its table: "*Not checked mechanically.* A test
 * asserting a table alongside every chart component is structural and worth
 * writing." It satisfies a binding text-alternative requirement — a chart is a
 * complex image and takes a long description, and the ledger has already
 * computed it — so the table being there is the whole of the compliance.
 *
 * 11.6, a series keeps its color when the visible set shrinks: "*Not checked
 * mechanically.* A jsdom test excluding one series and asserting the survivors'
 * `chart-series-N` classes did not move is cheap and worth writing." It has a
 * recorded defect behind it: colors were dealt by array position, so excluding
 * one category recolored every line after it, at exactly the moment somebody
 * was comparing the view with and without that category.
 *
 * Nothing watched either. No test in the repository mentions `chart-figure`,
 * and the only `chart-series` assertions anywhere are stylesheet ones.
 */

const report: Report = {
  report: "categories",
  range: { start: "2026-01-01", end: "2026-03-31" },
  asOf: "2026-03-31",
  bucket: "month",
  accumulation: "change",
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
          key: "rent",
          label: "Rent",
          kind: "expense",
          archived: false,
          values: ["900.00", "900.00", "900.00"],
          total: "2700.00",
        },
        {
          key: "food",
          label: "Food",
          kind: "expense",
          archived: false,
          values: ["210.00", "180.00", "240.00"],
          total: "630.00",
        },
        {
          key: "travel",
          label: "Travel",
          kind: "expense",
          archived: false,
          values: ["75.00", "0.00", "320.00"],
          total: "395.00",
        },
        {
          key: "books",
          label: "Books",
          kind: "expense",
          archived: false,
          values: ["40.00", "55.00", "20.00"],
          total: "115.00",
        },
      ],
      totals: ["1225.00", "1135.00", "1480.00"],
    },
  ],
};

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.startsWith("/api/v1/reports/")) return Response.json(report);
      return Response.json([]);
    }),
  );
}

function renderReports() {
  window.history.replaceState(null, "", "/reports/categories");
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
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

/**
 * 11.4, read off the source rather than off a render.
 *
 * The population is every chart component (§17.2: from the product, never from
 * the presence of the thing being checked), and the question is asked of each
 * one's call sites. A rendered assertion would have to name the pages, which is
 * the shape that lets the next chart be added somewhere nobody listed.
 */
describe("every chart ships its table", () => {
  const client = sourceFiles("src/client");
  const charts = client.find((file) => file.path.endsWith("charts.tsx"))!;

  /** Every component in `charts.tsx` that renders a `<figure className="chart-figure">`. */
  const components = [...charts.code.matchAll(/export function (\w+)\(/g)]
    .map((match) => ({
      name: match[1]!,
      body: charts.code.slice(match.index, charts.code.indexOf("\nexport ", match.index + 1)),
    }))
    .filter((component) => component.body.includes('className="chart-figure"'));

  /**
   * The population, before the verdict, and a census pin on top of it.
   *
   * The set is derived — every export in `charts.tsx` that renders a
   * `.chart-figure` — so the rule below covers a chart nobody listed. This
   * additionally pins what that derivation currently answers, for the reason
   * `tests/mcp-measurements.test.ts` pins its counts: a third chart is a thing
   * somebody should have to look at this file about, and a derivation that
   * quietly started answering nothing would otherwise leave the check below
   * passing over an empty set.
   */
  it("finds the chart components there are", () => {
    expect(components.map((component) => component.name).sort()).toEqual(["BarChart", "LineChart"]);
  });

  it("renders a table in the page beside each one", () => {
    const failures: string[] = [];
    for (const component of components) {
      for (const file of client) {
        if (file.path.endsWith("charts.tsx")) continue;
        for (const match of file.code.matchAll(new RegExp(`<${component.name}(?=[\\s/>])`, "g"))) {
          // The table must be in the page, not behind `aria-describedby`: a
          // described-by target is flattened to one paragraph and the table
          // structure is lost. So this looks for a real `<table>` in the same
          // section — the thousand characters after the chart, which is where
          // `ReportsPage` puts it.
          const after = file.code.slice(match.index, match.index + 2000);
          if (!after.includes("<table")) {
            failures.push(
              `${file.path}:${file.code.slice(0, match.index).split("\n").length} renders <${component.name}> with no table beside it`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * And the table is a real one. 11.4 names the two properties that make it a
   * long description rather than a grid of numbers: an `.sr-only` caption
   * identifying it, and `scope` on every header.
   */
  it("gives that table a caption and scoped headers", async () => {
    stub();
    renderReports();
    const table = await screen.findByRole("table");

    const caption = table.querySelector("caption");
    expect(caption).not.toBeNull();
    expect(caption).toHaveClass("sr-only");
    expect(caption!.textContent).toContain("USD");

    const headers = [...table.querySelectorAll("th")];
    expect(headers.length).toBeGreaterThan(4);
    expect(headers.every((header) => header.getAttribute("scope"))).toBe(true);

    // And the chart it describes is a figure, which is the structure 11.4 says
    // to use. Without this the test above would pass on a table beside nothing.
    expect(document.querySelector("figure.chart-figure")).not.toBeNull();
  });
});

/**
 * 11.6, in a browser-shaped render, because the defect was in what the page
 * hands the chart rather than in the chart.
 */
describe("a series keeps its color when the visible set shrinks", () => {
  const swatches = () =>
    [...document.querySelectorAll(".chart-legend li")].map((item) => ({
      label: item.textContent?.trim(),
      paint: [...(item.querySelector(".chart-swatch")?.classList ?? [])].find((name) =>
        name.startsWith("chart-series-"),
      ),
    }));

  it("leaves every surviving series on the color it had", async () => {
    stub();
    renderReports();
    await screen.findByRole("table");

    const before = swatches();
    expect(before.map((entry) => entry.label)).toEqual(["Rent", "Food", "Travel", "Books"]);
    expect(before.map((entry) => entry.paint)).toEqual([
      "chart-series-0",
      "chart-series-1",
      "chart-series-2",
      "chart-series-3",
    ]);

    // Exclude the second of four, which is the case position-dealt colors get
    // wrong: everything after it shifts up one.
    const row = screen.getByRole("row", { name: /Food/ });
    fireEvent.click(within(row).getByRole("button", { name: /Actions for Food/ }));
    fireEvent.click(within(row).getByRole("button", { name: /Exclude from this view/ }));

    const after = swatches();
    expect(after.map((entry) => entry.label)).toEqual(["Rent", "Travel", "Books"]);
    // Travel and Books keep 2 and 3. Dealt by position they would become 1 and
    // 2, and every line in the chart would change clothes at the moment
    // somebody was comparing this view with the one before it.
    expect(after.map((entry) => entry.paint)).toEqual([
      "chart-series-0",
      "chart-series-2",
      "chart-series-3",
    ]);
  });
});
