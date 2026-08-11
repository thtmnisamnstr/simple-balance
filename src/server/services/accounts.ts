import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Decimal } from "decimal.js";
import type { Actor } from "../../shared/domain.js";
import {
  accountCreateSchema,
  accountUpdateSchema,
  dateRangeSchema,
  isoDateSchema,
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
  recurrences,
  stagedTransactions,
  transactionTemplates,
  transactions,
} from "../db/schema.js";
import { conflict, notFound, staleVersion, validationError, duplicate } from "./errors.js";
import {
  canonicalDecimal,
  decimal,
  lockAccountReferences,
  serializeRow,
  writeAudit,
} from "./helpers.js";
import { getPreferences } from "./preferences.js";

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


const systemAccountNames: Record<SystemAccountKind, string> = {
  income: "Income",
  expense: "Expenses",
  exchange: "Currency Exchange",
  equity: "Opening Balances",
};

/**
 * The counter-accounts a transaction settles against, found once per
 * transaction rather than once per row.
 *
 * There is one of each kind per currency and nothing inside a transaction can
 * remove one, so the second lookup can only return what the first did. On a
 * CSV import that repeated select ran for every row staged.
 */
const systemAccountsByTx = new WeakMap<
  object,
  Map<string, typeof ledgerAccounts.$inferSelect>
>();

export async function ensureSystemAccount(
  tx: DbTransaction,
  actor: Actor,
  kind: SystemAccountKind,
  currency: string,
) {
  const cacheKey = `${actor.userId}|${kind}|${currency}`;
  let cache = systemAccountsByTx.get(tx as object);
  if (!cache) {
    cache = new Map();
    systemAccountsByTx.set(tx as object, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const found = await ensureSystemAccountUncached(tx, actor, kind, currency);
  cache.set(cacheKey, found);
  return found;
}

/**
 * Find or create the server-owned counter-account that balances the other side
 * of an entry. One exists per kind and currency, so every currency settles to
 * zero on its own. Creation is a conflict-tolerant insert because two
 * concurrent first-ever transactions in the same currency would otherwise race.
 */
async function ensureSystemAccountUncached(
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
 * Record where an account started in the ledger itself, against the Opening
 * Balances equity account. Without this the starting position would sit outside
 * the books and the ledger as a whole would not sum to zero.
 *
 * The pair carries no transaction, because an opening balance is where an
 * account began rather than something that happened. Both halves name the
 * account they open, so correcting the opening date moves the equity side along
 * with the account side instead of stranding it on the old day.
 *
 * Like every other correction this appends the difference rather than editing
 * what is already posted, and writes nothing when nothing changed.
 */
export async function postOpeningBalance(
  tx: DbTransaction,
  actor: Actor,
  account: {
    id: string;
    currency: string;
    openingBalance: string;
    openingDate: string;
  },
) {
  const equity = await ensureSystemAccount(tx, actor, "equity", account.currency);
  const existing = await tx
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.userId, actor.userId),
        eq(postings.openingAccountId, account.id),
      ),
    );

  const opening = decimal(account.openingBalance);
  const desired = opening.isZero()
    ? []
    : [
        { accountId: account.id, date: account.openingDate, amount: opening },
        {
          accountId: equity.id,
          date: account.openingDate,
          amount: opening.negated(),
        },
      ];

  const net = new Map<string, { accountId: string; date: string; amount: Decimal }>();
  const add = (accountId: string, date: string, amount: Decimal) => {
    const key = `${accountId}|${date}`;
    const slot = net.get(key);
    if (slot) slot.amount = slot.amount.plus(amount);
    else net.set(key, { accountId, date, amount });
  };
  for (const row of existing) add(row.accountId, row.date, decimal(row.amount).negated());
  for (const row of desired) add(row.accountId, row.date, row.amount);

  const rows = [...net.values()]
    .filter((slot) => !slot.amount.isZero())
    .map((slot) => ({
      userId: actor.userId,
      transactionId: null,
      openingAccountId: account.id,
      closingAccountId: null,
      accountId: slot.accountId,
      date: slot.date,
      amount: canonicalDecimal(slot.amount),
      currency: account.currency,
    }));
  if (rows.length) await tx.insert(postings).values(rows);
}

/**
 * Close an account out to equity so it ends at zero, and put it back when the
 * account is reopened.
 *
 * Archiving used to hide an account that still held money. The dashboard then
 * left it out of the balance while the cash-flow and category figures beside it
 * still counted its activity, so the headline total was short by whatever the
 * account held and nothing on the page said so. Deleting is refused for any
 * account with history, which made archiving the only way to retire one, so the
 * ungated path was also the mandatory one.
 *
 * So archiving now records what an opening balance records, in reverse: the
 * remaining balance is posted out of the account and into the same Opening
 * Balances equity account it came from. The money leaves the books the way it
 * entered them, and the ledger still sums to zero.
 *
 * The entry is dated the later of today and the account's last posting, so an
 * account holding a future-dated transaction still ends at zero rather than
 * coming back to life on that date. A balance as of an earlier day is
 * unaffected, because the money really was there then.
 *
 * Reopening appends the reversal rather than deleting the pair, which is the
 * same rule every other correction in this ledger follows.
 */
