import { sql } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  session as authSession,
  account as authAccount,
  user,
  verification,
} from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { deleteOwnAccount, summarizeOwnData } from "../../src/server/services/account-deletion.js";
import { createCategory } from "../../src/server/services/categories.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { createStage } from "../../src/server/services/staging.js";
import { createTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_deletion_${process.pid}_${Date.now()}`;
const leaver: Actor = { userId: "deletion-leaver", source: "web" };
const stayer: Actor = { userId: "deletion-stayer", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;

let keySeed = 0;
// Padded on the counter rather than the whole string, because padding the
// string to a fixed width made different counters collide: "…-1" and "…-10"
// both filled out to the same key, and two calls with the same payload then
// returned the first transaction instead of making a second one — a test that
// passes having written nothing.
const nextKey = () => `deletion-${String((keySeed += 1)).padStart(7, "0")}`;

/**
 * Every table that carries a user_id, read out of the live database rather than
 * from a list kept by hand.
 *
 * This is the point of the test. Deleting an account works by cascade, so
 * nothing in the service names a table; a table added later is covered
 * automatically, and if one is ever added WITHOUT the cascade this fails and
 * says which. A hand-maintained list would silently keep passing.
 */
async function tablesWithUserColumn() {
  const result = await getDb().execute(sql`
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_name = c.table_name and t.table_schema = c.table_schema
    where c.table_schema = 'public'
      and c.column_name = 'user_id'
      and t.table_type = 'BASE TABLE'
    order by c.table_name
  `);
  return result.rows.map((row) => String(row.table_name));
}

async function rowsFor(table: string, userId: string) {
  const result = await getDb().execute(
    sql`select count(*)::int as count from ${sql.identifier(table)} where user_id = ${userId}`,
  );
  return Number((result.rows[0] as { count: number }).count);
}

async function seed(actor: Actor, label: string) {
  await getDb()
    .insert(user)
    .values({
      id: actor.userId,
      name: label,
      email: `${actor.userId}@example.com`,
      emailVerified: true,
    });
  await setPreferences(actor, {
    timezone: "America/Los_Angeles",
    defaultCurrency: "USD",
  });
  const checking = await createAccount(actor, {
    name: `${label} Checking`,
    type: "checking",
    currency: "USD",
    openingDate: "2026-01-01",
    openingBalance: "1000",
  });
  const groceries = await createCategory(actor, {
    name: `${label} Groceries`,
    kind: "expense",
  });
  await createTransaction(
    actor,
    {
      type: "withdrawal",
      date: "2026-02-01",
      payee: `${label} Corner Shop`,
      description: null,
      amount: "25.00",
      fromAccountId: checking.id,
      categoryId: groceries.id,
    },
    nextKey(),
  );
  await createStage(actor, {
    idempotencyKey: nextKey(),
    draft: {
      type: "withdrawal",
      date: "2026-02-02",
      payee: `${label} Queued`,
      amount: "5.00",
      fromAccountId: checking.id,
    },
  });
  // Sessions, sign-in methods, and an agent's grant, which the ledger services
  // do not create but a real account has.
  await getDb()
    .insert(authAccount)
    .values({
      id: `acct-${actor.userId}`,
      accountId: actor.userId,
      providerId: "credential",
      userId: actor.userId,
      password: "hashed",
    });
  await getDb()
    .insert(authSession)
    .values({
      id: `sess-${actor.userId}`,
      token: `token-${actor.userId}`,
      userId: actor.userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  await getDb()
    .insert(oauthApplication)
    .values({
      id: `app-${actor.userId}`,
      name: `${label} Agent`,
      clientId: `client-${actor.userId}`,
      redirectUrls: "http://127.0.0.1:7777/cb",
      type: "web",
      userId: actor.userId,
    });
  await getDb()
    .insert(oauthConsent)
    .values({
      id: `consent-${actor.userId}`,
      clientId: `client-${actor.userId}`,
      userId: actor.userId,
      scopes: "ledger:read",
      consentGiven: true,
    });
  await getDb()
    .insert(oauthAccessToken)
    .values({
      id: `tok-${actor.userId}`,
      accessToken: `access-${actor.userId}`,
      refreshToken: `refresh-${actor.userId}`,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
      clientId: `client-${actor.userId}`,
      userId: actor.userId,
      scopes: "ledger:read",
    });
  // A pending password reset: no user column, so no cascade reaches it.
  await getDb()
    .insert(verification)
    .values({
      id: `verify-${actor.userId}`,
      identifier: `reset-password:token-${actor.userId}`,
      value: actor.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  return { checking, groceries };
}

integration("deleting an account takes everything in it", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await seed(leaver, "Leaver");
    await seed(stayer, "Stayer");
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("says what is about to go, in the terms it was put in", async () => {
    const summary = await summarizeOwnData(leaver);
    expect(summary.accounts).toBe(1);
    expect(summary.transactions).toBe(1);
    expect(summary.categories).toBe(1);
    expect(summary.stagedTransactions).toBe(1);
    expect(summary.payees).toBe(1);
    expect(summary.connectedAgents).toBe(1);
  });

  // Typing the address is the only thing on the screen a click cannot produce.
  it("refuses without the account's own address", async () => {
    for (const wrong of ["", "  ", "someone@else.test", "DELETION-LEAVER@example.com.uk"]) {
      await expect(deleteOwnAccount(leaver, { confirmEmail: wrong })).rejects.toThrow();
    }
    expect(await rowsFor("ledger_transaction", leaver.userId)).toBe(1);
  });

  it("accepts the address whatever case it is typed in", async () => {
    const before = await tablesWithUserColumn();
    expect(before.length).toBeGreaterThan(10);

    const result = await deleteOwnAccount(leaver, {
      confirmEmail: "  DELETION-LEAVER@Example.COM  ",
    });
    expect(result.deleted).toBe(true);
    expect(result.removed.transactions).toBe(1);
  });

  // The assertion that matters: nothing of theirs is left anywhere, checked
  // against every table the database itself says holds a user_id.
  it("leaves nothing behind in any table that holds user data", async () => {
    const tables = await tablesWithUserColumn();
    const leftovers: string[] = [];
    for (const table of tables) {
      const count = await rowsFor(table, leaver.userId);
      if (count > 0) leftovers.push(`${table}=${count}`);
    }
    expect(leftovers).toEqual([]);
    // And the user row itself.
    const users = await getDb().execute(
      sql`select count(*)::int as count from auth_user where id = ${leaver.userId}`,
    );
    expect(Number((users.rows[0] as { count: number }).count)).toBe(0);
  });

  // No user column, so the cascade cannot reach it and the service must.
  it("removes a pending password reset, which no cascade covers", async () => {
    const rows = await getDb().execute(
      sql`select count(*)::int as count from auth_verification where value = ${leaver.userId}`,
    );
    expect(Number((rows.rows[0] as { count: number }).count)).toBe(0);
  });

  it("leaves the other tenant's ledger completely alone", async () => {
    const tables = await tablesWithUserColumn();
    const kept: Record<string, number> = {};
    for (const table of tables) {
      const count = await rowsFor(table, stayer.userId);
      if (count > 0) kept[table] = count;
    }
    // Every area they had data in still has it.
    for (const table of [
      "ledger_account",
      "ledger_transaction",
      "posting",
      "category",
      "staged_transaction",
      "user_preferences",
      "audit_event",
      "auth_session",
      "auth_account",
      "auth_oauth_consent",
      "auth_oauth_access_token",
      "idempotency_record",
    ]) {
      expect(kept[table], table).toBeGreaterThan(0);
    }
    const summary = await summarizeOwnData(stayer);
    expect(summary.transactions).toBe(1);
    expect(summary.accounts).toBe(1);
    // And their pending reset is untouched.
    const theirReset = await getDb().execute(
      sql`select count(*)::int as count from auth_verification where value = ${stayer.userId}`,
    );
    expect(Number((theirReset.rows[0] as { count: number }).count)).toBe(1);
  });

  it("is gone rather than merely emptied, so signing in again is impossible", async () => {
    await expect(
      deleteOwnAccount(leaver, { confirmEmail: "deletion-leaver@example.com" }),
    ).rejects.toThrow(/not found/i);
  });
});
