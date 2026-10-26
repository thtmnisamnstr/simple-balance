/**
 * The Simple Balance file on the server: the export, one read of somebody's
 * ledger written as the format `src/shared/ledger-file.ts` defines, and the
 * add at the end of the file, which reads a file back into a ledger that may
 * already hold one through the services a person's own writes use.
 *
 * The export:
 *
 * Every read happens in one `REPEATABLE READ, READ ONLY` transaction, so the
 * accounts, categories and entries in a file agree with each other. A file built
 * from several reads at the default isolation could name an account created
 * between two of them, and a reader would be right to call that file broken.
 *
 * The figures in it are not worked out here. `balance` and `carriedForward` are
 * what `listAccounts` sums from the postings, and `postedAs` is which
 * counter-account those postings landed on; this module only compares the
 * second to zero and the first to `resolveEntrySide`. A file whose checks came
 * from arithmetic of its own would be checking an import against a second
 * implementation of the ledger.
 *
 * Built in two steps, and only the first touches the database. The read returns
 * rows and closes its transaction before anything is assembled, so the
 * connection goes back to the pool while the file is put together, validated and
 * serialized — on a one-connection pool that is the difference between an
 * export and an outage for as long as the file takes to build.
 */
import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Actor, CategoryKind, CounterKind, EntryType, Theme } from "../../shared/domain.js";
import { counterKinds, MAX_BULK_SELECTION_ENTRIES, resolveEntrySide } from "../../shared/domain.js";
import {
  assignLedgerKeys,
  LEDGER_FILE_FORMAT,
  ledgerFileKinds,
  ledgerFileName,
  ledgerFileRecordCount,
  ledgerFileRowCount,
  ledgerFileSelectionSchema,
  parseLedgerFile,
  parseLedgerFileText,
  serializeLedgerFile,
  type LedgerFile,
  type LedgerFileKind,
  type LedgerFileSelection,
} from "../../shared/ledger-file.js";
import {
  ledgerAccountInput,
  ledgerBudgetEntryInput,
  ledgerBudgetPlanInput,
  ledgerBudgetPlanKey,
  ledgerCategoryInput,
  ledgerCreatedKey,
  ledgerEntryDraft,
  ledgerFileAddInputSchema,
  ledgerFilePreviewInputSchema,
  ledgerGroupInput,
  ledgerRecurrenceInput,
  ledgerStagedDraft,
  ledgerTemplateInput,
  planLedgerFileAdd,
  type LedgerFileAddResult,
  type LedgerFileDecision,
  type LedgerFileFacts,
  type LedgerFilePlan,
  type LedgerFilePreview,
  type LedgerImportKind,
  type LedgerRefResolver,
} from "../../shared/ledger-file-import.js";
import { normalizeHumanName } from "../../shared/names.js";
import type { ProgressEvent } from "../../shared/progress.js";
import { addDays, startOfDayIn, todayIn } from "../../shared/recurrence-dates.js";
import { APP_VERSION } from "../../shared/version.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import {
  auditEvents,
  budgetEntries,
  budgetPlans,
  categories,
  categoryGroups,
  importBatches,
  ledgerAccounts,
  postings,
  recurrences,
  stagedTransactions,
  templateNotifications,
  transactionLegs,
  transactionTemplates,
  transactions,
  type BudgetEntryRow,
  type BudgetPlanRow,
  type CategoryGroupRow,
  type CategoryRow,
  type RecurrenceRow,
  type StagedTransactionRow,
  type TransactionLegRow,
  type TransactionRow,
} from "../db/schema.js";
import { ledgerFileRowsStaged } from "../metrics.js";
import { createAccount, listAccounts } from "./accounts.js";
import { getEntitlement } from "./billing.js";
import { createBudgetPlan, planView, setBudgetEntry } from "./budgets.js";
import { createCategory } from "./categories.js";
import { createCategoryGroup } from "./category-groups.js";
import { conflict, notFound, validationError } from "./errors.js";
import {
  canonicalDecimal,
  countAfterCommit,
  getIdempotent,
  isUniqueViolation,
  lockAccountNamespace,
  lockAccountReferences,
  lockCategoryNamespace,
  lockIdempotencyKey,
  lockPayeeNamespace,
  lockRecurrenceNamespace,
  lockTransactionTemplateNamespace,
  serializeRow,
  setIdempotent,
  withoutUserId,
  writeAudit,
} from "./helpers.js";
import { getPreferences, setPreferences } from "./preferences.js";
import { createRecurrence, ruleOf } from "./recurrences.js";
import { insertImportedStages } from "./staging.js";
import { createTransactionTemplate } from "./transaction-templates.js";
import { transactionToDraft } from "./transactions.js";

type AccountRow = typeof ledgerAccounts.$inferSelect;
type TemplateRow = typeof transactionTemplates.$inferSelect;
type NotificationRow = typeof templateNotifications.$inferSelect;
type AuditRow = typeof auditEvents.$inferSelect;
type JsonRecord = Record<string, unknown>;

/**
 * Everything one export reads, as rows, taken in one snapshot.
 *
 * Plain data and nothing that can reach the database, so assembling a file from
 * it is a pure function a test can drive without one. Each list of records is
 * in the order its rows were created, `(created_at, id)`, which is what makes
 * the keys `assignLedgerKeys` hands out the same on every export of an
 * unchanged ledger; the entries are by date, the order the file writes them in.
 */
export type LedgerSnapshot = {
  /** Today where the person lives, which dates the file's name. */
  readonly today: string;
  /** The day the balance checks describe: today, or the range's end when that is earlier. */
  readonly throughDate: string;
  /** The person's settings, or null when they were left out or never chosen. */
  readonly preferences: { timezone: string; defaultCurrency: string; theme: string } | null;
  readonly accounts: readonly AccountRow[];
  /**
   * Each account's signed posting sum as of `throughDate`, or null when the
   * file carries no entries for it to describe, or a range that starts after it.
   */
  readonly balances: ReadonlyMap<string, string> | null;
  /**
   * Each account's signed posting sum as of the day before the range's first
   * day, when the file's entries start partway through.
   */
  readonly carried: ReadonlyMap<string, string> | null;
  /** Which accounts a limited plan has frozen right now. */
  readonly frozen: ReadonlySet<string>;
  readonly groups: readonly CategoryGroupRow[];
  readonly categories: readonly CategoryRow[];
  readonly templates: readonly TemplateRow[];
  readonly notifications: ReadonlyMap<string, NotificationRow>;
  readonly recurrences: readonly RecurrenceRow[];
  readonly plans: readonly BudgetPlanRow[];
  readonly budgetEntries: readonly BudgetEntryRow[];
  readonly entries: readonly TransactionRow[];
  /**
   * For each entry with no origin of its own that was committed from a staged
   * row with none either, that row's id: the origin the row was exported
   * under while it waited, which the entry keeps.
   */
  readonly committedFrom: ReadonlyMap<string, string>;
  /** Each split entry's legs, in `ordinal` order, zeroed ones included. */
  readonly legs: ReadonlyMap<string, readonly TransactionLegRow[]>;
  /** For each live deposit and withdrawal, the counter-account kinds its postings net to non-zero on. */
  readonly postedSides: ReadonlyMap<string, readonly CounterKind[]>;
  readonly staged: readonly StagedTransactionRow[];
  readonly history: readonly AuditRow[];
};

/**
 * How much one export may hold, which each transport chooses for itself.
 *
 * `maxRows` counts entries, staged rows, budget amounts and activity events.
 * `maxHistoryBytes` counts the text of the activity history's before and after
 * snapshots, because rows do not bound the history the way they bound
 * everything else: an entry is a couple of hundred bytes on its line, and one
 * event about an edited split is ten times that, so a history inside the row
 * cap could still be a download large enough to take the server's heap with it.
 */
export type LedgerFileExportLimits = { maxRows: number; maxHistoryBytes: number };

/**
 * Export somebody's ledger, or some of its accounts, as a Simple Balance file.
 *
 * The limits are the transport's to choose, and the two choose differently on
 * purpose: the route allows `CSV_EXPORT_MAX_ROWS`, because the way out of this
 * product should never be narrower than the way in, and the MCP tool allows one
 * import part's worth, because its reply is serialized twice with no streaming.
 *
 * Takes no caller's transaction, unlike the writes beside it. Joining one would
 * give up the snapshot — a caller's transaction runs at its own isolation level
 * and has usually written something already — and the one thing this function
 * promises is that every section of the file was read at the same moment.
 */
