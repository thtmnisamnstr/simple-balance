import { describe, expect, it } from "vitest";
import { sourceFiles, topLevelDeclarations } from "./support/source.js";

/**
 * `docs/standards/code/errors.md` 2 and 2.4, the two halves a type cannot hold.
 *
 * `ServiceErrorCode` already admits `FORBIDDEN` and `REAUTHENTICATION_REQUIRED`
 * (`src/shared/domain.ts:2597`), so `new AppError("FORBIDDEN", …)` type-checks
 * anywhere under `src/server`: what the compiler refuses is a *transport* code
 * in an `AppError`, and nothing else. Who may construct one, and who may hand a
 * second audience its own sentence, are populations rather than types — so they
 * are counted here, the way `tests/service-errors.test.ts` counts bare throws.
 */

/** Where the second audience has been argued for, and what the agent is given. */
const SECOND_AUDIENCE = [
  {
    where: "src/server/services/accounts.ts",
    declaration: "assertAccountAllowance",
    raises: "conflict",
    times: 1,
    because:
      "The move that works is buying a plan, and buying one is session-only by AGENTS.md. " +
      "An agent told to upgrade is told to do something it holds no credential for, so it " +
      "is told the number and who to ask instead.",
  },
  {
    where: "src/server/services/accounts.ts",
    declaration: "setAccountArchived",
    raises: "conflict",
    times: 1,
    because:
      "The same ceiling met from the other side: coming out of the archive needs a free " +
      "place. Here the move that works is one an agent can make, so it is named — archive " +
      "or delete an account that is in use — rather than the browser's upgrade.",
  },
  {
    where: "src/server/services/accounts.ts",
    declaration: "assertAccountsWritable",
    raises: "validationError",
    times: 1,
    because:
      "A frozen account arrives under the code that means 'fix the arguments', and no " +
      "argument an agent can change gets past it. The browser is offered activating or " +
      "upgrading; the agent is told which tools report the freeze and what ends it.",
  },
  {
    where: "src/server/services/accounts.ts",
    declaration: "setActiveAccounts",
    raises: "conflict",
    times: 1,
    because:
      "The other direction: this is a call an agent can make, so the refusal names it and " +
      "says what a valid one looks like rather than handing the job to a person.",
  },
  {
    where: "src/server/services/billing.ts",
    declaration: "closeBillingForDeletion",
    raises: "conflict",
    times: 2,
    because:
      "Two refusals, and the browser half of each sends the person to whoever runs the " +
      "server. The agent half names the cause instead — keys that cannot vouch for the " +
      "answer, or Stripe unreachable — and says whether retrying helps. Reached today " +
      "only from the session-only deletion path, so nothing renders these yet; they are " +
      "right if that ever widens, and wrong to leave as the browser's sentence.",
  },
];

/** The throws those entries stand for, which is more than the entries. */
const EXPECTED_SITES = SECOND_AUDIENCE.reduce((total, known) => total + known.times, 0);

type Call = { where: string; declaration: string; raises: string };

