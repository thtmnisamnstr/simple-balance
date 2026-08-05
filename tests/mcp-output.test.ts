import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

describe("MCP output contracts", () => {
  const resources: {
    client?: Client;
    server?: ReturnType<typeof createMcpServer>;
  } = {};

  afterEach(async () => {
    await resources.client?.close();
    await resources.server?.close();
    resources.client = undefined;
    resources.server = undefined;
  });

  it("publishes concrete, operation-specific schemas for every tool", async () => {
    resources.server = createMcpServer(
      { userId: "schema-user", source: "mcp", clientId: "schema-test" },
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    resources.client = new Client({
      name: "output-schema-test",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await resources.server.connect(serverTransport);
    await resources.client.connect(clientTransport);

    const { tools } = await resources.client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      const output = tool.outputSchema as {
        properties?: {
          result?: {
            anyOf?: unknown[];
          };
        };
      };
      const variants = output.properties?.result?.anyOf;
      expect(variants, `${tool.name} must declare success and error results`)
        .toHaveLength(2);
      expect(variants?.[0], `${tool.name} success result must be concrete`)
        .not.toEqual({});
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const listAccountSchema = JSON.stringify(
      byName.get("list_accounts")?.outputSchema,
    );
    const createAccountSchema = JSON.stringify(
      byName.get("create_account")?.outputSchema,
    );
    const transactionSchema = JSON.stringify(
      byName.get("create_transaction")?.outputSchema,
    );
    const payeeSchema = JSON.stringify(byName.get("list_payees")?.outputSchema);
    const categorySchema = JSON.stringify(
      byName.get("list_categories")?.outputSchema,
    );
    const mergePayeeSchema = JSON.stringify(
      byName.get("merge_payees")?.outputSchema,
    );
    const bulkPreviewSchema = JSON.stringify(
      byName.get("preview_bulk_transaction_selection")?.outputSchema,
    );
    const bulkEditSchema = JSON.stringify(
      byName.get("bulk_edit_transactions")?.outputSchema,
    );
    const bulkEditInputSchema = JSON.stringify(
      byName.get("bulk_edit_transactions")?.inputSchema,
    );
    expect(listAccountSchema).toContain('"type":"array"');
    expect(createAccountSchema).toContain('"openingBalance"');
    expect(transactionSchema).toContain('"destinationAmount"');
    expect(payeeSchema).toContain('"stagedTransactionCount"');
    // Published rather than merely tolerated: the result schema passes unknown
    // keys through, so a count that is not declared here is one no agent can
    // discover from the tool listing.
    expect(categorySchema).toContain('"transactionCount"');
    expect(categorySchema).toContain('"stagedTransactionCount"');
    expect(categorySchema).toContain('"totalCount"');
    expect(mergePayeeSchema).toContain('"mergedSourcePayees"');
    expect(bulkPreviewSchema).toContain('"fingerprint"');
    expect(bulkPreviewSchema).toContain('"transferCount"');
    expect(bulkEditSchema).toContain('"selectionFingerprint"');
    expect(bulkEditSchema).toContain('"itemsTruncated"');
    expect(bulkEditInputSchema).toContain('"expectedFingerprint"');
    expect(
      byName.get("preview_bulk_transaction_selection")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(
      byName.get("bulk_edit_transactions")?.annotations?.destructiveHint,
    ).toBe(true);
    expect(createAccountSchema).not.toEqual(transactionSchema);
  });
});

describe("revoking an agent over MCP", () => {
  const resources: {
    client?: Client;
    server?: ReturnType<typeof createMcpServer>;
  } = {};

  afterEach(async () => {
    await resources.client?.close();
    await resources.server?.close();
    resources.client = undefined;
    resources.server = undefined;
  });

  async function toolsFor(scopes: string[]) {
    resources.server = createMcpServer(
      { userId: "revoke-scope-user", source: "mcp", clientId: "revoke-scope" },
      new Set(scopes),
    );
    resources.client = new Client({ name: "revoke-scope-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await resources.server.connect(serverTransport);
    await resources.client.connect(clientTransport);
    const { tools } = await resources.client.listTools();
    return tools.map((tool) => tool.name);
  }

  // The listing was registered outside every scope check, so a token holding no
  // ledger scope at all could enumerate somebody's connected agents. With it
  // back inside the read gate such a token has no tools whatsoever, and a
  // server with none does not offer tools/list at all.
  it("offers neither to a token with no ledger scope", async () => {
    const names = await toolsFor(["openid", "profile", "email"]).catch(
      (error: Error) => error,
    );
    if (Array.isArray(names)) {
      expect(names).not.toContain("list_connected_agents");
      expect(names).not.toContain("revoke_connected_agent");
      return;
    }
    expect(String(names)).toMatch(/Method not found/);
  });

  // Seeing what has access is a read. Taking it away is not, so an agent given
  // only read cannot lock the other agents out.
  it("offers the listing at read scope but not the revoke", async () => {
    const names = await toolsFor(["ledger:read"]);
    expect(names).toContain("list_connected_agents");
    expect(names).not.toContain("revoke_connected_agent");
  });

  it("offers both at write scope", async () => {
    const names = await toolsFor(["ledger:read", "ledger:write"]);
    expect(names).toContain("list_connected_agents");
    expect(names).toContain("revoke_connected_agent");
  });

  it("does not offer the revoke at stage scope", async () => {
    const names = await toolsFor(["ledger:stage"]);
    expect(names).toContain("list_connected_agents");
    expect(names).not.toContain("revoke_connected_agent");
  });
});
