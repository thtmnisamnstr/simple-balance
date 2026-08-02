import { createHash } from "node:crypto";
import Papa from "papaparse";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  categoryCreateSchema,
  idempotencyKeySchema,
  transactionDraftSchema,
  type Actor,
  type CategoryKind,
  type Page,
  type TransactionDraft,
  type ValidationIssue,
} from "../../shared/domain.js";
import {
  csvMappingSchema,
  normalizeCsvRows,
  previewCsv,
  rowsToCsv,
  type NormalizedCsvRow,
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
  type CategoryRow,
} from "../db/schema.js";
import {
  configuredCsvMaxBytes,
  configuredCsvMaxRows,
} from "../config-limits.js";
import { validationError } from "./errors.js";
import {
  getIdempotent,
  lockAccountReferences,
  lockCategoryNamespace,
  lockIdempotencyKey,
  lockPayeeNamespace,
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { cleanHumanName, normalizeHumanName } from "./names.js";
import { seedCanonicalPayeeCache } from "./payees.js";
import { insertImportedStage } from "./staging.js";
import { listTransactions } from "./transactions.js";

const APP_CSV_FORMAT = "simple-balance-csv-1";
const APP_CSV_COLUMNS = [
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
    const cursor = decodeCursor(query.cursor, { key: "created", direction: "desc" });
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
          key: "created",
          direction: "desc",
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
      payee: z.string().trim().min(1).max(160),
      description: z.string().nullable(),
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
    payee: protectedText.data.payee,
    description: protectedText.data.description,
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

type CsvStageRow = Pick<NormalizedCsvRow, "draft" | "issues"> & {
  rawData?: Record<string, string>;
};

export type CsvReferenceResolution = {
  categories: {
    inputName: string;
    resolvedName: string;
    categoryId: string | null;
    kind: CategoryKind;
    resolution: "existing" | "new" | "updated";
    unarchived: boolean;
  }[];
  payees: {
    inputPayee: string;
    resolvedPayee: string;
    resolution: "existing" | "new";
  }[];
};

function categoryKindForDraft(draft: TransactionDraft): CategoryKind {
  if (draft.type === "deposit") return "income";
  if (draft.type === "withdrawal") return "expense";
  return "both";
}

function combineCategoryKinds(
  left: CategoryKind,
  right: CategoryKind,
): CategoryKind {
  return left === right ? left : "both";
}

function preferredCategory(left: CategoryRow, right: CategoryRow) {
  if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) {
    return left.archivedAt ? 1 : -1;
  }
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

async function canonicalizeImportedPayees(
  tx: DbTransaction,
  actor: Actor,
  rows: CsvStageRow[],
) {
  const result = await tx.execute(sql`
    select
      payee_name as name,
      sum(reference_count)::int as reference_count
    from (
      select payee as payee_name, count(*)::int as reference_count
      from ledger_transaction
      where user_id = ${actor.userId}
        and deleted_at is null
        and char_length(trim(payee)) between 1 and 160
      group by payee

      union all

      select draft ->> 'payee' as payee_name, count(*)::int as reference_count
      from staged_transaction
      where user_id = ${actor.userId}
        and status = 'staged'
        and jsonb_typeof(draft -> 'payee') = 'string'
        and char_length(trim(draft ->> 'payee')) between 1 and 160
      group by draft ->> 'payee'
    ) as payee_references
    group by payee_name
  `);
  const groupedExisting = new Map<
    string,
    { name: string; referenceCount: number }[]
  >();
  for (const row of result.rows) {
    const name = String(row.name);
    const referenceCount = Number(row.reference_count);
    if (!Number.isSafeInteger(referenceCount) || referenceCount < 1) {
      throw new Error("Database returned an invalid payee reference count");
    }
    const normalizedName = normalizeHumanName(name);
    const group = groupedExisting.get(normalizedName);
    const summary = { name, referenceCount };
    if (group) group.push(summary);
    else groupedExisting.set(normalizedName, [summary]);
  }
  const canonicalByName = new Map<string, string>();
  for (const [normalizedName, payees] of groupedExisting) {
    const preferred = [...payees].sort((left, right) => {
      const leftClean = left.name === cleanHumanName(left.name) ? 1 : 0;
      const rightClean = right.name === cleanHumanName(right.name) ? 1 : 0;
      return (
        right.referenceCount - left.referenceCount ||
        rightClean - leftClean ||
        left.name.localeCompare(right.name)
      );
    })[0]!;
    canonicalByName.set(normalizedName, cleanHumanName(preferred.name));
  }
  const existingNames = new Set(canonicalByName.keys());
  const resolutionByName = new Map<
    string,
    CsvReferenceResolution["payees"][number]
  >();

  for (const row of rows) {
    if (!row.draft) continue;
    const inputPayee = row.draft.payee;
    const normalized = normalizeHumanName(inputPayee);
    const resolvedPayee =
      canonicalByName.get(normalized) ?? cleanHumanName(inputPayee);
    if (!canonicalByName.has(normalized)) {
      canonicalByName.set(normalized, resolvedPayee);
    }
    row.draft = { ...row.draft, payee: resolvedPayee };
    if (!resolutionByName.has(normalized)) {
      resolutionByName.set(normalized, {
        inputPayee: cleanHumanName(inputPayee),
        resolvedPayee,
        resolution: existingNames.has(normalized) ? "existing" : "new",
      });
    }
  }

  return {
    resolutions: [...resolutionByName.values()],
    canonicalByName,
  };
}

async function resolveImportedCategories(
  tx: DbTransaction,
  actor: Actor,
  rows: CsvStageRow[],
  rawRows: Record<string, string>[],
  categoryColumn: string | undefined,
  categoryRows: CategoryRow[],
  mutate: boolean,
) {
  const groups = new Map<
    string,
    {
      inputName: string;
      rowIndexes: number[];
      kind: CategoryKind;
    }
  >();
  if (categoryColumn) {
    for (let index = 0; index < rows.length; index += 1) {
      const draft = rows[index]?.draft;
      const inputName = cleanHumanName(rawRows[index]?.[categoryColumn] ?? "");
      // A row that already carries a category this ledger owns keeps it; only
      // unresolved rows are matched by name.
      if (draft?.categoryId) continue;
      if (!draft || !inputName) continue;
      const normalizedName = normalizeHumanName(inputName);
      const kind = categoryKindForDraft(draft);
      const group = groups.get(normalizedName);
      if (group) {
        group.rowIndexes.push(index);
        group.kind = combineCategoryKinds(group.kind, kind);
      } else {
        groups.set(normalizedName, { inputName, rowIndexes: [index], kind });
      }
    }
  }

  const categoryByName = new Map<string, CategoryRow>();
  for (const category of [...categoryRows].sort(preferredCategory)) {
    const normalizedName = normalizeHumanName(category.name);
    if (!categoryByName.has(normalizedName)) {
      categoryByName.set(normalizedName, category);
    }
  }
  const resolutions: CsvReferenceResolution["categories"] = [];

  for (const [normalizedName, group] of groups) {
    const existing = categoryByName.get(normalizedName);
    if (existing) {
      const resolvedKind = combineCategoryKinds(existing.kind, group.kind);
      const unarchived = existing.archivedAt !== null;
      const needsUpdate = unarchived || resolvedKind !== existing.kind;
      let resolved = existing;
      if (mutate && needsUpdate) {
        const [updated] = await tx
          .update(categories)
          .set({
            kind: resolvedKind,
            archivedAt: null,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(categories.id, existing.id),
              eq(categories.userId, actor.userId),
              eq(categories.version, existing.version),
            ),
          )
          .returning();
        if (!updated) {
          throw validationError("Category changed while resolving the CSV import");
        }
        await writeAudit(tx, actor, {
          entityType: "category",
          entityId: existing.id,
          operation: "update_from_csv",
          before: serializeRow(existing),
          after: serializeRow(updated),
        });
        resolved = updated;
      }
      for (const rowIndex of group.rowIndexes) {
        const draft = rows[rowIndex]!.draft!;
        rows[rowIndex]!.draft = { ...draft, categoryId: existing.id };
      }
      resolutions.push({
        inputName: group.inputName,
        resolvedName: resolved.name,
        categoryId: resolved.id,
        kind: resolvedKind,
        resolution: needsUpdate ? "updated" : "existing",
        unarchived,
      });
      continue;
    }

    const parsedCategory = categoryCreateSchema.safeParse({
      name: group.inputName,
      kind: group.kind,
    });
    if (!parsedCategory.success) {
      const message = parsedCategory.error.issues[0]?.message ?? "Category is invalid";
      for (const rowIndex of group.rowIndexes) {
        rows[rowIndex]!.issues.push({ field: "category", message });
      }
      continue;
    }

    let categoryId: string | null = null;
    if (mutate) {
      const [created] = await tx
        .insert(categories)
        .values({ userId: actor.userId, ...parsedCategory.data })
        .returning();
      categoryId = created.id;
      await writeAudit(tx, actor, {
        entityType: "category",
        entityId: created.id,
        operation: "create_from_csv",
        after: serializeRow(created),
      });
      for (const rowIndex of group.rowIndexes) {
        const draft = rows[rowIndex]!.draft!;
        rows[rowIndex]!.draft = { ...draft, categoryId };
      }
    }
    resolutions.push({
      inputName: group.inputName,
      resolvedName: parsedCategory.data.name,
      categoryId,
      kind: parsedCategory.data.kind,
      resolution: "new",
      unarchived: false,
    });
  }

  return resolutions;
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
        referenceResolution: CsvReferenceResolution;
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
      // A CSV can never post directly into a counter-account.
      .where(
        and(
          eq(ledgerAccounts.userId, actor.userId),
          isNull(ledgerAccounts.systemKind),
        ),
      );
    const allowedAccountIds = new Set(accountRows.map((account) => account.id));
    if (!allowedAccountIds.has(parsed.defaultAccountId)) {
      throw validationError("Default account is unavailable");
    }

    const roundTrip = isAppRoundTripCsv(parsedCsv.meta.fields ?? []);
    const rows: CsvStageRow[] = roundTrip
      ? parsedCsv.data.map((row) => roundTripDraft(row, allowedAccountIds))
      : normalizeCsvRows(parsedCsv.data, parsed);

    if (!parsed.dryRun) {
      // Preserve the global mutation lock order: account references first,
      // then category and payee namespaces. Stage insertion reacquires only
      // locks already held by this transaction.
      const accountIds = rows.flatMap((row) => {
        if (!row.draft) return [];
        if (row.draft.type === "deposit") return [row.draft.toAccountId];
        if (row.draft.type === "withdrawal") return [row.draft.fromAccountId];
        return [row.draft.fromAccountId, row.draft.toAccountId];
      });
      await lockAccountReferences(tx, actor, accountIds);
      await lockCategoryNamespace(tx, actor);
      await lockPayeeNamespace(tx, actor);
    }

    const categoryRows = await tx
      .select()
      .from(categories)
      .where(eq(categories.userId, actor.userId));
    const {
      resolutions: payeeResolution,
      canonicalByName: canonicalPayees,
    } = await canonicalizeImportedPayees(tx, actor, rows);
    seedCanonicalPayeeCache(tx, canonicalPayees);
    if (roundTrip) {
      // An export restored into another ledger carries category ids that do not
      // exist here. Drop those so the exported category_name can resolve them,
      // instead of importing every row with no category at all.
      const ownedCategoryIds = new Set(categoryRows.map((row) => row.id));
      for (const row of rows) {
        if (
          row.draft?.categoryId &&
          !ownedCategoryIds.has(row.draft.categoryId)
        ) {
          row.draft = { ...row.draft, categoryId: null };
        }
      }
    }
    const categoryResolution = await resolveImportedCategories(
      tx,
      actor,
      rows,
      parsedCsv.data,
      roundTrip ? "category_name" : parsed.mapping.category,
      categoryRows,
      !parsed.dryRun,
    );
    const referenceResolution: CsvReferenceResolution = {
      categories: categoryResolution,
      payees: payeeResolution,
    };
    const preview = {
      fileName: parsed.fileName,
      rowCount: rows.length,
      validCount: rows.filter((row) => row.draft && row.issues.length === 0).length,
      invalidCount: rows.filter((row) => !row.draft || row.issues.length > 0).length,
      sample: rows.slice(0, 25),
      referenceResolution,
    };
    if (parsed.dryRun) return preview;

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
    payee: transaction.payee,
    description: transaction.description,
    category_id: transaction.categoryId,
    category_name: transaction.category?.name,
    notes: transaction.notes,
    roundtrip_text_json: JSON.stringify({
      payee: transaction.payee,
      description: transaction.description,
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
      "payee",
      "description",
      "category_name",
      "notes",
      "source_account_name",
      "destination_account_name",
    ]),
    rowCount: rows.length,
  };
}
