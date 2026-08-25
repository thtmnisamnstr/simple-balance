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

async function registeredRoutes() {
  const source = await readFile(apiPath, "utf8");
  return [...source.matchAll(/app\.(get|post|put|delete)\(\s*"(\/api\/v1[^"]*)"/g)].map(
    (match) => `${match[1]!.toUpperCase()} ${match[2]}`,
  );
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
