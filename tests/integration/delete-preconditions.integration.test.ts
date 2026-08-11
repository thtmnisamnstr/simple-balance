import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
} from "../../src/server/services/accounts.js";
import {
  createCategory,
  deleteCategory,
} from "../../src/server/services/categories.js";
import { createRecurrence } from "../../src/server/services/recurrences.js";
import { createTransactionTemplate } from "../../src/server/services/transaction-templates.js";

const connection = process.env.TEST_DATABASE_URL;
const databaseName = `sb_delete_guards_${process.pid}`;
const actor: Actor = { userId: "delete-guards", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let key = 0;
const nextKey = () => `delete-guards-${(key += 1)}`;

/**
 * A recurrence's schedule and a template's draft both name accounts and
 * categories inside jsonb, where no foreign key can see them. Deleting what
 * they point at leaves a template that cannot be saved, or a schedule that
 * proposes a flagged row on every occurrence from here on with nothing on
 * screen saying why.
 */
describe.skipIf(!connection)("what stands in the way of a delete", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const url = new URL(connection!);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Guards",
      email: "guards@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const account = (name: string) =>
    createAccount(actor, {
      name,
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });

  it("refuses to delete a category a template names", async () => {
    const rent = await createCategory(actor, { name: "Rent", kind: "expense" });
    const home = await account("Template Category Checking");
    await createTransactionTemplate(actor, {
      name: "Monthly rent",
      draft: {
        type: "withdrawal",
        fromAccountId: home.id,
        categoryId: rent.id,
        payee: "Landlord",
      },
      idempotencyKey: nextKey(),
    });
    await expect(
      deleteCategory(actor, rent.id, rent.version),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { templateCount: 1 } });
  });

  it("refuses to delete a category a template's split leg names", async () => {
    const utilities = await createCategory(actor, {
      name: "Utilities",
      kind: "expense",
    });
    const water = await createCategory(actor, { name: "Water", kind: "expense" });
    const home = await account("Template Leg Checking");
    await createTransactionTemplate(actor, {
      name: "Split bill",
      draft: {
        type: "withdrawal",
        fromAccountId: home.id,
        payee: "Utility Co",
        amount: "90.00",
        legs: [
          { categoryId: utilities.id, amount: "60.00" },
          { categoryId: water.id, amount: "30.00" },
        ],
      },
      idempotencyKey: nextKey(),
    });
    await expect(
      deleteCategory(actor, utilities.id, utilities.version),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { templateCount: 1 } });
  });

  it("refuses to delete an account a recurrence names", async () => {
    const side = await account("Side Checking");
    await createRecurrence(actor, {
      name: "Side rent",
      shape: {
        type: "withdrawal",
        payee: "Landlord",
        fromAccountId: side.id,
        amount: "1200.00",
      },
      schedule: { frequency: "monthly", anchorDate: "2031-02-01" },
    });
    await expect(
      deleteAccount(actor, side.id, side.version),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { recurrenceCount: 1, templateCount: 0 },
    });
    expect(await getAccount(actor, side.id)).toMatchObject({ id: side.id });
  });

  it("refuses to delete an account a template names", async () => {
    const spare = await account("Spare Checking");
    await createTransactionTemplate(actor, {
      name: "Spare transfer",
      draft: { type: "withdrawal", fromAccountId: spare.id, payee: "Someone" },
      idempotencyKey: nextKey(),
    });
    await expect(
      deleteAccount(actor, spare.id, spare.version),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { templateCount: 1, recurrenceCount: 0 },
    });
  });

  it("still deletes an account nothing names", async () => {
    const unused = await account("Unused Checking");
    expect(await deleteAccount(actor, unused.id, unused.version)).toMatchObject({
      deleted: true,
    });
  });

  it("still deletes a category nothing names", async () => {
    const unused = await createCategory(actor, {
      name: "Never Used",
      kind: "expense",
    });
    expect(
      await deleteCategory(actor, unused.id, unused.version),
    ).toMatchObject({ deleted: true });
  });
});
