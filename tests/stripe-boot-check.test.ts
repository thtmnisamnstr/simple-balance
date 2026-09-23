import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Both entrypoints check Stripe's two prices before they start serving.
 *
 * The price check otherwise first runs when somebody opens the plan tab, or on
 * the scheduler's first billing sweep, so a price id from the wrong mode or the
 * wrong account was found by a customer rather than by the operator reading the
 * startup log. An API-only process runs no sweep at all, which left it with no
 * check until a page asked. The check never refuses to start — an unreachable
 * Stripe is a warning and a mismatch stops sales, not the process — so what is
 * held here is only that it is asked, and asked before the port is open.
 *
 * Everything each entrypoint talks to is stood in for; the order they are
 * reached in is the whole assertion.
 */
const order = vi.hoisted(() => [] as string[]);
const armed = vi.hoisted(() => ({ done: false }));

vi.mock("@hono/node-server", () => ({
  serve: () => {
    order.push("serve");
    return {};
  },
}));
vi.mock("../src/server/db/migrate.js", () => ({
  runMigrations: async () => {
    order.push("migrate");
  },
}));
vi.mock("../src/server/db/client.js", () => ({ closeDb: async () => {}, getDb: () => ({}) }));
vi.mock("../src/server/services/accounts.js", () => ({
  reconcileArchivedAccountClosings: async () => 0,
}));
vi.mock("../src/server/api.js", () => ({ default: { fetch: () => new Response() } }));
vi.mock("../src/server/recurrence-scheduler.js", () => ({
  createRecurrenceScheduler: () => ({ enabled: true, stop: async () => {} }),
}));
vi.mock("../src/server/server-lifecycle.js", () => ({
  createGracefulShutdown: () => {
    armed.done = true;
    return () => {};
  },
}));
vi.mock("../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/stripe.js")>()),
  checkStripePrices: async () => {
    order.push("stripe");
    return true;
  },
}));

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  order.length = 0;
  armed.done = false;
  process.exitCode = 0;
});

async function start(entrypoint: "index" | "scheduler") {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "on").mockImplementation(() => process);
  await import(entrypoint === "index" ? "../src/server/index.js" : "../src/server/scheduler.js");
  await vi.waitFor(() => expect(armed.done).toBe(true));
}

describe("the Stripe price check at startup", () => {
  it.each(["index", "scheduler"] as const)(
    "runs in the %s entrypoint once the schema is there and before it listens",
    async (entrypoint) => {
      await start(entrypoint);
      expect(order.filter((step) => step === "stripe")).toHaveLength(1);
      expect(order.indexOf("migrate")).toBeLessThan(order.indexOf("stripe"));
      expect(order.indexOf("stripe")).toBeLessThan(order.indexOf("serve"));
    },
  );
});
