import { serve } from "@hono/node-server";
import app from "./api.js";
import { getConfig } from "./config.js";
import { closeDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { checkMailTransport, closeMail } from "./mail.js";
import { isLocalBootstrapOpen } from "./auth-policy.js";
import { getOwnerSetupToken } from "./setup-token.js";
import { createGracefulShutdown } from "./server-lifecycle.js";

async function main() {
  const config = getConfig();
  await runMigrations();
  await checkMailTransport();
  if (
    config.isProduction &&
    config.localAuthEnabled &&
    (await isLocalBootstrapOpen())
  ) {
    console.info(`First-run setup code: ${getOwnerSetupToken()}`);
    console.info(
      "Use it to create the first account. It stops working once one exists; after that, ALLOWED_EMAILS decides who may register.",
    );
  }
  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.isProduction ? "0.0.0.0" : "127.0.0.1",
  });
  console.info(
    `Simple Balance API listening on port ${config.port} (public origin ${config.baseUrl})`,
  );

  const shutdown = createGracefulShutdown({
    server,
    closeResources: async () => {
      await closeMail();
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
