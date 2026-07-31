import Papa from "papaparse";
import { z } from "zod";
import {
  isoDateSchema,
  positiveDecimalStringSchema,
  type TransactionDraft,
} from "./domain.js";

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
    type: z.string().optional(),
    fromAccount: z.string().optional(),
    toAccount: z.string().optional(),
    sourceAmount: z.string().optional(),
    destinationAmount: z.string().optional(),
    externalId: z.string().optional(),
  })
  .refine(
    (mapping) =>
      Boolean(
        mapping.amount ||
          mapping.debit ||
          mapping.credit ||
          (mapping.type && mapping.sourceAmount && mapping.destinationAmount),
      ),
    {
      message:
        "Map an amount column, debit/credit columns, or the app export transaction fields",
    },
  );

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

export function parseLocalizedAmount(
  value: string,
  decimalSeparator: "." | "," = ".",
): string | null {
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
  if (
    !integerPart ||
    (fraction !== undefined && !/^\d+$/.test(fraction))
  ) {
    return null;
  }

  const usesConfiguredGrouping = integerPart.includes(groupingSeparator);
  const usesSpaceGrouping = integerPart.includes(" ");
  if (usesConfiguredGrouping && usesSpaceGrouping) return null;
  const grouping = usesConfiguredGrouping
    ? groupingSeparator
    : usesSpaceGrouping
      ? " "
      : null;
  if (
    grouping &&
    !new RegExp(`^\\d{1,3}(?:\\${grouping}\\d{3})+$`).test(integerPart)
  ) {
    return null;
  }
  const normalizedInteger = grouping
    ? integerPart.replaceAll(grouping, "")
    : integerPart;
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
  const match = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(trimmed);
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
};

export function normalizeCsvRows(
  rows: Record<string, string>[],
  options: CsvNormalizeOptions,
): NormalizedCsvRow[] {
  const { mapping } = options;
  return rows.map((row) => {
    const issues: { field: string; message: string }[] = [];
    const date = parseCsvDate(row[mapping.date] ?? "", options.dateFormat);
    if (!date) issues.push({ field: "date", message: "Date could not be parsed" });

    const payee = (row[mapping.payee] ?? "").trim();
    if (!payee) issues.push({ field: "payee", message: "Payee is required" });
    const description = mapping.description
      ? (row[mapping.description] ?? "").trim() || null
      : null;

    const signedRaw = mapping.amount ? row[mapping.amount] ?? "" : "";
    const debitRaw = mapping.debit ? row[mapping.debit] ?? "" : "";
    const creditRaw = mapping.credit ? row[mapping.credit] ?? "" : "";
    const signedAmount = mapping.amount
      ? parseLocalizedAmount(signedRaw, options.decimalSeparator)
      : null;
    const debit = mapping.debit
      ? parseLocalizedAmount(debitRaw, options.decimalSeparator)
      : null;
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

    let type: "deposit" | "withdrawal";
    let amount: string | null;
    if (mapping.amount && signedAmount) {
      type = signedAmount.startsWith("-") ? "withdrawal" : "deposit";
      amount = signedAmount.replace(/^-/, "");
    } else if (
      !mapping.amount &&
      debit &&
      !/^[-]?0(?:\.0+)?$/.test(debit) &&
      credit &&
      !/^[-]?0(?:\.0+)?$/.test(credit)
    ) {
      type = "withdrawal";
      amount = null;
      issues.push({
        field: "amount",
        message: "Only one of debit and credit may contain a non-zero amount",
      });
    } else if (
      !mapping.amount &&
      debit &&
      !/^[-]?0(?:\.0+)?$/.test(debit)
    ) {
      type = "withdrawal";
      amount = debit.replace(/^-/, "");
    } else if (
      !mapping.amount &&
      credit &&
      !/^[-]?0(?:\.0+)?$/.test(credit)
    ) {
      type = "deposit";
      amount = credit.replace(/^-/, "");
    } else {
      type = "withdrawal";
      amount = null;
    }

    if (!amount || !positiveDecimalStringSchema.safeParse(amount).success) {
      issues.push({ field: "amount", message: "A non-zero amount is required" });
    }

    if (issues.length || !date || !amount || !payee) {
      return { draft: null, issues, rawData: row };
    }

    const common = {
      date,
      payee,
      description,
      notes: mapping.notes ? row[mapping.notes] || null : null,
      externalId: mapping.externalId ? row[mapping.externalId] || null : null,
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

const escapeCsv = (value: unknown, protectFromFormulas: boolean) => {
  const stringValue = protectFromFormulas
    ? neutralizeSpreadsheetFormula(value)
    : value == null
      ? ""
      : String(value);
  return /[",\n\r]/.test(stringValue)
    ? `"${stringValue.replaceAll('"', '""')}"`
    : stringValue;
};

export function rowsToCsv(
  rows: Record<string, unknown>[],
  formulaProtectedColumns: readonly string[] = [],
): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const protectedColumns = new Set(formulaProtectedColumns);
  return [
    headers.map((header) => escapeCsv(header, false)).join(","),
    ...rows.map((row) =>
      headers
        .map((header) => escapeCsv(row[header], protectedColumns.has(header)))
        .join(","),
    ),
  ].join("\r\n");
}
