import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every `file:line` a standards guide points at, checked against the tree.
 *
 * The guides argue from the code, so nearly every rule carries a citation. Line
 * numbers rot: a change three functions above moves every number below it and
 * says nothing, and a citation that has drifted is worse than none, because it
 * reads as evidence while pointing at whatever happens to be there now.
 *
 * Three citations had already drifted by the time this was written, so this is
 * a check that was needed rather than one that might be.
 *
 * What it can prove is that the file exists and the lines are inside it, which
 * catches deletion, renaming and truncation. What it cannot prove is that the
 * line still holds the thing the sentence claims. That half stays a person's
 * job, and saying so is better than implying the machine has it covered.
 */
const CITATION =
  /`?((?:src|tests|drizzle|docs|scripts|public)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|sql|md|json|js|mjs)):(\d+)(?:[-–](\d+))?`?/g;

type Citation = {
  guide: string;
  guideLine: number;
  text: string;
  path: string;
  from: number;
  to: number;
};

const citations = (): Citation[] => {
  const found: Citation[] = [];
  for (const guide of globSync("docs/standards/**/*.md")) {
    const lines = readFileSync(guide, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(CITATION)) {
        const from = Number(match[2]);
        found.push({
          guide,
          guideLine: index + 1,
          text: match[0],
          path: match[1]!,
          from,
          to: match[3] ? Number(match[3]) : from,
        });
      }
    });
  }
  return found;
};

const lineCount = (path: string): number | null => {
  try {
    return readFileSync(path, "utf8").split("\n").length;
  } catch {
    return null;
  }
};

