// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, Category, TransactionTemplate } from "../src/client/api.js";
import { BrowserRouter } from "../src/client/router.js";
import TemplatesPage from "../src/client/pages/TemplatesPage.js";

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

const rent: TransactionTemplate = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Rent",
  draft: {
    type: "withdrawal",
    payee: "Landlord",
    fromAccountId: checking.id,
    categoryId: groceries.id,
    amount: "1450.00",
  },
  notification: null,
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const coffee: TransactionTemplate = {
  ...rent,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Coffee",
  notification: null,
  version: 7,
  draft: { type: "withdrawal", payee: "Cafe", fromAccountId: checking.id },
};

const salary: TransactionTemplate = {
  ...rent,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Salary",
  notification: null,
  version: 2,
  draft: { type: "deposit", payee: "Employer", toAccountId: checking.id },
};

const orphaned: TransactionTemplate = {
  ...rent,
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Old card",
  notification: null,
  version: 1,
  draft: {
    type: "withdrawal",
    payee: "Somebody",
    fromAccountId: "99999999-9999-4999-8999-999999999999",
  },
};

function stubApi(templates: TransactionTemplate[]) {
  const posts: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.method && init.method !== "GET") {
        posts.push({
          path: url.pathname,
          method: init.method,
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ changedCount: 2, items: [], dryRun: false });
      }
      if (url.pathname === "/api/v1/transaction-templates") {
        return Response.json(templates);
      }
      if (url.pathname === "/api/v1/accounts") {
        return Response.json([checking, savings]);
      }
      if (url.pathname === "/api/v1/categories") {
        return Response.json([groceries]);
      }
      if (url.pathname === "/api/v1/payees/suggestions") return Response.json([]);
      // The reminder section reads this to say when a deployment has no way to
      // deliver one. Answered here so the tests exercise the same path a real
      // page does rather than the query's error branch.
      if (url.pathname === "/api/auth/methods") {
        return Response.json({ notificationsAvailable: true });
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return posts;
}

