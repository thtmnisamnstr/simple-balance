import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/server/api.js";
import { getConfig } from "../src/server/config.js";
import { createAttemptLimiter } from "../src/server/http-security.js";
import { registry, resetMetrics } from "../src/server/metrics.js";
import { staleVersion } from "../src/server/services/errors.js";
import { createProgressDecoder, PROGRESS_MEDIA_TYPE } from "../src/shared/progress.js";

/**
 * What the HTTP surface counts that `http_requests_total` cannot say: how many
 * requests are open right now, which of them an unexpected failure ended, how a
 * stream ended after its 200 went out, which auth endpoint a request named,
 * which limiter refused it, whether readiness held, and whether anybody was
 * still there for the answer.
 *
 * Driven through the real app and its real middleware. What is stood in for is
 * what this tier has no way to reach: the session behind the `/api/v1` gate,
 * Better Auth's own handler, the service a commit calls, and the database a
 * readiness check and the attempt limiter ask. Each stand-in answers the way
 * its real counterpart can, so what is under test is the counting around it.
 */
const held = vi.hoisted(() => ({
  /** What Better Auth's handler answers, per test. */
  authAnswer: (_request: Request): Response | Promise<Response> => new Response(null),
  /** What the sign-in form's options read does, per test. */
  authOptions: async (): Promise<unknown> => ({ local: true }),
  /** What the commit service does, per test. */
  commit: async (): Promise<unknown> => ({ committed: [] }),
  /** What a statement against the database does, per test. */
  execute: async (): Promise<unknown> => ({ rows: [] }),
}));

vi.mock("../src/server/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/auth.js")>()),
  getWebIdentity: async () => ({
    user: { id: "metrics-http-person", name: "Metrics", email: "metrics@example.com" },
    session: { createdAt: new Date(0).toISOString() },
  }),
  getAuth: () => ({ handler: (request: Request) => held.authAnswer(request) }),
}));
vi.mock("../src/server/auth-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/auth-policy.js")>()),
  getPublicAuthOptions: () => held.authOptions(),
  // An unclaimed deployment, which is the only one where the setup code and
  // its limiter are reached at all.
  isLocalBootstrapOpen: async () => true,
}));
vi.mock("../src/server/setup-token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/setup-token.js")>()),
  isOwnerSetupTokenValid: async () => false,
}));
vi.mock("../src/server/services/staging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/services/staging.js")>()),
  commitStages: () => held.commit(),
}));
vi.mock("../src/server/db/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/db/client.js")>()),
  getDb: () => ({ execute: () => held.execute() }),
}));

const defaults = { ...held };

beforeEach(() => {
  resetMetrics();
  // `log.failure` writes every internal error here, which is the behavior
  // being provoked; the lines themselves are `tests/log-level.test.ts`'s. The
  // Node adapter announces a hang-up on `info` from its own code.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(held, defaults);
  vi.restoreAllMocks();
  resetMetrics();
});

/**
 * What a scrape would read for one series, summed over the series that match.
 *
 * Read off `getMetricsAsJSON`, which is what the text format is rendered from,
 * rather than off the metric object, so `component` and every other label are
 * on the values exactly as a scraper sees them.
 */
async function reading(name: string, labels: Record<string, string> = {}) {
  const metric = (await registry.getMetricsAsJSON()).find(
    (candidate) => candidate.name === `simple_balance_${name}`,
  );
  return (metric?.values ?? [])
    .filter((value) =>
      Object.entries(labels).every(([label, wanted]) => value.labels[label] === wanted),
    )
    .reduce((sum, value) => sum + value.value, 0);
}

