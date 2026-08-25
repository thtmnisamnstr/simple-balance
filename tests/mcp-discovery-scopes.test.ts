import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import app from "../src/server/api.js";
import { getConfig } from "../src/server/config.js";

/**
 * The two discovery documents answer two different questions, so they publish
 * two different scope lists.
 *
 * RFC 8414's `scopes_supported` is what the authorization server accepts. RFC
 * 9728's is what a client builds its scope request from: the MCP SDK joins it
 * verbatim and prefers it to the client's own configured scope, so every scope
 * named there is one every fresh connection will ask a person to approve. The
 * security document's Common Mistakes list names publishing all of them as a
 * mistake by hand, and it is the resource document it is about.
 *
 * These run without a database because discovery does: the metadata is built
 * from configuration and the request, which is also why a client can read it
 * before it has a token.
 */
const origin = new URL(getConfig().baseUrl).origin;

const document = async (path: string) => {
  const response = await app.request(`${origin}${path}`);
  expect(response.status, path).toBe(200);
  return (await response.json()) as { scopes_supported?: unknown };
};

/**
 * Every path a client can arrive at the protected-resource document by.
 *
 * The last one is Better Auth's own, and it is the one that matters most:
 * `withMcpAuth`'s 401 challenge names it as `resource_metadata`, so it is what
 * a first contact reads. Narrowing only the RFC 9728 paths would have corrected
 * the document nobody follows.
 */
const resourcePaths = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource/mcp/",
  "/api/auth/.well-known/oauth-protected-resource",
];

describe("what a client is told to ask for", () => {
  it("advertises the default grant to the resource, on every path it answers on", async () => {
    for (const path of resourcePaths) {
      const scopes = (await document(path)).scopes_supported;
      expect(scopes, path).toEqual(["openid", "profile", "email", "offline_access", "ledger:read"]);
    }
  });

  /**
   * `offline_access` earns its place: Better Auth issues a refresh token only
   * when it was asked for, so dropping it from the advertisement would leave a
   * long-lived client re-authorizing by hand.
   */
  it("keeps the refresh a long-lived connection needs", async () => {
    for (const path of resourcePaths) {
      expect((await document(path)).scopes_supported, path).toContain("offline_access");
    }
  });

  it("names neither of the wider tiers where a client would copy them", async () => {
    for (const path of resourcePaths) {
      const scopes = (await document(path)).scopes_supported as string[];
      expect(scopes, path).not.toContain("ledger:stage");
      expect(scopes, path).not.toContain("ledger:write");
    }
  });
});

describe("what the authorization server says it supports", () => {
  it("still names all three ledger tiers", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
    ]) {
      const scopes = (await document(path)).scopes_supported as string[];
      for (const scope of ["ledger:read", "ledger:stage", "ledger:write"]) {
        expect(scopes, `${path} ${scope}`).toContain(scope);
      }
    }
  });

  /**
   * The accept-list at `/authorize`, which no document reports.
   *
   * Better Auth checks the session before it checks the scope, so an
   * unauthenticated authorization redirects to the sign-in page whether or not
   * `ledger:write` is still accepted — the obvious end-to-end assertion passes
   * with the tier struck out, which is the regression it was meant to catch.
   * The source is the only place the answer is visible. If that array ever
   * loses a tier, an authorization naming it comes back `invalid_scope`, and
   * the `insufficient_scope` challenge that makes the narrowing above safe
   * would be pointing a client somewhere it cannot go.
   */
  it("still accepts the tiers the step-up challenge asks a client to request", () => {
    const source = readFileSync(new URL("../src/server/auth.ts", import.meta.url), "utf8");
    const declared = /const supportedScopes = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect(declared).toContain('"ledger:stage"');
    expect(declared).toContain('"ledger:write"');
    expect(source).toContain("scopes: supportedScopes,");
  });

  // The resource document is a smaller first ask, not a different vocabulary: a
  // scope a client is told to request that the server does not accept would
  // fail the authorization outright.
  it("accepts everything the resource document tells a client to ask for", async () => {
    const resource = (await document("/.well-known/oauth-protected-resource"))
      .scopes_supported as string[];
    const server = (await document("/.well-known/oauth-authorization-server"))
      .scopes_supported as string[];
    for (const scope of resource) {
      expect(server, scope).toContain(scope);
    }
  });
});
