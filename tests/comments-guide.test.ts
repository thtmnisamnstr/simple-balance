import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blankComments, repoFiles, repoRoot, sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/comments.md` section 8, which is the one rule on that
 * page about *where* the convention applies rather than about what a comment
 * says.
 *
 * Every other mechanism the page names reads `src` and nothing else, and `src`
 * stopped being all the first-party TypeScript here: the deployment profiles
 * are Pulumi programs, and this release added seven files of them. Section 5 is
 * Binding — a silenced lint rule argues at the site — and `npm run lint` really
 * does walk those files, so a bare disable under `deploy/` would be a live
 * silencing with nothing behind it. There are none, which is why this is cheap
 * to hold now; a check that arrives at zero stays at zero.
 *
 * The page's floor deliberately does not come along, and the last test here is
 * why: a floor is one number over whatever population it is handed, and these
 * three do not measure alike.
 */

/** The first-party TypeScript outside `src`, discovered rather than listed. */
const deploymentSource = () =>
  repoFiles((relative) => relative.startsWith("deploy/") && /\.tsx?$/.test(relative));

// Whether the run of comment lines directly above `index` argues anything.
//
// Deliberately simpler than the same walk in
// `tests/lint-config-documented.test.ts:72`, and the simplification is argued
// from the population rather than assumed: the two shapes that one has to allow
// for — a `{/* … */}` JSX comment, and a paragraph sitting above the
// `useEffect(` a disable is inside — are both React, and there is no `.tsx`
// under `deploy/`. What is left is a run of `//` lines, or a block comment,
// immediately above. Contiguous rather than nearby, for the reason that test
// gives: in a file commented this densely, a window of a dozen lines passes on
// a bare disable that happens to sit under something unrelated.
//
// Two words of three letters or more count as an argument, which is the same
// bar: a URL, or the rule name repeated back, is not one.
const argumentAbove = (lines: string[], index: number): boolean => {
  const run: string[] = [];
  let insideBlock = false;
  for (let above = index - 1; above >= 0; above -= 1) {
    const text = lines[above]!.trim();
    const closes = text.endsWith("*/") && !text.includes("/*");
    const opens = text.includes("/*");
    if (!(insideBlock || closes || opens || text.startsWith("//") || text.startsWith("*"))) break;
    if (closes) insideBlock = true;
    if (insideBlock && opens) insideBlock = false;
    run.push(text.replace(/^(?:\/\/|\/\*+|\*)\s*/, ""));
  }
  return /[a-z]{3,}\s+[a-z]{3,}/i.test(run.join(" "));
};

/** Every `oxlint-disable` in `files` with no argument above it, as `path:line`. */
const bareDisables = (files: { path: string; text: string }[]): string[] => {
  const bare: string[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    lines.forEach((line, index) => {
      if (!line.includes("oxlint-disable")) return;
      if (argumentAbove(lines, index)) return;
      bare.push(`${file.path}:${index + 1}`);
    });
  }
  return bare;
};

describe("the comment convention outside src", () => {
  it("finds the deployment TypeScript rather than listing it", () => {
    const files = deploymentSource();
    // A list is a claim about what exists, made once, by somebody who could not
    // see the next profile. So this asserts the shape of what the walk found
    // and not its membership — except for the file the rule's own measurement
    // is loudest about, which is worth naming so a rename is visible.
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((file) => file.path)).toContain("deploy/pulumi/single-common/cloud-init.ts");
    // Pulumi's dependencies ship their own declarations, and they are not this
    // repository's comments to keep.
    expect(files.filter((file) => file.path.includes("node_modules"))).toEqual([]);
  });

  /**
   * The premise the rule rests on, held because the rule collapses without it.
   *
   * A disable under `deploy/` only matters if something is reading those files.
   * `npm run lint` is a bare `oxlint`, which walks from the repository root, and
   * `.oxlintrc.json` excludes four directories that are not this one. Give the
   * script a path list or add `deploy` to the ignores and every disable there
   * becomes inert — at which point the rule below is enforcing a convention on
   * dead text and should be reconsidered rather than quietly kept.
   */
  it("is looking where the linter looks", () => {
    const scripts = (
      JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    // Flags are fine; a path is not, because a path list is what would silently
    // drop `deploy/` out of the lint.
    expect(scripts.lint!.split(/\s+/).filter((word) => !word.startsWith("-"))).toEqual(["oxlint"]);
    const ignored = (
      JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8")) as {
        ignorePatterns?: string[];
      }
    ).ignorePatterns;
    expect(ignored?.filter((pattern) => pattern.includes("deploy"))).toEqual([]);
  });

  it("silences no rule there without arguing for it", () => {
    expect(bareDisables(deploymentSource()), "a disable with no argument above it").toEqual([]);
  });

  /**
   * And the predicate itself, because the population is empty.
   *
   * The assertion above passes today by finding nothing, which is exactly how a
   * check spends a release reading nothing and nobody notices. These two are
   * what it would have to catch the day the first disable is written.
   */
  it("would catch one, and would leave an argued one alone", () => {
    const bare = [
      "const ami = pulumi.output(lookup());",
      "// oxlint-disable-next-line typescript/no-explicit-any",
      "const id = (ami as any).id;",
    ].join("\n");
    const argued = [
      "// Pulumi types the lookup as the union of every AMI shape, and the one",
      "// this filter can return is the only member of it carrying an id.",
      "// oxlint-disable-next-line typescript/no-explicit-any",
      "const id = (ami as any).id;",
    ].join("\n");
    expect(bareDisables([{ path: "fixture", text: bare }])).toEqual(["fixture:2"]);
    expect(bareDisables([{ path: "fixture", text: argued }])).toEqual([]);
  });

  /**
   * Why the floor stays on `src` while the convention does not.
   *
   * The guide's floor lives in `tests/comment-density.test.ts:23` and is 14%.
   * Widening its population to the whole repository is the obvious alternative
   * and is the one section 8 refuses, because `tests/` outnumbers `src` — so
   * this recomputes the counterfactual the guide argues from rather than
   * quoting a number that would rot beside it. If this ever stops holding, the
   * argument for keeping scope and floor apart has weakened and section 8 is
   * owed a second look.
   */
  it("could not defend src from a floor over the union", () => {
    const density = (files: { text: string }[]) => {
      let comments = 0;
      let lines = 0;
      for (const file of files) {
        const written = file.text.split("\n");
        const blanked = blankComments(file.text).split("\n");
        for (const [index, line] of written.entries()) {
          if (line.trim() === "") continue;
          lines += 1;
          if (blanked[index]?.trim() === "") comments += 1;
        }
      }
      return { comments, lines };
    };

    const application = density(sourceFiles("src"));
    const rest = density([...deploymentSource(), ...sourceFiles("tests")]);
    // Every comment in `src` tidied away: those lines are gone with them, so
    // what `src` still contributes to the union is its code and nothing else.
    const stripped = rest.comments / (rest.lines + application.lines - application.comments);
    expect(stripped * 100).toBeGreaterThan(14);
  });
});
