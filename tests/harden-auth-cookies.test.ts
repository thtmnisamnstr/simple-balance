import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { hardenAuthCookies } from "../src/server/http-security.js";

/**
 * Better Auth marks its session cookie HttpOnly and Secure and leaves the OIDC
 * plugin's oidc_login_prompt with neither, so the flags are added on the way
 * out rather than trusted to arrive.
 */
function appServing(cookies: string[], baseUrl: string) {
  const app = new Hono();
  app.use("/api/auth/*", hardenAuthCookies(baseUrl));
  app.get("/api/auth/thing", (c) => {
    for (const cookie of cookies) c.header("set-cookie", cookie, { append: true });
    return c.body(null, 204);
  });
  return app;
}

const HTTPS = "https://balance.example.com";
const PROMPT = "oidc_login_prompt=payload.sig; Max-Age=600; Path=/; SameSite=Lax";

describe("cookies leaving the auth routes", () => {
  it("closes an OIDC prompt cookie that arrived with neither flag", async () => {
    const response = await appServing([PROMPT], HTTPS).request(`${HTTPS}/api/auth/thing`);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    // The cookie itself is untouched, so the signature still verifies.
    expect(cookie.startsWith(PROMPT)).toBe(true);
  });

  it("leaves a cookie that already has both alone", async () => {
    const already = "__Secure-better-auth.session_token=v; Path=/; HttpOnly; Secure; SameSite=Lax";
    const response = await appServing([already], HTTPS).request(`${HTTPS}/api/auth/thing`);
    expect(response.headers.getSetCookie()).toEqual([already]);
  });

  it("hardens every cookie in a response that sets more than one", async () => {
    const response = await appServing([PROMPT, "second=b; Path=/"], HTTPS).request(
      `${HTTPS}/api/auth/thing`,
    );
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
    }
  });

  // Marking a cookie Secure on a plaintext origin makes the browser drop it,
  // which would break the flow the whole thing exists to protect.
  it("does not mark cookies Secure on a plaintext development origin", async () => {
    const base = "http://localhost:3000";
    const response = await appServing([PROMPT], base).request(`${base}/api/auth/thing`);
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
  });

  it("recognises the flags whatever case they arrive in", async () => {
    const shouting = "a=b; Path=/; HTTPONLY; SECURE";
    const response = await appServing([shouting], HTTPS).request(`${HTTPS}/api/auth/thing`);
    expect(response.headers.getSetCookie()).toEqual([shouting]);
  });

  it("does not invent a cookie header on a response that sets none", async () => {
    const response = await appServing([], HTTPS).request(`${HTTPS}/api/auth/thing`);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
