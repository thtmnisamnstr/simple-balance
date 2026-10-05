import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoFiles } from "./support/source.js";

/**
 * The workflows that test and publish this project, held to the conventions
 * they are written to.
 *
 * Read as text rather than parsed, because the properties worth holding are
 * about how a file is written — a pin with its version beside it, a key at the
 * top level rather than on a job — and a YAML parser would normalize exactly
 * those away. The helpers below understand only the indentation these files
 * use, which is the one layout GitHub's own examples and every file here share.
 */
const workflows = repoFiles((relative) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(relative));

/**
 * The lines under a top-level key, up to the next top-level key. Blank lines
 * and comments at the margin are left out: they sit between keys and belong to
 * whichever one follows, so they are no part of this one's value.
 */
const topLevel = (text: string, key: string) => {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (at === -1) return undefined;
  const end = lines.findIndex((line, index) => index > at && /^[A-Za-z]/.test(line));
  return lines
    .slice(at, end === -1 ? undefined : end)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .join("\n");
};

/** Each job under `jobs:`, by name. */
const jobsOf = (text: string) => {
  const block = topLevel(text, "jobs") ?? "";
  const jobs = new Map<string, string>();
  const starts = [...block.matchAll(/^ {2}([\w-]+):\s*$/gm)];
  starts.forEach((start, index) => {
    const end = starts[index + 1]?.index ?? block.length;
    jobs.set(start[1]!, block.slice(start.index, end));
  });
  return jobs;
};

/** Every `uses:` a file names, with whatever follows it on the line. */
const usesIn = (text: string) =>
  [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((match) => ({
    ref: match[1]!,
    rest: match[2]!,
  }));

describe("every workflow", () => {
  it("is found", () => {
    // The sweep found the files, so a broken pattern cannot read as a
    // repository whose workflows all comply.
    expect(workflows.map((file) => path.basename(file.path))).toEqual(
      expect.arrayContaining(["release.yml", "verify.yml"]),
    );
  });

  /**
   * By the commit, with the version it was beside it.
   *
   * A tag is a pointer its owner can move, and every workflow here runs with a
   * token that can write something — a package, a cache, a release. A commit
   * cannot move, and the comment is what lets Dependabot and a person reading
   * the file know which release that commit was. The one exception is a
   * reusable workflow in this repository, which runs at the caller's own ref.
   */
  it("pins every action by commit, with its version beside it", () => {
    const unpinned = workflows.flatMap((file) =>
      usesIn(file.text)
        .filter(
          ({ ref, rest }) =>
            !ref.startsWith("./.github/workflows/") &&
            !(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref) && /^ # v\d+(\.\d+)*$/.test(rest)),
        )
        .map(({ ref }) => `${file.path}: ${ref}`),
    );

    expect(workflows.flatMap((file) => usesIn(file.text)).length).toBeGreaterThan(0);
    expect(unpinned).toEqual([]);
  });

  it("grants only read access at the top, whatever a job then asks for", () => {
    for (const file of workflows) {
      expect(topLevel(file.text, "permissions"), file.path).toBe("permissions:\n  contents: read");
    }
  });

  /**
   * And the right to push a package only to a job that pushes one.
   *
   * Every other job in a publishing workflow runs this repository's code — the
   * test suites, `npm ci` and its lifecycle scripts — and none of it needs to
   * write to the registry, so none of it is handed a token that could.
   */
  it("grants packages: write only to a job that logs in to a registry", () => {
    for (const file of workflows) {
      for (const [name, job] of jobsOf(file.text)) {
        if (!/^\s+packages: write$/m.test(job)) continue;
        expect(job, `${file.path} ${name}`).toContain("uses: docker/login-action@");
      }
    }
  });
});