export async function postClosingBalance(
  tx: DbTransaction,
  actor: Actor,
  account: { id: string; currency: string },
  archived: boolean,
) {
  const existing = await tx
    .select()
    .from(postings)
    .where(
      and(
        eq(postings.userId, actor.userId),
        eq(postings.closingAccountId, account.id),
      ),
    );

  // The balance to clear is the one the account holds on its own terms, so a
  // closing pair already posted is left out of the sum rather than making the
  // account look like it needs closing twice.
  // Today where this person lives. current_date is the database session's day,
  // which for anyone west of it is tomorrow for part of every evening, and
  // every other "as of today" figure uses the preference timezone.
  const { timezone } = await getPreferences(actor, tx);
  const measured = await tx.execute(sql`
    select
      coalesce(sum(p.amount) filter (where p.closing_account_id is null), 0)::text
        as open_balance,
      greatest(
        (current_timestamp at time zone ${timezone})::date,
        coalesce(max(p.date), (current_timestamp at time zone ${timezone})::date)
      )::text as closing_date
    from posting p
    where p.user_id = ${actor.userId}
      and p.account_id = ${account.id}::uuid
  `);
  const { open_balance: openBalance, closing_date: closingDate } = measured
    .rows[0] as { open_balance: string; closing_date: string };
  const remaining = decimal(openBalance);

  const desired =
    archived && !remaining.isZero()
      ? [
          { accountId: account.id, date: closingDate, amount: remaining.negated() },
          {
            accountId: (
              await ensureSystemAccount(tx, actor, "equity", account.currency)
            ).id,
            date: closingDate,
            amount: remaining,
          },
        ]
      : [];

  const net = new Map<string, { accountId: string; date: string; amount: Decimal }>();
  const add = (accountId: string, date: string, amount: Decimal) => {
    const key = `${accountId}|${date}`;
    const slot = net.get(key);
    if (slot) slot.amount = slot.amount.plus(amount);
    else net.set(key, { accountId, date, amount });
  };
  for (const row of existing) add(row.accountId, row.date, decimal(row.amount).negated());
  for (const row of desired) add(row.accountId, row.date, row.amount);

  const rows = [...net.values()]
    .filter((slot) => !slot.amount.isZero())
    .map((slot) => ({
      userId: actor.userId,
      transactionId: null,
      openingAccountId: null,
      closingAccountId: account.id,
      accountId: slot.accountId,
      date: slot.date,
      amount: canonicalDecimal(slot.amount),
      currency: account.currency,
    }));
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
    where p.user_id = ${actor.userId}
      and p.account_id = ${accountId}::uuid
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
  // Bound as a parameter below, so this is not an injection, but an unparseable
  // value still reaches PostgreSQL and comes back as a failed cast, which the
  // caller sees as an unexplained 500 rather than as the typo it was.
  const asOf = end === undefined ? undefined : isoDateSchema.parse(end);
  const db = getDb();
  const result = await db.execute(sql`
    select
      a.*,
      coalesce(sum(p.amount), 0)::text as calculated_balance
    from ledger_account a
    left join posting p
      on p.user_id = a.user_id
      and p.account_id = a.id
      and p.date <= ${asOf ?? "9999-12-31"}::date
    where a.user_id = ${actor.userId}
      and a.system_kind is null
      and (${includeArchived} or a.archived_at is null)
    group by a.id
    order by a.archived_at nulls first, lower(a.name)
  `);

  // Named column by column rather than spread. The raw query selects a.*, so
  // spreading it would ship the snake_case originals alongside the camelCase
  // names every other account response uses, and a caller could reasonably
  // start depending on either.
  // A raw query hands timestamps back as PostgreSQL writes them, while the
  // Drizzle paths hand back Dates that serialise as ISO 8601. Both describe
  // themselves with the same schema, so a caller reading one and then the other
  // sees the same field in two shapes. These become Dates to match.
  const timestamp = (value: unknown) =>
    value === null || value === undefined ? null : new Date(String(value));

  return result.rows.map((row) => {
    const normalized = {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      type: row.type,
      systemKind: row.system_kind,
      currency: row.currency,
      institution: row.institution,
      notes: row.notes,
      openingDate: row.opening_date,
      openingBalance: String(row.opening_balance),
      archivedAt: timestamp(row.archived_at),
      version: row.version,
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
    } as unknown as typeof ledgerAccounts.$inferSelect;
    return accountView(normalized, String(row.calculated_balance));
  });
}

