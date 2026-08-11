import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../../shared/domain.js";
import { getDb } from "../db/client.js";
import {
  categories,
  importBatches,
  ledgerAccounts,
  oauthConsent,
  recurrences,
  stagedTransactions,
  transactions,
  user,
  verification,
} from "../db/schema.js";
import { notFound, validationError } from "./errors.js";

/**
 * Deleting an account, and everything that was in it.
 *
 * Every table that holds somebody's data references auth_user with
 * `on delete cascade`, so removing the person's row removes their ledger with
 * it: accounts, transactions, the postings underneath them, categories, staged
 * rows, import batches, preferences, idempotency records, audit history,
 * sessions, sign-in methods, and any OAuth grant an agent was holding. That is
 * deliberately the whole mechanism. A hand-written list of tables to empty is a
 * list somebody will forget to add to, and the thing it would forget is
 * somebody's data left behind after they asked for it to be gone.
 *
 * What the cascade cannot reach is auth_verification, which has no user column:
 * a pending password reset stores the user id in `value`. Those go explicitly.
 *
 * There is no audit event for this. It would be written to the same table the
 * cascade is about to empty, and a record of the deletion that survives it
 * would be the one piece of the person left behind.
 */

export const accountDeletionSchema = z
  .object({
    // Typing the address is the "you meant this" gate. It is the only thing on
    // the screen that cannot be produced by clicking, which is the point: an
    // errant click, a stale tab, or a mis-aimed request cannot supply it.
    confirmEmail: z.string().trim().min(1).max(320),
  })
  .strict();

export type OwnDataSummary = {
  accounts: number;
  transactions: number;
  categories: number;
  stagedTransactions: number;
  recurrences: number;
  importBatches: number;
  payees: number;
  connectedAgents: number;
};

const countOf = async (query: Promise<{ count: number }[]>) =>
  (await query)[0]?.count ?? 0;

/**
 * What is about to be destroyed, in the terms the person put it there.
 *
 * Shown before the confirmation rather than after, because "this will delete
 * 412 transactions across 6 accounts" is the sentence that makes somebody
 * check they are on the right account.
 */
export async function summarizeOwnData(actor: Actor): Promise<OwnDataSummary> {
  const db = getDb();
  const [accounts, transactionCount, categoryCount, staged, recurring, batches] =
    await Promise.all([
      countOf(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.userId, actor.userId),
              // The counter-accounts belong to the ledger rather than to the
              // person, and they never appeared in a list, so counting them
              // here would name something they have never seen.
              sql`${ledgerAccounts.systemKind} is null`,
            ),
          ),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(eq(transactions.userId, actor.userId)),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(categories)
          .where(eq(categories.userId, actor.userId)),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(stagedTransactions)
          .where(eq(stagedTransactions.userId, actor.userId)),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(recurrences)
          .where(eq(recurrences.userId, actor.userId)),
      ),
      countOf(
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(importBatches)
          .where(eq(importBatches.userId, actor.userId)),
      ),
    ]);

  // Payees are canonical text on transactions rather than rows of their own, so
  // they are counted the way the payee list derives them.
  const payees = await countOf(
    getDb()
      .select({ count: sql<number>`count(distinct lower(btrim(payee)))::int` })
      .from(transactions)
      .where(eq(transactions.userId, actor.userId)),
  );
  const connectedAgents = await countOf(
    getDb()
      .select({ count: sql<number>`count(distinct client_id)::int` })
      .from(oauthConsent)
      .where(
        and(
          eq(oauthConsent.userId, actor.userId),
          eq(oauthConsent.consentGiven, true),
        ),
      ),
  );

  return {
    accounts,
    transactions: transactionCount,
    categories: categoryCount,
    stagedTransactions: staged,
    recurrences: recurring,
    importBatches: batches,
    payees,
    connectedAgents,
  };
}

export type AccountDeletionResult = {
  deleted: true;
  removed: OwnDataSummary;
};

export async function deleteOwnAccount(
  actor: Actor,
  input: unknown,
): Promise<AccountDeletionResult> {
  const { confirmEmail } = accountDeletionSchema.parse(input);
  const db = getDb();
  const [owner] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.id, actor.userId))
    .limit(1);
  if (!owner) throw notFound("Account not found");
  if (confirmEmail.toLowerCase() !== owner.email.trim().toLowerCase()) {
    throw validationError(
      "Type the email address on this account to confirm deleting it.",
    );
  }

  const removed = await summarizeOwnData(actor);

  await db.transaction(async (tx) => {
    // No user column on this one, so the cascade cannot see it. A pending
    // password reset holds the user id in `value`.
    await tx
      .delete(verification)
      .where(
        and(eq(verification.value, actor.userId), isNotNull(verification.value)),
      );
    // Everything else goes with this row.
    await tx.delete(user).where(eq(user.id, actor.userId));
  });

  // Their audit history went with them, so this is the only place left that can
  // say it happened. Deliberately without the address: they asked to be gone.
  const count = (value: number, one: string, many = `${one}s`) =>
    `${value} ${value === 1 ? one : many}`;
  console.info(
    `An account was deleted, with ${count(removed.transactions, "transaction")} ` +
      `across ${count(removed.accounts, "account")}.`,
  );

  return { deleted: true, removed };
}
