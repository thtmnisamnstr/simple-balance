import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Two things only the single container answers: the browser app's own pages,
 * and the violation reports a rehearsing policy asks browsers to send.
 *
 * The pages exist only in production with a built bundle beside the process,
 * and `npm run verify` runs this before the build, so the bundle is made here:
 * a scratch directory holding the shell and one file beside it, made the
 * working directory for as long as this file runs, because that is where the
 * server looks for it. The repository's own `dist/` is never touched.
 */
const environment = { ...process.env };
const startedIn = process.cwd();
let bundle = "";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Metrics = typeof import("../src/server/metrics.js");
let app: App;
let metrics: Metrics;

beforeAll(async () => {
  bundle = mkdtempSync(path.join(tmpdir(), "simple-balance-pages-"));
  mkdirSync(path.join(bundle, "dist", "client", "assets"), { recursive: true });
  writeFileSync(
    path.join(bundle, "dist", "client", "index.html"),
    "<!doctype html><title>shell</title>",
  );
  writeFileSync(path.join(bundle, "dist", "client", "favicon.svg"), "<svg></svg>");
  process.chdir(bundle);

  Object.assign(process.env, {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
    APP_BASE_URL: "https://books.example",
    AUTH_SECRET: "metrics-http-pages-secret-at-least-32-characters",
    AUTH_MODE: "local",
    SB_CSP_REPORT_ONLY: "true",
  });
  // Production says so about the rehearsal and about `NODE_ENV`, and neither
  // line is what this file is about.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.resetModules();
  app = ((await import("../src/server/api.js")) as { default: App }).default;
  metrics = await import("../src/server/metrics.js");
});

afterEach(() => {
  metrics.resetMetrics();
});

afterAll(() => {
  process.chdir(startedIn);
  rmSync(bundle, { recursive: true, force: true });
  process.env = { ...environment };
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The value a scrape would read for one series, summed over the series that match. */
async function reading(name: string, labels: Record<string, string> = {}) {
  const metric = (await metrics.registry.getMetricsAsJSON()).find(
    (candidate) => candidate.name === `simple_balance_${name}`,
  );
  return (metric?.values ?? [])
    .filter((value) =>
      Object.entries(labels).every(([label, wanted]) => value.labels[label] === wanted),
    )
    .reduce((sum, value) => sum + value.value, 0);
}

describe("a page of the browser app", () => {
  it("is counted as the shell, wherever in the app it was asked for", async () => {
    for (const page of ["/", "/budgets", "/settings/plan"]) {
      const response = await app.request(`http://localhost${page}`);
      expect(response.status, page).toBe(200);
      expect(await response.text(), page).toContain("<title>shell</title>");
    }

    expect(await reading("http_requests_total", { route: "spa_shell", status: "200" })).toBe(3);
    // The point of the label. Without it every one of these is filed here, so
    // a typo and a page load are the same series.
    expect(await reading("http_requests_total", { route: "unmatched" })).toBe(0);
  });

  it("counts a file beside the shell with it", async () => {
    const response = await app.request("http://localhost/favicon.svg");

    expect(response.status).toBe(200);
    expect(await reading("http_requests_total", { route: "spa_shell" })).toBe(1);
    expect(await reading("http_requests_total", { route: "unmatched" })).toBe(0);
  });

  it("leaves a request nothing answered as unmatched", async () => {
    // The shell answers a page load and nothing else: a write to a path no
    // route has is the miss `unmatched` is for.
    const response = await app.request("http://localhost/no-such-thing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(await reading("http_requests_total", { route: "unmatched", status: "404" })).toBe(1);
    expect(await reading("http_requests_total", { route: "spa_shell" })).toBe(0);
  });

  it("keeps a hashed asset that is not there under its own prefix", async () => {
    // A tab left open across an upgrade asks for an asset the new build does
    // not have, and the fallback answers it with the shell. That is counted
    // under `/assets/*`, as it was before the shell had a label of its own.
    const response = await app.request("http://localhost/assets/index-0000dead.js");

    expect(response.status).toBe(200);
    expect(await reading("http_requests_total", { route: "/assets/*" })).toBe(1);
    expect(await reading("http_requests_total", { route: "spa_shell" })).toBe(0);
  });
});

describe("a violation report", () => {
  const report = (body: unknown, contentType = "application/csp-report") =>
    app.request("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify(body),
    });

  it("is counted under the directive it names, in either shape a browser sends", async () => {
    await report({
      "csp-report": {
        "blocked-uri": "https://js.stripe.com/v3",
        "violated-directive": "script-src-elem",
      },
    });
    await report(
      [
        {
          type: "csp-violation",
          body: { blockedURL: "https://m.stripe.com/6", effectiveDirective: "connect-src" },
        },
        {
          type: "csp-violation",
          body: { blockedURL: "https://q.stripe.com/", effectiveDirective: "connect-src" },
        },
      ],
      "application/reports+json",
    );

    expect(await reading("csp_violations_total", { directive: "script-src-elem" })).toBe(1);
    // One delivery, two violations: what is counted is what the policy
    // would have blocked, not how the browser batched telling us.
    expect(await reading("csp_violations_total", { directive: "connect-src" })).toBe(2);
  });

  it("reads the directive's name and not the sources an older browser writes after it", async () => {
    await report({
      "csp-report": { "violated-directive": "img-src 'self' data: https:" },
    });

    expect(await reading("csp_violations_total", { directive: "img-src" })).toBe(1);
  });

  it("files a violation under the directive that applied, not the fallback it inherited", async () => {
    // The policy has no font-src unless ads are served, so a blocked font falls
    // back to default-src, and a browser on the older convention says so in
    // `violated-directive` while `effective-directive` names the font. Counted
    // under default-src, every fallback would look like the same violation.
    await report({
      "csp-report": {
        "violated-directive": "default-src 'self'",
        "effective-directive": "font-src",
      },
    });

    expect(await reading("csp_violations_total", { directive: "font-src" })).toBe(1);
    expect(await reading("csp_violations_total", { directive: "default-src" })).toBe(0);
  });

  it("never makes a label of what the caller wrote", async () => {
    // Anybody can post here. A directive that is not one, a name built to be a
    // fresh series every time, and a field of the wrong type are all `other`.
    const invented = "made-up-directive-0f3c9a";
    await report({ "csp-report": { "violated-directive": invented } });
    await report({ "csp-report": { "effective-directive": "SCRIPT-SRC-ELEM\nforged line" } });
    await report({ "csp-report": { "violated-directive": { nested: "object" } } });

    expect(await reading("csp_violations_total", { directive: "other" })).toBe(2);
    // Matched without regard to case, because a directive's name is
    // case-insensitive, and still only ever to a name on the list.
    expect(await reading("csp_violations_total", { directive: "script-src-elem" })).toBe(1);
    expect(await metrics.registry.metrics()).not.toContain(invented);
  });
});
