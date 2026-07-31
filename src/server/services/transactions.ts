import { createHash } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type {
  Actor,
  BulkTransactionEditInput,
  BulkTransactionEditResult,
  BulkTransactionFilter,
  BulkTransactionPatch,
  BulkTransactionSelectionSnapshot,
  PaginatedPage,
  TransactionDraft,
} from "../../shared/domain.js";
import {
  bulkTransactionFilterSelectionRequestSchema,
  bulkTransactionEditResultSchema,
  bulkTransactionEditSchema,
  bulkTransactionSelectionSnapshotSchema,
  listQuerySchema,
  positiveDecimalStringSchema,
  transactionDraftSchema,
  transactionUpdateSchema,
} from "../../shared/domain.js";
import {
  getDb,
  type Database,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  categories,
  ledgerAccounts,
  postings,
  transactions,
  type TransactionRow,
} from "../db/schema.js";
import { duplicate, notFound, staleVersion, validationError } from "./errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  canonicalDecimal,
  decimal,
  getIdempotent,
  lockAccountReferences,
  lockCategoryNamespace,
  lockIdempotencyKey,
  lockPayeeNamespace,
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";
import { normalizeHumanName } from "./names.js";
import { resolveCanonicalPayee } from "./payees.js";

type PreparedTransaction = {
  transaction: typeof transactions.$inferInsert;
  postings: (typeof postings.$inferInsert)[];
};

type PostingAccount = {
  id: string;
  currency: string;
};

export type TransactionView = ReturnType<typeof transactionView>;

function transactionView(
  row: TransactionRow,
  sourceAccount?: { id: string; name: string; currency: string } | null,
  destinationAccount?: { id: string; name: string; currency: string } | null,
  category?: { id: string; name: string; kind: string } | null,
) {
  return {
    ...serializeRow(row),
    sourceAmount: row.sourceAmount ? canonicalDecimal(row.sourceAmount) : null,
    destinationAmount: row.destinationAmount
      ? canonicalDecimal(row.destinationAmount)
      : null,
    effectiveRate: row.effectiveRate ? canonicalDecimal(row.effectiveRate) : null,
    sourceAccount: sourceAccount ?? null,
    destinationAccount: destinationAccount ?? null,
    category: category ?? null,
  };
}

async function getOwnedAccounts(
  tx: DbTransaction,
  actor: Actor,
  ids: string[],
  allowedArchivedIds: ReadonlySet<string> = new Set(),
) {
  const rows = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.userId, actor.userId),
        inArray(ledgerAccounts.id, [...new Set(ids)]),
      ),
    );
  if (
    rows.length !== new Set(ids).size ||
    rows.some(
      (row) => row.archivedAt !== null && !allowedArchivedIds.has(row.id),
    )
  ) {
    throw validationError("One or more accounts are unavailable");
  }
  return new Map(rows.map((row) => [row.id, row]));
}

type PrepareTransactionOptions = {
  allowedArchivedAccountIds?: ReadonlySet<string>;
  allowedArchivedCategoryIds?: ReadonlySet<string>;
};

