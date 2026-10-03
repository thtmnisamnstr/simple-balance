import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoFiles, repoRoot, sourceFiles } from "./support/source.js";

/**
 * The claims `docs/standards/writing.md` makes that the tree can answer.
 *
 * That guide owns the document: what each one is for, who reads it, and when it
 * has to change. It is also the guide with the most measured numbers in it, and
 * a pass over it found thirty things that had stopped being true — eighteen of
 * them counts that were right when they were written, wrong by the time anybody
 * looked, and failing nothing in between. The document table claimed to be the
 * whole corpus while missing nine documents, the product kit, a fourth
 * deployment recipe and a harness README; the skills row said five where the
 * directory holds six and `tests/skills.test.ts` already asserted six, citing
 * that guide as its authority; a screenshot rule said "exactly one" against
 * twenty-seven.
 *
 * So the rule that guide now states about everybody else's numbers applies to
 * its own: a number recoverable from the tree gets a test, in the same change
 * that writes it. This is that test.
 *
 * What is deliberately **not** here is the other half of the same rule. Commit
 * statistics, corpus-wide counts of a punctuation mark and the length of the
 * changelog move under every commit, and a check the change under test has to
 * update is a check that gets updated without being read — the reason
 * `tests/testing-guide-counts.test.ts` leaves its test counts alone and
 * `tests/comment-density.test.ts` holds a band rather than an equality. Those
 * numbers carry the date they were taken instead.
 */
const GUIDE = "docs/standards/writing.md";
const guide = readFileSync(path.join(repoRoot, GUIDE), "utf8");

/** The guide with its hard wrapping flattened, for a sentence that spans lines. */
const flat = guide.replaceAll(/\s+/g, " ");

/**
 * Directories `.gitignore` drops, read out of it rather than listed here.
 *
 * The corpus is what is tracked. `outputs/` is where the build loop writes its
 * research passes and `.ralph/` is its state, and a document in either is a
 * working note rather than something anybody has to keep true — but both are
 * `.md` under the repository root, so a sweep that did not know about them
 * would fail this suite on somebody's local scratch.
 */
const IGNORED = new Set(
  readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_.][\w.-]*\/$/.test(line))
    .map((line) => line.slice(0, -1)),
);

const isIgnored = (file: string) => file.split("/").some((part) => IGNORED.has(part));

/** The rows of the first table under a heading, header and rule dropped. */
const tableUnder = (heading: string): string[] => {
  const at = guide.indexOf(`\n${heading}\n`);
  expect(at, `${GUIDE} has a heading reading exactly "${heading}"`).toBeGreaterThan(-1);
  const after = guide.slice(at + heading.length + 2).split("\n");
  const first = after.findIndex((line) => line.startsWith("|"));
  expect(first, `${heading} has a table under it`).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of after.slice(first)) {
    if (!line.startsWith("|")) break;
    rows.push(line);
  }
  return rows.filter((line) => !/^\|\s*-+/.test(line)).slice(1);
};

