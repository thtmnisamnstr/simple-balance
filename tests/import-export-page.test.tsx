// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../src/client/api.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import { BrowserRouter } from "../src/client/router.js";
import {
  defaultLedgerFileKinds,
  ledgerFileKinds,
  ledgerFileQueryString,
  MAX_LEDGER_FILE_ACCOUNT_CHOICES,
  type LedgerFileSelection,
} from "../src/shared/ledger-file.js";

/**
 * The export half of Import and export, against the request the route reads.
 *
 * The route is somebody else's, so it is answered here, and what is held is
 * the half of the contract the page owns: which boxes start ticked, what each
 * control does to the query string, which choices never reach the server, and
 * that a refusal comes back as a sentence on the page rather than as a file.
 * The query string is compared whole against `ledgerFileQueryString`, the
 * shared builder, so the test and the page cannot agree with each other and
 * disagree with the route.
 */
const account = (id: string, name: string, over: Partial<Account> = {}): Account => ({
  id,
  name,
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  archivedAt: null,
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
  ...over,
});

const CHECKING = account("11111111-1111-4111-8111-111111111111", "Checking");
const CARD = account("22222222-2222-4222-8222-222222222222", "Travel card", {
  type: "credit_card",
  frozen: true,
});
const OLD = account("33333333-3333-4333-8333-333333333333", "Old savings", {
  type: "savings",
  currency: "EUR",
  archivedAt: "2026-03-01T12:00:00.000Z",
});

type Exported = { url: URL; init: RequestInit | undefined };

const saved: string[] = [];

