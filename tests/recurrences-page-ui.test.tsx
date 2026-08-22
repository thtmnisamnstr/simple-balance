// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, Recurrence } from "../src/client/api.js";
import { BrowserRouter } from "../src/client/router.js";
import RecurrencesPage from "../src/client/pages/RecurrencesPage.js";
import { nextOccurrenceAfter } from "../src/shared/recurrence-dates.js";

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

/** Flipped by the one test about a deployment that cannot send mail. */
let mailAvailable = true;

const groceries: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

const today = "2026-08-10";

const rent: Recurrence = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Rent",
  shape: {
    type: "withdrawal",
    payee: "Landlord",
    fromAccountId: checking.id,
    amount: "1450.00",
    description: null,
    categoryId: null,
    categoryName: null,
    notes: null,
  },
  frequency: "monthly",
  interval: 1,
  anchorDate: "2026-08-01",
  monthPolicy: "last_day",
  weekendPolicy: "allow",
  positionOrdinal: null,
  positionWeekday: null,
  notifyOnCreate: false,
  proposesFrom: "2026-08-01",
  lastOccurrenceDate: "2026-08-01",
  nextOccurrenceDate: "2026-09-01",
  nextOccurrence: { occurrenceDate: "2026-09-01", postedDate: "2026-09-01" },
  overdue: false,
  proposedCount: 2,
  committedCount: 1,
  discardedCount: 0,
  version: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** The scheduler has stopped: its next instance is behind us and unproposed. */
const stalled: Recurrence = {
  ...rent,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Gym",
  frequency: "weekly",
  anchorDate: "2026-06-03",
  nextOccurrenceDate: "2026-07-01",
  nextOccurrence: { occurrenceDate: "2026-07-01", postedDate: "2026-07-01" },
  overdue: true,
  proposedCount: 0,
  committedCount: 0,
};

const payroll: Recurrence = {
  ...rent,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Salary",
  shape: {
    type: "deposit",
    payee: "Employer",
    toAccountId: checking.id,
    description: null,
    categoryId: null,
    categoryName: null,
    notes: null,
  },
  positionOrdinal: -1,
  positionWeekday: 5,
  overdue: false,
  proposedCount: 0,
  committedCount: 0,
};

const namedCategory: Recurrence = {
  ...rent,
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Named category",
  shape: {
    type: "withdrawal",
    payee: "Landlord",
    fromAccountId: checking.id,
    amount: "1450.00",
    description: null,
    categoryId: null,
    categoryName: "Utilities",
    notes: null,
  },
};

function stubApi(items: Recurrence[]) {
  const writes: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method && init.method !== "GET") {
        writes.push({
          path: url.pathname,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ id: "written" });
      }
      if (url.pathname === "/api/v1/recurrences") {
        return Response.json({ today, items });
      }
      if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
      if (url.pathname === "/api/v1/categories") return Response.json([groceries]);
      if (url.pathname === "/api/v1/payees/suggestions") return Response.json([]);
      if (url.pathname === "/api/auth/methods") {
        return Response.json({ notificationsAvailable: mailAvailable });
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return writes;
}

async function renderPage(items: Recurrence[], writes = stubApi(items)) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <RecurrencesPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Recurring" });
  if (items.length) await screen.findByText(items[0]!.name);
  return writes;
}

const rowFor = (name: string) =>
  screen.getByRole("row", { name: new RegExp(name) });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the recurrences list", () => {
  it("reads each schedule back as a sentence and shows what is next", async () => {
    await renderPage([rent, payroll]);

    expect(within(rowFor("Rent")).getByText("Every month, on day 1")).toBeInTheDocument();
    expect(
      within(rowFor("Salary")).getByText("Every month, on the last Friday"),
    ).toBeInTheDocument();
    expect(within(rowFor("Rent")).getByText(/Sep 1, 2026/)).toBeInTheDocument();
  });

  /**
   * The one failure this feature has to make visible. A recurrence past due
   * with nothing proposed means whatever runs the schedule has stopped, and the
   * ledger silently missing months is exactly what it exists to prevent.
   */
  it("says out loud when a recurrence is past due", async () => {
    await renderPage([stalled]);

    expect(screen.getByText(/past due with nothing proposed/)).toBeInTheDocument();
    expect(within(rowFor("Gym")).getByText("Past due")).toBeInTheDocument();
  });

  it("links what is waiting to the queue holding it", async () => {
    await renderPage([rent]);

    const link = within(rowFor("Rent")).getByRole("link", {
      name: /Rows waiting from Rent/,
    });
    expect(link).toHaveAttribute("href", `/staged?recurrenceId=${rent.id}`);
  });

  it("orders the amount column as money rather than as text", async () => {
    const cheap: Recurrence = {
      ...rent,
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      name: "Cheap",
      shape: { ...rent.shape, amount: "1.45" },
    };
    const dearer: Recurrence = {
      ...rent,
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "Dearer",
      shape: { ...rent.shape, amount: "1.5" },
    };
    await renderPage([cheap, dearer]);

    fireEvent.click(screen.getByRole("button", { name: /Amount/ }));
    await vi.waitFor(() => {
      const order = screen
        .getAllByRole("row")
        .map((row) => row.textContent ?? "")
        .filter((text) => text.includes("Cheap") || text.includes("Dearer"))
        .map((text) => (text.includes("Cheap") ? "Cheap" : "Dearer"));
      // Biggest first. The generic comparison reads each run of digits as its
      // own whole number, so it puts 1.50 below 1.45 by comparing 5 against 45
      // — which is why an amount needs comparing as money.
      expect(order).toEqual(["Dearer", "Cheap"]);
    });
  });

  it("says an amount is filled in each time when the recurrence holds none", async () => {
    await renderPage([payroll]);

    expect(within(rowFor("Salary")).getByText("each time")).toBeInTheDocument();
  });
});

