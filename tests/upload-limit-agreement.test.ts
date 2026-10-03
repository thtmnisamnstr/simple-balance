import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { apiRequestBodyLimit } from "../src/server/http-security.js";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * Three limits sit in front of a CSV import, and the two outer ones have to be
 * at least the inner one.
 *
 * The application sizes its own limit for the import routes at
 * `CSV_MAX_BYTES` x 6 plus 64 KiB, because a CSV arrives inside a JSON string
 * and worst-case escaping is six bytes per byte. Whatever terminates TLS sees
 * the body first, and whatever proxies it sees it second. Either one set below
 * the application's limit turns an import the product advertises into a 413
 * with nothing on screen to explain it — the request never reaches the code
 * that knows what the limit is or how to say so.
 *
 * The defect this was written for was a unit, not a number. nginx's `61m` is
 * binary and Caddy's `61MB` is decimal, so the two spellings that look
 * identical were 63,963,136 and 61,000,000 — and the application accepts
 * 62,980,096, which falls between them. A CSV of 61.5 MB was accepted by the
 * API, refused by the terminator, and correct according to both files.
 */

/** nginx's `size` suffixes: bare bytes, `k`, `m`, `g`, all binary. */
function nginxBytes(value: string): number {
  const match = /^(\d+)([kKmMgG]?)$/.exec(value.trim());
  expect(match, `not an nginx size: ${value}`).not.toBeNull();
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match![2]!.toLowerCase()]!;
  return Number(match![1]) * scale;
}

/** Caddy uses go-humanize: `MB` is a million, `MiB` is 1,048,576. */
function caddyBytes(value: string): number {
  const match = /^(\d+)\s*([KMGT]i?B|B)?$/.exec(value.trim());
  expect(match, `not a Caddy size: ${value}`).not.toBeNull();
  const scales: Record<string, number> = {
    "": 1,
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  const unit = match![2] ?? "";
  expect(scales[unit], `unknown Caddy unit in ${value}`).toBeDefined();
  return Number(match![1]) * scales[unit]!;
}

/** The value of an `ENV`, an `x: y`, or a `${NAME:-default}` in a file. */
function setting(relative: string, pattern: RegExp): string {
  const match = pattern.exec(read(relative));
  expect(match, `${pattern} found nothing in ${relative}`).not.toBeNull();
  return match![1]!;
}

describe("what the layers in front of an import will carry", () => {
  // No environment is set in this tier, so this is the limit at the default
  // CSV_MAX_BYTES — which is the number both deployment files are written
  // against and the one their comments quote.
  const server = apiRequestBodyLimit("/api/v1/csv/stage");

  it("is a real number, sized from the CSV limit rather than the generic one", () => {
    expect(server).toBe(10 * 1024 * 1024 * 6 + 64 * 1024);
    expect(server).toBeGreaterThan(apiRequestBodyLimit("/api/v1/accounts"));
  });

  it("is not more than the frontend image's nginx will pass", () => {
    const nginx = nginxBytes(
      setting("deploy/docker/frontend.Dockerfile", /^ENV SB_MAX_UPLOAD_SIZE=(\S+)$/m),
    );
    expect(nginx, "SB_MAX_UPLOAD_SIZE is below the API's own limit").toBeGreaterThanOrEqual(server);
  });

  it("is not more than the single profile's Caddy will pass", () => {
    const caddy = caddyBytes(
      setting(
        "deploy/compose/single/compose.caddy.yml",
        /MAX_BODY_SIZE: \$\{MAX_BODY_SIZE:-(\S+)\}/,
      ),
    );
    expect(caddy, "MAX_BODY_SIZE is below the API's own limit").toBeGreaterThanOrEqual(server);
  });

  /**
   * And the two terminators agree with each other exactly.
   *
   * Not merely "both are enough": they are the same ceiling described twice, so
   * a deployment cannot accept an import through one shape and refuse it
   * through the other. This is the assertion that catches a unit mistake, since
   * a decimal spelling large enough to pass the check above would still be a
   * different number from the binary one beside it.
   */
  it("is the same ceiling in both deployment shapes", () => {
    const nginx = nginxBytes(
      setting("deploy/docker/frontend.Dockerfile", /^ENV SB_MAX_UPLOAD_SIZE=(\S+)$/m),
    );
    const caddy = caddyBytes(
      setting(
        "deploy/compose/single/compose.caddy.yml",
        /MAX_BODY_SIZE: \$\{MAX_BODY_SIZE:-(\S+)\}/,
      ),
    );
    expect(caddy, "Caddy and nginx describe different ceilings").toBe(nginx);
  });
});
