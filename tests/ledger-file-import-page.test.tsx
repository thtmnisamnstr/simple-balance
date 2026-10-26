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
  LEDGER_FILE_MOVE_BLOCKED,
  ledgerFileAddInputSchema,
  ledgerFilePreviewInputSchema,
  ledgerFilePreviewSchema,
  type LedgerFileAddInput,
  type LedgerFileFacts,
} from "../src/shared/ledger-file-import.js";
import {
  ledgerBalanceRefusal,
  ledgerFileMoveInputSchema,
  ledgerMoveEntryRefusal,
} from "../src/shared/ledger-file-move.js";
import { chosenAccounts, origin, wholeLedger } from "./support/ledger-file.js";
import {
  accountLike,
  factsOf,
  ownAccount,
  parsedLedger,
  resultFor,
  unchecked,
} from "./support/ledger-file-facts.js";
import {
  movePreviewFor,
  moveResultFor,
  qualifying,
  typedInto,
} from "./support/ledger-file-move-facts.js";
import { encodeProgressFrame, type ProgressFrame } from "../src/shared/progress.js";
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
 * The three routes, answered the way the server answers them.
 *
 * `here` is the set of origins this ledger already holds, which is what the
 * preview's row counts are read from, and `waiting` the ones it holds only as
 * rows still in Staged. `answer` decides each add by call and `answerMove`
 * each move; left out, every part succeeds with the plan it carried out.
 */
