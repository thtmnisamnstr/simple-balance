import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoFiles } from "./support/source.js";

/**
 * The application's /metrics, never through the TLS terminator in front of it.
 *
 * The frontend image's nginx has always withheld it, and
 * `tests/dockerfile.test.ts` holds that by the location the template proxies.
 * The `single` profile's Caddy proxied every path, and the application checks
 * nothing but the optional METRICS_TOKEN, so METRICS_ENABLED=true without a
 * token published request rates, pool depth and every route's error count to
 * anybody with the address — while the compose file's comment said no
 * terminator in that profile proxied it. This is the Caddy half of that
 * rule, held the same way: read out of the files rather than restated here.
 *
 * What it reads is the shape. Whether Caddy answers 404 to /METRICS, to
 * /%6detrics and to //metrics as well as to /metrics was measured against
 * the image compose.caddy.yml pulls, Caddy 2.11, and is recorded beside the
 * matcher; a test without Caddy in it cannot repeat that.
 */

const caddyfiles = repoFiles((path) => path.startsWith("deploy/") && path.endsWith("/Caddyfile"));

/** The lines that are not comments, trimmed. */
const code = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/** The paths the server registers the metrics route at, read from the source. */
const metricsRoutes = ["src/server/api.ts", "src/server/scheduler.ts"].flatMap((file) =>
  [
    ...readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(
      /\.get\(\s*"([^"]+)",\s*serveMetrics\s*\)/g,
    ),
  ].map((match) => match[1]!),
);

describe("what a Caddyfile in front of the application refuses", () => {
  it("finds the Caddyfiles, and the route it has to refuse", () => {
    expect(caddyfiles.map(({ path }) => path)).toContain("deploy/compose/single/Caddyfile");
    // Both entrypoints, one path. A second path would need a second matcher.
    expect(new Set(metricsRoutes)).toEqual(new Set(["/metrics"]));
  });

  it.each(caddyfiles.map((file) => [file.path, file] as const))(
    "answers /metrics and everything under it with a 404 of its own, in %s",
    (path, file) => {
      const lines = code(file.text);
      const proxy = lines.findIndex((line) => line.startsWith("reverse_proxy "));
      expect(proxy, `${path} proxies something`).toBeGreaterThan(-1);

      // A named path matcher naming the route and everything under it.
      const matcher = lines
        .map((line) => /^@([\w-]+) path (.+)$/.exec(line))
        .find((match) => match !== null);
      expect(matcher, `${path} names a path matcher`).toBeDefined();
      const paths = matcher![2]!.split(/\s+/);
      for (const route of metricsRoutes) {
        expect(paths, path).toContain(route);
        expect(paths, path).toContain(`${route}/*`);
      }

      // Refused with Caddy's own static response, never handed upstream.
      // `respond` runs ahead of `reverse_proxy` in Caddy's directive order,
      // and is written ahead of it here too so the file reads as it runs.
      const refusal = lines.findIndex((line) => line === `respond @${matcher![1]} 404`);
      expect(refusal, `${path} responds 404 to @${matcher![1]}`).toBeGreaterThan(-1);
      expect(refusal, `${path} refuses before it proxies`).toBeLessThan(proxy);
    },
  );

  it.each(caddyfiles.map((file) => [file.path, file] as const))(
    "leaves Caddy's directive order alone, which is what the refusal relies on, in %s",
    (path, file) => {
      // A global `order` moving respond after reverse_proxy, or a `route` or
      // `handle` block taking the proxy out of the sorted order, would let the
      // proxy answer first without anything in the site block changing.
      for (const line of code(file.text)) {
        expect(line, path).not.toMatch(/^order\s/);
        expect(line, path).not.toMatch(/^(route|handle|handle_path)\b/);
      }
    },
  );

  it("no longer says, in the compose file, that nothing in the profile proxies it", () => {
    const compose = readFileSync(
      new URL("../deploy/compose/single/compose.yml", import.meta.url),
      "utf8",
    );
    expect(compose).not.toContain("no terminator in this profile proxies /metrics");
    expect(compose).toContain("The Caddyfile refuses /metrics");
  });
});
