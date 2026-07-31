import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import {
  categoryCreateSchema,
  categoryMergeSchema,
  categoryUpdateSchema,
} from "../../shared/domain.js";
import {
  getDb,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  categories,
  stagedTransactions,
  transactions,
  type CategoryRow,
} from "../db/schema.js";
import {
  conflict,
  duplicate,
  notFound,
  staleVersion,
  validationError,
} from "./errors.js";
import {
  lockCategoryNamespace,
  serializeRow,
  writeAudit,
} from "./helpers.js";
import { normalizeHumanName } from "./names.js";

async function findNormalizedNameConflict(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  excludeId?: string,
) {
  const rows = await tx
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.userId, actor.userId));
  const normalizedName = normalizeHumanName(name);
  return rows.find(
    (row) =>
      row.id !== excludeId &&
      normalizeHumanName(row.name) === normalizedName,
  );
}

async function assertNormalizedNameAvailable(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  excludeId?: string,
) {
  const existing = await findNormalizedNameConflict(
    tx,
    actor,
    name,
    excludeId,
  );
  if (existing) {
    throw duplicate("A category with this name already exists", {
      duplicateCategoryId: existing.id,
      normalizedName: normalizeHumanName(name),
    });
  }
}

async function activeStagedCategoryReferenceCount(
  tx: DbTransaction,
  actor: Actor,
  categoryId: string,
) {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        sql`${stagedTransactions.draft} ->> 'categoryId' = ${categoryId}`,
      ),
    );
  return count;
}

async function assertCategoryKindCompatible(
  tx: DbTransaction,
  actor: Actor,
  categoryId: string,
  kind: CategoryRow["kind"],
) {
  if (kind === "both") return;

  const incompatibleType = kind === "income" ? "withdrawal" : "deposit";
  const [{ count: transactionCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        eq(transactions.categoryId, categoryId),
        eq(transactions.type, incompatibleType),
      ),
    );
  const [{ count: stagedCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        sql`${stagedTransactions.draft} ->> 'categoryId' = ${categoryId}`,
        sql`${stagedTransactions.draft} ->> 'type' = ${incompatibleType}`,
      ),
    );

  if (transactionCount || stagedCount) {
    throw conflict(
      "This category's applicability conflicts with transactions that use it. Use Both or recategorize them first.",
      {
        incompatibleType,
        transactionCount,
        stagedTransactionCount: stagedCount,
      },
    );
  }
}

export async function listCategories(actor: Actor, includeArchived = false) {
  return getDb()
    .select()
    .from(categories)
    .where(
      and(
        eq(categories.userId, actor.userId),
        includeArchived ? sql`true` : sql`${categories.archivedAt} is null`,
      ),
    )
    .orderBy(categories.kind, categories.name);
}

export async function getCategory(actor: Actor, id: string) {
  const [category] = await getDb()
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, actor.userId)))
    .limit(1);
  if (!category) throw notFound("Category not found");
  return category;
}

export async function listDuplicateCategories(actor: Actor) {
  const rows = await getDb()
    .select()
    .from(categories)
    .where(eq(categories.userId, actor.userId))
    .orderBy(categories.name, categories.id);
  const grouped = new Map<string, CategoryRow[]>();

  for (const row of rows) {
    const normalizedName = normalizeHumanName(row.name);
    const group = grouped.get(normalizedName);
    if (group) {
      group.push(row);
    } else {
      grouped.set(normalizedName, [row]);
    }
  }

  return [...grouped.entries()]
    .filter(([, group]) => group.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([normalizedName, group]) => ({
      normalizedName,
      count: group.length,
      categories: group
        .sort((left, right) => {
          if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) {
            return left.archivedAt ? 1 : -1;
          }
          return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
        })
        .map((category) => serializeRow(category)),
    }));
}

export async function createCategory(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = categoryCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    await assertNormalizedNameAvailable(tx, actor, parsed.name);
    const [created] = await tx
      .insert(categories)
      .values({ userId: actor.userId, ...parsed })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: created.id,
      operation: "create",
      after: serializeRow(created),
    });
    return serializeRow(created);
  });
}

