import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpServer, handleMcpRequest } from "../src/server/mcp.js";
import app from "../src/server/api.js";
import { httpRequests, registry, resetMetrics } from "../src/server/metrics.js";

/**
 * What this deployment says about itself, and what it must never say.
 *
 * The rule that matters is the second one. A metric is read by whoever can
 * reach the scrape endpoint, which is not the person whose ledger it counts, so
 * a label carrying a user id, an email or an account name would publish through
 * the monitoring system exactly what every query in `src/server/services`
 * scopes by actor to keep private. Nothing in `src` does that today, and
 * `tests/observability-guide.test.ts` is what keeps it that way: a new label is
 * a decision that has to survive its allow-list.
 *
 * The other half is cardinality, which is the same defect wearing a cost rather
 * than a privacy label: a series per account id is a monitoring system that
 * falls over on a ledger somebody actually uses.
 */

describe("the metric registry", () => {
  // Which labels a metric carries is read in `tests/observability-guide.test.ts`
  // ("carry nobody's identity, read where a scrape reads them"), from the
  // values a scrape publishes against an allow-list. The check that stood here
  // read `labelNames` off `getMetricsAsJSON`, which never returns it, so it
  // looked at nothing and could not fail.

  it("names every metric of its own with the same prefix", async () => {
    const metrics = await registry.getMetricsAsJSON();
    const ours = metrics.filter((metric) => !metric.name.startsWith("nodejs_"));
    const unprefixed = ours
      .map((metric) => metric.name)
      .filter((name) => !name.startsWith("simple_balance_") && !name.startsWith("process_"));
    expect(unprefixed).toEqual([]);
  });

  it("suffixes a counter with _total and does not suffix anything else", async () => {
    const metrics = await registry.getMetricsAsJSON();
    const wrong = metrics
      // Ours, not `prom-client`'s. Its default set carries three gauges named
      // `nodejs_active_handles_total` and the like, which are its convention to
      // defend and not this repository's to fix.
      .filter((metric) => metric.name.startsWith("simple_balance_"))
      .filter((metric) => !metric.name.includes("nodejs_"))
      // Through `String`, because `prom-client`'s types and its runtime
      // disagree here: the declaration says `metric.type` is a `MetricType`
      // enum member and what `getMetricsAsJSON` actually returns is the string
      // `"counter"`. Comparing to the enum throws — it is a type-only
      // declaration with no runtime object behind it — and comparing to the
      // string without this is a type error. So the value is read as what it
      // is at run time, which is what the assertion is about.
      .filter((metric) =>
        String(metric.type) === "counter"
          ? !metric.name.endsWith("_total")
          : metric.name.endsWith("_total"),
      )
      .map((metric) => `${metric.name} is a ${metric.type}`);
    expect(wrong).toEqual([]);
  });

  it("renders in the format a scraper parses", async () => {
    httpRequests.inc({ method: "GET", route: "/health/live", status: "200" });
    const text = await registry.metrics();
    expect(text).toContain("# HELP simple_balance_http_requests_total");
    expect(text).toContain("# TYPE simple_balance_http_requests_total counter");
    expect(text).toMatch(
      /simple_balance_http_requests_total\{[^}]*route="\/health\/live"[^}]*\} 1/,
    );
  });
});

/** As much of a histogram as reading its buckets needs. */
type Observable = {
  observe: (labels: Record<string, string>, value: number) => void;
  get: () => Promise<{
    values: { labels: Record<string, string | number>; metricName?: string; value: number }[];
  }>;
};

const histogram = (name: string) => registry.getSingleMetric(name) as unknown as Observable;

/** Each finite boundary a histogram publishes and how many it holds, read as a scrape reads it. */
async function bucketCounts(name: string) {
  const { values } = await histogram(name).get();
  return values
    .filter((value) => value.metricName === `${name}_bucket`)
    .map((value) => ({ le: Number(value.labels.le), count: value.value }))
    .filter((bucket) => Number.isFinite(bucket.le));
}

/** The highest finite boundary, after one observation so a labeled histogram has a series. */
async function topBucket(name: string, labels: Record<string, string> = {}) {
  histogram(name).observe(labels, 0);
  return Math.max(...(await bucketCounts(name)).map((bucket) => bucket.le));
}

