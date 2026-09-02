import { and, asc, eq, sql } from "drizzle-orm";
import type { Actor, BudgetGroupPolicy } from "../../shared/domain.js";
import { categoryGroupCreateSchema, categoryGroupUpdateSchema } from "../../shared/domain.js";
import { normalizeHumanName } from "../../shared/names.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import {
  budgetEntries,
  budgetPlans,
  categories,
  categoryGroups,
  type CategoryGroupRow,
} from "../db/schema.js";
import { conflict, duplicate, notFound, staleVersion, validationError } from "./errors.js";
import { lockCategoryNamespace, writeAudit } from "./helpers.js";

/**
 * One level of grouping over categories, and the budget that reads it.
 *
 * A group is a way of reading categories rather than a thing money can be spent
 * on: nothing names a group on a transaction, no posting mentions one, and
 * deleting one leaves every category and every figure exactly where it was.
 * That is why the category's foreign key is `on delete set null` while the
 * budget's is `on delete cascade` — the categories survive the group, and a
 * budget about a group that no longer exists is a budget about nothing.
 *
 * The policy is the decision the roadmap said must not be made silently.
 * `standalone` is Monarch's: the group holds a budget of its own and its
 * members' budgets are separate. `sum_of_children` is hledger's: the group is
 * whatever its members add up to and holds no budget. Both are defensible;
 * having one and expecting the other is a page of figures that are all wrong in
 * the same direction, so it is declared per group and shown wherever the group
 * is.
 */

export type CategoryGroupView = {
  id: string;
  name: string;
  policy: BudgetGroupPolicy;
  /** How many categories are filed under it, so a page need not count. */
  categoryCount: number;
  version: number;
};

function groupView(row: CategoryGroupRow, categoryCount: number): CategoryGroupView {
  return {
    id: row.id,
    name: row.name,
    policy: row.policy,
    categoryCount,
    version: row.version,
  };
}

export async function listCategoryGroups(actor: Actor): Promise<CategoryGroupView[]> {
  // A join and a count rather than a correlated subquery. The subquery this
  // replaced was written as a raw fragment with an alias of its own, and
  // Drizzle rendered the outer table's columns unqualified inside it: they
  // bound to the inner alias, so every group counted its own members against
  // themselves and reported nought. The join says which table each column
  // belongs to because Drizzle writes both sides.
  const rows = await getDb()
    .select({
      group: categoryGroups,
      categoryCount: sql<number>`count(${categories.id})::int`,
    })
    .from(categoryGroups)
    .leftJoin(
      categories,
      and(eq(categories.userId, categoryGroups.userId), eq(categories.groupId, categoryGroups.id)),
    )
    .where(eq(categoryGroups.userId, actor.userId))
    .groupBy(categoryGroups.id)
    .orderBy(asc(categoryGroups.name));
  return rows.map((row) => groupView(row.group, row.categoryCount));
}

/**
 * One group, by id — a service-level convenience with no route of its own.
 *
 * Deliberate, not an omission: the list is short by construction (groups are
 * one level deep and hand-made), both transports serve the whole of it, and a
 * by-id route would be a capability neither surface needs. The integration
 * tests read through this instead of re-implementing find-over-list.
 */
export async function getCategoryGroup(actor: Actor, id: string): Promise<CategoryGroupView> {
  const found = (await listCategoryGroups(actor)).find((group) => group.id === id);
  if (!found) throw notFound("Category group not found");
  return found;
}

