import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server/mcp.js";

/**
 * The MCP surface is meant to be able to do everything the browser can, so this
 * compares the two directly rather than listing what is expected to exist.
 *
 * The comparison is by REST route: every `/api/v1` route the browser has is
 * either reachable through a tool or is named below as a deliberate exception.
 * Adding a route without a tool fails here, which is the point. So does adding a
 * route and quietly adding it to the exception list, because each exception has
 * to carry a reason somebody will read.
 */
const BROWSER_ONLY: Record<string, string> = {
  "DELETE /api/v1/me":
    "Deleting the account destroys every row and the audit trail with it, and nothing restores any of it. It stays something a person does while signed in.",
  "POST /api/v1/auth/local-password":
    "Setting a sign-in credential is account management rather than bookkeeping, and an agent cannot undo it from its side.",
  "GET /api/v1/session":
    "Split rather than missing: whoami reports the identity and get_preferences the regional settings. The rest of it is which sign-in methods the deployment offers, which is no business of an agent's.",
  "GET /api/v1/csv/export":
    "Reachable as export_transactions_csv. The route differs only in returning a file download with a dated filename.",
};

/** What each REST route needs a tool to be reachable through. */
const COVERED_BY: Record<string, string> = {
  "GET /api/v1/accounts": "list_accounts",
  "GET /api/v1/accounts/:id": "get_account",
  "GET /api/v1/accounts/:id/balances": "get_account_balances",
  "GET /api/v1/accounts/:id/register": "get_account_register",
  "POST /api/v1/accounts": "create_account",
  "PUT /api/v1/accounts/:id": "update_account",
  "POST /api/v1/accounts/:id/archive": "archive_account",
  "DELETE /api/v1/accounts/:id": "delete_account",
  "GET /api/v1/recurrences": "list_recurrences",
  "GET /api/v1/recurrences/:id": "get_recurrence",
  "POST /api/v1/recurrences": "create_recurrence",
  "PUT /api/v1/recurrences/:id": "update_recurrence",
  "DELETE /api/v1/recurrences/:id": "delete_recurrence",
  "GET /api/v1/categories": "list_categories",
  "GET /api/v1/categories/summaries": "list_categories",
  "GET /api/v1/categories/:id": "get_category",
  "GET /api/v1/categories/duplicates": "list_duplicate_categories",
  "POST /api/v1/categories": "create_category",
  "PUT /api/v1/categories/:id": "update_category",
  "POST /api/v1/categories/:id/archive": "archive_category",
  "DELETE /api/v1/categories/:id": "delete_category",
  "POST /api/v1/categories/merge": "merge_categories",
  "GET /api/v1/payees": "list_payees",
  "GET /api/v1/payees/duplicates": "list_duplicate_payees",
  "GET /api/v1/payees/suggestions": "list_payee_suggestions",
  "POST /api/v1/payees/merge": "merge_payees",
  "GET /api/v1/transactions": "list_transactions",
  "GET /api/v1/transactions/:id": "get_transaction",
  "POST /api/v1/transactions": "create_transaction",
  "PUT /api/v1/transactions/:id": "update_transaction",
  "POST /api/v1/transactions/:id/deleted": "set_transaction_deleted",
  "POST /api/v1/transactions/bulk-selection": "preview_bulk_transaction_selection",
  "POST /api/v1/transactions/bulk-edit": "bulk_edit_transactions",
  "POST /api/v1/transactions/bulk-delete": "bulk_delete_transactions",
  "GET /api/v1/staged-transactions": "list_staged_transactions",
  "GET /api/v1/staged-transactions/:id": "get_staged_transaction",
  "POST /api/v1/staged-transactions": "create_staged_transaction",
  "PUT /api/v1/staged-transactions/:id": "update_staged_transaction",
  "POST /api/v1/staged-transactions/commit": "commit_staged_transactions",
  "POST /api/v1/staged-transactions/delete": "delete_staged_transactions",
  "POST /api/v1/staged-transactions/bulk-selection": "preview_bulk_staged_selection",
  "POST /api/v1/staged-transactions/bulk-edit": "bulk_edit_staged_transactions",
  "GET /api/v1/transaction-templates": "list_transaction_templates",
  "GET /api/v1/transaction-templates/:id": "get_transaction_template",
  "POST /api/v1/transaction-templates": "create_transaction_template",
  "PUT /api/v1/transaction-templates/:id": "update_transaction_template",
  "DELETE /api/v1/transaction-templates/:id": "delete_transaction_template",
  "POST /api/v1/transaction-templates/bulk-edit":
    "bulk_edit_transaction_templates",
  "POST /api/v1/transaction-templates/bulk-delete":
    "bulk_delete_transaction_templates",
  "POST /api/v1/csv/preview": "preview_csv",
  "POST /api/v1/csv/stage": "stage_csv",
  "GET /api/v1/import-batches": "list_import_batches",
  "GET /api/v1/reports/:report": "get_report",
  "GET /api/v1/summary": "get_financial_summary",
  "GET /api/v1/audit-events": "list_audit_events",
  "GET /api/v1/connected-apps": "list_connected_agents",
  "DELETE /api/v1/connected-apps/:clientId": "revoke_connected_agent",
  "PUT /api/v1/preferences": "set_preferences",
  "GET /api/v1/me/data": "summarize_own_data",
};

