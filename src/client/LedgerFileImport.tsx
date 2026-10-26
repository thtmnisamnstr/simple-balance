import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, RotateCcw } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useMemo, useState } from "react";
import {
  budgetPeriodUnits,
  PROGRESS_STREAM_MIN_ROWS,
  type BudgetPeriodUnit,
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
  ledgerImportKinds,
  ledgerReferenceOpeningDate,
  mergeLedgerFileFacts,
  planLedgerFileAdd,
  suggestLedgerRename,
  type LedgerDecisionAction,
  type LedgerFileDecision,
  type LedgerFileFacts,
  type LedgerFilePlan,
  type LedgerFilePlannedRecord,
  type LedgerFilePlanProblem,
  type LedgerImportKind,
  type LedgerPreferencesChoice,
} from "../shared/ledger-file-import.js";
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
import { THEME_CHOICES } from "./pages/SettingsPage.js";
import { Link } from "./router.js";

/**
 * Adding a Simple Balance file to this ledger: the middle section of Import
 * and export.
 *
 * The page does three things the server does again, and that is the design
 * rather than a duplication. It reads the file with the shared reader, so a
 * file that is not one is refused in the format's own sentences before a byte
 * of it is sent. It cuts the file into parts with the shared splitter, because
 * one import is at most ten thousand rows and the person should not have to
 * know that. And it plans the whole file with `planLedgerFileAdd`, the function
 * the server runs over each part under its locks before it writes anything, so
 * what this page says a decision will do is what the add then does — and a
 * request the page would refuse is never sent.
 *
 * What the server alone can say is what is already here: its records in the
 * file's own shape, and which of the file's entries it holds by origin. That is
 * what the preview route answers with, part by part, and the one thing this
 * page asks for before anybody decides anything.
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
 * Where an add stopped. The part is what "Try again" resends, and the parts
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
type AddAnswers = {
  readonly decisions: LedgerFileDecision[];
  readonly arriveArchived: string[];
  readonly preferences: LedgerPreferencesChoice | undefined;
};

type AddRequest = AddAnswers & { readonly key: string; readonly start: number };

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
 * or is skipped because its origin is already here, and the table's columns
 * would say something false about it either way.
 */
