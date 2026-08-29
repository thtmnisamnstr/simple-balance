import { and, asc, eq, sql } from "drizzle-orm";
import type { Actor, BudgetAmountRule, BudgetPeriodUnit } from "../../shared/domain.js";
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
  categoryId: string;
  categoryName: string;
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
  /**
   * Which arithmetic produces the amount. Derived from the row rather than
   * chosen: a plan with a target is a sinking fund because of what it says.
   */
  amountRule: BudgetAmountRule;
  version: number;
};

export type BudgetEntryView = {
  id: string;
  categoryId: string;
  categoryName: string;
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
  /** The limit plus whatever was carried in. Null when nothing rolls over. */
  available: string | null;
  /**
   * What this period hands to the next, after the cap.
   *
   * Provisional while the period is still running, for the same reason
   * `actual` is: the period has not finished spending.
   */
  carriedOut: string | null;
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
  budgeted: string;
  spent: string;
  /** Sum of what was carried into this period. Zero when nothing rolls over. */
  carriedIn: string;
  /** Sum of `available`, which is `budgeted` plus `carriedIn`. */
  available: string;
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

function planView(row: BudgetPlanRow, categoryName: string): BudgetPlanView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName,
    currency: row.currency,
    periodUnit: row.periodUnit,
    amount: canonicalDecimal(row.amount),
    activeFrom: row.activeFrom,
    activeTo: row.activeTo,
    rollover: row.rollover,
    rolloverCap: row.rolloverCap === null ? null : canonicalDecimal(row.rolloverCap),
    targetAmount: row.targetAmount === null ? null : canonicalDecimal(row.targetAmount),
    targetDate: row.targetDate,
    amountRule: row.amountRule,
    version: row.version,
  };
}

function entryView(row: BudgetEntryRow, categoryName: string): BudgetEntryView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName,
    currency: row.currency,
    periodUnit: row.periodUnit,
    periodStart: row.periodStart,
    amount: canonicalDecimal(row.amount),
    version: row.version,
  };
}

/**
 * The category exists, belongs to this person, and can carry spending.
 *
 * An archived category may still be budgeted, because archiving hides it from
 * pickers rather than erasing what it did, and a budget report covering last
 * March has to be able to name it. What is refused is budgeting a category that
 * only ever carries income: a limit on it would compare a cap against a figure
 * that never moves.
 */
