// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  Account,
  Page,
  StagedTransaction,
} from "../src/client/api.js";
import { TransactionForm } from "../src/client/forms.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";

const account: Account = {
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

const malformedStage: StagedTransaction = {
  id: "22222222-2222-4222-8222-222222222222",
  draft: {
    type: { nested: "withdrawal" },
    date: ["2026-07-30"],
    description: { text: "Groceries" },
    payee: ["Market"],
    categoryId: { id: "category" },
    notes: { unsafe: true },
    fromAccountId: ["account"],
    amount: { value: "12.34" },
  },
  validationIssues: [{ field: "draft", message: "Malformed draft" }],
  version: 1,
  status: "staged",
  createdAt: "2026-07-30T12:00:00.000Z",
};

describe("staged transaction editor", () => {
  it("renders malformed object and array fields as safe empty inputs", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["payees"], []);

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <TransactionForm
          accounts={[account]}
          categories={[]}
          staged={malformedStage}
          onDone={() => undefined}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Date")).toHaveValue("");
    expect(screen.getByLabelText("Description")).toHaveValue("");
    expect(screen.getByLabelText("Amount (USD)")).toHaveValue("");
    expect(
      container.querySelector('input[list="payee-suggestions"]'),
    ).toHaveValue("");
    expect(container.querySelector("textarea")).toHaveValue("");
  });

  it("renders a malformed staged row without passing unknown values to React", () => {
    window.history.replaceState(
      null,
      "",
      "/staged?start=2026-07-01&end=2026-07-30",
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    const page: Page<StagedTransaction> = {
      items: [malformedStage],
      nextCursor: null,
    };
    queryClient.setQueryData(["import-batches", "active"], {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(
      [
        "staged",
        "",
        "",
        "",
        "",
        "2026-07-01",
        "2026-07-30",
      ],
      {
        pages: [page],
        pageParams: [undefined],
      },
    );
    queryClient.setQueryData(["accounts"], [account]);
    queryClient.setQueryData(["categories"], []);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <StagingPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("Incomplete row")).toBeInTheDocument();
    expect(screen.getByText("Unknown type")).toBeInTheDocument();
    expect(screen.getByText("Unknown account")).toBeInTheDocument();
  });
});
