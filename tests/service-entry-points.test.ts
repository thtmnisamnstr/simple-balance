import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A service function takes an actor first, and the ones that cannot say why.
 *
 * `services.md` 1.1 is where this rule lives, and `AGENTS.md` is the authority:
 * "Never accept a public `userId`. Derive it from the authenticated `Actor`, and
 * scope every finance read/write by that ID." The second half is the half that
 * does the work — a rule about a parameter would be satisfied by a function that
 * takes an actor and then queries without it.
 *
 * A handful of entry points have no actor to take, because no request made them
 * run. The guide named two of them in prose and there are five, which is how a
 * list in a paragraph goes: it was right when it was written and nothing asked
 * it again. `pruneIdempotencyRecords` is the fifth and arrived after the
 * sentence. So the list is here, one line of reason each, and the value is the
 * sixth.
 */
const SERVICES = globSync("src/server/services/*.ts").sort();

/**
 * Entry points with no actor, and why each one has none.
 *
 * Every one of these is either a scheduled sweep — nobody's request started it,
 * so there is nobody to derive an actor from — or the account-deletion
 * exception `services.md` 1.1 already names.
 */
const NO_ACTOR_TO_TAKE = new Map([
  [
    "reconcileArchivedAccountClosings",
    "A repair of somebody's postings, run at startup rather than by a request",
  ],
  ["pruneAbandonedClients", "A scheduled sweep of OAuth clients nobody completed"],
  ["pruneIdempotencyRecords", "The retention sweep, on the scheduler's tick"],
  ["runDueNotifications", "The reminder sweep, on the scheduler's tick"],
  ["runDueRecurrences", "The proposal sweep, on the scheduler's tick"],
  [
    "revokeAllConnectedApps",
    "Takes a userId, and is reached from a session or a password reset rather than from a request naming one — the exception services.md 1.1 names",
  ],
]);

/** One function's body, brace-balanced from the `{` that opens it. */
function bodyAfter(source: string, from: number) {
  let index = source.indexOf("{", from);
  if (index === -1) return "";
  let depth = 0;
  const start = index;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) break;
  }
  return source.slice(start, index + 1);
}

describe("a service function", () => {
  it("takes an actor first, or is on the list of the ones with none to take", () => {
    const unexplained: string[] = [];
    let checked = 0;
    for (const file of SERVICES) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/export (?:async )?function (\w+)\s*\(\s*([^),]*)/gs)) {
        const first = match[2].replace(/\s+/g, " ").trim();
        if (/^actor\s*:/.test(first)) {
          checked += 1;
          continue;
        }
        // The second sanctioned shape: a helper whose first parameter is spelled
        // to admit the pool as well as a transaction. `services.md` 1.1 calls
        // these "the second row under another name".
        if (/^(?:tx|db|executor)\s*:/.test(first) || /Database|DbTransaction/.test(first)) continue;
        const body = bodyAfter(source, match.index + match[0].length).replace(
          /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
          "",
        );
        // Its own reach for the database rather than a mention anywhere inside:
        // `balanceStatement` builds a `sql` fragment and takes a `userId`, and a
        // query builder is not an entry point. Both `getDb()` and
        // `withTransaction`, because the second is how a function that may be
        // handed a transaction opens its own.
        if (!/\bgetDb\(\)|\bwithTransaction\(/.test(body)) continue;
        checked += 1;
        if (!NO_ACTOR_TO_TAKE.has(match[1]!)) {
          unexplained.push(`${file}: ${match[1]}(${first.slice(0, 40)})`);
        }
      }
    }
    // The great majority take an actor, so this is not passing by examining
    // nothing.
    expect(checked).toBeGreaterThan(60);
    expect(
      unexplained,
      "take an actor first, or say in NO_ACTOR_TO_TAKE why there is none",
    ).toEqual([]);
  });

  it("keeps that list to the functions that still exist", () => {
    // A name left behind after the sweep it excused was renamed is the list
    // drifting the way the paragraph it replaced did.
    const everything = SERVICES.map((file) => readFileSync(file, "utf8")).join("\n");
    const stale = [...NO_ACTOR_TO_TAKE.keys()].filter(
      (name) => !new RegExp(`export (?:async )?function ${name}\\b`).test(everything),
    );
    expect(stale, "these are excused and gone").toEqual([]);
  });

  it("is the list the guide names", () => {
    // `services.md` 1.1 names them in prose as well, because a reader meets the
    // paragraph before the test. The two came apart once already.
    const guide = readFileSync("docs/standards/code/services.md", "utf8");
    // The table, not the page. The paragraph above it names one of these by way
    // of explaining how the list fell behind, so a page-wide search is
    // satisfied by the story rather than by the list — which is the same class
    // of mistake this check exists to catch.
    const rows = [...guide.matchAll(/^\| `(\w+)` \| [^|]+\|$/gm)].map((row) => row[1]!);
    const missing = [...NO_ACTOR_TO_TAKE.keys()].filter((name) => !rows.includes(name));
    expect(missing, "name these in services.md 1.1's table too").toEqual([]);
  });
});
