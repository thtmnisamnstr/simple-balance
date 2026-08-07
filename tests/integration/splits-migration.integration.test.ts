import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const name = `simple_balance_split_upgrade_${process.pid}_${Date.now()}`;
const drizzleFolder = path.resolve(import.meta.dirname, "../../drizzle");

/**
 * A copy of the migration folder with 0005 taken out, so a database can be
 * brought to exactly the state 0.1.3 shipped and no further.
 */
async function folderThrough0004() {
  const folder = path.join(tmpdir(), `sb-pre-0005-${process.pid}-${Date.now()}`);
  await cp(drizzleFolder, folder, { recursive: true });
  await rm(path.join(folder, "0005_split_transaction_legs.sql"));
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx < 5);
  await writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

/**
 * Every row of a table as text, ordered, so two readings can be compared for
 * equality rather than for approximate agreement.
 */
async function rowsOf(table: string, columns: string) {
  const result = await getDb().execute(
    sql.raw(`select ${columns} from ${table} order by id`),
  );
  return JSON.stringify(result.rows);
}

integration("upgrading a 0.1.3 ledger to split transactions", () => {
  let admin: PgClient;
  let preFolder: string;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const url = new URL(connection!);
    url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString();

    preFolder = await folderThrough0004();
    const client = new PgClient({ connectionString: url.toString() });
    await client.connect();
    await migrate(drizzle(client), { migrationsFolder: preFolder });
    await client.end();
  });

  afterAll(async () => {
    try {
      await closeDb();
    } finally {
      try {
        await rm(preFolder, { recursive: true, force: true });
        await admin.query(`drop database if exists "${name}"`);
      } finally {
        await admin.end();
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  /**
   * The acceptance test for migration 0005, and the only one that proves the
   * claim the whole feature rests on: a ledger with years of entries in it is
   * upgraded by a schema change, not by a data migration. Nothing existing is
   * rewritten, so nothing existing can be rewritten wrongly.
   */
  it("leaves every transaction and posting exactly as it found them", async () => {
    const userId = "upgrade-tenant";
    await getDb().execute(sql`
      insert into auth_user (id, name, email, email_verified)
      values (${userId}, 'Upgrade', 'upgrade@example.com', true)
    `);
    await getDb().execute(sql`
      insert into ledger_account (id, user_id, name, type, currency, opening_date, opening_balance)
      values
        ('a1111111-1111-4111-8111-111111111111', ${userId}, 'Checking', 'checking', 'USD', '2026-01-01', '0'),
        ('a2222222-2222-4222-8222-222222222222', ${userId}, 'Expenses (USD)', 'system', 'USD', '2026-01-01', '0')
    `);
    await getDb().execute(sql`
      update ledger_account set system_kind = 'expense'
      where id = 'a2222222-2222-4222-8222-222222222222'
    `);
    await getDb().execute(sql`
      insert into category (id, user_id, name, kind)
      values ('c1111111-1111-4111-8111-111111111111', ${userId}, 'Groceries', 'expense')
    `);
    await getDb().execute(sql`
      insert into ledger_transaction
        (id, user_id, type, date, payee, category_id, source_account_id, source_amount, source_currency)
      values
        ('d1111111-1111-4111-8111-111111111111', ${userId}, 'withdrawal', '2026-03-01',
         'Corner shop', 'c1111111-1111-4111-8111-111111111111',
         'a1111111-1111-4111-8111-111111111111', '25.00', 'USD')
    `);
    await getDb().execute(sql`
      insert into posting (id, user_id, transaction_id, account_id, date, amount, currency)
      values
        ('e1111111-1111-4111-8111-111111111111', ${userId}, 'd1111111-1111-4111-8111-111111111111',
         'a1111111-1111-4111-8111-111111111111', '2026-03-01', '-25.00', 'USD'),
        ('e2222222-2222-4222-8222-222222222222', ${userId}, 'd1111111-1111-4111-8111-111111111111',
         'a2222222-2222-4222-8222-222222222222', '2026-03-01', '25.00', 'USD')
    `);

    const transactionColumns =
      "id, type, date, payee, category_id, source_account_id, source_amount, source_currency, version, deleted_at, updated_at";
    const postingColumns =
      "id, transaction_id, account_id, date, amount, currency, updated_at";
    const before = {
      transactions: await rowsOf("ledger_transaction", transactionColumns),
      postings: await rowsOf("posting", postingColumns),
    };

    await runMigrations();

    expect(await rowsOf("ledger_transaction", transactionColumns)).toBe(
      before.transactions,
    );
    expect(await rowsOf("posting", postingColumns)).toBe(before.postings);

    const added = await getDb().execute(sql`
      select
        (select count(*)::int from transaction_leg) as legs,
        (select count(*)::int from posting where leg_id is not null) as claimed,
        (select count(*)::int from ledger_transaction where leg_count <> 0) as counted
    `);
    expect(added.rows[0]).toEqual({ legs: 0, claimed: 0, counted: 0 });
  });

  /**
   * Nothing declarative keeps `leg_count` honest — it has one reader, the check
   * constraint — so it is reconciled against the leg rows here rather than
   * trusted.
   */
  it("keeps the leg counter agreeing with the legs themselves", async () => {
    const drift = await getDb().execute(sql`
      select t.id
      from ledger_transaction t
      where t.leg_count <> (
        select count(*) from transaction_leg l
        where l.user_id = t.user_id and l.transaction_id = t.id and l.amount <> 0
      )
    `);
    expect(drift.rows).toEqual([]);
  });
});
