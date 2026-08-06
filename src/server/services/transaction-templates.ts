import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import {
  MAX_TRANSACTION_TEMPLATES,
  transactionTemplateBulkDeleteSchema,
  transactionTemplateBulkEditSchema,
  transactionTemplateBulkResultSchema,
  transactionTemplateCreateSchema,
  transactionTemplateDraftSchema,
  transactionTemplateUpdateSchema,
  type TransactionTemplateBulkPatch,
  type TransactionTemplateBulkResult,
  type TransactionTemplateBulkSelection,
  type TransactionTemplateDraft,
} from "../../shared/domain.js";
import {
  getDb,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  categories,
  ledgerAccounts,
  stagedTransactions,
  transactionTemplates,
  transactions,
} from "../db/schema.js";
import { conflict, duplicate, notFound, staleVersion, validationError } from "./errors.js";
import {
  getIdempotent,
  lockIdempotencyKey,
  lockTransactionTemplateNamespace,
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";
import { normalizeHumanName } from "./names.js";

/**
 * A template is a saved starting point for the transaction form. Nothing here
 * posts, reverses, or reads a balance: creating one records an intention, and
 * using one only fills in a form the person then submits themselves.
 */

async function assertNameAvailable(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  excludeId?: string,
) {
  const rows = await tx
    .select({ id: transactionTemplates.id, name: transactionTemplates.name })
    .from(transactionTemplates)
    .where(eq(transactionTemplates.userId, actor.userId));
  const normalized = normalizeHumanName(name);
  // Compared the way category names are, ignoring case and spacing. The picker
  // is a list of names, and two templates called Rent is a list nobody can use.
  const existing = rows.find(
    (row) => row.id !== excludeId && normalizeHumanName(row.name) === normalized,
  );
  if (existing) {
    throw duplicate("A template with this name already exists", {
      duplicateTemplateId: existing.id,
    });
  }
}

/**
 * The ids inside a draft carry no foreign key, so ownership is checked here
 * instead. Without it a template could hold somebody else's account and quietly
 * offer it back on the form.
 */
async function assertReferencesAreOwned(
  tx: DbTransaction,
  actor: Actor,
  draft: Pick<
    TransactionTemplateDraft,
    "fromAccountId" | "toAccountId" | "categoryId"
  >,
) {
  const accountIds = [draft.fromAccountId, draft.toAccountId].filter(
    (value): value is string => Boolean(value),
  );
  if (accountIds.length) {
    const owned = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.userId, actor.userId),
          inArray(ledgerAccounts.id, accountIds),
          sql`${ledgerAccounts.systemKind} is null`,
        ),
      );
    const found = new Set(owned.map((row) => row.id));
    const missing = accountIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw validationError("That account is not one of yours", {
        accountIds: missing,
      });
    }
  }
  if (draft.categoryId) {
    const [owned] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, draft.categoryId),
          eq(categories.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!owned) {
      throw validationError("That category is not one of yours", {
        categoryId: draft.categoryId,
      });
    }
  }
}

const templateView = (row: typeof transactionTemplates.$inferSelect) => ({
  ...serializeRow(row),
  draft: row.draft as TransactionTemplateDraft,
});

/** Which account side a type reads, so the other one is not worth storing. */
const accountSides = {
  deposit: { keep: "toAccountId", drop: "fromAccountId" },
  withdrawal: { keep: "fromAccountId", drop: "toAccountId" },
  transfer: { keep: null, drop: null },
} as const;

/**
 * The patch applied to one draft, re-parsed so what comes back is a draft
 * rather than something draft-shaped.
 *
 * A key the patch leaves out is left alone, a value sets it, and `null` removes
 * it. Changing the type drops whichever side the new type will never read,
 * because a template holding an account nothing looks at is worse than a blank
 * the person fills in on use.
 */
