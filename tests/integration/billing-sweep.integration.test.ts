/**
 * Billing on and selling, for this file only.
 *
 * Set at module scope because `getConfig` memoizes on first call, and restored
 * in `afterAll` because `vitest.config.ts` sets `fileParallelism: false` — every
 * integration file shares one process.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_billing_sweep",
  STRIPE_PUBLISHABLE_KEY: "pk_test_billing_sweep",
  STRIPE_WEBHOOK_SECRET: "whsec_billing_sweep",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import { billingSubscriptions, user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * Stripe, replaced at the one module that talks to it.
 *
 * The same doubles `billing-stripe.integration.test.ts` installs, and copied
 * rather than shared because the mock factory is hoisted to the top of its own
 * module and a helper that installed it would have to be imported after the
 * call it sets up. `isMissingStripeResource` is left real for the same reason
 * it is there: it is a rule about Stripe's errors rather than a call to Stripe,
 * and the sweep's reading of a `resource_missing` is part of what is under test.
 */
const stripe = vi.hoisted(() => ({
  lastPriceCheck: vi.fn(),
  fetchPlanPrices: vi.fn(),
  fetchSubscriptionSnapshot: vi.fn(),
}));
vi.mock("../../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/stripe.js")>()),
  ...stripe,
}));

import { runBillingReconciliation } from "../../src/server/services/billing.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
/**
 * Its own scratch database, and deliberately not "billing_stripe".
 *
 * `scratchDatabase` builds the name from the label, the process id and a
 * timestamp, and these files run in one process one after another. Two labels
 * that matched would still get two databases, but the names would differ by a
 * millisecond and nothing else, which is a thing to read wrongly at three in
 * the morning rather than a thing to rely on.
 */
const database = scratchDatabase("billing_sweep");

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seed = async (id: string) => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
};

const subscribe = async (
  userId: string,
  over: Partial<typeof billingSubscriptions.$inferInsert> = {},
) => {
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId,
      stripeSubscriptionId: `sub_${userId}`,
      status: "active",
      priceId: "price_monthly",
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      scheduledAt: null,
      pastDueSince: null,
      syncedAt: new Date(),
      ...over,
    });
};

const storedSubscription = async (userId: string, id = `sub_${userId}`) => {
  const [row] = await getDb()
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.userId, userId),
        eq(billingSubscriptions.stripeSubscriptionId, id),
      ),
    );
  return row;
};

/** What Stripe would say about a subscription on re-read, stamped now. */
const snapshotOf = (id: string, over: Record<string, unknown> = {}) => ({
  stripeSubscriptionId: id,
  status: "active",
  priceId: "price_yearly",
  currentPeriodEnd: new Date("2027-06-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  scheduledPriceId: null,
  scheduledAt: null,
  syncedAt: new Date(),
  stripeCustomerId: null,
  ...over,
});

const missing = () =>
  Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });

/**
 * The price check a live deployment's key reaches by default. Only a live key
 * that found both prices in live mode is believed about a missing subscription,
 * and the environment above cannot say live — the configuration refuses a live
 * key outside production — so the check is what says it.
 */
const liveCheck = { problems: [], confirmedMode: "live" } as const;

beforeEach(() => {
  for (const double of Object.values(stripe)) double.mockReset();
  stripe.lastPriceCheck.mockReturnValue(liveCheck);
  stripe.fetchPlanPrices.mockResolvedValue({
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  });
  stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => snapshotOf(id));
});

/** Far enough back that everything seeded with it is past the twelve-hour window. */
const longAgo = new Date("2026-01-01T00:00:00.000Z");

/** The ids the sweep asked Stripe about, in the order it asked. */
const fetched = (): string[] =>
  stripe.fetchSubscriptionSnapshot.mock.calls.map((call) => String(call[0]));

/**
 * How much of a backlog the sweep takes, in what order, and what it leaves out.
 *
 * Every row here is stale, so the only thing deciding which fifty of the
 * fifty-three rows a tick reads is the query: its status filter, its ordering
 * and its limit. Each of the three was deletable with the whole suite green.
 */
