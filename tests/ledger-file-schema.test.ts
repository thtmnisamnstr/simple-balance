import { describe, expect, it } from "vitest";
import {
  LEDGER_FILE_FORMAT,
  MAX_LEDGER_FILE_ACCOUNT_CHOICES,
  assignLedgerKeys,
  defaultLedgerFileKinds,
  ledgerFileKinds,
  ledgerFileName,
  ledgerFileQueryString,
  ledgerFileRowCount,
  ledgerFileSelectionSchema,
  parseLedgerFile,
  parseLedgerFileQuery,
  parseLedgerFileText,
  serializeLedgerFile,
  type LedgerFile,
} from "../src/shared/ledger-file.js";
import { APP_VERSION } from "../src/shared/version.js";
import { chosenAccounts, origin, wholeLedger } from "./support/ledger-file.js";

/**
 * The Simple Balance file's own rules, one sentence each.
 *
 * The format is a published contract — every later release reads every token
 * ever published — so what it accepts and what it refuses is held here rather
 * than left to whoever reads `src/shared/ledger-file.ts` next. A refusal is
 * asserted by its sentence and its field, because the sentence is what a
 * person reads on the import page and the field is what tells them where.
 */

type Json = Record<string, unknown>;

/** A copy of `file` with the value at a dotted path replaced, or removed when `value` is omitted. */
function edit(file: Json, path: string, ...value: [unknown?]): Json {
  const copy = structuredClone(file);
  const keys = path.split(".");
  const last = keys.pop()!;
  let target: Record<string, unknown> = copy;
  for (const key of keys) target = target[key] as Record<string, unknown>;
  if (value.length) target[last] = value[0];
  else delete target[last];
  return copy;
}

function read(value: unknown): LedgerFile {
  const parsed = parseLedgerFile(value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues, null, 2));
  return parsed.file;
}

function refusals(value: unknown) {
  const parsed = parseLedgerFile(value);
  if (parsed.ok) throw new Error("the file was accepted");
  return parsed.issues;
}