/** A number as a source file writes it, `NAME = 10_000` or `name: 10_000`. */
function sourceNumber(path: string, pattern: RegExp) {
  const found = pattern.exec(readFileSync(path, "utf8"))?.[1];
  // Thrown with the pattern and the file, rather than left to fail as a method
  // called on `undefined`, which names neither and reads as a bug in the test.
  if (found === undefined) throw new Error(`${String(pattern)} is not in ${path} any more`);
  return Number(found.replaceAll("_", ""));
}

/**
 * Where the bucket sets end, held against the numbers `metrics.ts` argues
 * them from.
 *
 * Each top boundary is a claim about something outside the histogram — a
 * timeout, a retry count, a default interval — and the failure it guards
 * against is silent: a reading past the last boundary lands in `+Inf`, where
 * how long it took cannot be read at all. So the outside number is read from
 * the file that sets it rather than copied here, and the comparison fails when
 * either side moves.
 */
describe("a histogram's buckets", () => {
  beforeEach(() => {
    resetMetrics();
  });
  afterEach(() => {
    resetMetrics();
  });

  it("tell a request inside fifty milliseconds from one inside a hundred", async () => {
    const name = "simple_balance_http_request_duration_seconds";
    histogram(name).observe({ method: "GET", route: "/health/live" }, 0.04);

    const counts = new Map((await bucketCounts(name)).map((bucket) => [bucket.le, bucket.count]));
    // Forty milliseconds is past 0.025 and inside 0.05. The set used to go
    // from 0.025 straight to 0.1, so an objective of fifty could not be read.
    expect(counts.get(0.025)).toBe(0);
    expect(counts.get(0.05)).toBe(1);
  });

  it("keep a Stripe request that timed out on every attempt out of +Inf", async () => {
    const stripe = "src/server/stripe.ts";
    const timeout = sourceNumber(stripe, /STRIPE_TIMEOUT_MS = ([\d_]+)/) / 1000;
    const retries = sourceNumber(stripe, /maxNetworkRetries: ([\d_]+)/);
    // The SDK sleeps half a second before its first retry and doubles that for
    // each one after, capped at five and never more than the full value
    // (`_getSleepTimeInMS` in its `RequestSender`). At ten seconds and two
    // retries: 10 + 0.5 + 10 + 1 + 10 = 31.5, three times the old top bucket.
    let worst = timeout * (retries + 1);
    for (let retry = 1; retry <= retries; retry += 1) worst += Math.min(0.5 * 2 ** (retry - 1), 5);

    expect(
      await topBucket("simple_balance_stripe_request_duration_seconds", {
        operation: "bucket_probe",
      }),
    ).toBeGreaterThanOrEqual(worst);
  });

  it("end a pool wait at the pool's own timeout, so +Inf is an acquire that gave up", async () => {
    const timeout =
      sourceNumber("src/server/db/client.ts", /connectionTimeoutMillis: ([\d_]+)/) / 1000;

    // Equal, not merely at least: a boundary above the timeout is a bucket
    // nothing can land in, and the reading `metrics.ts` promises — past the
    // last boundary means gave up — would stop being true.
    expect(await topBucket("simple_balance_db_pool_acquire_duration_seconds")).toBe(timeout);
  });

  it("end a tick at the default interval, so +Inf is a tick that overran it", async () => {
    const interval = sourceNumber(
      "src/server/config-limits.ts",
      /DEFAULT_RECURRENCE_TICK_SECONDS = ([\d_]+)/,
    );

    expect(await topBucket("simple_balance_scheduler_tick_duration_seconds")).toBe(interval);
  });

  it("keep a mail send that hit every transport bound out of +Inf", async () => {
    const mail = "src/server/mail.ts";
    const bounds =
      (sourceNumber(mail, /connectionTimeout: ([\d_]+)/) +
        sourceNumber(mail, /greetingTimeout: ([\d_]+)/) +
        sourceNumber(mail, /socketTimeout: ([\d_]+)/)) /
      1000;

    expect(await topBucket("simple_balance_mail_send_duration_seconds")).toBeGreaterThanOrEqual(
      bounds,
    );
  });
});

