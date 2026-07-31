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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
