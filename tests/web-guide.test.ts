import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stylesheet } from "./support/css.js";
import { repoRoot, sourceFiles } from "./support/source.js";

/**
 * The numbers and lists `docs/standards/web.md` argues from, derived here.
 *
 * That guide reasons from censuses — ten inline styles, eight z-index values,
 * twenty-seven components, twenty-eight silent buttons — and a census written
 * by hand is checked by whoever happens to recount it, which is nobody. By the
 * time this file was written the guide said sixteen empty states where there
 * are twenty-three and eighteen thirteen lines later; twelve scrolling
 * containers in one section and fourteen in another; twenty-four components in
 * a library of twenty-seven, with the one promoted into it that release having
 * no row at all. Every one of those read as evidence.
 *
 * `tests/standards-citations.test.ts` already does this for section 3's
 * spacing, radius, type and weight ramps and for the two numbers the guide
 * opens with. This file is the same idea for the rest of the page, and it is
 * separate rather than appended there because that one is about every guide's
 * citations and this one is about this guide's claims.
 *
 * Three rules that are not counts are here too, because each is a *shape* a new
 * instance has to land in and none of them is visible to a rendered test: where
 * an ad slot sits relative to the main landmark (7.7), the order the
 * stylesheet's at-rules end in (7.3, 15), and what a link that leaves the app
 * looks like (13.6).
 *
 * Everything is read from comment-blanked source, so a rule discussed in a
 * comment is not counted as a use of it — `forms.tsx` mentions `<Field>` twice
 * in JSX comments, which is two of the difference between a grep and a census.
 */
const GUIDE = path.join(repoRoot, "docs/standards/web.md");

/** The guide with its line breaks flattened, because prose wraps and counts do not. */
const guide = () => readFileSync(GUIDE, "utf8").replaceAll(/\s+/g, " ");

/** Every `.ts` and `.tsx` under `src/client`, comments blanked to spaces. */
const client = () => sourceFiles("src/client");

/** How many times a pattern appears across the client's code. */
const occurrences = (pattern: RegExp): number =>
  client().reduce((total, file) => total + [...file.code.matchAll(pattern)].length, 0);

/**
 * The guide spells small numbers as words and large ones as digits, with no
 * rule about where the line is, so each assertion says which it expects rather
 * than this helper guessing.
 */
const WORDS: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  13: "thirteen",
  14: "fourteen",
  16: "sixteen",
  20: "twenty",
  23: "twenty-three",
  24: "twenty-four",
  27: "twenty-seven",
  28: "twenty-eight",
  30: "thirty",
  35: "thirty-five",
  36: "thirty-six",
};

const word = (count: number): string => {
  const spelled = WORDS[count];
  // A count that has outgrown the map is a real failure rather than a missing
  // entry: whoever adds the entry has to read the sentence it goes in.
  if (spelled === undefined) throw new Error(`web.md spells no word for ${count}; add one`);
  return spelled;
};

const capitalized = (count: number): string => {
  const spelled = word(count);
  return `${spelled[0]!.toUpperCase()}${spelled.slice(1)}`;
};

/**
 * Every top-level construct of the stylesheet, in source order.
 *
 * `blocks()` in `support/css.ts` recurses into an at-rule and reports the rules
 * inside it, which is what every other test here wants and the opposite of what
 * this one does: the question is which at-rules follow which, and the bodies are
 * incidental.
 */
function topLevel(css: string): { selector: string; body: string }[] {
  const clean = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const found: { selector: string; body: string }[] = [];
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  let selector = "";
  for (let at = 0; at < clean.length; at += 1) {
    const character = clean[at];
    if (character === "{") {
      if (depth === 0) {
        selector = clean.slice(start, at).trim();
        bodyStart = at + 1;
      }
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        found.push({ selector, body: clean.slice(bodyStart, at) });
        start = at + 1;
      }
    }
  }
  return found;
}

/**
 * One JSX tag, read from `<name` to the `>` that closes it.
 *
 * Brace depth rather than a regular expression, for the reason
 * `tests/field-contract.test.tsx` records about its own census: `[^>]*?` cannot
 * cross the `>` in `onClick={() => …}`, so a pattern written that way is blind
 * to any tag whose first attribute is an arrow function — and reports green.
 */
