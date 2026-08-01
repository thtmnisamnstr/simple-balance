import { and, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "../../shared/domain.js";
import {
  accountCreateSchema,
  accountUpdateSchema,
  dateRangeSchema,
  liabilityAccountTypes,
  type AccountType,
  type SystemAccountKind,
  type UserAccountType,
} from "../../shared/domain.js";
import {
  getDb,
  type DbTransaction,
  withTransaction,
} from "../db/client.js";
import {
  ledgerAccounts,
  postings,
  stagedTransactions,
  transactions,
} from "../db/schema.js";
import { conflict, notFound, staleVersion, validationError } from "./errors.js";
import {
  canonicalDecimal,
  decimal,
  lockAccountReferences,
  serializeRow,
  writeAudit,
} from "./helpers.js";

function stagedAccountReference(accountId: string) {
  return sql`(
    ${stagedTransactions.draft} ->> 'fromAccountId' = ${accountId}
    or ${stagedTransactions.draft} ->> 'toAccountId' = ${accountId}
  )`;
}

async function activeStagedAccountReferenceCount(
  tx: DbTransaction,
  actor: Actor,
  accountId: string,
) {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(stagedTransactions)
    .where(
      and(
        eq(stagedTransactions.userId, actor.userId),
        eq(stagedTransactions.status, "staged"),
        stagedAccountReference(accountId),
      ),
    );
  return count;
}

export type AccountView = ReturnType<typeof accountView>;
export type AccountBalances = Awaited<ReturnType<typeof getAccountBalances>>;

const systemAccountNames: Record<SystemAccountKind, string> = {
  income: "Income",
  expense: "Expenses",
  exchange: "Currency Exchange",
  equity: "Opening Balances",
};

/**
 * Find or create the server-owned counter-account that balances the other side
 * of an entry. One exists per kind and currency, so every currency settles to
 * zero on its own. Creation is a conflict-tolerant insert because two
 * concurrent first-ever transactions in the same currency would otherwise race.
 */
export async function ensureSystemAccount(
  tx: DbTransaction,
  actor: Actor,
  kind: SystemAccountKind,
  currency: string,
) {
  const existing = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.userId, actor.userId),
        eq(ledgerAccounts.systemKind, kind),
        eq(ledgerAccounts.currency, currency),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  await tx
    .insert(ledgerAccounts)
    .values({
      userId: actor.userId,
      name: `${systemAccountNames[kind]} (${currency})`,
      type: "system",
      systemKind: kind,
      currency,
      openingDate: "1970-01-01",
      openingBalance: "0",
    })
    .onConflictDoNothing();

  const [created] = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.userId, actor.userId),
        eq(ledgerAccounts.systemKind, kind),
        eq(ledgerAccounts.currency, currency),
      ),
    )
    .limit(1);
  if (!created) {
    throw validationError(`Could not open the ${kind} account for ${currency}`);
  }
  return created;
}

/**
 * Record an account's opening balance in the ledger itself, against the
 * Opening Balances equity account. Without this the starting position would sit
 * outside the books and the ledger would not sum to zero.
 *
 * The postings carry no transaction because an opening balance is where an
 * account began, not something that happened. Re-running it reverses whatever
 * is already posted and writes the new pair, so editing an opening balance
 * stays append-only like every other correction.
 */
export async function postOpeningBalance(
  tx: DbTransaction,
  actor: Actor,
  account: { id: string; currency: string; openingBalance: string },
) {
  const equity = await ensureSystemAccount(tx, actor, "equity", account.currency);
  const existing = await tx
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.userId, actor.userId),
        eq(postings.accountId, account.id),
        isNull(postings.transactionId),
      ),
    );
  const opening = decimal(account.openingBalance);
  const current = existing.reduce(
    (total, row) => total.plus(row.amount),
    decimal("0"),
  );
  if (current.eq(opening)) return;

  const rows: (typeof postings.$inferInsert)[] = [];
  const difference = opening.minus(current);
  if (!difference.isZero()) {
    rows.push({
      userId: actor.userId,
      transactionId: null,
      accountId: account.id,
      amount: canonicalDecimal(difference),
      currency: account.currency,
    });
    rows.push({
      userId: actor.userId,
      transactionId: null,
      accountId: equity.id,
      amount: canonicalDecimal(difference.negated()),
      currency: account.currency,
    });
  }
  if (rows.length) await tx.insert(postings).values(rows);
}

export function presentAccountBalance(type: AccountType, balance: string) {
  // Only user account types carry a liability presentation.
  const signedBalance = canonicalDecimal(balance);
  const value = decimal(signedBalance);
  const isLiability = liabilityAccountTypes.has(type as UserAccountType);
  return {
    balance: signedBalance,
    balancePresentation:
      isLiability && value.isNegative()
        ? { label: "Amount owed", amount: canonicalDecimal(value.abs()) }
        : isLiability
          ? { label: "Credit balance", amount: signedBalance }
          : { label: "Balance", amount: signedBalance },
  };
}