export async function updateCategory(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = categoryUpdateSchema.parse(input);
  const { expectedVersion, ...changes } = parsed;
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Category not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    if (changes.name !== undefined) {
      await assertNormalizedNameAvailable(tx, actor, changes.name, id);
    }
    if (changes.kind !== undefined && changes.kind !== before.kind) {
      await assertCategoryKindCompatible(tx, actor, id, changes.kind);
    }
    const [updated] = await tx
      .update(categories)
      .set({ ...changes, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(categories.id, id),
          eq(categories.userId, actor.userId),
          eq(categories.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: id,
      operation: "update",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return serializeRow(updated);
  });
}

export async function setCategoryArchived(
  actor: Actor,
  id: string,
  expectedVersion: number,
  archived: boolean,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Category not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    if (
      archived &&
      (await activeStagedCategoryReferenceCount(tx, actor, id)) > 0
    ) {
      throw conflict(
        "Resolve staged transactions that reference this category before archiving it.",
      );
    }
    const [updated] = await tx
      .update(categories)
      .set({
        archivedAt: archived ? new Date() : null,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(categories.id, id),
          eq(categories.userId, actor.userId),
          eq(categories.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: id,
      operation: archived ? "archive" : "unarchive",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return serializeRow(updated);
  });
}

export async function deleteCategory(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Category not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    const [{ count: transactionCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(and(eq(transactions.userId, actor.userId), eq(transactions.categoryId, id)));
    const [{ count: stagedCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, actor.userId),
          sql`${stagedTransactions.draft} ->> 'categoryId' = ${id}`,
        ),
      );
    if (transactionCount || stagedCount) {
      throw conflict("This category is in use. Archive it instead of deleting it.", {
        transactionCount,
        stagedTransactionCount: stagedCount,
      });
    }
    const deleted = await tx
      .delete(categories)
      .where(
        and(
          eq(categories.id, id),
          eq(categories.userId, actor.userId),
          eq(categories.version, expectedVersion),
        ),
      )
      .returning({ id: categories.id });
    if (!deleted.length) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: id,
      operation: "delete",
      before: serializeRow(before),
    });
    return { id, deleted: true };
  });
}

function mergedCategoryKind(rows: CategoryRow[]) {
  const kinds = new Set(rows.map((row) => row.kind));
  return kinds.size === 1 ? rows[0]!.kind : "both";
}

