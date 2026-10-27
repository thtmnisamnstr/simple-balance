import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, RotateCcw } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useMemo, useState } from "react";
import {
  budgetPeriodUnits,
  PROGRESS_STREAM_MIN_ROWS,
  type BudgetPeriodUnit,
  type CounterKind,
  type ValidationIssue,
} from "../shared/domain.js";
import {
  parseLedgerFileText,
  serializeLedgerFile,
  splitLedgerFile,
  type LedgerFile,
  type LedgerFileAccount,
  type LedgerFilePartLimits,
} from "../shared/ledger-file.js";
import {
  addDecimalText,
  LEDGER_FILE_MOVE_BLOCKED,
  ledgerImportKinds,
  ledgerReferenceOpeningDate,
  mergeLedgerFileFacts,
  planLedgerFileAdd,
  suggestLedgerRename,
  type LedgerDecisionAction,
  type LedgerFigures,
  type LedgerFileDecision,
  type LedgerFileDrift,
  type LedgerFileFacts,
  type LedgerFileImportMode,
  type LedgerFilePlan,
  type LedgerFilePlannedRecord,
  type LedgerFilePlanProblem,
  type LedgerImportKind,
  type LedgerPreferencesChoice,
} from "../shared/ledger-file-import.js";
import {
  ledgerBalanceIssue,
  ledgerBalanceRefusal,
  ledgerBalanceRefusalOf,
  ledgerMoveEntryReason,
  ledgerMoveEntryRefusal,
  planLedgerFileMove,
} from "../shared/ledger-file-move.js";
import { normalizeHumanName } from "../shared/names.js";
import { progressFraction, type ProgressEvent } from "../shared/progress.js";
import {
  api,
  ApiClientError,
  apiStreamed,
  json,
  queryString,
  writeDidNotHappen,
  type LedgerFileAddResult,
  type LedgerFileMoveResult,
  type LedgerFilePreview,
} from "./api.js";
import { periodName } from "./budget-display.js";
import {
  Alert,
  Badge,
  Button,
  Field,
  formatCount,
  Input,
  Note,
  progressLabel,
  ProgressBar,
  Select,
  Skeleton,
} from "./components.js";
import { newIdempotencyKey } from "./idempotency.js";
import { formatDate, formatMoney } from "./money.js";
import { THEME_CHOICES } from "./pages/SettingsPage.js";
import { Link } from "./router.js";

/**
 * Adding a Simple Balance file to this ledger, or moving one into it: the
 * middle section of Import and export.
 *
 * The page does three things the server does again, and that is the design
 * rather than a duplication. It reads the file with the shared reader, so a
 * file that is not one is refused in the format's own sentences before a byte
 * of it is sent. It cuts the file into parts with the shared splitter, because
 * one import is at most ten thousand rows and the person should not have to
 * know that. And it plans the whole file with `planLedgerFileAdd`, or with
 * `planLedgerFileMove` once somebody chooses a move — the functions the server
 * runs over each part under its locks before it writes anything — so what this
 * page says a decision will do is what the import then does, and a request the
 * page would refuse is never sent.
 *
 * What the server alone can say is what is already here: its records in the
 * file's own shape, which of the file's entries it holds by origin, and
 * whether everything in it came from a Simple Balance file, which is when a
 * move is offered at all. That is what the preview route answers with, part by
 * part, and the one thing this page asks for before anybody decides anything.
 *
 * **Two ways in, chosen by the person.** Adding brings the records in at once
 * and sends the transactions to Staged, and is always offered. Moving writes
 * every transaction straight into the books — deleted ones deleted again,
 * archived accounts archived on their own day — and is offered only while the
 * ledger holds nothing typed by hand, so it is the way a whole ledger reaches
 * a new one. Where both are open neither is chosen for anybody: the two write
 * different things, and a guess never overwrites a decision.
 */

/** A file read and checked against this ledger, part by part. */
type CheckedFile = {
  /** What the person's file was called, recorded on the batch its rows stage under. */
  readonly name: string;
  /** The file's text, fingerprinted, so choosing the same file again is told from choosing another. */
  readonly identity: string;
  /** The whole file, which is what the page plans and shows. */
  readonly file: LedgerFile;
  /** The same file cut for sending, which is what every request carries. */
  readonly parts: readonly LedgerFile[];
  /** What every part's preview read, as one. */
  readonly facts: LedgerFileFacts;
  /**
   * What each part's preview read on its own, beside the merge: which of its
   * rows are already here is what tells a move that a part is in already.
   */
  readonly partFacts: readonly LedgerFileFacts[];
};

/** A file the browser refused before sending any of it, with the format's sentences. */
class FileRefusal extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(issues[0]?.message ?? "This is not a Simple Balance file.");
    this.issues = issues;
  }
}

/**
 * Where an import stopped. The part is what "Try again" resends, and the parts
 * before it are in.
 */
class PartStopped extends Error {
  readonly index: number;
  readonly failure: unknown;
  constructor(index: number, failure: unknown) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.index = index;
    this.failure = failure;
  }
}

/** What somebody has said about one record so far, before it is a decision. */
type DecisionDraft = {
  readonly kind: LedgerImportKind;
  readonly key: string;
  readonly action: LedgerDecisionAction;
  /** The name for a copy, or for a reference created where its own name is taken. */
  readonly name?: string;
  /** The record here a reference is matched to. */
  readonly id?: string;
};

/** What every part of one attempt is sent with, fixed when the attempt starts. */
type Answers = {
  readonly decisions: LedgerFileDecision[];
  readonly arriveArchived: string[];
  readonly preferences: LedgerPreferencesChoice | undefined;
};

/** One attempt: its answers, the way the file comes in, and the key its parts' keys are built from. */
type Attempt = Answers & { readonly mode: LedgerFileImportMode; readonly key: string };

type RunRequest = Attempt & { readonly start: number };

/**
 * A part a move did not send, because its own preview found every row in it
 * here already: what an earlier attempt brought in, counted the way a part
 * that ran reports what it skipped.
 */
type PassedPart = {
  readonly index: number;
  readonly entries: number;
  readonly deleted: number;
  readonly staged: number;
};

/** What the parts of one attempt did, in the order they did it. */
type Done = {
  readonly added: readonly LedgerFileAddResult[];
  readonly moved: readonly LedgerFileMoveResult[];
  readonly passed: readonly PassedPart[];
};

const NOTHING_DONE: Done = { added: [], moved: [], passed: [] };

const recordId = (kind: LedgerImportKind, key: string) => `${kind}\u0000${key}`;

/** The kinds, as the table's rows and a record's own heading name them. */
const KIND_NAMES: Record<LedgerImportKind, { one: string; many: string }> = {
  group: { one: "Category group", many: "Category groups" },
  category: { one: "Category", many: "Categories" },
  account: { one: "Account", many: "Accounts" },
  template: { one: "Template", many: "Templates" },
  // The glossary's two words, on every screen and in every heading.
  recurrence: { one: "Recurring transaction", many: "Recurring transactions" },
  budget_plan: { one: "Budget", many: "Budgets" },
  // One record per budget, counted one period at a time, which is why the row
  // reads in amounts rather than in budgets.
  budget_entry: { one: "Budget amounts", many: "Budget amounts" },
};

/**
 * The words each decision is offered in. A radio's label, so a verb the person
 * picks rather than a sentence about it; the record's own message above the
 * group says why it is asked.
 */
const CHOICE_LABELS: Record<LedgerDecisionAction, string> = {
  use_existing: "Use the one here",
  skip: "Leave it out",
  rename: "Bring it in as",
  match: "Use another here",
  create: "Create it",
  // Where the review happens is said once above the questions rather than in
  // every radio: "Staged" is a page's name, and a label map is held to
  // sentence case word by word (`tests/common-guide.test.ts`).
  leave_staged: "Leave for review",
};

/**
 * The two ways a file comes in, in the order they are offered and the words
 * each is offered in: what it writes, rather than what it is called, because
 * the difference between them is the whole question.
 *
 * Moving first, because a ledger that may take one is new and moving is what a
 * new ledger is for; where it may not, it is the one that says why beside
 * itself. Keyed on the shared modes, so a third would not typecheck here.
 */
const MODE_ORDER: readonly LedgerFileImportMode[] = ["move", "add"];
const MODE_CHOICES: Record<LedgerFileImportMode, { title: string; description: string }> = {
  move: {
    title: "Move it into this ledger",
    description:
      "Every transaction goes straight into the books, deleted ones and archived accounts as they were, and every balance is checked against the file.",
  },
  add: {
    title: "Add it to this ledger",
    description: "New records come in at once, and its transactions go to Staged for review.",
  },
};

/**
 * What a transaction's other half is, in the words the reports total it under,
 * by the direction it was entered in: a deposit on the spending side is a
 * refund of spending, and a withdrawal on the income side is income coming
 * back. Said without the direction, a refund read as "counted as spending",
 * the opposite of what it did. Keyed on the shared pair of counter-sides, so a
 * third would fail to typecheck here rather than render as a blank.
 */
const COUNTER_SIDE: Record<LedgerFileDrift["type"], Record<CounterKind, string>> = {
  deposit: { income: "income", expense: "a refund of spending" },
  withdrawal: { expense: "spending", income: "income coming back" },
};

/**
 * Money and days as this page writes them everywhere else, for the sentences
 * the shared planner and the move's refusals build (common.md: formatted,
 * never raw). The server writes the same sentences canonically.
 */
const FIGURES: LedgerFigures = { money: formatMoney, date: formatDate };

/** Names in quotes, the way a sentence here lists a few: "a", "b" and "c". */
function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length <= 1
    ? quoted.join("")
    : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/** The words Settings gives each theme, so the two screens say one thing. */
const themeLabel = (theme: string) =>
  THEME_CHOICES.find((choice) => choice.value === theme)?.label ?? theme;

/** "3 accounts", grouped, with the noun agreeing. */
const counted = (count: number, one: string, many = `${one}s`) =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

/**
 * The file's name as the batch records it: the route takes one to 240
 * characters, and a name the operating system allowed is not always that.
 */
const batchFileName = (name: string) => name.trim().slice(0, 240) || "simple-balance.json";

/**
 * A text's fingerprint: its length and a 32-bit FNV-1a over its code units.
 * Only ever compared with the last file checked, to tell the same file chosen
 * again from another, so a collision costs a kept choice and nothing more.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return [text.length, hash >>> 0].map((part) => part.toString(16)).join(":");
}

/**
 * A record's name as a person reads it. A budget plan's is composed by the
 * shared planner with the ISO day it starts, which an agent wants; on screen
 * that day names a period and is said as one (common.md §Dates and times).
 * The unit and the day are the last two parts of the plan's key, which the
 * planner builds and nothing else can contain a `|` after.
 */
function recordName(record: LedgerFilePlannedRecord): string {
  if (record.kind !== "budget_plan") return record.name;
  const [unit, activeFrom] = record.key.split("|").slice(-2);
  const suffix = ` from ${activeFrom}`;
  if (
    activeFrom === undefined ||
    !record.name.endsWith(suffix) ||
    !budgetPeriodUnits.includes(unit as BudgetPeriodUnit)
  ) {
    return record.name;
  }
  return `${record.name.slice(0, -suffix.length)} from ${periodName(unit as BudgetPeriodUnit, activeFrom)}`;
}