describe("the document table in writing.md", () => {
  /**
   * Every document in the corpus, discovered rather than listed.
   *
   * Listing them is the defect: the table was a list, it was right when it was
   * written, and the corpus roughly doubled underneath it without a single
   * failure. `support/source.ts` makes the same argument at length about three
   * other checks in this repository that enumerated their own populations.
   *
   * `docs/product/` is the one entry that is not a `.md` file. Its reader is
   * the marketing site, which is a program, and the table had no row whose
   * reader was a machine — which is most of the reason it had no row for the
   * kit either.
   */
  const corpus = [
    ...repoFiles((file) => file.endsWith(".md") && !isIgnored(file)).map((file) => file.path),
    "docs/product/facts.json",
  ];

  /** Every backtick-quoted token in the first cell of each row. */
  const named = tableUnder("## What each document is for").flatMap((row) =>
    [...(row.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1]!),
  );

  it("finds a corpus to check against", () => {
    // A glob that stopped matching would leave every assertion below passing
    // over nothing, which is how the first spelling of the compose-recipe check
    // in `tests/env-example.test.ts` spent a release checking neither recipe.
    expect(corpus.length).toBeGreaterThan(40);
    expect(named.length).toBeGreaterThan(20);
  });

  it("names every document in the corpus", () => {
    const covers = (token: string, file: string) => {
      if (token === file) return true;
      // A directory row, which covers everything under it: `docs/standards/`
      // is seventeen files and `docs/product/` is three plus the screenshots.
      if (token.endsWith("/")) return file.startsWith(token);
      // `.claude/skills/*/SKILL.md`, the one glob in the table.
      if (token.includes("*")) {
        return new RegExp(`^${token.replaceAll(".", "\\.").replaceAll("*", "[^/]+")}$`).test(file);
      }
      // A bare basename, which the ralph row uses after naming the directory in
      // its first token. Over-generous by construction and worth it: the
      // alternative is this test knowing which row a token came from.
      return !token.includes("/") && file.endsWith(`/${token}`);
    };

    const unnamed = corpus.filter((file) => !named.some((token) => covers(token, file)));
    expect(unnamed, `give each of these a reader and a mode in ${GUIDE}, or delete it`).toEqual([]);
  });

  it("names nothing that has gone", () => {
    const paths = new Set(corpus);
    const gone = named.filter((token) => {
      if (token.includes("*") || token.endsWith("/")) return false;
      if (paths.has(token)) return false;
      if (token.includes("/")) return true;
      // A bare basename in a row that named its directory in an earlier token.
      return ![...paths].some((file) => file.endsWith(`/${token}`));
    });
    expect(gone, `a row in ${GUIDE} names a document that is not there`).toEqual([]);
  });
});

/**
 * The counts the guide states about the things it governs.
 *
 * Each of these was wrong at once, and each was wrong in the direction that
 * reads as settled: a smaller number, stated confidently, in a sentence that
 * had been true.
 */
