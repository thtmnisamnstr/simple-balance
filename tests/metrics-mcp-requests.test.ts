import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcpRequest } from "../src/server/mcp.js";
import { registry, resetMetrics } from "../src/server/metrics.js";

/**
 * What `mcp_requests_total` and `internal_errors_total{surface="mcp"}` say
 * about the MCP endpoint, driven through the function the route calls.
 *
 * The tool counter wraps `registerTool`, so it sees only calls that reached a
 * tool; a call the protocol refused existed nowhere but the reply. These go in
 * the front door — `handleMcpRequest`, with a `Request` shaped the way a client
 * sends one — because the transport seam is the whole claim, and a server
 * connected over the in-memory pair never passes through it.
 *
 * No database is touched, so a tool that reaches one fails. That is the
 * unexpected failure the internal-error counter exists for, which makes it the
 * useful half here; the success path for a tool is the integration tier's.
 */
const actor = { userId: "rpc-metrics", source: "mcp" as const, clientId: "rpc-metrics" };

const post = (body: string, contentType = "application/json") =>
  new Request("https://books.example/mcp", {
    method: "POST",
    headers: { "content-type": contentType, accept: "application/json, text/event-stream" },
    body,
  });

const message = (id: number | undefined, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  ...(id === undefined ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});

const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
  message(id, "tools/call", { name, arguments: args });

const dispatch = (body: unknown, scopes: string[] = ["ledger:read"]) =>
  handleMcpRequest(post(JSON.stringify(body)), actor, new Set(scopes));

/** Every series one counter has published, as `labels → value`. */
async function series(name: string) {
  const metric = (await registry.getMetricsAsJSON()).find((one) => one.name === name);
  const values = (metric?.values ?? []) as { value: number; labels: Record<string, string> }[];
  return Object.fromEntries(
    values
      .filter((entry) => entry.value > 0)
      .map((entry) => [
        Object.entries(entry.labels)
          .filter(([label]) => label !== "component")
          .map(([label, value]) => `${label}=${value}`)
          .join(","),
        entry.value,
      ]),
  );
}

const rpcCounts = () => series("simple_balance_mcp_requests_total");

beforeEach(() => {
  resetMetrics();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMetrics();
});

describe("a JSON-RPC message the endpoint answered", () => {
  it("is counted under its method with the outcome its reply carried", async () => {
    // Initialize alone, because the transport refuses it in a batch.
    expect(
      (
        await dispatch(
          message(1, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "rpc-metrics", version: "1.0.0" },
          }),
        )
      ).status,
    ).toBe(200);
    expect((await dispatch(message(2, "tools/list"))).status).toBe(200);
    expect((await dispatch(message(3, "ping"))).status).toBe(200);

    expect(await rpcCounts()).toEqual({
      "rpc_method=initialize,outcome=ok": 1,
      "rpc_method=tools/list,outcome=ok": 1,
      "rpc_method=ping,outcome=ok": 1,
    });
  });

  /**
   * Each entry of a batch is a message of its own, with a reply of its own, and
   * the outcome is matched to it by id. Counting the request instead would give
   * the batch one outcome when its two replies disagree.
   */
  it("counts each message of a batch by its own reply", async () => {
    const response = await dispatch([
      message(1, "ping"),
      message(2, "resources/list"),
      message(undefined, "notifications/initialized"),
    ]);
    expect(response.status).toBe(200);
    // Two replies for two requests; the notification is answered by nothing.
    expect(((await response.json()) as unknown[]).length).toBe(2);

    expect(await rpcCounts()).toEqual({
      "rpc_method=ping,outcome=ok": 1,
      // This server registers no resources, so the SDK has no handler for it.
      "rpc_method=other,outcome=method_not_found": 1,
      "rpc_method=notification,outcome=ok": 1,
    });
  });

  it("counts a notification sent alone as accepted, by the status it was answered with", async () => {
    const response = await dispatch(message(undefined, "notifications/initialized"));
    expect(response.status).toBe(202);
    expect(await rpcCounts()).toEqual({ "rpc_method=notification,outcome=ok": 1 });
  });
});

