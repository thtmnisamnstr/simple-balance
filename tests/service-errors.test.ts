import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `docs/standards/code/errors.md` 1, which argues the rule this holds to: a
 * bare `Error` in a service means "this cannot happen" and becomes a 500, and
 * anything a caller could have got right is an `AppError` instead.
 *
 * A blanket ban would be wrong, because which kind a throw is cannot be read
 * off its syntax — it would flag every correct one below. So this is not a ban
 * but a list, each entry carrying the reason it is the impossible kind, and one
 * more throw fails until somebody writes down which kind it is. The judgement
 * stays where only a person can make it, at the moment of writing the throw,
 * and the thing that used to be invisible — a validation refusal dressed as a
 * 500 — now has to be argued for in a diff.
 *
 * Whether a listed reason is honest is still review. Whether a new throw was
 * thought about at all is now this test.
 */
const IMPOSSIBLE = [
  {
    where: "src/server/services/helpers.ts",
    message: "Idempotency payload numbers must be finite",
    because: "The canonicalizer has already refused anything that is not a JSON number.",
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
  {
    where: "src/server/services/billing.ts",
    message: "Stripe is not configured on this deployment",
    because:
      "Every caller is reached from a route registered only when Stripe is configured. Getting here means the code asked the wrong question, not that the deployment is wrong — and there is nothing an operator could do about a refusal on a route that would not exist.",
  },
  {
    where: "src/server/services/billing.ts",
    message: "No such user",
    because:
      "The actor came from an authenticated session or token, so the row it names was read moments earlier to build it.",
  },
  {
    where: "src/server/services/billing.ts",
    message: "Billing customer disappeared between insert and read",
    because:
      "The insert lost its conflict, which means a row exists; only a delete between the two statements could empty it, and nothing deletes one but account deletion, which cannot run for somebody mid-request.",
  },
  {
    where: "src/server/services/billing.ts",
    message: "Stripe returned a subscription with no items",
    because:
      "Every subscription this product creates carries exactly one price, and Stripe has no way to produce one with none.",
  },
];

type Throw = { where: string; text: string };

const bareThrows: Throw[] = sourceFiles("src/server/services").flatMap((file) =>
  [...file.code.matchAll(/\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError)\s*\(/g)].map(
    (match) => ({
      where: file.path,
      // Enough of the line to recognize, and the message is what the list below
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
  // throw that has been fixed or deleted must not leave its license behind for
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

/**
 * One code, one status.
 *
 * `http.md` publishes the enumeration as the thing a client branches on, and a
 * code that means two statuses cannot be branched on: `VALIDATION_ERROR` was
 * 422 from `validationError()` and 400 from the JSON body reader, so the same
 * word meant "your body is not JSON" and "your body is JSON and wrong". Adding
 * `MALFORMED_BODY` fixed it; this stops the next one.
 */
describe("the code-to-status map", () => {
  it("gives each error code exactly one status", () => {
    const byCode = new Map<string, Set<number>>();
    for (const file of sourceFiles("src/server")) {
      for (const match of file.code.matchAll(
        /new (?:App|Transport)Error\(\s*"([A-Z_]+)"\s*,[^)]*?,\s*(\d{3})/gs,
      )) {
        const [, code, status] = match;
        byCode.set(code!, (byCode.get(code!) ?? new Set()).add(Number(status)));
      }
    }
    expect(byCode.size, "no throw sites found — the pattern has stopped matching").toBeGreaterThan(
      2,
    );
    const ambiguous = [...byCode.entries()]
      .filter(([, statuses]) => statuses.size > 1)
      .map(([code, statuses]) => `${code} means ${[...statuses].sort().join(" and ")}`);
    expect(ambiguous).toEqual([]);
  });

  /**
   * The two sanctioned constructors, and nothing else building a body by hand.
   *
   * An error shape assembled at a route is an error shape no enumeration covers
   * — which is how a sixth transport code reached the wire once before.
   *
   * The two places are `api.ts`'s renderer, with the auth routes' builder that
   * sits beside it, and `errorResponse` in `http-security.ts`.
   *
   * This used to excuse the whole of `src/server/api.ts`, which is the file the
   * routes are registered in, so a body built by hand at any route passed for
   * being in the renderer's file. And it saw only a quoted code, so an envelope
   * with its code in a variable — `{ error: { code, message } }` — was invisible
   * in every file. So what is excused now is a construct, found by the
   * top-level statement an envelope is built inside and counted, and an
   * envelope is any `error: {` whose code is not a number: JSON-RPC's
   * `code: -32000` on the `/mcp` mount is a different protocol's error object
   * and is not this enumeration's business.
   */
  it("builds an error body in the two places that are allowed to", () => {
    const TRANSPORT_LEVEL = [
      {
        where: "src/server/api.ts",
        statement: "export function errorEnvelope(",
        times: 4,
        because:
          "The one renderer every thrown error goes through, for a response and for a " +
          "streamed frame alike: a branch per class it knows, and INTERNAL_ERROR for the rest.",
      },
      {
        where: "src/server/api.ts",
        statement: "const transportError = ",
        times: 1,
        because:
          "The auth routes' refusal, answered before any service is reached, which keeps the " +
          "flat {code, message} pair beside the envelope so a 0.1.5 client still finds it.",
      },
      {
        where: "src/server/http-security.ts",
        statement: "function errorResponse(",
        times: 1,
        because: "Its code is typed TransportErrorCode, so a transport refusal cannot invent one.",
      },
    ];

    const excused = TRANSPORT_LEVEL;

    // Counted per statement, so a second envelope inside an excused one is a
    // new decision rather than a passenger on the old one.
    const built = new Map<
      string,
      { where: string; line: number; statement: string; times: number }
    >();
    for (const file of sourceFiles("src/server")) {
      const lines = file.code.split("\n");
      for (const match of file.code.matchAll(
        /\berror\s*:\s*(?:[^{}\n]*\?\s*)?\{(?:[^{}]*?[,\s])?code\s*(?:[,}]|:(?!\s*-?\d))/g,
      )) {
        // The formatter starts every top-level statement at column zero and
        // indents everything inside one, so the nearest such line above is the
        // statement this envelope is part of. `topLevelDeclarations` is not
        // enough here: it knows `function` and `const`, and a route
        // registration would fall into whichever declaration preceded it.
        let index = file.code.slice(0, match.index).split("\n").length - 1;
        while (index > 0 && !/^[A-Za-z_$]/.test(lines[index]!)) index -= 1;
        const statement = lines[index]!.trimEnd();
        const key = `${file.path} ${statement}`;
        const seen = built.get(key) ?? { where: file.path, line: index + 1, statement, times: 0 };
        seen.times += 1;
        built.set(key, seen);
      }
    }

    const owner = (site: { where: string; statement: string }) =>
      excused.find(
        (known) => known.where === site.where && site.statement.startsWith(known.statement),
      );
    const unexcused = [...built.values()]
      .filter((site) => owner(site)?.times !== site.times)
      .map((site) => `${site.where}:${site.line} ${site.statement} builds ${site.times}`);
    expect(
      unexcused,
      "build an error body by throwing a TransportError or an AppError for errorEnvelope to " +
        "render, or through errorResponse; a new constructor goes in TRANSPORT_LEVEL with its reason",
    ).toEqual([]);

    // The other half: an entry outliving its statement licenses the next one,
    // and an empty scan would otherwise pass for a clean one.
    const stale = excused
      .filter((known) => ![...built.values()].some((site) => owner(site) === known))
      .map((known) => `${known.where} ${known.statement}`);
    expect(stale).toEqual([]);
  });
});
