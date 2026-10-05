// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, CsvPreview } from "../src/client/api.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import { BrowserRouter } from "../src/client/router.js";

/**
 * A column whose name is an inherited property is a cell, not an object.
 *
 * `csv.md` §16 lists "an inherited property name is a missing column" as
 * checked, and the check covers the server reader. The one place in the client
 * that indexes a parsed row by a name the uploaded file chose was the raw
 * file-preview table, and it indexed straight in.
 *
 * The file is RFC 4180-conformant, which §2 names as the Binding conformance
 * target. A header line containing `__proto__` parses to a row with no own
 * property of that name — assigning a string to `__proto__` on an object
 * literal sets the prototype and is silently dropped — so `row["__proto__"]`
 * answers `Object.prototype`, an object. `?? ""` does not catch it, because it
 * is not missing. React refuses to render an object as a child, the root
 * `ErrorBoundary` catches the throw, and the whole app is replaced by the error
 * screen the moment the file is chosen: before any mapping, before any staging,
 * with nothing on screen saying why.
 *
 * The preview arrives as JSON, which is what makes this reproducible here: a
 * `__proto__` key does not survive `JSON.stringify`, and `headers` still names
 * the column, so the parsed row has the header and not the cell. `constructor`
 * is the control — it is an own property on the server's row and survives the
 * round trip, so it renders its text and proves the test is reading the table
 * rather than passing on an empty one.
 */
const checking: Account = {
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

const preview: CsvPreview = {
  delimiter: ",",
  headers: ["date", "__proto__", "constructor", "amount"],
  // Exactly what a `JSON.parse` of the server's reply yields: the dangerous
  // column is named in `headers` and is not an own property of the row.
  rows: [{ date: "2026-07-31", constructor: "memo", amount: "-12.34" } as Record<string, string>],
  errors: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function chooseFile() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
      if (url.pathname === "/api/v1/categories") return Response.json([]);
      if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
      return new Response("Not found", { status: 404 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ImportPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Choose a CSV file" });
  const csv = "date,__proto__,constructor,amount\n2026-07-31,memo,memo,-12.34\n";
  const file = new File([csv], "bank.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => csv });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}

describe("the raw file preview", () => {
  it("renders an inherited column name as a blank cell rather than throwing", async () => {
    await chooseFile();

    const table = await screen.findByRole("table", { name: "Preview of the file being imported" });
    const header = within(table).getByRole("columnheader", { name: "__proto__" });
    expect(header).toBeInTheDocument();

    const cells = within(table).getAllByRole("cell");
    expect(cells).toHaveLength(preview.headers.length);
    // Position, not text: the point is that the cell for the inherited name is
    // empty while the one beside it still carries the file's own value.
    expect(cells[1]).toHaveTextContent("");
    expect(cells[2]).toHaveTextContent("memo");
    expect(cells[0]).toHaveTextContent("2026-07-31");
  });
});
