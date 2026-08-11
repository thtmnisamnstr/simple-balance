/**
 * When a recurrence falls due, worked out from calendar dates alone.
 *
 * Pure and shared, because the create form previews the next few dates and the
 * scheduler proposes on them. Two implementations of "what day is it where this
 * person lives" would let a recurrence propose a row for a day the dashboard
 * says has not happened yet.
 *
 * Every date is a `YYYY-MM-DD` string and every intermediate goes through
 * `Date.UTC` and `getUTC*`. A local-time getter here would move a date by a day
 * for anybody west of Greenwich.
 */

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
export type RecurrenceMonthPolicy = "last_day" | "skip";
export type RecurrenceWeekendPolicy =
  | "allow"
  | "skip"
  | "previous_business_day"
  | "next_business_day";

export type RecurrenceRule = {
  frequency: RecurrenceFrequency;
  interval: number;
  /** The first candidate occurrence, and the phase every later one is counted from. */
  anchorDate: string;
  monthPolicy: RecurrenceMonthPolicy;
  weekendPolicy: RecurrenceWeekendPolicy;
};

export type Occurrence = {
  /**
   * Where this instance sits in the schedule's own sequence. Never adjusted by
   * a policy, because it is the identity a proposed row is recorded under.
   */
  occurrenceDate: string;
  /** The date the proposed row carries, or null when a policy passed it over. */
  postedDate: string | null;
};

const MS_PER_DAY = 86_400_000;

function parts(date: string) {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

function iso(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayNumber(date: string) {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

export function addDays(date: string, days: number) {
  const moved = new Date(dayNumber(date) * MS_PER_DAY + days * MS_PER_DAY);
  return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** Day zero of the next month is the last day of this one, so leap years need no case. */
export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 is Sunday, 6 is Saturday. */
export function weekdayOf(date: string) {
  return new Date(dayNumber(date) * MS_PER_DAY).getUTCDay();
}

export function laterOf(left: string, right: string) {
  return left >= right ? left : right;
}

/** The calendar date it is where this person lives, not where the server runs. */
export function todayIn(timezone: string) {
  // The stored timezone is free text, checked only when it was written, so an
  // ICU update or a hand-edited row can leave one unrecognisable years later.
  // Inside a loop that serves everybody, one such row must not be able to throw.
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const value = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

/**
 * Occurrence `n` counted from the anchor, never from the occurrence before it.
 *
 * That is what makes the 31st of January follow into the 28th of February and
 * then back to the 31st of March. Stepping from the previous date instead turns
 * a rule about the 31st into a rule about the 28th the first time it meets
 * February, and it never recovers.
 */
function sequenceDate(rule: RecurrenceRule, n: number) {
  const { year, month, day } = parts(rule.anchorDate);
  switch (rule.frequency) {
    case "daily":
      return { date: addDays(rule.anchorDate, n * rule.interval), clamped: false };
    case "weekly":
      return { date: addDays(rule.anchorDate, n * rule.interval * 7), clamped: false };
    case "monthly": {
      const total = year * 12 + (month - 1) + n * rule.interval;
      const targetYear = Math.floor(total / 12);
      const targetMonth = (total % 12) + 1;
      const last = daysInMonth(targetYear, targetMonth);
      return {
        date: iso(targetYear, targetMonth, Math.min(day, last)),
        clamped: day > last,
      };
    }
    default: {
      const targetYear = year + n * rule.interval;
      const last = daysInMonth(targetYear, month);
      return { date: iso(targetYear, month, Math.min(day, last)), clamped: day > last };
    }
  }
}

/**
 * The date a proposed row carries, which never feeds back into the sequence.
 *
 * A business day is Monday to Friday. There is no holiday calendar and there
 * must not be one: it would be per-country, per-year data ageing inside a
 * container nobody updates, and PostgreSQL is the only persistent dependency
 * this product allows itself.
 */
function postedDateFor(
  rule: RecurrenceRule,
  step: { date: string; clamped: boolean },
) {
  if (step.clamped && rule.monthPolicy === "skip") return null;
  const weekday = weekdayOf(step.date);
  if (weekday !== 0 && weekday !== 6) return step.date;
  switch (rule.weekendPolicy) {
    case "allow":
      return step.date;
    case "skip":
      return null;
    case "previous_business_day":
      return addDays(step.date, weekday === 6 ? -1 : -2);
    default:
      return addDays(step.date, weekday === 6 ? 2 : 1);
  }
}

export function occurrenceAt(rule: RecurrenceRule, n: number): Occurrence {
  const step = sequenceDate(rule, n);
  return { occurrenceDate: step.date, postedDate: postedDateFor(rule, step) };
}

/**
 * The index of the first occurrence strictly after `after`, found rather than
 * scanned to.
 *
 * The guess can be off either way, so it backs off two and steps forward. That
 * terminates in at most three steps because the sequence strictly increases,
 * and it stays exact when the watermark is not on the current sequence at all,
 * which is the ordinary state right after somebody edits the rule.
 */
function firstIndexAfter(rule: RecurrenceRule, after: string) {
  if (after < rule.anchorDate) return 0;
  const anchor = parts(rule.anchorDate);
  const target = parts(after);
  const guess =
    rule.frequency === "daily"
      ? Math.ceil((dayNumber(after) - dayNumber(rule.anchorDate) + 1) / rule.interval)
      : rule.frequency === "weekly"
        ? Math.ceil(
            (dayNumber(after) - dayNumber(rule.anchorDate) + 1) / (rule.interval * 7),
          )
        : rule.frequency === "monthly"
          ? Math.ceil(
              (target.year * 12 +
                target.month -
                (anchor.year * 12 + anchor.month)) /
                rule.interval,
            )
          : Math.ceil((target.year - anchor.year) / rule.interval);
  let n = Math.max(0, guess - 2);
  while (sequenceDate(rule, n).date <= after) n += 1;
  return n;
}

/** The first occurrence strictly after `after`. A schedule has no end, so never null. */
export function nextOccurrenceAfter(rule: RecurrenceRule, after: string): Occurrence {
  return occurrenceAt(rule, firstIndexAfter(rule, after));
}

/**
 * Every occurrence strictly after `after` and no later than `through`, in order.
 *
 * `after` is a watermark, so "already decided" is a comparison rather than a
 * query. An instance a policy passed over comes back with a null `postedDate`
 * rather than being left out: the caller writes no row for it and still has to
 * move past it, or a February the policy skipped is reconsidered forever.
 */
export function occurrencesBetween(
  rule: RecurrenceRule,
  after: string,
  through: string,
  limit: number,
): Occurrence[] {
  const result: Occurrence[] = [];
  for (let n = firstIndexAfter(rule, after); result.length < limit; n += 1) {
    const step = sequenceDate(rule, n);
    if (step.date > through) break;
    result.push({ occurrenceDate: step.date, postedDate: postedDateFor(rule, step) });
  }
  return result;
}
