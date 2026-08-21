import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { ownerSetupTokens } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("setup_token");

/**
 * Every other test sets SETUP_TOKEN, which is why the generated branch went
 * three releases without anybody noticing it belonged to one process.
 *
 * Reading it twice through a cleared module cache is what stands in for a second
 * replica: two fresh imports against one database are exactly the situation two
 * pods are in, and before this they produced two different codes, each rejecting
 * the other's.
 */
const opened: (typeof import("../../src/server/db/client.js"))[] = [];

const freshImport = async () => {
  vi.resetModules();
  const module = await import("../../src/server/setup-token.js");
  // Resetting the registry gives the fresh copy its own connection pool, which
  // is what makes it stand in for another pod — and what would hold the scratch
  // database open past the drop if it were left running.
  opened.push(await import("../../src/server/db/client.js"));
  return module;
};

integration("the generated first-run setup code", () => {
  const original = {
    env: process.env.NODE_ENV,
    token: process.env.SETUP_TOKEN,
    baseUrl: process.env.APP_BASE_URL,
    secret: process.env.AUTH_SECRET,
  };

  beforeAll(async () => {
    await database.create();
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "http://localhost:3000";
    process.env.AUTH_SECRET = "setup-token-integration-secret-at-least-32";
    delete process.env.SETUP_TOKEN;
  });

  afterEach(async () => {
    await getDb().delete(ownerSetupTokens);
  });

  afterAll(async () => {
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("NODE_ENV", original.env);
    restore("SETUP_TOKEN", original.token);
    restore("APP_BASE_URL", original.baseUrl);
    restore("AUTH_SECRET", original.secret);
    for (const client of opened) await client.closeDb();
    await database.drop();
  });

  it("is the same code in a second process, and each accepts the other's", async () => {
    const first = await freshImport();
    const second = await freshImport();

    const issued = await first.getOwnerSetupToken();
    expect(issued).toBeTruthy();
    expect(await second.getOwnerSetupToken()).toBe(issued);
    expect(await second.isOwnerSetupTokenValid(issued)).toBe(true);
    expect(await first.isOwnerSetupTokenValid(issued)).toBe(true);
  });

  it("stores exactly one code however many processes ask for it", async () => {
    const processes = [await freshImport(), await freshImport(), await freshImport()];
    const codes = await Promise.all(
      processes.map((module) => module.getOwnerSetupToken()),
    );
    expect(new Set(codes).size).toBe(1);
    expect(await getDb().select().from(ownerSetupTokens)).toHaveLength(1);
  });

  it("refuses a code that is not the one it issued", async () => {
    const module = await freshImport();
    await module.getOwnerSetupToken();
    expect(await module.isOwnerSetupTokenValid("not-the-code")).toBe(false);
    expect(await module.isOwnerSetupTokenValid(undefined)).toBe(false);
  });

  it("keeps an operator-chosen code out of the database", async () => {
    process.env.SETUP_TOKEN = "operator-chosen-code";
    try {
      const module = await freshImport();
      expect(await module.getOwnerSetupToken()).toBe("operator-chosen-code");
      expect(await getDb().select().from(ownerSetupTokens)).toHaveLength(0);
    } finally {
      delete process.env.SETUP_TOKEN;
    }
  });
});