/**
 * The balance an account actually holds, summed from its postings.
 *
 * The list query derives this for every account at once. The single-account
 * paths have no such aggregate to draw on, and returning the declared opening
 * balance in its place would report a figure that stopped being true the moment
 * the first transaction landed.
 */
async function currentBalance(
  tx: Pick<DbTransaction, "execute">,
  actor: Actor,
  accountId: string,
) {
  const result = await tx.execute(sql`
    select coalesce(sum(p.amount), 0)::text as balance
    from posting p
    left join ledger_transaction t
      on t.id = p.transaction_id
      and t.user_id = p.user_id
    where p.user_id = ${actor.userId}
      and p.account_id = ${accountId}::uuid
      and (t.id is null or t.deleted_at is null)
  `);
  return String((result.rows[0] as { balance: string }).balance);
}

function accountView(
  account: typeof ledgerAccounts.$inferSelect,
  balance?: string,
) {
  return {
    ...serializeRow(account),
    ...presentAccountBalance(
      account.type as AccountType,
      balance ?? account.openingBalance,
    ),
  };
}

export async function listAccounts(actor: Actor, end?: string, includeArchived = false) {
  const db = getDb();
  const endDate = end ?? "9999-12-31";
  const result = await db.execute(sql`
    select
      a.*,
      coalesce(sum(case
        when (t.id is null or t.deleted_at is null)
          and coalesce(t.date, a.opening_date) <= ${endDate}::date
        then p.amount
        else 0
      end), 0)::text as calculated_balance
    from ledger_account a
    left join posting p on p.account_id = a.id
    left join ledger_transaction t on t.id = p.transaction_id
    where a.user_id = ${actor.userId}
      and a.system_kind is null
      and (${includeArchived} or a.archived_at is null)
    group by a.id
    order by a.archived_at nulls first, lower(a.name)
  `);

  return result.rows.map((row) => {
    const normalized = {
      ...row,
      userId: row.user_id,
      openingDate: row.opening_date,
      openingBalance: String(row.opening_balance),
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } as unknown as typeof ledgerAccounts.$inferSelect;
    return accountView(normalized, String(row.calculated_balance));
  });
}

export async function getAccount(actor: Actor, id: string) {
  const db = getDb();
  const [account] = await db
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.id, id), eq(ledgerAccounts.userId, actor.userId)))
    .limit(1);
  if (!account) throw notFound("Account not found");
  return accountView(account, await currentBalance(db, actor, account.id));
}

export async function getAccountBalances(
  actor: Actor,
  id: string,
  input: { start?: string; end?: string },
) {
  const range = dateRangeSchema.parse(input);
  if (range.start && range.end && range.start > range.end) {
    throw validationError("Start date must be on or before end date");
  }

  const hasStart = Boolean(range.start);
  const start = range.start ?? "0001-01-01";
  const end = range.end ?? "9999-12-31";
  const result = await getDb().execute(sql`
    select
      a.id,
      a.type,
      a.currency,
      (
        current_timestamp at time zone coalesce(preferences.timezone, 'UTC')
      )::date::text as today,
      (
        coalesce(sum(case
          when ${hasStart}
            and (t.id is null or t.deleted_at is null)
            and coalesce(t.date, a.opening_date) < ${start}::date
          then p.amount
          else 0
        end), 0)
      )::text as beginning_balance,
      (
        coalesce(sum(case
          when (t.id is null or t.deleted_at is null)
            and coalesce(t.date, a.opening_date) <= ${end}::date
          then p.amount
          else 0
        end), 0)
      )::text as ending_balance,
      (
        coalesce(sum(case
          when (t.id is null or t.deleted_at is null)
            and coalesce(t.date, a.opening_date) <= (
              current_timestamp at time zone coalesce(preferences.timezone, 'UTC')
            )::date
          then p.amount
          else 0
        end), 0)
      )::text as current_balance,
      (
        coalesce(sum(case
          when (t.id is null or t.deleted_at is null) then p.amount
          else 0
        end), 0)
      )::text as future_balance
    from ledger_account a
    left join user_preferences preferences
      on preferences.user_id = a.user_id
    left join posting p
      on p.account_id = a.id
      and p.user_id = a.user_id
    left join ledger_transaction t
      on t.id = p.transaction_id
      and t.user_id = a.user_id
    where a.id = ${id}::uuid
      and a.user_id = ${actor.userId}
    group by a.id, preferences.timezone
  `);
  const row = result.rows[0];
  if (!row) throw notFound("Account not found");

  const type = String(row.type) as AccountType;
  return {
    accountId: String(row.id),
    currency: String(row.currency),
    range: {
      start: range.start ?? null,
      end: range.end ?? null,
      today: String(row.today),
    },
    beginning: presentAccountBalance(type, String(row.beginning_balance)),
    ending: presentAccountBalance(type, String(row.ending_balance)),
    current: presentAccountBalance(type, String(row.current_balance)),
    future: presentAccountBalance(type, String(row.future_balance)),
  };
}

