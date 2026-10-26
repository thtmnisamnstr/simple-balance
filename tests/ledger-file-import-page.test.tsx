// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportBatchSummary, PaginatedPage, StagedTransaction } from "../src/client/api.js";
import { LedgerFileImport } from "../src/client/LedgerFileImport.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import {
  LEDGER_FILE_PART_MAX_BYTES,
  serializeLedgerFile,
  splitLedgerFile,
  type LedgerFilePartLimits,
} from "../src/shared/ledger-file.js";
import {
  ledgerFileAddInputSchema,
  ledgerFilePreviewInputSchema,
  ledgerFilePreviewSchema,
  type LedgerFileAddInput,
  type LedgerFileFacts,
} from "../src/shared/ledger-file-import.js";
import { chosenAccounts, origin, wholeLedger } from "./support/ledger-file.js";
import {
  accountLike,
  factsOf,
  ownAccount,
  parsedLedger,
  previewFor,
  resultFor,
  unchecked,
} from "./support/ledger-file-facts.js";
import { streamedResponse } from "./support/streamed-response.js";

/**
 * The import half of Import and export, against the two routes it calls.
 *
 * The routes are somebody else's, so they are answered here, and answered by
 * the shared planner the server runs: the preview's facts are built from a
 * destination this file describes, and every body the page sends is parsed
 * with the route's own schema before it is answered, so a request the server
 * would refuse fails here as a thrown parse rather than as a passing test.
 *
 * What is held is the half of the contract the page owns: the file is read and
 * refused in the browser before anything is sent; every part is previewed in
 * order and said so; each record that needs a choice is offered exactly its
 * choices, in the page's words, with nothing chosen; nothing is ever sent for a
 * record that asks nothing; places and settings wait for the person; and an add
 * goes part by part with one key per part, stops where a part stops, and can be
 * tried again or checked again.
 */

type Json = Record<string, unknown>;
type Sent = { body: LedgerFileAddInput; raw: Json; accept: string | null };

/**
 * The two routes, answered the way the server answers them.
 *
 * `here` is the set of origins this ledger already holds, which is what the
 * preview's row counts are read from. `answer` decides each add by call; left
 * out, every part succeeds with the plan it carried out.
 */
function stubServer({
  facts,
  here = new Set<string>(),
  answer,
  hold,
}: {
  facts: LedgerFileFacts;
  here?: ReadonlySet<string>;
  answer?: (body: LedgerFileAddInput, call: number) => Response | Promise<Response>;
  hold?: (call: number) => Promise<void> | undefined;
}) {
  const previews: string[] = [];
  const adds: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/ledger-file:preview") {
        const { ledgerFile } = ledgerFilePreviewInputSchema.parse(JSON.parse(String(init?.body)));
        previews.push(ledgerFile);
        await hold?.(previews.length);
        return Response.json(ledgerFilePreviewSchema.parse(previewFor(ledgerFile, facts, here)));
      }
      if (url.pathname === "/api/v1/ledger-file:add") {
        const raw = JSON.parse(String(init?.body)) as Json;
        // The route's own parser: a body it would refuse fails the test here.
        const body = ledgerFileAddInputSchema.parse(raw);
        adds.push({ body, raw, accept: new Headers(init?.headers).get("Accept") });
        if (answer) return answer(body, adds.length);
        return Response.json(resultFor(body, facts, here));
      }
      if (url.pathname === "/api/v1/accounts") return Response.json([]);
      if (url.pathname === "/api/v1/categories") return Response.json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return { previews, adds };
}

function renderImport(partLimits?: LedgerFilePartLimits) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <LedgerFileImport {...(partLimits ? { partLimits } : {})} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const NAME = "simple-balance-2026-10-25.json";

/** Choose a file the way the drop zone's input would be given one. */
function choose(contents: Json | string, name = NAME) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  const text = typeof contents === "string" ? contents : JSON.stringify(contents);
  fireEvent.change(input, {
    target: { files: [new File([text], name, { type: "application/json" })] },
  });
}

/** The add button in whatever it says now. */
const addButton = () => screen.getByRole("button", { name: /Add to this ledger|Try .*again/ });
const checked = () => screen.findByRole("button", { name: /Add to this ledger/ });

/** The parts the page sends a file in, as the shared splitter cuts it. */
const partsOf = (json: Json, limits?: LedgerFilePartLimits) => {
  const split = splitLedgerFile(parsedLedger(json), limits);
  if (!split.ok) throw new Error(split.message);
  return split.parts.map(serializeLedgerFile);
};

const SMALL: LedgerFilePartLimits = { maxRows: 3, maxBytes: LEDGER_FILE_PART_MAX_BYTES };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the section", () => {
  it("sits between the CSV import and the export, and says what adding does", async () => {
    stubServer({ facts: factsOf() });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <ImportPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    const csv = screen.getByRole("region", { name: "Import a CSV" });
    const file = screen.getByRole("region", { name: "Import a Simple Balance file" });
    const exported = screen.getByRole("region", { name: "Export a Simple Balance file" });
    expect(csv.compareDocumentPosition(file)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(file.compareDocumentPosition(exported)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(file).getByText(/transactions go to Staged for review/)).toBeVisible();
    expect(within(file).getByText("Choose a Simple Balance file")).toBeVisible();
    // Nothing to add until a file is chosen.
    expect(within(file).queryByRole("button", { name: /Add to this ledger/ })).toBeNull();
  });
});

