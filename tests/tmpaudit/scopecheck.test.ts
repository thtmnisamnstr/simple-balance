import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createMcpServer } from "../../src/server/mcp.js";

async function names(scopes: string[]) {
  const server = createMcpServer(
    { userId: "u", source: "mcp", clientId: "c" } as any,
    new Set(scopes),
  );
  const client = new Client({ name: "x", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

it("dump", async () => {
  const readTools = await names(["ledger:read"]);
  const all = await names(["ledger:read", "ledger:stage", "ledger:write"]);
  const out = {
    readOnlyToolNames: readTools.map((t) => t.name).sort(),
    createRecurrenceInput: all.find((t) => t.name === "create_recurrence")?.inputSchema,
    updateRecurrenceInput: all.find((t) => t.name === "update_recurrence")?.inputSchema,
    createTransactionInput: all.find((t) => t.name === "create_transaction")?.inputSchema,
    listStagedInput: all.find((t) => t.name === "list_staged_transactions")?.inputSchema,
    getStagedOutput: all.find((t) => t.name === "get_staged_transaction")?.outputSchema,
  };
  writeFileSync("/tmp/mcp-dump.json", JSON.stringify(out, null, 1));
  expect(true).toBe(true);
});