beforeEach(() => {
  saved.length = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:ledger-file"),
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push(this.download);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // jsdom has neither, so they were defined above rather than spied on, and a
  // definition left behind would be a browser API the next file never had.
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

/** A 200 the way the route answers one: the file, and the name to save it under. */
const fileResponse = (name = "simple-balance-2026-10-25.json") =>
  new Response('{"format":"simple-balance-ledger-1"}\n', {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });

/**
 * The page, with the accounts it lists and the answer the export gets.
 *
 * `/api/v1/accounts` answers the way the route does: in name order, and with
 * the archived ones only when asked for, which the CSV import's picker leaves
 * out and the export's list asks for.
 */
function renderPage({
  accounts = [CHECKING, OLD, CARD],
  answer = () => fileResponse(),
}: {
  accounts?: readonly Account[];
  answer?: () => Response | Promise<Response>;
} = {}) {
  const exported: Exported[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/ledger-file") {
        exported.push({ url, init });
        return answer();
      }
      if (url.pathname === "/api/v1/accounts") {
        const archived = url.searchParams.get("includeArchived") === "true";
        return Response.json(accounts.filter((one) => archived || !one.archivedAt));
      }
      if (url.pathname === "/api/v1/categories") return Response.json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <ImportPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return exported;
}

const exportSection = () => screen.getByRole("region", { name: "Export a Simple Balance file" });
const exportButton = () => within(exportSection()).getByRole("button", { name: /Export file/ });

/** The query the page sent, as the shared builder would have written it. */
const expectQuery = (sent: Exported | undefined, selection: LedgerFileSelection) => {
  expect(sent, "the export was requested").toBeDefined();
  expect(sent!.url.pathname).toBe("/api/v1/ledger-file");
  expect(sent!.url.search.slice(1)).toBe(ledgerFileQueryString(selection));
};

/** Every kind the format has, in its own order, from a set. */
const inOrder = (kinds: Iterable<string>) => {
  const wanted = new Set(kinds);
  return ledgerFileKinds.filter((kind) => wanted.has(kind));
};

const chooseSomeAccounts = async () => {
  fireEvent.click(within(exportSection()).getByRole("radio", { name: /Some accounts/ }));
  return within(exportSection()).findByRole("group", { name: "Accounts" });
};

describe("the page", () => {
  it("is Import and export, with the CSV import first and the export after it", async () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Import and export" })).toBeVisible();
    expect(document.title).toMatch(/^Import and export/);
    const csv = screen.getByRole("region", { name: "Import a CSV" });
    expect(csv.compareDocumentPosition(exportSection())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // One level down from each section's heading, so the outline reads as two
    // sections rather than as eight peers.
    expect(
      await within(csv).findByRole("heading", { level: 3, name: "Choose a CSV file" }),
    ).toBeVisible();
    expect(within(csv).getByRole("heading", { level: 3, name: "File preview" })).toBeVisible();
    // And the preview's empty state one level under its panel, not beside it.
    expect(within(csv).getByRole("heading", { level: 4, name: "No file yet" })).toBeVisible();
  });

  /**
   * Both empty states used to replace the whole page, which stopped mattering
   * the day the page held something besides the import: a ledger with no
   * account to post a CSV against still has categories, templates and settings
   * to export.
   */
  it("keeps a CSV import with nothing to post against inside its own section", async () => {
    renderPage({ accounts: [] });
    const csv = screen.getByRole("region", { name: "Import a CSV" });
    expect(
      await within(csv).findByRole("heading", { name: "No account to import into" }),
    ).toBeVisible();
    // The way there, as the frozen branch beside it has always offered.
    expect(within(csv).getByRole("link", { name: "Go to Accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    expect(exportButton()).toBeEnabled();
  });

  it("keeps the empty state for every account frozen inside the CSV section too", async () => {
    renderPage({ accounts: [{ ...CHECKING, frozen: true }] });
    const csv = screen.getByRole("region", { name: "Import a CSV" });
    expect(
      await within(csv).findByRole("heading", { name: "Every account is frozen" }),
    ).toBeVisible();
    expect(within(exportSection()).getByRole("radio", { name: /Everything/ })).toBeChecked();
  });
});

describe("exporting everything", () => {
  it("starts with every kind ticked but the activity history", async () => {
    const exported = renderPage();
    const holds = within(exportSection()).getByRole("group", { name: "What the file holds" });
    const boxes = within(holds).getAllByRole("checkbox");
    expect(
      boxes
        .filter((box) => !(box as HTMLInputElement).checked)
        .map((box) => box.closest("label")?.textContent),
    ).toEqual(["Activity history (kept in the file, cannot be imported)"]);
    // Named by the two Settings headings that hold what it carries, so the
    // words somebody checks it against are the words Settings uses.
    expect(
      within(holds).getByRole("checkbox", { name: "Regional defaults and appearance" }),
    ).toBeChecked();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], { kinds: [...defaultLedgerFileKinds] });
  });

  /**
   * Population rather than a list: ticking every box on the page has to ask
   * for every kind the format defines, so a kind added to `ledgerFileKinds`
   * with no box beside it fails here rather than shipping unreachable — the
   * defect `AGENTS.md` names for a field only an agent can set.
   */
  it("offers a box for every kind the format has", async () => {
    const exported = renderPage();
    const holds = within(exportSection()).getByRole("group", { name: "What the file holds" });
    for (const box of within(holds).getAllByRole("checkbox")) {
      if (!(box as HTMLInputElement).checked) fireEvent.click(box);
    }
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], { kinds: [...ledgerFileKinds] });
  });

  it("leaves out a kind somebody unticks", async () => {
    const exported = renderPage();
    fireEvent.click(within(exportSection()).getByRole("checkbox", { name: "Budgets" }));
    fireEvent.click(within(exportSection()).getByRole("checkbox", { name: "Staged transactions" }));
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], {
      kinds: defaultLedgerFileKinds.filter((kind) => kind !== "budgets" && kind !== "staged"),
    });
  });

  /**
   * Deleted entries and a range both narrow the entries, and the shared schema
   * refuses either without them. So unticking Transactions disables both and
   * the request carries neither, whatever they were left set to.
   */
  it("takes deleted entries and the range with Transactions, and never without them", async () => {
    const exported = renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    fireEvent.change(within(section).getByLabelText("Start date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(within(section).getByLabelText("End date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.click(within(section).getByRole("checkbox", { name: "Transactions" }));
    expect(
      within(section).getByRole("checkbox", { name: "Include deleted transactions" }),
    ).toBeDisabled();
    expect(within(section).getByRole("radio", { name: "Date range" })).toBeDisabled();
    expect(within(section).getByLabelText("Start date")).toBeDisabled();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], {
      kinds: defaultLedgerFileKinds.filter(
        (kind) => kind !== "entries" && kind !== "deletedEntries",
      ),
    });

    fireEvent.click(within(section).getByRole("checkbox", { name: "Transactions" }));
    fireEvent.click(
      within(section).getByRole("checkbox", { name: "Include deleted transactions" }),
    );
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(2));
    expectQuery(exported[1], {
      kinds: defaultLedgerFileKinds.filter((kind) => kind !== "deletedEntries"),
      start: "2026-01-01",
      end: "2026-06-30",
    });
  });

  /**
   * A range narrows the activity history too, so with the history ticked it
   * is offered whether or not Transactions is, and the question says what it
   * will narrow. The carry sentence is only for a file with accounts and their
   * transactions in it.
   */
  it("offers the range for the activity history alone, and says what it narrows", async () => {
    const exported = renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("checkbox", { name: "Transactions" }));
    expect(within(section).getByRole("radio", { name: "Date range" })).toBeDisabled();
    fireEvent.click(within(section).getByRole("checkbox", { name: /Activity history/ }));
    expect(
      within(section).getByRole("radiogroup", { name: "Activity history from" }),
    ).toBeVisible();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    const startDate = within(section).getByLabelText("Start date");
    expect(startDate).toBeEnabled();
    expect(startDate).toHaveAccessibleDescription("The activity history covers the same days.");
    fireEvent.change(startDate, { target: { value: "2026-01-01" } });
    fireEvent.change(within(section).getByLabelText("End date"), {
      target: { value: "2026-03-31" },
    });
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], {
      kinds: inOrder(
        [...defaultLedgerFileKinds, "history"].filter(
          (kind) => kind !== "entries" && kind !== "deletedEntries",
        ),
      ),
      start: "2026-01-01",
      end: "2026-03-31",
    });

    fireEvent.click(within(section).getByRole("checkbox", { name: "Transactions" }));
    expect(
      within(section).getByRole("radiogroup", { name: "Transactions and activity from" }),
    ).toBeVisible();
    expect(within(section).getByLabelText("Start date")).toHaveAccessibleDescription(
      "Each account carries what it held the day before, so its balance in the file still adds up. The activity history covers the same days.",
    );
  });

  it("asks for nothing while no kind is ticked, and says why", () => {
    const exported = renderPage();
    const holds = within(exportSection()).getByRole("group", { name: "What the file holds" });
    for (const box of within(holds).getAllByRole("checkbox")) {
      if ((box as HTMLInputElement).checked && !(box as HTMLInputElement).disabled) {
        fireEvent.click(box);
      }
    }
    const button = exportButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Choose at least one kind of record to export.");
    fireEvent.click(button);
    expect(exported).toEqual([]);
  });
});

