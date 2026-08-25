import Papa from "papaparse";
import { z } from "zod";
import { isoDateSchema, positiveDecimalStringSchema, type TransactionDraft } from "./domain.js";

export const APP_CSV_FORMAT = "simple-balance-csv-1";

/**
 * The columns an export writes. A file carrying all of them is one of ours.
 *
 * The four account columns are written for a person to read and are never read
 * back, because they name accounts in the ledger the file came from rather than
 * the one it is going into.
 */
export const APP_CSV_COLUMNS = [
  "simple_balance_format",
  "transaction_id",
  "transaction_type",
  "date",
  "payee",
  "description",
  "category_id",
  "category_name",
  "notes",
  "roundtrip_text_json",
  "source_account_id",
  "source_account_name",
  "source_amount",
  "source_currency",
  "destination_account_id",
  "destination_account_name",
  "destination_amount",
  "destination_currency",
  "effective_rate",
] as const;

/**
 * `legs_json` is deliberately not one of the columns above. That list is what a
 * file must carry to be recognised as an export at all, so adding to it would
 * stop every file written by an earlier version from being recognised as one.
 * A split is read back when the column is there and nothing is missed when it
 * is not.
 */
export const APP_CSV_LEGS_COLUMN = "legs_json";

/**
 * The bank's own reference for the row, out of the same list and for the same
 * reason. It is written for a person to read; the value the importer trusts
 * travels in `roundtrip_text_json`, where the spreadsheet-formula neutraliser
 * cannot reach it.
 */
export const APP_CSV_EXTERNAL_ID_COLUMN = "external_id";

export function isAppExportCsv(headers: readonly string[]) {
  const available = new Set(headers);
  return APP_CSV_COLUMNS.every((column) => available.has(column));
}

/**
 * The split an exported row carries, or nothing.
 *
 * A leg the file cannot be read as is left out rather than guessed at; the
 * amounts have to add up to the transaction total, and the draft schema and the
 * ledger both refuse a split that does not.
 */
export function parseExportedLegs(value: string | undefined) {
  if (!value?.trim()) return undefined;
  const parsed = z
    .array(
      z
        .object({
          categoryName: z.string().trim().min(1).max(120).nullable().optional(),
          amount: z.string(),
          note: z.string().nullable().optional(),
        })
        .strict(),
    )
    .min(2)
    .safeParse(
      (() => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })(),
    );
  return parsed.success ? parsed.data : null;
}

export const csvMappingSchema = z
  .object({
    date: z.string().min(1),
    payee: z.string().min(1),
    description: z.string().optional(),
    amount: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    category: z.string().optional(),
    notes: z.string().optional(),
    externalId: z.string().optional(),
  })
  .refine((mapping) => Boolean(mapping.amount || mapping.debit || mapping.credit), {
    message: "Map an amount column, or a debit column, or a credit column",
  });

export type CsvMapping = z.infer<typeof csvMappingSchema>;

export type CsvPreview = {
  delimiter: string;
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
};

export function previewCsv(csv: string, limit = 25): CsvPreview {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
    transform: (value) => value.trim(),
    preview: limit,
  });

  return {
    delimiter: parsed.meta.delimiter,
    headers: parsed.meta.fields ?? [],
    rows: parsed.data,
    errors: parsed.errors.map((error) => `Row ${error.row ?? "?"}: ${error.message}`),
  };
}

export function parseLocalizedAmount(value: string, decimalSeparator: "." | ","): string | null {
  let unsigned = value.trim().replace(/[\u00a0\u202f]/g, " ");
  if (!unsigned) return null;
  let negative = false;
  const parenthesized = /^\((.*)\)$/.exec(unsigned);
  if (parenthesized) {
    negative = true;
    unsigned = parenthesized[1]!;
  } else if (unsigned.startsWith("-")) {
    negative = true;
    unsigned = unsigned.slice(1);
  }
  if (!unsigned || unsigned.startsWith("+") || unsigned.includes("-")) {
    return null;
  }

  const groupingSeparator = decimalSeparator === "." ? "," : ".";
  const decimalParts = unsigned.split(decimalSeparator);
  if (decimalParts.length > 2) return null;
  const [integerPart, fraction] = decimalParts;
  if (!integerPart || (fraction !== undefined && !/^\d+$/.test(fraction))) {
    return null;
  }

  const usesConfiguredGrouping = integerPart.includes(groupingSeparator);
  const usesSpaceGrouping = integerPart.includes(" ");
  if (usesConfiguredGrouping && usesSpaceGrouping) return null;
  const grouping = usesConfiguredGrouping ? groupingSeparator : usesSpaceGrouping ? " " : null;
  if (grouping && !new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(integerPart)) {
    return null;
  }
  const normalizedInteger = grouping ? integerPart.replaceAll(grouping, "") : integerPart;
  if (!/^(?:0|[1-9]\d*)$/.test(normalizedInteger)) return null;

  const normalized = `${negative ? "-" : ""}${normalizedInteger}${
    fraction === undefined ? "" : `.${fraction}`
  }`;
  return normalized;
}

