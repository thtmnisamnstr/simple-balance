import { and, asc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type {
  Actor,
  BudgetAmountRule,
  BudgetGroupPolicy,
  BudgetPeriodUnit,
} from "../../shared/domain.js";
import {
  budgetEntrySetSchema,
  budgetPlanCreateSchema,
  budgetPlanUpdateSchema,
  budgetReportQuerySchema,
  MAX_REPORT_BUCKETS,
  MAX_ROLLOVER_PERIODS,
} from "../../shared/domain.js";
import { todayIn } from "../../shared/recurrence-dates.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import {
  budgetEntries,
  budgetPlans,
  categories,
  categoryGroups,
  type BudgetEntryRow,
  type BudgetPlanRow,
} from "../db/schema.js";
import { canonicalDecimal, decimal, lockCategoryNamespace, writeAudit } from "./helpers.js";
import { conflict, notFound, staleVersion, validationError } from "./errors.js";
import { getPreferences } from "./preferences.js";
import { archivedExclusion, gridQuery, PERIOD_UNITS, withClause } from "./report-sql.js";

/**
 * Budgeting sits over the ledger and never inside it.
 *
 * Nothing here writes a posting, and no figure on a budget page comes from
 * anywhere but postings, plans and entries. That is what makes a budget
 * deletable without trace: a plan that is removed leaves the books exactly as
 * they were, because it never touched them.
 *
 * Amounts resolve in three steps, and the order is the whole model. An explicit
 * entry for the period wins. Otherwise the plan whose window covers the period
 * says the amount. Otherwise nothing is budgeted, and the row reports what was
 * spent against no limit at all.
 */

export type BudgetPlanView = {
  id: string;
  /**
   * The target, one of which is always null.
   *
   * A budget is about a category or about a group, and the two are the same
   * budget in every other respect. `targetName` is whichever one it is, so a
   * page or an agent that only wants to say what this budget is about does not
   * have to branch.
   */
  categoryId: string | null;
  categoryName: string | null;
  groupId: string | null;
  groupName: string | null;
  targetName: string;
  currency: string;
  periodUnit: BudgetPeriodUnit;
  amount: string;
  activeFrom: string;
  activeTo: string | null;
  /** Whether the difference at the end of a period belongs to the next one. */
  rollover: boolean;
  rolloverCap: string | null;
  targetAmount: string | null;
  targetDate: string | null;
  /** Periods a trailing average looks back over, or null for any other rule. */
  lookbackPeriods: number | null;
  /** The percentage added to the previous period, when that is the rule. */
  percentOfPrevious: string | null;
  /** The share of the previous period's income, when that is the rule. */
  percentOfIncome: string | null;
  /** Lower is funded first when a period's income will not cover everything. */
  priority: number;
  /**
   * Which arithmetic produces the amount. Derived from the row rather than
   * chosen: a plan with a target is a sinking fund because of what it says.
   */
  amountRule: BudgetAmountRule;
  version: number;
};

export type BudgetEntryView = {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  groupId: string | null;
  groupName: string | null;
  targetName: string;
  currency: string;
  periodUnit: BudgetPeriodUnit;
  periodStart: string;
  amount: string;
  version: number;
};

export type BudgetPeriodRow = {
  categoryId: string | null;
  category: string;
  /** Absent when nothing budgeted this category for this period. */
  limit: string | null;
  actual: string;
  /**
   * What is left to spend, counting anything carried in.
   *
   * `available` minus `actual`, which is the limit minus actual for everything
   * that does not roll over — so this means what it always meant, and means
   * the useful thing for a budget that does. Negative is over. Absent for the
   * same reason `limit` is.
   */
  remaining: string | null;
  /** Where the amount came from, so a page can say whether it was overridden. */
  source: "entry" | "plan" | "none";
  /**
   * What earlier periods left to this one, or null when nothing rolls over.
   *
   * Negative is a debt: a period that overspent hands the overspend forward
   * rather than forgetting it, which is the half of rollover people forget is
   * part of the deal.
   */
  carriedIn: string | null;
  /**
   * The limit plus whatever was carried in; equal to the limit when nothing
   * rolls over, and null only where there is no limit. `carriedIn !== null`
   * is the envelope discriminator — the toAssign fold and the page both key
   * on it — so do not read this field's nullness as "rolls over".
   */
  available: string | null;
  /**
   * What this period hands to the next, after the cap.
   *
   * Provisional while the period is still running, for the same reason
   * `actual` is: the period has not finished spending.
   */
  carriedOut: string | null;
  /** Lower is funded first. Zero unless somebody set an order. */
  priority: number;
  /**
   * How much of this row's limit the period's income actually covers.
   *
   * Null unless a funding order is in play, which is what setting any priority
   * turns on. Without one, "funded" would be a figure about every budget in
   * every ledger, and on a ledger with no income recorded in a period it would
   * read as though nothing were affordable.
   */
  funded: string | null;
};

/**
 * A group's line in one period.
 *
 * Beside the category rows rather than among them, because a group and its
 * members are two readings of the same money: adding both into one list would
 * make the period's totals count a grocery bill twice.
 */
export type BudgetGroupRow = {
  groupId: string;
  name: string;
  policy: BudgetGroupPolicy;
  /**
   * What the group is allowed. Its own budget under `standalone`, and what its
   * categories add up to under `sum_of_children`.
   */
  limit: string | null;
  /** What its categories spent between them, however the limit was arrived at. */
  actual: string;
  remaining: string | null;
  source: "entry" | "plan" | "sum" | "none";
  carriedIn: string | null;
  available: string | null;
  carriedOut: string | null;
  priority: number;
  funded: string | null;
};

export type BudgetPeriodView = {
  periodStart: string;
  /**
   * The period's own bounds, never the window's.
   *
   * The other reports clip a bucket to the range asked for, and a budget must
   * not: a limit belongs to a whole period, so weighing it against part of one
   * compares unlike things and reads as money still to spend. A range chooses
   * which periods to show. It does not slice them.
   */
  start: string;
  end: string;
  /**
   * True while the period is still running, so its spending is a total so far.
   *
   * The current period is the one case where a whole period cannot be shown,
   * because money dated later has not moved. Saying so is the alternative to
   * quietly comparing three weeks of spending against a month's limit.
   */
  partial: boolean;
  currency: string;
  rows: BudgetPeriodRow[];
  /**
   * The groups, and never inside `rows`.
   *
   * `budgeted` and `spent` sum the category rows alone, so a ledger that groups
   * everything does not report twice what it spent.
   */
  groups: BudgetGroupRow[];
  budgeted: string;
  spent: string;
  /** Sum of what was carried into this period. Zero when nothing rolls over. */
  carriedIn: string;
  /** Sum of `available`, which is `budgeted` plus `carriedIn`. */
  available: string;
  /**
   * What arrived in this period, in this currency, from the income side.
   *
   * A fact rather than a budget, and reported whether or not anything uses it:
   * a percentage of income is worked out from the period before this one, and a
   * funding order is worked out from this one.
   */
  income: string;
  /**
   * The part of the budgeted total this period's income does not cover.
   *
   * Null unless a funding order is in play, for the same reason `funded` is.
   */
  unfunded: string | null;
  /**
   * Money inside the budget's perimeter that no envelope has claimed.
   *
   * Null unless something in this period rolls over, because a budget that does
   * not carry is a limit rather than a claim on cash, and a ledger with no
   * envelopes has nothing to assign.
   *
   * It sits below the bank balance for two reasons and the page says both: an
   * account can be taken out of the perimeter, and every envelope with money
   * left in it has already claimed part of what is there.
   */
  toAssign: string | null;
  /** What the accounts inside the perimeter held at the end of this period. */
  perimeter: string;
};

export type BudgetReportView = {
  periodUnit: BudgetPeriodUnit;
  start: string;
  /** The day the figures actually stop at, which is never after today. */
  asOf: string;
  periods: BudgetPeriodView[];
  /**
   * Period units this person budgets in that are not the one being reported.
   *
   * A budget belongs to a period unit, so a weekly budget is invisible in a
   * monthly report and the row for that category reads `limit: null`. On its
   * own that is a report saying "no budget" about a category that has one,
   * which is a wrong answer given confidently. This says what is being left
   * out, so the reply can be read for what it is.
   */
  otherPeriodUnits: BudgetPeriodUnit[];
  /**
   * Where the carry was folded from, and whether the fold hit its bound.
   *
   * Null when nothing in this report rolls over. Otherwise `from` is the first
   * period the carry was worked out from, which is normally the earliest
   * rollover budget's own start; `clipped` says the fold stopped at
   * `MAX_ROLLOVER_PERIODS` instead, so the carry began from nothing part way
   * through a budget's life. A figure with a bound is worth having and a bound
   * nobody is told about is not.
   */
  rollover: { from: string; clipped: boolean } | null;
};

const ZERO = "0";

