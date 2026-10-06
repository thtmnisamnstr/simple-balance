// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, Recurrence, StagedTransaction } from "../src/client/api.js";
import { RecurrenceForm, TransactionForm } from "../src/client/forms.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * Saying what a category named here should be, from the browser.
 *
 * The server has taken `categoryKind` for a while and the MCP has documented
 * it; this form had no way to send it, so a refund into a spending category
 * that did not exist yet was the one entry an agent could record and a person
 * could not. Worse than missing: the form accepted it and quietly made an
 * income category, so the money went to income and the budget never moved.
 *
 * These tests are about the one question the form now asks, and about not
 * asking it when there is nothing to decide.
 *
 * `RecurrenceForm` had the same hole for longer and it mattered more there: a
 * recurring refund into a category nobody has created yet would have been filed
 * as income once a month, for ever, and the schedule is the surface nobody
 * re-reads. It is at the bottom of this file, because the question and the
 * words are the same and only the form differs.
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

const groceries: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

function renderForm() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["payees", "suggestions", ""], []);
  client.setQueryData(["transaction-templates"], []);
  return render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <TransactionForm accounts={[checking]} categories={[groceries]} onDone={vi.fn()} />
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

const picker = () => screen.getByPlaceholderText("Type to search or add");
const chooseType = (label: RegExp) => fireEvent.click(screen.getByRole("radio", { name: label }));
const refundChoice = () => screen.queryByLabelText("A refund of money you spent");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("choosing what a new category is", () => {
  it("asks nothing while no category is named", () => {
    renderForm();
    chooseType(/Deposit/);
    expect(refundChoice()).not.toBeInTheDocument();
  });

  // A category that exists has an answer already, and asking again would invite
  // somebody to contradict it — which the server would then ignore.
  it("asks nothing when the name is one this ledger already has", () => {
    renderForm();
    chooseType(/Deposit/);
    fireEvent.change(picker(), { target: { value: "Groceries" } });
    expect(refundChoice()).not.toBeInTheDocument();
  });

  it("asks when the name is new, naming the category it is asking about", () => {
    renderForm();
    chooseType(/Deposit/);
    fireEvent.change(picker(), { target: { value: "Gadgets" } });
    expect(
      screen.getByRole("radiogroup", { name: "What kind of category is “Gadgets”?" }),
    ).toBeInTheDocument();
    // The direction's own guess is what is selected until somebody says
    // otherwise, so the default answer is the one the server would have given.
    expect(screen.getByLabelText("Money you earned")).toBeChecked();
    expect(refundChoice()).not.toBeChecked();
  });

  it("offers the withdrawal pair on a withdrawal", () => {
    renderForm();
    chooseType(/Withdrawal/);
    fireEvent.change(picker(), { target: { value: "Consulting" } });
    expect(screen.getByLabelText("Money you spent")).toBeChecked();
    expect(screen.getByLabelText("Paying back money you earned")).toBeInTheDocument();
    expect(refundChoice()).not.toBeInTheDocument();
  });

  it("sends the kind that was chosen", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderForm();

    chooseType(/Deposit/);
    fireEvent.change(screen.getByLabelText("Payee"), {
      target: { value: "Electronics Store" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), {
      target: { value: "30" },
    });
    fireEvent.change(picker(), { target: { value: "Gadgets" } });
    fireEvent.click(refundChoice()!);
    fireEvent.submit(screen.getByRole("button", { name: /Commit transaction/ }));

    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const draft = bodies.at(-1)!.draft as Record<string, unknown>;
    expect(draft.categoryName).toBe("Gadgets");
    expect(draft.categoryKind).toBe("expense");
  });

  // Nothing was decided, so nothing is said. Sending the direction's own guess
  // back to the server would put a field in the audit trail that changed
  // nothing about the outcome.
  it("says nothing when the direction's own guess is left alone", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderForm();

    chooseType(/Deposit/);
    fireEvent.change(screen.getByLabelText("Payee"), {
      target: { value: "Employer" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), {
      target: { value: "500" },
    });
    fireEvent.change(picker(), { target: { value: "Salary" } });
    fireEvent.submit(screen.getByRole("button", { name: /Commit transaction/ }));

    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const draft = bodies.at(-1)!.draft as Record<string, unknown>;
    expect(draft.categoryName).toBe("Salary");
    expect(draft).not.toHaveProperty("categoryKind");
  });

  /**
   * Both options are named after the direction, so a choice made under one type
   * cannot carry to another. Left set, a deposit answered as a refund would go
   * on sending "expense" after the entry became a withdrawal, where that answer
   * is not even on offer.
   */
  it("forgets the choice when the direction changes", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderForm();

    chooseType(/Deposit/);
    fireEvent.change(picker(), { target: { value: "Gadgets" } });
    fireEvent.click(refundChoice()!);
    expect(refundChoice()).toBeChecked();

    chooseType(/Withdrawal/);
    expect(screen.getByLabelText("Money you spent")).toBeChecked();

    fireEvent.change(screen.getByLabelText("Payee"), {
      target: { value: "Electronics Store" },
    });
    fireEvent.change(screen.getByLabelText("Amount (USD)"), {
      target: { value: "30" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /Commit transaction/ }));

    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const draft = bodies.at(-1)!.draft as Record<string, unknown>;
    expect(draft).not.toHaveProperty("categoryKind");
  });

  // Every leg is a share of one movement, so there is one question, not one per
  // row, and the answer covers all of them.
  it("asks once for a split, however many new names it has", () => {
    renderForm();
    chooseType(/Deposit/);
    fireEvent.click(screen.getByText("Split across categories"));
    const pickers = screen.getAllByPlaceholderText("Type to search or add");
    fireEvent.change(pickers[0]!, { target: { value: "Returned Boots" } });
    fireEvent.change(pickers[1]!, { target: { value: "Returned Coat" } });
    expect(screen.getAllByLabelText("A refund of money you spent")).toHaveLength(1);
    expect(
      screen.getByRole("radiogroup", { name: "What kind of categories are these?" }),
    ).toBeInTheDocument();
  });
});

