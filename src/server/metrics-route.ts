import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getConfig } from "./config.js";
import { metricsContentType, metricsText } from "./metrics.js";

/**
 * `GET /metrics`, for whichever process mounts it.
 *
 * Registered only when `METRICS_ENABLED=true`, rather than registered and
 * refusing. A deployment that never asked for this has no such route, which is
 * the same way an MCP tool outside a token's scope is absent rather than
 * forbidden: nothing to find is a better answer than something to probe.
 *
 * Both entrypoints mount it. The API's numbers are requests, tools and ledger
 * writes; the scheduler's are ticks, proposals and mail, and a split deployment
 * that scraped only the API would be watching the process that does none of the
 * work the schedule exists for.
 */
export async function serveMetrics(c: Context) {
  const { token } = getConfig().metrics;
  if (token && !bearerMatches(c.req.header("authorization"), token)) {
    // `WWW-Authenticate`, because a 401 without it tells a client it needs
    // credentials and not which kind. Prometheus' own scrape config sends a
    // bearer token, so naming the scheme is what makes the failure fixable
    // from the scraper's side.
    c.header("WWW-Authenticate", 'Bearer realm="metrics"');
    return c.text("Unauthorized", 401);
  }
  c.header("Content-Type", metricsContentType);
  // Never cached. A scrape is a reading of this instant, and an intermediary
  // that held one would report a healthy process long after it stopped being
  // one.
  c.header("Cache-Control", "no-store");
  return c.body(await metricsText());
}

/**
 * Compare a bearer token without leaking its length or its prefix.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees two buffers of
 * the same size: it throws on a length mismatch, and catching that throw would
 * be the length comparison this is trying to avoid.
 */
function bearerMatches(header: string | undefined, expected: string) {
  const offered = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(offered), digest(expected));
}