export async function exportLedgerFile(
  actor: Actor,
  input: unknown,
  options: LedgerFileExportLimits,
): Promise<{ ledgerFile: string; rowCount: number; fileName: string }> {
  const selection = ledgerFileSelectionSchema.parse(input);
  const snapshot = await getDb().transaction(
    (tx) => readLedgerSnapshot(tx, actor, selection, options),
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const parsed = parseLedgerFile(assembleLedgerFile(selection, snapshot, new Date()));
  if (!parsed.ok) {
    // The exporter's own defect, or a stored row nobody foresaw, and either way
    // a 500 rather than a refusal: nothing the caller sent can fix it. The paths
    // and nothing else go into the message, because both transports log it
    // through `log.failure` and an issue's sentence quotes keys, which are
    // people's account and category names.
    const fields = parsed.issues.map((issue) => issue.field || "(file)").join(", ");
    throw new Error(`A Simple Balance file failed its own reader at ${fields}`);
  }
  return {
    ledgerFile: serializeLedgerFile(parsed.file),
    rowCount: ledgerFileRowCount(parsed.file),
    fileName: ledgerFileName(snapshot.today, parsed.file.scope.accounts),
  };
}

/**
 * Every read one export makes, on the snapshot transaction it was handed.
 *
 * Counted before anything large is read, so a ledger over the cap is refused
 * after a handful of counts rather than after a hundred thousand rows have been
 * pulled into memory only to be thrown away.
 */
async function readLedgerSnapshot(
  tx: DbTransaction,
  actor: Actor,
  selection: LedgerFileSelection,
  { maxRows, maxHistoryBytes }: LedgerFileExportLimits,
): Promise<LedgerSnapshot> {
  const kinds = new Set(selection.kinds);
  const stored = await getPreferences(actor, tx);
  const today = todayIn(stored.timezone);
  const throughDate = selection.end !== undefined && selection.end < today ? selection.end : today;

  const accounts = await tx
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.systemKind)))
    .orderBy(asc(ledgerAccounts.createdAt), asc(ledgerAccounts.id));
  // Read off this person's own accounts, which never include a counter-account,
  // so an id naming one is not found in exactly the way a stranger's id is.
  const owned = new Set(accounts.map((account) => account.id));
  for (const accountId of selection.accountIds ?? []) {
    if (!owned.has(accountId)) throw notFound("Account not found", { accountId });
  }

  const entryScope = entryConditions(actor, selection);
  const historyScope = historyConditions(actor, selection, stored.timezone);
  const counted = await countRows(tx, actor, kinds, entryScope, historyScope);
  if (counted.rows > maxRows) {
    throw validationError(
      `This file would hold ${counted.rows.toLocaleString("en-US")} ${capNouns(kinds)}, and one export holds at most ${maxRows.toLocaleString("en-US")}. ${capWayOut(kinds)}`,
      { limit: maxRows, count: counted.rows },
    );
  }
  if (counted.historyBytes > maxHistoryBytes) {
    throw validationError(
      `The activity history in this file would come to ${counted.historyBytes.toLocaleString("en-US")} bytes, and one export carries at most ${maxHistoryBytes.toLocaleString("en-US")}. Narrow the activity history with a start and end date, and export one range at a time.`,
      { limit: maxHistoryBytes, bytes: counted.historyBytes },
    );
  }

  // One read gives both what each account holds and which ones a plan has
  // frozen, from the same rows the page shows; a second implementation of
  // either would be the thing an import's balance check ends up disagreeing
  // with. Only needed where an account travels whole.
  const asOfThrough = kinds.has("accounts") ? await listAccounts(actor, throughDate, true, tx) : [];
  const start = selection.start;
  // Every account, whatever its opening date, because an entry can be dated
  // before the account it is on opened and money dated before the range is in
  // no entry. Not capped at today: entries dated between today and the first
  // day are not in the file either, so the carry is the only place they are.
  const carriedFrom =
    start !== undefined && kinds.has("accounts") && kinds.has("entries")
      ? await listAccounts(actor, addDays(start, -1), true, tx)
      : null;

  const groups = await tx
    .select()
    .from(categoryGroups)
    .where(eq(categoryGroups.userId, actor.userId))
    .orderBy(asc(categoryGroups.createdAt), asc(categoryGroups.id));
  const categoryRows = await tx
    .select()
    .from(categories)
    .where(eq(categories.userId, actor.userId))
    .orderBy(asc(categories.createdAt), asc(categories.id));
  // Every template, even with templates left out, because an entry made from
  // one still names it and the file carries that name as a reference.
  const templates = await tx
    .select()
    .from(transactionTemplates)
    .where(eq(transactionTemplates.userId, actor.userId))
    .orderBy(asc(transactionTemplates.createdAt), asc(transactionTemplates.id));
  const notifications = kinds.has("templates")
    ? await tx
        .select()
        .from(templateNotifications)
        .where(eq(templateNotifications.userId, actor.userId))
    : [];
  const recurrenceRows = kinds.has("recurrences")
    ? await tx
        .select()
        .from(recurrences)
        .where(eq(recurrences.userId, actor.userId))
        .orderBy(asc(recurrences.createdAt), asc(recurrences.id))
    : [];
  const plans = kinds.has("budgets")
    ? await tx
        .select()
        .from(budgetPlans)
        .where(eq(budgetPlans.userId, actor.userId))
        .orderBy(asc(budgetPlans.createdAt), asc(budgetPlans.id))
    : [];
  const budgetEntryRows = kinds.has("budgets")
    ? await tx
        .select()
        .from(budgetEntries)
        .where(eq(budgetEntries.userId, actor.userId))
        .orderBy(asc(budgetEntries.createdAt), asc(budgetEntries.id))
    : [];

  const entries = kinds.has("entries")
    ? await tx
        .select()
        .from(transactions)
        .where(and(...entryScope))
        .orderBy(asc(transactions.date), asc(transactions.id))
    : [];
  const legs = kinds.has("entries")
    ? await readLegs(tx, actor, entryScope)
    : new Map<string, TransactionLegRow[]>();
  const committedFrom = kinds.has("entries")
    ? await readCommittedFrom(tx, actor, entryScope)
    : new Map<string, string>();
  const postedSides = kinds.has("entries")
    ? await readPostedSides(tx, actor, entryScope)
    : new Map<string, CounterKind[]>();

  const staged = kinds.has("staged")
    ? await tx
        .select()
        .from(stagedTransactions)
        .where(
          and(eq(stagedTransactions.userId, actor.userId), eq(stagedTransactions.status, "staged")),
        )
        .orderBy(asc(stagedTransactions.createdAt), asc(stagedTransactions.id))
    : [];
  const history = kinds.has("history")
    ? await tx
        .select()
        .from(auditEvents)
        .where(and(...historyScope))
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
    : [];

  return {
    today,
    throughDate,
    // A default nobody picked is not a decision another copy should take on as
    // one: the copy it lands in has defaults of its own, and its own browser
    // will offer what it detects there.
    preferences:
      kinds.has("preferences") && stored.chosen
        ? {
            timezone: stored.timezone,
            defaultCurrency: stored.defaultCurrency,
            theme: stored.theme,
          }
        : null,
    accounts,
    // Only with the entries in, and only once the range has started. A balance
    // check describes what the entries add up to, so a file without them would
    // carry a figure no import of it could ever reach — and so would a range
    // starting after today, whose checks describe today: an account rebuilt
    // from it opens on the first day and holds nothing yet on this one. The
    // check is left out rather than moved past today, because a balance that
    // counted future-dated money would describe money that has not moved.
    balances:
      kinds.has("accounts") && kinds.has("entries") && (start === undefined || throughDate >= start)
        ? new Map(asOfThrough.map((account) => [String(account.id), account.balance]))
        : null,
    carried: carriedFrom
      ? new Map(carriedFrom.map((account) => [String(account.id), account.balance]))
      : null,
    frozen: new Set(
      asOfThrough.filter((account) => account.frozen).map((account) => String(account.id)),
    ),
    groups,
    categories: categoryRows,
    templates,
    notifications: new Map(notifications.map((row) => [row.templateId, row])),
    recurrences: recurrenceRows,
    plans,
    budgetEntries: budgetEntryRows,
    entries,
    committedFrom,
    legs,
    postedSides,
    staged,
    history,
  };
}

/**
 * Which entries the file carries: this person's, live unless deleted entries
 * were asked for, inside the range, and — for chosen accounts — every entry
 * either of whose sides is one of them, so a transfer between two chosen
 * accounts is one entry rather than one per account.
 */
