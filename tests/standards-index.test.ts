import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The claims `docs/standards/index.md` makes about the set it routes to.
 *
 * It is the one page in the set whose job is routing, which is what makes a
 * wrong sentence here expensive: a reader reaches the table instead of the
 * guide, so the table is believed and cited rather than checked. Four of its
 * sentences are counts or lists of other files, every one of them maintained by
 * hand, and three had drifted — the code guides' subject list, the guides that
 * repeat the money invariant, and the two conformance targets this repository
 * does not meet.
 *
 * `tests/standards-citations.test.ts` already holds the citations and the
 * cross-links in every guide, including this one. What it does not have is any
 * check of the lists, and its labeled-rule check globs `docs/standards/code/`
 * alone, so this file has never been examined by it at all.
 */
const read = (path: string) => readFileSync(path, "utf8");
const INDEX = "docs/standards/index.md";

/** `docs/standards/*.md` other than the routing page itself. */
const interfaceGuides = (): string[] =>
  globSync("docs/standards/*.md")
    .filter((path) => path !== INDEX)
    .sort();

/** `docs/standards/code/*.md` other than that directory's own routing page. */
const codeGuides = (): string[] =>
  globSync("docs/standards/code/*.md")
    .filter((path) => !path.endsWith("/index.md"))
    .sort();

// Prose wraps, so every comparison below is against the flattened text. Without
// it a sentence that is right and wrapped differently reads as a sentence that
// is wrong — the lesson `standards-citations.test.ts` already learned on the
// spacing census.
const flat = (text: string) => text.replaceAll(/\s+/g, " ");

const NUMBER_WORDS: Record<number, string> = {
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
};
const word = (count: number) => NUMBER_WORDS[count] ?? String(count);

describe("the subjects index.md says the code guides cover", () => {
  /**
   * One subject per guide, in both spine documents, held to the directory.
   *
   * `index.md` and `AGENTS.md` carry the same list in parallel sentences. The
   * commit that gave metrics and logging a guide of its own moved `index.md`'s
   * count from seven to eight and left the list at seven subjects, and the
   * subject missing from it is observability — where the rule that nothing
   * outside the configuration layer names `console` lives, which `AGENTS.md`
   * calls one of three habits to know before the first edit. Two spine
   * documents disagreeing about the same eight files, with the routing page the
   * wrong one.
   */
  it("is one per guide, and the same list AGENTS.md carries", () => {
    const subjectsIn = (text: string, pattern: RegExp): string[] => {
      const found = pattern.exec(flat(text));
      expect(found, `no subject list matched ${String(pattern)}`).not.toBeNull();
      return found![1]!
        .split(",")
        .map((subject) => subject.trim().toLowerCase())
        .filter(Boolean);
    };

    const index = subjectsIn(read(INDEX), /How the code is \*written\* — (.+?) — is/);
    const agents = subjectsIn(read("AGENTS.md"), /— the source\. (.+?), and the linter/);

    expect(index, "index.md and AGENTS.md describe the same eight guides").toEqual(agents);
    expect(index.length, `docs/standards/code/ holds ${codeGuides().length} guides`).toBe(
      codeGuides().length,
    );
    expect(flat(read(INDEX))).toContain(`a second set of ${word(index.length)} guides`);
  });
});

describe("the guides index.md says repeat the money invariant", () => {
  /**
   * The one place a rule is deliberately written twice, so the list is exact.
   *
   * The sentence declaring that exception exists so nobody tidies the
   * repetition away, which makes it the one sentence in the set that has to
   * name files rather than gesture at them. "Repeated in every guide" is a
   * gesture, and it is wrong by nine: the invariant is quoted in five of the
   * seven interface guides and one of the eight code guides.
   *
   * Checked in both directions. A guide that starts quoting it without being
   * listed is the same defect as a listed guide that stops.
   */
  it("is exactly the set of guides that quote it", () => {
    const text = flat(read(INDEX));
    // The sentence runs from "quoted in" to the first full stop that ends a
    // sentence rather than a filename: a period inside `common.md` is followed
    // by a letter, and the one that ends the sentence by a space and a capital.
    const sentence = /That sentence is quoted in .+?(?=\.\s+[A-Z])/.exec(text);
    expect(
      sentence,
      "index.md no longer names the guides that repeat the money rule",
    ).not.toBeNull();

    const listed = [...sentence![0].matchAll(/`([\w/-]+\.md)`/g)].map((match) => match[1]!).sort();

    const quotes = (path: string) => read(path).includes("floating-point numbers");
    const actual = [...interfaceGuides().filter(quotes), ...codeGuides().filter(quotes)]
      .map((path) => path.slice("docs/standards/".length))
      .sort();

    expect(listed).toEqual(actual);

    // And the denominators, which are what went stale on the parallel sentence
    // about the code guides. A guide added to either directory moves one.
    const interfaceHits = interfaceGuides().filter(quotes).length;
    const codeHits = codeGuides().filter(quotes).length;
    expect(text).toContain(
      `quoted in ${word(interfaceHits)} of the ${word(interfaceGuides().length)} interface guides`,
    );
    expect(text).toContain(`in ${word(codeHits)} of the ${word(codeGuides().length)} code guides`);
  });
});

/**
 * A conformance target the repository does not meet, and where that is argued.
 *
 * The rule is `index.md` §"A target that is not met records the miss here". Two
 * of the five rows are aspirational, and both misses are recorded elsewhere in
 * two different shapes: a labeled `Contested` section in `http.md` for the
 * error format, a prose paragraph under `operations.md` §Hardening for the
 * container. Neither was reachable from the table that makes the claim.
 */
