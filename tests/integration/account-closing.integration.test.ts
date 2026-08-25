import { and, eq, sql } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ledgerAccounts, postings, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  reconcileArchivedAccountClosings,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { getSummary } from "../../src/server/services/summary.js";
import {
  createTransaction,
  getTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_closing_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "account-closing-user", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;

let keySeed = 0;
// Padded on the counter rather than the whole string, because padding the
// string to a fixed width made different counters collide: "…-1" and "…-10"
// both filled out to the same key, and two calls with the same payload then
// returned the first transaction instead of making a second one — a test that
// passes having written nothing.
const nextKey = () => `closing-${String((keySeed += 1)).padStart(8, "0")}`;

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function openAccount(name: string, opening: string) {
  return createAccount(actor, {
    name,
    type: "checking",
    currency: "USD",
    openingDate: "2026-01-01",
    openingBalance: opening,
  });
}

/** Every posting in the ledger must still sum to zero, per currency. */
async function ledgerSumsToZero() {
  const result = await getDb().execute(sql`
    select p.currency, sum(p.amount)::text as total
    from posting p
    where p.user_id = ${actor.userId}
    group by p.currency
  `);
  return result.rows.map((row) => `${row.currency}=${Number(row.total)}`);
}

const usd = (summary: Awaited<ReturnType<typeof getSummary>>) =>
  summary.currencies.find((entry) => entry.currency === "USD");

integration("archiving an account closes its balance out to equity", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Closing",
      email: "account-closing@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("zeroes the account and keeps the books balanced", async () => {
    const savings = await openAccount("Savings", "2000");
    expect(savings.balance).toBe("2000");

    await setAccountArchived(actor, savings.id, savings.version, true);

    const after = await getAccount(actor, savings.id);
    expect(after.balance).toBe("0");
    expect(await ledgerSumsToZero()).toEqual(["USD=0"]);
  });

  // The money really was there before it was closed out, so history is intact.
  it("leaves a balance as of an earlier day alone", async () => {
    const asOfOpening = await getDb().execute(sql`
      select coalesce(sum(p.amount), 0)::text as balance
      from posting p
      join ledger_account a on a.id = p.account_id and a.user_id = p.user_id
      where p.user_id = ${actor.userId}
        and a.name = 'Savings'
        and p.date <= '2026-06-01'::date
    `);
    expect(Number((asOfOpening.rows[0] as { balance: string }).balance)).toBe(2000);
  });

  it("gives the money back when the account is reopened", async () => {
    const [row] = await getDb()
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, actor.userId), eq(ledgerAccounts.name, "Savings")));
    await setAccountArchived(actor, row.id, row.version, false);

    const reopened = await getAccount(actor, row.id);
    expect(reopened.balance).toBe("2000");
    expect(reopened.archivedAt).toBeNull();
    expect(await ledgerSumsToZero()).toEqual(["USD=0"]);
  });

  // The case that made this a wrong headline number: archive an account holding
  // money and the dashboard total must not silently drop it while the cash flow
  // beside it still counts the account's activity.
  it("keeps the dashboard total and its cash flow talking about the same accounts", async () => {
    await openAccount("Checking", "5000");
    const petty = await openAccount("Petty Cash", "0");
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: today(),
        payee: "Stationery",
        description: null,
        amount: "40.00",
        fromAccountId: petty.id,
      },
      nextKey(),
    );

    const before = usd(await getSummary(actor, {}))!;
    expect(Number(before.withdrawals)).toBe(40);

    const pettyNow = await getAccount(actor, petty.id);
    await setAccountArchived(actor, petty.id, pettyNow.version, true);

    const after = usd(await getSummary(actor, {}))!;
    // Petty Cash is gone from the accounts, and so is the spending that ran
    // through it. Previously the balance dropped and the withdrawal stayed.
    expect(after.accounts.map((entry) => entry.name).sort()).toEqual(["Checking", "Savings"]);
    expect(Number(after.withdrawals)).toBe(0);
    expect(after.spendingByCategory).toEqual([]);
    expect(await ledgerSumsToZero()).toEqual(["USD=0"]);
  });

  it("shows the archived account again when asked to include it", async () => {
    const full = await getSummary(actor, {}, true);
    expect(full.includesArchived).toBe(true);
    const summary = usd(full)!;
    expect(summary.accounts.map((entry) => entry.name)).toContain("Petty Cash");
    const petty = summary.accounts.find((entry) => entry.name === "Petty Cash")!;
    expect(petty.archivedAt).not.toBeNull();
    expect(Number(summary.withdrawals)).toBe(40);
  });

  // An account holding something dated later must still end at zero, or it
  // would come back to life on that date while archived.
  it("closes out an account that holds a future-dated transaction", async () => {
    const future = await openAccount("Future Fund", "100");
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: daysFromNow(45),
        payee: "Later",
        description: null,
        amount: "500.00",
        toAccountId: future.id,
      },
      nextKey(),
    );
    const loaded = await getAccount(actor, future.id);
    await setAccountArchived(actor, future.id, loaded.version, true);

    const everAfter = await getDb().execute(sql`
      select coalesce(sum(p.amount), 0)::text as balance
      from posting p
      where p.user_id = ${actor.userId} and p.account_id = ${future.id}::uuid
    `);
    expect(Number((everAfter.rows[0] as { balance: string }).balance)).toBe(0);
    expect(await ledgerSumsToZero()).toEqual(["USD=0"]);
  });

  // Archiving closes an account to zero, but a transaction that ran through it
  // can still be edited or deleted afterwards. Reposting into a closed account
  // stranded money there, and because no total counts an archived account the
  // headline went short by exactly that amount - the same hole, through a
  // different door.
  it("keeps a closed account at zero when its history is edited afterwards", async () => {
    const closed = await openAccount("Closed Later", "0");
    const spend = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: today(),
        payee: "Last Purchase",
        description: null,
        amount: "75.00",
        fromAccountId: closed.id,
      },
      nextKey(),
    );
    const loaded = await getAccount(actor, closed.id);
    await setAccountArchived(actor, closed.id, loaded.version, true);
    expect((await getAccount(actor, closed.id)).balance).toBe("0");

    // Delete the transaction that ran through it, after it was closed.
    await setTransactionDeleted(actor, spend.id, spend.version, true);
    expect((await getAccount(actor, closed.id)).balance).toBe("0");
    expect(await ledgerSumsToZero()).toEqual(["USD=0"]);

    // And restoring it.
    const deleted = await getTransaction(actor, spend.id);
    await setTransactionDeleted(actor, spend.id, deleted.version, false);
    expect((await getAccount(actor, closed.id)).balance).toBe("0");
    expect(await ledgerSumsToZero()).toEqual(["USD=0"]);
  });

  it("writes nothing extra when an empty account is archived", async () => {
    const empty = await openAccount("Empty", "0");
    const before = await getDb().select().from(postings).where(eq(postings.userId, actor.userId));
    await setAccountArchived(actor, empty.id, empty.version, true);
    const after = await getDb().select().from(postings).where(eq(postings.userId, actor.userId));
    expect(after).toHaveLength(before.length);
  });
});

