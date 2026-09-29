import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERIES_COLORS } from "../src/client/charts.js";
import { blocks, ruleFor, stylesheet, tokensIn, type Block } from "./support/css.js";
import { sourceFiles } from "./support/source.js";

/**
 * The stylesheet holds two palettes now, and the ways that goes wrong are all
 * mechanical, so they are all checked here.
 *
 * The one that matters most: a token declared in one theme and not the other.
 * Nothing about that fails to compile, nothing looks wrong in the theme somebody
 * happened to be in, and the other theme paints one color from the wrong set —
 * white text on white, or a border that vanishes. It is invisible in review and
 * obvious to whoever is using it.
 */
const css = stylesheet();

const LIGHT = (block: Block) => block.context.length === 0 && block.selector === ":root";
const MEDIA_DARK = (block: Block) =>
  block.context.some((at) => /prefers-color-scheme:\s*dark/.test(at)) &&
  block.selector === ':root:not([data-theme="light"])';
const ATTRIBUTE_DARK = (block: Block) =>
  block.context.length === 0 && block.selector === ':root[data-theme="dark"]';

const light = tokensIn(css, LIGHT);
const mediaDark = tokensIn(css, MEDIA_DARK);
const attributeDark = tokensIn(css, ATTRIBUTE_DARK);

describe("the two palettes", () => {
  it("declares all three blocks", () => {
    for (const [name, tokens] of [
      ["light", light],
      ["dark, chosen by the machine", mediaDark],
      ["dark, chosen explicitly", attributeDark],
    ] as const) {
      expect(Object.keys(tokens).length, `${name} has no tokens`).toBeGreaterThan(20);
    }
  });

  it("gives every token a value in both themes", () => {
    // The whole point. A token in one block and not the other is the bug that
    // makes half the app unreadable.
    expect(Object.keys(mediaDark).sort()).toEqual(Object.keys(light).sort());
    expect(Object.keys(attributeDark).sort()).toEqual(Object.keys(light).sort());
  });

  it("keeps the two dark blocks saying the same thing", () => {
    // They cannot be merged — one asks what the machine wants, the other what
    // the person chose, and either can be true alone — so they are duplicated,
    // and duplication is what drifts.
    expect(attributeDark).toEqual(mediaDark);
  });

  it("puts the explicit choice last so it wins", () => {
    // Both selectors have the same specificity, so source order is the only
    // thing that decides. If the media block came second, choosing light on a
    // dark machine would paint dark.
    const order = blocks(css);
    const media = order.findIndex(MEDIA_DARK);
    const attribute = order.findIndex(ATTRIBUTE_DARK);
    expect(media).toBeGreaterThan(-1);
    expect(attribute).toBeGreaterThan(media);
  });

  it("tells the browser which theme its own surfaces should be", () => {
    // Scrollbars, number-input spinners and date pickers read `color-scheme` and
    // nothing else. Without it they stay light against a dark page.
    const declared = (matches: (block: Block) => boolean) =>
      blocks(css)
        .filter(matches)
        .flatMap((block) => [...block.body.matchAll(/color-scheme:\s*([a-z]+)/g)])
        .map((match) => match[1]);
    expect(declared(LIGHT)).toEqual(["light"]);
    expect(declared(MEDIA_DARK)).toEqual(["dark"]);
    expect(declared(ATTRIBUTE_DARK)).toEqual(["dark"]);
  });
});

