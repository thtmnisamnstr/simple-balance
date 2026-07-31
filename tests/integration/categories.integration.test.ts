import { and, eq, inArray } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  auditEvents,
  categories,
  stagedTransactions,
  transactions,
  user,
} from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import {
  createCategory,
  deleteCategory,
  listDuplicateCategories,
  mergeCategories,
  setCategoryArchived,
  updateCategory,
} from "../../src/server/services/categories.js";
import {
  commitStages,
  createStage,
  deleteStages,
} from "../../src/server/services/staging.js";
import {
  createTransaction,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_categories_${process.pid}_${Date.now()}`;
const primary: Actor = {
  userId: "category-integration-primary",
  source: "web",
};
const other: Actor = {
  userId: "category-integration-other",
  source: "mcp",
  clientId: "category-integration-client",
};
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let accountId: string;

integration("category duplicate detection and merge", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);

    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();

    const db = getDb();
    await db.insert(user).values([
      {
        id: primary.userId,
        name: "Category Primary",
        email: "category-primary@example.com",
        emailVerified: true,
      },
      {
        id: other.userId,
        name: "Category Other",
        email: "category-other@example.com",
        emailVerified: true,
      },
    ]);
    const account = await createAccount(primary, {
      name: "Category Test Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    accountId = account.id;
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

  it("rejects normalized duplicates on create and update", async () => {
    const dining = await createCategory(primary, {
      name: "Dining Out",
      kind: "expense",
    });

    await expect(
      createCategory(primary, {
        name: "  DINING   OUT  ",
        kind: "expense",
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE",
      details: {
        duplicateCategoryId: dining.id,
        normalizedName: "dining out",
      },
    });

    const utilities = await createCategory(primary, {
      name: "Utilities",
      kind: "expense",
    });
    const mobile = await createCategory(primary, {
      name: "Mobile Service",
      kind: "expense",
    });
    await expect(
      updateCategory(primary, mobile.id, {
        name: " utilities ",
        expectedVersion: mobile.version,
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE",
      details: {
        duplicateCategoryId: utilities.id,
        normalizedName: "utilities",
      },
    });

    const [mobileAfter] = await getDb()
      .select()
      .from(categories)
      .where(eq(categories.id, mobile.id));
    expect(mobileAfter).toMatchObject({
      name: "Mobile Service",
      version: mobile.version,
    });
  });

  it("rejects category kind changes that would invalidate committed or staged use", async () => {
    const category = await createCategory(primary, {
      name: "Kind invariant",
      kind: "both",
    });
    await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-08-01",
        description: "Committed category kind invariant",
        toAccountId: accountId,
        amount: "10",
        categoryId: category.id,
      },
      "category-kind-committed",
    );
    await createStage(primary, {
      draft: {
        type: "deposit",
        date: "2026-08-02",
        description: "Staged category kind invariant",
        toAccountId: accountId,
        amount: "5",
        categoryId: category.id,
      },
      idempotencyKey: "category-kind-staged",
    });

    await expect(
      updateCategory(primary, category.id, {
        kind: "expense",
        expectedVersion: category.version,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        incompatibleType: "deposit",
        transactionCount: 1,
        stagedTransactionCount: 1,
      },
    });

    const [unchanged] = await getDb()
      .select()
      .from(categories)
      .where(eq(categories.id, category.id));
    expect(unchanged).toMatchObject({
      kind: "both",
      version: category.version,
    });

    await expect(
      updateCategory(primary, category.id, {
        kind: "income",
        expectedVersion: category.version,
      }),
    ).resolves.toMatchObject({
      kind: "income",
      version: category.version + 1,
    });
  });

  it("blocks category archival with active stages and prevents new archived use", async () => {
    const category = await createCategory(primary, {
      name: "Archived category invariant",
      kind: "income",
    });
    const committed = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-08-03",
        description: "Historic archived category use",
        toAccountId: accountId,
        amount: "20",
        categoryId: category.id,
      },
      "archived-category-historic",
    );
    const activeStage = await createStage(primary, {
      draft: {
        type: "deposit",
        date: "2026-08-04",
        description: "Active archived category guard",
        toAccountId: accountId,
        amount: "2",
        categoryId: category.id,
      },
      idempotencyKey: "archived-category-active-stage",
    });

    await expect(
      setCategoryArchived(primary, category.id, category.version, true),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await deleteStages(primary, {
      stagedIds: [activeStage.id],
      expectedVersions: { [activeStage.id]: activeStage.version },
    });
    const archived = await setCategoryArchived(
      primary,
      category.id,
      category.version,
      true,
    );
    expect(archived.archivedAt).not.toBeNull();

    await expect(
      updateTransaction(primary, committed.id, {
        draft: {
          type: "deposit",
          date: committed.date,
          description: "Edited historic archived category use",
          toAccountId: accountId,
          amount: committed.destinationAmount!,
          categoryId: category.id,
        },
        expectedVersion: committed.version,
      }),
    ).resolves.toMatchObject({
      categoryId: category.id,
      description: "Edited historic archived category use",
    });

    await expect(
      createTransaction(
        primary,
        {
          type: "deposit",
          date: "2026-08-05",
          description: "New archived category use",
          toAccountId: accountId,
          amount: "3",
          categoryId: category.id,
        },
        "archived-category-new-transaction",
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const invalidStage = await createStage(primary, {
      draft: {
        type: "deposit",
        date: "2026-08-06",
        description: "New staged archived category use",
        toAccountId: accountId,
        amount: "4",
        categoryId: category.id,
      },
      idempotencyKey: "archived-category-invalid-stage",
    });
    expect(invalidStage.validationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "Category is unavailable" }),
      ]),
    );
    await expect(
      commitStages(primary, {
        stagedIds: [invalidStage.id],
        expectedVersions: { [invalidStage.id]: invalidStage.version },
        idempotencyKey: "archived-category-invalid-commit",
        allowDuplicates: false,
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("atomically merges committed and staged references with versions and audit history", async () => {
    const db = getDb();
    const [target, source] = await db
      .insert(categories)
      .values([
        {
          userId: primary.userId,
          name: "Household Supplies",
          kind: "expense",
        },
        {
          userId: primary.userId,
          name: " household   supplies ",
          kind: "income",
        },
      ])
      .returning();

    const duplicateGroups = await listDuplicateCategories(primary);
    expect(duplicateGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedName: "household supplies",
          count: 2,
          categories: expect.arrayContaining([
            expect.objectContaining({ id: target.id }),
            expect.objectContaining({ id: source.id }),
          ]),
        }),
      ]),
    );

    const committed = await createTransaction(
      primary,
      {
        type: "deposit",
        date: "2026-07-28",
        description: "Category merge committed reference",
        toAccountId: accountId,
        amount: "25",
        categoryId: source.id,
      },
      "category-merge-committed",
    );
    const staged = await createStage(primary, {
      draft: {
        type: "deposit",
        date: "2026-07-29",
        description: "Category merge staged reference",
        toAccountId: accountId,
        amount: "15",
        categoryId: source.id,
      },
      rawData: {
        source: "bank.csv",
        originalCategory: " household   supplies ",
      },
      idempotencyKey: "category-merge-staged",
    });

    await expect(
      deleteCategory(primary, source.id, source.version),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        transactionCount: 1,
        stagedTransactionCount: 1,
      },
    });

    const result = await mergeCategories(primary, {
      sourceCategoryIds: [source.id],
      targetCategoryId: target.id,
      expectedVersions: { [source.id]: source.version },
      targetExpectedVersion: target.version,
    });
    expect(result).toMatchObject({
      targetCategory: {
        id: target.id,
        kind: "both",
        version: target.version + 1,
      },
      mergedSourceCategoryIds: [source.id],
      updatedTransactionCount: 1,
      updatedStagedTransactionCount: 1,
    });

    const [targetAfter] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, target.id));
    expect(targetAfter).toMatchObject({
      kind: "both",
      version: target.version + 1,
    });
    expect(
      await db.select().from(categories).where(eq(categories.id, source.id)),
    ).toHaveLength(0);

    const [transactionAfter] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, committed.id));
    expect(transactionAfter).toMatchObject({
      categoryId: target.id,
      version: committed.version + 1,
    });

    const [stageAfter] = await db
      .select()
      .from(stagedTransactions)
      .where(eq(stagedTransactions.id, staged.id));
    expect(stageAfter).toMatchObject({
      version: staged.version + 1,
      rawData: {
        source: "bank.csv",
        originalCategory: " household   supplies ",
      },
    });
    expect(stageAfter.draft).toMatchObject({ categoryId: target.id });

    const mergeEvents = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, primary.userId),
          inArray(auditEvents.entityId, [
            target.id,
            source.id,
            committed.id,
            staged.id,
          ]),
        ),
      );
    expect(
      mergeEvents.map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        operation: event.operation,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          entityType: "category",
          entityId: target.id,
          operation: "merge",
        },
        {
          entityType: "category",
          entityId: source.id,
          operation: "merge_into",
        },
        {
          entityType: "transaction",
          entityId: committed.id,
          operation: "category_merge",
        },
        {
          entityType: "staged_transaction",
          entityId: staged.id,
          operation: "category_merge",
        },
      ]),
    );

    const transactionMerge = mergeEvents.find(
      (event) =>
        event.entityId === committed.id &&
        event.operation === "category_merge",
    );
    expect(transactionMerge?.before).toMatchObject({
      categoryId: source.id,
      version: committed.version,
    });
    expect(transactionMerge?.after).toMatchObject({
      categoryId: target.id,
      version: committed.version + 1,
    });

    const stagedMerge = mergeEvents.find(
      (event) =>
        event.entityId === staged.id &&
        event.operation === "category_merge",
    );
    expect(stagedMerge?.before).toMatchObject({
      draft: { categoryId: source.id },
      version: staged.version,
    });
    expect(stagedMerge?.after).toMatchObject({
      draft: { categoryId: target.id },
      version: staged.version + 1,
    });
  });

  it("rolls back stale merges and cannot cross tenant boundaries", async () => {
    const staleTarget = await createCategory(primary, {
      name: "Stale Merge Target",
      kind: "expense",
    });
    const staleSource = await createCategory(primary, {
      name: "Stale Merge Source",
      kind: "expense",
    });

    await expect(
      mergeCategories(primary, {
        sourceCategoryIds: [staleSource.id],
        targetCategoryId: staleTarget.id,
        expectedVersions: { [staleSource.id]: staleSource.version + 1 },
        targetExpectedVersion: staleTarget.version,
      }),
    ).rejects.toMatchObject({
      code: "STALE_VERSION",
      details: {
        categoryId: staleSource.id,
        currentVersion: staleSource.version,
      },
    });

    let persisted = await getDb()
      .select()
      .from(categories)
      .where(inArray(categories.id, [staleTarget.id, staleSource.id]));
    expect(persisted).toHaveLength(2);
    expect(
      persisted.every((category) => category.version === 1),
    ).toBe(true);

    const otherTarget = await createCategory(other, {
      name: "Other Tenant Target",
      kind: "expense",
    });
    await expect(
      mergeCategories(other, {
        sourceCategoryIds: [staleSource.id],
        targetCategoryId: otherTarget.id,
        expectedVersions: { [staleSource.id]: staleSource.version },
        targetExpectedVersion: otherTarget.version,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    persisted = await getDb()
      .select()
      .from(categories)
      .where(
        inArray(categories.id, [
          staleTarget.id,
          staleSource.id,
          otherTarget.id,
        ]),
      );
    expect(persisted).toHaveLength(3);
    expect(
      persisted.find((category) => category.id === staleSource.id),
    ).toMatchObject({
      userId: primary.userId,
      version: staleSource.version,
    });
    expect(
      persisted.find((category) => category.id === otherTarget.id),
    ).toMatchObject({
      userId: other.userId,
      version: otherTarget.version,
    });

    const failedMergeAudits = await getDb()
      .select()
      .from(auditEvents)
      .where(
        and(
          inArray(auditEvents.entityId, [
            staleTarget.id,
            staleSource.id,
            otherTarget.id,
          ]),
          inArray(auditEvents.operation, ["merge", "merge_into"]),
        ),
      );
    expect(failedMergeAudits).toHaveLength(0);
  });

  it("serializes staged category references against deletion", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const category = await createCategory(primary, {
        name: `Concurrent category deletion ${attempt}`,
        kind: "income",
      });
      const [stageResult, deletionResult] = await Promise.allSettled([
        createStage(primary, {
          draft: {
            type: "deposit",
            date: "2026-08-10",
            description: `Concurrent category reference ${attempt}`,
            toAccountId: accountId,
            amount: "1",
            categoryId: category.id,
          },
          idempotencyKey: `concurrent-category-stage-${attempt}`,
        }),
        deleteCategory(primary, category.id, category.version),
      ]);

      expect(stageResult.status).toBe("fulfilled");
      if (stageResult.status !== "fulfilled") continue;
      if (deletionResult.status === "fulfilled") {
        expect(stageResult.value.validationIssues.length).toBeGreaterThan(0);
      } else {
        expect(deletionResult.reason).toMatchObject({ code: "CONFLICT" });
        expect(stageResult.value.validationIssues).toHaveLength(0);
      }
    }
  });

  it("either merges a concurrent staged category reference or marks it invalid", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const target = await createCategory(primary, {
        name: `Concurrent merge target ${attempt}`,
        kind: "income",
      });
      const source = await createCategory(primary, {
        name: `Concurrent merge source ${attempt}`,
        kind: "income",
      });
      const [stageResult, mergeResult] = await Promise.allSettled([
        createStage(primary, {
          draft: {
            type: "deposit",
            date: "2026-08-11",
            description: `Concurrent category merge ${attempt}`,
            toAccountId: accountId,
            amount: "1",
            categoryId: source.id,
          },
          idempotencyKey: `concurrent-category-merge-stage-${attempt}`,
        }),
        mergeCategories(primary, {
          sourceCategoryIds: [source.id],
          targetCategoryId: target.id,
          expectedVersions: { [source.id]: source.version },
          targetExpectedVersion: target.version,
        }),
      ]);

      expect(stageResult.status).toBe("fulfilled");
      expect(mergeResult.status).toBe("fulfilled");
      if (stageResult.status !== "fulfilled") continue;
      const [storedStage] = await getDb()
        .select()
        .from(stagedTransactions)
        .where(eq(stagedTransactions.id, stageResult.value.id));
      const issues = storedStage.validationIssues as unknown[];
      const draft = storedStage.draft as { categoryId?: string };
      if (issues.length === 0) {
        expect(draft.categoryId).toBe(target.id);
      } else {
        expect(draft.categoryId).toBe(source.id);
      }
    }
  });
});
