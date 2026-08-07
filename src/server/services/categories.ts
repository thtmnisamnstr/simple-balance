import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type {
  Actor,
  CategoryKind,
  TransactionDraft,
} from "../../shared/domain.js";
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
import { cleanHumanName, normalizeHumanName } from "./names.js";

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

/** The kind an entry of this type needs a category to cover. */
export function categoryKindForDraft(draft: TransactionDraft): CategoryKind {
  if (draft.type === "deposit") return "income";
  if (draft.type === "withdrawal") return "expense";
  return "both";
}

/** One category asked to cover both sides has to be usable on both. */
export function combineCategoryKinds(
  left: CategoryKind,
  right: CategoryKind,
): CategoryKind {
  return left === right ? left : "both";
}

/** Live categories first, then a stable order, so a match never depends on row order. */
export function preferredCategory(left: CategoryRow, right: CategoryRow) {
  if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) {
    return left.archivedAt ? 1 : -1;
  }
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/**
 * Turn a category the caller named into one this ledger owns.
 *
 * Matching ignores case and surrounding space, so "groceries" typed against an
 * existing "Groceries" files the entry under the category already there. It is
 * the same rule a CSV import follows, and it is the reason a ledger does not
 * accumulate three spellings of the same thing.
 *
 * Two things follow from matching a category that does not currently fit:
 *
 * A category filed under expenses that is now wanted for a deposit is widened
 * to cover both rather than duplicated, because the alternative is refusing a
 * name the user can plainly see in their own list, or creating a second
 * category the uniqueness rule would reject anyway.
 *
 * An archived one is brought back. The user just named it, which is a clearer
 * statement that they want it than the archiving was that they did not.
 *
 * This writes, so it belongs only on paths that are already committing. Callers
 * that merely validate must not use it.
 */
export async function resolveCategoryByName(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  kind: CategoryKind,
): Promise<CategoryRow> {
  const parsed = categoryCreateSchema.parse({ name: cleanHumanName(name), kind });
  await lockCategoryNamespace(tx, actor);
  const owned = await tx
    .select()
    .from(categories)
    .where(eq(categories.userId, actor.userId));
  const normalizedName = normalizeHumanName(parsed.name);
  const [existing] = owned
    .filter((row) => normalizeHumanName(row.name) === normalizedName)
    .sort(preferredCategory);

  if (!existing) {
    const [created] = await tx
      .insert(categories)
      .values({ userId: actor.userId, ...parsed })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: created.id,
      operation: "create_from_transaction",
      after: serializeRow(created),
    });
    return created;
  }

  const resolvedKind = combineCategoryKinds(existing.kind, parsed.kind);
  if (existing.archivedAt === null && resolvedKind === existing.kind) {
    return existing;
  }
  const [updated] = await tx
    .update(categories)
    .set({
      kind: resolvedKind,
      archivedAt: null,
      version: existing.version + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(categories.id, existing.id),
        eq(categories.userId, actor.userId),
        eq(categories.version, existing.version),
      ),
    )
    .returning();
  if (!updated) throw staleVersion();
  await writeAudit(tx, actor, {
    entityType: "category",
    entityId: existing.id,
    operation: "update_from_transaction",
    before: serializeRow(existing),
    after: serializeRow(updated),
  });
  return updated;
}

/**
 * Settle a draft's categories before anything is written, the entry's own and
 * every leg's.
 *
 * An id the caller supplied wins outright; a name is only consulted when there
 * is no id. The name is dropped on the way out so everything downstream sees a
 * draft with exactly one way of saying which category this is.
 *
 * Legs resolve one at a time rather than in a batch, so that two legs naming
 * the same new category end up on one category rather than two: the second
 * lookup sees what the first created. Every leg of an entry takes the entry's
 * kind, since they are all shares of the same movement.
 */