function planView(row: BudgetPlanRow, target: BudgetTargetName): BudgetPlanView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.categoryId === null ? null : target.name,
    groupId: row.groupId,
    groupName: row.groupId === null ? null : target.name,
    targetName: target.name,
    currency: row.currency,
    periodUnit: row.periodUnit,
    amount: canonicalDecimal(row.amount),
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
    rollover: row.rollover,
    rolloverCap: row.rolloverCap === null ? null : canonicalDecimal(row.rolloverCap),
    targetAmount: row.targetAmount === null ? null : canonicalDecimal(row.targetAmount),
    targetDate: row.targetDate,
    lookbackPeriods: row.ruleLookback,
    // One stored column, two names, and the rule decides which one it answers
    // to. A reader should never have to know that they share a column.
    percentOfPrevious:
      row.amountRule === "incremental" && row.rulePercent !== null
        ? canonicalDecimal(row.rulePercent)
        : null,
    percentOfIncome:
      row.amountRule === "percent_of_income" && row.rulePercent !== null
        ? canonicalDecimal(row.rulePercent)
        : null,
    priority: row.priority,
    amountRule: row.amountRule,
    version: row.version,
  };
}

function entryView(row: BudgetEntryRow, target: BudgetTargetName): BudgetEntryView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.categoryId === null ? null : target.name,
    groupId: row.groupId,
    groupName: row.groupId === null ? null : target.name,
    targetName: target.name,
    currency: row.currency,
    periodUnit: row.periodUnit,
    periodStart: row.periodStart,
    amount: canonicalDecimal(row.amount),
    version: row.version,
  };
}

/** What a budget is about, and what to call it on a page. */
type BudgetTargetName = { kind: "category" | "group"; id: string; name: string };

/**
 * The target exists, belongs to this person, and can carry a budget.
 *
 * An archived category may still be budgeted, because archiving hides it from
 * pickers rather than erasing what it did, and a budget report covering last
 * March has to be able to name it. What is refused is budgeting a category that
 * only ever carries income: a limit on it would compare a cap against a figure
 * that never moves.
 *
 * A group is refused for a different reason. A `sum_of_children` group *is* its
 * categories' budgets added up, so a budget of its own would be a second figure
 * with an equal claim to be the group's, and nothing on the page could say
 * which of the two it was showing.
 */
async function requireBudgetableTarget(
  tx: DbTransaction,
  actor: Actor,
  target: { categoryId?: string | null; groupId?: string | null },
): Promise<BudgetTargetName> {
  if (target.groupId != null) {
    const [group] = await tx
      .select({ id: categoryGroups.id, name: categoryGroups.name, policy: categoryGroups.policy })
      .from(categoryGroups)
      .where(and(eq(categoryGroups.id, target.groupId), eq(categoryGroups.userId, actor.userId)))
      .limit(1);
    if (!group) throw notFound("Category group not found");
    if (group.policy === "sum_of_children") {
      throw validationError(
        `${group.name} is budgeted as whatever its categories add up to, so it cannot hold a budget of its own. Budget the categories in it, or change the group to hold its own budget.`,
      );
    }
    return { kind: "group", id: group.id, name: group.name };
  }
  if (target.categoryId == null) {
    throw validationError("A budget is about a category or a group. Name one of them.");
  }
  const [category] = await tx
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.id, target.categoryId), eq(categories.userId, actor.userId)))
    .limit(1);
  if (!category) throw notFound("Category not found");
  if (category.kind === "income") {
    throw validationError(
      "An income category has no spending to budget. Budget an expense category, or widen this one to both.",
    );
  }
  return { kind: "category", id: category.id, name: category.name };
}

/**
 * Two plans covering one period would make the amount depend on which row was
 * read first, so the windows for one target may not overlap.
 *
 * Checked under the category namespace lock, which is the lock this file takes
 * for the same reason `categories.ts` takes it: a uniqueness rule the database
 * cannot express needs somewhere to be serialised, and taking it here keeps the
 * order the rest of the ledger already uses.
 */
async function assertNoOverlap(
  tx: DbTransaction,
  actor: Actor,
  target: {
    categoryId?: string | null;
    groupId?: string | null;
    currency: string;
    periodUnit: BudgetPeriodUnit;
  },
  window: { activeFrom: string; activeTo: string | null },
  excludeId?: string,
) {
  const rows = await tx
    .select({
      id: budgetPlans.id,
      activeFrom: budgetPlans.activeFrom,
      activeTo: budgetPlans.activeTo,
    })
    .from(budgetPlans)
    .where(
      and(
        eq(budgetPlans.userId, actor.userId),
        // Whichever target this budget is about. The other column is null on
        // both rows, and `eq` against null matches nothing, so comparing both
        // would find no clash at all.
        target.groupId != null
          ? eq(budgetPlans.groupId, target.groupId)
          : eq(budgetPlans.categoryId, target.categoryId!),
        eq(budgetPlans.currency, target.currency),
        eq(budgetPlans.periodUnit, target.periodUnit),
      ),
    );
  const clash = rows.find((row) => {
    if (excludeId && row.id === excludeId) return false;
    // Both ends are period starts by the time they get here, so this compares
    // periods rather than days and two budgets can no longer half-cover a month
    // between them. Null means "still running", which is later than every date.
    const endsBefore = row.activeTo !== null && row.activeTo < window.activeFrom;
    const startsAfter = window.activeTo !== null && row.activeFrom > window.activeTo;
    return !endsBefore && !startsAfter;
  });
  if (clash) {
    // The advice has to be advice somebody can take. Telling a person to end
    // the other budget "at the period before" is a dead end when the other
    // budget starts in this very period: the period before is earlier than its
    // own start, which the other validator refuses. In that case the only real
    // answers are to change the amount on the budget already there, or to set
    // an amount for this one period.
    const startsInSamePeriod = clash.activeFrom >= window.activeFrom;
    throw validationError(
      startsInSamePeriod
        ? `That ${target.groupId != null ? "group" : "category"}'s budget already starts on ${clash.activeFrom}, which is this period or later. Change that budget's amount instead, or set an amount for one period only.`
        : `Another budget for this ${target.groupId != null ? "group" : "category"} already covers the period starting ${clash.activeFrom}${
            clash.activeTo
              ? ` through the one starting ${clash.activeTo}`
              : " and every period after it"
          }. Windows are whole periods, so end that one at the period before this one starts.`,
      {
        conflictingPlanId: clash.id,
        conflictingActiveFrom: clash.activeFrom,
        conflictingActiveTo: clash.activeTo,
        startsInSamePeriod,
      },
    );
  }
}

/**
 * Both joins are outer, because exactly one of them matches.
 *
 * A budget names a category or a group, so an inner join on either would drop
 * half the budgets — and the one it dropped would be the half somebody had just
 * created, which is the worst way to find out.
 */
const targetNameOf = (categoryName: string | null, groupName: string | null): BudgetTargetName =>
  groupName !== null
    ? { kind: "group", id: "", name: groupName }
    : { kind: "category", id: "", name: categoryName ?? "Unnamed" };

export async function listBudgetPlans(actor: Actor) {
  const rows = await getDb()
    .select({
      plan: budgetPlans,
      categoryName: categories.name,
      groupName: categoryGroups.name,
    })
    .from(budgetPlans)
    .leftJoin(
      categories,
      and(eq(categories.userId, budgetPlans.userId), eq(categories.id, budgetPlans.categoryId)),
    )
    .leftJoin(
      categoryGroups,
      and(
        eq(categoryGroups.userId, budgetPlans.userId),
        eq(categoryGroups.id, budgetPlans.groupId),
      ),
    )
    .where(eq(budgetPlans.userId, actor.userId))
    .orderBy(asc(categories.name), asc(categoryGroups.name), asc(budgetPlans.activeFrom));
  return rows.map((row) => planView(row.plan, targetNameOf(row.categoryName, row.groupName)));
}

export async function getBudgetPlan(actor: Actor, id: string) {
  const [row] = await getDb()
    .select({
      plan: budgetPlans,
      categoryName: categories.name,
      groupName: categoryGroups.name,
    })
    .from(budgetPlans)
    .leftJoin(
      categories,
      and(eq(categories.userId, budgetPlans.userId), eq(categories.id, budgetPlans.categoryId)),
    )
    .leftJoin(
      categoryGroups,
      and(
        eq(categoryGroups.userId, budgetPlans.userId),
        eq(categoryGroups.id, budgetPlans.groupId),
      ),
    )
    .where(and(eq(budgetPlans.id, id), eq(budgetPlans.userId, actor.userId)))
    .limit(1);
  if (!row) throw notFound("Budget not found");
  return planView(row.plan, targetNameOf(row.categoryName, row.groupName));
}

export async function createBudgetPlan(actor: Actor, input: unknown, transaction?: DbTransaction) {
  const parsed = budgetPlanCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const target = await requireBudgetableTarget(tx, actor, parsed);
    // Snapped to the period, both ends. A window is asked for in days and
    // answered in periods, and leaving the two in different units was three
    // defects at once: a budget set on the 23rd covered nothing that month, a
    // budget ended on the 2nd granted the whole month its full amount and
    // absorbed spending from the 28th, and a window living entirely inside one
    // period resolved nowhere while still blocking the plan that would have.
    // Snapping on the way in means the row says what it does.
    const activeFrom = await truncatePeriod(tx, parsed.periodUnit, parsed.activeFrom);
    const activeTo = parsed.activeTo
      ? await truncatePeriod(tx, parsed.periodUnit, parsed.activeTo)
      : null;
    await assertNoOverlap(tx, actor, parsed, { activeFrom, activeTo });
    const carry = await resolveCarry(tx, parsed.periodUnit, activeFrom, {
      rollover: parsed.rollover ?? false,
      rolloverCap: parsed.rolloverCap ?? null,
      targetAmount: parsed.targetAmount ?? null,
      targetDate: parsed.targetDate ?? null,
      lookbackPeriods: parsed.lookbackPeriods ?? null,
      percentOfPrevious: parsed.percentOfPrevious ?? null,
      percentOfIncome: parsed.percentOfIncome ?? null,
      priority: parsed.priority ?? 0,
      amount: parsed.amount,
      isGroup: parsed.groupId != null,
    });
    const [created] = await tx
      .insert(budgetPlans)
      .values({
        userId: actor.userId,
        categoryId: parsed.categoryId ?? null,
        groupId: parsed.groupId ?? null,
        currency: parsed.currency,
        periodUnit: parsed.periodUnit,
        amount: carry.amount,
        activeFrom,
        activeTo,
        ...carry.columns,
      })
      .returning();
    if (!created) throw validationError("Budget could not be created");
    await writeAudit(tx, actor, {
      operation: "budgetPlan.create",
      entityType: "budget_plan",
      entityId: created.id,
      after: created,
    });
    return planView(created, target);
  });
}

