import { describe, expect, it } from "vitest";
import { entryKey } from "../scripts/product-kit/entry-key.mjs";

/**
 * The key the product kit posts each seeded entry under.
 *
 * A re-run against the same throwaway database has to replay every entry it
 * already posted, whatever day it runs on. The kit clamps a date still ahead of
 * today to today, so a key built from the date moved with it and the history
 * was posted a second time — silently inflating every figure in the marketing
 * pictures. These hold the three runs that went wrong: a later day, a later
 * month, and the month boundary itself.
 */
describe("the product kit's entry keys", () => {
  const entries = [0, 1, 2, 16];
  const keys = (today: Date, monthsAgo: number) =>
    entries.map((index) => entryKey(today, monthsAgo, index));

  it("replays every entry on a later day of the same month", () => {
    const first = new Date(2026, 8, 5, 20, 0);
    const later = new Date(2026, 8, 22, 9, 0);
    for (const monthsAgo of [0, 1, 2]) {
      expect(keys(later, monthsAgo)).toEqual(keys(first, monthsAgo));
    }
  });

  it("replays last month's entries once the month has turned, and posts this month's", () => {
    const august = new Date(2026, 7, 30);
    const september = new Date(2026, 8, 2);
    // What was "this month" is now "one month ago", and it is the same
    // calendar month, so the same entries.
    expect(keys(september, 1)).toEqual(keys(august, 0));
    expect(keys(september, 2)).toEqual(keys(august, 1));
    // And the new month is new: keying on how many months back would have
    // replayed August's keys here and posted nothing for September.
    for (const key of keys(september, 0)) {
      expect(keys(august, 0)).not.toContain(key);
    }
  });

  it("gives every entry of every month a key of its own", () => {
    const today = new Date(2026, 0, 15);
    const all = [0, 1, 2].flatMap((monthsAgo) => keys(today, monthsAgo));
    expect(new Set(all).size).toBe(all.length);
    // Across the year boundary, too.
    expect(entryKey(today, 1, 0)).toBe("kit-2025-12-0");
  });
});
