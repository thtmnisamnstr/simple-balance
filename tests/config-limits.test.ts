import { afterEach, describe, expect, it } from "vitest";
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

  // The value an operator typed is either a number in range or a mistake, and a
  // mistake that resolves to the default is one nobody is told about: the
  // process starts, serves, and imports ten thousand rows for somebody who
  // asked for a thousand. Empty is in the list because `CSV_MAX_ROWS=` is a
  // line somebody wrote rather than a variable they left alone.
  it.each(["NaN", "0", "-1", "1.5", "999999999999999999999", ""])(
    "refuses invalid override %s rather than quietly using the default",
    (value) => {
      process.env.CSV_MAX_BYTES = value;
      expect(() => configuredCsvMaxBytes()).toThrow(/CSV_MAX_BYTES must be an integer/);
      delete process.env.CSV_MAX_BYTES;
      process.env.CSV_MAX_ROWS = value;
      expect(() => configuredCsvMaxRows()).toThrow(/CSV_MAX_ROWS must be an integer/);
    },
  );

  it("leaves an unset limit on its default, which is the only thing that means default", () => {
    for (const name of bounded) delete process.env[name];
    expect(configuredCsvMaxBytes()).toBe(DEFAULT_CSV_MAX_BYTES);
    expect(configuredCsvMaxRows()).toBe(DEFAULT_CSV_MAX_ROWS);
    expect(configuredDatabasePoolSize()).toBe(DEFAULT_DATABASE_POOL_SIZE);
    expect(() => assertConfiguredLimits()).not.toThrow();
  });

  it("validates the PostgreSQL pool size before creating the pool", () => {
    delete process.env.DATABASE_POOL_SIZE;
    expect(configuredDatabasePoolSize()).toBe(DEFAULT_DATABASE_POOL_SIZE);
    process.env.DATABASE_POOL_SIZE = "20";
    expect(configuredDatabasePoolSize()).toBe(20);
    for (const invalid of ["NaN", "0", "-1", "1.5", "101"]) {
      process.env.DATABASE_POOL_SIZE = invalid;
      expect(() => configuredDatabasePoolSize()).toThrow(/DATABASE_POOL_SIZE must be an integer/);
    }
  });
});

/**
 * Every one of these is read somewhere a person is no longer watching: an
 * import, a scheduler tick, the moment a pool is first opened. The startup
 * check is what makes a wrong one a process that will not start, so it is the
 * one place worth asserting they are all covered rather than five of six.
 */
describe("the startup check over every bounded limit", () => {
  it.each([
    ["CSV_MAX_BYTES", "1O485760"],
    ["CSV_MAX_ROWS", "1O000"],
    ["DATABASE_POOL_SIZE", "0"],
    ["RECURRENCE_TICK_SECONDS", "5 minutes"],
    ["RECURRENCE_CATCH_UP_LIMIT", "-1"],
    ["RECURRENCE_CLAIM_LIMIT", "99999"],
  ])("refuses to start on a bad %s, naming it", (name, value) => {
    process.env[name] = value;
    expect(() => assertConfiguredLimits()).toThrow(new RegExp(`${name} must be an integer`));
  });
});
