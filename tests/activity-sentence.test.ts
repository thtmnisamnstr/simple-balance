import { describe, expect, it } from "vitest";
import { activitySentence } from "../src/client/pages/ActivityPage.js";

/**
 * The Activity page's line for an audit event, as the words the stylesheet
 * then capitalizes.
 *
 * Two shapes of stored operation reach it: a bare snake_case verb, which is
 * most of them, and the `entity.camelCaseVerb` the budget and category-group
 * services write. The second used to render as "BudgetPlan.Create Budget
 * Plan" — the first thing on the page in the marketing screenshot — so both
 * shapes are held here.
 */
describe("activitySentence", () => {
  it("drops the entity prefix a dotted operation carries and splits its verb", () => {
    expect(activitySentence({ operation: "budgetPlan.create", entityType: "budget_plan" })).toBe(
      "create budget plan",
    );
    expect(
      activitySentence({ operation: "budgetPlan.moveOnMerge", entityType: "budget_plan" }),
    ).toBe("move on merge budget plan");
    expect(
      activitySentence({ operation: "categoryGroup.delete", entityType: "category_group" }),
    ).toBe("delete category group");
  });

  it("reads a snake_case operation as the words it already is", () => {
    expect(activitySentence({ operation: "payee_merge", entityType: "transaction" })).toBe(
      "payee merge transaction",
    );
    expect(activitySentence({ operation: "create", entityType: "account" })).toBe("create account");
  });

  it("leaves no code identifier for the stylesheet to capitalize", () => {
    // `text-transform: capitalize` uppercases the first letter of each word
    // and leaves the rest alone, so a dot or an inner capital that survived
    // here would reach the screen as "BudgetPlan.Create".
    for (const operation of ["budgetPlan.update", "budgetEntry.moveOnMerge", "create_from_csv"]) {
      const line = activitySentence({ operation, entityType: "budget_entry" });
      expect(line).not.toMatch(/[.A-Z_]/);
    }
  });
});