export function buildPreparedTransaction(
  actor: Actor,
  draft: TransactionDraft,
  accountMap: Map<string, PostingAccount>,
): PreparedTransaction {
  const common = {
    userId: actor.userId,
    type: draft.type,
    date: draft.date,
    payee: draft.payee,
    description: draft.description ?? null,
    categoryId: draft.categoryId ?? null,
    notes: draft.notes ?? null,
    externalId: draft.externalId ?? null,
  };

  if (draft.type === "deposit") {
    const destination = accountMap.get(draft.toAccountId);
    if (!destination) throw validationError("Destination account is unavailable");
    return {
      transaction: {
        ...common,
        destinationAccountId: destination.id,
        destinationAmount: canonicalDecimal(draft.amount),
        destinationCurrency: destination.currency,
      },
      postings: [
        {
          userId: actor.userId,
          transactionId: "00000000-0000-0000-0000-000000000000",
          accountId: destination.id,
          amount: canonicalDecimal(draft.amount),
          currency: destination.currency,
        },
      ],
    };
  }

  if (draft.type === "withdrawal") {
    const source = accountMap.get(draft.fromAccountId);
    if (!source) throw validationError("Source account is unavailable");
    return {
      transaction: {
        ...common,
        sourceAccountId: source.id,
        sourceAmount: canonicalDecimal(draft.amount),
        sourceCurrency: source.currency,
      },
      postings: [
        {
          userId: actor.userId,
          transactionId: "00000000-0000-0000-0000-000000000000",
          accountId: source.id,
          amount: canonicalDecimal(decimal(draft.amount).negated()),
          currency: source.currency,
        },
      ],
    };
  }

  if (draft.fromAccountId === draft.toAccountId) {
    throw validationError("Transfer accounts must be different");
  }
  const source = accountMap.get(draft.fromAccountId);
  const destination = accountMap.get(draft.toAccountId);
  if (!source || !destination) throw validationError("Transfer account is unavailable");
  if (source.currency !== destination.currency && !draft.destinationAmount) {
    throw validationError(
      "Destination amount is required when transfer currencies differ",
      { field: "destinationAmount" },
    );
  }
  if (
    source.currency === destination.currency &&
    draft.destinationAmount &&
    !decimal(draft.destinationAmount).eq(draft.sourceAmount)
  ) {
    throw validationError("Same-currency transfer amounts must match");
  }
  const destinationAmount = draft.destinationAmount ?? draft.sourceAmount;
  const effectiveRate =
    source.currency === destination.currency
      ? "1"
      : canonicalDecimal(decimal(destinationAmount).dividedBy(draft.sourceAmount));
  if (!positiveDecimalStringSchema.safeParse(effectiveRate).success) {
    throw validationError(
      "The implied exchange rate cannot be represented with 26 integer and 18 fractional digits",
      { field: "destinationAmount" },
    );
  }
  return {
    transaction: {
      ...common,
      sourceAccountId: source.id,
      destinationAccountId: destination.id,
      sourceAmount: canonicalDecimal(draft.sourceAmount),
      destinationAmount: canonicalDecimal(destinationAmount),
      sourceCurrency: source.currency,
      destinationCurrency: destination.currency,
      effectiveRate,
    },
    postings: [
      {
        userId: actor.userId,
        transactionId: "00000000-0000-0000-0000-000000000000",
        accountId: source.id,
        amount: canonicalDecimal(decimal(draft.sourceAmount).negated()),
        currency: source.currency,
      },
      {
        userId: actor.userId,
        transactionId: "00000000-0000-0000-0000-000000000000",
        accountId: destination.id,
        amount: canonicalDecimal(destinationAmount),
        currency: destination.currency,
      },
    ],
  };
}

export async function prepareTransaction(
  tx: DbTransaction,
  actor: Actor,
  draftInput: unknown,
  options: PrepareTransactionOptions = {},
): Promise<PreparedTransaction> {
  const draft = transactionDraftSchema.parse(draftInput);
  const accountIds =
    draft.type === "deposit"
      ? [draft.toAccountId]
      : draft.type === "withdrawal"
        ? [draft.fromAccountId]
        : [draft.fromAccountId, draft.toAccountId];
  await lockAccountReferences(tx, actor, accountIds);
  if (draft.categoryId) {
    await lockCategoryNamespace(tx, actor);
  }
  await lockPayeeNamespace(tx, actor);
  const canonicalDraft = {
    ...draft,
    payee: await resolveCanonicalPayee(tx, actor, draft.payee),
  };
  const accountMap = await getOwnedAccounts(
    tx,
    actor,
    accountIds,
    options.allowedArchivedAccountIds,
  );

  if (draft.categoryId) {
    const [category] = await tx
      .select()
      .from(categories)
      .where(
        and(eq(categories.id, draft.categoryId), eq(categories.userId, actor.userId)),
      )
      .limit(1);
    if (
      !category ||
      (category.archivedAt !== null &&
        !options.allowedArchivedCategoryIds?.has(category.id))
    ) {
      throw validationError("Category is unavailable");
    }
    if (draft.type === "deposit" && category.kind === "expense") {
      throw validationError("Choose an income category for a deposit");
    }
    if (draft.type === "withdrawal" && category.kind === "income") {
      throw validationError("Choose an expense category for a withdrawal");
    }
  }

  return buildPreparedTransaction(actor, canonicalDraft, accountMap);
}

export async function createTransactionWithinTx(
  tx: DbTransaction,
  actor: Actor,
  draft: TransactionDraft,
  auditOperation = "create",
  allowDuplicate = false,
) {
  const prepared = await prepareTransaction(tx, actor, draft);
  await assertDuplicateAllowed(tx, actor, draft, allowDuplicate);
  const [created] = await tx.insert(transactions).values(prepared.transaction).returning();
  await tx.insert(postings).values(
    prepared.postings.map((posting) => ({
      ...posting,
      transactionId: created.id,
    })),
  );
  await writeAudit(tx, actor, {
    entityType: "transaction",
    entityId: created.id,
    operation: auditOperation,
    after: serializeRow(created),
  });
  return created;
}

