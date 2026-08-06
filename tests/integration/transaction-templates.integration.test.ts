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
  bulkDeleteTransactionTemplates,
  bulkEditTransactionTemplates,
  createTransactionTemplate,
  deleteTransactionTemplate,
  getTransactionTemplate,
  listTransactionTemplates,
  updateTransactionTemplate,
} from "../../src/server/services/transaction-templates.js";
import { createStage, listStages } from "../../src/server/services/staging.js";
import {
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { getIdentity } from "../../src/server/services/identity.js";
import {
  getPreferences,
  setPreferences,
} from "../../src/server/services/preferences.js";

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
   * One key is refused rather than quietly dropped: a bank's import reference
   * would be copied onto every transaction made from the template, so the next
   * real import of that statement row would be swallowed as one already seen.
   * A date and a category name are stored, because each is visible in the form
   * before anything is submitted.
   */
  it("refuses the import reference and nothing else", async () => {
    await expect(
      createTransactionTemplate(owner, {
        name: "Refused externalId",
        draft: withdrawal({ payee: "Somebody", externalId: "bank-reference-12345" }),
      }),
    ).rejects.toThrow();
    expect(
      (await listTransactionTemplates(owner)).map((t) => t.name),
    ).not.toContain("Refused externalId");

    const dated = await createTransactionTemplate(owner, {
      name: "Keeps a date",
      draft: withdrawal({
        payee: "Landlord",
        date: "2026-03-15",
        categoryName: "Rent",
      }),
    });
    expect(dated.draft).toMatchObject({
      date: "2026-03-15",
      categoryName: "Rent",
    });
  });

  it("accepts a template that says nothing but its name", async () => {
    const bare = await createTransactionTemplate(owner, {
      name: "Nothing at all",
      draft: {},
    });
    expect(bare.draft).toEqual({});
    expect(bare.name).toBe("Nothing at all");
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

  /**
   * The link is provenance, so it has to survive everything that happens to the
   * entry afterwards and to be scoped to its owner like every other count.
   */
  describe("counting what came from a template", () => {
    it("counts committed and staged entries, and keeps them apart", async () => {
      const template = await createTransactionTemplate(owner, {
        name: "Counted",
        draft: withdrawal({ payee: "Corner Shop" }),
      });
      const other = await createTransactionTemplate(owner, {
        name: "Uncounted",
        draft: withdrawal({ payee: "Nobody" }),
      });

      await createTransaction(
        owner,
        {
          type: "withdrawal",
          date: "2026-05-01",
          payee: "Corner Shop",
          description: null,
          fromAccountId: checkingId,
          amount: "10.00",
          templateId: template.id,
        },
        "count-committed-1",
      );
      await createStage(owner, {
        draft: {
          type: "withdrawal",
          date: "2026-05-02",
          payee: "Corner Shop",
          fromAccountId: checkingId,
          amount: "11.00",
          templateId: template.id,
        },
        idempotencyKey: "count-staged-1",
      });

      const listed = await listTransactionTemplates(owner);
      const counted = listed.find((row) => row.id === template.id)!;
      expect(counted).toMatchObject({
        transactionCount: 1,
        stagedTransactionCount: 1,
        totalTransactionCount: 2,
      });
      // The one nothing came from is listed at zero rather than left out.
      expect(listed.find((row) => row.id === other.id)).toMatchObject({
        transactionCount: 0,
        stagedTransactionCount: 0,
        totalTransactionCount: 0,
      });
    });

    it("stops counting an entry once it is deleted", async () => {
      const template = await createTransactionTemplate(owner, {
        name: "Counted then deleted",
        draft: withdrawal({ payee: "Gone" }),
      });
      const created = await createTransaction(
        owner,
        {
          type: "withdrawal",
          date: "2026-05-03",
          payee: "Gone",
          description: null,
          fromAccountId: checkingId,
          amount: "12.00",
          templateId: template.id,
        },
        "count-deleted-1",
      );
      const before = (await listTransactionTemplates(owner)).find(
        (row) => row.id === template.id,
      )!;
      expect(before.transactionCount).toBe(1);

      await setTransactionDeleted(owner, created.id, created.version, true);
      const after = (await listTransactionTemplates(owner)).find(
        (row) => row.id === template.id,
      )!;
      expect(after.transactionCount).toBe(0);
    });

    /**
     * Applying a template while editing is the whole reason the picker is on
     * the edit form, so the edit has to record it. The update writes a column
     * list rather than the whole row, and a column left out of that list keeps
     * whatever was there.
     */
    it("records a template applied while editing an entry", async () => {
      const template = await createTransactionTemplate(owner, {
        name: "Applied on edit",
        draft: withdrawal({ payee: "Later" }),
      });
      const created = await createTransaction(
        owner,
        {
          type: "withdrawal",
          date: "2026-05-06",
          payee: "Before",
          description: null,
          fromAccountId: checkingId,
          amount: "15.00",
        },
        "count-edit-1",
      );
      expect(
        (await listTransactionTemplates(owner)).find((r) => r.id === template.id)!
          .transactionCount,
      ).toBe(0);

      await updateTransaction(owner, created.id, {
        expectedVersion: created.version,
        draft: {
          type: "withdrawal",
          date: "2026-05-06",
          payee: "After",
          description: null,
          fromAccountId: checkingId,
          amount: "15.00",
          templateId: template.id,
        },
      });

      expect(
        (await listTransactionTemplates(owner)).find((r) => r.id === template.id)!
          .transactionCount,
      ).toBe(1);
    });

    it("lists only the staged rows that came from one template", async () => {
      const mine = await createTransactionTemplate(owner, {
        name: "Staged filter mine",
        draft: withdrawal({ payee: "Mine" }),
      });
      await createStage(owner, {
        draft: {
          type: "withdrawal",
          date: "2026-05-07",
          payee: "From the template",
          fromAccountId: checkingId,
          amount: "16.00",
          templateId: mine.id,
        },
        idempotencyKey: "staged-filter-1",
      });
      await createStage(owner, {
        draft: {
          type: "withdrawal",
          date: "2026-05-07",
          payee: "From nothing",
          fromAccountId: checkingId,
          amount: "17.00",
        },
        idempotencyKey: "staged-filter-2",
      });

      const filtered = await listStages(owner, {
        templateId: mine.id,
        limit: 100,
      });
      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0]!.draft).toMatchObject({
        payee: "From the template",
      });
    });

    it("will not count another person's entry", async () => {
      const mine = await createTransactionTemplate(owner, {
        name: "Mine to count",
        draft: withdrawal({ payee: "Mine" }),
      });
      await createStage(stranger, {
        draft: {
          type: "withdrawal",
          date: "2026-05-04",
          payee: "Theirs",
          fromAccountId: strangerAccountId,
          amount: "13.00",
          templateId: mine.id,
        },
        idempotencyKey: "count-cross-tenant",
      });
      const counted = (await listTransactionTemplates(owner)).find(
        (row) => row.id === mine.id,
      )!;
      expect(counted.stagedTransactionCount).toBe(0);
    });

    it("refuses an entry naming somebody else's template", async () => {
      const theirs = await createTransactionTemplate(stranger, {
        name: "Not yours",
        draft: withdrawal({ payee: "Theirs" }),
      });
      await expect(
        createTransaction(
          owner,
          {
            type: "withdrawal",
            date: "2026-05-05",
            payee: "Trespass",
            description: null,
            fromAccountId: checkingId,
            amount: "14.00",
            templateId: theirs.id,
          },
          "count-foreign-template",
        ),
      ).rejects.toThrow(/Template is unavailable/);
    });
  });

  describe("changing many templates at once", () => {
    let key = 0;
    const nextKey = () => `bulk-${process.pid}-${(key += 1)}`;

    const make = async (name: string, draft: Record<string, unknown>) =>
      createTransactionTemplate(owner, { name, draft });

    const storedDraft = async (id: string) => {
      const [row] = await getDb()
        .select()
        .from(transactionTemplates)
        .where(eq(transactionTemplates.id, id));
      return row.draft as Record<string, unknown>;
    };

    it("sets one field and clears another across every selected row", async () => {
      const one = await make("Bulk set A", {
        type: "withdrawal",
        payee: "Old",
        fromAccountId: checkingId,
        amount: "10.00",
      });
      const two = await make("Bulk set B", {
        type: "withdrawal",
        payee: "Older",
        fromAccountId: checkingId,
        amount: "20.00",
      });

      const result = await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [
            { id: one.id, expectedVersion: one.version },
            { id: two.id, expectedVersion: two.version },
          ],
        },
        patch: { payee: "New", amount: null },
        idempotencyKey: nextKey(),
      });

      expect(result).toMatchObject({ dryRun: false, changedCount: 2 });
      for (const template of [one, two]) {
        const draft = await storedDraft(template.id);
        expect(draft.payee).toBe("New");
        // Cleared means the key is gone, not present and empty. That is what
        // makes the field one the form asks for when the template is used.
        expect("amount" in draft).toBe(false);
        expect(
          (await getTransactionTemplate(owner, template.id)).version,
        ).toBe(template.version + 1);
      }
    });

    it("refuses the whole edit when one expected version is stale", async () => {
      const fresh = await make("Bulk stale A", {
        type: "withdrawal",
        payee: "Untouched",
      });
      const moved = await make("Bulk stale B", {
        type: "withdrawal",
        payee: "Moved on",
      });
      await updateTransactionTemplate(owner, moved.id, {
        name: "Bulk stale B renamed",
        expectedVersion: moved.version,
      });

      await expect(
        bulkEditTransactionTemplates(owner, {
          selection: {
            items: [
              { id: fresh.id, expectedVersion: fresh.version },
              { id: moved.id, expectedVersion: moved.version },
            ],
          },
          patch: { payee: "Should not land" },
          idempotencyKey: nextKey(),
        }),
      ).rejects.toMatchObject({ code: "STALE_VERSION" });

      expect((await storedDraft(fresh.id)).payee).toBe("Untouched");
      expect((await getTransactionTemplate(owner, fresh.id)).version).toBe(
        fresh.version,
      );
    });

    it("will not touch a template belonging to somebody else", async () => {
      const mine = await make("Bulk tenant mine", {
        type: "withdrawal",
        payee: "Mine",
      });
      const theirs = await createTransactionTemplate(stranger, {
        name: "Bulk tenant theirs",
        draft: { type: "withdrawal", payee: "Theirs" },
      });

      await expect(
        bulkEditTransactionTemplates(owner, {
          selection: {
            items: [
              { id: mine.id, expectedVersion: mine.version },
              { id: theirs.id, expectedVersion: theirs.version },
            ],
          },
          patch: { payee: "Trespass" },
          idempotencyKey: nextKey(),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect((await storedDraft(theirs.id)).payee).toBe("Theirs");
      expect((await storedDraft(mine.id)).payee).toBe("Mine");
    });

    it("replays one idempotency key instead of writing twice", async () => {
      const template = await make("Bulk idempotent", {
        type: "withdrawal",
        payee: "First",
      });
      const input = {
        selection: {
          items: [{ id: template.id, expectedVersion: template.version }],
        },
        patch: { payee: "Second" },
        idempotencyKey: nextKey(),
      };
      const first = await bulkEditTransactionTemplates(owner, input);
      const replay = await bulkEditTransactionTemplates(owner, input);
      expect(replay).toEqual(first);
      expect((await getTransactionTemplate(owner, template.id)).version).toBe(
        template.version + 1,
      );
    });

    it("refuses a source account for a template that is a deposit", async () => {
      const deposit = await make("Bulk deposit", {
        type: "deposit",
        toAccountId: checkingId,
      });
      await expect(
        bulkEditTransactionTemplates(owner, {
          selection: {
            items: [{ id: deposit.id, expectedVersion: deposit.version }],
          },
          patch: { fromAccountId: savingsId },
          idempotencyKey: nextKey(),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect("fromAccountId" in (await storedDraft(deposit.id))).toBe(false);
    });

    it("drops the side a new type cannot hold", async () => {
      const transfer = await make("Bulk retype", {
        type: "transfer",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        amount: "5.00",
        destinationAmount: "5.00",
      });
      await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [{ id: transfer.id, expectedVersion: transfer.version }],
        },
        patch: { type: "withdrawal" },
        idempotencyKey: nextKey(),
      });
      const draft = await storedDraft(transfer.id);
      expect(draft).toMatchObject({
        type: "withdrawal",
        fromAccountId: checkingId,
      });
      expect("toAccountId" in draft).toBe(false);
      expect("destinationAmount" in draft).toBe(false);
    });

    it("refuses the one field a template never stores", async () => {
      const template = await make("Bulk strict", {
        type: "withdrawal",
        payee: "Strict",
      });
      await expect(
        bulkEditTransactionTemplates(owner, {
          selection: {
            items: [{ id: template.id, expectedVersion: template.version }],
          },
          patch: { externalId: "abc" },
          idempotencyKey: nextKey(),
        }),
      ).rejects.toThrow();

      await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [{ id: template.id, expectedVersion: template.version }],
        },
        patch: { date: "2026-01-01", categoryName: "Groceries" },
        idempotencyKey: nextKey(),
      });
      expect(await storedDraft(template.id)).toMatchObject({
        date: "2026-01-01",
        categoryName: "Groceries",
      });
    });

    /**
     * The unchanged row carries enough fields for its stored key order to
     * differ from the schema's: Postgres orders jsonb keys by length, so a
     * comparison against a freshly parsed draft calls every row changed unless
     * both sides are put in the same order first.
     */
    it("leaves a row alone when the patch is what it already holds", async () => {
      const same = await make("Bulk unchanged", {
        type: "withdrawal",
        notes: "unchanged",
        payee: "Same",
        amount: "12.00",
        categoryId: groceriesId,
        fromAccountId: checkingId,
      });
      const other = await make("Bulk changed", {
        type: "withdrawal",
        notes: "changed",
        payee: "Different",
        amount: "12.00",
        categoryId: groceriesId,
        fromAccountId: checkingId,
      });
      const result = await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [
            { id: same.id, expectedVersion: same.version },
            { id: other.id, expectedVersion: other.version },
          ],
        },
        patch: { payee: "Same" },
        idempotencyKey: nextKey(),
      });
      expect(result.changedCount).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual([other.id]);
      expect((await getTransactionTemplate(owner, same.id)).version).toBe(
        same.version,
      );
    });

    it("deletes every selected template, and none when one is stale", async () => {
      const doomed = await make("Bulk delete A", { type: "withdrawal" });
      const alsoDoomed = await make("Bulk delete B", { type: "withdrawal" });
      const survivor = await make("Bulk delete C", { type: "withdrawal" });

      await expect(
        bulkDeleteTransactionTemplates(owner, {
          selection: {
            items: [
              { id: survivor.id, expectedVersion: survivor.version },
              { id: doomed.id, expectedVersion: doomed.version + 5 },
            ],
          },
          idempotencyKey: nextKey(),
        }),
      ).rejects.toMatchObject({ code: "STALE_VERSION" });
      expect(await getTransactionTemplate(owner, survivor.id)).toBeTruthy();

      const result = await bulkDeleteTransactionTemplates(owner, {
        selection: {
          items: [
            { id: doomed.id, expectedVersion: doomed.version },
            { id: alsoDoomed.id, expectedVersion: alsoDoomed.version },
          ],
        },
        idempotencyKey: nextKey(),
      });
      expect(result.changedCount).toBe(2);
      const names = (await listTransactionTemplates(owner)).map(
        (template) => template.name,
      );
      expect(names).not.toContain("Bulk delete A");
      expect(names).not.toContain("Bulk delete B");
      expect(names).toContain("Bulk delete C");
    });

    /**
     * Dropping a side belongs to a type change and nothing else. A patch that
     * never mentions the type has not asked about the accounts, so taking one
     * away would be a deletion nobody requested.
     */
    it("leaves an unrelated account side alone when the type is not changing", async () => {
      const odd = await make("Bulk two sided", {
        type: "withdrawal",
        payee: "Before",
        fromAccountId: checkingId,
        toAccountId: savingsId,
      });
      await bulkEditTransactionTemplates(owner, {
        selection: { items: [{ id: odd.id, expectedVersion: odd.version }] },
        patch: { payee: "After" },
        idempotencyKey: nextKey(),
      });
      const draft = await storedDraft(odd.id);
      expect(draft).toMatchObject({
        payee: "After",
        fromAccountId: checkingId,
        toAccountId: savingsId,
      });
    });

    it("refuses a received amount for anything that is not a transfer", async () => {
      const withdrawal = await make("Bulk received amount", {
        type: "withdrawal",
        fromAccountId: checkingId,
      });
      await expect(
        bulkEditTransactionTemplates(owner, {
          selection: {
            items: [{ id: withdrawal.id, expectedVersion: withdrawal.version }],
          },
          patch: { destinationAmount: "5.00" },
          idempotencyKey: nextKey(),
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect("destinationAmount" in (await storedDraft(withdrawal.id))).toBe(false);
    });

    /**
     * A template outlives the account it names, so one holding a deleted
     * account has to stay editable. Checking the whole resulting draft would
     * make its payee unchangeable over an account nobody was touching.
     */
    it("edits a template that still names an account since deleted", async () => {
      const doomed = await createAccount(owner, {
        name: "Closing soon",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      });
      const template = await make("Bulk orphan", {
        type: "withdrawal",
        payee: "Before",
        fromAccountId: doomed.id,
      });
      await deleteAccount(owner, doomed.id, doomed.version);

      await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [{ id: template.id, expectedVersion: template.version }],
        },
        patch: { payee: "After" },
        idempotencyKey: nextKey(),
      });
      expect((await storedDraft(template.id)).payee).toBe("After");
    });

    // Clearing the type removes the constraint rather than leaving the old one
    // in force, so a side the cleared type no longer rules out can be set in
    // the same patch.
    it("lets a cleared type free the account side it ruled out", async () => {
      const deposit = await make("Bulk clear type", {
        type: "deposit",
        toAccountId: checkingId,
      });
      await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [{ id: deposit.id, expectedVersion: deposit.version }],
        },
        patch: { type: null, fromAccountId: savingsId },
        idempotencyKey: nextKey(),
      });
      const draft = await storedDraft(deposit.id);
      expect(draft).toMatchObject({ fromAccountId: savingsId });
      expect("type" in draft).toBe(false);
    });

    it("writes nothing on a dry run", async () => {
      const template = await make("Bulk dry run", {
        type: "withdrawal",
        payee: "Before",
      });
      const result = await bulkEditTransactionTemplates(owner, {
        selection: {
          items: [{ id: template.id, expectedVersion: template.version }],
        },
        patch: { payee: "After" },
        idempotencyKey: nextKey(),
        dryRun: true,
      });
      expect(result).toMatchObject({ dryRun: true, changedCount: 1 });
      expect((await storedDraft(template.id)).payee).toBe("Before");
    });
  });
});