describe("exporting some accounts", () => {
  it("lists every account, archived ones marked and frozen ones like any other", async () => {
    renderPage();
    const list = await chooseSomeAccounts();
    await within(list).findByRole("checkbox", { name: /Checking/ });
    const names = within(list)
      .getAllByRole("checkbox")
      .map((box) => box.closest("label")?.textContent);
    // In use first, archived after: the server's name order would put Old
    // savings between the two.
    expect(names).toEqual(["Checking USD", "Travel card USD", "Old savings EUR Archived"]);
    expect(within(list).getByRole("checkbox", { name: "Old savings EUR Archived" })).toBeVisible();
  });

  it("sends the accounts alone for account details only", async () => {
    const exported = renderPage();
    const list = await chooseSomeAccounts();
    fireEvent.click(await within(list).findByRole("checkbox", { name: /Old savings/ }));
    fireEvent.click(within(list).getByRole("checkbox", { name: /Checking/ }));
    expect(
      within(exportSection()).getByRole("radio", { name: "No, account details only" }),
    ).toBeChecked();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    // In the list's order, which is the order on screen, not the order ticked.
    expectQuery(exported[0], { kinds: ["accounts"], accountIds: [CHECKING.id, OLD.id] });
    await waitFor(() => expect(saved).toEqual(["simple-balance-2026-10-25.json"]));
  });

  it("sends the accounts with their categories and every entry for all of them", async () => {
    const exported = renderPage();
    const list = await chooseSomeAccounts();
    fireEvent.click(await within(list).findByRole("checkbox", { name: /Travel card/ }));
    fireEvent.click(within(exportSection()).getByRole("radio", { name: "All of them" }));
    const deleted = within(exportSection()).getByRole("checkbox", {
      name: "Include deleted transactions",
    });
    expect(deleted).toBeChecked();
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], {
      kinds: inOrder(["accounts", "categories", "entries", "deletedEntries"]),
      accountIds: [CARD.id],
    });

    fireEvent.click(deleted);
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(2));
    expectQuery(exported[1], {
      kinds: inOrder(["accounts", "categories", "entries"]),
      accountIds: [CARD.id],
    });
  });

  it("sends the range with the entries for in a date range", async () => {
    const exported = renderPage();
    const list = await chooseSomeAccounts();
    fireEvent.click(await within(list).findByRole("checkbox", { name: /Checking/ }));
    fireEvent.click(within(exportSection()).getByRole("radio", { name: "In a date range" }));
    fireEvent.change(within(exportSection()).getByLabelText("Start date"), {
      target: { value: "2026-04-01" },
    });
    fireEvent.change(within(exportSection()).getByLabelText("End date"), {
      target: { value: "2026-04-30" },
    });
    fireEvent.click(exportButton());
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], {
      kinds: inOrder(["accounts", "categories", "entries", "deletedEntries"]),
      accountIds: [CHECKING.id],
      start: "2026-04-01",
      end: "2026-04-30",
    });
  });

  it("asks for nothing until an account is ticked, and says why", async () => {
    const exported = renderPage();
    const list = await chooseSomeAccounts();
    await within(list).findByRole("checkbox", { name: /Checking/ });
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAccessibleDescription("Choose at least one account to export.");
    fireEvent.click(exportButton());
    expect(exported).toEqual([]);
  });

  it("says there is nothing to choose when the ledger has no account", async () => {
    renderPage({ accounts: [] });
    const list = await chooseSomeAccounts();
    expect(
      await within(list).findByText("There are no accounts to choose from yet."),
    ).toBeVisible();
    expect(exportButton()).toHaveAccessibleDescription("Create an account first.");
  });

  /**
   * The cap is the shared schema's, and its sentence is the one shown: the
   * check runs before the request, so a selection the route would refuse
   * costs nothing to find out about.
   */
  it("refuses more accounts than one export may name before asking, with this page's way out", async () => {
    const many = Array.from({ length: MAX_LEDGER_FILE_ACCOUNT_CHOICES + 1 }, (_, index) =>
      account(`44444444-4444-4444-8444-${String(index).padStart(12, "0")}`, `Account ${index}`),
    );
    const exported = renderPage({ accounts: many });
    const list = await chooseSomeAccounts();
    await within(list).findByRole("checkbox", { name: "Account 0 USD" });
    // Said before anybody meets the refusal, from the constant that sets it.
    expect(list).toHaveAccessibleDescription(
      new RegExp(`^Up to ${MAX_LEDGER_FILE_ACCOUNT_CHOICES} accounts in one file\\.`),
    );
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes).toHaveLength(MAX_LEDGER_FILE_ACCOUNT_CHOICES + 1);
    for (const box of boxes) fireEvent.click(box);
    fireEvent.click(exportButton());
    const summary = await within(exportSection()).findByRole("alert");
    // Not the shared sentence's "leave them out": on this page that is
    // unticking every box, which disables the button. Everything is the move.
    expect(summary).toHaveTextContent(
      `Choose at most ${MAX_LEDGER_FILE_ACCOUNT_CHOICES} accounts, or choose Everything to export every account`,
    );
    expect(summary).not.toHaveTextContent("leave them out");
    expect(exported).toEqual([]);
  });
});

