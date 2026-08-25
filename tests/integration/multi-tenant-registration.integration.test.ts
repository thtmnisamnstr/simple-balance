import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "../../src/server/db/schema.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const setupToken = "multi-tenant-integration-setup-token";

type App = (typeof import("../../src/server/api.js"))["default"];

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_POOL_SIZE: process.env.DATABASE_POOL_SIZE,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  SETUP_TOKEN: process.env.SETUP_TOKEN,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

// Sign-up is rate limited to a few attempts per address per ten seconds, so
// each of these people has to arrive from somewhere of their own, the way they
// would in life. Sequential requests from one address would trip the limiter
// and prove nothing about registration.
let nextClient = 0;
function fromNewClient() {
  nextClient += 1;
  return `203.0.113.${nextClient}`;
}

function restoreEnvironment() {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Each rule needs its own process-wide config and its own empty database, so
 * every case here builds both from scratch rather than sharing them.
 */
async function startDeployment(allowedEmails: string | undefined) {
  const databaseName = `simple_balance_tenants_${process.pid}_${Date.now()}_${Math.abs(
    hash(allowedEmails ?? "closed"),
  )}`;
  const adminClient = new PgClient({ connectionString: connection });
  await adminClient.connect();
  await adminClient.query(`create database "${databaseName}"`);
  const databaseUrl = new URL(connection!);
  databaseUrl.pathname = `/${databaseName}`;

  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.DATABASE_POOL_SIZE = "1";
  process.env.NODE_ENV = "production";
  process.env.AUTH_MODE = "local";
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.AUTH_SECRET = "tenant-integration-secret-at-least-32-chars";
  process.env.SETUP_TOKEN = setupToken;
  process.env.TRUST_PROXY = "true";
  if (allowedEmails === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = allowedEmails;

  vi.resetModules();
  // Everything below has to come from the modules loaded after the reset. The
  // ones this file imported at the top belong to a previous deployment and hold
  // a pool onto a database that is about to be dropped.
  const { runMigrations } = await import("../../src/server/db/migrate.js");
  const { closeDb, getDb } = await import("../../src/server/db/client.js");
  await runMigrations();
  const { default: app } = await import("../../src/server/api.js");
  return {
    app,
    getDb,
    async stop() {
      await closeDb();
      await adminClient.query(`drop database if exists "${databaseName}"`);
      await adminClient.end();
    },
  };
}

// Only needs to separate one database name from another.
function hash(value: string) {
  let result = 0;
  for (const character of value) {
    result = (result * 31 + character.charCodeAt(0)) | 0;
  }
  return result;
}

function signUp(app: App, body: Record<string, string>, client = fromNewClient()) {
  return app.request("http://localhost:3000/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-forwarded-for": client,
    },
    body: JSON.stringify(body),
  });
}

function signIn(app: App, email: string, password: string) {
  return app.request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
      "x-forwarded-for": fromNewClient(),
    },
    body: JSON.stringify({ email, password }),
  });
}

function methods(app: App) {
  return app.request("http://localhost:3000/api/auth/methods", {
    headers: { origin: "http://localhost:3000" },
  });
}

integration("ALLOWED_EMAILS=* lets anybody register", () => {
  let app: App;
  let getDb: Awaited<ReturnType<typeof startDeployment>>["getDb"];
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ app, getDb, stop } = await startDeployment("*"));
  });
  afterAll(async () => {
    await stop();
    restoreEnvironment();
  });

  // The setup code exists to cover an address the rule would turn away. Here
  // the rule turns nobody away, so asking the first person for a code would
  // guard a door that has no walls: whoever it stopped could simply register a
  // moment later.
  it("takes the first account with no setup code", async () => {
    const claimed = await signUp(app, {
      name: "First Person",
      email: "first@anywhere.test",
      password: "first-person-password",
    });
    expect(claimed.status).toBe(200);
  });

  it("lets everyone after the first register with no code at all", async () => {
    for (const email of ["second@anywhere.test", "third@elsewhere.test"]) {
      const response = await signUp(app, {
        name: email,
        email,
        password: "another-good-long-password",
      });
      expect(response.status).toBe(200);
    }
    expect(await getDb().select().from(user)).toHaveLength(3);
  });

  it("stops advertising the setup code once the deployment is claimed", async () => {
    expect(await (await methods(app)).json()).toMatchObject({
      localRegistrationOpen: true,
      awaitingFirstAccount: false,
      setupTokenRequired: false,
    });
  });

  it("refuses a second account for an address that already has one", async () => {
    const duplicate = await signUp(app, {
      name: "Second Person Again",
      email: "second@anywhere.test",
      password: "another-good-long-password",
    });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(await getDb().select().from(user)).toHaveLength(3);
  });
});