/** The file written out and read back as text, the way an import meets it. */
function throughText(value: Json): LedgerFile {
  const parsed = parseLedgerFileText(serializeLedgerFile(read(value)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.file;
}

describe("a Simple Balance file", () => {
  it("reads a whole ledger and a chosen-accounts file", () => {
    expect(read(wholeLedger()).entries).toHaveLength(6);
    expect(read(chosenAccounts()).accounts.map((account) => account.detail)).toEqual([
      "full",
      "reference",
    ]);
  });

  /**
   * Parse, write, parse: the same file both times, and the same bytes the
   * second time it is written. The second half is the one that matters for a
   * person diffing two exports of an unchanged ledger.
   */
  it("survives a round trip unchanged, to the byte", () => {
    for (const source of [wholeLedger(), chosenAccounts()]) {
      const first = read(source);
      const text = serializeLedgerFile(first);
      const again = parseLedgerFileText(text);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.file).toEqual(first);
      expect(serializeLedgerFile(again.file)).toBe(text);
    }
  });

  it("keeps what a round trip could plausibly lose", () => {
    const file = throughText(wholeLedger());
    const byId = new Map(file.entries.map((entry) => [entry.id, entry]));
    expect(byId.get(origin(3))).toMatchObject({
      legs: [
        { category: "Groceries", amount: "60.00" },
        { category: "Household", amount: "15.00", note: "bulbs" },
        { category: null, amount: "5.00" },
      ],
    });
    expect(byId.get(origin(2))).toMatchObject({
      sourceAmount: "1000.00",
      destinationAmount: "1081.40",
    });
    expect(byId.get(origin(4))).toMatchObject({ postedAs: "expense", externalId: "BANK-REF-77" });
    expect(byId.get(origin(5))).toMatchObject({ deleted: true, template: "Coffee" });
    expect(file.accounts[1]).toMatchObject({ notes: "Long-term only.\nDo not touch." });
    expect(file.accounts[2]).toMatchObject({
      openingBalance: "-120.50",
      archivedAt: "2024-12-31T23:00:00.000Z",
    });
    expect(file.templates[0]).toMatchObject({ notification: { lastNotifiedDate: "2026-10-01" } });
    expect(file.recurrences[0]).toMatchObject({ lastOccurrenceDate: "2026-09-30" });
    expect(file.staged[0]).toMatchObject({
      draft: { amount: "12,50 €", payee: "Bäckerei Müller" },
      rawData: { Empfänger: "Bäckerei Müller" },
    });
    expect(file.history).toHaveLength(1);
  });

  /**
   * One record per line is the layout, and it is what makes the file usable in
   * an editor: search for a payee, land on the whole entry.
   */
  it("writes the top level indented and every record on a line of its own", () => {
    const text = serializeLedgerFile(read(wholeLedger()));
    const lines = text.split("\n");
    expect(lines[0]).toBe("{");
    expect(lines[1]).toBe(`  "format": "${LEDGER_FILE_FORMAT}",`);
    expect(text.endsWith("}\n")).toBe(true);
    const opens = lines.indexOf('  "entries": [');
    const entryLines = lines.slice(opens + 1, lines.indexOf("  ],", opens));
    expect(entryLines).toHaveLength(6);
    for (const line of entryLines) expect(line.startsWith('    {"id":')).toBe(true);
    for (const line of entryLines) expect(() => JSON.parse(line.replace(/,$/, ""))).not.toThrow();
    expect(lines).toContain('  "budgets": {');
    expect(lines.filter((line) => line.startsWith('      {"category":'))).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith('      {"group":'))).toHaveLength(1);
  });

  it("orders entries by date and then origin, whatever order they arrived in", () => {
    const shuffled = wholeLedger();
    (shuffled.entries as Json[]).reverse();
    const file = read(shuffled);
    expect(file.entries.map((entry) => entry.id)).toEqual([
      origin(5),
      origin(6),
      origin(1),
      origin(2),
      origin(3),
      origin(4),
    ]);
    const written = serializeLedgerFile({ ...file, entries: [...file.entries].reverse() });
    expect(written).toBe(serializeLedgerFile(file));
  });

  it("counts the rows a part is capped at: entries, staged rows and budget amounts", () => {
    expect(ledgerFileRowCount(read(wholeLedger()))).toBe(6 + 2 + 1);
  });
});

describe("a JSON number where money goes", () => {
  const sentence = expect.stringContaining('every amount as a decimal string, such as "12.50"');

  it.each([
    ["accounts.0.openingBalance", 1520.33],
    ["accounts.0.balance", 1301.11],
    ["entries.0.amount", 54.23],
    ["entries.1.sourceAmount", 1000],
    ["entries.1.destinationAmount", 1081.4],
    ["entries.2.legs.0.amount", 60],
    ["templates.0.draft.amount", 1200],
    ["templates.1.draft.legs.0.amount", 3],
    ["recurrences.0.shape.amount", 3100],
    ["recurrences.1.shape.destinationAmount", 108.14],
    ["budgets.plans.0.amount", 400],
    ["budgets.plans.0.rolloverCap", 200],
    ["budgets.entries.0.amount", 550],
    ["staged.0.draft.amount", 12.5],
    ["staged.1.draft.sourceAmount", 50],
  ])("is refused at %s with the sentence, never rounded", (path, number) => {
    expect(refusals(edit(wholeLedger(), path, number))).toEqual([
      { field: path, message: sentence },
    ]);
  });

  it("is refused in a carried-forward balance too", () => {
    expect(refusals(edit(chosenAccounts(), "accounts.0.carriedForward.amount", 3120))).toEqual([
      { field: "accounts.0.carriedForward.amount", message: sentence },
    ]);
  });

  /**
   * A staged row may be wrong in every other way, because the queue is where
   * a wrong row goes to be fixed. A number is still refused, for the same
   * reason as everywhere else: it is already rounded by the time it is read.
   */
  it("is the one thing a staged row's amount may not be", () => {
    const file = read(edit(wholeLedger(), "staged.0.draft.amount", "not a number yet"));
    expect(file.staged[0]).toMatchObject({ draft: { amount: "not a number yet" } });
  });

  it("is summarized rather than listed past fifty", () => {
    const file = wholeLedger();
    file.entries = Array.from({ length: 60 }, (_, index) => ({
      id: origin(1000 + index),
      type: "withdrawal",
      date: "2026-10-02",
      from: "Checking",
      amount: index + 0.5,
      payee: "Rewe",
    }));
    const issues = refusals(file);
    expect(issues).toHaveLength(51);
    expect(issues.at(-1)).toEqual({ field: "", message: "There are 10 more problems like these." });
  });
});

