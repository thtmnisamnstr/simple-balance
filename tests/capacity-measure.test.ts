import { describe, expect, it } from "vitest";

import { buildWheel, errorsIn, percentile } from "../scripts/capacity/measure.mjs";
import { MIX } from "../scripts/capacity/schedule.mjs";

/**
 * The arithmetic every figure in `docs/capacity.md` is made of.
 *
 * Nothing checked it until the capacity work was already written up, which is
 * the wrong way round: a percentile off by one index, or an error count that
 * missed a status, would produce a report that reads entirely ordinary and is
 * wrong — and the whole point of that document is that somebody can trust a
 * number in it without re-running seventy minutes of load.
 */

describe("the percentile the report publishes", () => {
  // Nearest-rank, so every answer is a latency some request actually had.
  // Interpolation would report a number nothing measured.
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("takes the nearest rank rather than interpolating", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it("never reads past either end", () => {
    // p0 and p100 are the shapes that walk off an array: `ceil(0) - 1` is -1,
    // and a rank equal to the length is one past the last index.
    expect(percentile([5, 6, 7], 0)).toBe(5);
    expect(percentile([5, 6, 7], 100)).toBe(7);
    expect(percentile([5, 6, 7], 0.0001)).toBe(5);
  });

  it("says nothing rather than zero when there is nothing to say", () => {
    // Zero would be a lie that reads as a very fast arm, which is exactly what
    // a phase that never ran should not look like.
    expect(percentile([], 95)).toBeUndefined();
  });

  it("is right on a small odd sample, where off-by-one is visible", () => {
    const five = [10, 20, 30, 40, 50];
    expect(percentile(five, 50)).toBe(30);
    expect(percentile(five, 20)).toBe(10);
    expect(percentile(five, 21)).toBe(20);
    expect(percentile(five, 80)).toBe(40);
    expect(percentile(five, 81)).toBe(50);
  });

  it("puts the tail where a threshold would catch it", () => {
    // Ninety fast requests and ten slow ones: a p95 that reported the fast
    // number would pass a threshold the machine had actually missed.
    const skewed = [
      ...Array.from({ length: 90 }, () => 10),
      ...Array.from({ length: 10 }, () => 5_000),
    ];
    expect(percentile(skewed, 50)).toBe(10);
    expect(percentile(skewed, 90)).toBe(10);
    expect(percentile(skewed, 91)).toBe(5_000);
    expect(percentile(skewed, 99)).toBe(5_000);
  });
});

describe("the request mix the driver fires", () => {
  it("expands to one entry per percentage point", () => {
    const wheel = buildWheel(MIX);
    expect(wheel).toHaveLength(100);
    for (const entry of MIX) {
      expect(wheel.filter((kind) => kind === entry.kind)).toHaveLength(entry.percent);
    }
  });

  it("refuses a mix that does not add up", () => {
    // A mix of 99 would still run, every share a hair commoner than the
    // document says, and nothing downstream would notice.
    expect(() =>
      buildWheel([
        { kind: "a", percent: 60 },
        { kind: "b", percent: 39 },
      ]),
    ).toThrow(/adds to 99/);
    expect(() =>
      buildWheel([
        { kind: "a", percent: 60 },
        { kind: "b", percent: 41 },
      ]),
    ).toThrow(/adds to 101/);
  });
});

describe("what counts as an error in the report", () => {
  it("counts server failures and answers that never came", () => {
    expect(
      errorsIn(
        new Map([
          [200, 10],
          [500, 3],
        ]),
      ),
    ).toBe(3);
    // 0 is the driver's own mark for a request that got no answer at all, and
    // it is the one that matters most: a saturated machine drops connections
    // before it starts answering 500.
    expect(
      errorsIn(
        new Map([
          [200, 10],
          [0, 7],
        ]),
      ),
    ).toBe(7);
    expect(
      errorsIn(
        new Map([
          [503, 2],
          [500, 1],
          [0, 1],
        ]),
      ),
    ).toBe(4);
  });

  it("does not count a refusal that was correct", () => {
    // A 409 is two sessions editing one entry and the version check doing its
    // job. Counting it would make concurrency control look like an outage.
    expect(
      errorsIn(
        new Map([
          [200, 10],
          [409, 5],
          [404, 2],
          [422, 1],
        ]),
      ),
    ).toBe(0);
  });

  it("is zero for an empty tally rather than undefined", () => {
    expect(errorsIn(new Map())).toBe(0);
  });
});
