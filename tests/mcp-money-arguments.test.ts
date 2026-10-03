import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * No money argument is a number.
 *
 * `mcp.md` §Inputs a model cannot get wrong ends with "*Not checked:* that no
 * money argument is a number", and the rule behind it is the first invariant in
 * `AGENTS.md`: money is a validated decimal string, never a JSON float. The MCP
 * surface is where that is easiest to lose. A model writes JSON, `12.30` is the
 * obvious thing to write, and a schema saying `"type": "number"` is an
 * invitation to write it — at which point `0.1 + 0.2` is in the books and the
 * only evidence is a balance a cent out.
 *
 * Read off a live `tools/list` rather than off the Zod source, because the
 * schema an agent obeys is the one the server publishes. A `z.coerce.number()`
 * or a `z.number()` added inside a draft three levels down reads as ordinary
 * TypeScript and publishes as `"type": "number"`, which is exactly the edit
 * this is here to catch.
 *
 * Inputs only. An output carrying a number is a different rule (`mcp.md`
 * §Outputs) and a different failure.
 *
 * Note on the staged draft: every field of it publishes with no `type` at all,
 * because `stagedDraftSchema` is `z.unknown()` throughout — a staged row is
 * what a file proposed and is allowed to be wrong. That is not a hole in this
 * rule. A staged row affects no balance, and the commit path re-parses the
 * draft through `transactionDraftSchema`
 * (`src/server/services/staging.ts:183`), whose amounts are
 * `positiveDecimalStringSchema`. An untyped node is not a node declared as a
 * number, so it is neither a failure here nor an exception to register.
 */

type Tool = { name: string; inputSchema?: unknown };

/**
 * What counts as a money name.
 *
 * Two halves. The suffixes catch the compounds without listing them, so
 * `sourceAmount` and a `settlementAmount` somebody adds next year are both
 * caught without this set being edited. The exact names are the figures whose
 * names say nothing about money but which are money all the same: the three
 * budget rules are percentages and a cap, all stored as decimal strings today
 * for precisely the reason this rule exists, and a percentage that multiplies
 * into a budget figure is inside the invariant by way of "a stored column".
 *
 * Deliberately not here: `limit`, `page`, `interval`, `periods`, `priority`,
 * `ordinal`, `weekday`, `expectedVersion` and `expectedCount`. Every one is a
 * count or an index, every one is an integer today, and every one would make
 * this check fire on correct code.
 */
const MONEY_SUFFIXES = [
  "amount",
  "balance",
  "total",
  "subtotal",
  "price",
  "spent",
  "assigned",
  "carried",
  "debit",
  "credit",
];
const MONEY_NAMES = new Set(["rate", "rollovercap", "percentofprevious", "percentofincome"]);

const isMoneyName = (name: string) => {
  const lower = name.toLowerCase();
  return MONEY_NAMES.has(lower) || MONEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/**
 * The register. A path prefix, and the argument for it.
 *
 * One entry, and it has to be a prefix rather than three leaf paths because the
 * whole object is the exception: its values are headings in somebody's CSV, not
 * figures. Were this left out, the check would be right about the name and
 * wrong about the thing — and the day somebody lets a mapping name a column by
 * its position, `"type": "integer"` under `mapping` would be correct and this
 * would refuse it.
 */
const NOT_A_MONEY_VALUE: { prefix: string; why: string }[] = [
  {
    prefix: "stage_csv.mapping",
    // Every value under `mapping` is the heading of a column in the uploaded
    // file — the text "Amount" as the bank spells it — rather than an amount.
    // The figures those columns hold are parsed out of the file as text and
    // never reach this schema at all.
    why: "column headings, not values",
  },
];

const excusedBy = (entry: { prefix: string }, path: string) =>
  path === entry.prefix ||
  path.startsWith(`${entry.prefix}.`) ||
  path.startsWith(`${entry.prefix}[`);

const excused = (path: string) => NOT_A_MONEY_VALUE.some((entry) => excusedBy(entry, path));

const NUMERIC = new Set(["number", "integer"]);

const isNumeric = (type: unknown) =>
  typeof type === "string"
    ? NUMERIC.has(type)
    : Array.isArray(type) &&
      type.some((member) => typeof member === "string" && NUMERIC.has(member));

type Node = Record<string, unknown>;

/**
 * Every schema node, carrying the property name that introduced it.
 *
 * The name travels down through `items`, `anyOf`, `oneOf` and `allOf` rather
 * than being cleared, because `amount` as a nullable pair publishes as an
 * `anyOf` whose number member has no name of its own — which is how a money
 * argument would hide from a walk that only looked at `properties`.
 */
function walk(
  node: unknown,
  path: string,
  name: string | null,
  visit: (node: Node, path: string, name: string) => void,
): void {
  if (!node || typeof node !== "object") return;
  const schema = node as Node;
  if (name) visit(schema, path, name);
  const properties = schema["properties"];
  if (properties && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties))
      walk(value, `${path}.${key}`, key, visit);
  }
  const items = schema["items"];
  if (Array.isArray(items))
    items.forEach((item, index) => walk(item, `${path}[${index}]`, name, visit));
  else if (items) walk(items, `${path}[]`, name, visit);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branch = schema[key];
    if (Array.isArray(branch))
      branch.forEach((member, index) => walk(member, `${path}|${key}${index}`, name, visit));
  }
  const additional = schema["additionalProperties"];
  if (additional && typeof additional === "object") walk(additional, `${path}.*`, name, visit);
}