describe("what writing.md says there are", () => {
  it("counts the skills the way the directory does", () => {
    const skills = repoFiles((file) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file));
    const words: Record<number, string> = { 5: "five", 6: "six", 7: "seven", 8: "eight" };
    const word = words[skills.length] ?? String(skills.length);
    // Two sentences, because both said five while `tests/skills.test.ts`
    // asserted six and named this guide as its authority for the number. A
    // citation only one side reads is a citation that proves nothing.
    expect(flat, `there are ${skills.length} skills`).toContain(`one of ${word} tasks that repeat`);
    expect(flat, `there are ${skills.length} skills`).toContain(`promises are the same ${word}`);
  });

  it("counts the guides in this set", () => {
    const files = repoFiles((file) => /^docs\/standards\/.*\.md$/.test(file)).map(
      (file) => file.path,
    );
    const indexes = files.filter((file) => file.endsWith("/index.md"));
    const guides = files.length - indexes.length;
    const ordinals: Record<number, string> = { 10: "tenth", 15: "fifteenth", 16: "sixteenth" };
    const words: Record<number, string> = { 2: "two", 15: "fifteen", 16: "sixteen" };
    // The argument for the skills not being a guide rests on how many guides
    // there are, so it has to move when one is added. It said "a tenth guide"
    // while the set stood at fifteen.
    expect(guide, `${guides} guides, so a new one would be the ${guides + 1}th`).toContain(
      `not a ${ordinals[guides + 1] ?? `${guides + 1}th`} guide`,
    );
    expect(flat, `${guides} guides and ${indexes.length} indexes`).toContain(
      `${words[guides] ?? String(guides)} guides and ${words[indexes.length] ?? String(indexes.length)} indexes`,
    );
  });

  it("counts the pictures, which are two populations with opposite cadences", () => {
    const shots = repoFiles((file) => /^docs\/product\/screenshots\/.*\.webp$/.test(file));
    const words: Record<number, string> = {
      24: "twenty-four",
      26: "twenty-six",
      28: "twenty-eight",
      30: "thirty",
    };
    // The rule said "exactly one screenshot" while the kit shipped every screen
    // in both themes. One is still right about `docs/images/dashboard.png`,
    // which is why the sentence had to split rather than have its number fixed.
    expect(flat, `the kit ships ${shots.length} screenshots`).toContain(
      `The other ${words[shots.length] ?? String(shots.length)} are \`docs/product/screenshots/\``,
    );
  });

  it("counts the test files it says hold it", () => {
    const at = guide.indexOf("\n## What is checked, and what is not\n");
    expect(at, "writing.md has a roll-up section").toBeGreaterThan(-1);
    const named = new Set(
      [...guide.slice(at).matchAll(/^- `(tests\/[\w.-]+)` — /gm)].map((match) => match[1]!),
    );
    const words: Record<number, string> = {
      10: "ten",
      11: "eleven",
      12: "twelve",
      13: "thirteen",
      14: "fourteen",
    };
    // The roll-up is the one place a reader goes to ask "is any of this
    // checked", so a test that exists and is missing from it reads as a test
    // nobody wrote. One was: the file holding every citation in this set,
    // including this guide's own.
    expect(flat, `the roll-up names ${named.size} files`).toContain(
      `except what ${words[named.size] ?? String(named.size)} test files cover`,
    );
    const missing = [...named].filter(
      (file) => !repoFiles((candidate) => candidate === file).length,
    );
    expect(missing, "the roll-up names a test file that is not there").toEqual([]);
  });

  it("counts the roadmap items that carry a state", () => {
    const roadmap = readFileSync(path.join(repoRoot, "docs/roadmap.md"), "utf8").split("\n");
    const headings = roadmap.filter((line) => line.startsWith("## SB-"));
    const done = headings.filter((line) => line.endsWith("**done**"));
    const words: Record<number, string> = {
      8: "Eight",
      9: "Nine",
      10: "Ten",
      11: "Eleven",
      14: "fourteen",
      15: "fifteen",
      16: "sixteen",
    };
    // The roadmap's own convention is that the heading answers "is there
    // anything left to write". This guide quotes the tally, and a tally in
    // prose is the thing that moves when an item is marked and nothing else
    // does.
    expect(flat, `${done.length} of ${headings.length} headings are marked`).toContain(
      `${words[done.length] ?? String(done.length)} of the ${words[headings.length] ?? String(headings.length)} headings carry the state today`,
    );
  });

  it("counts its own table of what is checked, twice over", () => {
    const rows = tableUnder("## Keeping a document true");
    const words: Record<number, string> = { 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
    const word = words[rows.length] ?? String(rows.length);
    // The same number is said twice in that section, which is how two of
    // `web.md`'s censuses came apart from each other. Both are held, so they
    // cannot drift to different answers.
    expect(flat, `that table has ${rows.length} rows`).toContain(`the ${word} rows above`);
    expect(flat, `that table has ${rows.length} rows`).toContain(
      `habit is why ${word} of these are checked`,
    );
  });
});

/**
 * The extremes of the comment-density range, which is the guide's only
 * illustration of what an uncommented file legitimately looks like.
 *
 * `tests/comment-density.test.ts` holds the aggregate; this holds the two files
 * named as its ends. They came apart in the direction that matters: the floor
 * named `src/client/router.tsx` at "under 1 per cent" when it measures
 * nineteen, so a reader calibrating against it would have read a normally
 * commented file as the bottom of the range.
 *
 * Forty non-blank lines, because the density of a ten-line module is noise and
 * the sentence is about files somebody reads.
 */
