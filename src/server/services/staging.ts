import {
  and,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z, ZodError } from "zod";
import type {
  Actor,
  Page,
  TransactionDraft,
  ValidationIssue,
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
import { duplicate, notFound, staleVersion, validationError, zodIssues } from "./errors.js";
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
} from "./helpers.js";
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

function stageView(row: StagedTransactionRow) {
  return {
    ...serializeRow(row),
    validationIssues: row.validationIssues as ValidationIssue[],
    draft: row.draft as Partial<TransactionDraft>,
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
}> {
  const parsed = transactionDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { draft: null, issues: zodIssues(parsed.error), duplicateOfId: null };
  }
  try {
    await prepareTransaction(tx, actor, parsed.data);
    const duplicateOfId = await findDuplicate(tx, actor, parsed.data);
    return { draft: parsed.data, issues: [], duplicateOfId };
  } catch (error) {
    if (error instanceof ZodError) {
      return { draft: parsed.data, issues: zodIssues(error), duplicateOfId: null };
    }
    if (error instanceof Error) {
      return {
        draft: parsed.data,
        issues: [{ field: "draft", message: error.message }],
        duplicateOfId: null,
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

export async function insertImportedStage(
  tx: DbTransaction,
  actor: Actor,
  input: {
    draft: unknown;
    rawData: unknown;
    importBatchId: string;
    initialIssues?: ValidationIssue[];
  },
) {
  await lockStagedDraftReferences(tx, actor, [input.draft]);
  const canonicalDraft = await canonicalizeStagedDraftPayee(
    tx,
    actor,
    input.draft,
  );
  const draftValidation = await validateDraft(tx, actor, canonicalDraft);
  const validation = {
    issues: [...(input.initialIssues ?? []), ...draftValidation.issues],
    duplicateOfId: draftValidation.duplicateOfId,
  };
  const [created] = await tx
    .insert(stagedTransactions)
    .values({
      userId: actor.userId,
      draft: canonicalDraft ?? {},
      rawData: input.rawData,
      importBatchId: input.importBatchId,
      validationIssues: validation.issues,
      duplicateOfId: validation.duplicateOfId,
    })
    .returning();
  await writeAudit(tx, actor, {
    entityType: "staged_transaction",
    entityId: created.id,
    operation: "create_from_csv",
    after: stageView(created),
  });
  return created;
}

export async function listStages(
  actor: Actor,
  input: unknown,
): Promise<Page<StageView>> {
  const query = stageListQuerySchema.parse(input);
  const conditions: SQL[] = [
    eq(stagedTransactions.userId, actor.userId),
    eq(stagedTransactions.status, "staged"),
  ];
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    const sort = new Date(cursor.sort);
    conditions.push(
      or(
        lt(stagedTransactions.createdAt, sort),
        and(
          eq(stagedTransactions.createdAt, sort),
          lt(stagedTransactions.id, cursor.id),
        ),
      )!,
    );
  }
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
  if (query.start) {
    conditions.push(sql`${stagedTransactions.draft}->>'date' >= ${query.start}`);
  }
  if (query.end) {
    conditions.push(sql`${stagedTransactions.draft}->>'date' <= ${query.end}`);
  }
  if (query.validity === "valid") {
    conditions.push(
      sql`jsonb_array_length(${stagedTransactions.validationIssues}) = 0`,
      sql`${stagedTransactions.duplicateOfId} is null`,
    );
  } else if (query.validity === "invalid") {
    conditions.push(
      sql`jsonb_array_length(${stagedTransactions.validationIssues}) > 0`,
    );
  } else if (query.validity === "duplicate") {
    conditions.push(sql`${stagedTransactions.duplicateOfId} is not null`);
  }

  const rows = await getDb()
    .select()
    .from(stagedTransactions)
    .where(and(...conditions))
    .orderBy(desc(stagedTransactions.createdAt), desc(stagedTransactions.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  return {
    items: pageRows.map(stageView),
    nextCursor: hasMore
      ? encodeCursor({
          sort: pageRows.at(-1)!.createdAt.toISOString(),
          id: pageRows.at(-1)!.id,
        })
      : null,
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