/** A promise the test resolves, so a request can be caught while it is still open. */
function gate() {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

const origin = () => getConfig().baseUrl;
const COMMIT = "/api/v1/staged-transactions/commit";

/** The streamed commit as the browser sends it: same origin, JSON, asking for frames. */
const commit = () =>
  app.request(`http://localhost${COMMIT}`, {
    method: "POST",
    headers: { origin: origin(), "content-type": "application/json", accept: PROGRESS_MEDIA_TYPE },
    body: JSON.stringify({
      stagedIds: ["11111111-2222-4333-8444-555555555555"],
      expectedVersions: { "11111111-2222-4333-8444-555555555555": 1 },
      idempotencyKey: "metrics-http-commit",
    }),
  });

const authPost = (path: string, body: unknown, from = origin()) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { origin: from, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("requests in flight", () => {
  it("counts a request from the moment it arrives until it is answered", async () => {
    const { opened, release } = gate();
    held.authOptions = async () => {
      await opened;
      return { local: true };
    };

    const pending = app.request("http://localhost/api/auth/methods");
    // Parked in its handler, which is the state the gauge exists to show: a
    // request that has not finished is in neither counter yet.
    await vi.waitFor(async () => expect(await reading("http_requests_in_flight")).toBe(1));
    expect(await reading("http_requests_total")).toBe(0);

    release();
    expect((await pending).status).toBe(200);
    expect(await reading("http_requests_in_flight")).toBe(0);
    expect(await reading("http_requests_total", { route: "/api/auth/methods" })).toBe(1);
  });

  it("holds a streamed request until its last frame, not until its head went out", async () => {
    const { opened, release } = gate();
    held.commit = async () => {
      await opened;
      return { committed: [] };
    };

    const response = await commit();
    // The head is out and the 200 is spent, and the work is still running:
    // ending the count here is the mistake the deferred record exists to avoid.
    expect(response.status).toBe(200);
    expect(await reading("http_requests_in_flight")).toBe(1);

    release();
    await response.text();
    await vi.waitFor(async () => expect(await reading("http_requests_in_flight")).toBe(0));
  });

  it("goes back down after a request that failed", async () => {
    held.authOptions = async () => {
      throw new Error("the options could not be read");
    };

    expect((await app.request("http://localhost/api/auth/methods")).status).toBe(500);
    expect(await reading("http_requests_in_flight")).toBe(0);
  });
});

describe("how a stream ended", () => {
  it("counts a stream that delivered its result", async () => {
    const response = await commit();
    const frames = createProgressDecoder()(await response.text());

    expect(frames.at(-1)?.type).toBe("result");
    await vi.waitFor(async () =>
      expect(
        await reading("http_stream_outcomes_total", { route: COMMIT, outcome: "result" }),
      ).toBe(1),
    );
  });

  it("counts a refusal apart from a failure, and neither as an internal error", async () => {
    held.commit = async () => {
      throw staleVersion();
    };

    const response = await commit();
    const frames = createProgressDecoder()(await response.text());

    // A 200 on the wire, which is what `http_requests_total` will say forever.
    expect(response.status).toBe(200);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      error: { error: { code: "STALE_VERSION" } },
    });
    await vi.waitFor(async () =>
      expect(
        await reading("http_stream_outcomes_total", { route: COMMIT, outcome: "refused" }),
      ).toBe(1),
    );
    expect(await reading("http_stream_outcomes_total", { outcome: "error" })).toBe(0);
    // Somebody's rows changed under them: a person reloading, not a bug.
    expect(await reading("internal_errors_total")).toBe(0);
  });

  it("counts a failure nobody meant as an error, and as the stream's internal error", async () => {
    held.commit = async () => {
      throw new Error("the connection was reset mid-commit");
    };

    const response = await commit();
    const frames = createProgressDecoder()(await response.text());

    expect(response.status).toBe(200);
    expect(frames.at(-1)).toMatchObject({
      type: "error",
      error: { error: { code: "INTERNAL_ERROR" } },
    });
    await vi.waitFor(async () =>
      expect(await reading("http_stream_outcomes_total", { route: COMMIT, outcome: "error" })).toBe(
        1,
      ),
    );
    // Under `stream` and not `http`: the request counter recorded this as a
    // 200, so an alert on 5xx alone would never see it, and one on this
    // surface is the only place it shows.
    expect(await reading("internal_errors_total", { surface: "stream" })).toBe(1);
    expect(await reading("internal_errors_total", { surface: "http" })).toBe(0);
    await vi.waitFor(async () =>
      expect(await reading("http_requests_total", { route: COMMIT, status: "200" })).toBe(1),
    );
  });
});

describe("an internal error answered as a 500", () => {
  it("is counted under the surface that answered it", async () => {
    held.authOptions = async () => {
      throw new Error("the options could not be read");
    };

    const response = await app.request("http://localhost/api/auth/methods");

    expect(response.status).toBe(500);
    expect(await reading("internal_errors_total", { surface: "http" })).toBe(1);
    expect(await reading("internal_errors_total", { surface: "stream" })).toBe(0);
  });

  it("is not counted for a refusal the caller can act on", async () => {
    // A path under `/api/v1` that names nothing, and a commit whose body is
    // not one: two refusals reached through the same renderer as the 500.
    expect((await app.request("http://localhost/api/v1/no-such-endpoint")).status).toBe(404);
    const malformed = await app.request(`http://localhost${COMMIT}`, {
      method: "POST",
      headers: { origin: origin(), "content-type": "application/json" },
      body: JSON.stringify({ stagedIds: [] }),
    });
    expect(malformed.status).toBe(422);

    expect(await reading("internal_errors_total")).toBe(0);
  });
});

