import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A closed set spelled out again inside a type assertion.
 *
 * `tests/closed-sets.test.ts` holds the rule — "no union whose member set
 * equals a tuple that already exists" — and its `inlineUnions()` anchors the
 * position on what can precede a *type*: `(?:^|[:(<,])`, for a property, an
 * annotation, a parameter or a type argument. A union that follows `as` is
 * preceded by none of those, so an assertion was the one spelling it could not
 * see, and one survived in `TransactionBrowser.tsx` through exactly that blind
 * spot while the file was being visited for the other nine.
 *
 * An assertion is the worse half of the two, which is why it is worth a check
 * of its own rather than only a wider anchor. A property type that goes stale
 * fails to compile at the assignment; an assertion goes on claiming a value it
 * no longer covers, so a fourth member added to the tuple leaves it silently
 * wrong with nothing failing at build time.
 *
 * Scoped to `src/client`, which is where every assertion of this shape in the
 * repository stands today. The tuples are read from all of `src`, because the
 * set a client file restates is nearly always declared in `src/shared`.
 */
const TUPLE_SOURCES = globSync("src/**/*.{ts,tsx}");
const CLIENT_SOURCES = globSync("src/client/**/*.{ts,tsx}");

const key = (members: readonly string[]) => [...members].sort().join(" ");

/**
 * Every `as const` tuple of string literals, by the set of its members.
 *
 * The same reading `closed-sets.test.ts` does, and deliberately the same: a
 * tuple holding an expression or a number is not a spelling of a closed set.
 */
function tuples() {
  const found = new Map<string, string[]>();
  for (const relative of TUPLE_SOURCES) {
    const source = readFileSync(relative, "utf8");
    for (const match of source.matchAll(/const (\w+)\s*=\s*\[([^\]]*?)\]\s*as const/gs)) {
      const members = [...match[2]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
      if (members.length < 2) continue;
      if (match[2]!.replaceAll(/"[^"]*"|[\s,]|\/\/[^\n]*/g, "") !== "") continue;
      const at = source.slice(0, match.index).split("\n").length;
      found.set(key(members), [
        ...(found.get(key(members)) ?? []),
        `${relative}:${at} ${match[1]}`,
      ]);
    }
  }
  return found;
}

/** Every `as "a" | "b"` in one file, with the line it stands on. */
function assertedUnions(source: string, where: string) {
  const found: { at: string; members: string[]; text: string }[] = [];
  for (const match of source.matchAll(/\bas\s+("[^"\n]+"(?:\s*\|\s*"[^"\n]+")+)/g)) {
    const members = [...match[1]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
    found.push({
      at: `${where}:${source.slice(0, match.index).split("\n").length}`,
      members,
      text: match[1]!,
    });
  }
  return found;
}

describe("a closed set", () => {
  /**
   * The scanner, against a file written to be caught.
   *
   * A source scan that reports nothing has usually broken rather than passed,
   * and the only way to tell the two apart is to show it reporting something.
   */
  it("is seen when a type assertion spells it out", () => {
    const synthetic = [
      'const value: string = "deposit";',
      'const narrowed = value as "deposit" | "withdrawal" | "transfer";',
      // Two of the three is a deliberate narrowing to a smaller set, not a
      // second spelling of the same one, so it is not a hit. A pair with no
      // tuple of its own: deposit and withdrawal have one now, `entryTypes`.
      'const pair = value as "deposit" | "transfer";',
    ].join("\n");
    const byMembers = tuples();
    const seen = assertedUnions(synthetic, "synthetic.ts");
    expect(seen).toHaveLength(2);
    expect(seen.filter((union) => byMembers.has(key(union.members)))).toHaveLength(1);
  });

  it("is not restated inside a type assertion anywhere in the client", () => {
    const byMembers = tuples();
    expect(byMembers.size, "no tuples found, so this examined nothing").toBeGreaterThan(10);
    const restated: string[] = [];
    for (const relative of CLIENT_SOURCES) {
      for (const union of assertedUnions(readFileSync(relative, "utf8"), relative)) {
        if (!byMembers.has(key(union.members))) continue;
        restated.push(
          `${union.at} asserts ${union.text}, which is ${byMembers.get(key(union.members))!.join(", ")}`,
        );
      }
    }
    expect(restated, "narrow through the tuple rather than assert past it").toEqual([]);
  });
});
