import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_migrations_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
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
      "auth_session",
      "auth_user",
      "auth_verification",
      "category",
      "idempotency_record",
      "import_batch",
      "ledger_account",
      "ledger_transaction",
      "posting",
      "staged_transaction",
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
    expect(migrationRows.rows[0]?.count).toBe("1");

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

  it("can rerun startup migrations without changing the schema history", async () => {
    await runMigrations();
    const migrationRows = await databaseClient.query<{ count: string }>(
      `select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    expect(migrationRows.rows[0]?.count).toBe("1");
  });

  it("enforces ledger shapes, posting uniqueness, and tenant-owned references", async () => {
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
       values ($1, $2, 'deposit', '2026-01-02', 'Valid payee', 'Valid deposit', $3, 10, 'USD')`,
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
           (user_id, transaction_id, account_id, amount, currency)
         values ($1, $2, $3, 10, 'USD')`,
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

    await databaseClient.query(
      `insert into posting
         (user_id, transaction_id, account_id, amount, currency)
       values ($1, $2, $3, 10, 'USD')`,
      [secondUserId, secondTransactionId, secondAccountId],
    );
    await expect(
      databaseClient.query(
        `insert into posting
           (user_id, transaction_id, account_id, amount, currency)
         values ($1, $2, $3, 5, 'USD')`,
        [secondUserId, secondTransactionId, secondAccountId],
      ),
    ).rejects.toMatchObject({
      constraint: "posting_transaction_account_unique",
    });
  });
});
