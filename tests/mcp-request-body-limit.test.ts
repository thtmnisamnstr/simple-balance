import { describe, expect, it } from "vitest";
import { apiRequestBodyLimit } from "../src/server/http-security.js";
import { handleMcpRequest } from "../src/server/mcp.js";

/**
 * What `/mcp` reads, end to end through the function the route calls.
 *
 * The route bounds and buffers a body at `apiRequestBodyLimit("/mcp")`, which
 * is the larger of the CSV and ledger-file limits so a low CSV setting cannot
 * shrink an agent's import below one part. The SDK's transport then reads the
 * same body again with a limit of its own, 4 MiB unless it is told otherwise,
 * and that was the real one: a part the tool schemas accept, sixteen
 * mebibytes of it, was answered with a bare 413 before any tool ran.
 *
 * No database is touched. The ledger file sent here is not a file at all, so
 * each tool refuses it from its own reader — which is the point: a refusal
 * from the tool is the proof the call reached it.
 */
const actor = { userId: "body-limit", source: "mcp" as const, clientId: "body-limit" };
const FOUR_MIB = 4 * 1024 * 1024;

const callWith = (name: string, args: Record<string, unknown>, scopes: string[]) =>
  handleMcpRequest(
    new Request("https://books.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    actor,
    new Set(scopes),
  );

describe("a tools/call body larger than the SDK's own default", () => {
  const large = "x".repeat(FOUR_MIB + 1024);

  it("is within what the route allows /mcp", () => {
    expect(apiRequestBodyLimit("/mcp")).toBeGreaterThan(large.length + 1024);
  });

  for (const [name, scopes, args] of [
    ["preview_ledger_file", ["ledger:read"], { ledgerFile: large }],
    [
      "add_ledger_file",
      ["ledger:write"],
      { ledgerFile: large, fileName: "large.json", idempotencyKey: "body-limit-add" },
    ],
  ] as const) {
    it(`reaches ${name} rather than being refused by the transport`, async () => {
      const response = await callWith(name, args, [...scopes]);
      expect(response.status).toBe(200);
      const reply = (await response.json()) as {
        result?: { isError?: boolean; structuredContent?: unknown };
        error?: unknown;
      };
      expect(reply.error).toBeUndefined();
      // The tool's own reader refused it, with the project's envelope.
      expect(reply.result?.isError).toBe(true);
      expect(JSON.stringify(reply.result?.structuredContent)).toContain("VALIDATION_ERROR");
    });
  }
});
