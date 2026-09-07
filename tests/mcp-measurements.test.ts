import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer, satisfiesToolScope, TOOL_SCOPES } from "../src/server/mcp.js";

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
  title?: string;
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
  let tiers: { read: Tool[]; stage: Tool[]; write: Tool[] };
  let scopes: { read: number; stage: number; write: number };

  beforeAll(async () => {
    tools = await listTools(ALL_SCOPES);
    tiers = {
      read: await listTools(["ledger:read"]),
      stage: await listTools(["ledger:stage"]),
      write: await listTools(["ledger:write"]),
    };
    scopes = {
      read: tiers.read.length,
      stage: tiers.stage.length,
      write: tiers.write.length,
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

  /**
   * The payload table and the composition line, which used to be the two
   * measurements the guide admitted nothing pinned. Both had gone stale by
   * about a quarter twice in a row, and they are the numbers the whole
   * context-budget argument stands on, so they are pinned the same way as the
   * rest: the guide's sentence is parsed and compared to the live surface.
   */
  it("counts what each tier costs in tools/list characters", () => {
    const cost = (tier: Tool[]) => JSON.stringify(tier).length;
    expect(cost(tiers.read)).toBe(claimed(/\| `ledger:read` \| \d+ \| ([\d,]+) \|/));
    expect(cost(tiers.stage)).toBe(claimed(/\| `ledger:stage` \| \d+ \| ([\d,]+) \|/));
    expect(cost(tiers.write)).toBe(claimed(/\| `ledger:write` \| \d+ \| ([\d,]+) \|/));
  });

  /**
   * And the pattern that was a tenth of the payload does not come back.
   *
   * `z.string().uuid()` emits `"format":"uuid"` *and* a 166-character regex
   * saying the same thing, and 352 copies of it were 11% of everything an agent
   * loaded to learn what this server can do. The `uuid()` helper in
   * `src/shared/domain.ts` drops the regex and keeps the check.
   *
   * A count rather than a size, because the failure is one declaration written
   * the old way: sixty sites were converted, and the sixty-first is what this
   * is here for. The tier costs above would catch it too, but they would say
   * "191,414 is not 166,712", which is a puzzle where this is a fix.
   */
  it("publishes a uuid as a format and not also as a regex", () => {
    const text = JSON.stringify(tiers.write);
    expect([...text.matchAll(/"pattern":"\^\(\[0-9a-fA-F\]\{8\}/g)]).toEqual([]);
    // And the format is still there, so this is not passing because the ids
    // stopped being described at all.
    expect([...text.matchAll(/"format":"uuid"/g)].length).toBeGreaterThan(300);
  });

  it("counts what the write tier is made of", () => {
    const sum = (parts: number[]) => parts.reduce((a, b) => a + b, 0);
    const composition = {
      names: sum(tiers.write.map((tool) => tool.name.length)),
      titles: sum(
        tiers.write.map(
          (tool) => (tool.title ?? (tool.annotations?.["title"] as string) ?? "").length,
        ),
      ),
      descriptions: sum(tiers.write.map((tool) => (tool.description ?? "").length)),
      inputs: sum(tiers.write.map((tool) => JSON.stringify(tool.inputSchema ?? {}).length)),
      outputs: sum(tiers.write.map((tool) => JSON.stringify(tool.outputSchema ?? {}).length)),
    };
    const sentence =
      /Composition at the write tier: names ([\d,]+), titles ([\d,]+), descriptions\s+([\d,]+),\s+input schemas ([\d,]+), output schemas ([\d,]+)/.exec(
        guide,
      );
    expect(sentence, "the composition sentence has changed shape").not.toBeNull();
    const [, names, titles, descriptions, inputs, outputs] = sentence!;
    const number = (text: string) => Number(text.replaceAll(",", ""));
    expect(number(names!)).toBe(composition.names);
    expect(number(titles!)).toBe(composition.titles);
    expect(number(descriptions!)).toBe(composition.descriptions);
    expect(number(inputs!)).toBe(composition.inputs);
    expect(number(outputs!)).toBe(composition.outputs);
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

  /**
   * A selection field describes the selection modes it actually accepts.
   *
   * This is the `categoryKind` defect in the other direction: a *field* that
   * advertises a capability the schema does not have. Both template bulk
   * schemas carried the transaction one's sentence — "either an explicit list …
   * or a filter plus the count and fingerprint a preview handed back" — and
   * `AGENTS.md` says a template mass edit "names explicit rows with expected
   * versions and has no filtered selection". An agent reading it would build a
   * filter form, be refused, and have nothing in the reply saying the
   * instruction was wrong rather than its own call.
   *
   * Read off the published JSON Schema rather than the source, so the check is
   * about what an agent is told: `anyOf` is how a discriminated union arrives,
   * and a `mode` property is how each arm names itself.
   */
  it("describes only the selection modes a schema accepts", () => {
    const wrong: string[] = [];
    for (const tool of tools) {
      const input = tool.inputSchema as
        | { properties?: Record<string, { description?: string; anyOf?: unknown[] }> }
        | undefined;
      const selection = input?.properties?.["selection"];
      if (!selection) continue;
      // The *claim*, not the word. A description saying "there is no filter
      // form here" is correct and mentions filters; what is refused is offering
      // one as an alternative, which is the construction the transaction
      // sentence uses and the template ones had copied.
      const describesFilter = /\bor a filter\b|\ba filter plus\b/i.test(
        selection.description ?? "",
      );
      // A filter arm is one of the `anyOf` members; an explicit-only selection
      // is a plain object with `items` and no union at all.
      const hasFilterArm = JSON.stringify(selection).includes('"filter"');
      if (describesFilter !== hasFilterArm) {
        wrong.push(
          `${tool.name}: description ${describesFilter ? "claims" : "omits"} a filter form the schema ` +
            `${hasFilterArm ? "has" : "does not have"}`,
        );
      }
    }
    // There are selections on both sides of this to get wrong: the transaction
    // and staged bulk tools take a filter, the template ones do not.
    expect(
      tools.filter(
        (tool) =>
          (tool.inputSchema as { properties?: object })?.properties &&
          "selection" in ((tool.inputSchema as { properties: object }).properties as object),
      ).length,
    ).toBeGreaterThan(3);
    expect(wrong).toEqual([]);
  });

  /**
   * One spelling per concept, across every description and field description.
   *
   * `common.md` settles the voice for the whole product and this surface drifted
   * from it in two places: two descriptions said "this user's" where seventeen
   * said "this person", and one said "normalization" where the rest of the
   * product's prose is British. An agent reading two spellings of one concept
   * has to work out whether they are one concept, which is exactly the cost the
   * glossary exists to avoid.
   *
   * A count held at zero rather than a list of the winning spelling: a
   * seventeenth "this person" needs no edit here, and a third "this user's"
   * fails. The `normalizedName` *field* is out of scope by name — a field name
   * is published contract and an identifier, not prose.
   */
  it("uses one spelling per concept", () => {
    const surface = JSON.stringify(tools).replaceAll("normalizedName", "");
    for (const losing of ["this user's", "the user's", "normalization", "normalized"]) {
      const found = [...surface.matchAll(new RegExp(losing, "gi"))];
      expect(found, `"${losing}" is the spelling this surface does not use`).toEqual([]);
    }
    // And the winning spellings are there, so this is not passing because the
    // surface stopped saying anything.
    expect([...surface.matchAll(/this person/gi)].length).toBeGreaterThan(10);
    expect([...surface.matchAll(/normalis/gi)].length).toBeGreaterThan(1);
  });

  /**
   * The two that cannot be undone say so in words.
   *
   * `ToolAnnotations` has three booleans and no fourth field, so
   * `destructiveHint` covers both "posts a reversal you can undo" and "there is
   * no going back" — and those are different decisions for whoever approves the
   * call. `mcp.md` records the split; the description is the only channel that
   * can carry it, so a tool in the unrecoverable class has to spell it out.
   *
   * Named rather than derived from the annotation, because the annotation is
   * identical on the wire by design: inventing a field the specification does
   * not have would be worse than a list of two.
   *
   * **Two, and the first draft of this list had four.** The other two are
   * recoverable and their own descriptions said so before anybody checked:
   * deleting posts a reversal that `set_transaction_deleted` puts back, and a
   * revoked agent can be authorised again from a browser. Writing the list
   * first and reading the descriptions second is what caught it.
   */
  const UNRECOVERABLE = ["merge_categories", "merge_payees"];

  it("says so in words where a client cannot be told in a field", () => {
    const NO_WAY_BACK = /(cannot be undone|no undo|permanent|irreversible)/i;
    const silent: string[] = [];
    for (const name of UNRECOVERABLE) {
      const tool = tools.find((one) => one.name === name);
      expect(tool, `${name} should be registered`).toBeDefined();
      // Destructive, which the wire does say.
      expect(tool!.annotations?.["destructiveHint"], name).toBe(true);
      if (!NO_WAY_BACK.test(tool!.description ?? "")) silent.push(name);
    }
    expect(silent, "the description is the only place this can be said").toEqual([]);
    // And the recoverable ones are not in the list, which is what makes the
    // list a distinction rather than a synonym for destructive. All three say
    // how to get back, which is the other half of the wording rule.
    const BACK = /(can be undone|has to be authorized again|restore)/i;
    for (const name of [
      "set_transaction_deleted",
      "bulk_delete_transactions",
      "revoke_connected_agent",
    ]) {
      const tool = tools.find((one) => one.name === name);
      expect(tool?.annotations?.["destructiveHint"], name).toBe(true);
      expect(UNRECOVERABLE).not.toContain(name);
      expect(BACK.test(tool?.description ?? ""), `${name} should say how to get back`).toBe(true);
    }
  });

  /**
   * A description that names a tool has to name one that exists.
   *
   * Eleven descriptions point the agent at another tool — `create_budget_plan`
   * tells it to read `get_budget_report`, `preview_csv` tells it to follow with
   * `stage_csv` — and that is the one kind of prose here a machine can check.
   * A renamed tool leaves the sentences that named it behind, and the agent
   * that follows one calls a name the server does not have: it gets a protocol
   * error rather than an answer, and nothing in the reply says the instruction
   * was stale rather than its own call malformed.
   *
   * Every `snake_case` word is read as a claim about a tool, because that is
   * the shape a tool name has here and no field is spelled that way — fields
   * are camelCase, and the input descriptions are not read at all. A future
   * description that needs a snake_case word which is not a tool goes in
   * `NOT_A_TOOL` with the reason, which is a decision worth making in a diff.
   */
  const NOT_A_TOOL: string[] = [
    // Stored values rather than tools, each named by a description because the
    // choice it stands for has no default: how a category group is budgeted,
    // and what a forecast is projected from.
    "sum_of_children",
    "recurring_and_budgets",
  ];

  it("never sends an agent to a tool that does not exist", () => {
    const registered = new Set(tools.map((tool) => tool.name));
    const missing: string[] = [];
    let mentions = 0;
    for (const tool of tools) {
      for (const match of (tool.description ?? "").matchAll(
        /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g,
      )) {
        const named = match[1]!;
        if (NOT_A_TOOL.includes(named)) continue;
        mentions += 1;
        if (!registered.has(named)) missing.push(`${tool.name} names ${named}`);
      }
    }
    expect(missing).toEqual([]);
    // Guards the reading rather than the rule: a regex that stopped matching
    // would leave this passing on nothing at all, which is what "green today"
    // looks like from the outside either way.
    expect(mentions).toBeGreaterThanOrEqual(11);
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

  /**
   * Every field, not every parameter.
   *
   * This counted the top level only, and reported zero while 263 of 673 fields
   * carried nothing: the whole of `draft`, `shape`, `patch`, `selection`,
   * `schedule` and `mapping` — which is to say every field an agent actually
   * has to fill in to write anything. The guide's "0 of 226" was true of what
   * it measured and false of what it said, which is the worst shape for a
   * number to be in.
   *
   * It walks the schema now: properties, array items, and every branch of an
   * `anyOf`, `oneOf` or `allOf`, because a discriminated union publishes each
   * member separately and a field described on one branch and not another is
   * exactly the gap this missed.
   */
  it("counts every input field and how many lack a description", () => {
    let total = 0;
    const undescribed: string[] = [];
    type Node = {
      description?: string;
      properties?: Record<string, Node>;
      items?: Node;
      anyOf?: Node[];
      oneOf?: Node[];
      allOf?: Node[];
    };
    const walk = (node: Node | undefined, path: string) => {
      if (!node || typeof node !== "object") return;
      for (const [name, child] of Object.entries(node.properties ?? {})) {
        total += 1;
        if (!child?.description) undescribed.push(`${path}${name}`);
        walk(child, `${path}${name}.`);
      }
      walk(node.items, `${path}[].`);
      for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])]) {
        walk(branch, path);
      }
    };
    for (const tool of tools) walk(tool.inputSchema as Node, `${tool.name}.`);

    // Held at zero rather than at whatever the guide claims. Every other
    // measurement here is a fact the guide has to keep up with; this one became
    // a rule the moment it reached zero, and a rule is worth more than a number
    // somebody has to remember to lower.
    expect(undescribed, "every input field carries a description").toEqual([]);
    expect(total).toBe(claimed(/Measured:\s+\*\*0 of (\d+) carry none\*\*/));
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

  /**
   * Two numbers, counted two ways.
   *
   * This asserted one count against both halves of the sentence, so it could
   * only ever say that a number equalled itself: a mutating tool with no
   * idempotency key — the exact thing the rule exists against, and the thing
   * that would make `idempotentHint: true` a lie — would have moved both halves
   * together and passed. The mutating count comes from the annotations now, and
   * the key count from the schemas, which is what makes the comparison mean
   * something.
   *
   * A version is the other way a tool earns the annotation, so a mutating tool
   * carrying `expectedVersion` instead is counted as covered rather than as a
   * defect. Both are named in the guide's own sentence.
   */
  it("counts mutating tools and the idempotency keys they carry", () => {
    const properties = (tool: (typeof tools)[number]) =>
      (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {};
    const mutating = tools.filter((tool) => !tool.annotations?.["readOnlyHint"]);
    const withKey = mutating.filter((tool) => properties(tool)["idempotencyKey"] !== undefined);
    const uncovered = mutating.filter(
      (tool) =>
        properties(tool)["idempotencyKey"] === undefined &&
        properties(tool)["expectedVersion"] === undefined &&
        properties(tool)["expectedVersions"] === undefined &&
        properties(tool)["input"] === undefined,
    );
    expect(mutating.length).toBe(
      claimed(/Measured: (\d+)\s+mutating tools, \d+ with `idempotencyKey`/),
    );
    expect(withKey.length).toBe(
      claimed(/mutating tools, (\d+) with `idempotencyKey` in the schema/),
    );
    expect(
      uncovered.map((tool) => tool.name),
      "a mutating tool with neither a key nor a version makes idempotentHint a lie",
    ).toEqual([]);
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

  /**
   * `TOOL_SCOPES` is a second copy of the three registration blocks, written so
   * an under-scoped call can be answered before dispatch rather than by
   * registering a tool the caller cannot use. A second copy drifts unless
   * something holds it to the first, and the failure that matters is silent:
   * a tool missing from the map is never challenged, and one filed under the
   * wrong tier is challenged when it should not be — which on a client that
   * implements the step-up talks the agent into re-authorizing downward.
   *
   * Compared tier by tier and by name, so the failure says which tool moved.
   * `satisfiesToolScope` rather than `hasScope`, or the assertion bakes in the
   * bug it exists to catch: `hasScope` widens only `ledger:read`.
   */
  it.each([["ledger:read"], ["ledger:stage"], ["ledger:write"]])(
    "offers a %s token exactly the tools the scope map allows it",
    async (scope) => {
      const held = new Set([scope]);
      const allowed = [...TOOL_SCOPES.entries()]
        .filter(([, required]) => satisfiesToolScope(held, required))
        .map(([name]) => name)
        .sort();
      const offered = (await listTools([scope])).map((tool) => tool.name).sort();
      expect(offered).toEqual(allowed);
    },
  );
});