describe("the HTTP middleware", () => {
  beforeEach(() => {
    resetMetrics();
  });
  afterEach(() => {
    resetMetrics();
  });

  it("counts a handled request under the pattern that handled it", async () => {
    const response = await app.request("http://localhost/health/live");
    expect(response.status).toBe(200);
    expect(await registry.metrics()).toContain('route="/health/live"');
  });

  it("never puts an id in a label", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    // Unauthenticated, so the session gate refuses it before any handler runs
    // and the pattern that matched is the gate's own, `/api/v1/*`. That is the
    // right answer rather than a shortcoming: every request refused for the
    // same reason belongs in one series, and the label stays bounded either
    // way, which is the property being defended.
    const response = await app.request(`http://localhost/api/v1/accounts/${id}`);
    expect(response.status).toBe(401);
    const text = await registry.metrics();
    expect(text).toContain('route="/api/v1/*"');
    // The failure this exists to catch: one series per account, which is how a
    // ledger with ten thousand rows becomes ten thousand time series.
    expect(text).not.toContain(id);
  });

  it("counts a path that matched nothing under one name", async () => {
    await app.request("http://localhost/no-such-path-at-all");
    await app.request("http://localhost/another-one-that-does-not-exist");
    const text = await registry.metrics();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain("no-such-path-at-all");
  });
});

describe("an MCP tool call", () => {
  const resources: { client?: Client; server?: ReturnType<typeof createMcpServer> } = {};

  afterEach(async () => {
    await resources.client?.close();
    await resources.server?.close();
    resources.client = undefined;
    resources.server = undefined;
    resetMetrics();
  });

  /** A connected client and server over the in-memory pair, as a real one is. */
  async function connect() {
    resources.server = createMcpServer(
      { userId: "metrics-agent", source: "mcp", clientId: "metrics-test" },
      new Set(["ledger:read"]),
    );
    resources.client = new Client({ name: "metrics", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await resources.server.connect(serverTransport);
    await resources.client.connect(clientTransport);
    return resources.client;
  }

  it("is counted under the tool that was called", async () => {
    const client = await connect();
    // There is no database in this tier, so this call cannot be served and
    // comes back as a refusal. That is the useful half here: the label is the
    // thing being checked, and a failing call proves the counter is in the
    // `finally` rather than on the happy path. The successful case is in
    // `tests/integration/metrics.integration.test.ts`, where there is a ledger
    // to answer from.
    await client.callTool({ name: "whoami", arguments: {} });
    const text = await registry.metrics();
    // The label the registration knows and `runTool` never sees. Wrapping
    // `registerTool` is what makes it available, and the failure it prevents is
    // silent: without it every tool call lands in one unlabeled series and
    // "which tool is slow" cannot be asked at all.
    expect(text).toMatch(
      /simple_balance_mcp_tool_calls_total\{[^}]*tool="whoami"[^}]*outcome="error"[^}]*\} 1/,
    );
    expect(text).toContain("simple_balance_mcp_tool_duration_seconds_count{");
  });

  /**
   * What the wrapper cannot see, and the counter that can.
   *
   * The tool counter wraps `registerTool`, so it runs only once the SDK has
   * parsed the arguments against the tool's own schema and found the tool. A
   * call the protocol refuses first — an argument the schema rejects, a tool
   * that does not exist, a tool outside this connection's scope — never
   * reaches it.
   *
   * This test once asserted that such a call was *not* counted as `ok`, which
   * is true of a series that does not exist and would have been true of a
   * counter never wired up at all; then that it was counted nowhere, which was
   * the gap stated. `mcp_requests_total` closes the gap at the transport, so
   * the absence here is asserted beside the presence there, and the call goes
   * in through `handleMcpRequest` rather than the in-memory pair, because the
   * transport is where the second counter is and the pair never passes it.
   */
  it("leaves a call the protocol refuses out of the tool counter, and counts it at the transport", async () => {
    const response = await handleMcpRequest(
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
          params: { name: "list_transactions", arguments: { limit: -1 } },
        }),
      }),
      { userId: "metrics-agent", source: "mcp", clientId: "metrics-test" },
      new Set(["ledger:read"]),
    );
    expect(response.status).toBe(200);
    const text = await registry.metrics();
    expect(text).not.toContain('tool="list_transactions"');
    expect(text).toMatch(
      /simple_balance_mcp_requests_total\{[^}]*rpc_method="tools\/call"[^}]*outcome="tool_error"[^}]*\} 1/,
    );
  });
});