async function registeredRoutes() {
  const source = await readFile(
    new URL("../src/server/api.ts", import.meta.url),
    "utf8",
  );
  const routes = new Set<string>();
  for (const match of source.matchAll(
    /app\.(get|post|put|delete)\(\s*"(\/api\/v1[^"]*)"/g,
  )) {
    routes.add(`${match[1]!.toUpperCase()} ${match[2]}`);
  }
  return routes;
}

/**
 * Which service functions a route handler and a tool handler each call.
 *
 * Both transports are adapters over one service layer, so the check that
 * matters is not that a tool with the right name exists but that it reaches the
 * same code. A tool that quietly moved to a narrower service would still answer
 * plausibly, so this compares what is written rather than what is returned.
 *
 * Routes are cut at the next route rather than matched as a balanced call: some
 * are one-liners and some span lines, and a regex trying to find the closing
 * bracket swallows every route after a one-liner. That is not hypothetical — it
 * is how the first version of this silently compared half of them.
 */
async function servicesByRoute() {
  const source = await readFile(
    new URL("../src/server/api.ts", import.meta.url),
    "utf8",
  );
  const starts = [
    ...source.matchAll(/^app\.(get|post|put|delete)\(\s*"(\/api\/v1[^"]*)"/gm),
  ];
  const byRoute = new Map<string, Set<string>>();
  starts.forEach((start, index) => {
    const next = starts[index + 1];
    const body = source.slice(start.index!, next ? next.index! : source.length);
    byRoute.set(
      `${start[1]!.toUpperCase()} ${start[2]}`,
      new Set(
        [...body.matchAll(/\b([a-z][A-Za-z0-9]*)\(\s*c\.get\("actor"\)/g)].map(
          (call) => call[1]!,
        ),
      ),
    );
  });
  return byRoute;
}

async function servicesByTool() {
  const source = await readFile(
    new URL("../src/server/mcp.ts", import.meta.url),
    "utf8",
  );
  const byTool = new Map<string, Set<string>>();
  for (const match of source.matchAll(
    /registerTool\(\s*"([a-z_]+)",\s*\{.*?\n      \},\s*(.*?)\n    \);/gs,
  )) {
    byTool.set(
      match[1]!,
      new Set(
        [...match[2]!.matchAll(/\b([a-z][A-Za-z0-9]*)\(\s*actor\b/g)].map(
          (call) => call[1]!,
        ),
      ),
    );
  }
  return byTool;
}

/**
 * The one pair that deliberately differs, and in the agent's favour: the page
 * lists categories and asks for the usage counts separately, while the tool
 * always returns them, so an agent can tell an existing category from a second
 * spelling of one without a second call.
 */
const RICHER_ON_PURPOSE: Record<string, string> = {
  "GET /api/v1/categories": "list_categories",
};

async function toolNames(scopes: string[]) {
  const server = createMcpServer(
    { userId: "parity-user", source: "mcp", clientId: "parity-test" },
    new Set(scopes),
  );
  const client = new Client({ name: "parity", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return new Set(tools.map((tool) => tool.name));
}

async function toolsWithAnnotations(scopes: string[]) {
  const server = createMcpServer(
    { userId: "parity-user", source: "mcp", clientId: "parity-test" },
    new Set(scopes),
  );
  const client = new Client({ name: "parity", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

const everyScope = ["ledger:read", "ledger:stage", "ledger:write"];

describe("what an agent can reach compared with the browser", () => {
  it("has a tool for every route that is not a named exception", async () => {
    const routes = await registeredRoutes();
    const tools = await toolNames(everyScope);

    const unreachable: string[] = [];
    for (const route of routes) {
      if (route in BROWSER_ONLY) continue;
      const tool = COVERED_BY[route];
      if (!tool) {
        unreachable.push(`${route} — no tool claimed`);
      } else if (!tools.has(tool)) {
        unreachable.push(`${route} — claims ${tool}, which is not registered`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  // Otherwise the map above rots into a list of routes that no longer exist and
  // stops being evidence of anything.
  it("claims no route that has been removed", async () => {
    const routes = await registeredRoutes();
    const claimed = [...Object.keys(COVERED_BY), ...Object.keys(BROWSER_ONLY)];
    expect(claimed.filter((route) => !routes.has(route))).toEqual([]);
  });

  /**
   * The name map proves a tool exists for each route. This proves it is the
   * same tool: a route and its tool reaching different services is a parity gap
   * the map cannot see, and the shape it takes is a tool that accepts fewer
   * filters or writes fewer fields than the page beside it.
   */
  it("reaches the same service from both transports", async () => {
    const byRoute = await servicesByRoute();
    const byTool = await servicesByTool();

    const divergent: string[] = [];
    let compared = 0;
    for (const [route, tool] of Object.entries(COVERED_BY)) {
      if (RICHER_ON_PURPOSE[route] === tool) continue;
      const routeServices = byRoute.get(route);
      const toolServices = byTool.get(tool);
      // Two handlers name no service this can read: one delegates to Better
      // Auth and one takes a file rather than an actor. Skipped rather than
      // failed, and the count below is what stops that skip growing quietly.
      if (!routeServices?.size || !toolServices?.size) continue;
      compared += 1;
      if (![...routeServices].some((service) => toolServices.has(service))) {
        divergent.push(
          `${route} calls ${[...routeServices].join(", ")} but ${tool} calls ${[...toolServices].join(", ")}`,
        );
      }
    }

    expect(divergent).toEqual([]);
    // Guards the parsing. A regex that stopped matching would otherwise make
    // this pass by comparing nothing at all, which is exactly what an earlier
    // version of it did.
    expect(compared).toBeGreaterThanOrEqual(
      Object.keys(COVERED_BY).length - Object.keys(RICHER_ON_PURPOSE).length - 2,
    );
  });

  /**
   * A tool nobody wrote down is one an agent's operator cannot discover from
   * the guide, and the guide fell seventeen tools behind before anything
   * noticed. Checked by name rather than by count so the failure says which.
   */
  it("names every tool in the MCP guide", async () => {
    const guide = await readFile(
      new URL("../docs/mcp.md", import.meta.url),
      "utf8",
    );
    const tools = await toolNames(everyScope);
    const undocumented = [...tools].filter((tool) => !guide.includes(tool)).sort();
    expect(undocumented).toEqual([]);
  });

  it("keeps the two exceptions out of the tool list entirely", async () => {
    const tools = await toolNames(everyScope);
    for (const forbidden of [
      "delete_own_account",
      "delete_account_permanently",
      "set_local_password",
      "set_password",
    ]) {
      expect(tools.has(forbidden)).toBe(false);
    }
  });

  /**
   * Derived rather than listed, because the list below it is what failed: three
   * recurrence write tools were added to the file in the read block and nobody
   * had to remember to name them here. A tool declares itself with
   * `readOnlyHint`, so what a read-only token may see is answerable without a
   * roster anybody has to keep.
   */
  it("offers a read-only token nothing that declares itself a write", async () => {
    const tools = await toolsWithAnnotations(["ledger:read"]);

    expect(tools.length).toBeGreaterThan(0);
    const writes = tools
      .filter((tool) => tool.annotations?.readOnlyHint !== true)
      .map((tool) => tool.name);
    expect(writes).toEqual([]);
  });

  it("hides every write from a token that may only read", async () => {
    const readOnly = await toolNames(["ledger:read"]);
    for (const write of [
      "create_transaction",
      "set_preferences",
      "create_transaction_template",
      "update_transaction_template",
      "delete_transaction_template",
      "merge_payees",
      "bulk_edit_transaction_templates",
      "bulk_delete_transaction_templates",
      "create_recurrence",
      "update_recurrence",
      "delete_recurrence",
    ]) {
      expect(readOnly.has(write), `${write} must need more than read`).toBe(false);
    }
    // The reads it does get include the ones added for parity.
    for (const read of [
      "whoami",
      "get_preferences",
      "get_account",
      "get_category",
      "list_payee_suggestions",
      "list_import_batches",
      "preview_csv",
      "summarize_own_data",
      "list_transaction_templates",
      "get_transaction_template",
    ]) {
      expect(readOnly.has(read), `${read} should be readable`).toBe(true);
    }
  });

  it("gives every tool a description an agent can act on", async () => {
    const server = createMcpServer(
      { userId: "parity-user", source: "mcp", clientId: "parity-test" },
      new Set(everyScope),
    );
    const client = new Client({ name: "parity", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();

    for (const tool of tools) {
      expect(
        (tool.description ?? "").length,
        `${tool.name} needs a description`,
      ).toBeGreaterThan(30);
    }
  });

  /**
   * A tool declaring a wider schema than its service parses is worse than a
   * missing filter: the agent is told the parameter exists, sends it, and
   * either has it silently ignored or is refused for a value the tool said was
   * fine. Where a service parses input itself, the tool has to declare that
   * same schema rather than a convenient superset.
   */
  it("declares the schema each listing actually parses", async () => {
    const source = await readFile(
      new URL("../src/server/mcp.ts", import.meta.url),
      "utf8",
    );
    const declared = (tool: string) =>
      new RegExp(`"${tool}",[\\s\\S]{0,900}?inputSchema: ([A-Za-z.]+)`).exec(
        source,
      )?.[1];

    expect(declared("list_transactions")).toBe("listQuerySchema");
    expect(declared("list_staged_transactions")).toBe("stageListQuerySchema");
    // Its service reads a cursor and a limit and nothing else, and caps that
    // limit lower than the shared listing schema does.
    expect(declared("list_import_batches")).toBe("importBatchListQuerySchema");
  });
});
