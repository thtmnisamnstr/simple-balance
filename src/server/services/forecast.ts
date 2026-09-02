import { and, eq, sql } from "drizzle-orm";
import type { Actor, BudgetPeriodUnit, RecurrenceShape } from "../../shared/domain.js";
import { forecastQuerySchema, MAX_FORECAST_PERIODS } from "../../shared/domain.js";
import { occurrencesBetween, todayIn } from "../../shared/recurrence-dates.js";
import { getDb } from "../db/client.js";
import {
  budgetPlans,
  categories,
  categoryGroups,
  ledgerAccounts,
  recurrences,
} from "../db/schema.js";
import { otherUnits, periodsBetween } from "./budgets.js";
import { canonicalDecimal, decimal } from "./helpers.js";
import { getPreferences } from "./preferences.js";
import { ruleOf } from "./recurrences.js";
import { gridQuery, PERIOD_UNITS } from "./report-sql.js";

/**
 * What the balances do next, if nothing changes.
 *
 * **Nothing here is a balance, a report total, or a line of the trial balance,
 * and nothing here may ever become one.** Money dated in the future has not
 * moved: it is not in a posting, it is not in a balance, and a figure that
 * crossed from this file into one of those would make the ledger claim
 * something happened because somebody expected it to. That is the invariant
 * this story is at risk of, so the vocabulary is its own — `projected`,
 * `expected`, `openingBalance` — and `tests/forecast-boundary.test.ts` holds
 * the boundary rather than a paragraph asking nicely.
 *
 * Two sources, and they are kept apart on purpose. A recurrence is a dated
 * intention with an amount, so it projects directly. A budget is what a period
 * intends to spend, which overlaps whatever recurrences already cover —
 * counting both would spend the rent twice. So the projection uses recurrences,
 * and the budgets are reported beside them; `basis: "recurring_and_budgets"`
 * adds only the part of each category's budget that its recurrences do not
 * already account for.
 */

export type ForecastPeriod = {
  periodStart: string;
  start: string;
  end: string;
  /** What the accounts held when the projection started, for the first period. */
  openingBalance: string;
  expectedIncome: string;
  expectedSpending: string;
  /**
   * What budgets intend for this period, whether or not the projection uses it.
   *
   * Reported either way because it is the other half of the question: a period
   * whose budgets are far larger than its recurrences is a period where the
   * projected balance is optimistic, and only this figure says so.
   */
  budgetedSpending: string;
  /** The part of `budgetedSpending` no recurrence in the same category covers. */
  uncoveredBudget: string;
  /** Opening plus income less whatever the basis counts as spending. */
  projectedBalance: string;
  /** How many recurrence occurrences fall in this period. */
  occurrences: number;
};

export type ForecastCurrency = {
  currency: string;
  openingBalance: string;
  periods: ForecastPeriod[];
};

export type ForecastView = {
  /** The day the projection starts from, which is today where this person lives. */
  from: string;
  periodUnit: BudgetPeriodUnit;
  basis: "recurring" | "recurring_and_budgets";
  currencies: ForecastCurrency[];
  /**
   * What could not be projected, and why.
   *
   * Recurrences and budgets both land here, and for the same reason: each is a
   * real intention with no figure a projection can use. A recurrence with no
   * amount proposes a row for somebody to fill in; a budget whose amount is an
   * average or a share works it out from periods that have not happened.
   * Counting either as nothing would quietly flatter every period it falls in,
   * so they are named instead.
   */
  unprojectable: { id: string; name: string; reason: string }[];
  /**
   * Period units this person budgets in that the projection did not read.
   *
   * The budget report grew the same field for the same reason: a reply that
   * counts monthly plans and says nothing about the weekly ones reads as
   * "nothing is intended", which is a wrong answer given confidently. Naming
   * the units is what turns it back into an answer about what was asked.
   */
  otherPeriodUnits: BudgetPeriodUnit[];
};

const ZERO = "0";

