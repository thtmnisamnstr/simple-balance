import {
  and,
  count,
  eq,
  inArray,
  ne,
  notInArray,
  sql,
  type SQL, getTableColumns } from "drizzle-orm";
import { z, ZodError } from "zod";
import type {
  Actor,
  BulkStageEditResult,
  BulkStagePatch,
  PaginatedPage,
  TransactionDraft,
  ValidationIssue,
  SortDirection,
  StageSortField,
} from "../../shared/domain.js";
import {
  LIKELY_DUPLICATE_DAYS,
  bulkDeleteStageSchema,
  bulkStageEditSchema,
  bulkStageFilterSelectionRequestSchema,
  bulkStageSelectionSnapshotSchema,
  commitStageSchema,
  MAX_BULK_SELECTION_ENTRIES,
  stageCreateSchema,
  stageListQuerySchema,
  stageUpdateSchema,
  transactionDraftSchema,
} from "../../shared/domain.js";
import {
  getDb,
  type Database,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  stagedTransactions,
  type StagedTransactionRow,
} from "../db/schema.js";
import { duplicate, notFound, staleVersion, validationError, zodIssues, AppError } from "./errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  exceedsBulkSelectionCap,
  getIdempotent,
  likePattern,
  lockAccountReferences,
  lockCategoryNamespace,
  lockIdempotencyKey,
  lockPayeeNamespace,
  selectionFingerprint,
  serializeRow,
  setIdempotent,
  writeAudit,
  writeAuditMany,
} from "./helpers.js";
import {
  type SortPlan,
  keysetAfter,
  ordered,
} from "./sorting.js";
import { normalizeHumanName } from "../../shared/names.js";
import { pruneOrphanedCategories } from "./categories.js";
import { canonicalizeStagedDraftPayee } from "./payees.js";
import {
  createTransactionWithinTx,
  findDuplicate,
  getTransaction,
  lockTransactionDuplicateKeys,
  prepareTransaction,
  transactionDuplicateKeys,
} from "./transactions.js";

export type StageView = ReturnType<typeof stageView>;
const referenceUuidSchema = z.string().uuid();

function stageView(
  row: StagedTransactionRow & {
    repeatsStagedRow?: boolean;
    likelyDuplicateOfId?: string | null;
  },
) {
  // The fingerprint itself is an internal detail; what a caller needs is
  // whether the row repeats something, and which something.
  const {
    duplicateKey: _duplicateKey,
    repeatsStagedRow,
    likelyDuplicateOfId: likely,
    ...rest
  } = row;
  return {
    ...serializeRow(rest as StagedTransactionRow),
    validationIssues: row.validationIssues as ValidationIssue[],
    draft: row.draft as Partial<TransactionDraft>,
    // Only the list query works this out, because it is a comparison against
    // the rest of the queue. Where it was not computed the answer is unknown
    // rather than no, and saying `false` there contradicted what the same row
    // reports in a list.
    repeatsStagedRow: repeatsStagedRow ?? null,
    // Same rule as above, but two callers compare against the ledger rather than
    // one: the list, and the duplicate review on the row it was asked about.
    // Where neither did the answer is unknown rather than none.
    likelyDuplicateOfId: likely === undefined ? null : likely,
  };
}

function referenceValue(
  draft: unknown,
  field: "fromAccountId" | "toAccountId" | "categoryId",
) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;
  const value = (draft as Record<string, unknown>)[field];
  const parsed = referenceUuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function lockStagedDraftReferences(
  tx: DbTransaction,
  actor: Actor,
  drafts: readonly unknown[],
) {
  const accountIds = drafts.flatMap((draft) =>
    [
      referenceValue(draft, "fromAccountId"),
      referenceValue(draft, "toAccountId"),
    ].filter((value): value is string => Boolean(value)),
  );
  await lockAccountReferences(tx, actor, accountIds);
  // A split names its categories on the legs rather than in the column, so both
  // are looked at. Without the lock, two rows staged at once naming the same new
  // category by name would each create it.
  const namesACategory = (draft: unknown) =>
    Boolean(referenceValue(draft, "categoryId")) ||
    // A name and no id is a category this commit may create, which takes the
    // same namespace lock. `referenceValue` parses uuids, so it cannot see one.
    typeof (draft as { categoryName?: unknown })?.categoryName === "string" ||
    (Array.isArray((draft as { legs?: unknown })?.legs) &&
      (draft as { legs: unknown[] }).legs.some(
        (leg) =>
          referenceValue(leg, "categoryId") ??
          (leg as { categoryName?: unknown })?.categoryName,
      ));
  if (drafts.some(namesACategory)) {
    await lockCategoryNamespace(tx, actor);
  }
  await lockPayeeNamespace(tx, actor);
}

async function validateDraft(
  tx: DbTransaction,
  actor: Actor,
  input: unknown,
  options: { withDuplicate?: boolean } = {},
): Promise<{
  draft: TransactionDraft | null;
  issues: ValidationIssue[];
  duplicateOfId: string | null;
  duplicateKey: string | null;
}> {
  // A staged row always becomes a NEW transaction, so a leg identity carried in
  // its draft names nothing. Left in, the ledger refuses it with "Leg is
  // unavailable" at commit rather than at stage, and because a commit is atomic
  // one such row fails the whole batch somebody selected. Dropped here, where
  // every staged path already passes through, rather than in each of them.
  const withoutLegIds =
    input && typeof input === "object" && Array.isArray((input as { legs?: unknown }).legs)
      ? {
          ...(input as Record<string, unknown>),
          legs: ((input as { legs: unknown[] }).legs).map((leg) =>
            leg && typeof leg === "object" && "id" in leg
              ? Object.fromEntries(
                  Object.entries(leg as Record<string, unknown>).filter(
                    ([key]) => key !== "id",
                  ),
                )
              : leg,
          ),
        }
      : input;
  const parsed = transactionDraftSchema.safeParse(withoutLegIds);
  if (!parsed.success) {
    return {
      draft: null,
      issues: zodIssues(parsed.error),
      duplicateOfId: null,
      duplicateKey: null,
    };
  }
  // Recorded even when the row has other problems, so a queue full of
  // near-identical rows can still be sorted out before anything is committed.
  //
  // One column holds one key, and a draft can have two: the heuristic
  // fingerprint and, when the bank gave it a reference, `external:<id>`. The
  // external one is preferred because it is an identity rather than a guess -
  // two rows carrying it are the same transaction whatever else differs.
  // Taking the first of the sorted pair instead chose between them by
  // alphabet, which flagged neither reliably.
  //
  // This is the queue's badge, not the guard. Committing compares every key of
  // every selected row against every other (commitStages), so a pair this
  // misses - one row with a reference and one without, alike enough to share a
  // heuristic key - is still refused at the point it would matter.
  const stagedKeys = transactionDuplicateKeys(parsed.data);
  const duplicateKey =
    stagedKeys.find((key) => key.startsWith("external:")) ?? stagedKeys[0] ?? null;
  try {
    // Lookup rather than ensure: validating a draft answers whether it would
    // balance, and a question about the books should not add to them.
    await prepareTransaction(tx, actor, parsed.data, { systemAccounts: "lookup" });
    // Skipped where the caller is about to take the duplicate-key locks and ask
    // again under them. The unlocked answer is a badge for the queue, not a
    // decision, so computing it for a commit is a lookup per row whose result
    // is thrown away a few lines later.
    const duplicateOfId =
      options.withDuplicate === false
        ? null
        : await findDuplicate(tx, actor, parsed.data);
    return { draft: parsed.data, issues: [], duplicateOfId, duplicateKey };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        draft: parsed.data,
        issues: zodIssues(error),
        duplicateOfId: null,
        duplicateKey,
      };
    }
    // Only a genuine problem with the row becomes a row issue. A database or
    // network failure caught here would be filed against the person's data as
    // though they had typed something wrong, and would never reach the logs.
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return {
        draft: parsed.data,
        issues: [{ field: "draft", message: error.message }],
        duplicateOfId: null,
        duplicateKey,
      };
    }
    throw error;
  }
}

