import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
} from "../../src/server/services/accounts.js";
import {
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const actor: Actor = { userId: "integration-double-entry", source: "web" };

/** Nothing the ledger records may leave a currency out of balance. */
async function unbalancedTransactions() {
  const result = await getDb().execute(sql`
    select t.id, p.currency, sum(p.amount)::text as total
    from ledger_transaction t
    join posting p on p.transaction_id = t.id
    where t.user_id = ${actor.userId}
    group by t.id, p.currency
    having sum(p.amount) <> 0
  `);
  return result.rows;
}

/** Every posting the tenant owns, opening balances included, nets to zero. */
async function unbalancedCurrencies() {
  const result = await getDb().execute(sql`
    select p.currency, sum(p.amount)::text as total
    from posting p
    where p.user_id = ${actor.userId}
    group by p.currency
    having sum(p.amount) <> 0
  `);
  return result.rows;
}

async function openingPostings(accountId: string) {
  const result = await getDb().execute(sql`
    select count(*)::int as count, coalesce(sum(amount), 0)::text as total
    from posting
    where account_id = ${accountId}::uuid and transaction_id is null
  `);
  return result.rows[0] as { count: number; total: string };
}

async function postingCount(transactionId: string) {
  const result = await getDb().execute(sql`
    select count(*)::int as count from posting
    where transaction_id = ${transactionId}::uuid
  `);
  return Number((result.rows[0] as { count: number }).count);
}

async function netPostings(transactionId: string) {
  const result = await getDb().execute(sql`
    select account_id, currency, sum(amount)::text as total
    from posting
    where transaction_id = ${transactionId}::uuid
    group by account_id, currency
    having sum(amount) <> 0
    order by account_id
  `);
  return result.rows as { account_id: string; currency: string; total: string }[];
}

integration("double-entry ledger", () => {
  let checkingId: string;
  let savingsId: string;
  let euroId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = connection;
    await runMigrations();
    await getDb().execute(sql`delete from auth_user where id = ${actor.userId}`);
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Double Entry Tenant",
      email: "double-entry@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "DE Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2027-01-01",
        openingBalance: "0",
      })
    ).id;
    savingsId = (
      await createAccount(actor, {
        name: "DE Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2027-01-01",
        openingBalance: "0",
      })
    ).id;
    euroId = (
      await createAccount(actor, {
        name: "DE Euro",
        type: "checking",
        currency: "EUR",
        openingDate: "2027-01-01",
        openingBalance: "0",
      })
    ).id;
  });

  afterAll(async () => {
    if (connection) {
      await getDb().execute(sql`delete from auth_user where id = ${actor.userId}`);
    }
    await closeDb();
  });

  it("balances a deposit against the income account", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-02-01",
        payee: "DE employer",
        description: null,
        toAccountId: checkingId,
        amount: "500",
      },
      "de-deposit",
    );

    const rows = await netPostings(created.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.total).sort()).toEqual([
      "-500.000000000000000000",
      "500.000000000000000000",
    ]);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it("balances a withdrawal against the expense account", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-02-02",
        payee: "DE store",
        description: null,
        fromAccountId: checkingId,
        amount: "42.50",
      },
      "de-withdrawal",
    );

    const rows = await netPostings(created.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.total).sort()).toEqual([
      "-42.500000000000000000",
      "42.500000000000000000",
    ]);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it("settles a conversion through the exchange account so each currency balances", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2027-02-03",
        payee: "DE conversion",
        description: null,
        fromAccountId: checkingId,
        toAccountId: euroId,
        sourceAmount: "110",
        destinationAmount: "100",
      },
      "de-conversion",
    );

    // Two real accounts plus both sides of the exchange account.
    expect(await netPostings(created.id)).toHaveLength(4);
    expect(await unbalancedTransactions()).toEqual([]);

    const byCurrency = await getDb().execute(sql`
      select currency, sum(amount)::text as total
      from posting
      where transaction_id = ${created.id}::uuid
      group by currency
      order by currency
    `);
    expect(byCurrency.rows).toEqual([
      { currency: "EUR", total: "0.000000000000000000" },
      { currency: "USD", total: "0.000000000000000000" },
    ]);
  });

  it("keeps the counter-accounts out of the account list", async () => {
    const accounts = await listAccounts(actor);
    expect(accounts.map((account) => account.name).sort()).toEqual([
      "DE Checking",
      "DE Euro",
      "DE Savings",
    ]);

    // They exist, they are just not places a person keeps money.
    const system = await getDb().execute(sql`
      select system_kind, currency from ledger_account
      where user_id = ${actor.userId} and system_kind is not null
      order by system_kind, currency
    `);
    expect(system.rows.length).toBeGreaterThan(0);
  });

  it("adjusts an amount change instead of rewriting the postings", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-03-01",
        payee: "DE repost",
        description: null,
        fromAccountId: checkingId,
        amount: "10",
      },
      "de-repost",
    );
    expect(await postingCount(created.id)).toBe(2);

    const updated = await updateTransaction(actor, created.id, {
      draft: {
        type: "withdrawal",
        date: "2027-03-01",
        payee: "DE repost",
        description: null,
        fromAccountId: checkingId,
        amount: "25",
      },
      expectedVersion: created.version,
    });

    // The original rows stay untouched. Correcting 10 to 25 costs one adjusting
    // posting per side, not a full reversal and a full repost.
    expect(await postingCount(updated.id)).toBe(4);
    const net = await netPostings(updated.id);
    expect(net.map((row) => row.total).sort()).toEqual([
      "-25.000000000000000000",
      "25.000000000000000000",
    ]);
    expect(await unbalancedTransactions()).toEqual([]);
  });

  it("writes no postings when an edit only touches labels", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-03-02",
        payee: "DE label",
        description: null,
        fromAccountId: checkingId,
        amount: "7",
      },
      "de-label",
    );
    const before = await postingCount(created.id);

    await updateTransaction(actor, created.id, {
      draft: {
        type: "withdrawal",
        date: "2027-03-02",
        payee: "DE label renamed",
        description: "now described",
        notes: "and annotated",
        fromAccountId: checkingId,
        amount: "7",
      },
      expectedVersion: created.version,
    });

    expect(await postingCount(created.id)).toBe(before);
  });

  it("posts an opening balance against the equity account", async () => {
    const opened = await createAccount(actor, {
      name: "DE Opening",
      type: "savings",
      currency: "USD",
      openingDate: "2027-01-01",
      openingBalance: "1250.75",
    });

    const posted = await openingPostings(opened.id);
    expect(posted.count).toBe(1);
    expect(posted.total).toBe("1250.750000000000000000");

    const equity = await getDb().execute(sql`
      select sum(p.amount)::text as total
      from posting p
      join ledger_account a on a.id = p.account_id
      where a.user_id = ${actor.userId}
        and a.system_kind = 'equity'
        and p.currency = 'USD'
    `);
    expect(equity.rows[0]).toEqual({ total: "-1250.750000000000000000" });

    // The opening balance is where the account starts, so it shows up in the
    // balance without a single transaction against it.
    const account = await getAccount(actor, opened.id);
    expect(account.balance).toBe("1250.75");
    expect(await unbalancedCurrencies()).toEqual([]);
  });

  it("re-posts an opening balance correction rather than rewriting it", async () => {
    const opened = await createAccount(actor, {
      name: "DE Correction",
      type: "savings",
      currency: "USD",
      openingDate: "2027-01-01",
      openingBalance: "100",
    });

    await updateAccount(actor, opened.id, {
      openingBalance: "175",
      expectedVersion: opened.version,
    });

    // Two rows, not one rewritten row: the original stands and the delta joins it.
    const posted = await openingPostings(opened.id);
    expect(posted.count).toBe(2);
    expect(posted.total).toBe("175.000000000000000000");

    const account = await getAccount(actor, opened.id);
    expect(account.balance).toBe("175");
    expect(await unbalancedCurrencies()).toEqual([]);
  });

  it("retires the opening pair when an unused account is deleted", async () => {
    const opened = await createAccount(actor, {
      name: "DE Discarded",
      type: "savings",
      currency: "USD",
      openingDate: "2027-01-01",
      openingBalance: "60",
    });

    await deleteAccount(actor, opened.id, opened.version);

    expect((await openingPostings(opened.id)).count).toBe(0);
    expect(await unbalancedCurrencies()).toEqual([]);
  });

  it("reports a real balance from the single-account paths", async () => {
    const opened = await createAccount(actor, {
      name: "DE Single",
      type: "checking",
      currency: "USD",
      openingDate: "2027-01-01",
      openingBalance: "100",
    });
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-04-01",
        payee: "DE single deposit",
        description: null,
        toAccountId: opened.id,
        amount: "50",
      },
      "de-single",
    );

    // Reading or editing one account has no list aggregate to draw on. Handing
    // back the declared opening balance there would understate every account
    // that has ever been used.
    expect((await getAccount(actor, opened.id)).balance).toBe("150");
    const renamed = await updateAccount(actor, opened.id, {
      name: "DE Single Renamed",
      expectedVersion: opened.version,
    });
    expect(renamed.balance).toBe("150");
  });

  it("leaves the whole ledger balanced across every currency", async () => {
    expect(await unbalancedCurrencies()).toEqual([]);
  });

  it("voids the entry in the ledger when a transaction is deleted", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-03-03",
        payee: "DE delete",
        description: null,
        fromAccountId: savingsId,
        amount: "9",
      },
      "de-delete",
    );
    const before = await postingCount(created.id);
    expect(before).toBe(2);

    const deleted = await setTransactionDeleted(
      actor,
      created.id,
      created.version,
      true,
    );

    // Nothing is erased. The movement is reversed, so the entry nets to nothing
    // and no balance or report has to remember to filter it out.
    expect(await postingCount(created.id)).toBe(4);
    expect(await netPostings(created.id)).toEqual([]);
    expect(await unbalancedTransactions()).toEqual([]);

    // Restoring posts it back rather than resurrecting the old rows.
    await setTransactionDeleted(actor, created.id, deleted.version, false);
    expect(await postingCount(created.id)).toBe(6);
    expect((await netPostings(created.id)).map((row) => row.total).sort()).toEqual([
      "-9.000000000000000000",
      "9.000000000000000000",
    ]);
  });
});