integration("a list of domains and addresses admits exactly those", () => {
  let app: App;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ app, stop } = await startDeployment("pinecone.io, @usc.edu, one.person@example.com"));
    const claimed = await signUp(app, {
      name: "Operator",
      email: "operator@pinecone.io",
      password: "operator-account-password",
      setupToken,
    });
    expect(claimed.status).toBe(200);
  });
  afterAll(async () => {
    await stop();
    restoreEnvironment();
  });

  it("admits anybody at an allowed domain, written either way", async () => {
    for (const email of ["someone.else@pinecone.io", "student@usc.edu"]) {
      const response = await signUp(app, {
        name: email,
        email,
        password: "a-perfectly-good-password",
      });
      expect(response.status).toBe(200);
    }
  });

  it("admits a named address and nobody else at its domain", async () => {
    const named = await signUp(app, {
      name: "One Person",
      email: "one.person@example.com",
      password: "a-perfectly-good-password",
    });
    expect(named.status).toBe(200);

    const neighbour = await signUp(app, {
      name: "Other Person",
      email: "other.person@example.com",
      password: "a-perfectly-good-password",
    });
    expect(neighbour.status).toBe(403);
    expect(await neighbour.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "That email address is not allowed to register here.",
    });
  });

  // A subdomain is a different domain, and may be under someone else's control.
  it("does not admit a subdomain of an allowed domain", async () => {
    const response = await signUp(app, {
      name: "Subdomain",
      email: "someone@mail.pinecone.io",
      password: "a-perfectly-good-password",
    });
    expect(response.status).toBe(403);
  });

  it("refuses an unrelated address even with a valid setup code", async () => {
    const response = await signUp(app, {
      name: "Outsider",
      email: "outsider@example.net",
      password: "a-perfectly-good-password",
      setupToken,
    });
    expect(response.status).toBe(403);
  });

  it("matches regardless of the case the address is typed in", async () => {
    const response = await signUp(app, {
      name: "Shouty",
      email: "SHOUTY@Pinecone.IO",
      password: "a-perfectly-good-password",
    });
    expect(response.status).toBe(200);
  });
});

integration("an unset ALLOWED_EMAILS stays a one-person deployment", () => {
  let app: App;
  let getDb: Awaited<ReturnType<typeof startDeployment>>["getDb"];
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ({ app, getDb, stop } = await startDeployment(undefined));
  });
  afterAll(async () => {
    await stop();
    restoreEnvironment();
  });

  it("admits the first account and then nobody", async () => {
    expect(await (await methods(app)).json()).toMatchObject({
      localRegistrationOpen: true,
      awaitingFirstAccount: true,
    });

    const claimed = await signUp(app, {
      name: "Only Person",
      email: "only@example.com",
      password: "only-person-password",
      setupToken,
    });
    expect(claimed.status).toBe(200);

    const refused = await signUp(app, {
      name: "Second Person",
      email: "second@example.com",
      password: "second-person-password",
      setupToken,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "REGISTRATION_CLOSED",
      message: "This instance is not accepting new accounts.",
    });

    expect(await (await methods(app)).json()).toMatchObject({
      localRegistrationOpen: false,
    });
    expect(await getDb().select().from(user)).toHaveLength(1);
  });

  // The rule here admits nobody, and the one account that exists got in on the
  // setup code rather than on the rule. If the rule were also a sign-in gate,
  // that account would be locked out of its own books. It must not be, because
  // ALLOWED_EMAILS is optional and every deployment that never sets one would
  // be in exactly this position.
  it("signs in the account the closed rule does not cover", async () => {
    const session = await signIn(app, "only@example.com", "only-person-password");
    expect(session.status).toBe(200);
    const cookie = session.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toContain("better-auth.session_token=");

    const ledger = await app.request("http://localhost:3000/api/v1/session", {
      headers: { origin: "http://localhost:3000", cookie },
    });
    expect(ledger.status).toBe(200);
    expect(await ledger.json()).toMatchObject({
      user: { email: "only@example.com" },
    });
  });
});
