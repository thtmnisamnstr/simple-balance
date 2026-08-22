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
import { createCategory } from "../../src/server/services/categories.js";
import { updateTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const name = `simple_balance_split_upgrade_${process.pid}_${Date.now()}`;
const drizzleFolder = path.resolve(import.meta.dirname, "../../drizzle");

/**
 * A copy of the migration folder brought to exactly the state 0.1.3 shipped and
 * no further.
 *
 * Only the journal is trimmed. Drizzle's migrator reads the files the journal
 * names rather than listing the directory, so what is left on disk beside it
 * changes nothing; deleting 0005's SQL and not 0006's looked like it defined
 * the cut-off and defined nothing.
 */
async function folderThrough0004() {
  const folder = path.join(tmpdir(), `sb-pre-0005-${process.pid}-${Date.now()}`);
  await cp(drizzleFolder, folder, { recursive: true });
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

// Named for what it does rather than for two version numbers. It stops at the
// migrations 0.1.3 shipped and then runs every one that exists, so the
// destination is whatever the current release is — and the name went stale on
// each of them, having said 0.1.4 while carrying a ledger through 0.1.5's four
// new migrations as well.
integration("upgrading a ledger from the oldest supported state to this one", () => {
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
   * The acceptance test for both migrations this release ships, and the only
   * one that proves the claim they rest on: a ledger with years of entries in
   * it is upgraded by a schema change, not by a data migration. Nothing
   * existing is rewritten, so nothing existing can be rewritten wrongly.
   */
  it("leaves every transaction, posting and queued row exactly as it found them", async () => {
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

    // A queued row and an audit event, because 0006 adds columns to one and a
    // value to the enum the other stores. Without them this proved 0005 alone
    // while running both.
    await getDb().execute(sql`
      insert into staged_transaction (id, user_id, draft, status)
      values ('f1111111-1111-4111-8111-111111111111', ${userId},
              '{"type":"withdrawal","payee":"Queued","amount":"9.00"}'::jsonb, 'staged')
    `);
    await getDb().execute(sql`
      insert into audit_event (id, user_id, actor_source, entity_type, entity_id, operation)
      values ('11111111-aaaa-4aaa-8aaa-111111111111', ${userId}, 'web',
              'ledger_transaction', 'd1111111-1111-4111-8111-111111111111', 'create')
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

    // 0006's half of the same promise. The queued row keeps its draft and gains
    // two nulls, the audit event is untouched, and the enum has grown a value
    // without disturbing the rows already stored under the old ones.
    const queued = await getDb().execute(sql`
      select draft ->> 'payee' as payee, status::text as status,
             recurrence_id, occurrence_date
        from staged_transaction
       where id = 'f1111111-1111-4111-8111-111111111111'
    `);
    expect(queued.rows[0]).toEqual({
      payee: "Queued",
      status: "staged",
      recurrence_id: null,
      occurrence_date: null,
    });

    const audited = await getDb().execute(sql`
      select actor_source::text as actor_source from audit_event
       where id = '11111111-aaaa-4aaa-8aaa-111111111111'
    `);
    expect(audited.rows[0]).toEqual({ actor_source: "web" });

    const sources = await getDb().execute(sql`
      select enumlabel from pg_enum
       where enumtypid = 'public.actor_source'::regtype
       order by enumsortorder
    `);
    expect(sources.rows.map((row) => (row as { enumlabel: string }).enumlabel)).toEqual([
      "web",
      "mcp",
      "schedule",
    ]);

    // And the recurrence table arrives empty, so nothing was invented for a
    // ledger that never had one.
    const recurrences = await getDb().execute(
      sql`select count(*)::int as count from recurrence`,
    );
    expect(recurrences.rows[0]).toEqual({ count: 0 });
  });

  /**
   * Nothing declarative keeps `leg_count` honest — it has one reader, the check
   * constraint — so it is reconciled against the leg rows rather than trusted.
   *
   * Splitting a transaction first is what gives that anything to say. Reconciled
   * over the upgraded fixture alone it compared zero legs against zero counters
   * and passed on an empty set, which is the same answer a migration that
   * created no leg table at all would have given.
   */
  it("keeps the leg counter agreeing with the legs themselves", async () => {
    const userId = "upgrade-tenant";
    const household = (
      await createCategory(
        { userId, source: "web" },
        { name: "Household", kind: "expense" },
      )
    ).id;
    const split = await updateTransaction(
      { userId, source: "web" },
      "d1111111-1111-4111-8111-111111111111",
      {
        expectedVersion: 1,
        draft: {
          type: "withdrawal",
          date: "2026-03-01",
          payee: "Corner shop",
          fromAccountId: "a1111111-1111-4111-8111-111111111111",
          amount: "25.00",
          legs: [
            { categoryId: "c1111111-1111-4111-8111-111111111111", amount: "15.00" },
            { categoryId: household, amount: "10.00" },
          ],
        },
      },
    );
    expect(split.legs).toHaveLength(2);

    const drift = await getDb().execute(sql`
      select t.id
      from ledger_transaction t
      where t.leg_count <> (
        select count(*) from transaction_leg l
        where l.user_id = t.user_id and l.transaction_id = t.id and l.amount <> 0
      )
    `);
    expect(drift.rows).toEqual([]);

    // The migrated schema carries a split the way a fresh one does: two legs,
    // each with its own postings, and the entry still settling to zero.
    const shape = await getDb().execute(sql`
      select
        (select count(*)::int from transaction_leg) as legs,
        (select count(*)::int from posting where leg_id is not null) as legged,
        (select coalesce(sum(amount), 0)::text from posting
          where transaction_id = 'd1111111-1111-4111-8111-111111111111') as total
    `);
    expect(shape.rows[0]).toMatchObject({ legs: 2, legged: 2 });
    expect(Number((shape.rows[0] as { total: string }).total)).toBe(0);
  });
});
