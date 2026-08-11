import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getConfig } from "./config.js";
import { closeDb, getDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createRecurrenceScheduler } from "./recurrence-scheduler.js";
import { createGracefulShutdown } from "./server-lifecycle.js";

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

async function main() {
  const config = getConfig();
  // Also run from here, and not only from the API process, so a scheduler pod
  // that starts first works rather than failing on tables that do not exist
  // yet. One advisory lock means whichever process arrives first does the work
  // and the other waits for it.
  await runMigrations();
  const server = serve({
    fetch: health.fetch,
    port: config.port,
    hostname: "0.0.0.0",
  });
  console.info(
    `Simple Balance scheduler listening on port ${config.port} for health checks only`,
  );

  // Forced on rather than read from RECURRENCE_SCHEDULER. That flag exists to
  // turn the tick off on replicas that serve the API; a pod running this
  // entrypoint has no other job, and one started with the web Deployment's
  // environment copied across would otherwise sit there doing nothing.
  const scheduler = createRecurrenceScheduler({ enabled: true });

  const shutdown = createGracefulShutdown({
    server,
    closeResources: async () => {
      await scheduler.stop();
      await closeDb();
    },
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exitCode = 1;
});
