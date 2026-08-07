// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, Transaction } from "../src/client/api.js";
import { TransactionForm } from "../src/client/forms.js";
import { TimezoneProvider } from "../src/client/timezone.js";

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

const food: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Food",
  kind: "expense",
  version: 1,
};

const household: Category = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Household",
  kind: "expense",
  version: 1,
};

const split: Transaction = {
  id: "55555555-5555-4555-8555-555555555555",
  type: "withdrawal",
  date: "2026-07-31",
  payee: "Costco",
  description: null,
  categoryId: null,
  category: null,
  sourceAccountId: checking.id,
  sourceAccount: { id: checking.id, name: checking.name, currency: "USD" },
  sourceAmount: "100",
  sourceCurrency: "USD",
  legs: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", categoryId: food.id, category: food, amount: "60", note: "Groceries" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", categoryId: household.id, category: household, amount: "40", note: null },
  ],
  version: 3,
};

function renderForm(props: Partial<Parameters<typeof TransactionForm>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["payees", "suggestions", ""], []);
  return render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <TransactionForm
          accounts={[checking]}
          categories={[food, household]}
          onDone={vi.fn()}
          {...props}
        />
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

function captureRequests(bodies: Record<string, unknown>[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.body) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      if (url.pathname === "/api/v1/payees/suggestions") {
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

const legAmount = (index: number) =>
  screen.getByLabelText(`Amount for split ${index}`) as HTMLInputElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("splitting a transaction in the form", () => {
  it("opens with a single category and no split rows", () => {
    renderForm();
    expect(screen.getByText("Split across categories")).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount for split 1")).not.toBeInTheDocument();
  });

  /**
   * Splitting starts from what is on screen rather than from nothing, so the
   * category and amount already typed are not lost the moment the button is
   * pressed.
   */
  it("carries the chosen category and the whole amount into the first leg", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("Type to search or add"), {
      target: { value: "Food" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Split across categories"));

    expect(legAmount(1).value).toBe("100");
    expect(legAmount(2).value).toBe("");
    const pickers = screen.getAllByPlaceholderText("Type to search or add");
    expect((pickers[0] as HTMLInputElement).value).toBe("Food");
  });

  it("refuses to submit until the legs add up, then allows it", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Payee"), {
      target: { value: "Costco" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Split across categories"));

    fireEvent.change(legAmount(1), { target: { value: "60" } });
    expect(screen.getByText("40 left to assign.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit transaction/ })).toBeDisabled();

    fireEvent.change(legAmount(2), { target: { value: "40" } });
    expect(screen.getByText("The split adds up.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Commit transaction/ }),
    ).not.toBeDisabled();
  });

  /**
   * Worked out in scaled integers, not through Number: 33.33 + 33.33 + 33.34
   * is exactly 100, and a float would leave a remainder and refuse a receipt
   * that adds up perfectly well.
   */
  it("settles thirds of a hundred exactly", () => {
    renderForm();
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Split across categories"));
    fireEvent.click(screen.getByText("Add a category"));

    fireEvent.change(legAmount(1), { target: { value: "33.33" } });
    fireEvent.change(legAmount(2), { target: { value: "33.33" } });
    fireEvent.change(legAmount(3), { target: { value: "33.34" } });
    expect(screen.getByText("The split adds up.")).toBeInTheDocument();
  });

  it("folds back to a single category when a split is cut down to one leg", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("Type to search or add"), {
      target: { value: "Food" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Split across categories"));
    fireEvent.click(screen.getByLabelText("Remove split 2"));

    expect(screen.queryByLabelText("Amount for split 1")).not.toBeInTheDocument();
    expect(screen.getByText("Split across categories")).toBeInTheDocument();
    expect(
      (screen.getByPlaceholderText("Type to search or add") as HTMLInputElement)
        .value,
    ).toBe("Food");
  });

  it("sends the legs and no single category", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderForm();

    fireEvent.change(screen.getByLabelText("Payee"), {
      target: { value: "Costco" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), { target: { value: "100" } });
    fireEvent.click(screen.getByText("Split across categories"));
    const pickers = () => screen.getAllByPlaceholderText("Type to search or add");
    fireEvent.change(pickers()[0]!, { target: { value: "Food" } });
    fireEvent.change(legAmount(1), { target: { value: "60" } });
    fireEvent.change(pickers()[1]!, { target: { value: "Household" } });
    fireEvent.change(legAmount(2), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Note for split 1"), {
      target: { value: "Groceries" },
    });

    fireEvent.submit(screen.getByRole("button", { name: /Commit transaction/ }));
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));

    const draft = bodies.at(-1)!.draft as Record<string, unknown>;
    expect(draft.categoryId).toBeNull();
    expect(draft.categoryName).toBeNull();
    expect(draft.legs).toEqual([
      { categoryId: food.id, categoryName: null, amount: "60", note: "Groceries" },
      { categoryId: household.id, categoryName: null, amount: "40", note: null },
    ]);
  });

  /**
   * A leg sent without its id would be read as a new leg and retire the one it
   * stood for, so editing a split has to send every id back.
   */
  it("keeps each leg's identity when an existing split is edited", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderForm({ transaction: split });

    expect(legAmount(1).value).toBe("60");
    expect(legAmount(2).value).toBe("40");
    const pickers = screen.getAllByPlaceholderText("Type to search or add");
    expect((pickers[0] as HTMLInputElement).value).toBe("Food");

    fireEvent.submit(screen.getByRole("button", { name: /Save changes/ }));
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));

    const draft = bodies.at(-1)!.draft as { legs: { id: string }[] };
    expect(draft.legs.map((leg) => leg.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });

  it("offers no split on a transfer, which has no category side", () => {
    renderForm();
    fireEvent.click(screen.getByRole("radio", { name: /Transfer/i }));
    expect(screen.queryByText("Split across categories")).not.toBeInTheDocument();
  });
});
