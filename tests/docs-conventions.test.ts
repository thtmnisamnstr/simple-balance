import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Presence, not quality.
 *
 * Whether a decision record is worth reading is review and always will be.
 * Whether it is there at all is a string check, and that is the half that has
 * actually gone missing: an item shipped with its record above its acceptance
 * criteria under a different heading, and the README pointed somebody who found
 * a hole at nothing.
 */
const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("the roadmap", () => {
  it("says how every shipped item was met", () => {
    const sections = read("docs/roadmap.md").split("\n## ");
    const shipped = sections.filter((section) => section.split("\n")[0]!.endsWith("— **done**"));
    const silent = shipped
      .filter((section) => !section.includes("**How it was met**"))
      .map((section) => section.split("\n")[0]!);

    expect(shipped.length).toBeGreaterThan(0);
    expect(silent).toEqual([]);
  });
});

describe("the README", () => {
  it("tells somebody who found a hole where to report it", () => {
    expect(read("README.md").split("\n")).toContain("## Security");
    expect(read("README.md")).toContain("](SECURITY.md)");
    expect(read("SECURITY.md")).toContain("security/advisories/new");
  });

  it("does not answer the contributing question with the invariants file", () => {
    // One name pointing at two things. `AGENTS.md` is what a change is held to,
    // which is not the same question as whether a change is wanted.
    expect(read("README.md")).not.toContain("- [Contributing](AGENTS.md)");
  });

  it("does not leave the standards guide claiming the security file is missing", () => {
    // The same claim lived in two places in one guide, and only one of them
    // would have been updated.
    expect(read("docs/standards/writing.md")).not.toContain("No `SECURITY.md`");
  });
});

describe("the links a reader follows out of the root", () => {
  it("point at files that exist", () => {
    for (const file of ["README.md", "SECURITY.md"]) {
      const targets = [...read(file).matchAll(/\]\(([^)]+)\)/g)]
        .map((match) => match[1]!)
        .filter((target) => !/^(https?:|mailto:|#)/.test(target))
        .map((target) => target.split("#")[0]!);
      const broken = targets.filter((target) => !existsSync(path.join(root, target)));

      expect(targets.length, file).toBeGreaterThan(0);
      expect(broken, file).toEqual([]);
    }
  });
});
