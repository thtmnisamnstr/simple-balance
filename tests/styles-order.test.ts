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
    // Two components, not one. Both are qualifications of the rule directly
    // above them rather than a second body: the skeleton's shimmer stops, and
    // the button's spinner swaps its rotation for a pulse — it cannot simply
    // stop, because the blanket rule at the foot of the file would otherwise
    // freeze a busy indicator into a static icon.
    expect(topLevel(above[1]!.body).map((one) => one.selector)).toEqual([
      ".skeleton",
      ".animate-spin",
    ]);
  });
});

/**
 * The layer ladder, because a z-index chosen alone is chosen against nothing.
 *
 * `.merge-panel` and `.nav-scrim` both sat at 20 and both can be on screen
 * below 780px. The scrim is written later, so it painted over the merge panel,
 * and neither rule said anything about the other.
 */
describe("the stacking order", () => {
  it("gives two independently-triggered layers two values", () => {
    const declared = new Map<string, string[]>();
    for (const construct of constructs) {
      const inner = construct.selector.startsWith("@") ? topLevel(construct.body) : [construct];
      for (const rule of inner) {
        const match = /(?:^|[;{])\s*z-index:\s*(-?\d+)/.exec(rule.body);
        if (!match) continue;
        for (const selector of rule.selector.split(",").map((one) => one.trim())) {
          declared.set(match[1]!, [...(declared.get(match[1]!) ?? []), selector]);
        }
      }
    }
    expect(declared.size).toBeGreaterThan(3);
    // Two selectors may share a value only where they cannot both be on screen.
    // The sign-in surface is rendered instead of the app shell rather than over
    // it, so a layer there and a layer in the app never meet and their values
    // are free to coincide.
    const AUTH = /^\.auth-/;
    const shared = [...declared.entries()]
      .map(([value, selectors]) => [value, [...new Set(selectors)]] as const)
      .filter(([, selectors]) => selectors.filter((one) => !AUTH.test(one)).length > 1)
      .map(([value, selectors]) => `${value}: ${selectors.join(", ")}`);
    expect(shared, "two layers on one value, and DOM order deciding").toEqual([]);
  });
});
