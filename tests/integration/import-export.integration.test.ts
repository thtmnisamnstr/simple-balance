import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  exportTransactionsCsv,
  listActiveImportBatches,
  stageCsv,
} from "../../src/server/services/import-export.js";
import { createTransaction } from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_csv_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "csv-integration-user", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let checkingId = "";

integration("CSV import and export identification", () => {
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
      name: "CSV Integration",
      email: "csv-integration@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "CSV Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("uses the selected bank mapping when a non-app CSV has a transaction_type column", async () => {
    const preview = await stageCsv(actor, {
      csv: [
        "transaction_type,date,description,amount",
        "card_purchase,2026-07-30,Coffee,-12.34",
      ].join("\n"),
      fileName: "ordinary-bank.csv",
      idempotencyKey: "csv-preview-ordinary-bank",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        description: "description",
        amount: "amount",
      },
      dateFormat: "YMD",
      decimalSeparator: ".",
      dryRun: true,
    });

    expect(preview).toMatchObject({
      validCount: 1,
      invalidCount: 0,
      sample: [
        {
          draft: {
            type: "withdrawal",
            fromAccountId: checkingId,
            amount: "12.34",
          },
        },
      ],
    });
  });

  it("replays a committed CSV stage and binds its key to the file and mapping", async () => {
    const input = {
      csv: ["date,description,amount", "2026-07-29,Idempotent CSV,9.50"].join(
        "\n",
      ),
      fileName: "idempotent.csv",
      idempotencyKey: "csv-stage-idempotent",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        description: "description",
        amount: "amount",
      },
      dateFormat: "YMD" as const,
      decimalSeparator: "." as const,
      dryRun: false,
    };
    const created = await stageCsv(actor, input);
    expect(await stageCsv(actor, input)).toEqual(created);
    expect(created).toMatchObject({ rowCount: 1, stagedIds: [expect.any(String)] });
    expect(
      (await listActiveImportBatches(actor, { limit: 10 })).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fileName: "idempotent.csv",
          rowCount: 1,
          stagedCount: 1,
        }),
      ]),
    );

    await expect(
      stageCsv(actor, {
        ...input,
        csv: [
          "date,description,amount",
          "2026-07-29,Changed idempotent CSV,10.50",
        ].join("\n"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("marks exports explicitly and restores cross-currency transfer structure", async () => {
    const euroId = (
      await createAccount(actor, {
        name: "CSV Euro Cash",
        type: "cash",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-07-31",
        description: "CSV FX transfer",
        fromAccountId: checkingId,
        toAccountId: euroId,
        sourceAmount: "110",
        destinationAmount: "100",
      },
      "csv-round-trip-transfer",
    );
    const exported = await exportTransactionsCsv(actor, {
      start: "2026-07-31",
      end: "2026-07-31",
    });
    expect(exported.csv.split(/\r?\n/, 1)[0]).toContain(
      "simple_balance_format",
    );
    expect(exported.csv).toContain("simple-balance-csv-1");

    const preview = await stageCsv(actor, {
      csv: exported.csv,
      fileName: "simple-balance-export.csv",
      idempotencyKey: "csv-preview-round-trip-transfer",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        description: "description",
        amount: "source_amount",
      },
      dateFormat: "YMD",
      decimalSeparator: ".",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      validCount: 1,
      invalidCount: 0,
      sample: [
        {
          draft: {
            type: "transfer",
            fromAccountId: checkingId,
            toAccountId: euroId,
            sourceAmount: "110",
            destinationAmount: "100",
          },
        },
      ],
    });
  });

  it("round-trips formula-like text without exposing formulas or changing data", async () => {
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-08-01",
        description: "=SUM(A1:A2)",
        payee: "+Formula-like payee",
        notes: "@Formula-like note",
        toAccountId: checkingId,
        amount: "25",
      },
      "csv-round-trip-protected-text",
    );
    const exported = await exportTransactionsCsv(actor, {
      start: "2026-08-01",
      end: "2026-08-01",
    });
    expect(exported.csv).toContain("'=SUM(A1:A2)");
    expect(exported.csv).toContain("'+Formula-like payee");
    expect(exported.csv).toContain("'@Formula-like note");

    const preview = await stageCsv(actor, {
      csv: exported.csv,
      fileName: "simple-balance-protected-text.csv",
      idempotencyKey: "csv-preview-protected-text",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        description: "description",
        amount: "destination_amount",
      },
      dateFormat: "YMD",
      decimalSeparator: ".",
      dryRun: true,
    });
    expect(preview).toMatchObject({
      validCount: 1,
      invalidCount: 0,
      sample: [
        {
          draft: {
            type: "deposit",
            description: "=SUM(A1:A2)",
            payee: "+Formula-like payee",
            notes: "@Formula-like note",
            toAccountId: checkingId,
            amount: "25",
          },
        },
      ],
    });
  });
});