export async function mergeCategories(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = categoryMergeSchema.parse(input);
  const sourceCategoryIds = [...new Set(parsed.sourceCategoryIds)];

  if (sourceCategoryIds.length !== parsed.sourceCategoryIds.length) {
    throw validationError("Source category IDs must be unique");
  }
  if (sourceCategoryIds.includes(parsed.targetCategoryId)) {
    throw validationError("The target category cannot also be a source category");
  }
  for (const sourceId of sourceCategoryIds) {
    if (parsed.expectedVersions[sourceId] === undefined) {
      throw validationError(
        "An expected version is required for every source category",
        { categoryId: sourceId },
      );
    }
  }

  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);

    const requestedIds = [parsed.targetCategoryId, ...sourceCategoryIds];
    const requestedCategories = await tx
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.userId, actor.userId),
          inArray(categories.id, requestedIds),
        ),
      )
      .for("update");

    if (requestedCategories.length !== requestedIds.length) {
      throw notFound("One or more categories were not found");
    }

    const categoryById = new Map(
      requestedCategories.map((category) => [category.id, category]),
    );
    const target = categoryById.get(parsed.targetCategoryId)!;
    if (target.version !== parsed.targetExpectedVersion) {
      throw staleVersion({
        categoryId: target.id,
        currentVersion: target.version,
      });
    }

    const sources = sourceCategoryIds.map((sourceId) => {
      const source = categoryById.get(sourceId)!;
      const expectedVersion = parsed.expectedVersions[sourceId];
      if (source.version !== expectedVersion) {
        throw staleVersion({
          categoryId: source.id,
          currentVersion: source.version,
        });
      }
      return source;
    });

    const transactionRowsBefore = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          inArray(transactions.categoryId, sourceCategoryIds),
        ),
      )
      .orderBy(transactions.id)
      .for("update");
    const stagedRowsBefore = await tx
      .select()
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, actor.userId),
          inArray(
            sql<string>`${stagedTransactions.draft} ->> 'categoryId'`,
            sourceCategoryIds,
          ),
        ),
      )
      .orderBy(stagedTransactions.id)
      .for("update");

    const [updatedTarget] = await tx
      .update(categories)
      .set({
        kind: mergedCategoryKind([target, ...sources]),
        version: parsed.targetExpectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(categories.id, target.id),
          eq(categories.userId, actor.userId),
          eq(categories.version, parsed.targetExpectedVersion),
        ),
      )
      .returning();
    if (!updatedTarget) throw staleVersion();

    const updatedTransactions = transactionRowsBefore.length
      ? await tx
          .update(transactions)
          .set({
            categoryId: target.id,
            version: sql`${transactions.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(transactions.userId, actor.userId),
              inArray(transactions.categoryId, sourceCategoryIds),
            ),
          )
          .returning()
      : [];
    const updatedStages = stagedRowsBefore.length
      ? await tx
          .update(stagedTransactions)
          .set({
            draft: sql`jsonb_set(
              ${stagedTransactions.draft},
              '{categoryId}',
              to_jsonb(${target.id}::text),
              true
            )`,
            version: sql`${stagedTransactions.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stagedTransactions.userId, actor.userId),
              inArray(
                sql<string>`${stagedTransactions.draft} ->> 'categoryId'`,
                sourceCategoryIds,
              ),
            ),
          )
          .returning()
      : [];

    const deletedSources = await tx
      .delete(categories)
      .where(
        and(
          eq(categories.userId, actor.userId),
          inArray(categories.id, sourceCategoryIds),
        ),
      )
      .returning({ id: categories.id });
    if (deletedSources.length !== sourceCategoryIds.length) {
      throw staleVersion();
    }

    const transactionBeforeById = new Map(
      transactionRowsBefore.map((row) => [row.id, row]),
    );
    for (const updated of updatedTransactions) {
      await writeAudit(tx, actor, {
        entityType: "transaction",
        entityId: updated.id,
        operation: "category_merge",
        before: serializeRow(transactionBeforeById.get(updated.id)),
        after: serializeRow(updated),
      });
    }

    const stagedBeforeById = new Map(
      stagedRowsBefore.map((row) => [row.id, row]),
    );
    for (const updated of updatedStages) {
      await writeAudit(tx, actor, {
        entityType: "staged_transaction",
        entityId: updated.id,
        operation: "category_merge",
        before: serializeRow(stagedBeforeById.get(updated.id)),
        after: serializeRow(updated),
      });
    }

    for (const source of sources) {
      await writeAudit(tx, actor, {
        entityType: "category",
        entityId: source.id,
        operation: "merge_into",
        before: serializeRow(source),
        after: {
          mergedIntoCategoryId: updatedTarget.id,
          mergedIntoCategoryName: updatedTarget.name,
        },
      });
    }
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: updatedTarget.id,
      operation: "merge",
      before: serializeRow(target),
      after: {
        ...serializeRow(updatedTarget),
        mergedSourceCategoryIds: sourceCategoryIds,
        updatedTransactionCount: updatedTransactions.length,
        updatedStagedTransactionCount: updatedStages.length,
      },
    });

    return {
      targetCategory: serializeRow(updatedTarget),
      mergedSourceCategoryIds: sourceCategoryIds,
      updatedTransactionCount: updatedTransactions.length,
      updatedStagedTransactionCount: updatedStages.length,
    };
  });
}