export async function createTransaction(
  actor: Actor,
  draft: TransactionDraft,
  idempotencyKey: string,
  allowDuplicate = false,
  transaction?: DbTransaction,
) {
  const parsedDraft = transactionDraftSchema.parse(draft);
  const idempotencyPayload = {
    draft: parsedDraft,
    allowDuplicate,
  };
  return withTransaction(transaction, async (tx) => {
    await lockIdempotencyKey(
      tx,
      actor,
      "transaction.create",
      idempotencyKey,
    );
    const existing = await getIdempotent<TransactionView>(
      tx,
      actor,
      "transaction.create",
      idempotencyKey,
      idempotencyPayload,
    );
    if (existing) return existing;
    const created = await createTransactionWithinTx(
      tx,
      actor,
      parsedDraft,
      "create",
      allowDuplicate,
    );
    const view = await hydrateTransaction(tx, actor, created);
    await setIdempotent(
      tx,
      actor,
      "transaction.create",
      idempotencyKey,
      idempotencyPayload,
      view,
    );
    return view;
  });
}

async function hydrateTransaction(
  tx: DbTransaction,
  actor: Actor,
  row: TransactionRow,
) {
  const accountIds = [row.sourceAccountId, row.destinationAccountId].filter(
    (value): value is string => Boolean(value),
  );
  const accountRows = accountIds.length
    ? await tx
        .select({
          id: ledgerAccounts.id,
          name: ledgerAccounts.name,
          currency: ledgerAccounts.currency,
        })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.userId, actor.userId),
            inArray(ledgerAccounts.id, accountIds),
          ),
        )
    : [];
  const accountMap = new Map(accountRows.map((account) => [account.id, account]));
  const [category] = row.categoryId
    ? await tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(and(eq(categories.id, row.categoryId), eq(categories.userId, actor.userId)))
        .limit(1)
    : [undefined];
  return transactionView(
    row,
    row.sourceAccountId ? accountMap.get(row.sourceAccountId) : null,
    row.destinationAccountId ? accountMap.get(row.destinationAccountId) : null,
    category,
  );
}

export async function getTransaction(actor: Actor, id: string) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, actor.userId)))
      .limit(1);
    if (!row) throw notFound("Transaction not found");
    return hydrateTransaction(tx, actor, row);
  });
}

export async function listTransactions(
  actor: Actor,
  queryInput: unknown,
): Promise<PaginatedPage<TransactionView>> {
  const query = listQuerySchema.parse(queryInput);
  // The filter alone describes the whole result set, so the total is counted
  // before any cursor or page window narrows it.
  const filters = transactionFilterConditions(actor, query);
  const conditions = [...filters];
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    conditions.push(
      or(
        lt(transactions.date, cursor.sort),
        and(eq(transactions.date, cursor.sort), lt(transactions.id, cursor.id)),
      )!,
    );
  }

  const db = getDb();
  const [totals] = await db
    .select({ value: count() })
    .from(transactions)
    .where(and(...filters));
  const totalCount = totals?.value ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / query.limit));
  // A cursor keeps its streaming semantics; page numbers drive the browser.
  const page = query.cursor ? 1 : Math.min(query.page, totalPages);
  const offset = query.cursor ? 0 : (page - 1) * query.limit;
  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(query.limit + 1)
    .offset(offset);
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const items = await db.transaction(async (tx) =>
    Promise.all(pageRows.map((row) => hydrateTransaction(tx, actor, row))),
  );
  return {
    items,
    nextCursor: hasMore
      ? encodeCursor({
          sort: pageRows.at(-1)!.date,
          id: pageRows.at(-1)!.id,
        })
      : null,
    page,
    pageSize: query.limit,
    totalCount,
    totalPages,
  };
}

