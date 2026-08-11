import { Decimal } from "decimal.js";
import {
  and,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
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
  SystemAccountKind,
  PaginatedPage,
  TransactionDraft,
  SortDirection,
  TransactionSortField,
} from "../../shared/domain.js";
import {
  bulkTransactionFilterSelectionRequestSchema,
  bulkTransactionEditResultSchema,
  bulkTransactionDeleteSchema,
  bulkTransactionEditSchema,
  bulkTransactionSelectionSnapshotSchema,
  decimalStringSchema,
  isoDateSchema,
  listQuerySchema,
  MAX_BULK_SELECTION_ENTRIES,
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
  transactionLegs,
  transactionTemplates,
  transactions,
  type CategoryRow,
  type TransactionLegRow,
  type TransactionRow,
} from "../db/schema.js";
import { duplicate, notFound, staleVersion, validationError } from "./errors.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  canonicalDecimal,
  decimal,
  exceedsBulkSelectionCap,
  getIdempotent,
  likePattern,
  lockAccountReferences,
  lockCategoryNamespace,
  lockIdempotencyKey,
  lockPayeeNamespace,
  selectionFingerprint,
  serializeRow,
  setIdempotent,
  writeAudit,
} from "./helpers.js";
import {
  type SortPlan,
  keysetAfter,
  ordered,
} from "./sorting.js";
import { ensureSystemAccount, postClosingBalance } from "./accounts.js";
import { resolveDraftCategory } from "./categories.js";
import { normalizeHumanName } from "../../shared/names.js";
import { resolveCanonicalPayee } from "./payees.js";

/**
 * A leg as it should end up, before it has a row. `id` names an existing leg;
 * without one this is a new leg.
 */
type LegSeed = {
  id?: string;
  categoryId: string | null;
  amount: string;
  note: string | null;
};

/**
 * A posting before it is filed, naming its leg by position rather than by id.
 *
 * Positions rather than ids because buildPreparedTransaction is pure: staged
 * validation runs it for every queued row, so it must not mint identifiers or
 * touch the database. The caller turns the index into a leg id once the legs
 * have rows.
 */
type PreparedPosting = Omit<typeof postings.$inferInsert, "legId"> & {
  legIndex: number | null;
};

type PreparedTransaction = {
  transaction: typeof transactions.$inferInsert;
  postings: PreparedPosting[];
  legs: LegSeed[];
};

type PostingAccount = {
  id: string;
  currency: string;
};

export type TransactionView = ReturnType<typeof transactionView>;

type CategoryLabel = { id: string; name: string; kind: string };

/**
 * One leg as a reader sees it: the id it has to send back to keep editing that
 * same leg, and the category spelled out rather than referenced.
 */
function legView(leg: TransactionLegRow, category: CategoryLabel | null) {
  return {
    id: leg.id,
    categoryId: leg.categoryId,
    category,
    amount: canonicalDecimal(leg.amount),
    note: leg.note,
  };
}

export type TransactionLegView = ReturnType<typeof legView>;

function transactionView(
  row: TransactionRow,
  sourceAccount?: { id: string; name: string; currency: string } | null,
  destinationAccount?: { id: string; name: string; currency: string } | null,
  category?: CategoryLabel | null,
  legs: TransactionLegView[] = [],
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
    legs,
  };
}

/**
 * The legs of each transaction, labelled, with the zeroed ones left out.
 *
 * A leg worth nothing is no longer part of the split; its row survives only
 * because the postings that name it are append-only, and showing it would mean
 * showing a share of nothing.
 */
function legViews(
  legs: readonly TransactionLegRow[] | undefined,
  categoryMap: ReadonlyMap<string, CategoryLabel>,
): TransactionLegView[] {
  if (!legs) return [];
  return legs
    .filter((leg) => !decimal(leg.amount).isZero())
    .map((leg) =>
      legView(leg, leg.categoryId ? (categoryMap.get(leg.categoryId) ?? null) : null),
    );
}

async function getOwnedAccounts(
  tx: DbTransaction,
  actor: Actor,
  ids: string[],
  allowedArchivedIds: ReadonlySet<string> = new Set(),
  preloaded?: ReadonlyMap<string, typeof ledgerAccounts.$inferSelect>,
) {
  const rows = preloaded
    ? [...new Set(ids)]
        .map((id) => preloaded.get(id))
        .filter((row): row is typeof ledgerAccounts.$inferSelect => Boolean(row))
    : await tx
        .select()
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.userId, actor.userId),
            inArray(ledgerAccounts.id, [...new Set(ids)]),
            // The counter-accounts are the ledger's own, and they never appear
            // in a picker. Naming one directly would post both halves of an
            // entry to the same account, which nets to nothing while the
            // transaction still reads as real money moving.
            isNull(ledgerAccounts.systemKind),
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
  /**
   * The tenant's accounts, categories and template ids, read once by a caller
   * about to prepare thousands of drafts.
   *
   * Passed rather than memoised behind the transaction, so nothing has to
   * reason about when a cache goes stale: a caller that reads these and then
   * writes to those tables simply does not pass them. All three are bounded per
   * person, so reading them whole costs three queries instead of three per row.
   */
  references?: LedgerReferences;
};

export type LedgerReferences = {
  accounts: Map<string, typeof ledgerAccounts.$inferSelect>;
  categories: Map<string, CategoryRow>;
  templateIds: ReadonlySet<string>;
};

/** Everything prepareTransaction would otherwise look up per draft. */
export async function loadLedgerReferences(
  tx: DbTransaction,
  actor: Actor,
): Promise<LedgerReferences> {
  // One after another, not Promise.all: a transaction is a single connection,
  // and pipelining queries down it is what pg deprecated.
  const accountRows = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.userId, actor.userId),
        isNull(ledgerAccounts.systemKind),
      ),
    );
  const categoryRows = await tx
    .select()
    .from(categories)
    .where(eq(categories.userId, actor.userId));
  const templateRows = await tx
    .select({ id: transactionTemplates.id })
    .from(transactionTemplates)
    .where(eq(transactionTemplates.userId, actor.userId));
  return {
    accounts: new Map(accountRows.map((row) => [row.id, row])),
    categories: new Map(categoryRows.map((row) => [row.id, row])),
    templateIds: new Set(templateRows.map((row) => row.id)),
  };
}

/** Counter-accounts keyed by kind and currency. */
export type SystemAccountMap = Map<string, PostingAccount>;

export const systemAccountKey = (kind: SystemAccountKind, currency: string) =>
  `${kind}:${currency}`;

