import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { categories, user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  exportTransactionsCsv,
  stageCsv,
} from "../../src/server/services/import-export.js";
import { commitStages, listStages } from "../../src/server/services/staging.js";
import {
  createTransaction,
  getTransaction,
} from "../../src/server/services/transactions.js";
import { APP_CSV_COLUMNS, isAppExportCsv } from "../../src/shared/csv.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("csv_fidelity");
const actor: Actor = { userId: "csv-fidelity-source", source: "web" };
const stranger: Actor = { userId: "csv-fidelity-target", source: "web" };

let key = 0;
const nextKey = () => `csv-fidelity-${(key += 1)}`.padEnd(16, "0");

/**
 * What survives a full export and re-import into a different ledger. Everything
 * here was silently lost or fabricated: the bank's own reference was replaced
 * by the source ledger's primary key, a transfer's category was dropped, and a
 * category whose name begins with a spreadsheet-formula character gained an
 * apostrophe on every trip and became a second category each time.
 */
integration("what a CSV round trip preserves", () => {
  let sourceAccount: string;
  let sourceOther: string;
  let targetAccount: string;

  beforeAll(async () => {
    await database.create();
    for (const [id, name, email] of [
      [actor.userId, "Source", "csv-fidelity-source@example.com"],
      [stranger.userId, "Target", "csv-fidelity-target@example.com"],
    ] as const) {
      await getDb().insert(user).values({ id, name, email, emailVerified: true });
    }
    const account = (owner: Actor, name: string) =>
      createAccount(owner, {
        name,
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      });
    sourceAccount = (await account(actor, "Source Checking")).id;
    sourceOther = (await account(actor, "Source Savings")).id;
    targetAccount = (await account(stranger, "Target Checking")).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  const restore = async (csv: string, into = stranger) =>
    stageCsv(into, {
      csv,
      fileName: "export.csv",
      defaultAccountId: into === stranger ? targetAccount : sourceAccount,
      idempotencyKey: nextKey(),
    });

  const stagedRows = async (owner: Actor) =>
    (await listStages(owner, { limit: 100 })).items;

  it("carries the bank's own reference and never the source ledger's id", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-04-01",
        payee: "Utility Co",
        description: null,
        fromAccountId: sourceAccount,
        amount: "42.00",
        externalId: "FITID202604010001",
      },
      nextKey(),
    );
    const { csv } = await exportTransactionsCsv(actor, {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(csv).toContain("FITID202604010001");

    await restore(csv);
    const [row] = await stagedRows(stranger);
    expect((row!.draft as { externalId?: string }).externalId).toBe(
      "FITID202604010001",
    );
    expect((row!.draft as { externalId?: string }).externalId).not.toBe(created.id);
  });

  it("leaves the reference empty rather than inventing one", async () => {
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-04-02",
        payee: "No Reference",
        description: null,
        fromAccountId: sourceAccount,
        amount: "7.00",
      },
      nextKey(),
    );
    const { csv } = await exportTransactionsCsv(actor, {
      start: "2026-04-02",
      end: "2026-04-02",
    });
    await restore(csv);
    const row = (await stagedRows(stranger)).find(
      (one) => (one.draft as { payee?: string }).payee === "No Reference",
    );
    expect((row!.draft as { externalId?: string | null }).externalId ?? null).toBeNull();
  });

  it("keeps a transfer's category across ledgers", async () => {
    const sweep = await createCategory(actor, {
      name: "Savings Sweep",
      kind: "both",
    });
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-04-03",
        payee: "Monthly sweep",
        description: null,
        fromAccountId: sourceAccount,
        toAccountId: sourceOther,
        sourceAmount: "250.00",
        categoryId: sweep.id,
      },
      nextKey(),
    );
    const { csv } = await exportTransactionsCsv(actor, {
      start: "2026-04-03",
      end: "2026-04-03",
    });

    const staged = await restore(csv);
    expect(staged.referenceResolution.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ inputName: "Savings Sweep" }),
      ]),
    );
    const row = (await stagedRows(stranger)).find(
      (one) => (one.draft as { payee?: string }).payee === "Monthly sweep",
    );
    const created = await getDb()
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.userId, stranger.userId),
          eq(categories.name, "Savings Sweep"),
        ),
      );
    expect(created).toHaveLength(1);
    expect((row!.draft as { categoryId?: string }).categoryId).toBe(created[0]!.id);
  });

  it("does not add an apostrophe to a category whose name looks like a formula", async () => {
    const awkward = await createCategory(actor, {
      name: "-Reimbursements",
      kind: "expense",
    });
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-04-04",
        payee: "Expenses",
        description: null,
        fromAccountId: sourceAccount,
        amount: "15.00",
        categoryId: awkward.id,
      },
      nextKey(),
    );
    const { csv } = await exportTransactionsCsv(actor, {
      start: "2026-04-04",
      end: "2026-04-04",
    });
    // The visible cell stays spreadsheet-safe for whoever opens the file.
    expect(csv).toContain("'-Reimbursements");

    await restore(csv);
    const names = await getDb()
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.userId, stranger.userId));
    expect(names.map((row) => row.name)).toContain("-Reimbursements");
    expect(names.map((row) => row.name)).not.toContain("'-Reimbursements");
  });

  it("re-imports into the same ledger without a second category", async () => {
    const before = await getDb()
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.userId, actor.userId));
    const { csv } = await exportTransactionsCsv(actor, {
      start: "2026-04-04",
      end: "2026-04-04",
    });
    await restore(csv, actor);
    const after = await getDb()
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.userId, actor.userId));
    expect(after).toHaveLength(before.length);
  });

  // A file written before the reference column existed still has to import,
  // which is why the column is not part of what makes a file recognisable.
  it("still recognises a file with none of the new columns", () => {
    const shipped = [
      "simple_balance_format",
      "transaction_id",
      "transaction_type",
      "date",
      "payee",
      "description",
      "category_id",
      "category_name",
      "notes",
      "roundtrip_text_json",
      "source_account_id",
      "source_account_name",
      "source_amount",
      "source_currency",
      "destination_account_id",
      "destination_account_name",
      "destination_amount",
      "destination_currency",
      "effective_rate",
    ];
    expect(isAppExportCsv(shipped)).toBe(true);
    expect(APP_CSV_COLUMNS).not.toContain("external_id");
    expect(APP_CSV_COLUMNS).not.toContain("legs_json");
  });

  it("commits a restored transfer once both accounts are chosen", async () => {
    const row = (await stagedRows(stranger)).find(
      (one) => (one.draft as { payee?: string }).payee === "Monthly sweep",
    );
    const draft = row!.draft as Record<string, unknown>;
    const { updateStage } = await import("../../src/server/services/staging.js");
    const savings = await createAccount(stranger, {
      name: "Target Savings",
      type: "savings",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    const repaired = await updateStage(stranger, row!.id, {
      draft: {
        ...draft,
        type: "transfer",
        fromAccountId: targetAccount,
        toAccountId: savings.id,
      },
      expectedVersion: row!.version,
    });
    const committed = await commitStages(stranger, {
      stagedIds: [repaired.id],
      expectedVersions: { [repaired.id]: repaired.version },
      idempotencyKey: nextKey(),
    });
    const transactionId = (
      committed as { committed: { transactionId: string }[] }
    ).committed[0]!.transactionId;
    const transaction = await getTransaction(stranger, transactionId);
    expect(transaction.category?.name).toBe("Savings Sweep");
  });
});
