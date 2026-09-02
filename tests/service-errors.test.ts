import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/errors.md` 1: anything a caller could act on is an
 * `AppError`, and a bare `Error` means "this cannot happen" and becomes a 500.
 *
 * The guide marks this `human` and gives the reason: a rule banning
 * `throw new Error` under `src/server/services` "would be **wrong** — it would
 * flag the five correct ones. Which kind a throw is cannot be read off its
 * syntax." That is true, and it is an argument against the ban rather than
 * against every check.
 *
 * So this is not a ban. It is a list of the five, each with the reason it is
 * the impossible kind, and a sixth fails until somebody says which kind it is.
 * The judgement stays where only a person can make it — at the moment of
 * writing the throw — and the thing that used to be invisible, a validation
 * refusal dressed as a 500, now has to be argued for in a diff.
 *
 * Whether a listed reason is honest is still review. Whether a new throw was
 * thought about at all is now this test.
 */
const IMPOSSIBLE = [
  {
    where: "src/server/services/helpers.ts",
    message: "Idempotency payload numbers must be finite",
    because: "The canonicaliser has already refused anything that is not a JSON number.",
  },
  {
    where: "src/server/services/helpers.ts",
    message: "Unsupported idempotency payload value",
    because: "Every JSON type is handled above it, so the fall-through is unreachable.",
  },
  {
    where: "src/server/services/helpers.ts",
    message: "Idempotency payload must be JSON serializable",
    because: "The payload arrived as parsed JSON, so it round-trips by construction.",
  },
  {
    where: "src/server/services/payees.ts",
    message: "Database returned an invalid payee reference count",
    because: "A count is cast `::int` in SQL; a non-number back means the cast was dropped.",
  },
  {
    where: "src/server/services/categories.ts",
    message: "Database returned an invalid category reference count",
    because: "The same cast, and the same failure if it is ever removed.",
  },
  {
    where: "src/server/services/budgets.ts",
    message: "Budget insert returned no row",
    because:
      "A plain insert().returning() either throws or returns the row; empty means the driver broke. Dressed as a 422 it told somebody their input was wrong.",
  },
  {
    where: "src/server/services/budgets.ts",
    message: "Budget entry insert returned no row",
    because: "The same impossibility one table over.",
  },
  {
    where: "src/server/services/category-groups.ts",
    message: "Category group insert returned no row",
    because: "The same impossibility again.",
  },
];

type Throw = { where: string; text: string };

const bareThrows: Throw[] = sourceFiles("src/server/services").flatMap((file) =>
  [...file.code.matchAll(/\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError)\s*\(/g)].map(
    (match) => ({
      where: file.path,
      // Enough of the line to recognise, and the message is what the list below
      // matches on, so a reworded throw comes back here for a second look.
      text: file.code
        .slice(match.index, match.index + 160)
        .split("\n")[0]!
        .trim(),
    }),
  ),
);

describe("a bare Error in a service", () => {
  it("is one of the ones already argued to be impossible", () => {
    const unlisted = bareThrows
      .filter(
        (thrown) =>
          !IMPOSSIBLE.some(
            (known) => known.where === thrown.where && thrown.text.includes(known.message),
          ),
      )
      .map((thrown) => `${thrown.where} ${thrown.text}`);
    expect(
      unlisted,
      "a bare Error is a 500 and means this cannot happen; if the caller could have got it right, throw an AppError instead, and if it truly cannot, add it to IMPOSSIBLE with the reason",
    ).toEqual([]);
  });

  // The other half of the ratchet, borrowed from `tests/lint-budget.test.ts`: a
  // throw that has been fixed or deleted must not leave its licence behind for
  // the next one to inherit.
  it("has no entry standing for a throw that is no longer there", () => {
    const stale = IMPOSSIBLE.filter(
      (known) =>
        !bareThrows.some(
          (thrown) => thrown.where === known.where && thrown.text.includes(known.message),
        ),
    ).map((known) => `${known.where} ${known.message}`);
    expect(stale).toEqual([]);
  });

  it("is counted, so an empty read cannot pass for a clean one", () => {
    expect(bareThrows).toHaveLength(IMPOSSIBLE.length);
  });
});
