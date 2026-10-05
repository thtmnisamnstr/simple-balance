import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { todayIn } from "../../src/shared/recurrence-dates.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { createCategory } from "../../src/server/services/categories.js";
import { getForecast } from "../../src/server/services/forecast.js";
import { setPreferences } from "../../src/server/services/preferences.js";
import { createRecurrence } from "../../src/server/services/recurrences.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * A recurrence is projected on the side the ledger would post it to.
 *
 * `resolveEntrySide` is AGENTS.md's rule for which way an entry runs: money
 * coming back into a spending category is a refund and lowers spending, and
 * money going back out of an income category lowers income. The projection
 * read the type alone, so a monthly refund was forecast as income — beside a
 * historical baseline that, reading the postings, had always counted it as
 * spending going down.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("forecast_refunds");
const actor: Actor = { userId: "forecast-refunds", source: "web" };

const nextMonth = (() => {
  const [year, month] = todayIn("UTC").split("-").map(Number) as [number, number];
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
})();

integration("a recurring refund in the forecast", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Refunds",
      email: "refunds@example.test",
      emailVerified: true,
    });
    await setPreferences(actor, { timezone: "UTC", defaultCurrency: "USD" });
    const account = await createAccount(actor, {
      name: "Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    });
    const dining = await createCategory(actor, { name: "Dining out", kind: "expense" });
    const salary = await createCategory(actor, { name: "Salary", kind: "income" });
    const monthly = { frequency: "monthly" as const, anchorDate: nextMonth };
    const recur = (name: string, shape: Record<string, unknown>) =>
      createRecurrence(actor, { name, shape, schedule: monthly });
    await recur("Pay", {
      type: "deposit",
      toAccountId: account.id,
      payee: "Employer",
      amount: "1000.00",
      categoryId: salary.id,
    });
    await recur("Overpaid pay back", {
      type: "withdrawal",
      fromAccountId: account.id,
      payee: "Employer",
      amount: "30.00",
      categoryId: salary.id,
    });
    await recur("Dinner", {
      type: "withdrawal",
      fromAccountId: account.id,
      payee: "Bistro",
      amount: "50.00",
      categoryId: dining.id,
    });
    await recur("Dinner refund", {
      type: "deposit",
      toAccountId: account.id,
      payee: "Bistro",
      amount: "20.00",
      categoryId: dining.id,
    });
  }, 120_000);

  afterAll(async () => {
    await database.drop();
  });

  it("lowers spending for a refund and income for income going back", async () => {
    const forecast = await getForecast(actor, { periodUnit: "month", basis: "recurring" });
    const usd = forecast.currencies.find((currency) => currency.currency === "USD")!;
    const period = usd.periods.find((one) => one.periodStart === nextMonth)!;
    expect(period).toBeDefined();
    expect(period.expectedIncome).toBe("970");
    expect(period.expectedSpending).toBe("30");
    expect(forecast.unprojectable).toEqual([]);
  });
});