describe("a call the protocol refused before any tool ran", () => {
  /**
   * The gap this counter closes, beside the counter that cannot. A misspelled
   * tool and arguments its own schema rejects are both answered by the SDK in
   * the shape a tool's refusal takes, `isError: true` over a 200, and neither
   * reaches the `registerTool` wrapper.
   */
  it("is a tool_error here and absent from the tool counter", async () => {
    await dispatch(call(1, "list_transactions", { limit: -1 }));
    await dispatch(call(2, "list_transactionz"));

    expect(await rpcCounts()).toEqual({ "rpc_method=tools/call,outcome=tool_error": 2 });
    expect(await series("simple_balance_mcp_tool_calls_total")).toEqual({});
  });

  it("is an insufficient_scope for a tool outside the grant, counted from the challenge", async () => {
    const response = await dispatch(call(1, "create_transaction"));
    expect(response.status).toBe(403);
    expect(await rpcCounts()).toEqual({ "rpc_method=tools/call,outcome=insufficient_scope": 1 });
  });

  /**
   * One under-scoped call refuses the whole body, so the ping beside it was
   * answered by the same 403 and reached the server no more than the call did.
   */
  it("counts every message the challenge refused, not only the call that tripped it", async () => {
    const response = await dispatch([message(1, "ping"), call(2, "create_transaction")]);
    expect(response.status).toBe(403);
    expect(await rpcCounts()).toEqual({
      "rpc_method=ping,outcome=insufficient_scope": 1,
      "rpc_method=tools/call,outcome=insufficient_scope": 1,
    });
  });

  /**
   * The code the SDK chose, and it is not always the one a reader would guess.
   * A `tools/call` with no tool name fails the SDK's own request schema before
   * its `-32602` wrapper runs, and comes back `-32603`, so a client's malformed
   * call lands in `error` beside a server fault. Pinned so that changing — in
   * either direction — is somebody's decision rather than a quiet shift in what
   * an alert on `error` means.
   */
  it("takes the JSON-RPC error code the reply carried, by name", async () => {
    await dispatch(message(1, "resources/list"));
    await dispatch(message(2, "tools/call", {}));

    expect(await rpcCounts()).toEqual({
      "rpc_method=other,outcome=method_not_found": 1,
      "rpc_method=tools/call,outcome=error": 1,
    });
  });
});

describe("a body that never became a message", () => {
  it("is counted once, as other, whatever was wrong with it", async () => {
    const notJson = await handleMcpRequest(post("{not json"), actor, new Set(["ledger:read"]));
    const notJsonRpc = await dispatch({ hello: "there" });
    const wrongType = await handleMcpRequest(
      post(JSON.stringify(message(1, "ping")), "text/plain"),
      actor,
      new Set(["ledger:read"]),
    );
    expect([notJson.status, notJsonRpc.status, wrongType.status]).toEqual([400, 400, 415]);

    expect(await rpcCounts()).toEqual({ "rpc_method=other,outcome=invalid_request": 3 });
  });

  it("counts an empty batch not at all, because it held nothing", async () => {
    const response = await dispatch([]);
    // Accepted rather than refused, which is what separates it from the three
    // above: there was no message to count and no refusal to record.
    expect(response.status).toBe(202);
    expect(await rpcCounts()).toEqual({});
  });

  it("is not a POST, and is counted nowhere but the HTTP series", async () => {
    const response = await handleMcpRequest(
      new Request("https://books.example/mcp", {
        method: "GET",
        headers: { accept: "application/json, text/event-stream" },
      }),
      actor,
      new Set(["ledger:read"]),
    );
    expect(response.status).toBe(405);
    expect(await rpcCounts()).toEqual({});
  });
});

describe("a method a client wrote", () => {
  /**
   * The method is the client's string. Copied into the label it is a series
   * per string, and the string can carry anything at all.
   */
  it("is mapped onto the closed set and never appears in a label", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    await dispatch(message(1, `ledger/${id}`));
    // The two buckets are not methods: naming one is naming something this
    // server does not serve, so it lands where any such name does.
    await dispatch(message(2, "notification"));
    await dispatch(message(3, "other"));

    expect(await rpcCounts()).toEqual({ "rpc_method=other,outcome=method_not_found": 3 });
    expect(await registry.metrics()).not.toContain(id);
  });
});

describe("a request that threw", () => {
  it("is counted as an error rather than missing from the series", async () => {
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest").mockRejectedValue(
      new Error("transport fell over"),
    );
    await expect(dispatch(message(1, "ping"))).rejects.toThrow("transport fell over");
    expect(await rpcCounts()).toEqual({ "rpc_method=other,outcome=error": 1 });
  });
});

describe("internal_errors_total for the MCP surface", () => {
  /**
   * Both of these come back `isError: true` over a 200, so neither the tool
   * counter nor the request counter can tell them apart. Only `runTool` knows
   * which one was a bug, and the internal-error counter is the one place it
   * says so.
   */
  it("counts a tool that failed unexpectedly, and not one that refused the caller", async () => {
    // No database in this tier, so `whoami` cannot reach one and throws an
    // error nobody meant.
    const failed = await dispatch(call(1, "whoami"));
    expect(await failed.text()).toContain("INTERNAL_ERROR");
    // A page marker that cannot be read is refused before any query runs, as a
    // validation error the caller can act on.
    const refused = await dispatch(call(2, "list_import_batches", { cursor: "not-a-cursor" }));
    expect(await refused.text()).toContain("VALIDATION_ERROR");

    expect(await series("simple_balance_internal_errors_total")).toEqual({ "surface=mcp": 1 });
    // The two are the same thing at the transport, which is the point.
    expect(await rpcCounts()).toEqual({ "rpc_method=tools/call,outcome=tool_error": 2 });
  });
});
