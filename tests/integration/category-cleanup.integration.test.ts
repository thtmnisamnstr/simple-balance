import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory, listCategories } from "../../src/server/services/categories.js";
import { bulkEditStages, createStage, updateStage } from "../../src/server/services/staging.js";
import { createTransactionTemplate } from "../../src/server/services/transaction-templates.js";
import { createRecurrence } from "../../src/server/services/recurrences.js";
import {
  bulkEditTransactions,
  createTransaction,
  getTransaction,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { listPayees } from "../../src/server/services/payees.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("category_cleanup");
const actor: Actor = { userId: "cleanup-user", source: "web" };

let keySeed = 0;
const nextKey = () => `cleanup-${String((keySeed += 1)).padStart(6, "0")}`;
let checkingId = "";

const names = async () => (await listCategories(actor, true)).map((row) => row.name).sort();

const category = async (name: string) =>
  (await createCategory(actor, { name, kind: "expense" })).id;

integration("a category nothing points at any more", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Cleanup",
      email: "cleanup@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "5000",
      })
    ).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  it("goes when the only transaction using it is recategorised", async () => {
    const from = await category("Misfiled");
    const to = await category("Groceries");
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Shop",
        amount: "10",
        fromAccountId: checkingId,
        categoryId: from,
      } as never,
      nextKey(),
    );
    expect(await names()).toContain("Misfiled");

    await updateTransaction(actor, created.id, {
      expectedVersion: created.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Shop",
        amount: "10",
        fromAccountId: checkingId,
        categoryId: to,
      } as never,
    });
    expect(await names()).not.toContain("Misfiled");
    expect(await names()).toContain("Groceries");
  });

  /**
   * The rule is about a category an edit emptied, not about every empty
   * category. One made ahead of time for next month has had nothing moved off
   * it, and taking it away would undo a deliberate act.
   */
  it("leaves a category nobody has moved anything off", async () => {
    await category("Waiting for next month");
    const from = await category("Temporary");
    const to = await category("Kept");
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-02",
        payee: "Shop",
        amount: "11",
        fromAccountId: checkingId,
        categoryId: from,
      } as never,
      nextKey(),
    );
    await updateTransaction(actor, created.id, {
      expectedVersion: created.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-02",
        payee: "Shop",
        amount: "11",
        fromAccountId: checkingId,
        categoryId: to,
      } as never,
    });
    const after = await names();
    expect(after).toContain("Waiting for next month");
    expect(after).not.toContain("Temporary");
  });

  it("keeps one another transaction still uses", async () => {
    const shared = await category("Shared");
    const other = await category("Other");
    const first = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-03",
        payee: "One",
        amount: "12",
        fromAccountId: checkingId,
        categoryId: shared,
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-04",
        payee: "Two",
        amount: "13",
        fromAccountId: checkingId,
        categoryId: shared,
      } as never,
      nextKey(),
    );
    await updateTransaction(actor, first.id, {
      expectedVersion: first.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-03",
        payee: "One",
        amount: "12",
        fromAccountId: checkingId,
        categoryId: other,
      } as never,
    });
    expect(await names()).toContain("Shared");
  });

  it("keeps one a staged row still uses", async () => {
    const held = await category("Held by the queue");
    const other = await category("Elsewhere");
    await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-02-05",
        payee: "Queued",
        amount: "14",
        fromAccountId: checkingId,
        categoryId: held,
      },
      idempotencyKey: nextKey(),
    });
    const committed = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-05",
        payee: "Committed",
        amount: "15",
        fromAccountId: checkingId,
        categoryId: held,
      } as never,
      nextKey(),
    );
    await updateTransaction(actor, committed.id, {
      expectedVersion: committed.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-05",
        payee: "Committed",
        amount: "15",
        fromAccountId: checkingId,
        categoryId: other,
      } as never,
    });
    expect(await names()).toContain("Held by the queue");
  });

  /**
   * A standing instruction holds no row today and writes one on every
   * occurrence from here on, and a template's draft names a category in jsonb
   * with no foreign key. Neither would stop the delete, and what is left is a
   * proposal or a saved form naming a category that is gone.
   */
  it("keeps one only a recurrence or a template names", async () => {
    for (const [name, hold] of [
      ["Held by a recurrence", "recurrence"],
      ["Held by a template", "template"],
    ] as const) {
      const held = await category(name);
      const other = await category(`${name} elsewhere`);
      if (hold === "recurrence") {
        await createRecurrence(actor, {
          name,
          schedule: {
            frequency: "monthly",
            interval: 1,
            anchorDate: "2026-03-01",
            monthPolicy: "last_day",
            weekendPolicy: "allow",
          },
          shape: {
            type: "withdrawal",
            payee: "Standing",
            amount: "20",
            fromAccountId: checkingId,
            categoryId: held,
            description: null,
          },
        } as never);
      } else {
        await createTransactionTemplate(actor, {
          name,
          draft: {
            type: "withdrawal",
            payee: "Saved",
            amount: "20",
            fromAccountId: checkingId,
            categoryId: held,
          },
        } as never);
      }

      const created = await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-02-06",
          payee: name,
          amount: "16",
          fromAccountId: checkingId,
          categoryId: held,
        } as never,
        nextKey(),
      );
      await updateTransaction(actor, created.id, {
        expectedVersion: created.version,
        draft: {
          type: "withdrawal",
          date: "2026-02-06",
          payee: name,
          amount: "16",
          fromAccountId: checkingId,
          categoryId: other,
        } as never,
      });
      expect(await names(), hold).toContain(name);
    }
  });

  it("goes when a staged row is recategorised too", async () => {
    const from = await category("Staged misfile");
    const to = await category("Staged kept");
    const row = await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-02-07",
        payee: "Queued",
        amount: "17",
        fromAccountId: checkingId,
        categoryId: from,
      },
      idempotencyKey: nextKey(),
    });
    await updateStage(actor, row.id, {
      expectedVersion: row.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-07",
        payee: "Queued",
        amount: "17",
        fromAccountId: checkingId,
        categoryId: to,
      },
    });
    expect(await names()).not.toContain("Staged misfile");
  });

  /**
   * A queue token proposes and never decides, so it edits the row and leaves
   * the ledger's own records alone.
   */
  it("leaves the category alone for a caller that may only stage", async () => {
    const from = await category("Stage scoped");
    const to = await category("Stage scoped kept");
    const row = await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-02-08",
        payee: "Queued",
        amount: "18",
        fromAccountId: checkingId,
        categoryId: from,
      },
      idempotencyKey: nextKey(),
    });
    await updateStage(
      actor,
      row.id,
      {
        expectedVersion: row.version,
        draft: {
          type: "withdrawal",
          date: "2026-02-08",
          payee: "Queued",
          amount: "18",
          fromAccountId: checkingId,
          categoryId: to,
        },
      },
      undefined,
      { mayEditLedgerRecords: false },
    );
    expect(await names()).toContain("Stage scoped");
  });

  it("releases only the leg's category when a split is relabelled", async () => {
    const legOne = await category("Leg one");
    const legTwo = await category("Leg two");
    const replacement = await category("Leg one replaced");
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-09",
        payee: "Split",
        amount: "30",
        fromAccountId: checkingId,
        legs: [
          { categoryId: legOne, amount: "10" },
          { categoryId: legTwo, amount: "20" },
        ],
      } as never,
      nextKey(),
    );
    const loaded = await getTransaction(actor, created.id);
    await updateTransaction(actor, created.id, {
      expectedVersion: loaded.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-09",
        payee: "Split",
        amount: "30",
        fromAccountId: checkingId,
        legs: [
          { id: loaded.legs[0]!.id, categoryId: replacement, amount: "10" },
          { id: loaded.legs[1]!.id, categoryId: legTwo, amount: "20" },
        ],
      } as never,
    });
    const after = await names();
    expect(after).not.toContain("Leg one");
    expect(after).toContain("Leg two");
    expect(after).toContain("Leg one replaced");
  });

  /**
   * Payees are not records: every list of them is a group-by over the live
   * transaction and staged rows. A payee nothing references has therefore
   * already stopped existing, with nothing to delete.
   */
  it("drops a payee no row names any more, with nothing to delete", async () => {
    const created = await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-10",
        payee: "Only Ever Here",
        amount: "19",
        fromAccountId: checkingId,
      } as never,
      nextKey(),
    );
    expect((await listPayees(actor)).map((row) => row.name)).toContain("Only Ever Here");
    await updateTransaction(actor, created.id, {
      expectedVersion: created.version,
      draft: {
        type: "withdrawal",
        date: "2026-02-10",
        payee: "Renamed Instead",
        amount: "19",
        fromAccountId: checkingId,
      } as never,
    });
    const payees = (await listPayees(actor)).map((row) => row.name);
    expect(payees).not.toContain("Only Ever Here");
    expect(payees).toContain("Renamed Instead");
  });

  /**
   * The queue had the same split the committed rows had: one row at a time
   * cleared the category, a mass edit over the identical rows left it standing.
   */
  it("clears a category a staged mass edit emptied", async () => {
    const doomed = await category("Staged bulk emptied");
    const keeper = await category("Staged bulk destination");
    const rows = [];
    for (const day of ["2026-05-01", "2026-05-02"]) {
      rows.push(
        await createStage(actor, {
          draft: {
            type: "withdrawal",
            date: day,
            payee: "Queued",
            amount: "9",
            fromAccountId: checkingId,
            categoryId: doomed,
          },
          idempotencyKey: nextKey(),
        }),
      );
    }

    await bulkEditStages(actor, {
      selection: {
        mode: "ids" as const,
        items: rows.map((row) => ({ id: row.id, expectedVersion: row.version })),
      },
      patch: { categoryId: keeper },
      idempotencyKey: nextKey(),
    });

    const remaining = await names();
    expect(remaining).not.toContain("Staged bulk emptied");
    expect(remaining).toContain("Staged bulk destination");
  });

  it("leaves it alone when a staged mass edit may only stage", async () => {
    const doomed = await category("Staged bulk scoped");
    const keeper = await category("Staged bulk scoped destination");
    const row = await createStage(actor, {
      draft: {
        type: "withdrawal",
        date: "2026-05-03",
        payee: "Queued",
        amount: "11",
        fromAccountId: checkingId,
        categoryId: doomed,
      },
      idempotencyKey: nextKey(),
    });

    await bulkEditStages(
      actor,
      {
        selection: {
          mode: "ids" as const,
          items: [{ id: row.id, expectedVersion: row.version }],
        },
        patch: { categoryId: keeper },
        idempotencyKey: nextKey(),
      },
      undefined,
      { mayEditLedgerRecords: false },
    );

    expect(await names()).toContain("Staged bulk scoped");
  });

  /**
   * Recategorising a hundred rows one at a time cleared the category behind
   * them; doing it in one request left it standing. Two paths, one rule.
   */
  it("clears a category a mass edit emptied", async () => {
    const doomed = await createCategory(actor, { name: "Bulk Emptied", kind: "expense" });
    const keeper = await createCategory(actor, { name: "Bulk Destination", kind: "expense" });

    const rows = [];
    for (const day of ["2026-04-01", "2026-04-02"]) {
      rows.push(
        await createTransaction(
          actor,
          {
            type: "withdrawal",
            date: day,
            payee: "Shop",
            amount: "5",
            fromAccountId: checkingId,
            categoryId: doomed.id,
          } as never,
          nextKey(),
        ),
      );
    }

    await bulkEditTransactions(actor, {
      selection: {
        mode: "ids" as const,
        items: rows.map((row) => ({ id: row.id, expectedVersion: row.version })),
      },
      patch: { categoryId: keeper.id },
      idempotencyKey: nextKey(),
    });

    const remaining = await names();
    expect(remaining).not.toContain("Bulk Emptied");
    expect(remaining).toContain("Bulk Destination");
  });
});