function counterAccount(
  systemAccounts: SystemAccountMap,
  kind: SystemAccountKind,
  currency: string,
) {
  const account = systemAccounts.get(systemAccountKey(kind, currency));
  if (!account) {
    throw validationError(`The ${kind} account for ${currency} is unavailable`);
  }
  return account;
}

/**
 * Half of an entry, before it is filed. The date is stamped on once for the
 * whole entry, because every posting a transaction makes happened on the day
 * the transaction did.
 */
type PostingSeed = Omit<PreparedPosting, "date" | "transactionId">;

function posting(
  actor: Actor,
  accountId: string,
  amount: string | Decimal,
  currency: string,
  legIndex: number | null = null,
): PostingSeed {
  return {
    userId: actor.userId,
    accountId,
    amount: canonicalDecimal(amount),
    currency,
    legIndex,
  };
}

/** Every entry must settle to zero in each currency it touches. */
function assertBalanced(prepared: PreparedTransaction) {
  const totals = new Map<string, Decimal>();
  for (const entry of prepared.postings) {
    totals.set(
      entry.currency,
      (totals.get(entry.currency) ?? decimal("0")).plus(entry.amount),
    );
  }
  for (const [currency, total] of totals) {
    if (!total.isZero()) {
      throw validationError(
        `Postings for ${currency} do not balance to zero`,
        { currency, total: canonicalDecimal(total) },
      );
    }
  }
  return prepared;
}

/**
 * Refuse a split whose legs do not add up to the amount of the entry.
 *
 * This guarantees nothing that `assertBalanced` does not already guarantee: the
 * legs *are* the counter-account postings, so legs summing to 95 against a
 * total of 100 leave a 5 residual and are refused a few lines later either way.
 * It exists for what it says. `assertBalanced` would report "Postings for USD
 * do not balance to zero", which tells somebody who has just typed a receipt
 * nothing about the receipt. It also runs during staged validation, so an
 * import lands in the queue as a row that can be repaired rather than one that
 * was rejected. Deleting it would cost no correctness and all of the diagnosis.
 */
function assertLegsCoverTotal(draft: TransactionDraft, total: string) {
  if (!draft.legs) return;
  const summed = draft.legs.reduce(
    (running, leg) => running.plus(leg.amount),
    decimal("0"),
  );
  if (summed.eq(total)) return;
  throw validationError(
    `The split adds up to ${canonicalDecimal(summed)}, but the transaction is ${canonicalDecimal(total)}`,
    {
      field: "legs",
      legTotal: canonicalDecimal(summed),
      transactionAmount: canonicalDecimal(total),
      difference: canonicalDecimal(summed.minus(total)),
    },
  );
}

/**
 * The counter-account side of an entry, as one posting or as one per leg.
 *
 * A split does not add a second record of the money; it cuts the side that was
 * already there into pieces. That is why nothing has to check that the pieces
 * add up: they are the postings the balance check already sums.
 */
function counterPostings(
  actor: Actor,
  draft: TransactionDraft,
  accountId: string,
  total: string,
  currency: string,
  sign: 1 | -1,
): PostingSeed[] {
  const signed = (amount: string) =>
    sign === 1 ? decimal(amount) : decimal(amount).negated();
  if (!draft.legs) return [posting(actor, accountId, signed(total), currency)];
  return draft.legs.map((leg, index) =>
    posting(actor, accountId, signed(leg.amount), currency, index),
  );
}

function legSeeds(draft: TransactionDraft): LegSeed[] {
  return (draft.legs ?? []).map((leg) => ({
    ...(leg.id ? { id: leg.id } : {}),
    categoryId: leg.categoryId ?? null,
    amount: canonicalDecimal(leg.amount),
    note: leg.note ?? null,
  }));
}

export function buildPreparedTransaction(
  actor: Actor,
  draft: TransactionDraft,
  accountMap: Map<string, PostingAccount>,
  systemAccounts: SystemAccountMap = new Map(),
): PreparedTransaction {
  const common = {
    userId: actor.userId,
    type: draft.type,
    date: draft.date,
    payee: draft.payee,
    description: draft.description ?? null,
    categoryId: draft.categoryId ?? null,
    templateId: draft.templateId ?? null,
    notes: draft.notes ?? null,
    externalId: draft.externalId ?? null,
  };
  const entries = (seeds: PostingSeed[]): PreparedPosting[] =>
    seeds.map((seed) => ({ ...seed, date: common.date }));

  if (draft.type === "deposit") {
    const destination = accountMap.get(draft.toAccountId);
    if (!destination) throw validationError("Destination account is unavailable");
    assertLegsCoverTotal(draft, draft.amount);
    return {
      transaction: {
        ...common,
        destinationAccountId: destination.id,
        destinationAmount: canonicalDecimal(draft.amount),
        destinationCurrency: destination.currency,
        legCount: draft.legs?.length ?? 0,
      },
      legs: legSeeds(draft),
      postings: entries([
        posting(actor, destination.id, draft.amount, destination.currency),
        // The other half of the entry, as one posting or one per leg. Without
        // it the deposit would create money out of nothing.
        ...counterPostings(
          actor,
          draft,
          counterAccount(systemAccounts, "income", destination.currency).id,
          draft.amount,
          destination.currency,
          -1,
        ),
      ]),
    };
  }

  if (draft.type === "withdrawal") {
    const source = accountMap.get(draft.fromAccountId);
    if (!source) throw validationError("Source account is unavailable");
    assertLegsCoverTotal(draft, draft.amount);
    return {
      transaction: {
        ...common,
        sourceAccountId: source.id,
        sourceAmount: canonicalDecimal(draft.amount),
        sourceCurrency: source.currency,
        legCount: draft.legs?.length ?? 0,
      },
      legs: legSeeds(draft),
      postings: entries([
        posting(actor, source.id, decimal(draft.amount).negated(), source.currency),
        ...counterPostings(
          actor,
          draft,
          counterAccount(systemAccounts, "expense", source.currency).id,
          draft.amount,
          source.currency,
          1,
        ),
      ]),
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
      legCount: 0,
    },
    legs: [],
    postings: entries(
      source.currency === destination.currency
        ? [
            posting(
              actor,
              source.id,
              decimal(draft.sourceAmount).negated(),
              source.currency,
            ),
            posting(actor, destination.id, destinationAmount, destination.currency),
          ]
        : [
            posting(
              actor,
              source.id,
              decimal(draft.sourceAmount).negated(),
              source.currency,
            ),
            posting(
              actor,
              counterAccount(systemAccounts, "exchange", source.currency).id,
              draft.sourceAmount,
              source.currency,
            ),
            posting(
              actor,
              counterAccount(systemAccounts, "exchange", destination.currency).id,
              decimal(destinationAmount).negated(),
              destination.currency,
            ),
            posting(actor, destination.id, destinationAmount, destination.currency),
          ],
    ),
  };
}

