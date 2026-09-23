import { describe, expect, it } from "vitest";
import { PLAN_LABELS, plans } from "../src/shared/domain.js";
import { type SourceFile, sourceFiles } from "./support/source.js";

/**
 * The word a person reads for a plan is written once.
 *
 * `PLAN_LABELS` exists because the wire value and the label are different
 * strings with different owners: `plus` is what every client that has ever
 * seen this API expects, and **Premium** is what a customer is sold. Renaming
 * the first breaks integrations; renaming the second breaks nothing. The
 * marketing site at smpl.money reads the label out of
 * `docs/product/facts.json`, so a literal here is this application quietly
 * disagreeing with the page that sold the plan — which is what happened before
 * the constant existed, and happened again afterwards: the plan tab's own
 * heading said "Upgrade to Plus" while the site sold Premium.
 *
 * What this cannot see, stated rather than implied: a label assembled from
 * pieces, and the lower-case wire value used as a word in a sentence. The
 * second is deliberate — `plan === "plus"` is the wire value doing its job and
 * has to stay legal everywhere — so the guard looks for the *capitalized*
 * form, which is what a sentence uses.
 */

/** Same length, so line numbers survive and a match can be reported against them. */
const blank = (match: string) => match.replace(/[^\n]/g, " ");

/**
 * What is left of a file once everything that cannot reach a reader is gone.
 *
 * Comments are already blanked by `sourceFiles`, which is the point of using
 * it: hand-rolled stripping reads `"https://…"` as a line comment and
 * `"/api/auth/*"` as a block-comment opener, and a guard that swallows the
 * rest of the file reports green over source it never read. What is left to
 * remove here is the `Plus` icon — `<Plus size={16} />` beside "Add
 * transaction" is a drawing of a plus sign and has nothing to do with a plan.
 */
function readerVisible(file: SourceFile): string {
  return file.code
    .replace(/import\s+[^;]*?from\s+"lucide-react";/g, blank)
    .replace(/<Plus\b[^>]*>/g, blank);
}

/** The wire values whose label is a different word, derived rather than listed. */
const renamed = [...plans].filter(
  (plan) => PLAN_LABELS[plan].toLowerCase() !== (plan as string).toLowerCase(),
);

describe("the label a person reads for a plan", () => {
  it("covers every plan, and at least one of them is a rename", () => {
    // Both halves matter. A plan with no label is a plan somebody will spell
    // out by hand, and if no label were ever a rename the guard below would be
    // checking nothing.
    for (const plan of plans) expect(PLAN_LABELS[plan]).toBeTruthy();
    expect(renamed.length).toBeGreaterThan(0);
  });

  it("is never spelled out where the constant could be used", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const code = readerVisible(file);
      for (const plan of renamed) {
        const capitalized = plan.charAt(0).toUpperCase() + plan.slice(1);
        const word = new RegExp(`\\b${capitalized}\\b`, "g");
        for (const match of code.matchAll(word)) {
          const line = code.slice(0, match.index).split("\n").length;
          offenders.push(`${file.path}:${line} — ${capitalized}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