function stubServer({
  facts,
  here = new Set<string>(),
  waiting,
  answer,
  answerMove,
  hold,
}: {
  facts: LedgerFileFacts;
  here?: ReadonlySet<string>;
  waiting?: ReadonlySet<string>;
  answer?: (body: LedgerFileAddInput, call: number) => Response | Promise<Response>;
  answerMove?: (body: LedgerFileAddInput, call: number) => Response | Promise<Response>;
  hold?: (call: number) => Promise<void> | undefined;
}) {
  const previews: string[] = [];
  const adds: Sent[] = [];
  const moves: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/ledger-file:preview") {
        const { ledgerFile } = ledgerFilePreviewInputSchema.parse(JSON.parse(String(init?.body)));
        previews.push(ledgerFile);
        await hold?.(previews.length);
        return Response.json(
          ledgerFilePreviewSchema.parse(movePreviewFor(ledgerFile, facts, here, waiting)),
        );
      }
      if (url.pathname === "/api/v1/ledger-file:add") {
        const raw = JSON.parse(String(init?.body)) as Json;
        // The route's own parser: a body it would refuse fails the test here.
        const body = ledgerFileAddInputSchema.parse(raw);
        adds.push({ body, raw, accept: new Headers(init?.headers).get("Accept") });
        if (answer) return answer(body, adds.length);
        return Response.json(resultFor(body, facts, here));
      }
      if (url.pathname === "/api/v1/ledger-file:move") {
        const raw = JSON.parse(String(init?.body)) as Json;
        // The move route's own parser, for the reason the add's is above.
        const body = ledgerFileMoveInputSchema.parse(raw);
        moves.push({ body, raw, accept: new Headers(init?.headers).get("Accept") });
        if (answerMove) return answerMove(body, moves.length);
        return Response.json(moveResultFor(body, facts, here));
      }
      if (url.pathname === "/api/v1/accounts") return Response.json([]);
      if (url.pathname === "/api/v1/categories") return Response.json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return { previews, adds, moves };
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

  it("agrees with one account in use", async () => {
    const json = wholeLedger();
    const accounts = json.accounts as Json[];
    accounts.push({
      ...accounts[0],
      key: "Savings",
      name: "Savings",
      openingBalance: "0",
      balance: "0",
    });
    stubServer({ facts: factsOf({ accounts: [ownAccount("Wallet")] }, { limit: 3 }) });
    renderImport();
    choose(json);
    await checked();
    expect(screen.getByRole("group", { name: "Accounts to arrive archived" })).toHaveTextContent(
      "Your plan keeps 3 accounts in use, and 1 is in use here. This file brings 3 more, so choose at least 1 to arrive archived, or upgrade under Settings. 0 chosen so far.",
    );
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

/**
 * Moving a file straight into the books, which the page offers only where the
 * preview says this ledger may take one, and never chooses for anybody.
 *
 * What is held is the page's half: the way in is a named choice with neither
 * picked, the refusal is the server's own sentence bound to the refused radio,
 * a switch lets go of answers the new way does not take, the move says what it
 * writes and what it will be held to before anything is pressed, it goes part
 * by part to its own route with one key per part and a bar from real counts,
 * a resumed move sends only the parts not in yet and always the last, and the
 * end says what came in, what was checked, and what counts differently here.
 */
describe("moving a file", () => {
  const modes = () => screen.getByRole("radiogroup", { name: "How should this file come in?" });
  const moveRadio = () => screen.getByRole("radio", { name: "Move it into this ledger" });
  const addRadio = () => screen.getByRole("radio", { name: "Add it to this ledger" });
  const moveButton = () =>
    screen.getByRole("button", { name: /Move into this ledger|Try .*again/ });
  const ready = () => screen.findByRole("button", { name: "Import this file" });
  /** A reply in frames, whole, the way the route streams one when asked. */
  const framed = (frames: readonly ProgressFrame[]) =>
    new Response(frames.map(encodeProgressFrame).join(""), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

  it("offers both ways in where the ledger may take a move, and chooses neither", async () => {
    const { moves, adds } = stubServer({ facts: qualifying(factsOf()) });
    renderImport();
    choose(wholeLedger());
    const button = await ready();
    expect(modes()).toHaveAccessibleDescription(
      "A move brings what adding cannot: deleted transactions, accounts archived on the day they were, and no transaction left to review. It is offered only while everything in this ledger came from a Simple Balance file, as in a new one; once a transaction is typed in or imported from a CSV, a file can only be added.",
    );
    expect(within(modes()).getAllByRole("radio")).toEqual([moveRadio(), addRadio()]);
    expect(moveRadio()).toHaveAccessibleDescription(
      "Every transaction goes straight into the books, deleted ones and archived accounts as they were, and every balance is checked against the file.",
    );
    expect(addRadio()).toHaveAccessibleDescription(
      "New records come in at once, and its transactions go to Staged for review.",
    );
    for (const radio of [moveRadio(), addRadio()]) {
      expect(radio).toBeEnabled();
      expect(radio).not.toBeChecked();
    }
    // Nothing planned under a guess: no counts, no questions, no button to press.
    expect(screen.queryByRole("table")).toBeNull();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Choose how the file comes in.");

    fireEvent.click(moveRadio());
    expect(moveButton()).toBeEnabled();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Ready to move: 14 new records, 5 transactions straight into the books and 2 rows for Staged.",
    );
    fireEvent.click(addRadio());
    expect(screen.getByRole("button", { name: "Add to this ledger" })).toBeEnabled();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Ready to add: 14 new records and 7 rows for Staged.",
    );
    expect(moves).toEqual([]);
    expect(adds).toEqual([]);
  });

  it("refuses a move in the server's own sentence where the ledger holds entries of its own", async () => {
    stubServer({ facts: typedInto(factsOf()) });
    renderImport();
    choose(wholeLedger());
    await checked();
    expect(moveRadio()).toBeDisabled();
    expect(moveRadio()).toHaveAccessibleDescription(LEDGER_FILE_MOVE_BLOCKED);
    expect(screen.getByText(LEDGER_FILE_MOVE_BLOCKED)).toBeVisible();
    // Adding is the one way in, so it is the one chosen, and planned.
    expect(addRadio()).toBeChecked();
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "Ready to add: 14 new records and 7 rows for Staged.",
    );
  });

  it("says what a move writes, and what it is held to, before anything is pressed", async () => {
    stubServer({ facts: qualifying(factsOf()) });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    for (const sentence of [
      "5 transactions go straight into the books, with nothing to review.",
      "1 deleted transaction comes too, deleted as it was where the file came from, so it changes no balance.",
      "2 staged rows from the file wait in Staged again.",
      // The refund filed under Groceries before it was widened to take both.
      '1 deposit filed under "Groceries", €12.99, will count as income here, where it was a refund of spending.',
      "Account balances are the same either way, and only the income and spending totals move: here each side is decided by the categories as they are now.",
      "The balances of 2 accounts are checked against the file as the move ends, and nothing is written if one comes out different.",
      '"Old card" is not checked: archived where the file came from, it holds nothing there to check against.',
    ]) {
      expect(screen.getByText(sentence)).toBeVisible();
    }
    // What only adding says is not said of a move.
    expect(screen.queryByText(/go to Staged for review, with both sides/)).toBeNull();
    expect(screen.queryByText(/is not added, because a row in Staged/)).toBeNull();
    // A record's own sentence is the move's.
    expect(screen.getByText('Category "Old hobby"').closest("li")).toHaveTextContent(
      "It was archived where it came from, and arrives archived, with the transactions filed under it.",
    );
  });

  it("says each group of transactions that counts on the other side here, in its own currency", async () => {
    // A second refund, in dollars, into the same widened category: its own
    // sentence, and said of what will happen like the first.
    const json = wholeLedger();
    (json.entries as Json[]).push({
      id: origin(7),
      type: "deposit",
      date: "2026-10-06",
      to: "Brokerage",
      amount: "3.00",
      payee: "Store",
      category: "Groceries",
      postedAs: "expense",
    });
    (json.entries as Json[]).push({
      id: origin(8),
      type: "withdrawal",
      date: "2026-10-07",
      from: "Checking",
      amount: "7.00",
      payee: "Store",
      category: "Groceries",
      postedAs: "income",
    });
    stubServer({ facts: qualifying(factsOf()) });
    renderImport();
    choose(json);
    await ready();
    fireEvent.click(moveRadio());
    for (const sentence of [
      '1 deposit filed under "Groceries", €12.99, will count as income here, where it was a refund of spending.',
      '1 deposit filed under "Groceries", $3.00, will count as income here, where it was a refund of spending.',
      // A withdrawal on the other side is its own sentence in its own words:
      // income coming back there, spending here, and never summed with a
      // deposit, which moves the totals the other way.
      '1 withdrawal filed under "Groceries", €7.00, will count as spending here, where it was income coming back.',
    ]) {
      expect(screen.getByText(sentence)).toBeVisible();
    }
  });

  it("lets go of an answer the new way in does not take", async () => {
    stubServer({
      facts: qualifying(
        factsOf({ accounts: [accountLike("Checking", { institution: "Another bank" })] }),
      ),
    });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(addRadio());
    const checking = () => screen.getByRole("radiogroup", { name: 'Account "Checking" (EUR)' });
    fireEvent.click(within(checking()).getByRole("radio", { name: "Leave it out" }));
    fireEvent.click(moveRadio());
    // The file's transactions are written to it, so a move cannot leave it out.
    expect(
      within(checking())
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")!.textContent),
    ).toEqual(["Use the one here", "Bring it in as"]);
    expect(checking()).toHaveAccessibleDescription(
      // Six, the deleted one too: it is written before it is deleted again.
      /6 of this file's transactions name it, and a move writes each one straight into the books, so it has to come in\.$/,
    );
    expect(moveButton()).toBeDisabled();
    expect(moveButton()).toHaveAccessibleDescription("1 question is still open above.");
    // And back: the answer is gone, not brought back unasked.
    fireEvent.click(addRadio());
    expect(within(checking()).getByRole("radio", { name: "Leave it out" })).not.toBeChecked();
    expect(
      within(checking())
        .getAllByRole("radio")
        .filter((radio) => (radio as HTMLInputElement).checked),
    ).toEqual([]);
  });

  it("moves part by part to its own route, one key each, with a bar from real counts", async () => {
    let sent: LedgerFileAddInput | undefined;
    const stream = streamedResponse();
    const facts = qualifying(factsOf());
    const { moves, adds } = stubServer({
      facts,
      answerMove: (body, call) => {
        if (call !== 2) return Response.json(moveResultFor(body, facts));
        sent = body;
        return stream.response;
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(moveButton());
    expect(await screen.findByText("Part 2 of 3")).toBeVisible();
    await waitFor(() => expect(sent).toBeDefined());
    expect(screen.queryByRole("progressbar")).toBeNull();
    stream.push({ type: "progress", event: { phase: "posting", done: 60, total: 100 } });
    // Written, not committed: nothing a move writes was ever staged.
    expect(await screen.findByRole("progressbar", { name: "60 of 100 written" })).toHaveValue(0.6);
    stream.push({ type: "result", value: moveResultFor(sent!, facts) });
    stream.close();

    const done = await screen.findByText(
      /^Moved "simple-balance-2026-10-25\.json" into this ledger\./,
    );
    const alert = done.closest('[role="status"]')!;
    expect(alert).toHaveTextContent(
      'Moved "simple-balance-2026-10-25.json" into this ledger. 5 transactions went straight into the books, and 1 deleted transaction came in deleted, as it was where the file came from.',
    );
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(adds).toEqual([]);
    const parts = partsOf(wholeLedger(), SMALL);
    expect(moves.map(({ body }) => body.ledgerFile)).toEqual(parts);
    expect(moves.map(({ accept }) => accept)).toEqual(Array(3).fill("text/event-stream"));
    const keys = moves.map(({ body }) => body.idempotencyKey);
    const attempt = keys[0]!.slice(0, -2);
    expect(keys).toEqual([`${attempt}-1`, `${attempt}-2`, `${attempt}-3`]);
    expect(moves[0]!.raw).toEqual({
      ledgerFile: parts[0],
      fileName: NAME,
      idempotencyKey: `${attempt}-1`,
      part: { index: 1, count: 3 },
      decisions: [],
      arriveArchived: [],
    });
    for (const sentence of [
      "Every balance came out as the file says: 2 accounts checked. 1 account archived where the file came from was not compared, holding nothing there to compare with.",
      "Accounts: 3 created, 0 already here, 0 left out.",
      '1 archived account holds its transactions: "Old card". Restoring it posts its balance back.',
      "2 staged rows from the file went to Staged.",
      // Said of what happened now, rather than of what will.
      '1 deposit filed under "Groceries", €12.99, counts as income here, where it was a refund of spending.',
    ]) {
      expect(screen.getByText(sentence)).toBeVisible();
    }
    expect(screen.getByRole("link", { name: "Review 2 staged rows" })).toHaveAttribute(
      "href",
      `/staged?importBatchId=${origin(5003)}&preset=all-time`,
    );
  });

  it("asks which accounts arrive archived where places run short, and waits until enough are", async () => {
    const facts = qualifying(
      factsOf({ accounts: [ownAccount("House account"), ownAccount("Wallet")] }, { limit: 3 }),
    );
    const { moves } = stubServer({ facts });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    const group = screen.getByRole("group", { name: "Accounts to arrive archived" });
    expect(group).toHaveAccessibleDescription(
      "An account that arrives archived uses no place. Its transactions are written into it, and it holds nothing from the day of the move; restoring it posts its balance back.",
    );
    expect(
      within(group)
        .getAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked),
    ).toEqual([]);
    expect(moveButton()).toBeDisabled();
    fireEvent.click(within(group).getByRole("checkbox", { name: "Brokerage USD" }));
    expect(moveButton()).toBeEnabled();
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(moves[0]!.body.arriveArchived).toEqual(["Brokerage"]);
    expect(
      screen.getByText(
        '2 archived accounts hold their transactions: "Brokerage" and "Old card". Restoring one posts its balance back.',
      ),
    ).toBeVisible();
  });

  it("stops where the balances do not come out, says each in its own figures, and waits on a fresh check", async () => {
    const facts = qualifying(factsOf());
    const refusal = ledgerBalanceRefusal(
      [
        {
          field: "accounts.0.balance",
          key: "Checking",
          name: "Checking",
          currency: "EUR",
          expected: "1301.11",
          actual: "1311.11",
          difference: "10",
        },
        {
          field: "accounts.1.balance",
          key: "Brokerage",
          name: "Brokerage",
          currency: "USD",
          expected: "1081.4",
          actual: "81.4",
          difference: "-1000",
        },
      ],
      "2026-10-25",
      { part: { index: 3, count: 3 }, startsOn: null },
    );
    let refused = false;
    const { moves } = stubServer({
      facts,
      answerMove: (body) => {
        if (body.part.index === 3 && !refused) {
          refused = true;
          return framed([
            { type: "progress", event: { phase: "staging", done: 2, total: 2 } },
            {
              type: "error",
              error: {
                error: { code: "CONFLICT", message: refusal.message, details: refusal.details },
              },
            },
          ]);
        }
        return Response.json(moveResultFor(body, facts));
      },
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    moveButton().focus();
    fireEvent.click(moveButton());
    const alert = await screen.findByRole("alert");
    // Written again in this page's figures from the details, by the function
    // the server wrote it with: money as money, the day as a day, and what
    // to do about it rather than a part the page could not have left out.
    expect(alert).toHaveTextContent(
      'After this part, "Checking" would hold €1,311.11 on Oct 25, 2026, and the file says €1,301.11: €10.00 more than the file. 2 accounts disagree in all. Nothing in this part was written. If "Checking" here held transactions that are not in this file, rename it under Accounts and check the file again, so the file\'s comes in as a new account, or add the file instead, which sends its transactions to Staged. If it holds some of this file\'s transactions as an earlier copy of the file had them, a move passes over those rather than changing them, and they can only be put right by hand. Parts 1 to 2 of 3 are in.',
    );
    expect(alert.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(alert.textContent).not.toContain("earlier part");
    // Said once: the refusal already says nothing in the part was written.
    expect(alert.textContent!.match(/Nothing/g)).toHaveLength(1);
    expect(
      within(alert)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      '"Checking" would hold €1,311.11, and the file says €1,301.11.',
      '"Brokerage" would hold $81.40, and the file says $1,081.40.',
    ]);
    // The same request would meet the same balances, so trying again waits on
    // a fresh check, says so beside itself, and the sentence takes the focus
    // the button lets go of as it is disabled.
    const retry = screen.getByRole("button", { name: "Try part 3 of 3 again" });
    expect(retry).toBeDisabled();
    expect(retry).toHaveAccessibleDescription(
      "Trying again would meet the same balances, so check the file again first.",
    );
    await waitFor(() => expect(document.activeElement).toBe(alert));
    fireEvent.submit(retry.closest("form")!);
    expect(moves).toHaveLength(3);
    expect(moveRadio()).toBeDisabled();
    // Checked again, it is a new attempt with keys of its own.
    fireEvent.click(screen.getByRole("button", { name: "Check the file again" }));
    await waitFor(() => expect(moveButton()).toBeEnabled());
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(moves.map(({ body }) => body.part.index)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(moves[5]!.body.idempotencyKey).not.toBe(moves[2]!.body.idempotencyKey);
  });

  it("asks for another name before using an account here that holds transactions from elsewhere", async () => {
    // The same as the file's in every field, and holding four transactions
    // another file brought: the whole file can see it, so the page asks before
    // the first part is sent, rather than the last part meeting it after.
    const here = factsOf({ accounts: [accountLike("Checking", {})] });
    const { moves } = stubServer({
      facts: qualifying({
        ...here,
        rows: { ...here.rows, heldHere: { Checking: { entries: 4, fromFile: 0 } } },
      }),
    });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    expect(
      screen.getAllByText(
        "\"Checking\" here already holds 4 transactions that are not in this file, so the file's cannot be written into it and still come out at the file's balance.",
        { exact: false },
      )[0],
    ).toBeVisible();
    expect(moveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Bring it in as$/ }));
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(moves[0]!.body.decisions).toEqual([
      { kind: "account", key: "Checking", action: "rename", name: "Checking (2)" },
    ]);
  });

  it("sums up a deposit and a withdrawal that moved to the same side as two sentences", async () => {
    // Groceries takes only income here: the refund of spending counts as
    // income, and the withdrawal under it as income coming back. Each moves
    // the totals its own way, so the summary never adds them into one figure.
    const json = wholeLedger();
    json.entries = (json.entries as Json[]).filter((entry) => entry.id !== origin(3));
    const file = parsedLedger(json);
    const groceries = file.categories.find((category) => category.key === "Groceries")!;
    stubServer({ facts: qualifying(factsOf({ categories: [{ ...groceries, kind: "income" }] })) });
    renderImport();
    choose(json);
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(
      within(await screen.findByRole("radiogroup", { name: 'Category "Groceries"' })).getByRole(
        "radio",
        { name: "Use the one here" },
      ),
    );
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    for (const sentence of [
      '1 withdrawal filed under "Groceries", €54.23, counts as income coming back here, where it was spending.',
      '1 deposit filed under "Groceries", €12.99, counts as income here, where it was a refund of spending.',
    ]) {
      expect(screen.getByText(sentence)).toBeVisible();
    }
  });

  it("names a transaction the plan refuses in this page's figures", async () => {
    // Groceries takes only income here, so the split filed under it and
    // Household would be income and spending at once once the one here is used.
    const file = parsedLedger(wholeLedger());
    const groceries = file.categories.find((category) => category.key === "Groceries")!;
    stubServer({ facts: qualifying(factsOf({ categories: [{ ...groceries, kind: "income" }] })) });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(
      within(await screen.findByRole("radiogroup", { name: 'Category "Groceries"' })).getByRole(
        "radio",
        { name: "Use the one here" },
      ),
    );
    const open = screen.getByRole("heading", { name: "Still to decide" }).parentElement!;
    expect(open).toHaveTextContent(
      "The withdrawal of €80.00 dated Oct 4, 2026 with Market would be both income and spending here",
    );
    expect(open.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("writes a refused transaction's money and day in this page's figures", async () => {
    const facts = qualifying(factsOf());
    const entry = parsedLedger(wholeLedger()).entries.find((each) => each.id === origin(1))!;
    stubServer({
      facts,
      answerMove: () =>
        framed([
          {
            type: "error",
            error: {
              error: {
                code: "VALIDATION_ERROR",
                message: ledgerMoveEntryRefusal(entry, "Something here refuses it."),
                details: {
                  origin: entry.id,
                  date: entry.date,
                  payee: entry.payee,
                  amount: "54.23",
                },
              },
            },
          },
        ]),
    });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(moveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The withdrawal of €54.23 dated Oct 2, 2026 with Rewe could not be written: Something here refuses it. Nothing in this part was written.",
    );
  });

  it("claims nothing about a part whose answer never came", async () => {
    stubServer({
      facts: qualifying(factsOf()),
      answerMove: () =>
        framed([{ type: "progress", event: { phase: "posting", done: 3, total: 6 } }]),
    });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(moveButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The connection was lost before the file answered, so whether it was moved is not known.",
    );
    expect(alert).not.toHaveTextContent("Nothing");
  });

  /**
   * Resuming is a fresh check, and a part the check finds in already — every
   * transaction, deleted one and staged row in it here by origin — is not sent
   * again. The last part always is: it carries the balances and creates the
   * recurring transactions, and both happen nowhere else.
   */
  /**
   * A ledger part-way through a move of the whole ledger: the accounts its
   * earlier parts made, which the transactions already here are on. Without
   * them, transactions here and the accounts about to be made new are the
   * shape a move refuses, because the new accounts would never hold them.
   */
  const resumedFacts = () =>
    qualifying(
      factsOf({
        accounts: ["Checking", "Brokerage", "Old card"].map((key) => accountLike(key, {})),
      }),
    );

  it("sends only the parts not in yet when resumed, and always the last", async () => {
    // Parts of three rows, by date: origins 5, 6 and 1, then 2, 3 and 4, then
    // the budget amount and the two staged rows.
    const firstPart = new Set([origin(5), origin(6), origin(1)]);
    const facts = resumedFacts();
    const { moves } = stubServer({ facts, here: firstPart });
    renderImport(SMALL);
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    expect(
      screen.getByText("3 transactions are already in this ledger, so they are skipped."),
    ).toBeVisible();
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(moves.map(({ body }) => body.part)).toEqual([
      { index: 2, count: 3 },
      { index: 3, count: 3 },
    ]);
    expect(screen.getByText("Part 1 of 3 was in already, so it was not sent again.")).toBeVisible();
    expect(
      screen.getByText("3 transactions were already in this ledger, so they were skipped."),
    ).toBeVisible();
  });

  it("sends a part again while a deleted transaction in it is not here yet", async () => {
    // Part 1's two live transactions are here and its deleted one is not: the
    // part still has a transaction to write and delete again.
    const { moves } = stubServer({
      facts: resumedFacts(),
      here: new Set([origin(6), origin(1)]),
    });
    renderImport(SMALL);
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(moves.map(({ body }) => body.part.index)).toEqual([1, 2, 3]);
  });

  it("names an account archived here that the move wrote into, as a resumed move finds one", async () => {
    // Old card, brought in archived by an earlier attempt: the same here in
    // every field, so used, and still holding its transactions.
    stubServer({ facts: qualifying(factsOf({ accounts: [accountLike("Old card", {})] })) });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(
      screen.getByText(
        '1 archived account holds its transactions: "Old card". Restoring it posts its balance back.',
      ),
    ).toBeVisible();
  });

  it("sends the last part even when every row in it is here, because the balances travel in it", async () => {
    // No budget amounts and no staged rows, so the last part is entries alone,
    // every one of them here, in the accounts the earlier attempt made.
    const json = wholeLedger();
    (json.budgets as { entries: unknown[] }).entries = [];
    json.staged = [];
    const every = new Set(parsedLedger(json).entries.map((entry) => entry.id));
    const { moves } = stubServer({ facts: resumedFacts(), here: every });
    renderImport(SMALL);
    choose(json);
    await ready();
    fireEvent.click(moveRadio());
    fireEvent.click(moveButton());
    await screen.findByText(/^Moved /);
    expect(moves.map(({ body }) => body.part)).toEqual([{ index: 2, count: 2 }]);
  });

  it("is refused before anything is sent while the file's transactions wait in Staged", async () => {
    const { moves } = stubServer({
      facts: qualifying(factsOf()),
      waiting: new Set([origin(1), origin(2)]),
    });
    renderImport();
    choose(wholeLedger());
    await ready();
    fireEvent.click(moveRadio());
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
      "This file cannot be moved into this ledger until what is listed under Still to decide is settled.",
    );
    const open = screen.getByRole("heading", { name: "Still to decide" }).parentElement!;
    expect(open).toHaveTextContent(
      "2 of this file's transactions are waiting in Staged from an earlier import of it. Commit or discard them there first: a move writes each transaction straight into the books, once.",
    );
    expect(moveButton()).toBeDisabled();
    expect(moveButton()).toHaveAccessibleDescription(
      "What is listed under Still to decide has to be settled first.",
    );
    // Adding is still open, and would skip the two as already here.
    fireEvent.click(addRadio());
    expect(screen.getByRole("button", { name: "Add to this ledger" })).toBeEnabled();
    expect(moves).toEqual([]);
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
