import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createMcpServer, withoutUserId } from "../src/server/mcp.js";
import { actorSources, serviceErrorCodes } from "../src/shared/domain.js";
import {
  auditEventResultSchema,
  identityResultSchema,
  mcpOutputSchema,
} from "../src/server/mcp-output-schemas.js";

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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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
      expect(variants, `${tool.name} must declare success and error results`).toHaveLength(2);
      expect(variants?.[0], `${tool.name} success result must be concrete`).not.toEqual({});
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const listAccountSchema = JSON.stringify(byName.get("list_accounts")?.outputSchema);
    const createAccountSchema = JSON.stringify(byName.get("create_account")?.outputSchema);
    const transactionSchema = JSON.stringify(byName.get("create_transaction")?.outputSchema);
    const payeeSchema = JSON.stringify(byName.get("list_payees")?.outputSchema);
    const categorySchema = JSON.stringify(byName.get("list_categories")?.outputSchema);
    const mergePayeeSchema = JSON.stringify(byName.get("merge_payees")?.outputSchema);
    const bulkPreviewSchema = JSON.stringify(
      byName.get("preview_bulk_transaction_selection")?.outputSchema,
    );
    const bulkEditSchema = JSON.stringify(byName.get("bulk_edit_transactions")?.outputSchema);
    const bulkEditInputSchema = JSON.stringify(byName.get("bulk_edit_transactions")?.inputSchema);
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
    expect(byName.get("preview_bulk_transaction_selection")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("bulk_edit_transactions")?.annotations?.destructiveHint).toBe(true);
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
    const names = await toolsFor(["openid", "profile", "email"]).catch((error: Error) => error);
    // Empty, not merely missing the two this was written for. Naming them left
    // the branch accepting any other tool reaching a token with no ledger scope
    // at all, which is the failure the assertion exists to catch.
    if (Array.isArray(names)) {
      expect(names).toEqual([]);
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

describe("every actor source an audit row can carry", () => {
  /**
   * A result that fails its declared output schema is dropped without an error,
   * so an enum pinned to a subset of the sources does not fail loudly: it makes
   * every page of the audit log containing a new source come back empty. This
   * is what stops the two lists drifting apart again.
   */
  it("parses through the declared audit schema", () => {
    for (const source of actorSources) {
      const event = {
        id: "11111111-1111-4111-8111-111111111111",
        userId: "u1",
        actorSource: source,
        clientId: null,
        entityType: "transaction",
        entityId: "22222222-2222-4222-8222-222222222222",
        operation: "create",
        before: null,
        after: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      expect(auditEventResultSchema.safeParse(event).success, source).toBe(true);
    }
  });
});

/** Every node of a published schema, so a rule means "anywhere", not "at the top". */
function walkSchema(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walkSchema(item, visit);
    else walkSchema(value, visit);
  }
}

async function publishedTools() {
  const server = createMcpServer(
    { userId: "output-rules", source: "mcp", clientId: "output-rules" },
    new Set(["ledger:read", "ledger:stage", "ledger:write"]),
  );
  const client = new Client({ name: "output-rules", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

/**
 * The owner id, which this surface published on 34 of its 71 tools and then
 * refused to read back.
 *
 * Every row belongs to the actor that authorised the connection, so it was one
 * constant repeated on every row of every page, and no next call could send it
 * anywhere. It is gone from the schemas and gone from the payload, and both had
 * to move together: whoami's result is the one closed object of the four, so a
 * schema that still declared it would have published a contract the reply broke.
 */
describe("the owner id no agent can use", () => {
  /**
   * A named-exception set rather than a flat ban, following the shape
   * `tests/mcp-parity.test.ts` uses for its browser-only routes. Shared
   * accounts (SB-022) are the story where a row's owner stops being a constant
   * and becomes what a next call needs; that story should add a reason here
   * rather than delete the rule.
   */
  const OWNER_ID_EXCEPTIONS = new Set<string>();

  it("is declared by no output schema", async () => {
    const tools = await publishedTools();
    const declaring: string[] = [];
    for (const tool of tools) {
      walkSchema(tool.outputSchema, (node) => {
        const properties = node["properties"];
        if (properties && typeof properties === "object" && "userId" in properties) {
          declaring.push(tool.name);
        }
      });
    }
    expect([...new Set(declaring)].filter((name) => !OWNER_ID_EXCEPTIONS.has(name))).toEqual([]);
  });

  it("is dropped from a reply at every depth", () => {
    expect(
      withoutUserId({
        userId: "u",
        name: "Groceries",
        legs: [{ userId: "u", amount: "1.00" }],
      }),
    ).toEqual({ name: "Groceries", legs: [{ amount: "1.00" }] });
  });

  /**
   * The one place the key is somebody's data rather than this server's
   * constant: a CSV preview's rows are keyed by the uploaded file's own
   * headers. Dropping those cells would leave the tool that exists to diagnose
   * a malformed file lying about the file, with `headers` still listing the
   * column.
   */
  it("keeps a userId column that came out of somebody's CSV", () => {
    expect(
      withoutUserId({
        delimiter: ",",
        headers: ["userId", "amount"],
        rows: [{ userId: "abc", amount: "1.00" }],
        errors: [],
      }),
    ).toEqual({
      delimiter: ",",
      headers: ["userId", "amount"],
      rows: [{ userId: "abc", amount: "1.00" }],
      errors: [],
    });
  });

  /**
   * The same file one step later, and the case with a round trip to break.
   *
   * `rawData` is the record a staged draft was read from, kept beside it so
   * somebody repairing the row can see what arrived — and on
   * `create_staged_transaction` it is whatever the caller sent, an open
   * `record(string, unknown)`. Walking into it would let an agent stage a row
   * and read back a different one.
   */
  it("keeps a userId key inside a staged row's rawData", () => {
    expect(
      withoutUserId({
        userId: "u",
        id: "row",
        rawData: { userId: "1042", Payee: "Cafe", Amount: "4.20" },
      }),
    ).toEqual({ id: "row", rawData: { userId: "1042", Payee: "Cafe", Amount: "4.20" } });
  });

  it("leaves whoami's reply satisfying whoami's own closed schema", () => {
    const identity = {
      userId: "u1",
      name: "Sam",
      email: "sam@example.com",
      clientId: "agent",
      source: "mcp",
      notificationsAvailable: false,
      scopes: ["ledger:read"],
    };
    const stripped = withoutUserId(identity);
    // Both halves, because the parse alone proves only one direction: the
    // schema is a plain object, so Zod would strip an undeclared key and
    // succeed whether or not the payload had already lost it.
    expect(Object.keys(stripped as Record<string, unknown>)).not.toContain("userId");
    expect(mcpOutputSchema(identityResultSchema).safeParse({ result: stripped }).success).toBe(
      true,
    );
  });
});

/**
 * The closed list of output fields whose names do not give their meaning.
 *
 * Describing everything would fight the payload ceiling — one sentence on
 * `version` costs about 4,700 characters because it is emitted 42 times — and
 * most of the surface is `id`, `name`, `currency`, `date`, which need nothing.
 * These are the ones that mislead, and the rule is held per copy rather than by
 * a count, so a new result schema that spreads one of them undescribed fails
 * here rather than passing a total nobody remembers to raise.
 */
describe("output fields whose names mislead", () => {
  const MUST_DESCRIBE = [
    "version",
    "legs",
    "legCount",
    "deletedAt",
    "archivedAt",
    "effectiveRate",
    "templateId",
    "externalId",
    "status",
    "repeatsStagedRow",
    "duplicateOfId",
    "likelyDuplicateOfId",
    "chosen",
  ];

  /**
   * The copies that live in `src/shared/domain.ts` rather than in the output
   * schemas, named one by one with the reason.
   *
   * A template's and a recurrence's `legs` are the draft shape the browser
   * posts, and the three bulk results echo each row's new `version` from the
   * same file: one schema serving both surfaces, so describing it is a change
   * to what the browser sends as much as to what an agent reads. Listed as
   * exact tool-and-field pairs rather than by field name, so the rule still
   * holds every copy the output schemas own — and so a new tool spreading one
   * of these fails here by name rather than inheriting the exemption.
   */
  const SHARED_WITH_THE_BROWSER = new Set([
    "list_recurrences.legs",
    "get_recurrence.legs",
    "create_recurrence.legs",
    "update_recurrence.legs",
    "list_transaction_templates.legs",
    "get_transaction_template.legs",
    "create_transaction_template.legs",
    "update_transaction_template.legs",
    "bulk_edit_staged_transactions.version",
    "bulk_edit_transaction_templates.version",
    "bulk_delete_transaction_templates.version",
  ]);

  it("carry a description on every published copy", async () => {
    const tools = await publishedTools();
    const bare: string[] = [];
    for (const tool of tools) {
      walkSchema(tool.outputSchema, (node) => {
        const properties = node["properties"];
        if (!properties || typeof properties !== "object") return;
        for (const [name, property] of Object.entries(
          properties as Record<string, { description?: string }>,
        )) {
          const at = `${tool.name}.${name}`;
          if (
            MUST_DESCRIBE.includes(name) &&
            !property?.description &&
            !SHARED_WITH_THE_BROWSER.has(at)
          ) {
            bare.push(at);
          }
        }
      });
    }
    expect([...new Set(bare)]).toEqual([]);
  });
});

/**
 * The refusal an agent meets most, which is not this project's envelope at all.
 *
 * The SDK validates `inputSchema` before the handler runs, so a bad argument
 * never reaches `runTool` and comes back as a bare text block with no
 * `structuredContent`, no code and no details. A client written to read
 * `structuredContent` unconditionally breaks on its first typo, which is why
 * `docs/mcp.md` is held to naming it too.
 */
describe("an argument that fails a tool's schema", () => {
  it("is refused before the tool runs, outside the project envelope", async () => {
    const server = createMcpServer(
      { userId: "bad-argument", source: "mcp", clientId: "bad-argument" },
      new Set(["ledger:read"]),
    );
    const client = new Client({ name: "bad-argument", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "get_transaction",
      arguments: { id: "not-a-uuid" },
    });
    await client.close();
    await server.close();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const text = JSON.stringify(result.content);
    expect(text).toContain("-32602");
    expect(text).toContain("Invalid UUID at id");
  });

  it("is written down in the guide an agent's operator reads", () => {
    expect(readFileSync("docs/mcp.md", "utf8")).toContain("-32602");
  });
});

/**
 * The closed list of codes, on the wire rather than only in TypeScript.
 *
 * A code exists so a caller can branch, and it cannot branch on a union it has
 * no way to read. Asserted per tool rather than once, because the envelope is
 * built per tool: a tool that ever published `code` as a bare string would give
 * an agent nothing to switch on, and it would do so silently.
 */
describe("the error member every tool publishes", () => {
  it("names the whole closed code list", async () => {
    const tools = await publishedTools();
    const missing: string[] = [];
    for (const tool of tools) {
      const variants = (
        tool.outputSchema as {
          properties?: { result?: { anyOf?: { properties?: { error?: unknown } }[] } };
        }
      ).properties?.result?.anyOf;
      const error = variants?.find((variant) => variant?.properties?.error);
      const code = (
        error as { properties?: { error?: { properties?: { code?: { enum?: string[] } } } } }
      )?.properties?.error?.properties?.code;
      if (!code?.enum || [...code.enum].sort().join() !== [...serviceErrorCodes].sort().join()) {
        missing.push(tool.name);
      }
    }
    expect(missing).toEqual([]);
  });
});
