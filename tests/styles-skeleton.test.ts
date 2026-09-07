import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The loading shimmer is an animation with no end, so anything sharing a rule
 * with it animates for as long as it is on screen. Only the placeholder may.
 *
 * A card with no background of its own is the other half: it shows whatever is
 * painted behind it, so an animation anywhere underneath reads as the card
 * itself moving.
 */
const CONTENT_CLASSES = [".panel", ".table-card", ".account-card", ".metric-card", ".empty-state"];

async function stylesheet() {
  return readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");
}

function rules(css: string) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1]!.trim(),
    body: match[2]!,
  }));
}

const selectorsOf = (selector: string) => selector.split(",").map((one) => one.trim());

/**
 * Every animation that never ends, against the preference that says stop.
 *
 * The blanket block at the foot of the stylesheet sets
 * `animation-iteration-count: 1 !important` on everything, which is right for
 * decoration and wrong for a busy indicator: it froze the button's spinner into
 * a static icon, so somebody who asked for reduced motion got a picture of
 * waiting that was not waiting. `.skeleton` had been exempted by hand and the
 * spinner had not, and nothing said which of the two was the oversight.
 */
describe("an animation with no end", () => {
  it("is answered by name under reduced motion", async () => {
    const css = await stylesheet();
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const infinite = rules(css)
      .filter((rule) => /animation:[^;]*\binfinite\b/.test(rule.body))
      .flatMap((rule) => selectorsOf(rule.selector));
    expect(infinite.length).toBeGreaterThan(0);
    for (const selector of infinite) {
      // Named somewhere inside a reduced-motion block, which is the only way a
      // blanket `!important` can be answered.
      expect(reduced, `${selector} animates forever and says nothing about it`).toContain(selector);
    }
  });
});

describe("the loading shimmer", () => {
  it("animates nothing but the placeholder", async () => {
    const animated = rules(await stylesheet()).filter((rule) =>
      /animation:\s*[^;]*skeleton-sweep/.test(rule.body),
    );
    expect(animated.length).toBeGreaterThan(0);
    for (const rule of animated) {
      expect(selectorsOf(rule.selector)).toEqual([".skeleton"]);
    }
  });

  it("leaves every card painting its own background", async () => {
    const parsed = rules(await stylesheet());
    for (const className of CONTENT_CLASSES) {
      const owns = parsed.filter((rule) => selectorsOf(rule.selector).includes(className));
      expect(owns.length, `${className} has no rule`).toBeGreaterThan(0);
      const backgrounds = owns.flatMap((rule) => [
        ...rule.body.matchAll(/(?:^|[;\s])background(?:-color|-image)?\s*:/g),
      ]);
      expect(backgrounds.length, `${className} declares no background`).toBeGreaterThan(0);
    }
  });
});
