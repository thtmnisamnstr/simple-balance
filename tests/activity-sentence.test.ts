import { describe, expect, it } from "vitest";
import { activitySentence } from "../src/client/pages/ActivityPage.js";

/**
 * The Activity page's line for an audit event, as the words the stylesheet
 * then gives a capital first letter.
 *
 * Two shapes of stored operation reach it: a bare snake_case verb, which is
 * most of them, and the `entity.camelCaseVerb` the budget and category-group
 * services write. The second used to render as "BudgetPlan.Create Budget
 * Plan". The 0.2.0 sandbox smoke test then found the lines read as code —
 * "Create from stage transaction", "Payee merge transaction" — and named no
 * record at all, so a line now says what happened, in words, to which record.
 */
describe("activitySentence", () => {
  it("says what happened in words rather than the stored identifier", () => {
    expect(activitySentence({ operation: "create_from_stage", entityType: "transaction" })).toBe(
      "transaction committed from the staged queue",
    );
    expect(activitySentence({ operation: "payee_merge", entityType: "transaction" })).toBe(
      "transaction moved to another payee by a merge",
    );
    expect(activitySentence({ operation: "budgetPlan.create", entityType: "budget_plan" })).toBe(
      "budget plan created",
    );
    expect(
      activitySentence({ operation: "categoryGroup.delete", entityType: "category_group" }),
    ).toBe("category group deleted");
  });

  it("names the record, keeping the spelling it was given", () => {
    expect(
      activitySentence({
        operation: "update",
        entityType: "transaction",
        before: { payee: "Old Grocer" },
        after: { payee: "Grocer McGee" },
      }),
    ).toBe("transaction “Grocer McGee” edited");
    expect(
      activitySentence({
        operation: "delete",
        entityType: "category",
        before: { name: "Fuel" },
        after: null,
      }),
    ).toBe("category “Fuel” deleted");
    expect(
      activitySentence({
        operation: "create_from_recurrence",
        entityType: "staged_transaction",
        after: { draft: { payee: "Gym" } },
      }),
    ).toBe("staged row “Gym” proposed by a recurring transaction");
  });

  it("falls back to the words of an operation it does not know", () => {
    expect(activitySentence({ operation: "budgetPlan.recompute", entityType: "budget_plan" })).toBe(
      "budget plan recompute",
    );
  });

  it("leaves no code identifier for the stylesheet to capitalize", () => {
    for (const operation of ["budgetPlan.update", "budgetEntry.moveOnMerge", "create_from_csv"]) {
      const line = activitySentence({ operation, entityType: "budget_entry" });
      // A dot, an underscore or an inner capital is an identifier; an acronym
      // such as CSV is a word.
      expect(line).not.toMatch(/[._]|[a-z][A-Z]/);
    }
  });
});
