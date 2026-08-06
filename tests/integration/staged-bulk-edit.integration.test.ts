import { and, eq, inArray } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  auditEvents,
  stagedTransactions,
  user,
} from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  bulkEditStages,
  createStage,
  listStages,
  previewBulkStageSelection,
} from "../../src/server/services/staging.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_stagebulk_${process.pid}_${Date.now()}`;
const actor: Actor = { userId: "stage-bulk-user", source: "web" };
const stranger: Actor = { userId: "stage-bulk-stranger", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;
let accountId: string;
let otherAccountId: string;
let categoryId: string;

let keySeed = 0;
const nextKey = () => `stage-bulk-key-${(keySeed += 1)}`;

async function stage(draft: Record<string, unknown>) {
  const created = await createStage(actor, {
    idempotencyKey: nextKey(),
    draft,
  });
  return created as { id: string; version: number };
}

const rowsById = async (owner: Actor = actor) => {
  const rows = await getDb()
    .select()
    .from(stagedTransactions)
    .where(eq(stagedTransactions.userId, owner.userId));
  return new Map(rows.map((row) => [row.id, row]));
};

const idSelection = (entries: { id: string; version: number }[]) => ({
  mode: "ids" as const,
  items: entries.map((entry) => ({
    id: entry.id,
    expectedVersion: entry.version,
  })),
});

integration("changing many staged rows at once", () => {
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
        id: actor.userId,
        name: "Stage Bulk",
        email: "stage-bulk@example.com",
        emailVerified: true,
      },
      {
        id: stranger.userId,
        name: "Stranger",
        email: "stage-bulk-stranger@example.com",
        emailVerified: true,
      },
    ]);
    accountId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "5000",
      })
    ).id;
    otherAccountId = (
      await createAccount(actor, {
        name: "Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    categoryId = (
      await createCategory(actor, { name: "Groceries", kind: "expense" })
    ).id;
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("applies a patch to the rows named, and leaves the rest alone", async () => {
    const first = await stage({
      type: "withdrawal",
      date: "2026-02-01",
      payee: "Shop",
      amount: "10.00",
      fromAccountId: accountId,
    });
    const second = await stage({
      type: "withdrawal",
      date: "2026-02-02",
      payee: "Shop",
      amount: "20.00",
      fromAccountId: accountId,
    });
    const untouched = await stage({
      type: "withdrawal",
      date: "2026-02-03",
      payee: "Elsewhere",
      amount: "30.00",
      fromAccountId: accountId,
    });

    const result = await bulkEditStages(actor, {
      selection: idSelection([first, second]),
      patch: { categoryId, payee: "Corner Shop" },
      idempotencyKey: nextKey(),
    });
    expect(result.updatedCount).toBe(2);

    const rows = await rowsById();
    for (const entry of [first, second]) {
      const draft = rows.get(entry.id)!.draft as Record<string, unknown>;
      expect(draft.payee).toBe("Corner Shop");
      expect(draft.categoryId).toBe(categoryId);
      // Fields the patch did not mention are left exactly as they were.
      expect(draft.amount).toBe(entry.id === first.id ? "10.00" : "20.00");
      expect(rows.get(entry.id)!.version).toBe(entry.version + 1);
    }
    const other = rows.get(untouched.id)!.draft as Record<string, unknown>;
    expect(other.payee).toBe("Elsewhere");
    expect(rows.get(untouched.id)!.version).toBe(untouched.version);
  });

  // The whole point of editing the queue in bulk: a column the import could not
  // resolve is filled in for everything at once, and the rows stop being
  // invalid.
  it("revalidates, so fixing a batch clears its issues", async () => {
    const broken = await stage({
      type: "withdrawal",
      date: "2026-02-04",
      payee: "Needs An Account",
      amount: "15.00",
    });
    expect(
      ((await rowsById()).get(broken.id)!.validationIssues as unknown[]).length,
    ).toBeGreaterThan(0);

    const result = await bulkEditStages(actor, {
      selection: idSelection([broken]),
      patch: { accountId },
      idempotencyKey: nextKey(),
    });
    expect(result.invalidCount).toBe(0);
    expect(result.validCount).toBe(1);
    expect(
      ((await rowsById()).get(broken.id)!.validationIssues as unknown[]).length,
    ).toBe(0);
  });

  it("refuses the whole request when a row moved underneath", async () => {
    const row = await stage({
      type: "withdrawal",
      date: "2026-02-05",
      payee: "Stale",
      amount: "12.00",
      fromAccountId: accountId,
    });
    await expect(
      bulkEditStages(actor, {
        selection: idSelection([{ id: row.id, version: row.version + 5 }]),
        patch: { payee: "Never Applied" },
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow();
    const draft = (await rowsById()).get(row.id)!.draft as Record<string, unknown>;
    expect(draft.payee).toBe("Stale");
  });

  it("changes nothing at all when one row in the selection is stale", async () => {
    const good = await stage({
      type: "withdrawal",
      date: "2026-02-06",
      payee: "Good",
      amount: "1.00",
      fromAccountId: accountId,
    });
    const bad = await stage({
      type: "withdrawal",
      date: "2026-02-07",
      payee: "Bad",
      amount: "2.00",
      fromAccountId: accountId,
    });
    await expect(
      bulkEditStages(actor, {
        selection: idSelection([good, { id: bad.id, version: bad.version + 3 }]),
        patch: { payee: "Applied To Neither" },
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow();
    const rows = await rowsById();
    expect((rows.get(good.id)!.draft as Record<string, unknown>).payee).toBe("Good");
    expect(rows.get(good.id)!.version).toBe(good.version);
  });

  // A transfer has two accounts and no single one to move. Refused rather than
  // skipped, so the count of rows changed always matches what was selected.
  it("refuses account and type on a selection containing a transfer", async () => {
    const transfer = await stage({
      type: "transfer",
      date: "2026-02-08",
      payee: "Move",
      sourceAmount: "50.00",
      fromAccountId: accountId,
      toAccountId: otherAccountId,
    });
    await expect(
      bulkEditStages(actor, {
        selection: idSelection([transfer]),
        patch: { accountId: otherAccountId },
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow(/transfer/i);

    // The fields a transfer does share are fine.
    const ok = await bulkEditStages(actor, {
      selection: idSelection([transfer]),
      patch: { notes: "Checked" },
      idempotencyKey: nextKey(),
    });
    expect(ok.updatedCount).toBe(1);
  });

  // The alternative was writing the account nowhere and still counting the row
  // as updated, which reads as success and changes nothing.
  it("refuses an account on a row that has no type yet", async () => {
    const typeless = await stage({ date: "2026-02-20", payee: "Unreadable Line" });
    await expect(
      bulkEditStages(actor, {
        selection: idSelection([typeless]),
        patch: { accountId },
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow(/came in or went out/i);

    // Naming the type in the same edit is the way through.
    const fixed = await bulkEditStages(actor, {
      selection: idSelection([typeless]),
      patch: { accountId, type: "withdrawal" },
      idempotencyKey: nextKey(),
    });
    expect(fixed.updatedCount).toBe(1);
    const draft = (await rowsById()).get(typeless.id)!.draft as Record<string, unknown>;
    expect(draft.fromAccountId).toBe(accountId);
  });

  it("moves the account to the side the new type reads", async () => {
    const row = await stage({
      type: "withdrawal",
      date: "2026-02-09",
      payee: "Refund",
      amount: "40.00",
      fromAccountId: accountId,
    });
    await bulkEditStages(actor, {
      selection: idSelection([row]),
      patch: { type: "deposit" },
      idempotencyKey: nextKey(),
    });
    const draft = (await rowsById()).get(row.id)!.draft as Record<string, unknown>;
    expect(draft.type).toBe("deposit");
    expect(draft.toAccountId).toBe(accountId);
    expect(draft.fromAccountId).toBeUndefined();
  });

  it("says what it would do without doing it", async () => {
    const row = await stage({
      type: "withdrawal",
      date: "2026-02-10",
      payee: "Dry",
      amount: "7.00",
      fromAccountId: accountId,
    });
    const preview = await bulkEditStages(actor, {
      selection: idSelection([row]),
      patch: { payee: "Not Written" },
      idempotencyKey: nextKey(),
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.updatedCount).toBe(1);
    const after = (await rowsById()).get(row.id)!;
    expect((after.draft as Record<string, unknown>).payee).toBe("Dry");
    expect(after.version).toBe(row.version);
  });

  it("returns the first result when the same key is sent twice", async () => {
    const row = await stage({
      type: "withdrawal",
      date: "2026-02-11",
      payee: "Once",
      amount: "3.00",
      fromAccountId: accountId,
    });
    const key = nextKey();
    const first = await bulkEditStages(actor, {
      selection: idSelection([row]),
      patch: { payee: "Applied Once" },
      idempotencyKey: key,
    });
    const again = await bulkEditStages(actor, {
      selection: idSelection([row]),
      patch: { payee: "Applied Once" },
      idempotencyKey: key,
    });
    expect(again).toEqual(first);
    expect((await rowsById()).get(row.id)!.version).toBe(row.version + 1);
  });

  it("edits everything matching a view, and refuses when the set moved", async () => {
    const batch = await Promise.all([
      stage({
        type: "withdrawal",
        date: "2026-03-01",
        payee: "Filtered A",
        amount: "5.00",
        fromAccountId: accountId,
      }),
      stage({
        type: "withdrawal",
        date: "2026-03-02",
        payee: "Filtered B",
        amount: "6.00",
        fromAccountId: accountId,
      }),
    ]);
    const filter = { filter: { search: "Filtered" }, excludedIds: [] };
    const snapshot = await previewBulkStageSelection(actor, filter);
    expect(snapshot.count).toBe(2);

    // A row changing underneath makes the fingerprint stale, so the request is
    // refused rather than covering a different set than the one shown.
    await bulkEditStages(actor, {
      selection: idSelection([batch[0]]),
      patch: { notes: "moved" },
      idempotencyKey: nextKey(),
    });
    await expect(
      bulkEditStages(actor, {
        selection: {
          mode: "filter",
          filter: { search: "Filtered" },
          excludedIds: [],
          expectedCount: snapshot.count,
          expectedFingerprint: snapshot.fingerprint,
        },
        patch: { categoryId },
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow();

    // Re-resolved, it goes through and covers both.
    const fresh = await previewBulkStageSelection(actor, filter);
    const applied = await bulkEditStages(actor, {
      selection: {
        mode: "filter",
        filter: { search: "Filtered" },
        excludedIds: [],
        expectedCount: fresh.count,
        expectedFingerprint: fresh.fingerprint,
      },
      patch: { categoryId },
      idempotencyKey: nextKey(),
    });
    expect(applied.updatedCount).toBe(2);
    const rows = await rowsById();
    for (const entry of batch) {
      expect((rows.get(entry.id)!.draft as Record<string, unknown>).categoryId).toBe(
        categoryId,
      );
    }
  });

  it("cannot reach another tenant's staged rows", async () => {
    const theirs = await createStage(stranger, {
      idempotencyKey: nextKey(),
      draft: { type: "withdrawal", date: "2026-04-01", payee: "Theirs", amount: "9.00" },
    });
    await expect(
      bulkEditStages(actor, {
        selection: idSelection([theirs as { id: string; version: number }]),
        patch: { payee: "Stolen" },
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow(/unavailable/i);
    const stillTheirs = await rowsById(stranger);
    expect(
      (stillTheirs.get((theirs as { id: string }).id)!.draft as Record<string, unknown>)
        .payee,
    ).toBe("Theirs");
  });

  it("records what each row was and became", async () => {
    const row = await stage({
      type: "withdrawal",
      date: "2026-05-01",
      payee: "Audited",
      amount: "4.00",
      fromAccountId: accountId,
    });
    await bulkEditStages(actor, {
      selection: idSelection([row]),
      patch: { payee: "Audited And Renamed" },
      idempotencyKey: nextKey(),
    });
    const events = await getDb()
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, actor.userId),
          eq(auditEvents.entityId, row.id),
          eq(auditEvents.operation, "bulk_edit"),
        ),
      );
    expect(events).toHaveLength(1);
    const { before, after } = events[0]! as {
      before: { draft: Record<string, unknown> };
      after: { draft: Record<string, unknown>; version: number };
    };
    expect(before.draft.payee).toBe("Audited");
    expect(after.draft.payee).toBe("Audited And Renamed");
    expect(after.version).toBe(row.version + 1);
  });

  // The writes go out in chunks of 500, so a selection has to cross that
  // boundary for an off-by-one in the slicing to show up at all.
  it("covers a selection larger than one write chunk", async () => {
    const drafts = Array.from({ length: 620 }, (_, index) => ({
      userId: actor.userId,
      draft: {
        type: "withdrawal",
        date: "2026-06-01",
        payee: `Chunked ${index}`,
        amount: "1.00",
        fromAccountId: accountId,
      },
      validationIssues: [],
    }));
    const inserted = await getDb()
      .insert(stagedTransactions)
      .values(drafts)
      .returning({ id: stagedTransactions.id, version: stagedTransactions.version });

    const result = await bulkEditStages(actor, {
      selection: idSelection(inserted),
      patch: { categoryId, notes: "Filed in one go" },
      idempotencyKey: nextKey(),
    });
    expect(result.updatedCount).toBe(620);
    expect(result.items).toHaveLength(620);

    const rows = await rowsById();
    for (const entry of inserted) {
      const row = rows.get(entry.id)!;
      expect((row.draft as Record<string, unknown>).categoryId).toBe(categoryId);
      expect((row.draft as Record<string, unknown>).notes).toBe("Filed in one go");
      expect(row.version).toBe(entry.version + 1);
    }
    // One audit record per row, including the ones past the chunk boundary.
    const events = await getDb()
      .select({ entityId: auditEvents.entityId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.userId, actor.userId),
          eq(auditEvents.operation, "bulk_edit"),
          inArray(
            auditEvents.entityId,
            inserted.map((entry) => entry.id),
          ),
        ),
      );
    expect(new Set(events.map((event) => event.entityId)).size).toBe(620);
  });

  /**
   * A filter selection resolves the rows twice, once to show a count and a
   * fingerprint and once to write. Both go through one predicate, so a filter
   * the predicate does not implement widens the write to everything the view
   * did not exclude, and the fingerprint agrees because it described the same
   * wrong set.
   */
  it("scopes a filtered edit to the template it names", async () => {
    const templateA = "11111111-2222-4333-8444-555555555555";
    const templateB = "66666666-7777-4888-8999-000000000000";
    const mine = await stage({
      type: "withdrawal",
      date: "2026-04-01",
      payee: "From template A",
      fromAccountId: accountId,
      amount: "10.00",
      templateId: templateA,
    });
    const other = await stage({
      type: "withdrawal",
      date: "2026-04-01",
      payee: "From template B",
      fromAccountId: accountId,
      amount: "11.00",
      templateId: templateB,
    });
    const none = await stage({
      type: "withdrawal",
      date: "2026-04-01",
      payee: "From no template",
      fromAccountId: accountId,
      amount: "12.00",
    });

    const filter = { templateId: templateA };
    const preview = await previewBulkStageSelection(actor, {
      filter,
      excludedIds: [],
    });
    expect(preview.count).toBe(1);

    const result = await bulkEditStages(actor, {
      selection: {
        mode: "filter",
        filter,
        excludedIds: [],
        expectedCount: preview.count,
        expectedFingerprint: preview.fingerprint,
      },
      patch: { payee: "Rewritten" },
      idempotencyKey: nextKey(),
    });
    expect(result.updatedCount).toBe(1);

    const rows = await rowsById();
    const payeeOf = (id: string) =>
      (rows.get(id)!.draft as Record<string, unknown>).payee;
    expect(payeeOf(mine.id)).toBe("Rewritten");
    expect(payeeOf(other.id)).toBe("From template B");
    expect(payeeOf(none.id)).toBe("From no template");
  });

  it("leaves the queue readable afterwards", async () => {
    const page = await listStages(actor, { limit: 100 });
    expect(page.items.length).toBeGreaterThan(0);
  });
});
