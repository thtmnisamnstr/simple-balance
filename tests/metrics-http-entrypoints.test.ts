import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * What each entrypoint records about itself on the way up and on the way down.
 *
 * Readiness is checked once as the port opens, so `ready` says something true
 * from the first scrape; the mail relay and Stripe answers the startup checks
 * already get are kept where a scrape can read them; and a process dying on an
 * exception nothing caught writes its last line through the gate. All three
 * are the same in both entrypoints, so every case runs against both.
 *
 * Everything the entrypoints talk to is stood in for except mail and
 * configuration, as in `tests/scheduler-startup.test.ts`, plus a database whose
 * one statement each test decides the answer to.
 */
const database = vi.hoisted(() => ({
  execute: async (): Promise<unknown> => ({ rows: [] }),
}));
const stripe = vi.hoisted(() => ({
  pricesFit: true,
  unreadable: [] as string[] | null,
}));
const transport = vi.hoisted(() => ({
  verify: async (): Promise<unknown> => true,
  close: () => {},
}));
const armed = vi.hoisted(() => ({ done: false }));

vi.mock("nodemailer", () => ({ createTransport: () => transport }));
vi.mock("@hono/node-server", () => ({ serve: () => ({}) }));
vi.mock("../src/server/db/migrate.js", () => ({ runMigrations: async () => {} }));
vi.mock("../src/server/db/client.js", () => ({
  closeDb: async () => {},
  getDb: () => ({ execute: () => database.execute() }),
}));
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
  checkStripePrices: async () => stripe.pricesFit,
  checkStripeAccess: async () => stripe.unreadable,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  database.execute = async () => ({ rows: [] });
  stripe.pricesFit = true;
  stripe.unreadable = [];
  transport.verify = async () => true;
  armed.done = false;
  // Both entrypoints report a failed start through this field, and vitest
  // reads it when the run ends, so one left set would fail a green run.
  process.exitCode = 0;
});

const ENTRYPOINTS = [
  ["the API", "../src/server/index.js"],
  ["the scheduler", "../src/server/scheduler.js"],
] as const;

/**
 * Starts an entrypoint and waits for the last two things `main()` does — arm
 * its shutdown, then check readiness once — then hands back what it registered
 * on `process` and the registry it reported into. `answered: false` waits for
 * the first alone, for a database that never answers the second.
 */
async function start(entrypoint: string, { answered = true } = {}) {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const on = vi.spyOn(process, "on").mockImplementation(() => process);
  await import(entrypoint);
  await vi.waitFor(() => expect(armed.done).toBe(true));
  const metrics = await import("../src/server/metrics.js");
  if (answered) {
    await vi.waitFor(async () => expect(await reading(metrics, "readiness_checks_total")).toBe(1));
  }
  return { errors, on, metrics };
}

/** The value a scrape would read for one series, summed over the series that match. */
async function reading(
  metrics: typeof import("../src/server/metrics.js"),
  name: string,
  labels: Record<string, string> = {},
) {
  const metric = (await metrics.registry.getMetricsAsJSON()).find(
    (candidate) => candidate.name === `simple_balance_${name}`,
  );
  return (metric?.values ?? [])
    .filter((value) =>
      Object.entries(labels).every(([label, wanted]) => value.labels[label] === wanted),
    )
    .reduce((sum, value) => sum + value.value, 0);
}

