import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A name is decided under the lock that serializes deciding it.
 *
 * "Is this name free" and "take it" are two statements, and between them a
 * second transaction can read the same answer. PostgreSQL cannot help: there is
 * no row to lock for a name that does not exist yet, and the comparison is over
 * a normalized form rather than over a column, so a unique index would not
 * catch it either. The product's answer is an advisory namespace lock per
 * tenant, taken before the check.
 *
 * Four of the five namespaces had one from the day their check was written.
 * Accounts did not: `createAccount` called `assertAccountNameAvailable` under no
 * lock at all, and `updateAccount` held only the per-account-id reference lock,
 * which does not serialize two *different* accounts being renamed to the same
 * name. Two concurrent `POST /api/v1/accounts` with one name both succeeded.
 *
 * Read from the source rather than exercised, because the thing worth holding
 * is the shape: a check with no lock above it in the same function body. Not
 * because a race cannot be held — `tests/integration/account-limit.integration.test.ts`
 * races the same lock four times and passes every run, and `services.md` 2.4's
 * *Checked by:* says why a blocked waiter makes that deterministic. The reason
 * here is narrower: a name check has nothing to assert on afterwards except the
 * refusal, and the refusal is already covered sequentially.
 */
const SERVICES = globSync("src/server/services/*.ts");

/**
 * The name checks, and the lock each one belongs under.
 *
 * Named rather than derived. A derived list would have been empty for accounts
 * — there was no lock to derive from — which is the failure this is about.
 */
