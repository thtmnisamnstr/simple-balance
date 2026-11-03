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
  /**
   * All seven, on every path — the same answer 0.1.5 gave.
   *
   * Narrowing this to the read tier is a real improvement and is deliberately
   * not made here. The RFC 9728 document is what a client builds its scope
   * request from, so narrowing it means anybody who re-authorizes after
   * upgrading comes back read-only, and regains write only if their client
   * implements the RFC 6750 step-up. The MCP SDK does. A client written by hand
   * or against an older SDK may not, and would lose the ability to write with
   * nothing on screen saying why.
   *
   * This test is therefore the guard on an upgrade rather than on a preference:
   * it fails if somebody narrows the advertisement without a release that can
   * carry the change.
   */
  it("advertises every tier it accepts, on every path it answers on", async () => {
    for (const path of resourcePaths) {
      const scopes = (await document(path)).scopes_supported;
      expect(scopes, path).toEqual([
        "openid",
        "profile",
        "email",
        "offline_access",
        "ledger:read",
        "ledger:stage",
        "ledger:write",
      ]);
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

  /**
   * The half of the narrowing that did land, and costs nobody anything: a
   * client that asks for less than it needs is told which tier to come back
   * with, rather than being told the tool does not exist.
   */
  it("gives a client that asked for too little a way back up", () => {
    const source = readFileSync(new URL("../src/server/mcp.ts", import.meta.url), "utf8");
    expect(source).toContain("insufficient_scope");
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

/**
 * Registration makes every client public — `boundedRegistration` forces
 * `token_endpoint_auth_method` to `none` whatever was asked — so discovery says
 * that and nothing else. It advertised the two secret-based methods as well,
 * inviting a client to register as confidential and be told it was not, and
 * whether ChatGPT accepts that override is unconfirmed. Better Auth's own copy
 * under `/api/auth` is held too, because it answered with the library's three.
 */
describe("how a client may authenticate at the token endpoint", () => {
  it("is public, and only public, in every authorization-server document", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/oauth-authorization-server/mcp/",
      "/.well-known/openid-configuration",
      "/api/auth/.well-known/oauth-authorization-server",
    ]) {
      const metadata = (await document(path)) as Record<string, unknown>;
      expect(metadata.token_endpoint_auth_methods_supported, path).toEqual(["none"]);
      expect(metadata.scopes_supported, path).toContain("ledger:write");
      expect(metadata, path).not.toHaveProperty("userinfo_endpoint");
    }
  });
});

/**
 * The first answer a client gets, before it has a token.
 *
 * A client that takes its scopes from the challenge rather than from discovery
 * — Docker's gateway reads nothing else — got only `resource_metadata` and so
 * fell back to Better Auth's default grant: read tools, and no refresh token.
 */
describe("the challenge an unauthenticated /mcp request is answered with", () => {
  it("names the resource metadata and every scope the resource document lists", async () => {
    const response = await app.request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toBe(
      `Bearer resource_metadata="${getConfig().baseUrl}/api/auth/.well-known/oauth-protected-resource", ` +
        'scope="openid profile email offline_access ledger:read ledger:stage ledger:write"',
    );
    const advertised = (await document("/api/auth/.well-known/oauth-protected-resource"))
      .scopes_supported as string[];
    expect(/scope="([^"]*)"/.exec(challenge ?? "")?.[1]?.split(" ")).toEqual(advertised);
    // The body repeats it for a client that cannot read the header.
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error["www-authenticate"]).toBe(challenge);
  });
});
