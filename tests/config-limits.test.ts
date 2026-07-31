import { afterEach, describe, expect, it } from "vitest";
import {
  configuredCsvMaxBytes,
  configuredCsvMaxRows,
  configuredDatabasePoolSize,
  DEFAULT_CSV_MAX_BYTES,
  DEFAULT_CSV_MAX_ROWS,
  DEFAULT_DATABASE_POOL_SIZE,
} from "../src/server/config-limits.js";

const originalBytes = process.env.CSV_MAX_BYTES;
const originalRows = process.env.CSV_MAX_ROWS;
const originalPoolSize = process.env.DATABASE_POOL_SIZE;

afterEach(() => {
  if (originalBytes === undefined) delete process.env.CSV_MAX_BYTES;
  else process.env.CSV_MAX_BYTES = originalBytes;
  if (originalRows === undefined) delete process.env.CSV_MAX_ROWS;
  else process.env.CSV_MAX_ROWS = originalRows;
  if (originalPoolSize === undefined) delete process.env.DATABASE_POOL_SIZE;
  else process.env.DATABASE_POOL_SIZE = originalPoolSize;
});

describe("CSV resource limits", () => {
  it("accepts positive bounded integer overrides", () => {
    process.env.CSV_MAX_BYTES = "4096";
    process.env.CSV_MAX_ROWS = "500";
    expect(configuredCsvMaxBytes()).toBe(4096);
    expect(configuredCsvMaxRows()).toBe(500);
  });

  it.each(["NaN", "0", "-1", "1.5", "999999999999999999999"])(
    "falls back safely for invalid override %s",
    (value) => {
      process.env.CSV_MAX_BYTES = value;
      process.env.CSV_MAX_ROWS = value;
      expect(configuredCsvMaxBytes()).toBe(DEFAULT_CSV_MAX_BYTES);
      expect(configuredCsvMaxRows()).toBe(DEFAULT_CSV_MAX_ROWS);
    },
  );

  it("validates the PostgreSQL pool size before creating the pool", () => {
    delete process.env.DATABASE_POOL_SIZE;
    expect(configuredDatabasePoolSize()).toBe(DEFAULT_DATABASE_POOL_SIZE);
    process.env.DATABASE_POOL_SIZE = "20";
    expect(configuredDatabasePoolSize()).toBe(20);
    for (const invalid of ["NaN", "0", "-1", "1.5", "101"]) {
      process.env.DATABASE_POOL_SIZE = invalid;
      expect(() => configuredDatabasePoolSize()).toThrow(
        /DATABASE_POOL_SIZE must be an integer/,
      );
    }
  });
});
