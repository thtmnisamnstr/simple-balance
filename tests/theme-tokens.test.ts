import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERIES_COLOURS } from "../src/client/charts.js";
import { blocks, stylesheet, tokensIn, type Block } from "./support/css.js";

/**
 * The stylesheet holds two palettes now, and the ways that goes wrong are all
 * mechanical, so they are all checked here.
 *
 * The one that matters most: a token declared in one theme and not the other.
 * Nothing about that fails to compile, nothing looks wrong in the theme somebody
 * happened to be in, and the other theme paints one colour from the wrong set —
 * white text on white, or a border that vanishes. It is invisible in review and
 * obvious to whoever is using it.
 */
const css = stylesheet();

const LIGHT = (block: Block) =>
  block.context.length === 0 && block.selector === ":root";
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

describe("colours in the stylesheet", () => {
  const TOKEN_BLOCK = (block: Block) =>
    LIGHT(block) || MEDIA_DARK(block) || ATTRIBUTE_DARK(block);

  it("are written in the token blocks and nowhere else", () => {
    // A colour written inline has one theme by construction. This is the rule
    // that stops the second palette rotting the next time somebody adds a rule.
    const strays: string[] = [];
    for (const block of blocks(css)) {
      if (TOKEN_BLOCK(block)) continue;
      for (const found of block.body.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
        // A mask's colour keyword is an alpha channel, not a colour.
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
    expect(Object.keys(light).filter((token) => !used.has(token)).sort()).toEqual([]);
  });
});

describe("what each token is for", () => {
  // A colour that reads as text in one theme can be a fill in the other only if
  // the two roles are two tokens. They were one token, and in dark that put
  // white text on a bright mint button at 1.9:1.
  const TEXT = new Set([
    "--ink", "--ink-soft", "--muted", "--green", "--green-dark", "--red",
    "--amber", "--blue",
  ]);
  const FILL = new Set([
    "--ground", "--surface", "--surface-soft", "--fill-subtle", "--track",
    "--green-fill", "--green-fill-hover", "--red-fill", "--green-soft",
    "--green-wash", "--red-soft", "--amber-soft", "--blue-soft", "--fill-deep",
  ]);

  it("never paints an area with a text colour, or writes text in a surface colour", () => {
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

describe("the chart palette", () => {
  it("has a colour for every series the code will ask for, in both themes", () => {
    for (const [name, tokens] of [
      ["light", light],
      ["dark", mediaDark],
    ] as const) {
      const series = Object.keys(tokens).filter((token) => /^--series-\d+$/.test(token));
      expect(series.length, `${name} series count`).toBe(SERIES_COLOURS);
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
      expect(new Set(values).size, `${name} has a repeated series colour`).toBe(
        values.length,
      );
    }
  });

  it("draws every series from a token rather than a colour of its own", () => {
    for (let index = 0; index < SERIES_COLOURS; index++) {
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
    // colour turns up in the wrong block.
    const metas = [...html.matchAll(/<meta\s+name="theme-color"[\s\S]*?\/>/g)].map(
      (match) => match[0],
    );
    expect(metas.length, "one meta per theme").toBe(2);
    const grounds = { light: light["--ground"], dark: mediaDark["--ground"] };
    for (const meta of metas) {
      const which = /data-theme-for="(light|dark)"/.exec(meta)?.[1] as
        | "light"
        | "dark"
        | undefined;
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