integration("what an agent reads about the person and their settings", () => {
  const solo: Actor = { userId: "identity-owner", source: "mcp", clientId: "agent-7" };
  const soloDatabase = `simple_balance_identity_${process.pid}_${Date.now()}`;
  let client: PgClient;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    client = new PgClient({ connectionString: connection });
    await client.connect();
    await client.query(`create database "${soloDatabase}"`);
    const url = new URL(connection!);
    url.pathname = `/${soloDatabase}`;
    process.env.DATABASE_URL = url.toString();
    await runMigrations();
    await getDb().insert(user).values({
      id: solo.userId,
      name: "Ada Lovelace",
      email: "ada@example.com",
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await closeDb();
    await client.query(`drop database if exists "${soloDatabase}"`);
    await client.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("reports who the books belong to, and the client asking", async () => {
    expect(await getIdentity(solo)).toEqual({
      userId: solo.userId,
      name: "Ada Lovelace",
      email: "ada@example.com",
      clientId: "agent-7",
      source: "mcp",
    });
  });

  // Nothing about how they sign in. That is deployment plumbing, and an agent
  // has no use for knowing which credential doors exist.
  it("says nothing about sign-in methods", async () => {
    const identity = await getIdentity(solo);
    for (const leak of ["password", "google", "mode", "localEnabled"]) {
      expect(Object.keys(identity)).not.toContain(leak);
    }
  });

  /**
   * Until somebody picks, the answer is a default rather than a decision, and
   * an agent has to be able to tell the two apart before it reports what "this
   * month" covered.
   */
  it("distinguishes a default from a choice", async () => {
    const before = await getPreferences(solo);
    expect(before).toMatchObject({
      timezone: "UTC",
      defaultCurrency: "USD",
      chosen: false,
    });

    await setPreferences(solo, {
      timezone: "Europe/London",
      defaultCurrency: "GBP",
    });
    expect(await getPreferences(solo)).toMatchObject({
      timezone: "Europe/London",
      defaultCurrency: "GBP",
      chosen: true,
    });
  });

  // The stored record needs both, so without this a caller changing the
  // timezone would silently overwrite the currency with a guess.
  it("changes one setting without disturbing the other", async () => {
    await setPreferences(solo, {
      timezone: "Europe/London",
      defaultCurrency: "GBP",
    });

    await setPreferences(solo, { timezone: "America/New_York" });
    expect(await getPreferences(solo)).toMatchObject({
      timezone: "America/New_York",
      defaultCurrency: "GBP",
    });

    await setPreferences(solo, { defaultCurrency: "EUR" });
    expect(await getPreferences(solo)).toMatchObject({
      timezone: "America/New_York",
      defaultCurrency: "EUR",
    });
  });

  it("refuses a timezone no calendar recognises", async () => {
    await expect(
      setPreferences(solo, { timezone: "Middle/Earth" }),
    ).rejects.toThrow();
    expect(await getPreferences(solo)).toMatchObject({
      timezone: "America/New_York",
    });
  });
});
