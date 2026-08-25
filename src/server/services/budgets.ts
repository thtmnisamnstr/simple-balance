import { and, asc, eq, sql } from "drizzle-orm";
import type { Actor, BudgetPeriodUnit } from "../../shared/domain.js";
import {
  budgetEntrySetSchema,
  budgetPlanCreateSchema,
  budgetPlanUpdateSchema,
  budgetReportQuerySchema,
  MAX_REPORT_BUCKETS,
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
  /** Limit minus actual, and absent for the same reason `limit` is. */
  remaining: string | null;
  /** Where the amount came from, so a page can say whether it was overridden. */
  source: "entry" | "plan" | "none";
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
    const [created] = await tx
      .insert(budgetPlans)
      .values({
        userId: actor.userId,
        categoryId: parsed.categoryId,
        currency: parsed.currency,
        periodUnit: parsed.periodUnit,
        amount: canonicalDecimal(parsed.amount),
        activeFrom,
        activeTo,
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
    const [updated] = await tx
      .update(budgetPlans)
      .set({
        amount: parsed.amount === undefined ? before.amount : canonicalDecimal(parsed.amount),
        activeFrom,
        activeTo,
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
    };
  }

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

  const result = await getDb().execute(sql`
    ${withClause(
      archived.cte,
      sql`grid as (${gridQuery(parsed.periodUnit, start, asOf)})`,
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
          and p.date >= date_trunc(${unit}, ${start}::date)::date
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
    });
    if (limit !== null) {
      period.budgeted = canonicalDecimal(decimal(period.budgeted).plus(limit));
    }
    period.spent = canonicalDecimal(decimal(period.spent).plus(actual));
  }

  return {
    periodUnit: parsed.periodUnit,
    start,
    asOf: countedTo,
    periods: [...periods.values()],
    otherPeriodUnits: await otherUnits(actor, parsed.periodUnit),
  };
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