/**
 * Whether this patch names a way of working the amount out.
 *
 * A patch that names one rule replaces whatever rule the row had, because a
 * budget works its amount out one way and the alternative is a patch nobody can
 * write: sending a lookback to a plan that takes a share of income would be
 * refused for naming two, and clearing the other one first would mean naming a
 * field the caller never mentioned.
 */
const namesAnotherRule = (
  patch: {
    lookbackPeriods?: number | null;
    percentOfPrevious?: string | null;
    percentOfIncome?: string | null;
    targetAmount?: string | null;
  },
  except: "lookbackPeriods" | "percentOfPrevious" | "percentOfIncome",
) =>
  (except !== "lookbackPeriods" && patch.lookbackPeriods != null) ||
  (except !== "percentOfPrevious" && patch.percentOfPrevious != null) ||
  (except !== "percentOfIncome" && patch.percentOfIncome != null) ||
  patch.targetAmount != null;

export async function updateBudgetPlan(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = budgetPlanUpdateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const [before] = await tx
      .select()
      .from(budgetPlans)
      .where(and(eq(budgetPlans.id, id), eq(budgetPlans.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Budget not found");
    if (before.version !== parsed.expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    const target = await requireBudgetableTarget(tx, actor, before);
    const activeFrom = parsed.activeFrom
      ? await truncatePeriod(tx, before.periodUnit, parsed.activeFrom)
      : before.activeFrom;
    // Absent leaves the end alone, null ends it, a date moves it. The same
    // three-way patch the templates already use, so it reads the same way.
    const activeTo =
      parsed.activeTo === undefined
        ? before.activeTo
        : parsed.activeTo === null
          ? null
          : await truncatePeriod(tx, before.periodUnit, parsed.activeTo);
    if (activeTo !== null && activeTo < activeFrom) {
      throw validationError(
        `A budget cannot end before it starts. This one runs from ${activeFrom}, and ending it on ${activeTo} would be earlier than that. Move the start as well, or delete the budget.`,
      );
    }
    await assertNoOverlap(
      tx,
      actor,
      {
        categoryId: before.categoryId,
        groupId: before.groupId,
        currency: before.currency,
        periodUnit: before.periodUnit,
      },
      { activeFrom, activeTo },
      before.id,
    );
    // The patch over the row, then the pair checked together. A patch that only
    // turns rollover off is wrong when the row it lands on is a sinking fund,
    // and the schema cannot see that: it reads the patch and the patch alone.
    const carry = await resolveCarry(tx, before.periodUnit, activeFrom, {
      rollover: parsed.rollover ?? before.rollover,
      rolloverCap:
        parsed.rolloverCap === undefined ? before.rolloverCap : (parsed.rolloverCap ?? null),
      targetAmount:
        parsed.targetAmount === undefined ? before.targetAmount : (parsed.targetAmount ?? null),
      targetDate: parsed.targetDate === undefined ? before.targetDate : (parsed.targetDate ?? null),
      // Naming one rule's parameter clears whichever other rule was there,
      // which is what `update_budget_plan` says it does. Keeping the old one
      // and letting the pair be refused would be a patch that cannot change a
      // budget's mind: the only way out would be two calls, and the first would
      // have to clear a field the caller never mentioned.
      lookbackPeriods:
        parsed.lookbackPeriods !== undefined
          ? (parsed.lookbackPeriods ?? null)
          : namesAnotherRule(parsed, "lookbackPeriods")
            ? null
            : before.ruleLookback,
      // The stored column is one percentage and the patch has two names for it,
      // so which one it belongs to depends on the rule the row already carries.
      // Sending the other name is what changes the rule.
      percentOfPrevious:
        parsed.percentOfPrevious !== undefined
          ? (parsed.percentOfPrevious ?? null)
          : namesAnotherRule(parsed, "percentOfPrevious") || before.amountRule !== "incremental"
            ? null
            : before.rulePercent,
      percentOfIncome:
        parsed.percentOfIncome !== undefined
          ? (parsed.percentOfIncome ?? null)
          : namesAnotherRule(parsed, "percentOfIncome") || before.amountRule !== "percent_of_income"
            ? null
            : before.rulePercent,
      priority: parsed.priority ?? before.priority,
      amount: parsed.amount === undefined ? before.amount : parsed.amount,
      isGroup: before.groupId !== null,
    });
    const [updated] = await tx
      .update(budgetPlans)
      .set({
        amount: carry.amount,
        activeFrom,
        activeTo,
        ...carry.columns,
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetPlans.id, id),
          eq(budgetPlans.userId, actor.userId),
          eq(budgetPlans.version, before.version),
        ),
      )
      .returning();
    if (!updated) throw staleVersion({ currentVersion: before.version });
    await writeAudit(tx, actor, {
      operation: "budgetPlan.update",
      entityType: "budget_plan",
      entityId: id,
      before,
      after: updated,
    });
    return planView(updated, target);
  });
}

export async function deleteBudgetPlan(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(budgetPlans)
      .where(and(eq(budgetPlans.id, id), eq(budgetPlans.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Budget not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    // A deleted budget leaves nothing behind, because it never wrote anything.
    // That is the property the whole design was chosen for.
    await tx
      .delete(budgetPlans)
      .where(
        and(
          eq(budgetPlans.id, id),
          eq(budgetPlans.userId, actor.userId),
          eq(budgetPlans.version, expectedVersion),
        ),
      );
    await writeAudit(tx, actor, {
      operation: "budgetPlan.delete",
      entityType: "budget_plan",
      entityId: id,
      before,
    });
    return { id };
  });
}

/**
 * The first day of the period a date falls in, worked out by PostgreSQL rather
 * than in JavaScript.
 *
 * Because the report grid is `date_trunc` and this has to agree with it exactly.
 * Working out the start of an ISO week in JavaScript is a different function
 * from the one PostgreSQL runs, and the two disagreeing would put a limit on a
 * different Monday from its spending.
 */
/**
 * The four carry columns, checked against each other and against the window.
 *
 * The schemas refuse a patch that is wrong on its own terms — a target with no
 * date, a fund told not to roll over. What they cannot see is the row the patch
 * lands on, or the window it lands in, and both matter: turning rollover off on
 * a plan that is a sinking fund leaves a fund that cannot save, and a target
 * date before the budget starts is a fund with no periods to fund itself over.
 *
 * The rule is derived rather than asked for, which is the one decision here
 * worth defending. There is no method chooser in this product: a budget with a
 * target and a date is a sinking fund because of what it says, not because
 * somebody picked the words from a list.
 */
async function resolveCarry(
  executor: Pick<DbTransaction, "execute">,
  periodUnit: BudgetPeriodUnit,
  activeFrom: string,
  input: {
    rollover: boolean;
    rolloverCap: string | null;
    targetAmount: string | null;
    targetDate: string | null;
    lookbackPeriods: number | null;
    percentOfPrevious: string | null;
    percentOfIncome: string | null;
    priority: number;
    amount: string;
    isGroup: boolean;
  },
) {
  const isFund = input.targetAmount !== null;
  const named = [
    input.targetAmount === null ? null : "a savings target",
    input.lookbackPeriods === null ? null : "a lookback",
    input.percentOfPrevious === null ? null : "a percentage of the last period",
    input.percentOfIncome === null ? null : "a percentage of income",
  ].filter((rule): rule is string => rule !== null);
  if (named.length > 1) {
    throw validationError(
      `A budget works out its amount one way, and this one names ${named.join(" and ")}. Send one of them, or none for a fixed amount.`,
    );
  }
  if (isFund && input.targetDate === null) {
    throw validationError(
      "A sinking fund needs both an amount to save and a date to have it by. Send both, or neither.",
    );
  }
  if (isFund && !input.rollover) {
    throw validationError(
      "A sinking fund has to carry what it saved into the next period, so rollover cannot be off.",
    );
  }
  // Snapped like both ends of the window, and for the same reason: a fund
  // divides what is left by the periods left, so the date it is needed by has
  // to be one of them. Any day inside a period names that period.
  const targetDate = input.targetDate
    ? await truncatePeriod(executor, periodUnit, input.targetDate)
    : null;
  if (targetDate !== null && targetDate < activeFrom) {
    throw validationError(
      `A sinking fund cannot be needed before it starts saving. This one starts in the period beginning ${activeFrom} and the target period begins ${targetDate}.`,
    );
  }
  // Refused rather than ignored. A fund works out each period's figure from
  // what is left to save, so an amount beside it is a number nothing reads —
  // and a number nothing reads on a budget page is a number somebody will
  // believe.
  if (isFund && decimal(input.amount).cmp(0) !== 0) {
    throw validationError(
      "A sinking fund works out its own amount each period, from what is still needed and how many periods are left. Set the amount to zero, or remove the target to budget a fixed amount.",
    );
  }
  if (input.priority !== 0 && input.isGroup) {
    throw validationError(
      "A funding order is about categories. Ranking a group and the categories under it would spend the same income twice, so a group's budget carries no priority.",
    );
  }
  if (!input.rollover && input.rolloverCap !== null) {
    throw validationError(
      "A carry cap only means something when rollover is on, and this budget does not carry anything forward.",
    );
  }
  // A fund saves by carrying, so a cap under the target caps the saving: each
  // period's contribution is pinned back to the cap, the fund re-budgets what
  // the cap just discarded, and the target date arrives with the whole
  // shortfall due at once. The two numbers contradict each other, so the pair
  // is refused rather than obeyed in the wrong order — and the browser offers
  // the combination, which is exactly why the server has to say no.
  if (isFund && input.rolloverCap !== null && decimal(input.rolloverCap).lt(input.targetAmount!)) {
    throw validationError(
      "This cap is below what the fund is saving for, so it would throw away each period's contribution and leave the whole amount due at the end. Raise the cap to at least the target, or remove it.",
      { fields: ["rolloverCap"] },
    );
  }
  const amountRule: BudgetAmountRule = isFund
    ? "sinking_fund"
    : input.lookbackPeriods !== null
      ? "trailing_average"
      : input.percentOfPrevious !== null
        ? "incremental"
        : input.percentOfIncome !== null
          ? "percent_of_income"
          : "fixed";
  // One column for two percentages, because a row is only ever one of the two
  // rules that use it. Which one it is is the rule's own business.
  const rulePercent = input.percentOfPrevious ?? input.percentOfIncome ?? null;
  return {
    // A derived amount keeps what was sent, and every rule but `incremental`
    // ignores it. That one uses it as the base for its first period, which is
    // the only figure in the chain nothing earlier can supply.
    amount: canonicalDecimal(input.amount),
    columns: {
      rollover: input.rollover,
      rolloverCap: input.rolloverCap === null ? null : canonicalDecimal(input.rolloverCap),
      targetAmount: input.targetAmount === null ? null : canonicalDecimal(input.targetAmount),
      targetDate,
      ruleLookback: input.lookbackPeriods,
      rulePercent: rulePercent === null ? null : canonicalDecimal(rulePercent),
      priority: input.priority,
      amountRule,
    },
  };
}

async function truncatePeriod(
  executor: Pick<DbTransaction, "execute">,
  periodUnit: BudgetPeriodUnit,
  date: string,
): Promise<string> {
  const result = await executor.execute(
    sql`select date_trunc(${PERIOD_UNITS[periodUnit]}, ${date}::date)::date as start`,
  );
  return String(result.rows[0]!.start);
}

export async function setBudgetEntry(actor: Actor, input: unknown, transaction?: DbTransaction) {
  const parsed = budgetEntrySetSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const target = await requireBudgetableTarget(tx, actor, parsed);
    const periodStart = await truncatePeriod(tx, parsed.periodUnit, parsed.periodStart);
    const [before] = await tx
      .select()
      .from(budgetEntries)
      .where(
        and(
          eq(budgetEntries.userId, actor.userId),
          // The one this override is about, and never both columns: the other
          // is null on every row, and `eq` against null matches nothing.
          parsed.groupId != null
            ? eq(budgetEntries.groupId, parsed.groupId)
            : eq(budgetEntries.categoryId, parsed.categoryId!),
          eq(budgetEntries.currency, parsed.currency),
          eq(budgetEntries.periodUnit, parsed.periodUnit),
          eq(budgetEntries.periodStart, periodStart),
        ),
      )
      .limit(1);

    if (!before) {
      if (parsed.expectedVersion !== undefined) {
        throw notFound("There is no budget for that period to change");
      }
      const [created] = await tx
        .insert(budgetEntries)
        .values({
          userId: actor.userId,
          categoryId: parsed.categoryId ?? null,
          groupId: parsed.groupId ?? null,
          currency: parsed.currency,
          periodUnit: parsed.periodUnit,
          periodStart,
          amount: canonicalDecimal(parsed.amount),
        })
        .returning();
      if (!created) throw validationError("Budget could not be set");
      await writeAudit(tx, actor, {
        operation: "budgetEntry.create",
        entityType: "budget_entry",
        entityId: created.id,
        after: created,
      });
      return entryView(created, target);
    }

    if (parsed.expectedVersion === undefined) {
      throw conflict("That period already has a budget. Send its version to change it.", {
        currentVersion: before.version,
      });
    }
    if (before.version !== parsed.expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    const [updated] = await tx
      .update(budgetEntries)
      .set({
        amount: canonicalDecimal(parsed.amount),
        version: before.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetEntries.id, before.id),
          eq(budgetEntries.userId, actor.userId),
          eq(budgetEntries.version, before.version),
        ),
      )
      .returning();
    if (!updated) throw staleVersion({ currentVersion: before.version });
    await writeAudit(tx, actor, {
      operation: "budgetEntry.update",
      entityType: "budget_entry",
      entityId: before.id,
      before,
      after: updated,
    });
    return entryView(updated, target);
  });
}

