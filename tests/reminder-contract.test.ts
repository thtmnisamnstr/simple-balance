import { describe, expect, it } from "vitest";
import { templateNotificationSchema } from "../src/shared/domain.js";

/**
 * A reminder has to survive being read and sent back.
 *
 * That sounds too obvious to test, and it was not true. The three schedule
 * columns are NOT NULL with defaults, so a reminder that happens once always
 * reads back carrying interval 1, `last_day` and `allow` — and the guard against
 * leftovers of a repeating rule refused the presence of those fields rather than
 * a value that meant anything. So the object this schema produces was an object
 * this schema rejected: an agent that read a template, changed the reminder's
 * time and sent it back got three 422 issues about fields it never touched. The
 * browser never hit it because it rebuilds the object from its own state and
 * omits them, which is exactly why nothing caught it.
 */

/** What the server returns for a reminder that happens once. */
const readBack = {
  frequency: null,
  interval: 1,
  anchorDate: "2026-09-01",
  monthPolicy: "last_day",
  weekendPolicy: "allow",
  position: null,
  time: "09:00",
  repeats: false,
  lastNotifiedDate: null,
  nextNotificationDate: "2026-09-01",
};

const accepts = (value: unknown) => templateNotificationSchema.safeParse(value).success;
const issuePaths = (value: unknown) => {
  const result = templateNotificationSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("a reminder that happens once", () => {
  it("can be read and sent straight back", () => {
    expect(issuePaths(readBack)).toEqual([]);
  });

  it("can be read, edited and sent back", () => {
    // The whole point of the round trip: change one field, return the rest as
    // they arrived.
    expect(issuePaths({ ...readBack, time: "18:30" })).toEqual([]);
    expect(issuePaths({ ...readBack, anchorDate: "2026-10-05" })).toEqual([]);
  });

  it("still refuses anything that asks for a repeat without saying so", () => {
    // The guard's real job. A value that contradicts happening once is refused;
    // a stored default, which means nothing, is not.
    expect(issuePaths({ ...readBack, interval: 3 })).toEqual(["interval"]);
    expect(issuePaths({ ...readBack, weekendPolicy: "next_business_day" })).toEqual([
      "weekendPolicy",
    ]);
    expect(issuePaths({ ...readBack, monthPolicy: "skip" })).toEqual(["monthPolicy"]);
    expect(issuePaths({ ...readBack, position: { ordinal: 1, weekday: 1 } })).toEqual(["position"]);
  });

  it("names every field that contradicts it, not just the first", () => {
    // Both come from the same pass, so both are reported. A value that fails its
    // own type check would short-circuit before this pass runs, which is why the
    // position here is a real one rather than a made-up string.
    expect(
      issuePaths({
        ...readBack,
        interval: 2,
        position: { ordinal: 2, weekday: 3 },
      }).sort(),
    ).toEqual(["interval", "position"]);
  });
});

describe("a reminder that repeats", () => {
  const repeating = { ...readBack, frequency: "monthly", repeats: true };

  it("can be read and sent straight back", () => {
    expect(accepts(repeating)).toBe(true);
  });

  it("keeps the schedule rules a recurrence is held to", () => {
    // A daily schedule of one or two days moved onto a business day puts two
    // occurrences on the same date, which is refused for a recurrence and has to
    // be refused here for the same reason.
    expect(
      accepts({
        ...repeating,
        frequency: "daily",
        interval: 1,
        weekendPolicy: "next_business_day",
      }),
    ).toBe(false);
  });
});