function transactionFilterConditions(
  actor: Actor,
  query: BulkTransactionFilter,
) {
  const conditions: SQL[] = [eq(transactions.userId, actor.userId)];
  if (!query.includeDeleted) conditions.push(isNull(transactions.deletedAt));
  if (query.start) conditions.push(sql`${transactions.date} >= ${query.start}::date`);
  if (query.end) conditions.push(lte(transactions.date, query.end));
  if (query.type) conditions.push(eq(transactions.type, query.type));
  if (query.categoryId) conditions.push(eq(transactions.categoryId, query.categoryId));
  if (query.payee) {
    conditions.push(
      sql`lower(regexp_replace(trim(normalize(${transactions.payee}, NFKC)), '\\s+', ' ', 'g')) = ${normalizeTransactionText(query.payee)}`,
    );
  }
  if (query.accountId) {
    conditions.push(
      or(
        eq(transactions.sourceAccountId, query.accountId),
        eq(transactions.destinationAccountId, query.accountId),
      )!,
    );
  }
  if (query.currency) {
    conditions.push(
      or(
        eq(transactions.sourceCurrency, query.currency),
        eq(transactions.destinationCurrency, query.currency),
      )!,
    );
  }
  if (query.search) {
    const pattern = `%${query.search}%`;
    conditions.push(
      or(
        ilike(transactions.payee, pattern),
        ilike(transactions.description, pattern),
        ilike(transactions.notes, pattern),
      )!,
    );
  }
  return conditions;
}

function bulkSelectionFingerprint(
  rows: readonly Pick<TransactionRow, "id" | "version">[],
) {
  const payload = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => `${row.id}:${row.version}`)
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

function bulkSelectionSummary(rows: readonly TransactionRow[]) {
  const currencies = new Set<string>();
  let activeCount = 0;
  let deletedCount = 0;
  let transferCount = 0;
  for (const row of rows) {
    if (row.deletedAt) deletedCount += 1;
    else activeCount += 1;
    if (row.type === "transfer") transferCount += 1;
    if (row.sourceCurrency) currencies.add(row.sourceCurrency);
    if (row.destinationCurrency) currencies.add(row.destinationCurrency);
  }
  return {
    activeCount,
    deletedCount,
    transferCount,
    currencies: [...currencies].sort(),
  };
}

async function selectBulkFilterRows(
  executor: Database | DbTransaction,
  actor: Actor,
  selection: {
    filter: BulkTransactionFilter;
    excludedIds: readonly string[];
  },
) {
  const conditions = transactionFilterConditions(actor, selection.filter);
  if (selection.excludedIds.length) {
    conditions.push(notInArray(transactions.id, [...selection.excludedIds]));
  }
  return executor
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(transactions.id);
}

export async function getBulkTransactionSelection(
  actor: Actor,
  input: unknown,
): Promise<BulkTransactionSelectionSnapshot> {
  const parsed = bulkTransactionFilterSelectionRequestSchema.parse(input);
  const rows = await selectBulkFilterRows(getDb(), actor, parsed);
  return bulkTransactionSelectionSnapshotSchema.parse({
    count: rows.length,
    fingerprint: bulkSelectionFingerprint(rows),
    ...bulkSelectionSummary(rows),
  });
}

function applyBulkPatch(
  row: TransactionRow,
  patch: BulkTransactionPatch,
): TransactionDraft {
  if (row.type === "transfer" && (patch.accountId || patch.type)) {
    throw validationError(
      "Bulk account and type changes cannot include transfers",
      { transactionId: row.id, fields: ["accountId", "type"] },
    );
  }

  const current = transactionToDraft(row);
  const common = {
    date: patch.date ?? current.date,
    payee: patch.payee ?? current.payee,
    description:
      patch.description !== undefined
        ? patch.description
        : current.description,
    categoryId:
      patch.categoryId !== undefined
        ? patch.categoryId
        : current.categoryId,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    externalId: current.externalId,
  };

  if (!patch.type) {
    if (current.type === "deposit") {
      return {
        type: "deposit",
        toAccountId: patch.accountId ?? current.toAccountId,
        amount: current.amount,
        ...common,
      };
    }
    if (current.type === "withdrawal") {
      return {
        type: "withdrawal",
        fromAccountId: patch.accountId ?? current.fromAccountId,
        amount: current.amount,
        ...common,
      };
    }
    return { ...current, ...common };
  }

  const currentAccountId =
    current.type === "deposit"
      ? current.toAccountId
      : current.type === "withdrawal"
        ? current.fromAccountId
        : patch.type === "deposit"
          ? current.toAccountId
          : current.fromAccountId;
  const amount =
    current.type === "transfer"
      ? patch.type === "deposit"
        ? current.destinationAmount ?? current.sourceAmount
        : current.sourceAmount
      : current.amount;
  const accountId = patch.accountId ?? currentAccountId;
  return patch.type === "deposit"
    ? {
        type: "deposit",
        toAccountId: accountId,
        amount,
        ...common,
      }
    : {
        type: "withdrawal",
        fromAccountId: accountId,
        amount,
        ...common,
      };
}

