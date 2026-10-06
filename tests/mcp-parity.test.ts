import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renamedRoutes } from "./support/routes.js";
import { createMcpServer } from "../src/server/mcp.js";
import { listQuerySchema, stageListQuerySchema } from "../src/shared/domain.js";
import { sourceFiles, topLevelDeclarations, type SourceFile } from "./support/source.js";
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
    // Back to the `(` that opens the call holding this URL, then forward to the
    // `)` that closes it, skipping over strings and template holes both ways
    // is not needed backwards: the URL is the call's first argument.
    const open = client.lastIndexOf("(", match.index);
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

async function clientSource() {
  const root = new URL("../src/client/", import.meta.url);
  const walk = async (directory: URL): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push(...(await walk(new URL(`${entry.name}/`, directory))));
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(await readFile(new URL(entry.name, directory), "utf8"));
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
      const path = route.slice(route.indexOf(" ") + 1);
      // The whole path, with each parameter standing in for a template hole.
      // This asked whether the prefix before the first parameter appeared
      // anywhere in the client, which is true of `/api/v1/accounts` the moment
      // anything fetches an account — so every parameterized sub-route was
      // unchecked, and a page could stop calling one without this noticing.
      const pattern = new RegExp(
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
  function requestFields(file: SourceFile, name: string, seen = new Set<string>()): Set<string> {
    if (seen.has(name)) return new Set();
    seen.add(name);
    const opener = new RegExp(`\\bconst ${name}\\b[^=\\n]*=[^={[\\n]*([{[])`).exec(file.code);
    if (!opener) throw new Error(`${file.path} has no literal named ${name}`);

    /** The balanced region that opens at `from`, which is a `{` or a `[`. */
    const balanced = (from: number) => {
      let depth = 1;
      let end = from + 1;
      while (end < file.code.length && depth > 0) {
        const character = file.code[end]!;
        if ("{[(".includes(character)) depth += 1;
        else if ("}])".includes(character)) depth -= 1;
        end += 1;
      }
      return file.code.slice(from + 1, end - 1);
    };

    const start = opener.index + opener[0].length - 1;
    let open = opener[1]!;
    let body = balanced(start);
    const request = body.indexOf("json(");
    if (request !== -1) {
      const argument = body.indexOf("{", request);
      if (argument === -1) throw new Error(`${file.path}: ${name} calls json() on no object`);
      // `balanced` indexes the whole file, so the offset has to be the one the
      // body was cut from rather than the one inside it.
      body = balanced(start + 1 + argument);
      open = "{";
    }

    const fields = new Set<string>();
    const take = (chunk: string) => {
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
        for (const field of requestFields(file, spread[1]!, seen)) fields.add(field);
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
        take(body.slice(from, index));
        from = index + 1;
      }
    }
    take(body.slice(from));
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
     * Where in the published schema the fields are. Empty is the top level; a
     * mass edit keeps them under `patch`, and reading the top level there would
     * compare `selection` and `dryRun` and call it a match.
     */
    readonly at: readonly string[];
    /** The file that owns the form, repository-relative. */
    readonly file: string;
    /** The named request object, or field list, the form writes through. */
    readonly writes: string;
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
      what: "the import",
      tool: "stage_csv",
      at: [],
      file: "src/client/pages/ImportPage.tsx",
      writes: "request",
      unoffered: {},
    },
    {
      what: "the template mass edit",
      tool: "bulk_edit_transaction_templates",
      at: ["patch"],
      file: "src/client/pages/TemplatesPage.tsx",
      writes: "BULK_FIELDS",
      unoffered: {
        date: "A template's date is a prefill stored as typed and never moved on, which the tool's own description warns quietly backdates every entry made from it months later. One date across a selection is that mistake multiplied by the size of the selection, so it stays a decision made one template at a time.",
        destinationAmount:
          "Read only on a cross-currency transfer, where it is the figure arriving in the other currency. A selection can hold several destination currencies, so one value would be right for at most one row, and the panel cannot tell which rows are cross-currency without reading both accounts of each.",
        legs: "A split. Setting one division of money across many templates is the mirror of flattening a split into one category in bulk, which AGENTS.md forbids on transactions for the same reason: the division is per row, and no single value stands for all of them.",
        categoryName:
          "Naming a category that may not exist creates one, which is a change to the ledger's own records and needs ledger:write wherever it is reached from. This panel picks from the categories it has already loaded; a new one is made where the form can ask which kind it is.",
      },
    },
    {
      what: "a period's budget override",
      tool: "set_budget_entry",
      at: [],
      file: "src/client/pages/BudgetsPage.tsx",
      writes: "setEntry",
      unoffered: {},
    },
    {
      what: "setting a standing budget",
      tool: "create_budget_plan",
      at: [],
      file: "src/client/pages/BudgetsPage.tsx",
      writes: "createPlan",
      unoffered: {},
    },
    {
      what: "editing a standing budget",
      tool: "update_budget_plan",
      at: [],
      file: "src/client/pages/BudgetsPage.tsx",
      writes: "editPlan",
      unoffered: {
        activeFrom:
          "A carry is folded at read time rather than stored, so moving a plan's start date re-folds every period it has ever reported. The dialog adjusts a budget that is running; a budget that starts somewhere else is a different budget, made new.",
        targetAmount:
          "`amount_rule` is derived from the row rather than asked for, so this field IS the choice of a sinking fund. Setting it here would change what kind of budget the plan is from a dialog whose other controls assume it has not changed — the dialog instead says what the rule works out and offers no amount.",
        targetDate:
          "The other half of the sinking fund, and the same argument: the pair is what makes the plan one, so editing either through this dialog would change the plan's kind rather than its figures.",
        lookbackPeriods:
          "The parameter is the choice for a trailing average, so this is the plan's kind again rather than a figure on it. The dialog reports what such a plan works out instead of offering a number to type.",
        percentOfPrevious:
          "The same for an incremental plan: the percentage is what makes it incremental, so changing it here would change the kind of budget rather than its amount.",
        percentOfIncome:
          "And the same for a percent-of-income plan, whose sentence in the dialog says there is nothing here to type precisely because the parameter is the method.",
      },
    },
  ];

  it("offers somewhere in the browser every field a tool writes", async () => {
    const tools = await toolsWithAnnotations(everyScope);
    const files = new Map(sourceFiles("src/client").map((file) => [file.path, file]));

    const unreachable: string[] = [];
    let compared = 0;
    for (const form of WRITTEN_FORMS) {
      const tool = tools.find((entry) => entry.name === form.tool);
      if (!tool) throw new Error(`${form.tool} is not registered; ${form.what} needs a new entry`);
      let node = tool.inputSchema as Record<string, unknown> | undefined;
      for (const step of form.at) {
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
        `${form.tool} declares nothing at ${form.at.join(".") || "the top"}`,
      ).toBeGreaterThan(3);

      const file = files.get(form.file);
      if (!file) throw new Error(`${form.file} has moved; ${form.what} needs a new entry here`);
      const offered = requestFields(file, form.writes);
      for (const field of declares) {
        compared += 1;
        if (offered.has(field) || field in form.unoffered) continue;
        unreachable.push(
          `${form.tool} writes ${field}, and ${form.what} never sends it: give it a control, or name it in unoffered with the reason`,
        );
      }
    }

    expect(unreachable).toEqual([]);
    expect(compared).toBeGreaterThanOrEqual(20);
  });

  it("gives every field a form does not offer a reason", () => {
    for (const form of WRITTEN_FORMS) {
      for (const [field, reason] of Object.entries(form.unoffered)) {
        expect(reason.length, `${form.tool} ${field}`).toBeGreaterThan(40);
      }
    }
  });
});
