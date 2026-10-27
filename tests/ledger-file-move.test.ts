import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";
import { parseLedgerFile, type LedgerFile } from "../src/shared/ledger-file.js";
import {
  LEDGER_FILE_MOVE_BLOCKED,
  ledgerEntryLabel,
  ledgerFileFactsSchema,
  ledgerFileMoveStagedBlocked,
  ledgerFilePlanSchema,
  ledgerFilePreviewSchema,
  mergeLedgerFileFacts,
  planLedgerFileAdd,
  type LedgerFileDecision,
  type LedgerFileFacts,
  type LedgerFilePlan,
  type LedgerFilePlannedRecord,
  type LedgerRefResolver,
} from "../src/shared/ledger-file-import.js";
import {
  ledgerBalanceIssue,
  ledgerBalanceMismatches,
  ledgerBalanceRefusal,
  ledgerBalanceRefusalOf,
  ledgerFileMoveInputSchema,
  ledgerFileMoveResultSchema,
  ledgerMoveEntryDraft,
  ledgerMoveEntryRefusal,
  planLedgerFileMove,
} from "../src/shared/ledger-file-move.js";
import { chosenAccounts, origin, wholeLedger } from "./support/ledger-file.js";
import { unchecked } from "./support/ledger-file-facts.js";

/**
 * Moving a Simple Balance file straight into the books, as the plan both ends
 * run decides it.
 *
 * A move is an add's plan narrowed, so what is asserted here is the narrowing
 * and what only a move asks, each against the add over the same file and the
 * same ledger: a choice that would leave a transaction with nowhere to be
 * written is not offered; a frozen account, a category whose kind here would
 * make a transaction both income and spending, and a transaction still waiting
 * in Staged are refused before anything is written; deleted transactions and
 * archived records travel as they were; and the balances the file states are
 * the ones the part that carries them is held to.
 */

type Json = Record<string, unknown>;
type Account = LedgerFile["accounts"][number];
type Category = LedgerFile["categories"][number];

function parsed(json: Json): LedgerFile {
  const result = parseLedgerFile(json);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.file;
}

const whole = () => parsed(wholeLedger());

type Here = Partial<
  Pick<LedgerFile, "groups" | "categories" | "accounts" | "templates" | "recurrences" | "budgets">
>;

/** A destination holding `records`, settings nobody chose, and a ledger that may take a move. */
function factsOf(
  records: Here = {},
  options: {
    limit?: number | null;
    qualifies?: boolean;
    rows?: Partial<LedgerFileFacts["rows"]>;
  } = {},
): LedgerFileFacts {
  let next = 9000;
  const ids = <T extends { key: string }>(list: readonly T[] | undefined) =>
    Object.fromEntries((list ?? []).map((each) => [each.key, origin(next++)]));
  const qualifies = options.qualifies ?? true;
  return ledgerFileFactsSchema.parse({
    here: {
      groups: records.groups ?? [],
      categories: records.categories ?? [],
      accounts: records.accounts ?? [],
      templates: records.templates ?? [],
      recurrences: records.recurrences ?? [],
      budgets: records.budgets ?? { plans: [], entries: [] },
      ids: {
        group: ids(records.groups),
        category: ids(records.categories),
        account: ids(records.accounts),
        template: ids(records.templates),
        recurrence: ids(records.recurrences),
      },
      limit: options.limit ?? null,
      preferences: { chosen: false, timezone: "UTC", defaultCurrency: "USD", theme: "system" },
    },
    rows: { alreadyHere: 0, stagedAlreadyHere: 0, ...options.rows },
    move: { qualifies, reason: qualifies ? null : LEDGER_FILE_MOVE_BLOCKED, stagedRows: 0 },
  });
}

type Extra = {
  decisions?: LedgerFileDecision[];
  arriveArchived?: string[];
  part?: { index: number; count: number };
};

/** The move's plan, held to the published schema the preview and the result carry it in. */
const move = (file: LedgerFile, facts: LedgerFileFacts, extra: Extra = {}): LedgerFilePlan => {
  const { plan } = planLedgerFileMove({ file, facts, ...extra });
  ledgerFilePlanSchema.parse(plan);
  return plan;
};

/** The add's plan over the same file and ledger, which a move is measured against. */
const add = (file: LedgerFile, facts: LedgerFileFacts, extra: Extra = {}): LedgerFilePlan =>
  planLedgerFileAdd({ file, facts, ...extra }).plan;

const record = (plan: LedgerFilePlan, kind: string, key: string): LedgerFilePlannedRecord => {
  const found = plan.records.find((each) => each.kind === kind && each.key === key);
  if (!found) throw new Error(`no ${kind} ${key} in the plan`);
  return found;
};

const accountLike = (file: LedgerFile, key: string, change: Json) =>
  unchecked({ ...file.accounts.find((each) => each.key === key)!, ...change } as Account);

const categoryLike = (file: LedgerFile, key: string, change: Json): Category =>
  ({ ...file.categories.find((each) => each.key === key)!, ...change }) as Category;

/** The whole ledger with one kind left out, so what it names travels as references. */
function without(kind: "accounts" | "categories", json: Json = wholeLedger()): Json {
  const scope = json["scope"] as { kinds: string[] };
  scope.kinds = scope.kinds.filter((each) => each !== kind);
  const strip = (each: Json, keep: string[]) =>
    Object.fromEntries([
      ...[...keep, "key", "name"].map((field) => [field, each[field]]),
      ["detail", "reference"],
    ]);
  if (kind === "accounts") {
    json["accounts"] = (json["accounts"] as Json[])
      .filter((each) => each["key"] !== "Old card")
      .map((each) => strip(each, ["type", "currency"]));
  }
  if (kind === "categories") {
    json["groups"] = (json["groups"] as Json[]).map((each) => strip(each, ["policy"]));
    json["categories"] = (json["categories"] as Json[])
      .filter((each) => each["key"] !== "Old hobby")
      .map((each) => strip(each, ["kind", "group"]));
  }
  return json;
}

