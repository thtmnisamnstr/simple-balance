import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stylesheet } from "./support/css.js";

/**
 * How far apart two sections of a page sit, and who decides.
 *
 * It used to be whichever block happened to be there. `.page-header` carried
 * 26px, the three bars carried 20, an account type section 28, a toolbar 20 and
 * 12, the report tabs 16, the settings grid 14 — and `.panel`, `.table-card`,
 * `.alert`, `.empty-state` and `.category-page-list` carried none at all. So
 * four stacked panels on the budgets page touched, the categories page ran on
 * four different gaps in one screen, and the transactions buttons were dragged
 * into the header band by `margin-top: -48px`, a number that was only ever
 * right for one particular header.
 *
 * One container now supplies the rhythm and no page-level block carries a
 * vertical margin of its own. This holds that: it is a rule about who is
 * allowed to decide, which is the only kind of spacing rule a stylesheet can
 * actually keep.
 */

const css = stylesheet();

/** Every `selector { body }` in the sheet, comments stripped. */
function rules(text: string) {
  const clean = text.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
  }));
}

const parsed = rules(css);
const selectorsOf = (selector: string) => selector.split(",").map((one) => one.trim());

/**
 * The classes a page component puts at the top level of `.content`.
 *
 * Listed by hand, and that is the limitation worth stating: a page that invents
 * a new kind of section and gives it a margin is not caught until somebody adds
 * it here. What the list does catch is the failure that actually happened —
 * an existing page-level block growing a margin back.
 */
const PAGE_LEVEL = [
  ".page-header",
  ".date-bar",
  ".filter-bar",
  ".toolbar",
  ".category-toolbar",
  ".report-tabs",
  ".panel",
  ".table-card",
  ".alert",
  ".empty-state",
  ".category-page-list",
  ".settings-grid",
  ".currency-sections",
  ".import-layout",
  ".account-type-section",
  ".merge-panel",
  ".duplicate-groups",
  ".back-link",
  ".balance-snapshot-grid",
];

describe("the page stack", () => {
  it("takes its rhythm from one container", () => {
    const content = parsed.find((rule) => selectorsOf(rule.selector).includes(".content"));
    expect(content, ".content has no rule").toBeDefined();
    expect(content!.body).toMatch(/display:\s*flex/);
    expect(content!.body).toMatch(/flex-direction:\s*column/);
    expect(content!.body).toMatch(/gap:\s*24px/);
  });

  /**
   * Flex rather than grid, and it is load-bearing rather than a preference.
   *
   * `.merge-panel` is `position: sticky` and sits at page level on Categories
   * and Payees. A sticky grid item is bounded by its own grid area, which in a
   * single-column grid is its own height, so it would stop following the list
   * with nothing on screen to say why.
   */
  it("does not make the page a grid, because a sticky child sits in it", () => {
    const content = parsed.find((rule) => selectorsOf(rule.selector).includes(".content"));
    expect(content!.body).not.toMatch(/display:\s*grid/);
    const sticky = parsed.filter((rule) => /position:\s*sticky/.test(rule.body));
    expect(sticky.map((rule) => rule.selector)).toContain(".merge-panel");
  });

  it("lets no page-level block carry a vertical margin of its own", () => {
    const offenders: string[] = [];
    for (const rule of parsed) {
      const names = selectorsOf(rule.selector);
      // Only the bare class. A rule scoped inside something else — `.panel
      // .foo`, `.account-transactions > .section-title` — is about that
      // container's own layout and is none of this rule's business.
      if (!names.some((name) => PAGE_LEVEL.includes(name))) continue;
      const margins = [
        ...rule.body.matchAll(/(?:^|[;\s])(margin(?:-top|-bottom)?)\s*:\s*([^;]+)/g),
      ];
      for (const [, property, value] of margins) {
        // `margin: 0 auto` centres a page and sets no vertical distance;
        // `margin-bottom: 0` is a reset, not a decision.
        const parts = value!.trim().split(/\s+/);
        const vertical = property === "margin" ? [parts[0], parts[2] ?? parts[0]] : [parts[0]];
        if (vertical.every((one) => one === "0" || one === "0px")) continue;
        offenders.push(`${rule.selector} { ${property}: ${value!.trim()} }`);
      }
    }
    expect(offenders, "the page's gap decides this, not the block").toEqual([]);
  });

  /**
   * The two constants that used to hoist the transactions buttons into the
   * header band, and the reason a rule about them is worth keeping: they were
   * hand-tuned to one header height each and neither said so.
   */
  it("hoists nothing into the header with a negative margin", () => {
    // Scoped to blocks that sit on a page. `.sr-only` uses `margin: -1px` as
    // half of the clip trick and `.inline-edit` pulls a cell's editor back over
    // its own padding; neither is positioning one section against another.
    const positioning = new Set([...PAGE_LEVEL, ".page-actions", ".page-heading"]);
    const negative = parsed
      .filter((rule) => selectorsOf(rule.selector).some((name) => positioning.has(name)))
      .filter((rule) => /margin[^:]*:\s*[^;]*-\d/.test(rule.body))
      .map((rule) => rule.selector);
    expect(negative).toEqual([]);
  });
});

describe("a scrolling table", () => {
  /**
   * SC 2.1.1, and it had never been true: every `.data-table` carries a
   * `min-width` and sits in a container that scrolls, and not one of those
   * containers was a tab stop. A region that scrolls and cannot be reached is
   * content a keyboard user cannot get to.
   *
   * The name travels with the tabindex because a focusable region without one
   * is announced as "region" and nothing else.
   */
  it("is reachable from the keyboard, and named", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const path of globSync("src/client/**/*.tsx")) {
      const source = readFileSync(path, "utf8");
      // `[\s\S]*?` and no anchor on `className`: the formatter breaks a tag with
      // four attributes across five lines, and a pattern that wanted them on one
      // saw half the wrappers and reported the other half as passing.
      for (const match of source.matchAll(/<div\s[^>]*?className="table-(?:card|wrap)"[^>]*>/g)) {
        checked += 1;
        const tag = match[0];
        if (!tag.includes("tabIndex={0}")) offenders.push(`${path} (no tabIndex)`);
        else if (!tag.includes('role="region"')) offenders.push(`${path} (no role)`);
        else if (!tag.includes("aria-label")) offenders.push(`${path} (no name)`);
      }
    }
    expect(offenders).toEqual([]);
    // The count, because a pattern that matched nothing would pass the line
    // above and say nothing — which is exactly what the first version did.
    expect(checked).toBe(12);
  });
});

describe("a filter bar", () => {
  /**
   * Templates wrapped its Type filter in a `Field`, which stacks a visible
   * label above the control and made it twenty pixels taller than the search
   * box beside it — which `align-items: center` then rendered as two boxes at
   * two heights. Every other filter in the app was already a bare control with
   * an `aria-label`.
   *
   * A filter is not a form field: it takes effect on change, has no error
   * state, no required state, no submit, and never appears in an error summary.
   */
  it("wraps no control in a Field", () => {
    const offenders: string[] = [];
    for (const path of globSync("src/client/**/*.tsx")) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(
        /className="(?:category-toolbar|filter-bar|toolbar)"([\s\S]*?)\n {6}<\/div>/g,
      )) {
        if (match[1]!.includes("<Field")) offenders.push(path);
      }
    }
    expect(offenders, "a filter takes a bare control and an aria-label").toEqual([]);
  });
});
