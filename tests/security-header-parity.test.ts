import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { describe, expect, it } from "vitest";
import { securityHeaderOptions } from "../src/server/http-security.js";

/**
 * The split deployment serves the application shell and the hashed assets from
 * nginx, so those responses never pass through the middleware that sets the
 * policy. nginx repeats it, which means the policy exists twice — once in
 * TypeScript and once in an nginx include — and two lists in two languages
 * drift silently. The response that drifts is the document that runs the app.
 */
const nginxHeaders = () => {
  const conf = readFileSync(
    new URL("../deploy/docker/nginx-security-headers.conf", import.meta.url),
    "utf8",
  );
  return new Map(
    [...conf.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"\s+always;/gm)].map(
      (match) => [match[1]!.toLowerCase(), match[2]!],
    ),
  );
};

/** What a real response out of the middleware carries, not a list of guesses. */
const apiHeaders = async () => {
  const app = new Hono();
  // Production, because that is what the split deployment runs and the only
  // mode that sets HSTS.
  app.use("*", secureHeaders(securityHeaderOptions(true)));
  app.get("/", (c) => c.text("ok"));
  const response = await app.request("/");
  const headers = new Map<string, string>();
  response.headers.forEach((value, name) => headers.set(name.toLowerCase(), value));
  return headers;
};

describe("the security headers nginx repeats", () => {
  it("carries every header the API sets, with the same value", async () => {
    const api = await apiHeaders();
    const nginx = nginxHeaders();
    // Not a policy; it is what the response happens to be.
    api.delete("content-type");

    const missing = [...api.keys()].filter((name) => !nginx.has(name));
    expect(missing, `set by the API and not by nginx: ${missing.join(", ")}`).toEqual(
      [],
    );

    for (const [name, value] of api) {
      expect(nginx.get(name), `${name} differs`).toBe(value);
    }
  });

  it("adds nothing the API does not set", async () => {
    const api = await apiHeaders();
    const extra = [...nginxHeaders().keys()].filter((name) => !api.has(name));
    expect(extra, `set by nginx alone: ${extra.join(", ")}`).toEqual([]);
  });

  /**
   * X-Frame-Options and `frame-ancestors` say the same thing to two generations
   * of browser, so one saying DENY while the other says 'none' — or worse,
   * SAMEORIGIN, which Hono defaults to — is the pair disagreeing about whether
   * this application may be framed by itself.
   */
  it("says the same thing about framing in both headers", async () => {
    const api = await apiHeaders();
    expect(api.get("x-frame-options")).toBe("DENY");
    expect(api.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