describe("a ledger that may take a move", () => {
  it("is moved into with nothing asked when it holds nothing the file carries", () => {
    const result = move(whole(), factsOf());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is refused first, whatever else is decided, when it holds entries of its own", () => {
    const facts = factsOf({}, { qualifies: false });
    const result = move(whole(), facts);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toEqual({ field: "move", message: LEDGER_FILE_MOVE_BLOCKED });
    expect(add(whole(), facts).ok).toBe(true);
  });

  it("is refused in other words, with the rows counted, when only rows waiting in Staged stop it", () => {
    // Discarding them is the way out, and the entries sentence sent people to
    // add instead, which leaves the rest of the file in Staged.
    const facts = factsOf();
    const blocked = (n: number) => ({
      ...facts,
      move: { qualifies: false, reason: ledgerFileMoveStagedBlocked(n), stagedRows: n },
    });
    expect(move(whole(), blocked(2)).problems[0]).toEqual({
      field: "move",
      message:
        "2 rows waiting in Staged did not come from a Simple Balance file, and committing them would rule out a move for good. Discard them there and check the file again to move it, or add the file instead, with its transactions going to Staged for review.",
      count: 2,
    });
    expect(move(whole(), blocked(1)).problems[0]).toEqual({
      field: "move",
      message:
        "A row waiting in Staged did not come from a Simple Balance file, and committing it would rule out a move for good. Discard it there and check the file again to move it, or add the file instead, with its transactions going to Staged for review.",
      count: 1,
    });
  });

  it("is refused while the file's transactions wait in Staged from an earlier add", () => {
    const facts = factsOf({}, { rows: { alreadyHere: 2, waiting: 2 } });
    expect(move(whole(), facts).problems).toEqual([
      {
        field: "move",
        message:
          "2 of this file's transactions are waiting in Staged from an earlier import of it. Commit or discard them there first: a move writes each transaction straight into the books, once.",
        count: 2,
      },
    ]);
    expect(move(whole(), factsOf({}, { rows: { alreadyHere: 1, waiting: 1 } })).problems).toEqual([
      {
        field: "move",
        message:
          "One of this file's transactions is waiting in Staged from an earlier import of it. Commit or discard it there first: a move writes each transaction straight into the books, once.",
        count: 1,
      },
    ]);
    expect(add(whole(), facts).ok).toBe(true);
  });

  it("counts every read of a file in parts, and qualifies only if each did", () => {
    const one = factsOf({}, { rows: { deletedAlreadyHere: 1, waiting: 2 } });
    const two = factsOf({}, { qualifies: false, rows: { deletedAlreadyHere: 3, waiting: 1 } });
    const merged = mergeLedgerFileFacts([one, two]);
    expect(merged.rows).toMatchObject({ deletedAlreadyHere: 4, waiting: 3 });
    expect(merged.move).toEqual({
      qualifies: false,
      reason: LEDGER_FILE_MOVE_BLOCKED,
      stagedRows: 0,
    });
    expect(mergeLedgerFileFacts([two, one]).move.qualifies).toBe(false);
    expect(mergeLedgerFileFacts([one, one]).move.qualifies).toBe(true);
  });
});

describe("what a move writes", () => {
  it("writes every live transaction and every deleted one, and stages only the file's own rows", () => {
    const result = move(whole(), factsOf());
    expect(result.rows).toMatchObject({ entries: 6, deleted: 1, staged: 2, toStage: 2 });
    expect(result.move).toMatchObject({
      toWrite: 5,
      toVoid: 1,
      alreadyHere: 0,
      waiting: 0,
      templateDropped: 0,
      recurrencesDeferred: 0,
    });
    expect(add(whole(), factsOf()).rows.toStage).toBe(7);
    expect(add(whole(), factsOf()).move).toBeUndefined();
  });

  it("skips by origin what an earlier part brought, deleted transactions included", () => {
    const facts = factsOf(
      {},
      { rows: { alreadyHere: 3, stagedAlreadyHere: 1, deletedAlreadyHere: 1 } },
    );
    const result = move(whole(), facts);
    expect(result.rows.toStage).toBe(1);
    expect(result.move).toMatchObject({ toWrite: 2, toVoid: 0, alreadyHere: 4 });
  });

  it("counts the transactions whose template is not coming, which arrive without it", () => {
    const file = whole();
    const here = {
      ...file.templates[1]!,
      draft: { payee: "Somewhere else" },
    } as LedgerFile["templates"][number];
    const result = move(file, factsOf({ templates: [here] }), {
      decisions: [{ kind: "template", key: "Coffee", action: "skip" }],
    });
    expect(result.ok).toBe(true);
    expect(result.move!.templateDropped).toBe(1);
  });
});

