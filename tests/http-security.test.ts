import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  API_REQUEST_BODY_LIMIT_BYTES,
  AUTH_REQUEST_BODY_LIMIT_BYTES,
  BULK_REQUEST_BODY_LIMIT_BYTES,
  apiRequestBodyLimit,
  boundRequestBody,
  countableClientAddress,
  createAttemptLimiter,
  protectAuthMutation,
  protectBrowserMutation,
  requestBodyLimit,
  withCountableClientAddress,
} from "../src/server/http-security.js";
import {
  MAX_BULK_SELECTION_ENTRIES,
  bulkStageEditSchema,
  bulkTransactionEditSchema,
  commitStageSchema,
} from "../src/shared/domain.js";

const applicationOrigin = "https://balance.example.com";
const originalCsvMaxBytes = process.env.CSV_MAX_BYTES;

afterEach(() => {
  if (originalCsvMaxBytes === undefined) delete process.env.CSV_MAX_BYTES;
  else process.env.CSV_MAX_BYTES = originalCsvMaxBytes;
});

function browserMutationApp() {
  const app = new Hono();
  app.use(
    "*",
    protectBrowserMutation({
      allowedOrigin: applicationOrigin,
      allowedContentTypes: new Set(["application/json"]),
      requireContentType: true,
    }),
  );
  app.get("/", (context) => context.json({ ok: true }));
  app.post("/", (context) => context.json({ ok: true }));
  return app;
}