export async function getAccount(actor: Actor, id: string) {
  const db = getDb();
  const [account] = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, id),
        eq(ledgerAccounts.userId, actor.userId),
        // The income, expense, exchange and equity accounts are the ledger's
        // own bookkeeping. Every other path hides them, so fetching one by id
        // should not be the exception that puts them on show.
        isNull(ledgerAccounts.systemKind),
      ),
    )
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
      coalesce(sum(p.amount) filter (
        where ${hasStart} and p.date < ${start}::date
      ), 0)::text as beginning_balance,
      coalesce(sum(p.amount) filter (
        where p.date <= ${end}::date
      ), 0)::text as ending_balance,
      coalesce(sum(p.amount) filter (
        where p.date <= (
          current_timestamp at time zone coalesce(preferences.timezone, 'UTC')
        )::date
      ), 0)::text as current_balance,
      coalesce(sum(p.amount), 0)::text as future_balance
    from ledger_account a
    left join user_preferences preferences
      on preferences.user_id = a.user_id
    left join posting p
      on p.account_id = a.id
      and p.user_id = a.user_id
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

/**
 * Account names are unique among the accounts a person keeps. Checking first
 * turns a clash into a message naming the account it collides with, rather than
 * letting the unique index raise a bare constraint violation that the error
 * handler can only report as an unexpected failure.
 */
async function assertAccountNameAvailable(
  tx: DbTransaction,
  actor: Actor,
  name: string,
  excludeId?: string,
) {
  const [existing] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.userId, actor.userId),
        eq(ledgerAccounts.name, name),
        isNull(ledgerAccounts.systemKind),
        excludeId ? ne(ledgerAccounts.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  if (existing) {
    throw duplicate("An account with this name already exists", {
      duplicateAccountId: existing.id,
    });
  }
}

export async function createAccount(
  actor: Actor,
  input: unknown,
  transaction?: DbTransaction,
) {
  const parsed = accountCreateSchema.parse(input);
  return withTransaction(transaction, async (tx) => {
    await assertAccountNameAvailable(tx, actor, parsed.name);
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

    if (changes.name && changes.name !== before.name) {
      await assertAccountNameAvailable(tx, actor, changes.name, id);
    }

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
    // Re-posting the opening balance of an archived account would otherwise put
    // money back into one that is supposed to hold nothing, where no total
    // counts it.
    await postClosingBalance(tx, actor, updated, updated.archivedAt !== null);
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
    // After the flag is set, so the closing pair and the state it reflects are
    // written in the same transaction or neither is.
    await postClosingBalance(tx, actor, updated, archived);
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
    // Ledger history outlives the transaction that made it. Moving a
    // transaction to another account leaves the adjusting postings behind here,
    // so the account is still part of the books even though nothing points at
    // it any more. Counting postings catches that; counting transactions alone
    // would let the delete through and fail on the foreign key instead.
    const [{ count: postingCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(postings)
      .where(
        and(
          eq(postings.userId, actor.userId),
          eq(postings.accountId, id),
          isNotNull(postings.transactionId),
        ),
      );
    // A recurrence's shape and a template's draft both name accounts in jsonb
    // with no foreign key, so neither count above sees them. A recurrence that
    // outlives its account proposes a flagged row on every occurrence from here
    // on, for as long as nobody notices; a template becomes unusable.
    const jsonNamesAccount = (column: PgColumn) =>
      or(
        sql`${column} ->> 'fromAccountId' = ${id}`,
        sql`${column} ->> 'toAccountId' = ${id}`,
      )!;
    const [{ count: recurrenceCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(recurrences)
      .where(
        and(
          eq(recurrences.userId, actor.userId),
          jsonNamesAccount(recurrences.shape),
        ),
      );
    const [{ count: templateCount }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionTemplates)
      .where(
        and(
          eq(transactionTemplates.userId, actor.userId),
          jsonNamesAccount(transactionTemplates.draft),
        ),
      );
    if (
      transactionCount ||
      stageCount ||
      postingCount ||
      recurrenceCount ||
      templateCount
    ) {
      throw conflict("This account is in use. Archive it instead of deleting it.", {
        transactionCount,
        stagedTransactionCount: stageCount,
        postingCount,
        recurrenceCount,
        templateCount,
      });
    }
    // Deleting is only allowed while an account has no transactions, so the
    // opening pair and any closing pair are all it holds. An account that was
    // archived and restored still has the closing rows, netting to zero;
    // leaving them behind made the delete fail on a foreign key with a raw
    // database error rather than an answer. Both halves of each pair name this
    // account, so they come out together and no equity side is stranded.
    await tx
      .delete(postings)
      .where(
        and(
          eq(postings.userId, actor.userId),
          sql`(${postings.openingAccountId} = ${id}::uuid
            or ${postings.closingAccountId} = ${id}::uuid)`,
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