integration("what the reconciliation sweep chooses, and how much of it", () => {
  beforeEach(async () => {
    await database.create();
  }, 60_000);
  afterEach(async () => {
    await database.drop();
  });

  /** Fifty-one: one more than the cap, so the cap has something to leave behind. */
  const LIVE_ROWS = 51;
  const idOf = (index: number) => `sweep-${String(index).padStart(2, "0")}`;
  /** Older than every live row, so a dropped filter puts these at the head of the line. */
  const deadSyncedAt = new Date("2024-01-01T00:00:00.000Z");

  const seedBacklog = async () => {
    // Seeded newest first on purpose, so that insertion order, id order and age
    // order are not the same order and a sweep that reads by the wrong one is
    // visible here. Note what this cannot catch: deleting the `order by`
    // outright still passes, because `billing_subscription_synced_at_idx` is on
    // `synced_at` and the plan hands the rows back in that order anyway. The
    // ordering is defended against being *changed*, which is what a later edit
    // does; the index defends it against being dropped.
    for (let index = LIVE_ROWS - 1; index >= 0; index -= 1) {
      await seed(idOf(index));
      await subscribe(idOf(index), {
        priceId: "price_yearly",
        // A minute apart, so "oldest first" has a single right answer rather
        // than fifty-one rows the database may return in any order it likes.
        syncedAt: new Date(longAgo.getTime() + index * 60_000),
      });
    }
    // And the two statuses that are history rather than somebody's current
    // subscription. Stripe keeps a canceled Subscription object forever and
    // this product keeps a row per (userId, stripeSubscriptionId), so every
    // cancellation leaves one of these behind permanently.
    for (const [id, status] of [
      ["sweep-dead-canceled", "canceled"],
      ["sweep-dead-expired", "incomplete_expired"],
    ] as const) {
      await seed(id);
      await subscribe(id, { status, priceId: "price_yearly", syncedAt: deadSyncedAt });
    }
  };

  it("reads the fifty oldest live rows, oldest first, and says it was capped", async () => {
    await seedBacklog();

    const summary = await runBillingReconciliation();

    // Fifty of the fifty-one. The scheduler arms the next tick only after this
    // one resolves, and these are sequential network calls to one vendor, so an
    // uncapped sweep holds the recurrence proposals, the reminder mail and the
    // idempotency prune behind every stale row in the deployment — which is
    // exactly the state a restart after an outage leaves.
    expect(summary.examined).toBe(50);
    // And it says so, which is the only signal an operator gets that a tick
    // left work behind.
    expect(summary.capped).toBe(true);
    // The literal fifty, not `BILLING_SWEEP_MAX`. It is not exported, and an
    // expectation computed from the constant agrees with the source whatever
    // the source says — the defect this repository has shipped four times.
    expect(fetched()).toEqual(Array.from({ length: 50 }, (_, index) => `sub_${idOf(index)}`));
  });

  /**
   * And the row the cap left is the one the next tick starts with.
   *
   * Oldest-first is a fairness property and reads like one, so it is worth
   * saying what it costs to lose: under any fixed order that is not the age
   * order, the rows at the wrong end of it are re-read every tick and the rows
   * at the other end are never read at all. This is that property stated as a
   * drain rather than as a sort.
   */
  it("comes back for the row the cap left, and calls that tick uncapped", async () => {
    await seedBacklog();
    await runBillingReconciliation();
    stripe.fetchSubscriptionSnapshot.mockClear();

    const summary = await runBillingReconciliation();

    expect(summary).toMatchObject({ examined: 1, capped: false });
    expect(fetched()).toEqual(["sub_sweep-50"]);
  });

  /**
   * The status filter, which is the limb of the query that costs money.
   *
   * Drop it and the stale set becomes every subscription the deployment has
   * ever had. Each dead row is re-read from Stripe, stamped fresh, and falls
   * back into the stale set twelve hours later, forever — and because the sweep
   * reads oldest-first and takes only fifty, a deployment with enough history
   * never reaches a live row again. The safety net under the webhook stops
   * covering anybody while reporting a full tick every time.
   */
  it("never reads a subscription that is already history, oldest though it is", async () => {
    await seedBacklog();

    // Twice drains all fifty-one live rows, so a third tick has nothing live
    // left to prefer: if the two dead rows were ever going to be read, this is
    // where it would happen.
    await runBillingReconciliation();
    await runBillingReconciliation();
    const third = await runBillingReconciliation();

    expect(third).toMatchObject({ examined: 0 });
    // The row state first, because it is the assertion that says what the
    // filter is worth. The default double answers `status: "active"` for any id
    // it is handed, so a sweep without the filter does not merely waste a call
    // — it resurrects a subscription Stripe closed and hands its owner back a
    // plan nobody is paying for.
    const canceled = await storedSubscription("sweep-dead-canceled");
    expect(canceled?.status).toBe("canceled");
    expect(canceled?.syncedAt).toEqual(deadSyncedAt);
    const expired = await storedSubscription("sweep-dead-expired");
    expect(expired?.status).toBe("incomplete_expired");
    expect(expired?.syncedAt).toEqual(deadSyncedAt);
    // And it was never asked about, which is the waste beside the damage: a
    // dead row stamped fresh falls back into the stale set twelve hours later,
    // forever, ahead of every live row behind it.
    expect(fetched()).not.toContain("sub_sweep-dead-canceled");
    expect(fetched()).not.toContain("sub_sweep-dead-expired");
  });
});

