import { parseLedgerFileText } from "../../src/shared/ledger-file.js";
import {
  LEDGER_FILE_MOVE_BLOCKED,
  planLedgerFileAdd,
  type LedgerFileFacts,
} from "../../src/shared/ledger-file-import.js";
import {
  ledgerFileMoveResultSchema,
  planLedgerFileMove,
  type LedgerFileMoveInput,
  type LedgerFileMoveResult,
} from "../../src/shared/ledger-file-move.js";
import { origin } from "./ledger-file.js";
import { alreadyHereOn, rowsHere } from "./ledger-file-facts.js";

/**
 * The move route's half of what `ledger-file-facts.ts` does for the add: a
 * destination that may take a move, and what one part of a move does, worked
 * out by the shared planner the server runs, for the tiers that answer the
 * routes themselves.
 */

/** The same destination, holding nothing that did not come from a Simple Balance file. */
export const qualifying = (facts: LedgerFileFacts): LedgerFileFacts => ({
  ...facts,
  move: { qualifies: true, reason: null },
});

/** The same destination once somebody has typed a transaction into it, as the server says so. */
export const typedInto = (facts: LedgerFileFacts): LedgerFileFacts => ({
  ...facts,
  move: { qualifies: false, reason: LEDGER_FILE_MOVE_BLOCKED },
});

/**
 * The preview's reply for one part, where `waiting` are origins still sitting
 * in Staged from an earlier add: found by origin, so counted as here, and
 * counted as waiting too, which is what refuses a move.
 */
export function movePreviewFor(
  ledgerFile: string,
  facts: LedgerFileFacts,
  here: ReadonlySet<string>,
  waiting: ReadonlySet<string> = new Set(),
) {
  const read = parseLedgerFileText(ledgerFile);
  if (!read.ok) throw new Error("the page sent a file the reader refuses");
  const found = new Set([...here, ...waiting]);
  const rows = {
    ...rowsHere(read.file, found),
    waiting: read.file.entries.filter((entry) => waiting.has(entry.id)).length,
    // On an account here only once it is a transaction rather than a row
    // still waiting in Staged, as the server counts them.
    alreadyHereOn: alreadyHereOn(read.file, here),
    // What the accounts here hold is the destination's, given whole.
    heldHere: facts.rows.heldHere,
  };
  const partFacts = { ...facts, rows };
  return {
    ...partFacts,
    plan: planLedgerFileAdd({ file: read.file, facts: partFacts }).plan,
    movePlan: planLedgerFileMove({ file: read.file, facts: partFacts }).plan,
  };
}

/** What one part of a move does, by the plan the server would carry out for it. */
export function moveResultFor(
  body: LedgerFileMoveInput,
  facts: LedgerFileFacts,
  here: ReadonlySet<string> = new Set(),
  needsReview = 0,
): LedgerFileMoveResult {
  const read = parseLedgerFileText(body.ledgerFile);
  if (!read.ok) throw new Error("unreadable part");
  const rows = rowsHere(read.file, here);
  const { plan } = planLedgerFileMove({
    file: read.file,
    facts: { ...facts, rows },
    decisions: body.decisions,
    arriveArchived: body.arriveArchived,
    preferences: body.preferences,
    part: body.part,
  });
  const move = plan.move!;
  let made = 7000;
  return ledgerFileMoveResultSchema.parse({
    part: body.part,
    written: { entries: move.toWrite, deleted: move.toVoid },
    skipped: {
      entries: rows.alreadyHere,
      deleted: rows.deletedAlreadyHere,
      staged: rows.stagedAlreadyHere,
    },
    importBatchId: plan.rows.toStage ? origin(5000 + body.part.index) : null,
    staged: plan.rows.toStage,
    needsReview,
    budgetEntries: {
      created: plan.counts.budget_entry.create,
      skipped: plan.counts.budget_entry.skip,
    },
    archived: plan.records.filter(
      (record) => record.kind === "account" && record.action === "create" && record.arrivesArchived,
    ).length,
    balances: move.checks.length
      ? {
          checked: move.checks.filter((check) => check.compared).length,
          notCompared: move.checks.filter((check) => !check.compared).length,
        }
      : null,
    plan: {
      ...plan,
      records: plan.records.map((record) =>
        record.action === "create" ? { ...record, id: origin(made++) } : record,
      ),
    },
  });
}