export function applyTemplateBulkPatch(
  draft: TransactionTemplateDraft,
  patch: TransactionTemplateBulkPatch,
): TransactionTemplateDraft {
  const next: Record<string, unknown> = { ...draft };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  if (patch.type) {
    const { drop } = accountSides[patch.type];
    if (drop) delete next[drop];
    if (patch.type !== "transfer") delete next.destinationAmount;
  }
  return transactionTemplateDraftSchema.parse(next);
}

/**
 * Setting an account side that the row's type will never read is refused rather
 * than dropped. Dropping it would report a template changed in a way it was
 * not, and the person asked for something this row cannot hold.
 */
function assertPatchFitsType(
  rows: { id: string; draft: TransactionTemplateDraft }[],
  patch: TransactionTemplateBulkPatch,
) {
  const effectiveType = (row: { draft: TransactionTemplateDraft }) =>
    patch.type === null ? undefined : (patch.type ?? row.draft.type);
  for (const side of ["fromAccountId", "toAccountId"] as const) {
    if (!patch[side]) continue;
    const stranded = rows.filter((row) => {
      const type = effectiveType(row);
      return type ? accountSides[type].drop === side : false;
    });
    if (stranded.length) {
      throw validationError(
        side === "fromAccountId"
          ? "A deposit has no source account, so it cannot be set here"
          : "A withdrawal has no destination account, so it cannot be set here",
        { templateIds: stranded.map((row) => row.id) },
      );
    }
  }
  if (patch.destinationAmount) {
    const stranded = rows.filter((row) => {
      const type = effectiveType(row);
      return type !== undefined && type !== "transfer";
    });
    if (stranded.length) {
      throw validationError(
        "Only a transfer has a received amount, so it cannot be set here",
        { templateIds: stranded.map((row) => row.id) },
      );
    }
  }
}

async function lockSelectedTemplates(
  tx: DbTransaction,
  actor: Actor,
  selection: TransactionTemplateBulkSelection,
) {
  const ids = selection.items.map((item) => item.id);
  const rows = await tx
    .select()
    .from(transactionTemplates)
    .where(
      and(
        eq(transactionTemplates.userId, actor.userId),
        inArray(transactionTemplates.id, ids),
      ),
    )
    .orderBy(transactionTemplates.id)
    .for("update");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    throw notFound("Some of those templates are unavailable", {
      templateIds: missing,
    });
  }
  const stale = selection.items.filter(
    (item) => byId.get(item.id)!.version !== item.expectedVersion,
  );
  if (stale.length) {
    throw staleVersion({
      templateIds: stale.map((item) => item.id),
      currentVersions: stale.map((item) => byId.get(item.id)!.version),
    });
  }
  return selection.items.map((item) => byId.get(item.id)!);
}

