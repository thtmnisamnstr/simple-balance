import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot, sourceFiles } from "./support/source.js";

/**
 * The one number in these guides that is a rule rather than a description.
 *
 * `AGENTS.md` warns an agent before its first edit that comments here are dense
 * on purpose, and `docs/standards/code/comments.md` spends a page on why. Both
 * quote a percentage, and a quoted percentage rots: it was 14.9% when it was
 * written and 16.8% two steps of work later, which nobody noticed because a
 * number in prose is checked by whoever recounts it, and nobody recounts it.
 *
 * Two different failures are worth catching and they want different checks.
 * Somebody tidying the comments away is the one the rule exists for, and a
 * floor catches it without firing on ordinary work. The two documents drifting
 * apart, or drifting far from the truth, is the other, and a band catches that
 * while leaving room for a normal week's edits. Neither is an exact equality,
 * because a check that every commit has to update gets updated without being
 * read — the same reason `testing.md`'s test counts are not held either.
 */
const FLOOR = 14;
const TOLERANCE = 1.5;

/** Lines that are entirely comment, over lines that are not blank, in `src`. */
const measure = (): { comments: number; lines: number; percent: number } => {
  let comments = 0;
  let lines = 0;
  for (const file of sourceFiles("src")) {
    const written = file.text.split("\n");
    const blanked = file.code.split("\n");
    for (const [index, line] of written.entries()) {
      if (line.trim() === "") continue;
      lines += 1;
      // Blank once the comments are gone means the line held nothing else. A
      // trailing comment on a line of code does not count, which understates
      // the density and is the conservative direction for a floor.
      if (blanked[index]?.trim() === "") comments += 1;
    }
  }
  return { comments, lines, percent: (comments / lines) * 100 };
};

/** Every percentage in a document, as a number. */
const percentagesIn = (relative: string): number[] =>
  [...readFileSync(path.join(repoRoot, relative), "utf8").matchAll(/(\d+\.\d)% of/g)].map((match) =>
    Number(match[1]),
  );

describe("comment density", () => {
  const measured = measure();

  it("stays above the floor the guides are written to defend", () => {
    expect(measured.percent).toBeGreaterThan(FLOOR);
  });

  it("is quoted the same way everywhere it is quoted", () => {
    const quoted = [
      ...percentagesIn("AGENTS.md"),
      ...percentagesIn("docs/standards/code/comments.md"),
    ];
    // Both documents make the claim, and a reader who finds two numbers has to
    // work out which is current. There is no answer to that from inside the
    // text, so the check is that the question never comes up.
    expect(new Set(quoted).size).toBe(1);
    for (const percent of quoted) {
      expect(
        Math.abs(percent - measured.percent),
        `the guides say ${percent}%, src measures ${measured.percent.toFixed(1)}% ` +
          `(${measured.comments} of ${measured.lines})`,
      ).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
