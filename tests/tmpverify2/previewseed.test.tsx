// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, Recurrence } from "../../src/client/api.js";
import { BrowserRouter } from "../../src/client/router.js";
import RecurrencesPage from "../../src/client/pages/RecurrencesPage.js";
import { TimezoneProvider } from "../../src/client/timezone.js";
import {
  occurrencesBetween,
  nextOccurrenceAfter,
} from "../../src/shared/recurrence-dates.js";

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

const today = "2026-08-20";

// A monthly recurrence whose scheduler stopped after May.
const stalled: Recurrence = {
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
  anchorDate: "2026-01-15",
  monthPolicy: "last_day",
  weekendPolicy: "allow",
  positionOrdinal: null,
  positionWeekday: null,
  proposesFrom: "2026-01-15",
  lastOccurrenceDate: "2026-05-15",
  nextOccurrenceDate: "2026-06-15",
  nextOccurrence: { occurrenceDate: "2026-06-15", postedDate: "2026-06-15" },
  overdue: true,
  proposedCount: 0,
  committedCount: 0,
  discardedCount: 0,
  version: 3,
  createdAt: "2026-01-15T00:00:00.000Z",
  updatedAt: "2026-05-15T00:00:00.000Z",
};

// The same recurrence, healthy, on the very day its occurrence already fired.
const firedToday: Recurrence = {
  ...stalled,
  anchorDate: "2026-01-20",
  proposesFrom: "2026-01-20",
  lastOccurrenceDate: "2026-08-20",
  nextOccurrenceDate: "2026-09-20",
  nextOccurrence: { occurrenceDate: "2026-09-20", postedDate: "2026-09-20" },
  overdue: false,
  proposedCount: 1,
};

function stubApi(items: Recurrence[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method && init.method !== "GET") return Response.json({ id: "w" });
      if (url.pathname === "/api/v1/recurrences") return Response.json({ today, items });
      if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
      if (url.pathname === "/api/v1/categories") return Response.json([groceries]);
      if (url.pathname === "/api/v1/payees/suggestions") return Response.json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
}

async function renderPage(items: Recurrence[]) {
  stubApi(items);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <RecurrencesPage />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Recurring" });
  await screen.findByText(items[0]!.name);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

const openEdit = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
  await screen.findByRole("heading", { name: "Edit recurrence" });
};

describe("what the edit form previews vs what the scheduler owes", () => {
  it("overdue: preview omits the backlog", async () => {
    await renderPage([stalled]);
    // The list, from the server's own arithmetic.
    expect(within(screen.getByRole("row", { name: /Rent/ })).getByText(/Jun 15, 2026/))
      .toBeInTheDocument();

    await openEdit("Rent");
    const preview = screen.getByText("Next five").parentElement!;
    // eslint-disable-next-line no-console
    console.log("PREVIEW TEXT:", preview.textContent);

    // What the scheduler will actually propose on its next tick.
    const owed = occurrencesBetween(
      {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-01-15",
        monthPolicy: "last_day",
        weekendPolicy: "allow",
        position: null,
      },
      "2026-05-15",
      today,
      50,
    );
    console.log("SCHEDULER OWES:", owed.map((o) => o.occurrenceDate).join(", "));
    console.log(
      "SERVER NEXT AFTER BACKLOG:",
      nextOccurrenceAfter(
        {
          frequency: "monthly",
          interval: 1,
          anchorDate: "2026-01-15",
          monthPolicy: "last_day",
          weekendPolicy: "allow",
          position: null,
        },
        "2026-05-15",
      ).occurrenceDate,
    );
  });

  it("healthy, on the occurrence day itself", async () => {
    await renderPage([firedToday]);
    expect(within(screen.getByRole("row", { name: /Rent/ })).getByText(/Sep 20, 2026/))
      .toBeInTheDocument();
    await openEdit("Rent");
    const preview = screen.getByText("Next five").parentElement!;
    console.log("PREVIEW TEXT (fired today):", preview.textContent);
  });
});