export async function bulkEditTransactionTemplates(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<TransactionTemplateBulkResult> {
  const parsed = transactionTemplateBulkEditSchema.parse(input);
  const idempotencyPayload = {
    selection: parsed.selection,
    patch: parsed.patch,
  };
  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "transaction_template.bulk_edit",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<TransactionTemplateBulkResult>(
        tx,
        actor,
        "transaction_template.bulk_edit",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return transactionTemplateBulkResultSchema.parse(existing);
    }
    await lockTransactionTemplateNamespace(tx, actor);
    const rows = await lockSelectedTemplates(tx, actor, parsed.selection);
    assertPatchFitsType(
      rows.map((row) => ({
        id: row.id,
        draft: row.draft as TransactionTemplateDraft,
      })),
      parsed.patch,
    );

    // Both sides go through the schema before they are compared. Postgres
    // orders jsonb keys by length and Zod returns them in the order the schema
    // declares, so comparing a stored draft against a parsed one reports every
    // row changed however little was asked for.
    const planned = rows.map((row) => {
      const before = transactionTemplateDraftSchema.parse(row.draft);
      return { row, before, draft: applyTemplateBulkPatch(before, parsed.patch) };
    });
    // Only what the patch introduces. A template outlives the account it names,
    // so checking the whole draft would make every old template refuse an edit
    // to its payee over an account nobody was touching.
    await assertReferencesAreOwned(tx, actor, {
      fromAccountId: parsed.patch.fromAccountId ?? undefined,
      toAccountId: parsed.patch.toAccountId ?? undefined,
      categoryId: parsed.patch.categoryId ?? undefined,
    });

    const changed = planned.filter(
      ({ before, draft }) => JSON.stringify(before) !== JSON.stringify(draft),
    );
    if (parsed.dryRun) {
      return {
        dryRun: true,
        changedCount: changed.length,
        items: changed.map(({ row }) => ({
          id: row.id,
          name: row.name,
          version: row.version,
        })),
      };
    }

    const items: TransactionTemplateBulkResult["items"] = [];
    for (const { row, draft } of changed) {
      const [updated] = await tx
        .update(transactionTemplates)
        .set({ draft, version: row.version + 1, updatedAt: new Date() })
        .where(
          and(
            eq(transactionTemplates.id, row.id),
            eq(transactionTemplates.userId, actor.userId),
            eq(transactionTemplates.version, row.version),
          ),
        )
        .returning();
      if (!updated) throw staleVersion({ templateIds: [row.id] });
      await writeAudit(tx, actor, {
        entityType: "transaction_template",
        entityId: row.id,
        operation: "bulk_edit",
        before: templateView(row),
        after: templateView(updated),
      });
      items.push({
        id: updated.id,
        name: updated.name,
        version: updated.version,
      });
    }

    const result = { dryRun: false, changedCount: items.length, items };
    await setIdempotent(
      tx,
      actor,
      "transaction_template.bulk_edit",
      parsed.idempotencyKey,
      idempotencyPayload,
      result,
    );
    return result;
  });
}

export async function bulkDeleteTransactionTemplates(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<TransactionTemplateBulkResult> {
  const parsed = transactionTemplateBulkDeleteSchema.parse(input);
  const idempotencyPayload = { selection: parsed.selection };
  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "transaction_template.bulk_delete",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<TransactionTemplateBulkResult>(
        tx,
        actor,
        "transaction_template.bulk_delete",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return transactionTemplateBulkResultSchema.parse(existing);
    }
    await lockTransactionTemplateNamespace(tx, actor);
    const rows = await lockSelectedTemplates(tx, actor, parsed.selection);
    const items = rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
    }));
    if (parsed.dryRun) {
      return { dryRun: true, changedCount: items.length, items };
    }

    await tx.delete(transactionTemplates).where(
      and(
        eq(transactionTemplates.userId, actor.userId),
        inArray(
          transactionTemplates.id,
          rows.map((row) => row.id),
        ),
      ),
    );
    for (const row of rows) {
      await writeAudit(tx, actor, {
        entityType: "transaction_template",
        entityId: row.id,
        operation: "bulk_delete",
        before: templateView(row),
      });
    }

    const result = { dryRun: false, changedCount: items.length, items };
    await setIdempotent(
      tx,
      actor,
      "transaction_template.bulk_delete",
      parsed.idempotencyKey,
      idempotencyPayload,
      result,
    );
    return result;
  });
}