function rowSentences(rows: LedgerFilePlan["rows"]): string[] {
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
 * Why adding a file would change nothing, or null when it would change
 * something.
 *
 * An add that writes nothing is not refused — the server takes it and says so
 * — but a button that does nothing is a question the page can answer before it
 * is pressed: a file added a second time, or one whose every record and entry
 * is here already, which is exactly what a finished import looks like when it
 * is checked again.
 */
function nothingToAdd(plan: LedgerFilePlan): string | null {
  const writes =
    plan.records.some((record) => record.action === "create") ||
    plan.rows.toStage > 0 ||
    plan.counts.budget_entry.create > 0 ||
    plan.preferences.action === "apply";
  if (writes) return null;
  return plan.records.length === 0 && plan.rows.entries === 0 && plan.rows.staged === 0
    ? "This file holds nothing to add."
    : "Everything in this file is already in this ledger.";
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
  const [showRecords, setShowRecords] = useState(false);
  const [attempt, setAttempt] = useState<(AddAnswers & { key: string }) | null>(null);
  const [done, setDone] = useState<LedgerFileAddResult[]>([]);
  const [running, setRunning] = useState<{ index: number; count: number } | null>(null);
  const [addProgress, setAddProgress] = useState<ProgressEvent | null>(null);

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
        // once. The part's own `plan` is dropped: it is that part planned with
        // nothing decided, and the page plans the whole file itself, from the
        // facts every part read, each time somebody decides something.
        const { plan: _plan, ...facts } = await api<LedgerFilePreview>(
          "/api/v1/ledger-file:preview",
          json({ ledgerFile: serializeLedgerFile(part) }),
        );
        read.push(facts);
      }
      return { name, identity, file, parts, facts: mergeLedgerFileFacts(read) };
    },
    onMutate: (source) => {
      // A new attempt, whatever the last one got to. A part already in is
      // recognized by the next preview — its entries are here by origin, and
      // its records are here, read as the same ones under the same decisions
      // — so starting again is how an add resumes.
      add.reset();
      setAttempt(null);
      setDone([]);
      if ("file" in source) {
        setChosenName(source.file.name);
        setChecked(null);
      }
    },
    onSuccess: (result) => {
      setChecked(result);
      // Choices belong to a file. The same file again — checked again, or
      // chosen again after a stop — keeps them, so a resumed add asks nothing
      // it was already told and a copy is not brought in under a second new
      // name; another file starts from nothing.
      if (result.identity === decidedFor) return;
      setDecidedFor(result.identity);
      setDrafts(new Map());
      setArchived(new Set());
      setPreferences(undefined);
      setShowRecords(false);
    },
    onSettled: () => setChecking(null),
  });

  const add = useMutation({
    mutationFn: async (asked: AddRequest) => {
      const parts = checked!.parts;
      for (let index = asked.start; index <= parts.length; index += 1) {
        setRunning({ index, count: parts.length });
        setAddProgress(null);
        let result: LedgerFileAddResult;
        try {
          // One key per part, built from one per attempt: a part retried is
          // the same request and replays if it had in fact finished, and the
          // next part is a different request.
          result = await apiStreamed<LedgerFileAddResult>(
            "/api/v1/ledger-file:add",
            json({
              ledgerFile: serializeLedgerFile(parts[index - 1]!),
              fileName: batchFileName(checked!.name),
              idempotencyKey: `${asked.key}-${index}`,
              part: { index, count: parts.length },
              decisions: asked.decisions,
              arriveArchived: asked.arriveArchived,
              preferences: asked.preferences,
            }),
            setAddProgress,
          );
        } catch (error) {
          throw new PartStopped(index, error);
        }
        setDone((earlier) => [...earlier, result]);
      }
    },
    onSettled: async () => {
      setAddProgress(null);
      setRunning(null);
      // Everything, because a file reaches every list there is: accounts,
      // categories, templates, recurring transactions, budgets, the queue and
      // its batches, and the settings in the session. A stop partway still
      // wrote every part before it.
      await queryClient.invalidateQueries();
    },
  });

  const accounts = useMemo(
    () => new Map((checked?.file.accounts ?? []).map((account) => [account.key, account])),
    [checked],
  );

  /**
   * The plan for the whole file as things stand, and exactly what the add
   * would send.
   *
   * Twice when it has to be. A draft can outlive the question it answered —
   * a category is the same as the one here once its group is used rather than
   * renamed — and a decision is never sent for a record that asks none. The
   * second pass plans with only the decisions the first pass asked for, which
   * changes nothing the person can see and is what the request will carry.
   */
  const planned = useMemo(() => {
    if (!checked) return null;
    const run = (decisions: LedgerFileDecision[], arriveArchived: string[]) =>
      planLedgerFileAdd({
        file: checked.file,
        facts: checked.facts,
        decisions,
        arriveArchived,
        preferences,
      }).plan;
    const all = [...drafts.values()].map(decisionOf).filter((one) => one !== null);
    const first = run(all, [...archived]);
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
    const plan =
      decisions.length === all.length && arriveArchived.length === archived.size
        ? first
        : run(decisions, arriveArchived);
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
    return { plan, answers: { decisions: sent, arriveArchived, preferences }, offered };
  }, [checked, drafts, archived, preferences, accounts]);

  const stopped = add.error instanceof PartStopped ? add.error : null;
  const finished = add.isSuccess;
  // Nothing about the file changes while it is being checked or added, or once
  // an attempt has stopped: what is on screen is what the stopped part was
  // sent with, and changing it before "Try again" would send a different
  // request under the same key.
  const locked = check.isPending || add.isPending || stopped !== null;

  const busy = check.isPending || add.isPending;
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

  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!planned || !checked || add.isPending) return;
    if (stopped && attempt) {
      add.mutate({ ...attempt, start: stopped.index });
      return;
    }
    if (!planned.plan.ok) return;
    const answers = { ...planned.answers, key: newIdempotencyKey() };
    setAttempt(answers);
    setDone([]);
    add.mutate({ ...answers, start: 1 });
  };

  return (
    <div className="panel ledger-import">
      <label className="file-drop">
        <FileUp size={26} />
        <strong>{checked?.name || chosenName || "Choose a Simple Balance file"}</strong>
        <span>A file exported from Simple Balance, on this copy or on another.</span>
        <span>Nothing is written until you add it.</span>
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

      {finished && checked ? (
        <AddResult name={checked.name} file={checked.file} results={done} />
      ) : checked && planned ? (
        <form className="ledger-import-preview" onSubmit={start}>
          <PreviewBody
            base={base}
            checked={checked}
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

          {add.isPending && running ? (
            <div className="ledger-import-progress">
              {running.count > 1 ? (
                <p role="status">{`Part ${formatCount(running.index)} of ${formatCount(running.count)}`}</p>
              ) : null}
              {/* Never before a count is real (web.md 12.6): a part does its
                  records and its lookups before the first row, and reports
                  nothing while it does. */}
              {addProgress && addProgress.total >= PROGRESS_STREAM_MIN_ROWS ? (
                <ProgressBar
                  label={progressLabel(addProgress)}
                  value={progressFraction(addProgress)}
                  max={1}
                />
              ) : null}
            </div>
          ) : null}

          {stopped ? (
            <StoppedNotice stopped={stopped} count={checked.parts.length} done={done.length} />
          ) : null}

          <AddActions
            plan={planned.plan}
            checked={checked}
            stopped={stopped}
            pending={add.isPending}
            checking={check.isPending}
            onCheckAgain={() => check.mutate({ again: checked })}
          />
        </form>
      ) : null}
    </div>
  );
}