/**
 * The cooperative stop, which is the half of SIGTERM that happens down here.
 *
 * `scheduler.stop()` gives up after STOP_GRACE_MS whether or not the sweep has
 * finished, and `closeDb()` then closes the pool under it. Fifty sequential
 * Stripe round trips do not fit in five seconds, so a sweep that does not stop
 * runs on into a closed pool: every row left throws, is counted failed, and is
 * stamped as read, which puts it to the back of a twelve-hour line for no
 * reason but a restart. Every other call site in the tree passes no predicate,
 * so the default `() => false` was the only one ever exercised.
 */
integration("stopping the reconciliation sweep part-way", () => {
  beforeEach(async () => {
    await database.create();
  }, 60_000);
  afterEach(async () => {
    await database.drop();
  });

  /** Three stale rows and the three answers Stripe can give about one. */
  const seedStale = async () => {
    for (const id of ["sweep-gone", "sweep-flaky", "sweep-fine"]) {
      await seed(id);
      await subscribe(id, { priceId: "price_yearly", syncedAt: longAgo });
    }
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => {
      if (id === "sub_sweep-gone") throw missing();
      if (id === "sub_sweep-flaky") throw new Error("connect ETIMEDOUT");
      return snapshotOf(id);
    });
  };

  it("reads nothing at all when it is asked to stop before the first row", async () => {
    await seedStale();

    const summary = await runBillingReconciliation(() => true);

    expect(summary).toEqual({ examined: 0, written: 0, failed: 0, capped: false, skipped: false });
    // Not "examined none but asked anyway": a stop during shutdown must cost
    // Stripe nothing, because the answer has nowhere to be written.
    expect(stripe.fetchSubscriptionSnapshot).not.toHaveBeenCalled();
  });

  /**
   * And the stop is checked per row rather than once before the loop.
   *
   * This is the case a "helpful" tidy-up loses: hoisting the check above the
   * loop reads like the same thing, passes the test above, and turns every
   * stop that arrives after the first row into no stop at all — which is the
   * only kind that happens, since the sweep is only worth stopping once it is
   * running.
   */
  it("stops after the row it is on, and leaves the rest of the backlog stale", async () => {
    await seedStale();
    let seen = 0;

    const summary = await runBillingReconciliation(() => seen++ > 0);

    expect(summary.examined).toBe(1);
    expect(stripe.fetchSubscriptionSnapshot).toHaveBeenCalledTimes(1);
    // The two it never reached keep their old `syncedAt`, so the next tick
    // reads them rather than waiting out another staleness window. Which two
    // is not fixed — all three rows share `longAgo`, so which sorts first is
    // the database's business — so the assertion counts them instead.
    const rows = await Promise.all(
      ["sweep-gone", "sweep-flaky", "sweep-fine"].map((id) => storedSubscription(id)),
    );
    expect(rows.filter((row) => row?.syncedAt.getTime() === longAgo.getTime())).toHaveLength(2);
  });
});