export async function createStage(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = stageCreateSchema.parse(input);
  const idempotencyPayload = {
    draft: parsed.draft,
    rawData: parsed.rawData,
  };
  return withTransaction(transaction, async (tx) => {
    await lockIdempotencyKey(
      tx,
      actor,
      "stage.create",
      parsed.idempotencyKey,
    );
    const existing = await getIdempotent<StageView>(
      tx,
      actor,
      "stage.create",
      parsed.idempotencyKey,
      idempotencyPayload,
    );
    if (existing) return existing;
    await lockStagedDraftReferences(tx, actor, [parsed.draft]);
    const canonicalDraft = await canonicalizeStagedDraftPayee(
      tx,
      actor,
      parsed.draft,
    );
    const validation = await validateDraft(tx, actor, canonicalDraft);
    const [created] = await tx
      .insert(stagedTransactions)
      .values({
        userId: actor.userId,
        draft: canonicalDraft,
        rawData: parsed.rawData,
        validationIssues: validation.issues,
        duplicateOfId: validation.duplicateOfId,
        duplicateKey: validation.duplicateKey,
      })
      .returning();
    const view = stageView(created);
    await writeAudit(tx, actor, {
      entityType: "staged_transaction",
      entityId: created.id,
      operation: "create",
      after: view,
    });
    await setIdempotent(
      tx,
      actor,
      "stage.create",
      parsed.idempotencyKey,
      idempotencyPayload,
      view,
    );
    return view;
  });
}

type GeneratedStageInput = {
  draft: unknown;
  rawData: unknown;
  importBatchId: string | null;
  recurrenceId: string | null;
  occurrenceDate: string | null;
  initialIssues?: ValidationIssue[];
};

/** Everything a staged row needs decided, with nothing written yet. */
async function prepareGeneratedStage(
  tx: DbTransaction,
  actor: Actor,
  input: GeneratedStageInput,
) {
  await lockStagedDraftReferences(tx, actor, [input.draft]);
  const canonicalDraft = await canonicalizeStagedDraftPayee(
    tx,
    actor,
    input.draft,
  );
  const draftValidation = await validateDraft(tx, actor, canonicalDraft);
  return {
    userId: actor.userId,
    draft: canonicalDraft ?? {},
    rawData: input.rawData,
    importBatchId: input.importBatchId,
    recurrenceId: input.recurrenceId,
    occurrenceDate: input.occurrenceDate,
    validationIssues: [
      ...(input.initialIssues ?? []),
      ...draftValidation.issues,
    ],
    duplicateOfId: draftValidation.duplicateOfId,
    duplicateKey: draftValidation.duplicateKey,
  };
}

/**
 * Stage what a recurrence has decided is due.
 *
 * There is no idempotency key because there is a better one: the occurrence a
 * row belongs to is unique at the schema level, so a second tick, a second
 * replica and a half-restored backup all arrive at that constraint and the
 * second one writes nothing.
 *
 * Provenance is an argument rather than a field on the draft, and
 * stageCreateSchema stays strict. A caller able to name a recurrence could
 * forge "the scheduler proposed this" in the audit trail, and could take the
 * occurrence key so the real proposal could never be written at all.
 */
export async function insertRecurringStages(
  tx: DbTransaction,
  actor: Actor,
  inputs: readonly Omit<GeneratedStageInput, "importBatchId">[],
) {
  if (!inputs.length) return [];
  const values = [];
  for (const input of inputs) {
    values.push(
      await prepareGeneratedStage(tx, actor, { ...input, importBatchId: null }),
    );
  }
  const created = await tx.insert(stagedTransactions).values(values).returning();
  await writeAuditMany(
    tx,
    actor,
    created.map((row) => ({
      entityType: "staged_transaction",
      entityId: row.id,
      operation: "create_from_recurrence",
      after: stageView(row),
    })),
  );
  return created;
}

/**
 * Stage a whole file's worth of rows with two statements per chunk instead of
 * two per row.
 *
 * Each row still has to be checked against the ledger on its own, because that
 * is what the review queue is for. What it does not need is its own insert and
 * its own audit round trip: those are the same statement repeated, and on a
 * twelve-thousand-row import they were most of the wall clock.
 */
export async function insertImportedStages(
  tx: DbTransaction,
  actor: Actor,
  inputs: readonly Omit<GeneratedStageInput, "recurrenceId" | "occurrenceDate">[],
) {
  if (!inputs.length) return [];
  const values = [];
  for (const input of inputs) {
    values.push(
      await prepareGeneratedStage(tx, actor, {
        ...input,
        recurrenceId: null,
        occurrenceDate: null,
      }),
    );
  }

  // Bounded so one enormous file cannot build a statement PostgreSQL refuses
  // for having too many bind parameters.
  const CHUNK = 500;
  const created: (typeof stagedTransactions.$inferSelect)[] = [];
  for (let start = 0; start < values.length; start += CHUNK) {
    const inserted = await tx
      .insert(stagedTransactions)
      .values(values.slice(start, start + CHUNK))
      .returning();
    created.push(...inserted);
  }

  await writeAuditMany(
    tx,
    actor,
    created.map((row) => ({
      entityType: "staged_transaction",
      entityId: row.id,
      operation: "create_from_csv",
      after: stageView(row),
    })),
  );
  return created;
}

