import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A name is decided under the lock that serializes deciding it.
 *
 * "Is this name free" and "take it" are two statements, and between them a
 * second transaction can read the same answer. PostgreSQL cannot help: there is
 * no row to lock for a name that does not exist yet, and the comparison is over
 * a normalised form rather than over a column, so a unique index would not
 * catch it either. The product's answer is an advisory namespace lock per
 * tenant, taken before the check.
 *
 * Four of the five namespaces had one from the day their check was written.
 * Accounts did not: `createAccount` called `assertAccountNameAvailable` under no
 * lock at all, and `updateAccount` held only the per-account-id reference lock,
 * which does not serialize two *different* accounts being renamed to the same
 * name. Two concurrent `POST /api/v1/accounts` with one name both succeeded.
 *
 * Read from the source rather than exercised, because the race needs two
 * connections and the thing worth holding is the shape: a check with no lock
 * above it in the same function body. A test that raced would be a test that
 * usually passed.
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
 */
function bodies(source: string) {
  const found: { name: string; text: string; line: number }[] = [];
  for (const match of source.matchAll(/(?:export )?(?:async )?function (\w+)\s*\(/g)) {
    let index = source.indexOf("{", match.index + match[0].length);
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
