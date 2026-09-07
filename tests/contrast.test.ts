import { describe, expect, it } from "vitest";
import { blocks, stylesheet, tokensIn, type Block } from "./support/css.js";

/**
 * Contrast, computed from the token values rather than quoted from a table.
 *
 * `web.md` sections 2.1, 2.2 and 11.1 publish twenty ratios, and every one of
 * them was worked out by hand and typed in. Two things follow. A pair somebody
 * adds is not in the table, so nothing looks at it. And a token whose value
 * moves silently invalidates every row that mentions it — the table records
 * what the palette was on the day somebody measured it.
 *
 * So this derives the pairs instead of listing them: every rule that sets both
 * a colour and a background gets checked, in both themes. That is the version
 * worth having. The guide proposed an enumerated list of sanctioned pairs, and
 * all twenty of those reproduce exactly — an enumerated check would have caught
 * nothing, and the one real failure it found (`::selection` at 2.59:1 in dark)
 * was a pair nobody had thought to enumerate.
 *
 * WCAG 2.2 SC 1.4.3 for text, SC 1.4.11 for the rest, and the 2.x ratio rather
 * than APCA — section 2 of the guide says why.
 */

const css = stylesheet();

/** The relative luminance of an `#rrggbb`, per WCAG 2.x. */
function luminance(hex: string) {
  const channel = (pair: string) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const body = hex.replace("#", "");
  return (
    0.2126 * channel(body.slice(0, 2)) +
    0.7152 * channel(body.slice(2, 4)) +
    0.0722 * channel(body.slice(4, 6))
  );
}

const ratio = (left: string, right: string) => {
  const [high, low] = [luminance(left), luminance(right)].sort((a, b) => b - a) as [number, number];
  return (high + 0.05) / (low + 0.05);
};

/**
 * The two palettes, read from the blocks that declare them.
 *
 * The light one is bare `:root`; the dark one is `:root` under the
 * `prefers-color-scheme` media query. The attribute block says the same thing
 * as the media block — `tests/theme-tokens.test.ts` holds that — so checking
 * one of the two is checking both.
 */
const light = tokensIn(css, (block) => block.context.length === 0 && block.selector === ":root");
const dark = tokensIn(css, (block) =>
  block.context.some((at) => at.includes("prefers-color-scheme: dark")),
);

/** A `var(--name)` reference resolved in one palette, or null for anything else. */
function resolve(value: string, palette: Record<string, string>): string | null {
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim());
  if (!reference) return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim() : null;
  const resolved = palette[reference[1]!];
  return resolved && /^#[0-9a-f]{6}$/i.test(resolved) ? resolved : null;
}

const declaration = (block: Block, property: RegExp) => {
  const found = [...block.body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;]+)/g)].filter((one) =>
    property.test(one[1]!),
  );
  return found.at(-1)?.[2]?.trim() ?? null;
};

/**
 * Text is 4.5:1; everything else is 3:1.
 *
 * A rule painting an icon or a bar is not text even when it sets `color`, so
 * the threshold follows the font size where the rule declares one, and
 * otherwise assumes text — the stricter of the two, which is the right default
 * for a check that is deciding on incomplete information.
 */
const LARGE_TEXT_PX = 24;

/**
 * Pairs that are correct and that a two-colour reading cannot see.
 *
 * Named individually with the reason, because a blanket skip is how a check
 * like this stops meaning anything.
 */
const COMPOSITED = new Set([
  // `--art-veil` is a translucent wash over `.auth-art`'s gradient, not over
  // `--ground`. Reading it against the token underneath computes 1.00:1 and
  // says nothing about what a person sees.
  ".auth-ledger-card",
]);

describe("contrast, from the tokens", () => {
  it("reads both palettes", () => {
    // If either map came back empty every assertion below would pass by
    // examining nothing, which is the failure mode this whole file is about.
    expect(Object.keys(light).length).toBeGreaterThan(50);
    expect(Object.keys(dark).length).toBeGreaterThan(50);
  });

  it("gives every rule that paints text on a fill enough contrast, in both themes", () => {
    const failures: string[] = [];
    for (const [name, palette] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const block of blocks(css)) {
        if (block.selector.startsWith("@") || block.selector.startsWith(":root")) continue;
        if (COMPOSITED.has(block.selector.trim())) continue;
        const colour = declaration(block, /^color$/);
        const fill = declaration(block, /^background(-color)?$/);
        if (!colour || !fill) continue;
        const foreground = resolve(colour, palette);
        // A gradient, a keyword or a colour-mix resolves to nothing, and a pair
        // this cannot read is a pair it must not judge.
        const background = resolve(fill, palette);
        if (!foreground || !background) continue;
        const size = declaration(block, /^font-size$/);
        const pixels = size ? Number.parseFloat(size) : 13;
        const weight = Number.parseInt(declaration(block, /^font-weight$/) ?? "400", 10);
        const large = pixels >= LARGE_TEXT_PX || (pixels >= 18.66 && weight >= 700);
        const required = large ? 3 : 4.5;
        const measured = ratio(foreground, background);
        if (measured + 0.005 < required) {
          failures.push(
            `${name}: ${block.selector} is ${measured.toFixed(2)}:1, needs ${required}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * The pairs the guide publishes, checked against the palette rather than
   * against the last person to recompute them.
   *
   * Every one of these appears in a table in `web.md`. If a token moves, this
   * says so and names the row to update.
   */
  it("keeps the published non-text pairs above 3:1", () => {
    const pairs: [string, string][] = [
      ["--line-strong", "--surface"],
      ["--line-strong", "--ground"],
      ["--focus-ring", "--surface"],
      ["--focus-ring", "--ground"],
      ["--green-line-strong", "--surface-soft"],
      ["--green-fill", "--track"],
    ];
    const failures: string[] = [];
    for (const [name, palette] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [front, back] of pairs) {
        const measured = ratio(palette[front]!, palette[back]!);
        if (measured < 3) failures.push(`${name}: ${front} on ${back} is ${measured.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });
});
