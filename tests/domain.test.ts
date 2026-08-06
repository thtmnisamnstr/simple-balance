import { describe, expect, it } from "vitest";
import {
  decimalStringSchema,
  accountCreateSchema,
  bulkTransactionEditSchema,
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
import {
  currencyOptionLabel,
  currencyOptions,
  timezoneOptionLabel,
} from "../src/client/select-options.js";

const accountId = "11111111-1111-4111-8111-111111111111";

describe("boundary schemas", () => {
  it("accepts money only as decimal strings", () => {
    expect(decimalStringSchema.safeParse("123456789.0123").success).toBe(true);
    expect(decimalStringSchema.safeParse(12.34).success).toBe(false);
    expect(decimalStringSchema.safeParse("01.00").success).toBe(false);
  });

  it("enforces the PostgreSQL numeric(44,18) storage boundary", () => {
    expect(
      decimalStringSchema.safeParse(
        "99999999999999999999999999.999999999999999999",
      ).success,
    ).toBe(true);
    expect(
      decimalStringSchema.safeParse(
        "-99999999999999999999999999.999999999999999999",
      ).success,
    ).toBe(true);
    expect(
      decimalStringSchema.safeParse(
        "100000000000000000000000000.000000000000000000",
      ).success,
    ).toBe(false);
    expect(decimalStringSchema.safeParse("0.123456789012345678").success).toBe(true);
    expect(decimalStringSchema.safeParse("0.1234567890123456789").success).toBe(false);
  });

  it("accepts crypto wallet accounts and common crypto asset symbols", () => {
    expect(
      accountCreateSchema.safeParse({
        name: "Cold wallet",
        type: "crypto_wallet",
        currency: "USDT",
        openingDate: "2026-07-30",
        openingBalance: "0.000000000000000001",
      }).success,
    ).toBe(true);
    expect(currencyOptions("USD")).toEqual(
      expect.arrayContaining(["BTC", "ETH", "SOL", "USDC", "USDT"]),
    );
    expect(currencyOptionLabel("USDT")).toBe("Tether (USDT)");
    expect(timezoneOptionLabel("America/Los_Angeles")).toMatch(
      /America \/ Los Angeles.*\(UTC[+-]\d{2}:\d{2}\)/,
    );
  });

  it("rejects impossible calendar dates", () => {
    expect(isoDateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(isoDateSchema.safeParse("2025-02-29").success).toBe(false);
  });

  it("requires positive human-facing transaction amounts", () => {
    const parsed = transactionDraftSchema.safeParse({
      type: "withdrawal",
      date: "2026-07-30",
      payee: "Lunch counter",
      description: "Lunch",
      fromAccountId: accountId,
      amount: "-12.50",
    });
    expect(parsed.success).toBe(false);
  });

  it("requires a payee and permits an omitted description", () => {
    expect(
      transactionDraftSchema.safeParse({
        type: "deposit",
        date: "2026-07-30",
        payee: "Employer",
        toAccountId: accountId,
        amount: "100",
      }).success,
    ).toBe(true);
    expect(
      transactionDraftSchema.safeParse({
        type: "deposit",
        date: "2026-07-30",
        description: "Salary",
        toAccountId: accountId,
        amount: "100",
      }).success,
    ).toBe(false);
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

  it("strictly validates explicit and snapshot-protected bulk transaction edits", () => {
    const explicit = bulkTransactionEditSchema.parse({
      selection: {
        mode: "ids",
        items: [{ id: accountId, expectedVersion: 1 }],
      },
      patch: { payee: "Updated payee", notes: "" },
      idempotencyKey: "bulk-domain-explicit",
    });
    expect(explicit).toMatchObject({
      allowDuplicates: false,
      dryRun: false,
      patch: { payee: "Updated payee", notes: null },
    });
    expect(explicit.patch).not.toHaveProperty("description");

    expect(
      bulkTransactionEditSchema.safeParse({
        selection: {
          mode: "filter",
          filter: { start: "2026-07-01", includeDeleted: false },
          excludedIds: [],
          expectedCount: 2,
          expectedFingerprint: "a".repeat(64),
        },
        patch: { categoryId: null, description: null },
        idempotencyKey: "bulk-domain-filter",
        dryRun: true,
      }).success,
    ).toBe(true);
    expect(
      bulkTransactionEditSchema.safeParse({
        selection: {
          mode: "filter",
          filter: { limit: 50 },
          excludedIds: [],
        },
        patch: {},
        idempotencyKey: "bulk-domain-invalid",
      }).success,
    ).toBe(false);
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
        mapping: {
          date: "Date",
          payee: "Memo",
          description: "Memo",
          amount: "Amount",
        },
        defaultAccountId: accountId,
        dateFormat: "MDY",
        decimalSeparator: ".",
      },
    );
    expect(rows[0].draft).toMatchObject({
      type: "deposit",
      payee: "Paycheck",
      amount: "2000.00",
    });
    expect(rows[1].draft).toMatchObject({
      type: "withdrawal",
      payee: "Rent",
      amount: "900.00",
    });
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
          payee: "Memo",
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

// A mapping names the column each field is read from, and the names come from
// whoever is doing the import rather than from us.
describe("reading a CSV cell", () => {
  const mapping = (over: Record<string, string>) => ({
    date: "Date",
    payee: "Memo",
    amount: "Amount",
    ...over,
  });

  it("treats an inherited property name as a missing column", () => {
    for (const inherited of ["__proto__", "constructor", "toString"]) {
      const rows = normalizeCsvRows(
        [{ Date: "2026-07-30", Memo: "Paycheck", Amount: "10.00" }],
        {
          mapping: mapping({ payee: inherited }),
          dateFormat: "YMD",
          decimalSeparator: ".",
          defaultAccountId: accountId,
        },
      );
      // No throw, and the row simply says the field is missing.
      expect(rows[0]!.draft, inherited).toBeNull();
      expect(
        rows[0]!.issues.some((issue) => issue.field === "payee"),
        inherited,
      ).toBe(true);
    }
  });

  // A bank really can head a column `__proto__`, and the parser hands that back
  // as an own property. Written as an object literal it would set the prototype
  // instead, which is why this one is built with defineProperty: the literal
  // form silently tests the missing-column case above all over again.
  it("still reads a column that is genuinely named that", () => {
    const row: Record<string, string> = {
      Date: "2026-07-30",
      Amount: "10.00",
    };
    Object.defineProperty(row, "__proto__", {
      value: "Paycheck",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const rows = normalizeCsvRows([row], {
      mapping: mapping({ payee: "__proto__" }),
      dateFormat: "YMD",
      decimalSeparator: ".",
      defaultAccountId: accountId,
    });
    expect(rows[0]!.draft).toMatchObject({ payee: "Paycheck" });
  });
});