function entryConditions(actor: Actor, selection: LedgerFileSelection): SQL[] {
  const conditions: SQL[] = [eq(transactions.userId, actor.userId)];
  if (!selection.kinds.includes("deletedEntries")) conditions.push(isNull(transactions.deletedAt));
  if (selection.start !== undefined) conditions.push(gte(transactions.date, selection.start));
  if (selection.end !== undefined) conditions.push(lte(transactions.date, selection.end));
  if (selection.accountIds !== undefined) {
    conditions.push(
      or(
        inArray(transactions.sourceAccountId, selection.accountIds),
        inArray(transactions.destinationAccountId, selection.accountIds),
      )!,
    );
  }
  return conditions;
}

/**
 * Which activity events the file carries: this person's, on the days of the
 * range where they live.
 *
 * The range narrows the history because nothing else can. The history counts
 * toward the cap, and a CSV import alone logs three events for every entry it
 * brings in, so without this a person a few thousand imports in could never
 * export their history at all, and the history is the one thing in the file no
 * service can write back. The days are turned into instants by
 * `startOfDayIn` and compared as instants, rather than asking the database
 * what day an event fell on, which `calendarDayIn` answers and PostgreSQL
 * answers differently for a bare offset.
 */
function historyConditions(actor: Actor, selection: LedgerFileSelection, timezone: string): SQL[] {
  const conditions: SQL[] = [eq(auditEvents.userId, actor.userId)];
  if (selection.start !== undefined) {
    conditions.push(gte(auditEvents.createdAt, startOfDayIn(selection.start, timezone)));
  }
  if (selection.end !== undefined) {
    conditions.push(lt(auditEvents.createdAt, startOfDayIn(addDays(selection.end, 1), timezone)));
  }
  return conditions;
}

/** What the cap is counting, in the words the refusal uses for it. */
function capNouns(kinds: ReadonlySet<LedgerFileKind>): string {
  return listed(
    [
      kinds.has("entries") ? "entries" : null,
      kinds.has("staged") ? "staged rows" : null,
      kinds.has("budgets") ? "budget amounts" : null,
      kinds.has("history") ? "activity events" : null,
    ].filter((noun) => noun !== null),
  );
}

/**
 * The way out of the cap, built from what was asked for, so it names only the
 * moves that would work there. A range narrows the entries and the history and
 * nothing else. Exporting staged rows, budgets or the history separately helps
 * only beside something else that was asked for, since alone they already are.
 * With nothing that narrows and nothing to set apart, the one move left for
 * staged rows is to clear some, and budget amounts have none.
 */
function capWayOut(kinds: ReadonlySet<LedgerFileKind>): string {
  const ranged = [
    kinds.has("entries") ? "the entries" : null,
    kinds.has("history") ? "the activity history" : null,
  ].filter((noun) => noun !== null);
  const counted = (["entries", "staged", "budgets", "history"] as const).filter((kind) =>
    kinds.has(kind),
  ).length;
  const apart =
    counted > 1
      ? [
          kinds.has("staged") ? "staged rows" : null,
          kinds.has("budgets") ? "budgets" : null,
          kinds.has("history") ? "the activity history" : null,
        ].filter((noun) => noun !== null)
      : [];
  const moves: string[] = [];
  if (ranged.length) {
    moves.push(
      `narrow ${listed(ranged)} with a start and end date, and export one range at a time`,
    );
  }
  if (apart.length) moves.push(`export ${listed(apart)} separately`);
  if (moves.length) {
    const sentence = moves.join(", or ");
    return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
  }
  return kinds.has("staged")
    ? "Commit or discard some of the staged rows, then export again."
    : "Budget amounts have no date to narrow them by, so no one export can carry this many.";
}

/** "a", "a and b", "a, b and c": the house's list, with no serial comma. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The rows the cap counts — entries, staged rows, budget amounts, and the
 * activity events when the history was asked for — and the bytes of the
 * history's snapshots, which the history's own limit counts.
 *
 * The history counts here although no import part carries it, because it is
 * what makes a file large: a ledger edited for years can log ten events for
 * every entry it holds, and each event carries a whole record twice. Its bytes
 * are read off the stored JSON in the same statement as its count, so a
 * history over its limit is refused before any of it is pulled into memory,
 * which is the whole point of counting first.
 */
async function countRows(
  tx: DbTransaction,
  actor: Actor,
  kinds: ReadonlySet<string>,
  entryScope: readonly SQL[],
  historyScope: readonly SQL[],
): Promise<{ rows: number; historyBytes: number }> {
  let total = 0;
  let historyBytes = 0;
  if (kinds.has("entries")) {
    const [row] = await tx
      .select({ total: count() })
      .from(transactions)
      .where(and(...entryScope));
    total += row?.total ?? 0;
  }
  if (kinds.has("staged")) {
    const [row] = await tx
      .select({ total: count() })
      .from(stagedTransactions)
      .where(
        and(eq(stagedTransactions.userId, actor.userId), eq(stagedTransactions.status, "staged")),
      );
    total += row?.total ?? 0;
  }
  if (kinds.has("budgets")) {
    const [row] = await tx
      .select({ total: count() })
      .from(budgetEntries)
      .where(eq(budgetEntries.userId, actor.userId));
    total += row?.total ?? 0;
  }
  if (kinds.has("history")) {
    const [row] = await tx
      .select({
        total: count(),
        bytes: sql<string>`coalesce(sum(coalesce(octet_length(${auditEvents.before}::text), 0) + coalesce(octet_length(${auditEvents.after}::text), 0)), 0)::text`,
      })
      .from(auditEvents)
      .where(and(...historyScope));
    total += row?.total ?? 0;
    historyBytes = Number(row?.bytes ?? 0);
  }
  return { rows: total, historyBytes };
}

/**
 * The legs of every split entry the file carries, by entry, in `ordinal` order.
 *
 * Selected through the entries' own conditions rather than a list of their
 * ids. A hundred thousand ids is past the sixty-five thousand parameters one
 * PostgreSQL statement may bind, and the subquery is the same filter the
 * entries were read with, so the two cannot disagree about which entries those
 * are. A `leg_count` of zero is an entry that is not split now, whatever legs it
 * once had: those are zeroed, and the list a reader sees for it is empty.
 */
async function readLegs(
  tx: DbTransaction,
  actor: Actor,
  entryScope: readonly SQL[],
): Promise<Map<string, TransactionLegRow[]>> {
  const rows = await tx
    .select()
    .from(transactionLegs)
    .where(
      and(
        eq(transactionLegs.userId, actor.userId),
        inArray(
          transactionLegs.transactionId,
          tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(...entryScope, gt(transactions.legCount, 0))),
        ),
      ),
    )
    .orderBy(
      asc(transactionLegs.transactionId),
      asc(transactionLegs.ordinal),
      asc(transactionLegs.id),
    );
  const byEntry = new Map<string, TransactionLegRow[]>();
  for (const row of rows) {
    const list = byEntry.get(row.transactionId);
    if (list) list.push(row);
    else byEntry.set(row.transactionId, [row]);
  }
  return byEntry;
}

/**
 * The staged row each of the file's origin-less entries was committed from,
 * when that row had no origin either: by entry, the row's id.
 *
 * A row waiting in Staged is exported under its own id, and a commit gives the
 * entry it becomes no origin when the row had none — a CSV's row, one typed
 * into the queue, a recurrence's proposal. Without this the same entry would
 * be written under the row's id in one file and its own in the next, and a
 * ledger the first file was added to would take the second for a different
 * entry and stage it again, with the duplicate check standing aside because
 * the two origins differ. Kept on the export side rather than stored on the
 * entry, because an entry with an origin reads as having come from a file —
 * to the duplicate check, and to whether a ledger may be moved whole.
 *
 * Selected through the entries' own conditions, as `readLegs` is, and served
 * by `staged_committed_reference_idx`.
 */
async function readCommittedFrom(
  tx: DbTransaction,
  actor: Actor,
  entryScope: readonly SQL[],
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ entryId: stagedTransactions.committedTransactionId, rowId: stagedTransactions.id })
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "committed"),
        isNull(stagedTransactions.importOrigin),
        inArray(
          stagedTransactions.committedTransactionId,
          tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(...entryScope, isNull(transactions.importOrigin))),
        ),
      ),
    );
  return new Map(rows.flatMap((row) => (row.entryId === null ? [] : [[row.entryId, row.rowId]])));
}

