import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/server/api.js";
import { httpRequests, registry, resetMetrics } from "../src/server/metrics.js";

/**
 * What this deployment says about itself, and what it must never say.
 *
 * The rule that matters is the second one. A metric is read by whoever can
 * reach the scrape endpoint, which is not the person whose ledger it counts, so
 * a label carrying a user id, an email or an account name would publish through
 * the monitoring system exactly what every query in `src/server/services`
 * scopes by actor to keep private. Nothing in `src` does that today and this is
 * what keeps it that way — a new label is a decision that has to survive
 * reading this list.
 *
 * The other half is cardinality, which is the same defect wearing a cost rather
 * than a privacy label: a series per account id is a monitoring system that
 * falls over on a ledger somebody actually uses.
 */
const FORBIDDEN_LABELS = [
  "user",
  "userid",
  "user_id",
  "actor",
  "email",
  "account",
  "accountid",
  "account_id",
  "payee",
  "category",
  "id",
  "name",
  "amount",
  "currency",
];

/** A label whose values a person's data could ever supply. */
const looksIdentifying = (label: string) => FORBIDDEN_LABELS.includes(label.toLowerCase());

describe("the metric registry", () => {
  it("labels nothing with somebody's identity", async () => {
    const metrics = await registry.getMetricsAsJSON();
    const offenders = metrics.flatMap((metric) =>
      // `component` and the default labels are added by us and are a closed set
      // of two, so they are read the same way as any other label rather than
      // exempted: if one of them ever became identifying, this should fail.
      (metric.aggregator === "omit" ? [] : ((metric as { labelNames?: string[] }).labelNames ?? []))
        .filter((label) => looksIdentifying(label))
        .map((label) => `${metric.name} has a ${label} label`),
    );
    expect(offenders).toEqual([]);
  });

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
});
