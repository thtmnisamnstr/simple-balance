import type { BudgetPeriodUnitName, BudgetReportRow } from "./api.js";
import { compareMoney, formatDate, isNegativeMoney, moneyFromUnits, moneyUnits } from "./money.js";

/**
 * How a budget figure is described, for the two pages that describe one.
 *
 * These were private to the budgets page until the overview grew a panel
 * saying where the budget stands. Two copies of "is this over, nearly there or
 * fine" is two answers to one question, and the one people would notice is the
 * dashboard calling a category fine while the budgets page calls it over.
 */

/**
 * The period a stored date names, written the way somebody would say it.
 *
 * Both ends of a window are stored as the first day of a period, so printing
 * one raw says "to 1 June" about a budget that covers all of June, and a budget
 * covering exactly one month reads as a single day. The date is right; it is
 * the name of a period rather than a boundary, so it is rendered as one.
 */
export function periodName(unit: BudgetPeriodUnitName, isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const at = new Date(Date.UTC(year!, month! - 1, day!));
  const month_ = at.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  if (unit === "month") return month_;
  if (unit === "year") return String(year);
  if (unit === "quarter") return `Q${Math.floor((month! - 1) / 3) + 1} ${year}`;
  return `week of ${formatDate(isoDate)}`;
}

/**
 * How far through a limit the spending has got, as a width.
 *
 * Clamped at a hundred, because a bar that runs off the panel says less than
 * one that is full beside a number saying how far over. The number is always
 * there and is what anybody reads; the bar is the glance.
 */
export function fillPercent(limit: string, actual: string) {
  // Scaled units rather than Number, because these are money. The float only
  // appears at the very end, where the answer is a CSS width and lossiness is
  // the same lossiness a pixel already is. `moneyRatioPercent` is the wrong
  // helper here: it floors at four percent so a chart bar stays visible, and a
  // budget nobody has spent against must read as nothing, not as a sliver.
  const cap = moneyUnits(limit);
  const spent = moneyUnits(actual);
  if (spent === null || spent <= 0n) return 0;
  if (cap === null || cap <= 0n) return 100;
  const hundredths = (spent * 10_000n) / cap;
  return Math.min(100, Number(hundredths) / 100);
}

/**
 * What the row is doing, as a word.
 *
 * A word rather than only a colour, because colour alone fails anybody who
 * cannot separate the two and it fails everybody in a printout. The bar takes
 * its colour from this, so the two can never disagree.
 */
export function rowState(row: BudgetReportRow, partial = false) {
  if (row.limit === null || row.remaining === null) return "unbudgeted" as const;
  // Compared as money rather than as floats. Which side of a limit somebody is
  // on is a decision, and eighteen fractional digits do not survive a float.
  if (isNegativeMoney(row.remaining)) return "over" as const;
  // Spent exactly the limit is neither over nor nearly there. Saying "nearly"
  // to somebody who has spent all of it is the sort of small wrongness that
  // makes a person stop trusting the rest of the page.
  if (compareMoney(row.remaining, "0") === 0) return "spent" as const;
  // While a period is still running, "within budget" is a claim about a month
  // that has not finished. Over is still over, and spent is still spent, but
  // there is nothing to say yet about the rest.
  if (partial) return "running" as const;
  // Against what there was to spend, which for an envelope is its limit plus
  // what it carried in. `remaining` already counts the carry, so a bar drawn
  // against the bare limit disagreed with the word beside it: a category that
  // had rolled money forward showed "nearly there" while its own figure said
  // most of the money was still available.
  if (fillPercent(row.available ?? row.limit, row.actual) >= 80) return "close" as const;
  return "within" as const;
}

export const stateLabel = {
  running: "So far",
  over: "Over",
  spent: "All spent",
  close: "Nearly there",
  within: "Within budget",
  unbudgeted: "No budget",
} as const;

export const stateTone = {
  running: "blue",
  over: "red",
  spent: "amber",
  close: "amber",
  within: "green",
  unbudgeted: "neutral",
} as const;

export const unitNoun: Record<BudgetPeriodUnitName, string> = {
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

/** Only the plural is irregular enough to be worth a second map. */
export const unitNounPlural: Record<BudgetPeriodUnitName, string> = {
  week: "Weeks",
  month: "Months",
  quarter: "Quarters",
  year: "Years",
};

/**
 * A whole period's state, from the same rule one row uses.
 *
 * The report gives a period what it has and what it spent but not what is
 * left — that figure exists per row. Working it out here rather than in the
 * page keeps the answer to "is this over" in the one place, so the overview and
 * the budgets page cannot come to different conclusions about the same month.
 */
export function periodState(period: {
  budgeted: string;
  spent: string;
  available: string;
  partial: boolean;
}) {
  const available = moneyUnits(period.available);
  const spent = moneyUnits(period.spent);
  const remaining = available === null || spent === null ? null : moneyFromUnits(available - spent);
  return rowState(
    {
      // Only these four decide a state; the rest of a row is about a category
      // and a period has none.
      limit: period.budgeted,
      actual: period.spent,
      remaining,
      available: period.available,
    } as BudgetReportRow,
    period.partial,
  );
}
