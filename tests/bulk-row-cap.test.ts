import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  CSV_EXPORT_MAX_ROWS,
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

  // It used to be reduced to the cap, which meant a deployment asking for a
  // hundred thousand rows ran on ten thousand and was told nothing. The number
  // it can have is unchanged; what changed is that asking for more is a refusal
  // naming the variable, at startup, rather than a limit nobody chose.
  it("cannot be configured above the cap", () => {
    process.env.CSV_MAX_ROWS = String(MAX_BULK_SELECTION_ENTRIES * 10);
    expect(() => configuredCsvMaxRows()).toThrow(
      new RegExp(`CSV_MAX_ROWS must be an integer between 1 and ${MAX_BULK_SELECTION_ENTRIES}`),
    );
  });

  it("can still be lowered by a deployment", () => {
    process.env.CSV_MAX_ROWS = "500";
    expect(configuredCsvMaxRows()).toBe(500);
  });

  it.each([
    ["transactions", bulkTransactionSelectionSchema],
    ["staged rows", bulkStageSelectionSchema],
  ])("refuses a %s filter selection claiming more than the cap", (_label, schema) => {
    expect(schema.safeParse(filterSelection(MAX_BULK_SELECTION_ENTRIES)).success).toBe(true);
    expect(schema.safeParse(filterSelection(MAX_BULK_SELECTION_ENTRIES + 1)).success).toBe(false);
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
    expect(transactionTemplateBulkSelectionSchema.safeParse({ items }).success).toBe(false);
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

/**
 * The exit is never smaller than the entrance.
 *
 * Ten thousand rows is the import cap and it is deliberately not the export
 * cap. They answer different questions: the import cap is a fact about what one
 * mass action can then clear, so a file that stages more than a commit can
 * handle is a cap doing damage. The export is the way out, and capping the way
 * out at what one import can take would mean a forty-thousand-row ledger cannot
 * leave this product whole — a worse failure than a file its own importer asks
 * you to split.
 *
 * So the gap is intentional, and this asserts the direction rather than the
 * numbers. An edit that quietly makes them equal fails here.
 */
describe("the export cap against the import cap", () => {
  it("lets more out than one import can take back", () => {
    expect(CSV_EXPORT_MAX_ROWS).toBeGreaterThan(MAX_BULK_SELECTION_ENTRIES);
  });

  it("names the remedy on both sides, because the gap is only safe if it is explained", async () => {
    const exportSide = await readFile(
      new URL("../src/server/services/transactions.ts", import.meta.url),
      "utf8",
    );
    const importSide = await readFile(
      new URL("../src/server/services/import-export.ts", import.meta.url),
      "utf8",
    );
    expect(exportSide).toContain("export one range at a time");
    expect(importSide).toContain("imported one range at a time");
  });
});
