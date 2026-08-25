// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, CsvPreview, CsvSampleRow } from "../src/client/api.js";
import { APP_CSV_COLUMNS } from "../src/shared/csv.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import { BrowserRouter } from "../src/client/router.js";

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

const card: Account = {
  ...checking,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Other Card",
  type: "credit_card",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const dining: Category = { id: "cat-dining", name: "Dining", kind: "expense", version: 1 };

/**
 * The stage reply, in the shape the service returns it.
 *
 * `sample` defaults to empty because a header-only file samples nothing, and a
 * panel that swapped the file's own cells for an empty table would be showing
 * less than it started with.
 */
function stubApi(
  preview: CsvPreview,
  accounts: Account[] = [checking],
  stage: Partial<{ sample: CsvSampleRow[] } & Record<string, unknown>> = {},
  categories: Category[] = [dining],
) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/accounts") return Response.json(accounts);
      if (url.pathname === "/api/v1/categories") return Response.json(categories);
      if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
      if (url.pathname === "/api/v1/csv/stage") {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({
          fileName: "export.csv",
          rowCount: 1,
          validCount: 1,
          invalidCount: 0,
          sample: [],
          referenceResolution: { categories: [], payees: [] },
          ...stage,
        });
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return bodies;
}

async function chooseFile(csv: string, name: string) {
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
  const file = new File([csv], name, { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => csv });
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
}

describe("CSV reference resolution UI", () => {
  it("maps the category column and explains automatic category/payee handling", async () => {
    const csv = ["date,payee,category,amount", "2026-07-31,ACME Market,Dining,-12.34"].join("\n");
    const preview: CsvPreview = {
      delimiter: ",",
      headers: ["date", "payee", "category", "amount"],
      rows: [
        {
          date: "2026-07-31",
          payee: "ACME Market",
          category: "Dining",
          amount: "-12.34",
        },
      ],
      errors: [],
    };
    let stageBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/accounts") {
          return Response.json([checking]);
        }
        if (url.pathname === "/api/v1/csv/preview") {
          return Response.json(preview);
        }
        if (url.pathname === "/api/v1/csv/stage") {
          stageBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            fileName: "bank.csv",
            rowCount: 1,
            validCount: 1,
            invalidCount: 0,
            sample: [],
            referenceResolution: {
              categories: [
                {
                  inputName: "Dining",
                  resolvedName: "Dining",
                  categoryId: null,
                  kind: "expense",
                  resolution: "new",
                  unarchived: false,
                },
              ],
              payees: [
                {
                  inputPayee: "ACME Market",
                  resolvedPayee: "Acme Market",
                  resolution: "existing",
                },
              ],
            },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ImportPage />
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Choose a CSV file" });

    const file = new File([csv], "bank.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: async () => csv });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    expect(await screen.findByLabelText("Category")).toHaveValue("category");
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));

    await waitFor(() => {
      expect(stageBody).toMatchObject({
        mapping: { category: "category", payee: "payee" },
        dryRun: true,
      });
    });
    expect(screen.getByText(/Categories: 0 matched, 1 new, and 0 updated/)).toBeInTheDocument();
    expect(screen.getByText(/Payees: 1 matched and 0 new/)).toBeInTheDocument();
  });
});

/**
 * Every column mapping shown for one of our own exports is a control that
 * decides nothing, and one of them looked like it decided the account. The
 * screen asks for the account and nothing else.
 */
describe("importing a Simple Balance export", () => {
  const headers = [...APP_CSV_COLUMNS];
  const preview: CsvPreview = {
    delimiter: ",",
    headers,
    rows: [Object.fromEntries(headers.map((header) => [header, ""]))],
    errors: [],
  };
  const csv = `${headers.join(",")}\n`;

  it("asks for the account and hides the mapping it would ignore", async () => {
    stubApi(preview, [checking, card]);
    await chooseFile(csv, "simple-balance-export.csv");

    await screen.findByRole("heading", { name: "Choose the account" });
    expect(screen.getByLabelText("Account")).toBeInTheDocument();
    expect(
      screen.getByText(/Every row is posted against the account you choose/),
    ).toBeInTheDocument();

    for (const label of [
      "Date",
      "Payee",
      "Signed amount",
      "Debit",
      "Credit",
      "Category",
      "Description",
      "Notes",
      "Date format",
      "Decimal separator",
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
  });

  it("stages against the chosen account and sends no mapping", async () => {
    const bodies = stubApi(preview, [checking, card]);
    await chooseFile(csv, "simple-balance-export.csv");

    const account = await screen.findByLabelText("Account");
    fireEvent.change(account, { target: { value: card.id } });
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ defaultAccountId: card.id, dryRun: true });
    expect(bodies[0]).not.toHaveProperty("mapping");
  });

  it("still asks for a mapping when the file is not one of ours", async () => {
    stubApi({
      delimiter: ",",
      headers: ["transaction_type", "date", "description", "amount"],
      rows: [],
      errors: [],
    });
    await chooseFile("transaction_type,date,description,amount\n", "bank.csv");

    await screen.findByRole("heading", { name: "Map the columns" });
    expect(screen.getByLabelText("Signed amount")).toBeInTheDocument();
  });
});

/**
 * A right preview and a wrong import is a bug rather than a surprise, so the
 * panel stops showing the file's own cells once the server has read them and
 * shows what it read instead.
 */
