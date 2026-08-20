import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  createStage,
  getStagedDuplicateReview,
  listStages,
} from "../../src/server/services/staging.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("staged_duplicates");
const actor: Actor = { userId: "staged-dup-user", source: "web" };

let keySeed = 0;
const nextKey = () => `dup-${String((keySeed += 1)).padStart(6, "0")}`;

let checkingId = "";
let cardId = "";
let foodId = "";
let funId = "";
let committedId = "";

const stage = async (draft: Record<string, unknown>) =>
  createStage(actor, { draft, idempotencyKey: nextKey() });

const flagged = async () => {
  const page = await listStages(actor, { limit: 100 });
  return Object.fromEntries(
    page.items.map((row) => [
      String((row.draft as { payee?: unknown }).payee),
      row.likelyDuplicateOfId,
    ]),
  );
};

integration("a staged row that looks like a committed transaction", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Staged Duplicates",
      email: "staged-dup@example.com",
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
    cardId = (
      await createAccount(actor, {
        name: "Card",
        type: "credit_card",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    funId = (await createCategory(actor, { name: "Fun", kind: "expense" })).id;

    committedId = (
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-10",
          payee: "SQ *BLUE BOTTLE",
          amount: "42.50",
          fromAccountId: checkingId,
          categoryId: foodId,
        } as never,
        nextKey(),
      )
    ).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  /**
   * The pair this exists for. `findDuplicate`, which the commit guard uses,
   * wants the same day and the same payee, and a real import has neither: the
   * bank posts when it settles and names the merchant its own way.
   */
  it("finds it across a different payee, a different category and a few days", async () => {
    await stage({
      type: "withdrawal",
      date: "2026-03-12",
      payee: "Blue Bottle Coffee",
      amount: "42.50",
      fromAccountId: checkingId,
      categoryId: funId,
    });
    expect((await flagged())["Blue Bottle Coffee"]).toBe(committedId);
  });

  it("stops at the edge of the window rather than a little past it", async () => {
    await stage({
      type: "withdrawal",
      date: "2026-03-13",
      payee: "Three days out",
      amount: "42.50",
      fromAccountId: checkingId,
    });
    await stage({
      type: "withdrawal",
      date: "2026-03-14",
      payee: "Four days out",
      amount: "42.50",
      fromAccountId: checkingId,
    });
    const rows = await flagged();
    expect(rows["Three days out"]).toBe(committedId);
    expect(rows["Four days out"]).toBeNull();
  });

  it("keeps two unrelated spends of the same size apart", async () => {
    await stage({
      type: "withdrawal",
      date: "2026-03-10",
      payee: "Other account",
      amount: "42.50",
      fromAccountId: cardId,
    });
    await stage({
      type: "withdrawal",
      date: "2026-03-10",
      payee: "Other amount",
      amount: "42.51",
      fromAccountId: checkingId,
    });
    await stage({
      type: "deposit",
      date: "2026-03-10",
      payee: "Other direction",
      amount: "42.50",
      toAccountId: checkingId,
    });
    const rows = await flagged();
    expect(rows["Other account"]).toBeNull();
    expect(rows["Other amount"]).toBeNull();
    expect(rows["Other direction"]).toBeNull();
  });

  /**
   * A row whose draft holds whatever a CSV put in the date column is exactly the
   * row somebody is in the queue to fix. The date cast would raise on it, which
   * is why the comparison sits behind a `case` rather than an `and`.
   */
  it("reads a queue holding drafts it cannot parse", async () => {
    await stage({
      type: "withdrawal",
      date: "not-a-date",
      payee: "Bad date",
      amount: "42.50",
      fromAccountId: checkingId,
    });
    await stage({
      type: "withdrawal",
      payee: "No date",
      amount: "42.50",
      fromAccountId: checkingId,
    });
    await stage({
      type: "withdrawal",
      date: "2026-03-10",
      payee: "Bad amount",
      amount: "42x50",
      fromAccountId: checkingId,
    });
    const rows = await flagged();
    expect(rows["Bad date"]).toBeNull();
    expect(rows["No date"]).toBeNull();
    expect(rows["Bad amount"]).toBeNull();
  });

  it("offers them all under the one duplicate filter", async () => {
    const page = await listStages(actor, { limit: 100, validity: "duplicate" });
    const payees = page.items.map(
      (row) => (row.draft as { payee?: unknown }).payee,
    );
    expect(payees).toContain("Blue Bottle Coffee");
    expect(payees).toContain("Three days out");
    expect(payees).not.toContain("Four days out");
    expect(page.totalCount).toBe(payees.length);
  });

  it("stops flagging once the committed transaction is deleted", async () => {
    const { setTransactionDeleted, getTransaction } = await import(
      "../../src/server/services/transactions.js"
    );
    const current = await getTransaction(actor, committedId);
    await setTransactionDeleted(actor, committedId, current.version, true, true);
    try {
      expect((await flagged())["Blue Bottle Coffee"]).toBeNull();
    } finally {
      const deleted = await getTransaction(actor, committedId);
      await setTransactionDeleted(actor, committedId, deleted.version, false, true);
    }
  });

  /**
   * Which side is which. A committed transaction is second whatever its date,
   * because it is the one already in the books and the staged row is the one
   * still up for a decision.
   */
  it("puts the committed transaction second", async () => {
    const page = await listStages(actor, { limit: 100 });
    const subject = page.items.find(
      (row) => (row.draft as { payee?: unknown }).payee === "Blue Bottle Coffee",
    )!;
    const review = await getStagedDuplicateReview(actor, subject.id);
    expect(review.first.kind).toBe("staged");
    expect(review.first.staged?.id).toBe(subject.id);
    expect(review.second?.kind).toBe("committed");
    expect(review.second?.committed?.id).toBe(committedId);
    expect(review.second?.staged).toBeNull();
    expect(review.first.committed).toBeNull();
  });

  it("puts the older row second when both sides are staged", async () => {
    const older = await stage({
      type: "withdrawal",
      date: "2026-05-01",
      payee: "Twice entered",
      amount: "88.00",
      fromAccountId: checkingId,
    });
    const newer = await stage({
      type: "withdrawal",
      date: "2026-05-01",
      payee: "Twice entered",
      amount: "88.00",
      fromAccountId: checkingId,
    });

    const fromNewer = await getStagedDuplicateReview(actor, newer.id);
    expect(fromNewer.first.staged?.id).toBe(newer.id);
    expect(fromNewer.second?.kind).toBe("staged");
    expect(fromNewer.second?.staged?.id).toBe(older.id);

    // Opened from either side, the older row is still the one underneath.
    const fromOlder = await getStagedDuplicateReview(actor, older.id);
    expect(fromOlder.first.staged?.id).toBe(newer.id);
    expect(fromOlder.second?.staged?.id).toBe(older.id);
  });

  it("offers no second side once nothing matches the row", async () => {
    const alone = await stage({
      type: "withdrawal",
      date: "2026-06-01",
      payee: "Only one of these",
      amount: "123.45",
      fromAccountId: checkingId,
    });
    const review = await getStagedDuplicateReview(actor, alone.id);
    expect(review.first.staged?.id).toBe(alone.id);
    expect(review.second).toBeNull();
  });

  it("refuses to review a row that has left the queue", async () => {
    const { deleteStages } = await import(
      "../../src/server/services/staging.js"
    );
    const doomed = await stage({
      type: "withdrawal",
      date: "2026-07-01",
      payee: "About to go",
      amount: "9.99",
      fromAccountId: checkingId,
    });
    await deleteStages(actor, {
      stagedIds: [doomed.id],
      expectedVersions: { [doomed.id]: doomed.version },
    });
    await expect(getStagedDuplicateReview(actor, doomed.id)).rejects.toThrow(
      /not found/i,
    );
  });

  it("sorts the amount column on a queue holding an unparseable amount", async () => {
    const page = await listStages(actor, {
      limit: 100,
      sort: "amount",
      direction: "desc",
    });
    expect(page.items.length).toBeGreaterThan(0);
  });
});
