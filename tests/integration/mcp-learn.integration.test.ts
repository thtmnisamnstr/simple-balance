import { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The money guides over `/mcp` itself, with a bearer token, which is the
 * connection an agent really has.
 *
 * `AGENTS.md`: a tool whose result does not satisfy its declared output schema
 * fails the call, so new tools are exercised over a real connection rather than
 * trusted to their schema. The in-memory suite (`tests/mcp-learn.test.ts`)
 * already parses every reply against the published schema; what only this one
 * sees is the scope gate the bearer token passes through, the transport's JSON
 * mode, and `held` answered from a grant that came out of the token table
 * rather than out of a test's own `Set`.
 *
 * Nothing here touches a ledger, and that is part of what is being shown: the
 * account that owns the token has no accounts, categories or entries, and every
 * guide still comes back whole.
 */
const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const databaseName = `simple_balance_mcp_learn_${process.pid}_${Date.now()}`;
const BASE = "http://localhost:3000";

type App = (typeof import("../../src/server/api.js"))["default"];

const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  AUTH_MODE: process.env.AUTH_MODE,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

let admin: PgClient;
let app: App;
let closeDb: () => Promise<void>;
let ownerId = "";

/** A bearer token for this person, holding exactly `scopes`. */
async function tokenFor(name: string, scopes: string) {
  const { getDb } = await import("../../src/server/db/client.js");
  const { oauthAccessToken, oauthApplication } = await import("../../src/server/db/schema.js");
  const { issueMcpAccessToken } = await import("../../src/server/mcp-token.js");
  await getDb()
    .insert(oauthApplication)
    .values({
      id: `${name}-app`,
      name: `Learn agent ${name}`,
      clientId: `${name}-agent`,
      redirectUrls: "http://127.0.0.1:7777/callback",
      type: "public",
      userId: ownerId,
    });
  await getDb()
    .insert(oauthAccessToken)
    .values({
      id: `${name}-token`,
      accessToken: `${name}-opaque-access-token`,
      refreshToken: `${name}-opaque-refresh-token`,
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 120_000),
      clientId: `${name}-agent`,
      userId: ownerId,
      scopes,
    });
  return issueMcpAccessToken(`${name}-opaque-access-token`);
}