describe("a date range", () => {
  it("is refused before anything is asked when it ends before it starts", async () => {
    const exported = renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    fireEvent.change(within(section).getByLabelText("Start date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(within(section).getByLabelText("End date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.click(exportButton());
    const summary = await within(section).findByRole("alert");
    expect(summary).toHaveTextContent("The range cannot end before it starts");
    // GOV.UK's three agreeing signals, on the field the sentence is about.
    const endDate = within(section).getByLabelText("End date");
    expect(endDate).toHaveAttribute("aria-invalid", "true");
    // The refusal alone: End date has no hint of its own since the advice on
    // moving by ranges went to the range question it is about.
    expect(endDate).toHaveAccessibleDescription("The range cannot end before it starts");
    expect(within(section).getByLabelText("Start date")).not.toHaveAttribute("aria-invalid");
    expect(document.activeElement).toBe(summary.closest(".error-summary"));
    expect(exported).toEqual([]);
  });

  /**
   * The refusal is about the form as it was sent. A switch that takes away the
   * field it names clears it, or the summary links to a field that is gone and
   * sits beside a form whose button says something else is wrong.
   */
  it.each([
    ["All time", "radio", "All time"],
    ["Some accounts", "radio", /Some accounts/],
    ["Transactions", "checkbox", "Transactions"],
  ] as const)("clears a refusal about the range when %s is chosen", async (_, role, name) => {
    renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    fireEvent.change(within(section).getByLabelText("Start date"), {
      target: { value: "2026-06-30" },
    });
    fireEvent.change(within(section).getByLabelText("End date"), {
      target: { value: "2026-01-01" },
    });
    fireEvent.click(exportButton());
    await within(section).findByRole("alert");
    fireEvent.click(within(section).getByRole(role, { name }));
    await waitFor(() => expect(within(section).queryByRole("alert")).toBeNull());
  });

  it("says what the start date does on the field itself", () => {
    renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    expect(within(section).getByLabelText("Start date")).toHaveAccessibleDescription(
      "Each account carries what it held the day before, so its balance in the file still adds up.",
    );
  });

  it("says on the range question that only the latest range of a move should carry recurring transactions", () => {
    renderPage();
    const section = exportSection();
    const question = within(section).getByRole("radiogroup", { name: "Transactions from" });
    const advice =
      "When a ledger moves a range at a time, only the latest range should carry recurring transactions: one an earlier range brings can propose a row into Staged before the next range is moved, which stops the move until that row is discarded.";
    // Said once a range is chosen, on the choice that makes one — not on End
    // date, which it says nothing about.
    expect(question).not.toHaveAccessibleDescription(advice);
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    expect(question).toHaveAccessibleDescription(advice);
    expect(within(section).getByLabelText("End date")).not.toHaveAccessibleDescription(advice);
    // Said only while recurring transactions are in the file.
    fireEvent.click(within(section).getByRole("checkbox", { name: "Recurring transactions" }));
    expect(question).not.toHaveAccessibleDescription(advice);
  });

  it("needs both of its days, and the browser says so rather than the page", async () => {
    const exported = renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    const startDate = within(section).getByLabelText("Start date") as HTMLInputElement;
    expect(startDate).toBeRequired();
    expect(within(section).getByLabelText("End date")).toBeRequired();
    fireEvent.click(exportButton());
    expect(startDate.validity.valueMissing).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exported).toEqual([]);
  });
});

describe("the download", () => {
  /**
   * The request the route is written against: a GET of `/api/v1/ledger-file`
   * with the session's cookie and no body, so `Cache-Control: no-store` and
   * the `ledger:read` scope are all it meets — no idempotency key, no origin
   * check, no body limit.
   */
  it("is a plain GET with the session, saved under the name the server gave", async () => {
    const exported = renderPage({ answer: () => fileResponse("simple-balance-2026-10-24.json") });
    fireEvent.click(exportButton());
    await waitFor(() => expect(saved).toEqual(["simple-balance-2026-10-24.json"]));
    expect(exported).toHaveLength(1);
    expect(exported[0]!.init?.method ?? "GET").toBe("GET");
    expect(exported[0]!.init?.body).toBeUndefined();
    expect(exported[0]!.init?.credentials).toBe("include");
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(within(exportSection()).queryByRole("alert")).toBeNull();
  });

  it("is saved as JSON when a proxy strips the server's name", async () => {
    renderPage({
      answer: () =>
        new Response("{}\n", { headers: { "Content-Type": "application/json; charset=utf-8" } }),
    });
    fireEvent.click(exportButton());
    await waitFor(() => expect(saved).toEqual(["simple-balance.json"]));
  });

  it("says the button is working while the file is on its way, and keeps focus on it", async () => {
    let finish: (response: Response) => void = () => {};
    renderPage({ answer: () => new Promise<Response>((resolve) => (finish = resolve)) });
    const button = exportButton();
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toHaveTextContent("Working…");
    expect(document.activeElement).toBe(button);
    finish(fileResponse());
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(document.activeElement).toBe(button);
  });
});

describe("a refusal", () => {
  it("shows the row cap's sentence, which names the way out", async () => {
    const sentence =
      "This export would hold 120,000 rows, more than the 100,000 one file may. Narrow the entries with a start and end date, or leave staged rows, budgets or the activity history to a file of their own, and export one piece at a time.";
    renderPage({
      answer: () =>
        Response.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: sentence,
              details: { limit: 100_000, count: 120_000 },
            },
          },
          { status: 422 },
        ),
    });
    fireEvent.click(exportButton());
    const summary = await within(exportSection()).findByRole("alert");
    expect(summary).toHaveTextContent("There is a problem");
    expect(summary).toHaveTextContent(sentence);
    expect(saved).toEqual([]);
  });

  it("shows an account that is not this person's as not found", async () => {
    renderPage({
      answer: () =>
        Response.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Account not found",
              details: { accountId: CHECKING.id },
            },
          },
          { status: 404 },
        ),
    });
    const list = await chooseSomeAccounts();
    fireEvent.click(await within(list).findByRole("checkbox", { name: /Checking/ }));
    fireEvent.click(exportButton());
    expect(await within(exportSection()).findByRole("alert")).toHaveTextContent(
      "Account not found",
    );
  });

  it("puts a sentence the server pins to a field beside that field", async () => {
    renderPage({
      answer: () =>
        Response.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Request validation failed",
              details: [
                { code: "custom", path: ["kinds"], message: "Name each kind of record once" },
              ],
            },
          },
          { status: 422 },
        ),
    });
    fireEvent.click(exportButton());
    await within(exportSection()).findByRole("alert");
    const holds = within(exportSection()).getByRole("group", { name: "What the file holds" });
    expect(holds).toHaveAccessibleDescription(/Name each kind of record once/);
  });
});

