import { and, eq } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  categories,
  importBatches,
  user,
} from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createCategory,
  setCategoryArchived,
} from "../../src/server/services/categories.js";
import {
  exportTransactionsCsv,
  listActiveImportBatches,
  stageCsv,
} from "../../src/server/services/import-export.js";
import { createStage, getStage } from "../../src/server/services/staging.js";
import {
  createTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";

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
        payee: "description",
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
        payee: "description",
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

  it("maps reference names, creates categories atomically, and reports dry-run plans", async () => {
    const groceries = await createCategory(actor, {
      name: "Groceries",
      kind: "expense",
    });
    const refunds = await createCategory(actor, {
      name: "Refunds",
      kind: "income",
    });
    const subscriptions = await createCategory(actor, {
      name: "Subscriptions",
      kind: "expense",
    });
    await setCategoryArchived(
      actor,
      subscriptions.id,
      subscriptions.version,
      true,
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-09-01",
        payee: "ACME Market",
        description: null,
        fromAccountId: checkingId,
        amount: "1",
      },
      "csv-reference-existing-payee",
    );
    await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-09-01",
        payee: "Corner Shop",
        fromAccountId: checkingId,
        amount: "2",
      },
      idempotencyKey: "csv-reference-existing-staged-payee",
    });

    const csv = [
      "date,payee,category,amount",
      "2026-09-10,acme market,  groceries  ,-5",
      "2026-09-11,CORNER   SHOP,Travel,-10",
      "2026-09-12,Fresh Cafe, travel ,20",
      "2026-09-13,fresh   cafe,refunds,-3",
      "2026-09-14,Streaming,subscriptions,-4",
      "2026-09-15,Employer,Salary,100",
      "2026-09-16,Coffee Shop,Dining,-6",
    ].join("\n");
    const common = {
      csv,
      fileName: "reference-resolution.csv",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        payee: "payee",
        category: "category",
        amount: "amount",
      },
      dateFormat: "YMD" as const,
      decimalSeparator: "." as const,
    };

    const preview = await stageCsv(actor, {
      ...common,
      idempotencyKey: "csv-reference-resolution-preview",
      dryRun: true,
    });
    expect(preview).toMatchObject({ validCount: 7, invalidCount: 0 });
    expect(preview.referenceResolution.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inputName: "groceries",
          categoryId: groceries.id,
          kind: "expense",
          resolution: "existing",
        }),
        expect.objectContaining({
          inputName: "Travel",
          categoryId: null,
          kind: "both",
          resolution: "new",
        }),
        expect.objectContaining({
          inputName: "refunds",
          categoryId: refunds.id,
          kind: "both",
          resolution: "updated",
        }),
        expect.objectContaining({
          inputName: "subscriptions",
          categoryId: subscriptions.id,
          kind: "expense",
          resolution: "updated",
          unarchived: true,
        }),
        expect.objectContaining({
          inputName: "Salary",
          categoryId: null,
          kind: "income",
          resolution: "new",
        }),
        expect.objectContaining({
          inputName: "Dining",
          categoryId: null,
          kind: "expense",
          resolution: "new",
        }),
      ]),
    );
    expect(preview.referenceResolution.payees).toEqual(
      expect.arrayContaining([
        {
          inputPayee: "acme market",
          resolvedPayee: "ACME Market",
          resolution: "existing",
        },
        {
          inputPayee: "CORNER SHOP",
          resolvedPayee: "Corner Shop",
          resolution: "existing",
        },
        {
          inputPayee: "Fresh Cafe",
          resolvedPayee: "Fresh Cafe",
          resolution: "new",
        },
      ]),
    );
    expect(
      await getDb()
        .select()
        .from(categories)
        .where(
          and(
            eq(categories.userId, actor.userId),
            eq(categories.name, "Travel"),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(importBatches)
        .where(
          and(
            eq(importBatches.userId, actor.userId),
            eq(importBatches.fileName, common.fileName),
          ),
        ),
    ).toHaveLength(0);
    expect(
      (await getDb().select().from(categories).where(eq(categories.id, refunds.id)))[0],
    ).toMatchObject({ kind: "income", version: refunds.version });
    expect(
      (await getDb()
        .select()
        .from(categories)
        .where(eq(categories.id, subscriptions.id)))[0]?.archivedAt,
    ).not.toBeNull();

    const input = {
      ...common,
      idempotencyKey: "csv-reference-resolution-stage",
      dryRun: false,
    };
    const staged = await stageCsv(actor, input);
    expect(await stageCsv(actor, input)).toEqual(staged);
    if (!("stagedIds" in staged)) throw new Error("Expected staged CSV rows");
    expect(staged).toMatchObject({ validCount: 7, invalidCount: 0 });
    const stored = await Promise.all(staged.stagedIds.map((id) => getStage(actor, id)));
    expect(stored.every((row) => row.validationIssues.length === 0)).toBe(true);
    expect(stored.map((row) => row.draft.payee)).toEqual([
      "ACME Market",
      "Corner Shop",
      "Fresh Cafe",
      "Fresh Cafe",
      "Streaming",
      "Employer",
      "Coffee Shop",
    ]);

    const resolvedCategories = await getDb()
      .select()
      .from(categories)
      .where(eq(categories.userId, actor.userId));
    expect(resolvedCategories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Travel", kind: "both" }),
        expect.objectContaining({ name: "Salary", kind: "income" }),
        expect.objectContaining({ name: "Dining", kind: "expense" }),
        expect.objectContaining({ id: refunds.id, kind: "both" }),
        expect.objectContaining({ id: subscriptions.id, archivedAt: null }),
      ]),
    );
    expect(
      resolvedCategories.filter(
        (category) =>
          category.name.normalize("NFKC").trim().toLowerCase() === "travel",
      ),
    ).toHaveLength(1);
  });

  it("serializes concurrent creation of the same normalized import category", async () => {
    const makeInput = (suffix: string, category: string) => ({
      csv: [
        "date,payee,category,amount",
        `2026-09-20,Concurrent Payee ${suffix},${category},-7`,
      ].join("\n"),
      fileName: `concurrent-category-${suffix}.csv`,
      idempotencyKey: `concurrent-category-${suffix}`,
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        payee: "payee",
        category: "category",
        amount: "amount",
      },
      dateFormat: "YMD" as const,
      decimalSeparator: "." as const,
      dryRun: false,
    });
    const [first, second] = await Promise.all([
      stageCsv(actor, makeInput("first", "Concurrent Utilities")),
      stageCsv(actor, makeInput("second", " concurrent   utilities ")),
    ]);
    expect(first.invalidCount).toBe(0);
    expect(second.invalidCount).toBe(0);
    const persisted = await getDb()
      .select()
      .from(categories)
      .where(eq(categories.userId, actor.userId));
    expect(
      persisted.filter(
        (category) =>
          category.name
            .normalize("NFKC")
            .trim()
            .replace(/\s+/gu, " ")
            .toLowerCase() === "concurrent utilities",
      ),
    ).toHaveLength(1);
    expect(
      [first, second].flatMap(
        (result) => result.referenceResolution.categories,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolution: "new" }),
        expect.objectContaining({ resolution: "existing" }),
      ]),
    );
  });

  it("does not resolve categories or payees through another tenant", async () => {
    const otherActor: Actor = {
      userId: "csv-reference-other-user",
      source: "web",
    };
    await getDb().insert(user).values({
      id: otherActor.userId,
      name: "Other CSV User",
      email: "csv-reference-other@example.com",
      emailVerified: true,
    });
    const otherAccountId = (
      await createAccount(otherActor, {
        name: "Other CSV Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    const otherCategory = await createCategory(otherActor, {
      name: "Tenant Private Category",
      kind: "expense",
    });
    await createTransaction(
      otherActor,
      {
        type: "withdrawal",
        date: "2026-09-21",
        payee: "Tenant Private Payee",
        description: null,
        fromAccountId: otherAccountId,
        amount: "8",
      },
      "csv-reference-other-payee",
    );

    const result = await stageCsv(actor, {
      csv: [
        "date,payee,category,amount",
        "2026-09-21,tenant private payee,tenant private category,-8",
      ].join("\n"),
      fileName: "tenant-private-references.csv",
      idempotencyKey: "tenant-private-references",
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        payee: "payee",
        category: "category",
        amount: "amount",
      },
      dateFormat: "YMD",
      decimalSeparator: ".",
      dryRun: false,
    });
    expect(result.referenceResolution).toMatchObject({
      categories: [
        {
          resolution: "new",
          resolvedName: "tenant private category",
        },
      ],
      payees: [
        {
          resolution: "new",
          resolvedPayee: "tenant private payee",
        },
      ],
    });
    const [primaryCategory] = await getDb()
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.userId, actor.userId),
          eq(categories.name, "tenant private category"),
        ),
      );
    expect(primaryCategory?.id).not.toBe(otherCategory.id);
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
        payee: "CSV FX transfer",
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
        payee: "description",
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
        payee: "description",
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
  // A deleted entry is void: its postings net to zero and it is no part of any
  // balance. The file carries no column saying so, so a deleted row in it would
  // be indistinguishable from live money to whatever reads the file back.
  it("never exports a deleted transaction, even when the view asked for them", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-09-09",
        payee: "Exported Then Voided",
        description: null,
        fromAccountId: checkingId,
        amount: "42.00",
      },
      "csv-export-deleted-row",
    );
    await setTransactionDeleted(actor, created.id, created.version, true);

    for (const query of [
      { start: "2026-09-09", end: "2026-09-09" },
      { start: "2026-09-09", end: "2026-09-09", includeDeleted: true },
      { start: "2026-09-09", end: "2026-09-09", includeDeleted: "true" },
    ]) {
      const exported = await exportTransactionsCsv(actor, query);
      expect(exported.csv, JSON.stringify(query)).not.toContain(
        "Exported Then Voided",
      );
      expect(exported.rowCount, JSON.stringify(query)).toBe(0);
    }
  });

});
