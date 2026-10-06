import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * `AGENTS.md`: a tool whose result does not satisfy its declared output schema
 * fails the call, so "exercise new tools over a real connection rather than
 * trusting the schema alone".
 *
 * Nothing held the second half. Thirty-nine of seventy-seven tools were called
 * by no integration test, so a wrong output schema on any of them — a field
 * declared required that a service leaves out, a number published as a string
 * — would have shipped with the unit tier green, because nothing below the
 * integration tier parses a real result against the published schema. This
 * asks that every registered tool be named by a test that runs against a
 * database, by name, so the failure says which.
 */
async function registeredTools() {
  const server = createMcpServer(
    { userId: "exercised", source: "mcp", clientId: "exercised" },
    new Set(["ledger:read", "ledger:stage", "ledger:write"]),
  );
  const client = new Client({ name: "exercised", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((tool) => tool.name);
}

describe("every tool the MCP surface registers", () => {
  it("is called over a real connection by an integration test", async () => {
    const tools = await registeredTools();
    expect(tools.length).toBeGreaterThan(70);
    const integration = globSync("tests/integration/**/*.ts")
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const neverCalled = tools
      .filter((name) => !new RegExp(`["'\`]${name}["'\`]`).test(integration))
      .sort();
    expect(neverCalled, "call it in tests/integration, against the real schema").toEqual([]);
  });
});