function draftAccountIds(draft: TransactionDraft) {
  return draft.type === "deposit"
    ? [draft.toAccountId]
    : draft.type === "withdrawal"
      ? [draft.fromAccountId]
      : [draft.fromAccountId, draft.toAccountId];
}

type BulkEditPlan = {
  before: TransactionRow;
  draft: TransactionDraft;
  prepared: PreparedTransaction;
};

function assertExpectedFilterSnapshot(
  selection: Extract<BulkTransactionEditInput["selection"], { mode: "filter" }>,
  rows: readonly TransactionRow[],
) {
  const fingerprint = bulkSelectionFingerprint(rows);
  if (
    rows.length !== selection.expectedCount ||
    fingerprint !== selection.expectedFingerprint
  ) {
    throw staleVersion({
      expectedCount: selection.expectedCount,
      currentCount: rows.length,
      expectedFingerprint: selection.expectedFingerprint,
      currentFingerprint: fingerprint,
    });
  }
}

function normalizedBulkSelection(
  selection: BulkTransactionEditInput["selection"],
) {
  if (selection.mode === "ids") {
    return {
      mode: selection.mode,
      items: [...selection.items].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    };
  }
  return {
    ...selection,
    excludedIds: [...selection.excludedIds].sort(),
  };
}

async function selectBulkSnapshot(
  tx: DbTransaction,
  actor: Actor,
  selection: BulkTransactionEditInput["selection"],
) {
  if (selection.mode === "filter") {
    const rows = await selectBulkFilterRows(tx, actor, selection);
    assertExpectedFilterSnapshot(selection, rows);
    return rows;
  }

  const ids = selection.items.map((item) => item.id);
  const rows = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        inArray(transactions.id, ids),
      ),
    )
    .orderBy(transactions.id);
  if (rows.length !== ids.length) {
    throw notFound("One or more transactions are unavailable");
  }
  const expectedVersions = new Map(
    selection.items.map((item) => [item.id, item.expectedVersion]),
  );
  const staleItems = rows
    .filter((row) => expectedVersions.get(row.id) !== row.version)
    .map((row) => ({
      id: row.id,
      expectedVersion: expectedVersions.get(row.id),
      currentVersion: row.version,
    }));
  if (staleItems.length) throw staleVersion({ items: staleItems });
  return rows;
}

async function assertBulkDuplicatesAllowed(
  tx: DbTransaction,
  actor: Actor,
  plans: readonly BulkEditPlan[],
  allowDuplicates: boolean,
) {
  const selectedIds = new Set(plans.map((plan) => plan.before.id));
  const selectedByKey = new Map<string, string>();
  for (const plan of plans) {
    if (plan.before.deletedAt !== null) continue;
    for (const key of transactionDuplicateKeys(plan.draft)) {
      const duplicateOfSelectedId = selectedByKey.get(key);
      if (duplicateOfSelectedId && !allowDuplicates) {
        throw duplicate("Two selected transactions appear to be duplicates", {
          transactionId: plan.before.id,
          duplicateOfSelectedId,
        });
      }
      if (!duplicateOfSelectedId) {
        selectedByKey.set(key, plan.before.id);
      }
    }
  }
  if (allowDuplicates || !selectedByKey.size) return;

  const activeRows = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        isNull(transactions.deletedAt),
      ),
    )
    .orderBy(transactions.id);
  for (const row of activeRows) {
    if (selectedIds.has(row.id)) continue;
    const collidedSelectedId = transactionDuplicateKeys(transactionToDraft(row))
      .map((key) => selectedByKey.get(key))
      .find((id): id is string => Boolean(id));
    if (collidedSelectedId) {
      throw duplicate("A selected transaction matches another transaction", {
        transactionId: collidedSelectedId,
        duplicateOfId: row.id,
      });
    }
  }
}