describe("colors in the stylesheet", () => {
  const TOKEN_BLOCK = (block: Block) => LIGHT(block) || MEDIA_DARK(block) || ATTRIBUTE_DARK(block);

  it("are written in the token blocks and nowhere else", () => {
    // A color written inline has one theme by construction. This is the rule
    // that stops the second palette rotting the next time somebody adds a rule.
    const strays: string[] = [];
    for (const block of blocks(css)) {
      if (TOKEN_BLOCK(block)) continue;
      for (const found of block.body.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
        // A mask's color keyword is an alpha channel, not a color.
        if (/mask(-image)?\s*:/.test(block.body.slice(0, found.index))) continue;
        strays.push(`${block.selector}: ${found[0]}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("never reference a token that was never declared", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((token) => !(token in light)).sort()).toEqual([]);
  });

  it("declares nothing it does not use", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect(
      Object.keys(light)
        .filter((token) => !used.has(token))
        .sort(),
    ).toEqual([]);
  });
});

describe("what each token is for", () => {
  // A color that reads as text in one theme can be a fill in the other only if
  // the two roles are two tokens. They were one token, and in dark that put
  // white text on a bright mint button at 1.9:1.
  const TEXT = new Set([
    "--ink",
    "--ink-soft",
    "--muted",
    "--green",
    "--green-dark",
    "--red",
    "--amber",
    "--blue",
  ]);
  const FILL = new Set([
    "--ground",
    "--surface",
    "--surface-soft",
    "--fill-subtle",
    "--track",
    "--green-fill",
    "--green-fill-hover",
    "--red-fill",
    "--green-soft",
    "--green-wash",
    "--red-soft",
    "--amber-soft",
    "--blue-soft",
    "--fill-deep",
    "--field",
    "--field-disabled",
  ]);

  it("never paints an area with a text color, or writes text in a surface color", () => {
    const wrong: string[] = [];
    for (const block of blocks(css)) {
      if (block.selector.includes(":root")) continue;
      for (const declaration of block.body.split(";")) {
        const parsed = /^\s*([a-z-]+)\s*:\s*(.+)$/s.exec(declaration);
        if (!parsed) continue;
        const [, property, value] = parsed;
        for (const token of value!.matchAll(/var\((--[a-z0-9-]+)/g)) {
          const name = token[1]!;
          if (/^background(-color)?$/.test(property!) && TEXT.has(name)) {
            wrong.push(`${block.selector} { ${property}: var(${name}) }`);
          }
          if (property === "color" && FILL.has(name)) {
            wrong.push(`${block.selector} { color: var(${name}) }`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the field role", () => {
  // --field and --field-line hold today's --surface and --line-strong values, so
  // nothing on screen moved when they arrived. That is exactly what makes them
  // easy to lose again: a later edit reaching for --surface would look right and
  // would quietly put the field back to having no fill of its own.
  it("draws a field's fill and edge from the field role rather than the card's", () => {
    const rule = ruleFor(css, ".input");
    expect(rule.length, ".input is declared once at the top level").toBe(1);
    expect(rule[0]!.body).toMatch(/background:\s*var\(--field\)/);
    expect(rule[0]!.body).toMatch(/border:\s*1px solid var\(--field-line\)/);
  });

  it("gives a field that cannot be edited a fill of its own", () => {
    const rule = ruleFor(css, ".input:disabled");
    expect(rule.length, ".input:disabled is declared").toBe(1);
    expect(rule[0]!.body).toMatch(/background:\s*var\(--field-disabled\)/);
  });

  it("makes a disabled field look different from a live one in every theme", () => {
    // The assertion that holds the behavior rather than the wiring. Fourteen
    // fields ship disabled and every one of them was pixel-identical to a live
    // one; a --field-disabled equal to --field would pass every test above and
    // leave them that way.
    for (const [name, tokens] of [
      ["light", light],
      ["dark, chosen by the machine", mediaDark],
      ["dark, chosen explicitly", attributeDark],
    ] as const) {
      expect(tokens["--field-disabled"], `${name} disabled fill`).not.toBe(tokens["--field"]);
    }
  });
});

/**
 * The other half of section 1.5, and the half that shipped without a guard.
 *
 * A field states its disabled condition with a fill, because it sits on colored
 * rows and dimming it would let the row's color through. A button states it
 * with opacity — which works only while nothing paints over the rendering the
 * browser gives a disabled control, and two families do exactly that:
 * `.row-actions button` and `.menu-popover button` each set their own color,
 * background and cursor. So freezing an account left a dead row icon and a dead
 * menu item pixel-identical to live ones, down to the hover fill. Nothing
 * asserted either rule, which is why that could ship.
 */
describe("a disabled button", () => {
  /**
   * The families that override the browser's rendering and so must say it
   * themselves. Written out because two of them have to be: a row icon and a
   * menu item are bare `<button>`s named only by the container they sit in, so
   * the scan over the source below cannot see them. That scan is what keeps
   * this list from falling behind the third kind — `.link-button` was shipping
   * disabled with none of this while the list said the answer was complete.
   */
  const FAMILIES = [".row-actions button", ".menu-popover button", ".link-button"];
  const opacityOf = (body: string) => /opacity:\s*([\d.]+)/.exec(body)?.[1];
  const house = opacityOf(ruleFor(css, ".button:disabled")[0]?.body ?? "");

  it("dims the families that paint over the browser's own disabled rendering", () => {
    expect(house, ".button:disabled sets the house opacity").toBeDefined();
    expect(Number(house), "a dim rather than no change at all").toBeLessThan(1);
    for (const family of FAMILIES) {
      const rule = ruleFor(css, `${family}:disabled`);
      expect(rule.length, `${family}:disabled is declared once at the top level`).toBe(1);
      expect(rule[0]!.body, family).toMatch(/cursor:\s*not-allowed/);
      // Read from `.button:disabled` rather than written out twice. The
      // pagination controls already sit at their own 0.45, so a hard-coded
      // number here would be a third value nothing compares.
      expect(rule[0]!.body, `${family} takes the house opacity`).toMatch(
        new RegExp(`opacity:\\s*${house!.replace(".", "\\.")}\\s*;`),
      );
    }
  });

  it("lights no hover on a control that does nothing", () => {
    // Stated over the whole stylesheet rather than the two families, because
    // the defect is not specific to them: any family with a `:disabled` rule
    // has a hover that must be narrowed to live controls, and the next one
    // added would otherwise repeat this with nothing to say so.
    const parts = (selector: string) =>
      selector.split(",").map((one) => one.replaceAll(/\s+/g, " ").trim());
    const top = blocks(css).filter((block) => block.context.length === 0);
    const selectors = top.flatMap((block) => parts(block.selector));
    const shipsDisabled = new Set(
      selectors
        .filter((one) => one.endsWith(":disabled"))
        .map((one) => one.slice(0, -":disabled".length)),
    );
    expect(shipsDisabled.size, "the stylesheet disables something").toBeGreaterThan(2);
    const lit = selectors
      .filter((one) => one.includes(":hover") && !one.includes(":not(:disabled)"))
      .filter((one) => shipsDisabled.has(one.replace(":hover", "")));
    expect(lit, "a hover on a family that ships disabled, not narrowed to live ones").toEqual([]);
  });

  /**
   * Every element the browser ships `disabled` while naming a class of its own,
   * with the classes on it.
   *
   * The two tests above are both keyed off the stylesheet: the first checks the
   * families somebody wrote down, the second every family already carrying a
   * `:disabled` rule. Neither can see the defect that matters — a family that
   * ships disabled and was never given the answer at all — because a family
   * nobody remembered appears in neither list. `.link-button` was exactly that,
   * and it was found by reading the source rather than by either test.
   *
   * So the population is discovered from the markup, in the shape
   * `tests/support/source.ts` argues for: every opening tag carrying both a
   * `className` and a `disabled`, which is what a browser renders as a dead
   * control painted by a rule of its own.
   */
  function elementsShippedDisabled(): { classes: string[]; where: string }[] {
    const found: { classes: string[]; where: string }[] = [];
    for (const file of sourceFiles("src/client")) {
      for (let at = 0; at < file.code.length; at++) {
        if (file.code[at] !== "<" || !/[A-Za-z]/.test(file.code[at + 1] ?? "")) continue;
        const attributes = attributesOf(file.code, at);
        if (attributes === undefined || !("disabled" in attributes)) continue;
        const value = attributes["className"];
        if (value === undefined) continue;
        const classes = value
          // An interpolation is not a class name, and what it leaves behind —
          // the `button-` of `button-${variant}` — is a prefix rather than one.
          .replaceAll(/\$\{[^}]*\}/g, " ")
          .split(/[\s"'`{}?:()]+/)
          .filter((token) => /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(token));
        const line = file.code.slice(0, at).split("\n").length;
        if (classes.length > 0) found.push({ classes, where: `${file.path}:${line}` });
      }
    }
    return found;
  }

  /**
   * The attributes of the JSX opening tag at `at`, or undefined if what is
   * there is not one.
   *
   * Read by walking rather than by a pattern, and only at brace depth zero,
   * because both halves of this go wrong otherwise. `disabled={legs.length >=
   * MAX_TRANSACTION_LEGS}` holds a `>` that closes no tag, and a `<PageHeader
   * actions={<div className="…"><Button disabled /></div>} />` holds both of
   * the words being looked for, belonging to two elements inside it rather
   * than to it. Nested tags are found by the walk over the file instead, each
   * from its own `<`.
   */
  function attributesOf(code: string, at: number): Record<string, string> | undefined {
    const attributes: Record<string, string> = {};
    let index = at + 1;
    while (index < code.length && /[\w.]/.test(code[index]!)) index++;
    while (index < code.length) {
      const character = code[index]!;
      if (character === ">") return attributes;
      if (character === "<") return undefined;
      if (!/[A-Za-z]/.test(character)) {
        index++;
        continue;
      }
      const from = index;
      while (index < code.length && /[\w-]/.test(code[index]!)) index++;
      const name = code.slice(from, index);
      while (index < code.length && /\s/.test(code[index]!)) index++;
      if (code[index] !== "=") {
        attributes[name] = "";
        continue;
      }
      index++;
      const [value, after] = valueAt(code, index);
      if (after < 0) return undefined;
      attributes[name] = value;
      index = after;
    }
    return undefined;
  }

  /** One attribute's value as written, and the index just past it. */
  function valueAt(code: string, from: number): [string, number] {
    const quote = code[from];
    if (quote === '"' || quote === "'") {
      const close = code.indexOf(quote, from + 1);
      return close < 0 ? ["", -1] : [code.slice(from + 1, close), close + 1];
    }
    if (quote !== "{") return ["", -1];
    // Brace-balanced, and quote-aware so a `}` inside a string does not close
    // the expression. A template literal's `${…}` balances on its own.
    let depth = 0;
    let inside = "";
    for (let index = from; index < code.length; index++) {
      const character = code[index]!;
      if (inside) {
        if (character === inside) inside = "";
        continue;
      }
      if (character === '"' || character === "'" || character === "`") inside = character;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) return [code.slice(from + 1, index), index + 1];
    }
    return ["", -1];
  }

  /**
   * A class that is shipped disabled but is not itself the family that answers
   * for it. Each entry is argued, because an entry is a place this stops
   * looking.
   */
  const ANSWERED_BY: Record<string, string> = {
    // The account card's **Delete if unused**. `.danger` sets the item's color
    // and nothing else; what paints it, and so what has to un-paint it, is the
    // popover's own button rule.
    danger: ".menu-popover button",
  };

  it("answers every family the browser ships disabled, not only the ones written down", () => {
    const elements = elementsShippedDisabled();
    // A scan that found nothing would pass this silently, and the whole point
    // is that it is looking. Six today: the three pagination controls, the
    // `Button` component, the split editor's "Add a category", and the account
    // card's red menu item.
    expect(elements.length, "the browser disables something it paints itself").toBeGreaterThan(3);
    const missing: string[] = [];
    for (const { classes, where } of elements) {
      // Any one class on the element answering covers it: `class="button
      // button-secondary"` is a `.button`, and `.button-secondary` is a repaint
      // of one rather than a family of its own.
      const answers = classes.map((one) => ANSWERED_BY[one] ?? `.${one}`);
      if (answers.some((family) => ruleFor(css, `${family}:disabled`).length > 0)) continue;
      missing.push(`${answers.join(" / ")} at ${where}`);
    }
    expect(missing, "a family shipped disabled with nothing to say so").toEqual([]);
  });
});

