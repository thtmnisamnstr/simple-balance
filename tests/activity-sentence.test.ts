import { describe, expect, it } from "vitest";
import { activitySentence } from "../src/client/pages/ActivityPage.js";
import { sourceFiles } from "./support/source.js";

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

  /**
   * A Simple Balance file's two operations. The second is the one that has to
   * be said exactly: a move writes a transaction that was deleted where the
   * file came from and deletes it again, and "deleted" alone would tell the
   * person they deleted it on the day they moved their ledger.
   */
  it("says what came in from a Simple Balance file, and what came in deleted", () => {
    expect(
      activitySentence({
        operation: "create_from_ledger_file",
        entityType: "account",
        after: { name: "Checking" },
      }),
    ).toBe("account “Checking” brought in from a Simple Balance file");
    expect(
      activitySentence({
        operation: "delete_from_ledger_file",
        entityType: "transaction",
        after: { payee: "Kiosk" },
      }),
    ).toBe("transaction “Kiosk” brought in deleted from a Simple Balance file");
  });

  it("says both halves of the choice of accounts in use", () => {
    expect(
      activitySentence({
        operation: "activate",
        entityType: "account",
        after: { name: "Savings" },
      }),
    ).toBe("account “Savings” marked in use");
    expect(
      activitySentence({ operation: "freeze", entityType: "account", after: { name: "Savings" } }),
    ).toBe("account “Savings” frozen by the choice of accounts in use");
  });

  /**
   * Every operation a service writes has words, so none reaches the fallback
   * below. `freeze` did, for a release: the choice of accounts in use writes it
   * for every account left unchecked, and the line read "Account “Savings”
   * freeze" — the bare stored verb, which is what this file exists to stop.
   *
   * Read off the services' own source: a quoted identifier on a line that
   * names an operation — `operation: "x"`, either side of a ternary, the
   * default after `??`, or an `_OPERATION` constant. One written as a bare
   * argument on a line of its own is out of reach of a line scan, which is why
   * the floor is a floor rather than the whole population.
   */
  it("has words for every operation a service writes", () => {
    /** Quoted beside the word "operation" and never an audit row's verb. */
    const NOT_AN_AUDIT_OPERATION: Record<string, string> = {
      succeeded:
        "src/server/services/billing.ts: the state a billing operation's idempotency row finishes in.",
      failed:
        "src/server/services/billing.ts: the state a billing operation's idempotency row finishes in.",
    };
    const written = new Map<string, string>();
    for (const file of sourceFiles("src/server/services")) {
      file.code.split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*)/.test(line) || !/operation\b|_OPERATION\b|Operation\b/.test(line)) {
          return;
        }
        for (const [, name] of line.matchAll(/"([a-z][\w.]*)"/g)) {
          if (!written.has(name!)) written.set(name!, `${file.path}:${index + 1}`);
        }
      });
    }
    expect(written.size, "the scan is reading the services").toBeGreaterThan(30);
    expect(written.has("freeze"), "and finds the one that had no words").toBe(true);
    const fallback = (operation: string) =>
      operation
        .slice(operation.lastIndexOf(".") + 1)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .toLowerCase();
    const unworded = [...written]
      .filter(([name]) => !(name in NOT_AN_AUDIT_OPERATION))
      .filter(
        ([name]) =>
          activitySentence({ operation: name, entityType: "account" }) ===
          `account ${fallback(name)}`,
      )
      .map(([name, at]) => `${at} ${name}`);
    expect(unworded, "give it words in ActivityPage's operationWords").toEqual([]);
    expect(
      Object.keys(NOT_AN_AUDIT_OPERATION).filter((name) => !written.has(name)),
      "the register excuses something the scan no longer finds",
    ).toEqual([]);
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