function parseCsvDate(value: string, dateFormat: "YMD" | "MDY" | "DMY"): string | null {
  const trimmed = value.trim();
  if (dateFormat === "YMD") {
    return isoDateSchema.safeParse(trimmed).success ? trimmed : null;
  }
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed);
  if (!match) return null;
  const [, first, second, year] = match;
  const month = dateFormat === "MDY" ? first : second;
  const day = dateFormat === "MDY" ? second : first;
  const result = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isoDateSchema.safeParse(result).success ? result : null;
}

export type CsvNormalizeOptions = {
  mapping: CsvMapping;
  defaultAccountId: string;
  dateFormat: "YMD" | "MDY" | "DMY";
  decimalSeparator: "." | ",";
};

export type NormalizedCsvRow = {
  draft: TransactionDraft | null;
  issues: { field: string; message: string }[];
  rawData: Record<string, string>;
  /**
   * What was read from a row that could not be assembled into a draft.
   *
   * The queue exists to fix rows like this, and fixing one is much easier when
   * the six fields that did parse are already in it. Only ever set beside a null
   * draft; `stageCsv` stores whichever of the two is present.
   */
  partial?: Record<string, unknown>;
};

/**
 * A cell, or the empty string when the row has no such column.
 *
 * A mapping names the column each field comes from, and the names come from
 * whoever is doing the import. Indexing straight into the row would answer
 * `__proto__` or `constructor` with something inherited rather than with a
 * cell, and `?? ""` does not catch it because it is not missing, just not a
 * string. What arrives downstream is then an object where text was expected.
 */
export function csvCell(row: Record<string, string>, column: string | undefined) {
  if (!column) return "";
  if (!Object.hasOwn(row, column)) return "";
  const value = row[column];
  return typeof value === "string" ? value : "";
}

const zeroAmountPattern = /^-?0(?:\.0+)?$/;

export function normalizeCsvRows(
  rows: Record<string, string>[],
  options: CsvNormalizeOptions,
): NormalizedCsvRow[] {
  const { mapping } = options;
  return rows.map((row) => {
    const issues: { field: string; message: string }[] = [];
    const date = parseCsvDate(csvCell(row, mapping.date), options.dateFormat);
    if (!date) issues.push({ field: "date", message: "Date could not be parsed" });

    const payee = csvCell(row, mapping.payee).trim();
    if (!payee) issues.push({ field: "payee", message: "Payee is required" });
    const description = mapping.description
      ? csvCell(row, mapping.description).trim() || null
      : null;

    const signedRaw = csvCell(row, mapping.amount);
    const debitRaw = csvCell(row, mapping.debit);
    const creditRaw = csvCell(row, mapping.credit);
    const signedAmount = mapping.amount
      ? parseLocalizedAmount(signedRaw, options.decimalSeparator)
      : null;
    const debit = mapping.debit ? parseLocalizedAmount(debitRaw, options.decimalSeparator) : null;
    const credit = mapping.credit
      ? parseLocalizedAmount(creditRaw, options.decimalSeparator)
      : null;

    if (mapping.amount && signedRaw.trim() && signedAmount === null) {
      issues.push({
        field: "amount",
        message: "Amount has invalid decimal or thousands separators",
      });
    }
    if (!mapping.amount && mapping.debit && debitRaw.trim() && debit === null) {
      issues.push({
        field: "debit",
        message: "Debit has invalid decimal or thousands separators",
      });
    }
    if (!mapping.amount && mapping.credit && creditRaw.trim() && credit === null) {
      issues.push({
        field: "credit",
        message: "Credit has invalid decimal or thousands separators",
      });
    }

    const debitPresent = !mapping.amount && Boolean(debit) && !zeroAmountPattern.test(debit!);
    const creditPresent = !mapping.amount && Boolean(credit) && !zeroAmountPattern.test(credit!);
    if (debitPresent && creditPresent) {
      issues.push({
        field: "amount",
        message: "Only one of debit and credit may contain a non-zero amount",
      });
    }

    // A sign is only ambiguous where it is the one other thing that could state
    // direction. Where the file has both columns, the other one is what carries
    // a reversal, so a sign is redundant and the column decides — which is how
    // nearly every two-column bank export is written. Where it has one, a sign
    // is the only way that file can express the other direction, and reading it
    // either way silently reverses half of real files, so the row is refused
    // the way both columns holding a value is refused just above.
    const bothColumnsMapped = Boolean(mapping.debit && mapping.credit);
    const signedColumn =
      !bothColumnsMapped &&
      ((debitPresent && debit!.startsWith("-") && "debit") ||
        (creditPresent && credit!.startsWith("-") && "credit"));
    if (signedColumn) {
      issues.push({
        field: signedColumn,
        message:
          "A negative value states a direction the column already states, and this file has no other column to say which was meant. Map a debit and a credit column, or a signed amount column, so the direction is stated once.",
      });
    }

    const debitReadable = debitPresent && (bothColumnsMapped || !debit!.startsWith("-"));
    const creditReadable = creditPresent && (bothColumnsMapped || !credit!.startsWith("-"));
    const signedDebit = debitReadable;
    const signedCredit = creditReadable;
    let type: "deposit" | "withdrawal";
    let amount: string | null;
    if (mapping.amount && signedAmount) {
      type = signedAmount.startsWith("-") ? "withdrawal" : "deposit";
      amount = signedAmount.replace(/^-/, "");
    } else if (debitPresent && creditPresent) {
      type = "withdrawal";
      amount = null;
    } else if (signedDebit) {
      type = "withdrawal";
      amount = debit!.replace(/^-/, "");
    } else if (signedCredit) {
      type = "deposit";
      amount = credit!.replace(/^-/, "");
    } else {
      type = "withdrawal";
      amount = null;
    }

    if (!amount || !positiveDecimalStringSchema.safeParse(amount).success) {
      issues.push({ field: "amount", message: "A non-zero amount is required" });
    }

    if (issues.length || !date || !amount || !payee) {
      // Everything that did parse travels with the row. Returning nothing threw
      // away five good fields because a sixth was unreadable, leaving somebody to
      // retype a date and a payee the importer had already understood — and the
      // app-export reader beside this one has always refused to do that.
      return {
        draft: null,
        issues,
        rawData: row,
        partial: {
          type,
          ...(date ? { date } : {}),
          ...(payee ? { payee } : {}),
          ...(amount ? { amount } : {}),
          ...(description ? { description } : {}),
          ...(csvCell(row, mapping.notes) ? { notes: csvCell(row, mapping.notes) } : {}),
          ...(csvCell(row, mapping.externalId)
            ? { externalId: csvCell(row, mapping.externalId) }
            : {}),
          ...(type === "deposit"
            ? { toAccountId: options.defaultAccountId }
            : { fromAccountId: options.defaultAccountId }),
        },
      };
    }

    const common = {
      date,
      payee,
      description,
      notes: csvCell(row, mapping.notes) || null,
      externalId: csvCell(row, mapping.externalId) || null,
    };

    const draft: TransactionDraft =
      type === "deposit"
        ? { type, toAccountId: options.defaultAccountId, amount, ...common }
        : { type, fromAccountId: options.defaultAccountId, amount, ...common };

    return { draft, issues, rawData: row };
  });
}

