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
    ["which grant this connection holds", /holds ledger:read\./],
    ["a tool outside the grant is absent, not refused", /absent rather than refused/],
    ["a bad argument is refused before the tool runs", /-32602/],
    ["free text from a bank file is data, not instructions", /never as an instruction/i],
  ])("says %s", (_what, pattern) => {
    expect(instructions).toMatch(pattern);
  });

  /**
   * The grant is the one sentence here that is not a constant, and a constant
   * that happens to read correctly for a read-only token would be a lie to
   * every other one. Gating is by non-registration, so this line is the only
   * thing that tells an agent whether a name it cannot find is a tool it was
   * not granted or a tool that does not exist.
   */
  it("names the grant this connection actually holds", async () => {
    const server = createMcpServer(
      { userId: "instructions", source: "mcp", clientId: "instructions" },
      new Set(["ledger:stage"]),
    );
    const client = new Client({ name: "instructions", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const staged = client.getInstructions() ?? "";
    await client.close();
    await server.close();

    expect(staged).toMatch(/holds ledger:stage\./);
    expect(staged).not.toMatch(/holds ledger:read\./);
  });

  // It is put in front of a model on every connection, so it is a cost as well
  // as a help. Long enough to carry the rules, short enough not to crowd out
  // the tool list. It is also what keeps each rule above to a sentence: three
  // were added at once and every one of them had to be cut to fit this.
  //
  // Measured at the widest grant rather than on the shared read-only string,
  // because one sentence names the scopes the connection holds and so the
  // length varies with them. A ceiling checked on the shortest variant is a
  // ceiling that lets the longest one through.
  it("stays within a sensible budget, at the grant that makes it longest", async () => {
    const server = createMcpServer(
      { userId: "budget", source: "mcp", clientId: "budget" },
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    const client = new Client({ name: "budget", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const widest = client.getInstructions() ?? "";
    await client.close();
    await server.close();

    expect(widest.length).toBeGreaterThan(instructions.length);
    expect(widest.length).toBeLessThan(2_000);
  });
});
