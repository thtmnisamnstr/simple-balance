import { and, eq, inArray } from "drizzle-orm";
import Papa from "papaparse";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { categories, importBatches, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory, setCategoryArchived } from "../../src/server/services/categories.js";
import {
  exportTransactionsCsv,
  listActiveImportBatches,
  stageCsv,
} from "../../src/server/services/import-export.js";
import {
  commitStages,
  createStage,
  getStage,
  listStages,
} from "../../src/server/services/staging.js";
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
      csv: ["date,description,amount", "2026-07-29,Idempotent CSV,9.50"].join("\n"),
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
    expect((await listActiveImportBatches(actor, { limit: 10 })).items).toEqual(
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
        csv: ["date,description,amount", "2026-07-29,Changed idempotent CSV,10.50"].join("\n"),
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
    await setCategoryArchived(actor, subscriptions.id, subscriptions.version, true);
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
        // Named by a withdrawal and a deposit, so the rows tie and the category
        // is created as spending. It used to be created covering both, and a
        // category covering both agrees with whichever direction it is handed:
        // the deposit then credited income and every later refund into Travel
        // moved nothing.
        expect.objectContaining({
          inputName: "Travel",
          categoryId: null,
          kind: "expense",
          resolution: "new",
        }),
        // An income category named on a withdrawal is income coming back, not
        // a category that turns out to cover both. It keeps its kind, so the
        // resolution is "existing" rather than "updated" and nothing about the
        // ledger's own records changes.
        expect.objectContaining({
          inputName: "refunds",
          categoryId: refunds.id,
          kind: "income",
          resolution: "existing",
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
        .where(and(eq(categories.userId, actor.userId), eq(categories.name, "Travel"))),
    ).toHaveLength(0);
    expect(
      await getDb()
        .select()
        .from(importBatches)
        .where(
          and(eq(importBatches.userId, actor.userId), eq(importBatches.fileName, common.fileName)),
        ),
    ).toHaveLength(0);
    expect(
      (await getDb().select().from(categories).where(eq(categories.id, refunds.id)))[0],
    ).toMatchObject({ kind: "income", version: refunds.version });
    expect(
      (await getDb().select().from(categories).where(eq(categories.id, subscriptions.id)))[0]
        ?.archivedAt,
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
        expect.objectContaining({ name: "Travel", kind: "expense" }),
        expect.objectContaining({ name: "Salary", kind: "income" }),
        expect.objectContaining({ name: "Dining", kind: "expense" }),
        // Unchanged: a withdrawal naming an income category is income coming
        // back, and the category is not widened by it.
        expect.objectContaining({ id: refunds.id, kind: "income" }),
        expect.objectContaining({ id: subscriptions.id, archivedAt: null }),
      ]),
    );
    expect(
      resolvedCategories.filter(
        (category) => category.name.normalize("NFKC").trim().toLowerCase() === "travel",
      ),
    ).toHaveLength(1);
  });

  /**
   * A dry run is the only reading of the file anybody sees before committing to
   * it, and a category the file names and the ledger does not have had nothing
   * to say for itself in that reading: no id, because nothing was created, and
   * no name either. The row came back silent, and the import preview reported it
   * as uncategorized — for precisely the categories the real stage was about to
   * make. An MCP caller reading the same sample got the same silence.
   */
  it("names the category a dry run has not created, without creating it", async () => {
    const common = {
      csv: ["date,payee,category,amount", "2026-10-01,Bakery,Baking,-7"].join("\n"),
      fileName: "deferred-category.csv",
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

    const preview = (await stageCsv(actor, {
      ...common,
      idempotencyKey: "csv-deferred-category-preview",
      dryRun: true,
    })) as { sample: { draft: Record<string, unknown> | null }[] };

    expect(preview.sample[0]!.draft).toMatchObject({
      categoryName: "Baking",
      // The kind travels with the name for the same reason it does on a
      // `ledger:stage` proposal: the file decided it by reading every row, and
      // a commit sees one row at a time.
      categoryKind: "expense",
    });
    expect(preview.sample[0]!.draft?.categoryId).toBeFalsy();
    expect(
      await getDb()
        .select()
        .from(categories)
        .where(and(eq(categories.userId, actor.userId), eq(categories.name, "Baking"))),
    ).toHaveLength(0);

    const staged = await stageCsv(actor, {
      ...common,
      idempotencyKey: "csv-deferred-category-stage",
      dryRun: false,
    });
    // The real stage answers with an id instead, and drops the name so nothing
    // downstream carries two ways of saying which category it means.
    const stagedSample = (staged as { sample: { draft: Record<string, unknown> | null }[] })
      .sample[0]!.draft;
    expect(stagedSample?.categoryId).toEqual(expect.any(String));
    expect(stagedSample?.categoryName).toBeUndefined();
  });

  /**
   * One split, two new categories, two different kinds.
   *
   * The kind a deferred category will be created as rides on the leg that
   * names it, never on the row. Carried at row level, one split naming two
   * new categories had a single slot for two answers: whichever vote wrote
   * last decided both, and the commit gave its kind to every leg of the row.
   */
  it("carries a deferred category kind per leg, not per row", async () => {
    const exported = [
      "date,payee,category,amount",
      // Two deposits vote DeferAlpha income, so the row-level kind on these
      // plain rows still works exactly as before.
      "2026-11-02,Employer,DeferAlpha,250",
      "2026-11-03,Employer,DeferAlpha,250",
    ].join("\n");
    const staged = (await stageCsv(
      actor,
      {
        csv: exported,
        fileName: "defer-votes.csv",
        idempotencyKey: "csv-defer-per-leg-plain",
        defaultAccountId: checkingId,
        mapping: { date: "date", payee: "payee", category: "category", amount: "amount" },
        dateFormat: "YMD" as const,
        decimalSeparator: "." as const,
      },
      undefined,
      { mayMutateCategories: false },
    )) as { sample: { draft: Record<string, unknown> | null }[] };
    expect(staged.sample[0]!.draft).toMatchObject({
      categoryName: "DeferAlpha",
      categoryKind: "income",
    });

    // A split whose legs carry their own kinds: one category that covers both
    // directions beside a plain spending one. A row-level slot cannot say
    // that — the last writer decided both categories.
    const stage = await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-11-04",
        payee: "Mixed split",
        fromAccountId: checkingId,
        amount: "100.00",
        legs: [
          { categoryName: "DeferBoth", categoryKind: "both", amount: "40.00" },
          { categoryName: "DeferBeta", categoryKind: "expense", amount: "60.00" },
        ],
      },
      idempotencyKey: "csv-defer-per-leg-split",
    });
    // The kinds survive staging leg by leg.
    const storedLegs = (
      (await getStage(actor, stage.id)).draft as {
        legs: { categoryName?: string; categoryKind?: string }[];
      }
    ).legs;
    expect(storedLegs.map((leg) => leg.categoryKind)).toEqual(["both", "expense"]);

    await commitStages(actor, {
      stagedIds: [stage.id],
      expectedVersions: { [stage.id]: stage.version },
      idempotencyKey: "csv-defer-per-leg-commit",
    });
    const created = await getDb()
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.userId, actor.userId),
          inArray(categories.name, ["DeferBoth", "DeferBeta"]),
        ),
      );
    const kinds = new Map(created.map((category) => [category.name, category.kind]));
    expect(kinds.get("DeferBoth")).toBe("both");
    expect(kinds.get("DeferBeta")).toBe("expense");
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
          category.name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() ===
          "concurrent utilities",
      ),
    ).toHaveLength(1);
    expect([first, second].flatMap((result) => result.referenceResolution.categories)).toEqual(
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
        and(eq(categories.userId, actor.userId), eq(categories.name, "tenant private category")),
      );
    expect(primaryCategory?.id).not.toBe(otherCategory.id);
  });

  it("marks exports explicitly and asks for both accounts of a transfer", async () => {
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
    expect(exported.csv.split(/\r?\n/, 1)[0]).toContain("simple_balance_format");
    expect(exported.csv).toContain("simple-balance-csv-1");

    const preview = await stageCsv(actor, {
      csv: exported.csv,
      fileName: "simple-balance-export.csv",
      idempotencyKey: "csv-preview-round-trip-transfer",
      defaultAccountId: checkingId,
      dryRun: true,
    });
    // Two accounts and one choice, so the row keeps everything it can and the
    // queue is asked for the rest. Which side the choice belongs on is not
    // guessed: a transfer pointed the wrong way is a wrong entry one click from
    // being committed.
    expect(preview).toMatchObject({
      validCount: 0,
      invalidCount: 1,
      sample: [
        {
          draft: null,
          issues: [
            {
              field: "account",
              message:
                "A transfer moves between two accounts and an import chooses one, so pick both here",
            },
          ],
        },
      ],
    });
  });

  /**
   * The file names the accounts of the ledger it came from, and a different
   * account, a different person, or a fresh install resolves none of those ids.
   * So the account is the one chosen for the import, and never one read back
   * out of the file.
   */
  it("posts an export against the account chosen for the import", async () => {
    const cardId = (
      await createAccount(actor, {
        name: "CSV Other Card",
        type: "credit_card",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-06-04",
        payee: "Elsewhere",
        description: null,
        fromAccountId: checkingId,
        amount: "42.50",
      },
      "csv-account-choice-withdrawal",
    );
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-06-04",
        payee: "Refund",
        description: null,
        toAccountId: checkingId,
        amount: "9.99",
      },
      "csv-account-choice-deposit",
    );
    const exported = await exportTransactionsCsv(actor, {
      start: "2026-06-04",
      end: "2026-06-04",
    });
    expect(exported.csv).toContain(checkingId);

    const preview = (await stageCsv(actor, {
      csv: exported.csv,
      fileName: "simple-balance-export.csv",
      idempotencyKey: "csv-account-choice",
      defaultAccountId: cardId,
      dryRun: true,
    })) as {
      validCount: number;
      invalidCount: number;
      sample: { draft: Record<string, string> | null }[];
    };

    expect(preview.validCount).toBe(2);
    expect(preview.invalidCount).toBe(0);
    const drafts = preview.sample.map((row) => row.draft);
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "withdrawal",
          fromAccountId: cardId,
          payee: "Elsewhere",
          description: null,
          amount: "42.5",
        }),
        expect.objectContaining({
          type: "deposit",
          toAccountId: cardId,
          payee: "Refund",
          description: null,
          amount: "9.99",
        }),
      ]),
    );
    for (const draft of drafts) {
      expect(JSON.stringify(draft)).not.toContain(checkingId);
    }
  });

  it("takes an export with no column mapping at all", async () => {
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-06-05",
        payee: "No mapping needed",
        description: null,
        fromAccountId: checkingId,
        amount: "5.00",
      },
      "csv-no-mapping",
    );
    const exported = await exportTransactionsCsv(actor, {
      start: "2026-06-05",
      end: "2026-06-05",
    });
    await expect(
      stageCsv(actor, {
        csv: exported.csv,
        fileName: "simple-balance-export.csv",
        idempotencyKey: "csv-no-mapping-stage",
        defaultAccountId: checkingId,
        dryRun: true,
      }),
    ).resolves.toMatchObject({ validCount: 1, invalidCount: 0 });

    // A file that is not one of ours still has to say which column is which.
    await expect(
      stageCsv(actor, {
        csv: "date,payee,amount\n2026-06-05,Somebody,-5.00\n",
        fileName: "bank.csv",
        idempotencyKey: "csv-no-mapping-bank",
        defaultAccountId: checkingId,
        dryRun: true,
      }),
    ).rejects.toThrow(/Map the columns/);
  });

  /**
   * An unreadable split costs the split, not the row. Discarding the whole
   * draft left somebody an empty row and one complaint, having thrown away the
   * date, payee, amount and account the file stated perfectly clearly.
   */
  it("stages a row whose split cannot be read, without the split", async () => {
    // Dated well clear of every other fixture, because the exports in this file
    // are taken by date range and an extra row changes what they count.
    const day = "2029-11-07";
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: day,
        payee: "Corrupt split",
        description: null,
        fromAccountId: checkingId,
        amount: "30.00",
        legs: [
          { categoryName: "Damaged Food", amount: "20.00" },
          { categoryName: "Damaged Home", amount: "10.00" },
        ],
      },
      "csv-corrupt-split",
    );
    const exported = await exportTransactionsCsv(actor, { start: day, end: day });

    // Parsed and rewritten rather than edited as text: the export quotes fields
    // that contain commas, and splitting on them shifts every later column.
    const parsed = Papa.parse<Record<string, string>>(exported.csv.trim(), {
      header: true,
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]!.legs_json).toContain("Damaged Food");
    parsed.data[0]!.legs_json = "{not json";
    const csv = Papa.unparse(parsed.data, { columns: parsed.meta.fields });

    await stageCsv(actor, {
      csv,
      fileName: "damaged.csv",
      idempotencyKey: "csv-corrupt-split-stage",
      defaultAccountId: checkingId,
    });

    const [row] = (await listStages(actor, { limit: 10, search: "Corrupt split" })).items;
    expect(row).toBeDefined();
    // Everything the file did state survived.
    expect(row!.draft).toMatchObject({
      type: "withdrawal",
      date: day,
      payee: "Corrupt split",
      fromAccountId: checkingId,
    });
    expect(Number((row!.draft as { amount?: string }).amount)).toBe(30);
    expect(row!.draft.legs).toBeUndefined();
    expect(row!.validationIssues.map((issue) => issue.field)).toContain("legs_json");
  });

  it("lets a different person import an export of someone else's ledger", async () => {
    const stranger: Actor = { userId: "csv-stranger-user", source: "web" };
    await getDb().insert(user).values({
      id: stranger.userId,
      name: "CSV Stranger",
      email: "csv-stranger@example.com",
      emailVerified: true,
    });
    const strangerAccountId = (
      await createAccount(stranger, {
        name: "Stranger Wallet",
        type: "cash",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-06-06",
        payee: "Crossing tenants",
        description: null,
        fromAccountId: checkingId,
        amount: "12.34",
      },
      "csv-cross-tenant-source",
    );
    const exported = await exportTransactionsCsv(actor, {
      start: "2026-06-06",
      end: "2026-06-06",
    });

    const preview = (await stageCsv(stranger, {
      csv: exported.csv,
      fileName: "someone-elses-export.csv",
      idempotencyKey: "csv-cross-tenant",
      defaultAccountId: strangerAccountId,
      dryRun: true,
    })) as {
      validCount: number;
      invalidCount: number;
      sample: { draft: Record<string, string> | null }[];
    };

    expect(preview.validCount).toBe(1);
    expect(preview.invalidCount).toBe(0);
    expect(preview.sample[0]!.draft).toMatchObject({
      type: "withdrawal",
      fromAccountId: strangerAccountId,
      payee: "Crossing tenants",
      amount: "12.34",
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
      expect(exported.csv, JSON.stringify(query)).not.toContain("Exported Then Voided");
      expect(exported.rowCount, JSON.stringify(query)).toBe(0);
    }
  });
  /**
   * An export matching nothing is still a CSV file.
   *
   * It used to be the empty string, which has no header record: RFC 4180
   * readers reject it, and this product's own preview and stage routes refused
   * it on `z.string().min(1)`. So the one export somebody is most likely to be
   * confused by — "did it work, or is my filter wrong?" — was also the one that
   * could not be opened to find out.
   *
   * The header a populated file writes comes from its first row's keys; an
   * empty one has no first row and takes them from a list instead. This asserts
   * the two agree, because a column added to the rows and not to the list would
   * make the empty file describe a different format from the full one.
   */
  it("exports a header-only file when nothing matches, with the same columns", async () => {
    const populated = await exportTransactionsCsv(actor, {});
    expect(populated.rowCount).toBeGreaterThan(0);
    const populatedHeader = populated.csv.split("\r\n")[0];

    const empty = await exportTransactionsCsv(actor, {
      start: "1900-01-01",
      end: "1900-01-02",
    });
    expect(empty.rowCount).toBe(0);
    expect(empty.csv).not.toBe("");
    expect(empty.csv.split("\r\n")).toHaveLength(1);
    expect(empty.csv).toBe(populatedHeader);
  });
});
