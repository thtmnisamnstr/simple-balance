import { google } from "better-auth/social-providers";
import { describe, expect, it } from "vitest";
import { googleProviderOptions } from "../src/server/auth.js";

/**
 * The 0.2.0 sandbox smoke test read `email profile openid openid email profile`
 * off the authorization URL: Better Auth's defaults and the list naming them
 * again. Built through the real provider, so a Better Auth upgrade that changes
 * how the two are merged is caught here rather than on Google's consent screen.
 */
describe("the scopes Google is asked for", () => {
  it("names each one once", async () => {
    const provider = google(googleProviderOptions("client-id", "client-secret"));
    const url = await provider.createAuthorizationURL({
      state: "state",
      codeVerifier: "a".repeat(43),
      redirectURI: "https://balance.example.com/api/auth/callback/google",
    });
    const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);

    expect([...scopes].sort()).toEqual(["email", "openid", "profile"]);
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });
});
