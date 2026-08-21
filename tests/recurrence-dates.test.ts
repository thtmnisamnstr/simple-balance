import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  daysInMonth,
  laterOf,
  nextOccurrenceAfter,
  scheduleCursor,
  occurrenceAt,
  occurrencesBetween,
  todayIn,
  weekdayOf,
  type RecurrenceRule,
} from "../src/shared/recurrence-dates.js";

const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  frequency: "monthly",
  interval: 1,
  anchorDate: "2026-01-31",
  monthPolicy: "last_day",
  weekendPolicy: "allow",
  ...over,
});

const dates = (one: RecurrenceRule, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) =>
    occurrenceAt(one, from + index).occurrenceDate,
  );

describe("calendar helpers", () => {
  it("moves days across month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2028-01-01", -1)).toBe("2027-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("knows February without a leap-year case", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
  });

  it("reads weekdays in UTC", () => {
    expect(weekdayOf("2026-01-31")).toBe(6);
    expect(weekdayOf("2028-01-01")).toBe(6);
    expect(weekdayOf("2027-01-01")).toBe(5);
  });

  it("takes the later of two dates", () => {
    expect(laterOf("2026-01-01", "2026-02-01")).toBe("2026-02-01");
    expect(laterOf("2026-02-01", "2026-02-01")).toBe("2026-02-01");
  });

  /**
   * The stored timezone is free text checked only when it was written, and this
   * runs inside a loop serving everybody, so one unrecognisable row must not be
   * able to stop the scheduler.
   */
  it("falls back to UTC rather than throwing on a timezone it cannot read", () => {
    // The clock is pinned to an hour where UTC and UTC+14 are on different
    // days. Comparing against todayIn("UTC") at whatever time the suite happens
    // to run proves nothing for most of the day, because a wrong fallback zone
    // usually shares today's date with UTC; matching a date-shaped regex, which
    // is what this did before, proved only that nothing threw.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T23:30:00.000Z"));
      expect(todayIn("Pacific/Kiritimati")).toBe("2026-08-12");
      expect(todayIn("UTC")).toBe("2026-08-11");
      expect(todayIn("Not/AZone")).toBe("2026-08-11");
      expect(todayIn("")).toBe("2026-08-11");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the sequence is anchored, not stepped", () => {
  /**
   * The whole reason occurrences are counted from the anchor. Stepping from the
   * previous date turns a rule about the 31st into a rule about the 28th the
   * first time it meets February, and it never recovers.
   */
  it("returns to the 31st after a February that clamped it", () => {
    expect(dates(rule(), 0, 3)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("lands on the 29th in a leap February with no special case", () => {
    expect(occurrenceAt(rule(), 24).occurrenceDate).toBe("2028-01-31");
    expect(occurrenceAt(rule(), 25).occurrenceDate).toBe("2028-02-29");
  });

  it("clamps a yearly anchor of the 29th into a common year", () => {
    const yearly = rule({ frequency: "yearly", anchorDate: "2028-02-29" });
    expect(dates(yearly, 0, 1)).toEqual(["2028-02-29", "2029-02-28"]);
  });

  it("counts intervals rather than asking for every other occurrence", () => {
    const fortnightly = rule({
      frequency: "weekly",
      interval: 2,
      anchorDate: "2026-06-26",
    });
    expect(dates(fortnightly, 0, 3)).toEqual([
      "2026-06-26",
      "2026-07-10",
      "2026-07-24",
      "2026-08-07",
    ]);
  });

  it("handles a quarterly rule as a monthly interval of three", () => {
    const quarterly = rule({ interval: 3, anchorDate: "2026-01-15" });
    expect(dates(quarterly, 0, 3)).toEqual([
      "2026-01-15",
      "2026-04-15",
      "2026-07-15",
      "2026-10-15",
    ]);
  });
});

describe("a relative day of the month", () => {
  const positioned = (ordinal: 1 | 2 | 3 | 4 | -1, weekday: number, over = {}) =>
    rule({ anchorDate: "2026-06-01", position: { ordinal, weekday }, ...over });

  it("counts from the start of the month", () => {
    expect(dates(positioned(2, 2), 0, 3)).toEqual([
      "2026-06-09",
      "2026-07-14",
      "2026-08-11",
      "2026-09-08",
    ]);
    expect(dates(positioned(1, 1), 0, 1)).toEqual(["2026-06-01", "2026-07-06"]);
  });

  it("counts the last one backwards from the end", () => {
    expect(dates(positioned(-1, 5), 0, 3)).toEqual([
      "2026-06-26",
      "2026-07-31",
      "2026-08-28",
      "2026-09-25",
    ]);
  });

  it("finds the last Tuesday of a leap February", () => {
    const leap = rule({
      anchorDate: "2028-02-01",
      position: { ordinal: -1, weekday: 2 },
    });
    expect(occurrenceAt(leap, 0).occurrenceDate).toBe("2028-02-29");
  });

  it("works on a quarterly interval and on a yearly rule", () => {
    expect(dates(positioned(3, 4, { interval: 3 }), 0, 2)).toEqual([
      "2026-06-18",
      "2026-09-17",
      "2026-12-17",
    ]);
    const yearly = rule({
      frequency: "yearly",
      anchorDate: "2026-11-01",
      position: { ordinal: 3, weekday: 4 },
    });
    expect(dates(yearly, 0, 2)).toEqual(["2026-11-19", "2027-11-18", "2028-11-16"]);
  });

  /**
   * Every month has at least 28 days and so at least four of every weekday, so
   * an ordinal of 1 to 4 or -1 always lands on a real date and nothing about the
   * month's length can shorten it.
   */
  it("never clamps, so the month-length policy has nothing to do", () => {
    const skipShort = positioned(4, 0, { monthPolicy: "skip" as const });
    for (let n = 0; n < 60; n += 1) {
      expect(occurrenceAt(skipShort, n).postedDate).not.toBeNull();
    }
  });

  it("ignores the anchor's day of the month", () => {
    const first = rule({ anchorDate: "2026-06-01", position: { ordinal: 2, weekday: 2 } });
    const last = rule({ anchorDate: "2026-06-30", position: { ordinal: 2, weekday: 2 } });
    expect(dates(first, 0, 2)).toEqual(dates(last, 0, 2));
  });
});

describe("policies decide the posted date, never the sequence", () => {
  it("moves a weekend occurrence back to the Friday before it", () => {
    const previous = rule({ weekendPolicy: "previous_business_day" });
    expect(occurrenceAt(previous, 0)).toEqual({
      occurrenceDate: "2026-01-31",
      postedDate: "2026-01-30",
    });
    expect(occurrenceAt(previous, 1)).toEqual({
      occurrenceDate: "2026-02-28",
      postedDate: "2026-02-27",
    });
  });

  it("crosses a year backwards when the first of January is a Saturday", () => {
    const previous = rule({
      anchorDate: "2027-11-01",
      weekendPolicy: "previous_business_day",
    });
    expect(occurrenceAt(previous, 2)).toEqual({
      occurrenceDate: "2028-01-01",
      postedDate: "2027-12-31",
    });
  });

  it("moves a Saturday forward two days and a Sunday forward one", () => {
    const next = rule({
      frequency: "weekly",
      anchorDate: "2026-03-07",
      weekendPolicy: "next_business_day",
    });
    expect(occurrenceAt(next, 0).postedDate).toBe("2026-03-09");
    const sunday = rule({
      frequency: "weekly",
      anchorDate: "2026-03-08",
      weekendPolicy: "next_business_day",
    });
    expect(occurrenceAt(sunday, 0).postedDate).toBe("2026-03-09");
  });

  /**
   * A skipped instance keeps its occurrence date so the watermark can move past
   * it. Left out entirely, a February the policy passed over would be
   * reconsidered on every tick forever.
   */
  it("keeps the occurrence but posts nothing when a policy passes it over", () => {
    const skipShort = rule({ monthPolicy: "skip" });
    expect(occurrenceAt(skipShort, 1)).toEqual({
      occurrenceDate: "2026-02-28",
      postedDate: null,
    });
    expect(occurrenceAt(skipShort, 2).postedDate).toBe("2026-03-31");

    const skipWeekend = rule({ weekendPolicy: "skip" });
    expect(occurrenceAt(skipWeekend, 0)).toEqual({
      occurrenceDate: "2026-01-31",
      postedDate: null,
    });
  });
});

describe("finding where to resume", () => {
  it("proposes every missed occurrence after six weeks of downtime", () => {
    const weekly = rule({ frequency: "weekly", anchorDate: "2026-06-26" });
    const missed = occurrencesBetween(weekly, "2026-06-26", "2026-08-07", 50);
    expect(missed.map((one) => one.occurrenceDate)).toEqual([
      "2026-07-03",
      "2026-07-10",
      "2026-07-17",
      "2026-07-24",
      "2026-07-31",
      "2026-08-07",
    ]);
  });

  it("returns nothing when the clock has gone backwards", () => {
    const weekly = rule({ frequency: "weekly", anchorDate: "2026-06-26" });
    expect(occurrencesBetween(weekly, "2026-08-07", "2026-07-01", 50)).toEqual([]);
    expect(occurrencesBetween(weekly, "2026-08-07", "2026-08-07", 50)).toEqual([]);
  });

  it("never returns more than it was asked for", () => {
    const daily = rule({ frequency: "daily", anchorDate: "2020-01-01" });
    expect(occurrencesBetween(daily, "2020-01-01", "2030-01-01", 7)).toHaveLength(7);
  });

  it("starts at the anchor when the watermark is before it", () => {
    expect(nextOccurrenceAfter(rule(), "2020-01-01").occurrenceDate).toBe(
      "2026-01-31",
    );
  });

  /**
   * The ordinary state right after somebody edits the rule: the watermark is a
   * date the new sequence never contained.
   */
  it("resumes correctly from a watermark that is not on the sequence", () => {
    expect(nextOccurrenceAfter(rule(), "2026-02-14").occurrenceDate).toBe(
      "2026-02-28",
    );
    expect(nextOccurrenceAfter(rule(), "2026-03-01").occurrenceDate).toBe(
      "2026-03-31",
    );
  });
});

const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;

/**
 * How many occurrences a brute-force scan has to walk to pass a date.
 *
 * Bounded, and the bound is asserted. An unbounded `while` here would not fail
 * if the index stopped advancing — the loop would spin until the whole file
 * timed out, which reports as "this file is slow" rather than "this rule stopped
 * moving forwards". A daily rule crossing the widest window these tests use
 * needs well under a thousand steps.
 */
const SCAN_CAP = 5000;

const scanPast = (one: RecurrenceRule, after: string) => {
  let scanned = 0;
  while (occurrenceAt(one, scanned).occurrenceDate <= after) {
    scanned += 1;
    if (scanned > SCAN_CAP) {
      throw new Error(
        `scanning ${JSON.stringify(one)} never passed ${after} in ${SCAN_CAP} steps`,
      );
    }
  }
  return scanned;
};

describe("properties that must hold for every rule", () => {
  /**
   * A clamp only ever pulls a date back inside its own month, so it can never
   * reach the occurrence before it. Everything else depends on this: the seek
   * below terminates because the sequence increases, and the watermark is only
   * a valid "already decided" marker if later occurrences are strictly later.
   */
  it("increases strictly in n, for every frequency, interval and anchor day", () => {
    for (const frequency of FREQUENCIES) {
      for (const interval of [1, 2, 3, 12]) {
        for (const day of [1, 28, 29, 30, 31]) {
          const one = rule({
            frequency,
            interval,
            anchorDate: `2026-01-${String(day).padStart(2, "0")}`,
          });
          let previous = occurrenceAt(one, 0).occurrenceDate;
          for (let n = 1; n < 600; n += 1) {
            const current = occurrenceAt(one, n).occurrenceDate;
            expect(
              current > previous,
              `${frequency} x${interval} day ${day}: ${previous} -> ${current}`,
            ).toBe(true);
            previous = current;
          }
        }
      }
    }
  });

  it("increases strictly in n for every relative day of the month too", () => {
    for (const frequency of ["monthly", "yearly"] as const) {
      for (const interval of [1, 3, 12]) {
        for (const ordinal of [1, 2, 3, 4, -1] as const) {
          for (let weekday = 0; weekday < 7; weekday += 1) {
            const one = rule({
              frequency,
              interval,
              anchorDate: "2026-01-01",
              position: { ordinal, weekday },
            });
            let previous = occurrenceAt(one, 0).occurrenceDate;
            for (let n = 1; n < 200; n += 1) {
              const current = occurrenceAt(one, n).occurrenceDate;
              expect(
                current > previous,
                `${frequency} x${interval} ordinal ${ordinal} weekday ${weekday}: ${previous} -> ${current}`,
              ).toBe(true);
              previous = current;
            }
          }
        }
      }
    }
  });

  it("seeks exactly for a relative day of the month as well", () => {
    for (const ordinal of [1, 2, 3, 4, -1] as const) {
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const one = rule({
          anchorDate: "2026-01-01",
          position: { ordinal, weekday },
        });
        for (let offset = -20; offset < 200; offset += 1) {
          const after = addDays("2026-01-15", offset * 5);
          const scanned = scanPast(one, after);
          expect(
            nextOccurrenceAfter(one, after).occurrenceDate,
            `ordinal ${ordinal} weekday ${weekday} after ${after}`,
          ).toBe(occurrenceAt(one, scanned).occurrenceDate);
        }
      }
    }
  });

  /**
   * The seek is the only part that is cleverer than a scan, so it is checked
   * against one. A wrong index does not throw, it silently proposes the wrong
   * dates or skips a month.
   */
  it("seeks to exactly the index a brute-force scan would reach", () => {
    for (const frequency of FREQUENCIES) {
      for (const interval of [1, 2, 3, 7, 12]) {
        for (const day of [1, 15, 28, 29, 30, 31]) {
          const one = rule({
            frequency,
            interval,
            anchorDate: `2026-01-${String(day).padStart(2, "0")}`,
          });
          for (let offset = -40; offset < 360; offset += 1) {
            const after = addDays("2026-01-15", offset * 4);
            const scanned = scanPast(one, after);
            expect(
              nextOccurrenceAfter(one, after).occurrenceDate,
              `${frequency} x${interval} day ${day} after ${after}`,
            ).toBe(occurrenceAt(one, scanned).occurrenceDate);
          }
        }
      }
    }
  });
});

/**
 * A positioned rule's occurrence 0 can fall earlier in the anchor's month than
 * the anchor itself — "the first Monday" of a month anchored on the 31st. The
 * seek used to short-circuit to index 0 whenever the watermark preceded the
 * anchor, which returned a date the caller had already passed.
 */
describe("seeking past a watermark on a positioned schedule", () => {
  const positioned = (anchorDate: string, ordinal: 1 | 2 | 3 | 4 | -1, weekday: number) => ({
    frequency: "monthly" as const,
    interval: 1,
    anchorDate,
    monthPolicy: "last_day" as const,
    weekendPolicy: "allow" as const,
    position: { ordinal, weekday },
  });

  it("never returns an occurrence on or before the watermark", () => {
    for (const day of ["01", "05", "11", "17", "28", "31"]) {
      for (const ordinal of [1, 2, 3, 4, -1] as const) {
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const rule = positioned(`2026-08-${day}`, ordinal, weekday);
          for (const after of ["2026-07-31", "2026-08-01", "2026-08-10", "2026-08-30"]) {
            const next = nextOccurrenceAfter(rule, after);
            expect(
              next.occurrenceDate > after,
              `${rule.anchorDate} ordinal=${ordinal} weekday=${weekday} after=${after} gave ${next.occurrenceDate}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("proposes the occurrence in the anchor's own month when it is still ahead", () => {
    // Anchored 2026-08-31, "third Monday" is 2026-08-17. Seeking from the day
    // before the schedule may reach back to must find it, not next month's.
    const rule = positioned("2026-08-31", 3, 1);
    expect(nextOccurrenceAfter(rule, "2026-08-10").occurrenceDate).toBe("2026-08-17");
  });

  it("still starts at the anchor for a rule with no position", () => {
    const rule = {
      frequency: "monthly" as const,
      interval: 1,
      anchorDate: "2026-09-15",
      monthPolicy: "last_day" as const,
      weekendPolicy: "allow" as const,
      position: null,
    };
    expect(nextOccurrenceAfter(rule, "2026-08-09").occurrenceDate).toBe("2026-09-15");
  });

  it("refuses an interval that would make the sequence stand still", () => {
    for (const interval of [0, -1, -12]) {
      expect(() =>
        nextOccurrenceAfter(
          {
            frequency: "daily",
            interval,
            anchorDate: "2026-08-01",
            monthPolicy: "last_day",
            weekendPolicy: "allow",
            position: null,
          },
          "2026-08-10",
        ),
      ).toThrow(RangeError);
    }
  });
});

describe("the watermark a schedule seeks from", () => {
  it("is the day before it may reach back to, until it has run", () => {
    expect(
      scheduleCursor({ proposesFrom: "2026-08-11", lastOccurrenceDate: null }),
    ).toBe("2026-08-10");
  });

  it("is the last occurrence once it is later than that", () => {
    expect(
      scheduleCursor({ proposesFrom: "2026-08-11", lastOccurrenceDate: "2026-09-01" }),
    ).toBe("2026-09-01");
  });

  it("never moves backwards past the floor", () => {
    expect(
      scheduleCursor({ proposesFrom: "2026-08-11", lastOccurrenceDate: "2026-01-01" }),
    ).toBe("2026-08-10");
  });
});
