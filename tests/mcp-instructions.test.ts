import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * What a client puts in front of the model before it picks a tool.
 *
 * This was unset for a long time, and `docs/standards/mcp.md` called it the
 * cheapest improvement available on the surface: the tool descriptions say what
 * each call does, but nothing said what the surface *is* or which mistakes it
 * will not forgive. Everything asserted below is something an agent otherwise
 * learns by being refused.
 *
 * The assertions are on substance rather than wording, so the prose can be
 * improved without a test failing for it — but a rule going missing altogether
 * fails, which is the part worth catching.
 */
describe("the server instructions", () => {
  let instructions: string;

  beforeAll(async () => {
    const server = createMcpServer(
      { userId: "instructions", source: "mcp", clientId: "instructions" },
      new Set(["ledger:read"]),
    );
    const client = new Client({ name: "instructions", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    instructions = client.getInstructions() ?? "";
    await client.close();
    await server.close();
  });

  it("is set at all", () => {
    expect(instructions.length).toBeGreaterThan(200);
  });

  it.each([
    ["money is a string, never a JSON number", /decimal string, never a JSON number/i],
    ["no total crosses currencies", /cross currencies/i],
    ["dates are in the person's timezone", /timezone/i],
    ["a create needs an idempotency key", /idempotencyKey/],
    ["a change needs the version it read", /expectedVersion/],
    ["a stale version means re-read, not retry", /do not retry with the old version/i],
    ["staging proposes and writing decides", /ledger:stage/],
    ["amounts are positive and direction is the type", /Amounts are always positive/],
    ["a refund is not income", /refund/i],
  ])("says %s", (_what, pattern) => {
    expect(instructions).toMatch(pattern);
  });

  // It is put in front of a model on every connection, so it is a cost as well
  // as a help. Long enough to carry the rules, short enough not to crowd out
  // the tool list.
  it("stays within a sensible budget", () => {
    expect(instructions.length).toBeLessThan(2_000);
  });
});
