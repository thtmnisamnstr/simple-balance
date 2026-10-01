import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";
import { sourceFiles } from "./support/source.js";

/**
 * Two rules from `docs/standards/mcp.md` that nothing held, both written for
 * this release and both about a claim made somewhere the existing checks do not
 * read.
 *
 * Named for the guide rather than for either rule, because both are rules about
 * the guide's own reach: one extends a claim check from tool descriptions to
 * field descriptions, and one applies the "said once" rule to a refusal that
 * cuts across a whole tier of tools.
 */

const EVERY_SCOPE = ["ledger:read", "ledger:stage", "ledger:write"];

type Tool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
};

/** Every node of a JSON Schema, so a walk means "anywhere", not "at the top". */
function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else walk(value, visit);
  }
}

async function connect() {
  const server = createMcpServer(
    { userId: "guide", source: "mcp", clientId: "guide" },
    new Set(EVERY_SCOPE),
  );
  const client = new Client({ name: "guide", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools as Tool[];
  const instructions = client.getInstructions() ?? "";
  await client.close();
  await server.close();
  return { tools, instructions };
}

describe("a tool named inside a field description", () => {
  let tools: Tool[];

  beforeAll(async () => {
    ({ tools } = await connect());
  });

  /**
   * The same claim the tool-description check in `tests/mcp-measurements.test.ts`
   * makes, one level down, where the surface has moved and that check does not
   * read.
   *
   * Seventeen field descriptions name a tool — `frozen` sends the agent to
   * `set_active_accounts`, `accountLimit` to `create_account`, `notes` on
   * `stage_csv` back to `preview_csv` — and none of them was covered.
   * A rename changes the registry and the tool descriptions together, in one
   * file, while these sentences sit in `src/shared/domain.ts` and the output
   * schemas and go on naming the old word with every test green. The agent that
   * follows one gets a protocol error saying its own call was malformed.
   *
   * A snake_case word a tool publishes as a value it accepts is a value and not
   * a tool: `sum_of_children` is how a category group is budgeted and
   * `credit_card` is an account type. Read off that tool's own schemas rather
   * than from a list somebody maintains, so a new enum value named in its own
   * description needs no edit here and a new tool name still has to exist.
   */
  it("exists", () => {
    const registered = new Set(tools.map((tool) => tool.name));
    const missing: string[] = [];
    const sites = new Set<string>();
    let claims = 0;

    for (const tool of tools) {
      const published = new Set<string>();
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        walk(schema, (node) => {
          const values = node["enum"];
          if (Array.isArray(values)) {
            for (const value of values) if (typeof value === "string") published.add(value);
          }
          const literal = node["const"];
          if (typeof literal === "string") published.add(literal);
        });
      }

      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        walk(schema, (node) => {
          const properties = node["properties"];
          if (!properties || typeof properties !== "object") return;
          for (const [field, child] of Object.entries(properties as Record<string, unknown>)) {
            const description = (child as { description?: unknown } | null)?.description;
            if (typeof description !== "string") continue;
            for (const match of description.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) {
              const named = match[1]!;
              if (published.has(named)) continue;
              claims += 1;
              sites.add(`${tool.name}.${field}`);
              if (!registered.has(named)) missing.push(`${tool.name}.${field} names ${named}`);
            }
          }
        });
      }
    }

    expect(missing).toEqual([]);
    // Guards the reading rather than the rule, the way the tool-description
    // check does: a traversal that stopped matching would pass on nothing.
    expect(sites.size).toBeGreaterThanOrEqual(17);
    expect(claims).toBeGreaterThanOrEqual(sites.size);
  });
});

describe("a refusal a whole tier of tools can return", () => {
  let instructions: string;

  beforeAll(async () => {
    ({ instructions } = await connect());
  });

  /**
   * The premise first, so this is a rule about the surface rather than a
   * sentence pinned to itself.
   *
   * `assertAccountsWritable` is one guard reached from four services, and a
   * refusal crossing that many tools belongs where every connection reads it.
   * Naming it in each of the thirty-five write descriptions is the per-tool
   * convention the guide's payload argument refuses; naming it nowhere is what
   * shipped, and the single description that mentions a freeze is
   * `set_active_accounts`, which is the one caller that did not need telling.
   *
   * Counted from the services rather than from a list, so a guard that spreads
   * to a fifth keeps the premise true without an edit, and one that shrinks
   * back to a single service fails here and asks for the rule to be argued
   * again rather than quietly carrying on.
   */
  it("is named in the instructions every connection reads", () => {
    const callers = sourceFiles("src/server/services")
      .filter((file) => /\bassertAccountsWritable\(/.test(file.code))
      .map((file) => file.path);

    expect(
      callers.length,
      "the premise is that one guard crosses several services",
    ).toBeGreaterThan(2);

    expect(instructions).toMatch(/frozen/i);
    // The refusal arrives as VALIDATION_ERROR, which on this surface means "fix
    // the arguments", so the instructions have to say that none of them will.
    expect(instructions).toMatch(/no argument you can change gets past/i);
    // And where to look, since an agent cannot buy its way out of this one.
    expect(instructions).toMatch(/whoami/);
    expect(instructions).toMatch(/list_accounts/);
  });
});