export async function deleteBudgetEntry(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(budgetEntries)
      .where(and(eq(budgetEntries.id, id), eq(budgetEntries.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Budget not found");
    if (before.version !== expectedVersion) {
      throw staleVersion({ currentVersion: before.version });
    }
    await tx
      .delete(budgetEntries)
      .where(
        and(
          eq(budgetEntries.id, id),
          eq(budgetEntries.userId, actor.userId),
          eq(budgetEntries.version, expectedVersion),
        ),
      );
    await writeAudit(tx, actor, {
      operation: "budgetEntry.delete",
      entityType: "budget_entry",
      entityId: id,
      before,
    });
    return { id };
  });
}

export async function listBudgetEntries(actor: Actor) {
  const rows = await getDb()
    .select({
      entry: budgetEntries,
      categoryName: categories.name,
      groupName: categoryGroups.name,
    })
    .from(budgetEntries)
    .leftJoin(
      categories,
      and(eq(categories.userId, budgetEntries.userId), eq(categories.id, budgetEntries.categoryId)),
    )
    .leftJoin(
      categoryGroups,
      and(
        eq(categoryGroups.userId, budgetEntries.userId),
        eq(categoryGroups.id, budgetEntries.groupId),
      ),
    )
    .where(eq(budgetEntries.userId, actor.userId))
    .orderBy(asc(budgetEntries.periodStart), asc(categories.name), asc(categoryGroups.name));
  return rows.map((row) => entryView(row.entry, targetNameOf(row.categoryName, row.groupName)));
}

/**
 * What each budgeted category was allowed and what it actually spent.
 *
 * Four things this gets right that the obvious version does not.
 *
 * It joins from the budget to the spending rather than the other way, so a
 * category budgeted at two hundred and spent nothing on renders as nought of
 * two hundred. Copying the dashboard's aggregate instead would inherit its
 * `having sum(p.amount) <> 0` and silently drop exactly the rows a budget page
 * exists to show.
 *
 * Splits, corrections and deletions need no handling at all. A leg is its own
 * postings, a correction is an appended delta, and a voided entry already nets
 * to zero, so each falls out of summing signed postings. A transfer cannot
 * appear because it has no expense-side posting to sum.
 *
 * The grid comes from the same `date_trunc` and `generate_series` the reports
 * use, so a limit and its actual cannot land on different periods.
 *
 * And every figure stops at today in the person's own timezone, like every
 * other figure in the product, because money dated tomorrow has not moved.
 */
export async function getBudgetReport(actor: Actor, input: unknown): Promise<BudgetReportView> {
  const parsed = budgetReportQuerySchema.parse(input);
  const { timezone } = await getPreferences(actor);
  const today = todayIn(timezone);
  const requestedEnd = parsed.end ?? today;
  const asOf = requestedEnd < today ? requestedEnd : today;
  // Without a start, the window is the period today falls in rather than today
  // itself. Defaulting to a single day would compare a whole month's limit
  // against one day's spending and call the difference "remaining", which is
  // the wrong answer arrived at silently and on the path most people take. A
  // start that was asked for is honoured as it stands, the way every other
  // report clips to the window rather than to the period.
  const start = parsed.start ?? (await truncatePeriod(getDb(), parsed.periodUnit, asOf));
  // Refused rather than answered with nothing, the way every other report
  // refuses it. An empty reply to a backwards range reads as "no budgets",
  // which is a different and wrong answer.
  if (parsed.start && parsed.end && parsed.start > parsed.end) {
    throw validationError("Start date must be on or before end date");
  }
  if (start > asOf) {
    return {
      periodUnit: parsed.periodUnit,
      start,
      asOf,
      periods: [],
      otherPeriodUnits: await otherUnits(actor, parsed.periodUnit),
      rollover: null,
    };
  }

  // The plans that carry, read before anything else, because they decide how
  // far back the rest of this has to look. A report with none of them costs
  // exactly what it did before: one query over the periods asked for.
  const carrying = await rolloverPlans(actor, parsed.periodUnit);
  const foldFrom =
    carrying.length === 0
      ? start
      : carrying.map((plan) => plan.activeFrom).reduce((a, b) => (a < b ? a : b), start);

  const unit = PERIOD_UNITS[parsed.periodUnit];
  // The same ceiling the reports draw, and for the same reason: a decade of
  // weeks is thousands of periods nobody can read and a reply nobody wants to
  // hold in memory, and over MCP it is megabytes of context.
  const gridRows = await getDb().execute(
    sql`${gridQuery(parsed.periodUnit, start, asOf)} limit ${MAX_REPORT_BUCKETS + 1}`,
  );
  if (gridRows.rows.length > MAX_REPORT_BUCKETS) {
    throw validationError(
      `That range needs more than ${MAX_REPORT_BUCKETS} ${parsed.periodUnit} periods, which is the most a budget report will draw. Ask for a coarser period or a shorter range.`,
    );
  }
  // The day the figures actually stop at, which is the end of the last period
  // shown or today, whichever comes first. Not the end that was asked for:
  // whole periods mean a range ending on the tenth still counts the whole
  // month, and reporting the tenth as the day used was the report describing
  // itself wrongly.
  const lastPeriodEnd = String(gridRows.rows[gridRows.rows.length - 1]?.period_end ?? asOf);
  const countedTo = lastPeriodEnd < today ? lastPeriodEnd : today;
  const archived = archivedExclusion(actor.userId, parsed.includeArchived);
  // Every period the carry has to be folded over: the ones being reported, and
  // the ones before them that the carry came through. Bounded, and the bound is
  // reported rather than assumed — see `MAX_ROLLOVER_PERIODS`.
  const foldPeriods =
    foldFrom < start
      ? (await getDb().execute(sql`${gridQuery(parsed.periodUnit, foldFrom, countedTo)}`)).rows.map(
          (row) => String(row.bucket_start),
        )
      : gridRows.rows.map((row) => String(row.bucket_start));
  // The first period actually being reported, which is a period start and not
  // the date that was asked for. `start` may be any day inside its period —
  // that is the whole point of a grid of whole periods — so comparing the two
  // as strings dropped the first period of every report whose start was not the
  // first of a month.
  const firstReported = String(gridRows.rows[0]?.bucket_start ?? start);
  const clipped = foldPeriods.length > MAX_ROLLOVER_PERIODS + gridRows.rows.length;
  const folded = clipped
    ? foldPeriods.slice(foldPeriods.length - (MAX_ROLLOVER_PERIODS + gridRows.rows.length))
    : foldPeriods;
  const queryStart = folded[0] ?? start;

  const result = await getDb().execute(sql`
    ${withClause(
      archived.cte,
      sql`grid as (${gridQuery(parsed.periodUnit, queryStart, asOf)})`,
      // Signed postings on the expense counter-account, bucketed the same way
      // the grid is. A refund is negative here and lowers the category it came
      // back to, which is why nothing in this query mentions refunds.
      //
      // The zero filter below belongs to the unbudgeted branch alone. A
      // budgeted category that was never spent on is the row this page exists
      // to show, so the budgeted branch keeps its zeroes; a category that only
      // ever appears because money moved has nothing to say once that money
      // nets to nothing, and leaving it in accumulated a phantom row for every
      // deleted entry and every collapsed split.
      sql`spend as (
        select
          date_trunc(${unit}, p.date)::date as period_start,
          case when p.leg_id is not null then l.category_id else t.category_id end
            as category_id,
          p.currency,
          sum(p.amount) as actual
        from posting p
        join ledger_account a
          on a.user_id = p.user_id
          and a.id = p.account_id
          and a.system_kind = 'expense'
        left join transaction_leg l
          on l.user_id = p.user_id
          and l.id = p.leg_id
        left join ledger_transaction t
          on p.leg_id is null
          and t.user_id = p.user_id
          and t.id = p.transaction_id
        ${archived.join}
        where p.user_id = ${actor.userId}
          -- Both ends widened to the periods the window touches, not the dates
          -- it was asked for. Widening only the front was the same defect with
          -- the sign flipped: a July asked for to the 10th reported ten days of
          -- spending against the whole month's limit, under a heading naming
          -- the whole month. Bounded above by today as well, because money
          -- dated later has not moved.
          and p.date >= date_trunc(${unit}, ${queryStart}::date)::date
          and p.date <= ${countedTo}::date
          ${archived.filter}
        group by 1, 2, 3
      )`,
      // The amount each budgeted category is allowed in each period: the entry
      // if there is one, otherwise the plan whose window covers the period.
      // A budget names a category or a group, and both travel through here the
      // same way: the group's own spending is worked out from its categories
      // afterwards, because spending is recorded against a category and a group
      // is a way of reading them rather than a thing money is spent on.
      sql`budgeted as (
        select
          g.bucket_start as period_start,
          b.category_id,
          b.group_id,
          b.currency,
          b.amount,
          b.source
        from grid g
        join lateral (
          select e.category_id, e.group_id, e.currency, e.amount, 'entry'::text as source
          from budget_entry e
          where e.user_id = ${actor.userId}
            and e.period_unit = ${parsed.periodUnit}
            and e.period_start = g.bucket_start
          union all
          select pl.category_id, pl.group_id, pl.currency, pl.amount, 'plan'::text as source
          from budget_plan pl
          where pl.user_id = ${actor.userId}
            and pl.period_unit = ${parsed.periodUnit}
            and pl.active_from <= g.bucket_start
            and (pl.active_to is null or pl.active_to >= g.bucket_start)
            and not exists (
              select 1
              from budget_entry e2
              where e2.user_id = pl.user_id
                and e2.category_id is not distinct from pl.category_id
                and e2.group_id is not distinct from pl.group_id
                and e2.currency = pl.currency
                and e2.period_unit = pl.period_unit
                and e2.period_start = g.bucket_start
            )
        ) b on true
      )`,
    )}
    select * from (
      select
        g.bucket_start::text as period_start,
        g.period_end::text as period_end,
        b.currency as currency,
        b.category_id as category_id,
        b.group_id as group_id,
        coalesce(c.name, cg.name, 'Uncategorized') as category,
        b.amount::text as limit_amount,
        b.source as source,
        coalesce(s.actual, 0)::text as actual,
        -- Uncategorised last, whatever it totals, the way the dashboard already
        -- ranks it: it is not a category anybody chose, so it belongs at the
        -- bottom rather than competing with the ones they did.
        (b.category_id is null) as unfiled
      from grid g
      join budgeted b on b.period_start = g.bucket_start
      left join spend s
        on s.period_start = g.bucket_start
        and s.currency = b.currency
        and s.category_id is not distinct from b.category_id
      left join category c
        on c.user_id = ${actor.userId}
        and c.id = b.category_id
      left join category_group cg
        on cg.user_id = ${actor.userId}
        and cg.id = b.group_id
      ${
        // Always read, and dropped after the groups have counted them when the
        // caller did not ask for them. A group's spending is its categories'
        // spending whether or not each category has a budget, so dropping these
        // rows in SQL made a group of half-budgeted categories report less than
        // it spent.
        sql`
      union all
      select
        g.bucket_start::text as period_start,
        g.period_end::text as period_end,
        s.currency as currency,
        s.category_id as category_id,
        null::uuid as group_id,
        coalesce(c.name, 'Uncategorized') as category,
        null as limit_amount,
        'none'::text as source,
        s.actual::text as actual,
        (s.category_id is null) as unfiled
      from grid g
      join spend s on s.period_start = g.bucket_start
      left join category c
        on c.user_id = ${actor.userId}
        and c.id = s.category_id
      where s.actual <> 0
        and not exists (
          select 1
          from budgeted b2
          where b2.period_start = s.period_start
            and b2.currency = s.currency
            and b2.group_id is null
            and b2.category_id is not distinct from s.category_id
        )`
      }
    ) rows
    -- Ordered out here rather than inside, because PostgreSQL will only sort a
    -- set operation by its own output columns and refuses an expression over
    -- one. Sorting in the query rather than the page so an agent reading this
    -- sees the same order somebody looking at the screen does.
    order by period_start, currency, unfiled, category
  `);

  const periods = new Map<string, BudgetPeriodView>();
  for (const row of result.rows) {
    const periodStart = String(row.period_start);
    const periodEnd = String(row.period_end);
    const currency = String(row.currency);
    const key = `${periodStart}:${currency}`;
    let period = periods.get(key);
    if (!period) {
      period = {
        periodStart,
        start: periodStart,
        end: periodEnd,
        // Against today, never against the end that was asked for. A July
        // requested to the 10th is still a July that finished six weeks ago,
        // and calling it "so far" says the opposite of what happened.
        partial: periodEnd > today,
        currency,
        rows: [],
        groups: [],
        budgeted: ZERO,
        spent: ZERO,
        carriedIn: ZERO,
        available: ZERO,
        income: ZERO,
        unfunded: null,
        toAssign: null,
        perimeter: ZERO,
      };
      periods.set(key, period);
    }
    const limit = row.limit_amount === null ? null : canonicalDecimal(String(row.limit_amount));
    const actual = canonicalDecimal(String(row.actual));
    if (row.group_id !== null) {
      // A group's own budget. Its spending is its categories' and is filled in
      // once they are all read, which is why this row starts at nothing rather
      // than at whatever the join found.
      period.groups.push({
        groupId: String(row.group_id),
        name: String(row.category),
        policy: "standalone",
        limit,
        actual: ZERO,
        remaining: limit,
        source: String(row.source) as BudgetGroupRow["source"],
        carriedIn: null,
        available: limit,
        carriedOut: null,
        priority: 0,
        funded: null,
      });
      continue;
    }
    period.rows.push({
      categoryId: row.category_id === null ? null : String(row.category_id),
      category: String(row.category),
      limit,
      actual,
      remaining: limit === null ? null : canonicalDecimal(decimal(limit).minus(actual)),
      source: String(row.source) as BudgetPeriodRow["source"],
      carriedIn: null,
      available: limit,
      carriedOut: null,
      priority: 0,
      funded: null,
    });
  }

  // What came in, per period and currency, from the income counter-account.
  // Read once for the whole folded range rather than per plan: a percentage of
  // income asks about the period before, and a funding order asks about this
  // one, and both are the same figure.
  const income = new Map<string, string>();
  const incomeRows = await getDb().execute(sql`
    ${withClause(archived.cte)}
    select
      date_trunc(${unit}, p.date)::date::text as period_start,
      p.currency as currency,
      (-sum(p.amount))::text as income
    from posting p
    join ledger_account a
      on a.user_id = p.user_id and a.id = p.account_id and a.system_kind = 'income'
    ${archived.join}
    where p.user_id = ${actor.userId}
      -- One period earlier than the fold's first, because a share-of-income
      -- plan's first period asks about the calendar period before it. Bounded
      -- by stepping one day back off this period's start and truncating,
      -- which is previous-period-start in every unit, including quarters,
      -- where interval arithmetic has no word for the step.
      and p.date >= date_trunc(${unit}, date_trunc(${unit}, ${queryStart}::date) - interval '1 day')::date
      and p.date <= ${countedTo}::date
      ${archived.filter}
    group by 1, 2
  `);
  for (const row of incomeRows.rows) {
    income.set(`${String(row.period_start)}:${String(row.currency)}`, String(row.income));
  }
  for (const period of periods.values()) {
    period.income = canonicalDecimal(
      income.get(`${period.periodStart}:${period.currency}`) ?? ZERO,
    );
  }

  // Which categories belong to which group, and how each group is budgeted.
  // Read once for the whole report: a group's figures are its categories' rows
  // added up, and that is arithmetic over rows this already has rather than a
  // second pass over the postings.
  const groups = await getDb()
    .select({
      id: categoryGroups.id,
      name: categoryGroups.name,
      policy: categoryGroups.policy,
    })
    .from(categoryGroups)
    .where(eq(categoryGroups.userId, actor.userId))
    .orderBy(asc(categoryGroups.name));
  const membership = new Map<string, string>();
  if (groups.length > 0) {
    const members = await getDb()
      .select({ id: categories.id, groupId: categories.groupId })
      .from(categories)
      .where(and(eq(categories.userId, actor.userId), isNotNull(categories.groupId)));
    for (const member of members) {
      if (member.groupId !== null) membership.set(member.id, member.groupId);
    }
  }

  // What the accounts the budget is about held at the end of each period.
  //
  // Everything before the grid is folded into its first bucket, so a running
  // total over the buckets is a real balance rather than a balance of the
  // window. A correlated subquery per period would have been the obvious
  // alternative and is the shape this repository prices out of its reports.
  const perimeterRows = await getDb().execute(sql`
    with grid as (${gridQuery(parsed.periodUnit, queryStart, asOf)}),
    deltas as (
      select
        greatest(date_trunc(${unit}, p.date)::date, date_trunc(${unit}, ${queryStart}::date)::date)
          as bucket,
        p.currency as currency,
        sum(p.amount) as delta
      from posting p
      join ledger_account a
        on a.user_id = p.user_id
        and a.id = p.account_id
        and a.system_kind is null
        and a.in_budget
      where p.user_id = ${actor.userId}
        and p.date <= ${countedTo}::date
      group by 1, 2
    ), currencies as (
      select distinct currency from deltas
    )
    select
      g.bucket_start::text as period_start,
      c.currency as currency,
      sum(coalesce(d.delta, 0)) over (
        partition by c.currency order by g.bucket_start
      )::text as balance
    from grid g
    cross join currencies c
    left join deltas d on d.bucket = g.bucket_start and d.currency = c.currency
  `);
  // The grid is built again here rather than shared with the report query
  // above: they are two statements, and a CTE cannot cross that boundary.
  const perimeter = new Map<string, string>();
  for (const row of perimeterRows.rows) {
    perimeter.set(`${String(row.period_start)}:${String(row.currency)}`, String(row.balance));
  }

  fillGroupRows(periods, groups, membership);
  if (!parsed.includeUnbudgeted) {
    // After the groups have counted them, because a group's spending is its
    // categories' whether or not somebody budgeted each one.
    for (const period of periods.values()) {
      period.rows = period.rows.filter((row) => row.limit !== null);
    }
  }
  foldRollover(periods, folded, carrying, parsed.periodUnit, income);
  sumChildBudgets(periods, groups, membership);
  allocateByPriority(periods);

  // What is left to assign, which is the envelope question and the last figure
  // that depends on all the others: what the perimeter holds, less what every
  // envelope with money in it has already claimed.
  //
  // Only positive envelope balances claim anything. An envelope that is
  // overspent has already taken its money out of the accounts — counting it
  // again here would take it twice.
  for (const period of periods.values()) {
    period.perimeter = canonicalDecimal(
      perimeter.get(`${period.periodStart}:${period.currency}`) ?? ZERO,
    );
    const envelopes = period.rows.filter((row) => row.carriedIn !== null);
    const groupEnvelopes = period.groups.filter((row) => row.carriedIn !== null);
    if (envelopes.length === 0 && groupEnvelopes.length === 0) continue;
    const positive = (row: { remaining: string | null }) =>
      decimal(row.remaining ?? ZERO).cmp(0) > 0 ? decimal(row.remaining ?? ZERO) : decimal(ZERO);
    let claimed = envelopes.reduce((total, row) => total.plus(positive(row)), decimal(ZERO));
    // A group's envelope claims only what its categories have not claimed
    // already. Adding both would count the same money twice: a group budget and
    // the budgets of the categories under it are two plans over one set of
    // spending, and somebody who runs both is not saying they have twice the
    // money. The same "uncovered" reading the forecast uses for budgets a
    // recurrence already pays.
    for (const group of groupEnvelopes) {
      // Only members that are themselves envelopes: a member with a
      // non-rollover budget claimed nothing above, so subtracting its
      // remaining here would net the group's claim against money nobody is
      // holding — toAssign came back overstated by exactly that amount, and
      // the page invited assigning money an envelope already held.
      const members = period.rows.filter(
        (row) =>
          row.carriedIn !== null &&
          row.categoryId !== null &&
          membership.get(row.categoryId) === group.groupId,
      );
      const byMembers = members.reduce((total, row) => total.plus(positive(row)), decimal(ZERO));
      const extra = positive(group).minus(byMembers);
      if (extra.cmp(0) > 0) claimed = claimed.plus(extra);
    }
    period.toAssign = canonicalDecimal(decimal(period.perimeter).minus(claimed));
  }

  // Totalled after the fold, because the fold is what decides three of the four
  // figures. Summing while reading the rows would have had to be undone.
  for (const period of periods.values()) {
    for (const row of period.rows) {
      if (row.limit !== null)
        period.budgeted = canonicalDecimal(decimal(period.budgeted).plus(row.limit));
      if (row.carriedIn !== null) {
        period.carriedIn = canonicalDecimal(decimal(period.carriedIn).plus(row.carriedIn));
      }
      if (row.available !== null) {
        period.available = canonicalDecimal(decimal(period.available).plus(row.available));
      }
      period.spent = canonicalDecimal(decimal(period.spent).plus(row.actual));
    }
  }

  return {
    periodUnit: parsed.periodUnit,
    start,
    asOf: countedTo,
    // Only the periods that were asked for. The earlier ones were read to work
    // out what they handed forward and are not part of the answer.
    periods: [...periods.values()].filter((period) => period.periodStart >= firstReported),
    otherPeriodUnits: await otherUnits(actor, parsed.periodUnit),
    // Null unless something in this report really carries. `carrying` also
    // holds the plans that only work out an amount or name a funding order, and
    // reporting a fold to a ledger with no envelopes in it would be answering a
    // question nobody asked.
    rollover: carrying.some((plan) => plan.rollover) ? { from: queryStart, clipped } : null,
  };
}

/**
 * What each group spent, and what a summing group is allowed.
 *
 * Two jobs, one pass over the rows that are already there. Every group gets its
 * categories' spending added up, whether or not it holds a budget: a group with
 * no budget still answers "what did this lot cost", which is most of why
 * somebody groups categories at all. A `sum_of_children` group also gets its
 * limit from those same rows, so its budget is its members' budgets by
 * construction rather than by a second figure that could disagree with them.
 *
 * A `standalone` group's limit is left alone. It came from its own plan or
 * entry, and the fold may still change it — that is what a group budget that
 * rolls over or works itself out means.
 */
/**
 * A group's history follows its current members, and that is a choice.
 *
 * Membership is a column on the category rather than a record of when it moved,
 * so moving Groceries into "Fixed costs" today changes what that group spent
 * last March. The alternative is dating the membership, which is a table and a
 * second history to keep straight for a figure nobody reconciles against
 * anything. What makes this safe is that no money moves: a group is a way of
 * reading categories, the categories' own rows are untouched, and the ledger
 * says exactly what it said before.
 */
function fillGroupRows(
  periods: Map<string, BudgetPeriodView>,
  groups: readonly { id: string; name: string; policy: BudgetGroupPolicy }[],
  membership: ReadonlyMap<string, string>,
) {
  if (groups.length === 0) return;
  for (const period of periods.values()) {
    for (const group of groups) {
      const members = period.rows.filter(
        (row) => row.categoryId !== null && membership.get(row.categoryId) === group.id,
      );
      const existing = period.groups.find((row) => row.groupId === group.id);
      // A group with no budget and no spending is not a row. Reporting one
      // would fill a page with groups somebody made for next year.
      if (members.length === 0 && !existing) continue;
      const actual = members.reduce((sum, row) => sum.plus(row.actual), decimal(ZERO));
      if (existing) {
        existing.policy = group.policy;
        existing.actual = canonicalDecimal(actual);
        existing.remaining =
          existing.limit === null ? null : canonicalDecimal(decimal(existing.limit).minus(actual));
        continue;
      }
      // A row with no limit yet. `sumChildBudgets` fills one in below for a
      // group that is its categories added up, once the fold has decided what
      // those categories are allowed.
      period.groups.push({
        groupId: group.id,
        name: group.name,
        policy: group.policy,
        limit: null,
        actual: canonicalDecimal(actual),
        remaining: null,
        source: "none",
        carriedIn: null,
        available: null,
        carriedOut: null,
        priority: 0,
        funded: null,
      });
    }
    period.groups.sort((left, right) => left.name.localeCompare(right.name));
  }
}

/**
 * What a group that is its categories added up is allowed, after the fold.
 *
 * After, and that is the whole reason this is a second pass. A member's limit
 * is not final until the fold has run: a trailing average, an incremental step
 * and a sinking fund's contribution are all worked out there, and summing
 * before it would add up the plans' stored amounts — which for three of the
 * five rules is zero. The group would have read as budgeting nothing while
 * every category under it budgeted something.
 *
 * A `standalone` group is left alone: its limit came from its own plan and the
 * fold may have changed it, which is what a group budget that rolls over means.
 */
function sumChildBudgets(
  periods: Map<string, BudgetPeriodView>,
  groups: readonly { id: string; policy: BudgetGroupPolicy }[],
  membership: ReadonlyMap<string, string>,
) {
  const summing = groups.filter((group) => group.policy === "sum_of_children");
  if (summing.length === 0) return;
  for (const period of periods.values()) {
    for (const group of summing) {
      const row = period.groups.find((candidate) => candidate.groupId === group.id);
      if (!row) continue;
      const budgeted = period.rows.filter(
        (member) =>
          member.categoryId !== null &&
          membership.get(member.categoryId) === group.id &&
          member.limit !== null,
      );
      if (budgeted.length === 0) continue;
      const limit = canonicalDecimal(
        budgeted.reduce((sum, member) => sum.plus(member.limit ?? ZERO), decimal(ZERO)),
      );
      // The available money adds up too, so a group of envelopes reports what
      // its envelopes hold rather than what they were allowed this period.
      const available = canonicalDecimal(
        budgeted.reduce(
          (sum, member) => sum.plus(member.available ?? member.limit ?? ZERO),
          decimal(ZERO),
        ),
      );
      row.limit = limit;
      row.available = available;
      row.remaining = canonicalDecimal(decimal(available).minus(row.actual));
      row.source = "sum";
    }
  }
}

/**
 * Every plan for this period unit that carries something forward.
 *
 * Read whole rather than joined into the report query, because the fold is
 * arithmetic over periods rather than over rows: which period a plan covers,
 * what a fund still needs, and where a cap bites are all questions about the
 * sequence, and SQL that answered them would be a recursive CTE nobody could
 * read for a saving nobody measured.
 */
async function rolloverPlans(actor: Actor, periodUnit: BudgetPeriodUnit) {
  return getDb()
    .select({
      categoryId: budgetPlans.categoryId,
      groupId: budgetPlans.groupId,
      currency: budgetPlans.currency,
      amount: budgetPlans.amount,
      activeFrom: budgetPlans.activeFrom,
      activeTo: budgetPlans.activeTo,
      rollover: budgetPlans.rollover,
      rolloverCap: budgetPlans.rolloverCap,
      targetAmount: budgetPlans.targetAmount,
      targetDate: budgetPlans.targetDate,
      ruleLookback: budgetPlans.ruleLookback,
      rulePercent: budgetPlans.rulePercent,
      priority: budgetPlans.priority,
      amountRule: budgetPlans.amountRule,
    })
    .from(budgetPlans)
    .where(
      and(
        eq(budgetPlans.userId, actor.userId),
        eq(budgetPlans.periodUnit, periodUnit),
        // Everything the fold has to walk period by period: a budget that
        // carries, one that works its own amount out, and one that named a
        // funding order — the last of those because the order is a property of
        // the plan and the row it lands on has to be told. A plain fixed budget
        // is answered by the report's own query and needs none of this.
        or(
          eq(budgetPlans.rollover, true),
          ne(budgetPlans.amountRule, "fixed"),
          ne(budgetPlans.priority, 0),
        ),
      ),
    );
}

type CarryingPlan = Awaited<ReturnType<typeof rolloverPlans>>[number];

/**
 * How many whole periods separate two period starts.
 *
 * Both arguments are period starts that PostgreSQL produced, so this is
 * subtraction rather than a second opinion about where a period begins — which
 * is the thing `truncatePeriod` exists to keep out of JavaScript. A week is
 * seven days whatever the calendar does; the other three are months apart.
 */
/**
 * The start of the period before this one.
 *
 * Same licence as `periodsBetween`: the argument is a period start PostgreSQL
 * produced, so stepping back is arithmetic rather than a second opinion about
 * where periods begin. A week is seven days back; the others move whole
 * months on a first-of-month date, which no month length can bend.
 */
function previousPeriodStart(unit: BudgetPeriodUnit, start: string): string {
  if (unit === "week") {
    const date = new Date(`${start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7);
    return date.toISOString().slice(0, 10);
  }
  const [year, month] = start.split("-").map(Number) as [number, number];
  const months = unit === "year" ? 12 : unit === "quarter" ? 3 : 1;
  const index = year * 12 + (month - 1) - months;
  const backYear = Math.floor(index / 12);
  const backMonth = (index % 12) + 1;
  return `${String(backYear).padStart(4, "0")}-${String(backMonth).padStart(2, "0")}-01`;
}

export function periodsBetween(unit: BudgetPeriodUnit, from: string, to: string): number {
  if (unit === "week") {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    return Math.round(days / 7);
  }
  const [fromYear, fromMonth] = from.split("-").map(Number) as [number, number, number];
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number, number];
  const months = (toYear - fromYear) * 12 + (toMonth - fromMonth);
  return unit === "year" ? months / 12 : unit === "quarter" ? months / 3 : months;
}

/**
 * The carry, folded forward one period at a time.
 *
 * The whole of rollover, sinking funds and envelopes is this loop. A period's
 * available money is its own limit plus what the period before handed it; what
 * it does not spend, it hands on; what it overspends, it hands on as a debt.
 * Nothing is stored, so turning rollover off tomorrow leaves no rows behind and
 * no figure that has to be recomputed.
 *
 * Three things it is careful about:
 *
 * A period with no active rollover plan breaks the chain rather than passing
 * the carry through it. A budget that ended in March and another that starts in
 * September are two budgets, and joining them across the gap would hand six
 * months of "unspent" to a plan that never saw them.
 *
 * A cap applies in both directions and is applied to what is handed on rather
 * than to what was available, so a period that overspends by more than the cap
 * hands forward the cap's worth of debt and no more.
 *
 * A sinking fund's own limit is worked out here rather than read from the row,
 * because it depends on the carry: what is still needed, over the periods left.
 * That is why it cannot be a column and why the fold is the only place it can
 * live.
 */
function foldRollover(
  periods: Map<string, BudgetPeriodView>,
  ordered: readonly string[],
  carrying: readonly CarryingPlan[],
  unit: BudgetPeriodUnit,
  income: ReadonlyMap<string, string>,
) {
  if (carrying.length === 0) return;
  const byTarget = new Map<string, CarryingPlan[]>();
  for (const plan of carrying) {
    // The kind is part of the key. Without it a category and a group that
    // happened to share an id would fold into each other, and more practically
    // the lookup below has to know which list to look in.
    const key =
      plan.groupId !== null
        ? `group:${plan.groupId}:${plan.currency}`
        : `category:${plan.categoryId}:${plan.currency}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), plan]);
  }

  for (const [key, plans] of byTarget) {
    const [kind, targetId, currency] = key.split(":") as ["category" | "group", string, string];
    let carry = decimal(ZERO);
    // What earlier periods of this same budget did, which is what the derived
    // rules are about: an average of what was spent, a step up from what was
    // budgeted, a share of what came in.
    const history: ReturnType<typeof decimal>[] = [];
    let previousLimit: string | null = null;
    for (const periodStart of ordered) {
      const plan = plans.find(
        (candidate) =>
          candidate.activeFrom <= periodStart &&
          (candidate.activeTo === null || candidate.activeTo >= periodStart),
      );
      if (!plan) {
        carry = decimal(ZERO);
        history.length = 0;
        previousLimit = null;
        continue;
      }
      const period = periods.get(`${periodStart}:${currency}`);
      const row: BudgetPeriodRow | BudgetGroupRow | undefined =
        kind === "group"
          ? period?.groups.find((candidate) => candidate.groupId === targetId)
          : period?.rows.find((candidate) => candidate.categoryId === targetId);
      // A period the query returned nothing for still moves the carry: a fund
      // with nothing spent and nothing budgeted keeps what it had.
      const carriedIn = plan.rollover ? canonicalDecimal(carry) : null;
      let limit = row?.limit === null || row?.limit === undefined ? ZERO : row.limit;
      // An override is an amount somebody typed for this period, and no rule
      // outranks that. Every derived rule steps aside for one.
      if (row?.source !== "entry" && plan.amountRule !== "fixed") {
        limit = derivedAmount(plan, unit, periodStart, carry, {
          history,
          income: income.get(`${periodStart}:${currency}`) ?? null,
          previousLimit,
          // Looked up per period rather than threaded through the loop: the
          // income before a period is a fact about the calendar, not about
          // this budget's history, so a plan's first period reads the real
          // period before it — the income query reaches one period earlier
          // than the fold for exactly this line. Threading it also went wrong
          // in both directions: a first period read null and budgeted
          // nothing, and a plan resuming after a gap read the last period the
          // previous plan saw, however long ago that was.
          previousIncome:
            income.get(`${previousPeriodStart(unit, periodStart)}:${currency}`) ?? null,
        });
      }
      previousLimit = limit;
      const available = plan.rollover ? decimal(limit).plus(carry) : decimal(limit);
      const actual = decimal(row?.actual ?? ZERO);
      const capped = applyCap(available.minus(actual), plan.rolloverCap);
      if (row) {
        row.carriedIn = carriedIn;
        row.limit = limit;
        row.available = canonicalDecimal(available);
        row.remaining = canonicalDecimal(available.minus(actual));
        row.carriedOut = plan.rollover ? canonicalDecimal(capped) : null;
        row.priority = plan.priority;
      }
      // What this period spent, kept for the trailing averages that will ask
      // about it a few periods from now.
      history.push(actual);
      carry = plan.rollover ? capped : decimal(ZERO);
    }
  }
}

