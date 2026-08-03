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
  if (!config.isProduction) {
    // Several protections read this rather than being switched on separately:
    // the first-account setup code is not demanded, the rate limiter is off,
    // and secure cookies are not required. That is right for `npm run dev` and
    // wrong, silently, for a built server somebody starts by hand.
    console.warn(
      "NODE_ENV is not production. The first-run setup code is not required, " +
        "sign-in attempts are not rate limited, and cookies are not marked " +
        "secure. Set NODE_ENV=production before exposing this to anybody.",
    );
  }
  await runMigrations();
  await checkMailTransport();
  if (config.isProduction && !config.trustProxy) {
    // Sign-in attempts are counted per client address, and with no trusted
    // proxy that address is the other end of the TCP connection. Reached
    // directly that is each caller, which is what this default is for. Reached
    // through a reverse proxy it is the proxy, every time, so everybody shares
    // one allowance and one stranger can spend it for the rest.
    console.info(
      "TRUST_PROXY is off, so sign-in rate limits count against the address " +
        "connecting to this process. Set TRUST_PROXY=true if a reverse proxy " +
        "sits in front, or every visitor will share one allowance.",
    );
  }
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
