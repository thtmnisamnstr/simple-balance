import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import { createBudgetPlan, getBudgetReport } from "../../src/server/services/budgets.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The measurement SB-025 said it would not ship without.
 *
 * A rollover carry depends on every period since the budget started, which is
 * the first budget figure that reads more than the periods it reports. The
 * roadmap priced the reporting work against a hundred thousand postings on
 * PostgreSQL and asked for the same standard here: plan assertions that answer
 * whether an index *can* serve the query, rather than whether the planner
 * bothers on a handful of rows.
 *
 * So this seeds a hundred thousand postings over ten years and asks two
 * questions of the shape rather than of the clock. Does the spending behind a
 * folded report come from one indexed pass, or from one query per period? And
 * does a ten-year fold return the right carry at all, which is the thing a
 * bounded window could quietly get wrong.
 *
 * The timing is recorded in `docs/roadmap.md` rather than asserted. A threshold
 * in a test measures the machine it ran on; a plan assertion measures the query.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("budgets_scale");
const actor: Actor = { userId: "budget-scale-user", source: "web" };

/** Ten years of months, which is what `MAX_ROLLOVER_PERIODS` is scaled for. */
const POSTINGS = 100_000;
const START = "2016-01-01";

let categoryId = "";
let accountId = "";

integration("a budget report over a ledger that is not small", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Scale",
      email: "scale@example.com",
      emailVerified: true,
    });
    await setPreferences(actor, { timezone: "UTC", defaultCurrency: "USD" });
    accountId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: START,
        openingBalance: "1000000.00",
      })
    ).id;
    categoryId = (await createCategory(actor, { name: "Groceries", kind: "expense" })).id;
    await createBudgetPlan(actor, {
      categoryId,
      currency: "USD",
      periodUnit: "month",
      amount: "100.00",
      activeFrom: START,
      rollover: true,
    });

    // One real withdrawal, because budgets write no postings and the expense
    // counter-account is created by the first entry that needs one. Seeding
    // straight into `posting` without it would insert against an account that
    // does not exist yet.
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        date: START,
        payee: "First",
        description: null,
        fromAccountId: accountId,
        categoryId,
        amount: "1.00",
      },
      "scale-first",
    );

    // Written as rows rather than as transactions. A hundred thousand postings
    // through `createTransaction` is a hundred thousand transactions, each with
    // its own idempotency lock and audit row, and this is a measurement of one
    // read rather than of the write path. The rows are the shape the read
    // depends on: an expense-side posting with a date, a currency and a
    // transaction that names the category.
    const [expense] = (
      await getDb().execute(sql`
        select id from ledger_account
        where user_id = ${actor.userId} and system_kind = 'expense' and currency = 'USD'
        limit 1
      `)
    ).rows as { id: string }[];
    expect(expense, "the expense counter-account is created with the first plan").toBeDefined();

    await getDb().execute(sql`
      with entries as (
        select
          gen_random_uuid() as transaction_id,
          (${START}::date + (n % 3650))::date as on_date,
          n
        from generate_series(1, ${POSTINGS}) as n
      ), inserted as (
        insert into ledger_transaction
          (id, user_id, type, date, payee, source_account_id, source_amount, source_currency,
           category_id)
        select
          transaction_id, ${actor.userId}::text, 'withdrawal'::transaction_type, on_date,
          'Bulk ' || n, ${accountId}::uuid, 1::numeric, 'USD'::text, ${categoryId}::uuid
        from entries
        returning id, date
      )
      insert into posting (user_id, transaction_id, account_id, date, amount, currency)
      select ${actor.userId}::text, i.id, ${accountId}::uuid, i.date, -1::numeric, 'USD'::text
      from inserted i
      union all
      select ${actor.userId}::text, i.id, ${expense!.id}::uuid, i.date, 1::numeric, 'USD'::text
      from inserted i
    `);
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  });

  it("has the postings it says it has", async () => {
    const [{ count }] = (await getDb().execute(sql`select count(*)::int as count from posting`))
      .rows as { count: number }[];
    // Two per transaction, plus the two the opening balance wrote.
    expect(count).toBeGreaterThanOrEqual(POSTINGS * 2);
  });

  /**
   * One indexed pass, not one query per period.
   *
   * `enable_seqscan = off` prices the sequential scan out of the way, so this
   * asks whether an index can serve the query rather than whether the planner
   * bothered. `SubPlan` is the failure that matters: a correlated subquery per
   * period is what a naive fold looks like from the database's side, and it is
   * invisible in a test that only checks the numbers.
   */
  it("reads the spending behind a folded report in one pass", async () => {
    const plan = await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const explained = await tx.execute(sql`
        explain
        select date_trunc('month', p.date)::date as period_start, p.currency, sum(p.amount)
        from posting p
        join ledger_account a
          on a.user_id = p.user_id and a.id = p.account_id and a.system_kind = 'expense'
        where p.user_id = ${actor.userId}
          and p.date >= date '2016-01-01'
          and p.date <= date '2025-12-31'
        group by 1, 2
      `);
      return explained.rows.map((row) => Object.values(row)[0]).join("\n");
    });

    expect(plan).not.toContain("SubPlan");
    expect(plan).toContain("Index");
  });

  it("folds ten years of carry and comes back with the right one", async () => {
    const startedAt = Date.now();
    const report = await getBudgetReport(actor, {
      start: "2025-01-01",
      end: "2025-12-31",
      periodUnit: "month",
    });
    const january = report.periods.find(
      (period) => period.periodStart === "2025-01-01" && period.currency === "USD",
    );
    const row = january!.rows.find((entry) => entry.categoryId === categoryId);

    // The fold reaches back to the budget's own start rather than to the range
    // asked for, and says so — and it got there without hitting its bound,
    // because ten years of months is inside it.
    expect(report.rollover).toMatchObject({ from: "2016-01-01", clipped: false });

    // The carry checked against the ledger rather than against a number typed
    // here: 108 periods of 100 budgeted, less everything those periods spent.
    // This is the assertion a bounded window would fail, because a fold that
    // silently started late comes back with a smaller debt.
    const [{ spent }] = (
      await getDb().execute(sql`
        select coalesce(sum(p.amount), 0)::text as spent
        from posting p
        join ledger_account a
          on a.user_id = p.user_id and a.id = p.account_id and a.system_kind = 'expense'
        where p.user_id = ${actor.userId}
          and p.date >= date '2016-01-01'
          and p.date < date '2025-01-01'
      `)
    ).rows as { spent: string }[];
    const expected = 108 * 100 - Number(spent);
    expect(Number(row!.carriedIn)).toBe(expected);
    // Deeply in debt, which is what a hundred a month against this much
    // spending means, and the direction that proves the debt half carries.
    expect(expected).toBeLessThan(0);
    expect(Number(row!.available)).toBe(expected + 100);
    // Printed rather than asserted. The number belongs in `docs/roadmap.md`,
    // where it can be read as the measurement it is; a threshold here would be
    // a measurement of whichever machine happened to run the suite.
    console.info(
      `budget report, ${POSTINGS} postings, 120-period fold: ${Date.now() - startedAt}ms`,
    );
  }, 60_000);
});
