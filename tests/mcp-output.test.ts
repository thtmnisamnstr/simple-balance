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