async function connect(token: string) {
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => app.request(String(url), init),
  });
  const client = new Client({ name: "learn-http", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

integration("the money guides over a real connection", () => {
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
    process.env.AUTH_SECRET = "mcp-learn-route-secret-at-least-32-characters";
    process.env.ALLOWED_EMAILS = "learn@example.test";
    process.env.TRUST_PROXY = "true";

    vi.resetModules();
    const migrate = await import("../../src/server/db/migrate.js");
    await migrate.runMigrations();
    closeDb = (await import("../../src/server/db/client.js")).closeDb;
    app = (await import("../../src/server/api.js")).default;

    const signUp = await app.request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Learner",
        email: "learn@example.test",
        password: "mcp-learn-route-password",
      }),
    });
    expect(signUp.status).toBe(200);
    ownerId = ((await signUp.json()) as { user: { id: string } }).user.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await closeDb?.();
    } finally {
      try {
        await admin?.query(`drop database if exists "${databaseName}"`);
      } finally {
        await admin?.end();
        for (const [key, value] of Object.entries(originalEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  });

  it("lists every guide and reads each one whole, to a read-only token", async () => {
    const { LEARN_PACK } = await import("../../src/server/learn/pack.js");
    const client = await connect(await tokenFor("reader", "openid ledger:read"));
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["list_learn_articles", "get_learn_article"]));

      const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
        const reply = await client.callTool({ name, arguments: args });
        expect(JSON.stringify(reply), name).not.toContain("Output validation error");
        return { reply, result: (reply.structuredContent as { result: T }).result };
      };

      const listed = await call<{ items: { slug: string }[]; nextCursor: null }>(
        "list_learn_articles",
      );
      expect(listed.reply.isError).toBeFalsy();
      expect(listed.result.items.map((item) => item.slug)).toEqual(
        LEARN_PACK.articles.map((article) => article.slug),
      );

      for (const article of LEARN_PACK.articles) {
        const read = await call<{
          markdown: string;
          inSimpleBalance: { tools: { name: string; held: boolean }[] }[];
        }>("get_learn_article", { slug: article.slug });
        expect(read.reply.isError, article.slug).toBeFalsy();
        expect(read.result.markdown, article.slug).toBe(article.lines.join("\n"));
        // The grant came out of the token table: a read-only token holds the
        // reads a guide names and none of the writes.
        const held = new Map(
          read.result.inSimpleBalance.flatMap((step) =>
            step.tools.map((tool) => [tool.name, tool.held] as const),
          ),
        );
        if (held.has("create_account")) expect(held.get("create_account")).toBe(false);
        if (held.has("get_report")) expect(held.get("get_report")).toBe(true);
      }

      const missing = await call<{ error: { code: string; details: { available: string[] } } }>(
        "get_learn_article",
        { slug: "no-such-guide" },
      );
      expect(missing.reply.isError).toBe(true);
      expect(missing.result.error.code).toBe("NOT_FOUND");
      expect(missing.result.error.details.available).toHaveLength(LEARN_PACK.articles.length);
    } finally {
      await client.close();
    }
  });

  it("tells a writing token it holds the steps a read-only one does not", async () => {
    const client = await connect(await tokenFor("writer", "openid ledger:write"));
    try {
      const reply = await client.callTool({
        name: "get_learn_article",
        arguments: { slug: "net-worth" },
      });
      expect(JSON.stringify(reply)).not.toContain("Output validation error");
      const { inSimpleBalance } = (
        reply.structuredContent as {
          result: { inSimpleBalance: { tools: { name: string; held: boolean }[] }[] };
        }
      ).result;
      const tools = inSimpleBalance.flatMap((step) => step.tools);
      expect(tools.find((tool) => tool.name === "create_account")?.held).toBe(true);
      expect(tools.every((tool) => tool.held)).toBe(true);
    } finally {
      await client.close();
    }
  });

  /**
   * The net-worth guide's "Things it can't put a price on", followed as its
   * step map says, over the connection an agent has. A new value goes in as a
   * dated entry for the difference, so the months before it keep the value they
   * had and the trend the guide is about stays true; changing the opening
   * balance, which the map used to point at, would have moved every month. A
   * fall in the same income category reverses the gain rather than counting as
   * spending.
   */
  it("records a new value the way the net-worth step says, leaving the trend's history alone", async () => {
    const { IN_SIMPLE_BALANCE } = await import("../../src/server/learn/in-simple-balance.js");
    const step = IN_SIMPLE_BALANCE["net-worth"]!.find(
      (one) => one.step === "Things it can't put a price on",
    )!;
    expect(step.tools).toEqual(["create_account", "get_account", "create_transaction"]);

    const client = await connect(await tokenFor("valuer", "openid ledger:write"));
    const call = async <T>(name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args });
      expect(JSON.stringify(reply), name).not.toContain("Output validation error");
      expect(reply.isError, JSON.stringify(reply.structuredContent)).toBeFalsy();
      return (reply.structuredContent as { result: T }).result;
    };
    const month = (back: number) => {
      const now = new Date();
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
        .toISOString()
        .slice(0, 10);
    };
    try {
      const house = await call<{ id: string }>("create_account", {
        name: "House",
        type: "other_asset",
        currency: "USD",
        openingDate: month(3),
        openingBalance: "300000",
        idempotencyKey: "learn-valuation-house",
      });
      const { balance } = await call<{ balance: string }>("get_account", { id: house.id });
      expect(balance).toBe("300000");
      // Valued at 320,000 a month ago, then at 315,000 the same day: both are
      // entries for the difference, in one income category of their own.
      for (const [type, amount, side] of [
        ["deposit", "20000", "toAccountId"],
        ["withdrawal", "5000", "fromAccountId"],
      ] as const) {
        await call("create_transaction", {
          draft: {
            type,
            date: month(1),
            payee: "Valuation",
            [side]: house.id,
            amount,
            categoryName: "Change in value",
            categoryKind: "income",
          },
          idempotencyKey: `learn-valuation-${type}`,
        });
      }

      const trend = await call<{
        currencies: { rows: { key: string; values: string[] }[] }[];
      }>("get_report", { report: "net-worth", start: month(3), bucket: "month" });
      const row = trend.currencies[0]!.rows.find((one) => one.key === house.id)!;
      expect(row.values.slice(0, 2)).toEqual(["300000", "300000"]);
      expect(row.values.at(-1)).toBe("315000");

      const summary = await call<{
        currencies: { spendingByCategory: { category: string }[] }[];
      }>("get_financial_summary", {});
      expect(
        summary.currencies.flatMap((one) => one.spendingByCategory.map((line) => line.category)),
      ).not.toContain("Change in value");
    } finally {
      await client.close();
    }
  });
});
