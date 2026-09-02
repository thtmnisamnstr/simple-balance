import { sql } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBudgetPlan,
  deleteBudgetEntry,
  deleteBudgetPlan,
  getBudgetPlan,
  getBudgetReport,
  listBudgetEntries,
  listBudgetPlans,
  setBudgetEntry,
  updateBudgetPlan,
} from "../../src/server/services/budgets.js";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccount,
  getAccountBalances,
  listAccounts,
  updateAccount,
} from "../../src/server/services/accounts.js";
import {
  createCategoryGroup,
  listCategoryGroups,
} from "../../src/server/services/category-groups.js";
import {
  createCategory,
  listCategories,
  updateCategory,
} from "../../src/server/services/categories.js";
import { listPayees } from "../../src/server/services/payees.js";
import { getSummary } from "../../src/server/services/summary.js";
import {
  bulkDeleteTransactions,
  bulkEditTransactions,
  createTransaction,
  getTransaction,
  listTransactions,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);

/**
 * Two people who have never met, sharing one deployment. Everything here is an
 * attempt by the second to reach the first's books using ids they should never
 * have been able to guess, plus the checks that they simply cannot see each
 * other by ordinary means.
 */
const alice: Actor = { userId: "tenant-alice", source: "web" };
const mallory: Actor = { userId: "tenant-mallory", source: "mcp", clientId: "test" };

