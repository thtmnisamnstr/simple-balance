import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * A ratchet on the lint warnings this repository has not cleared yet.
 *
 * Every rule in `.oxlintrc.json` is either denied, in which case a violation
 * fails `npm run lint` and never reaches here, or turned off with its reason
 * written down in `docs/standards/code/`. These three are the exception: real
 * findings, worth fixing, too many to fix in the change that turned the linter
 * on. Left as bare warnings they would be read once and then scrolled past.
 *
 * So the count is written down, and this test refuses to let it grow. Fixing
 * some is expected to break this test; the fix is to lower the number in the
 * same commit, which is the point. Raising a number here is a decision somebody
 * has to make on purpose, in a diff a reviewer can see.
 *
 * The budget is per rule rather than a single total, because one rule going
 * down while another goes up is not progress and a total would hide it.
 */
const BUDGET: Record<string, number> = {
  "react-hooks(exhaustive-deps)": 17,
  "react(set-state-in-effect)": 13,
  "react(use-memo)": 1,
};

type Diagnostic = { code?: string; severity?: string };

const warningsByRule = (): Map<string, number> => {
  // Non-zero exit means findings, which is the normal case here, so the status
  // is not the signal — the parsed output is.
  let raw: string;
  try {
    raw = execFileSync("npx", ["oxlint", "--format=json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    raw = String((error as { stdout?: string }).stdout ?? "");
  }
  const parsed = JSON.parse(raw) as { diagnostics?: Diagnostic[] };
  const counts = new Map<string, number>();
  for (const diagnostic of parsed.diagnostics ?? []) {
    if (diagnostic.severity !== "warning" || !diagnostic.code) continue;
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  return counts;
};

describe("the lint warning budget", () => {
  const counts = warningsByRule();

  for (const [rule, allowed] of Object.entries(BUDGET)) {
    it(`has no more than ${allowed} of ${rule}`, () => {
      expect(counts.get(rule) ?? 0).toBeLessThanOrEqual(allowed);
    });
  }

  // The other half of a ratchet. Without this a rule cleared to zero leaves its
  // budget behind, and the next regression is silently permitted.
  it("has no budget larger than the count it is holding back", () => {
    const slack = Object.entries(BUDGET)
      .map(([rule, allowed]) => ({ rule, allowed, actual: counts.get(rule) ?? 0 }))
      .filter((entry) => entry.actual < entry.allowed);
    expect(slack, "lower these budgets to what the tree now has").toEqual([]);
  });

  // A rule warning here that nobody has budgeted is a rule nobody decided
  // about. Deny it, turn it off with a reason, or give it a number.
  it("warns about nothing that has no budget", () => {
    const unbudgeted = [...counts.keys()].filter((rule) => !(rule in BUDGET));
    expect(unbudgeted).toEqual([]);
  });
});
