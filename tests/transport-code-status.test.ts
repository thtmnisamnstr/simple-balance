import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * One code, one status — at the two places that name a status in a transport.
 *
 * `http.md` §Errors publishes the code enumeration as the thing a client
 * branches on, and says what the existing check cannot see: it reads
 * `new AppError(` and `new TransportError(`, "which is where a *service* names
 * a status. It sees neither of the two places a *transport* does: the
 * `errorResponse(context, status, code, …)` call sites in
 * `src/server/http-security.ts`, where the status is the second argument, and
 * `transportError(code, message)` in `src/server/api.ts`, where the status is a
 * literal on the `c.json(…, 4xx)` beside it. Those two carry twenty-three
 * refusals between them, and the sentence above is why nobody looked at them."
 *
 * This looks at them. §What is checked item 2 asks for exactly this and says
 * it "fails today on the `UNAUTHORIZED` 400/401 split", which it did: the two
 * OAuth consent routes answered 401 and the Stripe webhook's signature refusal
 * answered 400, both under one word. A client cannot branch on a code that does
 * not decide, which is the whole reason the enumeration is published.
 *
 * **Scope.** One code, one status, over every refusal these two shapes make —
 * the auth and consent routes included, because the rule is about a word
 * meaning one thing and that holds wherever the word is used. The *other* half
 * of §Errors, that every code is in the published enumeration, is deliberately
 * not here: `apiErrorCodes` scopes itself to what a caller reads off
 * `/api/v1`, and eight codes reaching a caller from `/api/auth` are outside it
 * by design. A check conflating the two would report eight failures on correct
 * code and be deleted.
 */

const server = sourceFiles("src/server");

/** The index of the `)` closing the `(` at `from`, quotes and nesting respected. */
function closingParen(code: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < code.length; index += 1) {
    const character = code[index]!;
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

type Refusal = { file: string; line: number; code: string; status: number; shape: string };

const refusals: Refusal[] = server.flatMap((file) => {
  const found: Refusal[] = [];
  const lineAt = (index: number) => file.code.slice(0, index).split("\n").length;

  // `errorResponse(context, status, code, message)`: the status is the second
  // argument and the code the third, both literals at every call site.
  for (const match of file.code.matchAll(
    /\berrorResponse\(\s*[A-Za-z_$][\w$]*\s*,\s*(\d{3})\s*,\s*"([A-Z_]+)"/g,
  )) {
    found.push({
      file: file.path,
      line: lineAt(match.index),
      code: match[2]!,
      status: Number(match[1]!),
      shape: "errorResponse",
    });
  }

  // `transportError(code, message)` wrapped in `c.json(…, status)`. The status
  // is read forward from the call's own closing paren rather than by a window
  // of n characters: a message here may be a multi-line conditional, and a
  // fixed window would stop inside one and report the status missing.
  for (const match of file.code.matchAll(/\btransportError\(\s*"([A-Z_]+)"/g)) {
    const open = file.code.indexOf("(", match.index);
    const close = closingParen(file.code, open);
    if (close === -1) continue;
    const status = /^\s*,\s*(\d{3})\s*[,)]/.exec(file.code.slice(close + 1));
    if (!status) continue;
    found.push({
      file: file.path,
      line: lineAt(match.index),
      code: match[1]!,
      status: Number(status[1]!),
      shape: "transportError",
    });
  }
  return found;
});

describe("the statuses a transport names", () => {
  /**
   * The population, before the verdict.
   *
   * `http.md` counts these: "Those two carry twenty-three refusals between
   * them." A parser that silently stopped reading one of the two shapes — the
   * multi-line `c.json` wrapper is the fragile half — would report no ambiguity
   * and look like a pass. So the count is asserted against the guide's own
   * figure, and both shapes have to be present.
   */
  it("reads every refusal both shapes make", () => {
    expect(refusals.filter((one) => one.shape === "errorResponse").length).toBeGreaterThanOrEqual(
      8,
    );
    expect(refusals.filter((one) => one.shape === "transportError").length).toBeGreaterThanOrEqual(
      15,
    );
    expect(refusals.length).toBeGreaterThanOrEqual(23);
    // Including the two that are hardest to read: a status past a multi-line
    // conditional message, and one on a route in a different file.
    expect(refusals.some((one) => one.code === "REGISTRATION_CLOSED" && one.status === 403)).toBe(
      true,
    );
    expect(refusals.some((one) => one.file.endsWith("http-security.ts"))).toBe(true);
    expect(refusals.some((one) => one.file.endsWith("api.ts"))).toBe(true);
  });

  it("gives each code exactly one status", () => {
    const byCode = new Map<string, Map<number, string[]>>();
    for (const refusal of refusals) {
      const statuses = byCode.get(refusal.code) ?? new Map<number, string[]>();
      statuses.set(refusal.status, [
        ...(statuses.get(refusal.status) ?? []),
        `${refusal.file}:${refusal.line}`,
      ]);
      byCode.set(refusal.code, statuses);
    }
    const ambiguous = [...byCode.entries()]
      .filter(([, statuses]) => statuses.size > 1)
      .map(
        ([code, statuses]) =>
          `${code} means ${[...statuses.entries()]
            .sort(([a], [b]) => a - b)
            .map(([status, sites]) => `${status} (${sites.join(", ")})`)
            .join(" and ")}`,
      );
    expect(ambiguous).toEqual([]);
  });
});