/**
 * A record's heading: its kind and name, and for an account its currency,
 * because an account's currency is half of whether it is the one here.
 */
function recordTitle(
  record: LedgerFilePlannedRecord,
  accounts: ReadonlyMap<string, LedgerFileAccount>,
) {
  const kind = KIND_NAMES[record.kind].one;
  // A budget's name is already a description — "Groceries (EUR, by month)
  // from January 2025" — and quoting it would read as a name somebody typed.
  if (record.kind === "budget_plan" || record.kind === "budget_entry") {
    return `${kind} for ${recordName(record)}`;
  }
  const currency = record.kind === "account" ? accounts.get(record.key)?.currency : undefined;
  return `${kind} "${record.name}"${currency ? ` (${currency})` : ""}`;
}

/**
 * The words a choice is offered in for this record. A budget's amounts are
 * many periods under one question, so its two answers say how many each
 * keeps and brings rather than reusing words that promise more.
 */
function choiceLabel(record: LedgerFilePlannedRecord, choice: LedgerDecisionAction): string {
  const periods = record.kind === "budget_entry" ? record.periods : null;
  if (periods && record.choices.length > 1) {
    if (choice === "use_existing") {
      return `Keep the ${formatCount(periods.conflict)} here and add the ${formatCount(periods.create)} new`;
    }
    if (choice === "skip") return `Leave all ${formatCount(periods.create + periods.conflict)} out`;
  }
  return CHOICE_LABELS[choice];
}

