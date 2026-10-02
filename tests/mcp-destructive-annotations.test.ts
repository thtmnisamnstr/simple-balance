import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

type Tool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

/** Whether a published input schema asks for an expected version anywhere. */
function asksForAVersion(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const record = node as Record<string, unknown>;
  const properties = record["properties"] as Record<string, unknown> | undefined;
  if (properties && Object.hasOwn(properties, "expectedVersion")) return true;
  // Anywhere, not at the top: a bulk edit carries one per row, inside an array
  // inside the arm of an `anyOf`, and a check that only read the top level
  // would pass every one of them without looking.
  return Object.values(record).some((value) =>
    Array.isArray(value) ? value.some(asksForAVersion) : asksForAVersion(value),
  );
}

/**
 * A tool that asks for an expected version is a tool that overwrites.
 *
 * `docs/standards/mcp.md` §Annotations makes `destructiveHint` a claim rather
 * than a label: it says "the call can destroy or overwrite what is already in
 * the ledger, as opposed to only adding to it", and a false claim is a defect
 * because a client reads it to decide what may run without a prompt.
 *
 * `expectedVersion` is the mechanical tell, and it is why this is a rule and
 * not a roster: a version is asked for only where there is already a row whose
 * replacement somebody could lose a race over. `set_budget_entry` was the one
 * tool on the surface that asked for one and called itself additive — it
 * overwrites the amount, writes `budgetEntry.update`, and leaves the previous
 * figure nowhere but the audit log, so the prompt it skipped was the only
 * chance to keep that figure. Its own description said so two lines above the
 * annotation that denied it.
 *
 * Over a real connection rather than against the registration source, because
 * what matters is what an agent is told in `tools/list`.
 */
describe("tools that overwrite say so", () => {
  let tools: Tool[];

  beforeAll(async () => {
    const server = createMcpServer(
      { userId: "annotations", source: "mcp", clientId: "annotations" },
      new Set(["ledger:read", "ledger:stage", "ledger:write"]),
    );
    const client = new Client({ name: "annotations", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools as Tool[];
    await client.close();
    await server.close();
  });

  const versioned = () => tools.filter((tool) => asksForAVersion(tool.inputSchema));

  /**
   * First, that the finder finds. A walk that quietly stopped matching would
   * report every tool compliant, which is the shape this whole check fails in:
   * the named four cover a flat schema, a schema built by `.extend`, and a
   * discriminated union with the version inside an array in one arm.
   */
  it("finds the schemas that ask for a version", () => {
    const names = versioned().map((tool) => tool.name);
    expect(names).toContain("update_transaction");
    expect(names).toContain("archive_account");
    expect(names).toContain("set_budget_entry");
    expect(names).toContain("bulk_edit_transactions");
    expect(names.length).toBeGreaterThan(20);
  });

  it("annotates every one of them destructive", () => {
    for (const tool of versioned()) {
      expect(
        tool.annotations?.["readOnlyHint"],
        `${tool.name} asks for an expectedVersion, so it writes`,
      ).toBe(false);
      expect(
        tool.annotations?.["destructiveHint"],
        `${tool.name} asks for an expectedVersion, so it can overwrite a row that is already there`,
      ).toBe(true);
    }
  });

  /**
   * And the one that was wrong carries the wording its class owes, since a
   * client that auto-approved it yesterday will prompt for it today and the
   * person being asked needs to know what is at stake.
   */
  it("tells an agent what replacing a budget entry costs", () => {
    const tool = tools.find((entry) => entry.name === "set_budget_entry");
    expect(tool, "set_budget_entry is registered").toBeDefined();
    expect(tool!.description).toMatch(/confirm/i);
    expect(tool!.description).toMatch(/audit log/i);
    expect(tool!.description).toContain("delete_budget_entry");
  });
});
