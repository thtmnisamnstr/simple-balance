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

/**
 * Two rules that are one subject: a thing you can reach with the keyboard has
 * to show that you have, and a thing that scrolls has to leave room for what
 * sticks over it.
 */
describe("focus and the sticky layers", () => {
  it("shows a focus indicator on every focusable kind", () => {
    const focusRules = parsed.filter((rule) => /:focus(-visible|-within)?\b/.test(rule.selector));
    const covered = focusRules.map((rule) => rule.selector).join(" ");
    // `summary` is the row menu's trigger, `[tabindex]` is a scrolling table,
    // and a checkbox used to have nothing but `accent-color`. All three were
    // focusable with no indicator, which is SC 2.4.7 three times.
    for (const kind of ["button", "a", "summary", "input", "select", "textarea", "[tabindex]"]) {
      expect(covered, `${kind} can take focus and shows nothing`).toContain(kind);
    }
    // The file picker's own input is visually hidden, so the wrapper takes it.
    expect(covered).toContain(".file-drop:focus-within");
  });

  it("leaves room under whatever sticks over a scroller", () => {
    const sticky = parsed.filter((rule) => /position:\s*(sticky|fixed)/.test(rule.body));
    expect(sticky.length).toBeGreaterThan(0);
    // Two scrollers hold all of them: the document, and the modal's own card.
    // SC 2.4.11 — without this a row scrolled to by keyboard lands underneath
    // the bar that is stuck over it, which is the case `.merge-panel` is.
    const padded = parsed
      .filter((rule) => /scroll-padding/.test(rule.body))
      .flatMap((rule) => selectorsOf(rule.selector));
    expect(padded).toContain("html");
    expect(padded).toContain(".modal-card");
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

/**
 * A page-prefixed class is used on that page and nowhere else.
 *
 * `web.md` 6.3 asks for a class named for its component rather than for a page,
 * and `.settings-note` was the counter-example: named after the page it was born
 * on and then used 26 times across eight files, none of them Settings. It is a
 * `Note` component now, and this is what would have said so — the drift is
 * invisible from any one file, because every use of it looks local.
 *
 * The prefix comes from the page's own filename, so a new page is covered the
 * day it is added rather than the day somebody remembers.
 */
describe("a page-scoped class", () => {
  /**
   * Utilities, which are legitimately used everywhere, and the four are the
   * four `web.md` 6.3 names. A fifth has to come here and argue.
   */
  const UTILITIES = new Set(["align-right", "nowrap", "subtle", "sr-only"]);

  /**
   * Names that read like a page's and belong to a component, one line each.
   *
   * This is a register rather than a rule, because the distinction the rule
   * draws — is this class named for a *page* or for a *component that happens
   * to share the page's word* — is a judgement no pattern makes. `.settings-note`
   * was named for a page and used on eight files; `.account-icon` is named for
   * an account and appears wherever an account does. Nothing structural tells
   * them apart: `.settings-note` was used on its own page too.
   *
   * The value is that a *new* off-page use has to be classified here, which is
   * the reading `.settings-note` never got in 26 uses across four releases.
   */
  const COMPONENTS = new Map([
    ["account-icon", "An account's coloured glyph, wherever an account is listed"],
    ["budget-display", "The budget section the dashboard and the budgets page share"],
    ["budget-report", "Same section, same reason"],
    ["budget-progress", "The bar inside it"],
    ["budget-bar", "The bar inside it"],
    ["import-batches", "The import-batch list, read by the staged queue as well"],
    ["template-blank", "A template's unfilled field, shown wherever one is applied"],
    ["account-mini-group", "The dashboard's compact account list"],
    ["account-mini-heading", "Same list"],
    ["account-mini-row", "Same list"],
    ["account-register", "The register of one account's entries, on its detail page"],
    ["account-transactions", "Same register, and the category detail page shows one too"],
    ["recurrence-preview", "A schedule's next few dates, previewed in the form as well"],
    ["recurrence-preview-label", "Same preview"],
    ["transaction-cell", "A cell in the transaction register, wherever the register appears"],
    ["transaction-icon", "Same register"],
    ["transaction-payee", "Same register, and the staged queue shows the same shape"],
    ["transaction-selection-bar", "The bulk-action bar, on all three pages that have one"],
    ["transaction-selection-actions", "Same bar"],
    ["transaction-type", "The deposit/withdrawal/transfer choice, in every form that asks"],
    ["transaction-type-grid", "Same choice"],
  ]);

  it("is used on the page it is named for and nowhere else", () => {
    const pages = globSync("src/client/pages/*.tsx");
    // Both spellings, because pages disagree about which they use.
    // `AccountsPage.tsx` names its classes `.account-card`, singular, and
    // `SettingsPage.tsx` names its `.settings-section`, plural. Deriving only
    // the singular is why a `.settings-` class dropped on the dashboard went
    // unnoticed by the first version of this check.
    const prefixesOf = (path: string) => {
      const stem = path
        .slice(path.lastIndexOf("/") + 1)
        .replace(/Page\.tsx$/, "")
        .replace(/([a-z])([A-Z])/g, "$1-$2")
        .toLowerCase();
      return [...new Set([stem, stem.replace(/s$/, "")])].filter((one) => one.length >= 4);
    };
    const strays: string[] = [];
    let checked = 0;
    for (const page of pages) {
      const prefixes = prefixesOf(page);
      if (prefixes.length === 0) continue;
      checked += 1;
      const used = new RegExp(`\\b(?:${prefixes.join("|")})-[a-z-]+`, "g");
      for (const other of globSync("src/client/**/*.tsx")) {
        if (other === page) continue;
        const source = readFileSync(other, "utf8");
        // A class name inside a comment is a comment about it. Every docstring
        // here that explains a rename names the class it replaced, which is
        // the reason to keep the comment rather than a reason to fail.
        const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        for (const match of code.matchAll(used)) {
          const name = match[0];
          if (UTILITIES.has(name) || COMPONENTS.has(name)) continue;
          // A real class rather than a word that happens to start the same way.
          // Keyed on the stylesheet and not on "does its own page use it too":
          // that guard let the worse case through, a `.settings-` class used on
          // the dashboard and *not* on Settings at all.
          if (!css.includes(`.${name}`)) continue;
          strays.push(`${other} uses ${name}, which belongs to ${page}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
    expect(
      [...new Set(strays)],
      "name it for its component, not for a page — or say which it is in COMPONENTS",
    ).toEqual([]);
    // Every register entry still earns its place. One left behind after the
    // class it excused was renamed is the register drifting the way the class
    // did.
    const everything = globSync("src/client/**/*.tsx")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const stale = [...COMPONENTS.keys()].filter((name) => !everything.includes(name));
    expect(stale, "these are excused and unused").toEqual([]);
  });
});

/**
 * Full height means the viewport somebody actually has.
 *
 * `100vh` is the *largest* viewport height, so on a mobile browser with a
 * retracting toolbar it is taller than what is on screen and the bottom of the
 * page cannot be reached until the toolbar hides itself. The modal was where it
 * mattered: `max-height: calc(100vh - 28px)` put a tall form's last field and
 * its submit button below the fold.
 *
 * `vw` is deliberately not in scope. Nothing retracts horizontally, so the two
 * `100vw` in the modal's width arithmetic are correct as they are.
 */
describe("a full-height rule", () => {
  it("measures the dynamic viewport", () => {
    const offenders = css
      .split("\n")
      .map((line, index) => ({ line, at: index + 1 }))
      .filter(({ line }) => /\b\d+vh\b/.test(line) && !/^\s*(?:\/\*|\*)/.test(line))
      .map(({ line, at }) => `styles.css:${at} ${line.trim()}`);
    expect(offenders, "use dvh, which is the viewport as it is now").toEqual([]);
    // And there are heights to have got wrong: an empty result here would mean
    // the stylesheet stopped setting one rather than that it sets them well.
    expect([...css.matchAll(/\b\d+dvh\b/g)].length).toBeGreaterThan(4);
  });
});

/**
 * Header alignment, cell alignment and tabular figures travel together.
 *
 * `web.md` 9.3 says exactly that and the selector said otherwise: it was
 * `.data-table td.align-right`, so a `<th className="align-right">` on Reports
 * and Budgets got the alignment and not the figures — a column of period totals
 * in a header row that failed to line up with the identical column beneath it.
 */
describe("a right-aligned table cell", () => {
  it("gets tabular figures whether it is a header or not", () => {
    const rule = css.slice(css.indexOf(".align-right,\n.amount"));
    expect(css).toContain(".data-table :is(th, td).align-right");
    expect(rule.slice(0, rule.indexOf("}"))).toContain("font-variant-numeric: tabular-nums");
  });
});
