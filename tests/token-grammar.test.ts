import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stylesheet, tokensIn, type Block } from "./support/css.js";
import {
  fillTokens,
  parseToken,
  textTokens,
  tokenKind,
  TOKEN_MODIFIERS,
  TOKEN_ROLES,
} from "./support/token-grammar.js";

/**
 * Every token name matches the grammar, and the grammar says what it is for.
 *
 * `web.md` 17.2 item 2, which 1.4 states twice: "The grammar is regex-shaped
 * and a test could derive the `TEXT` and `FILL` sets that
 * `tests/theme-tokens.test.ts:118-145` maintains by hand."
 *
 * Both halves matter and they fail differently. A name outside the grammar is a
 * token nobody can place — 1.4's first consequence is "do not reach for a token
 * because its color happens to match", and a name that cannot be read is an
 * invitation to do exactly that. A set maintained by hand is the second: 1.4
 * exempts six tokens by name from being readable, and records that one of the
 * six "had been silently missing from that list, which is the exact failure a
 * by-name exemption exists to prevent". A hand list in a test rots the same way
 * and nothing would say so.
 *
 * The two closed lists are read out of `web.md` rather than written down here,
 * so the guide is the one place a role is added and this fails until it is.
 */

/**
 * The six `web.md` 1.4 exempts by name, kept as a register.
 *
 * Two of them really are outside the grammar: `--art-glow-a` and
 * `--art-glow-b` carry a property *and* a letter telling the two apart, which
 * is two segments where the grammar allows one. The other four parse, and are
 * exempted for the other half of the same sentence — their role names a thing
 * in the product rather than a kind of color, so the name does not say whether
 * it paints words or an area.
 *
 * Kept by name rather than widened into a rule, because 1.4 makes that
 * argument itself: `--art-glow-b` "had been silently missing from that list,
 * which is the exact failure a by-name exemption exists to prevent". A
 * seventh is a sentence somebody edits in the guide, which the last assertion
 * below is what forces.
 */
const UNREADABLE_BY_NAME = [
  // A translucent page-chrome fill. The role names where it is used.
  "--ambient",
  // Two stops of the marketing gradient, told apart by a trailing letter.
  "--art-glow-a",
  "--art-glow-b",
  // A white overlay over the art surface.
  "--art-veil",
  // The header's backdrop, which is a fill with its own name.
  "--chrome",
  // The dimming behind a modal.
  "--scrim",
];

const css = stylesheet();
const LIGHT = (block: Block) => block.context.length === 0 && block.selector === ":root";
const declared = Object.keys(tokensIn(css, LIGHT));

describe("the lists the grammar is written against", () => {
  /**
   * Read, not copied — so this has to prove it read something. A sentence
   * reworded in the guide leaves the regex matching nothing, and an empty role
   * list would make every token below unparseable rather than silently fine,
   * but an empty *modifier* list would quietly turn modifiers into properties
   * and change what every chromatic token is classified as.
   */
  it("comes out of web.md 1.4", () => {
    expect(TOKEN_ROLES).toContain("ground");
    expect(TOKEN_ROLES).toContain("series-N");
    expect(TOKEN_ROLES).toContain("on-*");
    expect(TOKEN_ROLES.length).toBeGreaterThanOrEqual(20);
    expect(TOKEN_MODIFIERS).toContain("soft");
    expect(TOKEN_MODIFIERS).toContain("disabled");
    expect(TOKEN_MODIFIERS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("every declared token", () => {
  it("is found, so the verdicts below are about something", () => {
    expect(declared.length).toBeGreaterThanOrEqual(55);
  });

  it("opens with a role from the closed list and splits the rest", () => {
    const unparseable = declared
      .filter((token) => !UNREADABLE_BY_NAME.includes(token))
      .map(parseToken)
      .filter((parsed) => typeof parsed === "string");
    expect(
      unparseable,
      "web.md 1.4 names the closed list. A new role is an edit to that paragraph.",
    ).toEqual([]);
  });

  it("carries at most one property segment", () => {
    // The constraint that actually bites, and the one `--art-glow-a` fails:
    // two segments after the role, neither a modifier, so the name has a
    // property *and* a disambiguator and cannot be read. 1.4 exempts it by
    // name, and `parseToken` reports it rather than inventing a reading.
    const parsed = parseToken("--art-glow-a");
    expect(typeof parsed).toBe("string");
    expect(parsed).toContain("more than one property segment");
  });
});

describe("what the grammar says a token is for", () => {
  const text = textTokens(declared);
  const fill = fillTokens(declared);

  /**
   * The derivation reproduces the distinctions the hand list was keeping.
   * Spot-checked by the cases that discriminate rather than by listing both
   * sets again, which would be the hand list back with an extra step: the role
   * deciding, the hue deciding on its own segment, and a `line` beating both.
   */
  it("reads words, areas and edges apart", () => {
    expect(tokenKind("--ink")).toBe("text");
    expect(tokenKind("--ink-soft")).toBe("text");
    expect(tokenKind("--muted")).toBe("text");
    // A hue at text contrast, and the same hue as an area.
    expect(tokenKind("--green")).toBe("text");
    expect(tokenKind("--green-dark")).toBe("text");
    expect(tokenKind("--green-fill")).toBe("fill");
    expect(tokenKind("--green-fill-hover")).toBe("fill");
    expect(tokenKind("--green-soft")).toBe("fill");
    expect(tokenKind("--amber-soft")).toBe("fill");
    expect(tokenKind("--ground")).toBe("fill");
    expect(tokenKind("--field")).toBe("fill");
    expect(tokenKind("--field-disabled")).toBe("fill");
    expect(tokenKind("--fill-deep")).toBe("fill");
    // An edge is neither, whichever role it is on.
    expect(tokenKind("--line-strong")).toBe("neither");
    expect(tokenKind("--field-line")).toBe("neither");
    expect(tokenKind("--green-line-strong")).toBe("neither");
    // And a role that names a thing rather than a kind of color says nothing.
    expect(tokenKind("--shadow-pop")).toBe("neither");
    expect(tokenKind("--focus-ring")).toBe("neither");
    expect(tokenKind("--series-3")).toBe("neither");
    expect(tokenKind("--on-art-muted")).toBe("neither");
  });

  it("covers the palette rather than a corner of it", () => {
    expect(text.size).toBeGreaterThanOrEqual(8);
    expect(fill.size).toBeGreaterThanOrEqual(16);
  });

  it("exempts the six 1.4 exempts, and they are all still declared", () => {
    for (const token of UNREADABLE_BY_NAME) {
      expect(declared, `${token} is in 1.4's exemption list and not in the stylesheet`).toContain(
        token,
      );
      expect(tokenKind(token) === "neither" || typeof tokenKind(token) === "string").toBe(true);
    }
    // And the guide still names each of them, so the register and the paragraph
    // cannot drift apart in either direction. This is the half that would have
    // caught `--art-glow-b`.
    const guide = readFileSync("docs/standards/web.md", "utf8");
    const paragraph = /Second, (`--[\s\S]*?) carry no property segment/.exec(guide);
    expect(paragraph, "web.md 1.4 no longer lists its by-name exemptions").not.toBeNull();
    const named = [...paragraph![1]!.matchAll(/`(--[a-z0-9-]+)`/g)].map((match) => match[1]!);
    expect(named.sort()).toEqual([...UNREADABLE_BY_NAME].sort());
  });
});
