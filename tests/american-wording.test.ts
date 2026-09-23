import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, sourceFiles } from "./support/source.js";

/**
 * The British words and idioms that survived the American spelling sweep, held
 * at zero so an edit cannot bring one back.
 *
 * `common.md` settles on American English for the whole repository, and the
 * sweep in `1d753f2` changed spellings by a frozen word map. A word map cannot
 * see an idiom, so "Tick the box" went on showing in the Budgets marketing
 * picture, "every fortnight" in the descriptions an agent reads, and "per cent"
 * in the errors the budget form shows. `tests/mcp-measurements.test.ts` holds
 * the spelling of the agent surface; this holds the words, across everything a
 * person or an agent reads out of this repository's source: `src` (the pages,
 * the published descriptions, the refusals, the mail, and the comments beside
 * them), `index.html`, and the product kit's seed, which is what every marketing
 * screenshot is a picture of.
 *
 * Only the ones that are safe to match mechanically are here: each pattern is a
 * phrase with no American reading, so a hit is always a defect rather than a
 * judgment. Plenty of the decided wording is not like that — "shop" is a verb
 * as often as a noun, "tick" is also what a scheduler does, and "a place" is the
 * product's word for an account slot — and those stay review. A test file is
 * out of scope by construction, because a test that asserts a phrase is absent
 * has to spell the phrase, and this file is the first of those.
 */
const LOSING: { pattern: RegExp; instead: string }[] = [
  { pattern: /\btick the box\b/i, instead: "check the box" },
  { pattern: /\btick-?box(es)?\b/i, instead: "checkbox" },
  { pattern: /\bfortnight/i, instead: "two weeks" },
  { pattern: /\bper[ -]cent\b/i, instead: "percent" },
  // Only at the end of a clause, which is the sense American English spells
  // as one word: "nothing matches it anymore". "Any more accounts" is a
  // quantity, the same in both, and is left alone.
  { pattern: /\bany more(?=\s*(?:[.,;:!?)"'`]|$))/im, instead: "anymore" },
  { pattern: /\bfor ever\b/i, instead: "forever" },
  { pattern: /\bstraight away\b/i, instead: "right away" },
  { pattern: /\bweekly shop\b/i, instead: "weekly groceries" },
  { pattern: /\bin one go\b/i, instead: "at once" },
  { pattern: /\bone-off\b/i, instead: "one-time" },
  { pattern: /\bnought\b/i, instead: "zero" },
  { pattern: /\bcommonest\b/i, instead: "most common" },
  { pattern: /\bpart way\b/i, instead: "partway" },
  { pattern: /\bupper case\b/i, instead: "uppercase" },
  { pattern: /\bmonday to friday\b/i, instead: "Monday through Friday" },
  { pattern: /\bbehaviour/i, instead: "behavior" },
  { pattern: /\bageing\b/i, instead: "aging" },
  { pattern: /\btotall(ed|ing)\b/i, instead: "totaled, totaling" },
  { pattern: /\bartefact/i, instead: "artifact" },
  { pattern: /\bafterwards\b/i, instead: "afterward" },
];

type Scanned = { path: string; text: string };

function read(relative: string): Scanned {
  return { path: relative, text: readFileSync(path.join(repoRoot, relative), "utf8") };
}

/**
 * Everything in scope, with the whole text rather than its literals: the
 * decided wording applies to comments too, and a comment that quotes a string
 * is how the old string gets copied back.
 */
const SCANNED: Scanned[] = [
  ...sourceFiles("src"),
  read("src/client/styles.css"),
  read("index.html"),
  read("scripts/product-kit/seed.json"),
  read("scripts/product-kit/build.mjs"),
  read("scripts/product-kit/entry-key.mjs"),
];

function hits(files: Scanned[]) {
  const found: string[] = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      for (const { pattern, instead } of LOSING) {
        const match = pattern.exec(line);
        if (match) found.push(`${file.path}:${index + 1}: "${match[0]}" — write "${instead}"`);
      }
    });
  }
  return found;
}

describe("American wording", () => {
  it("reads the source it claims to", () => {
    // Not passing because it read nothing: the pages, the services and the
    // descriptions are all in the set.
    const paths = SCANNED.map((file) => file.path);
    expect(paths.length).toBeGreaterThan(100);
    for (const expected of [
      "src/client/pages/BudgetsPage.tsx",
      "src/server/mcp.ts",
      "src/shared/domain.ts",
      "src/server/mail.ts",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("uses none of the British phrases the sweep missed", () => {
    expect(hits(SCANNED)).toEqual([]);
  });

  it("finds each phrase where one is written", () => {
    // The patterns themselves, against the sentences that shipped. A pattern
    // that stopped matching its own example would pass the test above over
    // any amount of British English.
    const shipped = [
      "Some selected rows look like duplicates. Tick the box to commit them anyway.",
      "so 2 on a weekly schedule is every fortnight.",
      "A share of income is between 0 and 1000 per cent.",
      "it is null when nothing matches it any more.",
      "once a month, for ever.",
      "fixes it straight away.",
      'placeholder="Weekly shop"',
      "This was a one-off reminder, so there will not be another.",
      "a bulk write is all-or-nothing and there is no per-row report afterwards.",
    ];
    const found = hits([{ path: "shipped", text: shipped.join("\n") }]);
    expect(found).toHaveLength(shipped.length);
    // And the quantity sense of "any more" is not a defect.
    expect(
      hits([{ path: "fine", text: "You cannot open any more accounts on this plan." }]),
    ).toEqual([]);
  });

  it("declares the variety the app is written in", () => {
    // A document that says only "en" lets a browser pick a British dictionary
    // or voice for text written American, and the marketing site already
    // says en-US.
    expect(read("index.html").text).toMatch(/<html lang="en-US">/);
  });
});