describe("a file the browser refuses", () => {
  it("is refused in the reader's own sentence, before anything is sent", async () => {
    const { previews } = stubServer({ facts: factsOf() });
    renderImport();
    choose("Date,Payee,Amount\n2026-10-01,Rewe,-54.23\n", "march.csv");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This is not a Simple Balance file: it could not be read as JSON. A CSV export goes through the CSV import instead, and a file that was cut short has to be exported again.",
    );
    expect(previews).toEqual([]);
  });

  it("lists every problem with the place in the file it points at", async () => {
    const { previews } = stubServer({ facts: factsOf() });
    renderImport();
    const file = wholeLedger();
    const entries = file.entries as Json[];
    // Two amounts written as JSON numbers, which the format refuses rather
    // than rounds.
    entries[0] = { ...entries[0], amount: 54.23 };
    entries[2] = { ...entries[2], amount: 80 };
    choose(file);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This file cannot be added as it is.");
    const items = within(alert).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(
      /^entries\.0\.amount A Simple Balance file writes every amount/,
    );
    expect(items[1]).toHaveTextContent(/^entries\.2\.amount /);
    expect(previews).toEqual([]);
  });
});

describe("checking the file", () => {
  it("previews every part in order, says which part it is on, and plans the whole file", async () => {
    let release: () => void = () => {};
    const { previews } = stubServer({
      facts: factsOf(),
      hold: (call) =>
        call === 2
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : undefined,
    });
    renderImport(SMALL);
    choose(wholeLedger());
    expect(await screen.findByText("Checking part 2 of 3 against this ledger")).toBeInTheDocument();
    release();
    await checked();
    // Exactly the splitter's parts, serialized, one request each and in order.
    expect(previews).toEqual(partsOf(wholeLedger(), SMALL));
    // And the page planned the whole file: all five live entries and both
    // staged rows, not the last part's share of them.
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Ready to add: 14 new records and 7 rows for Staged.",
    );
  });

  it("adds up what every part found already here, not what one part did", async () => {
    // Cut three rows to a part, the entries go by date: origin 1 is in the
    // first part and origin 4 in the second, so only the merged facts know
    // both are here.
    stubServer({ facts: factsOf(), here: new Set([origin(1), origin(4)]) });
    renderImport(SMALL);
    choose(wholeLedger());
    await checked();
    expect(
      screen.getByText("2 transactions are already in this ledger, so they are skipped."),
    ).toBeVisible();
  });

  it("counts every kind in a real table, and says what the transactions will do", async () => {
    stubServer({ facts: factsOf() });
    renderImport();
    choose(wholeLedger());
    await checked();
    const table = screen.getByRole("table", {
      name: "What happens to each kind of record in the file",
    });
    const header = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(header).toEqual([
      "Kind",
      "In the file",
      "New",
      "Already here",
      "Needs a choice",
      "Left out",
    ]);
    const row = (kind: string) =>
      within(within(table).getByRole("rowheader", { name: kind }).closest("tr")!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(row("Category groups")).toEqual(["1", "1", "0", "0", "0"]);
    expect(row("Categories")).toEqual(["4", "4", "0", "0", "0"]);
    expect(row("Accounts")).toEqual(["3", "3", "0", "0", "0"]);
    expect(row("Recurring transactions")).toEqual(["2", "2", "0", "0", "0"]);
    expect(row("Budget amounts")).toEqual(["1", "1", "0", "0", "0"]);
    for (const sentence of [
      "5 transactions go to Staged for review, with both sides of every transfer filled in.",
      "2 staged rows from the file wait in Staged again.",
      "1 deleted transaction in the file is not added, because a row in Staged cannot be a deleted transaction.",
      "1 transaction will count as income where it counted as a refund of spending, or the other way round, because a category's kind changed after it was written. Balances are the same either way.",
    ]) {
      expect(screen.getByText(sentence)).toBeVisible();
    }
    // What a record does that nobody is asked about is said beside its name.
    expect(screen.getByText('Category "Old hobby"').closest("li")).toHaveTextContent(
      "It was archived where it came from. It arrives in use so the transactions filed under it can be committed; archive it again once they are.",
    );
    // Nothing needs deciding, so the button is ready.
    expect(addButton()).toBeEnabled();
  });

  it("says how many transactions are already here, and skips them", async () => {
    const here = new Set([origin(1), origin(2), origin(101)]);
    stubServer({ facts: factsOf(), here });
    renderImport();
    choose(wholeLedger());
    await checked();
    expect(
      screen.getByText("2 transactions are already in this ledger, so they are skipped."),
    ).toBeVisible();
    expect(
      screen.getByText("1 staged row is already waiting in Staged, so it is skipped."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "3 transactions go to Staged for review, with both sides of every transfer filled in.",
      ),
    ).toBeVisible();
  });

  it("says when everything in the file is already here, and offers nothing to press", async () => {
    const file = parsedLedger(wholeLedger());
    const facts = factsOf(
      {
        groups: file.groups,
        categories: file.categories,
        accounts: file.accounts.map(unchecked),
        templates: file.templates,
        recurrences: file.recurrences,
        budgets: file.budgets,
      },
      {
        preferences: {
          chosen: true,
          timezone: "Europe/Berlin",
          defaultCurrency: "EUR",
          theme: "system",
        },
      },
    );
    const here = new Set([
      ...file.entries.map((entry) => entry.id),
      ...file.staged.map((row) => row.id),
    ]);
    stubServer({ facts, here });
    renderImport();
    choose(wholeLedger());
    await checked();
    expect(screen.getAllByText("Everything in this file is already in this ledger.")).toHaveLength(
      2,
    );
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAccessibleDescription(
      "Everything in this file is already in this ledger.",
    );
  });

  it("lists every record and what happens to it on request", async () => {
    stubServer({ facts: factsOf() });
    renderImport();
    choose(wholeLedger());
    await checked();
    const toggle = screen.getByRole("button", { name: "Show all 15 records" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table", { name: /Every record/ })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide the records" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const table = screen.getByRole("table", {
      name: "Every record in the file, and what happens to it",
    });
    const checking = within(table).getByRole("rowheader", { name: "Checking" }).closest("tr")!;
    expect(
      within(checking)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["New", "Account", ""]);
    const oldCard = within(table).getByRole("rowheader", { name: "Old card" }).closest("tr")!;
    expect(oldCard).toHaveTextContent("New, arrives archived");
    const amounts = within(table)
      .getByRole("rowheader", { name: "Groceries (EUR, by month)" })
      .closest("tr")!;
    expect(amounts).toHaveTextContent("1 new");
    // A plan's first period is named as a period, never as a raw ISO day.
    expect(
      within(table).getByRole("rowheader", { name: "Groceries (EUR, by month) from January 2025" }),
    ).toBeVisible();
    for (const header of within(table).getAllByRole("rowheader")) {
      expect(header.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe("a record already here", () => {
  /** The file against a ledger that already has a "Checking" that is not the file's. */
  const differing = () =>
    factsOf({ accounts: [accountLike("Checking", { institution: "Another bank" })] });

  it("offers use, leave out and a copy, with nothing chosen, and asks before adding", async () => {
    stubServer({ facts: differing() });
    renderImport();
    choose(wholeLedger());
    await checked();
    const group = screen.getByRole("radiogroup", { name: 'Account "Checking" (EUR)' });
    // What differs is said, so "use the one here" is chosen knowing what it keeps.
    expect(group).toHaveAccessibleDescription(
      'There is already an account called "Checking" here, and it differs from the file\'s in its institution.',
    );
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")!.textContent)).toEqual([
      "Use the one here",
      "Leave it out",
      "Bring it in as",
    ]);
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toEqual([]);
    expect(addButton()).toBeDisabled();
    expect(addButton()).toHaveAccessibleDescription("1 question is still open above.");
    expect(screen.getByRole("heading", { name: "One record needs a choice" })).toBeVisible();
  });

  it("lists what is still open, and takes somebody to the question", async () => {
    stubServer({ facts: differing() });
    renderImport();
    choose(wholeLedger());
    await checked();
    const open = screen.getByRole("heading", { name: "Still to decide" }).parentElement!;
    const link = within(open).getByRole("link", {
      name: "There is already an account called \"Checking\" here, and it differs from the file's in its institution. Choose whether to use the one here, leave the file's out or bring it in under another name.",
    });
    fireEvent.click(link);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Use the one here" }));
  });

  it("offers a copy's name only once a copy is chosen, and sends exactly that", async () => {
    const { adds } = stubServer({ facts: differing() });
    renderImport();
    choose(wholeLedger());
    await checked();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Bring it in as" }));
    const name = screen.getByRole("textbox", { name: 'New name for "Checking"' });
    // Suggested, not invented in the request: the first free "(n)".
    expect(name).toHaveValue("Checking (2)");
    fireEvent.change(name, { target: { value: "Checking at the old bank" } });
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.decisions).toEqual([
      { kind: "account", key: "Checking", action: "rename", name: "Checking at the old bank" },
    ]);
  });

  it("says beside the record what is wrong with an answer, in the create's own sentence", async () => {
    stubServer({ facts: differing() });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Bring it in as" }));
    fireEvent.change(screen.getByRole("textbox", { name: 'New name for "Checking"' }), {
      target: { value: "   " },
    });
    const block = screen.getByRole("radiogroup", {
      name: 'Account "Checking" (EUR)',
    }).parentElement!;
    expect(within(block).getByText("Enter an account name")).toBeVisible();
    // Said in the three places that agree (web.md 8.1): beside the field, on
    // it, and named by it, so a screen reader hears which field and why.
    const name = screen.getByRole("textbox", { name: 'New name for "Checking"' });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter an account name");
    expect(block.querySelectorAll(".ledger-import-problem")).toHaveLength(0);
    expect(addButton()).toBeDisabled();
  });

  it("takes somebody from what is still open to the field the sentence is about", async () => {
    stubServer({ facts: differing() });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Bring it in as" }));
    const name = screen.getByRole("textbox", { name: 'New name for "Checking"' });
    fireEvent.change(name, { target: { value: "checking" } });
    const open = screen.getByRole("heading", { name: "Still to decide" }).parentElement!;
    fireEvent.click(within(open).getByRole("link", { name: /has to differ from it/ }));
    expect(document.activeElement).toBe(name);
  });

  it("offers the copy already here as the name to bring it in under, and says why", async () => {
    const checking = accountLike("Checking", {});
    const copy = { ...checking, key: "Checking (2)", name: "Checking (2)" } as typeof checking;
    stubServer({
      facts: factsOf({
        accounts: [accountLike("Checking", { institution: "Another bank" }), copy],
      }),
    });
    renderImport();
    choose(wholeLedger());
    await checked();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Bring it in as" }));
    const name = screen.getByRole("textbox", { name: 'New name for "Checking"' });
    expect(name).toHaveValue("Checking (2)");
    expect(name).toHaveAccessibleDescription(
      '"Checking (2)" here is the same as the file\'s in every field, so an earlier import may have brought it in under that name.',
    );
    expect(addButton()).toBeEnabled();
  });

  it("never offers an account in another currency as the one here", async () => {
    stubServer({ facts: factsOf({ accounts: [accountLike("Checking", { currency: "USD" })] }) });
    renderImport();
    choose(wholeLedger());
    await checked();
    const group = screen.getByRole("radiogroup", { name: 'Account "Checking" (EUR)' });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["Leave it out", "Bring it in as"]);
    expect(group).toHaveAccessibleDescription(
      'There is already an account called "Checking" here, in USD, and the file\'s is in EUR, so the two cannot be one account.',
    );
  });

  it("never sends a decision for a record that stopped asking", async () => {
    // A category is the same as the one here only while its group comes in as
    // the group here. Copying the group makes Groceries ask; using the group
    // here makes it stop, and what was said about it then is not sent.
    const file = parsedLedger(wholeLedger());
    const facts = factsOf({
      groups: [{ key: "Home", name: "Home", detail: "full", policy: "sum_of_children" }],
      categories: [file.categories.find((category) => category.key === "Groceries")!],
    });
    const { adds } = stubServer({ facts });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: 'Category group "Home"' })).getByRole("radio", {
        name: "Bring it in as",
      }),
    );
    const groceries = await screen.findByRole("radiogroup", { name: 'Category "Groceries"' });
    fireEvent.click(within(groceries).getByRole("radio", { name: "Leave it out" }));
    fireEvent.click(
      within(screen.getByRole("radiogroup", { name: 'Category group "Home"' })).getByRole("radio", {
        name: "Use the one here",
      }),
    );
    expect(screen.queryByRole("radiogroup", { name: 'Category "Groceries"' })).toBeNull();
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.decisions).toEqual([
      { kind: "group", key: "Home", action: "use_existing" },
    ]);
  });
});