/**
 * `decimalStringSchema`'s rule, written for PostgreSQL: at most 26 digits before
 * the point and 18 after.
 *
 * The bound is the whole point. Guarding a `::numeric` cast on shape alone
 * admits literals `numeric` cannot hold, and a draft amount of two hundred
 * thousand digits then raises SQLSTATE 22003 and takes the queue down on its
 * default sort — the same failure, and the same dead end, as an impossible date.
 * Anything the domain would accept casts; anything it would not lands as NULL,
 * which is where a draft the person still has to fix belongs anyway.
 */
const DRAFT_DECIMAL = "^-?(0|[1-9][0-9]{0,25})(\\.[0-9]{1,18})?$";

/**
 * A staged row is a draft, so the columns the queue shows live inside unvalidated
 * JSON. Every expression here reads that JSON as text and compares it as text,
 * which keeps a malformed draft from turning a sort into a cast error.
 */
function stageSortPlan(
  sort: StageSortField,
  direction: SortDirection,
): SortPlan<StagedTransactionRow> {
  const id = sql`${stagedTransactions.id}`;
  const tie = ordered(id, direction);
  const draft = sql`${stagedTransactions.draft}`;
  // Draft fields are optional, so absent values need a defined place to land.
  const paged = (expression: SQL) => ({
    orderBy: [ordered(expression, direction, true), tie],
    keyset: null,
    cursorValue: null,
  });

  switch (sort) {
    case "payee":
      return paged(sql`lower(${draft} ->> 'payee')`);
    case "account":
      return paged(sql`(
        select lower(name) from ledger_account
        where ledger_account.user_id = ${stagedTransactions.userId}
          and ledger_account.id::text = coalesce(
            ${draft} ->> 'fromAccountId',
            ${draft} ->> 'toAccountId'
          )
      )`);
    case "category":
      return paged(sql`(
        select lower(name) from category
        where category.user_id = ${stagedTransactions.userId}
          and category.id::text = ${draft} ->> 'categoryId'
      )`);
    case "status":
      // The order the queue reads in: what needs a person, then what might be a
      // repeat, then what is ready to go.
      //
      // "Might be a repeat" is the same three ways the badge and the filter mean
      // it — a strict match, another row still waiting, or something already
      // committed that looks like the same money. Asking only about the strict
      // match sorted a badged row in among the ready ones.
      return paged(sql`case
        when jsonb_array_length(${stagedTransactions.validationIssues}) > 0 then 0
        when ${possiblyDuplicate} then 1
        else 2
      end`);
    case "amount":
      // A transfer states its amount as `sourceAmount`, which is what the queue
      // shows for one, so sorting on `amount` alone left every transfer with no
      // value to sort by and sent them all to one end.
      return paged(sql`case
        when ${draft} ->> 'type' = 'transfer' then ${draftAmount("sourceAmount")}
        else ${draftAmount("amount")}
      end`);
    default: {
      // ISO dates sort the same as text, so this ordering can be resumed.
      //
      // A staged row need not carry a date at all: a CSV line the parser could
      // not read is stored with whatever it managed, and those are exactly the
      // rows somebody is here to fix. Left as NULL, such a row makes the keyset
      // row comparison evaluate to NULL and drop out of every resumed page,
      // while the cursor written for it says "" and matches nothing after it.
      // Coalescing to "" gives them one real place in the order: first
      // ascending, last descending, and visible either way.
      const expression = sql`coalesce(${draft} ->> 'date', '')`;
      return {
        orderBy: [ordered(expression, direction), tie],
        keyset: keysetAfter(expression, id, direction),
        cursorValue: (row) => {
          const value = (row.draft as { date?: unknown }).date;
          return typeof value === "string" ? value : "";
        },
      };
    }
  }
}

/**
 * A row is a possible duplicate when it matches something already committed, or
 * when another row still waiting in the queue carries the same fingerprint.
 * Only the first was recorded before, so two imported copies of one statement
 * were refused at commit while this filter found nothing to show for it.
 *
 * At module scope because it depends on no query, and both the filter and the
 * flag the list reports read it.
 */
const repeatsAnotherStagedRow = sql`(
  ${stagedTransactions.duplicateKey} is not null
  and exists (
    select 1 from staged_transaction other
    where other.user_id = ${stagedTransactions.userId}
      and other.status = 'staged'
      and other.deleted_at is null
      and other.duplicate_key = ${stagedTransactions.duplicateKey}
      and other.id <> ${stagedTransactions.id}
  )
)`;
/**
 * Whether a committed transaction looks like the same money as this staged row.
 *
 * Deliberately looser than `findDuplicate`, which is the guard a commit runs and
 * demands the same day and the same payee. Neither survives a real import: the
 * bank posts when it settles rather than when the card was swiped, and it names
 * the merchant its own way. What does survive is the amount, so that is the
 * anchor, with the account and the direction to keep two unrelated spends of the
 * same size apart and a few days of latitude on the date. Payee and category are
 * ignored on purpose, being the two fields most likely to differ.
 *
 * Advisory only. It badges the queue and opens the review; the strict guard is
 * what still decides whether a commit is refused, because loosening that would
 * start turning down two genuine coffees bought on one card in one week.
 */
const draftAmount = (field: string) => sql`(
  case
    when ${stagedTransactions.draft} ->> ${field} ~ ${DRAFT_DECIMAL}
      then (${stagedTransactions.draft} ->> ${field})::numeric
  end
)`;

