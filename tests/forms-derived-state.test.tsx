// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, Transaction } from "../src/client/api.js";
import { RecurrenceForm, TemplateForm, TransactionForm } from "../src/client/forms.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * The three forms after their derived values stopped being state.
 *
 * Every case here is behaviour that used to be produced by an effect writing
 * state or by a `useMemo` whose dependency array had drifted from what the body
 * reads. None of it should have changed, which is the point of the file: it is
 * the evidence that clearing the warnings left the screens alone.
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

const savings: Account = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Savings",
  type: "savings",
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

const salary: Category = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Salary",
  kind: "income",
  version: 1,
};

const retired: Category = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Retired Groceries",
  kind: "expense",
  version: 1,
  archivedAt: "2026-01-02T00:00:00.000Z",
};

const filedUnderRetired: Transaction = {
  id: "66666666-6666-4666-8666-666666666666",
  type: "withdrawal",
  date: "2026-07-31",
  payee: "Market",
  description: null,
  categoryId: retired.id,
  category: retired,
  sourceAccountId: checking.id,
  sourceAccount: { id: checking.id, name: checking.name, currency: "USD" },
  sourceAmount: "10",
  sourceCurrency: "USD",
  legs: [],
  version: 2,
};

function mount(node: React.ReactNode) {
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
      <TimezoneProvider timezone="UTC">{node}</TimezoneProvider>
    </QueryClientProvider>,
  );
}

