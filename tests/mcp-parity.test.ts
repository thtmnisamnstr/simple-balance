import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renamedRoutes } from "./support/routes.js";
import { createMcpServer } from "../src/server/mcp.js";
import { csvMappingSchema } from "../src/shared/csv.js";
import { listQuerySchema, stageListQuerySchema } from "../src/shared/domain.js";
import {
  blankComments,
  sourceFiles,
  topLevelDeclarations,
  type SourceFile,
} from "./support/source.js";
import { mutationNames } from "./support/mutations.js";

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
    "Split rather than missing: whoami reports the identity, the plan's ceiling and how much of it is used, and get_preferences the regional settings. What is left is which sign-in methods the deployment offers, which is no business of an agent's.",
  "GET /api/v1/billing":
    "Paying for the deployment is account management rather than bookkeeping. Reported to an agent as far as it needs it: whoami carries the plan, its ceiling and how much of it is used, which is what an agent has to know to explain a refusal.",
  "PUT /api/v1/billing/subscription":
    "Starting or changing a paid subscription spends somebody's money, and an MCP token is a credential handed to a program. It stays something a person does while signed in, alongside deleting the account and setting a password.",
  "PUT /api/v1/billing/subscription/cancellation":
    "The other half of the same decision. An agent that could not subscribe but could cancel would be a worse split, not a safer one.",
  "POST /api/v1/billing/payment-setups":
    "Returns a secret that only Stripe's browser SDK can use. There is nothing an agent could do with it.",
  "POST /api/v1/billing/payment-setups/confirmations":
    "The other half of that one: it names a SetupIntent only Stripe's browser SDK can have confirmed. An agent has no way to reach the state this reports.",
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
  "POST /api/v1/accounts/:id/archived": "archive_account",
  "PUT /api/v1/accounts/active": "set_active_accounts",
  "DELETE /api/v1/accounts/:id": "delete_account",
  "GET /api/v1/category-groups": "list_category_groups",
  "POST /api/v1/category-groups": "create_category_group",
  "PUT /api/v1/category-groups/:id": "update_category_group",
  "DELETE /api/v1/category-groups/:id": "delete_category_group",
  "GET /api/v1/budget-plans": "list_budget_plans",
  "GET /api/v1/budget-plans/:id": "get_budget_plan",
  "POST /api/v1/budget-plans": "create_budget_plan",
  "PUT /api/v1/budget-plans/:id": "update_budget_plan",
  "DELETE /api/v1/budget-plans/:id": "delete_budget_plan",
  "GET /api/v1/budget-entries": "list_budget_entries",
  "PUT /api/v1/budget-entries": "set_budget_entry",
  "DELETE /api/v1/budget-entries/:id": "delete_budget_entry",
  "GET /api/v1/budget-report": "get_budget_report",
  "GET /api/v1/forecast": "get_forecast",
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
  "POST /api/v1/categories/:id/archived": "archive_category",
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
  "POST /api/v1/staged-transactions/bulk-delete": "delete_staged_transactions",
  "POST /api/v1/staged-transactions/bulk-selection": "preview_bulk_staged_selection",
  "POST /api/v1/staged-transactions/bulk-edit": "bulk_edit_staged_transactions",
  "GET /api/v1/transaction-templates": "list_transaction_templates",
  "GET /api/v1/transaction-templates/:id": "get_transaction_template",
  "POST /api/v1/transaction-templates": "create_transaction_template",
  "PUT /api/v1/transaction-templates/:id": "update_transaction_template",
  "DELETE /api/v1/transaction-templates/:id": "delete_transaction_template",
  "POST /api/v1/transaction-templates/bulk-edit": "bulk_edit_transaction_templates",
  "POST /api/v1/transaction-templates/bulk-delete": "bulk_delete_transaction_templates",
  "POST /api/v1/csv/preview": "preview_csv",
  "POST /api/v1/csv/stage": "stage_csv",
  "GET /api/v1/import-batches": "list_import_batches",
  "GET /api/v1/reports/:report": "get_report",
  "GET /api/v1/staged-transactions/:id/duplicate": "get_staged_duplicate",
  "GET /api/v1/summary": "get_financial_summary",
  "GET /api/v1/audit-events": "list_audit_events",
  "GET /api/v1/connected-apps": "list_connected_agents",
  "DELETE /api/v1/connected-apps/:clientId": "revoke_connected_agent",
  "PUT /api/v1/preferences": "set_preferences",
  "GET /api/v1/me/data": "summarize_own_data",
};