/**
 * The buttons under the preview: check the file again, and add it.
 *
 * One add button whatever the state, in one place, so the element a keyboard
 * pressed is the element that is there when the answer comes. "Add to this
 * ledger" becomes "Try part 2 of 3 again" where a part stopped, rather than a
 * second button replacing the first: a replaced button takes focus to `<body>`
 * with it (web.md 13.3).
 */
function AddActions({
  plan,
  checked,
  stopped,
  pending,
  checking,
  onCheckAgain,
}: {
  plan: LedgerFilePlan;
  checked: CheckedFile;
  stopped: PartStopped | null;
  pending: boolean;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const count = checked.parts.length;
  const idle = nothingToAdd(plan);
  const open = plan.problems.length;
  // Why the button cannot be pressed, said beside it (web.md 12.3). A stopped
  // attempt is always retryable, because it resends what was already decided.
  // A check in flight disables it too and says nothing, because the check
  // button beside it is spinning and that is the answer.
  const blocked = stopped
    ? null
    : open > 0
      ? `${counted(open, "question is", "questions are")} still open above.`
      : idle;
  const label = stopped
    ? count > 1
      ? `Try part ${formatCount(stopped.index)} of ${formatCount(count)} again`
      : "Try again"
    : "Add to this ledger";
  return (
    <div className="form-actions">
      {/* Gone while a part is being added rather than disabled beside it:
          checking again then would read a ledger halfway through changing,
          and the add button's own busy state already says why. */}
      {pending ? null : (
        <Button type="button" variant="secondary" loading={checking} onClick={onCheckAgain}>
          <RotateCcw size={16} /> Check the file again
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
 * Where an add stopped, what is in, and what pressing the button will do.
 *
 * "Nothing was written" only where the server answered: a part is one
 * transaction, so a refusal wrote none of it, but a connection that went away
 * says nothing about whether the part finished (web.md 12.6), and the notice
 * says that in its own words, since retrying with the part's key is how to
 * find out.
 */
function StoppedNotice({
  stopped,
  count,
  done,
}: {
  stopped: PartStopped;
  count: number;
  done: number;
}) {
  const refused = writeDidNotHappen(stopped.failure);
  const before =
    done === 0
      ? null
      : done === 1
        ? `Part 1 of ${formatCount(count)} is in.`
        : `Parts 1 to ${formatCount(done)} of ${formatCount(count)} are in.`;
  const which =
    count > 1 ? `part ${formatCount(stopped.index)} of ${formatCount(count)}` : "the file";
  // A connection that went away is not a refusal (web.md 12.6): the part is
  // one transaction the server finishes whether or not anybody is still
  // listening, so its outcome is unknown, and the browser's own "Failed to
  // fetch" says none of that. Trying again finds out, because the part's key
  // replays one that finished.
  const lead = refused
    ? `${stopped.message} ${count > 1 ? `Nothing from part ${formatCount(stopped.index)} was written.` : "Nothing was written."}`
    : `The connection was lost before ${which} answered, so whether it was added is not known.`;
  return (
    <>
      <Alert>
        {lead}
        {before ? ` ${before}` : null}
      </Alert>
      <Note>
        Trying again sends exactly what was sent before, and a part that did finish is not added
        twice. Checking the file again, or choosing it again, reads this ledger afresh and keeps
        what you decided: whatever an earlier part brought in is recognized and skipped under the
        same decisions, and a new name for a renamed record would bring in a second copy.
      </Note>
    </>
  );
}

/** Everything between the file and the buttons. */
function PreviewBody({
  base,
  checked,
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
  const rows = rowSentences(plan.rows);
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
  const created = plan.records.filter((record) => record.action === "create").length;
  const summary = !plan.ok
    ? `${counted(plan.problems.length, "question")} to answer before this file can be added.`
    : (nothingToAdd(plan) ??
      `Ready to add: ${counted(created, "new record")} and ${counted(plan.rows.toStage, "row")} for Staged.`);

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
              ? "Hide the records"
              : `Show ${plan.records.length === 1 ? "the record" : `all ${formatCount(plan.records.length)} records`}`}
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
            <table className="data-table">
              <caption className="sr-only">
                Every record in the file, and what happens to it
              </caption>
              <thead>
                <tr>
                  {/* What happens second: a table scrolls rather than
                      reflows, and on a phone the first two columns are the
                      ones on screen. */}
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
                      <td>{record.message ?? ""}</td>
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
            {asking.some((record) => record.choices.includes("leave_staged"))
              ? "Each is already here under the same name, or is named by the file and not here. Nothing here is changed whatever you choose, and one left for review keeps the transactions that name it waiting in Staged, to be settled there."
              : "Each is already here under the same name, or is named by the file and not here. Nothing here is changed whatever you choose."}
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
              aria-describedby={record.message ? `${group}-why` : undefined}
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
          aria-describedby={record.message ? `${group}-why` : undefined}
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
        <p className="ledger-import-problem" key={`${index}-${problem.field}`}>
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
 * coming, the numbers are said here and the add waits until enough are
 * chosen.
 */
function ArriveArchived({
  id,
  offered,
  plan,
  accounts,
  archived,
  locked,
  onChange,
}: {
  id: string;
  offered: readonly LedgerFilePlannedRecord[];
  plan: LedgerFilePlan;
  accounts: ReadonlyMap<string, LedgerFileAccount>;
  archived: ReadonlySet<string>;
  locked: boolean;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  const { limit, inUse, arriving, needed, chosen } = plan.places;
  return (
    <div id={id}>
      <Field
        as="group"
        label="Accounts to arrive archived"
        // Places only where a plan keeps a number of them: a copy that sells
        // nothing, and the paid plan, have none (common.md's glossary), and the
        // choice is offered there anyway because an agent can make it.
        hint={
          limit !== null
            ? "An account that arrives archived uses no place. Its transactions still go to Staged, and wait there until you restore it."
            : "An account that arrives archived is put away as it arrives. Its transactions still go to Staged, and wait there until you restore it."
        }
      >
        {limit !== null && needed > 0 ? (
          <Note>
            {`Your plan keeps ${formatCount(limit)} accounts in use, and ${formatCount(inUse)} are in use here. This file brings ${formatCount(arriving)} more, so choose at least ${formatCount(needed)} to arrive archived, or upgrade under Settings. ${formatCount(chosen)} chosen so far.`}
          </Note>
        ) : null}
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
 * What an add did, summed over its parts.
 *
 * Records are read off the first part's plan with the ids it filled in:
 * every part carries every record, so the first part creates them and every
 * later one finds them here. Rows and budget amounts are each part's own and
 * are added up.
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
  // Per record, the furthest any part got: created in one, it is created.
  const outcome = new Map<string, LedgerFilePlannedRecord>();
  for (const result of results) {
    for (const record of result.plan.records) {
      const id = recordId(record.kind, record.key);
      const seen = outcome.get(id);
      if (!seen || (seen.action !== "create" && record.action === "create")) {
        outcome.set(id, record);
      }
    }
  }
  const records = [...outcome.values()];
  const perKind = ledgerImportKinds
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
  const batches = results.flatMap((result) =>
    result.importBatchId === null
      ? []
      : [{ id: result.importBatchId, part: result.part, staged: result.staged }],
  );
  const review = (batch: (typeof batches)[number]) => ({
    pathname: "/staged",
    // The batch, so the queue opens on these rows rather than on everything
    // ever staged, and all-time, because the queue's this-month default hid
    // every imported row dated outside the month (the CSV import's precedent).
    search: queryString({ importBatchId: batch.id, preset: "all-time" }),
  });
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
      <div className="ledger-import-links">
        {batches.map((batch) => (
          <Link className="button button-primary" key={batch.id} to={review(batch)}>
            {batches.length > 1
              ? `Review part ${formatCount(batch.part.index)}'s ${counted(batch.staged, "staged row")}`
              : `Review ${counted(batch.staged, "staged row")}`}
          </Link>
        ))}
        <Link className="button button-secondary" to="/accounts">
          Open Accounts
        </Link>
      </div>
    </div>
  );
}
