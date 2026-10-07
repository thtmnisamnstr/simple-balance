import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The category namespace before the payee namespace, on the paths that move
 * something off a category.
 *
 * `helpers.ts` orders the advisory locks so two writes by one person cannot
 * each hold the lock the other wants. A create naming a category takes the
 * category lock and then the payee lock. An edit moving an entry off its
 * category took the payee lock first — the new draft names no category, so
 * nothing took the category lock up front — and then the category lock last,
 * inside the prune that clears the category it left. Two such writes on
 * different accounts had nothing else to serialize them, and PostgreSQL broke
 * the deadlock by failing one of them as a 500. `bulkEditTransactions` had
 * already been fixed for exactly this; the single edit and both staged edits
 * had not.
 *
 * The order is recorded rather than raced: a deadlock needs two connections to
 * interleave just so, and a test that waits for one proves little when it does
 * not happen. Every lock still runs — the recorder wraps the real functions.
 */
const order = vi.hoisted(() => [] as string[]);

vi.mock("../../src/server/services/helpers.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/services/helpers.js")>();
  return {
    ...original,
    lockAccountReferences: async (...args: Parameters<typeof original.lockAccountReferences>) => {
      order.push("account");
      return original.lockAccountReferences(...args);
    },
    lockCategoryNamespace: async (...args: Parameters<typeof original.lockCategoryNamespace>) => {
      order.push("category");
      return original.lockCategoryNamespace(...args);
    },
    lockPayeeNamespace: async (...args: Parameters<typeof original.lockPayeeNamespace>) => {
      order.push("payee");
      return original.lockPayeeNamespace(...args);
    },
  };
});

const { createAccount } = await import("../../src/server/services/accounts.js");
const { createCategory } = await import("../../src/server/services/categories.js");
const { bulkEditStages, createStage, updateStage } =
  await import("../../src/server/services/staging.js");
const { createTransaction, setTransactionDeleted, updateTransaction } =
  await import("../../src/server/services/transactions.js");
const { createRecurrence } = await import("../../src/server/services/recurrences.js");
const { createTransactionTemplate } =
  await import("../../src/server/services/transaction-templates.js");

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("lock_order");
const actor: Actor = { userId: "integration-lock-order", source: "web" };
let keySeed = 0;
const key = () => `lock-order-${String((keySeed += 1)).padStart(6, "0")}`;

/** Whenever both are taken, the category lock comes first. */
const categoryBeforePayee = () => {
  const category = order.indexOf("category");
  const payee = order.indexOf("payee");
  return { category, payee, ordered: category !== -1 && payee !== -1 && category < payee };
};

integration("moving off a category", () => {
  let accountId: string;
  let categoryId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Lock order",
      email: "lock-order@example.com",
      emailVerified: true,
    });
    accountId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "100.00",
      })
    ).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    categoryId = (await createCategory(actor, { name: `Leaving ${key()}`, kind: "expense" })).id;
    order.length = 0;
  });

  const withdrawal = (category: string | null) => ({
    type: "withdrawal" as const,
    date: "2026-02-01",
    payee: "Corner shop",
    description: null,
    fromAccountId: accountId,
    amount: "4.00",
    ...(category ? { categoryId: category } : {}),
  });

  it("takes the category lock first when an entry is edited off it", async () => {
    const entry = await createTransaction(actor, withdrawal(categoryId), key());
    order.length = 0;
    await updateTransaction(actor, entry.id, {
      draft: withdrawal(null),
      expectedVersion: entry.version,
    });
    expect(categoryBeforePayee(), order.join(" → ")).toMatchObject({ ordered: true });
  });

  it("takes the category lock first when a staged row is edited off it", async () => {
    const staged = await createStage(actor, {
      draft: withdrawal(categoryId),
      idempotencyKey: key(),
    });
    order.length = 0;
    await updateStage(actor, staged.id, {
      draft: withdrawal(null),
      expectedVersion: staged.version,
    });
    expect(categoryBeforePayee(), order.join(" → ")).toMatchObject({ ordered: true });
  });

  it("takes the category lock first when staged rows are cleared of it in bulk", async () => {
    const staged = await createStage(actor, {
      draft: withdrawal(categoryId),
      idempotencyKey: key(),
    });
    order.length = 0;
    await bulkEditStages(actor, {
      selection: { mode: "ids", items: [{ id: staged.id, expectedVersion: staged.version }] },
      patch: { categoryId: null },
      idempotencyKey: key(),
    });
    expect(categoryBeforePayee(), order.join(" → ")).toMatchObject({ ordered: true });
  });

  // Voiding moves money off an account as surely as an edit does, and took no
  // lock on it, so it could race archiving that account: each committed without
  // seeing the other's postings, and the archived account kept the voided sum.
  it("takes the account lock when an entry is voided", async () => {
    const entry = await createTransaction(actor, { ...withdrawal(null), amount: "7.77" }, key());
    order.length = 0;
    await setTransactionDeleted(actor, entry.id, entry.version, true);
    expect(order[0], order.join(" → ")).toBe("account");
  });

  // A template or a recurrence names accounts the way an entry does, and took
  // no lock on them: `deleteAccount` counts references under that lock, so an
  // account could be deleted while something naming it was being created. The
  // account lock first, as every entry takes it, so neither order inverts.
  it("takes the account lock before the category lock for a recurrence and a template", async () => {
    await createRecurrence(actor, {
      name: `Rent ${key()}`,
      shape: {
        type: "withdrawal",
        payee: "Landlord",
        fromAccountId: accountId,
        amount: "9.00",
        categoryId,
      },
      schedule: { frequency: "monthly", anchorDate: "2026-02-01" },
    });
    expect(order.slice(0, 2), order.join(" → ")).toEqual(["account", "category"]);
    order.length = 0;
    await createTransactionTemplate(actor, {
      name: `Template ${key()}`,
      draft: { type: "withdrawal", payee: "Landlord", fromAccountId: accountId, categoryId },
    });
    expect(order.slice(0, 2), order.join(" → ")).toEqual(["account", "category"]);
  });
});
