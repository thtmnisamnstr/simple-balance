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
import type {
  Account,
  Category,
  TransactionTemplate,
} from "../src/client/api.js";
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

const savings: Account = {
  ...checking,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Savings",
};

const groceries: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

const salaryCategory: Category = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Salary",
  kind: "income",
  version: 1,
};

const rent: TransactionTemplate = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Rent",
  draft: {
    type: "withdrawal",
    payee: "Landlord",
    fromAccountId: checking.id,
    categoryId: groceries.id,
    amount: "1450.00",
    notes: "monthly",
  },
  notification: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// No amount and no notes: the recurring-payee case, where the number differs
// every time.
const coffee: TransactionTemplate = {
  ...rent,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Coffee",
  draft: {
    type: "withdrawal",
    payee: "Cafe",
    fromAccountId: checking.id,
  },
};

// Names an account that is no longer in the list the select can show.
const orphaned: TransactionTemplate = {
  ...rent,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Old account",
  draft: {
    type: "withdrawal",
    payee: "Somebody",
    fromAccountId: "99999999-9999-4999-8999-999999999999",
  },
};

// An income category on a withdrawal: the category was widened or narrowed
// after the template was saved.
const mismatched: TransactionTemplate = {
  ...rent,
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Wrong kind",
  draft: {
    type: "withdrawal",
    payee: "Somebody",
    fromAccountId: checking.id,
    categoryId: salaryCategory.id,
  },
};

// A split whose second leg names a category that has since been deleted. The
// single-category path already refuses one of these; a split is the same
// mistake with more legs.
const splitWithDeadLeg: TransactionTemplate = {
  ...rent,
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  name: "Weekly shop",
  draft: {
    type: "withdrawal",
    payee: "Market",
    fromAccountId: checking.id,
    amount: "100.00",
    legs: [
      { categoryId: groceries.id, amount: "60.00" },
      { categoryId: "99999999-9999-4999-8999-999999999999", amount: "40.00" },
    ],
  },
};

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function stubApi(templates: TransactionTemplate[]) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === "/api/v1/transaction-templates") {
        return jsonResponse(templates);
      }
      if (url.pathname === "/api/v1/payees/suggestions") return jsonResponse([]);
      if (url.pathname === "/api/v1/transactions") {
        return jsonResponse({ id: "created" }, 201);
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return requests;
}

