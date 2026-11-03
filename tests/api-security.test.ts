import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/server/api.js";
import { getConfig } from "../src/server/config.js";
import {
  API_REQUEST_BODY_LIMIT_BYTES,
  AUTH_REQUEST_BODY_LIMIT_BYTES,
  requestBodyLimit,
} from "../src/server/http-security.js";
import { apiErrorCodes } from "../src/shared/domain.js";

const applicationOrigin = new URL(getConfig().baseUrl).origin;

/**
 * Reads the code off a refusal and holds it to the published enumeration.
 *
 * Asserting the envelope shape alone is what let five transport codes sit on
 * the wire in no list at all: every one of these responses matched
 * `{ error: { code } }` the whole time. The membership is the part that fails
 * when a refusal invents a code nobody can look up.
 */
async function refusalCode(response: Response) {
  const payload = (await response.json()) as { error?: { code?: unknown } };
  expect(payload).toMatchObject({ error: { code: expect.any(String) } });
  const code = payload.error?.code as string;
  expect(apiErrorCodes).toContain(code);
  return code;
}

describe("API transport security wiring", () => {
  it("rejects a cross-origin finance mutation before session lookup", async () => {
    const response = await app.request(`${applicationOrigin}/api/v1/preferences`, {
      method: "PUT",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await refusalCode(response)).toBe("CROSS_ORIGIN_REQUEST");
  });

  it("rejects a cross-origin auth mutation before Better Auth", async () => {
    const response = await app.request(`${applicationOrigin}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  // Revoking an agent is a DELETE with nothing to say, which is exactly the
  // shape that fell through the gap: /api/v1 demands a JSON content type on
  // anything that changes state, so a fetch that sent no body at all was
  // refused with a 415 the browser never surfaced. Both halves are pinned here
  // because the requirement is deliberate and the client has to satisfy it.
  it("refuses a state-changing request that names no content type", async () => {
    const response = await app.request(`${applicationOrigin}/api/v1/connected-apps/some-client`, {
      method: "DELETE",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: applicationOrigin,
      },
    });
    expect(response.status).toBe(415);
    expect(await refusalCode(response)).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("lets a bodyless revoke through the media type gate to authentication", async () => {
    const response = await app.request(`${applicationOrigin}/api/v1/connected-apps/some-client`, {
      method: "DELETE",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: applicationOrigin,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).not.toBe(415);
    expect(response.status).toBe(401);
  });

  it("rejects an oversized auth body before Better Auth parses it", async () => {
    const response = await app.request(`${applicationOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: applicationOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "x".repeat(AUTH_REQUEST_BODY_LIMIT_BYTES),
      }),
    });
    expect(response.status).toBe(413);
    expect(await refusalCode(response)).toBe("PAYLOAD_TOO_LARGE");
  });

  // Both of these are framing rather than content: the headers describing the
  // body contradict the body. They are refused where the 413 is, ahead of
  // Better Auth, which is why an auth path can reach them without a session.
  it("refuses a request whose Content-Length is not a number", async () => {
    const response = await app.request(`${applicationOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: applicationOrigin,
        "content-type": "application/json",
        "content-length": "twelve",
      },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(await refusalCode(response)).toBe("INVALID_CONTENT_LENGTH");
  });

  it("refuses a bodyless request that declares bytes it never sends", async () => {
    const response = await app.request(`${applicationOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        origin: applicationOrigin,
        "content-type": "application/json",
        "content-length": "12",
      },
    });
    expect(response.status).toBe(400);
    expect(await refusalCode(response)).toBe("REQUEST_BODY_NOT_ALLOWED");
  });

  it("rejects an unauthenticated finance body before granting the upload allowance", async () => {
    const response = await app.request(`${applicationOrigin}/api/v1/preferences`, {
      method: "PUT",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: applicationOrigin,
        "content-type": "application/json",
        "content-length": String(API_REQUEST_BODY_LIMIT_BYTES + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await refusalCode(response)).toBe("UNAUTHORIZED");
    expect(response.headers.get("connection")).toBe("close");
  });

  it("rejects an unauthenticated MCP body before granting the CSV allowance", async () => {
    const response = await app.request(`${applicationOrigin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(requestBodyLimit("/mcp") + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("connection")).toBe("close");
  });
});

/**
 * What a refusal that comes before the session check still says about itself.
 *
 * `no-store` and the deprecation headers were both set after the guards — the
 * first inside the session check, the second by a middleware on each old route
 * — so a cross-origin 403, a 415 and a 401 on an old spelling went out without
 * them. `http.md` asks `no-store` on every `/api/v1` response without
 * exception, and the 401 is what an old tab left open across an upgrade meets
 * first.
 */
describe("headers set before anything can refuse", () => {
  const anyId = "00000000-0000-4000-8000-000000000001";

  it("marks a cross-origin refusal and a media-type refusal uncacheable", async () => {
    const crossOrigin = await app.request(`${applicationOrigin}/api/v1/preferences`, {
      method: "PUT",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("cache-control")).toBe("no-store");

    const noMediaType = await app.request(`${applicationOrigin}/api/v1/connected-apps/x`, {
      method: "DELETE",
      headers: { origin: applicationOrigin },
    });
    expect(noMediaType.status).toBe(415);
    expect(noMediaType.headers.get("cache-control")).toBe("no-store");
  });

  it("says an old spelling is deprecated even when it refuses the request", async () => {
    const response = await app.request(`${applicationOrigin}/api/v1/accounts/${anyId}/archive`, {
      method: "POST",
      headers: { origin: applicationOrigin, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("deprecation")).toMatch(/^@\d+$/);
    expect(response.headers.get("sunset")).toBeTruthy();
    // The successor with the id this request named, never a `{id}` template:
    // a brace is not allowed in a URI reference, so that link led nowhere.
    const link = response.headers.get("link") ?? "";
    expect(link).toContain(`</api/v1/accounts/${anyId}/archived>; rel="successor-version"`);
    expect(link).toMatch(/CHANGELOG\.md#[\w-]+>; rel="deprecation"/);
    expect(link).not.toMatch(/[{}]/);
  });

  it("marks only the old spellings", async () => {
    const current = await app.request(`${applicationOrigin}/api/v1/accounts/${anyId}/archived`, {
      method: "POST",
      headers: { origin: applicationOrigin, "content-type": "application/json" },
      body: "{}",
    });
    expect(current.status).toBe(401);
    expect(current.headers.get("deprecation")).toBeNull();
    const old = await app.request(`${applicationOrigin}/api/v1/staged/${anyId}/duplicate`);
    expect(old.headers.get("link")).toContain(
      `</api/v1/staged-transactions/${anyId}/duplicate>; rel="successor-version"`,
    );
  });
});

/**
 * The icon lived in the built bundle the whole time and nothing routed to it:
 * only /assets/* was served statically, so /favicon.svg fell through to the
 * single-page shell and a browser was handed index.html under text/html for an
 * image request. It showed no icon and reported no error.
 *
 * Asserted against the source rather than by making a request, because the
 * static routes only exist when NODE_ENV is production and `npm run verify`
 * runs the tests before the build, so there is no bundle to serve when this
 * runs. What can be checked always is the wiring: a handler for the bundle root
 * has to come before the catch-all, or the catch-all answers first. The
 * behavior itself is verified against the built container.
 */
describe("static files at the root of the client bundle", () => {
  const source = readFileSync(path.join(import.meta.dirname, "..", "src/server/api.ts"), "utf8");

  it("serves the bundle root before falling back to the shell", () => {
    // Specifically the wildcard one. Matching the bare serveStatic call found
    // the /assets/* handler, which contains the same text and is already before
    // the fallback, so this passed with the root handler deleted.
    const rootHandler = source.indexOf('app.use("*", serveStatic({ root: "./dist/client" }))');
    const shellFallback = source.indexOf('serveStatic({ path: "./dist/client/index.html" })');
    expect(rootHandler, "a handler for the bundle root").toBeGreaterThan(-1);
    expect(shellFallback, "the single-page fallback").toBeGreaterThan(-1);
    expect(rootHandler).toBeLessThan(shellFallback);
  });

  /**
   * Three descriptions of this product and one of them was different. The shell
   * is the one a search engine and a link preview read, and it had drifted into
   * saying something vaguer than the manifest the release publishes.
   */
  it("describes the product the way the manifest does", () => {
    const html = readFileSync(path.join(import.meta.dirname, "..", "index.html"), "utf8");
    const manifest = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { description: string };
    expect(html).toContain(manifest.description);
  });

  // Whether the phone's browser chrome matches the page is now
  // tests/theme-tokens.test.ts, which checks it per theme. There are two grounds
  // and two metas, and the check here was `expect(css).toContain(...)` over the
  // whole file — with two palettes that passes when the color turns up in the
  // wrong block, so doubling it would have kept the words and lost the meaning.

  /**
   * `/robots.txt` reached the single-page shell, which a crawler reads as a
   * robots file with no rules in it, found by the 0.2.0 sandbox smoke test. It
   * is a file in public/, so the bundle-root handler above serves it.
   *
   * For a release it turned every crawler but AdSense's away, and that kept a
   * search engine from ever reading the `noindex` every response carries — the
   * block at the foot of this file — so an address somebody linked to could
   * still be listed. It lets them all in now, and the header does the keeping.
   */
  it("ships a robots file that lets every crawler in to read the noindex", () => {
    const robots = readFileSync(
      path.join(import.meta.dirname, "..", "public", "robots.txt"),
      "utf8",
    );
    const groups = robots
      .split(/\n\s*\n/)
      .map((group) => group.split("\n").filter((line) => line && !line.startsWith("#")))
      .filter((lines) => lines.length);
    const everyone = groups.find((lines) => lines.includes("User-agent: *"));
    // The allowance beside the absence: a file whose `*` group had gone would
    // disallow nothing at all and pass the second assertion alone.
    expect(everyone).toContain("Allow: /");
    expect(groups.flat().filter((line) => /^Disallow:\s*\S/i.test(line))).toEqual([]);
    // Google ignores `*` for AdSense's crawler, so the group naming it is the
    // only rule it reads, and the one place its allowance can be said.
    const adsense = groups.find((lines) => lines.includes("User-agent: Mediapartners-Google"));
    expect(adsense, "AdSense's own group, the only one its crawler reads").toContain("Allow: /");
  });

  it("keeps the icon the document asks for in the bundle", () => {
    const html = readFileSync(path.join(import.meta.dirname, "..", "index.html"), "utf8");
    for (const match of html.matchAll(/<(?:link[^>]+href|script[^>]+src)="\/([^"]+)"/g)) {
      const file = match[1];
      // Hashed assets are emitted by the build, as is the module entry it
      // rewrites; these are the ones copied verbatim out of public/, so they
      // have to be there to be copied. Scripts are matched as well as links
      // because <head> now loads one, and a src pointing at a file nobody
      // copied would have shipped a 404 that blocks the first paint.
      if (file!.startsWith("src/")) continue;
      if (file.startsWith("assets/")) continue;
      expect(
        existsSync(path.join(import.meta.dirname, "..", "public", file)),
        `public/${file} is referenced by index.html`,
      ).toBe(true);
    }
  });
});

/**
 * The other half of the robots file above: everything this process answers
 * says `noindex`, so a crawler let in reads it and leaves the page out.
 *
 * Asked of real requests, in production with a bundle beside the process,
 * because the pages and the files out of the bundle exist only then and they
 * are what a search engine was finding. `npm run verify` runs this before the
 * build, so the bundle is made here the way `tests/metrics-http-pages.test.ts`
 * makes one: a scratch directory holding the shell, an icon, a hashed asset and
 * the real robots file, made the working directory while this block runs. The
 * repository's own `dist/` is never touched.
 */
describe("a noindex on every response", () => {
  const environment = { ...process.env };
  const startedIn = process.cwd();
  const origin = "https://books.example";
  let bundle = "";
  let server: { request: (input: string, init?: RequestInit) => Promise<Response> };

  beforeAll(async () => {
    bundle = mkdtempSync(path.join(tmpdir(), "simple-balance-noindex-"));
    const client = path.join(bundle, "dist", "client");
    mkdirSync(path.join(client, "assets"), { recursive: true });
    writeFileSync(path.join(client, "index.html"), "<!doctype html><title>shell</title>");
    writeFileSync(path.join(client, "favicon.svg"), "<svg></svg>");
    writeFileSync(path.join(client, "assets", "index-0000beef.js"), "export {};");
    copyFileSync(
      path.join(import.meta.dirname, "..", "public", "robots.txt"),
      path.join(client, "robots.txt"),
    );
    process.chdir(bundle);
    Object.assign(process.env, {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
      APP_BASE_URL: origin,
      AUTH_SECRET: "api-security-noindex-secret-at-least-32-characters",
    });
    // Production says so about `NODE_ENV` at import, which is not what this
    // block is about.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.resetModules();
    server = ((await import("../src/server/api.js")) as { default: typeof server }).default;
  });

  afterAll(() => {
    process.chdir(startedIn);
    rmSync(bundle, { recursive: true, force: true });
    process.env = { ...environment };
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Each one names what answered it as well as the header, so a row that fell
  // through to the shell, or to a 404 nobody meant, cannot pass for the
  // response it is named after. `/ads.txt` exists only where AdSense is
  // configured and is asked in `tests/ads-txt.test.ts`, which configures it.
  it.each([
    { what: "the shell", target: "/", status: 200, says: "<title>shell</title>" },
    { what: "the shell at a page's address", target: "/budgets", status: 200, says: "shell" },
    { what: "a file beside the shell", target: "/favicon.svg", status: 200, says: "<svg>" },
    { what: "a hashed asset", target: "/assets/index-0000beef.js", status: 200, says: "export" },
    { what: "the robots file", target: "/robots.txt", status: 200, says: "User-agent: *" },
    { what: "an API answer", target: "/health/live", status: 200, says: '"status":"ok"' },
  ])("is said on $what", async ({ target, status, says }) => {
    const response = await server.request(`${origin}${target}`);
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(says);
    // Exactly the one value: a second middleware saying it as well would make
    // this `noindex, noindex`, which is harmless and means two places to keep.
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  /**
   * `http.md`: the single-page app never answers an API path. Only three
   * prefixes were fenced, so the single container answered every other path
   * under one this process owns with the shell and a 200 — HTML for an API
   * client to parse, and "ready" from a probe at a mistyped health path with
   * the database down. Matched on the body and the type as well as the status,
   * because Hono's own 404 would pass on the status alone.
   */
  it.each([
    "/api/v2/accounts",
    "/api",
    "/api/",
    "/mcp/tools",
    "/health/readyz",
    "/metrics",
    "/ads.txt",
  ])("answers %s as an API path that is not there, never with the shell", async (target) => {
    const response = await server.request(`${origin}${target}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await refusalCode(response)).toBe("NOT_FOUND");
  });

  // Bare `/health` answered 200 through the shell on the release before, and a
  // load balancer pointed there must not take the backend out on an upgrade.
  it.each(["/health", "/health/"])("keeps %s answering, as liveness", async (target) => {
    const response = await server.request(`${origin}${target}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("is said on a refusal, which a guard answers before any route runs", async () => {
    const response = await server.request(`${origin}/api/v1/preferences`, {
      method: "PUT",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await refusalCode(response)).toBe("CROSS_ORIGIN_REQUEST");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });
});

/**
 * The split deployment's nginx serves the shell, the assets and the robots file
 * itself, so none of them pass through the middleware above, and it says the
 * header again for them.
 *
 * `tests/security-header-parity.test.ts` holds each header snippet to the
 * API's headers value for value, and so already fails on a snippet that drops
 * this one. What it cannot see is a location that answers with a file and
 * includes no snippet at all, which would send the shell with no header and
 * fail nothing — so every location in the template is read, and each either
 * proxies to the API, which says it, or includes a snippet the image installs
 * that says it too.
 */
describe("a noindex on what the frontend nginx serves itself", () => {
  const docker = path.join(import.meta.dirname, "..", "deploy", "docker");
  const template = readFileSync(path.join(docker, "nginx.conf.template"), "utf8");
  // Read off the image's own COPY lines rather than listed here, so a snippet
  // installed under another name is followed to the file it really is.
  const installed = new Map(
    [
      ...readFileSync(path.join(docker, "frontend.Dockerfile"), "utf8").matchAll(
        /^COPY deploy\/docker\/(\S+) (\/etc\/nginx\/snippets\/\S+)$/gm,
      ),
    ].map((match) => [match[2]!, match[1]!] as const),
  );
  const locations = [
    ...template.matchAll(/^ {2}location\s+([^{]+?)\s*\{\n([\s\S]*?)^ {2}\}$/gm),
  ].map((match) => ({ match: match[1]!, body: match[2]! }));
  const proxies = (body: string) => /^\s*proxy_pass\s/m.test(body);

  it("is said on every file it serves, and passed through from the API on the rest", () => {
    // Every `location` the template declares, against the ones the pattern
    // read. A block it cannot parse — one written on a single line, or
    // indented differently — is a failure here rather than a location nobody
    // checked, which is exactly the shape that would serve a file bare.
    expect(locations).toHaveLength(template.match(/^\s*location\b/gm)?.length ?? 0);
    // Both kinds found, so a pattern that stopped matching the template cannot
    // pass over an empty list.
    expect(locations.filter((location) => proxies(location.body)).length).toBeGreaterThan(0);
    // Passed through means passed through: a proxying location that hid the
    // API's header would serve every API answer without it.
    for (const location of locations.filter(({ body }) => proxies(body))) {
      expect(location.body, `location ${location.match}`).not.toMatch(
        /^\s*proxy_hide_header\s+X-Robots-Tag\s*;/im,
      );
    }
    const serving = locations.filter((location) => !proxies(location.body));
    expect(serving.map((location) => location.match)).toEqual(
      expect.arrayContaining(["/assets/", "/"]),
    );
    for (const location of serving) {
      const snippet = /^\s*include\s+(\S+);/m.exec(location.body)?.[1];
      expect(snippet, `location ${location.match} includes a header snippet`).toBeDefined();
      const source = installed.get(snippet!);
      expect(source, `the image installs ${snippet}`).toBeDefined();
      expect(readFileSync(path.join(docker, source!), "utf8"), source).toMatch(
        /^add_header X-Robots-Tag "noindex" always;$/m,
      );
    }
  });
});