describe("the chart palette", () => {
  it("has a color for every series the code will ask for, in both themes", () => {
    for (const [name, tokens] of [
      ["light", light],
      ["dark", mediaDark],
    ] as const) {
      const series = Object.keys(tokens).filter((token) => /^--series-\d+$/.test(token));
      expect(series.length, `${name} series count`).toBe(SERIES_COLORS);
    }
  });

  it("gives each series its own value in each theme", () => {
    for (const [name, tokens] of [
      ["light", light],
      ["dark", mediaDark],
    ] as const) {
      const values = Object.entries(tokens)
        .filter(([token]) => /^--series-\d+$/.test(token))
        .map(([, value]) => value);
      expect(new Set(values).size, `${name} has a repeated series color`).toBe(values.length);
    }
  });

  /**
   * Ten hues cannot all be distinguishable from each other — section 11.2 of
   * the guide argues that at length and takes the trade deliberately. Adjacent
   * bars run as low as 1.05:1, which is the case where a shape boundary has to
   * do the work color cannot.
   */
  it("separates one bar from the next with something that is not color", () => {
    const bar = ruleFor(css, ".chart-bar");
    expect(bar.length, ".chart-bar has no rule").toBeGreaterThan(0);
    const stroke = bar.map((rule) => /stroke:\s*([^;]+)/.exec(rule.body)?.[1]?.trim()).at(-1);
    expect(stroke, "adjacent bars at 1.05:1 need an edge").toBeDefined();
    expect(stroke).not.toBe("none");
  });

  it("draws every series from a token rather than a color of its own", () => {
    for (let index = 0; index < SERIES_COLORS; index++) {
      const rule = new RegExp(
        `\\.chart-series-${index} \\{ stroke: var\\(--series-${index}\\); fill: var\\(--series-${index}\\); \\}`,
      );
      expect(css, `.chart-series-${index}`).toMatch(rule);
      const swatch = new RegExp(
        `\\.chart-swatch\\.chart-series-${index} \\{ background: var\\(--series-${index}\\); \\}`,
      );
      expect(css, `.chart-swatch.chart-series-${index}`).toMatch(swatch);
    }
  });
});

