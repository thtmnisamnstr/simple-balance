import { describe, expect, it } from "vitest";
import { stylesheet } from "./support/css.js";

/**
 * Where a rule sits in this file decides whether it wins.
 *
 * A media query adds no specificity, so a component rule written below the
 * breakpoint blocks silently outranks every responsive override above it. The
 * stylesheet used to have a second body of component rules down there — 426
 * lines of them, with a stray 980px block stranded among them — and
 * `@media (max-width: 780px) { .chart-grid { … } }` written in the obvious place
 * would have lost to `.chart-grid` written later, with nothing on screen to say
 * why. `blocks()` discards offsets, so this walks the text itself.
 */
const css = stylesheet();

type Top = { selector: string; body: string };

/** Every top-level construct, in source order, comments stripped. */
function topLevel(text: string): Top[] {
  const clean = text.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const found: Top[] = [];
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  let selector = "";
  for (let i = 0; i < clean.length; i++) {
    const character = clean[i];
    if (character === "{") {
      if (depth === 0) {
        selector = clean.slice(start, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        found.push({ selector, body: clean.slice(bodyStart, i) });
        start = i + 1;
      }
    }
  }
  return found;
}

const constructs = topLevel(css);
const BREAKPOINT = /^@media \(max-width: (\d+)px\)$/;
const firstBreakpoint = constructs.findIndex((one) => BREAKPOINT.test(one.selector));

describe("the order of the stylesheet", () => {
  it("puts every responsive block at the end and lets no rule follow them", () => {
    expect(firstBreakpoint, "the file has a breakpoint block at all").toBeGreaterThan(-1);
    // Named rather than counted: a failure that says "3 rules follow" is a
    // puzzle, and one that says which three is a fix.
    const after = constructs
      .slice(firstBreakpoint)
      .filter((one) => !one.selector.startsWith("@"))
      .map((one) => one.selector);
    expect(after).toEqual([]);
  });

  it("steps the breakpoints down in one place", () => {
    // Catches a fifth breakpoint invented mid-file as well as a scrambled
    // order. Section 3.6 of the web guide amends this list if 980 is ever
    // folded into 1050.
    const widths = constructs
      .map((one) => BREAKPOINT.exec(one.selector)?.[1])
      .filter((width): width is string => Boolean(width))
      .map(Number);
    expect(widths).toEqual([1050, 980, 780, 560]);
  });

  it("names the two at-rules that sit above the responsive body", () => {
    // Otherwise "nothing follows the responsive body" says nothing about a
    // preference block scattered through the component rules, which is the
    // other half of what this is here to prevent. The colour block belongs to
    // the three the theme needs at the top; the other is four lines qualifying
    // the rule six lines above it.
    const above = constructs
      .slice(0, firstBreakpoint)
      .filter((one) => one.selector.startsWith("@media"));
    expect(above.map((one) => one.selector)).toEqual([
      "@media (prefers-color-scheme: dark)",
      "@media (prefers-reduced-motion: reduce)",
    ]);
    expect(topLevel(above[1]!.body).map((one) => one.selector)).toEqual([".skeleton"]);
  });
});
