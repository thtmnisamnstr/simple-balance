import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { scratchDatabase } from "./support/scratch-database.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import {
  createTransaction,
  getTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("splits");
const actor: Actor = { userId: "integration-splits", source: "web" };

/** Every posting of one transaction, with the leg it belongs to. */
async function postingsOf(transactionId: string) {
  const result = await getDb().execute(sql`
    select p.leg_id, p.amount::text as amount, p.account_id, a.system_kind
    from posting p
    join ledger_account a on a.id = p.account_id
    where p.transaction_id = ${transactionId}::uuid
    order by p.created_at, p.amount
  `);
  return result.rows as {
    leg_id: string | null;
    amount: string;
    account_id: string;
    system_kind: string | null;
  }[];
}

/** What each leg is currently worth once its postings are netted. */
async function legPositions(transactionId: string) {
  const result = await getDb().execute(sql`
    select l.id, l.ordinal, l.category_id, l.amount::text as leg_amount,
           coalesce(sum(p.amount), 0)::text as posted
    from transaction_leg l
    left join posting p on p.leg_id = l.id
    where l.transaction_id = ${transactionId}::uuid
    group by l.id, l.ordinal, l.category_id, l.amount
    order by l.ordinal
  `);
  return result.rows as {
    id: string;
    ordinal: number;
    category_id: string | null;
    leg_amount: string;
    posted: string;
  }[];
}

async function legCount(transactionId: string) {
  const result = await getDb().execute(sql`
    select leg_count from ledger_transaction where id = ${transactionId}::uuid
  `);
  return Number((result.rows[0] as { leg_count: number }).leg_count);
}

async function postingTotal(transactionId: string) {
  const result = await getDb().execute(sql`
    select coalesce(sum(amount), 0)::text as total from posting
    where transaction_id = ${transactionId}::uuid
  `);
  return (result.rows[0] as { total: string }).total;
}

