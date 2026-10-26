/**
 * Moving a Simple Balance file straight into the books: the request, the
 * reply, and the few rules a move needs beside the plan it shares with adding.
 *
 * Shared for the reason the plan is: the page shows what a move will write and
 * what it will be held to, and the server refuses with the same sentences.
 * What a file's records become is `planLedgerFileMove`, which is the add's
 * planner told it is a move (`src/shared/ledger-file-import.ts`), so a resumed
 * move finds what its earlier parts made exactly as a second add would.
 *
 * **Only into a ledger that holds nothing else.** A move is offered while every
 * entry, deleted or not, and every row waiting in Staged came from a Simple
 * Balance file — a new sign-up, a fresh install, a ledger part-way through a
 * move. Outside data reaches the books through the review queue; a move is not
 * outside data, because every transaction in it was reviewed and committed
 * once already, in the ledger it is leaving.
 *
 * **What it writes, it writes through the services a person's own writes use.**
 * Postings are posted, never copied, and a transaction's other half lands
 * where `resolveEntrySide` puts it from the categories here; where that is not
 * where it landed in the file, the difference is reported (`plan.move.drift`)
 * and never reproduced. That is also why a transaction is held to the file's
 * balances only after it is written: the figure is the file's, the arithmetic
 * is this ledger's own.
 */
import { z } from "zod";
import {
  addDecimalText,
  canonicalDecimalText,
  ledgerEntryDraft,
  ledgerEntryLabel,
  ledgerFileAddInputSchema,
  ledgerFilePlanSchema,
  LEDGER_RAW_FIGURES,
  planLedgerFileAdd,
  type LedgerBalanceCheck,
  type LedgerFigures,
  type LedgerFilePlanInput,
  type LedgerFilePlanned,
  type LedgerRefResolver,
  type LedgerReferenceKind,
} from "./ledger-file-import.js";
import { type LedgerFile, type LedgerFileEntry } from "./ledger-file.js";
import { uuid } from "./domain.js";

/**
 * Moving one part of a file into this ledger: the add's request, field for
 * field, because the person decides exactly the same things — and described
 * for a move, because a field's description is what an agent reads.
 *
 * There is no `dryRun`. A part is atomic, so a move that would fail writes
 * nothing, which is everything a rehearsal could say; and the one thing only
 * writing can tell — whether the balances come out — is checked by the last
 * part, which no rehearsal of it could check before the parts ahead of it are
 * in.
 */
export const ledgerFileMoveInputSchema = ledgerFileAddInputSchema.extend({
  fileName: ledgerFileAddInputSchema.shape.fileName.describe(
    "What the file was called. Recorded on the import batch the file's own staged rows go under, so somebody can tell one import from another later.",
  ),
  part: ledgerFileAddInputSchema.shape.part.describe(
    "Which part of the file this is. Left out, the file is one part. Send the parts in order: each is written all at once, the last one carries the balances every account is held to, and the recurring transactions are created by the last one.",
  ),
  decisions: ledgerFileAddInputSchema.shape.decisions.describe(
    "What to do with each record movePlan in preview_ledger_file says needs a decision. A move offers fewer choices than an add: an account or category the file's transactions name has to come in.",
  ),
  arriveArchived: ledgerFileAddInputSchema.shape.arriveArchived.describe(
    "Keys of new accounts to create archived, so they use no place on a plan that limits how many accounts are in use. Needed when the preview says more accounts are coming than there are places; none is chosen for you. Their transactions are written into them, and they hold nothing from the day of the move; restoring one into a free place posts its balance back. Accounts archived where the file came from arrive archived anyway, holding nothing from the day they were archived there.",
  ),
});
export type LedgerFileMoveInput = z.infer<typeof ledgerFileMoveInputSchema>;

const count = () => z.number().int().nonnegative();