describe("the metrics endpoint", () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.resetModules();
  });

  /** The API app, rebuilt against the environment this test just set. */
  async function freshApp() {
    vi.resetModules();
    const module = (await import("../src/server/api.js")) as { default: typeof app };
    return module.default;
  }

  it("is absent from a deployment that did not ask for it", async () => {
    process.env.METRICS_ENABLED = "false";
    const server = await freshApp();
    const response = await server.request("http://localhost/metrics");
    // Not a status assertion, because the status depends on something this test
    // has no business knowing: with a built client on disk the single-page
    // app's fallback answers 200 with the shell, exactly as it does for
    // `/budgets`, and without one it is a 404. Both are "there is no such
    // route" — what matters is that no measurement comes back, and a scraper
    // pointed at a deployment that never asked for this gets a parse error
    // rather than a page of numbers.
    expect(await response.text()).not.toContain("simple_balance_");
  });

  it("answers when it was asked for and no token was set", async () => {
    process.env.METRICS_ENABLED = "true";
    delete process.env.METRICS_TOKEN;
    const server = await freshApp();
    const response = await server.request("http://localhost/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("simple_balance_");
  });

  it("refuses without the token, and names the scheme so a scraper can fix it", async () => {
    process.env.METRICS_ENABLED = "true";
    process.env.METRICS_TOKEN = "a-long-enough-scrape-token";
    const server = await freshApp();
    const response = await server.request("http://localhost/metrics");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="metrics"');
  });

  it("refuses a token that is close but not the one", async () => {
    process.env.METRICS_ENABLED = "true";
    process.env.METRICS_TOKEN = "a-long-enough-scrape-token";
    const server = await freshApp();
    for (const offered of [
      "a-long-enough-scrape-toke",
      "a-long-enough-scrape-tokenn",
      "A-long-enough-scrape-token",
      "",
    ]) {
      const response = await server.request("http://localhost/metrics", {
        headers: { authorization: `Bearer ${offered}` },
      });
      expect(response.status, `${offered || "an empty token"} must be refused`).toBe(401);
    }
  });

  it("answers the token it was given", async () => {
    process.env.METRICS_ENABLED = "true";
    process.env.METRICS_TOKEN = "a-long-enough-scrape-token";
    const server = await freshApp();
    const response = await server.request("http://localhost/metrics", {
      headers: { authorization: "Bearer a-long-enough-scrape-token" },
    });
    expect(response.status).toBe(200);
  });

  /**
   * Over a real socket, because the hole was in what the adapter does with a
   * raw request line and `app.request()` never has one. The frontend nginx
   * reads `/api/..\metrics` as an /api path and proxies it; the adapter read
   * the backslash as a slash, resolved the `..`, and answered with every
   * number this process keeps — from the internet, with no token set.
   */
  it("answers only a request line that asked for /metrics itself", async () => {
    process.env.METRICS_ENABLED = "true";
    delete process.env.METRICS_TOKEN;
    const listener = serve({ fetch: (await freshApp()).fetch, port: 0, hostname: "127.0.0.1" });
    await once(listener, "listening");
    const { port } = listener.address() as AddressInfo;
    const ask = (target: string) =>
      new Promise<string>((resolve, reject) => {
        let answer = "";
        const socket = connect(port, "127.0.0.1", () => {
          socket.end(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => (answer += chunk));
        socket.on("end", () => resolve(answer));
        socket.on("error", reject);
      });
    try {
      for (const target of [
        "/api/..\\metrics",
        "/health/..\\metrics",
        "/api/../metrics",
        "/api/%2e%2e/metrics",
      ]) {
        const answer = await ask(target);
        expect(answer, target).toMatch(/^HTTP\/1\.1 404 /);
        expect(answer, target).not.toContain("simple_balance_");
      }
      for (const target of ["/metrics", "/metrics?scrape=1"]) {
        const answer = await ask(target);
        expect(answer, target).toMatch(/^HTTP\/1\.1 200 /);
        expect(answer, target).toContain("simple_balance_");
      }
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});