describe("the format token", () => {
  it("names a newer format and says to upgrade", () => {
    expect(refusals(edit(wholeLedger(), "format", "simple-balance-ledger-2"))).toEqual([
      {
        field: "format",
        message:
          "This file was made by a newer Simple Balance (simple-balance-ledger-2). Upgrade this copy to import it.",
      },
    ]);
  });

  it.each([
    ["the CSV token", "simple-balance-csv-1"],
    ["no token at all", undefined],
    ["a token from nowhere", "ledger"],
    ["a version that was never published", "simple-balance-ledger-0"],
  ])("refuses %s as not a Simple Balance file", (_, format) => {
    const file =
      format === undefined ? edit(wholeLedger(), "format") : edit(wholeLedger(), "format", format);
    expect(refusals(file)).toEqual([
      {
        field: "format",
        message: `This is not a Simple Balance file: it does not say it is one. A Simple Balance file starts with "format": "${LEDGER_FILE_FORMAT}".`,
      },
    ]);
  });

  it("refuses text that is not JSON with a sentence naming the likely mistakes", () => {
    expect(parseLedgerFileText("date,payee,amount\n2026-10-02,Rewe,54.23\n")).toEqual({
      ok: false,
      issues: [{ field: "", message: expect.stringContaining("could not be read as JSON") }],
    });
    expect(parseLedgerFileText('{"format": "simple-balance-ledger-1", "entries": [')).toMatchObject(
      { ok: false, issues: [{ message: expect.stringContaining("cut short") }] },
    );
    expect(parseLedgerFile([1, 2, 3])).toMatchObject({ ok: false, issues: [{ field: "format" }] });
  });
});

describe("a field the format has no place for", () => {
  it("is refused by name, at any depth", () => {
    expect(refusals(edit(wholeLedger(), "entries.0.rate", "1.08"))).toEqual([
      {
        field: "entries.0",
        message: `"rate" is not part of a Simple Balance file (${LEDGER_FILE_FORMAT}).`,
      },
    ]);
  });

  /**
   * A staged draft keeps whatever keys it is given in the queue, and one of
   * them could be a uuid from the ledger it came from. The file never carries
   * one, so the strict draft refuses the id fields an exporter might forget to
   * translate.
   */
  it("includes a uuid reference left untranslated in a staged draft", () => {
    expect(refusals(edit(wholeLedger(), "staged.0.draft.fromAccountId", origin(9)))).toEqual([
      {
        field: "staged.0.draft",
        message: expect.stringContaining('"fromAccountId" is not part of'),
      },
    ]);
  });

  /**
   * A later release may add an optional field under this same token, which
   * this copy refuses. The refusal is right; the remedy it names has to be an
   * upgrade, or a file from a newer copy reads as a damaged one.
   */
  it("says to upgrade when the file comes from a newer release", () => {
    const newer = edit(edit(wholeLedger(), "producer.version", "9.0.0"), "entries.0.mood", "happy");
    const issues = refusals(newer);
    expect(issues[0]).toEqual({
      field: "producer.version",
      message: `This file was made by Simple Balance 9.0.0, which is newer than this copy (${APP_VERSION}), and it holds something this copy cannot read. Upgrade this copy to import it.`,
    });
    expect(issues[1]?.message).toContain('"mood" is not part of');
    // From this release or an older one, the field is simply not part of the format.
    expect(refusals(edit(wholeLedger(), "entries.0.mood", "happy"))).toHaveLength(1);
  });

  it("reports a missing field as missing and an unknown type as unknown", () => {
    expect(refusals(edit(wholeLedger(), "entries.0.payee"))).toEqual([
      { field: "entries.0.payee", message: "This is missing." },
    ]);
    expect(refusals(edit(wholeLedger(), "entries.0.type", "refund"))).toEqual([
      { field: "entries.0.type", message: "This type is not one a Simple Balance file knows." },
    ]);
    expect(refusals(edit(wholeLedger(), "accounts.0.detail", "partial"))).toEqual([
      {
        field: "accounts.0.detail",
        message: "This detail is not one a Simple Balance file knows.",
      },
    ]);
  });

  it("does not stop the activity history carrying a field this copy never logged", () => {
    const file = read(edit(wholeLedger(), "history.0.clientId", "agent-7"));
    expect(file.history?.[0]).toMatchObject({ clientId: "agent-7" });
  });
});