describe("browser mutation protection", () => {
  it("rejects a cross-origin cookie-authenticated JSON mutation", async () => {
    const response = await browserMutationApp().request(`${applicationOrigin}/`, {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=session",
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

  it("rejects missing origins and non-JSON finance mutations", async () => {
    const missingOrigin = await browserMutationApp().request(`${applicationOrigin}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(missingOrigin.status).toBe(403);

    const simpleRequest = await browserMutationApp().request(`${applicationOrigin}/`, {
      method: "POST",
      headers: {
        origin: applicationOrigin,
        "content-type": "text/plain",
      },
      body: "{}",
    });
    expect(simpleRequest.status).toBe(415);
    expect(await simpleRequest.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });
  });

  it("allows same-origin JSON mutations and safe reads", async () => {
    const mutation = await browserMutationApp().request(`${applicationOrigin}/`, {
      method: "POST",
      headers: {
        origin: applicationOrigin,
        "content-type": "application/json; charset=utf-8",
      },
      body: "{}",
    });
    expect(mutation.status).toBe(200);

    const read = await browserMutationApp().request(`${applicationOrigin}/`);
    expect(read.status).toBe(200);
  });
});

describe("auth mutation protection", () => {
  function authApp() {
    const app = new Hono();
    app.use("*", protectAuthMutation(applicationOrigin));
    app.post("*", (context) => context.json({ ok: true }));
    return app;
  }

  it("keeps non-browser MCP OAuth requests usable", async () => {
    const registration = await authApp().request(`${applicationOrigin}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(registration.status).toBe(200);

    const token = await authApp().request(`${applicationOrigin}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code",
    });
    expect(token.status).toBe(200);
  });

  it("rejects cross-origin cookies even on externally callable MCP routes", async () => {
    const response = await authApp().request(`${applicationOrigin}/api/auth/mcp/token`, {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=session",
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=authorization_code",
    });
    expect(response.status).toBe(403);
  });

  it("protects browser auth mutations while allowing the provider callback", async () => {
    const signOut = await authApp().request(`${applicationOrigin}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=session",
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(signOut.status).toBe(403);

    const callback = await authApp().request(`${applicationOrigin}/api/auth/callback/google`, {
      method: "POST",
      headers: {
        cookie: "better-auth.oauth_state=state",
        origin: "https://accounts.google.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "code=provider-code&state=state",
    });
    expect(callback.status).toBe(200);
  });
});

describe("bounded request bodies", () => {
  function limitedApp(maxBytes: number) {
    const app = new Hono();
    app.use("*", boundRequestBody({ maxBytes }));
    app.post("/", async (context) => context.json({ body: await context.req.text() }));
    return app;
  }

  it("rejects an oversized declared body before parsing", async () => {
    const response = await limitedApp(8).request(`${applicationOrigin}/`, {
      method: "POST",
      headers: {
        "content-length": "9",
        "content-type": "text/plain",
      },
      body: "123456789",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("cancels a streaming body as soon as it exceeds the limit", async () => {
    let cancelled = false;
    let chunk = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(new TextEncoder().encode(chunk === 1 ? "123456" : "789"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(`${applicationOrigin}/`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await limitedApp(8).fetch(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("does not trust Content-Length instead of measuring a streaming body", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.enqueue(new TextEncoder().encode("789"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request(`${applicationOrigin}/`, {
      method: "POST",
      headers: {
        "content-length": "1",
        "content-type": "text/plain",
      },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await limitedApp(8).fetch(request);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it("replays an in-limit streaming body for the route handler", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
        controller.close();
      },
    });
    const request = new Request(`${applicationOrigin}/`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await limitedApp(8).fetch(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: "12345678" });
  });

  it("uses a bounded but larger JSON envelope for CSV routes", () => {
    process.env.CSV_MAX_BYTES = "1024";
    expect(apiRequestBodyLimit("/api/v1/accounts")).toBe(API_REQUEST_BODY_LIMIT_BYTES);
    expect(apiRequestBodyLimit("/api/v1/csv/preview")).toBe(71_680);
    expect(apiRequestBodyLimit("/api/v1/csv/stage")).toBe(71_680);
    expect(apiRequestBodyLimit("/mcp")).toBe(71_680);
    // `/mcp/` is routed to the same endpoint, so it has to be sized the same.
    // It was not, which left a client configured with the trailing slash - the
    // configuration that spelling exists to support - refused a CSV upload the
    // other spelling was allowed.
    expect(apiRequestBodyLimit("/mcp/")).toBe(71_680);
    expect(requestBodyLimit("/mcp/")).toBe(71_680);
  });

  it("lets bulk routes carry an entry for every selectable row", () => {
    process.env.CSV_MAX_BYTES = "1024";
    for (const path of [
      "/api/v1/transactions/bulk-edit",
      "/api/v1/transactions/bulk-delete",
      "/api/v1/transactions/bulk-selection",
      "/api/v1/staged-transactions/commit",
      "/api/v1/staged-transactions/delete",
      "/api/v1/staged-transactions/bulk-edit",
      "/api/v1/staged-transactions/bulk-selection",
    ]) {
      expect(apiRequestBodyLimit(path)).toBe(BULK_REQUEST_BODY_LIMIT_BYTES);
    }
    expect(BULK_REQUEST_BODY_LIMIT_BYTES).toBeGreaterThan(API_REQUEST_BODY_LIMIT_BYTES);
  });

  // The schema cap is the real limit. These build the largest payload each
  // endpoint accepts and prove the transport never rejects it first, so raising
  // MAX_BULK_SELECTION_ENTRIES cannot silently reintroduce the 413.
  it("accepts a maximum staged commit without hitting the body limit", () => {
    const ids = Array.from({ length: MAX_BULK_SELECTION_ENTRIES }, () => randomUUID());
    const body = {
      stagedIds: ids,
      expectedVersions: Object.fromEntries(ids.map((id) => [id, Number.MAX_SAFE_INTEGER])),
      idempotencyKey: "k".repeat(200),
      allowDuplicates: true,
      dryRun: false,
    };
    expect(commitStageSchema.safeParse(body).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      apiRequestBodyLimit("/api/v1/staged-transactions/commit"),
    );
  });

  it("accepts a maximum transaction bulk edit without hitting the body limit", () => {
    const body = {
      selection: {
        mode: "ids" as const,
        items: Array.from({ length: MAX_BULK_SELECTION_ENTRIES }, () => ({
          id: randomUUID(),
          expectedVersion: Number.MAX_SAFE_INTEGER,
        })),
      },
      patch: {
        date: "2026-01-01",
        payee: "p".repeat(160),
        description: "d".repeat(240),
        notes: "n".repeat(4_000),
      },
      idempotencyKey: "k".repeat(200),
      allowDuplicates: true,
      dryRun: false,
    };
    expect(bulkTransactionEditSchema.safeParse(body).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      apiRequestBodyLimit("/api/v1/transactions/bulk-edit"),
    );
  });

  it("accepts a maximum staged bulk edit without hitting the body limit", () => {
    const body = {
      selection: {
        mode: "ids" as const,
        items: Array.from({ length: MAX_BULK_SELECTION_ENTRIES }, () => ({
          id: randomUUID(),
          expectedVersion: Number.MAX_SAFE_INTEGER,
        })),
      },
      patch: {
        date: "2026-01-01",
        payee: "p".repeat(160),
        description: "d".repeat(240),
        notes: "n".repeat(4_000),
      },
      idempotencyKey: "k".repeat(200),
      dryRun: false,
    };
    expect(bulkStageEditSchema.safeParse(body).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      apiRequestBodyLimit("/api/v1/staged-transactions/bulk-edit"),
    );
  });

  it("selects the strict auth limit from the global path-aware policy", () => {
    process.env.CSV_MAX_BYTES = "1024";
    expect(requestBodyLimit("/api/auth/sign-in/email")).toBe(AUTH_REQUEST_BODY_LIMIT_BYTES);
    expect(requestBodyLimit("/mcp")).toBe(71_680);
    expect(requestBodyLimit("/api/v1/accounts")).toBe(API_REQUEST_BODY_LIMIT_BYTES);
  });
});

/**
 * The rate limiter counts sign-up and sign-in attempts per client address, and
 * it learns that address from x-forwarded-for. These cover the two ways that
 * goes wrong when nothing rewrites the header: a caller who supplies one to buy
 * extra attempts, and a caller who supplies none so that everybody shares a
 * bucket.
 */
describe("the address a rate limit is counted against", () => {
  const withPeer = (peer?: string) =>
    ({ env: { incoming: { socket: { remoteAddress: peer } } } }) as never;

  it("replaces a caller's own x-forwarded-for with the connection's address", async () => {
    const request = new Request("https://balance.example.com/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.7",
      },
      body: JSON.stringify({ email: "someone@example.com" }),
    });

    const counted = withCountableClientAddress(request, withPeer("203.0.113.4"), false);
    expect(counted.headers.get("x-forwarded-for")).toBe("203.0.113.4");
    // The request still has to be usable afterwards.
    expect(await counted.json()).toEqual({ email: "someone@example.com" });
  });

  it("adds the connection's address when the caller sent none", () => {
    const request = new Request("https://balance.example.com/api/auth/sign-in/email", {
      method: "POST",
      body: "{}",
    });
    const counted = withCountableClientAddress(request, withPeer("203.0.113.9"), false);
    expect(counted.headers.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  it("drops a claimed address when the connection has none to offer", () => {
    const request = new Request("https://balance.example.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7" },
      body: "{}",
    });
    const counted = withCountableClientAddress(request, withPeer(undefined), false);
    expect(counted.headers.get("x-forwarded-for")).toBeNull();
  });

  // With a proxy in front, the header is the proxy's statement rather than the
  // caller's, and the connection address is only ever the proxy itself.
  it("leaves the header alone when a proxy is trusted", () => {
    const request = new Request("https://balance.example.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.7" },
      body: "{}",
    });
    const counted = withCountableClientAddress(request, withPeer("10.0.0.1"), true);
    expect(counted.headers.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(counted).toBe(request);
  });
});

describe("counting attempts against a caller", () => {
  const withPeer = (peer: string | undefined) =>
    ({ env: { incoming: { socket: { remoteAddress: peer } } } }) as never;
  const request = (forwarded?: string) =>
    new Request("https://balance.example.com/api/auth/sign-up/email", {
      method: "POST",
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
      body: "{}",
    });

  it("reads the address the same way withCountableClientAddress does", () => {
    expect(countableClientAddress(request("198.51.100.7"), withPeer("203.0.113.4"), false)).toBe(
      "203.0.113.4",
    );
    expect(
      countableClientAddress(request("198.51.100.7, 10.0.0.1"), withPeer("10.0.0.1"), true),
    ).toBe("198.51.100.7");
    expect(countableClientAddress(request(), withPeer(undefined), false)).toBe("unknown");
  });

  /**
   * A store standing in for the table, so these stay unit tests. It counts the
   * way the upsert does: one window per key, restarted once it has run out.
   */
  function fakeStore() {
    const rows = new Map<string, { count: number; lastRequest: number }>();
    return {
      rows,
      reached: 0,
      async take(key: string, max: number, windowMs: number, now: number) {
        this.reached += 1;
        const row = rows.get(key);
        if (!row || row.lastRequest <= now - windowMs) {
          rows.set(key, { count: 1, lastRequest: now });
          return 1 <= max;
        }
        row.count += 1;
        return row.count <= max;
      },
      async clear(key: string) {
        rows.delete(key);
      },
    };
  }

  const at = (times: number[]) => {
    let index = 0;
    return () => times[Math.min(index++, times.length - 1)]!;
  };

  it("allows the allowance and then refuses", async () => {
    const store = fakeStore();
    const limiter = createAttemptLimiter({
      max: 3,
      windowMs: 60_000,
      now: () => 1_000,
      store,
    });
    expect([await limiter.take("a"), await limiter.take("a"), await limiter.take("a")]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await limiter.take("a")).toBe(false);
  });

  it("counts each caller on its own", async () => {
    const store = fakeStore();
    const limiter = createAttemptLimiter({
      max: 1,
      windowMs: 60_000,
      now: () => 1_000,
      store,
    });
    expect(await limiter.take("a")).toBe(true);
    expect(await limiter.take("b")).toBe(true);
    expect(await limiter.take("a")).toBe(false);
  });

  it("starts over once the window has passed", async () => {
    const store = fakeStore();
    const limiter = createAttemptLimiter({
      max: 1,
      windowMs: 60_000,
      now: at([1_000, 30_000, 61_001]),
      store,
    });
    expect(await limiter.take("a")).toBe(true);
    expect(await limiter.take("a")).toBe(false);
    expect(await limiter.take("a")).toBe(true);
  });

  it("forgets a caller that succeeded", async () => {
    const store = fakeStore();
    const limiter = createAttemptLimiter({
      max: 1,
      windowMs: 60_000,
      now: () => 1_000,
      store,
    });
    expect(await limiter.take("a")).toBe(true);
    await limiter.clear("a");
    expect(await limiter.take("a")).toBe(true);
    expect(store.rows.has("a")).toBe(true);
  });

  /**
   * The whole reason the count moved out of the process: two replicas each
   * holding their own tally hand a guesser twice the allowance.
   */
  it("counts one allowance across separate replicas", async () => {
    const store = fakeStore();
    const replica = () =>
      createAttemptLimiter({ max: 2, windowMs: 60_000, now: () => 1_000, store });
    const first = replica();
    const second = replica();
    expect(await first.take("a")).toBe(true);
    expect(await second.take("a")).toBe(true);
    expect(await second.take("a")).toBe(false);
    expect(await first.take("a")).toBe(false);
  });

  /**
   * A flood is refused by the tally in this process, so the table it would
   * otherwise be hammering is never reached for it.
   */
  it("stops asking the database once a caller is over the allowance", async () => {
    const store = fakeStore();
    const limiter = createAttemptLimiter({
      max: 2,
      windowMs: 60_000,
      now: () => 1_000,
      store,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) await limiter.take("a");
    expect(store.reached).toBe(2);
  });

  /**
   * A database having a bad minute must not refuse every sign-in on the
   * deployment. The local tally is what is left, and it is still a bound.
   */
  it("falls back to the local tally when the store cannot be reached", async () => {
    const broken = {
      take: async () => {
        throw new Error("no connection");
      },
      clear: async () => {},
    };
    const limiter = createAttemptLimiter({
      max: 2,
      windowMs: 60_000,
      now: () => 1_000,
      store: broken,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await limiter.take("a")).toBe(true);
    expect(await limiter.take("a")).toBe(true);
    expect(await limiter.take("a")).toBe(false);
  });
});

/**
 * The list this replaced had drifted: the template mass edit and mass delete
 * accept a full bulk selection and were sized as ordinary requests.
 */
describe("which routes are sized for a bulk selection", () => {
  it.each([
    "/api/v1/transactions/bulk-edit",
    "/api/v1/transactions/bulk-delete",
    "/api/v1/transactions/bulk-selection",
    "/api/v1/staged-transactions/commit",
    "/api/v1/staged-transactions/delete",
    "/api/v1/staged-transactions/bulk-edit",
    "/api/v1/staged-transactions/bulk-selection",
    "/api/v1/transaction-templates/bulk-edit",
    "/api/v1/transaction-templates/bulk-delete",
  ])("gives %s the bulk allowance", (path) => {
    expect(apiRequestBodyLimit(path)).toBe(BULK_REQUEST_BODY_LIMIT_BYTES);
  });

  it.each([
    "/api/v1/transactions",
    `/api/v1/transactions/${randomUUID()}`,
    `/api/v1/transaction-templates/${randomUUID()}`,
    "/api/v1/preferences",
    "/api/v1/me",
  ])("leaves %s on the ordinary allowance", (path) => {
    expect(apiRequestBodyLimit(path)).toBe(API_REQUEST_BODY_LIMIT_BYTES);
  });

  it("covers every bulk-shaped route the API actually registers", async () => {
    const source = await readFile(new URL("../src/server/api.ts", import.meta.url), "utf8");
    const routes = [...source.matchAll(/app\.(?:post|put|delete)\("(\/api\/v1\/[^"]+)"/g)].map(
      (match) => match[1]!,
    );
    const bulkShaped = routes.filter((path) =>
      /\/(bulk-edit|bulk-delete|bulk-selection|commit|delete)$/.test(path),
    );
    expect(bulkShaped.length).toBeGreaterThanOrEqual(9);
    for (const path of bulkShaped) {
      expect(apiRequestBodyLimit(path), path).toBe(BULK_REQUEST_BODY_LIMIT_BYTES);
    }
  });
});