/** Every `conflict(…)` or `validationError(…)` given a third argument. */
const secondAudienceCalls = (): Call[] => {
  const found: Call[] = [];
  for (const file of sourceFiles("src/server/services")) {
    for (const declaration of topLevelDeclarations(file)) {
      for (const match of declaration.body.matchAll(/\b(conflict|validationError)\(/g)) {
        const open = match.index + match[0]!.length - 1;
        if (topLevelArguments(declaration.body, open) < 3) continue;
        found.push({
          where: file.path,
          declaration: declaration.name,
          raises: match[1]!,
        });
      }
    }
  }
  return found;
};

describe("a refusal that carries a sentence for an agent", () => {
  it("carries one only where somebody has written down why", () => {
    const unargued = secondAudienceCalls()
      .filter(
        (call) =>
          !SECOND_AUDIENCE.some(
            (known) =>
              known.where === call.where &&
              known.declaration === call.declaration &&
              known.raises === call.raises,
          ),
      )
      .map((call) => `${call.where} ${call.declaration} → ${call.raises}`);
    expect(
      unargued,
      "a second sentence is for a refusal whose remedy the two callers cannot both reach; " +
        "if the advice is the same for everyone, leave it off, and if it is not, add the " +
        "site to SECOND_AUDIENCE with the reason",
    ).toEqual([]);
  });

  // The other half of the ratchet, the shape `tests/service-errors.test.ts`
  // uses: an entry for a site that has gone must not sit there licensing the
  // next one.
  it("has no entry standing for a site that no longer passes one", () => {
    const calls = secondAudienceCalls();
    const stale = SECOND_AUDIENCE.filter(
      (known) =>
        !calls.some(
          (call) =>
            call.where === known.where &&
            call.declaration === known.declaration &&
            call.raises === known.raises,
        ),
    ).map((known) => `${known.where} ${known.declaration}`);
    expect(stale).toEqual([]);
  });

  it("is counted, so a scan that stopped matching cannot pass for a clean one", () => {
    expect(secondAudienceCalls()).toHaveLength(EXPECTED_SITES);
  });

  /**
   * The constraint the rule carries that the prose cannot: the agent half may
   * not name a field the refusal is not carrying.
   *
   * Thirteen of the fifty-three `staleVersion` sites send no details, which is
   * why `carries` exists; pointing an agent at `details.currentVersion` when
   * nothing is there is the "offer the move that works" rule failing one field
   * deeper. So a sentence naming `details.x` has to sit in a declaration that
   * either guards on `x` or builds it.
   */
  it("names no details field the declaration neither guards nor builds", () => {
    const unguarded: string[] = [];
    for (const file of sourceFiles("src/server")) {
      for (const declaration of topLevelDeclarations(file)) {
        for (const literal of stringLiterals(declaration.body)) {
          for (const named of literal.matchAll(/details\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
            const key = named[1]!;
            const evidence = new RegExp(`carries\\(details,\\s*"${key}"\\)|\\b${key}\\s*:`);
            if (!evidence.test(declaration.body)) {
              unguarded.push(`${file.path} ${declaration.name} → details.${key}`);
            }
          }
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  /**
   * Only the MCP transport reads it. HTTP rendering it as well would change
   * browser copy silently, which is the whole reason the field is separate from
   * `message` rather than replacing it.
   */
  it("is rendered by the MCP transport and by nothing else", () => {
    const readers = [
      ...sourceFiles("src/server"),
      ...sourceFiles("src/client"),
      ...sourceFiles("src/shared"),
    ]
      .filter((file) => /\bagentMessage\b/.test(file.code))
      .map((file) => file.path);
    expect(readers).toEqual(["src/server/mcp.ts", "src/server/services/errors.ts"]);
  });
});

/** Every `new AppError(…)` or `new TransportError(…)`, with the code it names. */
const constructions = (type: "AppError" | "TransportError") =>
  sourceFiles("src/server").flatMap((file) =>
    [...file.code.matchAll(new RegExp(`new ${type}\\(\\s*"([A-Z_]+)"`, "g"))].map((match) => ({
      where: file.path,
      code: match[1]!,
    })),
  );

describe("constructing an error by hand", () => {
  /**
   * `errors.md` 2's named exception, held to the two lines it claims.
   *
   * Both are about signing in rather than about the ledger, and both are on the
   * one route `AGENTS.md` keeps to a session. A third would be a service-shaped
   * refusal built outside the constructors, which is what the rule is for.
   */
  it("happens in the constructor module and at two transport lines", () => {
    const outside = constructions("AppError").filter(
      (site) => site.where !== "src/server/services/errors.ts",
    );
    expect(outside).toEqual([
      { where: "src/server/api.ts", code: "FORBIDDEN" },
      { where: "src/server/api.ts", code: "REAUTHENTICATION_REQUIRED" },
    ]);
  });

  // The transport half of the same count. `MALFORMED_BODY` is the one transport
  // refusal a route raises by throwing rather than by returning.
  it("builds the one TransportError a route throws, and no other", () => {
    expect(
      constructions("TransportError").filter(
        (site) => site.where !== "src/server/services/errors.ts",
      ),
    ).toEqual([{ where: "src/server/api.ts", code: "MALFORMED_BODY" }]);
  });

  it("never happens in a service", () => {
    const inServices = [...constructions("AppError"), ...constructions("TransportError")].filter(
      (site) =>
        site.where.startsWith("src/server/services/") &&
        site.where !== "src/server/services/errors.ts",
    );
    expect(
      inServices.map((site) => `${site.where} ${site.code}`),
      "a service names the situation with one of the five constructors",
    ).toEqual([]);
  });
});

/**
 * How many arguments the call opening at `open` was given.
 *
 * A regular expression cannot do this: the sentences these calls carry are
 * template literals holding `${…}`, commas and parentheses of their own, so the
 * count has to come from a scan that knows where a string starts. Comments are
 * already blanked by `sourceFiles`, which leaves strings as the only hazard.
 *
 * The blank segments are dropped at the end rather than the commas counted,
 * because `oxfmt` puts a trailing comma after the last argument of every call
 * it breaks over lines — which is most of these. Counting commas read every
 * two-argument refusal as a three-argument one.
 */
function topLevelArguments(code: string, open: number): number {
  const segments: string[] = [];
  let depth = 0;
  let start = open + 1;
  let index = open;
  while (index < code.length) {
    const character = code[index]!;
    if (character === '"' || character === "'") {
      index = skipString(code, index, character);
      continue;
    }
    if (character === "`") {
      index = skipTemplate(code, index);
      continue;
    }
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) {
        segments.push(code.slice(start, index));
        break;
      }
      index += 1;
      continue;
    }
    if (character === "," && depth === 1) {
      segments.push(code.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  return segments.filter((segment) => segment.trim() !== "").length;
}

/** Every string literal's contents, for a rule about what a sentence says. */
function stringLiterals(code: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < code.length) {
    const character = code[index]!;
    if (character === '"' || character === "'") {
      const end = skipString(code, index, character);
      found.push(code.slice(index + 1, end - 1));
      index = end;
      continue;
    }
    if (character === "`") {
      const end = skipTemplate(code, index);
      found.push(code.slice(index + 1, end - 1));
      index = end;
      continue;
    }
    index += 1;
  }
  return found;
}

/** The index just past the string opening at `start`. */
function skipString(code: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < code.length) {
    const character = code[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\n") return index;
    if (character === quote) return index + 1;
    index += 1;
  }
  return index;
}

/** The index just past the template literal opening at `start`, `${…}` and all. */
function skipTemplate(code: string, start: number): number {
  let index = start + 1;
  while (index < code.length) {
    const character = code[index]!;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") return index + 1;
    if (character === "$" && code[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < code.length && depth > 0) {
        const inner = code[index]!;
        if (inner === '"' || inner === "'") {
          index = skipString(code, index, inner);
          continue;
        }
        if (inner === "`") {
          index = skipTemplate(code, index);
          continue;
        }
        if (inner === "{") depth += 1;
        if (inner === "}") depth -= 1;
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return index;
}