/**
 * Who gets paid when the money that came in will not cover what was budgeted.
 *
 * The funding order, which is the whole of "pay yourself first", "priority
 * budgeting" and the half of an anti-budget that says savings come off the top.
 * Rows are filled in priority order until the period's income runs out; what is
 * left over is the shortfall, and it is reported rather than spread thinly.
 *
 * Off unless somebody set a priority, and that is the whole of the opt-in.
 * Otherwise every ledger would grow a figure saying its budgets were unfunded
 * in every period where income happened to land in a different one — which is
 * true, useless, and alarming.
 *
 * Ordered rather than sorted in SQL, because the order is a property of the
 * plans rather than of the rows: two categories at the same priority are filled
 * in the order the report already puts them in, which is by name.
 */
function allocateByPriority(periods: Map<string, BudgetPeriodView>) {
  for (const period of periods.values()) {
    // Per period rather than per report. A funding order set on a budget that
    // starts in June says nothing about March, and a report spanning both
    // should not answer for a period where nobody asked the question.
    if (!period.rows.some((row) => row.priority !== 0)) continue;
    let pool = decimal(period.income);
    let unfunded = decimal(ZERO);
    // Zero is "not ordered", and not ordered goes last. A funding order names
    // what comes first; a budget nobody ranked is not more important than the
    // one somebody deliberately put at the top, which is what sorting zero
    // first would have meant — and every budget in the ledger defaults to zero.
    const rank = (row: BudgetPeriodRow) =>
      row.priority === 0 ? Number.MAX_SAFE_INTEGER : row.priority;
    const ordered = [...period.rows]
      .filter((row) => row.limit !== null)
      .sort((left, right) => rank(left) - rank(right));
    for (const row of ordered) {
      const wanted = decimal(row.limit ?? ZERO);
      const funded = pool.cmp(wanted) >= 0 ? wanted : pool.cmp(0) > 0 ? pool : decimal(ZERO);
      row.funded = canonicalDecimal(funded);
      unfunded = unfunded.plus(wanted.minus(funded));
      pool = pool.minus(funded);
    }
    period.unfunded = canonicalDecimal(unfunded);
  }
}