let moneyNodes: { path: string; node: Node }[] = [];
let listed: Tool[] = [];

beforeAll(async () => {
  // Every scope at once: a tool is only listed under the scopes that reach it,
  // and a money argument on a write tool is invisible to a read-scoped listing.
  const server = createMcpServer(
    { userId: "money-arguments", source: "mcp", clientId: "money-arguments" },
    new Set(["ledger:read", "ledger:stage", "ledger:write"]),
  );
  const client = new Client({ name: "money-arguments", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();

  listed = tools as Tool[];

  const found: { path: string; node: Node }[] = [];
  for (const tool of listed) {
    walk(tool.inputSchema, tool.name, null, (node, path, name) => {
      if (isMoneyName(name) && !excused(path)) found.push({ path, node });
    });
  }
  moneyNodes = found;
});

describe("money arguments on the MCP surface", () => {
  /**
   * The walk, before the verdict.
   *
   * A check that reports nothing wrong because it looked at nothing is the
   * failure mode here: a rename of `inputSchema`, a listing that comes back
   * empty under some scope, or a walk that stops at the top level would all
   * leave the test below passing forever. So this names figures that are
   * unambiguously money and insists they were reached, including one behind a
   * `oneOf` and one behind an array, which are the two shapes a shallow walk
   * misses.
   */
  it("reaches the money arguments it is supposed to be checking", () => {
    const paths = new Set(moneyNodes.map((entry) => entry.path));
    for (const path of [
      "create_transaction.draft|oneOf0.amount",
      "create_transaction.draft|oneOf2.sourceAmount",
      "create_transaction.draft|oneOf0.legs[].amount",
      "create_account.openingBalance",
      "set_budget_entry.amount",
      "create_budget_plan.targetAmount|anyOf0",
      "create_recurrence.shape|oneOf2.destinationAmount",
    ]) {
      expect(paths.has(path), `the walk never reached ${path}`).toBe(true);
    }
    expect(moneyNodes.length).toBeGreaterThan(40);
  });

  it("declares none of them as a number", () => {
    const numeric = moneyNodes
      .filter((entry) => isNumeric(entry.node["type"]))
      .map((entry) => `${entry.path} is declared "${String(entry.node["type"])}"`);
    expect(numeric).toEqual([]);
  });

  /**
   * And the register earns its place rather than sitting there.
   *
   * An entry whose prefix no longer matches a money-named node is excusing
   * nothing, and a stale excuse is how a register turns into a list of holes.
   * So this walks again with the register switched off and insists each prefix
   * covers something.
   */
  it("keeps no exception that excuses nothing", () => {
    const covered = new Map(NOT_A_MONEY_VALUE.map((entry) => [entry.prefix, [] as string[]]));
    for (const tool of listed) {
      walk(tool.inputSchema, tool.name, null, (_node, path, name) => {
        if (!isMoneyName(name)) return;
        for (const entry of NOT_A_MONEY_VALUE) {
          if (excusedBy(entry, path)) covered.get(entry.prefix)!.push(path);
        }
      });
    }
    const idle = [...covered].filter(([, paths]) => paths.length === 0).map(([prefix]) => prefix);
    expect(idle).toEqual([]);
    expect(covered.get("stage_csv.mapping")).toEqual([
      "stage_csv.mapping.amount",
      "stage_csv.mapping.debit",
      "stage_csv.mapping.credit",
    ]);
  });
});
