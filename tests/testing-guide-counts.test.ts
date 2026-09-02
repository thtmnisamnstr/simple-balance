import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./support/source.js";

/**
 * The file counts in `docs/standards/code/testing.md`, held against the files.
 *
 * That page opens with two tables of numbers, and they went stale within one
 * release of being written: the tier table said 48 node files when there were
 * 68, and the run table said the default gate covers 812 tests when it covers
 * 1,025. Nobody noticed, because a number in prose is checked by whoever
 * happens to recount it, which is nobody.
 *
 * So the counts that can be recovered from the filesystem are recovered here
 * and compared with what the page claims. The test counts beside them are
 * deliberately left alone — they move with every test anyone adds, including
 * this one, and a check that the change under test has to update teaches people
 * to update it without reading it. What is checked is the part that only moves
 * when a *file* is added, which is rare enough that being made to edit the page
 * is the point rather than the friction.
 */
const GUIDE = path.join(repoRoot, "docs/standards/code/testing.md");

/** Every test file under a repository-relative directory, non-recursive. */
const filesIn = (relative: string): string[] =>
  readdirSync(path.join(repoRoot, relative))
    .filter((name) => /\.(test|spec)\.tsx?$/.test(name))
    .sort();

/**
 * jsdom is chosen per file, so it has to be read out of the file.
 *
 * `vitest.config.ts` sets no global environment, and a `.test.ts` opts in with
 * the `@vitest-environment jsdom` pragma on its first lines. Two do. Counting
 * by extension alone would file both under node and leave the jsdom row two
 * short, which is exactly the kind of near-miss that makes a documented number
 * worse than none.
 */
const isJsdom = (relative: string, name: string): boolean => {
  if (name.endsWith(".tsx")) return true;
  const source = readFileSync(path.join(repoRoot, relative, name), "utf8");
  // The pragma only does anything on a line that opens a comment, which is also
  // what tells it apart from a file that merely mentions it. This one does, two
  // paragraphs up, and reading that as an opt-in filed this test under jsdom and
  // made the node row look one short.
  return /^\s*(?:\/\/|\/\*)[^\n]*@vitest-environment\s+jsdom/m.test(source);
};

/** The number in the `Files` column of a row whose first cell is `label`. */
const rowNumbers = (guide: string, label: string): number[] => {
  const row = guide.split("\n").find((line) => line.startsWith(`| ${label} |`));
  if (row === undefined) throw new Error(`testing.md has no row for ${label}`);
  const cells = row.split("|").map((cell) => cell.trim());
  // Cell 2 is `Files` in both tables; the tier table's own `Files` cell is a
  // bare count and the run table's is `105 pass, 51 skip`, so both arrive as a
  // list of the numbers in the cell and the caller says how many it expects.
  // A number, not a run of digits and commas: `106 pass, 51 skip` separates its
  // two numbers with a comma, and a pattern that let one start with a comma read
  // that separator as a third number worth nothing.
  return [...(cells[2] ?? "").matchAll(/\d[\d,]*/g)].map((match) =>
    Number(match[0].replaceAll(",", "")),
  );
};

describe("testing.md file counts", () => {
  const guide = readFileSync(GUIDE, "utf8");
  const top = filesIn("tests");
  const jsdom = top.filter((name) => isJsdom("tests", name));
  const node = top.filter((name) => !isJsdom("tests", name));
  const integration = filesIn("tests/integration");
  const browser = filesIn("tests/browser");

  it("names the tiers by the files each one holds", () => {
    expect(rowNumbers(guide, "Unit (node)")).toEqual([node.length]);
    expect(rowNumbers(guide, "Unit (jsdom)")).toEqual([jsdom.length]);
    expect(rowNumbers(guide, "Integration")).toEqual([integration.length]);
    expect(rowNumbers(guide, "Browser")).toEqual([browser.length]);
  });

  it("adds the collected tiers up to what a run reports", () => {
    // `vitest.config.ts` excludes `tests/browser` and nothing else, so a run
    // collects everything above it. Both run-table rows are therefore the same
    // total seen twice: with a database every file passes, and without one the
    // integration files that skip themselves move into the second number.
    const collected = node.length + jsdom.length + integration.length;
    const [withoutDatabase, skipped] = rowNumbers(guide, "`npm test`, no database");
    expect(withoutDatabase! + skipped!).toBe(collected);
    expect(rowNumbers(guide, "`npm test`, database set")).toEqual([collected]);
    expect(rowNumbers(guide, "`npm run test:integration`")).toEqual([integration.length]);
    // The skipping files are integration files, so there cannot be more of them
    // than there are integration files. This is the only claim in the run table
    // the filesystem can check about *which* files skip, and it is worth making
    // because the failure it catches — a unit test quietly skipping itself for
    // want of a database it should not need — reads as a healthy green run.
    expect(skipped!).toBeLessThanOrEqual(integration.length);
  });

  it("counts the browser tier the way 1.2 says it is sized", () => {
    // The prose said eleven while the file held eighteen, and nothing noticed:
    // this section's whole argument is "small on purpose", so the number in it
    // is a claim about restraint and has to be the real one.
    const spec = readFileSync(path.join(repoRoot, "tests/browser/budgets.spec.ts"), "utf8");
    const tests = [...spec.matchAll(/^\s*test\("/gm)].length;
    const words: Record<number, string> = {
      11: "Eleven",
      18: "Eighteen",
      19: "Nineteen",
      20: "Twenty",
      21: "Twenty-one",
    };
    expect(guide, `the browser tier holds ${tests} tests`).toContain(
      `${words[tests] ?? String(tests)} tests, one file, one worker`,
    );
  });
});