export const ledgerFileMoveResultSchema = z
  .object({
    part: z.object({ index: z.number().int(), count: z.number().int() }).strict(),
    written: z
      .object({
        entries: count().describe("Transactions this part wrote straight into the books."),
        deleted: count().describe(
          "Deleted transactions this part wrote and deleted again, as they were where the file came from.",
        ),
      })
      .strict(),
    skipped: z
      .object({
        entries: count(),
        deleted: count(),
        staged: count(),
      })
      .strict()
      .describe(
        "Transactions, deleted transactions and staged rows already here by their origin, which this part passed over: what an earlier part, or an earlier try of this one, already brought.",
      ),
    importBatchId: uuid()
      .nullable()
      .describe(
        "The batch the file's own staged rows went under, which Staged can be filtered by. Null when this part staged none.",
      ),
    staged: count().describe("The file's own staged rows this part put in Staged."),
    needsReview: count().describe("Of those, rows staged with an issue."),
    budgetEntries: z.object({ created: count(), skipped: count() }).strict(),
    archived: count().describe(
      "Archived accounts this part wrote transactions into, each left holding nothing from the day it was archived, as archiving any account leaves it.",
    ),
    balances: z
      .object({
        checked: count().describe("Accounts whose balance came out as the file says."),
        notCompared: count().describe(
          "Accounts the check passes over: archived where the file came from, whose balance there is the zero archiving left, which says nothing about the transactions in them; or opening after the day the balances are for with money from before the file's first day, which arrives with the opening, after that day.",
        ),
      })
      .strict()
      .nullable()
      .describe("Null when this part carried no balances, which is every part but the last."),
    plan: ledgerFilePlanSchema,
  })
  .strict();
export type LedgerFileMoveResult = z.infer<typeof ledgerFileMoveResultSchema>;

export function planLedgerFileMove(input: Omit<LedgerFilePlanInput, "mode">): LedgerFilePlanned {
  return planLedgerFileAdd({ ...input, mode: "move" });
}

/**
 * An entry as the draft a move writes, or what kept it from being one.
 *
 * The staged draft an add would make, held to being complete: a move has no
 * queue for a partial row to wait in, so every account side and every
 * category it files under must resolve to a record here. The plan offers no
 * choice that leaves one unresolved, so a refusal here is a planner defect
 * met before it could write half a transaction, not a question for somebody.
 * The template is the one reference allowed to go: it is provenance, and an
 * entry whose template is not coming arrives the way one whose template was
 * deleted already reads.
 */
type WrittenReference = Extract<LedgerReferenceKind, "account" | "category">;

export type LedgerMoveDraft =
  | { ok: true; draft: Record<string, unknown> }
  | { ok: false; kind: WrittenReference; key: string };

export function ledgerMoveEntryDraft(
  entry: LedgerFileEntry,
  ref: LedgerRefResolver,
): LedgerMoveDraft {
  const resolved = (kind: WrittenReference, key: string) => {
    const target = ref(kind, key);
    return target !== null && "id" in target;
  };
  const sides =
    entry.type === "deposit"
      ? [entry.to]
      : entry.type === "withdrawal"
        ? [entry.from]
        : [entry.from, entry.to];
  for (const key of sides) {
    if (!resolved("account", key)) return { ok: false, kind: "account", key };
  }
  const categories = [
    entry.category,
    ...(entry.type === "transfer" ? [] : (entry.legs ?? []).map((leg) => leg.category)),
  ].filter((key): key is string => typeof key === "string");
  for (const key of categories) {
    if (!resolved("category", key)) return { ok: false, kind: "category", key };
  }
  return { ok: true, draft: ledgerEntryDraft(entry, ref) };
}

const PART_NOT_WRITTEN = "Nothing in this part was written.";

/**
 * The sentence a move refuses with when a service turns down one transaction
 * the plan did not foresee: which one, in words somebody can find it by, and
 * the service's own reason. The whole part is rolled back, so it says that too.
 *
 * The server writes the transaction's money and day canonically; the page
 * writes them again with its own figures and the transaction's currency, from
 * the reason `ledgerMoveEntryReason` reads back out of the server's sentence.
 */
