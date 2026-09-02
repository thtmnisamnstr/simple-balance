import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  bulkDeleteTransactions,
  bulkEditTransactions,
  createTransaction,
  getBulkTransactionSelection,
  getTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("bulk_transactions");
const actor: Actor = { userId: "integration-bulk-transactions", source: "web" };
const other: Actor = { userId: "integration-bulk-transactions-other", source: "web" };

function explicitSelection(rows: readonly { id: string; version: number }[]) {
  return {
    mode: "ids" as const,
    items: rows.map((row) => ({
      id: row.id,
      expectedVersion: row.version,
    })),
  };
}

integration("atomic committed transaction bulk editing", () => {
  let checkingId: string;
  let savingsId: string;
  let euroId: string;
  let otherAccountId: string;
  let bothCategoryId: string;
  let expenseCategoryId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().execute(sql`
      delete from auth_user
      where id in (${actor.userId}, ${other.userId})
    `);
    await getDb()
      .insert(user)
      .values([
        {
          id: actor.userId,
          name: "Bulk Transaction Tenant",
          email: "bulk-transactions@example.com",
          emailVerified: true,
        },
        {
          id: other.userId,
          name: "Other Bulk Transaction Tenant",
          email: "bulk-transactions-other@example.com",
          emailVerified: true,
        },
      ]);
    const [checking, savings, euro, otherAccount] = await Promise.all([
      createAccount(actor, {
        name: "Bulk Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
      createAccount(actor, {
        name: "Bulk Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
      createAccount(actor, {
        name: "Bulk Euro",
        type: "cash",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
      createAccount(other, {
        name: "Other Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      }),
    ]);
    checkingId = checking.id;
    savingsId = savings.id;
    euroId = euro.id;
    otherAccountId = otherAccount.id;
    bothCategoryId = (await createCategory(actor, { name: "Bulk Both", kind: "both" })).id;
    expenseCategoryId = (await createCategory(actor, { name: "Bulk Expense", kind: "expense" })).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  it("soft-deletes a selection atomically and idempotently", async () => {
    const first = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-06-01",
        payee: "Bulk delete one",
        description: null,
        fromAccountId: checkingId,
        amount: "31",
        externalId: "bulk-delete-one",
      },
      "bulk-delete-one",
    );
    const second = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-06-02",
        payee: "Bulk delete two",
        description: null,
        fromAccountId: checkingId,
        amount: "32",
        externalId: "bulk-delete-two",
      },
      "bulk-delete-two",
    );

    const preview = await bulkDeleteTransactions(actor, {
      selection: explicitSelection([first, second]),
      idempotencyKey: "bulk-delete-dry",
      dryRun: true,
    });
    expect(preview.updatedCount).toBe(2);
    expect((await getTransaction(actor, first.id)).deletedAt).toBeNull();

    const result = await bulkDeleteTransactions(actor, {
      selection: explicitSelection([first, second]),
      idempotencyKey: "bulk-delete-live",
      dryRun: false,
    });
    expect(result.updatedCount).toBe(2);
    const deletedFirst = await getTransaction(actor, first.id);
    const deletedSecond = await getTransaction(actor, second.id);
    expect(deletedFirst.deletedAt).not.toBeNull();
    expect(deletedSecond.deletedAt).not.toBeNull();
    expect(deletedFirst.version).toBe(first.version + 1);

    // Replaying the same key must not bump versions a second time, and the
    // same selection listed in a different order is the same selection. That
    // second half is the reason the key is matched against what the service
    // normalised rather than against the request as it arrived: a caller
    // retrying after a dropped connection has no reason to preserve the order
    // it sent, and being told CONFLICT would leave it unable to tell a retry
    // from a genuine clash.
    const replay = await bulkDeleteTransactions(actor, {
      selection: explicitSelection([second, first]),
      idempotencyKey: "bulk-delete-live",
      dryRun: false,
    });
    expect(replay).toEqual(result);
    expect((await getTransaction(actor, first.id)).version).toBe(first.version + 1);
  });

  it("refuses a stale selection and writes nothing", async () => {
    const row = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-06-03",
        payee: "Bulk delete stale",
        description: null,
        fromAccountId: checkingId,
        amount: "33",
        externalId: "bulk-delete-stale",
      },
      "bulk-delete-stale",
    );

    await expect(
      bulkDeleteTransactions(actor, {
        selection: {
          mode: "ids" as const,
          items: [{ id: row.id, expectedVersion: row.version + 5 }],
        },
        idempotencyKey: "bulk-delete-stale-key",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect((await getTransaction(actor, row.id)).deletedAt).toBeNull();
  });

  it("leaves an already deleted row untouched", async () => {
    const row = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-06-04",
        payee: "Bulk delete repeat",
        description: null,
        fromAccountId: checkingId,
        amount: "34",
        externalId: "bulk-delete-repeat",
      },
      "bulk-delete-repeat",
    );
    const deleted = await setTransactionDeleted(actor, row.id, row.version, true);

    const result = await bulkDeleteTransactions(actor, {
      selection: explicitSelection([deleted]),
      idempotencyKey: "bulk-delete-repeat-key",
      dryRun: false,
    });

    // Nothing to delete, so the row keeps the version the first delete gave it.
    expect(result.updatedCount).toBe(0);
    expect((await getTransaction(actor, row.id)).version).toBe(deleted.version);
  });

  it("dry-runs and idempotently updates every supported field with rebuilt postings", async () => {
    const first = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-01-01",
        payee: "Bulk original one",
        description: "Original one",
        fromAccountId: checkingId,
        amount: "11",
        externalId: "bulk-original-one",
      },
      "bulk-original-one",
    );
    const second = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-01-02",
        payee: "Bulk original two",
        description: "Original two",
        fromAccountId: checkingId,
        amount: "22",
        externalId: "bulk-original-two",
      },
      "bulk-original-two",
    );
    const input = {
      selection: explicitSelection([first, second]),
      patch: {
        date: "2027-01-10",
        payee: "Mass merchant",
        categoryId: bothCategoryId,
        accountId: savingsId,
        description: "Mass description",
        notes: "Mass notes",
        type: "deposit" as const,
      },
      idempotencyKey: "bulk-edit-every-field",
      allowDuplicates: false,
    };

    const preview = await bulkEditTransactions(actor, {
      ...input,
      dryRun: true,
    });
    expect(preview).toMatchObject({
      updatedCount: 2,
      selectionCount: 2,
      activeCount: 2,
      deletedCount: 0,
      transferCount: 0,
      currencies: ["USD"],
      dryRun: true,
      itemsTruncated: false,
    });
    expect(preview.items).toHaveLength(2);
    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.id,
          previousVersion: first.version,
          nextVersion: first.version + 1,
          type: "deposit",
        }),
        expect.objectContaining({
          id: second.id,
          previousVersion: second.version,
          nextVersion: second.version + 1,
          type: "deposit",
        }),
      ]),
    );
    expect(await getTransaction(actor, first.id)).toMatchObject({
      version: first.version,
      payee: first.payee,
    });
    const dryRunRecords = await getDb().execute(sql`
      select count(*)::int as count
      from idempotency_record
      where user_id = ${actor.userId}
        and operation = 'transaction.bulk_edit'
        and key = ${input.idempotencyKey}
    `);
    expect(Number(dryRunRecords.rows[0]?.count)).toBe(0);

    const updated = await bulkEditTransactions(actor, input);
    const retried = await bulkEditTransactions(actor, input);
    expect(retried).toEqual(updated);
    await expect(
      bulkEditTransactions(actor, {
        ...input,
        patch: { ...input.patch, notes: "Different request" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    for (const [created, amount] of [
      [first, "11"],
      [second, "22"],
    ] as const) {
      expect(await getTransaction(actor, created.id)).toMatchObject({
        type: "deposit",
        date: "2027-01-10",
        payee: "Mass merchant",
        description: "Mass description",
        notes: "Mass notes",
        categoryId: bothCategoryId,
        destinationAccountId: savingsId,
        destinationAmount: amount,
        sourceAccountId: null,
        sourceAmount: null,
        externalId: created.externalId,
        version: created.version + 1,
      });
    }
    // Postings are append-only, so the edit leaves the original rows in place
    // and adds reversals plus the new set. What matters is the net position and
    // that every currency still settles to zero.
    const postingRows = await getDb().execute(sql`
      select transaction_id, account_id, sum(amount)::text as amount
      from posting
      where user_id = ${actor.userId}
        and transaction_id in (${first.id}::uuid, ${second.id}::uuid)
      group by transaction_id, account_id
      having sum(amount) <> 0
      order by transaction_id
    `);
    expect(postingRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_id: savingsId, amount: "11.000000000000000000" }),
        expect.objectContaining({ account_id: savingsId, amount: "22.000000000000000000" }),
      ]),
    );
    const perCurrency = await getDb().execute(sql`
      select currency, sum(amount)::text as total
      from posting
      where user_id = ${actor.userId}
        and transaction_id in (${first.id}::uuid, ${second.id}::uuid)
      group by currency
    `);
    expect(perCurrency.rows).toEqual([{ currency: "USD", total: "0.000000000000000000" }]);
    const audits = await getDb().execute(sql`
      select entity_id, operation
      from audit_event
      where user_id = ${actor.userId}
        and entity_id in (${first.id}, ${second.id})
        and operation = 'bulk_update'
      order by entity_id
    `);
    expect(audits.rows).toEqual(
      [
        { entity_id: first.id, operation: "bulk_update" },
        { entity_id: second.id, operation: "bulk_update" },
      ].sort((left, right) => left.entity_id.localeCompare(right.entity_id)),
    );
  });

  /**
   * The other half of the refund refusal. Patching a category that runs
   * against the rows' direction was already refused; patching a *direction*
   * that runs against the rows' retained categories is the identical reversal
   * arriving through the other field, and for a while it went through
   * silently — every deposit carrying an income category flipped into a
   * refund, moving money between the two counter-accounts for rows nobody
   * looked at.
   */
  it("refuses a type flip that would turn retained categories into refunds", async () => {
    const incomeCategoryId = (await createCategory(actor, { name: "Bulk Income", kind: "income" }))
      .id;
    const paycheck = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-03-01",
        payee: "Refund flip employer",
        description: null,
        toAccountId: checkingId,
        categoryId: incomeCategoryId,
        amount: "500",
      },
      "bulk-refund-flip-deposit",
    );
    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([paycheck]),
        patch: { type: "withdrawal" as const },
        idempotencyKey: "bulk-refund-flip",
        allowDuplicates: true,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { fields: ["type"], reversedCount: 1 },
    });
    // Refused means untouched: same type, same version, nothing reposted.
    expect(await getTransaction(actor, paycheck.id)).toMatchObject({
      type: "deposit",
      version: paycheck.version,
    });

    // A row whose category agrees with the new direction still flips: the
    // refusal is about reversals, not about the type field.
    const spend = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-03-02",
        payee: "Refund flip shop",
        description: null,
        toAccountId: checkingId,
        categoryId: bothCategoryId,
        amount: "40",
      },
      "bulk-refund-flip-both",
    );
    const flipped = await bulkEditTransactions(actor, {
      selection: explicitSelection([spend]),
      patch: { type: "withdrawal" as const },
      idempotencyKey: "bulk-refund-flip-allowed",
      allowDuplicates: true,
    });
    expect(flipped.updatedCount).toBe(1);
    expect(await getTransaction(actor, spend.id)).toMatchObject({ type: "withdrawal" });
  });

  it("rejects transfer conversion and cross-currency reassignment atomically", async () => {
    const transfer = await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2027-01-20",
        payee: "Bulk FX transfer",
        description: null,
        fromAccountId: checkingId,
        toAccountId: euroId,
        sourceAmount: "25",
        destinationAmount: "20",
      },
      "bulk-fx-transfer",
    );
    const ordinary = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-01-21",
        payee: "Bulk ordinary rollback",
        description: null,
        fromAccountId: checkingId,
        amount: "9",
      },
      "bulk-ordinary-rollback",
    );
    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([transfer, ordinary]),
        patch: { type: "deposit" },
        idempotencyKey: "bulk-transfer-conversion-rejected",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await bulkEditTransactions(actor, {
      selection: explicitSelection([transfer]),
      patch: {
        date: "2027-01-25",
        payee: "Updated FX transfer",
        description: "Common fields only",
        notes: "FX shape preserved",
        categoryId: bothCategoryId,
      },
      idempotencyKey: "bulk-transfer-common-fields",
    });
    const transferAfterCommon = await getTransaction(actor, transfer.id);
    expect(transferAfterCommon).toMatchObject({
      type: "transfer",
      date: "2027-01-25",
      payee: "Updated FX transfer",
      description: "Common fields only",
      notes: "FX shape preserved",
      categoryId: bothCategoryId,
      sourceAccountId: checkingId,
      destinationAccountId: euroId,
      sourceAmount: "25",
      destinationAmount: "20",
      sourceCurrency: "USD",
      destinationCurrency: "EUR",
      effectiveRate: "0.8",
      version: transfer.version + 1,
    });
    const transferPostings = await getDb().execute(sql`
      select account_id, amount::text, currency
      from posting
      where user_id = ${actor.userId}
        and transaction_id = ${transfer.id}::uuid
      order by account_id
    `);
    expect(transferPostings.rows).toEqual(
      expect.arrayContaining([
        {
          account_id: checkingId,
          amount: "-25.000000000000000000",
          currency: "USD",
        },
        {
          account_id: euroId,
          amount: "20.000000000000000000",
          currency: "EUR",
        },
      ]),
    );
    expect(await getTransaction(actor, ordinary.id)).toMatchObject({
      type: "withdrawal",
      version: ordinary.version,
    });
    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([transferAfterCommon]),
        patch: { accountId: savingsId },
        idempotencyKey: "bulk-transfer-account-rejected",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const first = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-01-22",
        payee: "Currency rollback one",
        description: null,
        toAccountId: checkingId,
        amount: "31",
      },
      "bulk-currency-rollback-one",
    );
    const second = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-01-23",
        payee: "Currency rollback two",
        description: null,
        toAccountId: checkingId,
        amount: "32",
      },
      "bulk-currency-rollback-two",
    );
    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([first, second]),
        patch: { accountId: euroId, notes: "must roll back" },
        idempotencyKey: "bulk-cross-currency-rejected",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { previousCurrency: "USD", targetCurrency: "EUR" },
    });
    expect(await getTransaction(actor, first.id)).toMatchObject({
      destinationAccountId: checkingId,
      notes: null,
      version: first.version,
    });
    expect(await getTransaction(actor, second.id)).toMatchObject({
      destinationAccountId: checkingId,
      notes: null,
      version: second.version,
    });

    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([ordinary, first]),
        patch: {
          categoryId: expenseCategoryId,
          notes: "Category validation must roll back",
        },
        idempotencyKey: "bulk-category-kind-rollback",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await getTransaction(actor, ordinary.id)).toMatchObject({
      categoryId: null,
      notes: null,
      version: ordinary.version,
    });
    expect(await getTransaction(actor, first.id)).toMatchObject({
      categoryId: null,
      notes: null,
      version: first.version,
    });
  });

  it("protects all-results selections with an exact filter fingerprint", async () => {
    const excluded = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-02-01",
        payee: "Filter cohort excluded",
        description: null,
        fromAccountId: checkingId,
        amount: "41",
      },
      "bulk-filter-excluded",
    );
    const included = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-02-02",
        payee: "Filter cohort included",
        description: null,
        fromAccountId: checkingId,
        amount: "42",
      },
      "bulk-filter-included",
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-03-01",
        payee: "Filter cohort outside date",
        description: null,
        fromAccountId: checkingId,
        amount: "43",
      },
      "bulk-filter-outside-date",
    );
    const request = {
      filter: {
        start: "2027-02-01",
        end: "2027-02-28",
        accountId: checkingId,
        search: "Filter cohort",
        includeDeleted: false,
      },
      excludedIds: [excluded.id],
    };
    const firstSnapshot = await getBulkTransactionSelection(actor, request);
    expect(firstSnapshot).toMatchObject({
      count: 1,
      activeCount: 1,
      deletedCount: 0,
      transferCount: 0,
      currencies: ["USD"],
    });

    const addedAfterPreview = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-02-03",
        payee: "Filter cohort added later",
        description: null,
        fromAccountId: checkingId,
        amount: "44",
      },
      "bulk-filter-added-later",
    );
    await expect(
      bulkEditTransactions(actor, {
        selection: {
          mode: "filter",
          ...request,
          expectedCount: firstSnapshot.count,
          expectedFingerprint: firstSnapshot.fingerprint,
        },
        patch: { notes: "Filtered update" },
        idempotencyKey: "bulk-filter-stale-preview",
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });

    const currentSnapshot = await getBulkTransactionSelection(actor, request);
    const updated = await bulkEditTransactions(actor, {
      selection: {
        mode: "filter",
        ...request,
        expectedCount: currentSnapshot.count,
        expectedFingerprint: currentSnapshot.fingerprint,
      },
      patch: { notes: "Filtered update" },
      idempotencyKey: "bulk-filter-current-preview",
    });
    expect(updated).toMatchObject({
      selectionCount: 2,
      updatedCount: 2,
      itemsTruncated: false,
      selectionFingerprint: currentSnapshot.fingerprint,
    });
    expect(await getTransaction(actor, excluded.id)).toMatchObject({ notes: null });
    expect(await getTransaction(actor, included.id)).toMatchObject({
      notes: "Filtered update",
      version: included.version + 1,
    });
    expect(await getTransaction(actor, addedAfterPreview.id)).toMatchObject({
      notes: "Filtered update",
      version: addedAfterPreview.version + 1,
    });

    const emptySnapshot = await getBulkTransactionSelection(actor, {
      filter: { start: "2099-01-01", end: "2099-01-01" },
      excludedIds: [],
    });
    expect(emptySnapshot).toMatchObject({ count: 0, currencies: [] });
    await expect(
      bulkEditTransactions(actor, {
        selection: {
          mode: "filter",
          filter: { start: "2099-01-01", end: "2099-01-01" },
          excludedIds: [],
          expectedCount: emptySnapshot.count,
          expectedFingerprint: emptySnapshot.fingerprint,
        },
        patch: { notes: "Nothing" },
        idempotencyKey: "bulk-filter-empty",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Select at least one transaction",
    });
  });

  it("detects final duplicates within and outside the selection unless overridden", async () => {
    const first = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-04-01",
        payee: "Duplicate bulk first",
        description: null,
        fromAccountId: checkingId,
        amount: "51",
      },
      "bulk-duplicate-first",
    );
    const second = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-04-02",
        payee: "Duplicate bulk second",
        description: null,
        fromAccountId: checkingId,
        amount: "51",
      },
      "bulk-duplicate-second",
    );
    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([first, second]),
        patch: { date: "2027-04-10", payee: "Same final duplicate" },
        idempotencyKey: "bulk-within-duplicate-rejected",
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    expect(await getTransaction(actor, first.id)).toMatchObject({
      date: first.date,
      version: first.version,
    });
    expect(await getTransaction(actor, second.id)).toMatchObject({
      date: second.date,
      version: second.version,
    });

    const existing = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-04-20",
        payee: "Unselected collision",
        description: null,
        toAccountId: checkingId,
        amount: "52",
      },
      "bulk-unselected-collision",
    );
    const selected = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-04-21",
        payee: "Selected collision source",
        description: null,
        toAccountId: checkingId,
        amount: "52",
      },
      "bulk-selected-collision-source",
    );
    const collisionInput = {
      selection: explicitSelection([selected]),
      patch: { date: existing.date, payee: existing.payee },
      idempotencyKey: "bulk-unselected-duplicate-rejected",
    };
    await expect(bulkEditTransactions(actor, collisionInput)).rejects.toMatchObject({
      code: "DUPLICATE",
      details: { duplicateOfId: existing.id },
    });
    const overridden = await bulkEditTransactions(actor, {
      ...collisionInput,
      idempotencyKey: "bulk-unselected-duplicate-overridden",
      allowDuplicates: true,
    });
    expect(overridden.updatedCount).toBe(1);
  });

  it("rejects stale or cross-tenant explicit selections without partial updates", async () => {
    const owned = await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2027-05-01",
        payee: "Owned bulk tenant row",
        description: null,
        toAccountId: checkingId,
        amount: "61",
      },
      "bulk-owned-tenant-row",
    );
    const otherRow = await createTransaction(
      other,
      {
        type: "deposit",
        date: "2027-05-01",
        payee: "Other bulk tenant row",
        description: null,
        toAccountId: otherAccountId,
        amount: "62",
      },
      "bulk-other-tenant-row",
    );
    await expect(
      bulkEditTransactions(actor, {
        selection: explicitSelection([owned, otherRow]),
        patch: { notes: "Must not leak" },
        idempotencyKey: "bulk-cross-tenant-rejected",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await getTransaction(actor, owned.id)).toMatchObject({
      notes: null,
      version: owned.version,
    });

    await expect(
      bulkEditTransactions(actor, {
        selection: {
          mode: "ids",
          items: [{ id: owned.id, expectedVersion: owned.version + 1 }],
        },
        patch: { notes: "Must remain stale" },
        idempotencyKey: "bulk-stale-explicit-rejected",
      }),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(await getTransaction(actor, owned.id)).toMatchObject({
      notes: null,
      version: owned.version,
    });
  });

  it("keeps deleted selections deleted and excludes them from duplicate checks", async () => {
    const active = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-06-01",
        payee: "Deleted duplicate active",
        description: null,
        fromAccountId: checkingId,
        amount: "71",
      },
      "bulk-deleted-duplicate-active",
    );
    const createdDeleted = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-06-02",
        payee: "Deleted duplicate source",
        description: null,
        fromAccountId: checkingId,
        amount: "71",
      },
      "bulk-deleted-duplicate-source",
    );
    const deleted = await setTransactionDeleted(
      actor,
      createdDeleted.id,
      createdDeleted.version,
      true,
    );
    const result = await bulkEditTransactions(actor, {
      selection: explicitSelection([deleted]),
      patch: { date: active.date, payee: active.payee },
      idempotencyKey: "bulk-deleted-duplicate-ignored",
    });
    expect(result).toMatchObject({ activeCount: 0, deletedCount: 1 });
    expect(await getTransaction(actor, deleted.id)).toMatchObject({
      deletedAt: expect.any(String),
      date: active.date,
      payee: active.payee,
      version: deleted.version + 1,
    });
  });
});