describe("a reference", () => {
  it.each([
    ["entries.0.from", "account"],
    ["entries.1.to", "account"],
    ["entries.0.category", "category"],
    ["entries.2.legs.1.category", "category"],
    ["entries.4.template", "template"],
    ["categories.0.group", "category group"],
    ["templates.0.draft.from", "account"],
    ["templates.0.draft.category", "category"],
    ["templates.1.draft.legs.0.category", "category"],
    ["recurrences.0.shape.to", "account"],
    ["recurrences.1.shape.from", "account"],
    ["recurrences.0.shape.category", "category"],
    ["budgets.plans.0.category", "category"],
    ["budgets.plans.1.group", "category group"],
    ["budgets.entries.0.category", "category"],
    ["staged.0.draft.from", "account"],
    ["staged.1.draft.to", "account"],
  ])("to a key nothing in the file has is refused at %s", (path, label) => {
    expect(refusals(edit(wholeLedger(), path, "Nowhere"))).toEqual([
      { field: path, message: `No ${label} in this file has the key "Nowhere".` },
    ]);
  });

  /**
   * Keys match exactly. They are unique once folded, so an import maps each
   * to one record either way, but a key that only folds onto another is a file
   * somebody edited by hand, and guessing what they meant is the import's
   * job, not the reader's.
   */
  it("matches a key exactly rather than by its folded form", () => {
    expect(refusals(edit(wholeLedger(), "entries.0.from", "checking"))).toEqual([
      { field: "entries.0.from", message: 'No account in this file has the key "checking".' },
    ]);
  });

  it("may name a record that travels only as a reference", () => {
    expect(read(chosenAccounts()).entries[1]).toMatchObject({ to: "Brokerage" });
  });
});