describe("the density range writing.md names", () => {
  const FLOOR = 40;

  const measured = sourceFiles("src")
    .map((file) => {
      const written = file.text.split("\n");
      const blanked = file.code.split("\n");
      let comments = 0;
      let lines = 0;
      for (const [index, line] of written.entries()) {
        if (line.trim() === "") continue;
        lines += 1;
        if (blanked[index]?.trim() === "") comments += 1;
      }
      return { path: file.path, lines, percent: (comments / lines) * 100 };
    })
    .filter((file) => file.lines >= FLOOR)
    .sort((left, right) => right.percent - left.percent);

  it("names the file at the top of it", () => {
    expect(guide, `the densest file of ${FLOOR}+ lines is ${measured.at(0)!.path}`).toContain(
      `\`${measured.at(0)!.path}\``,
    );
  });

  it("names the file at the bottom of it", () => {
    const last = measured.at(-1)!;
    expect(guide, `the least commented file of ${FLOOR}+ lines is ${last.path}`).toContain(
      `\`${last.path}\``,
    );
  });

  it("does not still claim the errors service carries no comments", () => {
    // The highest-consequence sentence in that guide, and it was false.
    // `AGENTS.md` tells an agent before its first edit not to tidy comments
    // away, and this said comments in that exact file would be a banned
    // restatement. The file is five docblocks now.
    const errors = measured.find((file) => file.path === "src/server/services/errors.ts");
    expect(errors, "src/server/services/errors.ts").toBeDefined();
    expect(errors!.percent).toBeGreaterThan(30);
    // The old claim is still quoted in the guide, as the record of the
    // correction, so this looks for the correction rather than for its absence.
    expect(flat).toContain("was the other example and is now the correction");
  });
});

/**
 * Every em dash in browser copy, held to the list the guide records.
 *
 * `common.md` bans them outright and this guide records the disagreement rather
 * than resolving it, which makes the list of exceptions the whole content of
 * the record. It named four sites and there are nine files, and one of the four
 * had drifted onto a row checkbox — a non-blank line of plausible code, so
 * every check in `tests/standards-citations.test.ts` passed on it.
 *
 * Copy, not comments: the blanked text from `support/source.ts` is what a
 * person could see. A lone `"—"` in an empty cell is a placeholder glyph rather
 * than punctuation and the guide says so, so it is dropped here too.
 */
describe("em dashes in browser copy", () => {
  const sites = sourceFiles("src/client").flatMap((file) =>
    file.code.split("\n").flatMap((line, index) => {
      if (!line.includes("—")) return [];
      if (!line.replaceAll(/["'`]—["'`]/g, "").includes("—")) return [];
      return [{ path: file.path, line: index + 1 }];
    }),
  );

  it("finds the copy it is checking", () => {
    expect(sites.length).toBeGreaterThan(5);
  });

  it("is the set writing.md records as the exception", () => {
    const files = [...new Set(sites.map((site) => site.path))].sort();
    const unrecorded = files.filter((file) => !guide.includes(`\`${file.split("/").pop()}`));
    expect(
      unrecorded,
      "a new em dash in browser copy: record it in writing.md or take it out",
    ).toEqual([]);
    const words: Record<number, string> = { 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
    expect(flat, `${files.length} files carry one`).toContain(
      `${words[files.length] ?? String(files.length)} files rather than the four sites`,
    );
  });
});

/**
 * Two budgets on `CHANGELOG.md`, for rules this guide states and nothing held.
 *
 * Both are ceilings rather than equalities. "Prose, not bullets" was quotable
 * as "zero list items in 3,508 lines" and that sentence is what made it
 * memorable; there are five now, all in one entry, each a decision with its own
 * counter-argument. A ceiling keeps that from becoming a habit without
 * forbidding the one shape a list earns.
 *
 * The line-length instruction is the clearer case for a budget. The guide said
 * "76 lines currently run past 80 and should come back"; nothing checked it,
 * the number went to 195, and the sentence went on sounding like a small
 * tidy-up. The number lives here, where it fails, rather than in prose, where
 * it rotted.
 */
describe("the changelog, against the two rules writing.md states about it", () => {
  const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8").split("\n");

  it("stays prose rather than bullets", () => {
    const listItems = changelog.filter((line) => /^ {0,3}[-*+] /.test(line));
    expect(
      listItems.length,
      "an entry runs at the length and in the voice of a commit body",
    ).toBeLessThanOrEqual(5);
  });

  it("does not let its long lines grow", () => {
    // Characters, not bytes. `awk` and `wc -c` count an em dash as three, and
    // this file is full of them: the two measures differ by eighty per cent
    // here, and a column on a screen is a character.
    expect(
      changelog.filter((line) => line.length > 80).length,
      "hard-wrap at 80, and bring the existing overruns back rather than adding to them",
    ).toBeLessThanOrEqual(108);
  });
});