function tagsNamed(code: string, name: string): { tag: string; at: number }[] {
  const found: { tag: string; at: number }[] = [];
  const opener = new RegExp(`<${name}(?=[\\s/>])`, "g");
  for (const match of code.matchAll(opener)) {
    const from = match.index;
    let depth = 0;
    for (let at = from; at < code.length; at += 1) {
      const character = code[at];
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
      else if (character === ">" && depth === 0) {
        found.push({ tag: code.slice(from, at + 1), at: from });
        break;
      }
    }
  }
  return found;
}

describe("web.md's component inventory", () => {
  /**
   * 6.1 opens with three counts and then lists what it counted.
   *
   * The counts and the table came apart in the release that promoted `Note`
   * into the library: the header said twenty-four components where there are
   * twenty-seven, named three helpers of four, and `Note` had no row — which
   * matters beyond tidiness, because 6.2's duplicate check is "is it already in
   * the table" and a component with no row is one the check cannot fire for.
   * That is the failure 6.1's own opening sentence names.
   */
  it("counts and lists every export of components.tsx", () => {
    const source = client().find((file) => file.path === "src/client/components.tsx");
    expect(source, "src/client/components.tsx is readable").toBeDefined();
    const exports = [
      ...source!.code.matchAll(/^export (?<kind>function|const|type) (?<name>[A-Za-z0-9_]+)/gm),
    ].map((match) => ({ kind: match.groups!.kind!, name: match.groups!.name! }));

    const types = exports.filter((one) => one.kind === "type");
    // A component is an export whose name is capitalized, which is React's own
    // rule rather than this test's: JSX reads a lowercase tag as an HTML
    // element, so the capital is what makes `Input` usable as `<Input>`.
    const components = exports.filter((one) => one.kind !== "type" && /^[A-Z]/.test(one.name));
    const helpers = exports.filter((one) => one.kind !== "type" && !/^[A-Z]/.test(one.name));

    const flat = guide();
    expect(flat, `components.tsx exports ${components.length} components`).toContain(
      `${word(components.length)} components, ${word(helpers.length)} helpers`,
    );
    expect(flat, `and ${types.length} exported types`).toContain(
      `and ${word(types.length)} exported types`,
    );
    for (const helper of helpers) {
      expect(flat, `${helper.name} is a helper and the header lists the helpers`).toContain(
        `\`${helper.name}\``,
      );
    }

    // 6.1's own rows, and nothing else's. 17.1 is a table of backticked names
    // too, so a population taken from "a line starting with a backticked cell"
    // would count a component mentioned in a test's description as listed —
    // which is 17.2's first rule, that a check derives its population from the
    // product rather than from the shape of what it is looking for.
    const inventory = /### 6\.1 The inventory\n([\s\S]*?)\n### /.exec(readFileSync(GUIDE, "utf8"));
    expect(inventory, "web.md still has a section 6.1").not.toBeNull();
    // A row may name several components — `Modal`, `ConfirmDialog`,
    // `useConfirm` share one — so the cell is scanned for backticked names
    // rather than split on them.
    const rows = inventory![1]!.split("\n").filter((line) => line.startsWith("| `"));
    const listed = new Set(
      rows.flatMap((row) => [...row.matchAll(/`([A-Za-z0-9_]+)`/g)].map((match) => match[1]!)),
    );
    const missing = [...components, ...helpers]
      .map((one) => one.name)
      .filter((name) => !listed.has(name));
    expect(missing, "every export of the library has a row in 6.1").toEqual([]);
    // And the one row for a component that lives elsewhere, which is why the
    // table is a row longer than the file and 6.1 says so.
    expect(listed.has("AdSlot"), "AdSlot has a row although it lives in ads.tsx").toBe(true);
  });
});

