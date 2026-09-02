import { createHash } from "node:crypto";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, getPool } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import { account, user } from "../../src/server/db/schema.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_auth_${process.pid}_${Date.now()}`;
let adminClient: PgClient;
let app: (typeof import("../../src/server/api.js"))["default"];
let ownerEmail = "";
let ownerPassword = "";
let ownerCookie = "";
const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  SETUP_TOKEN: process.env.SETUP_TOKEN,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

// Sign-up and sign-in are rate limited per client address, a few attempts every
// ten seconds. This file makes more attempts than that, and would otherwise
// make them all from the one address a request with no socket falls back to.
// Each attempt therefore arrives from its own, the way separate people would.
let nextClient = 0;
const fromNewClient = () => `198.51.100.${(nextClient += 1) % 250}`;
const setupToken = "integration-owner-setup-token";

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function authRequest(path: string, body?: unknown, cookie?: string) {
  return app.request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-forwarded-for": fromNewClient(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function formRequest(path: string, values: Record<string, string>, cookie?: string) {
  return app.request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      referer: "http://localhost:3000/sign-in",
      "x-forwarded-for": fromNewClient(),
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(values).toString(),
  });
}

function oauthClientRequest(
  path: string,
  body: string,
  contentType: "application/json" | "application/x-www-form-urlencoded",
) {
  return app.request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

integration("embedded local authentication", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.DATABASE_POOL_SIZE = "1";
    process.env.NODE_ENV = "production";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_SECRET = "auth-integration-secret-at-least-32-characters";
    process.env.SETUP_TOKEN = setupToken;
    process.env.TRUST_PROXY = "true";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.ALLOWED_EMAILS;
    await runMigrations();
    ({ default: app } = await import("../../src/server/api.js"));
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("advertises local setup without Google configuration", async () => {
    const response = await authRequest("/api/auth/methods");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "local",
      localEnabled: true,
      googleEnabled: false,
      localRegistrationOpen: true,
      awaitingFirstAccount: true,
      setupTokenRequired: true,
      // Required implies offered: the form shows the field either way, and
      // this flag is what makes it optional on a list-mode claim.
      setupTokenOffered: true,
      passwordResetAvailable: false,
      emailVerificationRequired: false,
      // Not gated on local auth, unlike the two above, but false here for the
      // same reason: this deployment has no mail server.
      notificationsAvailable: false,
      minimumPasswordLength: 12,
    });
  });

  it("requires the production owner setup code", async () => {
    const response = await authRequest("/api/auth/sign-up/email", {
      name: "No Setup Code",
      email: "missing-token@example.com",
      password: "long-enough-password",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "INVALID_SETUP_TOKEN" });
    expect(await getDb().select().from(user)).toHaveLength(0);
  });

  it("keeps bootstrap open after an invalid password", async () => {
    const response = await authRequest("/api/auth/sign-up/email", {
      name: "Short Password",
      email: "short@example.com",
      password: "too-short",
      setupToken,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await getDb().select().from(user)).toHaveLength(0);
    const methods = await authRequest("/api/auth/methods");
    expect(await methods.json()).toMatchObject({ localRegistrationOpen: true });
  });

  it("rolls back the user if credential creation fails", async () => {
    await getPool().query(`
      create function reject_test_auth_account() returns trigger
      language plpgsql as $$
      begin
        raise exception 'intentional credential failure';
      end;
      $$;
      create trigger reject_test_auth_account
      before insert on auth_account
      for each row execute function reject_test_auth_account();
    `);
    try {
      const response = await authRequest("/api/auth/sign-up/email", {
        name: "Rolled Back Owner",
        email: "rollback@example.com",
        password: "rollback-owner-password",
        setupToken,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await getDb().select().from(user)).toHaveLength(0);
      const methods = await authRequest("/api/auth/methods");
      expect(await methods.json()).toMatchObject({ localRegistrationOpen: true });
    } finally {
      await getPool().query(`
        drop trigger if exists reject_test_auth_account on auth_account;
        drop function if exists reject_test_auth_account();
      `);
    }
  });

  it("serializes concurrent setup and creates exactly one hashed credential", async () => {
    const attempts = [
      {
        name: "First Owner",
        email: "first-owner@example.com",
        password: "first-owner-password",
        setupToken,
      },
      {
        name: "Second Owner",
        email: "second-owner@example.com",
        password: "second-owner-password",
        setupToken,
      },
    ];
    const responses = await Promise.all(
      attempts.map((attempt) => authRequest("/api/auth/sign-up/email", attempt)),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winningIndex = responses.findIndex((response) => response.status === 200);
    ownerEmail = attempts[winningIndex].email;
    ownerPassword = attempts[winningIndex].password;
    ownerCookie = cookieHeader(responses[winningIndex]);
    expect(ownerCookie).toContain("better-auth.session_token=");

    const users = await getDb().select().from(user);
    const credentials = await getDb().select().from(account);
    expect(users).toHaveLength(1);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      providerId: "credential",
      userId: users[0].id,
    });
    expect(credentials[0].password).not.toBe(ownerPassword);
    expect(credentials[0].password?.length).toBeGreaterThan(30);
  });

  // This deployment names nobody in ALLOWED_EMAILS, which is the single-user
  // configuration: one account exists, the setup code is spent, and the rule
  // admits no one else. A second person cannot get in even holding the code.
  it("uses the local session and admits nobody else while the rule is closed", async () => {
    const session = await authRequest("/api/v1/session", undefined, ownerCookie);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { email: ownerEmail },
      auth: {
        mode: "local",
        localPasswordConfigured: true,
        googleLinked: false,
      },
    });
    const methods = await authRequest("/api/auth/methods");
    expect(await methods.json()).toMatchObject({
      localRegistrationOpen: false,
      awaitingFirstAccount: false,
      setupTokenRequired: false,
    });
    const secondSignup = await authRequest("/api/auth/sign-up/email", {
      name: "Another Person",
      email: "another@example.com",
      password: "another-person-password",
      setupToken,
    });
    expect(secondSignup.status).toBe(403);
    // Both halves of the transitional envelope: the flat pair a 0.1.5 client
    // reads, and the nested `error` the browser's own reader looks inside.
    // Fourteen routes grew the pair and no test held it — a regression to
    // flat-only would pass every assertion that checks only the flat keys.
    expect(await secondSignup.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      error: { code: "REGISTRATION_CLOSED" },
    });
    expect(await getDb().select().from(user)).toHaveLength(1);
  });

  it("rejects cross-origin finance and session mutations", async () => {
    const financeMutation = await app.request("http://localhost:3000/api/v1/preferences", {
      method: "PUT",
      headers: {
        cookie: ownerCookie,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timezone: "UTC",
        defaultCurrency: "USD",
      }),
    });
    expect(financeMutation.status).toBe(403);
    expect(await financeMutation.json()).toMatchObject({
      error: { code: "CROSS_ORIGIN_REQUEST" },
    });

    const signOut = await app.request("http://localhost:3000/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: ownerCookie,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(signOut.status).toBe(403);

    const session = await authRequest("/api/v1/session", undefined, ownerCookie);
    expect(session.status).toBe(200);
  });

  it("rejects a wrong password and signs in with the configured password", async () => {
    const wrong = await authRequest("/api/auth/sign-in/email", {
      email: ownerEmail,
      password: "this-password-is-wrong",
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);

    const correct = await authRequest("/api/auth/sign-in/email", {
      email: ownerEmail,
      password: ownerPassword,
      rememberMe: true,
    });
    expect(correct.status).toBe(200);
    const cookie = cookieHeader(correct);
    expect(cookie).toContain("better-auth.session_token=");
    const session = await authRequest("/api/v1/session", undefined, cookie);
    expect(session.status).toBe(200);
  });

  it("completes local MCP authorization with a native form and PKCE", async () => {
    const registration = await oauthClientRequest(
      "/api/auth/mcp/register",
      JSON.stringify({
        client_name: "Local authentication integration",
        redirect_uris: ["http://127.0.0.1:7777/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
      "application/json",
    );
    expect([200, 201]).toContain(registration.status);
    const client = (await registration.json()) as { client_id: string };
    const verifier = "integration-local-auth-verifier-012345678901234567890123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL("http://localhost:3000/api/auth/mcp/authorize");
    authorizeUrl.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:7777/callback",
      response_type: "code",
      // Deliberately omit prompt=consent. The server must enforce consent even
      // for an untrusted dynamically registered client requesting write access.
      scope: "openid profile email ledger:write",
      state: "local-auth-integration",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const authorize = await app.request(authorizeUrl.toString());
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get("location")).toContain("/sign-in?");
    const promptCookie = cookieHeader(authorize);
    expect(promptCookie).toContain("oidc_login_prompt=");

    const login = await formRequest(
      "/api/auth/sign-in/email",
      { email: ownerEmail, password: ownerPassword },
      promptCookie,
    );
    expect(login.status).toBe(302);
    const consentPage = new URL(login.headers.get("location")!, "http://localhost:3000");
    expect(consentPage.origin + consentPage.pathname).toBe("http://localhost:3000/oauth/consent");
    expect(consentPage.searchParams.get("scope")).toContain("ledger:write");
    const consentCode = consentPage.searchParams.get("consent_code");
    expect(consentCode).toBeTruthy();

    const consent = await authRequest(
      "/api/auth/oauth2/consent",
      { accept: true, consent_code: consentCode },
      cookieHeader(login),
    );
    expect(consent.status).toBe(200);
    const consentPayload = (await consent.json()) as { redirectURI: string };
    const callback = new URL(consentPayload.redirectURI);
    expect(callback.origin + callback.pathname).toBe("http://127.0.0.1:7777/callback");
    expect(callback.searchParams.get("state")).toBe("local-auth-integration");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await oauthClientRequest(
      "/api/auth/mcp/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: code!,
        redirect_uri: "http://127.0.0.1:7777/callback",
        code_verifier: verifier,
      }).toString(),
      "application/x-www-form-urlencoded",
    );
    expect(token.status).toBe(200);
    const tokenPayload = (await token.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
    };
    expect(tokenPayload).toMatchObject({
      token_type: "Bearer",
      scope: "openid profile email ledger:write",
    });
    expect(tokenPayload.access_token.split(".")).toHaveLength(3);

    const mcp = await app.request("http://localhost:3000/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "auth-integration", version: "1.0.0" },
        },
      }),
    });
    expect(mcp.status).toBe(200);
    expect(await mcp.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "simple-balance" } },
    });
  });

  it.each([
    ["no body at all", undefined],
    ["a truncated object", "{"],
    ["something that is not JSON", "not json"],
  ])("answers 400 rather than 500 for %s", async (_label, raw) => {
    const response = await app.request("http://localhost:3000/api/v1/accounts", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "x-forwarded-for": fromNewClient(),
        "content-type": "application/json",
        cookie: ownerCookie,
      },
      body: raw,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it.each(["/api/v1/does-not-exist", "/api/v1/transactions/", "/api/v1/accounts/"])(
    "answers a JSON 404 for the unmatched path %s",
    async (path) => {
      const response = await authRequest(path, undefined, ownerCookie);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    },
  );

  it("tells caches not to keep a response carrying a session token", async () => {
    const sessions = await authRequest("/api/auth/list-sessions", undefined, ownerCookie);
    expect(sessions.status).toBe(200);
    expect(sessions.headers.get("cache-control")).toBe("no-store");
  });

  it("leaves the public signing keys cacheable", async () => {
    const jwks = await authRequest("/api/auth/mcp/jwks");
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("answers a malformed consent cookie without a 500", async () => {
    const response = await app.request("http://localhost:3000/api/auth/oauth2/consent-request", {
      headers: {
        origin: "http://localhost:3000",
        "x-forwarded-for": fromNewClient(),
        cookie: `${ownerCookie}; oidc_consent_prompt=%zz`,
      },
    });
    expect(response.status).toBeLessThan(500);
  });
});