/**
 * Which counter-account each live deposit and withdrawal actually posted to.
 *
 * Summed per entry and per kind from the postings, and kept only where the sum
 * is not zero. That is the one honest answer after a correction, because a
 * recategorized refund appended a delta to one counter-account and its reverse
 * to the other: the side it first landed on nets to zero and the side it is on
 * now does not. Read off the postings rather than off the category, which is
 * the whole point — the category says what a fresh entry would do, and this is
 * what the old one did.
 */
async function readPostedSides(
  tx: DbTransaction,
  actor: Actor,
  entryScope: readonly SQL[],
): Promise<Map<string, CounterKind[]>> {
  const rows = await tx
    .select({
      transactionId: postings.transactionId,
      kind: ledgerAccounts.systemKind,
    })
    .from(postings)
    .innerJoin(
      ledgerAccounts,
      and(eq(ledgerAccounts.userId, postings.userId), eq(ledgerAccounts.id, postings.accountId)),
    )
    .where(
      and(
        eq(postings.userId, actor.userId),
        inArray(ledgerAccounts.systemKind, [...counterKinds]),
        inArray(
          postings.transactionId,
          tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(...entryScope, isNull(transactions.deletedAt), ne(transactions.type, "transfer")),
            ),
        ),
      ),
    )
    .groupBy(postings.transactionId, ledgerAccounts.systemKind)
    .having(sql`sum(${postings.amount}) <> 0`);
  const byEntry = new Map<string, CounterKind[]>();
  for (const row of rows) {
    if (row.transactionId === null || row.kind === null) continue;
    const kind = row.kind as CounterKind;
    const list = byEntry.get(row.transactionId);
    if (list) list.push(kind);
    else byEntry.set(row.transactionId, [kind]);
  }
  return byEntry;
}

/**
 * Each record's key by its id, as `assignLedgerKeys` hands them out over rows
 * in the order they were created.
 *
 * One function for the export and for the import's reading of the ledger it
 * lands in, because the import compares a file's records with the ones here
 * by key and resolves a key to the id it stands for: two spellings of the rule
 * would be a key that names one account in the file and another here.
 */
function ledgerKeysById(rows: readonly { id: string; name: string }[]): Map<string, string> {
  const keys = assignLedgerKeys(rows.map((row) => row.name));
  return new Map(rows.map((row, at) => [row.id, keys[at]!]));
}

/** A key carrying a value only when there is one, so blank and absent read alike. */
const present = (key: string, value: unknown): JsonRecord =>
  value === null || value === undefined || value === "" ? {} : { [key]: value };

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A stored amount a file can carry. A staged row may hold anything at all, and
 * a JSON number is the one thing the file refuses, so a number is written as
 * the text JSON would have spelled it: what the row said, minus the claim that
 * it was ever exact.
 */
const stagedAmount = (value: unknown) =>
  typeof value === "number" ? JSON.stringify(value) : value;

/** The staged draft's own fields, passed through as they are. */
const STAGED_PASSTHROUGH = [
  "type",
  "date",
  "payee",
  "description",
  "categoryName",
  "categoryKind",
  "notes",
  "externalId",
] as const;
const STAGED_AMOUNTS = ["amount", "sourceAmount", "destinationAmount"] as const;

/** A template draft's own fields, kept as stored, which is what the format promises. */
const TEMPLATE_PASSTHROUGH = [
  "type",
  "date",
  "payee",
  "amount",
  "destinationAmount",
  "categoryName",
  "description",
  "notes",
] as const;

