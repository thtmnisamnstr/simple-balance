import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

type Tool = {
  name: string;
  description?: string;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

/** The `frozen` description wherever an account result carries it. */
function frozenDescriptions(node: unknown, found: string[] = []): string[] {
  if (!node || typeof node !== "object") return found;
  const record = node as Record<string, unknown>;
  const properties = record["properties"] as Record<string, { description?: string }> | undefined;
  if (properties?.["frozen"]?.description) found.push(properties["frozen"].description);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const item of value) frozenDescriptions(item, found);
    else frozenDescriptions(value, found);
  }
  return found;
}

/**
 * What an agent is told about choosing which accounts stay usable.
 *
 * The tool was registered as additive and idempotent, beside a comment saying
 * the previous list put everything back — which the choose-once rule made
 * false: the first call freezes every account it leaves out, and sending the
 * earlier list again is refused. A client that auto-approves non-destructive
 * calls would let an agent make the person's one-time choice for them without
 * a prompt. And every account result told the agent only the browser could
 * change the choice, beside a tool in `tools/list` that does.
 */
describe("set_active_accounts, as an agent meets it", () => {
  let tools: Tool[];

  beforeAll(async () => {
    const server = createMcpServer(
      { userId: "active-accounts", source: "mcp", clientId: "active-accounts" },
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    const client = new Client({ name: "active-accounts", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools as Tool[];
    await client.close();
    await server.close();
  });

  const tool = () => {
    const found = tools.find((entry) => entry.name === "set_active_accounts");
    expect(found, "set_active_accounts is registered").toBeDefined();
    return found!;
  };

  it("is marked destructive, so a client asks before an agent makes the choice", () => {
    expect(tool().annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("tells the agent the choice is the person's, and to confirm it with them", () => {
    const description = tool().description ?? "";
    expect(description).toMatch(/confirm it with the person first/i);
    expect(description).toMatch(/cannot be traded/i);
    // And that there is nothing to choose while nothing is frozen, so an agent
    // does not go on sending lists the server has to refuse.
    expect(description).toMatch(/refused while nothing is frozen/i);
  });

  it("is named wherever an account says it is frozen", () => {
    const descriptions = tools.flatMap((entry) => frozenDescriptions(entry.outputSchema));
    expect(descriptions.length, "account results carry `frozen`").toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description).toContain("set_active_accounts");
      expect(description).not.toMatch(/only .* from the browser/i);
    }
  });
});