describe("a choice that would leave a transaction nowhere to be written", () => {
  it("is not offered for an account the file's transactions name", () => {
    const file = whole();
    const facts = factsOf({ accounts: [accountLike(file, "Checking", { notes: "Joint" })] });
    expect(record(add(file, facts), "account", "Checking").choices).toEqual([
      "use_existing",
      "skip",
      "rename",
    ]);
    const result = move(file, facts, {
      decisions: [{ kind: "account", key: "Checking", action: "skip" }],
    });
    expect(record(result, "account", "Checking")).toMatchObject({
      outcome: "duplicate",
      choices: ["use_existing", "rename"],
      action: "undecided",
      message:
        "There is already an account called \"Checking\" here, and it differs from the file's in its notes. 6 of this file's transactions name it, and a move writes each one straight into the books, so it has to come in.",
    });
    expect(result.problems[0]!.message).toBe(
      'The account "Checking" cannot take that decision. Choose whether to use the one here or bring it in under another name.',
    );
  });

  it("is offered for an account nothing in the file is written to", () => {
    const file = whole();
    const facts = factsOf({ accounts: [accountLike(file, "Old card", { notes: "Shredded" })] });
    expect(record(move(file, facts), "account", "Old card").choices).toEqual([
      "use_existing",
      "skip",
      "rename",
    ]);
  });

  it("leaves an account here that opens differently unused, because its balance would not come out", () => {
    const file = whole();
    const facts = factsOf({
      accounts: [accountLike(file, "Checking", { openingBalance: "1000" })],
    });
    expect(record(add(file, facts), "account", "Checking").choices).toContain("use_existing");
    const result = move(file, facts);
    expect(record(result, "account", "Checking")).toMatchObject({
      choices: ["rename"],
      message:
        "There is already an account called \"Checking\" here, and it differs from the file's in its opening. Here it opens on 2019-01-01 at 1000 EUR, and the file's on 2019-01-01 at 1520.33 EUR. A move holds every balance to the file, and the one here keeps its own opening, so it cannot be used. 6 of this file's transactions name it, and a move writes each one straight into the books, so it has to come in.",
    });
    expect(result.problems[0]!.message).toMatch(
      /Choose whether to bring it in under another name\.$/,
    );
  });

  it("is not offered for an account the file only names, where a transaction names it", () => {
    const file = parsed(chosenAccounts());
    expect(record(add(file, factsOf()), "account", "Brokerage").choices).toEqual([
      "create",
      "leave_staged",
    ]);
    expect(record(move(file, factsOf()), "account", "Brokerage")).toMatchObject({
      outcome: "missing",
      choices: ["create"],
      message:
        'This file names an account "Brokerage", which is not here. One of this file\'s transactions names it, and a move writes each one straight into the books, so it has to come in.',
    });
    const leaving = move(file, factsOf(), {
      decisions: [{ kind: "account", key: "Brokerage", action: "leave_staged" }],
    });
    expect(leaving.problems[0]!.message).toBe(
      'The account "Brokerage" cannot take that decision. Choose whether to create it.',
    );
    const created = move(file, factsOf(), {
      decisions: [{ kind: "account", key: "Brokerage", action: "create" }],
    });
    expect(created.ok).toBe(true);
    expect(record(created, "account", "Brokerage").action).toBe("create");
  });

  it("is offered for a reference only the file's staged rows name, since those still stage", () => {
    const json = without("accounts");
    (json["accounts"] as Json[]).push({
      key: "Wallet",
      name: "Wallet",
      detail: "reference",
      type: "cash",
      currency: "EUR",
    });
    (json["staged"] as Json[])[1] = {
      id: origin(102),
      draft: { type: "transfer", sourceAmount: "50.00", payee: "To savings", to: "Wallet" },
      rawData: null,
    };
    const result = move(parsed(json), factsOf());
    expect(record(result, "account", "Wallet").choices).toEqual(["create", "leave_staged"]);
    expect(record(result, "account", "Checking").choices).toEqual(["create"]);
  });

  it("is not offered for a category the file's transactions are filed under", () => {
    const file = whole();
    const facts = factsOf({ categories: [categoryLike(file, "Household", { group: null })] });
    expect(record(add(file, facts), "category", "Household").choices).toEqual([
      "use_existing",
      "skip",
      "rename",
    ]);
    expect(record(move(file, facts), "category", "Household").choices).toEqual([
      "use_existing",
      "rename",
    ]);
    const unused = factsOf({ categories: [categoryLike(file, "Old hobby", { kind: "both" })] });
    expect(record(move(file, unused), "category", "Old hobby").choices).toEqual([
      "use_existing",
      "skip",
      "rename",
    ]);
    const named = parsed(without("categories"));
    expect(record(move(named, factsOf()), "category", "Groceries").choices).toEqual(["create"]);
  });

  it("leaves a group's choices alone, because no transaction names a group", () => {
    const named = parsed(without("categories"));
    expect(record(move(named, factsOf()), "group", "Home").choices).toEqual(["create", "skip"]);
  });
});

describe("records that travel as they were", () => {
  it("brings a category archived where it came from archived, rather than in use", () => {
    expect(record(add(whole(), factsOf()), "category", "Old hobby")).toMatchObject({
      arrivesArchived: false,
      message:
        "It was archived where it came from. It arrives in use so the transactions filed under it can be committed; archive it again once they are.",
    });
    expect(record(move(whole(), factsOf()), "category", "Old hobby")).toMatchObject({
      action: "create",
      arrivesArchived: true,
      message:
        "It was archived where it came from, and arrives archived, with the transactions filed under it.",
    });
  });

  it("brings an archived account with its transactions in it, closed on its own day", () => {
    expect(record(move(whole(), factsOf()), "account", "Old card")).toMatchObject({
      arrivesArchived: true,
      message:
        "It was archived where it came from, so it arrives archived and uses no place: its transactions are written into it, and it holds nothing from the day it was archived there.",
    });
  });

  it("writes into an account somebody chose to arrive archived, closed on the day of the move", () => {
    const result = move(whole(), factsOf({}, { limit: 1 }), { arriveArchived: ["Brokerage"] });
    expect(result.places).toEqual({ limit: 1, inUse: 0, arriving: 2, needed: 1, chosen: 1 });
    expect(result.ok).toBe(true);
    expect(record(result, "account", "Brokerage")).toMatchObject({
      arrivesArchived: true,
      message:
        "It arrives archived and uses no place: its transactions are written into it, and it holds nothing from the day of the move. Restoring it into a free place posts its balance back.",
    });
    expect(record(result, "account", "Checking").arrivesArchived).toBe(false);
    expect(move(whole(), factsOf({}, { limit: 1 })).problems[0]).toMatchObject({
      field: "arriveArchived",
      needed: 1,
    });
  });

  it("writes into an account archived here, and says so rather than sending it to Staged", () => {
    const file = whole();
    const facts = factsOf({
      accounts: [accountLike(file, "Checking", { archivedAt: "2026-01-01T00:00:00.000Z" })],
    });
    expect(record(add(file, facts), "account", "Checking").message).toBe(
      '"Checking" is archived here, so the transactions that name it wait in Staged until it is restored.',
    );
    expect(record(move(file, facts), "account", "Checking")).toMatchObject({
      action: "use",
      message:
        '"Checking" is archived here. A move writes its transactions into it all the same, and it still holds nothing from the day it was archived here.',
    });
  });
});