const likelyCommittedMatch = sql`(
  select candidate.id
  from ledger_transaction candidate
  where candidate.user_id = ${stagedTransactions.userId}
    and candidate.deleted_at is null
    and candidate.type::text = ${stagedTransactions.draft} ->> 'type'
    and abs(
      candidate.date - (${stagedTransactions.draft} ->> 'date')::date
    ) <= ${LIKELY_DUPLICATE_DAYS}
    and (
      (
        candidate.type = 'deposit'
        and candidate.destination_account_id::text
          = ${stagedTransactions.draft} ->> 'toAccountId'
        and candidate.destination_amount = ${draftAmount("amount")}
      )
      or (
        candidate.type = 'withdrawal'
        and candidate.source_account_id::text
          = ${stagedTransactions.draft} ->> 'fromAccountId'
        and candidate.source_amount = ${draftAmount("amount")}
      )
      or (
        candidate.type = 'transfer'
        and candidate.source_account_id::text
          = ${stagedTransactions.draft} ->> 'fromAccountId'
        and candidate.destination_account_id::text
          = ${stagedTransactions.draft} ->> 'toAccountId'
        and candidate.source_amount = ${draftAmount("sourceAmount")}
      )
    )
  order by
    abs(candidate.date - (${stagedTransactions.draft} ->> 'date')::date),
    candidate.date desc,
    candidate.id
  limit 1
)`;

/**
 * The date cast would raise on a row whose draft holds whatever a CSV put in
 * that column, and those are exactly the rows somebody is in the queue to fix.
 * A `case` is the one construct that promises not to evaluate the branch it
 * does not take.
 *
 * The shape of a date is not enough to make it castable: `2026-02-30` and
 * `2026-13-01` both match the pattern and PostgreSQL refuses both, which took
 * the whole queue down with SQLSTATE 22008 for as long as one such row existed
 * — the queue being the only place that row could be seen and fixed. So the
 * guard asks what validation already decided instead of trying to out-guess the
 * calendar: a row reaches the cast only if nothing filed an issue against its
 * date, and only if its type named one of the union branches. The second term
 * is not redundant. An unrecognised type fails the discriminator, so Zod never
 * reaches the date at all and files nothing against it; such a row would carry
 * a bad date and no date issue.
 */
const guardedByDate = (expression: SQL) => sql`(
  case
    when ${stagedTransactions.draft} ->> 'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
      and ${stagedTransactions.draft} ->> 'type'
        in ('deposit', 'withdrawal', 'transfer')
      and not exists (
        select 1
        from jsonb_array_elements(${stagedTransactions.validationIssues}) as issue
        where issue ->> 'field' = 'date'
      )
      then ${expression}
  end
)`;

const likelyDuplicateOfId = guardedByDate(likelyCommittedMatch);
const repeatsCommittedRow = sql`${guardedByDate(sql`exists ${likelyCommittedMatch}`)} is true`;

const possiblyDuplicate = sql`(
  ${stagedTransactions.duplicateOfId} is not null
  or ${repeatsAnotherStagedRow}
  or ${repeatsCommittedRow}
)`;

export type StageFilterQuery = Pick<
  z.infer<typeof stageListQuerySchema>,
  | "importBatchId"
  | "recurrenceId"
  | "search"
  | "accountId"
  | "type"
  | "categoryId"
  | "templateId"
  | "payee"
  | "start"
  | "end"
  | "validity"
>;

/**
 * The rows a staged view is showing, as SQL.
 *
 * Lifted out of listStages so a bulk selection resolves exactly what the list
 * resolved. A second copy of these predicates is a second definition of "the
 * rows you are looking at", and the day they drift is the day a mass edit
 * touches something that was never on screen.
 */
export function stageFilterConditions(
  actor: Actor,
  query: StageFilterQuery,
) {
  const conditions: SQL[] = [
    eq(stagedTransactions.userId, actor.userId),
    eq(stagedTransactions.status, "staged"),
  ];
  if (query.recurrenceId) {
    conditions.push(eq(stagedTransactions.recurrenceId, query.recurrenceId));
  }
  if (query.importBatchId) {
    conditions.push(eq(stagedTransactions.importBatchId, query.importBatchId));
  }
  if (query.search) {
    conditions.push(
      sql`${stagedTransactions.draft}::text ilike ${likePattern(query.search)}`,
    );
  }
  if (query.accountId) {
    conditions.push(
      sql`${stagedTransactions.draft}::text like ${likePattern(query.accountId)}`,
    );
  }
  if (query.type) {
    conditions.push(sql`${stagedTransactions.draft}->>'type' = ${query.type}`);
  }
  if (query.categoryId) {
    // Legs as well as the entry's own category, because everything else that
    // counts a category counts them: the archive guard, the delete guard and
    // the category page's own badge. Reading only the top-level key made a
    // staged split show in the count and then be missing from the list the
    // count links to.
    conditions.push(
      sql`(
        ${stagedTransactions.draft}->>'categoryId' = ${query.categoryId}
        or exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(${stagedTransactions.draft} -> 'legs') = 'array'
                then ${stagedTransactions.draft} -> 'legs'
              else '[]'::jsonb
            end
          ) as leg
          where leg ->> 'categoryId' = ${query.categoryId}
        )
      )`,
    );
  }
  if (query.templateId) {
    conditions.push(
      sql`${stagedTransactions.draft}->>'templateId' = ${query.templateId}`,
    );
  }
  if (query.payee) {
    // Match the same way payees are compared elsewhere: trimmed, whitespace
    // collapsed, case-insensitive.
    conditions.push(
      sql`lower(regexp_replace(btrim(${stagedTransactions.draft}->>'payee'), '\\s+', ' ', 'g')) = ${normalizeHumanName(query.payee)}`,
    );
  }
  if (query.start) {
    conditions.push(sql`${stagedTransactions.draft}->>'date' >= ${query.start}`);
  }
  if (query.end) {
    conditions.push(sql`${stagedTransactions.draft}->>'date' <= ${query.end}`);
  }

  if (query.validity === "valid") {
    conditions.push(
      sql`jsonb_array_length(${stagedTransactions.validationIssues}) = 0`,
      sql`not ${possiblyDuplicate}`,
    );
  } else if (query.validity === "invalid") {
    conditions.push(
      sql`jsonb_array_length(${stagedTransactions.validationIssues}) > 0`,
    );
  } else if (query.validity === "duplicate") {
    conditions.push(possiblyDuplicate);
  }
  return conditions;
}

