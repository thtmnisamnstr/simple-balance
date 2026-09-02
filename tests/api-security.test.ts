import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
 * behaviour itself is verified against the built container.
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
  // whole file — with two palettes that passes when the colour turns up in the
  // wrong block, so doubling it would have kept the words and lost the meaning.

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
