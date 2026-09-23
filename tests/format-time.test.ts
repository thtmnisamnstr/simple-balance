import { describe, expect, it } from "vitest";
import { formatTime } from "../src/client/money.js";

/**
 * A stored reminder time, "HH:MM" on the person's own clock, written the way
 * the reader's locale writes a time.
 *
 * `Intl` separates the hour from "AM" with a narrow no-break space in current
 * ICU and an ordinary one in older builds, so the match is `\s` rather than a
 * literal space: the test is about the clock style, not about which ICU a
 * machine ships.
 */
describe("formatTime", () => {
  it("writes a US reader's time on a twelve-hour clock", () => {
    expect(formatTime("09:00", "en-US")).toMatch(/^9:00\sAM$/);
    expect(formatTime("18:30", "en-US")).toMatch(/^6:30\sPM$/);
    expect(formatTime("00:05", "en-US")).toMatch(/^12:05\sAM$/);
  });

  it("keeps a 24-hour reader's time on a 24-hour clock", () => {
    expect(formatTime("18:30", "en-GB")).toBe("18:30");
    expect(formatTime("09:00", "de-DE")).toBe("9:00");
  });

  it("converts nothing: a stored time is a wall-clock time, not an instant", () => {
    // Formatted in UTC so the machine running this, wherever it is, cannot
    // shift the hour. A local-zone formatter would print 18:30 as some other
    // hour for anybody away from UTC.
    expect(["00:00", "07:15", "12:00", "23:59"].map((time) => formatTime(time, "en-GB"))).toEqual([
      "0:00",
      "7:15",
      "12:00",
      "23:59",
    ]);
  });

  it("shows anything that is not a time as it arrived", () => {
    for (const value of ["", "9:00", "24:00", "12:60", "noon"]) {
      expect(formatTime(value, "en-US")).toBe(value);
    }
  });
});