export function ledgerMoveEntryRefusal(
  entry: LedgerFileEntry,
  reason: string,
  shown?: { readonly figures: LedgerFigures; readonly currency: string | undefined },
): string {
  const label = ledgerEntryLabel(entry, shown);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} could not be written: ${reason.trim()} ${PART_NOT_WRITTEN}`;
}

/**
 * The service's reason in a sentence `ledgerMoveEntryRefusal` wrote about this
 * transaction, or null when the sentence is not one of those. The inverse of
 * the one function, so the page reads back exactly what the server wrote
 * rather than a pattern that could drift from it.
 */
export function ledgerMoveEntryReason(entry: LedgerFileEntry, message: string): string | null {
  const head = ledgerMoveEntryRefusal(entry, "\u0000").split("\u0000")[0]!;
  const tail = ` ${PART_NOT_WRITTEN}`;
  if (!message.startsWith(head) || !message.endsWith(tail)) return null;
  return message.slice(head.length, message.length - tail.length);
}

const negate = (value: string) => (value.startsWith("-") ? value.slice(1) : `-${value}`);
const subtract = (left: string, right: string) => addDecimalText(left, negate(right));

export type LedgerBalanceMismatch = {
  /** Where the figure is in the file, counting accounts from zero, as every problem path does. */
  readonly field: string;
  readonly key: string;
  readonly name: string;
  readonly currency: string;
  readonly expected: string;
  readonly actual: string;
  /** What this ledger holds less what the file says, signed. */
  readonly difference: string;
};

/**
 * The accounts whose balance here, once a part is written, is not the file's.
 *
 * `actual` is each checked account's balance on the file's last day, summed
 * from its postings with the closing pairs left out, keyed by the account's
 * key in the file. Left out because a close is a ledger's own: an account the
 * file has live but somebody chose to have arrive archived is closed here and
 * was never closed there, and an archived one is closed here on its archive
 * day where this ledger lives, which need not be the day it was where the file
 * came from. Without its closing pairs an account holds what its opening and
 * its transactions put in it, which is the figure the file's arithmetic and
 * this ledger's have to agree on. An account the check does not compare is
 * passed over. One missing from `actual` holds nothing, which is what a sum
 * over no postings is: a read that leaves an account out has to be refused by
 * the check, not waved through by it.
 */
export function ledgerBalanceMismatches(
  file: LedgerFile,
  checks: readonly LedgerBalanceCheck[],
  actual: ReadonlyMap<string, string>,
): LedgerBalanceMismatch[] {
  const mismatches: LedgerBalanceMismatch[] = [];
  for (const check of checks) {
    if (!check.compared) continue;
    const here = canonicalDecimalText(actual.get(check.key) ?? "0");
    const expected = canonicalDecimalText(check.balance);
    if (here === expected) continue;
    mismatches.push({
      field: `accounts.${file.accounts.findIndex((account) => account.key === check.key)}.balance`,
      key: check.key,
      name: check.name,
      currency: check.currency,
      expected,
      actual: here,
      difference: subtract(here, expected),
    });
  }
  return mismatches;
}

/**
 * The refusal for a part whose balances did not come out: the first account by
 * name, both figures and the gap between them, how many disagree in all, and
 * that nothing was written. Every mismatch, with its numbers and its name, is
 * in the details, so nobody has to read a figure back out of the sentence, and
 * the page can write the sentence again in its own figures.
 *
 * Then the causes that can be acted on, and what to do about each. The
 * browser's never blames an earlier part, because the page sends the parts in
 * order and never sends the last before the rest are in; an agent's does
 * where there is one, and names the tools. A file that starts partway through
 * may be waiting on the file for the days before it. An account here holding
 * transactions from outside the file is put right by renaming it, so the
 * file's comes in new, or by adding the file instead. And an account holding
 * this file's own transactions as an earlier copy of it had them cannot be put
 * right by a move at all, because a move passes over a transaction already
 * here rather than changing it (`docs/standards/ledger-file.md`).
 */
export function ledgerBalanceRefusal(
  mismatches: readonly LedgerBalanceMismatch[],
  throughDate: string,
  context: {
    readonly part: { readonly index: number; readonly count: number };
    /** The file's first day, for a file whose entries start partway through. */
    readonly startsOn: string | null;
  },
  figures: LedgerFigures = LEDGER_RAW_FIGURES,
): { message: string; forAgent: string; details: Record<string, unknown> } {
  const [first] = mismatches;
  if (first === undefined) throw new Error("There is no mismatch to refuse with");
  const { part, startsOn } = context;
  const whole = part.count === 1;
  const money = (amount: string) => figures.money(amount, first.currency);
  const gap = first.difference.startsWith("-") ? first.difference.slice(1) : first.difference;
  const direction = first.difference.startsWith("-") ? "less" : "more";
  const head = `${whole ? "After the move" : "After this part"}, "${first.name}" would hold ${money(first.actual)} on ${figures.date(throughDate)}, and the file says ${money(first.expected)}: ${money(gap)} ${direction} than the file.${mismatches.length > 1 ? ` ${mismatches.length} accounts disagree in all.` : ""} ${whole ? "Nothing was written." : PART_NOT_WRITTEN}`;
  const range =
    startsOn === null
      ? null
      : `This file starts on ${figures.date(startsOn)}, so a file covering the days before it may have to be moved in first.`;
  const copy = `If it holds some of this file's transactions as an earlier copy of the file had them, a move passes over those rather than changing them, and they can only be put right by hand.`;
  const person = [
    head,
    range,
    `If "${first.name}" here held transactions that are not in this file, rename it under Accounts and check the file again, so the file's comes in as a new account, or add the file instead, which sends its transactions to Staged.`,
    copy,
  ];
  const earlier = whole
    ? null
    : "Call preview_ledger_file on each earlier part: one whose transactions are not all already here has not been moved, so send it first, then this part again.";
  const otherwise =
    earlier !== null ? "If every earlier part is in, " : range !== null ? "Otherwise, " : "";
  const agent = [
    head,
    earlier,
    range === null ? null : `${range.slice(0, -1)}: move that file first, then this one again.`,
    `${otherwise}"${first.name}" here holds transactions that are not in this file, or holds some of this file's as an earlier copy of it had them. For the first, rename it with update_account, call preview_ledger_file again and send ${whole ? "the file" : "the parts"} again so the file's comes in as a new account, or call add_ledger_file instead. For the second, a move passes over a transaction already here rather than changing it, so only the person can reconcile them.`,
  ];
  return {
    message: person.filter((sentence) => sentence !== null).join(" "),
    forAgent: agent.filter((sentence) => sentence !== null).join(" "),
    details: {
      throughDate,
      key: first.key,
      name: first.name,
      currency: first.currency,
      expected: first.expected,
      actual: first.actual,
      difference: first.difference,
      count: mismatches.length,
      issues: mismatches.map((mismatch) => ({
        field: mismatch.field,
        message: ledgerBalanceIssue(mismatch),
        key: mismatch.key,
        name: mismatch.name,
        currency: mismatch.currency,
        expected: mismatch.expected,
        actual: mismatch.actual,
        difference: mismatch.difference,
      })),
    },
  };
}

