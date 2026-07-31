import { createHash } from "node:crypto";
import Papa from "papaparse";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  idempotencyKeySchema,
  transactionDraftSchema,
  type Actor,
  type Page,
  type TransactionDraft,
  type ValidationIssue,
} from "../../shared/domain.js";
import {
  csvMappingSchema,
  normalizeCsvRows,
  previewCsv,
  rowsToCsv,
} from "../../shared/csv.js";
import {
  getDb,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  categories,
  importBatches,
  ledgerAccounts,
  stagedTransactions,
} from "../db/schema.js";
import {
  configuredCsvMaxBytes,
  configuredCsvMaxRows,
} from "../config-limits.js";
import { validationError } from "./errors.js";
import {
  getIdempotent,
  lockIdempotencyKey,
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  insertImportedStage,
  lockStagedDraftReferences,
} from "./staging.js";
import { listTransactions } from "./transactions.js";

const APP_CSV_FORMAT = "simple-balance-csv-1";
const APP_CSV_COLUMNS = [
  "simple_balance_format",
  "transaction_id",
  "transaction_type",
  "date",
  "description",
  "payee",
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

export const csvStageInputSchema = z.object({
  csv: z.string().min(1),
  fileName: z.string().trim().min(1).max(240),
  idempotencyKey: idempotencyKeySchema,
  defaultAccountId: z.string().uuid(),
  mapping: csvMappingSchema,
  dateFormat: z.enum(["YMD", "MDY", "DMY"]).default("YMD"),
  decimalSeparator: z.enum([".", ","]).default("."),
  dryRun: z.boolean().default(false),
});

export function getCsvPreview(csv: string) {
  return previewCsv(csv);
}

export type ImportBatchSummary = {
  id: string;
  fileName: string;
  rowCount: number;
  stagedCount: number;
  createdAt: string;
};

const importBatchListQuerySchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listActiveImportBatches(
  actor: Actor,
  input: unknown,
): Promise<Page<ImportBatchSummary>> {
  const query = importBatchListQuerySchema.parse(input);
  const conditions = [eq(importBatches.userId, actor.userId)];
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    const createdAt = new Date(cursor.sort);
    if (Number.isNaN(createdAt.getTime())) {
      throw validationError("Cursor is invalid");
    }
    conditions.push(
      or(
        lt(importBatches.createdAt, createdAt),
        and(
          eq(importBatches.createdAt, createdAt),
          lt(importBatches.id, cursor.id),
        ),
      )!,
    );
  }

  const rows = await getDb()
    .select({
      id: importBatches.id,
      fileName: importBatches.fileName,
      rowCount: importBatches.rowCount,
      createdAt: importBatches.createdAt,
      stagedCount: sql<number>`count(${stagedTransactions.id})::int`,
    })
    .from(importBatches)
    .innerJoin(
      stagedTransactions,
      and(
        eq(stagedTransactions.importBatchId, importBatches.id),
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
      ),
    )
    .where(and(...conditions))
    .groupBy(importBatches.id)
    .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
    .limit(query.limit + 1);
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  return {
    items: pageRows.map((row) => ({
      ...row,
      stagedCount: Number(row.stagedCount),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore
      ? encodeCursor({
          sort: pageRows.at(-1)!.createdAt.toISOString(),
          id: pageRows.at(-1)!.id,
        })
      : null,
  };
}

function isAppRoundTripCsv(headers: readonly string[]) {
  const available = new Set(headers);
  return APP_CSV_COLUMNS.every((column) => available.has(column));
}

function roundTripDraft(
  row: Record<string, string>,
  allowedAccountIds: Set<string>,
): { draft: TransactionDraft | null; issues: ValidationIssue[] } {
  if (row.simple_balance_format !== APP_CSV_FORMAT) {
    return {
      draft: null,
      issues: [{
        field: "simple_balance_format",
        message: "The Simple Balance CSV format marker is missing or unsupported",
      }],
    };
  }
  const protectedText = z
    .object({
      description: z.string(),
      payee: z.string().nullable(),
      notes: z.string().nullable(),
    })
    .safeParse(
      (() => {
        try {
          return JSON.parse(row.roundtrip_text_json);
        } catch {
          return null;
        }
      })(),
    );
  if (!protectedText.success) {
    return {
      draft: null,
      issues: [{
        field: "roundtrip_text_json",
        message: "The Simple Balance round-trip text payload is invalid",
      }],
    };
  }
  const common = {
    date: row.date,
    description: protectedText.data.description,
    payee: protectedText.data.payee,
    categoryId: row.category_id || null,
    notes: protectedText.data.notes,
    externalId: row.transaction_id || null,
  };
  let candidate: unknown;
  if (row.transaction_type === "deposit") {
    candidate = {
      type: "deposit",
      toAccountId: row.destination_account_id,
      amount: row.destination_amount,
      ...common,
    };
  } else if (row.transaction_type === "withdrawal") {
    candidate = {
      type: "withdrawal",
      fromAccountId: row.source_account_id,
      amount: row.source_amount,
      ...common,
    };
  } else if (row.transaction_type === "transfer") {
    candidate = {
      type: "transfer",
      fromAccountId: row.source_account_id,
      toAccountId: row.destination_account_id,
      sourceAmount: row.source_amount,
      destinationAmount: row.destination_amount,
      ...common,
    };
  } else {
    return {
      draft: null,
      issues: [{ field: "type", message: "Transaction type is not recognized" }],
    };
  }
  const parsed = transactionDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      draft: null,
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    };
  }
  const referencedIds =
    parsed.data.type === "deposit"
      ? [parsed.data.toAccountId]
      : parsed.data.type === "withdrawal"
        ? [parsed.data.fromAccountId]
        : [parsed.data.fromAccountId, parsed.data.toAccountId];
  if (referencedIds.some((id) => !allowedAccountIds.has(id))) {
    return {
      draft: null,
      issues: [{ field: "account", message: "An exported account is unavailable" }],
    };
  }
  return { draft: parsed.data, issues: [] };
}

export async function stageCsv(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = csvStageInputSchema.parse(input);
  const maxBytes = configuredCsvMaxBytes();
  const maxRows = configuredCsvMaxRows();
  if (Buffer.byteLength(parsed.csv, "utf8") > maxBytes) {
    throw validationError(`CSV exceeds the ${maxBytes}-byte limit`);
  }
  const parsedCsv = Papa.parse<Record<string, string>>(parsed.csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (value) => value.trim(),
    transform: (value) => value.trim(),
  });
  if (parsedCsv.data.length > maxRows) {
    throw validationError(`CSV exceeds the ${maxRows}-row limit`);
  }
  if (parsedCsv.errors.some((error) => error.code === "MissingQuotes")) {
    throw validationError("CSV contains malformed quoted data", parsedCsv.errors);
  }
  const fileHash = createHash("sha256").update(parsed.csv).digest("hex");
  const idempotencyPayload = {
    fileHash,
    fileName: parsed.fileName,
    defaultAccountId: parsed.defaultAccountId,
    mapping: parsed.mapping,
    dateFormat: parsed.dateFormat,
    decimalSeparator: parsed.decimalSeparator,
  };

  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "csv.stage",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<{
        fileName: string;
        rowCount: number;
        validCount: number;
        invalidCount: number;
        sample: unknown[];
        importBatchId: string;
        stagedIds: string[];
      }>(
        tx,
        actor,
        "csv.stage",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return existing;
    }
    const accountRows = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.userId, actor.userId));
    const allowedAccountIds = new Set(accountRows.map((account) => account.id));
    if (!allowedAccountIds.has(parsed.defaultAccountId)) {
      throw validationError("Default account is unavailable");
    }

    const categoryRows = await tx
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.userId, actor.userId));
    const categoryByName = new Map(
      categoryRows.map((category) => [category.name.trim().toLowerCase(), category.id]),
    );
    const normalized = normalizeCsvRows(parsedCsv.data, parsed).map((row, index) => {
      const categoryName = parsed.mapping.category
        ? parsedCsv.data[index]?.[parsed.mapping.category]?.trim()
        : "";
      if (!categoryName || !row.draft) return row;
      const categoryId = categoryByName.get(categoryName.toLowerCase());
      if (!categoryId) {
        return {
          ...row,
          issues: [
            ...row.issues,
            { field: "category", message: `Category "${categoryName}" was not found` },
          ],
        };
      }
      return { ...row, draft: { ...row.draft, categoryId } };
    });
    const roundTrip = isAppRoundTripCsv(parsedCsv.meta.fields ?? []);
    const rows = roundTrip
      ? parsedCsv.data.map((row) => roundTripDraft(row, allowedAccountIds))
      : normalized;
    const preview = {
      fileName: parsed.fileName,
      rowCount: rows.length,
      validCount: rows.filter((row) => row.draft && row.issues.length === 0).length,
      invalidCount: rows.filter((row) => !row.draft || row.issues.length > 0).length,
      sample: rows.slice(0, 25),
    };
    if (parsed.dryRun) return preview;

    await lockStagedDraftReferences(
      tx,
      actor,
      rows.map((row) => row.draft ?? {}),
    );
    const [batch] = await tx
      .insert(importBatches)
      .values({
        userId: actor.userId,
        fileName: parsed.fileName,
        fileHash,
        delimiter: parsedCsv.meta.delimiter,
        mapping: parsed.mapping,
        rowCount: rows.length,
      })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "import_batch",
      entityId: batch.id,
      operation: "create",
      after: serializeRow(batch),
    });

    const stagedIds: string[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const normalizedRow = rows[index];
      const rawData = parsedCsv.data[index];
      const staged = await insertImportedStage(tx, actor, {
        draft: normalizedRow.draft ?? {},
        rawData,
        importBatchId: batch.id,
        initialIssues: normalizedRow.issues,
      });
      stagedIds.push(staged.id);
    }
    const response = { ...preview, importBatchId: batch.id, stagedIds };
    await setIdempotent(
      tx,
      actor,
      "csv.stage",
      parsed.idempotencyKey,
      idempotencyPayload,
      response,
    );
    return response;
  });
}