describe("a request to the auth routes", () => {
  it("is counted under the endpoint it named, with a token in the path left out", async () => {
    const token = "reset-token-that-must-never-be-a-label-0123456789";
    held.authAnswer = () => new Response(null, { status: 302, headers: { location: "/" } });

    await app.request(`http://localhost/api/auth/reset-password/${token}`);

    expect(
      await reading("auth_requests_total", {
        route: "/api/auth/reset-password/:token",
        outcome: "redirected",
      }),
    ).toBe(1);
    // The failure this exists to prevent: a reset token is a credential, and a
    // label publishes it to whoever can scrape.
    expect(await registry.metrics()).not.toContain(token);
  });

  it("puts a path no listed endpoint matches under the catch-all, never as it was sent", async () => {
    held.authAnswer = () => new Response(null, { status: 404 });

    await app.request("http://localhost/api/auth/probing/for-something-here");
    await app.request("http://localhost/api/auth/sign-in/email/with/more/segments");

    expect(await reading("auth_requests_total", { route: "/api/auth/*", outcome: "refused" })).toBe(
      2,
    );
    const text = await registry.metrics();
    expect(text).not.toContain("probing");
    expect(text).not.toContain("with/more");
  });

  it("names a provider's callback by its pattern, whatever the provider", async () => {
    // Google is off in this tier, so its route refuses before Better Auth is
    // asked; the label is the same either way, which is the point.
    await app.request("http://localhost/api/auth/callback/google");
    held.authAnswer = () => new Response(null, { status: 302, headers: { location: "/" } });
    await app.request("http://localhost/api/auth/callback/someone-elses-provider");

    expect(
      await reading("auth_requests_total", { route: "/api/auth/callback/:id", outcome: "refused" }),
    ).toBe(1);
    expect(
      await reading("auth_requests_total", {
        route: "/api/auth/callback/:id",
        outcome: "redirected",
      }),
    ).toBe(1);
    expect(await registry.metrics()).not.toContain("someone-elses-provider");
  });

  it("counts a sign-in a guard refused, as the timing middleware does", async () => {
    let reached = false;
    held.authAnswer = () => {
      reached = true;
      return new Response(null);
    };

    const response = await authPost(
      "/api/auth/sign-in/email",
      { email: "someone@example.com", password: "a password long enough" },
      "https://somewhere-else.example",
    );

    expect(response.status).toBe(403);
    expect(reached).toBe(false);
    expect(
      await reading("auth_requests_total", {
        route: "/api/auth/sign-in/email",
        outcome: "refused",
      }),
    ).toBe(1);
  });

  it("tells a session read that worked from a server that failed", async () => {
    held.authAnswer = () => Response.json({ session: null });
    await app.request("http://localhost/api/auth/get-session");
    held.authOptions = async () => {
      throw new Error("the options could not be read");
    };
    await app.request("http://localhost/api/auth/methods");

    expect(
      await reading("auth_requests_total", { route: "/api/auth/get-session", outcome: "ok" }),
    ).toBe(1);
    expect(
      await reading("auth_requests_total", { route: "/api/auth/methods", outcome: "error" }),
    ).toBe(1);
  });
});

describe("a rate limiter's refusal", () => {
  it("is Better Auth's when the 429 carries its header", async () => {
    held.authAnswer = () => new Response(null, { status: 429, headers: { "X-Retry-After": "10" } });

    const response = await authPost("/api/auth/sign-in/email", {
      email: "someone@example.com",
      password: "a password long enough",
    });

    expect(response.status).toBe(429);
    expect(await reading("rate_limited_total", { limiter: "auth" })).toBe(1);
    expect(await reading("rate_limited_total", { limiter: "setup_code" })).toBe(0);
    expect(
      await reading("auth_requests_total", {
        route: "/api/auth/sign-in/email",
        outcome: "rate_limited",
      }),
    ).toBe(1);
  });

  it("is the setup code's when somebody keeps guessing it", async () => {
    // A stranger the registration rule turns away, on an unclaimed deployment:
    // the code is the only way in and the attempt limiter is all that stands
    // in front of it. Five wrong codes are refused for being wrong, and the
    // sixth for being one too many, by this process's own tally.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await authPost("/api/auth/sign-up/email", {
        email: "stranger@example.com",
        password: "a password long enough",
        name: "Stranger",
        setupToken: `guess-${attempt}`,
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
    expect(await reading("rate_limited_total", { limiter: "setup_code" })).toBe(1);
    // Not Better Auth's: its handler was never reached, and the 429 says so by
    // carrying only the standard header.
    expect(await reading("rate_limited_total", { limiter: "auth" })).toBe(0);
    expect(
      await reading("auth_requests_total", {
        route: "/api/auth/sign-up/email",
        outcome: "rate_limited",
      }),
    ).toBe(1);
  });

  it("counts the shared store failing, and only on the attempt that fell back", async () => {
    const limiter = createAttemptLimiter({
      max: 5,
      windowMs: 60_000,
      store: {
        take: async () => {
          throw new Error("auth_rate_limit could not be reached");
        },
        clear: async () => {
          throw new Error("auth_rate_limit could not be reached");
        },
      },
    });

    // Allowed, because a database's bad minute must not refuse every sign-in;
    // and counted, because that allowance is now per replica.
    await expect(limiter.take("someone")).resolves.toBe(true);
    await expect(limiter.take("someone")).resolves.toBe(true);
    await limiter.clear("someone");

    expect(await reading("rate_limit_store_failures_total")).toBe(2);
  });
});

