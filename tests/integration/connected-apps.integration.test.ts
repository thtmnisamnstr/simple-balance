import { eq } from "drizzle-orm";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { closeDb, getDb } from "../../src/server/db/client.js";
import { runMigrations } from "../../src/server/db/migrate.js";
import {
  auditEvents,
  oauthAccessToken,
  oauthApplication,
  oauthConsent,
  user,
} from "../../src/server/db/schema.js";
import {
  listConnectedApps,
  revokeConnectedApp,
} from "../../src/server/services/connected-apps.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_connapps_${process.pid}_${Date.now()}`;
const owner: Actor = { userId: "connected-apps-owner", source: "web" };
const stranger: Actor = { userId: "connected-apps-stranger", source: "web" };
const originalDatabaseUrl = process.env.DATABASE_URL;
let adminClient: PgClient;

const hour = 60 * 60 * 1000;
let seed = 0;

async function registerClient(clientId: string, name: string) {
  await getDb().insert(oauthApplication).values({
    id: `app-${clientId}`,
    name,
    clientId,
    redirectUrls: "http://127.0.0.1:7777/callback",
    type: "web",
  });
}

async function grant(
  actor: Actor,
  clientId: string,
  scopes: string,
  options: { accessMs?: number; refreshMs?: number; token?: boolean } = {},
) {
  const { accessMs = hour, refreshMs = 24 * hour, token = true } = options;
  await getDb().insert(oauthConsent).values({
    id: `consent-${(seed += 1)}`,
    clientId,
    userId: actor.userId,
    scopes,
    consentGiven: true,
  });
  if (!token) return;
  await getDb().insert(oauthAccessToken).values({
    id: `token-${(seed += 1)}`,
    accessToken: `access-${seed}`,
    refreshToken: `refresh-${seed}`,
    accessTokenExpiresAt: new Date(Date.now() + accessMs),
    refreshTokenExpiresAt: new Date(Date.now() + refreshMs),
    clientId,
    userId: actor.userId,
    scopes,
  });
}