describe("keyboard and names", () => {
  it("names every control and every group, in both halves", async () => {
    renderPage();
    const section = exportSection();
    expect(within(section).getByRole("group", { name: "What to export" })).toBeVisible();
    expect(within(section).getByRole("radiogroup", { name: "Transactions from" })).toBeVisible();
    const named = () =>
      within(section)
        .getAllByRole("checkbox")
        .concat(within(section).getAllByRole("radio"))
        .filter((control) => !control.getAttribute("aria-label") && !control.closest("label"));
    expect(named()).toEqual([]);

    await chooseSomeAccounts();
    await within(section).findByRole("checkbox", { name: /Checking/ });
    expect(
      within(section).getByRole("radiogroup", { name: "With their transactions" }),
    ).toBeVisible();
    expect(named()).toEqual([]);
  });

  /**
   * One tab stop per group: a browser moves between radios with the arrows
   * only when they share a name, and two groups sharing one would merge.
   */
  it("gives each radio group a name of its own", async () => {
    renderPage();
    const section = exportSection();
    await chooseSomeAccounts();
    const names = within(section)
      .getAllByRole("radio")
      .map((radio) => radio.getAttribute("name"));
    expect(new Set(names).size).toBe(2);
    for (const group of within(section).getAllByRole("radiogroup")) {
      const inside = within(group)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("name"));
      expect(new Set(inside).size).toBe(1);
    }
  });

  /**
   * `web.md` 14: Enter submits from any single-line field. That is the
   * browser's implicit submission, which needs the fields and one submit
   * button in a single form; jsdom performs no implicit submission, so this
   * holds the shape and submits the form the way Enter would.
   */
  it("is one form with its submit, so Enter in a date field exports", async () => {
    const exported = renderPage();
    const section = exportSection();
    fireEvent.click(within(section).getByRole("radio", { name: "Date range" }));
    fireEvent.change(within(section).getByLabelText("Start date"), {
      target: { value: "2026-01-01" },
    });
    const endDate = within(section).getByLabelText("End date");
    fireEvent.change(endDate, { target: { value: "2026-12-31" } });
    const form = endDate.closest("form")!;
    expect(exportButton().closest("form")).toBe(form);
    expect(exportButton()).toHaveAttribute("type", "submit");
    expect(within(form).getAllByRole("button")).toHaveLength(1);
    fireEvent.submit(form);
    await waitFor(() => expect(exported).toHaveLength(1));
    expectQuery(exported[0], {
      kinds: [...defaultLedgerFileKinds],
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });
});
