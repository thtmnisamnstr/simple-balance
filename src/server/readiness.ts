import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { getConfig } from "./config.js";
import { getDb } from "./db/client.js";
import { mailEnabled } from "./mail.js";
import { dependencyUp, processReady, readinessChecks, type ReadinessOutcome } from "./metrics.js";
import { APP_VERSION } from "../shared/version.js";

/**
 * Whether this process can do its job, asked once and recorded where a scrape
 * can read the answer.
 *
 * Both entrypoints answer `/health/ready`. The scheduler answers it from an app
 * with no timing middleware, so with a copy of these lines in each entrypoint a
 * scheduler failing readiness was a 503 no metric ever saw: the platform took
 * it out of rotation and the monitoring said nothing. One function for both is
 * what makes the two processes report the same check in the same words. It
 * lives here rather than in `scheduler.ts` because that file is pinned to three
 * routes and no instrumentation of its own
 * (`docs/standards/code/observability.md` §1.7), and the API has no business
 * importing the scheduler's entrypoint to reach it.
 *
 * Deliberately one statement against the database, and nothing else. It does
 * not check configuration, the migrations or the scheduler, and adding any of
 * those would take a working process out of rotation for a condition that
 * cannot change while it runs. The migration guarantee is ordering rather than
 * a probe: `runMigrations()` is awaited before either process listens, so a
 * process answering this at all is a process that got past them.
 *
 * Recorded from the check that ran and never run for a scrape. The probes keep
 * it fresh on their own — the image's `HEALTHCHECK`, the Compose recipes' own
 * checks and the chart's startup and readiness probes all ask `/health/ready`
 * every few seconds — and a scrape that queried the database to report on it
 * would be the scrape opening a connection, which the pool gauge in
 * `metrics.ts` already refuses to do.
 */
export async function checkReadiness(): Promise<ReadinessOutcome> {
  let outcome: ReadinessOutcome;
  try {
    await getDb().execute(sql`select 1`);
    outcome = "ready";
  } catch {
    // Not logged. The answer is the 503 and the gauge below, and a database
    // that is down for an hour would otherwise write a line every few seconds
    // per process saying what both of those already say.
    outcome = "not_ready";
  }
  readinessChecks.inc({ outcome });
  processReady.set(outcome === "ready" ? 1 : 0);
  return outcome;
}

/**
 * The route both entrypoints mount.
 *
 * The version on both answers, because the question an operator asks a health
 * endpoint during a rolling deploy is "which build is answering", and the API
 * and the scheduler are deployed separately on a split deployment, so reading
 * one off the other would answer about the wrong process. The body says the
 * outcome in the words the counter labels it with, so the probe's log and the
 * scrape cannot describe the same check differently.
 */
export async function answerReadiness(c: Context) {
  const outcome = await checkReadiness();
  return c.json({ status: outcome, version: APP_VERSION }, outcome === "ready" ? 200 : 503);
}

/**
 * What the startup checks found, where a scrape can read it.
 *
 * Both entrypoints ask the mail relay and Stripe before they listen, and each
 * check logs and carries on rather than refusing to start. That is right — the
 * ledger is what people came for — and it leaves a process that is up, ready
 * and quietly unable to send a password reset or sell a plan, with one line at
 * startup the only place that says so. Readiness cannot carry it: taking a
 * process out of rotation because a relay refused would lock everybody out of
 * the books over the one thing in them that is optional.
 *
 * From the answers the checks already gave, never by asking again on a scrape,
 * and only for what the deployment configured. A deployment with no relay has
 * no `smtp` series rather than a 0, because mail is optional and its absence
 * is a supported shape rather than a dependency that is down; billing turned
 * off is the same. A Stripe that could not be reached reads 0 on both of its
 * series, because neither check passed: 1 is a check that ran and found
 * nothing wrong, and a check that could not run found nothing at all. The one
 * exception is a standard `sk_` key, which holds every permission and so is
 * never asked what it may read: its `stripe_access` is 1 whatever Stripe says.
 *
 * `smtp` and `stripe_access` are asked only here, so they say what the
 * process found as it started. `stripe_prices` is asked again — by the plan
 * tab, before every sale and by the billing sweep — and `fetchPlanPrices` in
 * `stripe.ts` writes each newer verdict over this one, so it follows the
 * verdict the point of sale refuses on. Written here as well because that
 * function writes nothing when Stripe does not answer, and at boot there is
 * then no verdict at all for it to have kept.
 */
export function recordDependencyChecks(found: {
  /** `checkMailTransport`'s answer, where this entrypoint asked it. */
  relay?: boolean;
  /** `checkStripePrices`'s answer. */
  pricesFit: boolean;
  /**
   * `checkStripeAccess`'s answer: the resources the key was refused, or null
   * where Stripe could not be asked about all of them and refused none.
   */
  unreadable: readonly string[] | null;
}) {
  if (found.relay !== undefined && mailEnabled()) {
    dependencyUp.set({ dependency: "smtp" }, found.relay ? 1 : 0);
  }
  if (!getConfig().billing) return;
  dependencyUp.set({ dependency: "stripe_prices" }, found.pricesFit ? 1 : 0);
  dependencyUp.set({ dependency: "stripe_access" }, found.unreadable?.length === 0 ? 1 : 0);
}