describe("the recurrence form", () => {
  const openForm = async () => {
    fireEvent.click(screen.getByRole("button", { name: /New recurrence/ }));
    await screen.findByRole("heading", { name: "New recurrence" });
  };

  it("previews the next five dates with the arithmetic the scheduler runs", async () => {
    await renderPage([]);
    await openForm();

    fireEvent.change(screen.getByLabelText(/^Starting/), {
      target: { value: "2026-09-15" },
    });

    const preview = screen.getByText("Next five").parentElement!;
    const rule = {
      frequency: "monthly" as const,
      interval: 1,
      anchorDate: "2026-09-15",
      monthPolicy: "last_day" as const,
      weekendPolicy: "allow" as const,
      position: null,
    };
    let cursor = "2026-09-14";
    for (let index = 0; index < 5; index += 1) {
      const next = nextOccurrenceAfter(rule, cursor);
      const [year, month, day] = next.postedDate!.split("-").map(Number);
      const label = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(year!, month! - 1, day!)));
      expect(within(preview).getByText(label)).toBeInTheDocument();
      cursor = next.occurrenceDate;
    }
  });

  /**
   * The preview has to seek from the watermark the scheduler will seek from.
   * Derived from the anchor instead, a positioned rule's first occurrence in
   * the anchor's own month is skipped: the screen promises September while the
   * next tick proposes August.
   */
  it("previews the occurrence the scheduler will actually propose first", async () => {
    await renderPage([]);
    await openForm();

    // Derived rather than written down. The occurrence under test has to be in
    // the future for the preview to list it at all, so a fixed date passes
    // until that date goes by and then fails for a reason that has nothing to
    // do with what is being tested.
    const year = new Date().getUTCFullYear() + 1;
    const firstMonday = new Date(Date.UTC(year, 7, 1));
    const shift = (8 - firstMonday.getUTCDay()) % 7;
    const thirdMonday = new Date(Date.UTC(year, 7, 1 + shift + 14));
    const lastOfAugust = new Date(Date.UTC(year, 7, 31));

    fireEvent.change(screen.getByLabelText(/^Starting/), {
      target: { value: lastOfAugust.toISOString().slice(0, 10) },
    });
    fireEvent.click(screen.getByLabelText(/relative day/i));
    fireEvent.change(screen.getByLabelText(/^Which one/), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText(/^Day$/), { target: { value: "1" } });

    const preview = screen.getByText("Next five").parentElement!;
    // The third Monday of that August, which is before the anchor's own day.
    expect(thirdMonday.getUTCDate()).toBeLessThan(31);
    const label = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(thirdMonday);
    expect(within(preview).getByText(label)).toBeInTheDocument();
  });

  it("previews nothing and refuses to save an interval the schedule rule rejects", async () => {
    const writes = await renderPage([]);
    await openForm();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Gym" } });
    fireEvent.change(screen.getByLabelText(/^Payee/), { target: { value: "Gym Ltd" } });
    fireEvent.change(screen.getByLabelText(/^Account$/), {
      target: { value: checking.id },
    });
    fireEvent.change(screen.getByLabelText(/^Repeats/), { target: { value: "daily" } });

    const save = screen.getByRole("button", { name: "Create recurrence" });
    // The button is otherwise enabled here, which is what makes the assertion
    // below mean something rather than being true of any half-filled form.
    expect(save).not.toBeDisabled();
    expect(screen.getByText("Next five")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Every/), { target: { value: "-1" } });
    expect(screen.queryByText("Next five")).not.toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Every/), { target: { value: "3" } });
    expect(screen.getByText("Next five")).toBeInTheDocument();
    expect(save).not.toBeDisabled();
    expect(writes).toHaveLength(0);
  });

  /**
   * Saturday and Sunday both land on the Friday beside them, and the queue
   * refuses to commit rows that alike, so the server refuses the combination.
   * Disabling it says so before the refusal has to.
   */
  it("blocks the two business-day policies on a daily schedule, with the reason", async () => {
    await renderPage([]);
    await openForm();

    fireEvent.change(screen.getByLabelText(/^Repeats/), {
      target: { value: "daily" },
    });

    const policy = screen.getByLabelText(/When it lands on a weekend/);
    expect(
      within(policy).getByRole("option", { name: /Move it back to the Friday/ }),
    ).toBeDisabled();
    expect(
      within(policy).getByRole("option", { name: /Move it on to the Monday/ }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Make the interval three days or more to use those two/),
    ).toBeInTheDocument();

    // Two days apart still collides, three does not.
    fireEvent.change(screen.getByLabelText(/^Every N days/), {
      target: { value: "2" },
    });
    expect(
      within(policy).getByRole("option", { name: /Move it back to the Friday/ }),
    ).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/^Every N days/), {
      target: { value: "3" },
    });
    expect(
      within(policy).getByRole("option", { name: /Move it back to the Friday/ }),
    ).not.toBeDisabled();
  });

  /**
   * A shape may name its category rather than cite one, which is what a CSV
   * import or an agent leaves behind. Seeded from the id alone the field came
   * up blank, and saving wrote the recurrence back with no category at all.
   */
  it("keeps a category the shape names rather than cites", async () => {
    const writes = await renderPage([namedCategory]);
    fireEvent.click(
      within(rowFor("Named category")).getByRole("button", {
        name: /Actions for Named category/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/ }));
    await screen.findByRole("heading", { name: "Edit recurrence" });

    expect(screen.getByDisplayValue("Utilities")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save recurrence" }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({
      shape: { categoryName: "Utilities" },
    });
  });

  it("sends a relative day of the month when one is chosen", async () => {
    const writes = await renderPage([]);
    await openForm();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Payday" } });
    fireEvent.change(screen.getByLabelText(/^Payee/), { target: { value: "Employer" } });
    fireEvent.change(screen.getByLabelText(/^Account/), {
      target: { value: checking.id },
    });
    fireEvent.click(screen.getByLabelText(/On a relative day/));
    fireEvent.change(screen.getByLabelText(/^Which one/), { target: { value: "-1" } });
    fireEvent.change(screen.getByLabelText(/^Day$/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Create recurrence" }));

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.path).toBe("/api/v1/recurrences");
    expect(writes[0]!.body).toMatchObject({
      name: "Payday",
      schedule: { position: { ordinal: -1, weekday: 5 } },
    });
  });

  it("shows on the list whether a recurrence writes when it proposes", async () => {
    await renderPage([
      rent,
      { ...payroll, notifyOnCreate: true },
    ]);

    expect(within(rowFor("Rent")).getByText("No")).toBeInTheDocument();
    expect(within(rowFor("Salary")).getByText("Email")).toBeInTheDocument();
  });

  it("groups the ones that will email when the column is sorted", async () => {
    await renderPage([
      rent,
      { ...payroll, notifyOnCreate: true },
    ]);
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("strong")?.textContent);

    // Leans descending, so one click puts the ones that will email first.
    fireEvent.click(screen.getByRole("button", { name: /Notifies/ }));
    expect(names()).toEqual(["Salary", "Rent"]);
    fireEvent.click(screen.getByRole("button", { name: /Notifies/ }));
    expect(names()).toEqual(["Rent", "Salary"]);
  });

  /**
   * It sits directly under Schedule, which is a card with a small-caps legend,
   * and it was a bare fieldset taking the browser's own border and a legend
   * indented from everything else. Two sections of one form that look like two
   * different forms.
   */
  it("is laid out like the schedule section above it", async () => {
    await renderPage([]);
    fireEvent.click(screen.getByRole("button", { name: /New recurrence/ }));
    const dialog = within(await screen.findByRole("dialog"));

    for (const name of ["Schedule", "Notifications"]) {
      expect(dialog.getByText(name).closest("fieldset")).toHaveClass(
        "form-fieldset",
      );
    }
  });

  it("sends the notification choice, off unless it is asked for", async () => {
    const writes = await renderPage([]);
    await openForm();

    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Rent" } });
    fireEvent.change(screen.getByLabelText(/^Payee/), { target: { value: "Landlord" } });
    fireEvent.change(screen.getByLabelText(/^Account/), {
      target: { value: checking.id },
    });
    const toggle = screen.getByLabelText(/Email me when this proposes/);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Create recurrence" }));

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body).toMatchObject({ notifyOnCreate: true });
  });

  it("seeds the notification choice from the recurrence being edited", async () => {
    await renderPage([{ ...rent, notifyOnCreate: true }]);
    fireEvent.click(screen.getByRole("button", { name: /Actions for Rent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      await screen.findByLabelText(/Email me when this proposes/),
    ).toBeChecked();
  });

  it("says so when the deployment cannot send the email it is offering", async () => {
    mailAvailable = false;
    try {
      await renderPage([]);
      await openForm();
      fireEvent.click(screen.getByLabelText(/Email me when this proposes/));
      expect(
        await screen.findByText(/no mail server configured/),
      ).toBeInTheDocument();
    } finally {
      mailAvailable = true;
    }
  });
});