const CHECKS: { check: RegExp; lock: string }[] = [
  { check: /assertAccountNameAvailable\(/, lock: "lockAccountNamespace" },
  { check: /assertNameAvailable\(/, lock: "lock(?:TransactionTemplate|Recurrence)Namespace" },
  { check: /resolveCategoryByName\(/, lock: "lockCategoryNamespace" },
  { check: /resolveCategoryGroup\(/, lock: "lockCategoryNamespace" },
];

/**
 * Every function body in a service, as text.
 *
 * Brace-balanced from the `{` that opens the body, which is enough here: these
 * files have no template literal holding an unbalanced brace, and a body that
 * ran off its end would report a call under a lock that is not really above it,
 * which is the direction that fails the test rather than the one that hides a
 * defect.
 *
 * The parameter list is stepped over first, balanced from its own `(`. The
 * first `{` after the name was taken for the body, and once the creates took
 * `options: … = {}` before their transaction that `{}` was the body: four of
 * the functions this walks dropped out, and the floor below is what said so.
 */
function bodies(source: string) {
  const found: { name: string; text: string; line: number }[] = [];
  for (const match of source.matchAll(/(?:export )?(?:async )?function (\w+)\s*\(/g)) {
    let parens = 1;
    let after = match.index + match[0].length;
    for (; after < source.length && parens > 0; after += 1) {
      if (source[after] === "(") parens += 1;
      else if (source[after] === ")") parens -= 1;
    }
    let index = source.indexOf("{", after);
    if (index === -1) continue;
    let depth = 0;
    const start = index;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}") depth -= 1;
      if (depth === 0) break;
    }
    found.push({
      name: match[1]!,
      text: source.slice(start, index + 1),
      line: source.slice(0, match.index).split("\n").length,
    });
  }
  return found;
}

describe("deciding a name", () => {
  it("happens under the lock that serializes deciding it", () => {
    const unlocked: string[] = [];
    let checked = 0;
    for (const relative of SERVICES) {
      const source = readFileSync(relative, "utf8");
      for (const body of bodies(source)) {
        for (const { check, lock } of CHECKS) {
          // The definition itself is not a call site: `assertNameAvailable` is
          // where the comparison lives, and its caller is what must hold the
          // lock.
          if (body.name.startsWith("assert") || body.name.startsWith("resolve")) continue;
          const at = body.text.search(check);
          if (at === -1) continue;
          checked += 1;
          const above = body.text.slice(0, at);
          if (!new RegExp(`${lock}\\(`).test(above)) {
            unlocked.push(`${relative}:${body.line} ${body.name} checks a name with no ${lock}`);
          }
        }
      }
    }
    // If the walk found nothing, every assertion above passed by looking at
    // nothing — which is how a check like this stops meaning anything.
    expect(checked).toBeGreaterThan(4);
    expect(unlocked).toEqual([]);
  });

  /**
   * And every namespace has a lock to be taken.
   *
   * The accounts gap was invisible from the call sites: nothing named a lock
   * that did not exist, so a walk of the call sites had nothing to compare
   * against. This is the half that would have caught it on its own.
   */
  it("has a lock for every namespace a name is compared in", () => {
    const helpers = readFileSync("src/server/services/helpers.ts", "utf8");
    for (const namespace of [
      "lockAccountNamespace",
      "lockCategoryNamespace",
      "lockPayeeNamespace",
      "lockRecurrenceNamespace",
      "lockTransactionTemplateNamespace",
    ]) {
      expect(helpers, namespace).toContain(`export async function ${namespace}(`);
    }
  });
});

/**
 * `services.md` 2.4's second rule: a write that merely *references* an account
 * or a category takes that lock too, even though it decides no name.
 *
 * A delete counts what names the account or category under its lock and
 * refuses while anything does. A write that checks "is this one of yours?" and
 * then stores the id, with no lock between, is invisible to that count: the
 * delete runs in the gap, counts nothing, and the write commits naming a record
 * that is gone. The template mass edit was exactly that until a sweep after
 * 0.2.1 — thirty templates pointed at a category deleted under them — while the
 * create and the single edit beside it took both locks. The integration test
 * records the order on the paths it drives; this holds the shape on every path,
 * including the next one, by the ownership check each reaches.
 *
 * Named rather than derived, for the reason `CHECKS` above is: the helpers
 * that answer "is this one of yours" are few and stable, and each is paired
 * with the lock its delete counts under.
 */
const REFERENCE_CHECKS: { check: RegExp; locks: string[] }[] = [
  // Templates and recurrences: a draft or shape naming accounts and a category.
  {
    check: /assertReferencesAreOwned\(/,
    locks: ["lockAccountReferences", "lockCategoryNamespace"],
  },
  // An entry, through `prepareTransaction`: the accounts it posts to.
  { check: /getOwnedAccounts\(/, locks: ["lockAccountReferences"] },
  // A budget's category or group.
  { check: /requireBudgetableTarget\(/, locks: ["lockCategoryNamespace"] },
];

describe("referencing an account or a category", () => {
  it("happens under the lock its delete counts references under", () => {
    const unlocked: string[] = [];
    let checked = 0;
    for (const relative of SERVICES) {
      const source = readFileSync(relative, "utf8");
      for (const body of bodies(source)) {
        for (const { check, locks } of REFERENCE_CHECKS) {
          const at = body.text.search(check);
          if (at === -1) continue;
          // The helper's own body is where the question is asked, not a caller.
          if (check.source.startsWith(`${body.name}\\(`)) continue;
          checked += 1;
          const above = body.text.slice(0, at);
          for (const lock of locks) {
            if (!new RegExp(`${lock}\\(`).test(above)) {
              unlocked.push(
                `${relative}:${body.line} ${body.name} checks what it references with no ${lock} above it`,
              );
            }
          }
        }
      }
    }
    // Eight callers today; a walk that found none would pass by looking at nothing.
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(unlocked).toEqual([]);
  });

  it("names helpers that still exist", () => {
    const all = SERVICES.map((relative) => readFileSync(relative, "utf8")).join("\n");
    for (const { check } of REFERENCE_CHECKS) {
      const name = check.source.replace("\\(", "");
      expect(all, `${name} is gone; the register names a check nothing calls`).toMatch(
        new RegExp(`function ${name}\\(`),
      );
    }
  });
});