export async function exportTransactionsCsv(actor: Actor, query: unknown) {
  const page = await listTransactions(actor, { ...(query as object), limit: 200 });
  const all = [...page.items];
  let cursor = page.nextCursor;
  while (cursor) {
    const next = await listTransactions(actor, {
      ...(query as object),
      limit: 200,
      cursor,
    });
    all.push(...next.items);
    cursor = next.nextCursor;
    if (all.length > 100_000) throw validationError("Export exceeds 100,000 rows");
  }

  const rows = all.map((transaction) => ({
    simple_balance_format: APP_CSV_FORMAT,
    transaction_id: transaction.id,
    transaction_type: transaction.type,
    date: transaction.date,
    description: transaction.description,
    payee: transaction.payee,
    category_id: transaction.categoryId,
    category_name: transaction.category?.name,
    notes: transaction.notes,
    roundtrip_text_json: JSON.stringify({
      description: transaction.description,
      payee: transaction.payee,
      notes: transaction.notes,
    }),
    source_account_id: transaction.sourceAccountId,
    source_account_name: transaction.sourceAccount?.name,
    source_amount: transaction.sourceAmount,
    source_currency: transaction.sourceCurrency,
    destination_account_id: transaction.destinationAccountId,
    destination_account_name: transaction.destinationAccount?.name,
    destination_amount: transaction.destinationAmount,
    destination_currency: transaction.destinationCurrency,
    effective_rate: transaction.effectiveRate,
  }));
  return {
    csv: rowsToCsv(rows, [
      "description",
      "payee",
      "category_name",
      "notes",
      "source_account_name",
      "destination_account_name",
    ]),
    rowCount: rows.length,
  };
}