/**
 * Every column that describes the shape of a transaction, named explicitly.
 *
 * A prepared transaction only carries the columns its own shape needs, so
 * spreading it into an update leaves the previous shape's columns untouched.
 * Turning a withdrawal into a deposit that way keeps the old source account and
 * amount alongside the new destination ones, which the shape check rejects.
 * Listing them all means the shape being written is the whole shape.
 */
function transactionShapeColumns(values: typeof transactions.$inferInsert) {
  return {
    type: values.type,
    date: values.date,
    payee: values.payee,
    description: values.description ?? null,
    categoryId: values.categoryId ?? null,
    templateId: values.templateId ?? null,
    notes: values.notes ?? null,
    sourceAccountId: values.sourceAccountId ?? null,
    destinationAccountId: values.destinationAccountId ?? null,
    sourceAmount: values.sourceAmount ?? null,
    destinationAmount: values.destinationAmount ?? null,
    sourceCurrency: values.sourceCurrency ?? null,
    destinationCurrency: values.destinationCurrency ?? null,
    effectiveRate: values.effectiveRate ?? null,
    // Editing a split down to one category has to clear this, or the check
    // constraint holds the row to a shape it no longer has.
    legCount: values.legCount ?? 0,
  };
}

/**
 * Bring an entry's postings to a desired state without ever editing or deleting
 * one. The difference between what is posted and what should be posted is
 * worked out per account, currency, date, and leg, and only that difference is
 * written.
 *
 * Correcting an amount therefore costs one adjusting posting per side rather
 * than a full reversal plus a full repost, and an edit that changes nothing
 * about the movement writes nothing at all. Recategorising a leg is exactly
 * that kind of edit: the label lives on the leg row and the leg's identity does
 * not change, so the difference is empty and no posting is written. Changing
 * what a leg is worth does write two, which is right, because the money was
 * divided differently.
 *
 * Passing an empty desired set voids the entry, which is how deletion works.
 * Each leg is negated under its own id, so a split goes to zero one leg at a
 * time and every one of its categories drops out of the reports. Passing its
 * postings back restores it.
 *
 * The rows still sum to the current position, and the path there stays legible.
 */
/**
 * Bring a transaction's legs to the desired list and hand back where each
 * prepared posting's `legIndex` now points.
 *
 * A leg is never deleted, only zeroed. Its postings reference it and they are
 * append-only, so removing the row would take the history of the money with it.
 * A zeroed leg nets to nothing through `repostTransaction`, disappears from
 * every report through the `sum(amount) <> 0` filters they already have, and is
 * waiting to be reused if that category comes back.
 *
 * Returned by index rather than mutating the seeds, because the seeds come from
 * a pure builder that has no ids to give.
 */
async function resyncLegs(
  tx: DbTransaction,
  actor: Actor,
  transactionId: string,
  desired: readonly LegSeed[],
): Promise<(string | null)[]> {
  const existing = await tx
    .select()
    .from(transactionLegs)
    .where(
      and(
        eq(transactionLegs.userId, actor.userId),
        eq(transactionLegs.transactionId, transactionId),
      ),
    );
  const byId = new Map(existing.map((leg) => [leg.id, leg]));

  const named = new Set<string>();
  const ids: (string | null)[] = [];
  for (const [ordinal, leg] of desired.entries()) {
    const current = leg.id ? byId.get(leg.id) : undefined;
    if (leg.id && !current) throw validationError("Leg is unavailable");
    if (current) {
      named.add(current.id);
      await tx
        .update(transactionLegs)
        .set({
          categoryId: leg.categoryId,
          amount: leg.amount,
          note: leg.note,
          ordinal,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(transactionLegs.id, current.id),
            eq(transactionLegs.userId, actor.userId),
          ),
        );
      ids.push(current.id);
      continue;
    }
    const [created] = await tx
      .insert(transactionLegs)
      .values({
        userId: actor.userId,
        transactionId,
        categoryId: leg.categoryId,
        amount: leg.amount,
        note: leg.note,
        ordinal,
      })
      .returning({ id: transactionLegs.id });
    named.add(created.id);
    ids.push(created.id);
  }

  const dropped = existing.filter(
    (leg) => !named.has(leg.id) && !decimal(leg.amount).isZero(),
  );
  if (dropped.length) {
    // The category goes with the amount. A leg worth nothing belongs to no
    // category, and leaving the label behind would keep a foreign key on a
    // category every screen already reports as unused, so it could never be
    // deleted and nothing on screen would say why.
    await tx
      .update(transactionLegs)
      .set({ amount: "0", categoryId: null, updatedAt: new Date() })
      .where(
        and(
          eq(transactionLegs.userId, actor.userId),
          inArray(
            transactionLegs.id,
            dropped.map((leg) => leg.id),
          ),
        ),
      );
  }
  return ids;
}

/**
 * A transaction as the audit log should record it: the row and its legs.
 *
 * The legs carry the categories a split went to, and relabelling one writes no
 * posting and touches no column on the transaction. An audit entry built from
 * the row alone therefore has an identical before and after for exactly the
 * change somebody is most likely to want to look up later.
 *
 * A zeroed leg is left out for the same reason it is left out everywhere else:
 * it is how a leg is removed, and a list of them is what the entry now says.
 */
function auditedTransaction(
  row: TransactionRow,
  legs: readonly TransactionLegRow[],
) {
  const live = legs.filter((leg) => !decimal(leg.amount).isZero());
  const serialized = serializeRow(row);
  if (!live.length) return serialized;
  return {
    ...serialized,
    legs: live.map((leg) => ({
      id: leg.id,
      categoryId: leg.categoryId,
      amount: canonicalDecimal(leg.amount),
      note: leg.note,
      ordinal: leg.ordinal,
    })),
  };
}

/**
 * Every transaction's legs, in display order, for a batch of transactions.
 *
 * One query for a page of rows rather than one per row: a mass edit over a
 * whole filter would otherwise issue a lookup per transaction to find out that
 * almost none of them are splits.
 */