async function registeredRoutes() {
  const source = await readFile(new URL("../src/server/api.ts", import.meta.url), "utf8");
  const routes = new Set<string>();
  const renamed = renamedRoutes(source);
  for (const match of source.matchAll(/app\.(get|post|put|delete)\(\s*"(\/api\/v1[^"]*)"/g)) {
    const route = `${match[1]!.toUpperCase()} ${match[2]}`;
    // A path kept alive across a rename is the same capability under its old
    // spelling, registered against the same handler. Counting it here would ask
    // for a second tool and a second browser call for one thing, which is the
    // opposite of what parity is about. `tests/http-route-table.test.ts` holds
    // these to naming a successor that exists.
    if (renamed.has(route)) continue;
    routes.add(route);
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
 *
 * A handler shared between two paths is written as a named `const` instead of
 * inline, because a renamed path is registered against the same handler as its
 * replacement. Those are collected first and spliced in wherever a route names
 * one, so a route does not read as calling no service at all.
 */
async function servicesByRoute() {
  const source = await readFile(new URL("../src/server/api.ts", import.meta.url), "utf8");
  const named = new Map<string, Set<string>>();
  const declarations = [...source.matchAll(/^const (\w+): Handler<AppEnv> =/gm)];
  declarations.forEach((declaration, index) => {
    const next = declarations[index + 1];
    const body = source.slice(declaration.index!, next ? next.index! : source.length);
    named.set(
      declaration[1]!,
      new Set(
        [...body.matchAll(/\b([a-z][A-Za-z0-9]*)\(\s*c\.get\("actor"\)/g)].map((call) => call[1]!),
      ),
    );
  });

  const starts = [...source.matchAll(/^app\.(get|post|put|delete)\(\s*"(\/api\/v1[^"]*)"/gm)];
  const byRoute = new Map<string, Set<string>>();
  starts.forEach((start, index) => {
    const next = starts[index + 1];
    const body = source.slice(start.index!, next ? next.index! : source.length);
    const services = new Set(
      [...body.matchAll(/\b([a-z][A-Za-z0-9]*)\(\s*c\.get\("actor"\)/g)].map((call) => call[1]!),
    );
    for (const [handler, calls] of named) {
      if (new RegExp(`\\b${handler}\\b`).test(body)) for (const call of calls) services.add(call);
    }
    byRoute.set(`${start[1]!.toUpperCase()} ${start[2]}`, services);
  });
  return byRoute;
}

async function servicesByTool() {
  const source = await readFile(new URL("../src/server/mcp.ts", import.meta.url), "utf8");
  const byTool = new Map<string, Set<string>>();
  for (const match of source.matchAll(
    /registerTool\(\s*"([a-z_]+)",\s*\{.*?\n      \},\s*(.*?)\n    \);/gs,
  )) {
    byTool.set(
      match[1]!,
      new Set(
        [...match[2]!.matchAll(/\b([a-z][A-Za-z0-9]*)\(\s*actor\b/g)].map((call) => call[1]!),
      ),
    );
  }
  return byTool;
}

/**
 * The one pair that deliberately differs, and in the agent's favor: the page
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
    const guide = await readFile(new URL("../docs/mcp.md", import.meta.url), "utf8");
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

  /**
   * The other half of the same claim: what the annotation says, and what the
   * code behind it does.
   *
   * The test above proves a read-only token is offered nothing annotated as a
   * write. It cannot see the failure the other way round — a tool annotated
   * `readOnlyHint: true` whose handler calls a service that writes a row. That
   * one is worse, because the annotation is what a client shows the person
   * approving the call: VS Code's is the only documented use of it, and it uses
   * it to decide what may run without asking.
   *
   * "Writes a row" is `tests/support/mutations.ts`, the same reader
   * `tests/service-transactions.test.ts` uses for the services guide, so there
   * is one definition of a write in this repository rather than two that drift.
   */
  it("annotates a tool read-only only when nothing it calls writes", async () => {
    const tools = await toolsWithAnnotations(everyScope);
    const services = await servicesByTool();
    const mutations = mutationNames(
      sourceFiles("src/server/services").flatMap((file) =>
        topLevelDeclarations(file).map((declaration) => ({
          name: declaration.name,
          body: declaration.body,
        })),
      ),
    );

    const lying: string[] = [];
    let compared = 0;
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint !== true) continue;
      const called = [...(services.get(tool.name) ?? [])];
      // `preview_csv` takes a file rather than an actor, so no service name can
      // be read off its handler. Skipped rather than failed, and the count below
      // is what stops that skip growing quietly.
      if (called.length === 0) continue;
      compared += 1;
      const writes = called.filter((service) => mutations.has(service));
      if (writes.length > 0) lying.push(`${tool.name} calls ${writes.join(", ")}`);
    }

    expect(lying).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(34);
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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();

    for (const tool of tools) {
      expect((tool.description ?? "").length, `${tool.name} needs a description`).toBeGreaterThan(
        30,
      );
    }
  });

  /**
   * A name is for a machine and a title is for a person, and the two are held
   * to different rules.
   *
   * The name has to be something a model can retype: the specification's own
   * character set and length, and `verb_noun` in snake_case on top of it, with
   * `whoami` named as the one exception because it is the name the thing has.
   * The title is what an approval dialog shows, so it must not claim another
   * tier's verb — `create_transaction` was once titled "Commit a transaction",
   * which is the sentence `commit_staged_transactions` owns, and a person
   * approving it could believe they were releasing a row they had already
   * reviewed. The adjective is fine: "List committed transactions" says what
   * the rows already are rather than what the call is about to do.
   */
  it("names tools for a machine and titles them so no title claims another tier's verb", async () => {
    const tools = await toolsWithAnnotations(everyScope);
    const withTitles = tools as { name: string; title?: string }[];

    const malformed = withTitles
      .filter((tool) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(tool.name) || tool.name.length > 128)
      .map((tool) => tool.name);
    expect(malformed).toEqual([]);
    const oneWord = withTitles.filter((tool) => !tool.name.includes("_")).map((tool) => tool.name);
    expect(oneWord).toEqual(["whoami"]);

    // Two dialogs a person cannot tell apart are two chances to approve the
    // wrong one, so a repeated title fails whichever tools carry it.
    const titles = withTitles.map((tool) => (tool.title ?? "").toLowerCase());
    expect(titles.filter((title) => title.length === 0)).toEqual([]);
    expect(titles.filter((title, index) => titles.indexOf(title) !== index)).toEqual([]);

    const claimingCommit = withTitles
      .filter((tool) => /\bcommits?\b/i.test(tool.title ?? ""))
      .map((tool) => tool.name);
    expect(claimingCommit).toEqual(["commit_staged_transactions"]);
  });

  /**
   * Scope gates by non-registration, so "needs ledger:write" in a description
   * is read only by an agent that already holds ledger:write and never by the
   * one that does not. Written on all 36 gated tools it would be about 3,600
   * characters of one convention repeated per tool, for a reader who cannot
   * benefit. What a description owes is the behavior that differs by scope,
   * which is these four and nothing else — so this is set equality rather than
   * a floor, and it fails both when one of them loses its sentence and when
   * somebody starts pasting the scope onto the rest.
   */
  it("names a scope only where the scope changes what the tool does", async () => {
    const tools = await toolsWithAnnotations(everyScope);
    const naming = tools
      .filter((tool) => /ledger:(read|stage|write)/.test(tool.description ?? ""))
      .map((tool) => tool.name)
      .sort();
    expect(naming).toEqual([
      "bulk_edit_staged_transactions",
      "create_budget_plan",
      "stage_csv",
      "update_staged_transaction",
    ]);
  });

  /**
   * A tool declaring a wider schema than its service parses is worse than a
   * missing filter: the agent is told the parameter exists, sends it, and
   * either has it silently ignored or is refused for a value the tool said was
   * fine. Where a service parses input itself, the tool has to declare that
   * same schema rather than a convenient superset.
   */
  it("declares the schema each listing actually parses", async () => {
    const source = await readFile(new URL("../src/server/mcp.ts", import.meta.url), "utf8");
    // `.strict()` is closure, not width: it narrows what the tool accepts to
    // exactly the declared shape, which is the direction this test wants.
    const declared = (tool: string) =>
      new RegExp(`"${tool}",[\\s\\S]{0,900}?inputSchema: ([A-Za-z.]+)`)
        .exec(source)?.[1]
        ?.replace(/\.strict$/, "");

    expect(declared("list_transactions")).toBe("listQuerySchema");
    expect(declared("list_staged_transactions")).toBe("stageListQuerySchema");
    // Its service reads a cursor and a limit and nothing else, and caps that
    // limit lower than the shared listing schema does.
    expect(declared("list_import_batches")).toBe("importBatchListQuerySchema");
  });
});

/**
 * The other direction, which nothing checked until a budget shipped with tools
 * the page had no way to reach.
 *
 * Parity was only ever enforced one way: every route needed a tool. That let
 * the agent surface run ahead of the browser, which is the wrong way round for
 * a product whose argument is that a person and their agent see the same
 * ledger. A capability an agent has and a person does not is a capability
 * nobody asked for in that shape.
 *
 * Matched on the static prefix of the path, because that is how the browser
 * writes a URL: a literal up to the first parameter, then a template.
 */
const AGENT_ONLY: Record<string, string> = {
  // The four reads by id. Each passed this check for as long as it matched on
  // the path alone, behind the edit form that sends a PUT to the same URL; the
  // check is method-aware now and they are named instead.
  "GET /api/v1/transactions/:id":
    "Every page that shows or edits an entry already holds it from the list it was opened from, so the browser never reads one by id. An agent meets ids with no list behind them — a staged row's duplicateOfId, an audit event's entityId — and get_transaction reads the record they name.",
  "GET /api/v1/staged-transactions/:id":
    "The staged queue holds every row it shows from the list it fetched, and the duplicate review has its own route. An agent holding a staged id from a DUPLICATE refusal's details has no other way to read that row.",
  "GET /api/v1/recurrences/:id":
    "The Recurring page fetches the whole list, which is capped, and edits from it. An agent holding the recurrenceId a staged row carries reads the recurrence that proposed it here.",
  "GET /api/v1/budget-plans/:id":
    "The budgets page fetches every plan at once and edits from that list. An agent given one plan's id reads that plan here rather than listing them all to find it.",
  "POST /api/v1/staged-transactions/bulk-selection":
    "Staged commits and deletes are explicit-ID, so the page walks the pages and keeps the rows rather than handing the server a filter, and says so at StagingPage.tsx. The route exists for preview_bulk_staged_selection, where an agent has no pages to walk.",
};

/**
 * The method each call in the browser makes, read off the call itself.
 *
 * The path alone is not a route: `GET /api/v1/transactions/:id` passed for as
 * long as anything sent a `PUT` to the same path, and four agent-only reads
 * hid that way behind the edit forms that share their URL. So each place the
 * path appears is followed out to the call it sits in, and the method is what
 * that call says — a `method:` it names, `json(…)` for the POST that helper
 * makes, and otherwise the GET `fetch` defaults to.
 */
function callMethods(client: string, pattern: RegExp): Set<string> {
  const methods = new Set<string>();
  const global = new RegExp(pattern.source, "g");
  for (const match of client.matchAll(global)) {
    const { open, end } = enclosingCall(client, match.index);
    let call = client.slice(open, end + 1);
    // A request built beforehand and passed by name — the import page builds
    // one body for its plain call and its streamed one — is read where it was
    // built, the nearest `const` of that name before the call.
    const named = /,\s*(\w+)\s*[,)]/.exec(call.slice(match[0].length + 1));
    if (named && !/method:|\bjson\(/.test(call)) {
      const built = client.lastIndexOf(`const ${named[1]} = `, match.index);
      if (built !== -1) call += client.slice(built, client.indexOf(";", built));
    }
    const method = /method:\s*"([A-Z]+)"/.exec(call);
    methods.add(method ? method[1]! : /\bjson\(/.test(call) ? "POST" : "GET");
  }
  return methods;
}

/** Where the call holding the URL at `at` opens, and the `)` that closes it. */
function enclosingCall(client: string, at: number): { open: number; end: number } {
  // Back to the `(` that opens the call holding this URL, then forward to the
  // `)` that closes it, skipping over strings and template holes both ways
  // is not needed backwards: the URL is the call's first argument.
  const open = client.lastIndexOf("(", at);
  let depth = 0;
  let end = open;
  const stack: string[] = [];
  for (let index = open; index < client.length; index++) {
    const character = client[index]!;
    const top = stack.at(-1);
    if (top === '"' || top === "'") {
      if (character === "\\") index++;
      else if (character === top) stack.pop();
      continue;
    }
    if (top === "`") {
      if (character === "\\") index++;
      else if (character === "`") stack.pop();
      else if (character === "$" && client[index + 1] === "{") {
        stack.push("{");
        index++;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") stack.push(character);
    else if (character === "{") stack.push("{");
    else if (character === "}") stack.pop();
    else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) {
      end = index;
      break;
    }
  }
  return { open, end };
}

/**
 * The whole path a route is called by, with each parameter standing in for a
 * template hole.
 *
 * The backward check once asked whether the prefix before the first parameter
 * appeared anywhere in the client, which is true of `/api/v1/accounts` the
 * moment anything fetches an account — so every parameterized sub-route was
 * unchecked, and a page could stop calling one without it noticing.
 */
function routePathPattern(path: string): RegExp {
  return new RegExp(
    path
      .split("/")
      .map((segment) =>
        segment.startsWith(":")
          ? "\\$\\{[^}`]*\\}"
          : segment.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/") +
      // The path ends here — at the string's end, a query, or a template hole
      // that writes one: `/staged-transactions/${id}` is not called by a
      // page that fetches `/staged-transactions/${id}/duplicate`.
      "(?=[`\"'?$])",
  );
}

async function clientSource() {
  const root = new URL("../src/client/", import.meta.url);
  const walk = async (directory: URL): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push(...(await walk(new URL(`${entry.name}/`, directory))));
      } else if (/\.tsx?$/.test(entry.name)) {
        // Comments blanked: the method reader walks quotes to find where a call
        // ends, and an apostrophe in a comment inside a request body — "a
        // group's rank" — opened a string that never closed.
        out.push(blankComments(await readFile(new URL(entry.name, directory), "utf8")));
      }
    }
    return out;
  };
  return (await walk(root)).join("\n");
}

describe("what the browser can reach compared with an agent", () => {
  it("calls every route that is not a named agent-only exception", async () => {
    const routes = await registeredRoutes();
    const client = await clientSource();

    const unreachable: string[] = [];
    for (const route of routes) {
      if (route in AGENT_ONLY) continue;
      const pattern = routePathPattern(route.slice(route.indexOf(" ") + 1));
      const method = route.slice(0, route.indexOf(" "));
      if (!pattern.test(client)) {
        unreachable.push(`${route} — no call in src/client`);
      } else if (!callMethods(client, pattern).has(method)) {
        unreachable.push(`${route} — src/client calls the path, never with ${method}`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it("gives every agent-only route a reason", () => {
    for (const [route, reason] of Object.entries(AGENT_ONLY)) {
      expect(reason.length, route).toBeGreaterThan(40);
    }
  });

  /**
   * One level below the route list, which is the level the two checks above
   * cannot see.
   *
   * `AGENTS.md` says so in as many words: route by route "is where the test can
   * check, not where the rule stops — a request field only an agent ever sets is
   * the same defect one level down, and it is invisible to a comparison of route
   * lists". It names `categoryKind` as the one it caught by hand: documented for
   * the MCP, missing from the form, so the browser filed refunds as income.
   * `type` on the staged queue was the second, caught the same way.
   * `stageListQuerySchema` inherits it, `stageFilterConditions` really applies
   * it, and the page held no state that could send it — so `?type=transfer`
   * worked for an agent while nothing in the browser could ask the one list of
   * transactions in the product for its transfers.
   *
   * So this compares what a listing route PARSES against what the page that owns
   * that list SENDS. Each page builds its request as one named object: `params`
   * on the register, behind both the table and the CSV export link, and
   * `stageQuery` on the staged queue, behind both the table and the walk that
   * selects every matching row. Reading that object reads what the person in
   * front of it can reach.
   */
  type FilteredList = {
    /** What the reader calls this list. */
    readonly view: string;
    /** The file that owns it, repository-relative. */
    readonly file: string;
    /** The named object it spreads into every read of that route. */
    readonly request: string;
    readonly route: string;
    /** Every key the route's schema parses, paging and ordering included. */
    readonly parses: readonly string[];
    /**
     * Filters the page deliberately does not offer, each with the sentence it
     * has to be arguable in. A bare key is refused by the test below, exactly
     * as `AGENT_ONLY` refuses a route added to the exception list without one.
     */
    readonly unoffered: Readonly<Record<string, string>>;
  };

  const FILTERED_LISTS: readonly FilteredList[] = [
    {
      view: "the register",
      file: "src/client/TransactionBrowser.tsx",
      request: "params",
      route: "GET /api/v1/transactions",
      parses: Object.keys(listQuerySchema.shape),
      unoffered: {
        currency:
          "The one filter in this comparison that no page offers. An account holds exactly one currency, so the account select asks this question one account at a time, and a conversion deliberately matches under both of the currencies it touches rather than either alone. Adding a currency select would have to put `currency` into `bulkFilter` in the same change — otherwise a selection made from the view names rows the view never showed — which makes it a product decision rather than an oversight. Named here so it is visible rather than simply absent.",
      },
    },
    {
      view: "the staged queue",
      file: "src/client/pages/StagingPage.tsx",
      request: "stageQuery",
      route: "GET /api/v1/staged-transactions",
      parses: Object.keys(stageListQuerySchema.shape),
      unoffered: {
        categoryId:
          "A page's subject rather than a filter anybody chooses, which is the distinction `src/client/list-filters.ts` argues at length; this queue is about nothing in particular, so it has no subject to fix. The register sends it on this same route from `stagedParams` whenever a category page fixes one, so it is reachable — never as a control on this bar.",
        templateId:
          "The same case: a template page is about its template, and the register sends this on this same route from `stagedParams` to show that template's staged rows above its committed ones. The queue itself is about nothing in particular and has no subject to fix.",
        payee:
          "The same case again, and the one with the clearest reason to stay off the bar: a payee is free text rather than a list to pick from, so the search box is how this queue is narrowed to one. A payee page fixes it through `stagedParams` on this same route.",
      },
    },
  ];

  /** What describes a view rather than scopes it, as `bulkStageFilterSchema` omits it. */
  const PRESENTATION = new Set(["cursor", "page", "limit", "sort", "direction"]);

  /**
   * The keys of a named literal in a file, following `...spread` of another
   * named object in the same file.
   *
   * Read off `code` rather than `text`, so a brace or a comma inside a comment
   * cannot end the object early. In these two files that is not a hypothetical:
   * the comment above `stagedParams` runs four lines and names `includeDeleted`.
   *
   * Three shapes, because the browser writes its requests in three:
   *
   * - A plain object, which is how a filtered list builds the query it reads.
   * - An array of names, or of `{ key }` rows, which is how a mass-edit panel
   *   declares the fields it offers.
   * - A mutation, where the request travels through `json(…)`. The fields are
   *   that call's argument rather than the mutation's options object, so a
   *   declaration containing one is re-anchored to it; a filter object has no
   *   such call and is read where it stands.
   */
  function requestFields(file: SourceFile, name: string): Set<string> {
    const start = literalNamed(file, name);
    if (start === undefined) throw new Error(`${file.path} has no literal named ${name}`);
    return literalFields(file, start, new Set());
  }

  /** The balanced region that opens at `from`, which is a `{` or a `[`. */
  function balanced(file: SourceFile, from: number): string {
    let depth = 1;
    let end = from + 1;
    while (end < file.code.length && depth > 0) {
      const character = file.code[end]!;
      if ("{[(".includes(character)) depth += 1;
      else if ("}])".includes(character)) depth -= 1;
      end += 1;
    }
    return file.code.slice(from + 1, end - 1);
  }

  /**
   * Where the literal a name is bound to opens, as `requestFields` reads it: a
   * declaration containing a `json(…)` call is re-anchored to that call's
   * argument.
   *
   * The nearest declaration before `before` where there is one, and the first
   * in the file otherwise. Nearest, because a spread names whatever is in scope
   * where it is written: `forms.tsx` declares `const body` for templates and
   * again for recurrences, and `StagingPage.tsx` `const payload` for the
   * selection's commit and again for one row's — the first in the file is the
   * wrong one half the time.
   */
  function literalNamed(file: SourceFile, name: string, before?: number): number | undefined {
    const openers = [
      ...file.code.matchAll(new RegExp(`\\bconst ${name}\\b[^=\\n]*=[^={[\\n]*([{[])`, "g")),
    ];
    const opener =
      openers.filter((match) => before !== undefined && match.index < before).at(-1) ?? openers[0];
    if (!opener) return undefined;
    const start = opener.index + opener[0].length - 1;
    const body = balanced(file, start);
    const request = body.indexOf("json(");
    if (request === -1) return start;
    const argument = body.indexOf("{", request);
    if (argument === -1) throw new Error(`${file.path}: ${name} calls json() on no object`);
    // `balanced` indexes the whole file, so the offset has to be the one the
    // body was cut from rather than the one inside it.
    return start + 1 + argument;
  }

  /** The fields of the literal that opens at `start`, following what it spreads. */
  function literalFields(file: SourceFile, start: number, seen: Set<number>): Set<string> {
    if (seen.has(start)) return new Set();
    seen.add(start);
    const open = file.code[start]!;
    const body = balanced(file, start);

    const fields = new Set<string>();
    const take = (chunk: string, at: number) => {
      const trimmed = chunk.trim();
      if (open === "[") {
        // A field list is either names or `{ key: "name" }` rows; both say the
        // same thing, and a panel that switched between them should not change
        // what this reads.
        const row = /\bkey:\s*"([^"]+)"/.exec(trimmed) ?? /^"([^"]+)"/.exec(trimmed);
        if (row) fields.add(row[1]!);
        return;
      }
      const spread = /^\.\.\.([A-Za-z_$][\w$]*)\s*$/.exec(trimmed);
      if (spread) {
        const spreads = literalNamed(file, spread[1]!, at);
        if (spreads === undefined)
          throw new Error(`${file.path} has no literal named ${spread[1]}`);
        for (const field of literalFields(file, spreads, seen)) fields.add(field);
        return;
      }
      // `...(condition ? { expectedVersion } : {})` is a field the form really
      // sends, and reading only the head of the chunk saw a dot and took
      // nothing — so a conditional spread is read for every key of every object
      // literal inside it. Shorthand included: this read only `key:` pairs, so
      // `{ rolloverCap }` and `{ targetAmount, targetDate }` were invisible
      // while the comment above said the shorthand case was the one handled.
      if (trimmed.startsWith("...")) {
        let depth = 0;
        let member = "";
        for (const character of trimmed) {
          if (character === "{") {
            depth += 1;
            if (depth === 1) {
              member = "";
              continue;
            }
          } else if (character === "}") {
            depth -= 1;
            if (depth === 0) {
              const key = /^\s*([A-Za-z_$][\w$]*)/.exec(member);
              if (key) fields.add(key[1]!);
              continue;
            }
          } else if (character === "," && depth === 1) {
            const key = /^\s*([A-Za-z_$][\w$]*)/.exec(member);
            if (key) fields.add(key[1]!);
            member = "";
            continue;
          }
          if (depth >= 1) member += character;
        }
        return;
      }
      const key = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
      if (key) fields.add(key[1]!);
    };
    let nesting = 0;
    let from = 0;
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index]!;
      if ("{[(".includes(character)) nesting += 1;
      else if ("}])".includes(character)) nesting -= 1;
      else if (character === "," && nesting === 0) {
        take(body.slice(from, index), start + 1 + from);
        from = index + 1;
      }
    }
    take(body.slice(from), start + 1 + from);
    return fields;
  }

  it("sends every filter the route it reads parses", () => {
    const files = new Map(sourceFiles("src/client").map((file) => [file.path, file]));

    const unreachable: string[] = [];
    let compared = 0;
    for (const list of FILTERED_LISTS) {
      const file = files.get(list.file);
      if (!file) throw new Error(`${list.file} has moved; ${list.view} needs a new entry here`);
      const sent = requestFields(file, list.request);
      const parses = list.parses.filter((field) => !PRESENTATION.has(field));
      // A schema this could no longer read would make the whole check vacuous
      // by comparing against nothing, which is how the route comparison above
      // once passed.
      expect(parses.length, `${list.route} parses nothing`).toBeGreaterThan(5);
      for (const field of parses) {
        compared += 1;
        if (sent.has(field) || field in list.unoffered) continue;
        unreachable.push(
          `${list.route} parses ${field}, and ${list.view} never sends it: give it a control, or name it in unoffered with the reason`,
        );
      }
    }

    expect(unreachable).toEqual([]);
    // The same guard the service comparison carries: a reader that stopped
    // matching would otherwise report nothing wrong because it looked at
    // nothing at all.
    expect(compared).toBeGreaterThanOrEqual(20);
  });

  it("gives every filter a page does not offer a reason", () => {
    for (const list of FILTERED_LISTS) {
      for (const [field, reason] of Object.entries(list.unoffered)) {
        expect(reason.length, `${list.route} ${field}`).toBeGreaterThan(40);
      }
    }
  });

  /**
   * The same comparison on the write side, which is the half nothing checked.
   *
   * `mcp.md` §The agent surface never runs ahead of the browser says it in as
   * many words: "nothing compares the fields a tool writes against the fields a
   * page writes". The reading comparison above was built after a filter an
   * agent could send and a person could not; this is the identical defect on a
   * form, and it is the one with the named precedent. `categoryKind` was
   * documented for the MCP and absent from the form, so the browser filed
   * refunds as income — a route-by-route comparison saw a tool and a page on
   * the same route and reported parity.
   *
   * The direction is the one the rule cares about: every field a TOOL writes
   * has to be reachable from the form that writes the same record. The other
   * way round is the browser holding something an agent cannot, and the one
   * field that does it is argued in `AGENTS.md`: `ifUnchosen`, which the
   * preferences route accepts and no tool declares, because it carries a guess
   * from a browser's locale and an agent has no locale to be tentative about.
   * Nothing here checks that direction, so a second such field needs the same
   * kind of argument written beside it; this comment used to say the route
   * would refuse one, which `ifUnchosen` itself disproves.
   */
  type WrittenForm = {
    /** What the reader calls this form. */
    readonly what: string;
    readonly tool: string;
    /**
     * Where in the published schema the fields are. Left out, it is `input`
     * where the tool declares one — an update keeps the record's fields there
     * and its id beside them, and the route takes them as its whole body — and
     * the top level otherwise. A mass edit names `patch`, because reading the
     * top level there would compare `selection` and `dryRun` and call it a
     * match.
     */
    readonly at?: readonly string[];
    /**
     * A panel that declares the fields it offers as a named list, and the file
     * that owns it, repository-relative. Left out, the form is whatever
     * `src/client` sends the tool's own route, found by the route.
     */
    readonly file?: string;
    readonly writes?: string;
    /**
     * Fields the form deliberately does not offer, each with the sentence it
     * has to be arguable in, exactly as `unoffered` works for a filter above.
     */
    readonly unoffered: Readonly<Record<string, string>>;
  };

  /**
   * How a call is addressed and made safe to retry, rather than anything it
   * writes. The browser puts a record's id in the path, and mints a key only
   * where one is required — an update carries an expected version instead.
   */
  const ADDRESSING = new Set(["id", "idempotencyKey"]);

  /**
   * `mcp.md` §The agent surface never runs ahead of the browser argues this
   * once for every bulk tool, so it is written once here.
   */
  const DRY_RUN =
    "The browser holds the rows it is about to write, or previews a filtered set with the selection route, and shows the count before it writes. The rehearsal exists for a caller with no screen to show one on.";

  /**
   * The forms that need saying something about. Every other write tool is
   * compared without an entry, against what `src/client` sends its route.
   */
  const WRITTEN_FORMS: readonly WrittenForm[] = [
    {
      what: "the register's mass edit",
      tool: "bulk_edit_transactions",
      at: ["patch"],
      file: "src/client/bulk-edit.tsx",
      writes: "bulkEditFields",
      unoffered: {},
    },
    {
      what: "the staged queue's mass edit",
      tool: "bulk_edit_staged_transactions",
      at: ["patch"],
      file: "src/client/bulk-edit.tsx",
      writes: "bulkEditFields",
      unoffered: {},
    },
    {
      what: "the template mass edit",
      tool: "bulk_edit_transaction_templates",
      at: ["patch"],
      file: "src/client/pages/TemplatesPage.tsx",
      writes: "BULK_FIELDS",
      unoffered: {
        date: "Left out of the panel on purpose: a template's date is a prefill stored as typed and never moved on, which the tool's own description warns quietly backdates every entry made from it, and one date across a selection multiplies that. The tool still offers it, so the two surfaces disagree, and that is recorded in docs/acceptance.md rather than resolved here: taking it from the tool would narrow a capability, which needs a deprecation first (writing.md §Versioning).",
        destinationAmount:
          "Not offered yet, and the earlier reason for it was false: the panel does hold every account and draft and could offer it when the selection shares one currency pair. An outstanding gap, recorded in docs/acceptance.md.",
        legs: "Left out of the panel on purpose, as one division of money across many templates is the mirror of flattening a split into one category in bulk. The tool still offers it; the disagreement is recorded in docs/acceptance.md for the reason the date's entry gives.",
        categoryName:
          "Not offered yet. The patch stores a name as typed and creates nothing — a category is made only when an entry is — so the earlier reason, that offering it would create one, was false. The panel picks from the categories it has loaded and has no free-text option; an outstanding gap, recorded in docs/acceptance.md.",
      },
    },
    {
      what: "the template mass edit's request",
      tool: "bulk_edit_transaction_templates",
      unoffered: { dryRun: DRY_RUN },
    },
    {
      what: "deleting templates in bulk",
      tool: "bulk_delete_transaction_templates",
      unoffered: { dryRun: DRY_RUN },
    },
    {
      what: "deleting staged rows",
      tool: "delete_staged_transactions",
      unoffered: { dryRun: DRY_RUN },
    },
    {
      what: "staging an entry by hand",
      tool: "create_staged_transaction",
      unoffered: {
        rawData:
          "The row an agent read its proposal from. A person entering one has no other row it came from; what was missing was showing it, and the staged row's form now shows it as it arrived.",
      },
    },
    {
      what: "editing a standing budget",
      tool: "update_budget_plan",
      unoffered: {
        activeFrom:
          "A carry is folded at read time rather than stored, so moving a plan's start date re-folds every period it has ever reported. The dialog adjusts a budget that is running; a budget that starts somewhere else is a different budget, made new.",
        targetAmount:
          "Setting or clearing it changes what kind of budget the plan is, which the dialog does not do and should not. Retuning it within a sinking fund keeps the kind, and the service accepts that in place; the dialog has no control for it yet. An outstanding gap, recorded in docs/acceptance.md.",
        targetDate:
          "The other half of the sinking fund, on the same terms: setting or clearing it changes the kind, retuning it does not, and the dialog has no control for retuning it yet. Recorded in docs/acceptance.md.",
        lookbackPeriods:
          "Setting or clearing it changes the plan's kind; changing a lookback from three periods to six does not, and the dialog has no control for it — it offers the plan's amount, which a trailing average works out for itself. Recorded in docs/acceptance.md.",
        percentOfPrevious:
          "The same for an incremental plan: the step is retunable in place by the service and not by the dialog yet. Recorded in docs/acceptance.md.",
        percentOfIncome:
          "And the same for a percent-of-income plan: the share is retunable in place by the service and not by the dialog yet. Recorded in docs/acceptance.md.",
      },
    },
  ];

  /**
   * Write tools with nothing to compare, each with the reason. A population
   * member the rule excuses, so it is named and argued rather than simply
   * missing (`testing.md` 2.6).
   */
  const NOT_COMPARED: Readonly<Record<string, string>> = {
    revoke_connected_agent:
      "Its one field, clientId, names which agent, and the browser puts that in the path as it puts every record's id there. Settings sends the route an empty body, so there is no field on either side to compare.",
  };

  /**
   * Every field `src/client` sends a route, read off each call to it, and how
   * many calls there were.
   *
   * Found by the route rather than named, so a write tool needs no entry to be
   * compared: its route is the one `COVERED_BY` gives it, and every call to
   * that path with that method is a form that writes it. Unioned across the
   * calls, because the rule is that a field is offered somewhere —
   * `set_preferences` is written by Settings, by the theme switch and by a
   * first visit's guess, and each sends a different part of it.
   */
  function sentTo(files: readonly SourceFile[], route: string) {
    const method = route.slice(0, route.indexOf(" "));
    const pattern = new RegExp(routePathPattern(route.slice(route.indexOf(" ") + 1)).source, "g");
    const fields = new Set<string>();
    let calls = 0;
    for (const file of files) {
      for (const match of file.code.matchAll(pattern)) {
        const { open, end } = enclosingCall(file.code, match.index);
        const call = file.code.slice(open, end + 1);
        const body = requestBody(file, open, call);
        const sends = /method:\s*"([A-Z]+)"/.exec(call)?.[1] ?? (body ? "POST" : "GET");
        if (sends !== method) continue;
        calls += 1;
        for (const field of body ?? []) fields.add(field);
      }
    }
    return { calls, fields };
  }

  /**
   * What one call sends: the argument of the `json(…)` it makes, or of the
   * one that built a request it is handed by name — the import and the staged
   * commit each build one request for a plain call and a streamed one.
   */
  function requestBody(file: SourceFile, open: number, call: string): Set<string> | undefined {
    const direct = call.indexOf("json(");
    if (direct !== -1) return argumentFields(file, open + direct + "json(".length);
    const named = /,\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(call)?.[1];
    if (!named) return undefined;
    const built = [...file.code.matchAll(new RegExp(`\\bconst ${named}\\s*=\\s*json\\(`, "g"))]
      .filter((match) => match.index < open)
      .at(-1);
    return built ? argumentFields(file, built.index + built[0].length) : undefined;
  }

  /**
   * The fields of the argument starting at `index`: a literal read where it
   * stands, or a name read where it is bound.
   *
   * A name is bound either by a `const` holding a literal, or as the
   * variables of the mutation whose `mutationFn` takes it — which are read at
   * every `.mutate({…})` that supplies them, because that is where the
   * register's bulk delete writes its request. Whichever binding is nearer the
   * use is the one in scope: the staged queue's mass edit takes `request` as a
   * parameter a hundred lines below a `const request` that belongs to the
   * commit.
   */
  function argumentFields(file: SourceFile, index: number): Set<string> | undefined {
    const rest = file.code.slice(index);
    const literal = /^\s*[{[]/.exec(rest);
    if (literal) return literalFields(file, index + literal[0].length - 1, new Set());
    const name = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(rest)?.[1];
    if (!name) return undefined;
    const before = file.code.slice(0, index);
    const nearest = (pattern: RegExp) => [...before.matchAll(pattern)].at(-1)?.index ?? -1;
    const declared = nearest(new RegExp(`\\bconst ${name}\\b`, "g"));
    const parameter = nearest(new RegExp(`\\(\\s*${name}\\s*(?::[^()]*)?\\)\\s*=>`, "g"));
    if (declared > parameter) {
      const start = literalNamed(file, name, index);
      return start === undefined ? undefined : literalFields(file, start, new Set());
    }
    const mutation = [...before.matchAll(/\bconst (\w+)\s*=\s*useMutation\b/g)].at(-1)?.[1];
    if (parameter === -1 || !mutation) return undefined;
    const fields = new Set<string>();
    for (const call of file.code.matchAll(
      new RegExp(`\\b${mutation}\\.mutate(?:Async)?\\(\\s*\\{`, "g"),
    )) {
      for (const field of literalFields(file, call.index + call[0].length - 1, new Set())) {
        fields.add(field);
      }
    }
    return fields;
  }

  /**
   * Which tools this compares: every tool that writes, found over a real
   * connection by the annotation each declares about itself.
   *
   * **What the old check could not see:** it compared the seven tools a list
   * named — three mass edits, the import and three budget forms — and the
   * other thirty-three write tools against nothing, and a write tool added
   * tomorrow would have joined them without a word. A list of what to compare
   * is a claim about what exists, made once (`testing.md` 2.6). The population
   * is the tool list now, each member is compared against what the browser
   * sends the route `COVERED_BY` gives it, and the only list left is of the
   * tools that are not compared, each with its reason.
   *
   * One level deep, as it always was: `draft`, `shape` and `selection` are
   * compared as fields a form sends, not opened. What a staged draft carries
   * is `tests/staged-draft-contract.test.ts`'s to hold.
   */
  it("offers somewhere in the browser every field a tool writes", async () => {
    const tools = await toolsWithAnnotations(everyScope);
    const client = sourceFiles("src/client");
    const files = new Map(client.map((file) => [file.path, file]));
    const writing = tools.filter((tool) => tool.annotations?.readOnlyHint !== true);
    // The population before anything is claimed about it: an annotation this
    // stopped reading would leave the loop below comparing nothing at all.
    expect(writing.map((tool) => tool.name)).toContain("create_transaction");
    expect(writing.length).toBeGreaterThanOrEqual(30);

    const routesOf = (tool: string) =>
      Object.keys(COVERED_BY).filter((route) => COVERED_BY[route] === tool);
    const forms: WrittenForm[] = [
      ...WRITTEN_FORMS,
      ...writing
        .filter((tool) => !(tool.name in NOT_COMPARED))
        .filter((tool) => !WRITTEN_FORMS.some((form) => form.tool === tool.name && !form.writes))
        .map((tool) => ({
          what: `what src/client sends ${routesOf(tool.name).join(" or ") || "its route"}`,
          tool: tool.name,
          unoffered: {},
        })),
    ];

    const unreachable: string[] = [];
    let compared = 0;
    for (const form of forms) {
      const tool = tools.find((entry) => entry.name === form.tool);
      if (!tool) throw new Error(`${form.tool} is not registered; ${form.what} needs a new entry`);
      let node = tool.inputSchema as Record<string, unknown> | undefined;
      const top = (node?.["properties"] ?? {}) as Record<string, unknown>;
      const at = form.at ?? ("input" in top ? ["input"] : []);
      for (const step of at) {
        const properties = node?.["properties"] as Record<string, unknown> | undefined;
        node = properties?.[step] as Record<string, unknown> | undefined;
      }
      const declares = Object.keys((node?.["properties"] ?? {}) as Record<string, unknown>).filter(
        (field) => !ADDRESSING.has(field),
      );
      // A path that stopped resolving would compare against an empty object and
      // report every form compliant, which is the way this whole family of
      // checks fails.
      expect(
        declares.length,
        `${form.tool} declares nothing at ${at.join(".") || "the top"}`,
      ).toBeGreaterThan(0);

      let offered: Set<string>;
      if (form.writes !== undefined) {
        const file = form.file === undefined ? undefined : files.get(form.file);
        if (!file) throw new Error(`${form.file} has moved; ${form.what} needs a new entry here`);
        offered = requestFields(file, form.writes);
      } else {
        const routes = routesOf(form.tool);
        const sent = routes.map((route) => sentTo(client, route));
        if (sent.every((one) => one.calls === 0)) {
          unreachable.push(
            `${form.tool} writes through ${routes.join(" and ") || "no route COVERED_BY names"}, and nothing in src/client sends it there`,
          );
          continue;
        }
        offered = new Set(sent.flatMap((one) => [...one.fields]));
      }
      for (const field of declares) {
        compared += 1;
        if (offered.has(field) || field in form.unoffered) continue;
        unreachable.push(
          `${form.tool} writes ${field}, and ${form.what} never sends it: give it a control, or name it in unoffered with the reason`,
        );
      }
    }

    expect(unreachable).toEqual([]);
    // Under today's 166, so a field retired on purpose fails nowhere but in
    // the form that stopped sending it.
    expect(compared).toBeGreaterThanOrEqual(150);
  });

  /**
   * The registers' own policing. An entry names a tool that writes, so a tool
   * renamed or made read-only cannot leave an entry comparing nothing; a tool
   * excused from comparison is not also compared; and every excuse is long
   * enough to be one, exactly as the route exceptions are held.
   */
  it("names only write tools, and gives every tool it does not compare a reason", async () => {
    const writing = new Set(
      (await toolsWithAnnotations(everyScope))
        .filter((tool) => tool.annotations?.readOnlyHint !== true)
        .map((tool) => tool.name),
    );
    for (const form of WRITTEN_FORMS) {
      expect(writing.has(form.tool), `${form.tool} is not a registered write tool`).toBe(true);
    }
    for (const [tool, reason] of Object.entries(NOT_COMPARED)) {
      expect(writing.has(tool), `${tool} is not a registered write tool`).toBe(true);
      expect(
        WRITTEN_FORMS.some((form) => form.tool === tool),
        `${tool} is both compared and excused`,
      ).toBe(false);
      expect(reason.length, tool).toBeGreaterThan(40);
    }
  });

  it("gives every field a form does not offer a reason", () => {
    for (const form of WRITTEN_FORMS) {
      for (const [field, reason] of Object.entries(form.unoffered)) {
        expect(reason.length, `${form.tool} ${field}`).toBeGreaterThan(40);
      }
    }
  });
});

/**
 * `stage_csv`'s mapping, one level down. The comparison above sees `mapping` as
 * one field the import page sends, so a column only an agent could map was
 * invisible to it — the bank reference was exactly that until 0.2.1: guessed
 * from four headings, sent, and never offered, so a person could neither pick
 * another column nor undo a wrong guess.
 */
describe("the import mapping, column by column", () => {
  it("offers every column the schema accepts", async () => {
    const page = await readFile(
      new URL("../src/client/pages/ImportPage.tsx", import.meta.url),
      "utf8",
    );
    const columns = Object.keys(csvMappingSchema.shape);
    expect(columns.length).toBeGreaterThan(5);
    expect(columns.filter((column) => !page.includes(`value={mapping.${column}}`))).toEqual([]);
  });
});
