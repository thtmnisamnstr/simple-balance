import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * The numbers `docs/standards/mcp.md` quotes, checked against the live surface.
 *
 * That guide argues from measurement — "146 of the 225 top-level parameters
 * carry no description", "14 of 71 input schemas are closed" — and those numbers
 * are the whole force of the argument. They are also the first thing to rot: a
 * new tool changes half of them at once and says nothing.
 *
 * Four had already drifted when this was written. Adding `categoryKind` to the
 * transaction draft put an enum and a nullable `anyOf` into twelve schemas,
 * which moved two counts the guide states as facts, and the budget tools moved
 * two more.
 *
 * So the guide is pinned rather than trusted. A tool added on purpose fails
 * this test, and the fix is to update the sentence in the same commit — which
 * is the point, because the sentence is usually an argument about a gap the new
 * tool either widened or closed.
 */

const ALL_SCOPES = ["ledger:read", "ledger:stage", "ledger:write"];

type Tool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

async function listTools(scopes: readonly string[]): Promise<Tool[]> {
  const server = createMcpServer(
    { userId: "measurement", source: "mcp", clientId: "measurement" },
    new Set(scopes),
  );
  const client = new Client({ name: "measurement", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools as Tool[];
}

/** Every node of a JSON Schema, so a count means "anywhere", not "at the top". */
function walk(node: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else walk(value, visit);
  }
}

const guide = readFileSync("docs/standards/mcp.md", "utf8");

/** The number the guide claims, pulled from the sentence that claims it. */
const claimed = (pattern: RegExp): number => {
  const match = pattern.exec(guide);
  expect(match, `no sentence in mcp.md matched ${pattern}`).not.toBeNull();
  return Number(match![1]!.replaceAll(",", ""));
};

describe("what mcp.md says it measured", () => {
  let tools: Tool[];
  let scopes: { read: number; stage: number; write: number };

  beforeAll(async () => {
    tools = await listTools(ALL_SCOPES);
    scopes = {
      read: (await listTools(["ledger:read"])).length,
      stage: (await listTools(["ledger:stage"])).length,
      write: (await listTools(["ledger:write"])).length,
    };
  });

  it("counts the tools", () => {
    expect(tools).toHaveLength(claimed(/The agent surface: (\d+) tools over Streamable HTTP/));
  });

  it("counts description characters, median, longest and the terse ones", () => {
    const lengths = tools.map((tool) => (tool.description ?? "").length).sort((a, b) => a - b);
    const sentence =
      /(\d[\d,]*)\s+descriptions,\s+([\d,]+)\s+characters,\s+median\s+([\d,]+),\s+range\s+(\d+)\s+to\s+([\d,]+),\s+and\s+\*\*(\d+)\s+under\s+100 characters\*\*/.exec(
        guide,
      );
    expect(sentence, "the description-length sentence has changed shape").not.toBeNull();
    const [, count, chars, median, min, max, under] = sentence!;
    expect(Number(count)).toBe(tools.length);
    expect(Number(chars!.replaceAll(",", ""))).toBe(lengths.reduce((a, b) => a + b, 0));
    expect(Number(median!.replaceAll(",", ""))).toBe(lengths[Math.floor(lengths.length / 2)]);
    expect(Number(min)).toBe(lengths[0]);
    expect(Number(max!.replaceAll(",", ""))).toBe(lengths.at(-1));
    expect(Number(under)).toBe(lengths.filter((length) => length < 100).length);
  });

  it("counts destructive tools that carry a confirm-or-undo word", () => {
    const destructive = tools.filter((tool) => tool.annotations?.["destructiveHint"]);
    const CONFIRM = /(confirm|undo|cannot be undone|permanent|irreversible|restore)/i;
    const carrying = destructive.filter((tool) => CONFIRM.test(tool.description ?? ""));
    expect(carrying).toHaveLength(
      claimed(/Measured: (\d+) of the \d+\s+`destructiveHint` tools carry a confirm-or-undo word/),
    );
    expect(destructive.length - carrying.length).toBe(
      claimed(/`destructiveHint` tools carry a confirm-or-undo word and (\d+) do not/),
    );
  });

  it("counts enums on each side", () => {
    let input = 0;
    let output = 0;
    for (const tool of tools) {
      walk(tool.inputSchema, (node) => {
        if (Array.isArray(node["enum"])) input += 1;
      });
      walk(tool.outputSchema, (node) => {
        if (Array.isArray(node["enum"])) output += 1;
      });
    }
    expect(input).toBe(claimed(/Measured: (\d+)\s+enums across the input schemas/));
    expect(output).toBe(
      claimed(/enums across the input schemas, and (\d+) more on the output side/),
    );
  });

  it("counts closed and open input schemas", () => {
    const closed = tools.filter(
      (tool) =>
        (tool.inputSchema as { additionalProperties?: unknown })?.additionalProperties === false,
    ).length;
    expect(closed).toBe(claimed(/Measured: (\d+) of \d+ input schemas are\s+closed/));
    expect(tools.length - closed).toBe(claimed(/input schemas are\s+closed and (\d+) are open/));
  });

  it("counts top-level parameters and how many lack a description", () => {
    let total = 0;
    let undescribed = 0;
    for (const tool of tools) {
      const properties = (
        tool.inputSchema as { properties?: Record<string, { description?: string }> }
      )?.properties;
      for (const property of Object.values(properties ?? {})) {
        total += 1;
        if (!property?.description) undescribed += 1;
      }
    }
    expect(undescribed).toBe(
      claimed(/Measured: (\d+) of the \d+\s+top-level tool parameters carry none/),
    );
    expect(total).toBe(
      claimed(/Measured: \d+ of the (\d+)\s+top-level tool parameters carry none/),
    );
  });

  it("counts anyOf and oneOf, and how they break down", () => {
    let anyOf = 0;
    let oneOf = 0;
    let nullablePairs = 0;
    let nullablePairsOnInput = 0;
    let onInput = 0;
    let onOutput = 0;
    const isNullablePair = (node: Record<string, unknown>): boolean => {
      const members = node["anyOf"];
      return (
        Array.isArray(members) &&
        members.length === 2 &&
        members.some((member) => (member as { type?: string })?.type === "null")
      );
    };
    for (const tool of tools) {
      walk(tool.inputSchema, (node) => {
        if (Array.isArray(node["anyOf"])) {
          anyOf += 1;
          onInput += 1;
          if (isNullablePair(node)) {
            nullablePairs += 1;
            nullablePairsOnInput += 1;
          }
        }
        if (Array.isArray(node["oneOf"])) oneOf += 1;
      });
      walk(tool.outputSchema, (node) => {
        if (Array.isArray(node["anyOf"])) {
          anyOf += 1;
          onOutput += 1;
          if (isNullablePair(node)) nullablePairs += 1;
        }
        if (Array.isArray(node["oneOf"])) oneOf += 1;
      });
    }
    expect(anyOf).toBe(claimed(/Measured: (\d+) `anyOf` and \d+ `oneOf`/));
    expect(oneOf).toBe(claimed(/Measured: \d+ `anyOf` and (\d+) `oneOf`/));
    expect(nullablePairs).toBe(
      claimed(/across the surface\. (\d+) of the \d+ are two-member nullable pairs/),
    );
    expect(nullablePairsOnInput).toBe(
      claimed(/two-member nullable pairs, (\d+) of them\s+on inputs/),
    );
    expect(onInput).toBe(claimed(/(\d+) of all the `anyOf` are on inputs/));
    expect(onOutput).toBe(claimed(/of all the `anyOf` are on inputs and (\d+) on outputs/));
  });

  it("counts output properties and how many are described", () => {
    let total = 0;
    let described = 0;
    for (const tool of tools) {
      walk(tool.outputSchema, (node) => {
        const properties = node["properties"];
        if (properties && typeof properties === "object") {
          for (const property of Object.values(
            properties as Record<string, { description?: string }>,
          )) {
            total += 1;
            if (property?.description) described += 1;
          }
        }
      });
    }
    expect(total).toBe(claimed(/Measured: \*\*([\d,]+) output properties/));
    expect(described).toBe(claimed(/output properties, (\d+) with a description/));
  });

  it("counts mutating tools and the idempotency keys they carry", () => {
    const withKey = tools.filter(
      (tool) =>
        (tool.inputSchema as { properties?: Record<string, unknown> })?.properties?.[
          "idempotencyKey"
        ] !== undefined,
    ).length;
    expect(withKey).toBe(claimed(/Measured: (\d+)\s+mutating tools, \d+ with `idempotencyKey`/));
    expect(withKey).toBe(claimed(/mutating tools, (\d+) with `idempotencyKey` in the schema/));
  });

  it("counts the annotation split", () => {
    const readOnly = tools.filter((tool) => tool.annotations?.["readOnlyHint"]).length;
    const destructive = tools.filter((tool) => tool.annotations?.["destructiveHint"]).length;
    expect(readOnly).toBe(claimed(/Measured: (\d+) read, \d+ additive, \d+ destructive/));
    expect(destructive).toBe(claimed(/Measured: \d+ read, \d+ additive, (\d+) destructive/));
    expect(tools.length - readOnly - destructive).toBe(
      claimed(/Measured: \d+ read, (\d+) additive, \d+ destructive/),
    );
  });

  it("counts what each scope can reach", () => {
    expect(scopes.read).toBe(claimed(/Measured: (\d+) tools at `ledger:read`/));
    expect(scopes.stage).toBe(claimed(/tools at `ledger:read`, (\d+) at\s+`ledger:stage`/));
    expect(scopes.write).toBe(claimed(/`ledger:stage`, (\d+) at `ledger:write`/));
  });
});