export async function listStages(
  actor: Actor,
  input: unknown,
): Promise<PaginatedPage<StageView>> {
  const query = stageListQuerySchema.parse(input);
  // Keep the cursor window out of `conditions` until the filters are complete,
  // so the total can be counted against the filters alone.
  const conditions = stageFilterConditions(actor, query);
  const filters = [...conditions];
  const plan = stageSortPlan(query.sort, query.direction);
  if (query.cursor) {
    if (!plan.keyset) {
      throw validationError(
        "This sort order pages by number rather than by cursor.",
        { sort: query.sort },
      );
    }
    const cursor = decodeCursor(query.cursor, {
      key: query.sort,
      direction: query.direction,
    });
    conditions.push(plan.keyset(cursor.sort, cursor.id));
  }

  const db = getDb();
  const [totals] = await db
    .select({ value: count() })
    .from(stagedTransactions)
    .where(and(...filters));
  const totalCount = totals?.value ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / query.limit));
  const page = query.cursor ? 1 : Math.min(query.page, totalPages);
  const offset = query.cursor ? 0 : (page - 1) * query.limit;
  const rows = await db
    .select({
      ...getTableColumns(stagedTransactions),
      // Whether this row repeats another that is still waiting. It depends on
      // the rest of the queue, not on the row, so it is answered here rather
      // than stored.
      repeatsStagedRow: sql<boolean>`${repeatsAnotherStagedRow}`,
      // Which committed transaction it looks like, so the review can open the
      // pair without asking again.
      likelyDuplicateOfId: sql<string | null>`${likelyDuplicateOfId}`,
    })
    .from(stagedTransactions)
    .where(and(...conditions))
    .orderBy(...plan.orderBy)
    .limit(query.limit + 1)
    .offset(offset);
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(stageView),
    nextCursor:
      hasMore && last && plan.cursorValue
        ? encodeCursor({
            key: query.sort,
            direction: query.direction,
            sort: plan.cursorValue(last),
            id: last.id,
          })
        : null,
    page,
    pageSize: query.limit,
    totalCount,
    totalPages,
  };
}

export async function getStage(actor: Actor, id: string) {
  const [row] = await getDb()
    .select()
    .from(stagedTransactions)
    .where(
      and(eq(stagedTransactions.id, id), eq(stagedTransactions.userId, actor.userId)),
    )
    .limit(1);
  if (!row) throw notFound("Staged transaction not found");
  return stageView(row);
}

/**
 * A staged row and the one thing it looks like a repeat of, ordered for review.
 *
 * The older of the two sits second, and a committed transaction is always second
 * whatever its date: it is the one already in the books, and the staged row is
 * the one still up for a decision. That is also why only a staged side may be
 * deleted from the review — the way out of a duplicate is to drop the copy that
 * has not been recorded yet.
 *
 * A counterpart is looked for in the order the queue itself trusts: what the
 * commit guard already matched, then what merely looks alike, then another row
 * still waiting under the same fingerprint. `null` where nothing matches any
 * more, which is what an already-resolved pair looks like.
 */
export async function getStagedDuplicateReview(actor: Actor, id: string) {
  const db = getDb();
  const [row] = await db
    .select({
      ...getTableColumns(stagedTransactions),
      likelyDuplicateOfId: sql<string | null>`${likelyDuplicateOfId}`,
    })
    .from(stagedTransactions)
    .where(
      and(eq(stagedTransactions.id, id), eq(stagedTransactions.userId, actor.userId)),
    )
    .limit(1);
  // Still in the queue, not merely still on file. A row that has been dropped
  // or committed opens a review whose forms every save would refuse, and the
  // pair it was half of is already resolved.
  if (!row || row.status !== "staged") {
    throw notFound("Staged transaction not found");
  }

  const subject = stageView(row);
  const committedId = row.duplicateOfId ?? row.likelyDuplicateOfId ?? null;
  const committed = committedId
    ? await getTransaction(actor, committedId).catch(() => null)
    : null;

  if (committed) {
    return {
      first: { kind: "staged" as const, staged: subject, committed: null },
      second: { kind: "committed" as const, staged: null, committed },
    };
  }

  const [sibling] = row.duplicateKey
    ? await db
        .select()
        .from(stagedTransactions)
        .where(
          and(
            eq(stagedTransactions.userId, actor.userId),
            eq(stagedTransactions.status, "staged"),
            eq(stagedTransactions.duplicateKey, row.duplicateKey),
            ne(stagedTransactions.id, row.id),
          ),
        )
        .orderBy(stagedTransactions.createdAt, stagedTransactions.id)
        .limit(1)
    : [];

  if (!sibling) {
    return {
      first: { kind: "staged" as const, staged: subject, committed: null },
      second: null,
    };
  }

  const other = stageView(sibling);
  const subjectIsOlder =
    row.createdAt.getTime() === sibling.createdAt.getTime()
      ? row.id < sibling.id
      : row.createdAt.getTime() < sibling.createdAt.getTime();
  return subjectIsOlder
    ? {
        first: { kind: "staged" as const, staged: other, committed: null },
        second: { kind: "staged" as const, staged: subject, committed: null },
      }
    : {
        first: { kind: "staged" as const, staged: subject, committed: null },
        second: { kind: "staged" as const, staged: other, committed: null },
      };
}

