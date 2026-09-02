import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * The route tables in `docs/standards/http.md` against the routes the server
 * actually registers.
 *
 * Those tables are the published surface, and until now nothing but somebody
 * reading both files kept them equal to the code. Both ways of drifting apart
 * cost a reader something: a route added without a row reads as private to
 * anybody working from the guide, and a row left behind after a rename sends
 * them at a 404 that the guide told them to expect an answer from.
 *
 * The extraction is the one `tests/mcp-parity.test.ts` already does over the
 * same file, for the same reason it does it there: `src/server/api.ts` is where
 * a route is true, and every other list of them is a claim about that file.
 *
 * Paths are compared with the guide's `{id}` rewritten to Hono's `:id`. The two
 * spellings are a house convention each — a published path names its variable
 * in braces, a router names it with a colon — and neither is worth changing to
 * make a comparison easier.
 */
const guidePath = new URL("../docs/standards/http.md", import.meta.url);
const apiPath = new URL("../src/server/api.ts", import.meta.url);

/**
 * Every route, split into the surface and the paths kept alive for compatibility.
 *
 * A renamed path stays registered against the same handler under its old
 * spelling, so a browser tab left open across the upgrade keeps working. Those
 * old spellings are deliberately the ones the conventions below reject — that is
 * what made them worth renaming — so they are held apart rather than excused
 * one by one.
 */
async function allRoutes() {
  const source = await readFile(apiPath, "utf8");
  const surface: string[] = [];
  const deprecated: { route: string; successor: string }[] = [];
  for (const match of source.matchAll(
    /app\.(get|post|put|delete)\(\s*"(\/api\/v1[^"]*)",\s*(deprecated\("([^"]+)"\))?/g,
  )) {
    const route = `${match[1]!.toUpperCase()} ${match[2]}`;
    if (match[3]) deprecated.push({ route, successor: match[4]! });
    else surface.push(route);
  }
  return { surface, deprecated };
}

async function registeredRoutes() {
  return (await allRoutes()).surface;
}

