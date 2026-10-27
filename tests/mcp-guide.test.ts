import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";
import {
  directTransactionCreateSchema,
  transactionTemplateDraftSchema,
} from "../src/shared/domain.js";
import { sourceFiles } from "./support/source.js";

/**
 * Rules from `docs/standards/mcp.md` that nothing held, each about a claim made
 * somewhere the existing checks do not read.
 *
 * Named for the guide rather than for any one rule, because each is about the
 * guide's own reach: one extends a claim check from tool descriptions to field
 * descriptions, one applies the "said once" rule to a refusal that cuts across
 * a whole tier of tools, and one holds the "what to call instead" a
 * description gives to the tool it sends the agent to.
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
   * Thirty-four field descriptions name a tool — `frozen` sends the agent to
   * `set_active_accounts`, `accountLimit` to `create_account`, `notes` on
   * `stage_csv` back to `preview_csv` — and none of the seventeen there were
   * when this was written was covered.
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

  /**
   * `mcp.md` §Descriptions: backticks mark an identifier, because "an
   * identifier set in prose is an identifier a model retypes wrong". Only the
   * tool descriptions were held to it, so the field descriptions named a tool
   * bare in twenty-eight places and in backticks in seven, and the
   * instructions every connection reads named `whoami` and `list_accounts`
   * bare. Matched against the registered names rather than a snake_case
   * pattern, so a one-word tool such as `whoami` is read too.
   */
  it("sets it in backticks, and so do the instructions", async () => {
    const { instructions } = await connect();
    const registered = [...new Set(tools.map((tool) => tool.name))];
    const named = new RegExp(`(\`?)\\b(${registered.join("|")})\\b(\`?)`, "g");
    const bare: string[] = [];
    let marked = 0;
    const read = (where: string, text: string) => {
      for (const match of text.matchAll(named)) {
        if (match[1] === "`" && match[3] === "`") marked += 1;
        else bare.push(`${where} names ${match[2]} in bare prose`);
      }
    };
    for (const tool of tools) {
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        walk(schema, (node) => {
          const properties = node["properties"];
          if (!properties || typeof properties !== "object") return;
          for (const [field, child] of Object.entries(properties as Record<string, unknown>)) {
            const description = (child as { description?: unknown } | null)?.description;
            if (typeof description === "string") read(`${tool.name}.${field}`, description);
          }
        });
      }
    }
    read("the instructions", instructions);
    expect([...new Set(bare)]).toEqual([]);
    // A reader that stopped matching would pass on nothing.
    expect(marked).toBeGreaterThanOrEqual(30);
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

describe("what the template tools say about making an entry from one", () => {
  let tools: Tool[];

  beforeAll(async () => {
    ({ tools } = await connect());
  });

  /**
   * A template keeps the transaction form's field names, and the form renames
   * one on the way out: a transfer template's `amount` is the posted draft's
   * `sourceAmount`. Both tools that hand an agent a template tell it to copy
   * the draft into `create_transaction`, so the steps they give have to turn a
   * template of every kind into a draft that tool takes. Copied as it stood, a
   * transfer template was refused at `draft.sourceAmount`, and staged as it
   * stood it was accepted with an issue that kept it from ever committing.
   *
   * The rename is read out of the description rather than written here, so
   * the sentence an agent reads is the one under test.
   */
  it("turns a template of every kind into a draft create_transaction takes", () => {
    const said = ["list_transaction_templates", "get_transaction_template"].map((name) => {
      const description = tools.find((tool) => tool.name === name)?.description ?? "";
      return [...description.matchAll(/rename a transfer's `(\w+)` to `(\w+)`/g)].map(
        (match) => [match[1]!, match[2]!] as const,
      );
    });
    expect(said[0], "both tools give the same steps").toEqual(said[1]);

    const from = "00000000-0000-4000-8000-000000000001";
    const to = "00000000-0000-4000-8000-000000000002";
    for (const stored of [
      { type: "withdrawal", fromAccountId: from, amount: "12.50", payee: "Corner shop" },
      { type: "deposit", toAccountId: to, amount: "900", payee: "Employer" },
      { type: "transfer", fromAccountId: from, toAccountId: to, amount: "50", payee: "Card" },
    ]) {
      const template = transactionTemplateDraftSchema.parse(stored);
      // What the description says to fill in: the date it leaves out, and the
      // template's id so the template counts the entry.
      const draft: Record<string, unknown> = {
        ...template,
        date: "2026-01-02",
        templateId: "00000000-0000-4000-8000-000000000003",
      };
      if (template.type === "transfer") {
        for (const [before, after] of said[0]!) {
          draft[after] = draft[before];
          delete draft[before];
        }
      }
      const parsed = directTransactionCreateSchema
        .strict()
        .safeParse({ draft, idempotencyKey: "template-copy-0001" });
      expect(parsed.error?.issues ?? [], stored.type).toEqual([]);
    }
  });
});
