import { and, eq, sql } from "drizzle-orm";
import type { Actor, BudgetPeriodUnit, RecurrenceShape } from "../../shared/domain.js";
import { forecastQuerySchema, MAX_FORECAST_PERIODS } from "../../shared/domain.js";
import { occurrencesBetween, todayIn } from "../../shared/recurrence-dates.js";
import { getDb } from "../db/client.js";
import { budgetPlans, categories, ledgerAccounts, recurrences } from "../db/schema.js";
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
   * Recurrences that could not be projected, and why.
   *
   * A recurrence with no amount proposes a row for somebody to fill in, so it
   * is a real schedule with no figure — projecting it as nothing would quietly
   * flatter every period it falls in.
   */
  unprojectable: { id: string; name: string; reason: string }[];
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
    const occurrences = occurrencesBetween(
      // `ruleOf` reads the six schedule columns and nothing else, so the narrow
      // row this query selects is all it needs. The cast says that rather than
      // widening the query to columns no projection reads.
      ruleOf(row as Parameters<typeof ruleOf>[0]),
      from,
      through,
      MAX_FORECAST_PERIODS * 40,
    );
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
        const categoryId = (shape as { categoryId?: string }).categoryId;
        if (categoryId) {
          const key = `${currency}:${periodStart}:${categoryId}`;
          spendingByCategory.set(
            key,
            canonicalDecimal(decimal(spendingByCategory.get(key) ?? ZERO).plus(amount)),
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
      }
    }
  }

  // What the budgets intend for each period, per currency, from the plans alone.
  // A derived amount is not resolved here: it depends on periods that have not
  // happened, and a forecast that guessed at one would be a projection of a
  // projection. Those plans contribute their stored amount, which for a fund or
  // an average is zero, and the page says the figure is what the plans say.
  const plans = await getDb()
    .select({
      categoryId: budgetPlans.categoryId,
      currency: budgetPlans.currency,
      amount: budgetPlans.amount,
      periodUnit: budgetPlans.periodUnit,
      activeFrom: budgetPlans.activeFrom,
      activeTo: budgetPlans.activeTo,
    })
    .from(budgetPlans)
    .where(and(eq(budgetPlans.userId, actor.userId), eq(budgetPlans.periodUnit, parsed.periodUnit)))
    .leftJoin(categories, eq(categories.id, budgetPlans.categoryId));

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
        if (plan.activeFrom > period.start) continue;
        if (plan.activeTo !== null && plan.activeTo < period.start) continue;
        budgeted = budgeted.plus(plan.amount);
        // A group budget covers no single category, so nothing it holds can be
        // said to be already covered by a recurrence. Its whole amount is
        // uncovered, which is the safe direction: the pessimistic basis stays
        // pessimistic.
        const covered = decimal(
          plan.categoryId === null
            ? ZERO
            : (spendingByCategory.get(`${currency}:${period.start}:${plan.categoryId}`) ?? ZERO),
        );
        const gap = decimal(plan.amount).minus(covered);
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
  };
}