describe("what only writing could get wrong, said first", () => {
  it("refuses a frozen account the file's transactions are on, with how many", () => {
    const file = whole();
    const facts = factsOf({ accounts: [accountLike(file, "Brokerage", { inUse: false })] });
    expect(add(file, facts).ok).toBe(true);
    const result = move(file, facts);
    const message =
      '"Brokerage" is frozen here, and one of this file\'s transactions is on it. A move writes every transaction straight into the books, and a frozen account takes no new ones, so free a place for it first by archiving or deleting an account in use, or upgrade under Settings.';
    expect(result.problems).toEqual([
      { field: "move", message, kind: "account", key: "Brokerage", count: 1 },
    ]);
    expect(record(result, "account", "Brokerage").message).toBe(message);
  });

  it("refuses a transaction a category's kind here would make both income and spending", () => {
    const file = whole();
    // Groceries takes only income here, and the split under it and Household,
    // which takes only spending, would then be income and spending at once.
    const facts = factsOf({ categories: [categoryLike(file, "Groceries", { kind: "income" })] });
    const result = move(file, facts, {
      decisions: [{ kind: "category", key: "Groceries", action: "use_existing" }],
    });
    expect(result.problems).toEqual([
      {
        field: "move",
        message:
          'The withdrawal of 80.00 dated 2026-10-04 with Market would be both income and spending here, because "Groceries" takes only income here and income and spending in the file. Bring "Groceries" in under another name rather than using the one here.',
        kind: "category",
        key: "Groceries",
        count: 1,
        // The transaction the sentence names, as fields an agent can find it
        // in the file by, rather than words it would have to read back.
        origin: origin(3),
        date: "2026-10-04",
        amount: "80.00",
      },
    ]);
    const renamed = move(file, facts, {
      decisions: [{ kind: "category", key: "Groceries", action: "rename", name: "Groceries (2)" }],
    });
    expect(renamed.ok).toBe(true);
  });

  it("refuses a deleted transaction that would be both too, since it is written before it is voided", () => {
    const json = wholeLedger();
    (json["entries"] as Json[]).push({
      id: origin(8),
      type: "withdrawal",
      date: "2026-10-07",
      from: "Checking",
      amount: "5.00",
      payee: "Market",
      legs: [
        { category: "Groceries", amount: "3.00" },
        { category: "Household", amount: "2.00" },
      ],
      deleted: true,
    });
    const file = parsed(json);
    const facts = factsOf({ categories: [categoryLike(file, "Groceries", { kind: "income" })] });
    const [refused] = move(file, facts, {
      decisions: [{ kind: "category", key: "Groceries", action: "use_existing" }],
    }).problems;
    expect(refused).toMatchObject({ field: "move", key: "Groceries", count: 2 });
    // The number the sentence states is the field, not one less than it.
    expect(refused!.message).toMatch(/ It is one of 2 transactions filed that way\.$/);
  });

  it("names a transaction the file itself files under both sides, with its fields", () => {
    // Edited by hand: a split across an income and a spending category, which
    // no ledger could have written, and which no category here can cure.
    const json = wholeLedger();
    (json["entries"] as Json[]).push({
      id: origin(9),
      type: "withdrawal",
      date: "2026-10-08",
      from: "Checking",
      amount: "9.00",
      payee: "Odd",
      legs: [
        { category: "Salary", amount: "4.00" },
        { category: "Household", amount: "5.00" },
      ],
    });
    const [refused] = move(parsed(json), factsOf()).problems;
    expect(refused).toEqual({
      field: "move",
      message:
        "The withdrawal of 9.00 dated 2026-10-08 with Odd is filed under both an income and a spending category, which one transaction cannot be, so the file cannot be moved as it is.",
      count: 1,
      origin: origin(9),
      date: "2026-10-08",
      amount: "9.00",
    });
  });

  it("names what can be done about a category matched by its name alone", () => {
    const json = chosenAccounts();
    (json["entries"] as Json[]).push({
      id: origin(19),
      type: "withdrawal",
      date: "2026-03-03",
      from: "Checking",
      amount: "10.00",
      payee: "Corner shop",
      legs: [
        { category: "Groceries", amount: "6.00" },
        { category: "Gifts", amount: "4.00" },
      ],
    });
    json["categories"] = [
      { key: "Groceries", name: "Groceries", detail: "reference", kind: "expense", group: null },
      { key: "Gifts", name: "Gifts", detail: "reference", kind: "expense", group: null },
    ];
    json["scope"] = { ...(json["scope"] as Json), kinds: ["accounts", "entries"] };
    const here = (key: string, kind: Category["kind"]): Category => ({
      key,
      name: key,
      detail: "full",
      kind,
      group: null,
      archivedAt: null,
    });
    const result = move(
      parsed(json),
      factsOf({ categories: [here("Groceries", "expense"), here("Gifts", "income")] }),
      { decisions: [{ kind: "account", key: "Brokerage", action: "create" }] },
    );
    expect(result.problems.map((each) => each.message)).toEqual([
      'The withdrawal of 10.00 dated 2026-03-03 with Corner shop would be both income and spending here, because "Gifts" takes only income here and only spending in the file. Change it to take only spending under Categories first, or move the file into a ledger without a category of that name.',
    ]);
  });
});

