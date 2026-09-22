import { describe, expect, it } from "vitest";
import app from "../src/server/api.js";

/**
 * Which handler a path actually reaches.
 *
 * Every other check on the route table reads `api.ts` as text — the published
 * table, the MCP parity pairs, the scope map. None of them can see *order*,
 * and order is what decides a collection route that sits under a parameter:
 * Hono answers from the first registration that matches, so
 * `PUT /api/v1/accounts/active` registered after `PUT /api/v1/accounts/:id`
 * is matched by the second, `active` is parsed as an id, and the request
 * fails validation before any service runs.
 *
 * That shipped in this feature's first draft and all three tiers were green,
 * because the integration test called the service directly and the route
 * tests were reading source. This asks the router.
 */
const literalCollectionRoutes = [
  ["PUT", "/api/v1/accounts/active"],
  ["GET", "/api/v1/categories/duplicates"],
  ["GET", "/api/v1/categories/summaries"],
] as const;

/** Each entry is `[[handler, route], params]`, in registration order. */
type Matched = [[[unknown, { path: string; method: string }], unknown][], unknown];

/** The path of the first registration that would answer, middleware skipped. */
function answeringPath(method: string, path: string) {
  const [chain] = (
    app as unknown as { router: { match: (m: string, p: string) => Matched } }
  ).router.match(method, path);
  const handler = chain.find(([[, route]]) => route.method.toUpperCase() === method);
  return handler?.[0][1].path;
}

describe("a literal path under a parameter route", () => {
  it("reaches its own handler rather than the parameter's", () => {
    const wrong: string[] = [];
    for (const [method, path] of literalCollectionRoutes) {
      const answering = answeringPath(method, path);
      if (answering !== path) {
        wrong.push(`${method} ${path} — answered by ${answering ?? "nothing"}`);
      }
    }
    expect(wrong, "a literal path is being swallowed by a parameter route").toEqual([]);
  });

  it("can tell the two apart, which is the whole of its value", () => {
    // The check is only worth having if a parameter route really does answer
    // differently. `/api/v1/accounts/<a uuid>` must reach `:id`, or the
    // assertion above would pass whatever the registration order were.
    expect(answeringPath("PUT", "/api/v1/accounts/11111111-2222-3333-4444-555555555555")).toBe(
      "/api/v1/accounts/:id",
    );
  });
});
