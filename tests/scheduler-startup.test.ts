import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What the scheduler entrypoint finds out at startup.
 *
 * It is the process that sends every scheduled message, and it used to run none
 * of the checks the API entrypoint runs: a relay refusing its credentials was
 * discovered by nobody, because the person a reminder was for is not waiting
 * for it and never learns it did not arrive. The API's own check exists for the
 * weaker case, somebody locked out of a password reset, and that one at least
 * has somebody watching.
 *
 * Everything the entrypoint talks to is stood in for except mail and
 * configuration, which are the two this is about.
 */
const transport = vi.hoisted(() => ({
  verify: vi.fn(async () => true),
  close: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  closeResources: undefined as (() => Promise<void>) | undefined,
  ticking: false,
}));

vi.mock("nodemailer", () => ({ createTransport: () => transport }));
vi.mock("@hono/node-server", () => ({ serve: () => ({}) }));
vi.mock("../src/server/db/migrate.js", () => ({ runMigrations: async () => {} }));
vi.mock("../src/server/db/client.js", () => ({ closeDb: async () => {}, getDb: () => ({}) }));
vi.mock("../src/server/recurrence-scheduler.js", () => ({
  createRecurrenceScheduler: () => {
    lifecycle.ticking = true;
    return { enabled: true, stop: async () => {} };
  },
}));
vi.mock("../src/server/server-lifecycle.js", () => ({
  createGracefulShutdown: (options: { closeResources: () => Promise<void> }) => {
    lifecycle.closeResources = options.closeResources;
    return () => {};
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  transport.verify.mockReset();
  transport.verify.mockResolvedValue(true);
  transport.close.mockReset();
  lifecycle.closeResources = undefined;
  lifecycle.ticking = false;
  // The entrypoint reports a failed start by setting this, and vitest reads the
  // same field when the run ends, so one left behind would fail a green run.
  process.exitCode = 0;
});

/**
 * Imports the entrypoint, which starts itself, and waits for it to get as far
 * as arming its shutdown. Reaching that line is also what says `main()` did not
 * throw on the way.
 */
async function startScheduler() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  // Left alone, four starts leave eight signal listeners behind and Node warns
  // about a leak that belongs to the test file rather than to the process.
  vi.spyOn(process, "on").mockImplementation(() => process);
  await import("../src/server/scheduler.js");
  await vi.waitFor(() => expect(lifecycle.closeResources).toBeDefined());
  const said = (spy: typeof info) => spy.mock.calls.map((call) => String(call[0])).join("\n");
  return { info: said(info), error: said(error) };
}

describe("a scheduler started against a mail server", () => {
  it("says so when the relay refuses it, and goes on proposing", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("MAIL_FROM", "ledger@example.com");
    transport.verify.mockRejectedValue(new Error("Connection refused"));

    const { error } = await startScheduler();

    expect(error).toContain("SMTP_HOST is set but the mail server refused the connection");
    // A refused relay is not a reason to stop proposing rows: the ledger works
    // whether or not mail does, which is why the check logs rather than throws.
    expect(lifecycle.ticking).toBe(true);
  });

  it("names the address it will be sending as when the relay answers", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("MAIL_FROM", "ledger@example.com");

    const { info, error } = await startScheduler();

    expect(info).toContain("Mail is configured");
    expect(info).toContain("ledger@example.com");
    expect(error).toBe("");
  });

  it("closes the connection it opened when it shuts down", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("MAIL_FROM", "ledger@example.com");

    await startScheduler();
    await lifecycle.closeResources!();

    expect(transport.close).toHaveBeenCalled();
  });
});

describe("a scheduler started without one", () => {
  /**
   * The hand-assembled split deployment is the case: the SMTP settings went to
   * the API container, which needs them for a password reset, and not to this
   * one, which is the only process that sends a reminder. Both look healthy.
   */
  it("says it will send nothing, rather than looking the same as a working one", async () => {
    const { info, error } = await startScheduler();

    expect(info).toContain("No mail server is configured");
    expect(info).toContain("SMTP_HOST");
    expect(error).toBe("");
    expect(lifecycle.ticking).toBe(true);
  });
});

/**
 * The scheduler's own `/metrics`, which is half of a claim made in three places.
 *
 * `operations.md`, the chart's README and the CHANGELOG all say both entrypoints
 * answer, and that a split deployment scraping only the API watches the process
 * doing none of the scheduled work. Every metrics test until now drove the API,
 * so the half that carries ticks, proposals and mail was asserted and never
 * checked.
 */
describe("the scheduler's metrics endpoint", () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.resetModules();
  });

  it("is registered on the scheduler's health app when metrics are on", async () => {
    const source = await readFile(new URL("../src/server/scheduler.ts", import.meta.url), "utf8");
    // Read rather than driven: `main()` runs migrations and opens a listener,
    // and the property worth holding is that the route is mounted on the same
    // app the health probes are, behind the same setting the API uses.
    expect(source).toContain('health.get("/metrics", serveMetrics)');
    expect(source).toContain("if (config.metrics.enabled)");
    expect(source).toContain('setMetricsComponent("scheduler")');
  });
});