function renderRecurrence() {
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
        <RecurrenceForm accounts={[checking]} categories={[groceries]} onDone={vi.fn()} />
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

describe("choosing what a new category is, on a recurrence", () => {
  it("asks nothing for a category this ledger already has", () => {
    renderRecurrence();
    chooseType(/Withdrawal/);
    fireEvent.change(picker(), { target: { value: "Groceries" } });
    expect(refundChoice()).not.toBeInTheDocument();
  });

  it("asks when the name is new", () => {
    renderRecurrence();
    chooseType(/Withdrawal/);
    fireEvent.change(picker(), { target: { value: "Bicycle repairs" } });
    expect(
      screen.getByRole("radiogroup", { name: "What kind of category is “Bicycle repairs”?" }),
    ).toBeInTheDocument();
  });

  it("sends the kind that was chosen, so a recurring refund is not filed as income", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderRecurrence();
    chooseType(/Deposit/);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Quarterly rebate" } });
    fireEvent.change(screen.getByLabelText(/^Payee/), { target: { value: "Utility" } });
    fireEvent.change(screen.getByLabelText(/^Account/), {
      target: { value: checking.id },
    });
    fireEvent.change(picker(), { target: { value: "Utilities" } });
    fireEvent.click(screen.getByLabelText("A refund of money you spent"));
    fireEvent.click(screen.getByRole("button", { name: /Create recurring transaction/ }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ shape: { categoryKind: "expense" } });
  });
});

/**
 * Opening a stored answer and saving it keeps the answer.
 *
 * Both forms asked the question on create and never read the answer back, and
 * an update replaces a staged draft or a recurrence's shape whole. So the most
 * ordinary repair there is — a recurring refund proposed with no amount, opened
 * in the form to type one — saved a draft with no kind, and the row committed
 * as income. The inline editor already kept the stored kind; the forms did not.
 */
describe("a stored category kind, opened in a form and saved", () => {
  function renderWith(element: React.ReactElement) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    client.setQueryData(["payees", "suggestions", ""], []);
    client.setQueryData(["transaction-templates"], []);
    return render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">{element}</TimezoneProvider>
      </QueryClientProvider>,
    );
  }

  const stagedRow = (draft: Record<string, unknown>) =>
    ({
      id: "44444444-4444-4444-8444-444444444444",
      version: 3,
      status: "staged",
      validationIssues: [],
      importBatchId: null,
      createdAt: "2026-07-01T12:00:00.000Z",
      draft: {
        type: "deposit",
        date: "2026-07-01",
        payee: "Electronics Store",
        toAccountId: checking.id,
        amount: "30.00",
        ...draft,
      },
    }) as unknown as StagedTransaction;

  it("keeps a staged refund's kind, and shows it as the answer", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderWith(
      <TransactionForm
        accounts={[checking]}
        categories={[groceries]}
        staged={stagedRow({ categoryName: "Gadgets", categoryKind: "expense" })}
        onDone={vi.fn()}
      />,
    );
    expect(refundChoice()).toBeChecked();
    fireEvent.submit(document.querySelector("form")!);
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const draft = bodies.at(-1)!.draft as Record<string, unknown>;
    expect(draft.categoryName).toBe("Gadgets");
    expect(draft.categoryKind).toBe("expense");
  });

  it("keeps each leg's own kind on a split", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderWith(
      <TransactionForm
        accounts={[checking]}
        categories={[groceries]}
        staged={stagedRow({
          legs: [
            { categoryName: "Gadgets", categoryKind: "expense", amount: "20.00" },
            { categoryName: "Toys", categoryKind: "expense", amount: "10.00" },
          ],
        })}
        onDone={vi.fn()}
      />,
    );
    fireEvent.submit(document.querySelector("form")!);
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const legs = (bodies.at(-1)!.draft as { legs: Record<string, unknown>[] }).legs;
    expect(legs.map((leg) => leg.categoryKind)).toEqual(["expense", "expense"]);
  });

  it("keeps a recurring refund's kind", async () => {
    const bodies: Record<string, unknown>[] = [];
    captureRequests(bodies);
    renderWith(
      <RecurrenceForm
        accounts={[checking]}
        categories={[groceries]}
        recurrence={
          {
            id: "55555555-5555-4555-8555-555555555555",
            version: 2,
            name: "Quarterly rebate",
            shape: {
              type: "deposit",
              payee: "Utility",
              toAccountId: checking.id,
              amount: "12.00",
              categoryName: "Utilities",
              categoryKind: "expense",
            },
            frequency: "monthly",
            interval: 1,
            anchorDate: "2026-07-15",
            monthPolicy: "last_day",
            weekendPolicy: "allow",
            positionOrdinal: null,
            positionWeekday: null,
            proposesFrom: "2026-07-15",
            lastOccurrenceDate: null,
            nextOccurrenceDate: "2026-07-15",
            notifyOnCreate: false,
            nextOccurrence: { occurrenceDate: "2026-07-15", postedDate: null },
          } as unknown as Recurrence
        }
        onDone={vi.fn()}
      />,
    );
    expect(refundChoice()).toBeChecked();
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(bodies.at(-1)).toMatchObject({ shape: { categoryKind: "expense" } });
  });
});
