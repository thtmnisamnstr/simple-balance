import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createMcpServer, TOOL_SCOPES } from "../src/server/mcp.js";
import { sourceFiles } from "./support/source.js";

/**
 * The four properties of this MCP surface that nothing else looks at.
 *
 * Each is small, and `docs/standards/mcp.md` concedes as much about three of
 * them. They are here together because they share one failure shape: nothing
 * about any of them is visible in a diff, in a review, or in a running server
 * that answers every call correctly.
 */

type Tool = {
  name: string;
  annotations?: Record<string, unknown>;
};

const EVERY_SCOPE = ["ledger:read", "ledger:stage", "ledger:write"];

async function listTools(scopes: readonly string[]): Promise<Tool[]> {
  const server = createMcpServer(
    { userId: "protocol-surface", source: "mcp", clientId: "protocol-surface" },
    new Set(scopes),
  );
  const client = new Client({ name: "protocol-surface", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools as Tool[];
}

/**
 * The revision this guide is written against is the one the SDK negotiates.
 *
 * `mcp.md` §The revision this is written against names 2025-11-25 and spends
 * four bullets on what the next revision will oblige — `server/discover`, the
 * caching hints a `resultType: "complete"` result must carry, per-request
 * negotiation through `_meta`, and that `tools/list` must answer `private`
 * rather than the specification's own `public` example, because this tool list
 * varies by scope and a shared cache holding it would hand a `ledger:read`
 * token a `ledger:write` list.
 *
 * None of that is reachable from the installed SDK, so the guide says so
 * instead of claiming it. The guide also concedes this check: "A test comparing
 * the SDK's `LATEST_PROTOCOL_VERSION` against a constant named here would fail
 * on the day the SDK is upgraded, which is the day this section needs
 * rereading."
 *
 * That is the argument for building it, not against. An SDK bump is a
 * dependency line somebody approves in a minute; the four bullets above are a
 * section somebody has to reread, and nothing else in this repository would
 * ask them to. The failure message is the reading list.
 */
describe("the revision this surface speaks", () => {
  const guide = readFileSync("docs/standards/mcp.md", "utf8");

  it("is the one mcp.md is written against", () => {
    // Pulled out of the sentence that claims it rather than written down here,
    // so the guide is what this test reads and there is no third copy of the
    // number to keep.
    const claimed = /`LATEST_PROTOCOL_VERSION = "([0-9-]+)"`/.exec(guide);
    expect(claimed, "no sentence in mcp.md names LATEST_PROTOCOL_VERSION").not.toBeNull();
    expect(
      LATEST_PROTOCOL_VERSION,
      "the SDK has moved. Reread mcp.md §The revision this is written against: " +
        "`server/discover`, the `ttlMs`/`cacheScope` hints, `_meta` negotiation, and " +
        '`cacheScope: "private"` on `tools/list` — then update the sentence naming the revision.',
    ).toBe(claimed![1]);
  });

  it("names the SDK release it measured", () => {
    // The same sentence names a version, and a dependency bump that left the
    // protocol alone still moves what the paragraph is describing.
    const claimed = /`@modelcontextprotocol\/sdk` ([0-9]+\.[0-9]+\.[0-9]+)/.exec(guide);
    expect(claimed, "no sentence in mcp.md names the SDK version").not.toBeNull();
    const installed = JSON.parse(
      readFileSync("node_modules/@modelcontextprotocol/sdk/package.json", "utf8"),
    ) as { version: string };
    expect(installed.version).toBe(claimed![1]);
  });
});

/**
 * The order `tools/list` answers in, pinned.
 *
 * `mcp.md` §Paging and ordering files this as **Not checked. Registration order
 * is the de facto order.** It is met by construction and it is worth holding
 * anyway, because the cost of losing it is invisible: the three tiers' tool
 * lists measure 486,889 characters together, and a client that caches that
 * payload — or a model whose prompt holds it — pays a full miss for a reorder
 * that changes nothing about what the server can do. Moving one
 * `server.registerTool` call up a block in `src/server/mcp.ts` does it, and a
 * diff that moved a tool is indistinguishable from a diff that added one.
 *
 * Written out in full rather than compared against a sorted copy: sorting would
 * hold *an* order rather than *this* order, and the point is that the order a
 * client saw yesterday is the order it sees today. A deliberate move updates
 * this list in the same commit, which is a line of review rather than a
 * silence.
 */
describe("the order tools come back in", () => {
  /**
   * Registration order, as `tools/list` returns it for a token holding every
   * scope. The three tiers are contiguous — read, then stage, then write — so
   * a single-scope list is this one filtered, which is what the tier assertion
   * below checks rather than keeping three more copies.
   */
  const ORDER = [
    "list_accounts",
    "get_account_balances",
    "list_categories",
    "list_duplicate_categories",
    "list_payees",
    "list_duplicate_payees",
    "list_transactions",
    "get_transaction",
    "preview_bulk_transaction_selection",
    "get_account",
    "get_category",
    "whoami",
    "get_preferences",
    "list_payee_suggestions",
    "list_import_batches",
    "preview_csv",
    "summarize_own_data",
    "list_recurrences",
    "get_recurrence",
    "list_transaction_templates",
    "get_transaction_template",
    "preview_bulk_staged_selection",
    "list_staged_transactions",
    "get_staged_transaction",
    "get_financial_summary",
    "get_staged_duplicate",
    "get_report",
    "get_account_register",
    "export_transactions_csv",
    "list_audit_events",
    "list_connected_agents",
    "list_category_groups",
    "list_budget_plans",
    "get_budget_plan",
    "list_budget_entries",
    "get_forecast",
    "get_budget_report",
    "create_staged_transaction",
    "update_staged_transaction",
    "delete_staged_transactions",
    "bulk_edit_staged_transactions",
    "stage_csv",
    "create_category_group",
    "update_category_group",
    "delete_category_group",
    "create_budget_plan",
    "update_budget_plan",
    "delete_budget_plan",
    "set_budget_entry",
    "delete_budget_entry",
    "create_recurrence",
    "update_recurrence",
    "delete_recurrence",
    "revoke_connected_agent",
    "create_account",
    "update_account",
    "archive_account",
    "set_active_accounts",
    "delete_account",
    "create_category",
    "update_category",
    "archive_category",
    "set_preferences",
    "create_transaction_template",
    "update_transaction_template",
    "delete_transaction_template",
    "bulk_edit_transaction_templates",
    "bulk_delete_transaction_templates",
    "delete_category",
    "merge_categories",
    "merge_payees",
    "create_transaction",
    "update_transaction",
    "bulk_delete_transactions",
    "bulk_edit_transactions",
    "set_transaction_deleted",
    "commit_staged_transactions",
  ];

  it("is the order registration left them in", async () => {
    expect((await listTools(EVERY_SCOPE)).map((tool) => tool.name)).toEqual(ORDER);
  });

  it("gives each tier that order with the other tiers taken out", async () => {
    // The property a client actually depends on: a `ledger:read` token's list
    // is a subsequence of the whole, so a tool moving within its own block is
    // caught above and a tool moving *between* blocks is caught here as well —
    // the second being the one that also changes what a scope can reach.
    for (const scope of EVERY_SCOPE) {
      const offered = (await listTools([scope])).map((tool) => tool.name);
      const expected = ORDER.filter((name) => offered.includes(name));
      expect(offered, `${scope} lists its tools out of registration order`).toEqual(expected);
    }
  });
});

/**
 * A read-only tool is registered where a read-only token can reach it.
 *
 * `mcp.md` §Annotations files this as **Not checked, and empty today**, with
 * the reason it is the residue rather than the rule: a read-only tool filed
 * under `ledger:write` "would waste a tier's tool list rather than lie about
 * one". Waste is the right word and it is not nothing — the write tier's list
 * is the largest of the three, and a tool nobody at that tier needs is paid for
 * on every connection that holds it.
 *
 * `tests/mcp-parity.test.ts` already holds the direction that lies: a
 * `ledger:read` token is offered nothing annotated as a write, and no tool
 * annotated read-only calls a service that writes. Neither of those can see a
 * genuinely read-only tool registered one tier too high, because nothing about
 * that tool is false — it is merely out of reach of the token that should have
 * it. A `ledger:read` agent asking for a report it is entitled to and being
 * told the tool does not exist is the symptom, and the grant sentence in
 * `instructions` says a tool outside the grant is absent rather than refused,
 * so there is nothing for the agent to go on.
 *
 * Read off `TOOL_SCOPES` rather than off the tier listings, because that map is
 * what answers an under-scoped call before dispatch; `tests/mcp-measurements.test.ts`
 * is what holds it to the three registration blocks.
 */
describe("where a read-only tool is registered", () => {
  let readOnly: string[];

  beforeAll(async () => {
    readOnly = (await listTools(EVERY_SCOPE))
      .filter((tool) => tool.annotations?.["readOnlyHint"] === true)
      .map((tool) => tool.name);
  });

  /**
   * First, that the filter finds. An annotation key that stopped matching would
   * leave the assertion below iterating an empty list and passing on anything.
   */
  it("finds the tools that declare themselves read-only", () => {
    expect(readOnly).toContain("list_accounts");
    expect(readOnly).toContain("get_financial_summary");
    expect(readOnly.length).toBeGreaterThanOrEqual(30);
  });

  it("puts every one of them at ledger:read", () => {
    const stranded = readOnly
      .map((name) => ({ name, scope: TOOL_SCOPES.get(name) }))
      .filter((tool) => tool.scope !== "ledger:read")
      .map((tool) => `${tool.name} is read-only and registered at ${tool.scope ?? "no scope"}`);
    expect(stranded).toEqual([]);
  });
});

/**
 * This server ships tools, and nothing else.
 *
 * `mcp.md` §Tool, resource or prompt is **Binding** and quotes the
 * specification rather than paraphrasing it: a tool is model-controlled, a
 * resource is application-driven, a prompt is user-controlled. Simple Balance
 * answers all three questions with a tool, and the guide concedes the check is
 * nearly worthless — "Nothing would fail if a resource appeared."
 *
 * What it is worth is the two conditions the same section names as reopening
 * the decision: pinning a report into a conversation is a resource, and a
 * recurring named workflow is a prompt. Neither has been asked for. Somebody
 * reaching for `registerResource` because it is the nearest SDK call to hand is
 * how a surface acquires a second shape without anybody deciding it should,
 * and a failing test is where that decision gets made instead.
 *
 * Over the source rather than over a connection, because a resource registered
 * behind a condition no test sets up would be invisible to `resources/list`.
 * Comments blanked, so the sentence in this file's own guide — and any comment
 * quoting it — is not read as a call.
 */
describe("tools and nothing else", () => {
  const server = sourceFiles("src/server");

  /**
   * Every member the installed SDK declares as registering something, read off
   * its own type declarations: the ones returning a `Registered…` handle. That
   * is `registerTool`, `registerResource` and `registerPrompt`, the deprecated
   * `tool`, `resource` and `prompt` they replaced, and
   * `experimental.tasks.registerToolTask` — seven today, and an SDK that adds
   * an eighth adds it here without anybody having to know.
   */
  const SDK = "node_modules/@modelcontextprotocol/sdk/dist/esm";
  const registering = (declarations: string) => {
    const names = new Set<string>();
    let member = "";
    for (const line of declarations.split("\n")) {
      // A member starts at four spaces of indent. `registerTool`'s config
      // object runs deeper and closes on a line opening with `}`, so the name
      // held when its return type arrives is still its own.
      const start = /^ {4}(\w+)[<(]/.exec(line);
      if (start) member = start[1]!;
      if (/\): Registered\w+;/.test(line)) names.add(member);
    }
    return names;
  };
  const REGISTERING = new Set([
    ...registering(readFileSync(`${SDK}/server/mcp.d.ts`, "utf8")),
    ...registering(readFileSync(`${SDK}/experimental/tasks/mcp-server.d.ts`, "utf8")),
  ]);

  /**
   * And the two that register nothing by name. The low-level `Server` beneath
   * `McpServer` answers a JSON-RPC method with whatever `setRequestHandler` was
   * given, or with `fallbackRequestHandler` when nothing was — so either can
   * serve `resources/list` without a resource ever being registered.
   */
  const RAW = ["setRequestHandler", "fallbackRequestHandler"];

  /**
   * Where each one appears in `src/server`, comments blanked.
   *
   * A camelCase name is found wherever it appears, because nothing else is
   * spelled that way and a destructured or `.bind`-aliased method registers as
   * surely as a call. The three plain words are found only as a member —
   * `.resource`, or `server["resource"]` but not the array `["tool"]` a metric
   * labels itself with — because strings are not blanked, and "tool" is in
   * most of the descriptions.
   */
  const sites = (name: string) => {
    const pattern = /[A-Z]/.test(name)
      ? new RegExp(`\\b${name}\\b`, "g")
      : new RegExp(
          `(?:\\.\\s*${name}\\b|(?<=[\\w$)\\]])\\s*\\[\\s*["'\`]${name}["'\`]\\s*\\])`,
          "g",
        );
    return server.flatMap((file) =>
      [...file.code.matchAll(pattern)].map((match) => ({
        name,
        file: file.path,
        line: file.code.slice(0, match.index).split("\n").length,
        call: /^\s*\(/.test(file.code.slice(match.index + match[0].length)),
        registers: /^\s*\(\s*"([^"]+)"/.exec(file.code.slice(match.index + match[0].length))?.[1],
      })),
    );
  };

  /**
   * First, that the vocabulary is the SDK's and is whole. A declaration file
   * that moved or changed shape would leave the sweep below looking for nothing
   * and passing on everything — the old matcher's failure in another form: it
   * knew two spellings of seven, and none of the raw handlers.
   */
  it("knows every way the SDK has to register something", () => {
    expect([...REGISTERING]).toEqual(
      expect.arrayContaining(["registerTool", "registerResource", "registerPrompt", "tool"]),
    );
    expect(REGISTERING.size).toBeGreaterThanOrEqual(7);
    const protocol = readFileSync(`${SDK}/shared/protocol.d.ts`, "utf8");
    for (const name of RAW) {
      expect(protocol, `the SDK no longer declares ${name}`).toMatch(
        new RegExp(`^ {4}${name}[?<(:]`, "m"),
      );
    }
  });

  /**
   * The old check matched `register(Resource|Prompt)` and nothing else, so the
   * deprecated `server.resource(…)` and `server.prompt(…)`, a raw
   * `server.server.setRequestHandler(ListResourcesRequestSchema, …)`, and a
   * `fallbackRequestHandler` answering every method all passed it while putting
   * a resource or a prompt on the surface. Nor could it see a tool registered
   * around `registerTool`: `tool(…)` and `registerToolTask(…)` go straight to
   * the SDK's `_createRegisteredTool`, past the wrapper in `createMcpServer`
   * that times and counts every tool, so that tool would be served and never
   * measured.
   */
  it("registers no resource, no prompt, and no tool but through registerTool", () => {
    const found = [...REGISTERING, ...RAW]
      .filter((name) => name !== "registerTool")
      .flatMap(sites)
      .map((site) => `${site.file}:${site.line}: ${site.name}`);
    expect(
      found,
      "mcp.md §Tool, resource or prompt names the two conditions that reopen a resource " +
        "or a prompt; make the case there before adding one. A tool goes through " +
        "registerTool, which is what times and counts it.",
    ).toEqual([]);
  });

  /**
   * The guard that matters here. The assertion above is a search for
   * something absent, which a reader pointed at the wrong directory, or one
   * whose comment-blanking ate the code, would also report — and the old guard
   * asked only that `registerTool` appear once somewhere in `mcp.ts`.
   *
   * The same set rather than at least as many, compared by name so a failure
   * says which: a tool served that no `registerTool` call names was registered
   * some way this sweep cannot see, and a call that serves nothing to a token
   * holding every scope sits behind a condition other than scope, where the
   * specification says the tool set "MUST NOT vary per-connection".
   */
  it("finds one registerTool call for every tool the server offers", async () => {
    const calls = sites("registerTool").filter((site) => site.call);
    expect(calls.map((site) => site.file)).toContain("src/server/mcp.ts");
    expect(calls.length).toBeGreaterThanOrEqual(70);
    const offered = (await listTools(EVERY_SCOPE)).map((tool) => tool.name);
    const named = new Set(calls.map((site) => site.registers));
    expect(
      offered.filter((name) => !named.has(name)),
      "served, and named by no registerTool call in src/server",
    ).toEqual([]);
    expect(
      calls
        .filter((site) => !site.registers || !offered.includes(site.registers))
        .map(
          (site) =>
            `${site.file}:${site.line}: ${site.registers ?? "a name that is not a literal"}`,
        ),
      "a registerTool call a token holding every scope is not served",
    ).toEqual([]);
  });
});