/** The amount one occurrence moves, or null when the schedule does not say. */
function amountOf(shape: RecurrenceShape): string | null {
  const withAmount = shape as RecurrenceShape & { amount?: string; legs?: { amount: string }[] };
  if (withAmount.amount !== undefined) return withAmount.amount;
  // A split names its total in its legs, and the legs are the only place it
  // exists: the shape carries no total of its own, on purpose, because a total
  // beside the legs is a second answer to what the entry is worth.
  if (Array.isArray(withAmount.legs) && withAmount.legs.length > 0) {
    return canonicalDecimal(
      withAmount.legs.reduce((total, leg) => total.plus(leg.amount), decimal(ZERO)),
    );
  }
  return null;
}

export async function getForecast(actor: Actor, input: unknown): Promise<ForecastView> {
  const parsed = forecastQuerySchema.parse(input);
  const { timezone } = await getPreferences(actor);
  const from = todayIn(timezone);
  const unit = PERIOD_UNITS[parsed.periodUnit];

  // The periods being projected, on the same grid every other report uses, so a
  // forecast month and a budget month are the same month.
  const gridRows = await getDb().execute(sql`
    ${gridQuery(parsed.periodUnit, from, from)}
  `);
  const firstBucket = String(gridRows.rows[0]?.bucket_start ?? from);
  // The horizon, stepped by PostgreSQL rather than by JavaScript, for the same
  // reason every other period boundary in this product is: the start of an ISO
  // week is a different function in the two languages, and a forecast whose
  // weeks began on a different Monday from the budget's would be unreadable.
  //
  // `quarter` is the one unit `interval` will not parse, so a quarter is three
  // months here. `date_trunc` knows the word and interval arithmetic does not.
  const interval = parsed.periodUnit === "quarter" ? "month" : parsed.periodUnit;
  const multiple = parsed.periodUnit === "quarter" ? 3 : 1;
  const step = sql`((${multiple} * n) || ' ${sql.raw(interval)}')`;
  const nextStep = sql`((${multiple} * (n + 1)) || ' ${sql.raw(interval)}')`;
  const horizon = await getDb().execute(sql`
    select
      (date_trunc(${unit}, ${firstBucket}::date) + (${step})::interval)::date as bucket_start,
      (date_trunc(${unit}, ${firstBucket}::date) + (${nextStep})::interval
        - interval '1 day')::date as period_end
    from generate_series(0, ${parsed.periods - 1}) as n
  `);
  const periods = horizon.rows.map((row) => ({
    start: String(row.bucket_start),
    end: String(row.period_end),
  }));
  const through = periods.at(-1)?.end ?? from;

  // What this period has already spent, by category, so the first period's
  // budget is not subtracted twice.
  //
  // The projection starts from today's balance, which already reflects what the
  // month has spent so far. Taking the whole of the month's budget off that
  // again would count the shopping that has already happened twice, and the
  // first period is the one every reader looks at.
  const spentThisPeriod = new Map<string, string>();
  const firstPeriod = periods[0];
  if (firstPeriod) {
    const rows = await getDb().execute(sql`
      select
        case when p.leg_id is not null then l.category_id else t.category_id end as category_id,
        p.currency as currency,
        sum(p.amount)::text as spent
      from posting p
      join ledger_account a
        on a.user_id = p.user_id and a.id = p.account_id and a.system_kind = 'expense'
      left join transaction_leg l on l.user_id = p.user_id and l.id = p.leg_id
      left join ledger_transaction t
        on p.leg_id is null and t.user_id = p.user_id and t.id = p.transaction_id
      where p.user_id = ${actor.userId}
        and p.date >= ${firstPeriod.start}::date
        and p.date <= ${from}::date
      group by 1, 2
    `);
    for (const row of rows.rows) {
      if (row.category_id === null) continue;
      spentThisPeriod.set(`${String(row.currency)}:${String(row.category_id)}`, String(row.spent));
    }
  }

  // What each account holds now, by currency. Archived accounts are closed out
  // to zero by their own postings, so they contribute nothing and need no
  // filtering — the same property every other total here relies on.
  const balances = await getDb().execute(sql`
    select a.currency as currency, coalesce(sum(p.amount), 0)::text as balance
    from ledger_account a
    left join posting p
      on p.user_id = a.user_id and p.account_id = a.id and p.date <= ${from}::date
    where a.user_id = ${actor.userId} and a.system_kind is null
    group by a.currency
  `);

  const active = await getDb()
    .select({
      id: recurrences.id,
      name: recurrences.name,
      shape: recurrences.shape,
      frequency: recurrences.frequency,
      interval: recurrences.interval,
      anchorDate: recurrences.anchorDate,
      monthPolicy: recurrences.monthPolicy,
      weekendPolicy: recurrences.weekendPolicy,
      positionOrdinal: recurrences.positionOrdinal,
      positionWeekday: recurrences.positionWeekday,
    })
    .from(recurrences)
    // Every recurrence this person has. A recurrence in this product runs until
    // it is deleted: there is no end date and no pause, so there is nothing to
    // filter and nothing to forget to filter.
    .where(eq(recurrences.userId, actor.userId));

  const accountCurrency = new Map<string, string>(
    (
      await getDb()
        .select({ id: ledgerAccounts.id, currency: ledgerAccounts.currency })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.userId, actor.userId))
    ).map((row) => [row.id, row.currency]),
  );

  type Bucket = { income: string; spending: string; occurrences: number };
  const byCurrency = new Map<string, Map<string, Bucket>>();
  const bucketFor = (currency: string, periodStart: string) => {
    const periodsOf = byCurrency.get(currency) ?? new Map<string, Bucket>();
    byCurrency.set(currency, periodsOf);
    const bucket = periodsOf.get(periodStart) ?? { income: ZERO, spending: ZERO, occurrences: 0 };
    periodsOf.set(periodStart, bucket);
    return bucket;
  };
  const periodOf = (date: string) =>
    periods.find((period) => date >= period.start && date <= period.end)?.start;

  const unprojectable: ForecastView["unprojectable"] = [];
  const spendingByCategory = new Map<string, string>();
  for (const row of active) {
    const shape = row.shape as RecurrenceShape;
    const amount = amountOf(shape);
    if (amount === null) {
      unprojectable.push({
        id: row.id,
        name: row.name,
        reason: "It has no amount, so every occurrence proposes a row for somebody to fill in.",
      });
      continue;
    }
    // Never before today: a forecast is about what has not happened yet, and
    // what has is in the postings already.
    // A ceiling on how many occurrences one recurrence contributes. Daily over
    // two years of months is 730, so the bound is generous — and a schedule
    // that hits it is reported rather than quietly cut short, because a
    // projection missing its last months looks exactly like one with nothing
    // scheduled in them.
    const ceiling = MAX_FORECAST_PERIODS * 40;
    const occurrences = occurrencesBetween(
      // `ruleOf` reads the six schedule columns and nothing else, so the narrow
      // row this query selects is all it needs. The cast says that rather than
      // widening the query to columns no projection reads.
      ruleOf(row as Parameters<typeof ruleOf>[0]),
      from,
      through,
      ceiling,
    );
    if (occurrences.length === ceiling) {
      unprojectable.push({
        id: row.id,
        name: row.name,
        reason: `It has more than ${ceiling} occurrences in this window, so the projection stops counting it partway and the later periods are short by whatever it would have added.`,
      });
    }
    for (const occurrence of occurrences) {
      // A weekend policy can push a posted date to null — "skip" means this
      // occurrence does not happen at all — and a projection of a date that is
      // not there would be a figure nobody expects.
      if (occurrence.postedDate === null) continue;
      const periodStart = periodOf(occurrence.postedDate);
      if (periodStart === undefined) continue;
      const source = (shape as { fromAccountId?: string }).fromAccountId;
      const destination = (shape as { toAccountId?: string }).toAccountId;
      if (shape.type === "deposit" && destination) {
        const currency = accountCurrency.get(destination);
        if (!currency) continue;
        const bucket = bucketFor(currency, periodStart);
        bucket.income = canonicalDecimal(decimal(bucket.income).plus(amount));
        bucket.occurrences += 1;
      } else if (shape.type === "withdrawal" && source) {
        const currency = accountCurrency.get(source);
        if (!currency) continue;
        const bucket = bucketFor(currency, periodStart);
        bucket.spending = canonicalDecimal(decimal(bucket.spending).plus(amount));
        bucket.occurrences += 1;
        // A split names its categories on its legs and carries none of its
        // own, so reading `categoryId` alone attributed a split recurrence to
        // nothing — and a budget it pays every month then counted as entirely
        // uncovered, spending the same money twice under the pessimistic basis.
        const legs = (shape as { legs?: { categoryId?: string; amount: string }[] }).legs ?? [];
        const attributions =
          legs.length > 0
            ? legs.map((leg) => ({ categoryId: leg.categoryId, amount: leg.amount }))
            : [{ categoryId: (shape as { categoryId?: string }).categoryId, amount }];
        for (const attribution of attributions) {
          if (!attribution.categoryId) continue;
          const key = `${currency}:${periodStart}:${attribution.categoryId}`;
          spendingByCategory.set(
            key,
            canonicalDecimal(decimal(spendingByCategory.get(key) ?? ZERO).plus(attribution.amount)),
          );
        }
      } else if (shape.type === "transfer" && source && destination) {
        // A transfer between two accounts in one currency changes no total in
        // that currency, so it is counted nowhere. Across currencies it leaves
        // one and arrives in the other, and the destination amount is the
        // schedule's own rate rather than a rate this ledger invents.
        const sourceCurrency = accountCurrency.get(source);
        const destinationCurrency = accountCurrency.get(destination);
        if (!sourceCurrency || !destinationCurrency) continue;
        if (sourceCurrency === destinationCurrency) continue;
        const destinationAmount = (shape as { destinationAmount?: string }).destinationAmount;
        if (destinationAmount === undefined) {
          unprojectable.push({
            id: row.id,
            name: row.name,
            reason:
              "It moves money between two currencies without saying what arrives, so no projection can say what the other side gains.",
          });
          continue;
        }
        const out = bucketFor(sourceCurrency, periodStart);
        out.spending = canonicalDecimal(decimal(out.spending).plus(amount));
        out.occurrences += 1;
        const into = bucketFor(destinationCurrency, periodStart);
        into.income = canonicalDecimal(decimal(into.income).plus(destinationAmount));
        // The arrival is the same occurrence seen from the other currency.
        // Without this a ledger whose only recurrence is a cross-currency
        // transfer showed every destination period with income and
        // `occurrences: 0` — projected money with nothing to explain it.
        into.occurrences += 1;
      }
    }
  }

  // What the budgets intend for each period, per currency, from the plans alone.
  //
  // Only the plans whose amount is the number on them. A trailing average, a
  // share of income and a sinking fund all work their figure out from periods
  // that have not happened, so a projection of one would be a projection of a
  // projection — and their stored amount is zero, which would have quietly
  // reported them as intending nothing. They are counted in `unprojectable`
  // instead, so the reply says the budgeted figure is short rather than
  // implying it is complete.
  const plans = await getDb()
    .select({
      id: budgetPlans.id,
      categoryId: budgetPlans.categoryId,
      categoryName: categories.name,
      groupName: categoryGroups.name,
      currency: budgetPlans.currency,
      amount: budgetPlans.amount,
      amountRule: budgetPlans.amountRule,
      rulePercent: budgetPlans.rulePercent,
      periodUnit: budgetPlans.periodUnit,
      activeFrom: budgetPlans.activeFrom,
      activeTo: budgetPlans.activeTo,
    })
    .from(budgetPlans)
    .where(and(eq(budgetPlans.userId, actor.userId), eq(budgetPlans.periodUnit, parsed.periodUnit)))
    .leftJoin(categories, eq(categories.id, budgetPlans.categoryId))
    .leftJoin(categoryGroups, eq(categoryGroups.id, budgetPlans.groupId));

  for (const plan of plans) {
    if (plan.amountRule === "fixed" || plan.amountRule === "incremental") continue;
    if (plan.activeTo !== null && plan.activeTo < firstBucket) continue;
    unprojectable.push({
      id: plan.id,
      name: plan.categoryName ?? plan.groupName ?? "A budget",
      reason:
        "Its amount is worked out from periods that have not happened yet, so no projection can say what it intends.",
    });
  }

  const currencies = new Set<string>([
    ...balances.rows.map((row) => String(row.currency)),
    ...byCurrency.keys(),
    ...plans.map((plan) => plan.currency),
  ]);

  const result: ForecastCurrency[] = [];
  for (const currency of [...currencies].sort()) {
    const opening = String(
      balances.rows.find((row) => String(row.currency) === currency)?.balance ?? ZERO,
    );
    let running = decimal(opening);
    const rows: ForecastPeriod[] = [];
    for (const period of periods) {
      const bucket = byCurrency.get(currency)?.get(period.start) ?? {
        income: ZERO,
        spending: ZERO,
        occurrences: 0,
      };
      let budgeted = decimal(ZERO);
      let uncovered = decimal(ZERO);
      for (const plan of plans) {
        if (plan.currency !== currency) continue;
        if (plan.amountRule !== "fixed" && plan.amountRule !== "incremental") continue;
        // A group's budget is a second plan over its categories' spending, and
        // the budget report reports it beside them rather than among them for
        // the same reason: adding both would intend the same money twice.
        if (plan.categoryId === null) continue;
        if (plan.activeFrom > period.start) continue;
        if (plan.activeTo !== null && plan.activeTo < period.start) continue;
        // An incremental plan's stored amount is only its first period's; the
        // report compounds the step from there, so the projection has to
        // compound it the same way or the two surfaces answer one month with
        // two figures — and the projection's error grows every period. No
        // override chain exists out here in the future, so the closed form
        // over the period count is exactly the report's fold.
        const intended =
          plan.amountRule === "incremental"
            ? decimal(plan.amount).times(
                decimal("1")
                  .plus(decimal(plan.rulePercent ?? ZERO).div(100))
                  .pow(periodsBetween(parsed.periodUnit, plan.activeFrom, period.start)),
              )
            : decimal(plan.amount);
        budgeted = budgeted.plus(intended);
        // What a recurrence already accounts for, plus — in the period that
        // has already started — what this category has already spent out of
        // its budget, which today's balance has already been reduced by.
        const covered = decimal(
          spendingByCategory.get(`${currency}:${period.start}:${plan.categoryId}`) ?? ZERO,
        ).plus(
          period.start === firstPeriod?.start
            ? (spentThisPeriod.get(`${currency}:${plan.categoryId}`) ?? ZERO)
            : ZERO,
        );
        const gap = intended.minus(covered);
        if (gap.cmp(0) > 0) uncovered = uncovered.plus(gap);
      }
      const spending = decimal(bucket.spending).plus(
        parsed.basis === "recurring_and_budgets" ? uncovered : decimal(ZERO),
      );
      const openingBalance = canonicalDecimal(running);
      running = running.plus(bucket.income).minus(spending);
      rows.push({
        periodStart: period.start,
        start: period.start,
        end: period.end,
        openingBalance,
        expectedIncome: bucket.income,
        expectedSpending: canonicalDecimal(spending),
        budgetedSpending: canonicalDecimal(budgeted),
        uncoveredBudget: canonicalDecimal(uncovered),
        projectedBalance: canonicalDecimal(running),
        occurrences: bucket.occurrences,
      });
    }
    result.push({ currency, openingBalance: canonicalDecimal(opening), periods: rows });
  }

  return {
    from,
    periodUnit: parsed.periodUnit,
    basis: parsed.basis,
    currencies: result,
    // One entry per recurrence, however many reasons it gave.
    unprojectable: unprojectable.filter(
      (entry, index) => unprojectable.findIndex((other) => other.id === entry.id) === index,
    ),
    otherPeriodUnits: await otherUnits(actor, parsed.periodUnit),
  };
}
