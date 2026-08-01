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
      (
        case when a.opening_date <= ${endDate}::date then a.opening_balance else 0 end
        + coalesce(sum(case
            when t.deleted_at is null and t.date <= ${endDate}::date then p.amount
            else 0
          end), 0)
      )::text as calculated_balance
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
  return accountView(account);
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
        case
          when ${hasStart}
            and a.opening_date < ${start}::date
          then a.opening_balance
          else 0
        end
        + coalesce(sum(case
            when ${hasStart}
              and t.deleted_at is null
              and t.date < ${start}::date
            then p.amount
            else 0
          end), 0)
      )::text as beginning_balance,
      (
        case
          when a.opening_date <= ${end}::date
          then a.opening_balance
          else 0
        end
        + coalesce(sum(case
            when t.deleted_at is null
              and t.date <= ${end}::date
            then p.amount
            else 0
          end), 0)
      )::text as ending_balance,
      (
        case
          when a.opening_date <= (
            current_timestamp at time zone coalesce(preferences.timezone, 'UTC')
          )::date
          then a.opening_balance
          else 0
        end
        + coalesce(sum(case
            when t.deleted_at is null
              and t.date <= (
                current_timestamp at time zone coalesce(preferences.timezone, 'UTC')
              )::date
            then p.amount
            else 0
          end), 0)
      )::text as current_balance,
      (
        a.opening_balance
        + coalesce(sum(case
            when t.deleted_at is null then p.amount
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
    await writeAudit(tx, actor, {
      entityType: "account",
      entityId: created.id,
      operation: "create",
      after: serializeRow(created),
    });
    return accountView(created);
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
    await writeAudit(tx, actor, {
      entityType: "account",
      entityId: id,
      operation: "update",
      before: serializeRow(before),
      after: serializeRow(updated),
    });
    return accountView(updated);
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
    return accountView(updated);
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