async function requireBudgetableCategory(tx: DbTransaction, actor: Actor, categoryId: string) {
  const [category] = await tx
    .select({ id: categories.id, name: categories.name, kind: categories.kind })
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.userId, actor.userId)))
    .limit(1);
  if (!category) throw notFound("Category not found");
  if (category.kind === "income") {
    throw validationError(
      "An income category has no spending to budget. Budget an expense category, or widen this one to both.",
    );
  }
  return category;
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
    categoryId: string;
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
        eq(budgetPlans.categoryId, target.categoryId),
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
        ? `That category's budget already starts on ${clash.activeFrom}, which is this period or later. Change that budget's amount instead, or set an amount for one period only.`
        : `Another budget for this category already covers the period starting ${clash.activeFrom}${
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

export async function listBudgetPlans(actor: Actor) {
  const rows = await getDb()
    .select({ plan: budgetPlans, categoryName: categories.name })
    .from(budgetPlans)
    .innerJoin(
      categories,
      and(eq(categories.userId, budgetPlans.userId), eq(categories.id, budgetPlans.categoryId)),
    )
    .where(eq(budgetPlans.userId, actor.userId))
    .orderBy(asc(categories.name), asc(budgetPlans.activeFrom));
  return rows.map((row) => planView(row.plan, row.categoryName));
}

export async function getBudgetPlan(actor: Actor, id: string) {
  const [row] = await getDb()
    .select({ plan: budgetPlans, categoryName: categories.name })
    .from(budgetPlans)
    .innerJoin(
      categories,
      and(eq(categories.userId, budgetPlans.userId), eq(categories.id, budgetPlans.categoryId)),
    )
    .where(and(eq(budgetPlans.id, id), eq(budgetPlans.userId, actor.userId)))
    .limit(1);
  if (!row) throw notFound("Budget not found");
  return planView(row.plan, row.categoryName);
}

export async function createBudgetPlan(actor: Actor, input: unknown, transaction?: DbTransaction) {
  const parsed = budgetPlanCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await lockCategoryNamespace(tx, actor);
    const category = await requireBudgetableCategory(tx, actor, parsed.categoryId);
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
      amount: parsed.amount,
    });
    const [created] = await tx
      .insert(budgetPlans)
      .values({
        userId: actor.userId,
        categoryId: parsed.categoryId,
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
    return planView(created, category.name);
  });
}

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
    const category = await requireBudgetableCategory(tx, actor, before.categoryId);
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
      amount: parsed.amount === undefined ? before.amount : parsed.amount,
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
    return planView(updated, category.name);
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
    amount: string;
  },
) {
  const isFund = input.targetAmount !== null;
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
  if (!input.rollover && input.rolloverCap !== null) {
    throw validationError(
      "A carry cap only means something when rollover is on, and this budget does not carry anything forward.",
    );
  }
  const amountRule: BudgetAmountRule = isFund ? "sinking_fund" : "fixed";
  return {
    amount: canonicalDecimal(input.amount),
    columns: {
      rollover: input.rollover,
      rolloverCap: input.rolloverCap === null ? null : canonicalDecimal(input.rolloverCap),
      targetAmount: input.targetAmount === null ? null : canonicalDecimal(input.targetAmount),
      targetDate,
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
    const category = await requireBudgetableCategory(tx, actor, parsed.categoryId);
    const periodStart = await truncatePeriod(tx, parsed.periodUnit, parsed.periodStart);
    const [before] = await tx
      .select()
      .from(budgetEntries)
      .where(
        and(
          eq(budgetEntries.userId, actor.userId),
          eq(budgetEntries.categoryId, parsed.categoryId),
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
          categoryId: parsed.categoryId,
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
      return entryView(created, category.name);
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
    return entryView(updated, category.name);
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
    .select({ entry: budgetEntries, categoryName: categories.name })
    .from(budgetEntries)
    .innerJoin(
      categories,
      and(eq(categories.userId, budgetEntries.userId), eq(categories.id, budgetEntries.categoryId)),
    )
    .where(eq(budgetEntries.userId, actor.userId))
    .orderBy(asc(budgetEntries.periodStart), asc(categories.name));
  return rows.map((row) => entryView(row.entry, row.categoryName));
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
      sql`budgeted as (
        select
          g.bucket_start as period_start,
          b.category_id,
          b.currency,
          b.amount,
          b.source
        from grid g
        join lateral (
          select e.category_id, e.currency, e.amount, 'entry'::text as source
          from budget_entry e
          where e.user_id = ${actor.userId}
            and e.period_unit = ${parsed.periodUnit}
            and e.period_start = g.bucket_start
          union all
          select pl.category_id, pl.currency, pl.amount, 'plan'::text as source
          from budget_plan pl
          where pl.user_id = ${actor.userId}
            and pl.period_unit = ${parsed.periodUnit}
            and pl.active_from <= g.bucket_start
            and (pl.active_to is null or pl.active_to >= g.bucket_start)
            and not exists (
              select 1
              from budget_entry e2
              where e2.user_id = pl.user_id
                and e2.category_id = pl.category_id
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
        coalesce(c.name, 'Uncategorized') as category,
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
      ${
        parsed.includeUnbudgeted
          ? sql`
      union all
      select
        g.bucket_start::text as period_start,
        g.period_end::text as period_end,
        s.currency as currency,
        s.category_id as category_id,
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
            and b2.category_id is not distinct from s.category_id
        )`
          : sql.empty()
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
        budgeted: ZERO,
        spent: ZERO,
        carriedIn: ZERO,
        available: ZERO,
      };
      periods.set(key, period);
    }
    const limit = row.limit_amount === null ? null : canonicalDecimal(String(row.limit_amount));
    const actual = canonicalDecimal(String(row.actual));
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
    });
  }

  foldRollover(periods, folded, carrying, parsed.periodUnit);

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
    rollover: carrying.length === 0 ? null : { from: queryStart, clipped },
  };
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
      currency: budgetPlans.currency,
      activeFrom: budgetPlans.activeFrom,
      activeTo: budgetPlans.activeTo,
      rolloverCap: budgetPlans.rolloverCap,
      targetAmount: budgetPlans.targetAmount,
      targetDate: budgetPlans.targetDate,
      amountRule: budgetPlans.amountRule,
    })
    .from(budgetPlans)
    .where(
      and(
        eq(budgetPlans.userId, actor.userId),
        eq(budgetPlans.periodUnit, periodUnit),
        eq(budgetPlans.rollover, true),
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
function periodsBetween(unit: BudgetPeriodUnit, from: string, to: string): number {
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
) {
  if (carrying.length === 0) return;
  const byTarget = new Map<string, CarryingPlan[]>();
  for (const plan of carrying) {
    const key = `${plan.categoryId}:${plan.currency}`;
    byTarget.set(key, [...(byTarget.get(key) ?? []), plan]);
  }

  for (const [key, plans] of byTarget) {
    const [categoryId, currency] = key.split(":") as [string, string];
    let carry = decimal(ZERO);
    for (const periodStart of ordered) {
      const plan = plans.find(
        (candidate) =>
          candidate.activeFrom <= periodStart &&
          (candidate.activeTo === null || candidate.activeTo >= periodStart),
      );
      if (!plan) {
        carry = decimal(ZERO);
        continue;
      }
      const period = periods.get(`${periodStart}:${currency}`);
      const row = period?.rows.find((candidate) => candidate.categoryId === categoryId);
      // A period the query returned nothing for still moves the carry: a fund
      // with nothing spent and nothing budgeted keeps what it had.
      const carriedIn = canonicalDecimal(carry);
      let limit = row?.limit === null || row?.limit === undefined ? ZERO : row.limit;
      if (plan.amountRule === "sinking_fund" && row?.source !== "entry") {
        limit = sinkingFundAmount(plan, unit, periodStart, carry);
      }
      const available = decimal(limit).plus(carry);
      const actual = decimal(row?.actual ?? ZERO);
      const capped = applyCap(available.minus(actual), plan.rolloverCap);
      if (row) {
        row.carriedIn = carriedIn;
        row.limit = limit;
        row.available = canonicalDecimal(available);
        row.remaining = canonicalDecimal(available.minus(actual));
        row.carriedOut = canonicalDecimal(capped);
      }
      carry = capped;
    }
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
function sinkingFundAmount(
  plan: CarryingPlan,
  unit: BudgetPeriodUnit,
  periodStart: string,
  carry: ReturnType<typeof decimal>,
) {
  if (plan.targetAmount === null || plan.targetDate === null) return ZERO;
  const needed = decimal(plan.targetAmount).minus(carry);
  if (needed.cmp(0) <= 0) return ZERO;
  const periodsLeft = periodsBetween(unit, periodStart, plan.targetDate) + 1;
  if (periodsLeft <= 1) return canonicalDecimal(needed);
  return canonicalDecimal(needed.div(periodsLeft));
}

/** Which other period units this person has budgets in. */
async function otherUnits(actor: Actor, shown: BudgetPeriodUnit) {
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
