import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, TransactionDraft } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";
import {
  createAccount,
  setAccountArchived,
  updateAccount,
} from "../../src/server/services/accounts.js";
import { listAuditEvents } from "../../src/server/services/audit.js";
import {
  createBudgetPlan,
  setBudgetEntry,
  updateBudgetPlan,
} from "../../src/server/services/budgets.js";
import {
  createCategory,
  setCategoryArchived,
  updateCategory,
} from "../../src/server/services/categories.js";
import {
  createCategoryGroup,
  updateCategoryGroup,
} from "../../src/server/services/category-groups.js";
import { createRecurrence, updateRecurrence } from "../../src/server/services/recurrences.js";
import { createStage, updateStage } from "../../src/server/services/staging.js";
import {
  createTransactionTemplate,
  updateTransactionTemplate,
} from "../../src/server/services/transaction-templates.js";
import {
  bulkEditTransactions,
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";

/**
 * An edit that changes nothing writes nothing: no new version, no audit entry,
 * no posting. The 0.2.0 sandbox smoke test saved an entry unchanged and watched
 * its version go from 1 to 2, which turns every other form holding it stale over
 * a change nobody made. Every record a form saves with an expected version is
 * covered here, because the defect was the same shape in each service.
 *
 * And account names are matched the way category and payee names are, so
 * "Checking" and "CHECKING" cannot both be created.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("unchanged_edits");
const actor: Actor = { userId: "integration-unchanged", source: "web" };
let keySeed = 0;
const key = () => `unchanged-${String((keySeed += 1)).padStart(7, "0")}`;

const auditCount = async () => (await listAuditEvents(actor, { limit: 200 })).items.length;
const postingCount = async (transactionId: string) =>
  Number(
    (
      await getDb().execute<{ count: string }>(
        sql`select count(*) as count from posting where transaction_id = ${transactionId}`,
      )
    ).rows[0]!.count,
  );

integration("edits and names", () => {
  beforeAll(async () => {
    await database.create();
  });

  afterAll(async () => {
    await database.drop();
  });

  describe("saving without changing anything", () => {
    let checkingId: string;
    let savingsId: string;

    beforeAll(async () => {
      await getDb().insert(user).values({
        id: actor.userId,
        name: "Unchanged",
        email: "unchanged@example.com",
        emailVerified: true,
      });
      checkingId = (
        await createAccount(actor, {
          name: "Checking",
          type: "checking",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "1000.00",
        })
      ).id;
      savingsId = (
        await createAccount(actor, {
          name: "Savings",
          type: "savings",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "0",
        })
      ).id;
    });

    it("leaves a transaction's version, audit trail and postings alone", async () => {
      const draft = {
        type: "withdrawal",
        date: "2026-03-01",
        fromAccountId: checkingId,
        amount: "84.30",
        payee: "Grocer",
        categoryName: "Groceries",
      } as TransactionDraft;
      const created = await createTransaction(actor, draft, key());
      const audits = await auditCount();
      const postings = await postingCount(created.id);

      const saved = await updateTransaction(actor, created.id, {
        draft: {
          ...draft,
          categoryName: undefined,
          categoryId: created.categoryId,
          amount: "84.300",
          description: "",
        },
        expectedVersion: created.version,
      });

      expect(saved.version).toBe(created.version);
      expect(await auditCount()).toBe(audits);
      expect(await postingCount(created.id)).toBe(postings);
    });

    it("still writes a real change", async () => {
      const created = await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-02",
          fromAccountId: checkingId,
          amount: "10.00",
          payee: "Cafe",
        } as TransactionDraft,
        key(),
      );
      const saved = await updateTransaction(actor, created.id, {
        draft: {
          type: "withdrawal",
          date: "2026-03-02",
          fromAccountId: checkingId,
          amount: "10.00",
          payee: "Cafe",
          notes: "with a note",
        },
        expectedVersion: created.version,
      });
      expect(saved.version).toBe(created.version + 1);
    });

    it("leaves a split alone when its legs come back by id", async () => {
      const created = await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-03",
          fromAccountId: checkingId,
          amount: "100.00",
          payee: "Big box",
          legs: [
            { amount: "60.00", categoryName: "Groceries" },
            { amount: "40.00", categoryName: "Household", categoryKind: "expense" },
          ],
        } as TransactionDraft,
        key(),
      );
      const legs = created.legs.map(
        (leg: { id: string; categoryId: string | null; amount: string }) => ({
          id: leg.id,
          categoryId: leg.categoryId,
          amount: leg.amount,
        }),
      );
      const unchanged = await updateTransaction(actor, created.id, {
        draft: {
          type: "withdrawal",
          date: "2026-03-03",
          fromAccountId: checkingId,
          amount: "100",
          payee: "Big box",
          legs,
        },
        expectedVersion: created.version,
      });
      expect(unchanged.version).toBe(created.version);

      // The same figures on new legs are a change: the money moves to new leg ids.
      const relegged = await updateTransaction(actor, created.id, {
        draft: {
          type: "withdrawal",
          date: "2026-03-03",
          fromAccountId: checkingId,
          amount: "100",
          payee: "Big box",
          legs: legs.map(({ categoryId, amount }) => ({ categoryId, amount })),
        },
        expectedVersion: created.version,
      });
      expect(relegged.version).toBe(created.version + 1);
    });

    it("leaves an account alone, opening balance compared as a number", async () => {
      const before = await updateAccount(actor, savingsId, { notes: "kept", expectedVersion: 1 });
      const audits = await auditCount();
      const saved = await updateAccount(actor, savingsId, {
        name: "Savings",
        openingBalance: "0.000",
        notes: "kept",
        institution: "",
        expectedVersion: before.version,
      });
      expect(saved.version).toBe(before.version);
      expect(await auditCount()).toBe(audits);
    });

    it("leaves a category and a category group alone", async () => {
      const category = await createCategory(actor, { name: "Fuel", kind: "expense" });
      expect(
        (
          await updateCategory(actor, category.id, {
            name: "Fuel",
            kind: "expense",
            groupId: null,
            expectedVersion: category.version,
          })
        ).version,
      ).toBe(category.version);
      const group = await createCategoryGroup(actor, { name: "Driving", policy: "standalone" });
      expect(
        (
          await updateCategoryGroup(actor, group.id, {
            name: " Driving ",
            policy: "standalone",
            expectedVersion: group.version,
          })
        ).version,
      ).toBe(group.version);
    });

    it("leaves a budget plan and a budget entry alone", async () => {
      const category = await createCategory(actor, { name: "Dining", kind: "expense" });
      const plan = await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "200.00",
        activeFrom: "2026-01-01",
      });
      expect(
        (await updateBudgetPlan(actor, plan.id, { amount: "200", expectedVersion: plan.version }))
          .version,
      ).toBe(plan.version);
      const entry = await setBudgetEntry(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        periodStart: "2026-03-01",
        amount: "250.00",
      });
      const again = await setBudgetEntry(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        periodStart: "2026-03-01",
        amount: "250",
        expectedVersion: entry.version,
      });
      expect(again.version).toBe(entry.version);
    });

    it("leaves a template, its reminder included, alone", async () => {
      const draft = {
        type: "withdrawal" as const,
        payee: "Utility",
        fromAccountId: checkingId,
        amount: "70.00",
      };
      const notification = {
        frequency: "monthly" as const,
        anchorDate: "2026-04-01",
        time: "09:00",
      };
      const template = await createTransactionTemplate(actor, {
        name: "Electric",
        draft,
        notification,
      });
      const saved = await updateTransactionTemplate(actor, template.id, {
        name: "Electric",
        draft,
        notification,
        expectedVersion: template.version,
      });
      expect(saved.version).toBe(template.version);
      const moved = await updateTransactionTemplate(actor, template.id, {
        notification: { ...notification, time: "10:00" },
        expectedVersion: template.version,
      });
      expect(moved.version).toBe(template.version + 1);
    });

    it("leaves a recurrence alone", async () => {
      const shape = {
        type: "withdrawal" as const,
        payee: "Gym",
        fromAccountId: checkingId,
        amount: "45.00",
      };
      const schedule = { frequency: "monthly" as const, anchorDate: "2026-04-15" };
      const recurrence = await createRecurrence(actor, { name: "Gym", shape, schedule });
      const saved = await updateRecurrence(actor, recurrence.id, {
        name: "Gym",
        shape,
        schedule,
        notifyOnCreate: false,
        expectedVersion: recurrence.version,
      });
      expect(saved.version).toBe(recurrence.version);
    });

    it("leaves a record alone when asked for the state it is already in", async () => {
      const entry = await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-06",
          fromAccountId: checkingId,
          amount: "7.00",
          payee: "Twice",
        } as TransactionDraft,
        key(),
      );
      const deleted = await setTransactionDeleted(actor, entry.id, entry.version, true);
      const audits = await auditCount();
      const again = await setTransactionDeleted(actor, entry.id, deleted.version, true);
      expect(again.version).toBe(deleted.version);
      expect(await auditCount()).toBe(audits);

      const spare = await createAccount(actor, {
        name: "Spare",
        type: "cash",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      });
      expect((await setAccountArchived(actor, spare.id, spare.version, false)).version).toBe(
        spare.version,
      );
      const category = await createCategory(actor, { name: "Idle", kind: "expense" });
      expect((await setCategoryArchived(actor, category.id, category.version, false)).version).toBe(
        category.version,
      );
    });

    it("writes only the rows a bulk edit changes, and counts only those", async () => {
      const first = await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-07",
          fromAccountId: checkingId,
          amount: "1.00",
          payee: "Bulk",
          notes: "same",
        } as TransactionDraft,
        key(),
      );
      const second = await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-07",
          fromAccountId: checkingId,
          amount: "2.00",
          payee: "Bulk",
        } as TransactionDraft,
        key(),
      );
      const result = await bulkEditTransactions(actor, {
        selection: {
          mode: "ids",
          items: [
            { id: first.id, expectedVersion: first.version },
            { id: second.id, expectedVersion: second.version },
          ],
        },
        patch: { notes: "same" },
        idempotencyKey: key(),
      });
      expect(result.updatedCount).toBe(1);
      const byId = new Map(result.items.map((item) => [item.id, item]));
      expect(byId.get(first.id)!.nextVersion).toBe(first.version);
      expect(byId.get(second.id)!.nextVersion).toBe(second.version + 1);
    });

    it("leaves a staged row alone", async () => {
      const draft = {
        type: "withdrawal",
        date: "2026-03-05",
        fromAccountId: checkingId,
        amount: "5.00",
        payee: "Kiosk",
      };
      const staged = await createStage(actor, { draft, idempotencyKey: key() });
      const saved = await updateStage(actor, staged.id, { draft, expectedVersion: staged.version });
      expect(saved.version).toBe(staged.version);
    });
  });

  describe("account names", () => {
    const other: Actor = { userId: "integration-account-names", source: "web" };

    beforeAll(async () => {
      await getDb().insert(user).values({
        id: other.userId,
        name: "Names",
        email: "names@example.com",
        emailVerified: true,
      });
    });

    const open = (name: string) =>
      createAccount(other, {
        name,
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      });

    it("refuses a second spelling that differs only in case or spacing", async () => {
      await open("Joint Checking");
      await expect(open("JOINT CHECKING")).rejects.toMatchObject({ code: "DUPLICATE" });
      await expect(open("joint   checking")).rejects.toMatchObject({ code: "DUPLICATE" });
    });

    it("refuses renaming onto another account's name in any case", async () => {
      const second = await open("Travel");
      await expect(
        updateAccount(other, second.id, {
          name: "joint checking",
          expectedVersion: second.version,
        }),
      ).rejects.toMatchObject({ code: "DUPLICATE" });
    });

    it("lets an account change the case of its own name", async () => {
      const third = await open("rainy day");
      const renamed = await updateAccount(other, third.id, {
        name: "Rainy Day",
        expectedVersion: third.version,
      });
      expect(renamed.name).toBe("Rainy Day");
    });

    it("leaves a name the counter-accounts use alone", async () => {
      await expect(open("Opening Balances (USD)")).resolves.toMatchObject({
        name: "Opening Balances (USD)",
      });
    });
  });
});
