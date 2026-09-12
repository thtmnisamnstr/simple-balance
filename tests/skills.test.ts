import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The five procedures in `.claude/skills/`, held to what says they exist.
 *
 * They are documents like any other here, so `writing.md`'s table names their
 * reader and their mode, and `AGENTS.md` points at them from the file an agent
 * reads before its first edit. Three things can drift between those and the
 * directory, and all three are cheap to check: a skill that exists and is named
 * nowhere, a name that is promised and missing, and a file whose frontmatter
 * does not load.
 *
 * The fourth check is the one that was learned rather than predicted. A
 * `SKILL.md` is expanded when it loads, so a bare dollar-sign followed by a
 * name or a digit is substituted before anybody reads it. `design-review`
 * quoted a defect report about a figure that "always show[ed] $0" and the
 * loaded skill said it showed the skill's own name; `guides-comply` had a shell
 * loop whose variable would have been blanked, turning a census into a command
 * that counted nothing. Neither is visible in the file.
 */
const SKILLS = globSync(".claude/skills/*/SKILL.md");

const frontmatter = (source: string) => {
  const match = /^---\n(.*?)\n---\n/s.exec(source);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 2).trim();
  }
  return fields;
};

describe("the repository's skills", () => {
  it("are the five the invariants file points at", () => {
    const agents = readFileSync("AGENTS.md", "utf8");
    const onDisk = SKILLS.map((file) => path.basename(path.dirname(file))).sort();
    expect(onDisk.length, "five procedures, per writing.md").toBe(5);
    for (const name of onDisk) {
      expect(agents, `AGENTS.md names ${name}`).toContain(`\`${name}\``);
    }
    // And the other way: a name promised there and missing here.
    const promised = [...agents.matchAll(/^- `([a-z-]+)` — /gm)].map((one) => one[1]!);
    expect(promised.sort()).toEqual(onDisk);
  });

  it("carry frontmatter that names the directory they are in", () => {
    for (const file of SKILLS) {
      const fields = frontmatter(readFileSync(file, "utf8"));
      expect(fields, `${file} has a frontmatter block`).not.toBeNull();
      expect(fields!["name"], `${file} names itself`).toBe(path.basename(path.dirname(file)));
      // The description is what decides whether a skill is reached for at all.
      expect((fields!["description"] ?? "").length, `${file} describes itself`).toBeGreaterThan(40);
    }
  });

  it("contain no bare shell variable, which the loader would swallow", () => {
    const swallowed: string[] = [];
    for (const file of SKILLS) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          // `${...}` and `$(...)` survive the expansion; the bare form does not.
          for (const match of line.matchAll(/\$(?![({])[A-Za-z0-9_]+/g)) {
            swallowed.push(`${file}:${index + 1} ${match[0]}`);
          }
        });
    }
    expect(swallowed, "write the word, or wrap it in braces").toEqual([]);
  });

  it("cite the guides rather than restating them", () => {
    // The rule `writing.md` gives for why these are not a tenth guide. A skill
    // that mentions no guide at all is either doing something the guides do not
    // cover, or is quietly becoming a copy of one.
    for (const file of SKILLS) {
      const source = readFileSync(file, "utf8");
      const cites = /docs\/standards\/|AGENTS\.md|docs\/upgrades\.md|web\.md|writing\.md/.test(
        source,
      );
      expect(cites, `${file} points at the documents it defers to`).toBe(true);
    }
  });
});