describe("a readiness check", () => {
  it("records the answer it gave, ready", async () => {
    const response = await app.request("http://localhost/health/ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready" });
    expect(await reading("readiness_checks_total", { outcome: "ready" })).toBe(1);
    expect(await reading("ready")).toBe(1);
  });

  it("records the answer it gave, not ready, and the gauge follows it down", async () => {
    await app.request("http://localhost/health/ready");
    held.execute = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const response = await app.request("http://localhost/health/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready" });
    expect(await reading("readiness_checks_total", { outcome: "not_ready" })).toBe(1);
    expect(await reading("ready")).toBe(0);
  });

  it("is never asked by a scrape", async () => {
    let asked = 0;
    held.execute = async () => {
      asked += 1;
      return { rows: [] };
    };

    await registry.metrics();

    // A scrape that queried the database would be the scrape opening a
    // connection, which `metrics.ts` refuses everywhere else too.
    expect(asked).toBe(0);
  });
});

/**
 * Whether anybody was still there for the answer, over a real socket.
 *
 * `app.request` has no connection to close, so this tier's usual way in cannot
 * see it at all. The first test is about `@hono/node-server` rather than this
 * repository: the counter reads the request's abort signal, and it is only as
 * true as the adapter's promise to fire that signal when the client goes. If an
 * upgrade stops firing it, the first test fails by name rather than the counter
 * quietly reading zero for ever.
 */
describe("a request whose caller went away", () => {
  const servers: ReturnType<typeof serve>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  /** A listening server on a free loopback port. */
  async function listening(fetch: (request: Request) => Response | Promise<Response>) {
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(started));
    });
    servers.push(server);
    return { server, port: (server.address() as AddressInfo).port };
  }

  /** Opens a request, and hands back a way to hang up on it before any answer. */
  function hangUpOn(port: number, path: string) {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, agent: false });
    // The socket is torn down on purpose; the error that follows is the hang-up.
    outgoing.on("error", () => {});
    outgoing.end();
    return () => outgoing.destroy();
  }

  /** Waits until the server has seen the connection close, which is what fires the signal. */
  async function closedOn(server: ReturnType<typeof serve>) {
    await vi.waitFor(
      () =>
        new Promise<void>((resolve, reject) => {
          server.getConnections((error, count) =>
            !error && count === 0 ? resolve() : reject(new Error(`${count} still open`)),
          );
        }),
    );
    // One more turn, so the response's own `close` handler has run.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("is signaled to the handler by the adapter", async () => {
    const { opened, release } = gate();
    const arrived = gate();
    let signal: AbortSignal | undefined;
    const probe = new Hono();
    probe.get("/slow", async (c) => {
      signal = c.req.raw.signal;
      arrived.release();
      await opened;
      return c.text("too late");
    });
    const { server, port } = await listening(probe.fetch);

    const hangUp = hangUpOn(port, "/slow");
    await arrived.opened;
    expect(signal?.aborted).toBe(false);
    hangUp();
    await closedOn(server);

    expect(signal?.aborted).toBe(true);
    release();
  });

  it("is counted under its route, and a request answered in full is not", async () => {
    const { opened, release } = gate();
    const arrived = gate();
    held.authOptions = async () => {
      arrived.release();
      await opened;
      return { local: true };
    };
    const { server, port } = await listening(app.fetch);

    const hangUp = hangUpOn(port, "/api/auth/methods");
    await arrived.opened;
    hangUp();
    await closedOn(server);
    release();

    await vi.waitFor(async () =>
      expect(await reading("http_requests_total", { route: "/api/auth/methods" })).toBe(1),
    );
    expect(await reading("http_requests_aborted_total", { route: "/api/auth/methods" })).toBe(1);

    // And the control: the same route, waited for, is a request somebody got.
    held.authOptions = async () => ({ local: true });
    const answered = await fetch(`http://127.0.0.1:${port}/api/auth/methods`);
    expect(answered.status).toBe(200);
    await vi.waitFor(async () =>
      expect(await reading("http_requests_total", { route: "/api/auth/methods" })).toBe(2),
    );
    expect(await reading("http_requests_aborted_total")).toBe(1);
  });
});
