import {
  parseLedgerFile,
  parseLedgerFileText,
  type LedgerFile,
} from "../../src/shared/ledger-file.js";
import {
  ledgerFileAddResultSchema,
  ledgerFileFactsSchema,
  planLedgerFileAdd,
  type LedgerFileAddInput,
  type LedgerFileAddResult,
  type LedgerFileFacts,
} from "../../src/shared/ledger-file-import.js";
import { planLedgerFileMove } from "../../src/shared/ledger-file-move.js";
import { origin, wholeLedger } from "./ledger-file.js";

/**
 * What the ledger-file routes would read about a destination, for the tiers
 * that answer those routes themselves: the page's jsdom tests and its browser
 * specs. Both answer with the shared planner the server runs, so what a test
 * is answered with is what the server would say about the same ledger.
 */

type Json = Record<string, unknown>;
type Account = LedgerFile["accounts"][number];

export type Here = Partial<
  Pick<LedgerFile, "groups" | "categories" | "accounts" | "templates" | "recurrences" | "budgets">
>;
export type Settings = LedgerFileFacts["here"]["preferences"];

/** Settings nobody chose, which is where a new sign-up starts. */
const UNCHOSEN: Settings = {
  chosen: false,
  timezone: "UTC",
  defaultCurrency: "USD",
  theme: "system",
};

export function parsedLedger(json: Json): LedgerFile {
  const result = parseLedgerFile(json);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.file;
}

/** A destination holding `records`, each with an id of its own. */
export function factsOf(
  records: Here = {},
  options: { limit?: number | null; preferences?: Settings } = {},
): LedgerFileFacts {
  let next = 9000;
  const ids = <T extends { key: string }>(list: readonly T[] | undefined) =>
    Object.fromEntries((list ?? []).map((each) => [each.key, origin(next++)]));
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
      preferences: options.preferences ?? UNCHOSEN,
    },
    rows: { alreadyHere: 0, stagedAlreadyHere: 0 },
    move: { qualifies: false, reason: null },
  });
}

/** An account as a destination exports it: no balance check, since no entries come with it. */
export const unchecked = (each: Account): Account => {
  if (each.detail !== "full") return each;
  const { balance: _balance, ...rest } = each;
  return rest;
};

/** One of `wholeLedger`'s accounts, changed, as a destination holds it. */
export const accountLike = (key: string, change: Json): Account =>
  unchecked({
    ...parsedLedger(wholeLedger()).accounts.find((each) => each.key === key)!,
    ...change,
  } as Account);

/** An account of the destination's own, in use. */
export const ownAccount = (key: string, currency = "EUR"): Account => ({
  key,
  name: key,
  detail: "full",
  type: "checking",
  currency,
  openingDate: "2020-01-01",
  openingBalance: "0",
  institution: null,
  notes: null,
  inBudget: true,
  archivedAt: null,
  inUse: true,
});

/** The origins a part holds that are already here, as the preview counts them. */
export function rowsHere(part: LedgerFile, here: ReadonlySet<string>): LedgerFileFacts["rows"] {
  return {
    alreadyHere: part.entries.filter((entry) => !entry.deleted && here.has(entry.id)).length,
    stagedAlreadyHere: part.staged.filter((row) => here.has(row.id)).length,
    deletedAlreadyHere: part.entries.filter((entry) => entry.deleted && here.has(entry.id)).length,
    waiting: 0,
    alreadyHereOn: alreadyHereOn(part, here),
    heldHere: {},
  };
}

/** The live entries already here, by each of the part's accounts they name, as the preview counts them. */
export function alreadyHereOn(part: LedgerFile, here: ReadonlySet<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of part.entries) {
    if (entry.deleted || !here.has(entry.id)) continue;
    const sides =
      entry.type === "deposit"
        ? [entry.to]
        : entry.type === "withdrawal"
          ? [entry.from]
          : [entry.from, entry.to];
    for (const key of new Set(sides)) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** The preview's reply for one part: the facts, with that part's rows, and its own plan. */
export function previewFor(ledgerFile: string, facts: LedgerFileFacts, here: ReadonlySet<string>) {
  const read = parseLedgerFileText(ledgerFile);
  if (!read.ok) throw new Error("the page sent a file the reader refuses");
  const partFacts = { ...facts, rows: rowsHere(read.file, here) };
  return {
    ...partFacts,
    plan: planLedgerFileAdd({ file: read.file, facts: partFacts }).plan,
    movePlan: planLedgerFileMove({ file: read.file, facts: partFacts }).plan,
  };
}

/** What one part does, by the plan the server would carry out for it. */
export function resultFor(
  body: LedgerFileAddInput,
  facts: LedgerFileFacts,
  here: ReadonlySet<string> = new Set(),
  needsReview = 0,
): LedgerFileAddResult {
  const read = parseLedgerFileText(body.ledgerFile);
  if (!read.ok) throw new Error("unreadable part");
  const { plan } = planLedgerFileAdd({
    file: read.file,
    facts: { ...facts, rows: rowsHere(read.file, here) },
    decisions: body.decisions,
    arriveArchived: body.arriveArchived,
    preferences: body.preferences,
  });
  let made = 7000;
  return ledgerFileAddResultSchema.parse({
    part: body.part,
    importBatchId: plan.rows.toStage ? origin(5000 + body.part.index) : null,
    staged: plan.rows.toStage,
    needsReview,
    budgetEntries: {
      created: plan.counts.budget_entry.create,
      skipped: plan.counts.budget_entry.skip,
    },
    plan: {
      ...plan,
      records: plan.records.map((record) =>
        record.action === "create" ? { ...record, id: origin(made++) } : record,
      ),
    },
  });
}
