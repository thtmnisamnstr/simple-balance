import { afterEach, describe, expect, it, vi } from "vitest";
import type app from "../src/server/api.js";

/**
 * The file OpenAI's app portal reads before it will scan this MCP server.
 *
 * The portal issues a token and fetches `/.well-known/openai-apps-challenge`
 * from the MCP host, comparing the body with the token byte for byte. A JSON
 * envelope, a trailing newline or the single-page shell would each fail that
 * comparison silently, and the portal would just say the domain is unverified.
 */
describe("the OpenAI apps domain-verification route", () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.resetModules();
  });

  async function freshApp(token: string | undefined) {
    vi.resetModules();
    if (token === undefined) delete process.env.SB_OPENAI_APPS_CHALLENGE;
    else process.env.SB_OPENAI_APPS_CHALLENGE = token;
    const module = (await import("../src/server/api.js")) as { default: typeof app };
    return module.default;
  }

  it("answers with exactly the configured token, as plain text", async () => {
    const server = await freshApp("oai-verify-3f9c2a7d1b");
    const response = await server.request("http://localhost/.well-known/openai-apps-challenge");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("oai-verify-3f9c2a7d1b");
  });

  it("trims the newline an env file or a pasted secret leaves behind", async () => {
    const server = await freshApp("  oai-verify-3f9c2a7d1b\n");
    const response = await server.request("http://localhost/.well-known/openai-apps-challenge");
    expect(await response.text()).toBe("oai-verify-3f9c2a7d1b");
  });

  it.each([
    ["unset", undefined],
    ["blank", "   "],
  ])("answers 404, as every unpublished .well-known path does, while %s", async (_, token) => {
    const server = await freshApp(token);
    const response = await server.request("http://localhost/.well-known/openai-apps-challenge");
    expect(response.status).toBe(404);
    const unpublished = await server.request("http://localhost/.well-known/nothing-here");
    expect(await response.json()).toEqual(await unpublished.json());
  });
});