describe("a record the file only names", () => {
  const ledger = () =>
    factsOf({
      accounts: [ownAccount("Investments", "USD"), ownAccount("Euro savings", "EUR")],
    });

  it("is matched, created or left for review, matching only within its currency", async () => {
    const { adds } = stubServer({ facts: ledger() });
    renderImport();
    choose(chosenAccounts());
    await checked();
    const group = screen.getByRole("radiogroup", { name: 'Account "Brokerage" (USD)' });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["Use another here", "Create it", "Leave for review"]);
    fireEvent.click(within(group).getByRole("radio", { name: "Use another here" }));
    const pick = screen.getByRole("combobox", { name: 'Account here to use for "Brokerage"' });
    // The euro account is not offered: a match across currencies is refused.
    expect(
      within(pick)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Choose one", "Investments"]);
    expect(addButton()).toBeDisabled();
    // Nothing picked yet is asked by the picker's own "Choose one", not by the
    // record's question said a second time beside it.
    expect(group.parentElement!.querySelector(".ledger-import-problem")).toBeNull();
    const investments = ledger().here.ids.account["Investments"]!;
    fireEvent.change(pick, { target: { value: investments } });
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.decisions).toEqual([
      { kind: "account", key: "Brokerage", action: "match", id: investments },
    ]);
  });

  it("is created under its own name with no name sent, where its name is free", async () => {
    const { adds } = stubServer({ facts: ledger() });
    renderImport();
    choose(chosenAccounts());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Create it" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.decisions).toEqual([
      { kind: "account", key: "Brokerage", action: "create" },
    ]);
  });

  /**
   * The first part creates the account, and in a file cut by date it holds
   * none of the entries that name it. Only this page has the whole file, so
   * it sends the day with the decision; a file of one part needs nothing.
   */
  it("sends the whole file's opening day with it when the file is in parts", async () => {
    const { adds } = stubServer({ facts: ledger() });
    renderImport({ maxRows: 1, maxBytes: LEDGER_FILE_PART_MAX_BYTES });
    choose(chosenAccounts());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Create it" }));
    fireEvent.click(addButton());
    await screen.findByText(/^Added /);
    expect(adds).toHaveLength(2);
    for (const { body } of adds) {
      expect(body.decisions).toEqual([
        { kind: "account", key: "Brokerage", action: "create", openingDate: "2026-03-03" },
      ]);
    }
  });

  it("asks for a name to create it under where an account of its name is here in another currency", async () => {
    const { adds } = stubServer({
      facts: factsOf({ accounts: [ownAccount("Brokerage", "EUR")] }),
    });
    renderImport();
    choose(chosenAccounts());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Create it" }));
    const name = screen.getByRole("textbox", { name: 'Name to create "Brokerage" under' });
    expect(name).toHaveValue("Brokerage (2)");
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.decisions).toEqual([
      { kind: "account", key: "Brokerage", action: "create", name: "Brokerage (2)" },
    ]);
  });
});

