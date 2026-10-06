import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * `AGENTS.md`: deleting the account, setting a sign-in password and the billing
 * routes "are reachable from a session and never from an MCP token" — a
 * purchase spends somebody's money, and an MCP token is a credential handed to
 * a program.
 *
 * `tests/mcp-parity.test.ts` held this by asserting four tool names were not
 * registered, and none of the four had ever existed, so a fifth spelling —
 * `cancel_subscription`, say — wired straight to the service would have passed
 * it. This reads the transport instead: the MCP module may name none of the
 * functions those routes call. Each is also required to be named by the HTTP
 * module, so a rename fails here rather than quietly emptying the list.
 */
const SESSION_ONLY = [
  "deleteOwnAccount",
  "setPassword",
  "changePassword",
  "getBillingStatus",
  "setSubscription",
  "setSubscriptionCancellation",
  "createPaymentSetup",
  "confirmPaymentSetup",
];

const files = sourceFiles("src/server");
const code = (path: string) => files.find((file) => file.path === path)!.code;

describe("what only a signed-in person can do", () => {
  it("is never named by the MCP transport", () => {
    const mcp = code("src/server/mcp.ts");
    const reached = SESSION_ONLY.filter((name) => new RegExp(`\\b${name}\\b`).test(mcp));
    expect(reached, "a session-only action reachable from an MCP token").toEqual([]);
  });

  it("is still what the HTTP routes call, so the list names real functions", () => {
    const api = code("src/server/api.ts");
    // changePassword is Better Auth's own route, mounted under /api/auth, so the
    // HTTP module names the path rather than the method.
    const missing = SESSION_ONLY.filter((name) => name !== "changePassword").filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(api),
    );
    expect(missing).toEqual([]);
    expect(api).toContain('"/api/auth/change-password"');
  });
});
