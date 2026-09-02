import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/database.md` 3.4: a count is `::int`.
 *
 * `count(*)` is a `bigint`, node-postgres hands `bigint` back as a string, and
 * a string is not a number that adds. `categories.ts` already carries the scar
 * in a comment: "a missing cast would make the total the two counts
 * concatenated rather than added". Nothing checked it, and the guide said as
 * much — "grep-able, not grepped".
 *
 * Grepping it is not quite enough on its own, which is why this reads more than
 * a line at a time:
 *
 * - `count(*)` appears three times in `src/server/services` as prose. The
 *   comments are blanked before anything is matched.
 * - Drizzle's own `count()` helper is TypeScript, not SQL, and it maps the
 *   result itself. Only the inside of a `sql` template is read, so that helper
 *   is out of scope rather than exempted.
 * - The cast does not always sit against the closing bracket:
 *   `count(*) filter (where …)::int` is three of them.
 *
 * The guide's escape hatch is kept: a count that might not be small stays a
 * string, and a `sql<string>` fragment says so in its type.
 */
type Count = { where: string; fragment: string; cast: boolean };

/** The index just past the backtick that closes a template opening at `start`. */
const endOfTemplate = (text: string, start: number): number => {
  let index = start + 1;
  let depth = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "$" && text[index + 1] === "{") {
      depth += 1;
      index += 2;
      continue;
    }
    if (character === "}" && depth > 0) depth -= 1;
    else if (character === "`" && depth === 0) return index + 1;
    index += 1;
  }
  return -1;
};

/** The index just past the bracket that closes the one at `start`. */
const endOfBracket = (text: string, start: number): number => {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
};

/**
 * Every count in a `sql` template, and whether it is cast to `int`.
 *
 * A fragment declared `sql<string>` is skipped entirely: that is the guide's
 * answer for a count too large for a JavaScript number, and the type is where a
 * reader finds out which of the two a call site is doing.
 */
const countsIn = (code: string, where: string): Count[] => {
  const found: Count[] = [];
  for (const tag of code.matchAll(/\bsql\s*(?:<([^`<>]*)>)?\s*`/g)) {
    const backtick = tag.index + tag[0].length - 1;
    const close = endOfTemplate(code, backtick);
    if (close === -1) continue;
    const wants = (tag[1] ?? "").trim() !== "string";
    const fragment = code.slice(backtick + 1, close - 1);
    if (!wants) continue;
    for (const count of fragment.matchAll(/\bcount\s*\(/gi)) {
      const after = endOfBracket(fragment, count.index + count[0].length - 1);
      if (after === -1) continue;
      // A `filter (where …)` clause sits between the count and its cast, so the
      // cast is looked for past it rather than immediately after the bracket.
      let rest = fragment.slice(after).trimStart();
      const filter = /^filter\s*\(/i.exec(rest);
      if (filter) {
        const filterEnd = endOfBracket(rest, filter[0].length - 1);
        if (filterEnd === -1) continue;
        rest = rest.slice(filterEnd).trimStart();
      }
      const line = code.slice(0, backtick + 1 + count.index).split("\n").length;
      found.push({
        where: `${where}:${line}`,
        fragment: fragment
          .slice(count.index, after + 12)
          .replaceAll(/\s+/g, " ")
          .trim(),
        cast: rest.startsWith("::int"),
      });
    }
  }
  return found;
};

const counts = sourceFiles("src/server").flatMap((file) => countsIn(file.code, file.path));

describe("reading counts out of SQL", () => {
  it("accepts the shapes this schema writes and refuses a bare one", () => {
    const sample = [
      "const a = sql<number>`count(*)::int`;",
      "const b = sql<number>`count(distinct transaction_id)::int`;",
      "const c = sql<number>`count(*) filter (where status = 'staged')::int`;",
      "const d = sql<number>`count(*)`;",
      "const e = sql<number>`sum(transaction_count)::int`;",
      "// count(*) in a comment is prose",
      "const f = sql<string>`count(*)`;",
      "const g = db.select({ value: count() });",
    ].join("\n");
    const read = countsIn(sample, "sample.ts");
    expect(read.map((count) => count.where)).toEqual([
      "sample.ts:1",
      "sample.ts:2",
      "sample.ts:3",
      "sample.ts:4",
    ]);
    expect(read.filter((count) => !count.cast).map((count) => count.where)).toEqual([
      "sample.ts:4",
    ]);
  });

  // A reader that found nothing would pass the case below by having no work to
  // do, and this server has thirty-odd counts for it to look at.
  it("reads the counts this server actually has", () => {
    expect(counts.length).toBeGreaterThan(25);
  });
});

describe("a count", () => {
  it("is cast in SQL rather than parsed in JavaScript", () => {
    expect(
      counts.filter((count) => !count.cast).map((count) => `${count.where} ${count.fragment}`),
      "cast it `::int`, or declare the fragment `sql<string>` if it might not be small",
    ).toEqual([]);
  });
});
