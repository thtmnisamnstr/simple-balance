import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);

type App = (typeof import("../../src/server/api.js"))["default"];

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  SETUP_TOKEN: process.env.SETUP_TOKEN,
};

const BASE = "http://localhost:3000";

async function startDeployment(mode: "local" | "google" | "both", suffix: string) {
  const databaseName = `simple_balance_mcpd_${process.pid}_${suffix}`;
  const adminClient = new PgClient({ connectionString: connection });
  await adminClient.connect();
  await adminClient.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(connection!);
  databaseUrl.pathname = `/${databaseName}`;

  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.DATABASE_POOL_SIZE = "1";
  process.env.NODE_ENV = "production";
  process.env.AUTH_MODE = mode;
  process.env.APP_BASE_URL = BASE;
  process.env.AUTH_SECRET = "mcp-discovery-secret-at-least-32-characters";
  process.env.ALLOWED_EMAILS = "*";
  process.env.SETUP_TOKEN = "mcp-discovery-setup-code-123456";
  if (mode === "local") {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  } else {
    process.env.GOOGLE_CLIENT_ID = "mcp-discovery-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "mcp-discovery-client-secret";
  }

  vi.resetModules();
  const { runMigrations } = await import("../../src/server/db/migrate.js");
  const { closeDb } = await import("../../src/server/db/client.js");
  await runMigrations();
  const { default: app } = await import("../../src/server/api.js");
  return {
    app,
    async stop() {
      await closeDb();
      await adminClient.query(`drop database if exists "${databaseName}"`);
      await adminClient.end();
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

integration("what an MCP client can discover before it has a token", () => {
  let app: App;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ app, stop } = await startDeployment("local", "disc"));
  });
  afterAll(async () => {
    await stop();
  });

  // RFC 9728 tells a client holding the resource <origin>/mcp to look under
  // /.well-known/oauth-protected-resource/mcp first. Answering only at the root
  // left the single-page app returning HTML with a 200, which is worse than a
  // 404 because the client cannot tell it apart from a real document.
  it("answers the path-aware well-known locations with JSON", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
    ]) {
      const response = await app.request(`${BASE}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toContain("application/json");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.resource ?? body.issuer, path).toBeTruthy();
    }
  });

  it("says no to a well-known name it does not publish, rather than serving the app", async () => {
    const response = await app.request(`${BASE}/.well-known/webfinger`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("names the same resource, scopes, and endpoints in both documents", async () => {
    const resource = (await (
      await app.request(`${BASE}/.well-known/oauth-protected-resource`)
    ).json()) as Record<string, unknown>;
    const server = (await (
      await app.request(`${BASE}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;

    expect(resource.resource).toBe(`${BASE}/mcp`);
    expect(resource.authorization_servers).toEqual([BASE]);
    expect(server.issuer).toBe(BASE);
    expect(server.authorization_endpoint).toBe(`${BASE}/api/auth/mcp/authorize`);
    expect(server.token_endpoint).toBe(`${BASE}/api/auth/mcp/token`);
    expect(server.registration_endpoint).toBe(`${BASE}/api/auth/mcp/register`);
    expect(server.code_challenge_methods_supported).toContain("S256");
    expect(server.code_challenge_methods_supported).not.toContain("plain");
    for (const scope of ["ledger:read", "ledger:stage", "ledger:write"]) {
      expect(resource.scopes_supported).toContain(scope);
      expect(server.scopes_supported).toContain(scope);
    }
  });

  // The endpoint answers to the bare opaque token rather than the audience-bound
  // JWT, and hands back the refresh token with it.
  it("does not expose Better Auth's mcp/get-session", async () => {
    const response = await app.request(`${BASE}/api/auth/mcp/get-session`, {
      headers: { authorization: "Bearer whatever" },
    });
    expect(response.status).toBe(404);
  });
});

for (const mode of ["local", "google", "both"] as const) {
  integration(`the sign-in redirect in AUTH_MODE=${mode}`, () => {
    let app: App;
    let stop: () => Promise<void>;

    beforeAll(async () => {
      ({ app, stop } = await startDeployment(mode, `mode-${mode}`));
    });
    afterAll(async () => {
      await stop();
    });

    // Whichever methods are configured, an unauthenticated authorization has to
    // hand the person to this application's own sign-in page with everything
    // the flow needs to carry on afterwards.
    it("sends an unauthenticated authorization to the app's own sign-in page", async () => {
      const registration = await app.request(`${BASE}/api/auth/mcp/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: `mode ${mode}`,
          redirect_uris: ["http://127.0.0.1:7777/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        }),
      });
      expect([200, 201]).toContain(registration.status);
      const client = (await registration.json()) as { client_id: string };

      const authorize = new URL(`${BASE}/api/auth/mcp/authorize`);
      authorize.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:7777/callback",
        response_type: "code",
        scope: "openid ledger:read",
        state: `mode-${mode}`,
        code_challenge: "0123456789012345678901234567890123456789012",
        code_challenge_method: "S256",
      }).toString();

      const response = await app.request(authorize.toString());
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!, BASE);
      expect(location.pathname).toBe("/sign-in");
      // Everything the page needs to rebuild the return trip.
      expect(location.searchParams.get("client_id")).toBe(client.client_id);
      expect(location.searchParams.get("state")).toBe(`mode-${mode}`);
      expect(location.searchParams.get("code_challenge")).toBeTruthy();
      expect(location.searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:7777/callback",
      );
      // Consent is this server's policy, not the client's choice.
      expect(location.searchParams.get("prompt")).toBe("consent");
    });

    it("advertises exactly the sign-in methods this mode enables", async () => {
      const methods = (await (
        await app.request(`${BASE}/api/auth/methods`)
      ).json()) as Record<string, unknown>;
      expect(methods.mode).toBe(mode);
      expect(methods.localEnabled).toBe(mode !== "google");
      expect(methods.googleEnabled).toBe(mode !== "local");
    });

    it("refuses the sign-in methods this mode disables", async () => {
      const signUp = await app.request(`${BASE}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: BASE, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Mode Check",
          email: "mode-check@example.com",
          password: "mode-check-password",
        }),
      });
      if (mode === "google") {
        expect(signUp.status).toBe(403);
        expect(await signUp.json()).toMatchObject({ code: "LOCAL_AUTH_DISABLED" });
      } else {
        expect(signUp.status).toBe(200);
      }

      const googleCallback = await app.request(`${BASE}/api/auth/callback/google`);
      if (mode === "local") expect(googleCallback.status).toBe(404);
      else expect(googleCallback.status).not.toBe(404);
    });
  });
}
