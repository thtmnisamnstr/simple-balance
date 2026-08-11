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
  type PayeeSummary,
} from "../../shared/domain.js";
import {
  APP_CSV_EXTERNAL_ID_COLUMN,
  APP_CSV_FORMAT,
  APP_CSV_LEGS_COLUMN,
  csvCell,
  csvMappingSchema,
  isAppExportCsv,
  parseExportedLegs,
  normalizeCsvRows,
  previewCsv,
  restoreNeutralizedCell,
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
import { cursorInstant, decodeCursor, encodeCursor } from "./cursor.js";
import { cleanHumanName, normalizeHumanName } from "../../shared/names.js";
import {
  payeeSummaries,
  preferredPayee,
  seedCanonicalPayeeCache,
} from "./payees.js";
import {
  combineCategoryKinds,
  preferredCategory,
} from "./categories.js";
import { insertImportedStages } from "./staging.js";
import { listAllTransactions } from "./transactions.js";

export const csvStageInputSchema = z.object({
  csv: z.string().min(1),
  fileName: z.string().trim().min(1).max(240),
  idempotencyKey: idempotencyKeySchema,
  defaultAccountId: z
    .string()
    .uuid()
    .describe(
      "The account every row is posted against. Accounts are never read out of the file, so this is the only thing that decides where the rows land.",
    ),
  mapping: csvMappingSchema
    .optional()
    .describe(
      "Which column holds which field. Not needed for a Simple Balance export, whose columns are already known.",
    ),
  dateFormat: z.enum(["YMD", "MDY", "DMY"]).default("YMD"),
  decimalSeparator: z.enum([".", ","]).default("."),
  dryRun: z.boolean().default(false),
});

/**
 * The size limit, applied wherever a CSV arrives rather than only where one is
 * stored.
 *
 * The preview reads the same body the stage call does, off the same route
 * sizing, and papaparse stopping after twenty-five rows does not stop the whole
 * string being decoded and held first. Refusing here is also the earlier
 * answer: a file too large to import should say so before somebody maps its
 * columns.
 */
function assertCsvWithinSizeLimit(csv: string) {
  const maxBytes = configuredCsvMaxBytes();
  if (Buffer.byteLength(csv, "utf8") > maxBytes) {
    throw validationError(`CSV exceeds the ${maxBytes}-byte limit`);
  }
}

export function getCsvPreview(csv: string) {
  assertCsvWithinSizeLimit(csv);
  return previewCsv(csv);
}

export type ImportBatchSummary = {
  id: string;
  fileName: string;
  rowCount: number;
  stagedCount: number;
  createdAt: string;
};

export const importBatchListQuerySchema = z.object({
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
    const createdAt = cursorInstant(cursor);
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

/**
 * A row of one of our own exports, read against the account chosen for this
 * import.
 *
 * The account is that choice and nothing else. Not one of the file's four
 * account columns is read: they belong to the ledger it came from, so a
 * different account, a different person, or a fresh install resolves none of
 * them. Which side the amount sits on comes from the row's type instead.
 *
 * A row that cannot be made into a draft is still handed back with everything
 * that could be read, because a queue of rows missing one field can be repaired
 * and a queue of blank rows cannot.
 */
function appExportDraft(
  row: Record<string, string>,
  accountId: string,
): CsvStageRow {
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
  // Read on its own rather than widened into the object above, so a reference
  // that is too long or the wrong shape costs the reference and not the row's
  // payee, description and notes. Same rule as the split below.
  const roundtripExtras = z
    .object({
      externalId: z.string().max(200).nullable().optional(),
      categoryName: z.string().trim().min(1).max(120).nullable().optional(),
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
  const legs = parseExportedLegs(row[APP_CSV_LEGS_COLUMN]);
  // An unreadable split costs the split, not the row. Returning here threw away
  // the date, payee, amount and account the file stated perfectly clearly, and
  // left somebody an empty row and one complaint; every other unreadable field
  // in this reader keeps what it could read and says what it could not.
  const legIssues =
    legs === null
      ? [
          {
            field: APP_CSV_LEGS_COLUMN,
            message:
              "The split on this row could not be read, so it is staged without one. Divide it again here, or commit it against a single category.",
          },
        ]
      : [];
  const common = {
    date: row.date,
    payee: protectedText.success ? protectedText.data.payee : row.payee,
    description: protectedText.success
      ? protectedText.data.description
      : row.description || null,
    // A split says which categories the money went to, one per leg, so the
    // row's single category is left off rather than sent alongside them.
    ...(legs
      ? { legs }
      : {
          categoryId: row.category_id || null,
          // By name, because the id names a category in the ledger the file
          // came from. The name travels in the JSON where the spreadsheet
          // formula neutraliser cannot reach it; the visible column is the
          // fallback for a file written before that, and the apostrophe the
          // neutraliser may have added is taken back off.
          categoryName:
            (roundtripExtras.success
              ? roundtripExtras.data.categoryName
              : undefined) ??
            (cleanHumanName(restoreNeutralizedCell(row.category_name || "")) ||
              null),
        }),
    notes: protectedText.success ? protectedText.data.notes : row.notes || null,
    // Never the source ledger's own primary key, which means nothing here and
    // made the duplicate check key on a foreign identity.
    externalId:
      (roundtripExtras.success ? roundtripExtras.data.externalId : undefined) ||
      restoreNeutralizedCell(row[APP_CSV_EXTERNAL_ID_COLUMN] || "") ||
      null,
  };

  if (row.transaction_type === "transfer") {
    return {
      draft: null,
      partial: {
        type: "transfer",
        sourceAmount: row.source_amount,
        destinationAmount: row.destination_amount,
        ...common,
      },
      issues: [
        ...legIssues,
        {
          field: "account",
          message:
            "A transfer moves between two accounts and an import chooses one, so pick both here",
        },
      ],
    };
  }

  let candidate: Record<string, unknown>;
  if (row.transaction_type === "deposit") {
    candidate = {
      type: "deposit",
      toAccountId: accountId,
      amount: row.destination_amount,
      ...common,
    };
  } else if (row.transaction_type === "withdrawal") {
    candidate = {
      type: "withdrawal",
      fromAccountId: accountId,
      amount: row.source_amount,
      ...common,
    };
  } else {
    return {
      draft: null,
      partial: { ...common },
      issues: [
        ...legIssues,
        { field: "type", message: "Transaction type is not recognized" },
      ],
    };
  }

  if (!protectedText.success) {
    return {
      draft: null,
      partial: candidate,
      issues: [
        ...legIssues,
        {
          field: "roundtrip_text_json",
          message: "The Simple Balance round-trip text payload is invalid",
        },
      ],
    };
  }
  const parsed = transactionDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      draft: null,
      partial: candidate,
      issues: [
        ...legIssues,
        ...parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      ],
    };
  }
  return { draft: parsed.data, issues: legIssues };
}

type CsvStageRow = Pick<NormalizedCsvRow, "draft" | "issues"> & {
  rawData?: Record<string, string>;
  partial?: Record<string, unknown>;
};

export type CsvReferenceResolution = {
  categories: {
    inputName: string;
    resolvedName: string;
    categoryId: string | null;
    kind: CategoryKind;
    resolution: "existing" | "new" | "updated" | "deferred";
    unarchived: boolean;
  }[];
  payees: {
    inputPayee: string;
    resolvedPayee: string;
    resolution: "existing" | "new";
  }[];
};

async function canonicalizeImportedPayees(
  tx: DbTransaction,
  actor: Actor,
  rows: CsvStageRow[],
) {
  // The same query and the same comparator the payee list uses, called rather
  // than written again. Two copies of "which spelling wins" is two places for
  // the answer to drift, and an import filing entries under a spelling the
  // payee screen does not consider canonical is exactly the drift that costs.
  const groupedExisting = new Map<string, PayeeSummary[]>();
  for (const summary of await payeeSummaries(tx, actor)) {
    const group = groupedExisting.get(summary.normalizedName);
    if (group) group.push(summary);
    else groupedExisting.set(summary.normalizedName, [summary]);
  }
  const canonicalByName = new Map<string, string>();
  for (const [normalizedName, payees] of groupedExisting) {
    canonicalByName.set(
      normalizedName,
      cleanHumanName(preferredPayee(payees)!.name),
    );
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
  mayMutateCategories: boolean,
) {
  const groups = new Map<
    string,
    {
      inputName: string;
      rowIndexes: number[];
      legTargets: { rowIndex: number; legIndex: number }[];
      // Undefined until some row in the group states a type. A group that ends
      // with none is filed under "both" only if it has to create a category.
      kind: CategoryKind | undefined;
    }
  >();
  const group = (inputName: string, kind: CategoryKind | undefined) => {
    const normalizedName = normalizeHumanName(inputName);
    const existing = groups.get(normalizedName);
    if (existing) {
      existing.kind =
        existing.kind === undefined
          ? kind
          : kind === undefined
            ? existing.kind
            : combineCategoryKinds(existing.kind, kind);
      return existing;
    }
    const created = {
      inputName,
      rowIndexes: [] as number[],
      legTargets: [] as { rowIndex: number; legIndex: number }[],
      kind,
    };
    groups.set(normalizedName, created);
    return created;
  };

  // A transfer stages as a `partial` rather than a draft, because an import
  // names one account and a transfer needs two. Its category is on that partial
  // and reading only `draft` dropped it, silently, on a cross-ledger restore.
  const stageTarget = (row: CsvStageRow | undefined) => row?.draft ?? row?.partial;

  const writeTarget = (
    rowIndex: number,
    patch: Record<string, unknown>,
  ) => {
    const row = rows[rowIndex]!;
    if (row.draft) row.draft = { ...row.draft, ...patch } as typeof row.draft;
    else if (row.partial) row.partial = { ...row.partial, ...patch };
  };


  // A row that states no type says nothing about which kind of category may
  // carry it, so it is filed under one and can create one, but never widens an
  // existing narrow category to "both" on the strength of saying nothing.
  const targetKind = (target: { type?: unknown }): CategoryKind | undefined =>
    target.type === "deposit"
      ? "income"
      : target.type === "withdrawal"
        ? "expense"
        : target.type === "transfer"
          ? "both"
          : undefined;

  for (let index = 0; index < rows.length; index += 1) {
    const target = stageTarget(rows[index]);
    if (!target) continue;
    // A split says which categories the money went to, one per leg, and a row
    // carrying both would be refused at commit as a contradiction.
    if (Array.isArray(target.legs)) continue;
    // A row that already resolved to a category this ledger owns keeps it, and
    // the name goes: a draft holding both answers has the name re-applied at
    // commit, which silently undoes a mass edit that cleared the category.
    if (target.categoryId) {
      if (target.categoryName) writeTarget(index, { categoryName: undefined });
      continue;
    }
    const inputName = cleanHumanName(
      // An app export carries the name on the target, restored from the JSON
      // the neutraliser never touched. A mapped file carries it in the column
      // whoever set up the mapping named.
      typeof target.categoryName === "string" && target.categoryName
        ? target.categoryName
        : categoryColumn && rawRows[index]
          ? csvCell(rawRows[index]!, categoryColumn)
          : "",
    );
    if (!inputName) continue;
    group(inputName, targetKind(target)).rowIndexes.push(index);
  }

  // A split names a category per leg rather than in a column, so its names are
  // gathered whichever way the file was mapped. Sharing the grouping means two
  // legs and a plain row asking for the same new category create it once, and
  // the preview counts it once.
  for (let index = 0; index < rows.length; index += 1) {
    const target = stageTarget(rows[index]);
    if (!Array.isArray(target?.legs)) continue;
    const kind = targetKind(target);
    for (const [legIndex, leg] of (target.legs as {
      categoryId?: string | null;
      categoryName?: string | null;
    }[]).entries()) {
      if (leg.categoryId) continue;
      const inputName = cleanHumanName(leg.categoryName ?? "");
      if (!inputName) continue;
      group(inputName, kind).legTargets.push({ rowIndex: index, legIndex });
    }
  }

  /**
   * Point everything that named this category at the one it resolved to. A
   * leg's name is dropped once it has an id, so nothing downstream has two ways
   * of saying which category it means.
   */
  const assign = (
    group: { rowIndexes: number[]; legTargets: { rowIndex: number; legIndex: number }[] },
    categoryId: string,
  ) => {
    for (const rowIndex of group.rowIndexes) {
      // The name goes with the id, so nothing downstream carries two answers.
      // A staged row keeping both would have the name re-applied at commit and
      // undo a mass edit that cleared the category.
      writeTarget(rowIndex, { categoryId, categoryName: undefined });
    }
    for (const { rowIndex, legIndex } of group.legTargets) {
      const target = stageTarget(rows[rowIndex]);
      if (!Array.isArray(target?.legs)) continue;
      const legs = (target.legs as Record<string, unknown>[]).map((leg, index) =>
        index === legIndex ? { ...leg, categoryId, categoryName: undefined } : leg,
      );
      writeTarget(rowIndex, { legs });
    }
  };

  /**
   * Leave the name where a category cannot be made yet.
   *
   * A `ledger:stage` caller may not create or reopen one, so the row is staged
   * saying which category it wants and the commit, which needs `ledger:write`,
   * makes it. Without this the name is dropped here and the row commits
   * uncategorised.
   */
  const defer = (group: {
    inputName: string;
    rowIndexes: number[];
  }) => {
    for (const rowIndex of group.rowIndexes) {
      writeTarget(rowIndex, { categoryName: group.inputName });
    }
  };

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
      const resolvedKind =
        group.kind === undefined
          ? existing.kind
          : combineCategoryKinds(existing.kind, group.kind);
      const unarchived = existing.archivedAt !== null;
      const needsUpdate = unarchived || resolvedKind !== existing.kind;
      // Bringing an archived category back, or widening what it may carry, is
      // a change to the ledger's own records rather than to the review queue.
      // A caller that may only stage leaves the row naming the category and
      // lets the commit, which needs ledger:write, decide.
      if (needsUpdate && !mayMutateCategories) {
        defer(group);
        resolutions.push({
          inputName: group.inputName,
          resolvedName: existing.name,
          categoryId: null,
          kind: resolvedKind,
          resolution: "deferred",
          unarchived: false,
        });
        continue;
      }
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
      assign(group, existing.id);
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
      kind: group.kind ?? "both",
    });
    if (!parsedCategory.success) {
      const message = parsedCategory.error.issues[0]?.message ?? "Category is invalid";
      for (const rowIndex of [
        ...group.rowIndexes,
        ...group.legTargets.map((target) => target.rowIndex),
      ]) {
        rows[rowIndex]!.issues.push({ field: "category", message });
      }
      continue;
    }

    let categoryId: string | null = null;
    if (!mayMutateCategories) defer(group);
    if (mutate && mayMutateCategories) {
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
      assign(group, categoryId);
    }
    resolutions.push({
      inputName: group.inputName,
      resolvedName: parsedCategory.data.name,
      categoryId,
      kind: parsedCategory.data.kind,
      resolution: mayMutateCategories ? "new" : "deferred",
      unarchived: false,
    });
  }

  return resolutions;
}

export async function stageCsv(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
  options: { mayMutateCategories?: boolean } = {},
) {
  const mayMutateCategories = options.mayMutateCategories ?? true;
  const parsed = csvStageInputSchema.parse(input);
  const maxRows = configuredCsvMaxRows();
  assertCsvWithinSizeLimit(parsed.csv);
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

    const appExport = isAppExportCsv(parsedCsv.meta.fields ?? []);
    let rows: CsvStageRow[];
    if (appExport) {
      rows = parsedCsv.data.map((row) =>
        appExportDraft(row, parsed.defaultAccountId),
      );
    } else if (parsed.mapping) {
      rows = normalizeCsvRows(parsedCsv.data, {
        ...parsed,
        mapping: parsed.mapping,
      });
    } else {
      throw validationError("Map the columns this file uses");
    }

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
    if (appExport) {
      // An export restored into another ledger carries category ids that do not
      // exist here. Drop those so the exported category_name can resolve them,
      // instead of importing every row with no category at all.
      const ownedCategoryIds = new Set(categoryRows.map((row) => row.id));
      for (const row of rows) {
        const categoryId: unknown =
          row.draft?.categoryId ?? row.partial?.categoryId;
        if (typeof categoryId !== "string" || ownedCategoryIds.has(categoryId)) {
          continue;
        }
        if (row.draft) row.draft = { ...row.draft, categoryId: null };
        if (row.partial) row.partial = { ...row.partial, categoryId: null };
      }
    }
    const categoryResolution = await resolveImportedCategories(
      tx,
      actor,
      rows,
      parsedCsv.data,
      appExport ? "category_name" : parsed.mapping?.category,
      categoryRows,
      !parsed.dryRun,
      mayMutateCategories,
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
        mapping: parsed.mapping ?? {},
        rowCount: rows.length,
      })
      .returning();
    await writeAudit(tx, actor, {
      entityType: "import_batch",
      entityId: batch.id,
      operation: "create",
      after: serializeRow(batch),
    });

    const staged = await insertImportedStages(
      tx,
      actor,
      rows.map((normalizedRow, index) => ({
        draft: normalizedRow.draft ?? normalizedRow.partial ?? {},
        rawData: parsedCsv.data[index],
        importBatchId: batch.id,
        initialIssues: normalizedRow.issues,
      })),
    );
    const stagedIds = staged.map((row) => row.id);
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
  // An export is the whole filtered set, so the caller's window into it is
  // dropped. Left in, a `page` would start the walk partway down and quietly
  // leave the earlier rows out of the file. The walk also runs in the one order
  // a cursor can resume.
  const window = {
    ...(query as object),
    page: 1,
    cursor: undefined,
    sort: "date" as const,
    direction: "desc" as const,
    limit: 200,
    // Never the deleted ones, whatever the view being exported was showing. A
    // deleted entry is void: its postings net to zero and it is not part of the
    // balance. The file carries no column saying so, so including it would put
    // a row indistinguishable from live money in front of the importer, and
    // reading the file back would raise the voided amount from the dead.
    includeDeleted: false,
  };
  const all = await listAllTransactions(actor, window, 100_000);

  const rows = all.map((transaction) => ({
    simple_balance_format: APP_CSV_FORMAT,
    transaction_id: transaction.id,
    transaction_type: transaction.type,
    date: transaction.date,
    payee: transaction.payee,
    description: transaction.description,
    category_id: transaction.categoryId,
    category_name: transaction.category?.name,
    [APP_CSV_EXTERNAL_ID_COLUMN]: transaction.externalId,
    // A split, by category name only. Leg ids and category ids mean nothing in
    // the ledger this file is read into, exactly as account ids do not, so the
    // names are what travel and the import matches or creates them.
    //
    // The key is always present, even for rows that are not splits, because the
    // header row is taken from the first row's keys and a file whose first
    // transaction happens not to be split would otherwise lose the column for
    // every row after it.
    legs_json: transaction.legs.length
      ? JSON.stringify(
          transaction.legs.map((leg) => ({
            categoryName: leg.category?.name ?? null,
            amount: leg.amount,
            note: leg.note,
          })),
        )
      : "",
    notes: transaction.notes,
    // Everything the visible columns cannot carry exactly. The spreadsheet
    // formula neutraliser rewrites a cell beginning with =, +, - or @, which is
    // right for a person opening the file and wrong for a value read back
    // mechanically: a category named "-Reimbursements" grew an apostrophe on
    // every round trip and became a second category each time.
    roundtrip_text_json: JSON.stringify({
      payee: transaction.payee,
      description: transaction.description,
      notes: transaction.notes,
      categoryName: transaction.category?.name ?? null,
      externalId: transaction.externalId ?? null,
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
      APP_CSV_EXTERNAL_ID_COLUMN,
      "notes",
      "source_account_name",
      "destination_account_name",
    ]),
    rowCount: rows.length,
  };
}
