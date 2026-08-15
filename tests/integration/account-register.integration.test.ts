import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccount,
  getAccountBalances,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import { getAccountRegister } from "../../src/server/services/reports.js";
import {
  createTransaction,
  getTransaction,
  setTransactionDeleted,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("account_register");
const actor: Actor = { userId: "register-user", source: "web" };

let keySeed = 0;
const nextKey = () => `register-${String((keySeed += 1)).padStart(6, "0")}`;

let checkingId = "";
let spareId = "";
let foodId = "";
let refundId = "";

integration("the account register", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Register",
      email: "register@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "100",
      })
    ).id;
    spareId = (
      await createAccount(actor, {
        name: "Spare",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "40",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    refundId = (await createCategory(actor, { name: "Refunds", kind: "both" }))
      .id;

    // Two on one day, so the tie-break has something to break.
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Morning",
        amount: "10",
        fromAccountId: checkingId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-01",
        payee: "Evening",
        amount: "5",
        fromAccountId: checkingId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-03-01",
        payee: "Refund",
        amount: "25",
        toAccountId: checkingId,
        categoryId: refundId,
      } as never,
      nextKey(),
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it("opens on the account's opening balance", async () => {
    const register = await getAccountRegister(actor, checkingId, {});
    expect(register.openingBalance).toBe("0");
    expect(register.entries[0]!.origin).toBe("opening");
    expect(register.entries[0]!.balanceAfter).toBe("100");
  });

  /**
   * The window frame is the assertion. `1 preceding` instead of `current row`
   * leaves every balance one posting stale, which looks plausible on any single
   * row and only shows up against a figure computed another way.
   */
  it("ends on the balance the account actually holds", async () => {
    const register = await getAccountRegister(actor, checkingId, {});
    const balances = await getAccountBalances(actor, checkingId, {});
    expect(register.closingBalance).toBe("110");
    expect(register.entries[register.entries.length - 1]!.balanceAfter).toBe(
      balances.current.balance,
    );
  });

  /**
   * Computing the opening from `<= start` rather than `< start` counts the
   * first day twice, which is invisible unless something posted on exactly that
   * boundary.
   */
  it("adds the window's movement to its opening balance", async () => {
    const register = await getAccountRegister(actor, checkingId, {
      start: "2026-02-01",
      end: "2026-03-31",
    });
    expect(register.openingBalance).toBe("100");
    const moved = register.entries.reduce(
      (sum, entry) => sum + Number(entry.amount),
      0,
    );
    expect(Number(register.openingBalance) + moved).toBe(
      Number(register.closingBalance),
    );
    expect(register.closingBalance).toBe("110");
  });

  it("carries a balance before and after every row", async () => {
    const register = await getAccountRegister(actor, checkingId, {});
    for (const entry of register.entries) {
      expect(Number(entry.balanceBefore) + Number(entry.amount)).toBe(
        Number(entry.balanceAfter),
      );
    }
  });

  /**
   * Two postings share 2026-02-01. Ordering by date alone leaves their order to
   * whatever the scan produced, so the balance printed beside each of them
   * could differ between two calls that returned the same rows.
   */
  it("returns the same order every time", async () => {
    const first = await getAccountRegister(actor, checkingId, {});
    const second = await getAccountRegister(actor, checkingId, {});
    expect(second.entries.map((entry) => entry.postingId)).toEqual(
      first.entries.map((entry) => entry.postingId),
    );
    const sameDay = first.entries.filter(
      (entry) => entry.date === "2026-02-01",
    );
    expect(sameDay.length).toBe(2);
  });

  /**
   * Deleting posts the reversal on the original posting's date, so the pair
   * collides on date. `posting.id` is a random uuid, so ordering on it alone
   * listed the reversal first about half the time and walked the balance
   * through a figure the account never held.
   */
  it("lists a reversal after the row it reverses", async () => {
    const voided = [];
    for (let day = 1; day <= 8; day += 1) {
      voided.push(
        await createTransaction(
          actor,
          {
            type: "withdrawal",
            date: `2026-05-0${day}`,
            payee: `Undone ${day}`,
            amount: "10",
            fromAccountId: checkingId,
            categoryId: foodId,
          } as never,
          nextKey(),
        ),
      );
    }
    for (const entry of voided) {
      const current = await getTransaction(actor, entry.id);
      await setTransactionDeleted(actor, entry.id, current.version, true, true);
    }

    const register = await getAccountRegister(actor, checkingId, {
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(register.entries.length).toBe(16);
    for (let index = 0; index + 1 < register.entries.length; index += 2) {
      expect(Number(register.entries[index]!.amount)).toBeLessThan(0);
      expect(Number(register.entries[index + 1]!.amount)).toBeGreaterThan(0);
    }
    const highest = register.entries.reduce(
      (peak, entry) => Math.max(peak, Number(entry.balanceAfter)),
      0,
    );
    expect(highest).toBe(Number(register.openingBalance));
  });

  it("stops at today rather than at an end in the future", async () => {
    const register = await getAccountRegister(actor, checkingId, {
      end: "9999-12-31",
    });
    expect(register.asOf).toBe(new Date().toISOString().slice(0, 10));
    expect(register.range.end).toBe("9999-12-31");
  });

  /**
   * Archiving posts the balance out to equity, so the register has to end on
   * zero and show the row that took it there. Filtering closing postings out
   * would leave the account looking as though it still held the money.
   */
  it("ends an archived account at zero, showing the row that closed it", async () => {
    const loaded = await getAccount(actor, spareId);
    await setAccountArchived(actor, spareId, loaded.version, true);
    const register = await getAccountRegister(actor, spareId, {});
    expect(register.closingBalance).toBe("0");
    expect(register.entries.some((entry) => entry.origin === "closing")).toBe(
      true,
    );
    expect(register.archivedAt).not.toBeNull();
  });

  it("refuses an account that is not this person's", async () => {
    await expect(
      getAccountRegister(
        { userId: "someone-else", source: "web" },
        checkingId,
        {},
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses a register longer than it will list", async () => {
    const { MAX_REGISTER_ENTRIES } = await import(
      "../../src/shared/domain.js"
    );
    expect(MAX_REGISTER_ENTRIES).toBeGreaterThan(0);
    const wide = await getAccountRegister(actor, checkingId, {});
    expect(wide.entries.length).toBeLessThanOrEqual(MAX_REGISTER_ENTRIES);
  });

  it("refuses a range that runs backwards", async () => {
    await expect(
      getAccountRegister(actor, checkingId, {
        start: "2026-06-01",
        end: "2026-01-01",
      }),
    ).rejects.toThrow(/on or before/);
  });

  /**
   * The ordering has to be one an index can produce. Sorts and sequential scans
   * are priced out so the plan shows whether an index can serve it at all
   * rather than whether the planner bothers on a handful of rows. An
   * incremental sort is the expected shape: the index carries the date and the
   * `id` tie-break is resolved within each day.
   */
  it("reads the register in an order an index can serve", async () => {
    const text = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_sort = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const plan = await tx.execute(sql`
        explain
        select p.id, p.date, p.amount,
          sum(p.amount) over (
            order by p.date, p.id
            rows between unbounded preceding and current row
          )
        from posting p
        where p.user_id = ${actor.userId}
          and p.account_id = ${checkingId}::uuid
          and p.date <= '2026-12-31'::date
        order by p.date, p.id
      `);
      return plan.rows.map((row) => Object.values(row)[0]).join("\n");
    });

    expect(text).toContain("Index Scan");
    expect(text).not.toMatch(/->\s+Sort\b/);
  });
});
