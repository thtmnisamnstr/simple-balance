import { describe, expect, it } from "vitest";
import app from "../src/server/api.js";
import { getConfig } from "../src/server/config.js";
import {
  API_REQUEST_BODY_LIMIT_BYTES,
  AUTH_REQUEST_BODY_LIMIT_BYTES,
  requestBodyLimit,
} from "../src/server/http-security.js";

const applicationOrigin = new URL(getConfig().baseUrl).origin;

describe("API transport security wiring", () => {
  it("rejects a cross-origin finance mutation before session lookup", async () => {
    const response = await app.request(`${applicationOrigin}/api/v1/preferences`, {
      method: "PUT",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "CROSS_ORIGIN_REQUEST" },
    });
  });

  it("rejects a cross-origin auth mutation before Better Auth", async () => {
    const response = await app.request(`${applicationOrigin}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=untrusted",
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  // Revoking an agent is a DELETE with nothing to say, which is exactly the
  // shape that fell through the gap: /api/v1 demands a JSON content type on
  // anything that changes state, so a fetch that sent no body at all was
  // refused with a 415 the browser never surfaced. Both halves are pinned here
  // because the requirement is deliberate and the client has to satisfy it.
  it("refuses a state-changing request that names no content type", async () => {
    const response = await app.request(
      `${applicationOrigin}/api/v1/connected-apps/some-client`,
      {
        method: "DELETE",
        headers: {
          cookie: "better-auth.session_token=untrusted",
          origin: applicationOrigin,
        },
      },
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
  });

  it("lets a bodyless revoke through the media type gate to authentication", async () => {
    const response = await app.request(
      `${applicationOrigin}/api/v1/connected-apps/some-client`,
      {
        method: "DELETE",
        headers: {
          cookie: "better-auth.session_token=untrusted",
          origin: applicationOrigin,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(response.status).not.toBe(415);
    expect(response.status).toBe(401);
  });

  it("rejects an oversized auth body before Better Auth parses it", async () => {
    const response = await app.request(
      `${applicationOrigin}/api/auth/sign-in/email`,
      {
        method: "POST",
        headers: {
          origin: applicationOrigin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "owner@example.com",
          password: "x".repeat(AUTH_REQUEST_BODY_LIMIT_BYTES),
        }),
      },
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("rejects an unauthenticated finance body before granting the upload allowance", async () => {
    const response = await app.request(
      `${applicationOrigin}/api/v1/preferences`,
      {
        method: "PUT",
        headers: {
          cookie: "better-auth.session_token=untrusted",
          origin: applicationOrigin,
          "content-type": "application/json",
          "content-length": String(API_REQUEST_BODY_LIMIT_BYTES + 1),
        },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
    expect(response.headers.get("connection")).toBe("close");
  });

  it("rejects an unauthenticated MCP body before granting the CSV allowance", async () => {
    const response = await app.request(`${applicationOrigin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(requestBodyLimit("/mcp") + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("connection")).toBe("close");
  });
});