integration("revoking an agent's access from the browser", () => {
  beforeAll(async () => {
    adminClient = new PgClient({ connectionString: connection });
    await adminClient.connect();
    await adminClient.query(`create database "${databaseName}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    await runMigrations();
    await getDb().insert(user).values([
      {
        id: owner.userId,
        name: "Owner",
        email: "connected-apps-owner@example.com",
        emailVerified: true,
      },
      {
        id: stranger.userId,
        name: "Stranger",
        email: "connected-apps-stranger@example.com",
        emailVerified: true,
      },
    ]);
  });

  afterAll(async () => {
    await closeDb();
    await adminClient.query(`drop database if exists "${databaseName}"`);
    await adminClient.end();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("lists what was approved, with what it may do", async () => {
    await registerClient("client-reader", "Reading Agent");
    await grant(owner, "client-reader", "openid ledger:read");

    const [app] = await listConnectedApps(owner);
    expect(app.clientId).toBe("client-reader");
    expect(app.name).toBe("Reading Agent");
    expect(app.scopes).toContain("ledger:read");
    expect(app.hasLiveAccess).toBe(true);
    expect(app.activeTokenCount).toBe(1);
  });

  // The listing is the revocation screen, so a grant with no live token still
  // has to appear: it is the standing permission to come back without asking.
  it("lists a grant whose tokens have all expired", async () => {
    await registerClient("client-lapsed", "Lapsed Agent");
    await grant(owner, "client-lapsed", "ledger:read", {
      accessMs: -hour,
      refreshMs: -hour,
    });

    const apps = await listConnectedApps(owner);
    const lapsed = apps.find((app) => app.clientId === "client-lapsed");
    expect(lapsed).toBeDefined();
    expect(lapsed!.hasLiveAccess).toBe(false);
    expect(lapsed!.activeTokenCount).toBe(0);
  });

  it("shows nobody else's grants, and cannot revoke them", async () => {
    await registerClient("client-theirs", "Their Agent");
    await grant(stranger, "client-theirs", "ledger:write");

    const mine = await listConnectedApps(owner);
    expect(mine.map((app) => app.clientId)).not.toContain("client-theirs");

    await expect(revokeConnectedApp(owner, "client-theirs")).rejects.toThrow(
      /No access for that application was found/,
    );
    // Theirs is untouched.
    const theirs = await listConnectedApps(stranger);
    expect(theirs.map((app) => app.clientId)).toContain("client-theirs");
  });

  it("deletes the tokens rather than waiting for them to expire", async () => {
    await registerClient("client-revoke", "Doomed Agent");
    await grant(owner, "client-revoke", "ledger:read ledger:write");

    const before = await getDb()
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, "client-revoke"));
    expect(before).toHaveLength(1);

    const result = await revokeConnectedApp(owner, "client-revoke");
    expect(result.revokedTokenCount).toBe(1);
    expect(result.name).toBe("Doomed Agent");

    // Both halves of the row are gone, so the refresh token cannot mint more.
    const after = await getDb()
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, "client-revoke"));
    expect(after).toHaveLength(0);

    // And the consent, so it cannot walk back in without being asked again.
    const consents = await getDb()
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.clientId, "client-revoke"));
    expect(consents).toHaveLength(0);

    const apps = await listConnectedApps(owner);
    expect(apps.map((app) => app.clientId)).not.toContain("client-revoke");
  });

  it("leaves the same client working for somebody else who approved it", async () => {
    await registerClient("client-shared", "Shared Agent");
    await grant(owner, "client-shared", "ledger:read");
    await grant(stranger, "client-shared", "ledger:read");

    await revokeConnectedApp(owner, "client-shared");

    expect(
      (await listConnectedApps(owner)).map((app) => app.clientId),
    ).not.toContain("client-shared");
    const theirs = await listConnectedApps(stranger);
    expect(theirs.map((app) => app.clientId)).toContain("client-shared");
    expect(theirs.find((app) => app.clientId === "client-shared")!.hasLiveAccess).toBe(
      true,
    );
    // The registration itself survives, because it is not this person's to delete.
    const registration = await getDb()
      .select()
      .from(oauthApplication)
      .where(eq(oauthApplication.clientId, "client-shared"));
    expect(registration).toHaveLength(1);
  });

  it("writes the revocation to the audit log", async () => {
    await registerClient("client-audited", "Audited Agent");
    await grant(owner, "client-audited", "ledger:read");
    await revokeConnectedApp(owner, "client-audited");

    const events = await getDb()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, "client-audited"));
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("connected_app");
    expect(events[0].operation).toBe("revoke");
    expect(events[0].userId).toBe(owner.userId);
  });

  it("says so rather than pretending, when there is nothing to revoke", async () => {
    await expect(
      revokeConnectedApp(owner, "client-never-existed"),
    ).rejects.toThrow(/No access for that application was found/);
  });
});

integration("keeping dynamic client registration from growing forever", () => {
  const pruneDatabase = `simple_balance_prune_${process.pid}_${Date.now()}`;
  let pruneAdmin: PgClient;
  let app: (typeof import("../../src/server/api.js"))["default"];
  const BASE = "http://localhost:3000";

  beforeAll(async () => {
    pruneAdmin = new PgClient({ connectionString: connection });
    await pruneAdmin.connect();
    await pruneAdmin.query(`create database "${pruneDatabase}"`);
    const databaseUrl = new URL(connection!);
    databaseUrl.pathname = `/${pruneDatabase}`;
    process.env.DATABASE_URL = databaseUrl.toString();
    process.env.APP_BASE_URL = BASE;
    process.env.AUTH_SECRET = "prune-secret-at-least-32-characters-long";
    process.env.NODE_ENV = "production";
    vi.resetModules();
    const { runMigrations: migrate } = await import("../../src/server/db/migrate.js");
    await migrate();
    const { getDb: db } = await import("../../src/server/db/client.js");
    const { user: users } = await import("../../src/server/db/schema.js");
    await db().insert(users).values({
      id: owner.userId,
      name: "Owner",
      email: "prune-owner@example.com",
      emailVerified: true,
    });
    ({ default: app } = await import("../../src/server/api.js"));
  });

  afterAll(async () => {
    const { closeDb: shut } = await import("../../src/server/db/client.js");
    await shut();
    await pruneAdmin.query(`drop database if exists "${pruneDatabase}"`);
    await pruneAdmin.end();
    delete process.env.APP_BASE_URL;
    delete process.env.AUTH_SECRET;
    delete process.env.NODE_ENV;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const register = (body: Record<string, unknown>) =>
    app.request(`${BASE}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // 60 KiB of client_name fits inside the 64 KiB auth body limit, and used to
  // land in a row nothing would ever delete.
  it("clamps a client name that tries to park kilobytes in the table", async () => {
    const response = await register({
      client_name: "N".repeat(60_000),
      redirect_uris: ["http://127.0.0.1:7777/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    expect([200, 201]).toContain(response.status);
    const { client_id: clientId } = (await response.json()) as { client_id: string };

    const { getDb: db } = await import("../../src/server/db/client.js");
    const { oauthApplication: table } = await import("../../src/server/db/schema.js");
    const [row] = await db()
      .select()
      .from(table)
      .where(eq(table.clientId, clientId));
    expect(row.name.length).toBe(200);
  });

  it("caps how many redirect URIs one registration can carry", async () => {
    const response = await register({
      client_name: "Many Redirects",
      redirect_uris: Array.from({ length: 500 }, (_, i) => `http://127.0.0.1:7777/cb${i}`),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    expect([200, 201]).toContain(response.status);
    const { client_id: clientId } = (await response.json()) as { client_id: string };
    const { getDb: db } = await import("../../src/server/db/client.js");
    const { oauthApplication: table } = await import("../../src/server/db/schema.js");
    const [row] = await db()
      .select()
      .from(table)
      .where(eq(table.clientId, clientId));
    expect(row.redirectUrls.split(",").length).toBeLessThanOrEqual(20);
  });

  it("sweeps a registration nobody ever completed, and keeps one that was", async () => {
    const { getDb: db } = await import("../../src/server/db/client.js");
    const { oauthApplication: apps, oauthConsent: consents } = await import(
      "../../src/server/db/schema.js"
    );
    const { pruneAbandonedClients: prune } = await import(
      "../../src/server/services/connected-apps.js"
    );
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await db().insert(apps).values([
      {
        id: "abandoned-app",
        name: "Abandoned",
        clientId: "abandoned-client",
        redirectUrls: "http://127.0.0.1:7777/cb",
        type: "web",
        createdAt: old,
        updatedAt: old,
      },
      {
        id: "approved-app",
        name: "Approved",
        clientId: "approved-client",
        redirectUrls: "http://127.0.0.1:7777/cb",
        type: "web",
        createdAt: old,
        updatedAt: old,
      },
      {
        id: "fresh-app",
        name: "Fresh",
        clientId: "fresh-client",
        redirectUrls: "http://127.0.0.1:7777/cb",
        type: "web",
      },
    ]);
    await db().insert(consents).values({
      id: "keeps-approved",
      clientId: "approved-client",
      userId: owner.userId,
      scopes: "ledger:read",
      consentGiven: true,
    });

    await prune();

    const remaining = (await db().select().from(apps)).map((row) => row.clientId);
    expect(remaining).not.toContain("abandoned-client");
    // Approved by somebody, so not this sweep's business.
    expect(remaining).toContain("approved-client");
    // Too new to judge: an authorization may still be in flight.
    expect(remaining).toContain("fresh-client");
  });
});
