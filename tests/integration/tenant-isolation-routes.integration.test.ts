import { readFileSync } from "node:fs";
import path from "node:path";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Every route that names a record in its path, asked for by somebody the record
 * does not belong to.
 *
 * `http.md` §2.1 makes it Binding that another person's record is a 404 and
 * never a 403, and cited `tenant-isolation.integration.test.ts` for it. That
 * file walks the services it imports, so a route added later went unchecked
 * until somebody remembered to add a call there, and nothing said so. This one
 * reads the routes out of the router instead, and a route with an id in its
 * path that has no probe below fails here — which is the question a new route
 * has to answer, asked when it is written rather than at an audit.
 *
 * Over HTTP rather than against the services, because the status is the
 * contract: a service that threw the right error under a transport that mapped
 * it to a 403 would pass a service test and leak the bit the rule is about.
 * Every probe carries a body the route accepts, because a refusal of the body
 * comes before the lookup and a 422 proves nothing about whose the row is.
 */

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_tenant_routes_${process.pid}_${Date.now()}`;

type App = (typeof import("../../src/server/api.js"))["default"];
const BASE = "http://localhost:3000";

/** Every `/api/v1` route with a parameter in its path, as `METHOD /path`. */
const ROUTES = [
  ...new Set(
    [
      ...readFileSync(
        path.resolve(import.meta.dirname, "../../src/server/api.ts"),
        "utf8",
      ).matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/api\/v1\/[^"]*:[^"]*)"/g),
    ].map(([, method, route]) => `${method!.toUpperCase()} ${route}`),
  ),
];

/** A path parameter that names no one's record, with why there is nothing to reach. */
const NOT_A_RECORD: Record<string, string> = {
  "GET /api/v1/reports/:report":
    "names one of the report kinds, which every person has; there is nobody else's to reach",
};

type Record_ = { id: string; version: number };
type Seed = {
  account: Record_;
  category: Record_;
  group: Record_;
  plan: Record_;
  entry: Record_;
  transaction: Record_;
  stage: Record_;
  recurrence: Record_;
  template: Record_;
  clientId: string;
  draft: Record<string, unknown>;
};
type Probe = (seed: Seed) => { id: string; body?: unknown };

const versioned = (record: Record_) => ({
  id: record.id,
  body: { expectedVersion: record.version },
});

/**
 * How to name the first person's record on each route, as the second person.
 *
 * Each body is one the route would accept from its owner, so the only thing
 * standing between the second person and the row is whose it is.
 */
const PROBES: Record<string, Probe> = {
  "GET /api/v1/accounts/:id": (seed) => ({ id: seed.account.id }),
  "GET /api/v1/accounts/:id/balances": (seed) => ({ id: seed.account.id }),
  "GET /api/v1/accounts/:id/register": (seed) => ({ id: seed.account.id }),
  "PUT /api/v1/accounts/:id": (seed) => ({
    id: seed.account.id,
    body: { name: "Taken over", expectedVersion: seed.account.version },
  }),
  "POST /api/v1/accounts/:id/archived": (seed) => ({
    id: seed.account.id,
    body: { expectedVersion: seed.account.version, archived: true },
  }),
  "POST /api/v1/accounts/:id/archive": (seed) => ({
    id: seed.account.id,
    body: { expectedVersion: seed.account.version, archived: true },
  }),
  "DELETE /api/v1/accounts/:id": (seed) => versioned(seed.account),
  "GET /api/v1/categories/:id": (seed) => ({ id: seed.category.id }),
  "PUT /api/v1/categories/:id": (seed) => ({
    id: seed.category.id,
    body: { name: "Taken over", expectedVersion: seed.category.version },
  }),
  "POST /api/v1/categories/:id/archived": (seed) => ({
    id: seed.category.id,
    body: { expectedVersion: seed.category.version, archived: true },
  }),
  "POST /api/v1/categories/:id/archive": (seed) => ({
    id: seed.category.id,
    body: { expectedVersion: seed.category.version, archived: true },
  }),
  "DELETE /api/v1/categories/:id": (seed) => versioned(seed.category),
  "PUT /api/v1/category-groups/:id": (seed) => ({
    id: seed.group.id,
    body: { name: "Taken over", expectedVersion: seed.group.version },
  }),
  "DELETE /api/v1/category-groups/:id": (seed) => versioned(seed.group),
  "GET /api/v1/budget-plans/:id": (seed) => ({ id: seed.plan.id }),
  "PUT /api/v1/budget-plans/:id": (seed) => ({
    id: seed.plan.id,
    body: { amount: "1.00", expectedVersion: seed.plan.version },
  }),
  "DELETE /api/v1/budget-plans/:id": (seed) => versioned(seed.plan),
  "DELETE /api/v1/budget-entries/:id": (seed) => versioned(seed.entry),
  "GET /api/v1/transactions/:id": (seed) => ({ id: seed.transaction.id }),
  "PUT /api/v1/transactions/:id": (seed) => ({
    id: seed.transaction.id,
    body: {
      draft: { ...seed.draft, payee: "Taken over" },
      expectedVersion: seed.transaction.version,
    },
  }),
  "POST /api/v1/transactions/:id/deleted": (seed) => ({
    id: seed.transaction.id,
    body: { expectedVersion: seed.transaction.version, deleted: true },
  }),
  "GET /api/v1/staged-transactions/:id": (seed) => ({ id: seed.stage.id }),
  "GET /api/v1/staged-transactions/:id/duplicate": (seed) => ({ id: seed.stage.id }),
  "GET /api/v1/staged/:id/duplicate": (seed) => ({ id: seed.stage.id }),
  "PUT /api/v1/staged-transactions/:id": (seed) => ({
    id: seed.stage.id,
    body: {
      draft: { ...seed.draft, payee: "Taken over" },
      expectedVersion: seed.stage.version,
    },
  }),
  "GET /api/v1/recurrences/:id": (seed) => ({ id: seed.recurrence.id }),
  "PUT /api/v1/recurrences/:id": (seed) => ({
    id: seed.recurrence.id,
    body: { name: "Taken over", expectedVersion: seed.recurrence.version },
  }),
  "DELETE /api/v1/recurrences/:id": (seed) => versioned(seed.recurrence),
  "GET /api/v1/transaction-templates/:id": (seed) => ({ id: seed.template.id }),
  "PUT /api/v1/transaction-templates/:id": (seed) => ({
    id: seed.template.id,
    body: { name: "Taken over", expectedVersion: seed.template.version },
  }),
  "DELETE /api/v1/transaction-templates/:id": (seed) => versioned(seed.template),
  "DELETE /api/v1/connected-apps/:clientId": (seed) => ({ id: seed.clientId, body: {} }),
};

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
};

let admin: PgClient;
let app: App;
let closeDb: () => Promise<void>;
const cookies = { owner: "", stranger: "" };
let seed: Seed;

const request = (who: keyof typeof cookies, route: string, init: RequestInit = {}) =>
  app.request(`${BASE}${route}`, {
    ...init,
    headers: {
      origin: BASE,
      cookie: cookies[who],
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

async function created<T>(route: string, body: unknown, method = "POST"): Promise<T> {
  const response = await request("owner", route, { method, body: JSON.stringify(body) });
  expect(response.status, `${method} ${route}: ${await response.clone().text()}`).toBeLessThan(300);
  return (await response.json()) as T;
}

async function signUp(email: string) {
  const response = await app.request(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ name: email, email, password: "tenant-routes-password" }),
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; "),
    userId: ((await response.json()) as { user: { id: string } }).user.id,
  };
}

/** Each probe's route, filled with the first person's record and asked for by the second. */
const probesInOrder = () =>
  // Deletes last, so that if one of them did reach across, it could not be
  // what made a later read come back empty for the wrong reason.
  Object.keys(PROBES).sort(
    (a, b) => Number(a.startsWith("DELETE ")) - Number(b.startsWith("DELETE ")),
  );

describe("the routes this reaches", () => {
  it("are read from the router, and there are enough of them to mean something", () => {
    expect(ROUTES.length).toBeGreaterThan(30);
    expect(ROUTES).toContain("GET /api/v1/accounts/:id");
  });

  it("each have a probe, or a reason they name nobody's record", () => {
    expect(
      ROUTES.filter((route) => !(route in PROBES) && !(route in NOT_A_RECORD)),
      "a route that names a record needs a probe here",
    ).toEqual([]);
    expect(
      [...Object.keys(PROBES), ...Object.keys(NOT_A_RECORD)].filter(
        (route) => !ROUTES.includes(route),
      ),
      "these routes are no longer registered",
    ).toEqual([]);
  });
});

integration("another person's record, by every route that names one", () => {
  beforeAll(async () => {
    admin = new PgClient({ connectionString: connection });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);
    const url = new URL(connection!);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.NODE_ENV = "development";
    process.env.AUTH_MODE = "local";
    process.env.APP_BASE_URL = BASE;
    process.env.AUTH_SECRET = "tenant-routes-secret-at-least-32-characters";
    process.env.ALLOWED_EMAILS = "owner@example.test,stranger@example.test";

    vi.resetModules();
    await (await import("../../src/server/db/migrate.js")).runMigrations();
    const client = await import("../../src/server/db/client.js");
    closeDb = client.closeDb;
    app = (await import("../../src/server/api.js")).default;

    const owner = await signUp("owner@example.test");
    cookies.owner = owner.cookie;
    cookies.stranger = (await signUp("stranger@example.test")).cookie;

    const account = await created<Record_>("/api/v1/accounts", {
      name: "Owner Checking",
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "1000",
    });
    const category = await created<Record_>("/api/v1/categories", {
      name: "Owner Groceries",
      kind: "expense",
    });
    const group = await created<Record_>("/api/v1/category-groups", {
      name: "Owner fixed costs",
      policy: "standalone",
    });
    const draft = {
      type: "withdrawal",
      date: "2026-02-01",
      payee: "Owner Only Payee",
      fromAccountId: account.id,
      categoryId: category.id,
      amount: "40.00",
    };
    const transaction = await created<Record_>("/api/v1/transactions", {
      idempotencyKey: "tenant-routes-transaction",
      draft,
    });
    const stage = await created<Record_>("/api/v1/staged-transactions", {
      idempotencyKey: "tenant-routes-stage",
      draft: { ...draft, amount: "41.00" },
    });
    const plan = await created<Record_>("/api/v1/budget-plans", {
      categoryId: category.id,
      currency: "USD",
      periodUnit: "month",
      amount: "250.00",
      activeFrom: "2026-01-01",
    });
    const entry = await created<Record_>(
      "/api/v1/budget-entries",
      {
        categoryId: category.id,
        currency: "USD",
        periodUnit: "month",
        periodStart: "2026-02-01",
        amount: "90.00",
      },
      "PUT",
    );
    const recurrence = await created<Record_>("/api/v1/recurrences", {
      name: "Owner rent",
      shape: { type: "withdrawal", payee: "Landlord", fromAccountId: account.id, amount: "900.00" },
      schedule: { frequency: "monthly", anchorDate: "2026-01-15" },
    });
    const template = await created<Record_>("/api/v1/transaction-templates", {
      name: "Owner weekly shop",
      draft: { type: "withdrawal", payee: "Corner Market", fromAccountId: account.id },
    });

    // An agent connected to the first person, which only the OAuth flow makes,
    // so its three rows are written directly as that flow would leave them.
    const { getDb } = client;
    const schema = await import("../../src/server/db/schema.js");
    const clientId = "tenant-routes-agent";
    await getDb()
      .insert(schema.oauthApplication)
      .values({
        id: `app-${clientId}`,
        name: "Owner's agent",
        clientId,
        redirectUrls: "http://127.0.0.1:7777/callback",
        type: "web",
      });
    await getDb()
      .insert(schema.oauthConsent)
      .values({
        id: `consent-${clientId}`,
        clientId,
        userId: owner.userId,
        scopes: "openid ledger:read",
        consentGiven: true,
      });
    await getDb()
      .insert(schema.oauthAccessToken)
      .values({
        id: `token-${clientId}`,
        accessToken: `access-${clientId}`,
        refreshToken: `refresh-${clientId}`,
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        clientId,
        userId: owner.userId,
        scopes: "openid ledger:read",
      });

    seed = {
      account,
      category,
      group,
      plan,
      entry,
      transaction,
      stage,
      recurrence,
      template,
      clientId,
      draft,
    };
  }, 60_000);

  afterAll(async () => {
    try {
      await closeDb?.();
    } finally {
      await admin.query(`drop database if exists "${databaseName}"`);
      await admin.end();
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("is not found, never forbidden, and never anything else", async () => {
    const answered: string[] = [];
    for (const route of probesInOrder()) {
      const [method, pattern] = route.split(" ") as [string, string];
      const { id, body } = PROBES[route]!(seed);
      const response = await request("stranger", pattern.replace(/:[A-Za-z]+/, id), {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const reply = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      if (response.status !== 404 || reply.error?.code !== "NOT_FOUND") {
        answered.push(`${route}: ${response.status} ${JSON.stringify(reply).slice(0, 200)}`);
      }
    }
    expect(answered, "these answered the wrong person with something other than not found").toEqual(
      [],
    );
  });

  it("leaves every one of the first person's records as it was", async () => {
    const versionOf = async (route: string) => {
      const response = await request("owner", route);
      expect(response.status, route).toBe(200);
      return ((await response.json()) as { version: number }).version;
    };
    expect(await versionOf(`/api/v1/accounts/${seed.account.id}`)).toBe(seed.account.version);
    expect(await versionOf(`/api/v1/categories/${seed.category.id}`)).toBe(seed.category.version);
    expect(await versionOf(`/api/v1/transactions/${seed.transaction.id}`)).toBe(
      seed.transaction.version,
    );
    expect(await versionOf(`/api/v1/staged-transactions/${seed.stage.id}`)).toBe(
      seed.stage.version,
    );
    expect(await versionOf(`/api/v1/budget-plans/${seed.plan.id}`)).toBe(seed.plan.version);
    expect(await versionOf(`/api/v1/recurrences/${seed.recurrence.id}`)).toBe(
      seed.recurrence.version,
    );
    expect(await versionOf(`/api/v1/transaction-templates/${seed.template.id}`)).toBe(
      seed.template.version,
    );
    const groups = (await (await request("owner", "/api/v1/category-groups")).json()) as Record_[];
    expect(groups.find((group) => group.id === seed.group.id)?.version).toBe(seed.group.version);
    const entries = (await (await request("owner", "/api/v1/budget-entries")).json()) as Record_[];
    expect(entries.find((entry) => entry.id === seed.entry.id)?.version).toBe(seed.entry.version);
    const agents = JSON.stringify(await (await request("owner", "/api/v1/connected-apps")).json());
    expect(agents).toContain(seed.clientId);
  });
});