export async function resolveDraftCategory<T extends TransactionDraft>(
  tx: DbTransaction,
  actor: Actor,
  draft: T,
): Promise<T> {
  const { categoryName, ...rest } = draft;
  const kind = categoryKindForDraft(draft);
  const resolved = { ...rest } as T;

  if (draft.legs?.some((leg) => leg.categoryName && !leg.categoryId)) {
    const legs = [];
    for (const { categoryName: legName, ...leg } of draft.legs) {
      if (!legName || leg.categoryId) {
        legs.push(leg);
        continue;
      }
      const category = await resolveCategoryByName(tx, actor, legName, kind);
      legs.push({ ...leg, categoryId: category.id });
    }
    resolved.legs = legs;
  }

  if (!categoryName || draft.categoryId) return resolved;
  const category = await resolveCategoryByName(tx, actor, categoryName, kind);
  return { ...resolved, categoryId: category.id };
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

/**
 * The same list, plus how much each category is actually used.
 *
 * Kept apart from `listCategories` because most callers of that are pickers -
 * the category select on every transaction form, the mass edit modals, the
 * staging queue - and they would be paying for two aggregates to render a
 * dropdown. The browser holds this list under three separate cache keys and
 * every category, import, or staging write invalidates all of them, so the
 * waste would land on nearly every page.
 *
 * Counts are ledger-wide. Neither this page nor the payee list carries a date
 * range, so a range-scoped number would be one the reader could not explain or
 * change. A category detail page does have a range bar, and shows it, so a
 * badge reading 43 landing on a list of 7 is a difference the reader can see
 * the reason for.
 */
export async function listCategorySummaries(
  actor: Actor,
  includeArchived = false,
) {
  const db = getDb();
  // Aggregated before the join rather than counted across it: `count(*)` over a
  // left join reports 1 for a category nothing references, and the product of
  // the two sides when both match.
  const committedUse = db
    .select({
      categoryId: transactions.categoryId,
      total: sql<number>`count(*)::int`.as("committed_count"),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        sql`${transactions.deletedAt} is null`,
        sql`${transactions.categoryId} is not null`,
      ),
    )
    .groupBy(transactions.categoryId)
    .as("committed_use");
  const stagedUse = db
    .select({
      // Named apart from the committed side's column: the join below has to
      // spell this one out in SQL, and two derived tables offering the same
      // bare name is ambiguous.
      categoryId: sql<string>`${stagedTransactions.draft} ->> 'categoryId'`.as(
        "staged_category_id",
      ),
      total: sql<number>`count(*)::int`.as("staged_count"),
    })
    .from(stagedTransactions)
    .where(
      and(
        // Load-bearing in a way its twin on the committed side is not. A
        // transaction's category is held to the same owner by a foreign key; a
        // draft names its category as free JSON text that nothing constrains,
        // so somebody else's staged row can carry this person's category id and
        // only this line keeps it out of their count.
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        // A staged draft is unvalidated, so this slot can hold anything at all.
        // Nothing but a string could match an id anyway; this keeps the rest out
        // of the grouping rather than leaning on that.
        sql`jsonb_typeof(${stagedTransactions.draft} -> 'categoryId') = 'string'`,
      ),
    )
    .groupBy(sql`${stagedTransactions.draft} ->> 'categoryId'`)
    .as("staged_use");

  const rows = await db
    .select({
      ...getTableColumns(categories),
      transactionCount: sql<number>`coalesce(${committedUse.total}, 0)::int`,
      stagedTransactionCount: sql<number>`coalesce(${stagedUse.total}, 0)::int`,
    })
    .from(categories)
    // Left joined so a category nothing references still appears, reported as
    // zero. That is the row somebody came here to find.
    .leftJoin(committedUse, eq(committedUse.categoryId, categories.id))
    // The id is cast to text rather than the draft to uuid. Casting the other
    // way raises on the first draft holding something that is not a uuid, and
    // staging accepts those on purpose, so one bad import would take the whole
    // page down with no way back from the UI.
    .leftJoin(stagedUse, sql`${stagedUse.categoryId} = ${categories.id}::text`)
    .where(
      and(
        eq(categories.userId, actor.userId),
        includeArchived ? sql`true` : sql`${categories.archivedAt} is null`,
      ),
    )
    .orderBy(categories.kind, categories.name);

  return rows.map((row) => {
    const transactionCount = referenceCount(row.transactionCount);
    const stagedTransactionCount = referenceCount(row.stagedTransactionCount);
    return {
      ...row,
      transactionCount,
      stagedTransactionCount,
      totalCount: transactionCount + stagedTransactionCount,
    };
  });
}

/**
 * `count(*)` is a bigint, and node-postgres hands those back as strings, so a
 * missing cast would make the total the two counts concatenated rather than
 * added. The casts above are what prevent that; this is the check that says so
 * out loud if one is ever dropped.
 */
function referenceCount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Database returned an invalid category reference count");
  }
  return parsed;
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
    // Only rows still in the queue. A row that has been committed keeps its
    // draft, and the transaction it became is already counted above, so
    // counting both left a category that nothing uses permanently undeletable
    // with nothing on screen to explain why.
    const [{ count: stagedCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(stagedTransactions)
      .where(
        and(
          eq(stagedTransactions.userId, actor.userId),
          eq(stagedTransactions.status, "staged"),
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
