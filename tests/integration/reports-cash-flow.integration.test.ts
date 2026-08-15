import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccount,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import { getReport } from "../../src/server/services/reports.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("cash_flow");
const actor: Actor = { userId: "cash-flow-user", source: "web" };

let keySeed = 0;
const nextKey = () => `cashflow-${(keySeed += 1)}`.padEnd(16, "0");

let checkingId = "";
let savingsId = "";
let cardId = "";
let brokerageId = "";
let euroId = "";
let foodId = "";
let salaryId = "";

const year = { start: "2026-01-01", end: "2026-06-30" };

type Report = Awaited<ReturnType<typeof getReport>>;

const usd = (report: Report) =>
  report.currencies.find((entry) => entry.currency === "USD");

const segments = (report: Report) =>
  Object.fromEntries((usd(report)?.rows ?? []).map((row) => [row.key, row.total]));

integration("the cash flow statement", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Cash Flow",
      email: "cash-flow@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "2000",
      })
    ).id;
    savingsId = (
      await createAccount(actor, {
        name: "Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
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
    brokerageId = (
      await createAccount(actor, {
        name: "Brokerage",
        type: "investment",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    euroId = (
      await createAccount(actor, {
        name: "Euro",
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    salaryId = (await createCategory(actor, { name: "Salary", kind: "income" }))
      .id;

    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-02-01",
        payee: "Employer",
        amount: "4000",
        toAccountId: checkingId,
        categoryId: salaryId,
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-05",
        payee: "Grocer",
        amount: "300",
        fromAccountId: checkingId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    // Bought on the card in February, paid off in March. The expense and the
    // cash leaving are different months on purpose.
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-02-10",
        payee: "Restaurant",
        amount: "120",
        fromAccountId: cardId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-03-01",
        payee: "Card payment",
        fromAccountId: checkingId,
        toAccountId: cardId,
        sourceAmount: "120",
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-03-05",
        payee: "Save",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        sourceAmount: "500",
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-03-10",
        payee: "Invest",
        fromAccountId: checkingId,
        toAccountId: brokerageId,
        sourceAmount: "700",
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-04-01",
        payee: "Convert",
        fromAccountId: checkingId,
        toAccountId: euroId,
        sourceAmount: "220",
        destinationAmount: "200",
      } as never,
      nextKey(),
    );
    // A split, to prove three legs present one counterpart rather than three.
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-04-10",
        payee: "Market",
        amount: "90",
        fromAccountId: checkingId,
        legs: [
          { categoryId: foodId, amount: "50" },
          { categoryId: foodId, amount: "25" },
          { amount: "15" },
        ],
      } as never,
      nextKey(),
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  /**
   * The join is exact or the figures are multiples of themselves. Dropping the
   * currency match gives a conversion three counterparts; dropping the group by
   * in `sides` gives a three-leg split three. Both multiply silently, so the
   * distribution is asserted rather than a total that could be wrong twice.
   */
  it("resolves every movement to exactly one counterpart", async () => {
    const result = await getDb().execute(sql`
      with cash as (
        select a.id from ledger_account a
        where a.user_id = ${actor.userId} and a.system_kind is null
          and a.type in ('checking', 'savings', 'cash') and a.archived_at is null
      ),
      sides as (
        select p.transaction_id, p.currency, p.account_id
        from posting p
        where p.user_id = ${actor.userId} and p.transaction_id is not null
        group by 1, 2, 3
      ),
      moves as (
        select p.id, p.transaction_id, p.currency, p.account_id
        from posting p join cash on cash.id = p.account_id
        where p.user_id = ${actor.userId}
          and p.closing_account_id is null
          and p.transaction_id is not null
      )
      select counterparts, count(*)::int as movements
      from (
        select m.id, count(s.account_id)::int as counterparts
        from moves m
        left join sides s
          on s.transaction_id = m.transaction_id
          and s.currency = m.currency
          and s.account_id <> m.account_id
        group by m.id
      ) tallied
      group by 1
      order by 1
    `);
    expect(result.rows.map((row) => Number(row.counterparts))).toEqual([1]);
    expect(Number(result.rows[0]!.movements)).toBeGreaterThan(5);
  });

  it("adds its segments up to the change in the spendable accounts", async () => {
    const report = await getReport(actor, { report: "cash-flow", ...year });
    const moved = await getDb().execute(sql`
      select coalesce(sum(p.amount), 0)::text as net
      from posting p
      join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
      where p.user_id = ${actor.userId}
        and a.system_kind is null
        and a.type in ('checking', 'savings', 'cash')
        and a.archived_at is null
        and p.currency = 'USD'
        and p.closing_account_id is null
        and p.date between ${year.start}::date and ${year.end}::date
    `);
    const acrossBuckets = usd(report)!.totals.reduce(
      (sum, value) => sum + Number(value),
      0,
    );
    const acrossSegments = usd(report)!.rows.reduce(
      (sum, entry) => sum + Number(entry.total),
      0,
    );
    expect(acrossBuckets).toBe(Number(moved.rows[0]!.net));
    expect(acrossSegments).toBe(Number(moved.rows[0]!.net));
  });

  it("puts no movement in the catch-all segment", async () => {
    const report = await getReport(actor, { report: "cash-flow", ...year });
    expect(segments(report).other).toBeUndefined();
  });

  /**
   * The closed-set invariant, and the strongest single assertion here. Money
   * moved between two spendable accounts leaves one and enters the other, so
   * once every such account is in the report the segment has to vanish. A sign
   * error on either side, or a counterpart counted twice, shows up here and
   * nowhere else.
   */
  it("nets movement between spendable accounts to exactly zero", async () => {
    const report = await getReport(
      actor,
      { report: "cash-flow", ...year },
      true,
    );
    expect(segments(report).internal).toBe("0");
  });

  it("separates earning and spending from borrowing and investing", async () => {
    const report = await getReport(actor, { report: "cash-flow", ...year });
    const totals = segments(report);
    expect(totals.operating).toBe("3610");
    expect(totals.financing).toBe("-120");
    expect(totals.investing).toBe("-700");
    expect(totals.exchange).toBe("-220");
  });

  /**
   * The number people will report as a defect. An expense is recognised when
   * the card is swiped; the cash leaves when the bill is paid. Both are right,
   * and reconciling them would mean choosing one of the two questions to stop
   * answering.
   */
  it("dates a card purchase to the swipe and its cash to the payment", async () => {
    const monthly = await getReport(actor, {
      report: "cash-flow",
      ...year,
      bucket: "month",
    });
    const february = monthly.buckets.findIndex(
      (bucket) => bucket.start === "2026-02-01",
    );
    const march = monthly.buckets.findIndex(
      (bucket) => bucket.start === "2026-03-01",
    );
    const financing = usd(monthly)!.rows.find((row) => row.key === "financing")!;
    expect(financing.values[february]).toBe("0");
    expect(financing.values[march]).toBe("-120");

    const spending = await getReport(actor, {
      report: "income-expense",
      ...year,
      bucket: "month",
    });
    const expense = usd(spending)!.rows.find((row) => row.key === "expense")!;
    expect(expense.values[february]).toBe("-420");
    expect(expense.values[march]).toBe("0");
  });

  it("counts a split receipt once rather than once per leg", async () => {
    const april = await getReport(actor, {
      report: "cash-flow",
      start: "2026-04-10",
      end: "2026-04-10",
    });
    expect(segments(april).operating).toBe("-90");
  });

  /**
   * Archiving posts an account's balance out to equity. Counted as movement
   * that reads as spending the whole balance on the day the account closed, so
   * the report would show an outflow of money nobody moved.
   */
  it("reports no outflow when an account is archived inside the window", async () => {
    const toToday = { start: "2026-01-01" };
    const before = await getReport(
      actor,
      { report: "cash-flow", ...toToday },
      true,
    );
    const loaded = await getAccount(actor, savingsId);
    await setAccountArchived(actor, savingsId, loaded.version, true);
    try {
      const after = await getReport(
        actor,
        { report: "cash-flow", ...toToday },
        true,
      );
      expect(segments(after)).toEqual(segments(before));
    } finally {
      const archived = await getAccount(actor, savingsId);
      await setAccountArchived(actor, savingsId, archived.version, false);
    }
  });

  /**
   * Restoring appends the reversal rather than deleting the closing pair, so
   * both halves sit inside the window netting to nothing. Counted, they leave
   * the net right and both gross columns inflated by the balance.
   */
  it("leaves the figures alone when an account is archived and restored", async () => {
    const toToday = { start: "2026-01-01" };
    const before = await getReport(
      actor,
      { report: "cash-flow", ...toToday },
      true,
    );
    const loaded = await getAccount(actor, savingsId);
    await setAccountArchived(actor, savingsId, loaded.version, true);
    const archived = await getAccount(actor, savingsId);
    await setAccountArchived(actor, savingsId, archived.version, false);

    const after = await getReport(
      actor,
      { report: "cash-flow", ...toToday },
      true,
    );
    expect(segments(after)).toEqual(segments(before));
  });

  it("shows a conversion once, in the currency that moved", async () => {
    const report = await getReport(actor, { report: "cash-flow", ...year });
    const euro = report.currencies.find((entry) => entry.currency === "EUR")!;
    expect(usd(report)!.rows.find((row) => row.key === "exchange")!.total).toBe(
      "-220",
    );
    expect(euro.rows.find((row) => row.key === "exchange")!.total).toBe("200");
  });

  it("answers the counterpart without a query per movement", async () => {
    const text = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = await tx.execute(sql`
        explain
        with cash as (
          select a.id from ledger_account a
          where a.user_id = ${actor.userId} and a.system_kind is null
            and a.type in ('checking', 'savings', 'cash') and a.archived_at is null
        ),
        sides as (
          select p.transaction_id, p.currency, p.account_id, a.system_kind, a.type
          from posting p
          join ledger_account a on a.user_id = p.user_id and a.id = p.account_id
          where p.user_id = ${actor.userId} and p.transaction_id is not null
          group by 1, 2, 3, a.system_kind, a.type
        ),
        moves as (
          select p.transaction_id, p.date, p.currency, p.account_id, p.amount
          from posting p join cash on cash.id = p.account_id
          where p.user_id = ${actor.userId} and p.closing_account_id is null
        )
        select m.currency, s.system_kind, sum(m.amount)
        from moves m
        left join sides s
          on s.transaction_id = m.transaction_id
          and s.currency = m.currency
          and s.account_id <> m.account_id
        group by 1, 2
      `);
      return plan.rows.map((row) => Object.values(row)[0]).join("\n");
    });

    expect(text).not.toContain("SubPlan");
  });
});