function renderForm() {
  render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <TransactionForm
          accounts={[checking, savings]}
          categories={[groceries, salaryCategory]}
          onDone={() => {}}
        />
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

const field = (label: RegExp | string) => screen.getByLabelText(label);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("starting a transaction from a template", () => {
  it("fills the form in from the one chosen", async () => {
    stubApi([rent]);
    renderForm();
    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: rent.id },
    });

    expect(field(/^Payee/)).toHaveValue("Landlord");
    expect(field(/^Amount/)).toHaveValue("1450.00");
    expect(field("Account")).toHaveValue(checking.id);
    expect(field(/^Notes/)).toHaveValue("monthly");
    expect(field(/^Category/)).toHaveValue("Groceries");
  });

  /**
   * A template holds no date, and this is why: one that did would post
   * transactions dated whenever it was saved, moving balances in a month
   * nobody was looking at.
   */
  it("dates it today rather than whenever the template was made", async () => {
    stubApi([rent]);
    renderForm();
    const today = field("Date") as HTMLInputElement;
    const before = today.value;
    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: rent.id },
    });
    expect(field("Date")).toHaveValue(before);
    expect(before).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * The whole point of "without impacting the rest": editing the filled-in form
   * must not touch the template. There is no write path to reach it, and this
   * is the test that says so.
   */
  it("never writes back to the template, however much is changed", async () => {
    const requests = stubApi([rent]);
    renderForm();
    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: rent.id },
    });

    fireEvent.change(field(/^Payee/), { target: { value: "Someone Else" } });
    fireEvent.change(field(/^Amount/), { target: { value: "9.99" } });
    fireEvent.change(field(/^Notes/), { target: { value: "changed" } });
    fireEvent.submit(field(/^Payee/).closest("form")!);

    await waitFor(() =>
      expect(requests.some((request) => request.path === "/api/v1/transactions")).toBe(
        true,
      ),
    );
    const posted = requests.find((r) => r.path === "/api/v1/transactions")!;
    expect((posted.body as { draft: Record<string, unknown> }).draft).toMatchObject({
      payee: "Someone Else",
      amount: "9.99",
      notes: "changed",
    });
    // Nothing was ever written to a template, by any method.
    expect(
      requests.filter(
        (request) =>
          request.path.startsWith("/api/v1/transaction-templates") &&
          request.method !== "GET",
      ),
    ).toEqual([]);
  });

  /**
   * Picking a second template replaces the first rather than layering over it.
   * Merging would leave Rent's £1,450 attached to Coffee, which is a wrong
   * transaction one click from being committed.
   *
   * This is what the restore before applying is for: only the fields the
   * previous template set go back, so a second choice cannot inherit them.
   */
  it("replaces the previous choice instead of merging with it", async () => {
    stubApi([coffee, rent]);
    renderForm();
    const control = await screen.findByLabelText(/^Start from a template/);

    fireEvent.change(control, { target: { value: rent.id } });
    expect(field(/^Amount/)).toHaveValue("1450.00");
    expect(field(/^Notes/)).toHaveValue("monthly");

    fireEvent.change(control, { target: { value: coffee.id } });
    expect(field(/^Payee/)).toHaveValue("Cafe");
    // Coffee has neither, so neither may survive from Rent.
    expect(field(/^Amount/)).toHaveValue("");
    expect(field(/^Notes/)).toHaveValue("");
    expect(field(/^Category/)).toHaveValue("");
  });

  /**
   * Setting an account id with no matching option leaves the select looking
   * empty while holding a value, which passes the browser's own required check
   * and posts money to an account the person cannot see.
   */
  it("drops an account that is no longer available, and says so", async () => {
    stubApi([orphaned]);
    renderForm();
    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: orphaned.id },
    });

    expect(field("Account")).toHaveValue(checking.id);
    expect(
      screen.getByText(/account is no longer available/i),
    ).toBeInTheDocument();
  });

  it("drops a category that no longer fits the type", async () => {
    stubApi([mismatched]);
    renderForm();
    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: mismatched.id },
    });

    expect(field(/^Category/)).toHaveValue("");
    expect(screen.getByText(/category is no longer available/i)).toBeInTheDocument();
  });

  /**
   * Same failure as the account and the single category, one branch down: a leg
   * left holding an id with no matching option shows an empty picker, so the
   * split looks merely unfinished rather than wrong, and nothing says which leg
   * to look at.
   */
  it("says so when a split leg's category is no longer available", async () => {
    stubApi([splitWithDeadLeg]);
    renderForm();
    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: splitWithDeadLeg.id },
    });

    expect(
      screen.getByText(/category is no longer available/i),
    ).toBeInTheDocument();
    const legAmounts = screen
      .getAllByRole("textbox")
      .filter((one) => (one as HTMLInputElement).value === "40.00");
    expect(legAmounts.length).toBeGreaterThan(0);
  });

  it("goes back to a blank form when the choice is cleared", async () => {
    stubApi([rent]);
    renderForm();
    const control = await screen.findByLabelText(/^Start from a template/);
    fireEvent.change(control, { target: { value: rent.id } });
    expect(field(/^Payee/)).toHaveValue("Landlord");

    fireEvent.change(control, { target: { value: "" } });
    expect(field(/^Payee/)).toHaveValue("");
    expect(field(/^Amount/)).toHaveValue("");
  });

  /**
   * The rule that makes a template safe to apply to something already written:
   * a field it does not carry is left as it was, not blanked. Coffee names a
   * payee and an account and nothing else, so a form holding an amount and
   * notes keeps both.
   */
  it("applies only the fields the template carries", async () => {
    stubApi([coffee]);
    renderForm();
    fireEvent.change(field(/^Amount/), { target: { value: "88.00" } });
    fireEvent.change(field(/^Notes/), { target: { value: "keep me" } });

    fireEvent.change(await screen.findByLabelText(/^Start from a template/), {
      target: { value: coffee.id },
    });

    expect(field(/^Payee/)).toHaveValue("Cafe");
    expect(field(/^Amount/)).toHaveValue("88.00");
    expect(field(/^Notes/)).toHaveValue("keep me");
  });

  it("takes a date the template carries, and today when it carries none", async () => {
    const dated: TransactionTemplate = {
      ...rent,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      name: "Rent day",
      draft: { ...rent.draft, date: "2026-03-15" },
    };
    stubApi([dated, coffee]);
    renderForm();
    const control = await screen.findByLabelText(/^Start from a template/);
    const today = (field("Date") as HTMLInputElement).value;

    fireEvent.change(control, { target: { value: dated.id } });
    expect(field("Date")).toHaveValue("2026-03-15");

    fireEvent.change(control, { target: { value: coffee.id } });
    expect(field("Date")).toHaveValue(today);
  });

  it("clears the picker when the form resets for another entry", async () => {
    const requests = stubApi([rent]);
    renderForm();
    const control = await screen.findByLabelText(/^Start from a template/);
    fireEvent.change(control, { target: { value: rent.id } });
    expect(field(/^Amount/)).toHaveValue("1450.00");

    fireEvent.click(
      screen.getByLabelText(/return to create another/i),
    );
    fireEvent.click(screen.getByLabelText(/Reset after saving/i));
    fireEvent.submit(field(/^Payee/).closest("form")!);
    await waitFor(() =>
      expect(requests.some((r) => r.path === "/api/v1/transactions")).toBe(true),
    );

    // Left selected, the next entry would be started under a template the
    // person believes they have finished with.
    await waitFor(() => expect(control).toHaveValue(""));
    expect(field(/^Amount/)).toHaveValue("");
  });

  it("offers no picker when there are no templates", async () => {
    stubApi([]);
    renderForm();
    await screen.findByLabelText(/^Payee/);
    expect(
      screen.queryByLabelText(/^Start from a template/),
    ).not.toBeInTheDocument();
  });
});
