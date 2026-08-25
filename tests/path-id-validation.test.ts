import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * An id out of the URL has to be checked before it reaches a query.
 *
 * Left unchecked it travels to PostgreSQL as a uuid cast, fails there, and
 * comes back to the caller as an unexplained 500 while writing a stack trace
 * into the log — all for a mistyped URL. Every `/:id` route did this until the
 * path parameters were parsed at the boundary.
 *
 * Checked by reading the source rather than by standing a server up, so that a
 * route added later without the helper fails here rather than in production.
 */
describe("ids taken out of the URL", () => {
  it("never reaches a query straight from the path", async () => {
    const source = await readFile(new URL("../src/server/api.ts", import.meta.url), "utf8");
    const raw = [...source.matchAll(/c\.req\.param\("(\w+)"\)/g)].map((match) => match[1]!);
    // clientId is an OAuth client identifier rather than a uuid, and the route
    // that takes it compares it as text. report names one of a closed set and
    // is parsed against that set at the boundary, so neither reaches a cast.
    const checkedElsewhere = new Set(["clientId", "report"]);
    expect(raw.filter((name) => !checkedElsewhere.has(name))).toEqual([]);
  });

  it("routes every uuid path parameter through the same check", async () => {
    const source = await readFile(new URL("../src/server/api.ts", import.meta.url), "utf8");
    // A path kept alive across a rename carries no handler of its own — it is
    // registered against the same one as its replacement, which is where the
    // check lives — so counting it here would demand a `pathId` call that would
    // be a second parse of the same id.
    const idRoutes = [
      ...source.matchAll(/app\.\w+\(\s*"(\/api\/v1[^"]*:id[^"]*)",\s*(deprecated\()?/g),
    ].filter((match) => !match[2]);
    expect(idRoutes.length).toBeGreaterThan(10);
    expect(source).toContain("uuidPathSchema");
    expect(source.match(/pathId\(c/g)?.length).toBeGreaterThanOrEqual(idRoutes.length);
  });
});