/** Copy the listed keys that hold something, and nothing else. */
function pick(source: JsonRecord, keys: readonly string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * The file a snapshot makes, before the reader has seen it.
 *
 * Exported for the tests that hold each rule to a snapshot built by hand.
 * Callers want `exportLedgerFile`, which reads the snapshot and then runs this
 * through `parseLedgerFile` before a byte of it is written out.
 *
 * Built so that every reference resolves. A record of a kind that was left out
 * is still named wherever something in the file names it, and travels as a
 * reference so the name has something to point at; that is what lets somebody
 * untick a kind without breaking the file. Which records are named is only
 * known once everything that can name one has been built, so the sections are
 * assembled in dependency order — entries and staged rows, then templates,
 * recurrences and budgets, then the categories they name and the groups those
 * belong to, and the accounts last.
 *
 * A uuid that no longer resolves is dropped rather than carried: a deleted
 * account or category in a template's draft or a staged row's, or a deleted
 * template on an entry. A recurrence whose own account is gone cannot be
 * proposed by anything, so it is left out whole.
 */
export function assembleLedgerFile(
  selection: LedgerFileSelection,
  snapshot: LedgerSnapshot,
  exportedAt: Date,
): JsonRecord {
  const kinds = new Set(selection.kinds);
  const chosen = selection.accountIds === undefined ? null : new Set(selection.accountIds);
  const start = selection.start ?? null;

  const keysFor = ledgerKeysById;
  const accountKeys = keysFor(snapshot.accounts);
  const categoryKeys = keysFor(snapshot.categories);
  const groupKeys = keysFor(snapshot.groups);
  const templateKeys = keysFor(snapshot.templates);
  const recurrenceKeys = keysFor(snapshot.recurrences);
  const categoryKinds = new Map(snapshot.categories.map((row) => [row.id, row.kind]));
  const categoryGroup = new Map(snapshot.categories.map((row) => [row.id, row.groupId]));

  // Every id something in the file names, by kind, so the sections written last
  // know which records to carry as references.
  const named = {
    accounts: new Set<string>(),
    categories: new Set<string>(),
    groups: new Set<string>(),
    templates: new Set<string>(),
  };
  const naming =
    (keys: ReadonlyMap<string, string>, into: Set<string>) =>
    (id: unknown): string | undefined => {
      if (typeof id !== "string") return undefined;
      const key = keys.get(id);
      if (key !== undefined) into.add(id);
      return key;
    };
  const account = naming(accountKeys, named.accounts);
  const category = naming(categoryKeys, named.categories);
  const group = naming(groupKeys, named.groups);
  const template = naming(templateKeys, named.templates);

  const entries = snapshot.entries.map((row) => {
    const draft = transactionToDraft(row, snapshot.legs.get(row.id) ?? []);
    const common = {
      // The origin, which is the entry's own id unless it arrived in a Simple
      // Balance file: then it keeps the one it arrived with, so a ledger moved
      // on a second time is still recognized by the copy it started in. One
      // committed from a row that waited in Staged keeps the row's id, which
      // is what every export written while it waited called it.
      id: row.importOrigin ?? snapshot.committedFrom.get(row.id) ?? row.id,
      date: draft.date,
      payee: draft.payee,
      ...present("description", draft.description),
      ...present("notes", draft.notes),
      ...present("externalId", draft.externalId),
      ...present("template", template(draft.templateId)),
      ...(row.deletedAt === null ? {} : { deleted: true }),
      ...present("category", category(draft.categoryId)),
    };
    if (draft.type === "transfer") {
      return {
        ...common,
        type: "transfer",
        from: account(draft.fromAccountId),
        to: account(draft.toAccountId),
        sourceAmount: draft.sourceAmount,
        destinationAmount: draft.destinationAmount,
      };
    }
    const legs = draft.legs?.map((leg) => ({
      category: category(leg.categoryId) ?? null,
      amount: leg.amount,
      ...present("note", leg.note),
    }));
    const side =
      draft.type === "deposit"
        ? { type: "deposit", to: account(draft.toAccountId) }
        : { type: "withdrawal", from: account(draft.fromAccountId) };
    return {
      ...common,
      ...side,
      amount: draft.amount,
      ...(legs ? { legs } : {}),
      ...present("postedAs", row.deletedAt === null ? postedAs(row.id, draft) : undefined),
    };
  });

  /**
   * The side an entry's postings hit, written only where it is not the side
   * `resolveEntrySide` would choose from the kinds the file gives its
   * categories. That happens when a category was widened to `both` after a
   * refund was filed under it, because widening reposts nothing. Where the
   * kinds no longer resolve at all, the actual side is written, because there
   * is no expected one for it to agree with.
   */
  function postedAs(
    id: string,
    draft: {
      type: EntryType;
      categoryId?: string | null;
      legs?: readonly { categoryId?: string | null }[];
    },
  ): CounterKind | undefined {
    const actual = snapshot.postedSides.get(id);
    if (actual?.length !== 1) return undefined;
    const kindsNamed = [draft.categoryId, ...(draft.legs ?? []).map((leg) => leg.categoryId)]
      .map((categoryId) => (categoryId ? categoryKinds.get(categoryId) : undefined))
      .filter((kind): kind is CategoryKind => kind !== undefined);
    const expected = resolveEntrySide(draft.type, kindsNamed);
    return expected.ok && expected.counterKind === actual[0] ? undefined : actual[0];
  }

  const staged = snapshot.staged.map((row) => {
    const stored = isRecord(row.draft) ? row.draft : {};
    const draft: JsonRecord = {
      ...pick(stored, STAGED_PASSTHROUGH),
      ...present("from", account(stored.fromAccountId)),
      ...present("to", account(stored.toAccountId)),
      ...present("category", category(stored.categoryId)),
      ...present("template", template(stored.templateId)),
    };
    for (const field of STAGED_AMOUNTS) {
      if (stored[field] !== undefined) draft[field] = stagedAmount(stored[field]);
    }
    // A split the queue can still repair is carried; anything else in that
    // field is not a split, and the file has no place for whatever it is.
    if (Array.isArray(stored.legs) && stored.legs.every(isRecord)) {
      draft.legs = stored.legs.map((leg) => ({
        ...pick(leg, ["categoryName", "categoryKind", "note"]),
        ...present("category", category(leg.categoryId)),
        ...(leg.amount === undefined ? {} : { amount: stagedAmount(leg.amount) }),
      }));
    }
    return { id: row.importOrigin ?? row.id, draft, rawData: row.rawData ?? null };
  });

  const wholeTemplates = kinds.has("templates") && chosen === null;
  const templateRecords = snapshot.templates.flatMap((row) => {
    const key = templateKeys.get(row.id)!;
    if (wholeTemplates) {
      const stored = isRecord(row.draft) ? row.draft : {};
      const notification = snapshot.notifications.get(row.id);
      return [
        {
          key,
          name: row.name,
          detail: "full",
          draft: {
            ...pick(stored, TEMPLATE_PASSTHROUGH),
            ...present("from", account(stored.fromAccountId)),
            ...present("to", account(stored.toAccountId)),
            ...present("category", category(stored.categoryId)),
            ...(Array.isArray(stored.legs)
              ? {
                  legs: stored.legs.filter(isRecord).map((leg) => ({
                    ...pick(leg, ["categoryName", "amount", "note"]),
                    ...present("category", category(leg.categoryId)),
                  })),
                }
              : {}),
          },
          notification: notification
            ? {
                frequency: notification.frequency,
                interval: notification.interval,
                anchorDate: notification.anchorDate,
                monthPolicy: notification.monthPolicy,
                weekendPolicy: notification.weekendPolicy,
                position:
                  notification.positionOrdinal !== null && notification.positionWeekday !== null
                    ? {
                        ordinal: notification.positionOrdinal,
                        weekday: notification.positionWeekday,
                      }
                    : null,
                time: notification.notifyAt,
                // The watermark, and the reason the reminder travels at all
                // rather than being set up again: a one-time reminder the
                // source already sent must not be sent a second time by the
                // copy it moves to.
                lastNotifiedDate: notification.lastNotifiedDate,
              }
            : null,
        },
      ];
    }
    return named.templates.has(row.id) ? [{ key, name: row.name, detail: "reference" }] : [];
  });

  const recurrenceRecords =
    kinds.has("recurrences") && chosen === null
      ? snapshot.recurrences.flatMap((row) => {
          const shape = isRecord(row.shape) ? row.shape : {};
          const type = shape.type;
          // Looked up before anything is marked as named, so a recurrence left
          // out does not leave a reference behind for an account nothing needs.
          const from =
            type === "deposit" ? undefined : accountKeys.get(String(shape.fromAccountId));
          const to = type === "withdrawal" ? undefined : accountKeys.get(String(shape.toAccountId));
          if (
            (type !== "deposit" && from === undefined) ||
            (type !== "withdrawal" && to === undefined)
          ) {
            return [];
          }
          return [
            {
              key: recurrenceKeys.get(row.id)!,
              name: row.name,
              shape: {
                type,
                ...(type === "deposit" ? {} : { from: account(shape.fromAccountId) }),
                ...(type === "withdrawal" ? {} : { to: account(shape.toAccountId) }),
                ...pick(shape, [
                  "amount",
                  ...(type === "transfer" ? ["destinationAmount"] : []),
                  "payee",
                  "description",
                  "categoryName",
                  "categoryKind",
                  "notes",
                ]),
                ...present("category", category(shape.categoryId)),
                ...(Array.isArray(shape.legs)
                  ? {
                      legs: shape.legs.filter(isRecord).map((leg) => ({
                        ...pick(leg, ["categoryName", "amount", "note"]),
                        ...present("category", category(leg.categoryId)),
                      })),
                    }
                  : {}),
              },
              schedule: ruleOf(row),
              notifyOnCreate: row.notifyOnCreate,
              lastOccurrenceDate: row.lastOccurrenceDate,
            },
          ];
        })
      : [];

  const target = (row: { categoryId: string | null; groupId: string | null }) =>
    row.categoryId !== null
      ? { category: category(row.categoryId) }
      : { group: group(row.groupId) };
  const categoryName = new Map(snapshot.categories.map((row) => [row.id, row.name]));
  const groupName = new Map(snapshot.groups.map((row) => [row.id, row.name]));
  const plans = snapshot.plans.map((row) => {
    const view = planView(
      row,
      row.categoryId !== null
        ? { kind: "category", id: row.categoryId, name: categoryName.get(row.categoryId) ?? "" }
        : { kind: "group", id: row.groupId ?? "", name: groupName.get(row.groupId ?? "") ?? "" },
    );
    return {
      ...target(row),
      currency: view.currency,
      periodUnit: view.periodUnit,
      amount: view.amount,
      activeFrom: view.activeFrom,
      activeTo: view.activeTo,
      rollover: view.rollover,
      rolloverCap: view.rolloverCap,
      targetAmount: view.targetAmount,
      targetDate: view.targetDate,
      lookbackPeriods: view.lookbackPeriods,
      percentOfPrevious: view.percentOfPrevious,
      percentOfIncome: view.percentOfIncome,
      priority: view.priority,
    };
  });
  const budgetAmounts = snapshot.budgetEntries.map((row) => ({
    ...target(row),
    currency: row.currency,
    periodUnit: row.periodUnit,
    periodStart: row.periodStart,
    amount: canonicalDecimal(row.amount),
  }));

  // Categories next, because everything above may have named one. In a file
  // of chosen accounts, "categories" means the ones its entries name, whole;
  // otherwise it means all of them. A category travelling either way names its
  // group, so the groups are decided after it.
  const wholeCategories = kinds.has("categories");
  const categoryRecords = snapshot.categories.flatMap((row) => {
    const included = wholeCategories && chosen === null ? true : named.categories.has(row.id);
    if (!included) return [];
    const common = {
      key: categoryKeys.get(row.id)!,
      name: row.name,
      kind: row.kind,
      group: group(categoryGroup.get(row.id)) ?? null,
    };
    return wholeCategories
      ? [{ ...common, detail: "full", archivedAt: row.archivedAt?.toISOString() ?? null }]
      : [{ ...common, detail: "reference" }];
  });
  const groupRecords = snapshot.groups.flatMap((row) => {
    const included = wholeCategories && chosen === null ? true : named.groups.has(row.id);
    if (!included) return [];
    return [
      {
        key: groupKeys.get(row.id)!,
        name: row.name,
        detail: wholeCategories ? "full" : "reference",
        policy: row.policy,
      },
    ];
  });

  // Accounts last, for the same reason. Whole when every account was asked
  // for, whole for the ones somebody chose, and a reference for anything else
  // the file names — the far side of a transfer, most often.
  const accountRecords = snapshot.accounts.flatMap((row) => {
    const whole = kinds.has("accounts") && (chosen === null || chosen.has(row.id));
    if (!whole) {
      return named.accounts.has(row.id)
        ? [
            {
              key: accountKeys.get(row.id)!,
              name: row.name,
              detail: "reference",
              type: row.type,
              currency: row.currency,
            },
          ]
        : [];
    }
    const archivedAt = row.archivedAt?.toISOString() ?? null;
    return [
      {
        key: accountKeys.get(row.id)!,
        name: row.name,
        detail: "full",
        type: row.type,
        currency: row.currency,
        openingDate: row.openingDate,
        openingBalance: canonicalDecimal(row.openingBalance),
        institution: row.institution,
        notes: row.notes,
        inBudget: row.inBudget,
        archivedAt,
        // Information and nothing more. Whether an account is frozen is the
        // copy it lands in's question to answer, from that copy's own plan.
        inUse: archivedAt === null && !snapshot.frozen.has(row.id),
        carriedForward:
          start !== null && kinds.has("entries")
            ? { date: start, amount: snapshot.carried?.get(row.id) }
            : null,
        ...(snapshot.balances ? { balance: snapshot.balances.get(row.id) } : {}),
      },
    ];
  });

  return {
    format: LEDGER_FILE_FORMAT,
    exportedAt: exportedAt.toISOString(),
    throughDate: snapshot.throughDate,
    producer: { version: APP_VERSION },
    scope: {
      kinds: ledgerFileKinds.filter((kind) => kinds.has(kind)),
      accounts: chosen === null ? "all" : "chosen",
      start,
      end: selection.end ?? null,
    },
    preferences: snapshot.preferences,
    groups: groupRecords,
    categories: categoryRecords,
    accounts: accountRecords,
    templates: templateRecords,
    recurrences: recurrenceRecords,
    budgets: { plans, entries: budgetAmounts },
    entries,
    staged,
    ...(kinds.has("history")
      ? {
          history: snapshot.history.map((row) => ({
            createdAt: row.createdAt.toISOString(),
            actorSource: row.actorSource,
            entityType: row.entityType,
            entityId: row.entityId,
            operation: row.operation,
            // The owner id goes for the reason it goes from every agent's
            // reply, and `clientId` with it: both name things on the copy the
            // file is leaving, and neither means anything anywhere else.
            before: withoutUserId(row.before),
            after: withoutUserId(row.after),
          })),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Adding a file to a ledger that may already hold one.
// ---------------------------------------------------------------------------

/**
 * The kinds a ledger's own records are read in for an import: everything a
 * file's records can be the same as, and nothing that counts toward a row cap.
 * Entries and staged rows are asked about by origin instead, which is one
 * indexed lookup rather than a ledger read into memory.
 */
const HERE_KINDS: readonly LedgerFileKind[] = [
  "categories",
  "accounts",
  "templates",
  "recurrences",
  "budgets",
];

/**
 * Limits that cannot refuse. The export's own are about a download, and a
 * ledger read in so a file can be compared with it is never sent anywhere: its
 * size is the destination's, which the person already has.
 */
const UNBOUNDED: LedgerFileExportLimits = {
  maxRows: Number.MAX_SAFE_INTEGER,
  maxHistoryBytes: Number.MAX_SAFE_INTEGER,
};

/** What every write of the add says in the history, the way a CSV's say `create_from_csv`. */
const ADD_OPERATION = "create_from_ledger_file";

/**
 * One part of a file, read and held to the part cap, before anything asks the
 * database.
 *
 * The cap is `MAX_BULK_SELECTION_ENTRIES`, the number a mass edit, a mass
 * delete, a commit and a CSV import share, because a part that staged more
 * rows than one commit can clear would be a cap doing damage. The splitter
 * never cuts a part over it; a file somebody made by hand can be, and is
 * refused with the way round it.
 */
function readPart(text: string): LedgerFile {
  const parsed = parseLedgerFileText(text);
  if (!parsed.ok) {
    // The reader's own sentences, each with the path into the file it is
    // about, so the browser and an agent are told the same thing the page's
    // own reading of the file said before it was ever sent.
    const first = parsed.issues[0]!;
    throw validationError(first.message, { issues: parsed.issues });
  }
  const count = ledgerFileRowCount(parsed.file);
  if (count > MAX_BULK_SELECTION_ENTRIES) {
    throw validationError(
      `This part holds ${count.toLocaleString("en-US")} entries, staged rows and budget amounts, and one part holds at most ${MAX_BULK_SELECTION_ENTRIES.toLocaleString("en-US")}. The import page cuts a larger file into parts; export a larger ledger one date range at a time to send it yourself.`,
      { limit: MAX_BULK_SELECTION_ENTRIES, count },
    );
  }
  // The same number for the records, held apart from the rows: every one is
  // created or matched in this part's one transaction under every namespace
  // lock, and each create reads its whole namespace for a name clash, so an
  // unbounded list would be a part that holds a connection for as long as
  // the list is long.
  const records = ledgerFileRecordCount(parsed.file);
  if (records > MAX_BULK_SELECTION_ENTRIES) {
    throw validationError(
      `This part holds ${records.toLocaleString("en-US")} accounts, categories, groups, templates, recurring transactions and budgets, and one part holds at most ${MAX_BULK_SELECTION_ENTRIES.toLocaleString("en-US")}. Every part carries all of them, so leave some kinds out of the export, such as budgets or categories, to bring it under that.`,
      { limit: MAX_BULK_SELECTION_ENTRIES, count: records },
    );
  }
  return parsed.file;
}

/**
 * Which of these origins this ledger already has, as an entry or as a row
 * still waiting in Staged.
 *
 * Five places, in one statement so a commit landing between two lookups cannot
 * slip an origin past both:
 *
 * - an entry's own id, which is what a file re-imported into the ledger it was
 *   exported from carries;
 * - an entry's `import_origin`, deleted entries included, because deleting an
 *   entry is a decision about it and importing it again would undo that;
 * - a waiting row's own id, which is the origin its export wrote when the row
 *   never had one of its own;
 * - a waiting row's `import_origin`;
 * - the id of a row with no origin that has been committed, which is the
 *   origin its entry is exported under from then on (`readCommittedFrom`), so
 *   a file written while the row waited is still skipped once it is in the
 *   books, whether or not the entry was deleted since.
 *
 * Every branch leads with the owner, so nothing of anybody else's is ever
 * matched — a forged origin can at worst make somebody's own import skip an
 * entry of their own — and so Citus routes the statement to one shard group.
 * The array is bound once per branch rather than once, because a bound
 * parameter cannot be named twice in a Drizzle template; five copies of at most
 * twenty thousand ids is a few megabytes at the very worst, against a lookup
 * that each branch answers from an index.
 */
async function findImportOrigins(
  tx: DbTransaction,
  actor: Actor,
  origins: readonly string[],
): Promise<Set<string>> {
  if (!origins.length) return new Set();
  const wanted = () => sql`${sql.param([...origins])}::uuid[]`;
  const found = await tx.execute<{ origin: string }>(sql`
    select id::text as origin from ledger_transaction
     where user_id = ${actor.userId} and id = any(${wanted()})
    union
    select import_origin::text from ledger_transaction
     where user_id = ${actor.userId} and import_origin is not null
       and import_origin = any(${wanted()})
    union
    select id::text from staged_transaction
     where user_id = ${actor.userId} and status = 'staged' and id = any(${wanted()})
    union
    select import_origin::text from staged_transaction
     where user_id = ${actor.userId} and status = 'staged' and import_origin is not null
       and import_origin = any(${wanted()})
    union
    select id::text from staged_transaction
     where user_id = ${actor.userId} and status = 'committed' and import_origin is null
       and id = any(${wanted()})
  `);
  return new Set(found.rows.map((row) => String(row.origin)));
}

/**
 * Whether this ledger holds anything that did not come from a Simple Balance
 * file: an entry, deleted or not, or a row waiting in Staged, without an
 * origin. Moving a whole ledger straight into the books is offered only where
 * it holds nothing else, and this is the read that says so. Adding is all that
 * is carried out today; the answer travels so the page can say which applies.
 *
 * A deleted entry counts: one typed by hand and deleted since is still somebody
 * having typed into this ledger.
 */
async function moveBlocked(tx: DbTransaction, actor: Actor): Promise<boolean> {
  const result = await tx.execute<{ blocked: boolean }>(sql`
    select exists (
             select 1 from ledger_transaction
              where user_id = ${actor.userId} and import_origin is null
           )
        or exists (
             select 1 from staged_transaction
              where user_id = ${actor.userId} and status = 'staged' and import_origin is null
           ) as blocked
  `);
  return Boolean(result.rows[0]?.blocked);
}

const MOVE_BLOCKED_REASON =
  "This ledger already has entries that did not come from a Simple Balance file, so a file can only be added to it, with its entries going to Staged for review.";

/**
 * Everything an import asks the database, on the caller's transaction:
 * this ledger's own records in the form a file writes them, the plan's limit
 * and the settings chosen here, and which of the file's entries and staged rows
 * are already here by origin.
 *
 * **The records are read by the exporter itself.** Its snapshot read and its
 * assembly, the same code that wrote the file, write this ledger's records as a
 * file would carry them, so "the same record" means "would export to the same
 * record". That is what makes a record an earlier part of this import created
 * read as the same one when the next part arrives, and a file added twice
 * write nothing the second time, without anything keeping a list of what an
 * import made.
 *
 * Shared by the preview and the add, which reads it under the locks its writes
 * will hold, so what it plans against cannot change before it writes.
 */
async function readLedgerFileFacts(
  tx: DbTransaction,
  actor: Actor,
  file: LedgerFile,
): Promise<LedgerFileFacts> {
  const selection = ledgerFileSelectionSchema.parse({ kinds: HERE_KINDS });
  const snapshot = await readLedgerSnapshot(tx, actor, selection, UNBOUNDED);
  const assembled = parseLedgerFile(assembleLedgerFile(selection, snapshot, new Date()));
  if (!assembled.ok) {
    // The export's defect, met on the way in rather than out, and a 500 for
    // the reason it is one there: nothing the caller sent can fix it. Paths
    // only, because a sentence here quotes somebody's account names.
    const fields = assembled.issues.map((issue) => issue.field || "(file)").join(", ");
    throw new Error(`This ledger's own records failed the Simple Balance file reader at ${fields}`);
  }
  const here = assembled.file;
  const idsByKey = (rows: readonly { id: string; name: string }[]) =>
    Object.fromEntries([...ledgerKeysById(rows)].map(([id, key]) => [key, id]));
  const entitlement = await getEntitlement(actor, tx);
  const stored = await getPreferences(actor, tx);
  const live = file.entries.filter((entry) => !entry.deleted).map((entry) => entry.id);
  const staged = file.staged.map((row) => row.id);
  const found = await findImportOrigins(tx, actor, [...live, ...staged]);
  const blocked = await moveBlocked(tx, actor);
  return {
    here: {
      groups: here.groups,
      categories: here.categories,
      accounts: here.accounts,
      templates: here.templates,
      recurrences: here.recurrences,
      budgets: here.budgets,
      ids: {
        group: idsByKey(snapshot.groups),
        category: idsByKey(snapshot.categories),
        account: idsByKey(snapshot.accounts),
        template: idsByKey(snapshot.templates),
        recurrence: idsByKey(snapshot.recurrences),
      },
      // A limit only where one is in force: a deployment that sells nothing,
      // and the paid plan, keep every account in use.
      limit:
        entitlement.billing && entitlement.accountLimit !== null ? entitlement.accountLimit : null,
      preferences: {
        chosen: stored.chosen,
        timezone: stored.timezone,
        defaultCurrency: stored.defaultCurrency,
        theme: stored.theme as Theme,
      },
    },
    rows: {
      alreadyHere: live.filter((origin) => found.has(origin)).length,
      stagedAlreadyHere: staged.filter((origin) => found.has(origin)).length,
    },
    move: { qualifies: !blocked, reason: blocked ? MOVE_BLOCKED_REASON : null },
  };
}

/**
 * What adding one part of a file to this ledger would do, with nothing decided
 * yet. Writes nothing at all, not even an audit row.
 *
 * One snapshot, `REPEATABLE READ, READ ONLY`, like the export, so the records,
 * the places and the origins it reports were all true at the same moment. The
 * plan in the reply is the one the add will run with the same file and no
 * decisions, and the add refuses with exactly its problems until they are
 * decided; a page holding a file of several parts previews each, merges the
 * facts and plans the whole file itself.
 */
export async function previewLedgerFile(actor: Actor, input: unknown): Promise<LedgerFilePreview> {
  const { ledgerFile } = ledgerFilePreviewInputSchema.parse(input);
  const file = readPart(ledgerFile);
  const facts = await getDb().transaction((tx) => readLedgerFileFacts(tx, actor, file), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
  return { ...facts, plan: planLedgerFileAdd({ file, facts }).plan };
}

/**
 * The accounts an add may write staged rows against without having locked
 * them first: every account here whose name folds onto one the file carries or
 * a decision names, and every account a decision matches by id.
 *
 * Taken before anything else, because the order `helpers.ts` asks for puts the
 * accounts first and the namespaces after them. An account the plan then uses
 * that is not among them can only have come into being or been renamed in
 * between, and the add refuses rather than write against it unlocked.
 */
async function lockNamedAccounts(
  tx: DbTransaction,
  actor: Actor,
  file: LedgerFile,
  decisions: readonly LedgerFileDecision[],
): Promise<Set<string>> {
  const names = new Set(file.accounts.map((account) => normalizeHumanName(account.name)));
  const matched: string[] = [];
  for (const decision of decisions) {
    if (decision.kind !== "account") continue;
    if (decision.action === "rename" || (decision.action === "create" && decision.name)) {
      names.add(normalizeHumanName(decision.name!));
    }
    if (decision.action === "match") matched.push(decision.id);
  }
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.systemKind)));
  const locked = [
    ...rows.filter((row) => names.has(normalizeHumanName(row.name))).map((row) => row.id),
    ...matched,
  ];
  await lockAccountReferences(tx, actor, locked);
  return new Set(locked);
}

/** The refusal an add answers a plan with a problem with, and nothing written. */
function planRefusal(plan: LedgerFilePlan) {
  const first = plan.problems[0]!;
  const placesFirst = first.field === "arriveArchived" && plan.places.needed > plan.places.chosen;
  const { limit, inUse: current, arriving, needed } = plan.places;
  // The numbers the first problem's sentence says, as fields beside it, so
  // nobody has to read them back out of the message it becomes. Each problem
  // carries its own in `issues` as well.
  const { field: _field, message: _message, kind: _kind, key: _key, ...numbers } = first;
  return validationError(
    first.message,
    {
      issues: plan.problems,
      ...numbers,
      ...(placesFirst ? { limit, current, arriving, needed } : {}),
    },
    // An agent cannot buy anything, so the browser's "or upgrade" is advice it
    // cannot take: it gets the numbers, what it can send, and who to ask —
    // the `accountAllowance` precedent. Only moves that work: a new account
    // takes no decision, so a skip would change nothing.
    placesFirst
      ? `This ledger is on a plan that keeps ${limit} accounts in use and has ${current}, and this file brings ${arriving} more. Name at least ${needed} of the file's new accounts in arriveArchived, or archive or delete accounts here first to free places. Only the person who owns the ledger can raise the limit, from Settings in the browser.`
      : undefined,
  );
}

/**
 * Add one part of a Simple Balance file to this ledger.
 *
 * Records that are not transactions — groups, categories, accounts, templates,
 * recurring transactions, budgets — are created at once when nothing like
 * them is here, and one that is here under the same name is used or left out
 * or brought in renamed, as `decisions` says; nothing here is ever changed.
 * Entries go to Staged like any import, complete wherever every reference
 * resolves, with both sides of a transfer filled in and the origin they arrived
 * with. An entry or staged row whose origin is already here is skipped and
 * counted. Deleted entries are not brought.
 *
 * **All of it or none of it, per part.** The plan is worked out again here, on
 * the facts read under the locks the writes hold, and refused with its
 * problems before the first write; a service refusing something the plan did
 * not foresee rolls the whole part back. A file of several parts is applied a
 * part at a time, each idempotent by its key and by its origins, so a part
 * that failed is sent again and one that succeeded replays.
 *
 * `ledger:write` on both transports, because it creates records rather than
 * proposing them: `ledger:stage` proposes and never decides.
 */
export async function addLedgerFile(
  actor: Actor,
  input: unknown,
  options: { onProgress?: (event: ProgressEvent) => void } = {},
  transaction?: DbTransaction,
): Promise<LedgerFileAddResult> {
  const parsed = ledgerFileAddInputSchema.parse(input);
  const file = readPart(parsed.ledgerFile);
  const fileHash = createHash("sha256").update(parsed.ledgerFile).digest("hex");
  // The file by its hash rather than its text, which is up to sixteen
  // mebibytes and would be stored again in the key's record otherwise.
  const idempotencyPayload = {
    fileHash,
    fileName: parsed.fileName,
    part: parsed.part,
    decisions: parsed.decisions,
    arriveArchived: parsed.arriveArchived,
    preferences: parsed.preferences ?? null,
  };

  let replayed = false;
  const outcome = await withTransaction(transaction, async (tx) => {
    await lockIdempotencyKey(tx, actor, "ledger-file.add", parsed.idempotencyKey);
    const existing = await getIdempotent<LedgerFileAddResult>(
      tx,
      actor,
      "ledger-file.add",
      parsed.idempotencyKey,
      idempotencyPayload,
    );
    if (existing) {
      replayed = true;
      return existing;
    }

    // Every lock up front, in the order `helpers.ts` asks for, so nothing the
    // services below take afterward can deadlock against another write: each
    // re-takes these for free, and a record this call creates has an id
    // nobody else can know yet.
    const locked = await lockNamedAccounts(tx, actor, file, parsed.decisions);
    await lockAccountNamespace(tx, actor);
    await lockCategoryNamespace(tx, actor);
    await lockPayeeNamespace(tx, actor);
    await lockTransactionTemplateNamespace(tx, actor);
    await lockRecurrenceNamespace(tx, actor);

    const facts = await readLedgerFileFacts(tx, actor, file);
    const planned = planLedgerFileAdd({
      file,
      facts,
      decisions: parsed.decisions,
      arriveArchived: parsed.arriveArchived,
      preferences: parsed.preferences,
    });
    const { plan } = planned;
    if (!plan.ok) throw planRefusal(plan);
    if (
      plan.records.some(
        (record) => record.kind === "account" && record.action === "use" && !locked.has(record.id!),
      )
    ) {
      throw conflict("This ledger changed while the file was being read. Preview it again.");
    }

    const created = new Map<string, string>();
    const ref: LedgerRefResolver = (kind, key) => planned.resolve(kind, key, created);
    const creating = (kind: LedgerImportKind) =>
      plan.records.filter((record) => record.kind === kind && record.action === "create");
    const audit = { auditOperation: ADD_OPERATION };
    const byKey = <T extends { key: string }>(rows: readonly T[]) =>
      new Map(rows.map((row) => [row.key, row]));

    // Settings first, because the timezone decides the day a recurrence first
    // proposes and the day an account arriving archived is closed on.
    // `ifUnchosen` where nothing was chosen here when this was read, so a
    // choice somebody made since, in another tab, wins over the file.
    if (plan.preferences.action === "apply" && file.preferences !== null) {
      await setPreferences(
        actor,
        { ...file.preferences, ifUnchosen: !facts.here.preferences.chosen },
        tx,
      );
    }

    const groups = byKey(file.groups);
    for (const record of creating("group")) {
      const made = await createCategoryGroup(
        actor,
        ledgerGroupInput(groups.get(record.key)!, record.importName!),
        tx,
        audit,
      );
      created.set(ledgerCreatedKey("group", record.key), made.id);
    }
    // In use whatever the file says about being archived: a row filed under an
    // archived category cannot be committed, and a category takes no place,
    // so nothing is saved by making somebody restore it first. The plan's
    // message on the record says so.
    const categoryRecords = byKey(file.categories);
    for (const record of creating("category")) {
      const made = await createCategory(
        actor,
        ledgerCategoryInput(categoryRecords.get(record.key)!, record.importName!, ref),
        tx,
        audit,
      );
      created.set(ledgerCreatedKey("category", record.key), made.id);
    }
    const accounts = byKey(file.accounts);
    const openings = new Map(
      parsed.decisions.flatMap((decision) =>
        decision.kind === "account" && decision.action === "create" && decision.openingDate
          ? [[decision.key, decision.openingDate] as const]
          : [],
      ),
    );
    for (const record of creating("account")) {
      const made = await createAccount(
        actor,
        ledgerAccountInput(
          accounts.get(record.key)!,
          record.importName!,
          file,
          openings.get(record.key),
        ),
        tx,
        { ...audit, arriveArchived: record.arrivesArchived },
      );
      created.set(ledgerCreatedKey("account", record.key), made.id);
    }
    const templates = byKey(file.templates);
    for (const record of creating("template")) {
      const source = templates.get(record.key)!;
      if (source.detail !== "full") continue;
      const { input: template, lastNotifiedDate } = ledgerTemplateInput(
        source,
        record.importName!,
        ref,
      );
      const made = await createTransactionTemplate(actor, template, tx, {
        ...audit,
        lastNotifiedDate,
      });
      created.set(ledgerCreatedKey("template", record.key), made.id);
    }
    const recurrenceRecords = byKey(file.recurrences);
    for (const record of creating("recurrence")) {
      const { input: recurrence, lastOccurrenceDate } = ledgerRecurrenceInput(
        recurrenceRecords.get(record.key)!,
        record.importName!,
        ref,
      );
      const made = await createRecurrence(actor, recurrence, tx, {
        ...audit,
        lastOccurrenceDate,
      });
      created.set(ledgerCreatedKey("recurrence", record.key), made.id);
    }
    const plans = new Map(file.budgets.plans.map((each) => [ledgerBudgetPlanKey(each), each]));
    for (const record of creating("budget_plan")) {
      const made = await createBudgetPlan(
        actor,
        ledgerBudgetPlanInput(plans.get(record.key)!, ref),
        tx,
        audit,
      );
      created.set(ledgerCreatedKey("budget_plan", record.key), made.id);
    }
    let budgetEntriesCreated = 0;
    for (const entry of file.budgets.entries) {
      if (planned.budgetEntryAction(entry) !== "create") continue;
      await setBudgetEntry(actor, ledgerBudgetEntryInput(entry, ref), tx, audit);
      budgetEntriesCreated += 1;
    }

    // Under the locks, after every record is made: an origin committed by
    // another import a moment ago is skipped here rather than staged twice.
    const live = file.entries.filter((entry) => !entry.deleted);
    const found = await findImportOrigins(tx, actor, [
      ...live.map((entry) => entry.id),
      ...file.staged.map((row) => row.id),
    ]);
    const rows = [
      ...live
        .filter((entry) => !found.has(entry.id))
        .map((entry) => ({
          draft: ledgerEntryDraft(entry, ref),
          rawData: null,
          importOrigin: entry.id,
        })),
      ...file.staged
        .filter((row) => !found.has(row.id))
        .map((row) => ({
          draft: ledgerStagedDraft(row, ref),
          rawData: row.rawData,
          importOrigin: row.id,
        })),
    ];

    let importBatchId: string | null = null;
    let needsReview = 0;
    if (rows.length) {
      const [batch] = await tx
        .insert(importBatches)
        .values({
          userId: actor.userId,
          kind: "ledger_file",
          fileName: parsed.fileName,
          fileHash,
          // A CSV's two columns, which mean nothing for a file of JSON: no
          // delimiter, and in place of a column mapping the format and the
          // part, which is what somebody reading the batch can use.
          delimiter: "",
          mapping: { format: LEDGER_FILE_FORMAT, part: parsed.part },
          rowCount: rows.length,
        })
        .returning();
      await writeAudit(tx, actor, {
        entityType: "import_batch",
        entityId: batch!.id,
        operation: "create",
        after: serializeRow(batch),
      });
      importBatchId = batch!.id;
      const staged = await insertImportedStages(
        tx,
        actor,
        rows.map((row) => ({ ...row, importBatchId })),
        options.onProgress,
        audit,
      ).catch((error: unknown) => {
        // The waiting-row index refusing a second row for one origin: another
        // import staged it between this one's lookup and its insert, which the
        // locks make rare and the index makes harmless.
        if (isUniqueViolation(error, "staged_user_import_origin_unique")) {
          throw conflict(
            "Another import staged this file's entries a moment ago. Preview the file again.",
          );
        }
        throw error;
      });
      needsReview = staged.filter(
        (row) => (row.validationIssues as unknown[]).length > 0 || row.duplicateOfId !== null,
      ).length;
    }

    const response: LedgerFileAddResult = {
      part: parsed.part,
      importBatchId,
      staged: rows.length,
      needsReview,
      budgetEntries: {
        created: budgetEntriesCreated,
        skipped: file.budgets.entries.length - budgetEntriesCreated,
      },
      plan: {
        ...plan,
        records: plan.records.map((record) => {
          const id = created.get(ledgerCreatedKey(record.kind, record.key));
          return id === undefined ? record : { ...record, id };
        }),
      },
    };
    await setIdempotent(
      tx,
      actor,
      "ledger-file.add",
      parsed.idempotencyKey,
      idempotencyPayload,
      response,
    );
    return response;
  });
  // Rows placed in the queue, after the commit that placed them and never on a
  // replay, for the reasons `stageCsv` counts its own that way.
  if (!replayed && outcome.staged) {
    const staged = outcome.staged;
    countAfterCommit(transaction, () => ledgerFileRowsStaged.inc(staged));
  }
  return outcome;
}