const spreadsheetFormulaPattern = /^(?:[\u0000-\u0020]*[=+\-@]|[\t\r\n])/;

export function neutralizeSpreadsheetFormula(value: unknown): string {
  const stringValue = value == null ? "" : String(value);
  return spreadsheetFormulaPattern.test(stringValue) ? `'${stringValue}` : stringValue;
}

/**
 * Take back the apostrophe the neutraliser adds, for a file written before the
 * value also travelled in `roundtrip_text_json`.
 *
 * Not injective, and cannot be: a category genuinely named `'-Reimbursements`
 * and one named `-Reimbursements` export identically. The JSON channel is what
 * makes new files exact; this is the best answer available for an old one, and
 * it is better than importing every such name with a leading apostrophe glued
 * on and creating a second category on every round trip.
 */
export function restoreNeutralizedCell(value: string) {
  return value.startsWith("'") && spreadsheetFormulaPattern.test(value.slice(1))
    ? value.slice(1)
    : value;
}

const escapeCsv = (value: unknown, protectFromFormulas: boolean) => {
  const stringValue = protectFromFormulas
    ? neutralizeSpreadsheetFormula(value)
    : value == null
      ? ""
      : String(value);
  return /[",\n\r]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
};

export function rowsToCsv(
  rows: Record<string, unknown>[],
  formulaProtectedColumns: readonly string[] = [],
  // The columns to write when there are no rows to take them from. Without it
  // an export matching nothing produced the empty string, which is not a CSV
  // file: it has no header record, so RFC 4180 readers reject it and this
  // product's own `z.string().min(1)` refused to preview or stage it. A
  // header-only file is readable by everything, including us, and says plainly
  // that the answer was "nothing" rather than that the export broke.
  headerColumns: readonly string[] = [],
): string {
  if (rows.length === 0) {
    return headerColumns.length === 0
      ? ""
      : headerColumns.map((header) => escapeCsv(header, false)).join(",");
  }
  const headers = Object.keys(rows[0]);
  const protectedColumns = new Set(formulaProtectedColumns);
  return [
    headers.map((header) => escapeCsv(header, false)).join(","),
    ...rows.map((row) =>
      headers.map((header) => escapeCsv(row[header], protectedColumns.has(header))).join(","),
    ),
  ].join("\r\n");
}
