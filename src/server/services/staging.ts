import {
  and,
  count,
  eq,
  inArray,
  sql,
  type SQL, getTableColumns } from "drizzle-orm";
import { z, ZodError } from "zod";
import type {
  Actor,
  PaginatedPage,
  TransactionDraft,
  ValidationIssue,
  SortDirection,
  StageSortField,
} from "../../shared/domain.js";
import {
  bulkDeleteStageSchema,
  commitStageSchema,
  stageCreateSchema,
  stageListQuerySchema,
  stageUpdateSchema,
  transactionDraftSchema,
} from "../../shared/domain.js";
import {
  getDb,
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
  getIdempotent,
  lockAccountReferences,
  lockCategoryNamespace,
  lockIdempotencyKey,
  lockPayeeNamespace,
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
import { normalizeHumanName } from "./names.js";
import { canonicalizeStagedDraftPayee } from "./payees.js";
import {
  createTransactionWithinTx,
  findDuplicate,
  lockTransactionDuplicateKeys,
  prepareTransaction,
  transactionDuplicateKeys,
} from "./transactions.js";

export type StageView = ReturnType<typeof stageView>;
const referenceUuidSchema = z.string().uuid();

function stageView(
  row: StagedTransactionRow & { repeatsStagedRow?: boolean },
) {
  // The fingerprint itself is an internal detail; what a caller needs is
  // whether the row repeats something, and which something.
  const { duplicateKey: _duplicateKey, repeatsStagedRow, ...rest } = row;
  return {
    ...serializeRow(rest as StagedTransactionRow),
    validationIssues: row.validationIssues as ValidationIssue[],
    draft: row.draft as Partial<TransactionDraft>,
    // Only the list query works this out, because it is a comparison against
    // the rest of the queue. Where it was not computed the answer is unknown
    // rather than no, and saying `false` there contradicted what the same row
    // reports in a list.
    repeatsStagedRow:
      repeatsStagedRow === undefined || repeatsStagedRow === null
        ? null
        : Boolean(repeatsStagedRow),
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
  if (drafts.some((draft) => referenceValue(draft, "categoryId"))) {
    await lockCategoryNamespace(tx, actor);
  }
  await lockPayeeNamespace(tx, actor);
}

async function validateDraft(
  tx: DbTransaction,
  actor: Actor,
  input: unknown,
): Promise<{
  draft: TransactionDraft | null;
  issues: ValidationIssue[];
  duplicateOfId: string | null;
  duplicateKey: string | null;
}> {
  const parsed = transactionDraftSchema.safeParse(input);
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
    await prepareTransaction(tx, actor, parsed.data);
    const duplicateOfId = await findDuplicate(tx, actor, parsed.data);
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

type ImportedStageInput = {
  draft: unknown;
  rawData: unknown;
  importBatchId: string;
  initialIssues?: ValidationIssue[];
};

/** Everything a staged row needs decided, with nothing written yet. */
async function prepareImportedStage(
  tx: DbTransaction,
  actor: Actor,
  input: ImportedStageInput,
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
    validationIssues: [
      ...(input.initialIssues ?? []),
      ...draftValidation.issues,
    ],
    duplicateOfId: draftValidation.duplicateOfId,
    duplicateKey: draftValidation.duplicateKey,
  };
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
  inputs: readonly ImportedStageInput[],
) {
  if (!inputs.length) return [];
  const values = [];
  for (const input of inputs) {
    values.push(await prepareImportedStage(tx, actor, input));
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
      return paged(sql`case
        when jsonb_array_length(${stagedTransactions.validationIssues}) > 0 then 0
        when ${stagedTransactions.duplicateOfId} is not null then 1
        else 2
      end`);
    case "amount":
      return paged(sql`case
        when ${draft} ->> 'amount' ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (${draft} ->> 'amount')::numeric
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

export async function listStages(
  actor: Actor,
  input: unknown,
): Promise<PaginatedPage<StageView>> {
  const query = stageListQuerySchema.parse(input);
  // Keep the cursor window out of `conditions` until the filters are complete,
  // so the total can be counted against the filters alone.
  const conditions: SQL[] = [
    eq(stagedTransactions.userId, actor.userId),
    eq(stagedTransactions.status, "staged"),
  ];
  if (query.importBatchId) {
    conditions.push(eq(stagedTransactions.importBatchId, query.importBatchId));
  }
  if (query.search) {
    conditions.push(
      sql`${stagedTransactions.draft}::text ilike ${`%${query.search}%`}`,
    );
  }
  if (query.accountId) {
    conditions.push(
      sql`${stagedTransactions.draft}::text like ${`%${query.accountId}%`}`,
    );
  }
  if (query.type) {
    conditions.push(sql`${stagedTransactions.draft}->>'type' = ${query.type}`);
  }
  if (query.categoryId) {
    conditions.push(
      sql`${stagedTransactions.draft}->>'categoryId' = ${query.categoryId}`,
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
  // A row is a possible duplicate when it matches something already committed,
  // or when another row still waiting in the queue carries the same fingerprint.
  // Only the first was recorded before, so two imported copies of one statement
  // were refused at commit while this filter found nothing to show for it.
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
  const possiblyDuplicate = sql`(
    ${stagedTransactions.duplicateOfId} is not null or ${repeatsAnotherStagedRow}
  )`;

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

export async function updateStage(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
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
    return view;
  });
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
    const now = new Date();
    for (const row of rows) {
      const [updated] = await tx
        .update(stagedTransactions)
        .set({ status: "deleted", deletedAt: now, version: row.version + 1, updatedAt: now })
        .where(
          and(
            eq(stagedTransactions.id, row.id),
            eq(stagedTransactions.userId, actor.userId),
            eq(stagedTransactions.version, row.version),
            eq(stagedTransactions.status, "staged"),
          ),
        )
        .returning({ id: stagedTransactions.id });
      if (!updated) throw staleVersion({ id: row.id });
      await writeAudit(tx, actor, {
        entityType: "staged_transaction",
        entityId: row.id,
        operation: "delete",
        before: stageView(row),
      });
    }
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
      const result = await validateDraft(tx, actor, canonicalStagedDraft);
      if (!result.draft || result.issues.length) {
        throw validationError("All selected staged transactions must be valid", {
          id: row.id,
          issues: result.issues,
        });
      }
      if (result.duplicateOfId && !parsed.allowDuplicates) {
        throw duplicate("A selected staged transaction matches a committed transaction", {
          id: row.id,
          duplicateOfId: result.duplicateOfId,
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