integration("where uncategorised spending sits in the summary", () => {
  const catActor: Actor = { userId: "spend-order-user", source: "web" };
  const catDatabase = `simple_balance_spendorder_${process.pid}_${Date.now()}`;
  let catAdmin: PgClient;

  beforeAll(async () => {
    catAdmin = new PgClient({ connectionString: connection });
    await catAdmin.connect();
    await catAdmin.query(`create database "${catDatabase}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${catDatabase}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: catActor.userId,
      name: "Spend Order",
      email: "spend-order@example.com",
      emailVerified: true,
    });
    const account = await createAccount(catActor, {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "10000",
    });
    // Deliberately the largest: uncategorised outspends every named category,
    // which is exactly when ranking it by amount put it at the top.
    const spend = async (amount: string, payee: string, category?: string) =>
      createTransaction(
        catActor,
        {
          type: "withdrawal",
          date: today(),
          payee,
          description: null,
          amount,
          fromAccountId: account.id,
          ...(category ? { categoryName: category } : {}),
        },
        `spend-${payee}`.padEnd(16, "0").slice(0, 16),
      );
    await spend("900.00", "Landlord", "Rent");
    await spend("300.00", "Market", "Food");
    await spend("5000.00", "Mystery");
  });

  afterAll(async () => {
    await closeDb();
    await catAdmin.query(`drop database if exists "${catDatabase}"`);
    await catAdmin.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("puts it last even when it is the largest, so the order is the same everywhere", async () => {
    const summary = await getSummary(catActor, {});
    const spending = summary.currencies.find(
      (entry) => entry.currency === "USD",
    )!.spendingByCategory;

    expect(spending.map((entry) => entry.category)).toEqual(["Rent", "Food", "Uncategorized"]);
    // The named ones are still ordered by amount among themselves.
    expect(Number(spending[0].amount)).toBeGreaterThan(Number(spending[1].amount));
    // And it is genuinely the biggest, which is the case that used to top the list.
    expect(Number(spending[2].amount)).toBeGreaterThan(Number(spending[0].amount));
    expect(spending[2].categoryId).toBeNull();
  });
});

integration("a summary stops at today", () => {
  const futureActor: Actor = { userId: "summary-future-user", source: "web" };
  const futureDatabase = `simple_balance_future_${process.pid}_${Date.now()}`;
  let futureAdmin: PgClient;
  let accountId: string;

  beforeAll(async () => {
    futureAdmin = new PgClient({ connectionString: connection });
    await futureAdmin.connect();
    await futureAdmin.query(`create database "${futureDatabase}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${futureDatabase}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: futureActor.userId,
      name: "Future",
      email: "summary-future@example.com",
      emailVerified: true,
    });
    const account = await createAccount(futureActor, {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "165",
    });
    accountId = account.id;
    await createTransaction(
      futureActor,
      {
        type: "deposit",
        date: daysFromNow(30),
        payee: "Next Month",
        description: null,
        amount: "1000.00",
        toAccountId: accountId,
      },
      "future-summary-000",
    );
  });

  afterAll(async () => {
    await closeDb();
    await futureAdmin.query(`drop database if exists "${futureDatabase}"`);
    await futureAdmin.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  // "All time" used to mean 9999-12-31, so next month's deposit counted toward
  // a figure the page labelled as of today.
  it("leaves a future-dated deposit out of an open-ended range", async () => {
    const summary = await getSummary(futureActor, {});
    const currency = summary.currencies.find((entry) => entry.currency === "USD")!;
    expect(Number(currency.balance)).toBe(165);
    expect(Number(currency.deposits)).toBe(0);
    expect(summary.asOf).toBe(today());
  });

  it("treats an end date past today as today, and says so", async () => {
    const summary = await getSummary(futureActor, { end: "9999-12-31" });
    const currency = summary.currencies.find((entry) => entry.currency === "USD")!;
    expect(Number(currency.balance)).toBe(165);
    expect(summary.asOf).toBe(today());
    expect(summary.range.end).toBe("9999-12-31");
  });

  it("still honours an end date in the past", async () => {
    const summary = await getSummary(futureActor, { end: "2026-01-01" });
    const currency = summary.currencies.find((entry) => entry.currency === "USD")!;
    expect(Number(currency.balance)).toBe(165);
    expect(summary.asOf).toBe("2026-01-01");
  });
});

integration("an account that was archived can still be tidied away", () => {
  const tidyActor: Actor = { userId: "tidy-user", source: "web" };
  const tidyDatabase = `simple_balance_tidy_${process.pid}_${Date.now()}`;
  let tidyAdmin: PgClient;

  beforeAll(async () => {
    tidyAdmin = new PgClient({ connectionString: connection });
    await tidyAdmin.connect();
    await tidyAdmin.query(`create database "${tidyDatabase}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${tidyDatabase}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: tidyActor.userId,
      name: "Tidy",
      email: "tidy@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await closeDb();
    await tidyAdmin.query(`drop database if exists "${tidyDatabase}"`);
    await tidyAdmin.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  // Archiving leaves closing postings behind. They net to zero once the account
  // is restored, but the rows remain, and deleting only ever removed the
  // opening pair - so the account could never be deleted again and the caller
  // got a foreign-key error rather than an answer.
  it("deletes one that was archived and restored, with no transactions", async () => {
    const spare = await createAccount(tidyActor, {
      name: "Opened By Mistake",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "50",
    });
    await setAccountArchived(tidyActor, spare.id, spare.version, true);
    const archived = await getAccount(tidyActor, spare.id);
    await setAccountArchived(tidyActor, spare.id, archived.version, false);
    const restored = await getAccount(tidyActor, spare.id);

    await deleteAccount(tidyActor, spare.id, restored.version);

    const left = await getDb().select().from(postings).where(eq(postings.userId, tidyActor.userId));
    expect(left).toHaveLength(0);
  });
});

/**
 * The account has to read zero as of *every* date from the archive onward, not
 * merely ever-after. A single closing pair dated the last posting leaves the
 * money in an account the dashboard has already stopped counting, so the
 * headline total silently drops by whatever was in there.
 */
integration("archiving an account holding future-dated money", () => {
  const futureActor: Actor = { userId: "closing-future-user", source: "web" };
  const futureDatabase = `simple_balance_future_${process.pid}_${Date.now()}`;
  let futureAdmin: PgClient;

  const balanceAsOf = async (accountId: string, asOf: string) => {
    const result = await getDb().execute(sql`
      select coalesce(sum(p.amount), 0)::text as total
      from posting p
      where p.user_id = ${futureActor.userId}
        and p.account_id = ${accountId}::uuid
        and p.date <= ${asOf}::date
    `);
    return Number((result.rows[0] as { total: string }).total);
  };

  beforeAll(async () => {
    futureAdmin = new PgClient({ connectionString: connection });
    await futureAdmin.connect();
    await futureAdmin.query(`create database "${futureDatabase}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${futureDatabase}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: futureActor.userId,
      name: "Future",
      email: "closing-future@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await closeDb();
    await futureAdmin.query(`drop database if exists "${futureDatabase}"`);
    await futureAdmin.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("reads zero on every day from the archive to past the last posting", async () => {
    const account = await createAccount(futureActor, {
      name: "Holds Something Later",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "100",
    });
    await createTransaction(
      futureActor,
      {
        type: "deposit",
        date: daysFromNow(45),
        payee: "Later",
        description: null,
        toAccountId: account.id,
        amount: "500",
      },
      "closing-future-deposit",
    );

    const before = await getSummary(futureActor, {});
    const beforeTotal = Number(
      before.currencies.find((entry) => entry.currency === "USD")?.balance ?? "0",
    );

    const loaded = await getAccount(futureActor, account.id);
    await setAccountArchived(futureActor, account.id, loaded.version, true);

    // The day the money leaves, the days in between, and past the deposit.
    for (const asOf of [
      today(),
      daysFromNow(1),
      daysFromNow(44),
      daysFromNow(45),
      daysFromNow(60),
    ]) {
      expect(await balanceAsOf(account.id, asOf), asOf).toBe(0);
    }

    const after = await getSummary(futureActor, {});
    const afterTotal = Number(
      after.currencies.find((entry) => entry.currency === "USD")?.balance ?? "0",
    );
    expect(afterTotal).toBe(beforeTotal - 100);

    const totals = await getDb().execute(sql`
      select p.currency, sum(p.amount)::text as total
      from posting p where p.user_id = ${futureActor.userId} group by p.currency
    `);
    expect(totals.rows.map((row) => Number((row as { total: string }).total))).toEqual([0]);
  });

  it("puts every date back when the account is reopened", async () => {
    const account = await createAccount(futureActor, {
      name: "Reopened Later",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "70",
    });
    await createTransaction(
      futureActor,
      {
        type: "deposit",
        date: daysFromNow(30),
        payee: "Later",
        description: null,
        toAccountId: account.id,
        amount: "30",
      },
      "closing-future-reopen",
    );
    const opened = await getAccount(futureActor, account.id);
    await setAccountArchived(futureActor, account.id, opened.version, true);
    const archived = await getAccount(futureActor, account.id);
    await setAccountArchived(futureActor, account.id, archived.version, false);

    expect(await balanceAsOf(account.id, today())).toBe(70);
    expect(await balanceAsOf(account.id, daysFromNow(30))).toBe(100);
  });

  /**
   * The list of archived accounts is read outside the per-account transaction,
   * so a row can be restored between the read and the repair. Re-closing it
   * then would take a live account's balance away with nothing to undo it.
   *
   * The restore has to land inside that window for this to test anything, so it
   * is held under the account's own advisory lock until the repair is already
   * running and blocked on it. Restoring before the run instead leaves the row
   * out of the list entirely and the branch under test unreached.
   */
  it("skips an account restored while the repair was already running", async () => {
    const account = await createAccount(futureActor, {
      name: "Restored Mid Repair",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "300",
    });
    await createTransaction(
      futureActor,
      {
        type: "deposit",
        date: daysFromNow(25),
        payee: "Later",
        description: null,
        toAccountId: account.id,
        amount: "60",
      },
      "closing-restore-race",
    );
    const opened = await getAccount(futureActor, account.id);
    await setAccountArchived(futureActor, account.id, opened.version, true);
    // Leave it needing repair, so a run that does not skip would write.
    await getDb().execute(sql`
      delete from posting
      where user_id = ${futureActor.userId}
        and closing_account_id = ${account.id}::uuid
    `);

    const blocker = new PgClient({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `account-reference:${futureActor.userId}:${account.id}`,
    ]);
    await blocker.query("update ledger_account set archived_at = null where id = $1", [account.id]);

    // Reads the list, which still shows the row archived because the restore is
    // uncommitted, then blocks taking the lock this transaction holds.
    const repair = reconcileArchivedAccountClosings();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await blocker.query("commit");
    await blocker.end();
    await repair;

    expect(await balanceAsOf(account.id, today())).toBe(300);
    expect(await balanceAsOf(account.id, daysFromNow(25))).toBe(360);
    const closings = await getDb().execute(sql`
      select count(*)::int as rows from posting
      where user_id = ${futureActor.userId}
        and closing_account_id = ${account.id}::uuid
    `);
    expect((closings.rows[0] as { rows: number }).rows).toBe(0);
  });

  // An account archived under the single-entry rule keeps its one mis-dated
  // pair until something reposts into it, and nothing on the archived-account
  // screen does. The startup reconcile is what repairs an upgraded database.
  it("repairs an account archived the old way", async () => {
    const account = await createAccount(futureActor, {
      name: "Archived Before The Fix",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "200",
    });
    await createTransaction(
      futureActor,
      {
        type: "deposit",
        date: daysFromNow(20),
        payee: "Later",
        description: null,
        toAccountId: account.id,
        amount: "40",
      },
      "closing-legacy-deposit",
    );
    const opened = await getAccount(futureActor, account.id);
    await setAccountArchived(futureActor, account.id, opened.version, true);

    // Rewrite the close the way the old rule wrote it: one pair, dated the last
    // posting, for the whole ever-after balance.
    await getDb().execute(sql`
      delete from posting
      where user_id = ${futureActor.userId}
        and closing_account_id = ${account.id}::uuid
    `);
    const equity = await getDb().execute(sql`
      select id from ledger_account
      where user_id = ${futureActor.userId} and system_kind = 'equity'
      limit 1
    `);
    const equityId = (equity.rows[0] as { id: string }).id;
    const lastDate = daysFromNow(20);
    await getDb().execute(sql`
      insert into posting (user_id, account_id, closing_account_id, date, amount, currency)
      values
        (${futureActor.userId}, ${account.id}::uuid, ${account.id}::uuid, ${lastDate}::date, -240, 'USD'),
        (${futureActor.userId}, ${equityId}::uuid, ${account.id}::uuid, ${lastDate}::date, 240, 'USD')
    `);
    expect(await balanceAsOf(account.id, today())).toBe(200);

    expect(await reconcileArchivedAccountClosings()).toBeGreaterThan(0);

    for (const asOf of [today(), daysFromNow(19), daysFromNow(20), daysFromNow(40)]) {
      expect(await balanceAsOf(account.id, asOf), asOf).toBe(0);
    }
    // Running it again writes nothing, so it is safe on every startup.
    const totalsBefore = await getDb().execute(sql`
      select count(*)::int as rows from posting where user_id = ${futureActor.userId}
    `);
    await reconcileArchivedAccountClosings();
    const totalsAfter = await getDb().execute(sql`
      select count(*)::int as rows from posting where user_id = ${futureActor.userId}
    `);
    expect((totalsAfter.rows[0] as { rows: number }).rows).toBe(
      (totalsBefore.rows[0] as { rows: number }).rows,
    );
  });
});