export async function createAccount(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = accountCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    const [created] = await tx
      .insert(ledgerAccounts)
      .values({ userId: actor.userId, ...parsed })
      .returning();
    await postOpeningBalance(tx, actor, created);
    const balance = await currentBalance(tx, actor, created.id);
    await writeAudit(tx, actor, {
      entityType: "account",
      entityId: created.id,
      operation: "create",
      after: serializeRow(created),
    });
    return accountView(created, balance);
  });
}

export async function updateAccount(
  actor: Actor,
  id: string,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = accountUpdateSchema.parse(input);
  const { expectedVersion, ...changes } = parsed;
  return withTransaction(transaction, async (tx) => {
    await lockAccountReferences(tx, actor, [id]);
    const [before] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, id), eq(ledgerAccounts.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Account not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });

    if (changes.currency && changes.currency !== before.currency) {
      const [{ count: postingCount }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(postings)
        .where(and(eq(postings.userId, actor.userId), eq(postings.accountId, id)));
      const stageCount = await activeStagedAccountReferenceCount(
        tx,
        actor,
        id,
      );
      if (decimal(before.openingBalance).isZero() === false || postingCount > 0 || stageCount > 0) {
        throw conflict("Currency cannot change after the account is in use");
      }
    }

    const [updated] = await tx
      .update(ledgerAccounts)
      .set({ ...changes, version: expectedVersion + 1, updatedAt: new Date() })
      .where(
        and(
          eq(ledgerAccounts.id, id),
          eq(ledgerAccounts.userId, actor.userId),
          eq(ledgerAccounts.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    // Keeps the ledger in step when the declared opening balance changes.
    await postOpeningBalance(tx, actor, updated);
    const balance = await currentBalance(tx, actor, updated.id);
    await writeAudit(tx, actor, {
      entityType: "account",
      entityId: id,
      operation: "update",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return accountView(updated, balance);
  });
}

export async function setAccountArchived(
  actor: Actor,
  id: string,
  expectedVersion: number,
  archived: boolean,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    await lockAccountReferences(tx, actor, [id]);
    const [before] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, id), eq(ledgerAccounts.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Account not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    if (
      archived &&
      (await activeStagedAccountReferenceCount(tx, actor, id)) > 0
    ) {
      throw conflict(
        "Resolve staged transactions that reference this account before archiving it.",
      );
    }
    const [updated] = await tx
      .update(ledgerAccounts)
      .set({
        archivedAt: archived ? new Date() : null,
        version: expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ledgerAccounts.id, id),
          eq(ledgerAccounts.userId, actor.userId),
          eq(ledgerAccounts.version, expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "account",
      entityId: id,
      operation: archived ? "archive" : "unarchive",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return accountView(updated, await currentBalance(tx, actor, updated.id));
  });
}

export async function deleteAccount(
  actor: Actor,
  id: string,
  expectedVersion: number,
  transaction?: DbTransaction,
) {
  return withTransaction(transaction, async (tx) => {
    await lockAccountReferences(tx, actor, [id]);
    const [before] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.id, id), eq(ledgerAccounts.userId, actor.userId)))
      .limit(1);
    if (!before) throw notFound("Account not found");
    if (before.version !== expectedVersion) throw staleVersion({ currentVersion: before.version });
    if (before.archivedAt) {
      throw conflict("Archived accounts cannot be deleted. Unarchive this account first.");
    }

    const [{ count: transactionCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, actor.userId),
          sql`(${transactions.sourceAccountId} = ${id}::uuid or ${transactions.destinationAccountId} = ${id}::uuid)`,
        ),
      );
    const stageCount = await activeStagedAccountReferenceCount(
      tx,
      actor,
      id,
    );
    if (transactionCount || stageCount) {
      throw conflict("This account is in use. Archive it instead of deleting it.");
    }
    // Deleting is only allowed while an account has no transactions, so the
    // opening pair is the only thing it holds. Reverse it to zero, then drop
    // this side of it: what stays on the equity account still nets out.
    await postOpeningBalance(tx, actor, { ...before, openingBalance: "0" });
    await tx
      .delete(postings)
      .where(
        and(
          eq(postings.userId, actor.userId),
          eq(postings.accountId, id),
          isNull(postings.transactionId),
        ),
      );

    const [deleted] = await tx
      .delete(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.id, id),
          eq(ledgerAccounts.userId, actor.userId),
          eq(ledgerAccounts.version, expectedVersion),
          isNull(ledgerAccounts.archivedAt),
        ),
      )
      .returning({ id: ledgerAccounts.id });
    if (!deleted) throw staleVersion();
    await writeAudit(tx, actor, {
      entityType: "account",
      entityId: id,
      operation: "delete",
      before: serializeRow(before),
    });
    return { id: deleted.id, deleted: true };
  });
}