const databaseName = `simple_balance_tenants_${process.pid}_${Date.now()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let aliceAccountId: string;
let aliceCategoryId: string;
let aliceTransactionId: string;
let aliceTransactionVersion: number;
let malloryAccountId: string;

integration("one tenant cannot reach another", () => {
  beforeAll(async () => {
    // A database of its own, so the cross-tenant checks below can be made
    // against every row rather than against the rows this file happens to know.
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();

    await getDb()
      .insert(user)
      .values([
        {
          id: alice.userId,
          name: "Alice",
          email: "alice@example.com",
          emailVerified: true,
        },
        {
          id: mallory.userId,
          name: "Mallory",
          email: "mallory@example.com",
          emailVerified: true,
        },
      ]);

    const account = await createAccount(alice, {
      name: "Alice Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "1000",
    });
    aliceAccountId = account.id;
    aliceCategoryId = (await createCategory(alice, { name: "Alice Groceries", kind: "expense" }))
      .id;
    const transaction = await createTransaction(
      alice,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Alice Only Payee",
        description: null,
        categoryId: aliceCategoryId,
        fromAccountId: aliceAccountId,
        amount: "40",
      },
      "tenant-alice-1",
    );
    aliceTransactionId = transaction.id;
    aliceTransactionVersion = transaction.version;

    malloryAccountId = (
      await createAccount(mallory, {
        name: "Mallory Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "5",
      })
    ).id;
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("shows each tenant only their own lists", async () => {
    const accounts = await listAccounts(mallory);
    expect(accounts.map((a) => a.name)).toEqual(["Mallory Checking"]);

    const categories = await listCategories(mallory);
    expect(categories.map((c) => c.name)).not.toContain("Alice Groceries");

    const transactions = await listTransactions(mallory, { limit: 100 });
    expect(transactions.items).toHaveLength(0);
    expect(transactions.totalCount).toBe(0);

    const payees = await listPayees(mallory);
    expect(payees.map((p) => p.name)).not.toContain("Alice Only Payee");
  });

  it("keeps each tenant's totals to themselves", async () => {
    const summary = await getSummary(mallory, {});
    const usd = summary.currencies.find((c) => c.currency === "USD");
    // Mallory opened with 5 and has spent nothing.
    expect(usd?.balance).toBe("5");
    expect(usd?.withdrawals).toBe("0");
    expect(usd?.accounts.map((a) => a.name)).toEqual(["Mallory Checking"]);
  });

  it("refuses reads of another tenant's records by id", async () => {
    await expect(getAccount(mallory, aliceAccountId)).rejects.toThrow(/not found/i);
    await expect(getTransaction(mallory, aliceTransactionId)).rejects.toThrow(/not found/i);
    await expect(getAccountBalances(mallory, aliceAccountId, {})).rejects.toThrow(/not found/i);
  });

  it("refuses writes to another tenant's records by id", async () => {
    await expect(
      updateAccount(mallory, aliceAccountId, {
        name: "Taken Over",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/not found/i);

    await expect(
      updateCategory(mallory, aliceCategoryId, {
        name: "Taken Over",
        expectedVersion: 1,
      }),
    ).rejects.toThrow(/not found/i);

    await expect(
      updateTransaction(mallory, aliceTransactionId, {
        draft: {
          type: "withdrawal",
          date: "2026-02-01",
          payee: "Rewritten",
          description: null,
          fromAccountId: malloryAccountId,
          amount: "40",
        },
        expectedVersion: aliceTransactionVersion,
      }),
    ).rejects.toThrow(/not found/i);

    await expect(
      setTransactionDeleted(mallory, aliceTransactionId, aliceTransactionVersion, true),
    ).rejects.toThrow(/not found/i);
  });

  // The bulk paths take a list of ids rather than one, so a miss has to fail the
  // whole request rather than quietly skipping the rows it could not claim.
  // They report the miss in their own words; what matters is that it is the
  // not-found path and not, say, a validation complaint about the patch.
  it("refuses a bulk edit naming another tenant's rows", async () => {
    await expect(
      bulkEditTransactions(mallory, {
        selection: {
          mode: "ids",
          items: [{ id: aliceTransactionId, expectedVersion: aliceTransactionVersion }],
        },
        patch: { payee: "Rewritten in bulk" },
        idempotencyKey: "tenant-bulk-edit",
        dryRun: false,
      }),
    ).rejects.toThrow(/one or more transactions are unavailable/i);

    await expect(
      bulkDeleteTransactions(mallory, {
        selection: {
          mode: "ids",
          items: [{ id: aliceTransactionId, expectedVersion: aliceTransactionVersion }],
        },
        idempotencyKey: "tenant-bulk-delete",
        dryRun: false,
      }),
    ).rejects.toThrow(/one or more transactions are unavailable/i);
  });

  it("leaves the first tenant's books exactly as they were", async () => {
    const account = await getAccount(alice, aliceAccountId);
    expect(account.name).toBe("Alice Checking");
    expect(account.balance).toBe("960");

    const transaction = await getTransaction(alice, aliceTransactionId);
    expect(transaction.payee).toBe("Alice Only Payee");
    expect(transaction.deletedAt).toBeNull();
    expect(transaction.version).toBe(aliceTransactionVersion);
  });

  // Each tenant gets its own income, expense, exchange and equity accounts, so
  // one person's spending cannot land in another's income statement.
  it("gives each tenant their own counter-accounts", async () => {
    const rows = await getDb().execute(sql`
      select user_id, count(*)::int as total
      from ledger_account
      where system_kind is not null
        and user_id in (${alice.userId}, ${mallory.userId})
      group by user_id
      order by user_id
    `);
    expect(rows.rows).toHaveLength(2);

    const shared = await getDb().execute(sql`
      select count(*)::int as total from posting p
      join ledger_account a on a.id = p.account_id
      where p.user_id <> a.user_id
    `);
    expect(Number((shared.rows[0] as { total: number }).total)).toBe(0);
  });

  // Two people importing the same bank file must not collide, and one must not
  // be able to make the other's row look like a duplicate.
  it("keeps names and import references independent between tenants", async () => {
    await expect(
      createAccount(mallory, {
        name: "Alice Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
    ).resolves.toMatchObject({ name: "Alice Checking" });

    await expect(
      createCategory(mallory, { name: "Alice Groceries", kind: "expense" }),
    ).resolves.toMatchObject({ name: "Alice Groceries" });

    const external = "SHARED-STATEMENT-REF-1";
    await createTransaction(
      alice,
      {
        type: "withdrawal",
        date: "2027-03-01",
        payee: "Shared Ref",
        description: null,
        externalId: external,
        fromAccountId: aliceAccountId,
        amount: "11",
      },
      "tenant-alice-ext",
    );
    await expect(
      createTransaction(
        mallory,
        {
          type: "withdrawal",
          date: "2027-03-01",
          payee: "Shared Ref",
          description: null,
          externalId: external,
          fromAccountId: malloryAccountId,
          amount: "11",
        },
        "tenant-mallory-ext",
      ),
    ).resolves.toMatchObject({ externalId: external });
  });
  /**
   * Budgets were added without a single cross-tenant test, and a mutation audit
   * found eight scope predicates in `budgets.ts` that could be deleted with the
   * whole suite still green. Tenancy is the one thing AGENTS.md calls
   * non-negotiable, so it is checked here rather than trusted.
   */
  /**
   * The group link is the one cross-table reference here that is not composite.
   *
   * `on delete set null` sets every column of the constraint it is on, so the
   * usual `(user_id, id)` pair would null the tenant as well and fail against
   * `user_id not null`. The database therefore does not stop a category
   * pointing at somebody else's group; `resolveCategoryGroup` does, on the one
   * path that writes the column, and this is what holds it to that.
   */
  it("refuses to file a category under another tenant's group", async () => {
    const aliceGroup = await createCategoryGroup(alice, {
      name: "Alice fixed costs",
      policy: "standalone",
    });
    const malloryCategory = await createCategory(mallory, {
      name: "Mallory spending",
      kind: "expense",
    });

    await expect(
      updateCategory(mallory, malloryCategory.id, {
        expectedVersion: malloryCategory.version,
        groupId: aliceGroup.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createCategory(mallory, {
        name: "Mallory borrowed group",
        kind: "expense",
        groupId: aliceGroup.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createBudgetPlan(mallory, {
        groupId: aliceGroup.id,
        amount: "10.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2027-01-01",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await listCategoryGroups(mallory)).toEqual([]);
  });

  it("keeps budgets to the tenant that set them", async () => {
    const plan = await createBudgetPlan(alice, {
      categoryId: aliceCategoryId,
      amount: "250.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2027-01-01",
    });
    const entry = await setBudgetEntry(alice, {
      categoryId: aliceCategoryId,
      currency: "USD",
      periodUnit: "month",
      periodStart: "2027-02-01",
      amount: "90.00",
    });

    // Reading somebody else's by id is a 404, never a 403: the answer to
    // "does this exist" must not depend on who is asking.
    await expect(getBudgetPlan(mallory, plan.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      updateBudgetPlan(mallory, plan.id, {
        amount: "1.00",
        expectedVersion: plan.version,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(deleteBudgetPlan(mallory, plan.id, plan.version)).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteBudgetEntry(mallory, entry.id, entry.version)).rejects.toMatchObject({
      status: 404,
    });

    // Nothing of Alice's appears in a list or a report of Mallory's.
    expect(await listBudgetPlans(mallory)).toEqual([]);
    expect(await listBudgetEntries(mallory)).toEqual([]);
    const malloryReport = await getBudgetReport(mallory, {
      start: "2027-01-01",
      end: "2027-03-31",
      periodUnit: "month",
    });
    expect(malloryReport.periods.flatMap((period) => period.rows)).not.toContainEqual(
      expect.objectContaining({ limit: "250" }),
    );

    // And Alice still has both, so none of the refusals above was a delete.
    expect(await listBudgetPlans(alice)).toHaveLength(1);
    expect(await listBudgetEntries(alice)).toHaveLength(1);

    // Mallory cannot budget a category that is not theirs either.
    await expect(
      createBudgetPlan(mallory, {
        categoryId: aliceCategoryId,
        amount: "5.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2027-01-01",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