describe("refunds that land on the other side here", () => {
  it("are reported by currency, side and amount, and never reproduced", () => {
    // Origin 4 is a refund of 12.99 filed under Groceries, which was widened to
    // both after it posted: it debited spending there and credits income here.
    expect(move(whole(), factsOf()).move!.drift).toEqual([
      {
        currency: "EUR",
        type: "deposit",
        from: "expense",
        to: "income",
        entries: 1,
        amount: "12.99",
        categories: ["Groceries"],
      },
    ]);
  });

  it("leave a deleted refund out, since voided it moves nothing either way", () => {
    const json = wholeLedger();
    (json["entries"] as Json[]).push({
      id: origin(7),
      type: "deposit",
      date: "2026-10-06",
      to: "Checking",
      amount: "4.00",
      payee: "Rewe",
      category: "Groceries",
      deleted: true,
      postedAs: "expense",
    });
    expect(move(parsed(json), factsOf()).move!.drift.map((each) => each.entries)).toEqual([1]);
  });

  it("include a category whose kind here differs, and leave a refused transaction out", () => {
    const file = whole();
    // Salary takes both here: the salary deposit still credits income, so only
    // the widened refund drifts.
    const both = factsOf({ categories: [categoryLike(file, "Salary", { kind: "both" })] });
    expect(
      move(file, both, {
        decisions: [{ kind: "category", key: "Salary", action: "use_existing" }],
      }).move!.drift.map((each) => each.entries),
    ).toEqual([1]);
    // Groceries takes only income here: the refund still credits income, and
    // the withdrawal of 54.23 under it becomes income coming back. The split
    // is refused, so it drifts nothing. The two move income and spending in
    // opposite directions — the refund up by 12.99, the withdrawal down by
    // 54.23 — so they are two groups, each with its own direction, and never
    // one figure of 67.22 that matches neither.
    const income = factsOf({ categories: [categoryLike(file, "Groceries", { kind: "income" })] });
    expect(
      move(file, income, {
        decisions: [{ kind: "category", key: "Groceries", action: "use_existing" }],
      }).move!.drift,
    ).toEqual([
      {
        currency: "EUR",
        type: "withdrawal",
        from: "expense",
        to: "income",
        entries: 1,
        amount: "54.23",
        categories: ["Groceries"],
      },
      {
        currency: "EUR",
        type: "deposit",
        from: "expense",
        to: "income",
        entries: 1,
        amount: "12.99",
        categories: ["Groceries"],
      },
    ]);
  });
});