export async function updateStage(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
  options: { mayEditLedgerRecords?: boolean } = {},
) {
  const { draft, expectedVersion } = stageUpdateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockStagedDraftReferences(tx, actor, [draft]);
    const canonicalDraft = await canonicalizeStagedDraftPayee(
      tx,
      actor,
      draft,
    );
    const [before] = await tx
      .select()
      .from(stagedTransactions)
      .where(
        and(eq(stagedTransactions.id, id), eq(stagedTransactions.userId, actor.userId)),
      )
      .limit(1);
    if (!before || before.status !== "staged") throw notFound("Staged transaction not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    const validation = await validateDraft(tx, actor, canonicalDraft);
    const [updated] = await tx
      .update(stagedTransactions)
      .set({
        draft: canonicalDraft,
        validationIssues: validation.issues,
        duplicateOfId: validation.duplicateOfId,
        duplicateKey: validation.duplicateKey,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(stagedTransactions.id, id),
          eq(stagedTransactions.userId, actor.userId),
          eq(stagedTransactions.version, expectedVersion),
          eq(stagedTransactions.status, "staged"),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    const view = stageView(updated);
    await writeAudit(tx, actor, {
      entityType: "staged_transaction",
      entityId: id,
      operation: "update",
      before: stageView(before),
      after: view,
    });
    // Only for a caller who could delete the category outright. A queue token
    // proposes and never decides, and removing one of the ledger's own records
    // is a decision however small it looks.
    if (options.mayEditLedgerRecords !== false) {
      await pruneOrphanedCategories(
        tx,
        actor,
        draftCategoriesReleasedBy(before.draft, canonicalDraft),
      );
    }
    return view;
  });
}

/**
 * Which categories a staged edit stopped pointing at.
 *
 * A draft is whatever a CSV or an agent put there, so every field is read
 * defensively: a category is only considered released if it was a uuid before
 * and is not one of the uuids the draft carries now.
 */
function draftCategoriesReleasedBy(before: unknown, after: unknown) {
  const held = (draft: unknown) => {
    const ids = new Set<string>();
    if (!draft || typeof draft !== "object") return ids;
    const record = draft as Record<string, unknown>;
    const add = (value: unknown) => {
      if (referenceUuidSchema.safeParse(value).success) ids.add(value as string);
    };
    add(record.categoryId);
    if (Array.isArray(record.legs)) {
      for (const leg of record.legs) {
        if (leg && typeof leg === "object") {
          add((leg as Record<string, unknown>).categoryId);
        }
      }
    }
    return ids;
  };
  const kept = held(after);
  return [...held(before)].filter((id) => !kept.has(id));
}

export async function deleteStages(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = bulkDeleteStageSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    const rows = await tx
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, actor.userId),
          inArray(stagedTransactions.id, parsed.stagedIds),
          eq(stagedTransactions.status, "staged"),
        ),
      )
      .orderBy(stagedTransactions.id)
      .for("update");
    if (rows.length !== parsed.stagedIds.length) {
      throw notFound("One or more staged transactions are unavailable");
    }
    for (const row of rows) {
      if (parsed.expectedVersions[row.id] !== row.version) {
        throw staleVersion({ id: row.id, currentVersion: row.version });
      }
    }
    // A chunk at a time, the way the staged mass edit above does it and for the
    // same reason: ten thousand rows is the documented ceiling, and a statement
    // and an audit insert each would be twenty thousand sequential round trips
    // holding every one of those row locks.
    const CHUNK = 500;
    const now = new Date();
    for (let start = 0; start < rows.length; start += CHUNK) {
      const batch = rows.slice(start, start + CHUNK);
      const written = await tx
        .update(stagedTransactions)
        .set({
          status: "deleted",
          deletedAt: now,
          version: sql`${stagedTransactions.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(stagedTransactions.userId, actor.userId),
            inArray(
              stagedTransactions.id,
              batch.map((row) => row.id),
            ),
            eq(stagedTransactions.status, "staged"),
          ),
        );
      if (written.rowCount !== batch.length) {
        throw staleVersion({
          expectedCount: batch.length,
          currentCount: written.rowCount,
        });
      }
    }
    await writeAuditMany(
      tx,
      actor,
      rows.map((row) => ({
        entityType: "staged_transaction",
        entityId: row.id,
        operation: "delete",
        before: stageView(row),
      })),
    );
    return { deletedIds: rows.map((row) => row.id) };
  });
}

export async function commitStages(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = commitStageSchema.parse(input);
  const idempotencyPayload = {
    stagedIds: parsed.stagedIds,
    expectedVersions: parsed.expectedVersions,
    allowDuplicates: parsed.allowDuplicates,
    dryRun: parsed.dryRun,
  };
  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "stage.commit",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<{
        committed: { stagedId: string; transactionId: string }[];
      }>(
        tx,
        actor,
        "stage.commit",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return existing;
    }
    const rows = await tx
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, actor.userId),
          inArray(stagedTransactions.id, parsed.stagedIds),
          eq(stagedTransactions.status, "staged"),
        ),
      );
    if (rows.length !== parsed.stagedIds.length) {
      throw notFound("One or more staged transactions are unavailable");
    }
    await lockStagedDraftReferences(
      tx,
      actor,
      rows.map((row) => row.draft),
    );

    const validated: {
      row: StagedTransactionRow;
      draft: TransactionDraft;
      canonicalStagedDraft: unknown;
    }[] = [];
    for (const row of rows) {
      if (parsed.expectedVersions[row.id] !== row.version) {
        throw staleVersion({ id: row.id, currentVersion: row.version });
      }
      const canonicalStagedDraft = await canonicalizeStagedDraftPayee(
        tx,
        actor,
        row.draft,
      );
      // Validity only. Whether this row duplicates a committed one is asked
      // below, once the duplicate-key locks are held and the answer can be
      // acted on.
      const result = await validateDraft(tx, actor, canonicalStagedDraft, {
        withDuplicate: false,
      });
      if (!result.draft || result.issues.length) {
        throw validationError("All selected staged transactions must be valid", {
          id: row.id,
          issues: result.issues,
        });
      }
      validated.push({ row, draft: result.draft, canonicalStagedDraft });
    }

    await lockTransactionDuplicateKeys(
      tx,
      actor,
      validated.map(({ draft }) => draft),
    );
    const selectedByDuplicateKey = new Map<string, string>();
    for (const { row, draft } of validated) {
      const duplicateOfId = await findDuplicate(tx, actor, draft);
      if (duplicateOfId && !parsed.allowDuplicates) {
        throw duplicate("A selected staged transaction matches a committed transaction", {
          id: row.id,
          duplicateOfId,
        });
      }
      const duplicateOfStagedId = transactionDuplicateKeys(draft)
        .map((key) => selectedByDuplicateKey.get(key))
        .find((id): id is string => Boolean(id));
      if (duplicateOfStagedId && !parsed.allowDuplicates) {
        throw duplicate("Two selected staged transactions appear to be duplicates", {
          id: row.id,
          duplicateOfStagedId,
        });
      }
      for (const key of transactionDuplicateKeys(draft)) {
        if (!selectedByDuplicateKey.has(key)) {
          selectedByDuplicateKey.set(key, row.id);
        }
      }
    }

    const preview = {
      valid: true,
      count: validated.length,
      items: validated.map(({ row, draft }) => ({ stagedId: row.id, draft })),
    };
    if (parsed.dryRun) return preview;

    const committed: { stagedId: string; transactionId: string }[] = [];
    for (const { row, draft, canonicalStagedDraft } of validated) {
      const transaction = await createTransactionWithinTx(
        tx,
        actor,
        draft,
        "create_from_stage",
        parsed.allowDuplicates,
      );
      const [updated] = await tx
        .update(stagedTransactions)
        .set({
          draft: canonicalStagedDraft,
          status: "committed",
          committedTransactionId: transaction.id,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stagedTransactions.id, row.id),
            eq(stagedTransactions.userId, actor.userId),
            eq(stagedTransactions.version, row.version),
            eq(stagedTransactions.status, "staged"),
          ),
        )
        .returning();
      if (!updated) throw staleVersion({ id: row.id });
      await writeAudit(tx, actor, {
        entityType: "staged_transaction",
        entityId: row.id,
        operation: "commit",
        before: stageView(row),
        after: stageView(updated),
      });
      committed.push({ stagedId: row.id, transactionId: transaction.id });
    }
    const response = { committed };
    await setIdempotent(
      tx,
      actor,
      "stage.commit",
      parsed.idempotencyKey,
      idempotencyPayload,
      response,
    );
    return response;
  });
}

function stageSelectionSummary(
  rows: readonly (typeof stagedTransactions.$inferSelect)[],
) {
  let invalidCount = 0;
  let duplicateCount = 0;
  let transferCount = 0;
  let splitCount = 0;
  for (const row of rows) {
    if ((row.validationIssues as unknown[]).length) invalidCount += 1;
    if (row.duplicateOfId) duplicateCount += 1;
    const draft = row.draft as { type?: unknown; legs?: unknown };
    if (draft.type === "transfer") transferCount += 1;
    if (Array.isArray(draft.legs) && draft.legs.length) splitCount += 1;
  }
  return { invalidCount, duplicateCount, transferCount, splitCount };
}

async function selectStageFilterRows(
  runner: DbTransaction | Database,
  actor: Actor,
  request: { filter: StageFilterQuery; excludedIds: string[] },
  lockRows = false,
) {
  const conditions = stageFilterConditions(actor, request.filter);
  if (request.excludedIds.length) {
    conditions.push(notInArray(stagedTransactions.id, request.excludedIds));
  }
  const query = runner
    .select()
    .from(stagedTransactions)
    .where(and(...conditions))
    .orderBy(stagedTransactions.id)
    // One past the cap, so an oversized queue is refused by PostgreSQL rather
    // than after every row has been read, and — on the write path — rather
    // than after every row has been locked `for update`.
    .limit(MAX_BULK_SELECTION_ENTRIES + 1);
  const rows = await (lockRows ? query.for("update") : query);
  if (rows.length > MAX_BULK_SELECTION_ENTRIES) {
    throw validationError(exceedsBulkSelectionCap("staged rows"), {
      field: "filter",
      limit: MAX_BULK_SELECTION_ENTRIES,
    });
  }
  return rows;
}

/**
 * The count and fingerprint the browser sends back with a filter selection, so
 * the server can tell whether it is about to change the set it was shown.
 */
export async function previewBulkStageSelection(actor: Actor, input: unknown) {
  const parsed = bulkStageFilterSelectionRequestSchema.parse(input);
  const rows = await selectStageFilterRows(getDb(), actor, parsed);
  return bulkStageSelectionSnapshotSchema.parse({
    count: rows.length,
    fingerprint: selectionFingerprint(rows),
    ...stageSelectionSummary(rows),
  });
}

/** Apply one patch to one draft, leaving anything it does not mention alone. */
function patchedStageDraft(draft: Record<string, unknown>, patch: BulkStagePatch) {
  // The same refusal committed rows get, for the same reason: a split already
  // says which categories the money went to, and the direction of the entry is
  // what every leg's category was checked against. Setting either in bulk would
  // have to flatten the split to mean anything, which nothing here asked for.
  const isSplit = Array.isArray(draft.legs) && draft.legs.length > 0;
  if (isSplit && (patch.categoryId !== undefined || patch.type !== undefined)) {
    throw validationError(
      "Bulk category and type changes cannot include split transactions",
      { fields: ["categoryId", "type"] },
    );
  }

  const next: Record<string, unknown> = { ...draft };
  if (patch.date !== undefined) next.date = patch.date;
  if (patch.payee !== undefined) next.payee = patch.payee;
  if (patch.categoryId !== undefined) next.categoryId = patch.categoryId;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.notes !== undefined) next.notes = patch.notes;

  // Type and account move together, because which account field a draft carries
  // is decided by its type. A transfer has two sides and no single account to
  // move, so both are refused for one rather than guessed at.
  const currentType = patch.type ?? (next.type as string | undefined);
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.accountId !== undefined) {
    if (currentType === "deposit") {
      next.toAccountId = patch.accountId;
      delete next.fromAccountId;
    } else if (currentType === "withdrawal") {
      next.fromAccountId = patch.accountId;
      delete next.toAccountId;
    }
  } else if (patch.type !== undefined) {
    // Changed type with no new account: carry the account it already had over
    // to the side the new type reads, so the row does not silently lose it.
    if (patch.type === "deposit" && next.fromAccountId !== undefined) {
      next.toAccountId = next.fromAccountId;
      delete next.fromAccountId;
    }
    if (patch.type === "withdrawal" && next.toAccountId !== undefined) {
      next.fromAccountId = next.toAccountId;
      delete next.toAccountId;
    }
  }
  return next;
}

/**
 * Changing many staged rows at once.
 *
 * The safety model is the committed one, because a person selecting rows should
 * not have to learn two of them: a list of ids each carrying the version it was
 * read at, or "everything matching this view" carrying a count and a
 * fingerprint of the exact id:version set. Either way a row that moved
 * underneath makes the whole request stale rather than quietly taking a value
 * somebody never saw.
 *
 * What differs from the committed version is what happens after the selection
 * is settled, and it is simpler: a staged row is a draft, so nothing here posts,
 * reverses, or touches a balance. The patch is written into the draft, the payee
 * is canonicalised the way a single edit does it, and the row is validated
 * again so the queue's own verdict on it is current. A patch that turns an
 * invalid row valid is the ordinary reason to do this at all.
 */
export async function bulkEditStages(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = bulkStageEditSchema.parse(input);
  const { selection, patch } = parsed;

  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(tx, actor, "stage.bulkEdit", parsed.idempotencyKey);
      const existing = await getIdempotent<BulkStageEditResult>(
        tx,
        actor,
        "stage.bulkEdit",
        parsed.idempotencyKey,
        { selection, patch },
      );
      if (existing) return existing;
    }

    let rows: (typeof stagedTransactions.$inferSelect)[];
    if (selection.mode === "ids") {
      rows = await tx
        .select()
        .from(stagedTransactions)
        .where(
          and(
            eq(stagedTransactions.userId, actor.userId),
            inArray(
              stagedTransactions.id,
              selection.items.map((item) => item.id),
            ),
            eq(stagedTransactions.status, "staged"),
          ),
        )
        .orderBy(stagedTransactions.id)
        .for("update");
      if (rows.length !== selection.items.length) {
        throw notFound("One or more staged transactions are unavailable");
      }
      const expected = new Map(
        selection.items.map((item) => [item.id, item.expectedVersion]),
      );
      for (const row of rows) {
        if (expected.get(row.id) !== row.version) {
          throw staleVersion({ id: row.id, currentVersion: row.version });
        }
      }
    } else {
      rows = await selectStageFilterRows(tx, actor, selection, true);
      const fingerprint = selectionFingerprint(rows);
      if (
        rows.length !== selection.expectedCount ||
        fingerprint !== selection.expectedFingerprint
      ) {
        throw staleVersion({
          expectedCount: selection.expectedCount,
          currentCount: rows.length,
          expectedFingerprint: selection.expectedFingerprint,
          currentFingerprint: fingerprint,
        });
      }
    }

    if (rows.length > MAX_BULK_SELECTION_ENTRIES) {
      throw validationError(exceedsBulkSelectionCap("staged rows"), {
        limit: MAX_BULK_SELECTION_ENTRIES,
      });
    }

    // Which account field a draft carries is decided by its type, so a row whose
    // type gives no answer is refused rather than silently skipped: quietly
    // leaving one out would report a number of rows changed that does not match
    // what was selected.
    const draftType = (row: (typeof rows)[number]) =>
      (row.draft as { type?: unknown }).type;
    if (patch.accountId !== undefined || patch.type !== undefined) {
      // A transfer has two accounts and no single one to move, and no answer for
      // which of them survives becoming a one-sided type.
      const transfers = rows.filter((row) => draftType(row) === "transfer");
      if (transfers.length) {
        throw validationError(
          "Account and type cannot be changed on a transfer. Deselect the transfers in this selection, or change only the fields they share.",
          { transferIds: transfers.map((row) => row.id) },
        );
      }
    }
    if (patch.accountId !== undefined && patch.type === undefined) {
      // A row the parser could not read may carry no type at all, and there is
      // no side to write an account to until it has one.
      const untyped = rows.filter(
        (row) => draftType(row) !== "deposit" && draftType(row) !== "withdrawal",
      );
      if (untyped.length) {
        throw validationError(
          "Some of these rows do not say whether money came in or went out, so an account cannot be set on them. Set the type in the same edit.",
          { untypedIds: untyped.map((row) => row.id) },
        );
      }
    }

    const drafts = rows.map((row) =>
      patchedStageDraft(row.draft as Record<string, unknown>, patch),
    );
    await lockStagedDraftReferences(tx, actor, drafts);

    const planned: {
      row: (typeof stagedTransactions.$inferSelect);
      draft: unknown;
      issues: ValidationIssue[];
      duplicateOfId: string | null;
      duplicateKey: string | null;
    }[] = [];
    for (const [index, row] of rows.entries()) {
      const canonical = await canonicalizeStagedDraftPayee(tx, actor, drafts[index]);
      const validation = await validateDraft(tx, actor, canonical);
      planned.push({
        row,
        draft: canonical,
        issues: validation.issues,
        duplicateOfId: validation.duplicateOfId,
        duplicateKey: validation.duplicateKey,
      });
    }

    const items = planned.map((entry) => ({
      id: entry.row.id,
      version: entry.row.version + (parsed.dryRun ? 0 : 1),
      issueCount: entry.issues.length,
      possiblyDuplicate: entry.duplicateOfId !== null,
    }));
    const result: BulkStageEditResult = {
      dryRun: parsed.dryRun,
      updatedCount: planned.length,
      validCount: planned.filter((entry) => entry.issues.length === 0).length,
      invalidCount: planned.filter((entry) => entry.issues.length > 0).length,
      items,
    };
    if (parsed.dryRun) return result;

    // Written a chunk at a time rather than a row at a time. Ten thousand rows
    // is the documented ceiling, and a statement each would be twenty thousand
    // sequential round trips holding a row lock and a pool connection.
    // Bounded so one full-size selection cannot build a statement PostgreSQL
    // refuses for having too many bind parameters.
    const CHUNK = 500;
    const now = new Date();
    for (let start = 0; start < planned.length; start += CHUNK) {
      const batch = planned.slice(start, start + CHUNK);
      const patches = sql.join(
        batch.map(
          (entry) =>
            sql`(${entry.row.id}::uuid, ${JSON.stringify(entry.draft)}::jsonb, ${JSON.stringify(entry.issues)}::jsonb, ${entry.duplicateOfId}::uuid, ${entry.duplicateKey}::text, ${entry.row.version}::integer)`,
        ),
        sql`, `,
      );
      const written = await tx
        .update(stagedTransactions)
        .set({
          draft: sql`patched.draft`,
          validationIssues: sql`patched.validation_issues`,
          duplicateOfId: sql`patched.duplicate_of_id`,
          duplicateKey: sql`patched.duplicate_key`,
          version: sql`${stagedTransactions.version} + 1`,
          updatedAt: now,
        })
        .from(
          sql`(values ${patches}) as patched (id, draft, validation_issues, duplicate_of_id, duplicate_key, expected_version)`,
        )
        .where(
          and(
            eq(stagedTransactions.id, sql`patched.id`),
            eq(stagedTransactions.userId, actor.userId),
            eq(stagedTransactions.version, sql`patched.expected_version`),
            eq(stagedTransactions.status, "staged"),
          ),
        );
      // Every row was locked `for update` when the selection was resolved, so a
      // short write means one of them stopped matching between the read and the
      // write. Refusing the whole transaction is the only safe answer.
      if (written.rowCount !== batch.length) {
        throw staleVersion({
          expectedCount: batch.length,
          currentCount: written.rowCount,
        });
      }
    }

    // Read back rather than assumed, so an audit record says what actually
    // landed. One query per chunk against rows this transaction holds locked.
    const before = new Map(planned.map((entry) => [entry.row.id, entry.row]));
    const audits: Parameters<typeof writeAuditMany>[2][number][] = [];
    for (let start = 0; start < planned.length; start += CHUNK) {
      const ids = planned.slice(start, start + CHUNK).map((entry) => entry.row.id);
      const rows = await tx
        .select()
        .from(stagedTransactions)
        .where(
          and(
            eq(stagedTransactions.userId, actor.userId),
            inArray(stagedTransactions.id, ids),
          ),
        );
      for (const row of rows) {
        audits.push({
          entityType: "staged_transaction",
          entityId: row.id,
          operation: "bulk_edit",
          before: stageView(before.get(row.id)!),
          after: stageView(row),
        });
      }
    }
    await writeAuditMany(tx, actor, audits);
    await setIdempotent(
      tx,
      actor,
      "stage.bulkEdit",
      parsed.idempotencyKey,
      { selection, patch },
      result,
    );
    return result;
  });
}
