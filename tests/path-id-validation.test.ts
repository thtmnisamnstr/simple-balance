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
    const source = await readFile(
      new URL("../src/server/api.ts", import.meta.url),
      "utf8",
    );
    const raw = [...source.matchAll(/c\.req\.param\("(\w+)"\)/g)].map(
      (match) => match[1]!,
    );
    // clientId is an OAuth client identifier rather than a uuid, and the route
    // that takes it compares it as text.
    expect(raw.filter((name) => name !== "clientId")).toEqual([]);
  });

  it("routes every uuid path parameter through the same check", async () => {
    const source = await readFile(
      new URL("../src/server/api.ts", import.meta.url),
      "utf8",
    );
    const idRoutes = [...source.matchAll(/app\.\w+\("(\/api\/v1[^"]*:id[^"]*)"/g)];
    expect(idRoutes.length).toBeGreaterThan(10);
    expect(source).toContain("uuidPathSchema");
    expect(source.match(/pathId\(c/g)?.length).toBeGreaterThanOrEqual(
      idRoutes.length,
    );
  });
});
