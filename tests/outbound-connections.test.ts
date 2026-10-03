import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./support/source.js";

/**
 * The promise in `docs/standards/operations.md` §One process, one database:
 * this image makes no outbound connection nobody configured.
 *
 * It carried "*Not checked mechanically*" for four releases, and the reason
 * given was fair — an allow-list of network calls did not exist. This release
 * is what changed that. Stripe arrives as a *library* rather than a URL, which
 * is the first dependency able to open a socket without anything in this
 * repository spelling out a host, and the way that was made safe was to confine
 * it to one module. That confinement is the thing worth holding, because it is
 * what makes the promise answerable by reading one file instead of auditing
 * every call site.
 *
 * Two checks, and neither is the whole rule. A reviewer still has to notice a
 * *new* vendor library, because no test can know that a package it has never
 * heard of talks to the network. What these stop is the two ways the existing
 * promise decays: a bare `fetch` appearing in the server, and Stripe spreading
 * out of the module that owns it.
 */
describe("what the server is able to connect to", () => {
  const server = sourceFiles("src/server");

  it("makes no bare network call of its own", () => {
    // `fetch(` and not `fetch` alone: `c.req.raw` and Hono's own handlers name
    // the type in places, and a rule that fired on the word would be turned off
    // rather than obeyed.
    const callers = server
      .filter((file) => /(?<![.\w])fetch\s*\(/.test(file.code))
      .map((file) => file.path);
    expect(
      callers,
      "a call here is an outbound connection no setting describes; if it is deliberate, it belongs behind a setting and in operations.md's list",
    ).toEqual([]);
    // The census is really reading something, so a broken matcher is a failure
    // rather than a silent pass.
    expect(server.length).toBeGreaterThan(20);
  });

  /**
   * One module imports the vendor, so `grep -rn 'from "stripe"' src` answers
   * the whole question of what this process says to Stripe. Spread across three
   * services it would still work and the promise would stop being checkable,
   * which is the kind of decay that has no symptom.
   */
  it("keeps the one vendor library that opens sockets to one module", () => {
    const importers = server
      .filter((file) => /from "stripe"/.test(file.code))
      .map((file) => file.path);
    expect(importers).toEqual(["src/server/stripe.ts"]);
  });

  /**
   * And that module turns the vendor's own telemetry off.
   *
   * The SDK enables it by default and reports request timings back to Stripe —
   * harmless, and a connection nobody configured, which is the one thing the
   * promise is about. It is one line and it is the line most likely to be lost
   * to a refactor of the client options.
   */
  it("declines the vendor's telemetry", () => {
    const stripe = readFileSync("src/server/stripe.ts", "utf8");
    expect(stripe).toMatch(/telemetry:\s*false/);
  });
});