async function legsByTransaction(
  db: Database | DbTransaction,
  actor: Actor,
  transactionIds: readonly string[],
): Promise<Map<string, TransactionLegRow[]>> {
  const byTransaction = new Map<string, TransactionLegRow[]>();
  if (!transactionIds.length) return byTransaction;
  const rows = await db
    .select()
    .from(transactionLegs)
    .where(
      and(
        eq(transactionLegs.userId, actor.userId),
        inArray(transactionLegs.transactionId, [...transactionIds]),
      ),
    )
    .orderBy(transactionLegs.transactionId, transactionLegs.ordinal);
  for (const row of rows) {
    const legs = byTransaction.get(row.transactionId);
    if (legs) legs.push(row);
    else byTransaction.set(row.transactionId, [row]);
  }
  return byTransaction;
}

/** Stamp each prepared posting with the leg its index resolved to. */
function withLegIds(
  prepared: readonly PreparedPosting[],
  legIds: readonly (string | null)[],
  transactionId: string,
): (typeof postings.$inferInsert)[] {
  return prepared.map(({ legIndex, ...posting }) => ({
    ...posting,
    transactionId,
    legId: legIndex === null ? null : (legIds[legIndex] ?? null),
  }));
}

export async function repostTransaction(
  tx: DbTransaction,
  actor: Actor,
  transactionId: string,
  next: readonly (typeof postings.$inferInsert)[],
) {
  const current = await tx
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.userId, actor.userId),
        eq(postings.transactionId, transactionId),
      ),
    );

  type Slot = {
    accountId: string;
    currency: string;
    date: string;
    legId: string | null;
    amount: Decimal;
  };
  const net = new Map<string, Slot>();
  const add = (
    row: {
      accountId: string;
      currency: string;
      date: string;
      legId?: string | null;
    },
    amount: Decimal,
  ) => {
    // The leg belongs in the key. Every leg of a split posts to the same
    // counter-account, in the same currency, on the same date, so without it
    // the legs of a receipt collapse into one slot on the first edit, delete or
    // restore and the split is gone. Postings are append-only, so there would
    // be nothing left to repair it from.
    const key = `${row.accountId}|${row.currency}|${row.date}|${row.legId ?? ""}`;
    const slot = net.get(key);
    if (slot) {
      slot.amount = slot.amount.plus(amount);
      return;
    }
    net.set(key, {
      accountId: row.accountId,
      currency: row.currency,
      date: row.date,
      legId: row.legId ?? null,
      amount,
    });
  };
  for (const row of current) add(row, decimal(row.amount).negated());
  for (const row of next) add(row, decimal(row.amount));

  const rows = [...net.values()]
    .filter((slot) => !slot.amount.isZero())
    .map((slot) => ({
      userId: actor.userId,
      transactionId,
      accountId: slot.accountId,
      date: slot.date,
      legId: slot.legId,
      amount: canonicalDecimal(slot.amount),
      currency: slot.currency,
    }));
  if (!rows.length) return false;
  await tx.insert(postings).values(rows);

  // An archived account was closed out to zero, and this just posted into it.
  // Editing or deleting a transaction that ran through one would otherwise
  // strand money in an account no total counts, which is the exact hole
  // archiving was changed to close. Re-closing here covers every path, because
  // every repost comes through this function.
  await reconcileClosedAccounts(
    tx,
    actor,
    rows.map((row) => row.accountId),
  );
  return true;
}

/**
 * Put an archived account back at zero after something posted into it.
 *
 * Cheap for the ordinary case: accounts that are not archived are filtered out
 * in one query, and a live one never reaches postClosingBalance.
 */
async function reconcileClosedAccounts(
  tx: DbTransaction,
  actor: Actor,
  accountIds: readonly string[],
) {
  const touched = [...new Set(accountIds)];
  if (!touched.length) return;
  const archived = await tx
    .select({
      id: ledgerAccounts.id,
      currency: ledgerAccounts.currency,
      archivedAt: ledgerAccounts.archivedAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.userId, actor.userId),
        inArray(ledgerAccounts.id, touched),
        isNotNull(ledgerAccounts.archivedAt),
      ),
    );
  for (const account of archived) {
    await postClosingBalance(tx, actor, account, true);
  }
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
  if (draft.categoryId || draft.legs?.some((leg) => leg.categoryId)) {
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
    options.references?.accounts,
  );

  // Resolve the counter-accounts this entry needs before building it, so the
  // postings can be assembled without further database access.
  const systemAccounts: SystemAccountMap = new Map();
  const needed: { kind: SystemAccountKind; currency: string }[] = [];
  if (draft.type === "deposit") {
    needed.push({
      kind: "income",
      currency: accountMap.get(draft.toAccountId)!.currency,
    });
  } else if (draft.type === "withdrawal") {
    needed.push({
      kind: "expense",
      currency: accountMap.get(draft.fromAccountId)!.currency,
    });
  } else {
    const from = accountMap.get(draft.fromAccountId)!.currency;
    const to = accountMap.get(draft.toAccountId)!.currency;
    if (from !== to) {
      needed.push({ kind: "exchange", currency: from });
      needed.push({ kind: "exchange", currency: to });
    }
  }
  for (const { kind, currency } of needed) {
    const account = await ensureSystemAccount(tx, actor, kind, currency);
    systemAccounts.set(systemAccountKey(kind, currency), account);
  }

  // A template id carries no foreign key, so ownership is checked here. Without
  // it an entry could name somebody else's template and be counted against it.
  if (draft.templateId) {
    const owned = options.references
      ? options.references.templateIds.has(draft.templateId)
      : (
          await tx
            .select({ id: transactionTemplates.id })
            .from(transactionTemplates)
            .where(
              and(
                eq(transactionTemplates.id, draft.templateId),
                eq(transactionTemplates.userId, actor.userId),
              ),
            )
            .limit(1)
        ).length > 0;
    if (!owned) throw validationError("Template is unavailable");
  }

  // Every category the entry names, whether it names one or one per leg. The
  // legs of an entry are all shares of the same movement, so they answer to the
  // same rule about which kind of category may carry it.
  const namedCategoryIds = new Set(
    [
      draft.categoryId,
      ...(draft.legs ?? []).map((leg) => leg.categoryId),
    ].filter((id) => id != null),
  );
  for (const categoryId of namedCategoryIds) {
    const category = options.references
      ? options.references.categories.get(categoryId)
      : (
          await tx
            .select()
            .from(categories)
            .where(
              and(
                eq(categories.id, categoryId),
                eq(categories.userId, actor.userId),
              ),
            )
            .limit(1)
        )[0];
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

  return assertBalanced(
    buildPreparedTransaction(actor, canonicalDraft, accountMap, systemAccounts),
  );
}