export async function bulkEditTransactions(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<BulkTransactionEditResult> {
  const parsed = bulkTransactionEditSchema.parse(input);
  const idempotencyPayload = {
    selection: normalizedBulkSelection(parsed.selection),
    patch: parsed.patch,
    allowDuplicates: parsed.allowDuplicates,
  };

  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "transaction.bulk_edit",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<BulkTransactionEditResult>(
        tx,
        actor,
        "transaction.bulk_edit",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return bulkTransactionEditResultSchema.parse(existing);
    }

    const snapshotRows = await selectBulkSnapshot(tx, actor, parsed.selection);
    if (!snapshotRows.length) {
      throw validationError("Select at least one transaction");
    }
    const snapshotFingerprint = bulkSelectionFingerprint(snapshotRows);
    const snapshotDrafts = snapshotRows.map((row) => ({
      row,
      draft: applyBulkPatch(row, parsed.patch),
    }));

    await lockAccountReferences(
      tx,
      actor,
      snapshotDrafts.flatMap(({ row, draft }) => [
        ...[row.sourceAccountId, row.destinationAccountId].filter(
          (id): id is string => Boolean(id),
        ),
        ...draftAccountIds(draft),
      ]),
    );
    if (
      snapshotDrafts.some(
        ({ row, draft }) => Boolean(row.categoryId || draft.categoryId),
      )
    ) {
      await lockCategoryNamespace(tx, actor);
    }
    await lockPayeeNamespace(tx, actor);
    await lockTransactionDuplicateKeys(
      tx,
      actor,
      snapshotDrafts
        .filter(({ row }) => row.deletedAt === null)
        .map(({ draft }) => draft),
    );

    const snapshotIds = snapshotRows.map((row) => row.id);
    const lockedRows = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          inArray(transactions.id, snapshotIds),
        ),
      )
      .orderBy(transactions.id)
      .for("update");
    const lockedFingerprint = bulkSelectionFingerprint(lockedRows);
    if (
      lockedRows.length !== snapshotRows.length ||
      lockedFingerprint !== snapshotFingerprint
    ) {
      throw staleVersion({
        expectedCount: snapshotRows.length,
        currentCount: lockedRows.length,
        expectedFingerprint: snapshotFingerprint,
        currentFingerprint: lockedFingerprint,
      });
    }
    if (parsed.selection.mode === "filter") {
      assertExpectedFilterSnapshot(parsed.selection, lockedRows);
      const currentFilterRows = await selectBulkFilterRows(
        tx,
        actor,
        parsed.selection,
      );
      assertExpectedFilterSnapshot(parsed.selection, currentFilterRows);
    }

    const plans: BulkEditPlan[] = [];
    for (const before of lockedRows) {
      const draft = applyBulkPatch(before, parsed.patch);
      const existingAccountIds = new Set(
        [before.sourceAccountId, before.destinationAccountId].filter(
          (id): id is string => Boolean(id),
        ),
      );
      const prepared = await prepareTransaction(tx, actor, draft, {
        allowedArchivedAccountIds: existingAccountIds,
        allowedArchivedCategoryIds: new Set(
          before.categoryId ? [before.categoryId] : [],
        ),
      });
      const canonicalPayee = prepared.transaction.payee;
      if (typeof canonicalPayee !== "string") {
        throw new TypeError("Prepared transaction payee must be text");
      }
      if (parsed.patch.accountId && before.type !== "transfer") {
        const previousCurrency =
          before.type === "deposit"
            ? before.destinationCurrency
            : before.sourceCurrency;
        const targetCurrency =
          draft.type === "deposit"
            ? prepared.transaction.destinationCurrency
            : prepared.transaction.sourceCurrency;
        if (previousCurrency !== targetCurrency) {
          throw validationError(
            "Bulk account changes must keep the transaction's existing currency",
            {
              transactionId: before.id,
              previousCurrency,
              targetCurrency,
            },
          );
        }
      }
      plans.push({
        before,
        prepared,
        draft: { ...draft, payee: canonicalPayee },
      });
    }

    await assertBulkDuplicatesAllowed(
      tx,
      actor,
      plans,
      parsed.allowDuplicates,
    );

    const plannedItems = plans.map(({ before, draft }) => ({
      id: before.id,
      previousVersion: before.version,
      nextVersion: before.version + 1,
      type: draft.type,
      date: draft.date,
      payee: draft.payee,
    }));
    const visibleItems =
      parsed.selection.mode === "filter"
        ? plannedItems.slice(0, 200)
        : plannedItems;
    const baseResult = {
      updatedCount: plans.length,
      dryRun: parsed.dryRun,
      selectionCount: plans.length,
      selectionFingerprint: snapshotFingerprint,
      ...bulkSelectionSummary(lockedRows),
      itemsTruncated: visibleItems.length !== plannedItems.length,
      items: visibleItems,
    };
    if (parsed.dryRun) {
      return bulkTransactionEditResultSchema.parse(baseResult);
    }

    const now = new Date();
    const updatedRows: TransactionRow[] = [];
    for (const { before, prepared, draft } of plans) {
      const values = prepared.transaction;
      const [updated] = await tx
        .update(transactions)
        .set({
          type: draft.type,
          date: draft.date,
          payee: draft.payee,
          description: draft.description ?? null,
          categoryId: draft.categoryId ?? null,
          notes: draft.notes ?? null,
          externalId: before.externalId,
          sourceAccountId: values.sourceAccountId ?? null,
          destinationAccountId: values.destinationAccountId ?? null,
          sourceAmount: values.sourceAmount ?? null,
          destinationAmount: values.destinationAmount ?? null,
          sourceCurrency: values.sourceCurrency ?? null,
          destinationCurrency: values.destinationCurrency ?? null,
          effectiveRate: values.effectiveRate ?? null,
          version: before.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(transactions.id, before.id),
            eq(transactions.userId, actor.userId),
            eq(transactions.version, before.version),
          ),
        )
        .returning();
      if (!updated) throw staleVersion({ id: before.id });
      updatedRows.push(updated);
    }

    await tx
      .delete(postings)
      .where(
        and(
          eq(postings.userId, actor.userId),
          inArray(postings.transactionId, snapshotIds),
        ),
      );
    const replacementPostings = plans.flatMap(({ before, prepared }) =>
      prepared.postings.map((posting) => ({
        ...posting,
        transactionId: before.id,
      })),
    );
    if (replacementPostings.length) {
      await tx.insert(postings).values(replacementPostings);
    }

    for (let index = 0; index < plans.length; index += 1) {
      await writeAudit(tx, actor, {
        entityType: "transaction",
        entityId: plans[index]!.before.id,
        operation: "bulk_update",
        before: serializeRow(plans[index]!.before),
        after: serializeRow(updatedRows[index]!),
      });
    }

    const result = bulkTransactionEditResultSchema.parse({
      ...baseResult,
      dryRun: false,
    });
    await setIdempotent(
      tx,
      actor,
      "transaction.bulk_edit",
      parsed.idempotencyKey,
      idempotencyPayload,
      result,
    );
    return result;
  });
}