describe("the browser chrome", () => {
  const html = readFileSync(path.join(import.meta.dirname, "..", "index.html"), "utf8");

  it("declares one theme-color per theme, each matching that theme's ground", () => {
    // Was a whole-file substring match, which with two palettes passes when the
    // color turns up in the wrong block.
    const metas = [...html.matchAll(/<meta\s+name="theme-color"[\s\S]*?\/>/g)].map(
      (match) => match[0],
    );
    expect(metas.length, "one meta per theme").toBe(2);
    const grounds = { light: light["--ground"], dark: mediaDark["--ground"] };
    for (const meta of metas) {
      const which = /data-theme-for="(light|dark)"/.exec(meta)?.[1] as "light" | "dark" | undefined;
      expect(which, `theme-color says which theme it is for: ${meta}`).toBeDefined();
      const content = /content="(#[0-9a-fA-F]{6})"/.exec(meta)?.[1];
      expect(content?.toLowerCase()).toBe(grounds[which!]?.toLowerCase());
      expect(meta).toContain(`(prefers-color-scheme: ${which})`);
    }
  });

  it("loads the boot script in a way that runs before the page paints", () => {
    const tag = /<script src="\/theme-boot\.js"([^>]*)>/.exec(html);
    expect(tag, "index.html loads /theme-boot.js").not.toBeNull();
    // A module is deferred by definition, and defer or async would both let the
    // document paint first, which is the whole thing this is here to prevent.
    expect(tag![1]).not.toMatch(/type=|defer|async/);
    // Located by the tag, not by the filename: the comment above the metas names
    // the script too, and matching that made this assert about prose.
    const tagAt = html.indexOf('<script src="/theme-boot.js"');
    expect(tagAt).toBeGreaterThan(-1);
    expect(tagAt).toBeLessThan(html.indexOf("</head>"));
    // It adjusts the metas, so they have to exist by the time it runs.
    expect(html.indexOf('name="theme-color"')).toBeLessThan(tagAt);
  });

  // That every root-served file the document asks for is actually in public/ is
  // checked in tests/api-security.test.ts, alongside the rest of what the
  // client bundle serves.
});

