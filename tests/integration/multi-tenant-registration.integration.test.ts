import { inspect } from "node:util";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { user } from "../../src/server/db/schema.js";
import { INTERNAL_ERROR_MESSAGE } from "../../src/server/services/errors.js";

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
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
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
async function startDeployment(
  allowedEmails: string | undefined,
  settings: Record<string, string> = {},
) {
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
  Object.assign(process.env, settings);

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

  /**
   * The auth library says so in the log, at the default level, and it used to
   * say it with the address: `Sign-up attempt for existing email:
   * second@anywhere.test`, written to `console` outside the gate. The line
   * stays, because a run of them is what somebody probing for accounts looks
   * like and the response hides it; the address goes.
   */
  it("logs the attempt without the address it was made for", async () => {
    const lines: string[] = [];
    const spies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map((part) => inspect(part, { depth: Infinity })).join(" "));
      }),
    );
    try {
      const duplicate = await signUp(app, {
        name: "Second Person Once More",
        email: "Second@Anywhere.test",
        password: "another-good-long-password",
      });
      expect(duplicate.status).toBeGreaterThanOrEqual(400);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(lines.join("\n")).not.toMatch(/second@anywhere\.test/i);
    expect(lines).toContainEqual(
      expect.stringContaining("[Better Auth] Sign-up attempt for existing email: [email address]"),
    );
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

    const neighbor = await signUp(app, {
      name: "Other Person",
      email: "other.person@example.com",
      password: "a-perfectly-good-password",
    });
    expect(neighbor.status).toBe(403);
    expect(await neighbor.json()).toMatchObject({
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

/**
 * Every line written to `console` while `run` runs, whole, and nothing printed.
 * Inspected rather than stringified, because a stack and a nested object are
 * where an address would be carried.
 */
async function consoleDuring(run: () => Promise<void>) {
  const lines: string[] = [];
  const spies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      lines.push(
        parts
          .map((part) => (typeof part === "string" ? part : inspect(part, { depth: Infinity })))
          .join(" "),
      );
    }),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return lines;
}

/**
 * The whole application, rather than the library alone, because what these
 * two decide is where an auth route's failure lands: in the response the
 * sign-in screen reads, and in `log.failure` rather than round it.
 */
integration("an auth route that fails, reported through the log", () => {
  let app: App;
  let getDb: Awaited<ReturnType<typeof startDeployment>>["getDb"];
  let stop: () => Promise<void>;
  type Context = Awaited<
    ReturnType<(typeof import("../../src/server/auth.js"))["getAuth"]>["$context"]
  >;
  let context: Context;

  beforeAll(async () => {
    ({ app, getDb, stop } = await startDeployment("allowed.test", {
      AUTH_MODE: "both",
      GOOGLE_CLIENT_ID: "tenant-integration-client-id",
      GOOGLE_CLIENT_SECRET: "tenant-integration-client-secret",
    }));
    const { getAuth } = await import("../../src/server/auth.js");
    context = await getAuth().$context;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await stop();
    restoreEnvironment();
  });

  /**
   * An address the list turns away: `mayCreateAuthUser` refuses in the user
   * hook, the library's `createOAuthUser` reads `.id` off nothing, and its
   * catch logs the TypeError by handing over the error as the line. Treated as
   * a string that threw inside the catch, and the refused person got an empty
   * 500 instead of the 401 the sign-in screen turns into its Google alert.
   */
  it("answers a Google sign-up the list turns away with a 401", async () => {
    const google = context.socialProviders.find((provider) => provider.id === "google")!;
    vi.spyOn(google, "verifyIdToken").mockResolvedValue(true);
    vi.spyOn(google, "getUserInfo").mockResolvedValue({
      user: { id: "google-outsider", email: "outsider@elsewhere.test", emailVerified: true },
      data: {},
    } as Awaited<ReturnType<typeof google.getUserInfo>>);

    let response: Response | undefined;
    const lines = await consoleDuring(async () => {
      response = await app.request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
          "x-forwarded-for": fromNewClient(),
        },
        body: JSON.stringify({ provider: "google", idToken: { token: "an-id-token" } }),
      });
    });

    expect(response!.status).toBe(401);
    expect(await response!.json()).toMatchObject({ code: "OAUTH_LINK_ERROR" });
    expect(await getDb().select().from(user)).toHaveLength(0);
    expect(lines.join("\n")).not.toMatch(/outsider@elsewhere\.test/i);
    expect(lines).toContainEqual(expect.stringContaining("[Better Auth] Error [TypeError]"));
  });

  /**
   * A failed query inside an auth route. The library's router answered it with
   * an empty 500 and wrote `# SERVER_ERROR:` and the error whole to `console`
   * — the query's bound parameters with it, an address and a token among
   * them. Now it reaches the application's error handler.
   */
  it("hands a failed query to the application's error handler, parameters left out", async () => {
    const credentials = { email: "failing@allowed.test", password: "a-good-long-password" };
    expect((await signUp(app, { name: "Failing Query", ...credentials })).status).toBe(200);
    const failure = Object.assign(
      new Error('Failed query: insert into "auth_session" params: failing@allowed.test,tok_secret'),
      {
        query: 'insert into "auth_session" ("token", "user_id") values ($1, $2)',
        params: ["failing@allowed.test", "tok_secret"],
      },
    );
    vi.spyOn(context.internalAdapter, "createSession").mockRejectedValueOnce(failure);

    let response: Response | undefined;
    const lines = await consoleDuring(async () => {
      response = await signIn(app, credentials.email, credentials.password);
    });

    expect(response!.status).toBe(500);
    expect(await response!.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: INTERNAL_ERROR_MESSAGE },
    });
    const logged = lines.join("\n");
    expect(logged).not.toMatch(/SERVER_ERROR|failing@allowed\.test|tok_secret/);
    expect(logged).toContain(
      'Request failed: insert into "auth_session" ("token", "user_id") values ($1, $2)',
    );
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