async function renderPage(templates: TransactionTemplate[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <TemplatesPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Templates" });
  if (templates.length) await screen.findByText(templates[0]!.name);
}

const rowFor = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the templates screen", () => {
  it("shows what each template holds, and says which fields are blank", async () => {
    stubApi([rent, coffee]);
    await renderPage([rent, coffee]);

    const rentRow = within(rowFor("Rent"));
    expect(rentRow.getByText("Landlord")).toBeInTheDocument();
    expect(rentRow.getByText("Checking")).toBeInTheDocument();
    expect(rentRow.getByText("Groceries")).toBeInTheDocument();
    expect(rentRow.getByText("Withdrawal")).toBeInTheDocument();

    // Coffee stores no amount and no category on purpose, which is the point of
    // a template rather than a gap in one.
    const coffeeRow = within(rowFor("Coffee"));
    expect(coffeeRow.getAllByText("blank").length).toBeGreaterThanOrEqual(2);
  });

  it("says so when a template names an account that is gone", async () => {
    stubApi([orphaned]);
    await renderPage([orphaned]);
    expect(within(rowFor("Old card")).getByText("Unavailable")).toBeInTheDocument();
  });

  it("sorts by a column and turns it around on a second click", async () => {
    stubApi([rent, coffee, salary]);
    await renderPage([rent, coffee, salary]);

    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("strong")?.textContent);
    expect(names()).toEqual(["Coffee", "Rent", "Salary"]);

    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Salary", "Rent", "Coffee"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("narrows on a search and drops a selection that no longer applies", async () => {
    stubApi([rent, coffee]);
    await renderPage([rent, coffee]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    expect(screen.getByText("1 template selected")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search templates"), {
      target: { value: "coffee" },
    });
    expect(screen.queryByText("Rent")).toBeNull();
    expect(screen.queryByText(/template selected/)).toBeNull();
  });

  it("sends each selected id with the version it was read at", async () => {
    const posts = stubApi([rent, coffee]);
    await renderPage([rent, coffee]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    fireEvent.click(screen.getByLabelText("Select Coffee"));
    fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));

    fireEvent.change(screen.getByLabelText("Payee"), {
      target: { value: "set" },
    });
    fireEvent.change(screen.getByLabelText("New payee"), {
      target: { value: "New landlord" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toBe("/api/v1/transaction-templates/bulk-edit");
    const body = posts[0]!.body as {
      selection: { items: { id: string; expectedVersion: number }[] };
      patch: Record<string, unknown>;
    };
    expect(body.selection.items).toEqual(
      expect.arrayContaining([
        { id: rent.id, expectedVersion: 3 },
        { id: coffee.id, expectedVersion: 7 },
      ]),
    );
    expect(body.patch).toEqual({ payee: "New landlord" });
  });

  /**
   * The distinction the whole feature rests on: a field left alone is absent
   * from the patch, and a cleared one is present and null. An absent key and a
   * null key mean opposite things, so a form that collapsed them would quietly
   * do the wrong one.
   */
  it("sends null for a cleared field and nothing at all for one left alone", async () => {
    const posts = stubApi([rent]);
    await renderPage([rent]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "clear" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    const patch = (posts[0]!.body as { patch: Record<string, unknown> }).patch;
    expect(patch).toEqual({ amount: null });
    expect("payee" in patch).toBe(false);
    expect("categoryId" in patch).toBe(false);
  });

  it("will not offer a source account when a deposit is selected", async () => {
    stubApi([rent, salary]);
    await renderPage([rent, salary]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    fireEvent.click(screen.getByLabelText("Select Salary"));
    fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));

    const sourceAction = screen.getByLabelText("Source account");
    const setOption = within(sourceAction).getByRole("option", {
      name: "Set to",
    });
    expect(setOption).toBeDisabled();
    expect(screen.getByText(/A deposit has no source account/)).toBeInTheDocument();
  });

  it("selects every matching template, not only the ones on this page", async () => {
    // More than one page of them, or selecting the page and selecting every
    // match are the same answer and this proves nothing.
    const crowd = Array.from({ length: 30 }, (_, index) => ({
      ...coffee,
      id: `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, "0")}`,
      name: `Filler ${String(index).padStart(2, "0")}`,
    }));
    stubApi(crowd);
    await renderPage(crowd);
    expect(screen.getAllByRole("row").length - 1).toBe(25);

    fireEvent.click(screen.getByLabelText("Select Filler 00"));
    fireEvent.click(screen.getByRole("button", { name: "Select all 30 matching" }));
    expect(screen.getByText("30 templates selected")).toBeInTheDocument();
  });

  it("pages through the list and comes back to page one on a search", async () => {
    const crowd = Array.from({ length: 30 }, (_, index) => ({
      ...coffee,
      id: `ffffffff-ffff-4fff-8fff-${String(index).padStart(12, "0")}`,
      name: `Filler ${String(index).padStart(2, "0")}`,
    }));
    stubApi(crowd);
    await renderPage(crowd);
    expect(screen.queryByText("Filler 25")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(await screen.findByText("Filler 25")).toBeInTheDocument();
    expect(screen.queryByText("Filler 00")).toBeNull();

    // Narrowing to one match while sitting on page two has to show it rather
    // than an empty page the person cannot get off.
    fireEvent.change(screen.getByPlaceholderText("Search templates"), {
      target: { value: "Filler 03" },
    });
    expect(await screen.findByText("Filler 03")).toBeInTheDocument();
  });

  it("confirms before deleting a selection, then posts it", async () => {
    const posts = stubApi([rent, coffee]);
    await renderPage([rent, coffee]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected/ }));
    const dialog = within(screen.getByText("Delete 1 template?").closest("dialog")!);
    fireEvent.click(dialog.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.path).toBe("/api/v1/transaction-templates/bulk-delete");
    expect((posts[0]!.body as { selection: { items: unknown[] } }).selection.items).toEqual([
      { id: rent.id, expectedVersion: 3 },
    ]);
  });

  it("can make a template, so the screen is not somewhere you only delete", async () => {
    stubApi([rent]);
    await renderPage([rent]);
    fireEvent.click(screen.getByRole("button", { name: /New template/ }));
    expect(await screen.findByLabelText(/Template name/)).toBeInTheDocument();
  });

  /**
   * A bulk write is atomic, so a failed one moved no version and the selection
   * that produced it is still good. Clearing it would throw away the work of
   * choosing the rows for a mistake in the form.
   */
  it("keeps the selection and shows the reason when a mass edit fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), window.location.origin);
        if (init?.method && init.method !== "GET") {
          return new Response(
            JSON.stringify({ error: { message: "A deposit has no source account" } }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/api/v1/transaction-templates") {
          return Response.json([rent]);
        }
        if (url.pathname === "/api/v1/accounts") {
          return Response.json([checking, savings]);
        }
        if (url.pathname === "/api/v1/categories") return Response.json([groceries]);
        return Response.json([]);
      }),
    );
    await renderPage([rent]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));
    fireEvent.change(screen.getByLabelText("Payee"), { target: { value: "set" } });
    fireEvent.change(screen.getByLabelText("New payee"), {
      target: { value: "Nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    // Inside the dialog, because the page banner sits behind an open one.
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByText(/A deposit has no source account/)).toBeInTheDocument(),
    );
    expect(screen.getByText("1 template selected")).toBeInTheDocument();
  });

  it("drops an account choice the newly chosen type cannot hold", async () => {
    stubApi([rent]);
    await renderPage([rent]);

    fireEvent.click(screen.getByLabelText("Select Rent"));
    fireEvent.click(screen.getByRole("button", { name: /Edit selected/ }));
    const dialog = within(screen.getByRole("dialog"));

    fireEvent.change(dialog.getByLabelText("Source account"), {
      target: { value: "set" },
    });
    fireEvent.change(dialog.getByLabelText("New source account"), {
      target: { value: checking.id },
    });
    expect(dialog.getByLabelText("Source account")).toHaveValue("set");

    // A deposit has no source account, so the choice cannot survive the switch.
    fireEvent.change(dialog.getByLabelText("Type"), { target: { value: "set" } });
    fireEvent.change(dialog.getByLabelText("New type"), {
      target: { value: "deposit" },
    });
    expect(dialog.getByLabelText("Source account")).toHaveValue("leave");
  });

  it("waits for accounts before naming any of them unavailable", async () => {
    let releaseAccounts: (value: Response) => void = () => {};
    let templatesServed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/transaction-templates") {
          templatesServed = true;
          return Response.json([rent]);
        }
        if (url.pathname === "/api/v1/accounts") {
          return new Promise<Response>((resolve) => {
            releaseAccounts = resolve;
          });
        }
        if (url.pathname === "/api/v1/categories") return Response.json([groceries]);
        return Response.json([]);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <TemplatesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("heading", { name: "Templates" });
    // Waits for the templates request to have been answered, rather than for a
    // duration chosen to be long enough. That is what makes this catch a table
    // drawn on templates alone: the page has everything it needs to draw one
    // wrongly, and must still be waiting.
    await waitFor(() => expect(templatesServed).toBe(true));
    expect(screen.getByText("Loading templates…")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();

    releaseAccounts(Response.json([checking, savings]));
    await waitFor(() => expect(within(rowFor("Rent")).getByText("Checking")).toBeInTheDocument());
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("reports what came from each template and links to it", async () => {
    stubApi([
      { ...rent, transactionCount: 4, stagedTransactionCount: 2, totalTransactionCount: 6 },
      { ...coffee, transactionCount: 0, stagedTransactionCount: 0, totalTransactionCount: 0 },
    ]);
    await renderPage([rent, coffee]);

    const used = within(rowFor("Rent")).getByRole("link", {
      name: "Transactions from Rent",
    });
    expect(used).toHaveTextContent("6");
    expect(used).toHaveAttribute("href", `/templates/${rent.id}`);
    expect(within(rowFor("Rent")).getByText("4 committed · 2 pending")).toBeInTheDocument();

    // A template nothing came from reads zero rather than being left out.
    expect(
      within(rowFor("Coffee")).getByRole("link", {
        name: "Transactions from Coffee",
      }),
    ).toHaveTextContent("0");
  });

  it("sorts by how much each template has been used", async () => {
    stubApi([
      { ...rent, totalTransactionCount: 1 },
      { ...coffee, totalTransactionCount: 9 },
      { ...salary, totalTransactionCount: 5 },
    ]);
    await renderPage([rent, coffee, salary]);
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("strong")?.textContent);

    // Counts lean largest first, so one click is descending.
    fireEvent.click(screen.getByRole("button", { name: /Used/ }));
    expect(names()).toEqual(["Coffee", "Salary", "Rent"]);
    fireEvent.click(screen.getByRole("button", { name: /Used/ }));
    expect(names()).toEqual(["Rent", "Salary", "Coffee"]);
  });

  it("offers an empty screen that points at both ways to make one", async () => {
    stubApi([]);
    await renderPage([]);
    expect(await screen.findByText("No templates yet")).toBeInTheDocument();
    expect(screen.getByText(/Save as template/)).toBeInTheDocument();
  });

  it("shows on the list whether a reminder is set, and whether it repeats", async () => {
    const once: TransactionTemplate = {
      ...rent,
      notification: {
        frequency: null,
        interval: 1,
        anchorDate: "2026-06-15",
        monthPolicy: "last_day",
        weekendPolicy: "allow",
        position: null,
        time: "09:00",
        repeats: false,
        lastNotifiedDate: null,
        nextNotificationDate: "2026-06-15",
      },
    };
    const repeating: TransactionTemplate = {
      ...coffee,
      notification: { ...once.notification!, frequency: "monthly", repeats: true },
    };
    stubApi([once, repeating, salary]);
    await renderPage([once, repeating, salary]);

    expect(within(rowFor("Rent")).getByText("Once")).toBeInTheDocument();
    expect(within(rowFor("Coffee")).getByText("Repeating")).toBeInTheDocument();
    expect(within(rowFor("Salary")).getByText("none")).toBeInTheDocument();
  });

  it("sorts by what it is going to remind you about", async () => {
    const due: TransactionTemplate = {
      ...rent,
      notification: {
        frequency: null,
        interval: 1,
        anchorDate: "2026-06-15",
        monthPolicy: "last_day",
        weekendPolicy: "allow",
        position: null,
        time: "09:00",
        repeats: false,
        lastNotifiedDate: null,
        nextNotificationDate: "2026-06-15",
      },
    };
    // Sent, and nothing further owed. Still a reminder, but not one that is
    // going to say anything, so it sits below the one that is.
    const spent: TransactionTemplate = {
      ...coffee,
      notification: {
        ...due.notification!,
        lastNotifiedDate: "2026-06-15",
        nextNotificationDate: null,
      },
    };
    stubApi([spent, salary, due]);
    await renderPage([spent, salary, due]);
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("strong")?.textContent);

    // Leans descending, so one click puts what is still to come first.
    fireEvent.click(screen.getByRole("button", { name: /Reminder/ }));
    expect(names()).toEqual(["Rent", "Coffee", "Salary"]);
    fireEvent.click(screen.getByRole("button", { name: /Reminder/ }));
    expect(names()).toEqual(["Salary", "Coffee", "Rent"]);
  });

  const openEditor = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return within(await screen.findByRole("dialog"));
  };

  /**
   * The section was a bare fieldset, so it took the browser's own
   * `padding-inline` and its legend sat indented from every other label on the
   * screen, with eleven controls stacked against each other for want of a gap.
   * `.form-fieldset` is what the recurrence form's schedule section uses, and
   * the two are the same kind of thing.
   */
  it("is laid out like the schedule section it mirrors", async () => {
    stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    const legend = dialog.getByText("Reminder");
    const section = legend.closest("fieldset")!;
    expect(section).toHaveClass("form-fieldset");
    // A legend already names a fieldset, so an aria-label saying the same thing
    // was only overriding it with itself.
    expect(section).not.toHaveAttribute("aria-label");
  });

  /**
   * What the schedule section has that made it read as finished: the dates it
   * will actually fire on. A reminder can answer the same question, and "when
   * will this email me" is the one thing the settings above do not say outright.
   */
  it("previews the dates a one-off reminder will send on", async () => {
    stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    fireEvent.click(dialog.getByLabelText(/Email me to make this/));
    fireEvent.change(dialog.getByLabelText(/^Send on/), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(dialog.getByLabelText(/^Send at/), { target: { value: "18:45" } });

    expect(dialog.getByText("Sends on")).toBeInTheDocument();
    const preview = dialog.getByText("Sends on").parentElement!;
    // One date, because a one-off owes exactly one, and the hour it goes at.
    expect(within(preview).getAllByRole("listitem")).toHaveLength(1);
    expect(within(preview).getByText(/Jul 4, 2026 at 18:45/)).toBeInTheDocument();
  });

  it("previews five dates for a repeating reminder", async () => {
    stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    fireEvent.click(dialog.getByLabelText(/Email me to make this/));
    fireEvent.click(dialog.getByLabelText("Repeatedly"));
    fireEvent.change(dialog.getByLabelText(/^Starting/), {
      target: { value: "2026-07-04" },
    });

    expect(dialog.getByText("Next five")).toBeInTheDocument();
    const preview = dialog.getByText("Next five").parentElement!;
    expect(within(preview).getAllByRole("listitem")).toHaveLength(5);
    // Monthly by default, counted from the anchor rather than from each other.
    expect(within(preview).getByText(/Jul 4, 2026/)).toBeInTheDocument();
    expect(within(preview).getByText(/Aug 4, 2026/)).toBeInTheDocument();
  });

  it("explains what a reminder does beside the box that turns it on", async () => {
    stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    // Before the schedule fields, not stranded under them: it describes the
    // checkbox, and it is shown whether or not the box is ticked.
    const note = dialog.getByText(/A reminder only asks/);
    const checkbox = dialog.getByLabelText(/Email me to make this/);
    expect(checkbox.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checkbox).not.toBeChecked();
  });

  it("sends no reminder unless one is asked for", async () => {
    const posts = stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    expect(dialog.getByLabelText(/Email me to make this/)).not.toBeChecked();
    fireEvent.click(dialog.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ notification: null });
  });

  it("sends a one-off reminder as a date and a time, and nothing else", async () => {
    const posts = stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    fireEvent.click(dialog.getByLabelText(/Email me to make this/));
    fireEvent.change(dialog.getByLabelText(/^Send on/), {
      target: { value: "2026-07-04" },
    });
    fireEvent.change(dialog.getByLabelText(/^Send at/), { target: { value: "18:45" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({
      notification: { frequency: null, anchorDate: "2026-07-04", time: "18:45" },
    });
    // The fields a one-off cannot use are left out rather than sent as defaults,
    // because the server refuses them outright.
    const notification = (posts[0]!.body as { notification: Record<string, unknown> }).notification;
    expect(Object.keys(notification).sort()).toEqual(["anchorDate", "frequency", "time"]);
  });

  it("sends a repeating reminder with the schedule it was given", async () => {
    const posts = stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    fireEvent.click(dialog.getByLabelText(/Email me to make this/));
    fireEvent.click(dialog.getByLabelText("Repeatedly"));
    fireEvent.change(dialog.getByLabelText("Repeats"), {
      target: { value: "monthly" },
    });
    fireEvent.change(dialog.getByLabelText(/^Starting/), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(dialog.getByLabelText(/^Send at/), { target: { value: "07:30" } });
    fireEvent.click(dialog.getByLabelText(/On a relative day/));
    fireEvent.change(dialog.getByLabelText(/Which one to remind on/), {
      target: { value: "-1" },
    });
    fireEvent.change(dialog.getByLabelText(/Day to remind on/), {
      target: { value: "5" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({
      notification: {
        frequency: "monthly",
        interval: 1,
        anchorDate: "2026-07-01",
        time: "07:30",
        position: { ordinal: -1, weekday: 5 },
      },
    });
  });

  /**
   * The two business-day policies would put two reminders on one date for a daily
   * rule of one or two days, which the shared contract refuses. Offering them and
   * then submitting the refusal is how somebody gets a server error about a rule
   * the form told them was available.
   */
  it("disables the reminder policies that would land two on one date, and says why", async () => {
    stubApi([rent]);
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    fireEvent.click(dialog.getByLabelText(/Email me to make this/));
    fireEvent.click(dialog.getByLabelText("Repeatedly"));
    fireEvent.change(dialog.getByLabelText("Repeats"), {
      target: { value: "daily" },
    });
    fireEvent.change(dialog.getByLabelText(/^Every N days/), {
      target: { value: "1" },
    });

    expect(await screen.findByText(/would land two on the same date/)).toBeInTheDocument();
    expect(dialog.getByRole("option", { name: "Send it on the Friday" })).toBeDisabled();
  });

  it("seeds the reminder from the template being edited", async () => {
    const reminded: TransactionTemplate = {
      ...rent,
      notification: {
        frequency: "weekly",
        interval: 2,
        anchorDate: "2026-06-15",
        monthPolicy: "last_day",
        weekendPolicy: "skip",
        position: null,
        time: "21:15",
        repeats: true,
        lastNotifiedDate: null,
        nextNotificationDate: "2026-06-15",
      },
    };
    stubApi([reminded]);
    await renderPage([reminded]);
    const dialog = await openEditor("Rent");

    expect(dialog.getByLabelText(/Email me to make this/)).toBeChecked();
    expect(dialog.getByLabelText("Repeatedly")).toBeChecked();
    expect(dialog.getByLabelText("Repeats")).toHaveValue("weekly");
    expect(dialog.getByLabelText(/^Starting/)).toHaveValue("2026-06-15");
    expect(dialog.getByLabelText(/^Send at/)).toHaveValue("21:15");
  });

  it("says so when the deployment has no way to send a reminder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/transaction-templates") {
          return Response.json([rent]);
        }
        if (url.pathname === "/api/v1/accounts") return Response.json([checking]);
        if (url.pathname === "/api/v1/categories") return Response.json([groceries]);
        if (url.pathname === "/api/auth/methods") {
          return Response.json({ notificationsAvailable: false });
        }
        return Response.json([]);
      }),
    );
    await renderPage([rent]);
    const dialog = await openEditor("Rent");

    fireEvent.click(dialog.getByLabelText(/Email me to make this/));

    expect(await screen.findByText(/no mail server configured/)).toBeInTheDocument();
  });

  it("says a one-off reminder has been sent once nothing further is owed", async () => {
    const spent: TransactionTemplate = {
      ...rent,
      notification: {
        frequency: null,
        interval: 1,
        anchorDate: "2026-06-15",
        monthPolicy: "last_day",
        weekendPolicy: "allow",
        position: null,
        time: "09:00",
        repeats: false,
        lastNotifiedDate: "2026-06-15",
        nextNotificationDate: null,
      },
    };
    stubApi([spent]);
    await renderPage([spent]);

    expect(within(rowFor("Rent")).getByText("sent")).toBeInTheDocument();
  });
});
