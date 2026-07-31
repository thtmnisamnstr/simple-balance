import { describe, expect, it } from "vitest";
import {
  decimalStringSchema,
  isoDateSchema,
  listQuerySchema,
  stageCreateSchema,
  transactionDraftSchema,
} from "../src/shared/domain.js";
import {
  normalizeCsvRows,
  parseLocalizedAmount,
  previewCsv,
  rowsToCsv,
} from "../src/shared/csv.js";
import { rangeForPreset } from "../src/client/date-range.js";

const accountId = "11111111-1111-4111-8111-111111111111";

describe("boundary schemas", () => {
  it("accepts money only as decimal strings", () => {
    expect(decimalStringSchema.safeParse("123456789.0123").success).toBe(true);
    expect(decimalStringSchema.safeParse(12.34).success).toBe(false);
    expect(decimalStringSchema.safeParse("01.00").success).toBe(false);
  });

  it("enforces the PostgreSQL numeric(38,12) storage boundary", () => {
    expect(
      decimalStringSchema.safeParse(
        "99999999999999999999999999.999999999999",
      ).success,
    ).toBe(true);
    expect(
      decimalStringSchema.safeParse(
        "-99999999999999999999999999.999999999999",
      ).success,
    ).toBe(true);
    expect(
      decimalStringSchema.safeParse(
        "100000000000000000000000000.000000000000",
      ).success,
    ).toBe(false);
    expect(decimalStringSchema.safeParse("0.1234567890123").success).toBe(false);
  });

  it("rejects impossible calendar dates", () => {
    expect(isoDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(isoDateSchema.safeParse("2025-02-29").success).toBe(false);
  });

  it("requires positive human-facing transaction amounts", () => {
    const parsed = transactionDraftSchema.safeParse({
      type: "withdrawal",
      date: "2026-07-30",
      description: "Lunch",
      fromAccountId: accountId,
      amount: "-12.50",
    });
    expect(parsed.success).toBe(false);
  });

  it("keeps incomplete drafts in staging for later correction", () => {
    const parsed = stageCreateSchema.parse({
      idempotencyKey: "stage-incomplete-draft",
      draft: {
        type: "withdrawal",
        date: "not-yet-fixed",
        description: "",
        amount: "unknown",
      },
    });
    expect(parsed.draft).toMatchObject({
      type: "withdrawal",
      date: "not-yet-fixed",
      amount: "unknown",
    });
  });

  it("parses query booleans only from booleans or literal true and false strings", () => {
    expect(listQuerySchema.parse({ includeDeleted: true }).includeDeleted).toBe(true);
    expect(listQuerySchema.parse({ includeDeleted: false }).includeDeleted).toBe(false);
    expect(listQuerySchema.parse({ includeDeleted: "true" }).includeDeleted).toBe(true);
    expect(listQuerySchema.parse({ includeDeleted: "false" }).includeDeleted).toBe(false);
    expect(listQuerySchema.parse({}).includeDeleted).toBe(false);
    expect(listQuerySchema.safeParse({ includeDeleted: "1" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ includeDeleted: "yes" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ includeDeleted: "" }).success).toBe(false);
  });
});

describe("date presets", () => {
  const now = new Date(2026, 6, 30, 12);

  it("creates inclusive current-month and trailing-day ranges", () => {
    expect(rangeForPreset("this-month", now)).toEqual({
      start: "2026-07-01",
      end: "2026-07-30",
    });
    expect(rangeForPreset("last-30", now)).toEqual({
      start: "2026-07-01",
      end: "2026-07-30",
    });
  });

  it("handles the previous month boundary", () => {
    expect(rangeForPreset("last-month", new Date(2026, 0, 9))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("uses the configured timezone at a calendar-day boundary", () => {
    const instant = new Date("2026-08-01T06:30:00.000Z");

    expect(
      rangeForPreset("this-month", instant, "America/Los_Angeles"),
    ).toEqual({
      start: "2026-07-01",
      end: "2026-07-31",
    });
    expect(rangeForPreset("this-month", instant, "Asia/Tokyo")).toEqual({
      start: "2026-08-01",
      end: "2026-08-01",
    });
  });
});

describe("CSV normalization", () => {
  it("detects delimiters and headers", () => {
    const result = previewCsv("Date;Memo;Amount\n30/07/2026;Cafe;-12,50\n");
    expect(result.delimiter).toBe(";");
    expect(result.headers).toEqual(["Date", "Memo", "Amount"]);
  });

  it("parses US, European, and parenthesized numbers", () => {
    expect(parseLocalizedAmount("1,234.56", ".")).toBe("1234.56");
    expect(parseLocalizedAmount("1.234,56", ",")).toBe("1234.56");
    expect(parseLocalizedAmount("1 234,56", ",")).toBe("1234.56");
    expect(parseLocalizedAmount("(14.20)", ".")).toBe("-14.20");
  });

  it("rejects malformed or mismatched thousands separators", () => {
    expect(parseLocalizedAmount("12,34", ".")).toBeNull();
    expect(parseLocalizedAmount("1,2,3", ".")).toBeNull();
    expect(parseLocalizedAmount("12.34", ",")).toBeNull();
    expect(parseLocalizedAmount("1 23 4", ".")).toBeNull();
  });

  it("turns signed bank rows into deposits and withdrawals", () => {
    const rows = normalizeCsvRows(
      [
        { Date: "07/30/2026", Memo: "Paycheck", Amount: "2,000.00" },
        { Date: "07/31/2026", Memo: "Rent", Amount: "-900.00" },
      ],
      {
        mapping: { date: "Date", description: "Memo", amount: "Amount" },
        defaultAccountId: accountId,
        dateFormat: "MDY",
        decimalSeparator: ".",
      },
    );
    expect(rows[0].draft).toMatchObject({ type: "deposit", amount: "2000.00" });
    expect(rows[1].draft).toMatchObject({ type: "withdrawal", amount: "900.00" });
  });

  it("stages ambiguous debit and credit rows as validation errors", () => {
    const [row] = normalizeCsvRows(
      [
        {
          Date: "07/30/2026",
          Memo: "Ambiguous bank row",
          Debit: "12.00",
          Credit: "12.00",
        },
      ],
      {
        mapping: {
          date: "Date",
          description: "Memo",
          debit: "Debit",
          credit: "Credit",
        },
        defaultAccountId: accountId,
        dateFormat: "MDY",
        decimalSeparator: ".",
      },
    );

    expect(row.draft).toBeNull();
    expect(row.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(/only one of debit and credit/i),
        }),
      ]),
    );
  });

  it("round-trips commas, quotes, and line breaks", () => {
    const csv = rowsToCsv([{ description: 'Cafe, "North"', notes: "line 1\nline 2" }]);
    const result = previewCsv(csv);
    expect(result.rows[0]).toEqual({
      description: 'Cafe, "North"',
      notes: "line 1\nline 2",
    });
  });

  it("neutralizes spreadsheet formulas only in designated free-text columns", () => {
    const csv = rowsToCsv(
      [
        {
          transaction_id: "11111111-1111-4111-8111-111111111111",
          date: "2026-07-30",
          description: "=HYPERLINK(\"https://example.invalid\")",
          payee: "  +SUM(1,2)",
          notes: "@malicious",
          source_amount: "-12.34",
          effective_rate: "1.2345",
        },
      ],
      ["description", "payee", "notes"],
    );
    const result = previewCsv(csv);

    expect(result.rows[0]).toEqual({
      transaction_id: "11111111-1111-4111-8111-111111111111",
      date: "2026-07-30",
      description: "'=HYPERLINK(\"https://example.invalid\")",
      payee: "'  +SUM(1,2)",
      notes: "'@malicious",
      source_amount: "-12.34",
      effective_rate: "1.2345",
    });
  });
});
