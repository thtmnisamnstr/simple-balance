import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  // Asking for more than the cap used to be reduced to it in silence, so a
  // deployment asking for a hundred thousand rows ran on ten thousand and was
  // told nothing. The number it can have is unchanged; what changed is that
  // asking for more says so by name, at startup, rather than being a limit
  // nobody chose. It still runs on the cap: a tuning knob is not worth an
  // outage, and refusing here would have stopped a deployment on upgrade over a
  // value the previous release accepted.
  it("is held to the cap, and says so, when a deployment asks for more", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CSV_MAX_ROWS = String(MAX_BULK_SELECTION_ENTRIES * 10);
    const limits = await import("../src/server/config-limits.js");
    expect(limits.configuredCsvMaxRows()).toBe(limits.DEFAULT_CSV_MAX_ROWS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CSV_MAX_ROWS"));
    warn.mockRestore();
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
    // And as a field, so a client never parses the sentence for the number.
    expect(() => getCsvPreview(csv)).toThrow(
      expect.objectContaining({ details: { field: "csv", limit: 64 } }),
    );
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

  /**
   * The Simple Balance file has the same two sides with one more reader. The
   * download goes out at the export cap, like the CSV; an agent gets one
   * import part's worth a call, because a tool's reply is serialized twice and
   * cannot stream, and a file of one part is one it can hand straight to an
   * import. The refusal names the same remedy, so a person or an agent meeting
   * it knows to narrow by date rather than to give up.
   */
  it("lets a Simple Balance file out at the export cap, and an agent one part at a time", async () => {
    const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const [route, tool, service] = await Promise.all([
      read("src/server/api.ts"),
      read("src/server/mcp.ts"),
      read("src/server/services/ledger-file.ts"),
    ]);
    expect(route).toMatch(/exportLedgerFile\([^;]*?maxRows: CSV_EXPORT_MAX_ROWS/s);
    expect(tool).toMatch(
      /exportLedgerFile\(actor, input, \{\s*maxRows: MAX_BULK_SELECTION_ENTRIES,/,
    );
    expect(service).toContain("export one range at a time");
  });

  /**
   * And the way back in is one part at a time, at the cap every bulk path
   * shares: a part that staged more rows than one commit can clear would be a
   * cap doing damage. The splitter never cuts one over it, so the refusal is
   * for a file somebody put together by hand, or for the browser's download —
   * which allows ten times the cap — handed whole to an agent. It names the
   * ways round it: the page cuts a larger file, a larger ledger exports a range
   * at a time, and an agent holding only the file cuts it by the splitter's
   * rules, which `tests/ledger-file-split.test.ts` holds the refusal to.
   */
  it("reads a Simple Balance file back a part at a time, at the shared cap", async () => {
    const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const service = await read("src/server/services/ledger-file.ts");
    expect(service).toMatch(/if \(count > MAX_BULK_SELECTION_ENTRIES\) \{/);
    expect(service).toContain("The import page cuts a larger file into parts");
    expect(service).toContain("export a larger ledger one date range at a time");
    // Every way a file is read back goes through that one reader: the
    // preview, the add, and the move, which writes a part's transactions
    // straight into the books and so must never meet more than a commit could.
    for (const reader of ["previewLedgerFile", "addLedgerFile", "moveLedgerFile"]) {
      expect(service, reader).toMatch(
        new RegExp(
          `export async function ${reader}\\((?:(?!export async function)[\\s\\S])*?= readPart\\(`,
        ),
      );
    }
  });

  /**
   * A part's records — accounts, categories, groups, templates, recurring
   * transactions, budgets — are bounded at the same number, apart from the
   * rows. Every one is created or matched in the part's one transaction under
   * every namespace lock, so a part of nothing but records was the one way to
   * hold a connection for as long as the list was long. Apart, because every
   * part carries every record: counted into the rows, an export of ten
   * thousand entries would stop being one part.
   */
  it("holds a Simple Balance file's records to the same cap, apart from its rows", async () => {
    const service = await readFile(
      new URL("../src/server/services/ledger-file.ts", import.meta.url),
      "utf8",
    );
    expect(service).toMatch(/if \(records > MAX_BULK_SELECTION_ENTRIES\) \{/);
    const shared = await import("../src/shared/ledger-file.js");
    const domain = await import("../src/shared/domain.js");
    const file = shared.parseLedgerFile((await import("./support/ledger-file.js")).wholeLedger());
    if (!file.ok) throw new Error("the fixture does not read");
    const many = {
      ...file.file,
      categories: Array.from({ length: domain.MAX_BULK_SELECTION_ENTRIES }, (_, n) => ({
        key: `Category ${n}`,
        name: `Category ${n}`,
        detail: "full" as const,
        kind: "expense" as const,
        group: null,
        archivedAt: null,
      })),
    };
    expect(shared.ledgerFileRecordCount(many)).toBeGreaterThan(domain.MAX_BULK_SELECTION_ENTRIES);
    expect(shared.ledgerFileRowCount(many)).toBeLessThan(domain.MAX_BULK_SELECTION_ENTRIES);
    expect(shared.splitLedgerFile(many)).toMatchObject({ ok: false });
  });

  /**
   * Rows do not bound the activity history, whose events carry a whole record
   * twice, so a file has a second limit on the history's bytes, chosen per
   * transport like the row cap and smaller for an agent for the same reason.
   * Its refusal names the one remedy that works, a range, which narrows the
   * history as well as the entries.
   */
  it("bounds a Simple Balance file's history by its bytes too, and names the way out", async () => {
    const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const [route, tool, service] = await Promise.all([
      read("src/server/api.ts"),
      read("src/server/mcp.ts"),
      read("src/server/services/ledger-file.ts"),
    ]);
    const limits = await import("../src/server/config-limits.js");
    expect(route).toMatch(
      /exportLedgerFile\([^;]*?maxHistoryBytes: LEDGER_FILE_HISTORY_MAX_BYTES/s,
    );
    expect(tool).toMatch(
      /exportLedgerFile\([^;]*?maxHistoryBytes: MCP_LEDGER_FILE_HISTORY_MAX_BYTES/s,
    );
    expect(limits.MCP_LEDGER_FILE_HISTORY_MAX_BYTES).toBeLessThan(
      limits.LEDGER_FILE_HISTORY_MAX_BYTES,
    );
    expect(service).toContain(
      "Narrow the activity history with a start and end date, and export one range at a time.",
    );
  });
});
