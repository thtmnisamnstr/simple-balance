import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../src/server/api.js";
import { createAttemptLimiter } from "../../src/server/http-security.js";
import { registry } from "../../src/server/metrics.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The success half of what `tests/metrics-http.test.ts` checks against
 * stand-ins, against a database that really answers.
 *
 * `docs/standards/code/observability.md` §1.6: a metric proved only by its
 * failure is not proved, because a counter that was never wired up leaves the
 * success series absent in exactly the way one nothing has reached yet does.
 * The unit tier stands a statement in for the database; this is the statement.
 */
const integration = describe.skipIf(!process.env.TEST_DATABASE_URL);
const scratch = scratchDatabase("metrics_http");

/** The value a scrape would read for one series, summed over the series that match. */
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

integration("the HTTP surface against a real database", () => {
  beforeAll(() => scratch.create());
  afterAll(() => scratch.drop());

  it("answers ready, and records the answer from the statement it ran", async () => {
    const before = await reading("readiness_checks_total", { outcome: "ready" });

    const response = await app.request("http://localhost/health/ready");

    expect(response.status).toBe(200);
    expect(await reading("readiness_checks_total", { outcome: "ready" })).toBe(before + 1);
    expect(await reading("ready")).toBe(1);
  });

  it("counts no fallback while the shared attempt store answers", async () => {
    const before = await reading("rate_limit_store_failures_total");
    const limiter = createAttemptLimiter({ max: 2, windowMs: 60_000 });

    // Two inside the allowance, each asked of the table every replica shares,
    // and a third past it. None of them fell back to this process's own tally.
    await expect(limiter.take("metrics-http-integration")).resolves.toBe(true);
    await expect(limiter.take("metrics-http-integration")).resolves.toBe(true);
    await expect(limiter.take("metrics-http-integration")).resolves.toBe(false);
    await limiter.clear("metrics-http-integration");

    expect(await reading("rate_limit_store_failures_total")).toBe(before);
  });
});