/** One account the balances disagree about, as the line the refusal lists it on. */
export function ledgerBalanceIssue(
  mismatch: LedgerBalanceMismatch,
  figures: LedgerFigures = LEDGER_RAW_FIGURES,
): string {
  return `"${mismatch.name}" would hold ${figures.money(mismatch.actual, mismatch.currency)}, and the file says ${figures.money(mismatch.expected, mismatch.currency)}.`;
}

const balanceRefusalDetailsSchema = z.object({
  throughDate: z.string(),
  issues: z.array(
    z.object({
      field: z.string(),
      key: z.string(),
      name: z.string(),
      currency: z.string(),
      expected: z.string(),
      actual: z.string(),
      difference: z.string(),
    }),
  ),
});

/**
 * The mismatches a balance refusal's details carry, read back, or null when
 * the details are not a balance refusal's: what lets the page tell this stop
 * from any other, and write it again in its own figures, without matching on
 * the words.
 */
export function ledgerBalanceRefusalOf(
  details: unknown,
): { throughDate: string; mismatches: LedgerBalanceMismatch[] } | null {
  const parsed = balanceRefusalDetailsSchema.safeParse(details);
  if (!parsed.success || !parsed.data.issues.length) return null;
  return { throughDate: parsed.data.throughDate, mismatches: parsed.data.issues };
}
