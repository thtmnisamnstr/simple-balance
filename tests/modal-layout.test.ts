import { describe, expect, it } from "vitest";
import { ruleFor, stylesheet } from "./support/css.js";

describe("modal layout", () => {
  it("centers dialogs independently of the global margin reset", () => {
    // Selected by selector rather than by the first occurrence of `.modal {`.
    // Matching the substring meant any later rule mentioning `.modal` that got
    // written above this one — a theme override, say — became the rule under
    // test, and this failed over where a block sits in the file.
    const rules = ruleFor(stylesheet(), ".modal");
    expect(rules.length, "one top-level .modal rule").toBeGreaterThan(0);
    const layout = rules.map((rule) => rule.body).join("\n");

    expect(layout).toMatch(/position:\s*fixed/);
    expect(layout).toMatch(/inset:\s*0/);
    expect(layout).toMatch(/height:\s*fit-content/);
    expect(layout).toMatch(/margin:\s*auto/);
  });
});