describe.each(ENTRYPOINTS)("%s", (_name, entrypoint) => {
  describe("on an exception nothing caught", () => {
    /**
     * The shape a failed Drizzle query arrives in: a statement, the values
     * bound into it, and a message that repeats both. The value here is a
     * session token, which is what makes logging one whole a credential leak.
     */
    const failedQuery = () =>
      Object.assign(
        new Error(
          'Failed query: select * from "auth_session" where "token" = $1\nparams: a-live-session-token',
        ),
        {
          query: 'select * from "auth_session" where "token" = $1',
          params: ["a-live-session-token"],
          cause: new Error("Connection terminated unexpectedly"),
        },
      );

    it("writes its last line through the gate, narrowed like every other failure", async () => {
      const { errors, on } = await start(entrypoint);
      const monitor = on.mock.calls.find(([event]) => event === "uncaughtExceptionMonitor")?.[1] as
        | ((error: Error, origin: string) => void)
        | undefined;
      expect(monitor, "a monitor on uncaughtExceptionMonitor").toBeDefined();
      errors.mockClear();

      monitor!(failedQuery(), "uncaughtException");
      monitor!(failedQuery(), "unhandledRejection");

      const lines = errors.mock.calls.map((call) => call.map(String).join(" "));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/is stopping on an exception nothing caught/);
      expect(lines[1]).toMatch(/is stopping on a rejection nothing caught/);
      // The statement, so an operator knows what was running, and never the
      // token it was looking up.
      expect(lines.join("\n")).toContain('from "auth_session"');
      expect(lines.join("\n")).not.toContain("a-live-session-token");
    });

    it("is a monitor and nothing more, so the process still exits", async () => {
      const { on } = await start(entrypoint);
      const events = on.mock.calls.map(([event]) => event);

      // A listener on either of these would keep a broken process running.
      expect(events).not.toContain("uncaughtException");
      expect(events).not.toContain("unhandledRejection");
    });
  });

  describe("as its port opens", () => {
    it("reads ready at once, from a check that reached the database", async () => {
      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "ready")).toBe(1);
      expect(await reading(metrics, "readiness_checks_total", { outcome: "ready" })).toBe(1);
    });

    /**
     * Last, and not awaited in front of anything. Awaited before the scheduler
     * and the signal handlers, a database slow to answer — an idle connection
     * to one that has just failed over waits on TCP — left a process taking
     * requests that a SIGTERM killed outright rather than drained.
     */
    it("arms its shutdown without waiting for the check to answer", async () => {
      database.execute = () => new Promise(() => {});

      const { on, metrics } = await start(entrypoint, { answered: false });

      const events = on.mock.calls.map(([event]) => event);
      expect(events).toContain("SIGTERM");
      expect(events).toContain("SIGINT");
      expect(await reading(metrics, "readiness_checks_total")).toBe(0);
    });

    it("reads not ready at once, from a check that did not", async () => {
      database.execute = async () => {
        throw new Error("connect ECONNREFUSED");
      };

      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "ready")).toBe(0);
      expect(await reading(metrics, "readiness_checks_total", { outcome: "not_ready" })).toBe(1);
    });
  });

  describe("what the startup checks found", () => {
    it("says nothing about a relay or Stripe that is not configured", async () => {
      const { metrics } = await start(entrypoint);

      // No series rather than a 0: mail and billing are both optional, and a
      // deployment without them is a supported one rather than a broken one.
      expect(
        (await metrics.registry.getMetricsAsJSON()).find(
          (metric) => metric.name === "simple_balance_dependency_up",
        )?.values,
      ).toEqual([]);
    });

    it("records a relay that refused it", async () => {
      vi.stubEnv("SMTP_HOST", "smtp.example.com");
      vi.stubEnv("MAIL_FROM", "ledger@example.com");
      transport.verify = async () => {
        throw new Error("535 Authentication failed");
      };

      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "dependency_up", { dependency: "smtp" })).toBe(0);
    });

    it("records a relay that answered", async () => {
      vi.stubEnv("SMTP_HOST", "smtp.example.com");
      vi.stubEnv("MAIL_FROM", "ledger@example.com");

      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "dependency_up", { dependency: "smtp" })).toBe(1);
    });

    /** Billing on, which is what makes the two Stripe checks reach anything. */
    const withBilling = () => {
      vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_metrics_entrypoints");
      vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_metrics_entrypoints");
      vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_metrics_entrypoints");
      vi.stubEnv("STRIPE_PRICE_MONTHLY_ID", "price_monthly");
      vi.stubEnv("STRIPE_PRICE_YEARLY_ID", "price_yearly");
    };

    it("records prices that do not fit and a key that cannot read what it needs", async () => {
      withBilling();
      stripe.pricesFit = false;
      stripe.unreadable = ["Invoices"];

      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "dependency_up", { dependency: "stripe_prices" })).toBe(0);
      expect(await reading(metrics, "dependency_up", { dependency: "stripe_access" })).toBe(0);
    });

    /**
     * A Stripe that did not answer passed neither check, so both read 0. The
     * access check once answered an empty list here — the same as a key that
     * can read everything — and the series read 1 for a check nobody made.
     */
    it("records a Stripe that could not be reached as passing neither check", async () => {
      withBilling();
      stripe.pricesFit = false;
      stripe.unreadable = null;

      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "dependency_up", { dependency: "stripe_prices" })).toBe(0);
      expect(await reading(metrics, "dependency_up", { dependency: "stripe_access" })).toBe(0);
    });

    it("records prices that fit and a key that can read everything", async () => {
      withBilling();

      const { metrics } = await start(entrypoint);

      expect(await reading(metrics, "dependency_up", { dependency: "stripe_prices" })).toBe(1);
      expect(await reading(metrics, "dependency_up", { dependency: "stripe_access" })).toBe(1);
    });
  });
});

/**
 * The one failure no response can carry: Better Auth hands sending a reset or
 * confirmation link off to run after it has answered, so the person sees the
 * same "check your inbox" whether it worked or not, and the request counter
 * recorded a success before the work had begun.
 */
describe("a task the auth library ran after answering", () => {
  it("is counted as an internal error when it fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getAuth } = await import("../src/server/auth.js");
    const metrics = await import("../src/server/metrics.js");
    const { handler } = (
      getAuth().options as {
        advanced?: { backgroundTasks?: { handler: (task: Promise<unknown>) => void } };
      }
    ).advanced!.backgroundTasks!;

    handler(Promise.reject(new Error("the link could not be built")));
    handler(Promise.resolve());

    await vi.waitFor(async () =>
      expect(await reading(metrics, "internal_errors_total", { surface: "auth_background" })).toBe(
        1,
      ),
    );
  });
});