/**
 * A second channel that is not color, per `web.md` 11.3.
 *
 * Ten categorical colors cannot all be told apart under dichromatic vision and
 * no choice of ten fixes that: the palette this product ships is the best
 * available set and still reaches only 5.6 in light. A dash pattern is
 * orthogonal to hue, so two series that look alike to one reader are still two
 * different lines.
 *
 * The legend half is the part that was backwards. The swatch is `aria-hidden`,
 * so a screen reader gets the label and a color-blind sighted reader gets only
 * a block of color to match against a line — a swatch carrying the line's
 * rhythm can be matched by shape.
 */
describe("a chart series and its second channel", () => {
  it("gives every line but the first its own dash rhythm", () => {
    const patterns = new Map<string, string>();
    for (const match of css.matchAll(
      /\.chart-line\.chart-series-(\d+)\s*\{\s*stroke-dasharray:\s*([^;]+);/g,
    )) {
      patterns.set(match[1]!, match[2]!.trim());
    }
    // Nine, because series 0 is solid: it is what a single-series chart gets
    // and what a plain line should look like.
    expect([...patterns.keys()].sort()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(css).not.toMatch(/\.chart-line\.chart-series-0\s*\{\s*stroke-dasharray/);
    // And no two share a rhythm, which would put two series back on color
    // alone for the reader this exists for.
    expect(new Set(patterns.values()).size).toBe(patterns.size);
  });

  it("shows the same rhythm in the legend", () => {
    // The swatch is a `<span>` with no stroke to dash, so the pattern is a
    // repeating gradient. What matters is that a swatch exists for every dashed
    // series: one that stayed a solid block could not be matched to its line.
    const dashed = [
      ...css.matchAll(/\.chart-line\.chart-series-(\d+)\s*\{\s*stroke-dasharray/g),
    ].map((match) => match[1]!);
    expect(dashed.length).toBeGreaterThan(8);
    for (const index of dashed) {
      const rule = new RegExp(
        `\\.chart-swatch\\.chart-series-${index}\\s*\\{[^}]*repeating-linear-gradient`,
      );
      expect(css, `series ${index}'s swatch should carry its pattern`).toMatch(rule);
    }
    // Series 0 stays a solid block, matching its solid line.
    expect(css).toMatch(/\.chart-swatch\.chart-series-0\s*\{\s*background:\s*var\(--series-0\);/);
  });
});
