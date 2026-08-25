import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_migrations_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
// Read rather than written down, so adding a migration does not mean editing a
// number here to match.
const expectedMigrations = String(
  (
    JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../../drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: unknown[] }
  ).entries.length,
);
let adminClient: PgClient;
let databaseClient: PgClient;

integration("PostgreSQL migrations", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);

    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();

    databaseClient = new PgClient({ connectionString: databaseUrl.toString() });
    await databaseClient.connect();
  });

  afterAll(async () => {
    await databaseClient?.end();
    await closeDb();
    await adminClient?.query(`drop database if exists "${databaseName}"`);
    await adminClient?.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("creates the complete current schema from an empty database", async () => {
    const tables = await databaseClient.query<{ tablename: string }>(
      `select tablename
         from pg_tables
        where schemaname = 'public'
        order by tablename`,
    );

    expect(tables.rows.map(({ tablename }) => tablename)).toEqual([
      "audit_event",
      "auth_account",
      "auth_mcp_signing_key",
      "auth_oauth_access_token",
      "auth_oauth_application",
      "auth_oauth_consent",
      "auth_owner_setup_token",
      "auth_rate_limit",
      "auth_session",
      "auth_user",
      "auth_verification",
      "budget_entry",
      "budget_plan",
      "category",
      "idempotency_record",
      "import_batch",
      "ledger_account",
      "ledger_transaction",
      "posting",
      "recurrence",
      "staged_transaction",
      "template_notification",
      "transaction_leg",
      "transaction_template",
      "user_preferences",
    ]);

    const columns = await databaseClient.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `select table_name,
              column_name,
              data_type,
              is_nullable,
              numeric_precision,
              numeric_scale
         from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'idempotency_record' and column_name = 'request_hash')
            or
            (table_name = 'posting' and column_name = 'amount')
          )
        order by table_name, column_name`,
    );

    expect(columns.rows).toEqual([
      {
        table_name: "idempotency_record",
        column_name: "request_hash",
        data_type: "text",
        is_nullable: "NO",
        numeric_precision: null,
        numeric_scale: null,
      },
      {
        table_name: "posting",
        column_name: "amount",
        data_type: "numeric",
        is_nullable: "NO",
        numeric_precision: 44,
        numeric_scale: 18,
      },
    ]);

    const migrationRows = await databaseClient.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    expect(migrationRows.rows[0]?.count).toBe(expectedMigrations);

    const constraints = await databaseClient.query<{ conname: string }>(
      `select conname
         from pg_constraint
        where conname in (
          'category_version_check',
          'idempotency_record_request_hash_check',
          'import_batch_row_count_check',
          'ledger_account_currency_check',
          'ledger_account_version_check',
          'ledger_transaction_shape_check',
          'ledger_transaction_payee_check',
          'ledger_transaction_description_check',
          'ledger_transaction_version_check',
          'posting_amount_check',
          'posting_currency_check',
          'staged_transaction_status_check',
          'staged_transaction_version_check',
          'user_preferences_default_currency_check'
        )
        order by conname`,
    );
    expect(constraints.rows.map(({ conname }) => conname)).toEqual([
      "category_version_check",
      "idempotency_record_request_hash_check",
      "import_batch_row_count_check",
      "ledger_account_currency_check",
      "ledger_account_version_check",
      "ledger_transaction_description_check",
      "ledger_transaction_payee_check",
      "ledger_transaction_shape_check",
      "ledger_transaction_version_check",
      "posting_amount_check",
      "posting_currency_check",
      "staged_transaction_status_check",
      "staged_transaction_version_check",
      "user_preferences_default_currency_check",
    ]);
  });

  /**
   * A database left by the previous release takes this one's migrations.
   *
   * Every other case here starts from empty, which is the one shape no real
   * deployment has. `AGENTS.md` says a release upgrades cleanly from the one
   * before it, and the schema half of that promise is this: what a previous
   * release already applied is left alone, and only what is new runs.
   *
   * Built faithfully rather than by deleting a journal row: the tables that
   * migration created would still be there, which is a torn upgrade rather than
   * a previous release, and re-running the migration against its own objects
   * fails on `CREATE TYPE`. So this applies every migration but the last by
   * hand, into a database of its own, recording each one the way the migrator
   * would — the file's SHA-256, which is what it compares against.
   */
  it("applies only what is new to a database left by the release before", async () => {
    const scratch = `${databaseName}_upgrade`;
    await adminClient.query(`create database "${scratch}"`);
    const previousRelease = new PgClient({
      connectionString: new URL(`/${scratch}`, connection!).toString(),
    });
    await previousRelease.connect();

    try {
      const folder = new URL("../../drizzle/", import.meta.url);
      const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", folder), "utf8")) as {
        entries: { tag: string; when: number }[];
      };
      const upToPrevious = journal.entries.slice(0, -1);
      expect(upToPrevious.length).toBeGreaterThan(0);

      await previousRelease.query(`create schema if not exists drizzle`);
      await previousRelease.query(
        `create table if not exists drizzle.__drizzle_migrations (
           id serial primary key,
           hash text not null,
           created_at bigint
         )`,
      );
      for (const entry of upToPrevious) {
        const sql = readFileSync(new URL(`${entry.tag}.sql`, folder), "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await previousRelease.query(statement);
        }
        await previousRelease.query(
          `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
          [createHash("sha256").update(sql).digest("hex"), entry.when],
        );
      }

      // What a 0.1.5 database looks like: everything but the newest migration.
      const before = await previousRelease.query<{ count: string }>(
        `select count(*)::text as count from drizzle.__drizzle_migrations`,
      );
      expect(Number(before.rows[0]?.count)).toBe(journal.entries.length - 1);

      const restore = process.env.DATABASE_URL;
      process.env.DATABASE_URL = new URL(`/${scratch}`, connection!).toString();
      try {
        await expect(runMigrations()).resolves.not.toThrow();
      } finally {
        process.env.DATABASE_URL = restore;
        await closeDb();
      }

      const after = await previousRelease.query<{ count: string }>(
        `select count(*)::text as count from drizzle.__drizzle_migrations`,
      );
      expect(Number(after.rows[0]?.count)).toBe(journal.entries.length);
    } finally {
      await previousRelease.end();
      await adminClient.query(`drop database if exists "${scratch}"`);
    }
  });

  it("can rerun startup migrations without changing the schema history", async () => {
    await runMigrations();
    const migrationRows = await databaseClient.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    expect(migrationRows.rows[0]?.count).toBe(expectedMigrations);
  });

  it("enforces ledger shapes, append-only postings, and tenant-owned references", async () => {
    const firstUserId = "migration-constraints-first";
    const secondUserId = "migration-constraints-second";
    const firstAccountId = "10000000-0000-4000-8000-000000000001";
    const secondAccountId = "10000000-0000-4000-8000-000000000002";
    const secondTransactionId = "20000000-0000-4000-8000-000000000001";
    const secondCategoryId = "30000000-0000-4000-8000-000000000001";
    const secondImportBatchId = "40000000-0000-4000-8000-000000000001";

    await databaseClient.query(
      `insert into auth_user (id, name, email)
       values
         ($1, 'First owner', 'migration-constraints-first@example.com'),
         ($2, 'Second owner', 'migration-constraints-second@example.com')`,
      [firstUserId, secondUserId],
    );
    await databaseClient.query(
      `insert into ledger_account
         (id, user_id, name, type, currency, opening_date)
       values
         ($1, $3, 'First checking', 'checking', 'USD', '2026-01-01'),
         ($2, $4, 'Crypto wallet', 'crypto_wallet', 'USDT', '2026-01-01')`,
      [firstAccountId, secondAccountId, firstUserId, secondUserId],
    );
    await databaseClient.query(
      `insert into category (id, user_id, name, kind)
       values ($1, $2, 'Second income', 'income')`,
      [secondCategoryId, secondUserId],
    );
    await databaseClient.query(
      `insert into import_batch
         (id, user_id, file_name, file_hash, delimiter, mapping, row_count)
       values ($1, $2, 'second.csv', 'second-hash', ',', '{}'::jsonb, 1)`,
      [secondImportBatchId, secondUserId],
    );
    await databaseClient.query(
      `insert into ledger_transaction
         (id, user_id, type, date, payee, description, destination_account_id,
          destination_amount, destination_currency)
       values ($1, $2, 'deposit', '2026-01-02', 'Valid payee', 'Valid deposit', $3, 10, 'USDT')`,
      [secondTransactionId, secondUserId, secondAccountId],
    );

    await expect(
      databaseClient.query(
        `insert into ledger_transaction
           (user_id, type, date, payee, description, destination_account_id,
            destination_currency)
         values ($1, 'deposit', '2026-01-03', 'Test payee', 'Missing amount', $2, 'USD')`,
        [firstUserId, firstAccountId],
      ),
    ).rejects.toMatchObject({ constraint: "ledger_transaction_shape_check" });

    await expect(
      databaseClient.query(
        `insert into ledger_transaction
           (user_id, type, date, payee, description, destination_account_id,
            destination_amount, destination_currency)
         values ($1, 'deposit', '2026-01-03', 'Test payee', 'Other owner account', $2, 10, 'USD')`,
        [firstUserId, secondAccountId],
      ),
    ).rejects.toMatchObject({
      constraint: "ledger_transaction_destination_account_owner_fk",
    });

    await expect(
      databaseClient.query(
        `insert into ledger_transaction
           (user_id, type, date, payee, description, category_id, destination_account_id,
            destination_amount, destination_currency)
         values ($1, 'deposit', '2026-01-03', 'Test payee', 'Other owner category', $2, $3, 10, 'USD')`,
        [firstUserId, secondCategoryId, firstAccountId],
      ),
    ).rejects.toMatchObject({
      constraint: "ledger_transaction_category_owner_fk",
    });

    await expect(
      databaseClient.query(
        `insert into posting
           (user_id, transaction_id, account_id, date, amount, currency)
         values ($1, $2, $3, '2027-01-01', 10, 'USD')`,
        [firstUserId, secondTransactionId, firstAccountId],
      ),
    ).rejects.toMatchObject({ constraint: "posting_transaction_owner_fk" });

    await expect(
      databaseClient.query(
        `insert into staged_transaction (user_id, draft, import_batch_id)
         values ($1, '{}'::jsonb, $2)`,
        [firstUserId, secondImportBatchId],
      ),
    ).rejects.toMatchObject({
      constraint: "staged_transaction_import_batch_owner_fk",
    });

    // A posting cannot name an amount in a currency its account does not hold,
    // so a balance can sum without grouping by currency.
    await expect(
      databaseClient.query(
        `insert into posting
           (user_id, transaction_id, account_id, date, amount, currency)
         values ($1, $2, $3, '2027-01-01', 10, 'EUR')`,
        [secondUserId, secondTransactionId, secondAccountId],
      ),
    ).rejects.toMatchObject({ constraint: "posting_account_currency_fk" });

    // Postings are append-only. One account legitimately carries several
    // generations for a transaction once a correction adjusts it, so the schema
    // must allow the repeat rather than reject it.
    await databaseClient.query(
      `insert into posting
         (user_id, transaction_id, account_id, date, amount, currency)
       values ($1, $2, $3, '2027-01-01', 10, 'USDT')`,
      [secondUserId, secondTransactionId, secondAccountId],
    );
    await databaseClient.query(
      `insert into posting
         (user_id, transaction_id, account_id, date, amount, currency)
       values ($1, $2, $3, '2027-01-01', -10, 'USDT')`,
      [secondUserId, secondTransactionId, secondAccountId],
    );
    const generations = await databaseClient.query<{ total: string }>(
      `select sum(amount)::text as total
         from posting
        where transaction_id = $1 and account_id = $2`,
      [secondTransactionId, secondAccountId],
    );
    expect(generations.rows[0]?.total).toBe("0.000000000000000000");

    // A posting records a transaction or an opening balance, never both and
    // never neither.
    await expect(
      databaseClient.query(
        `insert into posting
           (user_id, transaction_id, opening_account_id, account_id, date, amount, currency)
         values ($1, $2, $3, $4, '2027-01-01', 10, 'USDT')`,
        [secondUserId, secondTransactionId, secondAccountId, secondAccountId],
      ),
    ).rejects.toMatchObject({ constraint: "posting_origin_check" });
    await expect(
      databaseClient.query(
        `insert into posting
           (user_id, account_id, date, amount, currency)
         values ($1, $2, '2027-01-01', 10, 'USDT')`,
        [secondUserId, secondAccountId],
      ),
    ).rejects.toMatchObject({ constraint: "posting_origin_check" });

    // A zero posting is still meaningless and stays rejected.
    await expect(
      databaseClient.query(
        `insert into posting
           (user_id, transaction_id, account_id, date, amount, currency)
         values ($1, $2, $3, '2027-01-01', 0, 'USDT')`,
        [secondUserId, secondTransactionId, secondAccountId],
      ),
    ).rejects.toMatchObject({ constraint: "posting_amount_check" });
  });
});