describe("a key", () => {
  it.each([
    [
      "accounts",
      "account",
      {
        key: " checking ",
        name: "Checking 2",
        detail: "reference",
        type: "savings",
        currency: "EUR",
      },
    ],
    [
      "categories",
      "category",
      {
        key: "GROCERIES",
        name: "Groceries",
        detail: "full",
        kind: "expense",
        group: null,
        archivedAt: null,
      },
    ],
    [
      "groups",
      "category group",
      { key: "home", name: "home", detail: "full", policy: "standalone" },
    ],
  ])("is unique among the %s once case and spacing are set aside", (section, label, record) => {
    const file = wholeLedger();
    (file[section] as Json[]).push(record);
    // A reference among whole accounts is a scope problem as well; the key is
    // the problem this case is about, so it looks for that one.
    expect(refusals(file)).toContainEqual({
      field: `${section}.${(file[section] as Json[]).length - 1}.key`,
      message: expect.stringContaining(`Another ${label} in this file already has the key`),
    });
  });

  it("is never blank", () => {
    expect(refusals(edit(wholeLedger(), "groups.0.key", "   "))).toContainEqual({
      field: "groups.0.key",
      message: "A key cannot be blank",
    });
  });

  /**
   * An older ledger can hold two names that fold together. The exporter gives
   * the second a suffix and keeps its name, and a suffix never takes a name
   * that somebody actually used.
   */
  it("is assigned with a suffix only where names fold together", () => {
    expect(assignLedgerKeys(["Checking", "checking", "Checking (2)", "Savings"])).toEqual([
      "Checking",
      "checking (3)",
      "Checking (2)",
      "Savings",
    ]);
    expect(assignLedgerKeys(["Café", "CAFÉ", "Ｃａｆé"])).toEqual([
      "Café",
      "CAFÉ (2)",
      "Ｃａｆé (3)",
    ]);
    const keys = assignLedgerKeys(["A", "a", "A ", "a (2)"]);
    expect(new Set(keys.map((key) => key.trim().toLowerCase())).size).toBe(4);
  });
});

describe("an origin", () => {
  it("names one entry", () => {
    expect(refusals(edit(wholeLedger(), "entries.1.id", origin(1)))).toContainEqual({
      field: expect.stringMatching(/^entries\.\d\.id$/),
      message: `An entry in this file already has the id ${origin(1)}. An id names one entry.`,
    });
  });

  it("is one identity across the books and the queue", () => {
    expect(refusals(edit(wholeLedger(), "staged.0.id", origin(1)))).toEqual([
      {
        field: "staged.0.id",
        message: `An entry in this file already has the id ${origin(1)}. An id names one entry.`,
      },
    ]);
  });

  it("is a uuid", () => {
    expect(refusals(edit(wholeLedger(), "entries.0.id", "42"))[0]?.field).toBe("entries.0.id");
  });
});

describe("an entry", () => {
  it("is filed under a category or split into legs, not both", () => {
    expect(refusals(edit(wholeLedger(), "entries.2.category", "Groceries"))).toEqual([
      {
        field: "entries.2.legs",
        message: "An entry is filed under one category or split into legs, not both.",
      },
    ]);
  });

  it("carries both amounts when it is a transfer, and no legs", () => {
    expect(refusals(edit(wholeLedger(), "entries.1.destinationAmount"))).toEqual([
      { field: "entries.1.destinationAmount", message: "This is missing." },
    ]);
    expect(refusals(edit(wholeLedger(), "entries.1.legs", []))[0]?.message).toContain(
      '"legs" is not part of',
    );
  });

  it("says postedAs only on a deposit or a withdrawal, and only income or expense", () => {
    expect(refusals(edit(wholeLedger(), "entries.1.postedAs", "income"))[0]?.message).toContain(
      '"postedAs" is not part of',
    );
    expect(refusals(edit(wholeLedger(), "entries.3.postedAs", "equity"))[0]?.field).toBe(
      "entries.3.postedAs",
    );
  });

  it("is deleted only as `true`, never as `false`", () => {
    expect(refusals(edit(wholeLedger(), "entries.0.deleted", false))[0]?.field).toBe(
      "entries.0.deleted",
    );
  });
});

describe("a budget", () => {
  it("is about a category or a group, exactly one", () => {
    expect(refusals(edit(wholeLedger(), "budgets.plans.0.group", "Home"))).toEqual([
      {
        field: "budgets.plans.0.category",
        message: "A budget is about a category or a group. Name exactly one.",
      },
    ]);
    expect(refusals(edit(wholeLedger(), "budgets.entries.0.category"))[0]?.message).toBe(
      "A budget is about a category or a group. Name exactly one.",
    );
  });

  it("has one plan per budget and start, and one amount per budget and period", () => {
    const file = wholeLedger();
    const budgets = file.budgets as { plans: Json[]; entries: Json[] };
    budgets.plans.push({ ...budgets.plans[0], amount: "500.00" });
    budgets.entries.push({ ...budgets.entries[0], amount: "1.00" });
    expect(refusals(file)).toEqual([
      {
        field: "budgets.plans.2",
        message: "This file already has a plan for this budget and period.",
      },
      {
        field: "budgets.entries.1",
        message: "This file already has an amount for this budget and period.",
      },
    ]);
  });
});

