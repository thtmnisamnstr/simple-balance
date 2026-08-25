import { describe, expect, it } from "vitest";
import {
  decimalStringSchema,
  accountCreateSchema,
  bulkDeleteStageSchema,
  bulkTransactionEditSchema,
  commitStageSchema,
  isoDateSchema,
  listQuerySchema,
  resolveEntrySide,
  reversesEntry,
  stageCreateSchema,
  transactionDraftSchema,
} from "../src/shared/domain.js";
import {
  CSV_MEDIA_TYPE,
  csvFileLine,
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
      decimalStringSchema.safeParse("99999999999999999999999999.999999999999999999").success,
    ).toBe(true);
    expect(
      decimalStringSchema.safeParse("-99999999999999999999999999.999999999999999999").success,
    ).toBe(true);
    expect(
      decimalStringSchema.safeParse("100000000000000000000000000.000000000000000000").success,
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

  /**
   * The staged selection encodes its versions as a map beside the ids rather
   * than as a list of pairs, which leaves `expectedVersion` a plausible thing
   * to type. MCP refused it by name at the tool boundary from the start; HTTP
   * dropped it and read the request as one naming no versions at all, which is
   * the same field being accepted from one caller and not the other.
   */
  it("refuses an unrecognised key on either staged selection", () => {
    const selection = {
      stagedIds: [accountId],
      expectedVersions: { [accountId]: 1 },
    };
    expect(commitStageSchema.safeParse({ ...selection, idempotencyKey: "commit-1" }).success).toBe(
      true,
    );
    expect(bulkDeleteStageSchema.safeParse(selection).success).toBe(true);

    expect(
      commitStageSchema.safeParse({
        ...selection,
        idempotencyKey: "commit-2",
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(bulkDeleteStageSchema.safeParse({ ...selection, expectedVersion: 1 }).success).toBe(
      false,
    );
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

    expect(rangeForPreset("this-month", instant, "America/Los_Angeles")).toEqual({
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

  /**
   * A row the importer could not finish is exactly the row somebody is in the
   * queue to fix, so what it did read has to arrive with it. Throwing it away
   * meant retyping a date and a payee the importer had already understood.
   */
  it("keeps what it read from a row it could not finish", () => {
    const [row] = normalizeCsvRows(
      [{ Date: "07/30/2026", Memo: "Corner shop", Amount: "not a number" }],
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

    expect(row.draft).toBeNull();
    expect(row.issues.map((issue) => issue.field)).toContain("amount");
    expect(row.partial).toMatchObject({
      date: "2026-07-30",
      payee: "Corner shop",
      description: "Corner shop",
      fromAccountId: accountId,
    });
    // The one field it could not read is absent rather than guessed at.
    expect(row.partial).not.toHaveProperty("amount");
  });

  /**
   * A negative in a debit or credit column is direction stated twice and
   * disagreeing. Reading it either way silently reverses half of real bank
   * files, so the row is refused with the sign still legible rather than
   * staged in whichever direction the column implied.
   */
  describe("a signed value in a debit or credit column", () => {
    const rowWith = (cells: Record<string, string>) =>
      normalizeCsvRows([{ Date: "07/30/2026", Memo: "Reversal", ...cells }], {
        mapping: {
          date: "Date",
          payee: "Memo",
          debit: "Debit",
          credit: "Credit",
        },
        defaultAccountId: accountId,
        dateFormat: "MDY",
        decimalSeparator: ".",
      })[0];

    const oneColumn = (column: "Debit" | "Credit", value: string) =>
      normalizeCsvRows([{ Date: "07/30/2026", Memo: "Reversal", [column]: value }], {
        mapping: {
          date: "Date",
          payee: "Memo",
          ...(column === "Debit" ? { debit: "Debit" } : { credit: "Credit" }),
        },
        defaultAccountId: accountId,
        dateFormat: "MDY",
        decimalSeparator: ".",
      })[0];

    // With only one of the two columns mapped, the sign is the one other thing
    // in the file that could state direction, and nothing says which was meant.
    it.each([
      ["Credit", "-250.00"],
      ["Debit", "-250.00"],
      ["Credit", "(250.00)"],
      ["Debit", "(250.00)"],
    ] as const)("refuses %s %s when it is the only column", (column, value) => {
      const row = oneColumn(column, value);
      expect(row.draft).toBeNull();
      expect(row.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: column.toLowerCase(),
            message: expect.stringMatching(/states a direction the column already states/i),
          }),
        ]),
      );
    });

    // With both columns mapped the other one is what a reversal goes in, so a
    // sign is redundant rather than contradictory and the column decides. This
    // is how nearly every two-column bank export is written, and refusing it
    // left files with no mapping that would import them at all.
    it.each([
      ["Debit", "-50.00", "withdrawal"],
      ["Credit", "-50.00", "deposit"],
      ["Debit", "(50.00)", "withdrawal"],
    ] as const)("reads %s %s as a %s when both columns are mapped", (column, value, type) => {
      const row = rowWith({ [column]: value });
      expect(row.draft).toMatchObject({ type, amount: "50.00" });
      expect(row.issues).toEqual([]);
    });

    it("still reads an unsigned value in either column", () => {
      expect(rowWith({ Debit: "250.00" }).draft).toMatchObject({
        type: "withdrawal",
        amount: "250.00",
      });
      expect(rowWith({ Credit: "250.00" }).draft).toMatchObject({
        type: "deposit",
        amount: "250.00",
      });
    });

    it("still honours the sign on a mapped signed-amount column", () => {
      const [row] = normalizeCsvRows(
        [{ Date: "07/30/2026", Memo: "Reversal", Amount: "-250.00" }],
        {
          mapping: { date: "Date", payee: "Memo", amount: "Amount" },
          defaultAccountId: accountId,
          dateFormat: "MDY",
          decimalSeparator: ".",
        },
      );
      expect(row.draft).toMatchObject({ type: "withdrawal", amount: "250.00" });
    });

    it("still refuses two columns each holding an amount", () => {
      const row = rowWith({ Debit: "-250.00", Credit: "100.00" });
      expect(row.draft).toBeNull();
      expect(row.issues.map((issue) => issue.message).join(" ")).toMatch(
        /only one of debit and credit/i,
      );
    });

    it("leaves a signed zero alone", () => {
      const row = oneColumn("Debit", "-0.00");
      expect(row.draft).toBeNull();
      expect(row.issues.map((issue) => issue.message).join(" ")).not.toMatch(
        /states a direction the column already states/i,
      );
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
          description: '=HYPERLINK("https://example.invalid")',
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
      description: '\'=HYPERLINK("https://example.invalid")',
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
      const rows = normalizeCsvRows([{ Date: "2026-07-30", Memo: "Paycheck", Amount: "10.00" }], {
        mapping: mapping({ payee: inherited }),
        dateFormat: "YMD",
        decimalSeparator: ".",
        defaultAccountId: accountId,
      });
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

/**
 * The rule the browser previews and the services enforce. Kept here as well as
 * in the ledger tests because those prove the postings it produces, and these
 * prove the rule itself, which is the thing two sides have to agree about.
 */
describe("which side of the books an entry lands on", () => {
  it("follows the direction when nothing contradicts it", () => {
    expect(resolveEntrySide("deposit", [])).toEqual({
      ok: true,
      counterKind: "income",
      reversal: false,
    });
    expect(resolveEntrySide("withdrawal", [])).toEqual({
      ok: true,
      counterKind: "expense",
      reversal: false,
    });
  });

  it("reads a spending category on a deposit as a refund", () => {
    expect(resolveEntrySide("deposit", ["expense"])).toEqual({
      ok: true,
      counterKind: "expense",
      reversal: true,
    });
  });

  it("reads an income category on a withdrawal as income going back", () => {
    expect(resolveEntrySide("withdrawal", ["income"])).toEqual({
      ok: true,
      counterKind: "income",
      reversal: true,
    });
  });

  it("lets a both-kind category go either way without reversing anything", () => {
    expect(resolveEntrySide("deposit", ["both"])).toMatchObject({
      counterKind: "income",
      reversal: false,
    });
    expect(resolveEntrySide("withdrawal", ["both", "expense"])).toMatchObject({
      counterKind: "expense",
      reversal: false,
    });
  });

  it("refuses an entry that is income and a refund at once", () => {
    const side = resolveEntrySide("deposit", ["income", "expense"]);
    expect(side.ok).toBe(false);
    expect(side.ok === false && side.message).toMatch(/either income or a refund/i);
  });

  it("says a transfer reverses nothing, because it files under no category", () => {
    expect(reversesEntry("transfer", "income")).toBe(false);
    expect(reversesEntry("transfer", "expense")).toBe(false);
    expect(reversesEntry("deposit", "expense")).toBe(true);
    expect(reversesEntry("withdrawal", "income")).toBe(true);
    expect(reversesEntry("deposit", "both")).toBe(false);
  });
});

/**
 * The media type says the first record is a header.
 *
 * RFC 4180's registration defines `header` as `present` or `absent`, and it is
 * the parameter that decides how a reader treats the first record. The export
 * used to declare only `charset`, which tells a consumer the encoding and
 * leaves it to guess the thing that actually changes the parse.
 *
 * The parameter and the header-only empty file are one claim, so they are
 * pinned in one test: if an export matching nothing ever goes back to returning
 * the empty string, `header=present` becomes a lie and this fails.
 */
describe("the CSV media type", () => {
  it("declares a header row, and the export always writes one", () => {
    expect(CSV_MEDIA_TYPE).toBe("text/csv; charset=utf-8; header=present");
    expect(rowsToCsv([], [], ["a", "b"])).toBe("a,b");
    expect(rowsToCsv([{ a: "1", b: "2" }]).split("\r\n")[0]).toBe("a,b");
  });
});

/**
 * One row number, counted the way a person counts.
 *
 * Papa Parse reports two different bases for two different faults, and neither
 * is the line number a spreadsheet shows. A `FieldMismatch` counts data records
 * with the header already removed; a `Quotes` error counts physical records
 * with the header among them. So the same file could report "Row 3" for a fault
 * on line 4 and "Row 2" for a fault on line 3 — both wrong, and wrong by
 * different amounts, which is worse than being consistently off.
 *
 * These cases pin the dependency's behaviour as much as ours: if papaparse ever
 * changes either base, this fails rather than the numbers quietly shifting.
 */
describe("which line of a CSV an error is about", () => {
  it("reports the file's own line for a row with too few fields", () => {
    const preview = previewCsv("date,payee,amount\r\n2026-01-01,Shop,1.00\r\n2026-01-02,Shop\r\n");
    expect(preview.errors.some((error) => error.startsWith("Row 3:"))).toBe(true);
  });

  it("counts the header as row 1, so the first data row is row 2", () => {
    const preview = previewCsv("date,payee,amount\r\n2026-01-01,Shop\r\n");
    expect(preview.errors.some((error) => error.startsWith("Row 2:"))).toBe(true);
  });

  it("says nothing rather than guessing when the parser gave no row", () => {
    expect(csvFileLine({ type: "Delimiter" })).toBeNull();
  });

  // The two bases, stated as the arithmetic, so the reason for the helper
  // survives even if papaparse's own naming changes.
  it("shifts a field mismatch by two and a quote fault by one", () => {
    expect(csvFileLine({ type: "FieldMismatch", row: 0 })).toBe(2);
    expect(csvFileLine({ type: "Quotes", row: 0 })).toBe(1);
  });
});
