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
import { getSummary } from "../../src/server/services/summary.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("reports");
const actor: Actor = { userId: "reports-user", source: "web" };

let keySeed = 0;
const nextKey = () => `reports-${String((keySeed += 1)).padStart(6, "0")}`;

let checkingId = "";
let savingsId = "";
let euroId = "";
let cardId = "";
let foodId = "";
let householdId = "";
let salaryId = "";

const year = { start: "2026-01-01", end: "2026-12-31" };

type Report = Awaited<ReturnType<typeof getReport>>;

const usd = (report: Report) =>
  report.currencies.find((entry) => entry.currency === "USD");

type Summary = Awaited<ReturnType<typeof getSummary>>;

const usdSummary = (summary: Summary) =>
  summary.currencies.find((entry) => entry.currency === "USD");

const row = (report: Report, key: string) =>
  usd(report)?.rows.find((entry) => entry.key === key);

const rowsByLabel = (report: Report) =>
  Object.fromEntries(
    (usd(report)?.rows ?? []).map((entry) => [entry.label, entry.total]),
  );

integration("reports", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Reports",
      email: "reports@example.com",
      emailVerified: true,
    });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "1000",
      })
    ).id;
    savingsId = (
      await createAccount(actor, {
        name: "Savings",
        type: "savings",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "500",
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
    euroId = (
      await createAccount(actor, {
        name: "Euro",
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "200",
      })
    ).id;
    foodId = (await createCategory(actor, { name: "Food", kind: "expense" })).id;
    householdId = (
      await createCategory(actor, { name: "Household", kind: "expense" })
    ).id;
    salaryId = (await createCategory(actor, { name: "Salary", kind: "income" }))
      .id;

    await createTransaction(
      actor,
      {
        type: "deposit",
        date: "2026-01-15",
        payee: "Employer",
        amount: "3000",
        toAccountId: checkingId,
        categoryId: salaryId,
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-01-20",
        payee: "Grocer",
        amount: "200",
        fromAccountId: checkingId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
    // March, so February is a bucket with nothing in it.
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-03-10",
        payee: "Market",
        amount: "150",
        fromAccountId: checkingId,
        legs: [
          { categoryId: foodId, amount: "90" },
          { categoryId: householdId, amount: "40" },
          { amount: "20" },
        ],
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "transfer",
        date: "2026-03-15",
        payee: "Move",
        fromAccountId: checkingId,
        toAccountId: savingsId,
        sourceAmount: "300",
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
        sourceAmount: "110",
        destinationAmount: "100",
      } as never,
      nextKey(),
    );
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: "2026-04-05",
        payee: "Restaurant",
        amount: "60",
        fromAccountId: cardId,
        categoryId: foodId,
      } as never,
      nextKey(),
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it("balances the trial balance to zero in every currency", async () => {
    const report = await getReport(actor, {
      report: "trial-balance",
      ...year,
    });
    for (const currency of report.currencies) {
      expect(currency.totals[0]).toBe("0");
    }
    expect(report.currencies.length).toBeGreaterThan(1);
  });

  it("lists the server's own counter-accounts only in the trial balance", async () => {
    const trial = await getReport(actor, { report: "trial-balance", ...year });
    const sheet = await getReport(actor, { report: "balance-sheet", ...year });
    expect(
      usd(trial)!.rows.some((entry) => entry.kind?.startsWith("system:")),
    ).toBe(true);
    expect(
      usd(sheet)!.rows.some((entry) => entry.kind?.startsWith("system:")),
    ).toBe(false);
  });

  it("ignores postings after the date a balance sheet is drawn for", async () => {
    const early = await getReport(actor, {
      report: "balance-sheet",
      end: "2026-02-01",
    });
    expect(row(early, checkingId)!.total).toBe("3800");
    const later = await getReport(actor, {
      report: "balance-sheet",
      end: "2026-03-31",
    });
    expect(row(later, checkingId)!.total).toBe("3350");
  });

  /**
   * Movements add up; balances do not. Summing a monthly net worth reported six
   * times the money the account holds, in a column headed Total on the page and
   * in a field an agent has no way to know it should ignore.
   */
  it("totals a balance row on what it closes on, not on the sum of its columns", async () => {
    const series = await getReport(actor, {
      report: "net-worth",
      ...year,
      bucket: "month",
    });
    for (const currency of series.currencies) {
      for (const entry of currency.rows) {
        expect(entry.total).toBe(entry.values[entry.values.length - 1]);
      }
    }
    const flow = await getReport(actor, {
      report: "income-expense",
      ...year,
      bucket: "month",
    });
    for (const entry of usd(flow)!.rows) {
      const summed = entry.values.reduce((total, value) => total + Number(value), 0);
      expect(Number(entry.total)).toBe(summed);
    }
  });

  /**
   * Archiving posts a balance out to equity. Dropping the account takes its side
   * of that posting with it and leaves the equity side behind, so the one report
   * whose whole claim is that the rows total zero stopped totalling zero for
   * every date before the archive.
   */
  it("balances the trial balance at a date before an account was archived", async () => {
    const before = await getReport(actor, {
      report: "trial-balance",
      end: "2026-05-31",
    });
    const loaded = await getAccount(actor, savingsId);
    await setAccountArchived(actor, savingsId, loaded.version, true);
    try {
      const after = await getReport(actor, {
        report: "trial-balance",
        end: "2026-05-31",
      });
      for (const currency of after.currencies) {
        expect(currency.totals[0]).toBe("0");
      }
      expect(after.currencies.map((one) => one.currency)).toEqual(
        before.currencies.map((one) => one.currency),
      );
    } finally {
      const archived = await getAccount(actor, savingsId);
      await setAccountArchived(actor, savingsId, archived.version, false);
    }
  });

  /**
   * Clamping a future start down to today instead reported today's figures under
   * next month's heading, with the requested range echoed back beside them.
   */
  it("reports nothing for a range that has not happened yet", async () => {
    const ahead = await getReport(actor, {
      report: "income-expense",
      start: "2027-11-01",
      end: "2027-11-30",
      bucket: "month",
    });
    expect(ahead.buckets).toEqual([]);
    expect(ahead.currencies).toEqual([]);
    expect(ahead.range).toEqual({ start: "2027-11-01", end: "2027-11-30" });
  });

  it("ranks categories the way the dashboard ranks them", async () => {
    const summary = await getSummary(actor, year);
    const report = await getReport(actor, { report: "categories", ...year });
    expect(
      usd(report)!
        .rows.filter((entry) => entry.kind === "expense")
        .map((entry) => entry.label),
    ).toEqual(usdSummary(summary)!.spendingByCategory.map((entry) => entry.category));
  });

  /**
   * The two reports are one query with a different number of columns, and this
   * is the assertion that keeps them that way. Seeding the running total from
   * the wrong side — dropping the pre-window opening, or counting it in both
   * the opening row and the first bucket — moves one and not the other.
   */
  it("ends a net worth series on the balance sheet figure", async () => {
    const series = await getReport(actor, {
      report: "net-worth",
      ...year,
      bucket: "month",
    });
    const sheet = await getReport(actor, { report: "balance-sheet", ...year });
    const last = usd(series)!.rows.find((entry) => entry.key === checkingId)!;
    expect(last.values[last.values.length - 1]).toBe(
      row(sheet, checkingId)!.total,
    );
  });

  /**
   * February holds no postings. Dropping the generate_series grid returns only
   * the buckets that have rows, and the chart then draws January next to March
   * as if no time passed between them.
   */
  it("carries a balance through a bucket with no postings", async () => {
    const series = await getReport(actor, {
      report: "net-worth",
      ...year,
      bucket: "month",
    });
    const checking = usd(series)!.rows.find((entry) => entry.key === checkingId)!;
    const months = series.buckets.map((entry) => entry.start);
    expect(months.slice(0, 3)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    expect(checking.values.length).toBe(series.buckets.length);
    expect(checking.values[0]).toBe("3800");
    expect(checking.values[1]).toBe("3800");
    expect(checking.values[2]).toBe("3350");
  });

  it("stops the series at today rather than at the end that was asked for", async () => {
    const series = await getReport(actor, {
      report: "net-worth",
      start: "2026-01-01",
      end: "9999-12-31",
      bucket: "month",
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(series.asOf).toBe(today);
    expect(series.range.end).toBe("9999-12-31");
    expect(series.buckets[series.buckets.length - 1]!.end).toBe(today);
  });

  it("clips a bucket to the range rather than to its own period", async () => {
    const series = await getReport(actor, {
      report: "income-expense",
      start: "2026-02-15",
      end: "2026-05-20",
      bucket: "quarter",
    });
    expect(series.buckets[0]!.start).toBe("2026-02-15");
    expect(series.buckets[series.buckets.length - 1]!.end).toBe("2026-05-20");
  });

  it("agrees with the dashboard on income and expense for the same range", async () => {
    const summary = await getSummary(actor, year);
    const report = await getReport(actor, {
      report: "income-expense",
      ...year,
      bucket: "month",
    });
    const figures = usdSummary(summary)!;
    expect(row(report, "income")!.total).toBe(figures.deposits);
    expect(Number(row(report, "expense")!.total)).toBe(-Number(figures.withdrawals));
    const net = usd(report)!.totals.reduce((sum, value) => sum + Number(value), 0);
    expect(net).toBe(Number(figures.netCashFlow));
  });

  /**
   * A transfer posts only to real accounts and a conversion adds the exchange
   * account, so neither can reach a query filtered to income and expense. The
   * exclusion is structural; widening that filter is what would break it.
   */
  it("counts neither a transfer nor a conversion as income or expense", async () => {
    const report = await getReport(actor, {
      report: "income-expense",
      start: "2026-03-15",
      end: "2026-04-01",
      bucket: "none",
    });
    expect(usd(report)).toBeUndefined();
  });

  it("reports income by category as well as expense", async () => {
    const report = await getReport(actor, { report: "categories", ...year });
    expect(rowsByLabel(report)).toEqual({
      Salary: "3000",
      Food: "350",
      Household: "40",
      Uncategorized: "20",
    });
    expect(row(report, `income:${salaryId}`)!.kind).toBe("income");
    expect(row(report, `expense:${foodId}`)!.kind).toBe("expense");
  });

  it("agrees with the dashboard on spending by category", async () => {
    const summary = await getSummary(actor, year);
    const report = await getReport(actor, { report: "categories", ...year });
    const spend = Object.fromEntries(
      usdSummary(summary)!.spendingByCategory.map((entry) => [
        entry.category,
        entry.amount,
      ]),
    );
    const expenses = Object.fromEntries(
      usd(report)!
        .rows.filter((entry) => entry.kind === "expense")
        .map((entry) => [entry.label, entry.total]),
    );
    expect(expenses).toEqual(spend);
  });

  /**
   * The third leg was filed under nothing on purpose. A coalesce to the
   * transaction's own category would quietly move that twenty pounds into
   * whatever the receipt as a whole was labelled.
   */
  it("leaves an unfiled leg unfiled", async () => {
    const report = await getReport(actor, { report: "categories", ...year });
    expect(row(report, "expense:uncategorized")!.total).toBe("20");
  });

  it("attributes each leg of a split without counting the receipt twice", async () => {
    const report = await getReport(actor, {
      report: "categories",
      start: "2026-03-01",
      end: "2026-03-31",
    });
    const total = usd(report)!
      .rows.filter((entry) => entry.kind === "expense")
      .reduce((sum, entry) => sum + Number(entry.total), 0);
    expect(total).toBe(150);
  });

  it("offers no total across currencies", async () => {
    const report = await getReport(actor, { report: "net-worth", ...year });
    expect(Object.keys(report)).not.toContain("total");
    expect(Object.keys(report)).not.toContain("netWorth");
    expect(report.currencies.length).toBe(2);
  });

  it("refuses more columns than it will draw", async () => {
    await expect(
      getReport(actor, {
        report: "net-worth",
        start: "1900-01-01",
        end: "2026-12-31",
        bucket: "week",
      }),
    ).rejects.toThrow(/most a report will draw/);
  });

  it("refuses a range that runs backwards", async () => {
    await expect(
      getReport(actor, {
        report: "net-worth",
        start: "2026-06-01",
        end: "2026-01-01",
      }),
    ).rejects.toThrow(/on or before/);
  });

  it("starts an unbounded range at the ledger rather than at the calendar", async () => {
    const report = await getReport(actor, {
      report: "net-worth",
      bucket: "year",
    });
    expect(report.buckets.length).toBe(1);
    expect(report.buckets[0]!.start).toBe("2026-01-01");
  });

  it("leaves an archived account out until it is asked for", async () => {
    const loaded = await getAccount(actor, savingsId);
    await setAccountArchived(actor, savingsId, loaded.version, true);
    try {
      const without = await getReport(actor, {
        report: "balance-sheet",
        ...year,
      });
      expect(row(without, savingsId)).toBeUndefined();

      const shown = await getReport(
        actor,
        { report: "balance-sheet", ...year },
        true,
      );
      expect(row(shown, savingsId)!.total).toBe("0");
    } finally {
      const archived = await getAccount(actor, savingsId);
      await setAccountArchived(actor, savingsId, archived.version, false);
    }
  });

  it("keeps the whole ledger summing to zero", async () => {
    const result = await getDb().execute(sql`
      select p.currency, sum(p.amount)::text as total
      from posting p
      where p.user_id = ${actor.userId}
      group by p.currency
      order by p.currency
    `);
    expect(result.rows.map((entry) => `${entry.currency}=${Number(entry.total)}`)).toEqual(
      ["EUR=0", "USD=0"],
    );
  });

  /**
   * A balance as of each bucket's end asked for one aggregate per column, which
   * is the same answer recomputed from scratch every month. The window form
   * reads the postings once, and a `SubPlan` in the plan is what the other
   * shape looks like whatever the row count.
   */
  it("builds the series from one pass rather than one query per bucket", async () => {
    const text = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = await tx.execute(sql`
        explain
        with accounts as (
          select a.id, a.currency from ledger_account a
          where a.user_id = ${actor.userId} and a.system_kind is null
            and a.archived_at is null
        ),
        changes as (
          select
            case when p.date < '2026-01-01'::date then null
                 else date_trunc('month', p.date)::date end as bucket,
            p.account_id, sum(p.amount) as amount
          from posting p
          join accounts acc on acc.id = p.account_id
          where p.user_id = ${actor.userId} and p.date <= '2026-12-31'::date
          group by 1, 2
        ),
        grid as (
          select b.bucket::date as bucket_start
          from generate_series(
            date_trunc('month', '2026-01-01'::date),
            date_trunc('month', '2026-12-31'::date),
            interval '1 month'
          ) as b(bucket)
        )
        select g.bucket_start, acc.id,
          (coalesce(o.amount, 0) + sum(coalesce(ch.amount, 0)) over (
            partition by acc.id order by g.bucket_start
            rows between unbounded preceding and current row))::text
        from grid g
        cross join accounts acc
        left join changes ch on ch.bucket = g.bucket_start and ch.account_id = acc.id
        left join changes o on o.bucket is null and o.account_id = acc.id
      `);
      return plan.rows.map((entry) => Object.values(entry)[0]).join("\n");
    });

    expect(text).not.toContain("SubPlan");
  });
});
