import { and, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
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
  recurrences,
  stagedTransactions,
  transactionLegs,
  transactionTemplates,
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
  writeAuditMany,
} from "./helpers.js";
import { cleanHumanName, normalizeHumanName } from "../../shared/names.js";

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
        or(
          sql`${stagedTransactions.draft} ->> 'categoryId' = ${categoryId}`,
          sql`exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(${stagedTransactions.draft} -> 'legs') = 'array'
                  then ${stagedTransactions.draft} -> 'legs'
                else '[]'::jsonb
              end
            ) as leg
            where leg ->> 'categoryId' = ${categoryId}
          )`,
        )!,
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
  // A leg names this category as squarely as the column does, and every leg
  // answers to the direction of the entry it belongs to, so narrowing a
  // category's kind has to see both. Otherwise the narrowing is allowed and the
  // next edit of that transaction is refused for something nobody did.
  const [{ count: transactionCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        eq(transactions.type, incompatibleType),
        or(
          eq(transactions.categoryId, categoryId),
          sql`exists (
            select 1 from transaction_leg l
            where l.user_id = ${transactions.userId}
              and l.transaction_id = ${transactions.id}
              and l.category_id = ${categoryId}
          )`,
        )!,
      ),
    );
  const [{ count: stagedCount }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        or(
          sql`${stagedTransactions.draft} ->> 'categoryId' = ${categoryId}`,
          sql`exists (
            select 1
            from jsonb_array_elements(
              case
                when jsonb_typeof(${stagedTransactions.draft} -> 'legs') = 'array'
                  then ${stagedTransactions.draft} -> 'legs'
                else '[]'::jsonb
              end
            ) as leg
            where leg ->> 'categoryId' = ${categoryId}
          )`,
        )!,
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
  //
  // A union over both places a committed row can name a category: its own
  // column, or one of its legs. `union` rather than `union all`, and then
  // `count(distinct)`, so a receipt split twice into the same category is one
  // transaction against that category rather than two. Without both, the badge
  // over a category would disagree with the list of transactions underneath it.
  const committedUse = db
    .select({
      categoryId: sql<string>`category_id`.as("category_id"),
      total: sql<number>`count(distinct transaction_id)::int`.as("committed_count"),
    })
    .from(
      sql`(
        select t.category_id, t.id as transaction_id
        from ledger_transaction t
        where t.user_id = ${actor.userId}
          and t.deleted_at is null
          and t.category_id is not null
        union
        select l.category_id, l.transaction_id
        from transaction_leg l
        join ledger_transaction t
          on t.user_id = l.user_id and t.id = l.transaction_id
        where l.user_id = ${actor.userId}
          and t.deleted_at is null
          and l.category_id is not null
          and l.amount <> 0
      ) as committed_category_use`,
    )
    .groupBy(sql`category_id`)
    .as("committed_use");
  //
  // Both places a queued draft can name a category, unioned and counted
  // distinct for the same reason the committed side is: a split names one per
  // leg, and the number over a category has to agree with the guard that
  // refuses to archive or delete it.
  //
  // The user filter is load-bearing in a way its twin on the committed side is
  // not. A transaction's category is held to the same owner by a foreign key; a
  // draft names its category as free JSON text that nothing constrains, so
  // somebody else's staged row can carry this person's category id and only
  // that line keeps it out of their count. The jsonb_typeof guards are there
  // because a staged draft is unvalidated and these slots can hold anything at
  // all, including a scalar that would make jsonb_array_elements raise.
  const stagedUse = db
    .select({
      categoryId: sql<string>`staged_category_id`.as("staged_category_id"),
      total: sql<number>`count(distinct staged_id)::int`.as("staged_count"),
    })
    .from(
      sql`(
        select s.draft ->> 'categoryId' as staged_category_id, s.id as staged_id
        from staged_transaction s
        where s.user_id = ${actor.userId}
          and s.status = 'staged'
          and jsonb_typeof(s.draft -> 'categoryId') = 'string'
        union
        select leg ->> 'categoryId' as staged_category_id, s.id as staged_id
        from staged_transaction s
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(s.draft -> 'legs') = 'array' then s.draft -> 'legs'
            else '[]'::jsonb
          end
        ) as leg
        where s.user_id = ${actor.userId}
          and s.status = 'staged'
          and jsonb_typeof(leg -> 'categoryId') = 'string'
      ) as staged_category_use`,
    )
    .groupBy(sql`staged_category_id`)
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
    // Legs count whatever they are worth, including the zeroed ones. A retired
    // leg keeps the category it was filed under, so the foreign key still holds
    // it: without this the guard would pass and the delete below would fail
    // with a database error instead of the sentence offering to archive.
    const [{ count: transactionCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          or(
            eq(transactions.categoryId, id),
            sql`exists (
              select 1 from transaction_leg l
              where l.user_id = ${transactions.userId}
                and l.transaction_id = ${transactions.id}
                and l.category_id = ${id}
            )`,
          )!,
        ),
      );
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
          or(
            sql`${stagedTransactions.draft} ->> 'categoryId' = ${id}`,
            sql`exists (
              select 1
              from jsonb_array_elements(
                case
                  when jsonb_typeof(${stagedTransactions.draft} -> 'legs') = 'array'
                    then ${stagedTransactions.draft} -> 'legs'
                  else '[]'::jsonb
                end
              ) as leg
              where leg ->> 'categoryId' = ${id}
            )`,
          )!,
        ),
      );
    // A standing instruction is a use like any other, and the one nothing else
    // would catch: it holds no row today and writes one on every occurrence
    // from here on. Deleting underneath it turns every future proposal into a
    // flagged row naming a category that no longer exists.
    const [{ count: recurrenceCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(recurrences)
      .where(
        and(
          eq(recurrences.userId, actor.userId),
          or(
            sql`${recurrences.shape} ->> 'categoryId' = ${id}`,
            sql`exists (
              select 1
              from jsonb_array_elements(
                case
                  when jsonb_typeof(${recurrences.shape} -> 'legs') = 'array'
                    then ${recurrences.shape} -> 'legs'
                  else '[]'::jsonb
                end
              ) as leg
              where leg ->> 'categoryId' = ${id}
            )`,
          )!,
        ),
      );
    // A template's draft names a category in jsonb with no foreign key, so
    // nothing above sees it and nothing stops the delete. What is left is a
    // template that cannot be saved and cannot be used, and no sentence
    // anywhere saying which category went missing.
    const [{ count: templateCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.userId, actor.userId),
          or(
            sql`${transactionTemplates.draft} ->> 'categoryId' = ${id}`,
            sql`exists (
              select 1
              from jsonb_array_elements(
                case
                  when jsonb_typeof(${transactionTemplates.draft} -> 'legs') = 'array'
                    then ${transactionTemplates.draft} -> 'legs'
                  else '[]'::jsonb
                end
              ) as leg
              where leg ->> 'categoryId' = ${id}
            )`,
          )!,
        ),
      );
    if (transactionCount || stagedCount || recurrenceCount || templateCount) {
      throw conflict("This category is in use. Archive it instead of deleting it.", {
        transactionCount,
        stagedTransactionCount: stagedCount,
        recurrenceCount,
        templateCount,
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
    // A split files its money by leg, so the rows answering to a merged
    // category are found through the legs as well as through the column. A leg
    // still pointing at a source when the delete below runs breaks its foreign
    // key, taking the whole merge with it.
    const sourceIdList = sql.join(
      sourceCategoryIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const legTransactionRowsBefore = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          sql`exists (
            select 1 from transaction_leg l
            where l.user_id = ${transactions.userId}
              and l.transaction_id = ${transactions.id}
              and l.category_id in (${sourceIdList})
          )`,
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
          or(
            inArray(
              sql<string>`${stagedTransactions.draft} ->> 'categoryId'`,
              sourceCategoryIds,
            ),
            sql`exists (
              select 1
              from jsonb_array_elements(
                case
                  when jsonb_typeof(${stagedTransactions.draft} -> 'legs') = 'array'
                    then ${stagedTransactions.draft} -> 'legs'
                  else '[]'::jsonb
                end
              ) as leg
              where leg ->> 'categoryId' in (${sourceIdList})
            )`,
          )!,
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
    let updatedLegTransactions: typeof legTransactionRowsBefore = [];
    if (legTransactionRowsBefore.length) {
      await tx
        .update(transactionLegs)
        .set({ categoryId: target.id, updatedAt: new Date() })
        .where(
          and(
            eq(transactionLegs.userId, actor.userId),
            inArray(transactionLegs.categoryId, sourceCategoryIds),
          ),
        );
      // The version has to move with the label. A mass edit describes the set
      // it is about to change by id and version, so a leg relabelled underneath
      // one would leave that description agreeing about a row that changed.
      updatedLegTransactions = await tx
        .update(transactions)
        .set({
          version: sql`${transactions.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactions.userId, actor.userId),
            inArray(
              transactions.id,
              legTransactionRowsBefore.map((row) => row.id),
            ),
          ),
        )
        .returning();
    }
    const updatedStages = stagedRowsBefore.length
      ? await tx
          .update(stagedTransactions)
          .set({
            // The column is rewritten only when it actually names a source.
            // Keying that off key-presence instead would rewrite a split, whose
            // categoryId the form posts as an explicit null: jsonb_set's
            // create_missing only skips a key that is ABSENT, not one that is
            // null, and a draft carrying both a category and legs can never be
            // committed.
            draft: sql`
              case
                when ${stagedTransactions.draft} ->> 'categoryId' in (${sourceIdList})
                  then jsonb_set(
                    ${stagedTransactions.draft},
                    '{categoryId}',
                    to_jsonb(${target.id}::text),
                    true
                  )
                when jsonb_typeof(${stagedTransactions.draft} -> 'legs') = 'array'
                  then jsonb_set(
                    ${stagedTransactions.draft},
                    '{legs}',
                    (
                      select coalesce(jsonb_agg(
                        case
                          when leg ->> 'categoryId' in (${sourceIdList})
                            then jsonb_set(leg, '{categoryId}', to_jsonb(${target.id}::text), true)
                          else leg
                        end
                        order by position
                      ), '[]'::jsonb)
                      from jsonb_array_elements(${stagedTransactions.draft} -> 'legs')
                        with ordinality as elements(leg, position)
                    ),
                    true
                  )
                else ${stagedTransactions.draft}
              end`,
            version: sql`${stagedTransactions.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stagedTransactions.userId, actor.userId),
              inArray(
                stagedTransactions.id,
                stagedRowsBefore.map((row) => row.id),
              ),
            ),
          )
          .returning()
      : [];

    // A standing instruction is a reference too, and the only one that keeps
    // producing rows after the merge. Left naming a hard-deleted id it would
    // propose a flagged row on every occurrence from here on. The version is
    // deliberately not bumped: a merge relabels what a recurrence points at
    // without changing what somebody configured, and bumping it would make
    // every open form stale for a reason nobody can see.
    await tx
      .update(recurrences)
      .set({
        shape: sql`
          case
            when ${recurrences.shape} ->> 'categoryId' in (${sourceIdList})
              then jsonb_set(
                ${recurrences.shape},
                '{categoryId}',
                to_jsonb(${target.id}::text),
                true
              )
            when jsonb_typeof(${recurrences.shape} -> 'legs') = 'array'
              then jsonb_set(
                ${recurrences.shape},
                '{legs}',
                (
                  select coalesce(jsonb_agg(
                    case
                      when leg ->> 'categoryId' in (${sourceIdList})
                        then jsonb_set(leg, '{categoryId}', to_jsonb(${target.id}::text), true)
                      else leg
                    end
                    order by position
                  ), '[]'::jsonb)
                  from jsonb_array_elements(${recurrences.shape} -> 'legs')
                    with ordinality as elements(leg, position)
                ),
                true
              )
            else ${recurrences.shape}
          end`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recurrences.userId, actor.userId),
          or(
            sql`${recurrences.shape} ->> 'categoryId' in (${sourceIdList})`,
            sql`exists (
              select 1
              from jsonb_array_elements(
                case
                  when jsonb_typeof(${recurrences.shape} -> 'legs') = 'array'
                    then ${recurrences.shape} -> 'legs'
                  else '[]'::jsonb
                end
              ) as leg
              where leg ->> 'categoryId' in (${sourceIdList})
            )`,
          )!,
        ),
      );

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

    // Transactions, not references. A row whose column named one source and
    // whose legs named another is one transaction updated, which is what the
    // screen reporting this number says it means.
    const updatedTransactionCount = new Set(
      [...updatedTransactions, ...updatedLegTransactions].map((row) => row.id),
    ).size;

    const transactionBeforeById = new Map(
      [...transactionRowsBefore, ...legTransactionRowsBefore].map((row) => [
        row.id,
        row,
      ]),
    );
    const stagedBeforeById = new Map(
      stagedRowsBefore.map((row) => [row.id, row]),
    );
    // The merge itself is set-based: every update above is one statement. The
    // audit trail it leaves has one row per affected transaction, and writing
    // those one insert at a time made a merge of a well-used category cost
    // tens of thousands of sequential round trips more than the merge did.
    await writeAuditMany(tx, actor, [
      ...[...updatedTransactions, ...updatedLegTransactions].map((updated) => ({
        entityType: "transaction",
        entityId: updated.id,
        operation: "category_merge",
        before: serializeRow(transactionBeforeById.get(updated.id)),
        after: serializeRow(updated),
      })),
      ...updatedStages.map((updated) => ({
        entityType: "staged_transaction",
        entityId: updated.id,
        operation: "category_merge",
        before: serializeRow(stagedBeforeById.get(updated.id)),
        after: serializeRow(updated),
      })),
      ...sources.map((source) => ({
        entityType: "category",
        entityId: source.id,
        operation: "merge_into",
        before: serializeRow(source),
        after: {
          mergedIntoCategoryId: updatedTarget.id,
          mergedIntoCategoryName: updatedTarget.name,
        },
      })),
    ]);
    await writeAudit(tx, actor, {
      entityType: "category",
      entityId: updatedTarget.id,
      operation: "merge",
      before: serializeRow(target),
      after: {
        ...serializeRow(updatedTarget),
        mergedSourceCategoryIds: sourceCategoryIds,
        updatedTransactionCount,
        updatedStagedTransactionCount: updatedStages.length,
      },
    });

    return {
      targetCategory: serializeRow(updatedTarget),
      mergedSourceCategoryIds: sourceCategoryIds,
      updatedTransactionCount,
      updatedStagedTransactionCount: updatedStages.length,
    };
  });
}
