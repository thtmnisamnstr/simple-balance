// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, CsvPreview } from "../src/client/api.js";
import { APP_CSV_COLUMNS } from "../src/shared/csv.js";
import ImportPage from "../src/client/pages/ImportPage.js";

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

function stubApi(preview: CsvPreview, accounts: Account[] = [checking]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/accounts") return Response.json(accounts);
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
      <ImportPage />
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
    const csv = [
      "date,payee,category,amount",
      "2026-07-31,ACME Market,Dining,-12.34",
    ].join("\n");
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
    expect(
      screen.getByText(/Categories: 0 matched, 1 new, and 0 updated/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Payees: 1 matched and 0 new/),
    ).toBeInTheDocument();
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