describe("the interpreted preview", () => {
  const preview: CsvPreview = {
    delimiter: ",",
    headers: ["date", "payee", "category", "amount"],
    rows: [{ date: "2026-07-31", payee: "ACME Market", category: "Dining", amount: "-12.34" }],
    errors: [],
  };
  const csv = ["date,payee,category,amount", "2026-07-31,ACME Market,Dining,-12.34"].join("\n");

  const withdrawal = (extra: Record<string, unknown> = {}): CsvSampleRow => ({
    draft: {
      type: "withdrawal",
      date: "2026-07-31",
      payee: "ACME Market",
      fromAccountId: checking.id,
      amount: "12.34",
      ...extra,
    } as CsvSampleRow["draft"],
    issues: [],
  });

  const dryRun = async () => {
    await screen.findByRole("heading", { name: "Map the columns" });
    fireEvent.click(screen.getByRole("button", { name: "Dry run" }));
  };

  it("shows the first rows as they will be read", async () => {
    stubApi(preview, [checking], {
      rowCount: 2,
      validCount: 1,
      invalidCount: 1,
      sample: [
        withdrawal({ categoryId: dining.id }),
        {
          draft: null,
          partial: { type: "withdrawal", payee: "Missing a date", fromAccountId: checking.id },
          issues: [{ field: "date", message: "Date could not be parsed" }],
        },
      ],
    });
    await chooseFile(csv, "bank.csv");
    await dryRun();

    await screen.findByRole("heading", { name: "As it will be read" });
    expect(screen.getByText("Jul 31, 2026")).toBeInTheDocument();
    expect(screen.getByText("ACME Market")).toBeInTheDocument();
    expect(screen.getAllByText("Checking")).toHaveLength(2);
    expect(screen.getByText("Dining")).toBeInTheDocument();
    expect(screen.getByText("−$12.34")).toBeInTheDocument();
    expect(screen.getByText("Missing a date")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Date could not be parsed")).toBeInTheDocument();
  });

  it("names a category the file will create", async () => {
    // The case the dry run used to get wrong in the only direction that
    // matters: nothing has been created, so there is no id, and the panel
    // reported "Uncategorized" for exactly the category the real stage was
    // about to make.
    stubApi(preview, [checking], {
      sample: [withdrawal({ categoryName: "Groceries", categoryKind: "expense" })],
    });
    await chooseFile(csv, "bank.csv");
    await dryRun();

    await screen.findByRole("heading", { name: "As it will be read" });
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.queryByText("Uncategorized")).toBeNull();
  });

  it("stops showing an interpretation the controls no longer describe", async () => {
    stubApi(preview, [checking], { sample: [withdrawal({ categoryId: dining.id })] });
    await chooseFile(csv, "bank.csv");
    await dryRun();

    await screen.findByRole("heading", { name: "As it will be read" });
    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "DMY" } });

    await screen.findByRole("heading", { name: "File preview" });
    expect(screen.queryByRole("heading", { name: "As it will be read" })).toBeNull();
    // The counts went with it: a number somebody acts on is worse than useless
    // once the settings it was computed under are gone.
    expect(screen.queryByText(/ready and/)).toBeNull();
  });

  it("keeps what a completed stage reported when the controls change", async () => {
    stubApi(preview, [checking], {
      importBatchId: "44444444-4444-4444-8444-444444444444",
      sample: [withdrawal({ categoryId: dining.id })],
    });
    await chooseFile(csv, "bank.csv");
    await screen.findByRole("heading", { name: "Map the columns" });
    fireEvent.click(screen.getByRole("button", { name: "Stage all rows" }));

    await screen.findByRole("link", { name: /Review these 1 rows/ });
    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "DMY" } });

    // Rows already written are history, not a prediction, so they never go
    // stale — but the reading they were written under no longer describes the
    // controls, so the interpreted table goes.
    expect(screen.getByRole("link", { name: /Review these 1 rows/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "As it will be read" })).toBeNull();
  });

  it("stamps an interpretation with the settings it was run under", async () => {
    // The race nothing else can see: change a control while the request is in
    // flight and the reply, read at the moment it arrives, would be labelled
    // with settings it knows nothing about.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
        if (url.pathname === "/api/v1/categories") return Response.json([dining]);
        if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
        if (url.pathname === "/api/v1/csv/stage") {
          await held;
          return Response.json({
            fileName: "bank.csv",
            rowCount: 1,
            validCount: 1,
            invalidCount: 0,
            sample: [withdrawal({ categoryId: dining.id })],
            referenceResolution: { categories: [], payees: [] },
          });
        }
        return new Response("Not found", { status: 404 });
      }),
    );
    await chooseFile(csv, "bank.csv");
    await dryRun();

    fireEvent.change(screen.getByLabelText("Date format"), { target: { value: "MDY" } });
    release!();

    await waitFor(() => expect(screen.queryByText(/ready and/)).toBeNull());
    expect(screen.queryByRole("heading", { name: "As it will be read" })).toBeNull();
    expect(screen.getByRole("heading", { name: "File preview" })).toBeInTheDocument();
  });

  it("shows the parse errors the preview reported", async () => {
    stubApi({
      ...preview,
      errors: ["Row 3: Too few fields: expected 4 fields but parsed 3"],
    });
    await chooseFile(csv, "bank.csv");

    expect(
      await screen.findByText(/Too few fields: expected 4 fields but parsed 3/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only the first rows of the file are read/)).toBeInTheDocument();
  });
});
