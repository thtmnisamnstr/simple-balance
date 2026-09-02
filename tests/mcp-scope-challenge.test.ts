import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../src/server/mcp.js";

/**
 * What an authenticated but under-scoped call gets back.
 *
 * It used to be `MCP error -32602: Tool create_transaction not found`, which is
 * character for character what a misspelled name returns, so an agent could not
 * tell a capability it was never granted from one that does not exist. The
 * answers now differ, and the 403 carries what a client needs to ask for more:
 * `insufficient_scope`, the full scope string to request, and where to find the
 * resource metadata.
 *
 * No database is touched. Every case here is decided before dispatch, or is
 * refused by the tool's own input schema, which the SDK checks before the
 * handler runs.
 */
const actor = { userId: "scope-challenge", source: "mcp" as const, clientId: "challenge" };

const call = (name: string, args: Record<string, unknown> = {}) =>
  new Request("https://books.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

const dispatch = (name: string, scopes: string[], args: Record<string, unknown> = {}) =>
  handleMcpRequest(call(name, args), actor, new Set(scopes));

describe("an under-scoped call", () => {
  it("is a 403 naming the scope that would have worked", async () => {
    const response = await dispatch("create_transaction", ["ledger:read"]);

    expect(response.status).toBe(403);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/error="insufficient_scope"/);
    expect(challenge).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
    expect(response.headers.get("Access-Control-Expose-Headers")).toMatch(/WWW-Authenticate/);
  });

  /**
   * The client SDK replaces its whole scope request with whatever the challenge
   * names, so a challenge carrying `ledger:write` alone would re-authorize with
   * no `openid` and no `offline_access` — no id token and no refresh token. The
   * agent would come back from the step-up worse off than it went in.
   */
  it("asks for the whole scope string, not the missing tier alone", async () => {
    const response = await dispatch("create_transaction", ["ledger:read"]);
    const scope = /scope="([^"]*)"/.exec(response.headers.get("WWW-Authenticate") ?? "")?.[1] ?? "";

    expect(scope.split(" ")).toContain("ledger:write");
    expect(scope.split(" ")).toContain("offline_access");
    expect(scope.split(" ")).toContain("openid");
  });

  it("says something a client with no step-up support can still read", async () => {
    const response = await dispatch("create_transaction", ["ledger:read"]);
    const body = (await response.json()) as { id?: unknown; error?: { message?: string } };

    expect(body.id).toBe(7);
    expect(body.error?.message).toMatch(/ledger:write/);
  });

  it("differs from what a misspelled tool name gets", async () => {
    const challenged = await dispatch("create_transaction", ["ledger:read"]);
    const misspelled = await dispatch("create_transactionn", ["ledger:read"]);

    expect(misspelled.status).toBe(200);
    expect(await misspelled.text()).toMatch(/not found/);
    expect(misspelled.status).not.toBe(challenged.status);
  });
});

describe("a call the grant does reach", () => {
  /**
   * The regression this file exists for. `hasScope` widens only `ledger:read`,
   * so testing the staging tier with it refuses a `ledger:write` token five
   * tools it already holds — and on a client implementing the step-up, the
   * challenge talks it into re-authorizing downward to `ledger:stage`, losing
   * the write scope it arrived with. Reaching dispatch is proved by the tool's
   * own input schema refusing the arguments, which happens after the challenge
   * and before anything touches a database.
   */
  it("is not challenged when a write token calls a staging tool", async () => {
    const response = await dispatch("create_staged_transaction", ["ledger:write"], { draft: 1 });

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/Input validation error/);
  });

  it("is not challenged when a write token calls a write tool", async () => {
    const response = await dispatch("create_transaction", ["ledger:write"], { draft: 1 });

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/Input validation error/);
  });

  it("is not challenged when a stage token calls a read tool", async () => {
    const response = await dispatch("get_transaction", ["ledger:stage"], { id: "not-a-uuid" });

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/Input validation error/);
  });
});

describe("a request carrying no call to inspect", () => {
  it("passes a GET through untouched", async () => {
    const response = await handleMcpRequest(
      new Request("https://books.example/mcp", {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
      actor,
      new Set(["ledger:read"]),
    );

    expect(response.status).not.toBe(403);
  });

  // Rebuilding a bodyless request with an empty body would change what the
  // transport sees, so it is forwarded as it arrived.
  it("passes a POST with no body through untouched", async () => {
    const response = await handleMcpRequest(
      new Request("https://books.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      actor,
      new Set(["ledger:read"]),
    );

    expect(response.status).not.toBe(403);
  });
});
