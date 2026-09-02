import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getConfig } from "./config.js";
import { closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { checkMailTransport, closeMail, mailEnabled } from "./mail.js";
import { setMetricsComponent, startDefaultMetrics } from "./metrics.js";
import { serveMetrics } from "./metrics-route.js";
import { createRecurrenceScheduler } from "./recurrence-scheduler.js";
import { createGracefulShutdown } from "./server-lifecycle.js";
import { log } from "./log.js";

/**
 * The scheduler on its own, for a deployment that has split the single
 * container into pieces. It runs the same tick the API process runs; the only
 * difference is that this one serves nothing else.
 *
 * The two health routes are here so a Kubernetes Deployment can probe it over
 * HTTP like anything else. Nothing else is mounted, so a pod running this
 * cannot answer an API request even if a Service is pointed at it by mistake.
 */
const health = new Hono();
health.get("/health/live", (c) => c.json({ status: "ok" }));
health.get("/health/ready", async (c) => {
  try {
    await getDb().execute(sql`select 1`);
    return c.json({ status: "ready" });
  } catch {
    return c.json({ status: "not_ready" }, 503);
  }
});

setMetricsComponent("scheduler");
startDefaultMetrics();

/**
 * What this entrypoint deliberately does not do, said here because an omission
 * reads as an oversight.
 *
 * `reconcileArchivedAccountClosings()` stays with the API process. It is a
 * repair of somebody's postings rather than anything the schedule needs, the
 * API image runs in every split deployment that runs this one, and running it
 * from every scheduler replica would multiply a write none of them is about.
 * The `TRUST_PROXY` notice and the first-run setup code are the sign-in
 * process's, and this one serves no sign-in: it answers two health routes and
 * nothing else, so it counts no rate limit, sets no cookie, and has no sign-up
 * form for a code to be typed into. Printing the code from here would put it in
 * a second log for a claim nobody can make against this port.
 */
async function main() {
  const config = getConfig();
  // The same endpoint the API mounts, and the reason this process needs one of
  // its own: proposals, reminders and mail all happen here, so a split
  // deployment scraping only the API would be watching the process that does
  // none of the work the schedule exists for.
  //
  // Registered here rather than beside the health routes because that is where
  // the configuration has been read. A module-level `getConfig()` would refuse
  // an unconfigured environment at import time, which is a worse failure than
  // the same refusal one line into `main`.
  if (config.metrics.enabled) health.get("/metrics", serveMetrics);
  // Also run from here, and not only from the API process, so a scheduler pod
  // that starts first works rather than failing on tables that do not exist
  // yet. One advisory lock means whichever process arrives first does the work
  // and the other waits for it.
  await runMigrations();
  if (mailEnabled()) {
    // The API checks the transport so a wrong address is found by the operator
    // rather than by somebody locked out. This process has the stronger claim
    // on the same check: it is the one that sends every scheduled message, and
    // nobody is waiting on a reminder, so a relay refusing it fails silently
    // and indefinitely. It still only logs, because mail is optional and the
    // schedule is not: proposing rows works whether or not the relay answers.
    await checkMailTransport();
  } else {
    // Said out loud for the same reason the API says RECURRENCE_SCHEDULER is
    // off. A scheduler with no mail server proposes rows and sends nothing,
    // which is a supported deployment and also exactly what a hand-assembled
    // one looks like when the SMTP settings were given to the API container and
    // not to this one. The two are indistinguishable in a log that says
    // nothing.
    log.info(
      "No mail server is configured, so this scheduler proposes recurring " +
        "transactions and sends none of the reminders or proposal notices. " +
        "They are still stored, and start arriving once SMTP_HOST and " +
        "MAIL_FROM are set on this container as well as on the API.",
    );
  }
  const server = serve({
    fetch: health.fetch,
    port: config.port,
    // Loopback outside production, exactly as the API entrypoint binds: this
    // little server carries /metrics when metrics are on, and a development
    // scheduler answering every interface publishes counters to whoever is on
    // the network without anybody deciding that.
    hostname: config.isProduction ? "0.0.0.0" : "127.0.0.1",
  });
  log.info(`Simple Balance scheduler listening on port ${config.port} for health checks only`);

  // Forced on rather than read from RECURRENCE_SCHEDULER. That flag exists to
  // turn the tick off on replicas that serve the API; a pod running this
  // entrypoint has no other job, and one started with the web Deployment's
  // environment copied across would otherwise sit there doing nothing.
  const scheduler = createRecurrenceScheduler({ enabled: true });

  const shutdown = createGracefulShutdown({
    server,
    closeResources: async () => {
      // First, because the loop holds a connection from a pool closeDb() is
      // about to end. Mail in between: the transport is pooled and this process
      // opened one by checking it at startup, so leaving it behind would hold
      // sockets open past the drain the deadline is measured against.
      await scheduler.stop();
      closeMail();
      await closeDb();
    },
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (error) => {
  // Same rule as the API entrypoint: a Drizzle error whole prints its bound
  // parameters, and a scheduler tick's parameters are drafts and reminders.
  log.failure("The scheduler could not start", error);
  await closeDb();
  process.exitCode = 1;
});
