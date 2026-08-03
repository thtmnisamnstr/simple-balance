import { and, eq, sql } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ledgerAccounts, postings, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccount,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { getSummary } from "../../src/server/services/summary.js";
import { createTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_closing_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "account-closing-user", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;

let keySeed = 0;
const nextKey = () => `closing-${(keySeed += 1)}`.padEnd(16, "0");

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
      .where(
        and(eq(ledgerAccounts.userId, actor.userId), eq(ledgerAccounts.name, "Savings")),
      );
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
    expect(after.accounts.map((entry) => entry.name).sort()).toEqual([
      "Checking",
      "Savings",
    ]);
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

  it("writes nothing extra when an empty account is archived", async () => {
    const empty = await openAccount("Empty", "0");
    const before = await getDb()
      .select()
      .from(postings)
      .where(eq(postings.userId, actor.userId));
    await setAccountArchived(actor, empty.id, empty.version, true);
    const after = await getDb()
      .select()
      .from(postings)
      .where(eq(postings.userId, actor.userId));
    expect(after).toHaveLength(before.length);
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