integration("splitting a transaction across categories", () => {
  let checkingId: string;
  let foodId: string;
  let householdId: string;
  let petsId: string;

  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Splits Tenant",
      email: "splits@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Split Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2027-01-01",
        openingBalance: "1000",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    householdId = (await createCategory(actor, { name: "Household", kind: "expense" })).id;
    petsId = (await createCategory(actor, { name: "Pets", kind: "expense" })).id;
  });

  afterAll(async () => {
    await database.drop();
  });

  // Each receipt gets its own payee: same date, same account and same amount is
  // the duplicate fingerprint, and the split deliberately plays no part in it.
  const receipt = (legs: unknown, key: string) =>
    createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2027-03-01",
        payee: `Costco ${key}`,
        fromAccountId: checkingId,
        amount: "100.00",
        legs,
      } as never,
      key,
    );

  const edit = (id: string, key: string, expectedVersion: number, extra: unknown) =>
    updateTransaction(actor, id, {
      expectedVersion,
      draft: {
        type: "withdrawal",
        date: "2027-03-01",
        payee: `Costco ${key}`,
        fromAccountId: checkingId,
        amount: "100.00",
        ...(extra as object),
      },
    } as never);

  it("posts one counter-account line per leg, and still balances", async () => {
    const created = await receipt(
      [
        { categoryId: foodId, amount: "60.00" },
        { categoryId: householdId, amount: "30.00" },
        { categoryId: petsId, amount: "10.00" },
      ],
      "split-create",
    );

    const rows = await postingsOf(created.id);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.leg_id === null)).toHaveLength(1);
    expect(await postingTotal(created.id)).toBe("0.000000000000000000");
    expect(await legCount(created.id)).toBe(3);

    const legs = await legPositions(created.id);
    expect(legs.map((leg) => leg.ordinal)).toEqual([0, 1, 2]);
    expect(legs.map((leg) => leg.category_id)).toEqual([foodId, householdId, petsId]);
    expect(legs.map((leg) => leg.posted)).toEqual([
      "60.000000000000000000",
      "30.000000000000000000",
      "10.000000000000000000",
    ]);
  });

  /**
   * The point of keeping the label on the leg rather than on the posting: the
   * leg's identity does not change when it is relabelled, so the difference
   * between what is posted and what should be posted is empty.
   */
  it("writes no postings at all when a leg is only recategorised", async () => {
    const created = await receipt(
      [
        { categoryId: foodId, amount: "70.00" },
        { categoryId: householdId, amount: "30.00" },
      ],
      "split-recategorise",
    );
    const before = await postingsOf(created.id);
    const [first, second] = await legPositions(created.id);

    await edit(created.id, "split-recategorise", created.version, {
      legs: [
        { id: first.id, categoryId: petsId, amount: "70.00" },
        { id: second.id, categoryId: householdId, amount: "30.00" },
      ],
    });

    expect(await postingsOf(created.id)).toEqual(before);
    const after = await legPositions(created.id);
    expect(after[0]!.category_id).toBe(petsId);
    expect(after[0]!.id).toBe(first.id);
  });

  /**
   * The identity rule, which is the whole reason a leg has an id on the wire.
   * Sending a leg without one asks for a new leg, and the leg it replaced is
   * zeroed rather than quietly reused, so nothing is attributed to a category
   * the person did not choose.
   */
  it("treats a leg sent without an id as a new leg, and retires the one it replaced", async () => {
    const created = await receipt(
      [
        { categoryId: foodId, amount: "70.00" },
        { categoryId: householdId, amount: "30.00" },
      ],
      "split-replace",
    );
    const [first, second] = await legPositions(created.id);

    await edit(created.id, "split-replace", created.version, {
      legs: [
        { id: first.id, categoryId: foodId, amount: "70.00" },
        { categoryId: petsId, amount: "30.00" },
      ],
    });

    const after = await legPositions(created.id);
    expect(after).toHaveLength(3);
    expect(after.find((leg) => leg.id === second.id)!.posted).toBe("0.000000000000000000");
    expect(after.find((leg) => leg.category_id === petsId)!.posted).toBe("30.000000000000000000");
    expect(await postingTotal(created.id)).toBe("0.000000000000000000");
    expect(await legCount(created.id)).toBe(2);
  });

  it("writes exactly two adjusting postings when a leg's share changes", async () => {
    const created = await receipt(
      [
        { categoryId: foodId, amount: "60.00" },
        { categoryId: householdId, amount: "40.00" },
      ],
      "split-reweight",
    );
    const legs = await legPositions(created.id);

    await edit(created.id, "split-reweight", created.version, {
      legs: [
        { id: legs[0]!.id, categoryId: foodId, amount: "75.00" },
        { id: legs[1]!.id, categoryId: householdId, amount: "25.00" },
      ],
    });

    expect(await postingsOf(created.id)).toHaveLength(5);
    expect(await postingTotal(created.id)).toBe("0.000000000000000000");
    expect((await legPositions(created.id)).map((leg) => leg.posted)).toEqual([
      "75.000000000000000000",
      "25.000000000000000000",
    ]);
  });

  it("zeroes a leg dropped from the split rather than deleting it", async () => {
    const created = await receipt(
      [
        { categoryId: foodId, amount: "60.00" },
        { categoryId: householdId, amount: "40.00" },
      ],
      "split-drop",
    );
    const legs = await legPositions(created.id);

    await edit(created.id, "split-drop", created.version, { categoryId: foodId });

    // Both rows survive, because the postings that name them are append-only.
    const after = await legPositions(created.id);
    expect(after).toHaveLength(2);
    expect(after.map((leg) => leg.leg_amount)).toEqual([
      "0.000000000000000000",
      "0.000000000000000000",
    ]);
    expect(after.map((leg) => leg.posted)).toEqual([
      "0.000000000000000000",
      "0.000000000000000000",
    ]);
    expect(await legCount(created.id)).toBe(0);
    expect(await postingTotal(created.id)).toBe("0.000000000000000000");
    expect((await getTransaction(actor, created.id)).category?.id).toBe(foodId);
    expect(legs).toHaveLength(2);
  });

  it("voids each leg on its own when the transaction is deleted, and puts them all back", async () => {
    const created = await receipt(
      [
        { categoryId: foodId, amount: "55.00" },
        { categoryId: householdId, amount: "45.00" },
      ],
      "split-delete",
    );

    const deleted = await setTransactionDeleted(actor, created.id, created.version, true);
    expect((await legPositions(created.id)).map((leg) => leg.posted)).toEqual([
      "0.000000000000000000",
      "0.000000000000000000",
    ]);

    await setTransactionDeleted(actor, created.id, deleted.version, false);
    const restored = await legPositions(created.id);
    expect(restored.map((leg) => leg.posted)).toEqual([
      "55.000000000000000000",
      "45.000000000000000000",
    ]);
    expect(restored.map((leg) => leg.category_id)).toEqual([foodId, householdId]);
    expect(await postingTotal(created.id)).toBe("0.000000000000000000");
  });

  it("refuses a split that does not add up, naming both totals", async () => {
    await expect(
      receipt(
        [
          { categoryId: foodId, amount: "60.00" },
          { categoryId: householdId, amount: "35.00" },
        ],
        "split-short",
      ),
    ).rejects.toThrow(/adds up to 95/);
  });

  it("creates a category named by a leg, and reuses it for a second leg naming the same one", async () => {
    const created = await receipt(
      [
        { categoryName: "Garden supplies", amount: "40.00" },
        { categoryName: "garden supplies", amount: "60.00" },
      ],
      "split-by-name",
    );
    const legs = await legPositions(created.id);
    expect(legs[0]!.category_id).toBe(legs[1]!.category_id);
    expect(legs[0]!.category_id).not.toBeNull();
  });
});