describe("the scope", () => {
  const without = (kind: string) => {
    const file = wholeLedger();
    const scope = file.scope as { kinds: string[] };
    scope.kinds = scope.kinds.filter((each) => each !== kind);
    return file;
  };

  it.each([
    ["budgets", "budgets", "This file's scope leaves budgets out, so it cannot carry any."],
    ["staged", "staged", "This file's scope leaves staged rows out, so it cannot carry any."],
    [
      "recurrences",
      "recurrences",
      "This file's scope leaves recurring transactions out, so it cannot carry any.",
    ],
    [
      "history",
      "history",
      "This file's scope leaves the activity history out, so it cannot carry any.",
    ],
    [
      "preferences",
      "preferences",
      "This file's scope leaves settings out, so it cannot carry any.",
    ],
  ])("refuses %s it says it left out", (kind, field, message) => {
    expect(refusals(without(kind))).toEqual([{ field, message }]);
  });

  it("carries a deleted entry only when it says it does", () => {
    expect(refusals(without("deletedEntries"))).toEqual([
      {
        field: "entries.4.deleted",
        message: "This file's scope leaves deleted entries out, so it cannot carry one.",
      },
    ]);
  });

  it("carries whole only the kinds it exported, and only references of the rest", () => {
    expect(refusals(without("templates")).map((issue) => issue.field)).toEqual([
      "templates.0.detail",
      "templates.1.detail",
    ]);
    const referenced = edit(wholeLedger(), "templates.1", {
      key: "Coffee",
      name: "Coffee",
      detail: "reference",
    });
    expect(refusals(referenced)).toEqual([
      {
        field: "templates.1.detail",
        message: "This file exports templates whole, so none of them is a reference.",
      },
    ]);
    expect(refusals(edit(chosenAccounts(), "scope.accounts", "all"))).toContainEqual({
      field: "accounts.1.detail",
      message: "This file exports every account whole, so none of them is a reference.",
    });
  });

  it("keeps a file of chosen accounts to accounts, categories and entries", () => {
    const kinds = ["accounts", "categories", "entries", "budgets"];
    expect(refusals(edit(chosenAccounts(), "scope.kinds", kinds))).toEqual([
      {
        field: "scope.kinds",
        message: "A file of chosen accounts carries accounts, categories and entries, not budgets.",
      },
    ]);
  });

  it("holds a ranged file's entries inside its range", () => {
    expect(refusals(edit(chosenAccounts(), "entries.1.date", "2026-07-01"))).toEqual([
      {
        field: "entries.1.date",
        message: "This entry is dated outside the range the file says it covers.",
      },
    ]);
  });

  /**
   * The balance check at the end of a ranged file describes the money the
   * file carried. Every account has to come into the range at what it held the
   * day before, or the check describes money that never moved — and that holds
   * for an account opened inside the range too, because an entry can be dated
   * before the account it is on was opened, and the reader cannot tell.
   */
  it("needs a carried-forward balance on every whole account of a ranged file", () => {
    expect(refusals(edit(chosenAccounts(), "accounts.0.carriedForward", null))).toEqual([
      {
        field: "accounts.0.carriedForward",
        message:
          "An account in a file whose entries start partway through needs the balance it carried into the range.",
      },
    ]);
    const openedInside = edit(chosenAccounts(), "accounts.0.openingDate", "2026-03-01");
    expect(read(openedInside).accounts[0]).toMatchObject({
      carriedForward: { date: "2026-01-01", amount: "3120.00" },
    });
    expect(refusals(edit(openedInside, "accounts.0.carriedForward", null))).toEqual([
      {
        field: "accounts.0.carriedForward",
        message:
          "An account in a file whose entries start partway through needs the balance it carried into the range.",
      },
    ]);
    expect(
      refusals(edit(chosenAccounts(), "accounts.0.carriedForward.date", "2025-12-31")),
    ).toEqual([
      {
        field: "accounts.0.carriedForward.date",
        message: "A balance is carried forward to the first day of the range.",
      },
    ]);
    const unranged = edit(edit(chosenAccounts(), "scope.start", null), "scope.end", null);
    expect(refusals(edit(unranged, "throughDate", "2026-10-25"))).toEqual([
      {
        field: "accounts.0.carriedForward",
        message: "Only a file whose entries start partway through carries a balance forward.",
      },
    ]);
  });

  /**
   * A range that starts after the day the checks describe — somebody moving
   * the entries they have scheduled — has nothing to check yet: an account
   * rebuilt from it opens on the first day and holds nothing before then. The
   * bound is the first day itself, because a copy opened on it holds nothing
   * the day before either.
   */
  it("checks no balance on a day before the range starts", () => {
    const early = edit(chosenAccounts(), "throughDate", "2025-12-31");
    expect(refusals(early)).toEqual([
      {
        field: "accounts.0.balance",
        message: "A range that starts after the balance check's day has no balance to check yet.",
      },
    ]);
    expect(read(edit(early, "accounts.0.balance")).throughDate).toBe("2025-12-31");
    expect(read(edit(chosenAccounts(), "throughDate", "2026-01-01")).throughDate).toBe(
      "2026-01-01",
    );
  });

  /**
   * The history is narrowed by the range as well, by the day each event
   * happened where the person lives, so a range needs one of the two things it
   * narrows and the history alone will do.
   */
  it("takes a range that narrows the activity history alone", () => {
    const historyOnly = {
      ...wholeLedger(),
      scope: { kinds: ["history"], accounts: "all", start: "2026-03-01", end: "2026-03-31" },
      throughDate: "2026-03-31",
      preferences: null,
      groups: [],
      categories: [],
      accounts: [],
      templates: [],
      recurrences: [],
      budgets: { plans: [], entries: [] },
      entries: [],
      staged: [],
    };
    expect(read(historyOnly).scope.start).toBe("2026-03-01");
    expect(refusals(edit(historyOnly, "scope.kinds", ["preferences"]))).toContainEqual({
      field: "scope.start",
      message:
        "A date range narrows the entries and the activity history, so a scope with one names one of them.",
    });
  });

  it("describes a balance no later than the range's last day", () => {
    expect(refusals(edit(chosenAccounts(), "throughDate", "2026-07-01"))).toEqual([
      {
        field: "throughDate",
        message: "The balance checks cannot describe a day after the range ends.",
      },
    ]);
  });
});