const offered = (container: HTMLElement) =>
  [...container.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"));

const previewDates = (container: HTMLElement) =>
  container.querySelectorAll(".recurrence-preview li").length;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The list stopped narrowing by direction when a category running against it
 * became a refund, and the entry's type was carried into the picker for a while
 * afterwards without being read. Removing it must leave both directions
 * offering everything.
 */
describe("the categories a picker offers", () => {
  it("offers every live category whichever way the money is going", () => {
    const { container } = mount(
      <TransactionForm
        accounts={[checking]}
        categories={[groceries, salary, retired]}
        onDone={vi.fn()}
      />,
    );
    expect(offered(container)).toEqual(["Groceries", "Salary"]);

    fireEvent.click(screen.getByRole("radio", { name: /Deposit/ }));
    expect(offered(container)).toEqual(["Groceries", "Salary"]);
  });

  it("keeps offering an archived category the entry is already filed under", () => {
    const { container } = mount(
      <TransactionForm
        accounts={[checking]}
        categories={[groceries, salary, retired]}
        transaction={filedUnderRetired}
        onDone={vi.fn()}
      />,
    );
    expect(offered(container)).toContain("Retired Groceries");
  });
});

/**
 * The name beside a chosen id used to be copied into state by an effect. It is
 * worked out during render now, so the two can no longer disagree — but only if
 * a name with no id behind it is still the person's own text.
 */
describe("the name the category picker shows", () => {
  it("shows the category list's spelling once the list arrives", () => {
    const { rerender } = mount(
      <TransactionForm
        accounts={[checking]}
        categories={[]}
        initialCategoryId={groceries.id}
        onDone={vi.fn()}
      />,
    );
    const field = () => screen.getByPlaceholderText("Type to search or add") as HTMLInputElement;
    expect(field().value).toBe("");

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <TransactionForm
            accounts={[checking]}
            categories={[groceries]}
            initialCategoryId={groceries.id}
            onDone={vi.fn()}
          />
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    expect(field().value).toBe("Groceries");

    // A rename that arrives on a refetch reaches the field too, which is what
    // the effect this replaced was for.
    rerender(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <TransactionForm
            accounts={[checking]}
            categories={[{ ...groceries, name: "Food", version: 2 }]}
            initialCategoryId={groceries.id}
            onDone={vi.fn()}
          />
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    expect(field().value).toBe("Food");
  });

  it("leaves a typed name that matches nothing alone", () => {
    mount(<TransactionForm accounts={[checking]} categories={[groceries]} onDone={vi.fn()} />);
    const field = screen.getByPlaceholderText("Type to search or add") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Fuel" } });

    expect(field.value).toBe("Fuel");
    expect(screen.getByText(/Saving will add/)).toHaveTextContent("Fuel");
  });
});

/**
 * The four effects that reset a stored choice, and the argument every one of
 * their disable comments rests on: the reset has to hold after the condition
 * that caused it lifts. A derived value would hand the old choice straight back,
 * which is the fix the lint rule's own help text suggests and the one that would
 * be wrong here.
 */
describe("a choice cleared by a condition that then lifts", () => {
  it("does not hand back a category that switching to Transfer cleared", () => {
    mount(
      <TransactionForm accounts={[checking, savings]} categories={[groceries]} onDone={vi.fn()} />,
    );
    const field = () => screen.getByPlaceholderText("Type to search or add") as HTMLInputElement;
    fireEvent.change(field(), { target: { value: "Groceries" } });
    expect(field().value).toBe("Groceries");

    // A transfer files under no category, so the picker goes away entirely.
    fireEvent.click(screen.getByRole("radio", { name: /Transfer/i }));
    expect(screen.queryByPlaceholderText("Type to search or add")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: /Withdrawal/i }));
    expect(field().value).toBe("");
  });

  it("leaves a weekend policy where the interval reset it, once the interval allows it again", () => {
    mount(<RecurrenceForm accounts={[checking]} categories={[groceries]} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Repeats"), { target: { value: "daily" } });
    const interval = screen.getByLabelText(/Every N days/);
    fireEvent.change(interval, { target: { value: "5" } });

    const policy = screen.getByLabelText(/When it lands on a weekend/) as HTMLSelectElement;
    fireEvent.change(policy, { target: { value: "next_business_day" } });
    expect(policy.value).toBe("next_business_day");

    // One or two days puts two occurrences on a date, so the option is refused
    // and the choice is reset.
    fireEvent.change(interval, { target: { value: "1" } });
    expect(policy.value).toBe("allow");

    // Widening the interval re-enables the option. It must not re-select it:
    // the note explaining the reset has been and gone.
    fireEvent.change(interval, { target: { value: "5" } });
    expect(policy.value).toBe("allow");
  });
});

/**
 * The preview walked the schedule the parser produced while its dependency
 * array named the raw fields, and those are not the same set: an interval of 0
 * and a blank one both read as "no usable number", so typing over one with the
 * other left whichever list was already on screen.
 */
describe("the recurrence schedule preview", () => {
  it("follows the interval field in both directions", () => {
    const { container } = mount(
      <RecurrenceForm accounts={[checking]} categories={[groceries]} onDone={vi.fn()} />,
    );
    const interval = screen.getByLabelText(/Every N months/);
    expect(previewDates(container)).toBe(5);

    // Refused by the shared contract, so there is nothing to preview.
    fireEvent.change(interval, { target: { value: "0" } });
    expect(previewDates(container)).toBe(0);

    // Blank is the form's way of saying every one, so the list comes back.
    fireEvent.change(interval, { target: { value: "" } });
    expect(previewDates(container)).toBe(5);

    fireEvent.change(interval, { target: { value: "0" } });
    expect(previewDates(container)).toBe(0);
  });
});

/**
 * The same preview on the other form, which used to key its memo on the JSON of
 * the parsed rule. Extracting the walk must leave both shapes of reminder — the
 * one-off and the repeat — saying the same thing.
 */
describe("the reminder preview", () => {
  it("shows one date for a one-off and five for a repeat", () => {
    const { container } = mount(
      <TemplateForm accounts={[checking]} categories={[groceries]} onDone={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText("Email me to make this transaction"));
    expect(screen.getByText("Sends on")).toBeInTheDocument();
    expect(previewDates(container)).toBe(1);

    fireEvent.click(screen.getByLabelText("Repeatedly"));
    expect(screen.getByText("Next five")).toBeInTheDocument();
    expect(previewDates(container)).toBe(5);

    fireEvent.change(screen.getByLabelText(/Every N months/), { target: { value: "0" } });
    expect(previewDates(container)).toBe(0);
  });
});