describe("places on a plan that limits them", () => {
  const limited = () =>
    factsOf({ accounts: [ownAccount("House account"), ownAccount("Wallet")] }, { limit: 3 });

  it("lists the accounts that would take a place, checks none, and says the numbers", async () => {
    const { adds } = stubServer({ facts: limited() });
    renderImport();
    choose(wholeLedger());
    await checked();
    const group = screen.getByRole("group", { name: "Accounts to arrive archived" });
    const boxes = within(group).getAllByRole("checkbox");
    // Old card was archived where it came from and arrives archived anyway,
    // so it is not offered and costs nothing.
    expect(boxes.map((box) => box.closest("label")!.textContent)).toEqual([
      "Checking EUR",
      "Brokerage USD",
    ]);
    expect(boxes.filter((box) => (box as HTMLInputElement).checked)).toEqual([]);
    expect(group).toHaveTextContent(
      "Your plan keeps 3 accounts in use, and 2 are in use here. This file brings 2 more, so choose at least 1 to arrive archived, or upgrade under Settings. 0 chosen so far.",
    );
    expect(addButton()).toBeDisabled();
    fireEvent.click(within(group).getByRole("checkbox", { name: "Brokerage USD" }));
    expect(group).toHaveTextContent("1 chosen so far.");
    expect(addButton()).toBeEnabled();
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.arriveArchived).toEqual(["Brokerage"]);
  });

  it("is offered where nothing limits them too, so a person can do what an agent can", async () => {
    stubServer({ facts: factsOf() });
    renderImport();
    choose(wholeLedger());
    await checked();
    const group = screen.getByRole("group", { name: "Accounts to arrive archived" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(2);
    expect(group).not.toHaveTextContent("Your plan keeps");
    // No plan keeps a number of places here, so none is spoken of.
    expect(group).not.toHaveTextContent("place");
    expect(group).toHaveAccessibleDescription(
      "An account that arrives archived is put away as it arrives. Its transactions still go to Staged, and wait there until you restore it.",
    );
  });
});

describe("settings", () => {
  it("are asked about, with nothing chosen, where this copy chose its own and the file's differ", async () => {
    const { adds } = stubServer({
      facts: factsOf(
        {},
        { preferences: { chosen: true, timezone: "UTC", defaultCurrency: "USD", theme: "light" } },
      ),
    });
    renderImport();
    choose(wholeLedger());
    await checked();
    const group = screen.getByRole("radiogroup", { name: "Regional defaults and appearance" });
    expect(group).toHaveAccessibleDescription(
      "This copy has its own, set in Settings or taken from this browser when it was first opened, and the file's differ.",
    );
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")!.textContent)).toEqual([
      "Use the file's: Europe/Berlin · EUR · Follow my system",
      "Keep this copy's: UTC · USD · Light",
    ]);
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toEqual([]);
    expect(addButton()).toBeDisabled();
    fireEvent.click(within(group).getByRole("radio", { name: /Keep this copy's/ }));
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.preferences).toBe("keep");
  });

  it("are taken from the file where this copy never chose, and the page says so", async () => {
    const { adds } = stubServer({ facts: factsOf() });
    renderImport();
    choose(wholeLedger());
    await checked();
    expect(
      screen.getByText(
        "This copy has not chosen its regional defaults and appearance, so it takes the file's: Europe/Berlin · EUR · Follow my system.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("radiogroup", { name: "Regional defaults and appearance" }),
    ).toBeNull();
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    // Nothing chosen is nothing sent: the server applies the file's where
    // this copy never chose, in the same transaction, and a choice made since
    // the preview wins.
    expect("preferences" in adds[0]!.raw).toBe(false);
  });
});

describe("adding", () => {
  it("sends one part with every field the route reads, asking to be told how it goes", async () => {
    const { adds } = stubServer({ facts: factsOf() });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.accept).toBe("text/event-stream");
    expect(adds[0]!.raw).toEqual({
      ledgerFile: partsOf(wholeLedger())[0],
      fileName: NAME,
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}-1$/),
      part: { index: 1, count: 1 },
      decisions: [],
      arriveArchived: [],
    });
  });

  it("draws a bar only from a real count, and ends on what it did, with focus", async () => {
    const stream = streamedResponse();
    let sent: LedgerFileAddInput | undefined;
    stubServer({
      facts: factsOf(),
      answer: (body) => {
        sent = body;
        return stream.response;
      },
    });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(addButton());
    await waitFor(() => expect(sent).toBeDefined());
    expect(screen.queryByRole("progressbar")).toBeNull();
    stream.push({ type: "progress", event: { phase: "staging", done: 120, total: 500 } });
    expect(await screen.findByRole("progressbar", { name: "120 of 500 staged" })).toBeVisible();
    stream.push({ type: "result", value: resultFor(sent!, factsOf(), new Set(), 2) });
    stream.close();
    const done = await screen.findByText(
      /^Added "simple-balance-2026-10-25\.json" to this ledger\./,
    );
    expect(done.closest('[role="status"]')).toHaveTextContent(
      'Added "simple-balance-2026-10-25.json" to this ledger. 7 rows went to Staged for review, and 2 of them need something from you before they can be committed.',
    );
    await waitFor(() => expect(document.activeElement).toBe(done.closest('[role="status"]')));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Accounts: 3 created, 0 already here, 0 left out.")).toBeVisible();
    expect(
      screen.getByText(
        '"Old card" arrived archived. Restore it from Accounts to commit its transactions.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        '"Old hobby" was archived where it came from and arrived in use, so the transactions filed under it can be committed. Archive it again once they are.',
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Review 7 staged rows" })).toHaveAttribute(
      "href",
      `/staged?importBatchId=${origin(5001)}&preset=all-time`,
    );
    expect(screen.getByRole("link", { name: "Open Accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
  });

  it("goes part by part, one key each from one attempt, saying which part it is on", async () => {
    let release: () => void = () => {};
    const facts = factsOf();
    const { adds } = stubServer({
      facts,
      answer: async (body, call) => {
        if (call === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Response.json(resultFor(body, facts));
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await checked();
    fireEvent.click(addButton());
    expect(await screen.findByText("Part 2 of 3")).toBeVisible();
    release();
    await screen.findByText(/^Added /);
    const parts = partsOf(wholeLedger(), SMALL);
    expect(adds.map(({ body }) => body.ledgerFile)).toEqual(parts);
    expect(adds.map(({ body }) => body.part)).toEqual([
      { index: 1, count: 3 },
      { index: 2, count: 3 },
      { index: 3, count: 3 },
    ]);
    const keys = adds.map(({ body }) => body.idempotencyKey);
    const attempt = keys[0]!.slice(0, -2);
    expect(keys).toEqual([`${attempt}-1`, `${attempt}-2`, `${attempt}-3`]);
    // Every part carries the same answers, because every part carries every
    // record.
    expect(
      new Set(adds.map(({ raw }) => JSON.stringify([raw.decisions, raw.arriveArchived]))).size,
    ).toBe(1);
    // One link per batch when there are several.
    expect(screen.getByRole("link", { name: /^Review part 1's / })).toBeVisible();
  });
});

describe("an add that stops", () => {
  const refusal = () =>
    new Response(
      JSON.stringify({
        error: {
          code: "CONFLICT",
          message: "This ledger changed while the file was being read. Check the file again.",
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );

  it("says where it stopped and what is in, and tries that part again with its own key", async () => {
    const facts = factsOf();
    let refused = false;
    const { adds } = stubServer({
      facts,
      answer: (body) => {
        if (body.part.index === 2 && !refused) {
          refused = true;
          return refusal();
        }
        return Response.json(resultFor(body, facts));
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await checked();
    addButton().focus();
    fireEvent.click(addButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This ledger changed while the file was being read. Check the file again. Nothing from part 2 was written. Part 1 of 3 is in.",
    );
    // The same button, renamed, and still where focus was.
    const retry = screen.getByRole("button", { name: "Try part 2 of 3 again" });
    expect(document.activeElement).toBe(retry);
    // Nothing can be changed under the same key.
    for (const box of within(
      screen.getByRole("group", { name: "Accounts to arrive archived" }),
    ).getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
    fireEvent.click(retry);
    await screen.findByText(/^Added /);
    expect(adds.map(({ body }) => body.part.index)).toEqual([1, 2, 2, 3]);
    expect(adds[2]!.body.idempotencyKey).toBe(adds[1]!.body.idempotencyKey);
    expect(adds[2]!.raw).toEqual(adds[1]!.raw);
  });

  it("claims nothing about a part whose answer never came", async () => {
    const stream = streamedResponse();
    stubServer({ facts: factsOf(), answer: () => stream.response });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(addButton());
    stream.push({ type: "progress", event: { phase: "staging", done: 60, total: 500 } });
    stream.close();
    const alert = await screen.findByRole("alert");
    // The page's own sentence: whether it finished is not known, and trying
    // again finds out. "Reload" would throw away the attempt the button resumes.
    expect(alert).toHaveTextContent(
      "The connection was lost before the file answered, so whether it was added is not known.",
    );
    expect(alert).not.toHaveTextContent("Reload");
    expect(alert).not.toHaveTextContent("Nothing was written");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("says a lost connection leaves the part's outcome unknown, in words of its own", async () => {
    const facts = factsOf();
    stubServer({
      facts,
      answer: (body) => {
        if (body.part.index === 2) throw new TypeError("Failed to fetch");
        return Response.json(resultFor(body, facts));
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await checked();
    fireEvent.click(addButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The connection was lost before part 2 of 3 answered, so whether it was added is not known. Part 1 of 3 is in.",
    );
    expect(alert).not.toHaveTextContent("Failed to fetch");
    expect(alert).not.toHaveTextContent("Nothing from part");
  });

  /**
   * Choosing the same file again after a stop is how a closed tab resumes,
   * and it keeps what was decided: a copy brought in under a name has to come
   * back under that name, or the rest of the file goes to a third account.
   */
  it("keeps the decisions when the same file is chosen again", async () => {
    const facts = factsOf({ accounts: [accountLike("Checking", { institution: "Another bank" })] });
    let refused = false;
    const { adds } = stubServer({
      facts,
      answer: (body) => {
        if (body.part.index === 2 && !refused) {
          refused = true;
          return refusal();
        }
        return Response.json(resultFor(body, facts));
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Bring it in as" }));
    fireEvent.change(screen.getByRole("textbox", { name: 'New name for "Checking"' }), {
      target: { value: "Checking at the old bank" },
    });
    fireEvent.click(addButton());
    await screen.findByRole("alert");
    choose(wholeLedger());
    await checked();
    expect(screen.getByRole("radio", { name: "Bring it in as" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: 'New name for "Checking"' })).toHaveValue(
      "Checking at the old bank",
    );
    fireEvent.click(addButton());
    await screen.findByText(/^Added /);
    expect(adds.at(-1)!.body.decisions).toEqual([
      { kind: "account", key: "Checking", action: "rename", name: "Checking at the old bank" },
    ]);
  });

  it("starts from nothing when another file is chosen", async () => {
    stubServer({ facts: factsOf({ accounts: [accountLike("Checking", { institution: "X" })] }) });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Leave it out" }));
    const other = wholeLedger();
    other.exportedAt = "2026-10-26T08:00:00.000Z";
    choose(other, "another.json");
    await screen.findByRole("button", { name: /Add to this ledger/ });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Leave it out" })).not.toBeChecked(),
    );
  });

  it("starts a new attempt from a fresh check, which is how an add resumes", async () => {
    const facts = factsOf();
    let refused = false;
    const { adds, previews } = stubServer({
      facts,
      answer: (body) => {
        if (body.part.index === 2 && !refused) {
          refused = true;
          return refusal();
        }
        return Response.json(resultFor(body, facts));
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await checked();
    fireEvent.click(addButton());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Check the file again" }));
    await waitFor(() => expect(previews).toHaveLength(6));
    const again = await screen.findByRole("button", { name: "Add to this ledger" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(again);
    await screen.findByText(/^Added /);
    const keys = adds.map(({ body }) => body.idempotencyKey.slice(0, -2));
    expect(keys[2]).not.toBe(keys[0]);
    expect(adds.slice(2).map(({ body }) => body.part.index)).toEqual([1, 2, 3]);
  });
});

describe("budget amounts already here", () => {
  /** The file's Groceries, used here, with a different amount for one of its months. */
  const here = (extra: Record<string, unknown>[] = []) => {
    const file = parsedLedger(wholeLedger());
    return {
      facts: factsOf({
        groups: file.groups,
        categories: file.categories,
        budgets: {
          plans: [],
          entries: [{ ...file.budgets.entries[0]!, amount: "999" }],
        },
      }),
      json: () => {
        const json = wholeLedger();
        const budgets = json.budgets as { entries: Record<string, unknown>[] };
        budgets.entries = [...budgets.entries, ...extra];
        return json;
      },
    };
  };

  it("are asked about as one answer to tick when nothing new would come", async () => {
    const { facts, json } = here();
    const { adds } = stubServer({ facts });
    renderImport();
    choose(json());
    await checked();
    // One answer to tick, named by the question and the answer together.
    expect(screen.queryByRole("radiogroup", { name: /^Budget amounts for Groceries/ })).toBeNull();
    const box = screen.getByRole("checkbox", {
      name: "Budget amounts for Groceries (EUR, by month) Leave it out",
    });
    expect(box).toHaveAccessibleDescription(/^"Groceries" already has different amounts here/);
    expect(box).not.toBeChecked();
    expect(addButton()).toBeDisabled();
    fireEvent.click(box);
    expect(addButton()).toBeEnabled();
    // And taken back, which a radio group of one could never be.
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    expect(addButton()).toBeDisabled();
    fireEvent.click(box);
    // Left out whole reads as left out, not as the periods it would have set.
    fireEvent.click(screen.getByRole("button", { name: /^Show all/ }));
    const row = screen.getByRole("rowheader", { name: "Groceries (EUR, by month)" }).closest("tr")!;
    expect(within(row).getAllByRole("cell")[0]).toHaveTextContent("Left out");
    fireEvent.click(addButton());
    await waitFor(() => expect(adds).toHaveLength(1));
    expect(adds[0]!.body.decisions).toContainEqual({
      kind: "budget_entry",
      key: "category:Groceries|EUR|month",
      action: "skip",
    });
  });

  it("offer keeping the ones here or leaving all out, in counts, when new ones would come", async () => {
    const { facts, json } = here([
      {
        category: "Groceries",
        currency: "EUR",
        periodUnit: "month",
        periodStart: "2026-04-01",
        amount: "480.00",
      },
    ]);
    stubServer({ facts });
    renderImport();
    choose(json());
    await checked();
    const group = screen.getByRole("radiogroup", {
      name: "Budget amounts for Groceries (EUR, by month)",
    });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["Keep the 1 here and add the 1 new", "Leave all 2 out"]);
  });
});

describe("a group the file only names", () => {
  it("is never left for review, because nothing staged names a group", async () => {
    const json = chosenAccounts();
    json.groups = [{ key: "Home", name: "Home", detail: "reference", policy: "standalone" }];
    json.categories = [
      { key: "Groceries", name: "Groceries", detail: "reference", kind: "expense", group: "Home" },
    ];
    json.scope = { ...(json.scope as Json), kinds: ["accounts", "entries"] };
    stubServer({ facts: factsOf({ accounts: [ownAccount("Brokerage", "USD")] }) });
    renderImport();
    choose(json);
    await checked();
    const group = screen.getByRole("radiogroup", { name: 'Category group "Home"' });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["Create it", "Leave it out"]);
    expect(group).toHaveAccessibleDescription(
      'This file names a category group "Home", which is not here. Left out, the categories in it come in without a group.',
    );
  });
});

describe("keyboard and names", () => {
  it("puts every radio in one named group of its own", async () => {
    stubServer({
      facts: factsOf(
        { accounts: [accountLike("Checking", { institution: "Another bank" })] },
        { preferences: { chosen: true, timezone: "UTC", defaultCurrency: "USD", theme: "light" } },
      ),
    });
    const { container } = renderImport();
    choose(wholeLedger());
    await checked();
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.length).toBeGreaterThan(3);
    const byName = new Map<string, Set<Element>>();
    for (const radio of radios) {
      const group = radio.closest('[role="radiogroup"]');
      expect(group, radio.outerHTML).not.toBeNull();
      expect(group).toHaveAccessibleName();
      byName.set(radio.name, new Set([...(byName.get(radio.name) ?? []), group!]));
    }
    for (const groups of byName.values()) expect(groups.size).toBe(1);
    expect(byName.size).toBe(screen.getAllByRole("radiogroup").length);
  });

  it("is one form whose submit is the add, so Enter in a name field adds", async () => {
    const { adds } = stubServer({
      facts: factsOf({ accounts: [accountLike("Checking", { institution: "Another bank" })] }),
    });
    renderImport();
    choose(wholeLedger());
    await checked();
    fireEvent.click(screen.getByRole("radio", { name: "Bring it in as" }));
    const name = screen.getByRole("textbox", { name: 'New name for "Checking"' });
    const form = name.closest("form")!;
    expect(addButton().closest("form")).toBe(form);
    expect(addButton()).toHaveAttribute("type", "submit");
    expect(screen.getByRole("button", { name: /Check the file again/ })).toHaveAttribute(
      "type",
      "button",
    );
    fireEvent.submit(form);
    await waitFor(() => expect(adds).toHaveLength(1));
  });
});

describe("the staged queue's batch filter", () => {
  it("says which batches came from a Simple Balance file", async () => {
    const batches: ImportBatchSummary[] = [
      {
        id: origin(1),
        fileName: "march.csv",
        rowCount: 3,
        stagedCount: 3,
        createdAt: "2026-10-25T10:00:00.000Z",
      },
      {
        id: origin(2),
        fileName: "simple-balance-2026-10-25.json",
        rowCount: 7,
        stagedCount: 7,
        createdAt: "2026-10-25T11:00:00.000Z",
        kind: "ledger_file",
      },
    ];
    const empty: PaginatedPage<StagedTransaction> = {
      items: [],
      nextCursor: null,
      page: 1,
      pageSize: 50,
      totalCount: 0,
      cursorAvailable: false,
      totalPages: 1,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/v1/staged-transactions") return Response.json(empty);
        if (url.pathname === "/api/v1/import-batches") {
          return Response.json({ items: batches, nextCursor: null });
        }
        if (url.pathname === "/api/v1/payees/suggestions") return Response.json([]);
        return Response.json([]);
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <StagingPage />
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("option", {
        name: /^simple-balance-2026-10-25\.json \(Simple Balance file\) · .+ · 7 of 7 rows staged$/,
      }),
    ).toBeInTheDocument();
    // A batch with no kind, from a server older than the file import, is a CSV.
    expect(
      screen.getByRole("option", { name: /^march\.csv · .+ · 3 of 3 rows staged$/ }),
    ).toBeInTheDocument();
  });
});
