import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CSV_MAX_ROWS,
  MAX_CSV_CONFIGURATION_ROWS,
  configuredCsvMaxRows,
} from "../src/server/config-limits.js";
import { getCsvPreview } from "../src/server/services/import-export.js";
import { AppError } from "../src/server/services/errors.js";
import { exceedsBulkSelectionCap } from "../src/server/services/helpers.js";
import {
  MAX_BULK_SELECTION_ENTRIES,
  MAX_TRANSACTION_TEMPLATES,
  bulkStageSelectionSchema,
  bulkTransactionSelectionSchema,
  transactionTemplateBulkSelectionSchema,
} from "../src/shared/domain.js";

const savedCsvMaxRows = process.env.CSV_MAX_ROWS;
const savedCsvMaxBytes = process.env.CSV_MAX_BYTES;

afterEach(() => {
  if (savedCsvMaxRows === undefined) delete process.env.CSV_MAX_ROWS;
  else process.env.CSV_MAX_ROWS = savedCsvMaxRows;
  if (savedCsvMaxBytes === undefined) delete process.env.CSV_MAX_BYTES;
  else process.env.CSV_MAX_BYTES = savedCsvMaxBytes;
});

const filterSelection = (expectedCount: number) => ({
  mode: "filter" as const,
  filter: {},
  excludedIds: [],
  expectedCount,
  expectedFingerprint: "0".repeat(64),
});

/**
 * One number, everywhere. A person who meets the cap on a mass edit should not
 * find a different one on an import, and an import that stages more rows than a
 * single commit covers leaves a queue nothing can clear in one action.
 */
describe("the row cap every bulk path shares", () => {
  it("is the same for a CSV import as for a mass action", () => {
    expect(DEFAULT_CSV_MAX_ROWS).toBe(MAX_BULK_SELECTION_ENTRIES);
    expect(MAX_CSV_CONFIGURATION_ROWS).toBe(MAX_BULK_SELECTION_ENTRIES);
  });

  it("cannot be configured above the cap", () => {
    process.env.CSV_MAX_ROWS = String(MAX_BULK_SELECTION_ENTRIES * 10);
    expect(configuredCsvMaxRows()).toBe(MAX_BULK_SELECTION_ENTRIES);
  });

  it("can still be lowered by a deployment", () => {
    process.env.CSV_MAX_ROWS = "500";
    expect(configuredCsvMaxRows()).toBe(500);
  });

  it.each([
    ["transactions", bulkTransactionSelectionSchema],
    ["staged rows", bulkStageSelectionSchema],
  ])("refuses a %s filter selection claiming more than the cap", (_label, schema) => {
    expect(schema.safeParse(filterSelection(MAX_BULK_SELECTION_ENTRIES)).success).toBe(
      true,
    );
    expect(
      schema.safeParse(filterSelection(MAX_BULK_SELECTION_ENTRIES + 1)).success,
    ).toBe(false);
  });

  it("caps a template mass edit at the number of templates that can exist", () => {
    const items = Array.from({ length: MAX_TRANSACTION_TEMPLATES + 1 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      expectedVersion: 1,
    }));
    expect(
      transactionTemplateBulkSelectionSchema.safeParse({
        items: items.slice(0, MAX_TRANSACTION_TEMPLATES),
      }).success,
    ).toBe(true);
    expect(
      transactionTemplateBulkSelectionSchema.safeParse({ items }).success,
    ).toBe(false);
  });

  it("says the same thing however the cap is met", () => {
    expect(exceedsBulkSelectionCap("transactions")).toContain("10,000 transactions");
    expect(exceedsBulkSelectionCap("staged rows")).toContain("10,000 staged rows");
  });
});

describe("the CSV preview", () => {
  it("refuses a file larger than the import would accept", () => {
    process.env.CSV_MAX_BYTES = "64";
    const csv = `date,payee,amount\n${"2026-01-01,Someone,1.00\n".repeat(50)}`;
    expect(() => getCsvPreview(csv)).toThrow(AppError);
    expect(() => getCsvPreview(csv)).toThrow(/64-byte limit/);
  });

  it("still previews a file within the limit", () => {
    process.env.CSV_MAX_BYTES = String(1024 * 1024);
    const preview = getCsvPreview("date,payee,amount\n2026-01-01,Someone,1.00\n");
    expect(preview.headers).toEqual(["date", "payee", "amount"]);
    expect(preview.rows).toHaveLength(1);
  });
});
