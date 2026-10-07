import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { hardenAuthCookies, withholdSessionTokens } from "../src/server/http-security.js";

/**
 * The session cookie is HttpOnly, and Better Auth hands the same value back in
 * JSON from get-session, list-sessions, sign-in, sign-up and change-password.
 * The 0.2.0 sandbox smoke test read it out of both session routes from page
 * script, which is the one thing HttpOnly exists to stop.
 */
function appAnswering(body: unknown, init: ResponseInit = {}) {
  const app = new Hono();
  app.use("/api/auth/*", hardenAuthCookies("https://balance.example.com"));
  app.use("/api/auth/*", withholdSessionTokens());
  app.get("/api/auth/thing", () => Response.json(body, init));
  return app;
}

const read = async (app: Hono) => {
  const response = await app.request("https://balance.example.com/api/auth/thing");
  return { response, text: await response.clone().text(), json: await response.json() };
};

describe("bodies leaving the auth routes", () => {
  it("drops session.token from get-session and keeps the rest", async () => {
    const { json, text } = await read(
      appAnswering({
        session: { id: "s1", token: "SECRET", expiresAt: "2026-10-12" },
        user: { id: "u1", email: "a@example.com" },
      }),
    );
    expect(text).not.toContain("SECRET");
    expect(json).toEqual({
      session: { id: "s1", expiresAt: "2026-10-12" },
      user: { id: "u1", email: "a@example.com" },
    });
  });

  it("drops token from every session list-sessions returns", async () => {
    const { json, text } = await read(
      appAnswering([
        { id: "s1", token: "SECRET-1", userAgent: "x" },
        { id: "s2", token: "SECRET-2", userAgent: "y" },
      ]),
    );
    expect(text).not.toContain("SECRET");
    expect(json).toEqual([
      { id: "s1", userAgent: "x" },
      { id: "s2", userAgent: "y" },
    ]);
  });

  it("drops the top-level token sign-in and sign-up return", async () => {
    const { json } = await read(
      appAnswering({ redirect: false, token: "SECRET", user: { id: "u1" } }),
    );
    expect(json).toEqual({ redirect: false, user: { id: "u1" } });
  });

  it("leaves a body with no token byte for byte", async () => {
    const { text } = await read(appAnswering({ status: true }));
    expect(text).toBe('{"status":true}');
  });

  it("keeps the status, the session cookie and a correct length", async () => {
    const app = new Hono();
    app.use("/api/auth/*", withholdSessionTokens());
    app.get("/api/auth/thing", (c) => {
      c.header("set-cookie", "__Secure-better-auth.session_token=v; HttpOnly; Secure");
      return c.json({ token: "SECRET-LONGER-THAN-WHAT-REMAINS", user: { id: "u1" } }, 201);
    });
    const response = await app.request("https://balance.example.com/api/auth/thing");
    const text = await response.text();
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toHaveLength(1);
    const length = response.headers.get("content-length");
    if (length !== null) expect(Number(length)).toBe(new TextEncoder().encode(text).length);
    expect(JSON.parse(text)).toEqual({ user: { id: "u1" } });
  });

  it("leaves an MCP token response alone, whose secrets are not named token", async () => {
    const payload = { access_token: "a", refresh_token: "r", id_token: "i", token_type: "Bearer" };
    const { json } = await read(appAnswering(payload));
    expect(json).toEqual(payload);
  });
});
