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

  it("registers no resource and no prompt", () => {
    const found = server.flatMap((file) =>
      [...file.code.matchAll(/\bregister(Resource|Prompt)\b/g)].map(
        (match) => `${file.path}: ${match[0]}`,
      ),
    );
    expect(
      found,
      "mcp.md §Tool, resource or prompt names the two conditions that reopen this. " +
        "Make the case there before adding one.",
    ).toEqual([]);
  });

  it("reads the file the registrations are actually in", () => {
    // The guard that matters here. The assertion above is a search for
    // something absent, which a reader pointed at the wrong directory, or one
    // whose comment-blanking ate the code, would also report.
    const registrations = server.filter((file) => /\bregisterTool\b/.test(file.code));
    expect(registrations.map((file) => file.path)).toContain("src/server/mcp.ts");
  });
});
