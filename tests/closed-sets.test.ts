import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A closed set is spelled once, and every copy of it is derived.
 *
 * The repository's habit is an `as const` tuple with the union derived from it
 * — `export const actorSources = [...] as const;` and
 * `export type ActorSource = (typeof actorSources)[number];` — and it is the
 * right habit, because everything that needs the values at run time (a Zod
 * enum, a `pgEnum`, a `<select>`) can read the tuple and everything that needs
 * the type can derive it.
 *
 * Nothing asked for it, though, so a closed set hand-written as a bare union of
 * string literals passed every check this repository had. Three had drifted
 * into existence: the recurrence vocabularies in `recurrence-dates.ts`, the
 * client's `AuthMode`, and the client's `BudgetPeriodUnitName` — the last a
 * hand-copy of the constant the standards hold up as the model, one directory
 * away.
 *
 * The rule is deliberately not "every closed set must be a tuple". A union
 * written inline and used once is fine, and demanding a tuple for it would be
 * noise. What is refused is a union whose member set *equals* a tuple that
 * already exists: that is one set spelled twice, and the two can come apart.
 */
const SOURCES = globSync("src/**/*.{ts,tsx}");

const key = (members: readonly string[]) => [...members].sort().join(" ");

/** Every `as const` tuple of string literals, by the set of its members. */
function tuples() {
  const found = new Map<string, string[]>();
  for (const relative of SOURCES) {
    const source = readFileSync(relative, "utf8");
    for (const match of source.matchAll(/const (\w+)\s*=\s*\[([^\]]*?)\]\s*as const/gs)) {
      const members = [...match[2]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
      // Only string literals make a tuple a spelling of a set; one holding an
      // expression or a number is something else.
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

/** Every type alias that is a union of two or more string literals. */
function unions() {
  const found: { where: string; name: string; members: string[] }[] = [];
  for (const relative of SOURCES) {
    const source = readFileSync(relative, "utf8");
    // The separator is anchored on a literal `|`, deliberately. Writing the
    // alternative as `(?:\s*\|?\s*"[^"]+")+` reads the same and backtracks
    // exponentially on `type a=` followed by many quoted words and no `;`,
    // because the two `\s*` either side of an optional pipe can split one run
    // of whitespace in as many ways as it is long. CodeQL caught it.
    for (const match of source.matchAll(
      /type (\w+)\s*=\s*\|?\s*("[^"]+"(?:\s*\|\s*"[^"]+")*)\s*;/g,
    )) {
      const members = [...match[2]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
      if (members.length < 2) continue;
      const at = source.slice(0, match.index).split("\n").length;
      found.push({ where: `${relative}:${at}`, name: match[1]!, members });
    }
  }
  return found;
}

/**
 * Every inline union of two or more string literals, wherever it stands.
 *
 * `unions()` above only sees a `type X = "a" | "b";` alias. The same set
 * restated as a property type — `policy: "standalone" | "sum_of_children";` —
 * is the identical defect and was invisible to it, which is how nine of them
 * accumulated: four response shapes in the client, the log level in three
 * places, and `initialType`, `kind` and `mode`.
 *
 * The position is anchored on what can precede a type: a `:` for a property or
 * an annotation, a `(` or `,` for a parameter, a `<` for a type argument.
 */
function inlineUnions() {
  const found: { where: string; members: string[]; text: string }[] = [];
  for (const relative of SOURCES) {
    const source = readFileSync(relative, "utf8");
    for (const match of source.matchAll(/(?:^|[:(<,])\s*("[^"\n]+"(?:\s*\|\s*"[^"\n]+")+)/g)) {
      const members = [...match[1]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
      const at = source.slice(0, match.index).split("\n").length;
      found.push({ where: `${relative}:${at}`, members, text: match[1]! });
    }
  }
  return found;
}

/**
 * An inline union that equals a tuple and is deliberately not derived from it.
 *
 * Empty, and that is the point: every one that existed had the shared type
 * already in scope. A new entry has to argue that the two sets are the same
 * members by coincidence rather than by meaning.
 */
const COINCIDENCE = new Set<string>([]);

/** Every `z.enum` written as a literal array of strings. */
function literalEnums() {
  const found: { where: string; members: string[] }[] = [];
  for (const relative of SOURCES) {
    const source = readFileSync(relative, "utf8");
    for (const match of source.matchAll(/\.enum\(\s*\[([^\]]*)\]/g)) {
      if (match[1]!.replaceAll(/"[^"]*"|[\s,]/g, "") !== "") continue;
      const members = [...match[1]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
      if (members.length < 2) continue;
      const at = source.slice(0, match.index).split("\n").length;
      found.push({ where: `${relative}:${at}`, members });
    }
  }
  return found;
}

/**
 * Two sets that share their words without being one set. A key here is the
 * members sorted and joined by a space, and it has to be argued.
 */
const SHARED_WORDS: Record<string, string> = {
  "archive delete":
    "An account card's row actions and a category row's: each page's own, decided by what that page offers, which happens to be the same two words today.",
};

describe("a closed set", () => {
  it("is not also spelled as a bare union somewhere else", () => {
    const byMembers = tuples();
    expect(byMembers.size, "no tuples found, so this examined nothing").toBeGreaterThan(10);
    const duplicated = unions()
      .filter((union) => byMembers.has(key(union.members)))
      .map(
        (union) =>
          `${union.where} ${union.name} restates ${byMembers.get(key(union.members))!.join(", ")}`,
      );
    expect(duplicated).toEqual([]);
  });

  it("is not restated inline where a property or a parameter takes it", () => {
    const byMembers = tuples();
    const restated = inlineUnions()
      .filter((union) => !COINCIDENCE.has(union.where))
      .filter((union) => byMembers.has(key(union.members)))
      .map(
        (union) =>
          `${union.where} spells out ${byMembers.get(key(union.members))!.join(", ")}: ${union.text}`,
      );
    expect(restated).toEqual([]);
  });

  /**
   * And a set nobody wrote a tuple for, spelled more than once.
   *
   * The two checks above ask whether a union restates a tuple that exists, so
   * a set with no tuple could be spelled any number of times — and five were,
   * across a service, its MCP output schema and the client. A member added to
   * the service alone then fails the tool with an output validation error,
   * which is how `staged_status` went wrong. Every spelling counts: a type
   * alias, an inline union and a `z.enum` of literals. A key list inside
   * `Pick` or `Omit` does not, because it names properties rather than values.
   */
  it("is spelled once even where nothing has written its tuple", () => {
    const tupled = tuples();
    const spellings = new Map<string, string[]>();
    const add = (members: readonly string[], where: string) =>
      spellings.set(key(members), [...(spellings.get(key(members)) ?? []), where]);
    for (const union of unions()) add(union.members, union.where);
    for (const union of inlineUnions()) {
      const [relative, line] = union.where.split(":") as [string, string];
      const before = readFileSync(relative, "utf8").split("\n")[Number(line) - 1] ?? "";
      if (/\b(?:Pick|Omit)<[^<>]*,\s*"/.test(before)) continue;
      add(union.members, union.where);
    }
    for (const literal of literalEnums()) add(literal.members, literal.where);
    expect(spellings.size, "no spellings found, so this examined nothing").toBeGreaterThan(20);
    const twice = [...spellings]
      .filter(([members, where]) => where.length > 1 && !tupled.has(members))
      .filter(([members]) => !(members in SHARED_WORDS))
      .map(([members, where]) => `{${members}} at ${where.join(", ")}`);
    expect(twice, "give the set one tuple, or one named type, and use it").toEqual([]);
  });

  it("names a shared-words exception only while the words are still shared", () => {
    const counted = new Map<string, number>();
    for (const union of [...unions(), ...inlineUnions(), ...literalEnums()]) {
      counted.set(key(union.members), (counted.get(key(union.members)) ?? 0) + 1);
    }
    for (const members of Object.keys(SHARED_WORDS)) {
      expect(counted.get(members) ?? 0, `${members} is no longer spelled twice`).toBeGreaterThan(1);
    }
  });

  /**
   * And the one copy the typechecker cannot see.
   *
   * `pgEnum("name", [...])` takes an array literal, so a value added to the
   * shared tuple and not to the enum compiles everywhere and is refused by the
   * database at run time — a defect that reaches production green. Passing the
   * tuple is what makes the two one thing.
   */
  it("reaches a pgEnum by name, never as a literal", () => {
    const schema = readFileSync("src/server/db/schema.ts", "utf8");
    const literals = [...schema.matchAll(/pgEnum\(\s*"[^"]+",\s*\[/g)].map((one) => one[0]);
    expect(literals).toEqual([]);
    // And there are enums to have got wrong.
    expect([...schema.matchAll(/pgEnum\(/g)].length).toBeGreaterThan(5);
  });
});