describe("a reminder's watermark", () => {
  it("is a date when it is there", () => {
    const file = edit(wholeLedger(), "templates.0.notification.lastNotifiedDate", "last week");
    expect(refusals(file)).toEqual([
      {
        field: "templates.0.notification.lastNotifiedDate",
        message: "Use YYYY-MM-DD",
      },
    ]);
  });
});

describe("an export's selection", () => {
  const ok = (value: unknown) => ledgerFileSelectionSchema.safeParse(value).success;
  const messages = (value: unknown) => {
    const parsed = ledgerFileSelectionSchema.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it("starts from every kind but the history", () => {
    expect(defaultLedgerFileKinds).toEqual(ledgerFileKinds.filter((kind) => kind !== "history"));
    expect(ok({ kinds: defaultLedgerFileKinds })).toBe(true);
  });

  it("expresses each of the page's three account choices", () => {
    const accountIds = [origin(1), origin(2)];
    expect(ok({ kinds: ["accounts"], accountIds })).toBe(true);
    expect(ok({ kinds: ["accounts", "categories", "entries", "deletedEntries"], accountIds })).toBe(
      true,
    );
    const ranged = { start: "2026-01-01", end: "2026-06-30" };
    expect(ok({ kinds: ["accounts", "categories", "entries"], accountIds, ...ranged })).toBe(true);
  });

  it("narrows the activity history by a range, with or without the entries", () => {
    const ranged = { start: "2026-01-01", end: "2026-06-30" };
    expect(ok({ kinds: ["history"], ...ranged })).toBe(true);
    expect(ok({ kinds: ["accounts", "history"], start: "2026-01-01" })).toBe(true);
  });

  it.each([
    [{ kinds: [] }, "Choose at least one kind of record to export"],
    [{ kinds: ["entries", "entries"] }, "Name each kind of record once"],
    [
      { kinds: ["deletedEntries"] },
      "Deleted entries travel with the entries, so ask for entries too",
    ],
    [
      { kinds: ["accounts"], start: "2026-01-01" },
      "A date range narrows the entries and the activity history, so ask for one of them",
    ],
    [
      { kinds: ["entries"], start: "2026-02-01", end: "2026-01-01" },
      "The range cannot end before it starts",
    ],
    [
      { kinds: ["entries"], accountIds: [origin(1)] },
      "Exporting chosen accounts needs accounts in kinds",
    ],
    [
      { kinds: ["accounts", "templates"], accountIds: [origin(1)] },
      "Chosen accounts travel with their categories and entries; templates travel with an export of everything",
    ],
    [{ kinds: ["accounts"], accountIds: [origin(1), origin(1)] }, "Choose each account once"],
  ])("refuses %j with its sentence", (selection, message) => {
    expect(messages(selection)).toContain(message);
  });

  /**
   * The chosen ids travel in a `GET` query string, and the bundled nginx reads
   * a request line into 8 KiB. The cap is what keeps the longest selection the
   * page can make inside that, with room for a proxy to prefix the path.
   */
  it("names at most as many accounts as fit comfortably in a request line", () => {
    const accountIds = Array.from({ length: MAX_LEDGER_FILE_ACCOUNT_CHOICES + 1 }, (_, n) =>
      origin(n),
    );
    expect(messages({ kinds: ["accounts"], accountIds })).toEqual([
      "Choose at most 100 accounts, or leave them out to export every one",
    ]);
    const longest = ledgerFileQueryString({
      kinds: ["accounts", "categories", "entries", "deletedEntries"],
      accountIds: accountIds.slice(1),
      start: "2026-01-01",
      end: "2026-12-31",
    });
    expect(ok(parseLedgerFileQuery(Object.fromEntries(new URLSearchParams(longest))))).toBe(true);
    expect(`GET /api/v1/ledger-file?${longest} HTTP/1.1`.length).toBeLessThan(4 * 1024);
  });

  it("survives the query string the export route reads", () => {
    const selection = {
      kinds: ledgerFileKinds.filter((kind) => ["accounts", "categories", "entries"].includes(kind)),
      accountIds: [origin(1), origin(2)],
      start: "2026-01-01",
      end: "2026-06-30",
    };
    const query = Object.fromEntries(new URLSearchParams(ledgerFileQueryString(selection)));
    expect(query.kinds).toBe("categories,accounts,entries");
    expect(ledgerFileSelectionSchema.parse(parseLedgerFileQuery(query))).toEqual(selection);
  });

  it("refuses a query parameter nobody defined rather than ignoring it", () => {
    const query = parseLedgerFileQuery({ kinds: "entries", accountId: origin(1) });
    const parsed = ledgerFileSelectionSchema.safeParse(query);
    expect(parsed.error?.issues[0]).toMatchObject({
      code: "unrecognized_keys",
      keys: ["accountId"],
    });
  });

  it("names the file by the day and by what it holds", () => {
    expect(ledgerFileName("2026-10-25", "all")).toBe("simple-balance-2026-10-25.json");
    expect(ledgerFileName("2026-10-25", "chosen")).toBe("simple-balance-accounts-2026-10-25.json");
  });
});
