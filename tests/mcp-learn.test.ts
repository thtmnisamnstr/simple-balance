import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEARN_PACK } from "../src/server/learn/pack.js";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * The two tools that carry the money guides, over the SDK's own client.
 *
 * The in-memory pair validates every reply against the output schema the tool
 * published, so a result that does not satisfy it fails the call here as it
 * would for an agent. What it skips is the bearer token and the HTTP
 * transport, which `tests/integration/mcp-learn.integration.test.ts` covers.
 */
async function connect(scopes: string[]) {
  const server = createMcpServer(
    { userId: "learn-reader", source: "mcp", clientId: "learn-reader" },
    new Set(scopes),
  );
  const client = new Client({ name: "learn-reader", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      const reply = await client.callTool({ name, arguments: args });
      return { reply, result: (reply.structuredContent as { result: T }).result };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

type Article = {
  slug: string;
  url: string;
  markdown: string;
  syncedAt: string;
  inSimpleBalance: { step: string; how: string; tools: { name: string; held: boolean }[] }[];
};

describe("the money guides an agent can read", () => {
  it("lists every guide in the site's reading order, as one page", async () => {
    const session = await connect(["ledger:read"]);
    try {
      const { reply, result } = await session.call<{
        items: { slug: string; updated: string }[];
        nextCursor: string | null;
      }>("list_learn_articles");
      expect(reply.isError).toBeFalsy();
      expect(result.items.map((item) => item.slug)).toEqual(
        LEARN_PACK.articles.map((article) => article.slug),
      );
      expect(result.nextCursor).toBeNull();
      // A list is for choosing, so the guide's text is not in it.
      expect(JSON.stringify(result)).not.toContain("## Sources");
    } finally {
      await session.close();
    }
  });

  it("hands over a guide as the exact bytes the site publishes", async () => {
    const session = await connect(["ledger:read"]);
    try {
      for (const article of LEARN_PACK.articles) {
        const { reply, result } = await session.call<Article>("get_learn_article", {
          slug: article.slug,
        });
        expect(reply.isError, article.slug).toBeFalsy();
        expect(result.markdown, article.slug).toBe(article.lines.join("\n"));
        expect(result.url).toBe(article.url);
        expect(result.syncedAt).toBe(LEARN_PACK.source.syncedAt);
        expect(result.inSimpleBalance.map((one) => one.step)).toHaveLength(article.steps.length);
      }
    } finally {
      await session.close();
    }
  });

  it("names the guides there are when asked for one that is not", async () => {
    const session = await connect(["ledger:read"]);
    try {
      const { reply, result } = await session.call<{
        error: { code: string; message: string; details: { available: string[] } };
      }>("get_learn_article", { slug: "fifty-thirty-twenty" });
      expect(reply.isError).toBe(true);
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("`list_learn_articles`");
      expect(result.error.details.available).toEqual(
        LEARN_PACK.articles.map((article) => article.slug),
      );
    } finally {
      await session.close();
    }
  });

  /**
   * `held` is the grant's answer and nothing else's: the same step, read by a
   * token that may only read and by one that may write, differs exactly where
   * the tool's tier does.
   */
  it("says which mapped tools this connection holds", async () => {
    const held = async (scopes: string[]) => {
      const session = await connect(scopes);
      try {
        const { result } = await session.call<Article>("get_learn_article", {
          slug: "make-a-budget",
        });
        return new Map(
          result.inSimpleBalance.flatMap((step) =>
            step.tools.map((tool) => [tool.name, tool.held] as const),
          ),
        );
      } finally {
        await session.close();
      }
    };
    const reading = await held(["ledger:read"]);
    const writing = await held(["ledger:write"]);
    expect(reading.get("create_budget_plan")).toBe(false);
    expect(writing.get("create_budget_plan")).toBe(true);
    expect(reading.get("get_budget_report")).toBe(true);
    expect(writing.get("get_budget_report")).toBe(true);
    // Staging is its own tier: a staging token holds `stage_csv` and not a
    // committed write.
    expect((await held(["ledger:stage"])).get("stage_csv")).toBe(true);
  });

  it("is not offered to a token with no ledger scope", async () => {
    const session = await connect(["openid", "profile", "email"]);
    try {
      const listed = await session.client.listTools().catch((error: Error) => error);
      if (Array.isArray((listed as { tools?: unknown[] }).tools)) {
        expect((listed as { tools: unknown[] }).tools).toEqual([]);
      } else {
        expect(String(listed)).toMatch(/Method not found/);
      }
    } finally {
      await session.close();
    }
  });
});

describe("where the guides come from", () => {
  /**
   * No actor and no database, by construction rather than by care. A guide is
   * the same text for every caller, so a read of somebody's ledger reached
   * from here would be a different function — and arguing for one starts by
   * changing this test.
   */
  it("reads nothing under the database layer", () => {
    const source = readFileSync("src/server/services/learn.ts", "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((specifier) => /\bdb\b|drizzle|pg\b/.test(specifier))).toEqual([]);
    expect(source).not.toMatch(/\bactor\b\s*:/);
  });
});
