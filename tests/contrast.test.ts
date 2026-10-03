import { readFileSync } from "node:fs";
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
 * a color and a background gets checked, in both themes. That is the version
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
 * Pairs that are correct and that a two-color reading cannot see.
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
        const color = declaration(block, /^color$/);
        const fill = declaration(block, /^background(-color)?$/);
        if (!color || !fill) continue;
        const foreground = resolve(color, palette);
        // A gradient, a keyword or a color-mix resolves to nothing, and a pair
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

  /**
   * The focus ring's two figures, which `web.md` 13.1 prints as facts.
   *
   * 13.1 is Binding on SC 1.4.11 and says of itself "*Not checked
   * mechanically.* The two ratios above are hand-computed, and the contrast
   * test in 17.2 item 1 is what would hold them." Both halves of that were
   * already stale: this file exists and has been deriving
   * `ratio(--focus-ring, --surface)` in both themes in the check above since it
   * was written, and 17.2 item 1 is the spacing and radius scales rather than
   * contrast, so the pointer went to the wrong item.
   *
   * What was genuinely unheld is the precision. The check above asks only that
   * the pair clears 3:1, and at 5.08 and 9.70 a token could move a long way —
   * light could fall to 3.01 — while that stayed green and 13.1 went on
   * printing numbers nobody had recomputed. The obligation is met either way;
   * it is the published sentence that could drift, and a guide whose figures
   * are wrong is the thing this repository has been bitten by repeatedly.
   *
   * So the figures are read out of the sentence that claims them rather than
   * copied here. A token that moves fails this and names the row to update, and
   * so does an edit to the sentence that the palette does not support — which
   * is the direction a second copy in a test file could never catch.
   */
  it("measures the focus ring at the two ratios 13.1 publishes", () => {
    // Whitespace collapsed first: the sentence is wrapped across two lines in
    // the guide, and a pattern that assumed single spaces would report the
    // ratios missing rather than wrong — a check that fails for the wrong
    // reason teaches the next reader to loosen it.
    const guide = readFileSync("docs/standards/web.md", "utf8").replaceAll(/\s+/g, " ");
    const claim =
      /`--focus-ring` measures ([\d.]+):1 light and ([\d.]+):1 dark against `--surface`/.exec(
        guide,
      );
    expect(claim, "web.md 13.1 no longer states the two focus-ring ratios").not.toBeNull();

    expect(ratio(light["--focus-ring"]!, light["--surface"]!).toFixed(2)).toBe(claim![1]);
    expect(ratio(dark["--focus-ring"]!, dark["--surface"]!).toFixed(2)).toBe(claim![2]);
  });
});