async function publishedRoutes() {
  const guide = await readFile(guidePath, "utf8");
  return [...guide.matchAll(/^\| `(GET|POST|PUT|DELETE|PATCH) (\/api\/v1[^`]*)` \|/gm)].map(
    (match) => `${match[1]} ${match[2]!.replace(/\{([^}]+)\}/g, ":$1")}`,
  );
}

describe("the published route table", () => {
  it("names every route the server registers", async () => {
    const published = new Set(await publishedRoutes());
    const unpublished = (await registeredRoutes()).filter((route) => !published.has(route));
    expect(unpublished).toEqual([]);
  });

  it("names nothing the server does not register", async () => {
    const registered = new Set(await registeredRoutes());
    const imaginary = (await publishedRoutes()).filter((route) => !registered.has(route));
    expect(imaginary).toEqual([]);
  });

  // A set comparison forgives a duplicated row, and two mistakes that cancel —
  // one route listed twice and another not at all — would leave both checks
  // above green. The tables are a reference somebody scans, so a route sitting
  // in two of them is a defect in its own right.
  it("names each route once", async () => {
    const published = await publishedRoutes();
    const twice = published.filter((route, index) => published.indexOf(route) !== index);
    expect(twice).toEqual([]);
  });
});

/**
 * The three conventions the four renamed paths had drifted from.
 *
 * Each was found by somebody reading both files rather than by anything that
 * fails, and the cost of fixing them was only small because `/api/v1` is
 * cookie-only and same-origin: no client outside this image could have been
 * calling them. That window closes when bearer tokens land, so the point of
 * these three lines is that the drift cannot come back while it is still free
 * to correct.
 */
describe("the conventions the paths follow", () => {
  it("keeps the staged queue under one collection name", async () => {
    const strays = (await registeredRoutes()).filter((route) => /\/staged(\/|$)/.test(route));
    expect(strays).toEqual([]);
  });

  // A route taking `{"archived": boolean}` is a state, and a state gets a state
  // sub-resource rather than a verb, the way `/transactions/{id}/deleted` does.
  it("spells a state change as a state, not as a verb", async () => {
    const verbs = (await registeredRoutes()).filter((route) => route.endsWith("/archive"));
    expect(verbs).toEqual([]);
  });

  // `delete` and `bulk-delete` were the same operation spelled two ways, on two
  // routes that already differ in scope and in what they do to the books. One
  // spelling is enough for a reader to have to learn.
  it("spells an operation over a set as bulk-delete", async () => {
    const strays = (await registeredRoutes()).filter((route) => route.endsWith("/delete"));
    expect(strays).toEqual([]);
  });
});

/**
 * The paths a rename left behind, still answering.
 *
 * `/api/v1` is cookie-only and same-origin, so the argument for renaming rather
 * than deprecating was that the only client which could be calling the old
 * spellings ships in this image. That is true of this image and not of the one
 * already running: a tab left open across the upgrade is serving the previous
 * build, and would have met a 404 on the first archive somebody attempted.
 *
 * So each old path is registered against the same handler as its replacement.
 * These assertions are about that promise being kept rather than about the
 * conventions above, which the old spellings deliberately break.
 */
describe("the paths kept alive across a rename", () => {
  it("names a successor that the server actually registers", async () => {
    const { surface, deprecated } = await allRoutes();
    const missing = deprecated.filter(
      ({ route, successor }) =>
        !surface.includes(
          `${route.slice(0, route.indexOf(" "))} ${successor.replace(/\{([^}]+)\}/g, ":$1")}`,
        ),
    );
    expect(missing).toEqual([]);
  });

  it("keeps every old spelling this release renamed", async () => {
    const { deprecated } = await allRoutes();
    // The four from 0.1.6. A rename that forgets one 404s a live browser flow
    // and nothing else in the suite would notice.
    expect(deprecated.map((entry) => entry.route).sort()).toEqual([
      "GET /api/v1/staged/:id/duplicate",
      "POST /api/v1/accounts/:id/archive",
      "POST /api/v1/categories/:id/archive",
      "POST /api/v1/staged-transactions/delete",
    ]);
  });

  /**
   * The window, read as dates rather than as source text.
   *
   * This used to assert the two headers were set and that `Deprecation` was
   * `"true"`, which is the superseded draft's spelling and which pinned the
   * defect rather than catching it: the sunset shipped as a date twenty-seven
   * days in the *past*, so every alias told its caller the path was already
   * gone while it was still answering, and this test passed throughout.
   */
  it("promises a window that is still open, and long enough", async () => {
    const source = await readFile(apiPath, "utf8");
    const deprecation = /const RENAMED_PATH_DEPRECATION = "@(\d+)"/.exec(source);
    const sunset = /const RENAMED_PATH_SUNSET = "([^"]+)"/.exec(source);
    expect(
      deprecation,
      "RENAMED_PATH_DEPRECATION must be @<seconds since the epoch>",
    ).not.toBeNull();
    expect(sunset).not.toBeNull();
    expect(source).toContain('c.header("Sunset", RENAMED_PATH_SUNSET)');
    expect(source).toContain('c.header("Deprecation", RENAMED_PATH_DEPRECATION)');
    expect(source).toContain('rel="deprecation"');

    const deprecatedAt = new Date(Number(deprecation![1]) * 1000);
    const sunsetAt = new Date(sunset![1]!);
    expect(Number.isNaN(sunsetAt.getTime()), `${sunset![1]} is not an HTTP-date`).toBe(false);
    const days = (sunsetAt.getTime() - deprecatedAt.getTime()) / 86_400_000;
    // RFC 8594: the sunset must not be earlier than the deprecation. The ninety
    // days on top of that is this product's own rule, in http.md.
    expect(days).toBeGreaterThanOrEqual(90);
    // The day this fails is the day somebody decides: drop the aliases, or
    // extend the window and say so. Both are decisions; a date that quietly
    // passed is not.
    expect(
      sunsetAt.getTime(),
      "the sunset has passed — remove the aliases or move the date",
    ).toBeGreaterThan(Date.now());
  });
});