export async function updateTransaction(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const { draft, expectedVersion, allowDuplicate } =
    transactionUpdateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Transaction not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    const allowedArchivedAccountIds = new Set(
      [before.sourceAccountId, before.destinationAccountId].filter(
        (accountId): accountId is string => accountId !== null,
      ),
    );
    const allowedArchivedCategoryIds = new Set(
      before.categoryId ? [before.categoryId] : [],
    );
    const prepared = await prepareTransaction(tx, actor, draft, {
      allowedArchivedAccountIds,
      allowedArchivedCategoryIds,
    });
    await assertDuplicateAllowed(tx, actor, draft, allowDuplicate, id);
    const [updated] = await tx
      .update(transactions)
      .set({
        ...prepared.transaction,
        id: undefined,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.id, id),
          eq(transactions.userId, actor.userId),
          eq(transactions.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    await tx
      .delete(postings)
      .where(
        and(
          eq(postings.transactionId, id),
          eq(postings.userId, actor.userId),
        ),
      );
    await tx.insert(postings).values(
      prepared.postings.map((posting) => ({ ...posting, transactionId: id })),
    );
    await writeAudit(tx, actor, {
      entityType: "transaction",
      entityId: id,
      operation: "update",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return hydrateTransaction(tx, actor, updated);
  });
}

export async function setTransactionDeleted(
  actor: Actor,
  id: string,
  expectedVersion: number,
  deleted: boolean,
  allowDuplicate = false,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    const [before] = await tx
      .select()
      .from(transactions)
      .where(and(eq(transactions.id, id), eq(transactions.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Transaction not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    if (!deleted && before.deletedAt) {
      await assertDuplicateAllowed(
        tx,
        actor,
        transactionToDraft(before),
        allowDuplicate,
        id,
      );
    }
    const [updated] = await tx
      .update(transactions)
      .set({
        deletedAt: deleted ? new Date() : null,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transactions.id, id),
          eq(transactions.userId, actor.userId),
          eq(transactions.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "transaction",
      entityId: id,
      operation: deleted ? "delete" : "restore",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return hydrateTransaction(tx, actor, updated);
  });
}

export async function findDuplicate(
  tx: DbTransaction,
  actor: Actor,
  draft: TransactionDraft,
  excludeTransactionId?: string,
) {
  const exclusion = excludeTransactionId
    ? ne(transactions.id, excludeTransactionId)
    : sql`true`;
  if (draft.externalId) {
    const [exact] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          isNull(transactions.deletedAt),
          exclusion,
          eq(transactions.externalId, draft.externalId),
        ),
      )
      .limit(1);
    if (exact) return exact.id;
  }
  const accountId =
    draft.type === "deposit"
      ? draft.toAccountId
      : draft.type === "withdrawal"
        ? draft.fromAccountId
        : draft.fromAccountId;
  const amount =
    draft.type === "transfer" ? draft.sourceAmount : draft.amount;
  const accountCondition =
    draft.type === "deposit"
      ? eq(transactions.destinationAccountId, accountId)
      : eq(transactions.sourceAccountId, accountId);
  const amountCondition =
    draft.type === "deposit"
      ? eq(transactions.destinationAmount, canonicalDecimal(amount))
      : eq(transactions.sourceAmount, canonicalDecimal(amount));
  const transferConditions =
    draft.type === "transfer"
      ? [
          eq(transactions.destinationAccountId, draft.toAccountId),
          eq(
            transactions.destinationAmount,
            canonicalDecimal(draft.destinationAmount ?? draft.sourceAmount),
          ),
        ]
      : [];
  const [match] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        isNull(transactions.deletedAt),
        exclusion,
        eq(transactions.type, draft.type),
        eq(transactions.date, draft.date),
        sql`lower(regexp_replace(trim(normalize(${transactions.payee}, NFKC)), '\\s+', ' ', 'g')) = ${normalizeTransactionText(draft.payee)}`,
        accountCondition,
        amountCondition,
        ...transferConditions,
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

function normalizeTransactionText(value: string) {
  return normalizeHumanName(value);
}

function transactionHeuristicDuplicateKey(draft: TransactionDraft) {
  const common = [
    draft.type,
    draft.date,
    normalizeTransactionText(draft.payee),
  ];
  if (draft.type === "deposit") {
    return `heuristic:${JSON.stringify([
      ...common,
      draft.toAccountId,
      canonicalDecimal(draft.amount),
    ])}`;
  }
  if (draft.type === "withdrawal") {
    return `heuristic:${JSON.stringify([
      ...common,
      draft.fromAccountId,
      canonicalDecimal(draft.amount),
    ])}`;
  }
  return `heuristic:${JSON.stringify([
    ...common,
    draft.fromAccountId,
    canonicalDecimal(draft.sourceAmount),
    draft.toAccountId,
    canonicalDecimal(draft.destinationAmount ?? draft.sourceAmount),
  ])}`;
}

export function transactionDuplicateKeys(draft: TransactionDraft) {
  const keys = [transactionHeuristicDuplicateKey(draft)];
  if (draft.externalId) {
    keys.push(`external:${draft.externalId.trim()}`);
  }
  return [...new Set(keys)].sort();
}

export async function lockTransactionDuplicateKeys(
  tx: DbTransaction,
  actor: Actor,
  drafts: TransactionDraft[],
) {
  const fingerprints = [
    ...new Set(
      drafts.flatMap((draft) =>
        transactionDuplicateKeys(draft).map((key) => `${actor.userId}:${key}`),
      ),
    ),
  ].sort();
  for (const fingerprint of fingerprints) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`,
    );
  }
}

async function assertDuplicateAllowed(
  tx: DbTransaction,
  actor: Actor,
  draft: TransactionDraft,
  allowDuplicate: boolean,
  excludeTransactionId?: string,
) {
  await lockTransactionDuplicateKeys(tx, actor, [draft]);
  const duplicateOfId = await findDuplicate(
    tx,
    actor,
    draft,
    excludeTransactionId,
  );
  if (duplicateOfId && !allowDuplicate) {
    throw duplicate("This transaction appears to be a duplicate", {
      duplicateOfId,
    });
  }
}

export function transactionToDraft(row: TransactionRow): TransactionDraft {
  const common = {
    date: row.date,
    payee: row.payee,
    description: row.description,
    categoryId: row.categoryId,
    notes: row.notes,
    externalId: row.externalId,
  };
  if (row.type === "deposit") {
    return {
      type: "deposit",
      toAccountId: row.destinationAccountId!,
      amount: canonicalDecimal(row.destinationAmount!),
      ...common,
    };
  }
  if (row.type === "withdrawal") {
    return {
      type: "withdrawal",
      fromAccountId: row.sourceAccountId!,
      amount: canonicalDecimal(row.sourceAmount!),
      ...common,
    };
  }
  return {
    type: "transfer",
    fromAccountId: row.sourceAccountId!,
    toAccountId: row.destinationAccountId!,
    sourceAmount: canonicalDecimal(row.sourceAmount!),
    destinationAmount: canonicalDecimal(row.destinationAmount!),
    ...common,
  };
}