/** A carry held inside its cap, in both directions, or left alone without one. */
function applyCap(carry: ReturnType<typeof decimal>, cap: string | null) {
  if (cap === null) return carry;
  const limit = decimal(cap);
  if (carry.cmp(limit) > 0) return limit;
  if (carry.cmp(limit.times(-1)) < 0) return limit.times(-1);
  return carry;
}

/**
 * What a sinking fund puts aside this period: what is still needed, over the
 * periods left to need it in.
 *
 * Nothing once the fund is full, and everything still missing once the target
 * period has arrived — a fund that is short on the day it is needed asks for
 * the shortfall rather than a share of it.
 */
/**
 * The amount a rule works out for one period.
 *
 * Four rules and one shape: each answers "what should this period budget",
 * from figures the report has already read. None of them is a mode anybody
 * picked — the row carries a lookback, a percentage or a target, and that is
 * what makes it the rule it is.
 *
 * The order they are tried in does not matter, because the constraints make
 * them mutually exclusive; the `switch` is exhaustive so a rule added later
 * fails to compile rather than falling through to a fixed amount.
 */
function derivedAmount(
  plan: CarryingPlan,
  unit: BudgetPeriodUnit,
  periodStart: string,
  carry: ReturnType<typeof decimal>,
  context: {
    history: readonly ReturnType<typeof decimal>[];
    income: string | null;
    previousLimit: string | null;
    previousIncome: string | null;
  },
): string {
  switch (plan.amountRule) {
    case "sinking_fund":
      return sinkingFundAmount(plan, unit, periodStart, carry);
    case "trailing_average": {
      // The finished periods before this one, and never this one: a period is
      // not part of its own average, or the budget would chase the spending it
      // is meant to be measuring. Fewer periods than asked for is the honest
      // answer early in a budget's life — averaging over the periods that
      // exist beats treating the ones before it started as zeroes.
      const window = context.history.slice(-(plan.ruleLookback ?? 1));
      if (window.length === 0) return canonicalDecimal(plan.amount);
      const total = window.reduce((sum, value) => sum.plus(value), decimal(ZERO));
      const average = total.div(window.length);
      // Spending is signed and a refunded period can end up negative. A budget
      // of less than nothing is not a budget, so the floor is zero.
      return average.cmp(0) <= 0 ? ZERO : canonicalDecimal(average);
    }
    case "incremental": {
      // The first period is the amount as typed. The step is what happens
      // *between* periods, so applying it to the first would budget more than
      // the number somebody put in the box that asked for the first period's
      // amount — which is what the form and the guide both promise.
      if (context.previousLimit === null) return canonicalDecimal(plan.amount);
      const step = decimal(plan.rulePercent ?? ZERO)
        .div(100)
        .plus(1);
      const next = decimal(context.previousLimit).times(step);
      return next.cmp(0) <= 0 ? ZERO : canonicalDecimal(next);
    }
    case "percent_of_income": {
      // The period before, not this one. A share of a period still running is
      // a figure that changes every time somebody looks at it, and a budget
      // that moves while you are spending against it is not a budget.
      if (context.previousIncome === null) return ZERO;
      const share = decimal(context.previousIncome).times(
        decimal(plan.rulePercent ?? ZERO).div(100),
      );
      return share.cmp(0) <= 0 ? ZERO : canonicalDecimal(share);
    }
    case "fixed":
      return canonicalDecimal(plan.amount);
  }
}

