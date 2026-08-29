import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount, setAccountArchived } from "../../src/server/services/accounts.js";
import {
  createCategory,
  deleteCategory,
  listCategories,
  mergeCategories,
} from "../../src/server/services/categories.js";
import {
  createBudgetPlan,
  deleteBudgetEntry,
  deleteBudgetPlan,
  getBudgetReport,
  listBudgetPlans,
  setBudgetEntry,
  updateBudgetPlan,
} from "../../src/server/services/budgets.js";
import {
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";
import { canonicalDecimal, decimal } from "../../src/server/services/helpers.js";
import { stageCsv } from "../../src/server/services/import-export.js";
import { commitStages, listStages } from "../../src/server/services/staging.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("budgets");
const actor: Actor = { userId: "budgets-user", source: "web" };

let keySeed = 0;
const nextKey = () => `budgets-${String((keySeed += 1)).padStart(6, "0")}`;

let checkingId = "";
let groceriesId = "";
let salaryId = "";

const march = { start: "2026-03-01", end: "2026-03-31" };

/** Summed exactly, because comparing money as doubles is the rule this repo keeps. */
const sumMoney = (values: readonly string[]) =>
  canonicalDecimal(values.reduce((total, value) => total.plus(value), decimal("0")));

type Report = Awaited<ReturnType<typeof getBudgetReport>>;

const usd = (report: Report) => report.periods.find((period) => period.currency === "USD");

const row = (report: Report, category: string) =>
  usd(report)?.rows.find((entry) => entry.category === category);

const spend = (
  categoryId: string | null,
  amount: string,
  date: string,
  // Distinct per caller where it matters. The ledger refuses a second entry
  // with the same payee, amount and date, which is the duplicate protection
  // working, and a fixture that reuses all three across four period units trips
  // it rather than testing anything.
  payee = "Shop",
) =>
  createTransaction(
    actor,
    {
      type: "withdrawal",
      fromAccountId: checkingId,
      amount,
      date,
      payee,
      description: null,
      ...(categoryId ? { categoryId } : {}),
    },
    nextKey(),
  );

/**
 * This file is order-independent, and is meant to stay that way. Five of these
 * tests once shared two categories and asserted what an earlier test had spent,
 * which is an order rather than a behaviour, and it hid a wrong expected value
 * for two rounds. Check it with:
 *
 *     npx vitest run -c vitest.integration.config.ts \
 *       tests/integration/budgets.integration.test.ts --sequence.shuffle
 *
 * The rest of `tests/integration` is not there yet: shuffling the whole
 * directory fails 68 tests across 26 files, because sharing one database per
 * file and building fixtures in sequence is the house pattern. Untangling that
 * is worth doing and is not this story's to do.
 */
integration("budgets", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Budgets",
      email: "budgets@example.com",
      emailVerified: true,
    });
    // Every figure stops at today where this person lives, so the fixture dates
    // have to be in the past for any of them to be visible at all.
    await setPreferences(actor, { timezone: "UTC", defaultCurrency: "USD" });
    checkingId = (
      await createAccount(actor, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "5000.00",
        idempotencyKey: nextKey(),
      })
    ).id;
    groceriesId = (await createCategory(actor, { name: "Groceries", kind: "expense" })).id;
    salaryId = (await createCategory(actor, { name: "Salary", kind: "income" })).id;
  });
  afterAll(async () => {
    await database.drop();
  });

  /**
   * Each of these owns the categories it names. They read as a sequence and
   * they used to be one: five tests sharing two categories, each depending on
   * what the last one spent. Five of them failed under `--sequence.shuffle`,
   * which means the suite was asserting an order rather than a behaviour.
   */
  const budgetedCategory = async (name: string, amount = "200.00") => {
    const category = await createCategory(actor, { name, kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: category.id,
      amount,
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    return category;
  };

  it("compares a standing budget against what was spent", async () => {
    const category = await budgetedCategory("Standing");
    await spend(category.id, "120.00", "2026-03-04", "Standing one");
    await spend(category.id, "35.50", "2026-03-19", "Standing two");

    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(report, "Standing")).toMatchObject({
      limit: "200",
      actual: "155.5",
      remaining: "44.5",
      source: "plan",
    });
  });

  /**
   * The row a budget page exists for, and the one the obvious query drops. The
   * dashboard's aggregate carries `having sum(p.amount) <> 0`; copying it would
   * have taken this row out.
   */
  it("shows a budgeted category that was never spent on", async () => {
    await budgetedCategory("Unspent", "80.00");
    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(report, "Unspent")).toMatchObject({
      limit: "80",
      actual: "0",
      remaining: "80",
    });
  });

  it("lets one period override the standing amount, and says which it used", async () => {
    const category = await budgetedCategory("Overridden");
    await spend(category.id, "55.50", "2026-03-19", "Overridden spend");
    await setBudgetEntry(actor, {
      categoryId: category.id,
      currency: "USD",
      periodUnit: "month",
      // Any day inside the period names it; the service truncates.
      periodStart: "2026-03-14",
      amount: "300.00",
    });
    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(report, "Overridden")).toMatchObject({
      limit: "300",
      remaining: "244.5",
      source: "entry",
    });

    // The month beside it is untouched, which is the whole point of an override.
    const april = await getBudgetReport(actor, {
      start: "2026-04-01",
      end: "2026-04-30",
      periodUnit: "month",
    });
    expect(row(april, "Overridden")).toMatchObject({ limit: "200", source: "plan" });
  });

  /**
   * A refund is not income, and the budget must see it. This is the case the
   * ledger could not represent at all before this story.
   */
  it("lowers the category a refund came back to", async () => {
    const category = await budgetedCategory("Refunded");
    await spend(category.id, "155.50", "2026-03-04", "Refunded spend");
    const before = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(before, "Refunded")?.actual).toBe("155.5");

    await createTransaction(
      actor,
      {
        type: "deposit",
        toAccountId: checkingId,
        amount: "30.00",
        date: "2026-03-22",
        payee: "Refunded back",
        description: null,
        categoryId: category.id,
      },
      nextKey(),
    );

    const after = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    // 200 budgeted, 155.50 spent, 30 back: 125.50 spent and 74.50 left. The
    // old figure here was 174.50, which was only right because a previous test
    // had left a 300 override on the shared category.
    expect(row(after, "Refunded")).toMatchObject({
      actual: "125.5",
      remaining: "74.5",
    });
  });

  /**
   * The same case, but where the refund arrives before any spending has ever
   * been filed under that name.
   *
   * This is the entry the ledger could not represent at all: the deposit had to
   * create the category, the direction made it income, and the refund then
   * credited income and moved no budget. Saying `categoryKind` is how a caller
   * settles it, and the proof is that the money lands somewhere a budget can
   * see rather than somewhere it cannot.
   */
  it("lowers a budget on a spending category a refund itself created", async () => {
    await createTransaction(
      actor,
      {
        type: "deposit",
        toAccountId: checkingId,
        amount: "45.00",
        date: "2026-03-18",
        payee: "Returned unopened",
        description: null,
        categoryName: "Refund First",
        categoryKind: "expense",
      },
      nextKey(),
    );

    const created = (await listCategories(actor)).find((entry) => entry.name === "Refund First");
    expect(created?.kind).toBe("expense");

    await createBudgetPlan(actor, {
      categoryId: created!.id,
      amount: "200.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });

    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    // Nothing was ever spent here and 45 came back, so the period's spending is
    // negative and there is more left than was budgeted. Had the category come
    // out as income, this row would read 0 spent and the money would have gone
    // to income instead, which is the bug.
    expect(row(report, "Refund First")).toMatchObject({
      actual: "-45",
      remaining: "245",
    });
  });

  it("attributes each leg of a split to its own category", async () => {
    const food = await budgetedCategory("SplitFood");
    const travel = await budgetedCategory("SplitTravel", "80.00");
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        fromAccountId: checkingId,
        amount: "50.00",
        date: "2026-03-25",
        payee: "Split supermarket",
        description: null,
        legs: [
          { categoryId: food.id, amount: "30.00" },
          { categoryId: travel.id, amount: "20.00" },
        ],
      },
      nextKey(),
    );
    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(report, "SplitFood")?.actual).toBe("30");
    expect(row(report, "SplitTravel")?.actual).toBe("20");
  });

  it("counts nothing for a transfer, because it has no expense side", async () => {
    const savings = await createAccount(actor, {
      name: "Savings",
      type: "savings",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
      idempotencyKey: nextKey(),
    });
    const before = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    await createTransaction(
      actor,
      {
        type: "transfer",
        fromAccountId: checkingId,
        toAccountId: savings.id,
        sourceAmount: "500.00",
        date: "2026-03-26",
        payee: "Moving money",
        description: null,
      },
      nextKey(),
    );
    const after = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(after.periods).toEqual(before.periods);
  });

  it("reports spending in a category nobody budgeted, separately", async () => {
    const eatingOut = await createCategory(actor, {
      name: "Eating out",
      kind: "expense",
    });
    const budgeted = await budgetedCategory("Watched");
    await spend(budgeted.id, "5.00", "2026-03-26", "Watched spend");
    await spend(eatingOut.id, "18.00", "2026-03-27", "Eating out spend");
    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(report, "Eating out")).toMatchObject({
      limit: null,
      actual: "18",
      remaining: null,
      source: "none",
    });

    const only = await getBudgetReport(actor, {
      ...march,
      periodUnit: "month",
      includeUnbudgeted: false,
    });
    expect(row(only, "Eating out")).toBeUndefined();
    expect(row(only, "Watched")).toBeDefined();
  });

  it("refuses a budget on a category with no spending to compare against", async () => {
    await expect(
      createBudgetPlan(actor, {
        categoryId: salaryId,
        amount: "10.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-01-01",
      }),
    ).rejects.toThrow(/income category/i);
  });

  it("refuses a second budget covering the same dates", async () => {
    const category = await budgetedCategory("Doubled");
    await expect(
      createBudgetPlan(actor, {
        categoryId: category.id,
        amount: "50.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-06-01",
      }),
    ).rejects.toThrow(/already covers/i);
  });

  /**
   * Both halves of the orphan rule at once: the delete is not refused, and it
   * takes the budget with it rather than leaving one pointing at nothing.
   */
  it("takes budgets with a deleted category, and is never refused because of one", async () => {
    const spare = await createCategory(actor, { name: "Spare", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: spare.id,
      amount: "25.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    expect((await listBudgetPlans(actor)).some((plan) => plan.categoryId === spare.id)).toBe(true);

    await deleteCategory(actor, spare.id, spare.version);

    expect((await listBudgetPlans(actor)).some((plan) => plan.categoryId === spare.id)).toBe(false);
  });

  /**
   * The defect a verification pass found first and four verifiers found
   * independently: a budget set today did not apply to today. A window is asked
   * for in days and answered in periods, so both ends are snapped to the period
   * on the way in.
   */
  it("applies from the period its start falls in, not the one after", async () => {
    const mid = await createCategory(actor, { name: "Midmonth", kind: "expense" });
    const plan = await createBudgetPlan(actor, {
      categoryId: mid.id,
      amount: "150.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-05-14",
    });
    expect(plan.activeFrom).toBe("2026-05-01");

    await spend(mid.id, "20.00", "2026-05-02");
    const may = await getBudgetReport(actor, {
      start: "2026-05-01",
      end: "2026-05-31",
      periodUnit: "month",
    });
    expect(row(may, "Midmonth")).toMatchObject({
      limit: "150",
      actual: "20",
      source: "plan",
    });
  });

  it("ends at the period its end falls in, so both ends read the same way", async () => {
    const ending = await createCategory(actor, { name: "Ending", kind: "expense" });
    const plan = await createBudgetPlan(actor, {
      categoryId: ending.id,
      amount: "100.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
      activeTo: "2026-03-02",
    });
    expect(plan.activeTo).toBe("2026-03-01");

    await spend(ending.id, "90.00", "2026-04-10");
    const april = await getBudgetReport(actor, {
      start: "2026-04-01",
      end: "2026-04-30",
      periodUnit: "month",
    });
    // April is after the window, so the spending is unbudgeted rather than
    // being absorbed by a plan that stopped in March.
    expect(row(april, "Ending")).toMatchObject({ limit: null, source: "none" });
  });

  /**
   * Adjacent windows are how a budget is raised without rewriting history, so
   * the overlap check must accept them and refuse anything that shares a period.
   */
  it("accepts a budget that starts the period after another ends", async () => {
    const raise = await createCategory(actor, { name: "Raise", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: raise.id,
      amount: "100.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
      activeTo: "2026-06-30",
    });
    await expect(
      createBudgetPlan(actor, {
        categoryId: raise.id,
        amount: "120.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-06-15",
      }),
    ).rejects.toThrow(/already covers/i);
    const next = await createBudgetPlan(actor, {
      categoryId: raise.id,
      amount: "120.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-07-01",
    });
    expect(next.activeFrom).toBe("2026-07-01");
  });

  /**
   * An ordinary edit that moved the last transaction off a category pruned the
   * category, and the cascade took the budget with it, with nothing in the
   * audit log naming a budget.
   */
  it("keeps a category alive while a budget holds it", async () => {
    const coffee = await createCategory(actor, { name: "Coffee", kind: "expense" });
    const dining = await createCategory(actor, { name: "Dining", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: coffee.id,
      amount: "50.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-02-01",
    });
    const bought = await createTransaction(
      actor,
      {
        type: "withdrawal",
        fromAccountId: checkingId,
        amount: "4.50",
        date: "2026-02-02",
        payee: "Cafe",
        description: null,
        categoryId: coffee.id,
      },
      nextKey(),
    );
    await updateTransaction(actor, bought.id, {
      draft: {
        type: "withdrawal",
        fromAccountId: checkingId,
        amount: "4.50",
        date: "2026-02-02",
        payee: "Cafe",
        description: null,
        categoryId: dining.id,
      },
      expectedVersion: bought.version,
    });
    expect((await listBudgetPlans(actor)).some((plan) => plan.categoryName === "Coffee")).toBe(
      true,
    );
  });

  it("says which period units it is leaving out", async () => {
    const weekly = await createCategory(actor, { name: "Weekly", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: weekly.id,
      amount: "30.00",
      currency: "USD",
      periodUnit: "week",
      activeFrom: "2026-03-02",
    });
    const monthly = await getBudgetReport(actor, {
      ...march,
      periodUnit: "month",
    });
    expect(monthly.otherPeriodUnits).toContain("week");
  });

  it("refuses a negative budget with a sentence rather than a database error", async () => {
    await expect(
      createBudgetPlan(actor, {
        categoryId: groceriesId,
        amount: "-5.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2027-01-01",
      }),
    ).rejects.toThrow(/negative/i);
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(
      createBudgetPlan(actor, {
        categoryId: groceriesId,
        amount: "5.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2027-05-01",
        activeTo: "2027-02-01",
      }),
    ).rejects.toThrow(/end before it starts/i);
  });

  it("refuses a range needing more periods than a report will draw", async () => {
    await expect(
      getBudgetReport(actor, {
        start: "1990-01-01",
        end: "2026-03-31",
        periodUnit: "week",
      }),
    ).rejects.toThrow(/most a budget report will draw/i);
  });

  it("refuses a backwards range rather than answering with nothing", async () => {
    await expect(
      getBudgetReport(actor, {
        start: "2026-03-31",
        end: "2026-03-01",
        periodUnit: "month",
      }),
    ).rejects.toThrow(/on or before/i);
  });

  /**
   * A deleted entry nets to zero and vanishes from the dashboard. It used to
   * leave a permanent "no budget, 0.00" row here, one per edit, for ever.
   */
  it("drops an unbudgeted row whose spending nets to nothing", async () => {
    const gone = await createCategory(actor, { name: "Gone", kind: "expense" });
    const untouched = await createCategory(actor, {
      name: "Untouched",
      kind: "expense",
    });
    await createBudgetPlan(actor, {
      categoryId: untouched.id,
      amount: "40.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    const paid = await spend(gone.id, "12.00", "2026-03-29");
    expect(
      row(await getBudgetReport(actor, { ...march, periodUnit: "month" }), "Gone"),
    ).toBeDefined();

    await setTransactionDeleted(actor, paid.id, paid.version, true);

    const after = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(after, "Gone")).toBeUndefined();
    // A budgeted category with no spending is the opposite case and stays. Its
    // own category, so this does not depend on what an earlier test spent.
    expect(row(after, "Untouched")).toMatchObject({ limit: "40", actual: "0" });
  });

  /**
   * Every behavioural test above is monthly, and the worst defect this story
   * had was a period-boundary bug that monthly fixtures could not see: a plan
   * starting mid-period budgeted nothing for that period. So the boundary is
   * exercised at every unit, and the dates are derived from what the service
   * snapped rather than hard-coded, because a hand-computed ISO week is a
   * different function from the one PostgreSQL runs.
   */
  describe.each([
    { unit: "week" as const, mid: "2026-03-04", earlier: "2026-02-20" },
    { unit: "month" as const, mid: "2026-03-14", earlier: "2026-02-20" },
    { unit: "quarter" as const, mid: "2026-05-14", earlier: "2026-02-20" },
    { unit: "year" as const, mid: "2026-05-14", earlier: "2025-11-20" },
  ])("budgeting by $unit", ({ unit, mid, earlier }) => {
    it("covers the period its start falls in and no earlier one", async () => {
      const label = `Boundary ${unit}`;
      const category = await createCategory(actor, {
        name: label,
        kind: "expense",
      });
      const plan = await createBudgetPlan(actor, {
        categoryId: category.id,
        amount: "500.00",
        currency: "USD",
        periodUnit: unit,
        activeFrom: mid,
      });
      // Snapped back to the first day of the period holding `mid`, never forward.
      expect(plan.activeFrom <= mid).toBe(true);

      await spend(category.id, "10.00", mid, `${label} inside`);
      await spend(category.id, "99.00", earlier, `${label} before`);

      const covered = await getBudgetReport(actor, {
        start: plan.activeFrom,
        end: mid,
        periodUnit: unit,
      });
      // One period in this currency. Another test in this file budgets and
      // spends in EUR, and an unbudgeted EUR row is a period of its own at
      // every unit whose window happens to contain it — which made this
      // assertion depend on the order the file ran in.
      expect(covered.periods.filter((period) => period.currency === "USD")).toHaveLength(1);
      expect(row(covered, label)).toMatchObject({
        limit: "500",
        actual: "10",
        source: "plan",
      });

      // The period before it is outside the window, so the earlier spending is
      // reported as unbudgeted rather than absorbed by a plan that had not begun.
      const before = await getBudgetReport(actor, {
        start: earlier,
        end: earlier,
        periodUnit: unit,
      });
      expect(row(before, label)).toMatchObject({ limit: null, source: "none" });
    });

    it("puts an override on the period any day inside it names", async () => {
      const label = `Override ${unit}`;
      const category = await createCategory(actor, {
        name: label,
        kind: "expense",
      });
      const entry = await setBudgetEntry(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: unit,
        periodStart: mid,
        amount: "77.00",
      });
      expect(entry.periodStart <= mid).toBe(true);

      const report = await getBudgetReport(actor, {
        start: entry.periodStart,
        end: mid,
        periodUnit: unit,
      });
      expect(row(report, label)).toMatchObject({
        limit: "77",
        source: "entry",
      });
    });
  });

  /**
   * The defect a re-verification found after the first round of fixes: a range
   * that did not line up with a period showed the whole period's limit against
   * only the part of its spending the range covered, and badged the difference
   * as money still to spend. A budget is about periods, so a range now chooses
   * which periods to show rather than slicing them.
   */
  it("weighs a whole period's spending against its limit, whatever range asked", async () => {
    const whole = await createCategory(actor, { name: "Whole", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: whole.id,
      amount: "200.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    await spend(whole.id, "260.00", "2026-07-03", "Whole early");

    // A range starting after the spending. The period is still July, and July
    // still spent 260 of its 200.
    const late = await getBudgetReport(actor, {
      start: "2026-07-20",
      end: "2026-07-31",
      periodUnit: "month",
    });
    expect(row(late, "Whole")).toMatchObject({
      limit: "200",
      actual: "260",
      remaining: "-60",
    });
    const july = late.periods.find((period) => period.periodStart === "2026-07-01");
    expect(july).toMatchObject({ start: "2026-07-01", end: "2026-07-31", partial: false });
  });

  /**
   * Against fixed dates, never against the clock. The first version of this
   * asserted that every period in the default range was partial, which is false
   * on the last day of a period and would have gone red about twelve days a
   * year for reasons nobody would connect to budgeting.
   */
  it("marks a finished period finished and a running one running", async () => {
    const finished = await getBudgetReport(actor, {
      start: "2026-03-01",
      end: "2026-03-31",
      periodUnit: "month",
    });
    expect(finished.periods.every((period) => period.partial)).toBe(false);

    // A period is partial when it has not finished, so the assertion is
    // against its own end date rather than against a guess about today. The
    // first version compared to a hard-coded date and would have gone red on
    // the last day of every month, which is the calendar dependence this test
    // exists to have removed.
    const running = await getBudgetReport(actor, { periodUnit: "month" });
    for (const period of running.periods) {
      expect(period.partial).toBe(period.end > running.asOf);
    }
  });

  /**
   * The other half of the whole-period rule, and the half that was missed: a
   * range ending inside a past period reported only the spending up to that
   * date against the whole period's limit.
   */
  it("reports a whole past period even when the range ends inside it", async () => {
    const cut = await createCategory(actor, { name: "Cutoff", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: cut.id,
      amount: "200.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    await spend(cut.id, "150.00", "2026-06-03", "Cutoff early");
    await spend(cut.id, "100.00", "2026-06-20", "Cutoff late");

    const clipped = await getBudgetReport(actor, {
      start: "2026-06-01",
      end: "2026-06-10",
      periodUnit: "month",
    });
    expect(row(clipped, "Cutoff")).toMatchObject({
      limit: "200",
      actual: "250",
      remaining: "-50",
    });
    const june = clipped.periods.find((p) => p.periodStart === "2026-06-01");
    expect(june).toMatchObject({ end: "2026-06-30", partial: false });
  });

  /** Exactly one row per category per period, which is what makes the totals mean anything. */
  it("gives each category one row and totals that add up", async () => {
    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    for (const period of report.periods) {
      const names = period.rows.map((entry) => entry.category);
      expect(new Set(names).size).toBe(names.length);
      const limits = period.rows
        .map((entry) => entry.limit)
        .filter((limit): limit is string => limit !== null);
      expect(period.budgeted).toBe(sumMoney(limits));
      expect(period.spent).toBe(sumMoney(period.rows.map((entry) => entry.actual)));
    }
  });

  it("refuses a merge of two budgeted sources before writing anything", async () => {
    const target = await createCategory(actor, { name: "MergeTarget", kind: "expense" });
    const one = await createCategory(actor, { name: "MergeOne", kind: "expense" });
    const two = await createCategory(actor, { name: "MergeTwo", kind: "expense" });
    for (const category of [one, two]) {
      await createBudgetPlan(actor, {
        categoryId: category.id,
        amount: "30.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-01-01",
      });
    }
    await expect(
      mergeCategories(actor, {
        sourceCategoryIds: [one.id, two.id],
        targetCategoryId: target.id,
        expectedVersions: { [one.id]: one.version, [two.id]: two.version },
        targetExpectedVersion: target.version,
      }),
    ).rejects.toThrow(/two budgets for one period/i);
    // Refused, so nothing moved and nothing was half-written.
    const plans = await listBudgetPlans(actor);
    expect(plans.filter((plan) => plan.categoryName === "MergeTarget")).toHaveLength(0);
    expect(plans.filter((plan) => plan.categoryName === "MergeOne")).toHaveLength(1);
  });

  it("allows a merge whose budgets cover different periods", async () => {
    const past = await createCategory(actor, { name: "PastOnly", kind: "expense" });
    const now = await createCategory(actor, { name: "NowOnly", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: past.id,
      amount: "10.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2025-01-01",
      activeTo: "2025-12-01",
    });
    await createBudgetPlan(actor, {
      categoryId: now.id,
      amount: "20.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    await mergeCategories(actor, {
      sourceCategoryIds: [past.id],
      targetCategoryId: now.id,
      expectedVersions: { [past.id]: past.version },
      targetExpectedVersion: now.version,
    });
    const plans = (await listBudgetPlans(actor)).filter((plan) => plan.categoryName === "NowOnly");
    expect(plans).toHaveLength(2);
    // The moved row's version bumps, so a client holding the old one is refused.
    expect(plans.some((plan) => plan.version === 2)).toBe(true);
  });

  it("round-trips every write, not just the creates", async () => {
    const rt = await createCategory(actor, { name: "RoundTrip", kind: "expense" });
    const plan = await createBudgetPlan(actor, {
      categoryId: rt.id,
      amount: "10.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-02-14",
    });
    expect(plan.activeFrom).toBe("2026-02-01");

    const raised = await updateBudgetPlan(actor, plan.id, {
      amount: "25.00",
      activeTo: "2026-04-20",
      expectedVersion: plan.version,
    });
    expect(raised).toMatchObject({ amount: "25", activeTo: "2026-04-01", version: 2 });

    const entry = await setBudgetEntry(actor, {
      categoryId: rt.id,
      currency: "USD",
      periodUnit: "month",
      periodStart: "2026-03-09",
      amount: "99.00",
    });
    expect(entry.periodStart).toBe("2026-03-01");
    const changed = await setBudgetEntry(actor, {
      categoryId: rt.id,
      currency: "USD",
      periodUnit: "month",
      periodStart: "2026-03-09",
      amount: "88.00",
      expectedVersion: entry.version,
    });
    expect(changed).toMatchObject({ amount: "88", version: 2 });

    await deleteBudgetEntry(actor, changed.id, changed.version);
    await deleteBudgetPlan(actor, raised.id, raised.version);
    expect((await listBudgetPlans(actor)).some((p) => p.categoryName === "RoundTrip")).toBe(false);
  });

  it("counts spending through a closed account, because the limit was never scoped to one", async () => {
    const card = await createAccount(actor, {
      name: "Old card",
      type: "credit_card",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
      idempotencyKey: nextKey(),
    });
    const both = await createCategory(actor, { name: "Spanning", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: both.id,
      amount: "200.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    await spend(both.id, "120.00", "2026-03-05", "Spanning checking");
    await createTransaction(
      actor,
      {
        type: "withdrawal",
        fromAccountId: card.id,
        amount: "80.00",
        date: "2026-03-06",
        payee: "Spanning card",
        description: null,
        categoryId: both.id,
      },
      nextKey(),
    );
    await setAccountArchived(actor, card.id, card.version, true);

    const counted = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(counted, "Spanning")).toMatchObject({ actual: "200", remaining: "0" });

    const excluded = await getBudgetReport(actor, {
      ...march,
      periodUnit: "month",
      includeArchived: false,
    });
    expect(row(excluded, "Spanning")).toMatchObject({ actual: "120" });
  });

  /**
   * The merge equivalent of the prune defect: a budget went with the source
   * category and nothing in the audit log named it.
   */
  it("moves budgets onto the target when categories are merged", async () => {
    const from = await createCategory(actor, { name: "MergeFrom", kind: "expense" });
    const into = await createCategory(actor, { name: "MergeInto", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: from.id,
      amount: "150.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
    });
    await mergeCategories(actor, {
      sourceCategoryIds: [from.id],
      targetCategoryId: into.id,
      expectedVersions: { [from.id]: from.version },
      targetExpectedVersion: into.version,
    });
    const plans = await listBudgetPlans(actor);
    expect(plans.some((plan) => plan.categoryName === "MergeInto")).toBe(true);
    expect(plans.some((plan) => plan.categoryName === "MergeFrom")).toBe(false);
  });

  it("refuses a merge that would leave two budgets for one period", async () => {
    const left = await createCategory(actor, { name: "BothLeft", kind: "expense" });
    const right = await createCategory(actor, { name: "BothRight", kind: "expense" });
    for (const category of [left, right]) {
      await createBudgetPlan(actor, {
        categoryId: category.id,
        amount: "10.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-01-01",
      });
    }
    await expect(
      mergeCategories(actor, {
        sourceCategoryIds: [left.id],
        targetCategoryId: right.id,
        expectedVersions: { [left.id]: left.version },
        targetExpectedVersion: right.version,
      }),
    ).rejects.toThrow(/two budgets for one period/i);
  });

  /** So `active_to >= bucket_start` cannot quietly become `>`. */
  it("still budgets the last period of a window", async () => {
    const last = await createCategory(actor, { name: "LastPeriod", kind: "expense" });
    await createBudgetPlan(actor, {
      categoryId: last.id,
      amount: "60.00",
      currency: "USD",
      periodUnit: "month",
      activeFrom: "2026-01-01",
      activeTo: "2026-05-01",
    });
    await spend(last.id, "25.00", "2026-05-20", "LastPeriod spend");
    const may = await getBudgetReport(actor, {
      start: "2026-05-01",
      end: "2026-05-31",
      periodUnit: "month",
    });
    expect(row(may, "LastPeriod")).toMatchObject({
      limit: "60",
      actual: "25",
      source: "plan",
    });
  });

  /**
   * The refund path that had no test: naming a category rather than citing its
   * id, which is what a CSV import does. Naming an expense category on a
   * deposit used to widen it to `both`, and a `both` category agrees with
   * whichever direction it is handed, so the refund credited income, the budget
   * never moved, and the category stayed broken for every refund after it.
   */
  it("lowers the budget when a refund names its category instead of citing it", async () => {
    const named = await budgetedCategory("NamedRefund");
    await spend(named.id, "45.00", "2026-03-02", "NamedRefund spend");
    await createTransaction(
      actor,
      {
        type: "deposit",
        toAccountId: checkingId,
        amount: "12.00",
        date: "2026-03-05",
        payee: "NamedRefund back",
        description: null,
        categoryName: "NamedRefund",
      },
      nextKey(),
    );

    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    expect(row(report, "NamedRefund")).toMatchObject({ actual: "33" });
    // And the category is still a spending category, so the next one works too.
    const kinds = await listCategories(actor);
    expect(kinds.find((category) => category.name === "NamedRefund")?.kind).toBe("expense");
  });

  /**
   * The composition defect a verification pass found after the by-name fix: the
   * file's rows were accumulated to a single kind first, so a file holding a
   * spend and a refund for one category arrived as `both`, and a `both` handed
   * to the widening rule widened the stored category. The by-name path was
   * fixed and the import path put the two rules back in the wrong order.
   */
  it("keeps a category's kind when one CSV file spends and refunds against it", async () => {
    const mixed = await budgetedCategory("MixedFile", "500.00");
    await spend(mixed.id, "100.00", "2026-03-02", "MixedFile by id");

    await stageCsv(actor, {
      csv: [
        "date,description,amount,category",
        "2026-03-05,Spend two,-50.00,MixedFile",
        "2026-03-06,Refund two,20.00,MixedFile",
      ].join("\n"),
      fileName: "mixed.csv",
      idempotencyKey: nextKey(),
      defaultAccountId: checkingId,
      mapping: {
        date: "date",
        payee: "description",
        description: "description",
        amount: "amount",
        category: "category",
      },
      dateFormat: "YMD" as const,
      decimalSeparator: "." as const,
      dryRun: false,
    });
    const queued = await listStages(actor, { page: 1, pageSize: 100 });
    await commitStages(actor, {
      stagedIds: queued.items.map((staged) => staged.id),
      expectedVersions: Object.fromEntries(
        queued.items.map((staged) => [staged.id, staged.version]),
      ),
      idempotencyKey: nextKey(),
    });

    const kinds = await listCategories(actor);
    expect(kinds.find((entry) => entry.name === "MixedFile")?.kind).toBe("expense");

    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    // 100 spent, 50 more spent, 20 refunded.
    expect(row(report, "MixedFile")).toMatchObject({ actual: "130" });
  });

  /**
   * A transfer carries no counter-account side, so the kind its draft asks for
   * is "both", and that widened any category it named. Refunds into that
   * category then stopped lowering it.
   */
  it("keeps a category's kind when a transfer names it", async () => {
    const named = await budgetedCategory("TransferNamed");
    await spend(named.id, "40.00", "2026-03-03", "TransferNamed spend");
    const savings = await createAccount(actor, {
      name: "Transfer savings",
      type: "savings",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
      idempotencyKey: nextKey(),
    });
    await createTransaction(
      actor,
      {
        type: "transfer",
        fromAccountId: checkingId,
        toAccountId: savings.id,
        sourceAmount: "10.00",
        date: "2026-03-09",
        payee: "Moving with a label",
        description: null,
        categoryName: "TransferNamed",
      },
      nextKey(),
    );

    const kinds = await listCategories(actor);
    expect(kinds.find((entry) => entry.name === "TransferNamed")?.kind).toBe("expense");
    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    // A transfer contributes nothing, so the figure is the spend alone.
    expect(row(report, "TransferNamed")).toMatchObject({ actual: "40" });
  });

  /**
   * The last order dependence in the import path. A `ledger:stage` caller may
   * not create a category, so the row is staged carrying the name and the
   * commit makes it. The commit sees one row at a time, so without the file's
   * decision travelling with the name, whichever row committed first decided
   * the kind: a refund landing first made an income category, filed every
   * purchase in the file against the income counter-account, and left a
   * category no budget could be set on at all.
   *
   * Committed in both orders here, because the point is that the answer does
   * not depend on the order.
   */
  it.each([
    { label: "purchase first", refundFirst: false },
    { label: "refund first", refundFirst: true },
  ])(
    "decides a deferred category's kind from the file, not the commit order ($label)",
    async ({ label, refundFirst }) => {
      const name = `Deferred ${label}`;
      await stageCsv(
        actor,
        {
          csv: [
            "date,description,amount,category",
            `2026-03-03,Buy one ${label},-40.00,${name}`,
            `2026-03-04,Buy two ${label},-30.00,${name}`,
            `2026-03-05,Refund ${label},10.00,${name}`,
          ].join("\n"),
          fileName: `${label}.csv`,
          idempotencyKey: nextKey(),
          defaultAccountId: checkingId,
          mapping: {
            date: "date",
            payee: "description",
            description: "description",
            amount: "amount",
            category: "category",
          },
          dateFormat: "YMD" as const,
          decimalSeparator: "." as const,
          dryRun: false,
        },
        undefined,
        // The scope that cannot create a category, which is what defers it.
        { mayMutateCategories: false },
      );

      const queued = (await listStages(actor, { page: 1, pageSize: 100 })).items.filter((row) =>
        String(row.draft.payee ?? "").includes(label),
      );
      expect(queued).toHaveLength(3);
      const deposits = queued.filter((row) => row.draft.type === "deposit");
      const withdrawals = queued.filter((row) => row.draft.type === "withdrawal");
      const order = refundFirst ? [...deposits, ...withdrawals] : [...withdrawals, ...deposits];

      // One at a time, so whichever is first genuinely creates the category.
      for (const row of order) {
        await commitStages(actor, {
          stagedIds: [row.id],
          expectedVersions: { [row.id]: row.version },
          idempotencyKey: nextKey(),
        });
      }

      const created = (await listCategories(actor)).find((entry) => entry.name === name);
      // Two purchases against one refund, so the file says spending.
      expect(created?.kind).toBe("expense");

      await createBudgetPlan(actor, {
        categoryId: created!.id,
        amount: "500.00",
        currency: "USD",
        periodUnit: "month",
        activeFrom: "2026-01-01",
      });
      const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
      expect(row(report, name)).toMatchObject({ actual: "60" });
    },
  );

  /**
   * "No figure spans currencies anywhere in the reply", which the whole suite
   * asserted in a ledger that had one currency in it.
   *
   * A single-currency fixture cannot tell a report that keys by currency from
   * one that adds across currencies, because both produce the same number. So
   * this one budgets the same category in two, spends in both, and asks for the
   * two figures separately.
   */
  it("keeps two currencies apart in the same category", async () => {
    const euroAccount = (
      await createAccount(actor, {
        name: `Euro current ${nextKey()}`,
        type: "checking",
        currency: "EUR",
        openingDate: "2026-01-01",
        openingBalance: "1000.00",
        idempotencyKey: nextKey(),
      })
    ).id;
    const name = `Travel ${nextKey()}`;
    const category = await createCategory(actor, { name, kind: "expense" });

    for (const [account, amount] of [
      [checkingId, "40.00"],
      [euroAccount, "70.00"],
    ] as const) {
      await createTransaction(
        actor,
        {
          type: "withdrawal",
          date: "2026-03-05",
          payee: "Rail",
          description: null,
          fromAccountId: account,
          categoryId: category.id,
          amount,
        },
        nextKey(),
      );
    }
    for (const [currency, limit] of [
      ["USD", "100.00"],
      ["EUR", "200.00"],
    ] as const) {
      await createBudgetPlan(actor, {
        categoryId: category.id,
        amount: limit,
        currency,
        periodUnit: "month",
        activeFrom: "2026-01-01",
      });
    }

    const report = await getBudgetReport(actor, { ...march, periodUnit: "month" });
    // A period is per currency rather than holding a currency breakdown, which
    // is what makes a figure spanning two of them unrepresentable rather than
    // merely avoided.
    const rows = report.periods
      .filter((period) => period.periodStart === "2026-03-01")
      .flatMap((period) =>
        period.rows
          .filter((row) => row.category === name)
          .map((row) => ({ currency: period.currency, limit: row.limit, actual: row.actual })),
      );
    // Two rows, each holding only its own currency's money. A report that added
    // them would show one row of 110 against 300, which is a number in no
    // currency at all.
    expect(rows.sort((a, b) => a.currency.localeCompare(b.currency))).toEqual([
      { currency: "EUR", limit: "200", actual: "70" },
      { currency: "USD", limit: "100", actual: "40" },
    ]);
  });

  /**
   * The criterion is "every figure stops at today in the person's own timezone,
   * and the day used is reported", and this asserted `asOf < "2999-12-31"`,
   * which is true of any date before the year 2999 — including the server's
   * today, which is the one thing the criterion is about. So it moves the
   * person to a timezone fourteen hours from UTC and asks for the day there.
   */
  it("stops at today in the person's own timezone, and says which day", async () => {
    const report = await getBudgetReport(actor, {
      start: "2026-03-01",
      end: "2999-12-31",
      periodUnit: "month",
    });
    expect(report.asOf).toBe(todayIn("UTC"));

    // Kiritimati is UTC+14, so for part of every day it is already tomorrow
    // there. A report that read the server's clock would agree with UTC around
    // the clock; this one has to follow the person.
    await setPreferences(actor, { timezone: "Pacific/Kiritimati", defaultCurrency: "USD" });
    try {
      const far = await getBudgetReport(actor, {
        start: "2026-03-01",
        end: "2999-12-31",
        periodUnit: "month",
      });
      expect(far.asOf).toBe(todayIn("Pacific/Kiritimati"));
      // And the periods stop there rather than running to the end date: a
      // budget for a month nobody has reached is not a budget that was
      // underspent.
      expect(far.periods.at(-1)!.periodStart <= far.asOf).toBe(true);
    } finally {
      await setPreferences(actor, { timezone: "UTC", defaultCurrency: "USD" });
    }
  });

  /**
   * Rollover, which is the whole of envelopes, sinking funds and debt.
   *
   * Nothing here is stored per period: every figure below is folded at read
   * time from the same plans, entries and postings the rest of the report comes
   * from. That is what these tests are really holding — a carry that had been
   * materialised would pass the first two and quietly fail the fifth, where a
   * budget's history is edited after the fact.
   */
  describe("a budget that carries what a period did not spend", () => {
    it("hands the unspent forward, and the overspend forward as a debt", async () => {
      const category = await createCategory(actor, { name: "Carry", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "100.00",
        activeFrom: "2026-01-01",
        rollover: true,
      });
      await spend(category.id, "40.00", "2026-01-10", "Carry Jan");
      await spend(category.id, "130.00", "2026-02-10", "Carry Feb");

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-03-31",
        periodUnit: "month",
      });
      const months = report.periods.filter((period) => period.currency === "USD");
      const carry = months.map((period) => period.rows.find((r) => r.category === "Carry")!);

      // January: spent 40 of 100, so 60 goes forward.
      expect(carry[0]).toMatchObject({
        limit: "100",
        actual: "40",
        carriedIn: "0",
        available: "100",
        remaining: "60",
        carriedOut: "60",
      });
      // February: 100 of its own plus 60 carried in, spent 130, so 30 forward.
      expect(carry[1]).toMatchObject({
        limit: "100",
        carriedIn: "60",
        available: "160",
        actual: "130",
        remaining: "30",
        carriedOut: "30",
      });
      // March: nothing spent, so it keeps its own hundred and the thirty.
      expect(carry[2]).toMatchObject({ carriedIn: "30", available: "130", carriedOut: "130" });
    });

    it("carries a debt when a period overspends past everything it had", async () => {
      const category = await createCategory(actor, { name: "Debt", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "50.00",
        activeFrom: "2026-01-01",
        rollover: true,
      });
      await spend(category.id, "200.00", "2026-01-15", "Debt Jan");

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-02-28",
        periodUnit: "month",
      });
      const rows = report.periods
        .filter((period) => period.currency === "USD")
        .map((period) => period.rows.find((r) => r.category === "Debt")!);
      expect(rows[0]).toMatchObject({ available: "50", actual: "200", carriedOut: "-150" });
      // The half of rollover people forget is part of the deal: February starts
      // a hundred in the hole rather than fresh at fifty.
      expect(rows[1]).toMatchObject({ carriedIn: "-150", available: "-100", remaining: "-100" });
    });

    it("holds the carry inside its cap, in both directions", async () => {
      const category = await createCategory(actor, { name: "Capped", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "100.00",
        activeFrom: "2026-01-01",
        rollover: true,
        rolloverCap: "120.00",
      });
      await spend(category.id, "400.00", "2026-03-05", "Capped March");

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-04-30",
        periodUnit: "month",
      });
      const rows = report.periods
        .filter((period) => period.currency === "USD")
        .map((period) => period.rows.find((r) => r.category === "Capped")!);
      // Two untouched months would have handed 200 forward. The cap stops it.
      expect(rows[0]!.carriedOut).toBe("100");
      expect(rows[1]!.carriedOut).toBe("120");
      // And a debt is held to the same number rather than running away: 120 in
      // plus 100 of its own less 400 spent is -180, capped back to -120.
      expect(rows[2]).toMatchObject({ carriedIn: "120", available: "220", carriedOut: "-120" });
      expect(rows[3]!.carriedIn).toBe("-120");
    });

    it("starts again rather than joining two budgets across a gap", async () => {
      const category = await createCategory(actor, { name: "Gap", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "100.00",
        activeFrom: "2026-01-01",
        activeTo: "2026-01-31",
        rollover: true,
      });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "100.00",
        activeFrom: "2026-03-01",
        rollover: true,
      });

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-03-31",
        periodUnit: "month",
      });
      const march = report.periods.find(
        (period) => period.periodStart === "2026-03-01" && period.currency === "USD",
      );
      // January's untouched hundred does not belong to March. Two budgets with
      // a month of nothing between them are two budgets, and carrying across
      // the gap would hand March money nobody budgeted for it.
      expect(march!.rows.find((r) => r.category === "Gap")).toMatchObject({
        carriedIn: "0",
        available: "100",
      });
    });

    it("carries through a period somebody overrode by hand", async () => {
      const category = await createCategory(actor, { name: "Override carry", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "100.00",
        activeFrom: "2026-01-01",
        rollover: true,
      });
      await setBudgetEntry(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        periodStart: "2026-02-01",
        amount: "300.00",
      });

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-03-31",
        periodUnit: "month",
      });
      const rows = report.periods
        .filter((period) => period.currency === "USD")
        .map((period) => period.rows.find((r) => r.category === "Override carry")!);
      // The override replaces the amount for its period and the carry runs
      // through it: a bigger December is still an envelope in December.
      expect(rows[1]).toMatchObject({ limit: "300", source: "entry", carriedIn: "100" });
      expect(rows[2]).toMatchObject({ carriedIn: "400" });
    });

    it("says where the carry was folded from", async () => {
      const category = await createCategory(actor, { name: "Folded", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "10.00",
        activeFrom: "2026-01-01",
        rollover: true,
      });

      const report = await getBudgetReport(actor, {
        start: "2026-04-01",
        end: "2026-04-30",
        periodUnit: "month",
      });
      // A report of April alone still had to read January onward to know what
      // April was handed, and it says so rather than leaving the reader to
      // wonder where four hundred of "carried in" came from.
      expect(report.rollover).toMatchObject({ from: "2026-01-01", clipped: false });
    });

    it("leaves a budget that does not roll over exactly as it was", async () => {
      const category = await createCategory(actor, { name: "Plain", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "100.00",
        activeFrom: "2026-01-01",
      });
      await spend(category.id, "20.00", "2026-01-08", "Plain Jan");

      const report = await getBudgetReport(actor, {
        start: "2026-02-01",
        end: "2026-02-28",
        periodUnit: "month",
      });
      // Null rather than zero. Zero would say "nothing carried in", which is a
      // claim about a budget that carries nothing at all.
      expect(row(report, "Plain")).toMatchObject({
        limit: "100",
        carriedIn: null,
        carriedOut: null,
        available: "100",
        remaining: "100",
      });
    });
  });

  describe("a sinking fund", () => {
    it("puts aside what is still needed over the periods that are left", async () => {
      const category = await createCategory(actor, { name: "Holiday", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "0",
        activeFrom: "2026-01-01",
        rollover: true,
        targetAmount: "600.00",
        targetDate: "2026-06-20",
      });

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-04-30",
        periodUnit: "month",
      });
      const rows = report.periods
        .filter((period) => period.currency === "USD")
        .map((period) => period.rows.find((r) => r.category === "Holiday")!);
      // Six periods from January through June, so a hundred a month, and each
      // later month divides what is left by the months that remain.
      expect(rows[0]).toMatchObject({ limit: "100", carriedIn: "0", carriedOut: "100" });
      expect(rows[1]).toMatchObject({ limit: "100", carriedIn: "100", carriedOut: "200" });
      expect(rows[3]).toMatchObject({ carriedIn: "300", limit: "100", carriedOut: "400" });
    });

    it("asks for nothing once it is full, and for the shortfall once it is due", async () => {
      const category = await createCategory(actor, { name: "Tyres", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "0",
        activeFrom: "2026-01-01",
        rollover: true,
        targetAmount: "300.00",
        targetDate: "2026-03-15",
      });

      const report = await getBudgetReport(actor, {
        start: "2026-01-01",
        end: "2026-05-31",
        periodUnit: "month",
      });
      const rows = report.periods
        .filter((period) => period.currency === "USD")
        .map((period) => period.rows.find((r) => r.category === "Tyres")!);
      expect(rows[0]!.limit).toBe("100");
      expect(rows[2]).toMatchObject({ limit: "100", carriedOut: "300" });
      // Full, and the months after it ask for nothing rather than starting the
      // same fund again.
      expect(rows[3]).toMatchObject({ limit: "0", carriedIn: "300", available: "300" });
      expect(rows[4]!.limit).toBe("0");
    });

    it("asks for the whole shortfall in the period it is needed", async () => {
      const category = await createCategory(actor, { name: "Boiler", kind: "expense" });
      await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "0",
        activeFrom: "2026-02-01",
        rollover: true,
        targetAmount: "500.00",
        targetDate: "2026-02-28",
      });

      const report = await getBudgetReport(actor, {
        start: "2026-02-01",
        end: "2026-02-28",
        periodUnit: "month",
      });
      // One period to save it in, so the period asks for all of it rather than
      // a share of it.
      expect(row(report, "Boiler")!.limit).toBe("500");
    });

    it("refuses the shapes that are not a fund", async () => {
      const category = await createCategory(actor, { name: "Refusals", kind: "expense" });
      const base = {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month" as const,
        activeFrom: "2026-01-01",
      };
      await expect(
        createBudgetPlan(actor, { ...base, amount: "0", rollover: true, targetAmount: "100.00" }),
      ).rejects.toThrow(/both an amount to save and a date/i);
      await expect(
        createBudgetPlan(actor, {
          ...base,
          amount: "0",
          targetAmount: "100.00",
          targetDate: "2026-06-01",
          rollover: false,
        }),
      ).rejects.toThrow(/carry what it saved/i);
      await expect(
        createBudgetPlan(actor, {
          ...base,
          amount: "50.00",
          rollover: true,
          targetAmount: "100.00",
          targetDate: "2026-06-01",
        }),
      ).rejects.toThrow(/works out its own amount/i);
      await expect(
        createBudgetPlan(actor, {
          ...base,
          amount: "0",
          rollover: true,
          targetAmount: "100.00",
          targetDate: "2025-06-01",
        }),
      ).rejects.toThrow(/cannot be needed before it starts/i);
      await expect(
        createBudgetPlan(actor, { ...base, amount: "10.00", rolloverCap: "50.00" }),
      ).rejects.toThrow(/only means something when rollover is on/i);
    });

    it("stores the rule and the target where a reader can see them", async () => {
      const category = await createCategory(actor, { name: "Stored fund", kind: "expense" });
      const plan = await createBudgetPlan(actor, {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        amount: "0",
        activeFrom: "2026-01-01",
        rollover: true,
        targetAmount: "240.00",
        targetDate: "2026-06-14",
      });
      // Nobody chose "sinking fund" anywhere: the rule is what the row says.
      expect(plan).toMatchObject({
        amountRule: "sinking_fund",
        rollover: true,
        targetAmount: "240",
        // Snapped to the period like both ends of the window, because the fund
        // divides what is left by the periods left and the date has to be one.
        targetDate: "2026-06-01",
      });
      const updated = await updateBudgetPlan(actor, plan.id, {
        expectedVersion: plan.version,
        targetAmount: null,
        targetDate: null,
        amount: "25.00",
      });
      expect(updated).toMatchObject({ amountRule: "fixed", targetAmount: null, rollover: true });
    });
  });
});