export async function createTransactionWithinTx(
  tx: DbTransaction,
  actor: Actor,
  input: TransactionDraft,
  auditOperation = "create",
  allowDuplicate = false,
) {
  // A named category becomes a real one here rather than inside
  // prepareTransaction, which is also how a staged row is checked and must
  // stay free of side effects.
  //
  // The account locks come first even though nothing here reads an account
  // yet. Resolving a name takes the category namespace lock, and the order in
  // helpers.ts is accounts, then categories, then payees; taking the category
  // lock ahead of them is the one path that could deadlock against every other
  // write.
  await lockAccountReferences(tx, actor, draftAccountIds(input));
  const draft = await resolveDraftCategory(tx, actor, input);
  const prepared = await prepareTransaction(tx, actor, draft);
  await assertDuplicateAllowed(tx, actor, draft, allowDuplicate);
  const [created] = await tx.insert(transactions).values(prepared.transaction).returning();
  const legIds = await resyncLegs(tx, actor, created.id, prepared.legs);
  await tx
    .insert(postings)
    .values(withLegIds(prepared.postings, legIds, created.id));
  await writeAudit(tx, actor, {
    entityType: "transaction",
    entityId: created.id,
    operation: auditOperation,
    after: auditedTransaction(
      created,
      (await legsByTransaction(tx, actor, [created.id])).get(created.id) ?? [],
    ),
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

/**
 * Names for a whole page of rows in two queries rather than two per row.
 *
 * hydrateTransaction is right for the one row a write returns. Mapping it over
 * a page is not: the rows are read inside one transaction, so they share a
 * single connection and the lookups run one after another rather than at once.
 * A fifty-row page meant a hundred sequential round trips to say what fifty
 * accounts and categories are called.
 */
async function hydrateTransactions(
  tx: DbTransaction,
  actor: Actor,
  rows: TransactionRow[],
) {
  if (!rows.length) return [];
  const accountIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.sourceAccountId, row.destinationAccountId].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ),
  ];
  // One query for the legs of the whole page, folded into the same category
  // lookup the rows already needed, so a page of splits costs no more round
  // trips than a page without one.
  const legs = await legsByTransaction(
    tx,
    actor,
    rows.filter((row) => row.legCount > 0).map((row) => row.id),
  );
  const categoryIds = [
    ...new Set(
      [
        ...rows.map((row) => row.categoryId),
        ...[...legs.values()].flat().map((leg) => leg.categoryId),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];

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
  const categoryRows = categoryIds.length
    ? await tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(
          and(
            eq(categories.userId, actor.userId),
            inArray(categories.id, categoryIds),
          ),
        )
    : [];

  const accountMap = new Map(accountRows.map((account) => [account.id, account]));
  const categoryMap = new Map(categoryRows.map((category) => [category.id, category]));
  return rows.map((row) =>
    transactionView(
      row,
      row.sourceAccountId ? accountMap.get(row.sourceAccountId) : null,
      row.destinationAccountId ? accountMap.get(row.destinationAccountId) : null,
      row.categoryId ? categoryMap.get(row.categoryId) : undefined,
      legViews(legs.get(row.id), categoryMap),
    ),
  );
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
  const legs = row.legCount
    ? ((await legsByTransaction(tx, actor, [row.id])).get(row.id) ?? [])
    : [];
  const categoryIds = [
    ...new Set(
      [row.categoryId, ...legs.map((leg) => leg.categoryId)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const categoryRows = categoryIds.length
    ? await tx
        .select({ id: categories.id, name: categories.name, kind: categories.kind })
        .from(categories)
        .where(
          and(
            eq(categories.userId, actor.userId),
            inArray(categories.id, categoryIds),
          ),
        )
    : [];
  const categoryMap = new Map(categoryRows.map((category) => [category.id, category]));
  return transactionView(
    row,
    row.sourceAccountId ? accountMap.get(row.sourceAccountId) : null,
    row.destinationAccountId ? accountMap.get(row.destinationAccountId) : null,
    row.categoryId ? categoryMap.get(row.categoryId) : undefined,
    legViews(legs, categoryMap),
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

/**
 * The orderings the transaction list offers, one per column it shows.
 *
 * Account and category are reached through another table, so they order by a
 * correlated lookup and cannot be resumed by a keyset cursor. The rest sit on
 * the row itself and can.
 */
function transactionSortPlan(
  sort: TransactionSortField,
  direction: SortDirection,
): SortPlan<TransactionRow> {
  const id = sql`${transactions.id}`;
  const tie = ordered(id, direction);
  const resumable = (
    expression: SQL,
    value: (row: TransactionRow) => string,
    parseCursorValue?: (value: string) => void,
  ) => ({
    orderBy: [ordered(expression, direction), tie],
    keyset: keysetAfter(expression, id, direction),
    cursorValue: value,
    parseCursorValue,
  });
  // Reached through another table, so the value can be absent and the ordering
  // has to say where absent belongs.
  const paged = (expression: SQL) => ({
    orderBy: [ordered(expression, direction, true), tie],
    keyset: null,
    cursorValue: null,
  });

  switch (sort) {
    case "payee":
      return resumable(sql`lower(${transactions.payee})`, (row) =>
        row.payee.toLowerCase(),
      );
    case "amount":
      // The magnitude the row shows: a deposit records only a destination
      // amount, everything else records a source amount.
      return resumable(
        sql`coalesce(${transactions.sourceAmount}, ${transactions.destinationAmount})`,
        (row) => String(row.sourceAmount ?? row.destinationAmount ?? "0"),
        // Compared against numeric(44,18).
        (value) => {
          decimalStringSchema.parse(value);
        },
      );
    case "account":
      return paged(sql`(
        select lower(name) from ledger_account
        where ledger_account.user_id = ${transactions.userId}
          and ledger_account.id = coalesce(
            ${transactions.sourceAccountId},
            ${transactions.destinationAccountId}
          )
      )`);
    case "category":
      // A split names several categories, so this sorts it under the first of
      // them alphabetically. The min is not only about the order: a scalar
      // subquery handed several rows is a hard runtime error, not a wrong
      // answer, so a list sorted by category would break outright on the first
      // split without it.
      return paged(sql`(
        select min(lower(c.name)) from category c
        where c.user_id = ${transactions.userId}
          and (
            c.id = ${transactions.categoryId}
            or c.id in (
              select l.category_id from transaction_leg l
              where l.user_id = ${transactions.userId}
                and l.transaction_id = ${transactions.id}
                and l.amount <> 0
            )
          )
      )`);
    default:
      // Compared against a date column.
      return resumable(sql`${transactions.date}`, (row) => row.date, (value) => {
        isoDateSchema.parse(value);
      });
  }
}

/**
 * Every transaction a filter matches, in one walk.
 *
 * Separate from `listTransactions` because that one counts the whole filtered
 * set on every call, which is what the browser needs for a page count and what
 * an export asks five hundred times for the same answer. Nothing here needs a
 * total, so nothing here counts one, and every batch's hydration shares a
 * single database transaction rather than opening its own.
 */
export async function listAllTransactions(
  actor: Actor,
  queryInput: unknown,
  maxRows: number,
): Promise<TransactionView[]> {
  const query = listQuerySchema.parse(queryInput);
  const filters = transactionFilterConditions(actor, query);
  const plan = transactionSortPlan(query.sort, query.direction);
  if (!plan.keyset || !plan.cursorValue) {
    throw validationError("This sort order cannot be exported.", {
      sort: query.sort,
    });
  }
  const batchSize = Math.min(Math.max(query.limit, 200), 500);
  return getDb().transaction(async (tx) => {
    const all: TransactionView[] = [];
    let after: { sort: string; id: string } | undefined;
    for (;;) {
      const conditions = after
        ? [...filters, plan.keyset!(after.sort, after.id)]
        : filters;
      const rows = await tx
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(...plan.orderBy)
        .limit(batchSize);
      if (!rows.length) return all;
      all.push(...(await hydrateTransactions(tx, actor, rows)));
      if (all.length > maxRows) {
        throw validationError(
          `Export exceeds ${maxRows.toLocaleString("en-US")} rows`,
        );
      }
      if (rows.length < batchSize) return all;
      const last = rows.at(-1)!;
      after = { sort: plan.cursorValue!(last), id: last.id };
    }
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
  const plan = transactionSortPlan(query.sort, query.direction);
  if (query.cursor) {
    if (!plan.keyset) {
      throw validationError(
        "This sort order pages by number rather than by cursor.",
        { sort: query.sort },
      );
    }
    const cursor = decodeCursor(query.cursor, {
      key: query.sort,
      direction: query.direction,
    });
    try {
      plan.parseCursorValue?.(cursor.sort);
    } catch {
      throw validationError("Cursor is invalid");
    }
    conditions.push(plan.keyset(cursor.sort, cursor.id));
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
    .orderBy(...plan.orderBy)
    .limit(query.limit + 1)
    .offset(offset);
  const hasMore = rows.length > query.limit;
  const pageRows = rows.slice(0, query.limit);
  const last = pageRows.at(-1);
  const items = await db.transaction(async (tx) =>
    hydrateTransactions(tx, actor, pageRows),
  );
  return {
    items,
    nextCursor:
      hasMore && last && plan.cursorValue
        ? encodeCursor({
            key: query.sort,
            direction: query.direction,
            sort: plan.cursorValue(last),
            id: last.id,
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
  if (query.categoryId) {
    // An exists rather than a join, so a receipt split two ways across the same
    // category is still one row in the list and counts once towards a mass
    // edit's expected count.
    conditions.push(
      or(
        eq(transactions.categoryId, query.categoryId),
        sql`exists (
          select 1 from transaction_leg l
          where l.user_id = ${transactions.userId}
            and l.transaction_id = ${transactions.id}
            and l.category_id = ${query.categoryId}
            and l.amount <> 0
        )`,
      )!,
    );
  }
  if (query.templateId) conditions.push(eq(transactions.templateId, query.templateId));
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
    const pattern = likePattern(query.search);
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

/**
 * Which of these transactions are splits, asked of the leg rows themselves.
 *
 * `ledger_transaction.leg_count` would answer faster and is deliberately not
 * used: it has exactly one reader, the check constraint, so if it ever drifted
 * the constraint would go slack rather than a screen telling somebody the wrong
 * thing about what they are about to change.
 */
async function splitTransactionIds(
  executor: Database | DbTransaction,
  actor: Actor,
  transactionIds: readonly string[],
): Promise<Set<string>> {
  if (!transactionIds.length) return new Set();
  const rows = await executor
    .selectDistinct({ transactionId: transactionLegs.transactionId })
    .from(transactionLegs)
    .where(
      and(
        eq(transactionLegs.userId, actor.userId),
        inArray(transactionLegs.transactionId, [...transactionIds]),
        ne(transactionLegs.amount, "0"),
      ),
    );
  return new Set(rows.map((row) => row.transactionId));
}

function bulkSelectionSummary(
  rows: readonly TransactionRow[],
  splitIds: ReadonlySet<string>,
) {
  const currencies = new Set<string>();
  let activeCount = 0;
  let deletedCount = 0;
  let transferCount = 0;
  let splitCount = 0;
  for (const row of rows) {
    if (row.deletedAt) deletedCount += 1;
    else activeCount += 1;
    if (row.type === "transfer") transferCount += 1;
    if (splitIds.has(row.id)) splitCount += 1;
    if (row.sourceCurrency) currencies.add(row.sourceCurrency);
    if (row.destinationCurrency) currencies.add(row.destinationCurrency);
  }
  return {
    activeCount,
    deletedCount,
    transferCount,
    splitCount,
    currencies: [...currencies].sort(),
  };
}

/** The summary of a selection, with the split count looked up for it. */
async function bulkSelectionSummaryFor(
  executor: Database | DbTransaction,
  actor: Actor,
  rows: readonly TransactionRow[],
) {
  return bulkSelectionSummary(
    rows,
    await splitTransactionIds(
      executor,
      actor,
      rows.map((row) => row.id),
    ),
  );
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
  const rows = await executor
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(transactions.id)
    // One past the cap, so the refusal happens in PostgreSQL rather than after
    // a whole ledger has been fetched, fingerprinted and held in memory. An
    // explicit-id selection is bounded by its own schema; a filter is not
    // bounded by anything the caller sends, so it is bounded here.
    .limit(MAX_BULK_SELECTION_ENTRIES + 1);
  if (rows.length > MAX_BULK_SELECTION_ENTRIES) {
    throw validationError(exceedsBulkSelectionCap("transactions"), {
      field: "filter",
      limit: MAX_BULK_SELECTION_ENTRIES,
    });
  }
  return rows;
}

export async function getBulkTransactionSelection(
  actor: Actor,
  input: unknown,
): Promise<BulkTransactionSelectionSnapshot> {
  const parsed = bulkTransactionFilterSelectionRequestSchema.parse(input);
  const rows = await selectBulkFilterRows(getDb(), actor, parsed);
  return bulkTransactionSelectionSnapshotSchema.parse({
    count: rows.length,
    fingerprint: selectionFingerprint(rows),
    ...(await bulkSelectionSummaryFor(getDb(), actor, rows)),
  });
}

function applyBulkPatch(
  row: TransactionRow,
  patch: BulkTransactionPatch,
  legs: readonly TransactionLegRow[] = [],
): TransactionDraft {
  if (row.type === "transfer" && (patch.accountId || patch.type)) {
    throw validationError(
      "Bulk account and type changes cannot include transfers",
      { transactionId: row.id, fields: ["accountId", "type"] },
    );
  }

  const current = transactionToDraft(row, legs);
  // A split already says which categories the money went to, one per leg, so
  // there is no single category to set it to and no honest way to guess which
  // leg was meant. Changing the type is refused for the same reason from the
  // other end: every leg's category was checked against the direction of the
  // entry, and flipping it invalidates all of them at once. Both are refused
  // outright rather than quietly flattening the split, which cannot be undone.
  if (current.legs && (patch.categoryId !== undefined || patch.type)) {
    throw validationError(
      "Bulk category and type changes cannot include split transactions",
      { transactionId: row.id, fields: ["categoryId", "type"] },
    );
  }
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
    // Provenance, and a mass edit is not a reason to lose it. Carried here
    // rather than left to the spread: this object is spread last over the
    // deposit and withdrawal shapes, so a field it does not name is a field
    // those two branches drop.
    templateId: current.templateId,
    legs: current.legs,
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
  const fingerprint = selectionFingerprint(rows);
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

  // Every duplicate key begins with the draft's own date, so a row on any other
  // date cannot collide with any of these plans. Narrowing to the dates being
  // written is therefore exact rather than a heuristic, and it turns a read of
  // the whole ledger into an indexed read of the days it touches.
  const writtenDates = [
    ...new Set(
      plans
        .filter((plan) => plan.before.deletedAt === null)
        .map((plan) => plan.draft.date),
    ),
  ];
  const activeRows = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, actor.userId),
        isNull(transactions.deletedAt),
        inArray(transactions.date, writtenDates),
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
    const snapshotFingerprint = selectionFingerprint(snapshotRows);
    const snapshotLegs = await legsByTransaction(
      tx,
      actor,
      snapshotRows.map((row) => row.id),
    );
    const snapshotDrafts = snapshotRows.map((row) => ({
      row,
      draft: applyBulkPatch(row, parsed.patch, snapshotLegs.get(row.id)),
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
    const lockedFingerprint = selectionFingerprint(lockedRows);
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
    const lockedLegs = await legsByTransaction(
      tx,
      actor,
      lockedRows.map((row) => row.id),
    );
    // Read once for the whole selection. A mass edit changes no account, no
    // category and no template, so what prepareTransaction would look up per
    // row cannot change underneath the loop, and looking it up per row was
    // three round trips each for an answer already in hand.
    const references = await loadLedgerReferences(tx, actor);
    for (const before of lockedRows) {
      const legs = lockedLegs.get(before.id) ?? [];
      const draft = applyBulkPatch(before, parsed.patch, legs);
      const existingAccountIds = new Set(
        [before.sourceAccountId, before.destinationAccountId].filter(
          (id): id is string => Boolean(id),
        ),
      );
      const prepared = await prepareTransaction(tx, actor, draft, {
        references,
        allowedArchivedAccountIds: existingAccountIds,
        // A category archived since the entry was written still has to be
        // allowed through, or a mass date change fails on a split whose
        // categories were tidied away months ago.
        allowedArchivedCategoryIds: new Set(
          [before.categoryId, ...legs.map((leg) => leg.categoryId)].filter(
            (id): id is string => id !== null,
          ),
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
      ...(await bulkSelectionSummaryFor(tx, actor, lockedRows)),
      itemsTruncated: visibleItems.length !== plannedItems.length,
      items: visibleItems,
    };
    if (parsed.dryRun) {
      return bulkTransactionEditResultSchema.parse(baseResult);
    }

    const now = new Date();
    const updatedRows: TransactionRow[] = [];
    for (const { before, prepared } of plans) {
      const values = prepared.transaction;
      const [updated] = await tx
        .update(transactions)
        .set({
          ...transactionShapeColumns(values),
          externalId: before.externalId,
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

    for (const { before, prepared } of plans) {
      const legIds = await resyncLegs(tx, actor, before.id, prepared.legs);
      // A deleted row keeps its labels editable and its ledger void.
      await repostTransaction(
        tx,
        actor,
        before.id,
        before.deletedAt
          ? []
          : withLegIds(prepared.postings, legIds, before.id),
      );
    }
    const editedLegs = await legsByTransaction(
      tx,
      actor,
      plans.map((plan) => plan.before.id),
    );
    for (let index = 0; index < plans.length; index += 1) {
      const before = plans[index]!.before;
      await writeAudit(tx, actor, {
        entityType: "transaction",
        entityId: before.id,
        operation: "bulk_update",
        before: auditedTransaction(before, lockedLegs.get(before.id) ?? []),
        after: auditedTransaction(
          updatedRows[index]!,
          editedLegs.get(before.id) ?? [],
        ),
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

/**
 * Soft-delete every selected transaction in one transaction. Selection safety
 * matches bulkEditTransactions: explicit ids carry their expected version, and a
 * filter selection is re-resolved and fingerprinted before anything is written.
 * Rows already deleted are left untouched so a repeat delete is a no-op rather
 * than a version bump.
 */
export async function bulkDeleteTransactions(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
): Promise<BulkTransactionEditResult> {
  const parsed = bulkTransactionDeleteSchema.parse(input);
  const idempotencyPayload = {
    selection: normalizedBulkSelection(parsed.selection),
    operation: "delete",
  };

  return withTransaction(transaction, async (tx) => {
    if (!parsed.dryRun) {
      await lockIdempotencyKey(
        tx,
        actor,
        "transaction.bulk_delete",
        parsed.idempotencyKey,
      );
      const existing = await getIdempotent<BulkTransactionEditResult>(
        tx,
        actor,
        "transaction.bulk_delete",
        parsed.idempotencyKey,
        idempotencyPayload,
      );
      if (existing) return bulkTransactionEditResultSchema.parse(existing);
    }

    const snapshotRows = await selectBulkSnapshot(tx, actor, parsed.selection);
    if (!snapshotRows.length) {
      throw validationError("Select at least one transaction");
    }
    const snapshotFingerprint = selectionFingerprint(snapshotRows);
    await lockAccountReferences(
      tx,
      actor,
      snapshotRows.flatMap((row) =>
        [row.sourceAccountId, row.destinationAccountId].filter(
          (id): id is string => Boolean(id),
        ),
      ),
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
    const lockedFingerprint = selectionFingerprint(lockedRows);
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
      assertExpectedFilterSnapshot(
        parsed.selection,
        await selectBulkFilterRows(tx, actor, parsed.selection),
      );
    }

    const deletable = lockedRows.filter((row) => row.deletedAt === null);
    const plannedItems = deletable.map((row) => ({
      id: row.id,
      previousVersion: row.version,
      nextVersion: row.version + 1,
      type: row.type,
      date: row.date,
      payee: row.payee,
    }));
    const visibleItems =
      parsed.selection.mode === "filter"
        ? plannedItems.slice(0, 200)
        : plannedItems;
    const baseResult = {
      updatedCount: deletable.length,
      dryRun: parsed.dryRun,
      selectionCount: lockedRows.length,
      selectionFingerprint: snapshotFingerprint,
      ...(await bulkSelectionSummaryFor(tx, actor, lockedRows)),
      itemsTruncated: visibleItems.length !== plannedItems.length,
      items: visibleItems,
    };
    if (parsed.dryRun) {
      return bulkTransactionEditResultSchema.parse(baseResult);
    }

    const now = new Date();
    for (const before of deletable) {
      const [updated] = await tx
        .update(transactions)
        .set({
          deletedAt: now,
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
      await repostTransaction(tx, actor, before.id, []);
      await writeAudit(tx, actor, {
        entityType: "transaction",
        entityId: before.id,
        operation: "bulk_delete",
        before: serializeRow(before),
        after: serializeRow(updated),
      });
    }

    const result = bulkTransactionEditResultSchema.parse({
      ...baseResult,
      dryRun: false,
    });
    await setIdempotent(
      tx,
      actor,
      "transaction.bulk_delete",
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
    const beforeLegs = (await legsByTransaction(tx, actor, [before.id])).get(
      before.id,
    );
    const allowedArchivedCategoryIds = new Set(
      [before.categoryId, ...(beforeLegs ?? []).map((leg) => leg.categoryId)].filter(
        (id): id is string => id !== null,
      ),
    );
    // Accounts before the category namespace, as in helpers.ts. The entry may
    // be moving between accounts, so both sides of the move are locked.
    await lockAccountReferences(tx, actor, [
      ...draftAccountIds(draft),
      ...allowedArchivedAccountIds,
    ]);
    const resolvedDraft = await resolveDraftCategory(tx, actor, draft);
    const prepared = await prepareTransaction(tx, actor, resolvedDraft, {
      allowedArchivedAccountIds,
      allowedArchivedCategoryIds,
    });
    await assertDuplicateAllowed(tx, actor, resolvedDraft, allowDuplicate, id);
    const [updated] = await tx
      .update(transactions)
      .set({
        ...transactionShapeColumns(prepared.transaction),
        externalId: prepared.transaction.externalId ?? null,
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
    const legIds = await resyncLegs(tx, actor, id, prepared.legs);
    // Editing a deleted entry keeps it deleted: the labels change, the ledger
    // stays void until it is restored.
    await repostTransaction(
      tx,
      actor,
      id,
      updated.deletedAt ? [] : withLegIds(prepared.postings, legIds, id),
    );
    await writeAudit(tx, actor, {
      entityType: "transaction",
      entityId: id,
      operation: "update",
      before: auditedTransaction(before, beforeLegs ?? []),
      after: auditedTransaction(
        updated,
        (await legsByTransaction(tx, actor, [id])).get(id) ?? [],
      ),
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
    // A deleted entry is voided in the ledger rather than hidden from it, so
    // no balance or report has to remember to filter it out. Restoring posts
    // the movement back, split and all: deleting negates the postings and
    // leaves the legs alone, so they are still there to be restored onto.
    const legs = (await legsByTransaction(tx, actor, [id])).get(id) ?? [];
    let restored: (typeof postings.$inferInsert)[] = [];
    if (!deleted) {
      const prepared = await prepareTransaction(
        tx,
        actor,
        transactionToDraft(updated, legs),
        {
          allowedArchivedAccountIds: new Set(
            [updated.sourceAccountId, updated.destinationAccountId].filter(
              (accountId): accountId is string => accountId !== null,
            ),
          ),
          allowedArchivedCategoryIds: new Set(
            [updated.categoryId, ...legs.map((leg) => leg.categoryId)].filter(
              (categoryId): categoryId is string => categoryId !== null,
            ),
          ),
        },
      );
      const legIds = await resyncLegs(tx, actor, id, prepared.legs);
      restored = withLegIds(prepared.postings, legIds, id);
    }
    await repostTransaction(tx, actor, id, restored);
    await writeAudit(tx, actor, {
      entityType: "transaction",
      entityId: id,
      operation: deleted ? "delete" : "restore",
      before: auditedTransaction(before, legs),
      after: auditedTransaction(updated, legs),
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

/**
 * Legs are deliberately not part of this, and neither is the category.
 *
 * The question this answers is whether the same money moved twice, and how
 * somebody carved up the receipt afterwards does not change the answer.
 * Including the split would mean re-importing a statement stopped catching the
 * rows that were split last month, which is exactly when the duplicate check
 * matters most.
 */
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

/**
 * The draft that would produce this row again, legs and all.
 *
 * Legs are passed in rather than fetched, so this stays a pure function of a
 * row; every caller that reposts is already inside a transaction and can read
 * them once for a whole batch. A caller that only wants the duplicate
 * fingerprint passes none, which is right: how a receipt was carved up is not
 * part of whether it is the same money.
 *
 * Passing legs is not optional for anything that reposts. A bulk date change
 * that dropped them would rewrite a split as a flat transaction, and the
 * postings it replaced are append-only.
 */
export function transactionToDraft(
  row: TransactionRow,
  legs: readonly TransactionLegRow[] = [],
): TransactionDraft {
  const live = legs.filter((leg) => !decimal(leg.amount).isZero());
  const common = {
    date: row.date,
    payee: row.payee,
    description: row.description,
    categoryId: row.categoryId,
    templateId: row.templateId,
    notes: row.notes,
    externalId: row.externalId,
    ...(live.length
      ? {
          legs: live.map((leg) => ({
            id: leg.id,
            categoryId: leg.categoryId,
            amount: canonicalDecimal(leg.amount),
            note: leg.note,
          })),
        }
      : {}),
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
