import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Actor, Page, TransactionDraft } from "../../shared/domain.js";
import {
  listQuerySchema,
  positiveDecimalStringSchema,
  transactionDraftSchema,
  transactionUpdateSchema,
} from "../../shared/domain.js";
import {
  getDb,
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
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";

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
    description: draft.description,
    payee: draft.payee ?? null,
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
      "The implied exchange rate cannot be represented with 26 integer and 12 fractional digits",
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

  return buildPreparedTransaction(actor, draft, accountMap);
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
): Promise<Page<TransactionView>> {
  const query = listQuerySchema.parse(queryInput);
  const conditions: SQL[] = [eq(transactions.userId, actor.userId)];
  if (!query.includeDeleted) conditions.push(isNull(transactions.deletedAt));
  if (query.start) conditions.push(sql`${transactions.date} >= ${query.start}::date`);
  if (query.end) conditions.push(lte(transactions.date, query.end));
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    conditions.push(
      or(
        lt(transactions.date, cursor.sort),
        and(eq(transactions.date, cursor.sort), lt(transactions.id, cursor.id)),
      )!,
    );
  }
  if (query.type) conditions.push(eq(transactions.type, query.type));
  if (query.categoryId) conditions.push(eq(transactions.categoryId, query.categoryId));
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
        ilike(transactions.description, pattern),
        ilike(transactions.payee, pattern),
        ilike(transactions.notes, pattern),
      )!,
    );
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(query.limit + 1);
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
  };
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
        sql`lower(regexp_replace(trim(${transactions.description}), '\\s+', ' ', 'g')) = ${normalizeTransactionText(draft.description)}`,
        accountCondition,
        amountCondition,
        ...transferConditions,
      ),
    )
    .limit(1);
  return match?.id ?? null;
}

function normalizeTransactionText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function transactionHeuristicDuplicateKey(draft: TransactionDraft) {
  const common = [
    draft.type,
    draft.date,
    normalizeTransactionText(draft.description),
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
    description: row.description,
    payee: row.payee,
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