export async function listTransactionTemplates(actor: Actor) {
  const db = getDb();
  // Aggregated before the join rather than counted across it: `count(*)` over a
  // left join reports 1 for a template nothing references, and the product of
  // the two sides when both match.
  const committedUse = db
    .select({
      templateId: transactions.templateId,
      total: sql<number>`count(*)::int`.as("committed_count"),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        sql`${transactions.deletedAt} is null`,
        sql`${transactions.templateId} is not null`,
      ),
    )
    .groupBy(transactions.templateId)
    .as("committed_use");
  const stagedUse = db
    .select({
      templateId: sql<string>`${stagedTransactions.draft} ->> 'templateId'`.as(
        "staged_template_id",
      ),
      total: sql<number>`count(*)::int`.as("staged_count"),
    })
    .from(stagedTransactions)
    .where(
      and(
        // A draft names its template as free JSON that nothing constrains, so
        // without this somebody else's staged row could be counted here.
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        sql`jsonb_typeof(${stagedTransactions.draft} -> 'templateId') = 'string'`,
      ),
    )
    .groupBy(sql`${stagedTransactions.draft} ->> 'templateId'`)
    .as("staged_use");

  const rows = await db
    .select({
      ...getTableColumns(transactionTemplates),
      transactionCount: sql<number>`coalesce(${committedUse.total}, 0)::int`,
      stagedTransactionCount: sql<number>`coalesce(${stagedUse.total}, 0)::int`,
    })
    .from(transactionTemplates)
    .leftJoin(committedUse, eq(committedUse.templateId, transactionTemplates.id))
    // The id is cast to text rather than the draft to uuid. Casting the other
    // way raises on the first draft holding something that is not a uuid, and
    // staging accepts those on purpose.
    .leftJoin(
      stagedUse,
      sql`${stagedUse.templateId} = ${transactionTemplates.id}::text`,
    )
    .where(eq(transactionTemplates.userId, actor.userId))
    .orderBy(transactionTemplates.name);

  return rows.map((row) => {
    const transactionCount = Number(row.transactionCount);
    const stagedTransactionCount = Number(row.stagedTransactionCount);
    return {
      ...templateView(row),
      transactionCount,
      stagedTransactionCount,
      totalTransactionCount: transactionCount + stagedTransactionCount,
    };
  });
}

export async function getTransactionTemplate(actor: Actor, id: string) {
  const [row] = await getDb()
    .select()
    .from(transactionTemplates)
    .where(
      and(
        eq(transactionTemplates.id, id),
        eq(transactionTemplates.userId, actor.userId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Template not found");
  return templateView(row);
}

export async function createTransactionTemplate(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = transactionTemplateCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockTransactionTemplateNamespace(tx, actor);
    await assertNameAvailable(tx, actor, parsed.name);
    await assertReferencesAreOwned(tx, actor, parsed.draft);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionTemplates)
      .where(eq(transactionTemplates.userId, actor.userId));
    if (count >= MAX_TRANSACTION_TEMPLATES) {
      throw conflict(
        `You can keep ${MAX_TRANSACTION_TEMPLATES} templates. Delete one you no longer use to make room.`,
        { limit: MAX_TRANSACTION_TEMPLATES, current: count },
      );
    }
    const [created] = await tx
      .insert(transactionTemplates)
      .values({ userId: actor.userId, name: parsed.name, draft: parsed.draft })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: created.id,
      operation: "create",
      after: templateView(created),
    });
    return templateView(created);
  });
}

export async function updateTransactionTemplate(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = transactionTemplateUpdateSchema.parse(input);
  const { expectedVersion, ...changes } = parsed;
  return withTransaction(transaction, async (tx) => {
    await lockTransactionTemplateNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!before) throw notFound("Template not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    if (changes.name !== undefined) {
      await assertNameAvailable(tx, actor, changes.name, id);
    }
    if (changes.draft !== undefined) {
      await assertReferencesAreOwned(tx, actor, changes.draft);
    }
    const [updated] = await tx
      .update(transactionTemplates)
      .set({
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.draft !== undefined ? { draft: changes.draft } : {}),
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
          eq(transactionTemplates.version, before.version),
        ),
      )
      .returning();
    if (!updated) throw staleVersion({ currentVersion: before.version });
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: id,
      operation: "update",
      before: templateView(before),
      after: templateView(updated),
    });
    return templateView(updated);
  });
}

export async function deleteTransactionTemplate(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    await lockTransactionTemplateNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!before) throw notFound("Template not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    // Deleted outright rather than archived. A template records nothing that
    // happened, so there is no history to keep, and the transactions made from
    // it are unaffected.
    await tx
      .delete(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.id, id),
          eq(transactionTemplates.userId, actor.userId),
          eq(transactionTemplates.version, expectedVersion),
        ),
      );
    await writeAudit(tx, actor, {
      entityType: "transaction_template",
      entityId: id,
      operation: "delete",
      before: templateView(before),
    });
    return { id, deleted: true };
  });
}