/** A budget's periods as words: what is new, what matches, what differs here. */
function periodWords(periods: NonNullable<LedgerFilePlannedRecord["periods"]>) {
  return [
    periods.create ? `${formatCount(periods.create)} new` : null,
    periods.exists ? `${formatCount(periods.exists)} already here` : null,
    periods.conflict ? `${formatCount(periods.conflict)} different here` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/**
 * What becomes of a record, in the words the table shows it in, and the tone
 * of its badge. The words carry the meaning on their own; the tone repeats it.
 */
function outcomeOf(record: LedgerFilePlannedRecord): {
  text: string;
  tone: "green" | "neutral" | "amber" | "red";
} {
  // Left out whole is said as left out, not as the periods it would have set.
  if (
    record.periods &&
    record.action !== "refused" &&
    record.action !== "undecided" &&
    record.action !== "skip"
  ) {
    return { text: periodWords(record.periods) || "Nothing to set", tone: "neutral" };
  }
  switch (record.action) {
    case "create": {
      const renamed = record.importName !== null && record.importName !== record.name;
      return {
        text: [
          "New",
          renamed ? `as "${record.importName}"` : null,
          record.arrivesArchived ? "arrives archived" : null,
        ]
          .filter((part) => part !== null)
          .join(", "),
        tone: "green",
      };
    }
    case "use":
      return {
        text:
          record.outcome === "exists" || record.importName === null
            ? "Already here"
            : `Uses "${record.importName}" here`,
        tone: "neutral",
      };
    case "leave_staged":
      return { text: "Left for review in Staged", tone: "neutral" };
    case "undecided":
      return { text: "Needs a choice", tone: "amber" };
    case "refused":
      return { text: "Left out", tone: "red" };
    default:
      return { text: "Left out", tone: "neutral" };
  }
}

/**
 * What the file's transactions and staged rows will do, as sentences.
 *
 * Kept out of the records table on purpose: a transaction is never "new" here
 * in the sense a category is. It goes to Staged for review like any import,
 * or straight into the books in a move, or is skipped because its origin is
 * already here, and the table's columns would say something false about it
 * either way.
 */
function rowSentences(plan: LedgerFilePlan, parts: number, file: LedgerFile): string[] {
  const { rows } = plan;
  if (plan.move) return moveSentences(plan, parts, file);
  const live = rows.entries - rows.deleted - rows.alreadyHere;
  const staged = rows.staged - rows.stagedAlreadyHere;
  return [
    live > 0
      ? `${counted(live, "transaction")} ${live === 1 ? "goes" : "go"} to Staged for review, with both sides of every transfer filled in.`
      : null,
    staged > 0
      ? `${counted(staged, "staged row")} from the file ${staged === 1 ? "waits" : "wait"} in Staged again.`
      : null,
    rows.alreadyHere > 0
      ? `${counted(rows.alreadyHere, "transaction")} ${rows.alreadyHere === 1 ? "is" : "are"} already in this ledger, so ${rows.alreadyHere === 1 ? "it is" : "they are"} skipped.`
      : null,
    rows.stagedAlreadyHere > 0
      ? `${counted(rows.stagedAlreadyHere, "staged row")} ${rows.stagedAlreadyHere === 1 ? "is" : "are"} already waiting in Staged, so ${rows.stagedAlreadyHere === 1 ? "it is" : "they are"} skipped.`
      : null,
    rows.deleted > 0
      ? `${counted(rows.deleted, "deleted transaction")} in the file ${rows.deleted === 1 ? "is" : "are"} not added, because a row in Staged cannot be a deleted transaction.`
      : null,
    // `postedAs` in the file: a refund written before its category was
    // widened. Reported rather than reproduced, because overriding the side
    // would be a second rule beside the one that decides it.
    rows.postedAsDiffers > 0
      ? `${counted(rows.postedAsDiffers, "transaction")} will count as income where ${rows.postedAsDiffers === 1 ? "it" : "they"} counted as a refund of spending, or the other way round, because a category's kind changed after ${rows.postedAsDiffers === 1 ? "it was" : "they were"} written. Balances are the same either way.`
      : null,
  ].filter((sentence) => sentence !== null);
}

/**
 * Transactions whose other half lands on the other side of the books here, as
 * one sentence a group. Reported and never reproduced: the side is decided by
 * the categories here, by the rule every transaction is posted by, and a move
 * that overrode it would be a second rule beside that one.
 */
function driftSentence(drift: LedgerFileDrift, done = false): string {
  const one = drift.entries === 1;
  const amount = formatMoney(drift.amount, drift.currency);
  const counts = done ? (one ? "counts" : "count") : "will count";
  const side = COUNTER_SIDE[drift.type];
  return `${counted(drift.entries, drift.type)} filed under ${quotedList(drift.categories)}, ${one ? amount : `${amount} in all`}, ${counts} as ${side[drift.to]} here, where ${one ? "it was" : "they were"} ${side[drift.from]}.`;
}

/**
 * What a move does with the file's rows: what it writes, what it writes and
 * deletes again, what is in already, and what it will be held to.
 *
 * The balance check is said before anything is pressed, because it is the
 * one way a move can stop once it has started — a part whose balances do not
 * come out writes nothing — and somebody should know that is what the check
 * is for rather than meet it as a refusal.
 */
function moveSentences(plan: LedgerFilePlan, parts: number, file: LedgerFile): string[] {
  const { rows } = plan;
  const move = plan.move!;
  const compared = move.checks.filter((check) => check.compared);
  // Two reasons a check is passed over (`balanceCheckSchema`), told apart by
  // the file's own account, because each is a different sentence about it.
  const archivedThere = new Set(
    file.accounts
      .filter((account) => account.detail === "full" && account.archivedAt !== null)
      .map((account) => account.key),
  );
  const passedOver = move.checks.filter((check) => !check.compared && archivedThere.has(check.key));
  const opensLater = move.checks.filter(
    (check) => !check.compared && !archivedThere.has(check.key),
  );
  const recurring = plan.records.some(
    (record) => record.kind === "recurrence" && record.action === "create",
  );
  const stagedHere = rows.stagedAlreadyHere;
  return [
    move.toWrite > 0
      ? `${counted(move.toWrite, "transaction")} ${move.toWrite === 1 ? "goes" : "go"} straight into the books, with nothing to review.`
      : null,
    move.toVoid > 0
      ? `${counted(move.toVoid, "deleted transaction")} ${move.toVoid === 1 ? "comes" : "come"} too, deleted as ${move.toVoid === 1 ? "it was" : "they were"} where the file came from, so ${move.toVoid === 1 ? "it changes" : "they change"} no balance.`
      : null,
    rows.toStage > 0
      ? `${counted(rows.toStage, "staged row")} from the file ${rows.toStage === 1 ? "waits" : "wait"} in Staged again.`
      : null,
    move.alreadyHere > 0
      ? `${counted(move.alreadyHere, "transaction")} ${move.alreadyHere === 1 ? "is" : "are"} already in this ledger, so ${move.alreadyHere === 1 ? "it is" : "they are"} skipped.`
      : null,
    stagedHere > 0
      ? `${counted(stagedHere, "staged row")} ${stagedHere === 1 ? "is" : "are"} already waiting in Staged, so ${stagedHere === 1 ? "it is" : "they are"} skipped.`
      : null,
    ...move.drift.map((group) => driftSentence(group)),
    move.drift.length
      ? "Account balances are the same either way, and only the income and spending totals move: here each side is decided by the categories as they are now."
      : null,
    move.templateDropped > 0
      ? `${counted(move.templateDropped, "transaction")} made from a template that is not coming in ${move.templateDropped === 1 ? "arrives" : "arrive"} without saying which template ${move.templateDropped === 1 ? "it was" : "they were"} made from.`
      : null,
    compared.length
      ? `${compared.length === 1 ? "The balance of one account is" : `The balances of ${formatCount(compared.length)} accounts are`} checked against the file ${parts > 1 ? "once the last part is in, and that part is not written" : "as the move ends, and nothing is written"} if one comes out different.`
      : null,
    passedOver.length
      ? `${quotedList(passedOver.map((check) => check.name))} ${passedOver.length === 1 ? "is" : "are"} not checked: archived where the file came from, ${passedOver.length === 1 ? "it holds" : "they hold"} nothing there to check against.`
      : null,
    opensLater.length
      ? `${quotedList(opensLater.map((check) => check.name))} ${opensLater.length === 1 ? "is" : "are"} not checked: ${opensLater.length === 1 ? "it opens" : "they open"} after ${formatDate(file.throughDate)}, the day the file's balances are for, and the money ${opensLater.length === 1 ? "it" : "they"} held before the file's first day ${opensLater.length === 1 ? "arrives with its" : "arrive with their"} opening.`
      : null,
    // The page plans the whole file, which is the last part as far as the
    // planner is concerned, so its own count of recurring transactions held
    // back is always none; across parts, every one waits for the last.
    parts > 1 && recurring
      ? "Recurring transactions are created by the last part, so nothing they propose reaches Staged while the move is under way."
      : null,
  ].filter((sentence) => sentence !== null);
}

/** A refusal's sentences, each with the place in the file it is about. */
function refusalIssues(error: unknown): readonly ValidationIssue[] {
  if (error instanceof FileRefusal) return error.issues;
  // The preview refuses a file with the reader's own list in `details.issues`,
  // which the client's envelope reader leaves alone because it is an object
  // rather than Zod's array.
  if (error instanceof ApiClientError) {
    const listed = (error.details as { issues?: unknown } | undefined)?.issues;
    if (Array.isArray(listed)) {
      return listed.filter(
        (issue): issue is ValidationIssue =>
          typeof (issue as ValidationIssue)?.message === "string" &&
          typeof (issue as ValidationIssue)?.field === "string",
      );
    }
  }
  return [];
}

/** Why a file cannot be added, with every sentence the reader gave and where it points. */
function FileRefused({ error }: { error: unknown }) {
  const issues = refusalIssues(error);
  const message = error instanceof Error ? error.message : String(error);
  if (issues.length <= 1) return <Alert>{issues[0]?.message ?? message}</Alert>;
  return (
    <Alert>
      This file cannot be added as it is.
      <ul className="ledger-import-issues">
        {issues.map((issue, index) => (
          // By index as well: the reader's last line, "There are 12 more
          // problems like these", has no field, and two sentences can match.
          <li key={`${index}-${issue.field}`}>
            {issue.field ? <span className="ledger-import-path">{issue.field}</span> : null}{" "}
            {issue.message}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * The records here a reference could be matched to: of the same kind, and for
 * an account in the same currency, because the planner refuses any other.
 */
function matchCandidates(
  kind: LedgerImportKind,
  facts: LedgerFileFacts,
  currency: string | undefined,
): { id: string; name: string; archived: boolean }[] {
  const { here } = facts;
  const listed =
    kind === "account"
      ? here.accounts
          .filter((account) => account.currency === currency)
          .map((account) => ({
            key: account.key,
            name: account.name,
            archived: account.detail === "full" && account.archivedAt !== null,
          }))
      : kind === "category"
        ? here.categories.map((category) => ({
            key: category.key,
            name: category.name,
            archived: category.detail === "full" && category.archivedAt !== null,
          }))
        : kind === "group"
          ? here.groups.map((group) => ({ key: group.key, name: group.name, archived: false }))
          : [];
  const ids: Record<string, string> =
    kind === "account" || kind === "category" || kind === "group" ? here.ids[kind] : {};
  return listed.flatMap((record) =>
    ids[record.key] ? [{ id: ids[record.key]!, name: record.name, archived: record.archived }] : [],
  );
}

/** The decision a draft makes, or nothing while it is not yet one. */
function decisionOf(draft: DecisionDraft): LedgerFileDecision | null {
  const { kind, key } = draft;
  switch (draft.action) {
    case "rename":
      // Sent as typed, blank included: the planner holds it to the kind's own
      // name rule and says so beside the record, in the sentence a create of
      // that kind would give.
      return { kind, key, action: "rename", name: draft.name ?? "" };
    case "match":
      return draft.id ? { kind, key, action: "match", id: draft.id } : null;
    case "create":
      // A blank name means its own name, which is what a create without one is.
      return draft.name?.trim()
        ? { kind, key, action: "create", name: draft.name }
        : { kind, key, action: "create" };
    default:
      return { kind, key, action: draft.action };
  }
}

/**
 * Why adding or moving a file would change nothing, or null when it would
 * change something.
 *
 * An import that writes nothing is not refused — the server takes it and says
 * so — but a button that does nothing is a question the page can answer before
 * it is pressed: a file brought in a second time, or one whose every record and
 * entry is here already, which is exactly what a finished import looks like
 * when it is checked again. A move writes its transactions rather than staging
 * them, so those count as well.
 */
function nothingToDo(plan: LedgerFilePlan): string | null {
  const writes =
    plan.records.some((record) => record.action === "create") ||
    plan.rows.toStage > 0 ||
    (plan.move !== undefined && plan.move.toWrite + plan.move.toVoid > 0) ||
    plan.counts.budget_entry.create > 0 ||
    plan.preferences.action === "apply";
  if (writes) return null;
  return plan.records.length === 0 && plan.rows.entries === 0 && plan.rows.staged === 0
    ? `This file holds nothing to ${plan.move ? "move" : "add"}.`
    : "Everything in this file is already in this ledger.";
}

/**
 * The part of a move that is in already, by its own preview: every live
 * transaction, every deleted one and every staged row in it found here by
 * origin, and no budget amount in it, since those are matched rather than
 * looked up and only sending the part can say whether one is new. Null for a
 * part that still has something to write, or one whose rows wait in Staged
 * from an add, which the move refuses rather than passes over.
 *
 * A resumed move sends what is left rather than all of it: sending a part
 * that is in already would write nothing, at the cost of reading ten thousand
 * origins to find that out.
 */
function alreadyIn(part: LedgerFile, facts: LedgerFileFacts): Omit<PassedPart, "index"> | null {
  const deleted = part.entries.filter((entry) => entry.deleted).length;
  const live = part.entries.length - deleted;
  const { rows } = facts;
  if (rows.waiting > 0 || part.budgets.entries.length > 0) return null;
  if (
    rows.alreadyHere !== live ||
    rows.deletedAlreadyHere !== deleted ||
    rows.stagedAlreadyHere !== part.staged.length
  ) {
    return null;
  }
  return { entries: live, deleted, staged: part.staged.length };
}

/**
 * Import a Simple Balance file.
 *
 * `partLimits` is the splitter's, and only a test passes it: a file has to be
 * over ten thousand rows to need a second part, and the jsdom tier would
 * spend most of its time building one.
 */
export function LedgerFileImport({ partLimits }: { partLimits?: LedgerFilePartLimits } = {}) {
  const queryClient = useQueryClient();
  const base = useId();
  const [checked, setChecked] = useState<CheckedFile | null>(null);
  const [chosenName, setChosenName] = useState("");
  // Beside the mutation for the reason the CSV import gives: a mutation has
  // nothing between pending and settled, and a file in parts is checked one
  // part at a time.
  const [checking, setChecking] = useState<{ index: number; count: number } | null>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DecisionDraft>>(() => new Map());
  // Which file the choices below were made about, by its fingerprint.
  const [decidedFor, setDecidedFor] = useState<string | null>(null);
  // Nothing chosen to arrive archived and nothing chosen about settings until
  // somebody chooses: a guess never overwrites a decision, and which of
  // somebody's accounts to put away is theirs.
  const [archived, setArchived] = useState<ReadonlySet<string>>(() => new Set());
  const [preferences, setPreferences] = useState<LedgerPreferencesChoice | undefined>(undefined);
  // And no way in until somebody picks one, where both are open: a move and
  // an add write different things, and only one of them can be undone by
  // reviewing what it did before it counts.
  const [mode, setMode] = useState<LedgerFileImportMode | undefined>(undefined);
  const [showRecords, setShowRecords] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [done, setDone] = useState<Done>(NOTHING_DONE);
  const [running, setRunning] = useState<{ index: number; count: number } | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);

  const check = useMutation({
    mutationFn: async (source: { file: File } | { again: CheckedFile }): Promise<CheckedFile> => {
      let name: string;
      let identity: string;
      let file: LedgerFile;
      let parts: readonly LedgerFile[];
      if ("again" in source) {
        ({ name, identity, file, parts } = source.again);
      } else {
        name = source.file.name;
        const text = await source.file.text();
        identity = fingerprint(text);
        const parsed = parseLedgerFileText(text);
        if (!parsed.ok) throw new FileRefusal(parsed.issues);
        const split = splitLedgerFile(parsed.file, partLimits);
        if (!split.ok) throw new FileRefusal([{ field: "", message: split.message }]);
        file = parsed.file;
        parts = split.parts;
      }
      const read: LedgerFileFacts[] = [];
      for (const [at, part] of parts.entries()) {
        setChecking({ index: at + 1, count: parts.length });
        // Every part is asked, because only the server knows which of a part's
        // entries are already here, and a part is the most it will read at
        // once. The part's own `plan` and `movePlan` are dropped: each is that
        // part planned with nothing decided, and the page plans the whole file
        // itself, either way, from the facts every part read, each time
        // somebody decides something.
        const {
          plan: _plan,
          movePlan: _movePlan,
          ...facts
        } = await api<LedgerFilePreview>(
          "/api/v1/ledger-file:preview",
          json({ ledgerFile: serializeLedgerFile(part) }),
        );
        read.push(facts);
      }
      // `rows.alreadyHereOn` and `rows.heldHere`, with its `fromFile`, are
      // never shown as figures: the planner reads them over the merged facts
      // and what they decide is shown as what it raises, the question about
      // an account here holding another file's transactions and the problem
      // of an account that would come in without its own.
      return { name, identity, file, parts, facts: mergeLedgerFileFacts(read), partFacts: read };
    },
    onMutate: (source) => {
      // A new attempt, whatever the last one got to. A part already in is
      // recognized by the next preview — its entries are here by origin, and
      // its records are here, read as the same ones under the same decisions
      // — so starting again is how an import resumes.
      run.reset();
      setAttempt(null);
      setDone(NOTHING_DONE);
      if ("file" in source) {
        setChosenName(source.file.name);
        setChecked(null);
      }
    },
    onSuccess: (result) => {
      setChecked(result);
      // Choices belong to a file. The same file again — checked again, or
      // chosen again after a stop — keeps them, so a resumed import asks
      // nothing it was already told and a copy is not brought in under a
      // second new name; another file starts from nothing, the way in too.
      if (result.identity === decidedFor) return;
      setDecidedFor(result.identity);
      setDrafts(new Map());
      setArchived(new Set());
      setPreferences(undefined);
      setMode(undefined);
      setShowRecords(false);
    },
    onSettled: () => setChecking(null),
  });

  const run = useMutation({
    mutationFn: async (asked: RunRequest) => {
      const { parts, partFacts } = checked!;
      const moving = asked.mode === "move";
      for (let index = asked.start; index <= parts.length; index += 1) {
        const part = parts[index - 1]!;
        // Never the last part, whatever its preview says: it carries the
        // balances the whole move is held to and creates the recurring
        // transactions, and neither happens anywhere else.
        const passed =
          moving && index < parts.length ? alreadyIn(part, partFacts[index - 1]!) : null;
        if (passed) {
          setDone((earlier) => ({ ...earlier, passed: [...earlier.passed, { index, ...passed }] }));
          continue;
        }
        setRunning({ index, count: parts.length });
        setProgress(null);
        // One key per part, built from one per attempt: a part retried is the
        // same request and replays if it had in fact finished, and the next
        // part is a different request. The same fields either way, because a
        // move decides exactly what an add decides.
        const body = json({
          ledgerFile: serializeLedgerFile(part),
          fileName: batchFileName(checked!.name),
          idempotencyKey: `${asked.key}-${index}`,
          part: { index, count: parts.length },
          decisions: asked.decisions,
          arriveArchived: asked.arriveArchived,
          preferences: asked.preferences,
        });
        try {
          if (moving) {
            const result = await apiStreamed<LedgerFileMoveResult>(
              "/api/v1/ledger-file:move",
              body,
              setProgress,
            );
            setDone((earlier) => ({ ...earlier, moved: [...earlier.moved, result] }));
          } else {
            const result = await apiStreamed<LedgerFileAddResult>(
              "/api/v1/ledger-file:add",
              body,
              setProgress,
            );
            setDone((earlier) => ({ ...earlier, added: [...earlier.added, result] }));
          }
        } catch (error) {
          throw new PartStopped(index, error);
        }
      }
    },
    onSettled: async () => {
      setProgress(null);
      setRunning(null);
      // Everything, because a file reaches every list there is: accounts,
      // categories, templates, recurring transactions, budgets, the queue and
      // its batches, balances and reports when it is moved, and the settings
      // in the session. A stop partway still wrote every part before it.
      await queryClient.invalidateQueries();
    },
  });

  const accounts = useMemo(
    () => new Map((checked?.file.accounts ?? []).map((account) => [account.key, account])),
    [checked],
  );

  // A move is offered only while the ledger may take one, and where it may
  // not, adding is the one way in and is what the page plans: a choice made
  // before somebody typed into the ledger does not outlive the check that
  // found it.
  const effective: LedgerFileImportMode | undefined = checked?.facts.move.qualifies ? mode : "add";

  /**
   * The plan for the whole file as things stand, the way it is coming in, and
   * exactly what the import would send. Nothing while no way in is chosen:
   * the two plan differently, and showing one would be choosing it.
   *
   * Twice when it has to be. A draft can outlive the question it answered —
   * a category is the same as the one here once its group is used rather than
   * renamed — and a decision is never sent for a record that asks none. The
   * second pass plans with only the decisions the first pass asked for, which
   * changes nothing the person can see and is what the request will carry.
   */
  const planned = useMemo(() => {
    if (!checked || effective === undefined) return null;
    const planner = effective === "move" ? planLedgerFileMove : planLedgerFileAdd;
    const plan = (decisions: LedgerFileDecision[], arriveArchived: string[]) =>
      planner({
        file: checked.file,
        facts: checked.facts,
        decisions,
        arriveArchived,
        preferences,
        figures: FIGURES,
      }).plan;
    const all = [...drafts.values()].map(decisionOf).filter((one) => one !== null);
    const first = plan(all, [...archived]);
    const asking = new Map(
      first.records
        .filter((record) => record.choices.length > 0)
        .map((record) => [recordId(record.kind, record.key), record]),
    );
    const decisions = all.filter((decision) =>
      asking.get(recordId(decision.kind, decision.key))?.choices.includes(decision.action),
    );
    // The accounts that would take a place, which are the ones the person can
    // choose to put away. One the source archived arrives archived anyway.
    const offered = first.records.filter((record) => {
      if (record.kind !== "account" || record.action !== "create") return false;
      const source = accounts.get(record.key);
      return !(source?.detail === "full" && source.archivedAt !== null);
    });
    const arriveArchived = [...archived].filter((key) =>
      offered.some((record) => record.key === key),
    );
    const final =
      decisions.length === all.length && arriveArchived.length === archived.size
        ? first
        : plan(decisions, arriveArchived);
    // An account the file only names opens on the earliest entry naming it,
    // and only this page holds the whole file: the part that creates it is
    // the first, which need not hold that entry. One part needs nothing sent.
    const sent =
      checked.parts.length > 1
        ? decisions.map((decision) =>
            decision.kind === "account" &&
            decision.action === "create" &&
            accounts.get(decision.key)?.detail === "reference"
              ? {
                  ...decision,
                  openingDate: ledgerReferenceOpeningDate(checked.file, decision.key),
                }
              : decision,
          )
        : decisions;
    return {
      mode: effective,
      plan: final,
      answers: { decisions: sent, arriveArchived, preferences },
      offered,
    };
  }, [checked, effective, drafts, archived, preferences, accounts]);

  const stopped = run.error instanceof PartStopped ? run.error : null;
  const finished = run.isSuccess;
  // Nothing about the file changes while it is being checked or brought in,
  // or once an attempt has stopped: what is on screen is what the stopped
  // part was sent with, and changing it before "Try again" would send a
  // different request under the same key.
  const locked = check.isPending || run.isPending || stopped !== null;

  const busy = check.isPending || run.isPending;
  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // A drop lands here whatever the click guard below says.
    if (file && !busy) check.mutate({ file });
    // Cleared so the same file can be chosen again, which is what somebody
    // does after exporting it afresh.
    event.target.value = "";
  };

  const draftFor = (record: LedgerFilePlannedRecord) =>
    drafts.get(recordId(record.kind, record.key));
  const clearDraft = (record: LedgerFilePlannedRecord) =>
    setDrafts((current) => {
      const next = new Map(current);
      next.delete(recordId(record.kind, record.key));
      return next;
    });
  const setDraft = (record: LedgerFilePlannedRecord, draft: Omit<DecisionDraft, "kind" | "key">) =>
    setDrafts((current) => {
      const next = new Map(current);
      next.set(recordId(record.kind, record.key), {
        kind: record.kind,
        key: record.key,
        ...draft,
      });
      return next;
    });

  /**
   * Another way in, and the answers that no longer fit it let go.
   *
   * A move offers fewer choices than an add — an account or a category the
   * file's transactions are written to has to come in — so "Leave it out",
   * said while adding, is not a choice a move can be sent. It is dropped
   * rather than kept out of sight: switching back to adding would otherwise
   * bring it back unasked, chosen by somebody who has since been shown the
   * question without it.
   */
  const chooseMode = (next: LedgerFileImportMode) => {
    if (!checked || next === mode) return;
    const planner = next === "move" ? planLedgerFileMove : planLedgerFileAdd;
    const { plan } = planner({
      file: checked.file,
      facts: checked.facts,
      decisions: [...drafts.values()].map(decisionOf).filter((one) => one !== null),
      arriveArchived: [...archived],
      preferences,
    });
    const offered = new Map(
      plan.records.map((record) => [recordId(record.kind, record.key), record.choices]),
    );
    setDrafts(
      (current) =>
        new Map([...current].filter(([id, draft]) => offered.get(id)?.includes(draft.action))),
    );
    setMode(next);
  };

  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!checked || run.isPending) return;
    // Enter in a name field, or on a box or a radio, submits the form through
    // its default button, and every one of those controls is disabled while a
    // part runs and after it stops. A browser blurs what it disables, so a
    // stop arrived with focus on <body> (web.md 13.3). Focus goes to the
    // button the browser submitted through, which stays focusable while it
    // works, so the stop ends where a pressed button already ends.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter instanceof HTMLElement && document.activeElement !== submitter) {
      submitter.focus();
    }
    if (stopped && attempt) {
      if (balanceStopOf(stopped) !== null) return;
      run.mutate({ ...attempt, start: stopped.index });
      return;
    }
    if (!planned || !planned.plan.ok) return;
    const asked: Attempt = { ...planned.answers, mode: planned.mode, key: newIdempotencyKey() };
    setAttempt(asked);
    setDone(NOTHING_DONE);
    run.mutate({ ...asked, start: 1 });
  };

  const parts = checked?.parts.length ?? 1;
  // A move's bar is the phase in flight, written and then staged, each from
  // nothing to all of it. The commit's weights would start a move at a
  // quarter: they count a validating and a comparing pass a move does not
  // make, and while it writes, how many staged rows come after is not known,
  // so there is nothing to weigh the two by that is not a guess.
  const moving = (attempt?.mode ?? planned?.mode) === "move";
  const fraction = (event: ProgressEvent) =>
    moving
      ? event.total > 0
        ? Math.min(event.done / event.total, 1)
        : 1
      : progressFraction(event);

  return (
    <div className="panel ledger-import">
      <label className="file-drop">
        <FileUp size={26} />
        <strong>{checked?.name || chosenName || "Choose a Simple Balance file"}</strong>
        <span>A file exported from Simple Balance, on this copy or on another.</span>
        <span>Nothing is written until you add it or move it in.</span>
        {/* Refused while busy the way `Button` refuses, never `disabled`: a
            browser blurs an element it disables, so the input that was just
            used let go of focus and the preview arrived with it on `<body>`
            (web.md 13.3). Space, Enter and a click on the label all reach the
            input as a click, and preventing it keeps the chooser shut. */}
        <input
          type="file"
          accept=".json,application/json"
          aria-disabled={busy || undefined}
          onClick={(event) => {
            if (busy) event.preventDefault();
          }}
          onChange={chooseFile}
        />
      </label>

      {check.isPending ? (
        <div className="ledger-import-checking">
          {/* Said in words as well as drawn: a shimmer is a picture of waiting,
              and somebody who cannot see it is told which part is being read. */}
          <p role="status">
            {checking && checking.count > 1
              ? `Checking part ${formatCount(checking.index)} of ${formatCount(checking.count)} against this ledger`
              : "Checking the file against this ledger"}
          </p>
          {checked ? null : <Skeleton height={96} />}
        </div>
      ) : null}

      {check.error ? <FileRefused error={check.error} /> : null}

      {finished && checked && attempt?.mode === "move" ? (
        <MoveResult name={checked.name} done={done} parts={parts} facts={checked.facts} />
      ) : finished && checked ? (
        <AddResult name={checked.name} file={checked.file} results={done.added} />
      ) : checked ? (
        <form className="ledger-import-preview" onSubmit={start}>
          <ModeChoice
            facts={checked.facts}
            mode={effective}
            locked={locked}
            onChange={chooseMode}
          />

          {planned ? (
            <PreviewBody
              base={base}
              checked={checked}
              mode={planned.mode}
              plan={planned.plan}
              accounts={accounts}
              offered={planned.offered}
              locked={locked}
              draftFor={draftFor}
              setDraft={setDraft}
              clearDraft={clearDraft}
              archived={archived}
              setArchived={setArchived}
              preferences={preferences}
              setPreferences={setPreferences}
              showRecords={showRecords}
              setShowRecords={setShowRecords}
            />
          ) : (
            <Alert kind="info">
              This ledger can take the file either way. Choose one, and what it would do is shown
              here before anything is written.
            </Alert>
          )}

          {run.isPending && running ? (
            <div className="ledger-import-progress">
              {running.count > 1 ? (
                <p role="status">{`Part ${formatCount(running.index)} of ${formatCount(running.count)}`}</p>
              ) : null}
              {/* Never before a count is real (web.md 12.6): a part does its
                  records and its lookups before the first row, and reports
                  nothing while it does. */}
              {progress && progress.total >= PROGRESS_STREAM_MIN_ROWS ? (
                <ProgressBar
                  label={progressLabel(
                    progress,
                    moving && progress.phase === "posting" ? "written" : undefined,
                  )}
                  value={fraction(progress)}
                  max={1}
                />
              ) : null}
            </div>
          ) : null}

          {stopped ? (
            <StoppedNotice
              stopped={stopped}
              mode={attempt?.mode ?? "add"}
              count={parts}
              done={done.added.length + done.moved.length + done.passed.length}
              file={checked.file}
            />
          ) : null}

          <RunActions
            mode={planned?.mode}
            plan={planned?.plan ?? null}
            count={parts}
            stopped={stopped}
            pending={run.isPending}
            checking={check.isPending}
            onCheckAgain={() => check.mutate({ again: checked })}
          />
        </form>
      ) : null}
    </div>
  );
}

/**
 * The buttons under the preview: Check file again, and bring it in.
 *
 * One button whatever the state, in one place, so the element a keyboard
 * pressed is the element that is there when the answer comes. "Add to this
 * ledger" becomes "Move into this ledger" when the way in changes, and either
 * becomes "Try part 2 of 3 again" where a part stopped, rather than a second
 * button replacing the first: a replaced button takes focus to `<body>` with
 * it (web.md 13.3).
 */
function RunActions({
  mode,
  plan,
  count,
  stopped,
  pending,
  checking,
  onCheckAgain,
}: {
  mode: LedgerFileImportMode | undefined;
  plan: LedgerFilePlan | null;
  count: number;
  stopped: PartStopped | null;
  pending: boolean;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const open = plan?.problems.length ?? 0;
  // A problem about the move as a whole — rows still waiting in Staged, a
  // frozen account, a category of the wrong kind here — is something to do
  // rather than a question to answer, and is not counted as one.
  const settle = plan?.problems.some((problem) => problem.field === "move") ?? false;
  // Why the button cannot be pressed, said beside it (web.md 12.3), the first
  // unmet condition only. A stopped attempt is retryable, because it resends
  // what was already decided and a part that did finish replays — except one
  // stopped by its balances, which the same request meets again every time;
  // the notice above it says what changes that, and takes focus, since this
  // button lets go of it as it is disabled. A check in flight disables it too
  // and says nothing, because the check button beside it is spinning and that
  // is the answer.
  const blocked = stopped
    ? balanceStopOf(stopped) === null
      ? null
      : "Trying again would meet the same balances, so check the file again first."
    : plan === null
      ? "Choose how the file comes in."
      : settle
        ? "What is listed under Still to decide has to be settled first."
        : open > 0
          ? `${counted(open, "question is", "questions are")} still open above.`
          : nothingToDo(plan);
  const label = stopped
    ? count > 1
      ? `Try part ${formatCount(stopped.index)} of ${formatCount(count)} again`
      : "Try again"
    : mode === "move"
      ? "Move into this ledger"
      : mode === "add"
        ? "Add to this ledger"
        : // Neither way named before one is chosen: a button that said either
          // would be the page choosing it.
          "Import this file";
  return (
    <div className="form-actions">
      {/* Gone while a part is being brought in rather than disabled beside
          it: checking again then would read a ledger halfway through
          changing, and the busy button's own state already says why. */}
      {pending ? null : (
        <Button type="button" variant="secondary" loading={checking} onClick={onCheckAgain}>
          <RotateCcw size={16} /> Check file again
        </Button>
      )}
      <Button
        type="submit"
        loading={pending}
        disabled={checking || blocked !== null}
        disabledReason={checking ? undefined : (blocked ?? undefined)}
      >
        {label}
      </Button>
    </div>
  );
}

/**
 * Where an import stopped, what is in, and what pressing the button will do.
 *
 * "Nothing was written" only where the server answered: a part is one
 * transaction, so a refusal wrote none of it, but a connection that went away
 * says nothing about whether the part finished (web.md 12.6), and the notice
 * says that in its own words, since retrying with the part's key is how to
 * find out. A move's own refusals already end by saying nothing in the part
 * was written, and are not told it twice.
 *
 * A balance that did not come out names the first account in its sentence and
 * every account in its details; where there are several, each is listed under
 * it, so nobody has to fix one, try again and meet the next.
 */
function StoppedNotice({
  stopped,
  mode,
  count,
  done,
  file,
}: {
  stopped: PartStopped;
  mode: LedgerFileImportMode;
  count: number;
  done: number;
  file: LedgerFile;
}) {
  const refused = writeDidNotHappen(stopped.failure);
  const balance = refused ? balanceStopOf(stopped) : null;
  const issues = refused && balance === null ? refusalIssues(stopped.failure) : [];
  const before =
    done === 0
      ? null
      : done === 1
        ? `Part 1 of ${formatCount(count)} is in.`
        : `Parts 1 to ${formatCount(done)} of ${formatCount(count)} are in.`;
  const which =
    count > 1 ? `part ${formatCount(stopped.index)} of ${formatCount(count)}` : "the file";
  // A move's own refusals are written again here in this page's figures, from
  // what their details carry, by the functions that wrote them on the server.
  const told =
    balance !== null
      ? ledgerBalanceRefusal(
          balance.mismatches,
          balance.throughDate,
          { part: { index: stopped.index, count }, startsOn: file.scope.start },
          FIGURES,
        ).message
      : (entryRefusalShown(stopped, file) ?? stopped.message);
  const said = balance !== null || told.includes("Nothing in this part was written.");
  // A connection that went away is not a refusal (web.md 12.6): the part is
  // one transaction the server finishes whether or not anybody is still
  // listening, so its outcome is unknown, and the browser's own "Failed to
  // fetch" says none of that. Trying again finds out, because the part's key
  // replays one that finished.
  const lead = refused
    ? said
      ? told
      : `${told} ${count > 1 ? `Nothing from part ${formatCount(stopped.index)} was written.` : "Nothing was written."}`
    : `The connection was lost before ${which} answered, so whether it was ${mode === "move" ? "moved" : "added"} is not known.`;
  return (
    <>
      <Alert takeFocus={balance !== null}>
        {lead}
        {before ? ` ${before}` : null}
        {balance !== null && balance.mismatches.length > 1 ? (
          <ul className="ledger-import-issues">
            {balance.mismatches.map((mismatch) => (
              <li key={mismatch.key}>{ledgerBalanceIssue(mismatch, FIGURES)}</li>
            ))}
          </ul>
        ) : issues.length > 1 ? (
          <ul className="ledger-import-issues">
            {issues.map((issue, index) => (
              <li key={`${index}-${issue.field}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
      </Alert>
      <Note>
        {balance !== null
          ? "Trying again sends exactly what was sent before, so it would meet the same balances. Rename the account here under Accounts, then check the file again, and the file's comes in as a new account; or check the file again and add it instead. Checking again reads this ledger afresh and keeps what you decided."
          : `Trying again sends exactly what was sent before, and a part that did finish is not ${mode === "move" ? "moved" : "added"} twice. Checking the file again, or choosing it again, reads this ledger afresh and keeps what you decided: whatever an earlier part brought in is recognized and skipped under the same decisions, and a new name for a renamed record would bring in a second copy.`}
      </Note>
    </>
  );
}

/** The balances a move's part did not come out at, when that is why it stopped. */
function balanceStopOf(stopped: PartStopped) {
  return stopped.failure instanceof ApiClientError
    ? ledgerBalanceRefusalOf(stopped.failure.details)
    : null;
}

/**
 * A move's refusal of one transaction, written again with the transaction's
 * money and day in this page's figures, or null when the stop is not one. The
 * transaction is found in the file by the origin the details carry, and the
 * service's reason is read back out of the server's sentence by the function
 * that is its inverse, so nothing here matches on words of its own.
 */
function entryRefusalShown(stopped: PartStopped, file: LedgerFile): string | null {
  const failure = stopped.failure;
  if (!(failure instanceof ApiClientError)) return null;
  const origin = (failure.details as { origin?: unknown } | undefined)?.origin;
  const entry = file.entries.find((each) => each.id === origin);
  if (entry === undefined) return null;
  const reason = ledgerMoveEntryReason(entry, stopped.message);
  if (reason === null) return null;
  const side = entry.type === "deposit" ? entry.to : entry.from;
  const currency = file.accounts.find((account) => account.key === side)?.currency;
  return ledgerMoveEntryRefusal(entry, reason, { figures: FIGURES, currency });
}

/**
 * How the file comes in: moved straight into the books, or added with its
 * transactions sent to Staged.
 *
 * Both offered where this ledger may take a move, and neither chosen: they
 * write different things, and which is right is somebody's own call about
 * their own ledger. Where it may not, moving is still shown, refused, with the
 * sentence the server would refuse it in as its description, and adding is
 * the one chosen; a move that silently was not there would be one somebody had
 * to know about to miss.
 *
 * Native radios in one named group, so the arrow keys move between the two
 * and pass over a refused one (web.md 8.8), drawn as the two cards the
 * transaction form offers "Commit now" and "Stage for review" in, which is the
 * same question asked of one transaction. Each is named by its title alone
 * and described by its sentence, so a screen reader hears the choice and then
 * what it does, rather than both run together as one name.
 */
function ModeChoice({
  facts,
  mode,
  locked,
  onChange,
}: {
  facts: LedgerFileFacts;
  mode: LedgerFileImportMode | undefined;
  locked: boolean;
  onChange: (mode: LedgerFileImportMode) => void;
}) {
  const group = useId();
  const blocked = !facts.move.qualifies;
  return (
    <div className="field ledger-import-mode">
      <span className="field-label" id={`${group}-question`}>
        How should this file come in?
      </span>
      <span className="field-hint" id={`${group}-why`}>
        A move brings what adding cannot: deleted transactions, accounts archived on the day they
        were, and no transaction left to review. It is offered only while everything in this ledger
        came from a Simple Balance file, as in a new one. Once a transaction is typed in or
        committed from a CSV, a file can only be added; a row waiting in Staged stops a move only
        until it is discarded.
      </span>
      <div
        className="commit-choice"
        role="radiogroup"
        aria-labelledby={`${group}-question`}
        aria-describedby={`${group}-why`}
      >
        {MODE_ORDER.map((each) => {
          const refused = each === "move" && blocked;
          return (
            <label key={each} className={refused ? "ledger-import-mode-refused" : undefined}>
              <input
                type="radio"
                name={group}
                checked={mode === each}
                disabled={locked || refused}
                aria-labelledby={`${group}-${each}`}
                aria-describedby={refused ? `${group}-${each}-reason` : `${group}-${each}-what`}
                onChange={() => onChange(each)}
              />
              <span>
                <strong id={`${group}-${each}`}>{MODE_CHOICES[each].title}</strong>
                <small id={`${group}-${each}-what`}>{MODE_CHOICES[each].description}</small>
                {refused ? (
                  <small className="ledger-import-mode-reason" id={`${group}-${each}-reason`}>
                    {facts.move.reason ?? LEDGER_FILE_MOVE_BLOCKED}
                  </small>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The one sentence the preview leads with: ready, and what will be written,
 * or what is in the way. A move's own problems — rows waiting in Staged, a
 * frozen account, a category of the wrong kind here — are things to settle
 * rather than questions, and are said as such.
 */
function summaryOf(plan: LedgerFilePlan): string {
  const { move } = plan;
  if (!plan.ok) {
    if (plan.problems.some((problem) => problem.field === "move")) {
      return `This file cannot be moved into this ledger until ${plan.problems.length === 1 ? "what is" : "everything"} listed under Still to decide is settled.`;
    }
    return `${counted(plan.problems.length, "question")} to answer before this file can be ${move ? "moved" : "added"}.`;
  }
  const idle = nothingToDo(plan);
  if (idle) return idle;
  const created = counted(
    plan.records.filter((record) => record.action === "create").length,
    "new record",
  );
  if (!move) return `Ready to add: ${created} and ${counted(plan.rows.toStage, "row")} for Staged.`;
  // The live ones: the deleted ones are said on their own line below, as
  // what they are, and counted here they read as money that moves.
  const written = counted(move.toWrite, "transaction");
  return plan.rows.toStage > 0
    ? `Ready to move: ${created}, ${written} straight into the books and ${counted(plan.rows.toStage, "row")} for Staged.`
    : `Ready to move: ${created} and ${written} straight into the books.`;
}

/** Everything between the file and the buttons. */
function PreviewBody({
  base,
  checked,
  mode,
  plan,
  accounts,
  offered,
  locked,
  draftFor,
  setDraft,
  clearDraft,
  archived,
  setArchived,
  preferences,
  setPreferences,
  showRecords,
  setShowRecords,
}: {
  base: string;
  checked: CheckedFile;
  mode: LedgerFileImportMode;
  plan: LedgerFilePlan;
  accounts: ReadonlyMap<string, LedgerFileAccount>;
  offered: readonly LedgerFilePlannedRecord[];
  locked: boolean;
  draftFor: (record: LedgerFilePlannedRecord) => DecisionDraft | undefined;
  setDraft: (record: LedgerFilePlannedRecord, draft: Omit<DecisionDraft, "kind" | "key">) => void;
  clearDraft: (record: LedgerFilePlannedRecord) => void;
  archived: ReadonlySet<string>;
  setArchived: (next: ReadonlySet<string>) => void;
  preferences: LedgerPreferencesChoice | undefined;
  setPreferences: (choice: LedgerPreferencesChoice) => void;
  showRecords: boolean;
  setShowRecords: (show: boolean) => void;
}) {
  const asking = plan.records.filter((record) => record.choices.length > 0);
  // Where each question is on the page, so the list of what is still open can
  // take somebody to it.
  const anchorOf = (problem: LedgerFilePlanProblem): string | null => {
    if (problem.field === "arriveArchived") return `${base}-archived`;
    if (problem.field === "preferences") return `${base}-preferences`;
    if (problem.kind === undefined || problem.key === undefined) return null;
    const at = asking.findIndex(
      (record) => record.kind === problem.kind && record.key === problem.key,
    );
    return at === -1 ? null : `${base}-decision-${at}`;
  };
  const notes = plan.records.filter((record) => record.message && record.choices.length === 0);
  const rows = rowSentences(plan, checked.parts.length, checked.file);
  const tallied = ledgerImportKinds
    .map((kind) => {
      const counts = plan.counts[kind];
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      return {
        kind,
        total,
        create: counts.create,
        use: counts.use,
        undecided: counts.undecided,
        left: counts.skip + counts.leave_staged + counts.drop + counts.refused,
      };
    })
    .filter((row) => row.total > 0);
  const summary = summaryOf(plan);

  return (
    <>
      <Alert kind="info">{summary}</Alert>

      <div className="ledger-import-block">
        <h3>What the file holds</h3>
        {tallied.length ? (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="What happens to each kind of record in the file"
          >
            <table className="data-table ledger-import-counts">
              <caption className="sr-only">What happens to each kind of record in the file</caption>
              <thead>
                <tr>
                  <th scope="col">Kind</th>
                  <th scope="col" className="align-right">
                    In the file
                  </th>
                  <th scope="col" className="align-right">
                    New
                  </th>
                  <th scope="col" className="align-right">
                    Already here
                  </th>
                  <th scope="col" className="align-right">
                    Needs a choice
                  </th>
                  <th scope="col" className="align-right">
                    Left out
                  </th>
                </tr>
              </thead>
              <tbody>
                {tallied.map((row) => (
                  <tr key={row.kind}>
                    <th scope="row">{KIND_NAMES[row.kind].many}</th>
                    <td className="align-right">{formatCount(row.total)}</td>
                    <td className="align-right">{formatCount(row.create)}</td>
                    <td className="align-right">{formatCount(row.use)}</td>
                    <td className="align-right">{formatCount(row.undecided)}</td>
                    <td className="align-right">{formatCount(row.left)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Note>
            It holds no accounts, categories, templates, recurring transactions or budgets.
          </Note>
        )}
        {rows.length ? (
          <ul className="ledger-import-notes">
            {rows.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        ) : (
          <Note>It holds no transactions and no staged rows.</Note>
        )}
        {notes.length ? (
          <ul className="ledger-import-notes">
            {notes.map((record) => (
              <li key={recordId(record.kind, record.key)}>
                <strong>{recordTitle(record, accounts)}</strong> {record.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="ledger-import-block">
        <div className="ledger-import-records-head">
          <h3>Every record</h3>
          <Button
            type="button"
            variant="ghost"
            aria-expanded={showRecords}
            aria-controls={`${base}-records-table`}
            onClick={() => setShowRecords(!showRecords)}
          >
            {showRecords
              ? "Hide records"
              : `Show ${plan.records.length === 1 ? "record" : `all ${formatCount(plan.records.length)} records`}`}
          </Button>
        </div>
        {showRecords ? (
          <div
            id={`${base}-records-table`}
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Every record in the file, and what happens to it"
          >
            <table className="data-table ledger-import-records">
              <caption className="sr-only">
                Every record in the file, and what happens to it
              </caption>
              <thead>
                <tr>
                  {/* What happens second: a table scrolls rather than
                      reflows, and on a phone the first two columns are the
                      ones on screen — which holds because the cells that
                      carry a name may break anywhere (the stylesheet's
                      `.ledger-import-records`), so one long name cannot
                      make either column wider than the phone. */}
                  <th scope="col">Record</th>
                  <th scope="col">What happens</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {plan.records.map((record) => {
                  const outcome = outcomeOf(record);
                  return (
                    <tr key={recordId(record.kind, record.key)}>
                      <th scope="row">
                        {recordName(record)}
                        {record.detail === "reference" ? (
                          <span className="subtle"> named by the file</span>
                        ) : null}
                      </th>
                      <td>
                        <Badge tone={outcome.tone}>{outcome.text}</Badge>
                      </td>
                      <td>{KIND_NAMES[record.kind].one}</td>
                      <td className="ledger-import-why">{record.message ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {asking.length ? (
        <div className="ledger-import-block">
          <h3>
            {asking.length === 1
              ? "One record needs a choice"
              : `${formatCount(asking.length)} records need a choice`}
          </h3>
          <Note>
            {[
              "Each is already here under the same name, or is named by the file and not here. Nothing here is changed whatever you choose.",
              // Said only of a move, which offers less than an add, so that a
              // missing "Leave it out" reads as a rule rather than a gap.
              mode === "move"
                ? "An account or a category the file's transactions are written to has to come in, so leaving one out is not offered."
                : null,
              asking.some((record) => record.choices.includes("leave_staged"))
                ? mode === "move"
                  ? "One left for review keeps the file's staged rows that name it waiting in Staged, to be settled there."
                  : "One left for review keeps the transactions that name it waiting in Staged, to be settled there."
                : null,
            ]
              .filter((sentence) => sentence !== null)
              .join(" ")}
          </Note>
          <div className="ledger-import-decisions">
            {asking.map((record, at) => (
              <RecordDecision
                key={recordId(record.kind, record.key)}
                id={`${base}-decision-${at}`}
                record={record}
                draft={draftFor(record)}
                locked={locked}
                checked={checked}
                plan={plan}
                accounts={accounts}
                problems={plan.problems.filter(
                  (problem) => problem.kind === record.kind && problem.key === record.key,
                )}
                onChange={(draft) => setDraft(record, draft)}
                onClear={() => clearDraft(record)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {offered.length ? (
        <ArriveArchived
          id={`${base}-archived`}
          mode={mode}
          offered={offered}
          plan={plan}
          accounts={accounts}
          archived={archived}
          locked={locked}
          onChange={setArchived}
        />
      ) : null}

      <PreferencesChoice
        id={`${base}-preferences`}
        file={checked.file}
        facts={checked.facts}
        plan={plan}
        choice={preferences}
        locked={locked}
        onChange={setPreferences}
      />

      {plan.problems.length ? (
        <div className="ledger-import-todo">
          <h3>Still to decide</h3>
          <ul>
            {plan.problems.slice(0, 10).map((problem, index) => {
              const anchor = anchorOf(problem);
              return (
                <li key={`${index}-${problem.field}-${problem.key ?? ""}`}>
                  {anchor ? (
                    <a
                      href={`#${anchor}`}
                      onClick={(event) => {
                        // Focus rather than a fragment, as the error summary
                        // does: nothing is written into the address. The
                        // control the sentence is about: the answer's own
                        // field once a choice takes one (a name, a record to
                        // use), else the choice made, else the first control,
                        // which is where an unanswered question starts. Keyed
                        // on what is rendered rather than on the problem's
                        // path, since a name clash is reported on the bare
                        // `decisions` field.
                        event.preventDefault();
                        const at = document.getElementById(anchor);
                        (
                          at?.querySelector<HTMLElement>(
                            ".ledger-import-answer input, .ledger-import-answer select",
                          ) ??
                          at?.querySelector<HTMLElement>('input[type="radio"]:checked') ??
                          at?.querySelector<HTMLElement>("input, select")
                        )?.focus();
                      }}
                    >
                      {problem.message}
                    </a>
                  ) : (
                    problem.message
                  )}
                </li>
              );
            })}
          </ul>
          {plan.problems.length > 10 ? (
            <p>{`And ${formatCount(plan.problems.length - 10)} more.`}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * One record that needs a choice, and the choice.
 *
 * A radio for each decision the plan says this record takes, and no others:
 * an account in another currency is never offered as the one here, and a
 * recurring transaction is never "used", since nothing else in a file names
 * one. The name a copy takes is offered only once somebody picks a copy, and
 * then as a suggestion they can change: a name nobody chose is a guess. The
 * suggestion is the name of the copy already here when the planner found
 * one, so an import resumed from a fresh check brings the file's record back
 * to the copy it made rather than to a third.
 *
 * A record with one answer is asked as that answer to tick, not as a radio
 * group of one, which once picked could not be taken back.
 */
function RecordDecision({
  id,
  record,
  draft,
  locked,
  checked,
  plan,
  accounts,
  problems,
  onChange,
  onClear,
}: {
  id: string;
  record: LedgerFilePlannedRecord;
  draft: DecisionDraft | undefined;
  locked: boolean;
  checked: CheckedFile;
  plan: LedgerFilePlan;
  accounts: ReadonlyMap<string, LedgerFileAccount>;
  problems: readonly LedgerFilePlanProblem[];
  onChange: (draft: Omit<DecisionDraft, "kind" | "key">) => void;
  onClear: () => void;
}) {
  const group = useId();
  const title = recordTitle(record, accounts);
  const action = draft && record.choices.includes(draft.action) ? draft.action : undefined;
  const currency = record.kind === "account" ? accounts.get(record.key)?.currency : undefined;
  const candidates =
    action === "match" ? matchCandidates(record.kind, checked.facts, currency) : [];
  // Every name this kind already goes by, here and in the file, so the name
  // offered for a copy is one nothing else is using.
  const taken = () => {
    const here = checked.facts.here;
    const herenames =
      record.kind === "group"
        ? here.groups
        : record.kind === "category"
          ? here.categories
          : record.kind === "account"
            ? here.accounts
            : record.kind === "template"
              ? here.templates
              : record.kind === "recurrence"
                ? here.recurrences
                : [];
    return [
      ...herenames.map((one) => one.name),
      ...plan.records
        .filter((other) => other.kind === record.kind)
        .flatMap((other) => [other.name, other.importName ?? ""]),
    ];
  };
  // A reference's own name is taken when an account of that name is here in
  // another currency, or the file carries a different record under it; then
  // it is created under a name somebody gives it.
  const ownNameTaken =
    record.existing !== null ||
    plan.records.some(
      (other) =>
        other !== record &&
        other.kind === record.kind &&
        other.detail === "full" &&
        normalizeHumanName(other.name) === normalizeHumanName(record.name),
    ) ||
    draft?.name !== undefined;
  // Shown beside the record only once somebody has answered it, and answered
  // it whole. Before that, the record's own sentence and its radios already
  // ask the question, and a match with nothing picked yet is asked by its
  // own "Choose one".
  const shown = action && draft && decisionOf(draft) !== null ? problems : [];
  const choose = (choice: LedgerDecisionAction) => {
    if (choice === "rename" || (choice === "create" && ownNameTaken)) {
      onChange({
        action: choice,
        name:
          draft?.name ??
          (choice === "rename" ? record.copy?.name : undefined) ??
          suggestLedgerRename(record.name, taken()),
      });
    } else if (choice === "match") {
      onChange({ action: choice, id: draft?.id ?? "" });
    } else {
      onChange({ action: choice });
    }
  };
  const nameLabel =
    action === "create" ? `Name to create "${record.name}" under` : `New name for "${record.name}"`;
  const naming = action === "rename" || (action === "create" && draft?.name !== undefined);
  // A sentence about the answer's own field is bound to that field — said
  // beside it, `aria-invalid` on it, and named by its `aria-describedby`
  // (web.md 8.1) — and only what is about the record as a whole stays a
  // paragraph under it. A name clash is reported on the bare `decisions`
  // field, and once an answer is shown that is the only sentence there.
  const aboutName = (problem: LedgerFilePlanProblem) =>
    naming && (problem.field.endsWith(".name") || problem.field === "decisions");
  const aboutId = (problem: LedgerFilePlanProblem) =>
    action === "match" && problem.field.endsWith(".id");
  const sentences = (pick: (problem: LedgerFilePlanProblem) => boolean) =>
    shown
      .filter(pick)
      .map((problem) => problem.message)
      .join(" ") || undefined;
  const nameProblem = sentences(aboutName);
  const idProblem = sentences(aboutId);
  const rest = shown.filter((problem) => !aboutName(problem) && !aboutId(problem));
  // A sentence about the record as a whole describes the choice it is about,
  // as the record's own reason does. Written as paragraphs and pointed at by
  // nothing, a refusal that appeared after a radio was picked was neither
  // announced nor read with the choice when focus came back to it (8.1).
  const describedBy =
    [record.message ? `${group}-why` : null, ...rest.map((_, index) => `${group}-problem-${index}`)]
      .filter(Boolean)
      .join(" ") || undefined;
  const only = record.choices.length === 1 ? record.choices[0]! : null;
  return (
    <div className="ledger-import-decision" id={id}>
      <span className="field-label" id={`${group}-question`}>
        {title}
      </span>
      {record.message ? (
        <p className="note" id={`${group}-why`}>
          {record.message}
        </p>
      ) : null}
      {only ? (
        <div className="radio-row">
          <label className="check-label">
            {/* Named by the question and the answer together, since one
                answer needs no group around it to say what it is about. */}
            <input
              type="checkbox"
              aria-labelledby={`${group}-question ${group}-answer`}
              aria-describedby={describedBy}
              checked={action === only}
              disabled={locked}
              onChange={(event) => (event.target.checked ? choose(only) : onClear())}
            />
            <span id={`${group}-answer`}>{choiceLabel(record, only)}</span>
          </label>
        </div>
      ) : (
        <div
          className="radio-row"
          role="radiogroup"
          aria-labelledby={`${group}-question`}
          aria-describedby={describedBy}
        >
          {record.choices.map((choice) => (
            <label className="check-label" key={choice}>
              <input
                type="radio"
                name={group}
                checked={action === choice}
                disabled={locked}
                onChange={() => choose(choice)}
              />
              {choiceLabel(record, choice)}
            </label>
          ))}
        </div>
      )}
      {naming ? (
        <div className="ledger-import-answer">
          <Field
            label={nameLabel}
            error={nameProblem}
            {...(action === "rename" && record.copy
              ? {
                  hint: `"${record.copy.name}" here is the same as the file's in every field, so an earlier import may have brought it in under that name.`,
                }
              : {})}
          >
            <Input
              value={draft?.name ?? ""}
              disabled={locked}
              onChange={(event) => onChange({ action: action!, name: event.target.value })}
            />
          </Field>
        </div>
      ) : null}
      {action === "match" ? (
        <div className="ledger-import-answer">
          <Field
            label={`${KIND_NAMES[record.kind].one} here to use for "${record.name}"`}
            error={idProblem}
          >
            <Select
              value={draft?.id ?? ""}
              disabled={locked}
              onChange={(event) => onChange({ action: "match", id: event.target.value })}
            >
              {/* Always something to choose: the planner offers "Use another
                  here" only where one of these exists. */}
              <option value="" disabled>
                Choose one
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.archived ? `${candidate.name} (archived)` : candidate.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      {rest.map((problem, index) => (
        <p
          className="ledger-import-problem"
          id={`${group}-problem-${index}`}
          key={`${index}-${problem.field}`}
        >
          {problem.message}
        </p>
      ))}
    </div>
  );
}

/**
 * The accounts the file brings that would take a place, any of which somebody
 * may choose to have arrive archived.
 *
 * Offered whatever the plan, because an agent can ask for it and a person has
 * to be able to as well, and with nothing checked, because which of
 * somebody's accounts to put away is theirs to say. Places are spoken of only
 * where a plan limits them. Where the plan keeps fewer places than are
 * coming, the numbers are said here and the import waits until enough are
 * chosen.
 *
 * What arriving archived costs differs by the way in, and the hint says which:
 * an add leaves the account's transactions in Staged until it is restored,
 * because a staged row cannot be committed into an archived account, and a
 * move writes them into it and puts it away holding nothing from that day on,
 * the way archiving any account leaves it.
 */
function ArriveArchived({
  id,
  mode,
  offered,
  plan,
  accounts,
  archived,
  locked,
  onChange,
}: {
  id: string;
  mode: LedgerFileImportMode;
  offered: readonly LedgerFilePlannedRecord[];
  plan: LedgerFilePlan;
  accounts: ReadonlyMap<string, LedgerFileAccount>;
  archived: ReadonlySet<string>;
  locked: boolean;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const { limit, inUse, arriving, needed, chosen } = plan.places;
  const after =
    mode === "move"
      ? "Its transactions are written into it, and it holds nothing from the day of the move; restoring it posts its balance back."
      : "Its transactions still go to Staged, and wait there until you restore it.";
  return (
    <div id={id}>
      <Field
        as="group"
        label="Accounts to arrive archived"
        // Places only where a plan keeps a number of them: a copy that sells
        // nothing, and the paid plan, have none (common.md's glossary), and the
        // choice is offered there anyway because an agent can make it.
        //
        // What the person has to do opens the hint rather than sitting in a
        // Note beside the group, which no control pointed at (`web.md` 8.1's
        // third defect): somebody who followed "Still to decide" here heard
        // the first box, the group and the hint, and not that at least so many
        // had to be checked. In the hint it is the group's description, and
        // the count chosen so far is read again whenever focus enters it.
        hint={
          limit !== null
            ? `${
                needed > 0
                  ? `Your plan keeps ${formatCount(limit)} accounts in use, and ${formatCount(inUse)} ${inUse === 1 ? "is" : "are"} in use here. This file brings ${formatCount(arriving)} more, so choose at least ${formatCount(needed)} to arrive archived, or upgrade under Settings. ${formatCount(chosen)} chosen so far. `
                  : ""
              }An account that arrives archived uses no place. ${after}`
            : `An account that arrives archived is put away as it arrives. ${after}`
        }
      >
        <ul className="ledger-import-choices">
          {offered.map((record) => (
            <li key={record.key}>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={archived.has(record.key)}
                  disabled={locked}
                  onChange={(event) => {
                    const next = new Set(archived);
                    if (event.target.checked) next.add(record.key);
                    else next.delete(record.key);
                    onChange(next);
                  }}
                />
                {/* The spaces are for the name a screen reader reads, which
                    runs the parts together without them. */}
                {record.importName ?? record.name}{" "}
                <span className="subtle">{accounts.get(record.key)?.currency}</span>
              </label>
            </li>
          ))}
        </ul>
      </Field>
    </div>
  );
}

/**
 * What happens to the file's regional defaults and appearance.
 *
 * Applied without asking where this copy has no settings of its own, and
 * asked where it has and the file's differ: a guess never overwrites a
 * decision, and somebody's settings are one. A new sign-up usually has some
 * already, because the browser's timezone and currency are taken on first
 * load and are stored as chosen from then on, so it is asked too; the
 * question says where those came from rather than calling them a choice.
 * Nothing is drawn where the file carries none, or they agree.
 */
function PreferencesChoice({
  id,
  file,
  facts,
  plan,
  choice,
  locked,
  onChange,
}: {
  id: string;
  file: LedgerFile;
  facts: LedgerFileFacts;
  plan: LedgerFilePlan;
  choice: LedgerPreferencesChoice | undefined;
  locked: boolean;
  onChange: (choice: LedgerPreferencesChoice) => void;
}) {
  const group = useId();
  const theirs = file.preferences;
  const ours = facts.here.preferences;
  if (!plan.preferences.inFile || theirs === null) return null;
  // Three values rather than a sentence, joined the way a composed label
  // joins values elsewhere (the staged queue's batch filter): "Europe/Berlin,
  // EUR, Follow my system" read as a sentence with a command at its end.
  const describe = (one: { timezone: string; defaultCurrency: string; theme: string }) =>
    `${one.timezone} · ${one.defaultCurrency} · ${themeLabel(one.theme)}`;
  if (!plan.preferences.chosenHere) {
    return (
      <Note>
        {`This copy has not chosen its regional defaults and appearance, so it takes the file's: ${describe(theirs)}.`}
      </Note>
    );
  }
  if (!plan.preferences.differs) return null;
  return (
    <div className="field" id={id}>
      <span className="field-label" id={`${group}-question`}>
        Regional defaults and appearance
      </span>
      <span className="field-hint" id={`${group}-why`}>
        This copy has its own, set in Settings or taken from this browser when it was first opened,
        and the file's differ.
      </span>
      <div
        className="radio-row"
        role="radiogroup"
        aria-labelledby={`${group}-question`}
        aria-describedby={`${group}-why`}
      >
        <label className="check-label">
          <input
            type="radio"
            name={group}
            checked={choice === "file"}
            disabled={locked}
            onChange={() => onChange("file")}
          />
          {`Use the file's: ${describe(theirs)}`}
        </label>
        <label className="check-label">
          <input
            type="radio"
            name={group}
            checked={choice === "keep"}
            disabled={locked}
            onChange={() => onChange("keep")}
          />
          {`Keep this copy's: ${describe(ours)}`}
        </label>
      </div>
    </div>
  );
}

/**
 * Per record, the furthest any part got: created in one, it is created.
 *
 * Records are read off each part's plan with the ids it filled in: every part
 * carries every record, so the first part creates them and every later one
 * finds them here.
 */
function recordsAcross(plans: readonly LedgerFilePlan[]): LedgerFilePlannedRecord[] {
  const outcome = new Map<string, LedgerFilePlannedRecord>();
  for (const plan of plans) {
    for (const record of plan.records) {
      const id = recordId(record.kind, record.key);
      const seen = outcome.get(id);
      if (!seen || (seen.action !== "create" && record.action === "create")) {
        outcome.set(id, record);
      }
    }
  }
  return [...outcome.values()];
}

/** One sentence a kind: how many of its records were created, were here, and were left out. */
function kindSentences(records: readonly LedgerFilePlannedRecord[]): string[] {
  return ledgerImportKinds
    .filter((kind) => kind !== "budget_entry")
    .flatMap((kind) => {
      const ofKind = records.filter((record) => record.kind === kind);
      if (!ofKind.length) return [];
      const made = ofKind.filter((record) => record.action === "create").length;
      const used = ofKind.filter((record) => record.action === "use").length;
      const left = ofKind.length - made - used;
      return [
        `${KIND_NAMES[kind].many}: ${formatCount(made)} created, ${formatCount(used)} already here, ${formatCount(left)} left out.`,
      ];
    });
}

type StagedBatch = { id: string; part: { index: number }; staged: number };

/**
 * Where to go next: each batch the import staged rows under, and Accounts.
 *
 * The batch, so the queue opens on these rows rather than on everything ever
 * staged, and all-time, because the queue's this-month default hid every
 * imported row dated outside the month (the CSV import's precedent).
 */
function ResultLinks({
  batches,
  archived,
}: {
  batches: readonly StagedBatch[];
  /** Whether a sentence above tells somebody to restore an account. */
  archived: boolean;
}) {
  return (
    <div className="ledger-import-links">
      {batches.map((batch) => (
        <Link
          className="button button-primary"
          key={batch.id}
          to={{
            pathname: "/staged",
            search: queryString({ importBatchId: batch.id, preset: "all-time" }),
          }}
        >
          {batches.length > 1
            ? `Review part ${formatCount(batch.part.index)}'s ${counted(batch.staged, "staged row")}`
            : `Review ${counted(batch.staged, "staged row")}`}
        </Link>
      ))}
      {/* With archived accounts shown, where a sentence above sends somebody
          to restore one: the list hides them by default, so a bare link
          landed on a page without the account it named (`web.md` 11.8). */}
      <Link
        className="button button-secondary"
        to={
          archived ? { pathname: "/accounts", search: queryString({ archived: "1" }) } : "/accounts"
        }
      >
        Open Accounts
      </Link>
    </div>
  );
}

const batchesOf = (
  results: readonly (LedgerFileAddResult | LedgerFileMoveResult)[],
): StagedBatch[] =>
  results.flatMap((result) =>
    result.importBatchId === null
      ? []
      : [{ id: result.importBatchId, part: result.part, staged: result.staged }],
  );

/**
 * What an add did, summed over its parts. Rows and budget amounts are each
 * part's own and are added up.
 */
function AddResult({
  name,
  file,
  results,
}: {
  name: string;
  file: LedgerFile;
  results: readonly LedgerFileAddResult[];
}) {
  const staged = results.reduce((sum, result) => sum + result.staged, 0);
  const needsReview = results.reduce((sum, result) => sum + result.needsReview, 0);
  const amounts = results.reduce(
    (sum, result) => ({
      created: sum.created + result.budgetEntries.created,
      skipped: sum.skipped + result.budgetEntries.skipped,
    }),
    { created: 0, skipped: 0 },
  );
  const records = recordsAcross(results.map((result) => result.plan));
  const perKind = kindSentences(records);
  const putAway = records.filter(
    (record) => record.kind === "account" && record.action === "create" && record.arrivesArchived,
  );
  const archivedAtSource = new Set(
    file.categories
      .filter((category) => category.detail === "full" && category.archivedAt !== null)
      .map((category) => category.key),
  );
  const unarchived = records.filter(
    (record) =>
      record.kind === "category" && record.action === "create" && archivedAtSource.has(record.key),
  );
  return (
    <div className="ledger-import-result">
      <Alert kind="success" takeFocus>
        {`Added "${name}" to this ledger. `}
        {staged
          ? `${counted(staged, "row")} went to Staged for review${needsReview ? `, and ${formatCount(needsReview)} of them need something from you before they can be committed` : ""}.`
          : "Nothing went to Staged."}
      </Alert>
      <ul className="ledger-import-notes">
        {perKind.map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
        {amounts.created || amounts.skipped ? (
          <li>
            {`Budget amounts: ${formatCount(amounts.created)} set, ${formatCount(amounts.skipped)} left out.`}
          </li>
        ) : null}
        {putAway.map((record) => (
          <li key={`archived-${record.key}`}>
            {`"${record.importName ?? record.name}" arrived archived. Restore it from Accounts to commit its transactions.`}
          </li>
        ))}
        {unarchived.map((record) => (
          <li key={`category-${record.key}`}>
            {`"${record.importName ?? record.name}" was archived where it came from and arrived in use, so the transactions filed under it can be committed. Archive it again once they are.`}
          </li>
        ))}
      </ul>
      <ResultLinks batches={batchesOf(results)} archived={putAway.length > 0} />
    </div>
  );
}

/**
 * Drift from every part as one list: the same currency and the same two sides
 * added up, so a refund split across two parts is one sentence, not two.
 */
function mergedDrift(results: readonly LedgerFileMoveResult[]): LedgerFileDrift[] {
  const merged = new Map<string, LedgerFileDrift>();
  for (const drift of results.flatMap((result) => result.plan.move?.drift ?? [])) {
    const slot = `${drift.currency}|${drift.type}|${drift.from}|${drift.to}`;
    const seen = merged.get(slot);
    merged.set(
      slot,
      seen
        ? {
            ...seen,
            entries: seen.entries + drift.entries,
            amount: addDecimalText(seen.amount, drift.amount),
            categories: [...new Set([...seen.categories, ...drift.categories])],
          }
        : drift,
    );
  }
  return [...merged.values()];
}

/**
 * What a move did, summed over its parts and the parts it found in already.
 *
 * The balance check is reported from the one part that carried balances —
 * the last — because that is the one that held every account to the file; a
 * part that ran at all passed it, since one that did not wrote nothing.
 *
 * The archived accounts are named rather than counted. Each part says how
 * many archived accounts it wrote into (`archived`), and one account with
 * transactions in three parts is three of those; by name, it is one. It counts
 * those created archived, and those already archived here that a part wrote
 * into, which is what a resumed move finds of the ones its first attempt made.
 */
function MoveResult({
  name,
  done,
  parts,
  facts,
}: {
  name: string;
  done: Done;
  parts: number;
  facts: LedgerFileFacts;
}) {
  const results = done.moved;
  const sum = (pick: (result: LedgerFileMoveResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const passed = (pick: (part: PassedPart) => number) =>
    done.passed.reduce((total, part) => total + pick(part), 0);
  const written = sum((result) => result.written.entries);
  const deleted = sum((result) => result.written.deleted);
  const skipped =
    sum((result) => result.skipped.entries + result.skipped.deleted) +
    passed((part) => part.entries + part.deleted);
  const waitingAlready = sum((result) => result.skipped.staged) + passed((part) => part.staged);
  const staged = sum((result) => result.staged);
  const needsReview = sum((result) => result.needsReview);
  const amounts = {
    created: sum((result) => result.budgetEntries.created),
    skipped: sum((result) => result.budgetEntries.skipped),
  };
  const records = recordsAcross(results.map((result) => result.plan));
  const archivedHere = new Set(
    facts.here.accounts
      .filter((account) => account.detail === "full" && account.archivedAt !== null)
      .map((account) => account.key),
  );
  const holding = records
    .filter(
      (record) =>
        record.kind === "account" &&
        ((record.action === "create" && record.arrivesArchived) ||
          (record.action === "use" &&
            record.existing !== null &&
            archivedHere.has(record.existing.key))),
    )
    .map((record) => record.importName ?? record.name);
  const balances = results.map((result) => result.balances).find((each) => each !== null);
  const drift = mergedDrift(results);
  const dropped = sum((result) => result.plan.move?.templateDropped ?? 0);
  const skippedParts = done.passed.map((part) => formatCount(part.index));
  return (
    <div className="ledger-import-result">
      <Alert kind="success" takeFocus>
        {`Moved "${name}" into this ledger. `}
        {written || deleted
          ? `${counted(written, "transaction")} went straight into the books${deleted ? `, and ${counted(deleted, "deleted transaction")} came in deleted, as ${deleted === 1 ? "it was" : "they were"} where the file came from` : ""}.`
          : "No transaction was new here."}
      </Alert>
      <ul className="ledger-import-notes">
        {balances ? (
          <li>
            {`Every balance came out as the file says: ${counted(balances.checked, "account")} checked.${balances.notCompared ? ` ${counted(balances.notCompared, "account")} ${balances.notCompared === 1 ? "was" : "were"} not compared: an account archived where the file came from holds nothing there to compare with, and one opening after the day the balances are for has not yet taken in the money it carries.` : ""}`}
          </li>
        ) : (
          <li>This file carried no balances to check.</li>
        )}
        {skipped ? (
          <li>
            {`${counted(skipped, "transaction")} ${skipped === 1 ? "was" : "were"} already in this ledger, so ${skipped === 1 ? "it was" : "they were"} skipped.`}
          </li>
        ) : null}
        {skippedParts.length ? (
          <li>
            {`${skippedParts.length === 1 ? `Part ${skippedParts[0]}` : `Parts ${skippedParts.slice(0, -1).join(", ")} and ${skippedParts.at(-1)}`} of ${formatCount(parts)} ${skippedParts.length === 1 ? "was" : "were"} in already, so ${skippedParts.length === 1 ? "it was" : "they were"} not sent again.`}
          </li>
        ) : null}
        {kindSentences(records).map((sentence) => (
          <li key={sentence}>{sentence}</li>
        ))}
        {amounts.created || amounts.skipped ? (
          <li>
            {`Budget amounts: ${formatCount(amounts.created)} set, ${formatCount(amounts.skipped)} left out.`}
          </li>
        ) : null}
        {holding.length ? (
          <li>
            {`${counted(holding.length, "archived account")} ${holding.length === 1 ? "holds its" : "hold their"} transactions: ${quotedList(holding)}. Restoring ${holding.length === 1 ? "it" : "one"} posts its balance back.`}
          </li>
        ) : null}
        {staged ? (
          <li>
            {`${counted(staged, "staged row")} from the file went to Staged${needsReview ? `, and ${formatCount(needsReview)} of them need something from you before they can be committed` : ""}.`}
          </li>
        ) : null}
        {waitingAlready ? (
          <li>
            {`${counted(waitingAlready, "staged row")} ${waitingAlready === 1 ? "was" : "were"} already waiting in Staged.`}
          </li>
        ) : null}
        {drift.map((group) => (
          <li key={`${group.currency}-${group.type}-${group.from}-${group.to}`}>
            {driftSentence(group, true)}
          </li>
        ))}
        {dropped ? (
          <li>
            {`${counted(dropped, "transaction")} made from a template that did not come in arrived without saying which template ${dropped === 1 ? "it was" : "they were"} made from.`}
          </li>
        ) : null}
      </ul>
      <ResultLinks batches={batchesOf(results)} archived={holding.length > 0} />
    </div>
  );
}