describe("a conformance target that is not met", () => {
  const CONFORMANCE = /## Conformance targets\n([\s\S]*?)\n\n/;
  const rows = (): { surface: string; target: string }[] => {
    const table = CONFORMANCE.exec(read(INDEX));
    expect(table, "index.md no longer has a Conformance targets table").not.toBeNull();
    return table![1]!
      .split("\n")
      .filter((line) => line.startsWith("|") && !/^\|\s*(Surface|-)/.test(line))
      .map((line) => {
        const cells = line.split("|").map((cell) => cell.trim());
        return { surface: cells[1]!, target: cells[2]! };
      });
  };

  /** The slug a markdown heading gets, spelled the way GitHub spells it. */
  const slugOf = (title: string): string =>
    title
      .replaceAll(/`([^`]*)`/g, "$1")
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replaceAll(/[^\w\s-]/g, "")
      .trim()
      .replaceAll(/\s+/g, "-");

  /** The body of one section, from its heading to the next heading. */
  const sectionOf = (path: string, slug: string): string => {
    const lines = read(path).split("\n");
    const starts = lines.flatMap((line, index) => (/^#{1,6} /.test(line) ? [index] : []));
    for (const [position, start] of starts.entries()) {
      if (slugOf(lines[start]!.replace(/^#+\s+/, "").trim()) !== slug) continue;
      return lines.slice(start, starts[position + 1] ?? lines.length).join("\n");
    }
    return "";
  };

  // Guarding the parse. A table that stopped matching would make every
  // assertion below pass against nothing, which is how the first version of
  // the disabled-button census spent a release checking zero rows.
  it("is read off a table that has rows in it", () => {
    expect(rows().length).toBeGreaterThanOrEqual(5);
  });

  it("carries a marker and a link to the section that argues it", () => {
    const wrong: string[] = [];
    let marked = 0;
    for (const { surface, target } of rows()) {
      if (!target.includes("**Not met:**")) continue;
      marked += 1;
      const link = /\[`([\w.-]+)`\]\(([\w.-]+)#([\w-]+)\)/.exec(target);
      if (!link) {
        wrong.push(`${surface}: marked Not met with no link to the section that argues it`);
        continue;
      }
      const guide = `docs/standards/${link[2]!}`;
      if (!globSync(guide).length) {
        wrong.push(`${surface}: links ${link[2]}, which does not exist`);
        continue;
      }
      const body = sectionOf(guide, link[3]!);
      if (!body) {
        wrong.push(`${surface}: links ${link[2]}#${link[3]}, which is not a heading there`);
        continue;
      }
      // The half that goes stale on its own: a blocker that stopped blocking.
      // A miss is recorded in one of three shapes in this set, and a section
      // rewritten because the miss was fixed carries none of them — at which
      // point the row here is the thing left saying something false.
      if (!/does not conform|not met|the one exception/i.test(body)) {
        wrong.push(
          `${surface}: ${link[2]}#${link[3]} no longer records a miss, so drop the marker`,
        );
      }
    }
    expect(wrong).toEqual([]);
    expect(marked, "no row is marked, so this test is checking nothing").toBeGreaterThan(0);
  });

  /**
   * And the other direction, which is the one a guide can break on its own.
   *
   * A guide that writes "this API does not conform to its own error target" and
   * leaves the table alone is exactly the state this rule exists to end. It
   * sees only a miss stated in those words, which is why the rule asks for the
   * marker rather than for a phrase: `operations.md` argues its one as an
   * exception and never names a conformance target.
   */
  it("is linked from this table by every guide that admits one", () => {
    const table = CONFORMANCE.exec(read(INDEX))![1]!;
    const unlinked: string[] = [];
    for (const guide of [...interfaceGuides(), ...codeGuides()]) {
      if (!/does not conform to its own/i.test(read(guide))) continue;
      const name = guide.slice("docs/standards/".length);
      if (!table.includes(`(${name}#`)) {
        unlinked.push(`${guide} says it does not conform, and no row here links to it`);
      }
    }
    expect(unlinked).toEqual([]);
  });
});

describe("a rule index.md states about itself", () => {
  /**
   * The contract the rest of the set is held to, applied to the page that sets
   * it: "A rule enforced by a test names the test. A rule that is not enforced
   * says so."
   *
   * `index.md` is outside the glob of the labeled-rule check in
   * `tests/standards-citations.test.ts`, which reaches `docs/standards/code/`
   * alone. The sentences defining the labeling scheme are deliberately
   * unlabeled and say why; anything here that does carry a label answers to the
   * same footer rule as a rule in any other guide.
   *
   * The label has to open a paragraph. The scheme's own table spells
   * `| **Binding** |` in a cell, and matching that would demand a footer on the
   * section that defines what a footer is.
   */
  it("carries a label and a mechanism like any other", () => {
    const lines = read(INDEX).split("\n");
    const starts = lines.flatMap((line, index) => (/^#{2,6} /.test(line) ? [index] : []));
    const silent: string[] = [];
    let labeled = 0;
    for (const [position, start] of starts.entries()) {
      const body = lines.slice(start, starts[position + 1] ?? lines.length).join("\n");
      if (!/^\*\*(Binding|House|Contested)\b/m.test(body)) continue;
      labeled += 1;
      if (!body.includes("*Checked by:*")) silent.push(lines[start]!.replace(/^#+\s+/, ""));
    }
    expect(silent, "name a mechanism, or say in the footer that it is review").toEqual([]);
    expect(labeled, "no labeled rule found, so this test is checking nothing").toBeGreaterThan(0);
  });
});