export async function createCategoryGroup(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<CategoryGroupView> {
  const parsed = categoryGroupCreateSchema.parse(input);
  const normalizedName = normalizeHumanName(parsed.name);
  if (normalizedName === "") throw validationError("A group needs a name.");
  return withTransaction(transaction, async (tx) => {
    // The same lock categories take, and taken for the same reason: two
    // requests can each find a name free. Groups and categories share it
    // because moving a category into a group reads both.
    await lockCategoryNamespace(tx, actor);
    const [existing] = await tx
      .select({ id: categoryGroups.id, name: categoryGroups.name })
      .from(categoryGroups)
      .where(
        and(
          eq(categoryGroups.userId, actor.userId),
          eq(categoryGroups.normalizedName, normalizedName),
        ),
      )
      .limit(1);
    if (existing) {
      throw duplicate(`A group called ${existing.name} already exists.`, {
        duplicateGroupId: existing.id,
        normalizedName,
      });
    }
    const [created] = await tx
      .insert(categoryGroups)
      .values({
        userId: actor.userId,
        name: parsed.name.trim(),
        normalizedName,
        policy: parsed.policy,
      })
      .returning();
    // Impossible, not invalid: insert().returning() either throws or returns.
    if (!created) throw new Error("Category group insert returned no row");
    await writeAudit(tx, actor, {
      operation: "categoryGroup.create",
      entityType: "category_group",
      entityId: created.id,
      after: created,
    });
    return groupView(created, 0);
  });
}

export async function updateCategoryGroup(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
): Promise<CategoryGroupView> {
  const parsed = categoryGroupUpdateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(categoryGroups)
      .where(and(eq(categoryGroups.id, id), eq(categoryGroups.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Category group not found");
    if (before.version !== parsed.expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    // A group that holds a budget of its own cannot become one that is its
    // categories added up: the budget would stop being read and nothing on the
    // page would say why. Refused with the way out rather than silently.
    if (parsed.policy === "sum_of_children" && before.policy === "standalone") {
      // A standing budget or an amount set for one period: both are budgets
      // about the group, and both would stop being read.
      const [held] = await tx
        .select({ id: budgetPlans.id })
        .from(budgetPlans)
        .where(and(eq(budgetPlans.userId, actor.userId), eq(budgetPlans.groupId, id)))
        .limit(1);
      const [entry] = held
        ? [undefined]
        : await tx
            .select({ id: budgetEntries.id })
            .from(budgetEntries)
            .where(and(eq(budgetEntries.userId, actor.userId), eq(budgetEntries.groupId, id)))
            .limit(1);
      if (held || entry) {
        throw conflict(
          `${before.name} has a budget of its own, and a group budgeted as its categories added up cannot hold one. Delete that budget first, or leave the group as it is.`,
          held ? { budgetPlanId: held.id } : { budgetEntryId: entry!.id },
        );
      }
    }
    const name = parsed.name === undefined ? before.name : parsed.name.trim();
    const normalizedName = normalizeHumanName(name);
    if (normalizedName === "") throw validationError("A group needs a name.");
    if (normalizedName !== before.normalizedName) {
      const [clash] = await tx
        .select({ id: categoryGroups.id, name: categoryGroups.name })
        .from(categoryGroups)
        .where(
          and(
            eq(categoryGroups.userId, actor.userId),
            eq(categoryGroups.normalizedName, normalizedName),
          ),
        )
        .limit(1);
      if (clash && clash.id !== id) {
        throw duplicate(`A group called ${clash.name} already exists.`, {
          duplicateGroupId: clash.id,
          normalizedName,
        });
      }
    }
    const [updated] = await tx
      .update(categoryGroups)
      .set({
        name,
        normalizedName,
        policy: parsed.policy ?? before.policy,
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(categoryGroups.id, id),
          eq(categoryGroups.userId, actor.userId),
          eq(categoryGroups.version, before.version),
        ),
      )
      .returning();
    if (!updated) throw staleVersion({ currentVersion: before.version });
    await writeAudit(tx, actor, {
      operation: "categoryGroup.update",
      entityType: "category_group",
      entityId: id,
      before,
      after: updated,
    });
    // Counted on this transaction rather than by calling `getCategoryGroup`,
    // which reads through `getDb()`. That would be two defects in one line: the
    // read happens outside this transaction and so returns the row as it was,
    // version and all, and on a one-connection pool it would be waiting for the
    // connection this transaction is holding.
    const [counted] = await tx
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(categories)
      .where(and(eq(categories.userId, actor.userId), eq(categories.groupId, id)));
    return groupView(updated, counted?.count ?? 0);
  });
}

export async function deleteCategoryGroup(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
): Promise<{ id: string }> {
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(categoryGroups)
      .where(and(eq(categoryGroups.id, id), eq(categoryGroups.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Category group not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    // The categories stay and lose their group; a budget about the group goes
    // with it. Both fall out of the foreign keys rather than being done here,
    // which is what keeps them true of a delete that arrives any other way.
    await tx
      .delete(categoryGroups)
      .where(
        and(
          eq(categoryGroups.id, id),
          eq(categoryGroups.userId, actor.userId),
          eq(categoryGroups.version, expectedVersion),
        ),
      );
    await writeAudit(tx, actor, {
      operation: "categoryGroup.delete",
      entityType: "category_group",
      entityId: id,
      before,
    });
    return { id };
  });
}

/**
 * The group a category may be filed under, checked before it is written.
 *
 * Returns null for "no group", which is what clearing it means, and refuses a
 * group that is not this person's — as a not-found, because confirming that an
 * id exists is the one bit of somebody else's ledger this must not leak.
 */
export async function resolveCategoryGroup(
  tx: DbTransaction,
  actor: Actor,
  groupId: string | null | undefined,
): Promise<string | null> {
  if (groupId === undefined || groupId === null) return null;
  const [group] = await tx
    .select({ id: categoryGroups.id })
    .from(categoryGroups)
    .where(and(eq(categoryGroups.id, groupId), eq(categoryGroups.userId, actor.userId)))
    .limit(1);
  if (!group) throw notFound("Category group not found");
  return group.id;
}