describe("the balances a move is held to", () => {
  it("are the file's own, compared for every account but one closed where it came from", () => {
    expect(move(whole(), factsOf()).move!.checks).toEqual([
      { key: "Checking", name: "Checking", currency: "EUR", balance: "1301.11", compared: true },
      { key: "Brokerage", name: "Brokerage", currency: "USD", balance: "1081.4", compared: true },
      { key: "Old card", name: "Old card", currency: "EUR", balance: "0", compared: false },
    ]);
  });

  it("follow an account brought in under another name, and leave out one left out", () => {
    const file = whole();
    const facts = factsOf({
      accounts: [
        accountLike(file, "Checking", { openingBalance: "1" }),
        accountLike(file, "Old card", { notes: "Shredded" }),
      ],
    });
    const result = move(file, facts, {
      decisions: [
        { kind: "account", key: "Checking", action: "rename", name: "Checking (old bank)" },
        { kind: "account", key: "Old card", action: "skip" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.move!.checks.map((each) => `${each.key} as ${each.name}`)).toEqual([
      "Checking as Checking (old bank)",
      "Brokerage as Brokerage",
    ]);
  });

  it("are none on a part that carries no balances", () => {
    const json = wholeLedger();
    for (const account of json["accounts"] as Json[]) delete account["balance"];
    expect(move(parsed(json), factsOf()).move!.checks).toEqual([]);
  });

  it("find only the accounts that came out differently, however a figure is written", () => {
    const file = whole();
    const checks = move(file, factsOf()).move!.checks;
    const actual = new Map([
      ["Checking", "1301.110000000000000000"],
      ["Brokerage", "1071.4"],
      ["Old card", "-120.5"],
    ]);
    expect(ledgerBalanceMismatches(file, checks, actual)).toEqual([
      {
        field: "accounts.1.balance",
        key: "Brokerage",
        name: "Brokerage",
        currency: "USD",
        expected: "1081.4",
        actual: "1071.4",
        difference: "-10",
      },
    ]);
    expect(
      ledgerBalanceMismatches(
        file,
        checks,
        new Map([
          ["Checking", "1301.11"],
          ["Brokerage", "1081.40"],
        ]),
      ),
    ).toEqual([]);
    // An account the read left out holds nothing, and is refused rather than passed.
    expect(
      ledgerBalanceMismatches(file, checks, new Map([["Checking", "1301.11"]])).map(
        (each) => `${each.key} ${each.actual} ${each.difference}`,
      ),
    ).toEqual(["Brokerage 0 -1081.4"]);
  });

  it("refuse in a sentence naming the account, both figures and the gap, with the numbers beside it", () => {
    const one = {
      field: "accounts.0.balance",
      key: "Checking",
      name: "Checking",
      currency: "EUR",
      expected: "4400.2",
      actual: "4410.2",
      difference: "10",
    };
    const whole = { part: { index: 1, count: 1 }, startsOn: null };
    const refusal = ledgerBalanceRefusal([one], "2026-10-25", whole);
    // A file of one part is "the move", and nothing of it was written. The
    // person is never told an earlier part may be missing, because the page
    // sends the parts in order; what they can do is said instead.
    expect(refusal.message).toBe(
      'After the move, "Checking" would hold 4410.2 EUR on 2026-10-25, and the file says 4400.2 EUR: 10 EUR more than the file. Nothing was written. If "Checking" here held transactions that are not in this file, rename it under Accounts and check the file again, so the file\'s comes in as a new account, or add the file instead, which sends its transactions to Staged. If it holds some of this file\'s transactions as an earlier copy of the file had them, a move passes over those rather than changing them, and they can only be put right by hand.',
    );
    // An agent with one part is never sent looking for earlier ones.
    expect(refusal.forAgent).toBe(
      'After the move, "Checking" would hold 4410.2 EUR on 2026-10-25, and the file says 4400.2 EUR: 10 EUR more than the file. Nothing was written. "Checking" here holds transactions that are not in this file, or holds some of this file\'s as an earlier copy of it had them. For the first, rename it with update_account, call preview_ledger_file again and send the file again so the file\'s comes in as a new account, or call add_ledger_file instead. For the second, a move passes over a transaction already here rather than changing it, so only the person can reconcile them.',
    );
    expect(refusal.details).toMatchObject({
      throughDate: "2026-10-25",
      key: "Checking",
      name: "Checking",
      currency: "EUR",
      expected: "4400.2",
      actual: "4410.2",
      difference: "10",
      count: 1,
    });
    // Of several parts, an agent is sent to the earlier parts first, and a
    // file that starts partway through names the file before it as a cause.
    const later = ledgerBalanceRefusal([one], "2026-10-25", {
      part: { index: 3, count: 3 },
      startsOn: "2026-06-01",
    });
    expect(later.message).toMatch(
      /^After this part, "Checking" would hold .* Nothing in this part was written\. This file starts on 2026-06-01, so a file covering the days before it may have to be moved in first\. If "Checking" here held/,
    );
    expect(later.message).not.toContain("earlier part");
    expect(later.forAgent).toContain(
      "Nothing in this part was written. Call preview_ledger_file on each earlier part: one whose transactions are not all already here has not been moved, so send it first, then this part again. This file starts on 2026-06-01, so a file covering the days before it may have to be moved in first: move that file first, then this one again. If every earlier part is in,",
    );
    const short = { ...one, key: "Savings", name: "Savings", actual: "4300", difference: "-100.2" };
    const three = ledgerBalanceRefusal([short, one, one], "2026-10-25", whole);
    // The count the sentence states is the count in the details.
    expect(three.message).toMatch(
      /^After the move, "Savings" would hold 4300 EUR on 2026-10-25, and the file says 4400\.2 EUR: 100\.2 EUR less than the file\. 3 accounts disagree in all\. Nothing/,
    );
    expect(three.details).toMatchObject({ count: 3, name: "Savings" });
    expect((three.details["issues"] as { name: string }[]).map((issue) => issue.name)).toEqual([
      "Savings",
      "Checking",
      "Checking",
    ]);
  });

  it("can be written again in the page's own figures, from the details alone", () => {
    const one = {
      field: "accounts.0.balance",
      key: "Checking",
      name: "Checking",
      currency: "EUR",
      expected: "990.5",
      actual: "996",
      difference: "5.5",
    };
    const context = { part: { index: 1, count: 1 }, startsOn: null };
    const sent = ledgerBalanceRefusal([one], "2026-10-26", context);
    const read = ledgerBalanceRefusalOf(sent.details);
    expect(read).toEqual({ throughDate: "2026-10-26", mismatches: [one] });
    const figures = {
      money: (amount: string, currency: string) => `[${amount} in ${currency}]`,
      date: (day: string) => `<${day}>`,
    };
    const shown = ledgerBalanceRefusal(read!.mismatches, read!.throughDate, context, figures);
    expect(shown.message).toMatch(
      /^After the move, "Checking" would hold \[996 in EUR\] on <2026-10-26>, and the file says \[990\.5 in EUR\]: \[5\.5 in EUR\] more than the file\./,
    );
    expect(ledgerBalanceIssue(one, figures)).toBe(
      '"Checking" would hold [996 in EUR], and the file says [990.5 in EUR].',
    );
    // Any other refusal's details are not taken for one.
    expect(ledgerBalanceRefusalOf({ issues: [{ field: "x", message: "y" }] })).toBeNull();
    expect(ledgerBalanceRefusalOf(undefined)).toBeNull();
  });
});

describe("recurring transactions", () => {
  it("wait for the last part of a file, so nothing they propose stops the rest", () => {
    const first = move(whole(), factsOf(), { part: { index: 1, count: 2 } });
    expect(first.move!.recurrencesDeferred).toBe(2);
    expect(record(first, "recurrence", "Salary")).toMatchObject({
      action: "create",
      message:
        "It is created by the file's last part, so nothing it proposes reaches Staged while the move is under way.",
    });
    const last = move(whole(), factsOf(), { part: { index: 2, count: 2 } });
    expect(last.move!.recurrencesDeferred).toBe(0);
    expect(record(last, "recurrence", "Salary").message).toBeNull();
    expect(
      record(add(whole(), factsOf(), { part: { index: 1, count: 2 } }), "recurrence", "Salary")
        .message,
    ).toBeNull();
  });
});

describe("a transaction as a move writes it", () => {
  const ids: LedgerRefResolver = (kind, key) =>
    kind === "account" || kind === "category" ? { id: origin(key.length) } : null;

  it("is the add's draft, complete, with a template that is not coming left off", () => {
    const entry = whole().entries.find((each) => each.id === origin(5))!;
    expect(ledgerMoveEntryDraft(entry, ids)).toEqual({
      ok: true,
      draft: {
        type: "withdrawal",
        date: "2026-09-30",
        payee: "Kiosk",
        fromAccountId: origin("Checking".length),
        amount: "5.00",
      },
    });
  });

  it("is refused, never half written, when an account or a category does not resolve", () => {
    const transfer = whole().entries.find((each) => each.type === "transfer")!;
    const noBrokerage: LedgerRefResolver = (kind, key) =>
      kind === "account" && key === "Brokerage" ? null : ids(kind, key);
    expect(ledgerMoveEntryDraft(transfer, noBrokerage)).toEqual({
      ok: false,
      kind: "account",
      key: "Brokerage",
    });
    const split = whole().entries.find((each) => each.id === origin(3))!;
    const byName: LedgerRefResolver = (kind, key) =>
      kind === "category" && key === "Household"
        ? { name: "Household", kind: "expense" }
        : ids(kind, key);
    expect(ledgerMoveEntryDraft(split, byName)).toEqual({
      ok: false,
      kind: "category",
      key: "Household",
    });
  });

  it("is named in a refusal by type, amount, day and payee", () => {
    const entry = whole().entries.find((each) => each.id === origin(1))!;
    expect(ledgerEntryLabel(entry)).toBe("the withdrawal of 54.23 dated 2026-10-02 with Rewe");
    expect(ledgerMoveEntryRefusal(entry, "That category is archived or was not found. ")).toBe(
      "The withdrawal of 54.23 dated 2026-10-02 with Rewe could not be written: That category is archived or was not found. Nothing in this part was written.",
    );
  });
});

describe("the request and the reply", () => {
  const request = {
    ledgerFile: "{}",
    fileName: "simple-balance-2026-10-25.json",
    idempotencyKey: "move-1-1",
  };

  it("take the add's fields and nothing else, described for a move", () => {
    expect(ledgerFileMoveInputSchema.parse(request)).toMatchObject({
      part: { index: 1, count: 1 },
      decisions: [],
      arriveArchived: [],
    });
    for (const extra of ["dryRun", "archivedAt", "deferClose", "allowArchived", "mode"]) {
      expect(ledgerFileMoveInputSchema.safeParse({ ...request, [extra]: true }).success).toBe(
        false,
      );
    }
    expect(ledgerFileMoveInputSchema.shape.arriveArchived.description).toContain(
      "Their transactions are written into them, and they hold nothing from the day of the move",
    );
  });

  it("reply with what each part wrote, skipped, staged, closed and checked", () => {
    const plan = move(whole(), factsOf());
    const reply = {
      part: { index: 1, count: 1 },
      written: { entries: 5, deleted: 1 },
      skipped: { entries: 0, deleted: 0, staged: 0 },
      importBatchId: origin(5001),
      staged: 2,
      needsReview: 2,
      budgetEntries: { created: 1, skipped: 0 },
      archived: 1,
      balances: { checked: 2, notCompared: 1 },
      plan: {
        ...plan,
        records: plan.records.map((each) =>
          each.action === "create" ? { ...each, id: origin(7000) } : each,
        ),
      },
    };
    expect(ledgerFileMoveResultSchema.parse(reply)).toEqual(reply);
    expect(ledgerFileMoveResultSchema.safeParse({ ...reply, balances: null }).success).toBe(true);
  });
});

/**
 * What the whole file can see and a part cannot: an account here holding
 * transactions the file does not, and the file's transactions already here on
 * another account. Each is asked or refused before anything is written,
 * because the balance check that would otherwise meet it comes only with the
 * last part, after the parts before it are in.
 */
describe("an account here that a move could never come out at", () => {
  it("asks for another name for one the same in every field that holds transactions from elsewhere", () => {
    const file = whole();
    const here = factsOf(
      { accounts: [accountLike(file, "Checking", {})] },
      { rows: { heldHere: { Checking: { entries: 5, fromFile: 2 } } } },
    );
    // Without anything held elsewhere it is the file's, and used.
    expect(
      record(
        move(file, factsOf({ accounts: [accountLike(file, "Checking", {})] })),
        "account",
        "Checking",
      ),
    ).toMatchObject({ outcome: "exists", action: "use" });
    const plan = move(file, here);
    expect(record(plan, "account", "Checking")).toMatchObject({
      outcome: "duplicate",
      choices: ["rename"],
      action: "undecided",
      message:
        "\"Checking\" here already holds 3 transactions that are not in this file, so the file's cannot be written into it and still come out at the file's balance.",
    });
    expect(plan.problems).toEqual([
      expect.objectContaining({ field: "decisions", kind: "account", key: "Checking", held: 3 }),
    ]);
    // Adding is not held to a balance, and asks nothing.
    expect(record(add(file, here), "account", "Checking")).toMatchObject({ outcome: "exists" });
    const renamed = move(file, here, {
      decisions: [{ kind: "account", key: "Checking", action: "rename", name: "Checking (2)" }],
    });
    expect(renamed.ok).toBe(true);
    expect(record(renamed, "account", "Checking")).toMatchObject({
      action: "create",
      importName: "Checking (2)",
    });
  });

  it("takes using one that differs off the table when it holds transactions from elsewhere", () => {
    const file = whole();
    const facts = factsOf(
      { accounts: [accountLike(file, "Checking", { notes: "Joint" })] },
      { rows: { heldHere: { Checking: { entries: 1, fromFile: 0 } } } },
    );
    expect(
      record(
        move(file, factsOf({ accounts: [accountLike(file, "Checking", { notes: "Joint" })] })),
        "account",
        "Checking",
      ).choices,
    ).toEqual(["use_existing", "rename"]);
    expect(record(move(file, facts), "account", "Checking").choices).toEqual(["rename"]);
    // Both numbers the sentence says are fields beside it.
    const [asked] = move(file, facts).problems;
    expect(asked).toMatchObject({ key: "Checking", held: 1 });
    expect(asked!.message).toContain("already holds a transaction that is not in this file");
    expect(asked!.message).toContain(`${asked!.count} of this file's transactions name it`);
  });

  it("keeps the whole file's answer on every part, which cannot see the question", () => {
    const file = whole();
    const rename = {
      decisions: [
        {
          kind: "account" as const,
          key: "Checking",
          action: "rename" as const,
          name: "Checking (2)",
        },
      ],
    };
    // A part's facts count only its own origins, so it asks nothing.
    const plain = factsOf({ accounts: [accountLike(file, "Checking", {})] });
    expect(
      record(move(file, plain, { part: { index: 1, count: 2 } }), "account", "Checking"),
    ).toMatchObject({ action: "use" });
    // The first part brings it in under the page's name.
    expect(
      record(move(file, plain, { ...rename, part: { index: 1, count: 2 } }), "account", "Checking"),
    ).toMatchObject({ action: "create", importName: "Checking (2)" });
    // A later part lands in the copy the first one made, the same in every field.
    const copied = factsOf({
      accounts: [
        accountLike(file, "Checking", {}),
        accountLike(file, "Checking", { key: "Checking (2)", name: "Checking (2)" }),
      ],
    });
    expect(
      record(
        move(file, copied, { ...rename, part: { index: 2, count: 2 } }),
        "account",
        "Checking",
      ),
    ).toMatchObject({ action: "use", importName: "Checking (2)" });
    // And never starts a copy of its own, which would split the parts already
    // written into the account here from the rest.
    expect(
      record(move(file, plain, { ...rename, part: { index: 2, count: 2 } }), "account", "Checking"),
    ).toMatchObject({ action: "use", importName: "Checking" });
  });

  it("refuses an account brought in new while the file's transactions on it are already here", () => {
    const file = whole();
    // Brokerage is new here, and the transfer onto it came with another file.
    const facts = factsOf(
      {},
      { rows: { alreadyHere: 1, alreadyHereOn: { Checking: 1, Brokerage: 1 } } },
    );
    const plan = move(file, facts);
    expect(plan.problems).toEqual([
      {
        field: "move",
        message:
          "One of this file's transactions on \"Checking\" is already here, on another account, from a file brought in before. A move passes over a transaction already here, so an account brought in new would not hold it and could never come out at the file's balance. Add this file instead, which sends its transactions to Staged for review.",
        kind: "account",
        key: "Checking",
        count: 1,
      },
      expect.objectContaining({ field: "move", key: "Brokerage", count: 1 }),
    ]);
    // Said while renaming is the only answer left, before it is given.
    const differs = factsOf(
      { accounts: [accountLike(file, "Brokerage", { openingBalance: "1" })] },
      { rows: { alreadyHere: 1, alreadyHereOn: { Brokerage: 1 } } },
    );
    const asking = move(file, differs);
    expect(record(asking, "account", "Brokerage").choices).toEqual(["rename"]);
    expect(asking.problems.map((each) => each.field)).toEqual(["decisions", "move"]);
    expect(asking.problems[1]!.message).toContain(
      "an account brought in under another name would not hold it",
    );
    // An account here it uses holds them, as a resumed move's does.
    expect(
      move(
        file,
        factsOf(
          { accounts: [accountLike(file, "Brokerage", {})] },
          { rows: { alreadyHere: 1, alreadyHereOn: { Brokerage: 1 } } },
        ),
      ).ok,
    ).toBe(true);
    // Adding stages them for review, and is never refused for it.
    expect(add(file, facts).ok).toBe(true);
  });
});

describe("a file exported a date range at a time", () => {
  it("uses the account an earlier range brought, whose opening is the range's own", () => {
    const file = parsed(chosenAccounts());
    // Here from an earlier range: opened on its own day, which a range's
    // account never matches, since it opens on the range's first day.
    const facts = factsOf({ accounts: [accountLike(file, "Checking", { carriedForward: null })] });
    const checking = record(
      move(file, facts, { decisions: [{ kind: "account", key: "Brokerage", action: "create" }] }),
      "account",
      "Checking",
    );
    expect(checking.choices).toEqual(["use_existing", "rename"]);
    expect(checking.message).toContain(
      "This file starts partway through, so using the one here carries on from the earlier part of its history already in it, and the balance check at the end says whether all of that history is here.",
    );
    const used = move(file, facts, {
      decisions: [
        { kind: "account", key: "Checking", action: "use_existing" },
        { kind: "account", key: "Brokerage", action: "create" },
      ],
    });
    expect(used.ok).toBe(true);
    expect(used.move!.checks).toEqual([
      { key: "Checking", name: "Checking", currency: "EUR", balance: "2065.77", compared: true },
    ]);
    // A whole file still cannot use one that opens differently.
    const unranged = whole();
    expect(
      record(
        move(
          unranged,
          factsOf({ accounts: [accountLike(unranged, "Checking", { openingBalance: "1" })] }),
        ),
        "account",
        "Checking",
      ).choices,
    ).toEqual(["rename"]);
  });

  it("does not compare an account opening after the file's last day with money carried into it", () => {
    const json = chosenAccounts();
    const accounts = json["accounts"] as Json[];
    // Opens on 2026-07-01, after the file's last day, with 20 spent before the
    // range: that money arrives with its opening, after the day it is checked.
    accounts[0] = {
      ...accounts[0],
      openingDate: "2026-07-01",
      openingBalance: "100",
      carriedForward: { date: "2026-01-01", amount: "-20" },
      balance: "-1074.23",
    };
    const facts = factsOf();
    const decisions = [{ kind: "account" as const, key: "Brokerage", action: "create" as const }];
    expect(move(parsed(json), facts, { decisions }).move!.checks).toEqual([
      { key: "Checking", name: "Checking", currency: "EUR", balance: "-1074.23", compared: false },
    ]);
    // Nothing carried, nothing moved past the day: compared.
    accounts[0] = {
      ...accounts[0],
      carriedForward: { date: "2026-01-01", amount: "0" },
      balance: "-1054.23",
    };
    expect(move(parsed(json), facts, { decisions }).move!.checks[0]!.compared).toBe(true);
  });
});

describe("a question a move narrowed", () => {
  it("carries how many transactions name the record, as its sentence says", () => {
    const plan = move(parsed(without("categories")), factsOf());
    const groceries = plan.problems.find((each) => each.key === "Groceries")!;
    expect(groceries.message).toContain("of this file's transactions name it");
    expect(groceries.count).toBe(record(plan, "category", "Groceries").rows);
  });
});

describe("what an agent is told about moving", () => {
  it("says the preview plans a move as a whole file or its last part, and where moving fits", async () => {
    // The preview takes no part, so a part before the last is planned as the
    // last, which differs from the move only in the recurring transactions it
    // leaves for later: said where an agent reads movePlan, rather than left
    // for it to meet as a count it was not shown.
    expect(ledgerFilePreviewSchema.shape.movePlan.description).toContain(
      "as a whole file or the last part of one",
    );
    expect(ledgerFilePreviewSchema.shape.movePlan.description).toContain(
      "plan.move.recurrencesDeferred",
    );
    const server = createMcpServer(
      { userId: "move-texts", source: "mcp", clientId: "move-texts" },
      new Set(["ledger:read", "ledger:write"]),
    );
    const client = new Client({ name: "move-texts", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    const tool = (name: string) => tools.find((each) => each.name === name)!;
    // An agent that reads only the export learns the move exists, and how to
    // move a ledger larger than one call carries: oldest range first, into the
    // accounts the earlier ranges brought.
    expect(tool("export_ledger_file").description).toContain("`move_ledger_file` moves it");
    expect(tool("export_ledger_file").description).toContain("move them oldest first");
    expect(tool("move_ledger_file").description).toContain("oldest first");
    expect(tool("preview_ledger_file").title).toBe(
      "Preview adding or moving a Simple Balance file",
    );
    expect(tool("preview_ledger_file").description).toContain("recurrencesDeferred");
  });
});
