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

/**
 * Every citation in every guide, in all three shapes, resolved to a file.
 *
 * Walking the document in document order is what makes a continuation
 * resolvable: `:558` means whatever file was named last, so the events have to
 * be visited in the order a reader meets them.
 */
type Cited = {
  guide: string;
  /** The file as the guide spells it, which may be a bare basename. */
  target: string;
  /** The repository path it resolves to, or null if nothing resolves. */
  path: string | null;
  from: number;
  to: number;
  token: string;
};

const NAMED =
  /`?((?:[A-Za-z0-9_./-]+\/)?[A-Za-z0-9_.-]+\.(?:ts|tsx|css|sql|json|mjs|js|md|sh|yaml|yml|example|toml)):(\d+)(?:[-–](\d+))?/g;
const CONTINUATION = /`:(\d+)(?:[-–](\d+))?`/g;
/**
 * A filename with no line number still names the file a continuation follows.
 *
 * A `*Checked by:* `tests/theme-tokens.test.ts`` line followed by `(`:46`)` is
 * unambiguous to a reader and was not to this test, which moved its antecedent
 * only on a citation that carried a line. It read those continuations against
 * whatever file had last been cited with one — three paragraphs up, in one
 * case — and checked them against the wrong file.
 */
const BARE_FILE =
  /`((?:[A-Za-z0-9_./-]+\/)?[A-Za-z0-9_.-]+\.(?:ts|tsx|css|sql|json|mjs|js|md|sh|yaml|yml|example|toml))`/g;

const everyCitation = (): Cited[] => {
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

  const found: Cited[] = [];
  for (const guide of globSync("docs/standards/**/*.md")) {
    const text = readFileSync(guide, "utf8");
    const events = [
      ...[...text.matchAll(NAMED)].map((m) => ({
        at: m.index,
        file: m[1]!,
        from: Number(m[2]),
        to: m[3] ? Number(m[3]) : Number(m[2]),
        token: m[0],
      })),
      ...[...text.matchAll(CONTINUATION)].map((m) => ({
        at: m.index,
        from: Number(m[1]),
        to: m[2] ? Number(m[2]) : Number(m[1]),
        token: m[0],
      })),
      ...[...text.matchAll(BARE_FILE)].map((m) => ({ at: m.index, file: m[1]!, token: m[0] })),
    ].sort((a, b) => a.at - b.at);

    let current: string | null = null;
    for (const event of events) {
      const named = "file" in event ? (event as { file: string }).file : null;
      if (named) current = named;
      // A bare filename moves the antecedent and is not itself a citation:
      // there is no line to check.
      if (!("from" in event)) continue;
      const target = named ?? current;
      found.push({
        guide,
        target: target ?? "",
        path: target === null ? null : resolve(target),
        from: event.from,
        to: event.to,
        token: event.token,
      });
    }
  }
  return found;
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

  /**
   * A citation has to land on something, not between two things.
   *
   * The existence and range checks above pass on a line that holds `});`, and
   * that turned out to be the shape of the failure rather than a corner of it:
   * two passes had renumbered citations by shifting them rather than by finding
   * what they named, so a citation whose target had moved further than the
   * shift landed on whatever now sat at the new number. Seven had come to rest
   * on a closing brace, a bare `items,` or a blank line, and every one of the
   * seven turned out to be pointing at the wrong thing entirely.
   *
   * So this is a proxy, and a good one: a closing bracket is never what a
   * sentence is citing, and a citation that has landed on one is a citation
   * that has drifted. It cannot see a citation that drifted onto a plausible
   * line, which is why the aim of a citation is still read by a person — but it
   * makes the cheap half of that reading unnecessary.
   */
  it("lands on a line with something on it", () => {
    const fragment = /^(?:[)}\]>;,]+|<\/\w+>|\w+,|\.\.\.\w+|\{\.\.\.\w+\}|)$/;
    const landed: string[] = [];
    for (const citation of everyCitation()) {
      if (citation.path === null) continue;
      const lines = readFileSync(citation.path, "utf8").split("\n");
      const line = lines[citation.from - 1];
      if (line === undefined) continue;
      if (fragment.test(line.trim())) {
        landed.push(`${citation.guide} -> ${citation.token} is «${line.trim() || "a blank line"}»`);
      }
    }
    expect(landed).toEqual([]);
  });

  /**
   * Two numbers `web.md` opens with, held against the stylesheet.
   *
   * Both had gone stale by the time anybody counted: fifty-seven tokens where
   * sixty are declared — three of them the subject of a section forty lines
   * further down the same guide — and 3,349 lines where the file has 3,450. A
   * number in a guide is checked by whoever recounts it, which is nobody, and
   * these two carry an argument each: the token count is the inventory the
   * "largest gap in this chapter" rests on, and the line count is what makes
   * hand-written CSS a claim rather than a boast.
   */
  it("counts the stylesheet the way web.md says it does", () => {
    const css = readFileSync("src/client/styles.css", "utf8");
    const guide = readFileSync("docs/standards/web.md", "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}", css.indexOf(":root {")));
    const tokens = [...root.matchAll(/^\s+(--[a-z0-9-]+):/gm)].length;
    // Newlines, not split parts: a file ending in a newline splits to one more
    // than it has lines, and `wc -l` is what anybody checking this would run.
    const lines = css.split("\n").length - (css.endsWith("\n") ? 1 : 0);
    const words: Record<number, string> = { 57: "Fifty-seven", 60: "Sixty", 61: "Sixty-one" };
    expect(guide, `styles.css declares ${tokens} tokens`).toContain(
      `${words[tokens] ?? String(tokens)} tokens are declared`,
    );
    expect(guide, `styles.css is ${lines} lines`).toContain(
      `${lines.toLocaleString("en-GB")} lines of hand-written CSS`,
    );
  });

  it("never cites a range backwards", () => {
    const backwards = all
      .filter((citation) => citation.to < citation.from)
      .map((citation) => `${citation.guide}:${citation.guideLine} -> ${citation.text}`);
    expect(backwards).toEqual([]);
  });
});