describe("what the standards guides cite", () => {
  const all = citations();

  // A guide set that cites nothing is a guide set arguing from assertion, and
  // it would also make every test below pass without looking at anything.
  it("cites the code at all", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("names only files that exist", () => {
    const missing = all
      .filter((citation) => lineCount(citation.path) === null)
      .map((citation) => `${citation.guide}:${citation.guideLine} -> ${citation.text}`);
    expect(missing).toEqual([]);
  });

  it("names only lines those files have", () => {
    const past = all
      .filter((citation) => {
        const length = lineCount(citation.path);
        return length !== null && (citation.from > length || citation.to > length);
      })
      .map(
        (citation) =>
          `${citation.guide}:${citation.guideLine} -> ${citation.text} (file has ${lineCount(citation.path)} lines)`,
      );
    expect(past).toEqual([]);
  });

  // A path named in prose with no line number is a citation too, and it rots the
  // same way. This found `tests/budgets.integration.test.ts`, which had never
  // existed under that path — the file is under `tests/integration/`.
  it("names only files that exist, line number or not", () => {
    const BARE =
      /`((?:src|tests|drizzle|scripts|public)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|sql|js|mjs|json))`/g;
    const missing: string[] = [];
    for (const guide of globSync("docs/standards/**/*.md")) {
      readFileSync(guide, "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const match of line.matchAll(BARE)) {
            if (lineCount(match[1]!) === null) {
              missing.push(`${guide}:${index + 1} -> ${match[1]}`);
            }
          }
        });
    }
    expect(missing).toEqual([]);
  });

  /**
   * Links between guides, and the headings they point at.
   *
   * The set cross-references itself heavily — `common.md#errors` from four
   * places, `index.md#changing-a-rule` from two — and a heading renamed for
   * clarity silently breaks every one of them.
   */
  it("links only to files and headings that exist", () => {
    const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
    const HEADING = /^#{1,6}\s+(.*)$/;
    const slugsOf = (path: string): Set<string> =>
      new Set(
        readFileSync(path, "utf8")
          .split("\n")
          .map((line) => HEADING.exec(line)?.[1]?.trim())
          .filter((title): title is string => Boolean(title))
          .map((title) =>
            title
              .replaceAll(/`([^`]*)`/g, "$1")
              .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
              .toLowerCase()
              .replaceAll(/[^\w\s-]/g, "")
              .trim()
              .replaceAll(/\s+/g, "-"),
          ),
      );

    const broken: string[] = [];
    for (const guide of globSync("docs/standards/**/*.md")) {
      const dir = guide.slice(0, guide.lastIndexOf("/"));
      readFileSync(guide, "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const match of line.matchAll(LINK)) {
            const target = match[1]!;
            if (target.startsWith("http")) continue;
            const [path, fragment] = target.split("#");
            const file = path ? `${dir}/${path}` : guide;
            if (lineCount(file) === null) {
              broken.push(`${guide}:${index + 1} -> ${target} (no such file)`);
            } else if (fragment && !slugsOf(file).has(fragment)) {
              broken.push(`${guide}:${index + 1} -> ${target} (no such heading)`);
            }
          }
        });
    }
    expect(broken).toEqual([]);
  });

  /**
   * The other two citation forms.
   *
   * The guides cite in three shapes, and this test originally knew one of them:
   *
   * - `src/client/forms.tsx:285` — a full path.
   * - `forms.tsx:285` — a bare filename, resolved by basename.
   * - `:558` — a continuation, inheriting the last file named before it.
   *
   * The first was checked from the start. The other two were not, and 120 bare
   * and 104 continuation citations went unverified through a reformat that
   * moved every line in `src`. Six checked by hand were all wrong.
   *
   * A continuation's antecedent is whatever file the prose named last, which is
   * a real ambiguity rather than a limitation of this test: where the reader
   * cannot tell either, the citation is written out in full instead.
   */
  it("resolves bare and continuation citations too", () => {
    const NAMED =
      /`?((?:[A-Za-z0-9_./-]+\/)?[A-Za-z0-9_.-]+\.(?:ts|tsx|css|sql|json|mjs|js|md|sh|yaml|yml|example|toml)):(\d+)/g;
    const CONTINUATION = /`:(\d+)(?:[-–](\d+))?`/g;

    // Built once. Globbing per citation turned an instant test into an
    // eighteen-second one.
    const byBasename = new Map<string, string[]>();
    for (const path of globSync("{src,tests,docs,scripts,deploy}/**/*")) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      byBasename.set(base, [...(byBasename.get(base) ?? []), path]);
    }

    const resolve = (name: string): string | null => {
      // A dependency's own type declarations are cited by their path inside the
      // package. They are real references and they are not in this repository.
      if (name.startsWith("dist/")) return null;
      if (lineCount(name) !== null) return name;
      const matches = byBasename.get(name) ?? [];
      return matches.length === 1 ? matches[0]! : null;
    };

    const broken: string[] = [];
    for (const guide of globSync("docs/standards/**/*.md")) {
      const text = readFileSync(guide, "utf8");
      const events = [
        ...[...text.matchAll(NAMED)].map((m) => ({ at: m.index, file: m[1]!, line: Number(m[2]) })),
        ...[...text.matchAll(CONTINUATION)].map((m) => ({
          at: m.index,
          cont: m[0],
          line: Number(m[1]),
          end: m[2] ? Number(m[2]) : Number(m[1]),
        })),
      ].sort((a, b) => a.at - b.at);

      let current: string | null = null;
      for (const event of events) {
        const named = "file" in event ? (event as { file: string }).file : null;
        if (named) {
          current = named;
        }
        const target = named ?? current;
        if (!target) {
          broken.push(`${guide} -> ${(event as { cont: string }).cont} (nothing named before it)`);
          continue;
        }
        if (target.startsWith("dist/")) continue;
        const path = resolve(target);
        if (path === null) {
          broken.push(`${guide} -> ${target} (unresolved)`);
          continue;
        }
        const length = lineCount(path)!;
        const highest = "end" in event ? (event as { end: number }).end : event.line;
        if (event.line > length || highest > length) {
          broken.push(`${guide} -> ${target}:${event.line} (file has ${length} lines)`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  /**
   * Authoring artefacts that must not survive into a published guide.
   *
   * Citations are written by content — `@@path::anchor@@` — and resolved to line
   * numbers by a script, because writing line numbers by hand is how they were
   * wrong in the first place. One token survived the resolver: its anchor
   * contained an `@`, which the resolver reads as a terminator, so it silently
   * matched nothing and the raw token shipped.
   */
  it("leaves no unresolved citation tokens", () => {
    const leftovers: string[] = [];
    for (const guide of globSync("docs/standards/**/*.md")) {
      readFileSync(guide, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (line.includes("@@")) leftovers.push(`${guide}:${index + 1}`);
        });
    }
    expect(leftovers).toEqual([]);
  });

  it("never cites a range backwards", () => {
    const backwards = all
      .filter((citation) => citation.to < citation.from)
      .map((citation) => `${citation.guide}:${citation.guideLine} -> ${citation.text}`);
    expect(backwards).toEqual([]);
  });
});
