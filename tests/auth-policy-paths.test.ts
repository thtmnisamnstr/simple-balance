import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved = {
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  AUTH_MODE: process.env.AUTH_MODE,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
};

beforeEach(() => {
  process.env.ALLOWED_EMAILS = "*";
  process.env.AUTH_MODE = "both";
  process.env.GOOGLE_CLIENT_ID = "policy-test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "policy-test-client-secret";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = "policy-test-secret-at-least-32-characters";
  vi.resetModules();
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

const policy = () => import("../src/server/auth-policy.js");

/**
 * Better Auth declares the social callback as `/callback/:id` and hands its
 * database hooks `endpoint.path`, not the URL that was requested. A hook is
 * therefore told `/callback/:id` and never `/callback/google`.
 *
 * Matching only the resolved form meant a first-ever Google sign-up fell
 * through to the fail-closed branch and was refused, while linking Google to an
 * existing account kept working because that path creates no user. The failure
 * surfaced as `unable_to_create_user`, with a TypeError in the log rather than
 * anything naming the policy that refused it.
 */
describe("what the auth policy sees as a social callback", () => {
  it("admits a first-time Google sign-up under the route pattern", async () => {
    const { mayCreateAuthUser } = await policy();
    expect(mayCreateAuthUser("someone@example.com", "/callback/:id", true)).toBe(true);
  });

  it("admits it under the resolved path too", async () => {
    const { mayCreateAuthUser } = await policy();
    expect(mayCreateAuthUser("someone@example.com", "/callback/google", true)).toBe(true);
  });

  // Google's own word that the address belongs to the person is the whole
  // reason a domain entry can be trusted, so an unverified claim is refused
  // whichever form of the path arrives.
  it("still refuses an unverified address on either form", async () => {
    const { mayCreateAuthUser } = await policy();
    for (const path of ["/callback/:id", "/callback/google"]) {
      expect(mayCreateAuthUser("someone@example.com", path, false), path).toBe(false);
    }
  });

  it("still refuses a social callback when Google is switched off", async () => {
    process.env.AUTH_MODE = "local";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    vi.resetModules();
    const { mayCreateAuthUser } = await policy();
    for (const path of ["/callback/:id", "/callback/google"]) {
      expect(mayCreateAuthUser("someone@example.com", path, true), path).toBe(false);
    }
  });

  it("still refuses an address the rule does not admit", async () => {
    process.env.ALLOWED_EMAILS = "allowed@example.com";
    vi.resetModules();
    const { mayCreateAuthUser } = await policy();
    expect(mayCreateAuthUser("other@example.com", "/callback/:id", true)).toBe(false);
    expect(mayCreateAuthUser("allowed@example.com", "/callback/:id", true)).toBe(true);
  });

  // Nothing else may create a user. A path the policy does not recognize has to
  // fail closed, which is what made this bug safe rather than dangerous.
  it("refuses a path it does not recognize", async () => {
    const { mayCreateAuthUser } = await policy();
    for (const path of ["/callback", "/sign-in/email", "/whatever", undefined]) {
      expect(mayCreateAuthUser("someone@example.com", path, true), String(path)).toBe(false);
    }
  });

  // The session hook's own branch was dead for the same reason: it never
  // matched, so it fell through to the general check.
  it("checks the Google link on a session created by the callback", async () => {
    const { mayCreateSession } = await policy();
    expect(await mayCreateSession("/callback/:id", [{ providerId: "google" }])).toBe(true);
    expect(
      await mayCreateSession("/callback/:id", [{ providerId: "credential", password: "x" }]),
    ).toBe(false);
  });
});

/**
 * A Better Auth database hook never reads through the application pool.
 *
 * AGENTS.md: the hook runs inside the sign-up transaction, which on a
 * one-connection pool holds the only connection, so a pool read waits for
 * itself. A read through the adapter the hook is handed runs on that same
 * connection and is the one allowed. `mayCreateSession` used to fall back to
 * `getDb()` when the hook passed no accounts; this holds the hooks and every
 * function they call by name in `auth-policy.ts` to that.
 */
describe("a Better Auth database hook", () => {
  it("decides without the application pool", async () => {
    const { readFileSync } = await import("node:fs");
    const auth = readFileSync("src/server/auth.ts", "utf8");
    const start = auth.indexOf("databaseHooks:");
    expect(start, "auth.ts has no databaseHooks block to check").toBeGreaterThan(-1);
    let depth = 0;
    let end = auth.indexOf("{", start);
    for (; end < auth.length; end += 1) {
      if (auth[end] === "{") depth += 1;
      if (auth[end] === "}" && --depth === 0) break;
    }
    const hooks = auth.slice(start, end);
    const policy = readFileSync("src/server/auth-policy.ts", "utf8");
    const called = [...hooks.matchAll(/\b(may\w+|is\w+Authorized)\(/g)].map((match) => match[1]!);
    expect(
      called.length,
      "the hooks call no policy function, so this checked nothing",
    ).toBeGreaterThan(1);
    const bodies = called.map((name) => {
      const at = policy.indexOf(`function ${name}(`);
      if (at === -1) return "";
      const next = policy.indexOf("\nexport ", at + 1);
      return policy.slice(at, next === -1 ? undefined : next);
    });
    for (const text of [hooks, ...bodies]) expect(text).not.toMatch(/\bgetDb\(/);
  });
});