describe("web.md's stylesheet censuses", () => {
  /**
   * 1.3's argument is that every inline style in the client is runtime geometry,
   * and it rests on the list being complete. It was not: the ad unit's
   * `display: block` is a vendor requirement outranked by an important
   * declaration in the stylesheet, which is a decision rather than a coordinate,
   * and it sat outside an enumeration that read as finished.
   */
  it("accounts for every inline style prop", () => {
    const total = occurrences(/\bstyle=\{/g);
    expect(guide(), `src/client has ${total} inline style props`).toContain(
      `${word(total - 1)} of the ${word(total)} inline \`style\` props`,
    );
    const ads = readFileSync(path.join(repoRoot, "src/client/ads.tsx"), "utf8").split("\n");
    expect(guide(), "the tenth is named rather than left to look like the nine").toContain(
      "`ads.tsx:143`",
    );
    expect(ads[142], "ads.tsx:143 is the vendor display declaration").toContain("style={{");
  });

  /**
   * 3.5's ladder, which is what a z-index chosen alone is chosen against — so a
   * value with no rung is a layer chosen against nothing. Two were missing when
   * this was written, the skip link and the mobile header, both added after the
   * ladder and neither read against it.
   */
  it("gives every z-index on the page a rung", () => {
    const css = stylesheet().replaceAll(/\/\*[\s\S]*?\*\//g, "");
    const declared = [...css.matchAll(/z-index:\s*(-?\d+)/g)].map((match) => Number(match[1]));
    const distinct = [...new Set(declared)].sort((left, right) => left - right);
    const flat = guide();
    expect(flat, `the stylesheet declares z-index ${declared.length} times`).toContain(
      `${capitalized(declared.length)} declarations across **${word(distinct.length)} distinct values**`,
    );

    // The rows of 3.5's table alone. Scanning the whole guide for a row whose
    // first cell is a number also finds the chart palette's ten series, which
    // are numbered 0 to 9 and are not layers — a population taken from the
    // shape of a line rather than from the section it is in.
    const section = /### 3\.5 Z-index\n([\s\S]*?)\n### /.exec(readFileSync(GUIDE, "utf8"));
    expect(section, "web.md still has a section 3.5").not.toBeNull();
    const rungs = new Set(
      section![1]!
        .split("\n")
        .map((line) => /^\| (\d+) \| /.exec(line)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number),
    );
    expect(
      distinct.filter((value) => !rungs.has(value)),
      "every declared z-index has a row in 3.5's ladder",
    ).toEqual([]);
    expect(
      [...rungs].filter((value) => !distinct.includes(value)),
      "3.5's ladder names no layer the stylesheet does not have",
    ).toEqual([]);
  });

  /**
   * 7.3 and 15, which are one rule read from two ends.
   *
   * `tests/styles-order.test.ts` refuses a non-at-rule after the first
   * breakpoint and says nothing about the order of the at-rules themselves, so
   * the print block could land after a block whose own comment calls itself
   * last — and did. Where a media query sits decides whether it wins, and that
   * argument does not stop at the first breakpoint.
   */
  it("ends in the order the guide states, with one print block", () => {
    const constructs = topLevel(stylesheet());
    const first = constructs.findIndex((one) => one.selector.startsWith("@media (max-width"));
    expect(first, "the file has a breakpoint block").toBeGreaterThan(-1);
    const tail = constructs.slice(first).map((one) => one.selector);
    expect(tail, "the responsive body, then preference, then medium").toEqual([
      "@media (max-width: 1050px)",
      "@media (max-width: 980px)",
      "@media (max-width: 780px)",
      "@media (max-width: 560px)",
      "@media (prefers-reduced-motion: reduce)",
      "@media print",
    ]);

    const print = constructs.at(-1)!;
    const rules = topLevel(print.body);
    expect(
      rules.map((one) => one.selector),
      "the print block hides the ad slot",
    ).toEqual([".ad-slot"]);
    expect(rules[0]!.body).toMatch(/display:\s*none/);
    expect(guide(), "15 says what the print block holds").toContain("holds one rule");
  });
});

describe("web.md's client censuses", () => {
  /**
   * Every count the guide states about the client, in one place.
   *
   * Each is load-bearing where it sits: the `Field` count is the argument for
   * wiring by context rather than by cloning a child, the `formatMoney` count is
   * the size of the loose end 9.3 asks somebody to close, and the optional count
   * is the scheme 8.4 says this product picked.
   */
  it("states what the client actually contains", () => {
    const flat = guide();

    const fields = occurrences(/<Field[\s>]/g) - occurrences(/<Field\s+extends|SortState<Field>/g);
    expect(flat, `Field is used at ${fields} sites`).toContain(`at ${fields} sites`);

    const required = occurrences(/\srequired(?=[\s>=])/g) - occurrences(/\srequired\s*=\s*false/g);
    expect(flat, `required is set ${required} times`).toContain(
      `\`required\` is set on controls ${required} times`,
    );

    // 8.4's scheme marks the optional fields, and there are now two ways to do
    // it: the hint written at the call site, and `Field`'s own prop. One census
    // covers both, because a reader counting only hints would conclude the three
    // on Budgets are unmarked.
    const hinted = occurrences(/hint="Optional/g);
    const propped = occurrences(/<Field[^>]*?\soptional(?=[\s>])/g);
    expect(flat, `${hinted + propped} fields are marked optional`).toContain(
      `**${word(hinted + propped)} fields are marked optional**`,
    );
    expect(flat, `${propped} through the prop`).toContain(`${word(propped)} through the prop`);
    expect(flat, `${hinted} writing the hint by hand`).toContain(
      `${word(hinted)} writing the hint by hand`,
    );

    // The definition and its own recursive call are not call sites: 9.3 is about
    // the places that would adopt `.amount`.
    const money = occurrences(/\bformatMoney\(/g) - 2;
    expect(flat, `there are ${money} formatMoney call sites`).toContain(
      `the ${money} \`formatMoney\` call sites`,
    );

    const empties = occurrences(/<EmptyState[\s>/]/g);
    expect(flat, `EmptyState is used at ${empties} sites`).toContain(
      `\`EmptyState\` is used at ${empties} sites`,
    );

    const skeletons = occurrences(/<Skeleton[\s>/]/g);
    expect(flat, `there are ${skeletons} Skeleton sites`).toContain(
      `${word(skeletons)} \`Skeleton\` sites`,
    );
  });

  /**
   * 12.3's census, derived the way `tests/field-contract.test.tsx` derives it.
   *
   * That test holds the *rule* — every one of these says why it is gray. This
   * holds the *number*, which is a different claim and the one the guide makes:
   * the section argues from how many controls were going gray in silence, and it
   * said twenty-two for a release after the count had moved.
   */
  it("counts the buttons disabled on a computed predicate", () => {
    const disabled = client()
      .filter((file) => file.path.endsWith(".tsx"))
      .flatMap((file) => tagsNamed(file.code, "Button"))
      .filter((one) => /\sdisabled=\{/.test(one.tag));
    const flat = guide();
    expect(flat, `${disabled.length} controls are disabled on a computed predicate`).toContain(
      `${capitalized(disabled.length)} controls are disabled on a computed predicate`,
    );
    expect(flat, "and the census paragraph reads the same number").toContain(
      `**${disabled.length} today**`,
    );
  });

  /**
   * How many containers scroll, which this guide said twice and differently.
   *
   * The measurement belongs to `tests/page-stack.test.ts`, which pins it against
   * the markup; this reads that pin rather than re-deriving it, because a second
   * derivation of one measurement is the thing that went wrong — 9.6 said
   * fourteen and 17.1 said twelve, and both read as checked.
   */
  it("says the same number of scrolling containers in both places", () => {
    const census = readFileSync(path.join(repoRoot, "tests/page-stack.test.ts"), "utf8");
    const pinned = /expect\(checked\)\.toBe\((\d+)\)/.exec(census)?.[1];
    expect(
      pinned,
      "page-stack.test.ts pins the scrolling-container count as `expect(checked).toBe(n)`",
    ).toBeDefined();
    const flat = guide();
    const spelled = word(Number(pinned));
    expect(flat, `9.6 reports ${spelled} scrolling containers`).toContain(
      `all ${spelled} scrolling containers`,
    );
    expect(flat, `17.1 reports ${spelled} too`).toContain(
      `the ${spelled} scrolling table containers`,
    );
  });
});

describe("web.md's rules about markup", () => {
  /**
   * 7.7: both ad units sit outside `<main>` and below it.
   *
   * `<main>` is what the skip link targets and what focus moves to on every
   * route change, and a screen reader entering a landmark reads from its top —
   * so a slot inside it puts an advertisement in front of the page on every
   * navigation, for the people who got there by skipping the navigation. The
   * check reads the source rather than a render because the defect is a slot
   * moved up the file, and jsdom reports the same accessible name either side of
   * the landmark.
   */
  it("keeps every ad slot below the main landmark", () => {
    const shell = client().find((file) => file.path === "src/client/App.tsx");
    expect(shell, "src/client/App.tsx is readable").toBeDefined();
    // The landmark the skip link targets, not whichever `</main>` comes last:
    // `App.tsx` also renders the sign-in shells, which are `<main>` elements of
    // their own further down the file, and measuring against one of those puts
    // every slot "after main" however high up the shell it was written.
    const landmark = shell!.code.indexOf('id="main"');
    expect(landmark, "the shell has the landmark the skip link targets").toBeGreaterThan(-1);
    const closes = shell!.code.indexOf("</main>", landmark);
    expect(closes, "that landmark closes").toBeGreaterThan(-1);
    const slots = tagsNamed(shell!.code, "AdSlot");
    expect(slots.length, "the shell renders ad slots").toBeGreaterThan(0);
    expect(
      slots.filter((slot) => slot.at < closes).map((slot) => slot.tag),
      "every AdSlot is written after </main>",
    ).toEqual([]);

    const ads = client().find((file) => file.path === "src/client/ads.tsx");
    const aside = tagsNamed(ads!.code, "aside")[0];
    expect(aside?.tag, "the slot is a labeled complementary landmark").toMatch(/aria-label=/);
    // Absence, deliberately: hiding an ad from a screen reader while showing it
    // to everybody else reads as a kindness and is concealment, and it is the
    // change most likely to be proposed as an improvement.
    expect(ads!.code, "nothing in the slot is hidden from assistive technology").not.toMatch(
      /aria-hidden/,
    );
  });

  /**
   * 13.6: a link that leaves the app, in the one shape all of them take.
   *
   * The population is derived rather than listed — every anchor in the client
   * whose `href` is not a route — so a sixth operator document is inside this
   * rule by construction. Two files are excluded by name because their href is a
   * route by construction and no pattern can say so: `Link`, which builds one
   * out of the router's own location, and `SettingsTabs`, which maps over two
   * literal paths.
   */
  it("holds every link that leaves the app to one shape", () => {
    const ROUTE_BY_CONSTRUCTION = new Set(["src/client/router.tsx", "src/client/components.tsx"]);
    const leaving: { where: string; tag: string; body: string }[] = [];
    for (const file of client()) {
      if (!file.path.endsWith(".tsx")) continue;
      for (const anchor of tagsNamed(file.code, "a")) {
        const href = /href=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/.exec(anchor.tag);
        if (!href) continue;
        const literal = href[1] ?? href[2];
        // A literal path or fragment is this app's own address space.
        if (literal !== undefined && /^[/#]/.test(literal)) continue;
        if (ROUTE_BY_CONSTRUCTION.has(file.path)) continue;
        const closes = file.code.indexOf("</a>", anchor.at);
        leaving.push({
          where: `${file.path}:${file.code.slice(0, anchor.at).split("\n").length}`,
          tag: anchor.tag,
          body: file.code.slice(anchor.at, closes === -1 ? anchor.at : closes),
        });
      }
    }

    expect(leaving.length, "the client has links that leave it").toBeGreaterThan(0);
    expect(guide(), `${leaving.length} anchors leave the app`).toContain(
      `${capitalized(leaving.length)} anchors in this product point at a document the operator`,
    );
    expect(
      leaving.filter((one) => !one.tag.includes('target="_blank"')).map((one) => one.where),
      "a link that leaves the app opens a new tab, so a half-filled form survives it",
    ).toEqual([]);
    expect(
      leaving.filter((one) => !/rel="no(referrer|opener)/.test(one.tag)).map((one) => one.where),
      "and carries a rel that does not hand the opener over",
    ).toEqual([]);
    // The deliberate absence, and the one a reviewer will ask to change: warning
    // about a new window is SC 3.2.5, level AAA, and the target here is AA. 13.6
    // argues it; this makes somebody read that argument before adding one.
    expect(
      leaving
        .filter((one) => /aria-label=|title=/.test(one.tag) || /new (tab|window)/i.test(one.body))
        .map((one) => one.where),
      "the new tab is not announced; 13.6 says why, and changing that changes 13.6",
    ).toEqual([]);
  });
});
