import { afterEach, describe, expect, it, vi } from "vitest";

const keys = [
  "NODE_ENV",
  "DATABASE_URL",
  "APP_BASE_URL",
  "AUTH_SECRET",
  "AUTH_MODE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function setEnvironment(values: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("authentication configuration", () => {
  it("defaults development to local auth without external identity settings", async () => {
    setEnvironment({ NODE_ENV: "development" });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    const config = getConfig();
    expect(config).toMatchObject({
      authMode: "local",
      localAuthEnabled: true,
      googleAuthEnabled: false,
      baseUrl: "http://localhost:5173",
    });
  });

  it("accepts production local mode without Google settings or an allowlist", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig()).toMatchObject({
      authMode: "local",
      localAuthEnabled: true,
      googleAuthEnabled: false,
    });
    // Nothing configured means nobody new registers, which is what an existing
    // deployment expects an upgrade to do.
    expect(getConfig().registration).toEqual({ kind: "closed" });
  });

  it.each([
    "http://simple-balance.example.com",
    "http://localhost.attacker.example",
    "ftp://localhost:3000",
  ])("rejects the insecure production APP_BASE_URL %s", async (baseUrl) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: baseUrl,
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/APP_BASE_URL must use HTTPS/);
  });

  it.each([
    "https://simple-balance.example.com/app",
    "https://simple-balance.example.com/app/",
    "https://simple-balance.example.com/.",
    "https://simple-balance.example.com\\app",
    "https://simple-balance.example.com?tenant=owner",
    "https://simple-balance.example.com#callback",
    "https://@simple-balance.example.com",
    "https://owner@simple-balance.example.com",
    "https://owner:secret@simple-balance.example.com",
  ])("rejects a production APP_BASE_URL that is not an exact origin: %s", async (baseUrl) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: baseUrl,
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/exact HTTP\(S\) origin/);
  });

  it("accepts and normalizes an optional trailing slash on the production origin", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com/",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig().baseUrl).toBe("https://simple-balance.example.com");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.42.0.8:3000",
    "http://[::1]:3000",
  ])("allows the production loopback URL %s", async (baseUrl) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: baseUrl,
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig().baseUrl).toBe(baseUrl);
  });

  it.each(["Production", "prod", "produciton", ""])(
    "refuses NODE_ENV=%s rather than reading it as development",
    async (nodeEnv) => {
      setEnvironment({ NODE_ENV: nodeEnv });
      vi.resetModules();
      const { getConfig } = await import("../src/server/config.js");
      expect(() => getConfig()).toThrow();
    },
  );

  it("refuses to run outside production once APP_BASE_URL names a real host", async () => {
    setEnvironment({
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/NODE_ENV is not production/);
  });

  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("still starts outside production on the loopback URL %s", async (baseUrl) => {
    setEnvironment({ APP_BASE_URL: baseUrl });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(getConfig().isProduction).toBe(false);
  });

  it.each([
    "development-only-secret-change-me-1234567890",
    "replace-with-at-least-32-random-characters",
  ])("refuses the published placeholder secret %s in production", async (secret) => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: secret,
      AUTH_MODE: "local",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow(/published placeholder/);
  });

  it("fails closed when Google mode is missing provider settings", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "google",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    expect(() => getConfig()).toThrow();
  });

  it("normalizes an allowlist when both methods are configured", async () => {
    setEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://simple_balance:secret@database.example/simple_balance",
      APP_BASE_URL: "https://simple-balance.example.com",
      AUTH_SECRET: "a-production-secret-that-is-at-least-32-characters",
      AUTH_MODE: "both",
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      ALLOWED_EMAILS: " Owner@Example.com, second@example.com ",
    });
    vi.resetModules();
    const { getConfig } = await import("../src/server/config.js");
    const config = getConfig();
    expect(config.authMode).toBe("both");
    expect(config.registration).toMatchObject({ kind: "list" });
    const rule = config.registration as {
      kind: "list";
      emails: Set<string>;
      domains: Set<string>;
    };
    expect([...rule.emails]).toEqual(["owner@example.com", "second@example.com"]);
    expect([...rule.domains]).toEqual([]);
  });
});