function sinkingFundAmount(
  plan: CarryingPlan,
  unit: BudgetPeriodUnit,
  periodStart: string,
  carry: ReturnType<typeof decimal>,
) {
  if (plan.targetAmount === null || plan.targetDate === null) return ZERO;
  const periodsLeft = periodsBetween(unit, periodStart, plan.targetDate) + 1;
  // Past its date, a fund asks for nothing at all. The money is either still
  // there or it was spent on the thing it was for; either way the date has gone
  // and another one is another budget. Without this a fund that was spent asked
  // for its whole target again, every period, for ever.
  if (periodsLeft <= 0) return ZERO;
  const needed = decimal(plan.targetAmount).minus(carry);
  if (needed.cmp(0) <= 0) return ZERO;
  // The period it is needed in asks for whatever is still short rather than a
  // share of it.
  if (periodsLeft === 1) return canonicalDecimal(needed);
  return canonicalDecimal(needed.div(periodsLeft));
}

/** Which other period units this person has budgets in. */
export async function otherUnits(actor: Actor, shown: BudgetPeriodUnit) {
  const result = await getDb().execute(sql`
    select distinct period_unit from budget_plan where user_id = ${actor.userId}
    union
    select distinct period_unit from budget_entry where user_id = ${actor.userId}
  `);
  return result.rows
    .map((row) => String(row.period_unit) as BudgetPeriodUnit)
    .filter((unit) => unit !== shown)
    .sort();
}
