import { serve } from "@hono/node-server";
import app from "./api.js";
import { getConfig, isRegistrationClosed, isRegistrationOpenToAnyone } from "./config.js";
import { closeDb } from "./db/client.js";
import { reconcileArchivedAccountClosings } from "./services/accounts.js";
import { runMigrations } from "./db/migrate.js";
import { checkMailTransport, closeMail } from "./mail.js";
import { isLocalBootstrapOpen } from "./auth-policy.js";
import { getOwnerSetupToken } from "./setup-token.js";
import { createRecurrenceScheduler } from "./recurrence-scheduler.js";
import { createGracefulShutdown } from "./server-lifecycle.js";
import { log } from "./log.js";

async function main() {
  const config = getConfig();
  if (!config.isProduction) {
    // Several protections read this rather than being switched on separately:
    // the first-account setup code is not demanded, the rate limiter is off,
    // and secure cookies are not required. That is right for `npm run dev` and
    // wrong, silently, for a built server somebody starts by hand.
    log.warn(
      "NODE_ENV is not production. The first-run setup code is not required, " +
        "sign-in attempts are not rate limited, and cookies are not marked " +
        "secure. Set NODE_ENV=production before exposing this to anybody.",
    );
  }
  await runMigrations();
  const reclosed = await reconcileArchivedAccountClosings();
  if (reclosed) {
    log.info(
      `Re-closed ${reclosed} archived account(s) that were holding a balance ` +
        "on a date the dashboard had already stopped counting.",
    );
  }
  await checkMailTransport();
  if (config.isProduction && !config.trustProxy) {
    // Sign-in attempts are counted per client address, and with no trusted
    // proxy that address is the other end of the TCP connection. Reached
    // directly that is each caller, which is what this default is for. Reached
    // through a reverse proxy it is the proxy, every time, so everybody shares
    // one allowance and one stranger can spend it for the rest.
    log.info(
      "TRUST_PROXY is off, so sign-in rate limits count against the address " +
        "connecting to this process. Set TRUST_PROXY=true if a reverse proxy " +
        "sits in front, or every visitor will share one allowance.",
    );
  }
  // The code is read only after ALLOWED_EMAILS has turned an address away, so a
  // rule admitting everyone makes it unreachable. Printing one there told the
  // operator to use something no request would ever look at, and sent them
  // hunting for a code the sign-up form does not ask for.
  if (
    config.isProduction &&
    config.localAuthEnabled &&
    !isRegistrationOpenToAnyone() &&
    (await isLocalBootstrapOpen())
  ) {
    // Announced rather than logged at a level, because there is nowhere else to
    // read it: `LOG_LEVEL=warn` is a supported setting and it made a fresh
    // production instance print nothing at all, which is an instance nobody can
    // claim.
    log.announce(`First-run setup code: ${await getOwnerSetupToken()}`);
    log.announce(
      isRegistrationClosed()
        ? "ALLOWED_EMAILS admits nobody, so this is the only way to create the first account. It stops working once one exists."
        : "Addresses ALLOWED_EMAILS admits do not need it. This claims the instance with an address it would turn away, and stops working once an account exists.",
    );
  }
  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.isProduction ? "0.0.0.0" : "127.0.0.1",
  });
  log.info(`Simple Balance API listening on port ${config.port} (public origin ${config.baseUrl})`);

  // Started after serve() returns, so the tables exist and health checks are
  // already answering before the first tick can take any time.
  const scheduler = createRecurrenceScheduler();
  if (!scheduler.enabled) {
    // Said out loud because the alternative failure is silent: a deployment
    // where every replica has it off proposes nothing, looks completely
    // healthy, and is noticed only when somebody misses months of rent.
    log.info(
      "RECURRENCE_SCHEDULER is off, so nothing in this process proposes " +
        "recurring transactions. Another container has to run with it on, or " +
        "every recurrence quietly falls past due.",
    );
  }

  const shutdown = createGracefulShutdown({
    server,
    closeResources: async () => {
      // First, because the loop holds a connection from a pool closeDb() is
      // about to end.
      await scheduler.stop();
      await closeMail();
      await closeDb();
    },
    exit: (code) => process.exit(code),
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (error) => {
  // log.failure, not the error whole: a Drizzle error escaping main() prints
  // the failing statement's bound parameters, and startup runs the archived
  // re-close repair over every tenant's balances before it serves.
  log.failure("The server could not start", error);
  await closeDb();
  process.exitCode = 1;
});
