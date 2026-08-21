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

/**
 * "The second Tuesday", "the last Friday". `ordinal` -1 is the last one in the
 * month; 1 through 4 are counted from the start.
 *
 * There is no fifth: a month has four of some weekdays and five of others, so
 * an ordinal of 5 would silently mean different things in different months.
 * Anybody who wants the fifth means the last one, which -1 says exactly.
 */
export type RecurrencePosition = {
  ordinal: 1 | 2 | 3 | 4 | -1;
  /** 0 is Sunday, 6 is Saturday. */
  weekday: number;
};

export type RecurrenceRule = {
  frequency: RecurrenceFrequency;
  interval: number;
  /** The first candidate occurrence, and the phase every later one is counted from. */
  anchorDate: string;
  monthPolicy: RecurrenceMonthPolicy;
  weekendPolicy: RecurrenceWeekendPolicy;
  /**
   * Monthly and yearly only, and when it is set the day of the anchor is not
   * read: the month decides the date, not the anchor's day number. A weekly
   * rule needs none of this, because its relative day is the anchor's weekday.
   */
  position?: RecurrencePosition | null;
};

/**
 * The date the ordinal names inside one month.
 *
 * Ordinals 1 to 4 always exist, because every month has at least 28 days and so
 * at least four of every weekday, and -1 always exists for the same reason.
 * Nothing here can be clamped, which is why a positioned rule ignores the
 * month-length policy entirely.
 */
export function weekdayOfMonth(
  year: number,
  month: number,
  position: RecurrencePosition,
) {
  if (position.ordinal === -1) {
    const last = daysInMonth(year, month);
    const lastWeekday = weekdayOf(iso(year, month, last));
    return iso(year, month, last - ((lastWeekday - position.weekday + 7) % 7));
  }
  const firstWeekday = weekdayOf(iso(year, month, 1));
  const first = 1 + ((position.weekday - firstWeekday + 7) % 7);
  return iso(year, month, first + (position.ordinal - 1) * 7);
}

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

/**
 * The calendar date some instant fell on where this person lives.
 *
 * The one place that question is answered. PostgreSQL can answer it too, but not
 * the same way: `at time zone '-08:00'` reads a bare offset with the POSIX sign
 * convention while `Intl` reads it as ISO, so the two disagree by sixteen hours
 * for anybody whose stored timezone is an offset rather than a zone name. Having
 * both was enough to close an account on a day the dashboard had not reached
 * yet, leaving its balance out of the headline total while the ledger still
 * counted it.
 */
export function calendarDayIn(instant: Date, timezone: string) {
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
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

/** The calendar date it is where this person lives, not where the server runs. */
export function todayIn(timezone: string) {
  return calendarDayIn(new Date(), timezone);
}

/**
 * The wall-clock time some instant fell on where this person lives, as `HH:MM`.
 *
 * A notification asked for at half past eight means half past eight where the
 * person is, so the comparison has to be made in their clock and not the
 * server's. Answered the same way and in the same place as the date, for the
 * same reason: two implementations of a timezone are two answers.
 */
export function clockTimeIn(instant: Date, timezone: string) {
  let formatter: Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, ...options });
  } catch {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options });
  }
  const value = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${value.hour}:${value.minute}`;
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
      if (rule.position) {
        return {
          date: weekdayOfMonth(targetYear, targetMonth, rule.position),
          clamped: false,
        };
      }
      const last = daysInMonth(targetYear, targetMonth);
      return {
        date: iso(targetYear, targetMonth, Math.min(day, last)),
        clamped: day > last,
      };
    }
    default: {
      const targetYear = year + n * rule.interval;
      if (rule.position) {
        return { date: weekdayOfMonth(targetYear, month, rule.position), clamped: false };
      }
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
  // A non-positive interval makes the sequence stand still or run backwards,
  // and the loop below advances until it passes the watermark, so it would
  // never return. The schema refuses one; this is the shared function refusing
  // it too, because a form that has not validated yet calls straight in.
  if (rule.interval < 1) {
    throw new RangeError("A recurrence interval must be at least 1");
  }
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

/**
 * The watermark a schedule seeks from: everything on or before it is settled.
 *
 * Shared because the browser's preview and the scheduler have to seek from the
 * same day. Deriving it from the anchor instead, as a form with no row in hand
 * is tempted to, shows a first date the scheduler will not propose.
 */
export function scheduleCursor(row: {
  proposesFrom: string;
  lastOccurrenceDate: string | null;
}) {
  const floor = addDays(row.proposesFrom, -1);
  return row.lastOccurrenceDate ? laterOf(row.lastOccurrenceDate, floor) : floor;
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
