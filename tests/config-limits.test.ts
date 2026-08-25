import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertConfiguredLimits,
  configuredCsvMaxBytes,
  configuredCsvMaxRows,
  configuredDatabasePoolSize,
  DEFAULT_CSV_MAX_BYTES,
  DEFAULT_CSV_MAX_ROWS,
  DEFAULT_DATABASE_POOL_SIZE,
} from "../src/server/config-limits.js";

const bounded = [
  "CSV_MAX_BYTES",
  "CSV_MAX_ROWS",
  "DATABASE_POOL_SIZE",
  "RECURRENCE_TICK_SECONDS",
  "RECURRENCE_CATCH_UP_LIMIT",
  "RECURRENCE_CLAIM_LIMIT",
] as const;
const original = Object.fromEntries(bounded.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of bounded) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("CSV resource limits", () => {
  it("accepts positive bounded integer overrides", () => {
    process.env.CSV_MAX_BYTES = "4096";
    process.env.CSV_MAX_ROWS = "500";
    expect(configuredCsvMaxBytes()).toBe(4096);
    expect(configuredCsvMaxRows()).toBe(500);
  });

  /**
   * A mistake falls back and says so.
   *
   * The value an operator typed is either a number in range or a mistake, and a
   * mistake that resolves to the default used to be one nobody was told about:
   * the process started, served, and imported ten thousand rows for somebody who
   * asked for a thousand.
   *
   * It warns rather than refusing. Refusing would mean a typo in a tuning knob
   * takes a ledger offline, on a value the previous release accepted — an
   * outage bought for a cap. The silence was the defect; the fallback never was.
   */
  it.each(["NaN", "0", "-1", "1.5", "999999999999999999999"])(
    "falls back and names itself on invalid override %s",
    async (value) => {
      // Re-imported per case because the warning is said once per name per
      // process — these are read on every scheduler tick, and warning each time
      // would fill a log with one mistake.
      vi.resetModules();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.CSV_MAX_ROWS = value;
      const limits = await import("../src/server/config-limits.js");
      expect(limits.configuredCsvMaxRows()).toBe(limits.DEFAULT_CSV_MAX_ROWS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("CSV_MAX_ROWS"));
      warn.mockRestore();
    },
  );

  it("treats an empty override as unset, silently", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSV_MAX_ROWS = "";
    const limits = await import("../src/server/config-limits.js");
    expect(limits.configuredCsvMaxRows()).toBe(limits.DEFAULT_CSV_MAX_ROWS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves an unset limit on its default, which is the only thing that means default", () => {
    for (const name of bounded) delete process.env[name];
    expect(configuredCsvMaxBytes()).toBe(DEFAULT_CSV_MAX_BYTES);
    expect(configuredCsvMaxRows()).toBe(DEFAULT_CSV_MAX_ROWS);
    expect(configuredDatabasePoolSize()).toBe(DEFAULT_DATABASE_POOL_SIZE);
    expect(() => assertConfiguredLimits()).not.toThrow();
  });

  /**
   * The pool size follows the same rule as the other five now. It used to throw
   * on its own, which made it the one variable whose typo was fatal; falling
   * back is strictly more permissive, so no deployment that started before
   * fails to start now.
   */
  it("reads the PostgreSQL pool size, and falls back on a bad one", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.DATABASE_POOL_SIZE;
    const limits = await import("../src/server/config-limits.js");
    expect(limits.configuredDatabasePoolSize()).toBe(limits.DEFAULT_DATABASE_POOL_SIZE);
    process.env.DATABASE_POOL_SIZE = "20";
    expect(limits.configuredDatabasePoolSize()).toBe(20);
    for (const invalid of ["NaN", "0", "-1", "1.5", "101"]) {
      process.env.DATABASE_POOL_SIZE = invalid;
      expect(limits.configuredDatabasePoolSize()).toBe(limits.DEFAULT_DATABASE_POOL_SIZE);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DATABASE_POOL_SIZE"));
    warn.mockRestore();
  });
});

/**
 * Every one of these is read somewhere a person is no longer watching: an
 * import, a scheduler tick, the moment a pool is first opened. Reading them all
 * at startup is what puts the warning in front of whoever just deployed rather
 * than in a log nobody opens, so it is worth asserting all six are covered
 * rather than five of six.
 */
describe("the startup check over every bounded limit", () => {
  it.each([
    ["CSV_MAX_BYTES", "1O485760"],
    ["CSV_MAX_ROWS", "1O000"],
    ["DATABASE_POOL_SIZE", "0"],
    ["RECURRENCE_TICK_SECONDS", "5 minutes"],
    ["RECURRENCE_CATCH_UP_LIMIT", "-1"],
    ["RECURRENCE_CLAIM_LIMIT", "99999"],
  ])("names a bad %s at startup, and starts anyway", async (name, value) => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[name] = value;
    const limits = await import("../src/server/config-limits.js");
    expect(() => limits.assertConfiguredLimits()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));
    warn.mockRestore();
  });
});
