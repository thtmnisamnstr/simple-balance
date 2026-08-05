import { eq } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { transactionTemplates, user } from "../../src/server/db/schema.js";
import { createAccount, deleteAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  createTransactionTemplate,
  deleteTransactionTemplate,
  getTransactionTemplate,
  listTransactionTemplates,
  updateTransactionTemplate,
} from "../../src/server/services/transaction-templates.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_templates_${process.pid}_${Date.now()}`;
const owner: Actor = { userId: "template-owner", source: "web" };
const stranger: Actor = { userId: "template-stranger", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;

let adminClient: PgClient;
let checkingId: string;
let savingsId: string;
let groceriesId: string;
let strangerAccountId: string;

const withdrawal = (extra: Record<string, unknown> = {}) => ({
  type: "withdrawal" as const,
  ...extra,
});

integration("saving a transaction as a template", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();

    await getDb().insert(user).values([
      {
        id: owner.userId,
        name: "Template Owner",
        email: "template-owner@example.com",
        emailVerified: true,
      },
      {
        id: stranger.userId,
        name: "Stranger",
        email: "template-stranger@example.com",
        emailVerified: true,
      },
    ]);
    const opening = {
      type: "checking" as const,
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "1000",
    };
    checkingId = (await createAccount(owner, { ...opening, name: "Checking" })).id;
    savingsId = (
      await createAccount(owner, {
        ...opening,
        name: "Savings",
        type: "savings",
        openingBalance: "0",
      })
    ).id;
    strangerAccountId = (
      await createAccount(stranger, { ...opening, name: "Theirs" })
    ).id;
    groceriesId = (
      await createCategory(owner, { name: "Groceries", kind: "expense" })
    ).id;
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("keeps the fields it was given and nothing else", async () => {
    const created = await createTransactionTemplate(owner, {
      name: "Weekly shop",
      draft: withdrawal({
        payee: "Corner Shop",
        fromAccountId: checkingId,
        categoryId: groceriesId,
        amount: "42.50",
      }),
    });
    expect(created.name).toBe("Weekly shop");
    expect(created.version).toBe(1);
    expect(created.draft).toEqual({
      type: "withdrawal",
      payee: "Corner Shop",
      fromAccountId: checkingId,
      categoryId: groceriesId,
      amount: "42.50",
    });
    // Nothing it was not given: no date, no notes, no empty strings.
    expect(Object.keys(created.draft).sort()).toEqual([
      "amount",
      "categoryId",
      "fromAccountId",
      "payee",
      "type",
    ]);
  });

  /**
   * The point of the feature: a recurring payee and category whose amount
   * differs every time. A blank field has to come back absent rather than as an
   * empty string, because the form applying it decides what to fill in by
   * asking whether the key is there.
   */
  it("stores a field left blank as absent, not as empty", async () => {
    const created = await createTransactionTemplate(owner, {
      name: "Varying amount",
      draft: withdrawal({
        payee: "Utilities",
        fromAccountId: checkingId,
        amount: "",
        description: "   ",
        notes: "",
      }),
    });
    expect(created.draft).toEqual({
      type: "withdrawal",
      payee: "Utilities",
      fromAccountId: checkingId,
    });
    expect("amount" in created.draft).toBe(false);
  });

  it("accepts a template that names no account at all", async () => {
    const created = await createTransactionTemplate(owner, {
      name: "Just a payee",
      draft: withdrawal({ payee: "Someone" }),
    });
    expect(created.draft).toEqual({ type: "withdrawal", payee: "Someone" });
  });

  /**
   * Three keys are refused rather than quietly dropped, each for its own
   * reason: a stored date would post transactions months back every time; a
   * category name would create a fresh category on every use; and a bank's
   * import reference would be copied onto every transaction made from the
   * template, so the next real import of that statement row would be swallowed
   * as one already seen.
   */
  it("refuses the keys that would make every transaction from it wrong", async () => {
    for (const [key, value] of [
      ["date", "2026-01-05"],
      ["categoryName", "Groceries"],
      ["externalId", "bank-reference-12345"],
    ] as const) {
      await expect(
        createTransactionTemplate(owner, {
          name: `Refused ${key}`,
          draft: withdrawal({ payee: "Somebody", [key]: value }),
        }),
      ).rejects.toThrow();
    }
    const names = (await listTransactionTemplates(owner)).map((t) => t.name);
    expect(names).not.toContain("Refused date");
    expect(names).not.toContain("Refused externalId");
  });

  it("insists on a type, because nothing can be shown without one", async () => {
    await expect(
      createTransactionTemplate(owner, {
        name: "Typeless",
        draft: { payee: "Somebody" },
      }),
    ).rejects.toThrow();
  });

  it("refuses an amount that is not money", async () => {
    for (const amount of ["-5.00", "0", "not-money"]) {
      await expect(
        createTransactionTemplate(owner, {
          name: `Bad amount ${amount}`,
          draft: withdrawal({ payee: "Somebody", amount }),
        }),
      ).rejects.toThrow();
    }
  });

  it("refuses a second template whose name differs only by case or spacing", async () => {
    await createTransactionTemplate(owner, {
      name: "Rent",
      draft: withdrawal({ payee: "Landlord", fromAccountId: checkingId }),
    });
    await expect(
      createTransactionTemplate(owner, {
        name: "  rent ",
        draft: withdrawal({ payee: "Landlord" }),
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("will not hold an account or category belonging to somebody else", async () => {
    await expect(
      createTransactionTemplate(owner, {
        name: "Not mine",
        draft: withdrawal({ payee: "Somebody", fromAccountId: strangerAccountId }),
      }),
    ).rejects.toThrow(/not one of yours/i);

    const theirCategory = await createCategory(stranger, {
      name: "Theirs",
      kind: "expense",
    });
    await expect(
      createTransactionTemplate(owner, {
        name: "Not my category",
        draft: withdrawal({ payee: "Somebody", categoryId: theirCategory.id }),
      }),
    ).rejects.toThrow(/not one of yours/i);
  });

  it("renames and re-edits under an expected version", async () => {
    const created = await createTransactionTemplate(owner, {
      name: "Coffee",
      draft: withdrawal({ payee: "Cafe", fromAccountId: checkingId, amount: "4.00" }),
    });
    const renamed = await updateTransactionTemplate(owner, created.id, {
      name: "Morning coffee",
      expectedVersion: created.version,
    });
    expect(renamed.name).toBe("Morning coffee");
    expect(renamed.version).toBe(2);
    // A name-only change leaves the draft exactly as it was.
    expect(renamed.draft).toEqual(created.draft);

    await expect(
      updateTransactionTemplate(owner, created.id, {
        name: "Too late",
        expectedVersion: created.version,
      }),
    ).rejects.toThrow();

    const reshaped = await updateTransactionTemplate(owner, created.id, {
      draft: withdrawal({ payee: "Cafe", fromAccountId: checkingId }),
      expectedVersion: renamed.version,
    });
    expect("amount" in reshaped.draft).toBe(false);
    expect(reshaped.name).toBe("Morning coffee");
  });

  /**
   * The template holds account and category ids with no foreign key on purpose.
   * A key would cascade, so tidying up an old account would silently take the
   * saved template with it. What the person gets instead is a template that
   * survives, holding a reference the form drops when it no longer resolves.
   */
  it("survives the deletion of the account it names", async () => {
    const spare = await createAccount(owner, {
      name: "Closing soon",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    const created = await createTransactionTemplate(owner, {
      name: "Names a doomed account",
      draft: withdrawal({ payee: "Somebody", fromAccountId: spare.id }),
    });

    await deleteAccount(owner, spare.id, spare.version);

    const survivor = await getTransactionTemplate(owner, created.id);
    expect(survivor.draft.fromAccountId).toBe(spare.id);
  });

  it("deletes on request, and refuses a stale delete", async () => {
    const created = await createTransactionTemplate(owner, {
      name: "Short lived",
      draft: withdrawal({ payee: "Somebody" }),
    });
    await expect(
      deleteTransactionTemplate(owner, created.id, created.version + 3),
    ).rejects.toThrow();
    expect(await getTransactionTemplate(owner, created.id)).toBeTruthy();

    expect(await deleteTransactionTemplate(owner, created.id, created.version)).toEqual(
      { id: created.id, deleted: true },
    );
    await expect(getTransactionTemplate(owner, created.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("cannot see, edit, or delete another tenant's template", async () => {
    const theirs = await createTransactionTemplate(stranger, {
      name: "Theirs alone",
      draft: withdrawal({ payee: "Their payee", fromAccountId: strangerAccountId }),
    });

    expect((await listTransactionTemplates(owner)).map((t) => t.name)).not.toContain(
      "Theirs alone",
    );
    await expect(getTransactionTemplate(owner, theirs.id)).rejects.toThrow(
      /not found/i,
    );
    await expect(
      updateTransactionTemplate(owner, theirs.id, {
        name: "Stolen",
        expectedVersion: theirs.version,
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      deleteTransactionTemplate(owner, theirs.id, theirs.version),
    ).rejects.toThrow(/not found/i);

    const stillTheirs = await getDb()
      .select()
      .from(transactionTemplates)
      .where(eq(transactionTemplates.id, theirs.id));
    expect(stillTheirs).toHaveLength(1);
    expect(stillTheirs[0]!.name).toBe("Theirs alone");
  });

  it("lists this tenant's templates by name", async () => {
    const listed = await listTransactionTemplates(owner);
    const names = listed.map((template) => template.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("Weekly shop");
    expect(names.every((name) => name !== "Theirs alone")).toBe(true);
  });

  it("takes a transfer template with both accounts", async () => {
    const created = await createTransactionTemplate(owner, {
      name: "Monthly saving",
      draft: {
        type: "transfer",
        payee: "To savings",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        amount: "200.00",
      },
    });
    expect(created.draft).toMatchObject({
      type: "transfer",
      fromAccountId: checkingId,
      toAccountId: savingsId,
      amount: "200.00",
    });
  });
});
