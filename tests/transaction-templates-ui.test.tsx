// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Account,
  Category,
  PaginatedPage,
  Transaction,
  TransactionTemplate,
} from "../src/client/api.js";
import { TransactionBrowser } from "../src/client/TransactionBrowser.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

const checking: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "100",
  balancePresentation: { label: "Balance", amount: "100" },
};

const groceries: Category = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Groceries",
  kind: "expense",
  version: 1,
};

/**
 * The reference this row was imported under. A template must not carry it: every
 * transaction made from the template would share it, and the next real import of
 * that statement row would be swallowed as one already seen.
 */
const imported: Transaction = {
  id: "44444444-4444-4444-8444-444444444444",
  type: "withdrawal",
  date: "2026-01-05",
  payee: "Market",
  description: "Food",
  categoryId: groceries.id,
  category: groceries,
  notes: "weekly",
  externalId: "bank-statement-row-9912",
  sourceAccountId: checking.id,
  sourceAccount: { id: checking.id, name: checking.name, currency: "USD" },
  sourceAmount: "12.34",
  sourceCurrency: "USD",
  version: 3,
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

function stubBrowser(templates: TransactionTemplate[] = []) {
  const posted: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/transactions") {
        const page: PaginatedPage<Transaction> = {
          items: [imported],
          nextCursor: null,
          page: 1,
          pageSize: 1,
          totalCount: 1,
          totalPages: 1,
        };
        return jsonResponse(page);
      }
      if (url.pathname === "/api/v1/transaction-templates") {
        if (init?.method === undefined && !init?.body) return jsonResponse(templates);
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ id: "new", name: "x", draft: {}, version: 1 }, 201);
      }
      if (url.pathname === "/api/v1/accounts") return jsonResponse([checking]);
      if (url.pathname === "/api/v1/categories") return jsonResponse([groceries]);
      if (url.pathname === "/api/v1/payees/suggestions") return jsonResponse([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return posted;
}

function renderBrowser() {
  window.history.replaceState(
    null,
    "",
    "/transactions?start=2026-01-01&end=2026-12-31&preset=custom",
  );
  render(
    <QueryClientProvider client={queryClient()}>
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <TransactionBrowser />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

async function openTemplateEditor() {
  fireEvent.click(await screen.findByRole("button", { name: "Actions for Market" }));
  fireEvent.click(screen.getByRole("button", { name: /Save as template/ }));
  return screen.getByRole("dialog", { name: "Save as template" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("saving a row as a template", () => {
  it("puts the action behind a menu named for its row", async () => {
    stubBrowser();
    renderBrowser();
    const trigger = await screen.findByRole("button", {
      name: "Actions for Market",
    });
    // The action lives inside the menu rather than as a fourth bare icon in the
    // row. Opening and closing is the browser's own disclosure behaviour, which
    // this environment does not implement, so it is exercised in
    // tests/row-menu.test.tsx instead.
    const item = screen.getByRole("button", { name: /Save as template/ });
    expect(trigger.closest("details")).toContainElement(item);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens filled in from the row", async () => {
    stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());

    expect(dialog.getByLabelText(/^Payee/)).toHaveValue("Market");
    expect(dialog.getByLabelText(/^Amount/)).toHaveValue("12.34");
    expect(dialog.getByLabelText("Account")).toHaveValue(checking.id);
    expect(dialog.getByLabelText(/^Description/)).toHaveValue("Food");
    expect(dialog.getByLabelText(/^Notes/)).toHaveValue("weekly");
  });

  // Saving a template from a row does not take that row's date. A date is a
  // field of the template like any other, entered on purpose, and left out
  // means the day the template is applied.
  it("offers a date but does not take the row's own", async () => {
    const posted = stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());
    expect(dialog.getByLabelText(/^Date/)).toHaveValue("");

    fireEvent.change(dialog.getByLabelText(/^Template name/), {
      target: { value: "Dateless" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save as template" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { draft: Record<string, unknown> }).draft).not.toHaveProperty(
      "date",
    );
  });

  it("saves a date when one is deliberately entered", async () => {
    const posted = stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());

    fireEvent.change(dialog.getByLabelText(/^Template name/), {
      target: { value: "Rent day" },
    });
    fireEvent.change(dialog.getByLabelText(/^Date/), {
      target: { value: "2026-03-15" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save as template" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { draft: Record<string, unknown> }).draft).toMatchObject({
      date: "2026-03-15",
    });
  });

  // The import reference is the one field still refused outright: copied onto
  // every transaction made from the template, it would make the next real
  // import of that statement row look like one already seen.
  it("never carries the row's import reference", async () => {
    const posted = stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());
    fireEvent.change(dialog.getByLabelText(/^Template name/), {
      target: { value: "No reference" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save as template" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(JSON.stringify(posted[0])).not.toContain("bank-statement-row-9912");
  });



  // The headline case: a recurring payee and category whose amount differs
  // every time.
  it("leaves out a field the user cleared", async () => {
    const posted = stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());

    fireEvent.change(dialog.getByLabelText(/^Template name/), {
      target: { value: "Varying" },
    });
    fireEvent.change(dialog.getByLabelText(/^Amount/), { target: { value: "" } });
    fireEvent.change(dialog.getByLabelText(/^Notes/), { target: { value: "" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save as template" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    const draft = (posted[0] as { draft: Record<string, unknown> }).draft;
    expect(draft).not.toHaveProperty("amount");
    expect(draft).not.toHaveProperty("notes");
    expect(draft).toMatchObject({ type: "withdrawal", payee: "Market" });
  });

  it("saves with no account chosen, which the transaction form would refuse", async () => {
    const posted = stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());

    fireEvent.change(dialog.getByLabelText(/^Template name/), {
      target: { value: "No account" },
    });
    fireEvent.change(dialog.getByLabelText("Account"), { target: { value: "" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save as template" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { draft: object }).draft).not.toHaveProperty(
      "fromAccountId",
    );
  });

  it("will not save without a name", async () => {
    stubBrowser();
    renderBrowser();
    const dialog = within(await openTemplateEditor());
    expect(
      dialog.getByRole("button", { name: "Save as template" }),
    ).toBeDisabled();
  });
});
