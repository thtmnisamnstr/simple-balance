/**
 * Billing on and selling, for this file only.
 *
 * Set at module scope because `getConfig` memoizes on first call, and restored
 * in `afterAll` because `vitest.config.ts` sets `fileParallelism: false` — every
 * integration file shares one process.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_billing_stripe",
  STRIPE_PUBLISHABLE_KEY: "pk_test_billing_stripe",
  STRIPE_WEBHOOK_SECRET: "whsec_billing_stripe",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  user,
} from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * Stripe, replaced at the one module that talks to it.
 *
 * Every function the billing service imports from `stripe.js` is a double here
 * except `isMissingStripeResource`, which is a rule about Stripe's errors rather
 * than a call to Stripe and is kept real so the tests exercise the same
 * reading of a `resource_missing` the service does.
 */
const stripe = vi.hoisted(() => ({
  lastPriceCheck: vi.fn(),
  fetchPlanPrices: vi.fn(),
  stripeCustomerStanding: vi.fn(),
  createStripeCustomer: vi.fn(),
  deleteStripeCustomer: vi.fn(),
  createStripeSubscription: vi.fn(),
  fetchSubscriptionSnapshot: vi.fn(),
  fetchSubscriptionClientSecret: vi.fn(),
  stripeScheduleFor: vi.fn(),
  releaseStripeSchedule: vi.fn(),
  scheduleStripeSubscriptionPrice: vi.fn(),
  stripeSubscriptionItem: vi.fn(),
  switchStripeSubscriptionNow: vi.fn(),
  cancelStripeSubscriptionNow: vi.fn(),
  setStripeCancelAtPeriodEnd: vi.fn(),
  createStripeSetupIntent: vi.fn(),
  fetchStripeSetupIntent: vi.fn(),
  currentStripeDefaultPaymentMethod: vi.fn(),
  setStripeDefaultPaymentMethod: vi.fn(),
  openStripeInvoiceFor: vi.fn(),
  payStripeInvoice: vi.fn(),
}));
vi.mock("../../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/stripe.js")>()),
  ...stripe,
}));

/**
 * The billing lock, real except for the people named in `refused`, whose
 * writes fail the way a lock timeout does — the one way to make a write the
 * sweep attempts throw without also breaking the reads around it.
 */
const locks = vi.hoisted(() => ({ refused: new Set<string>() }));
vi.mock("../../src/server/services/helpers.js", async (importOriginal) => {
  const helpers = await importOriginal<typeof import("../../src/server/services/helpers.js")>();
  return {
    ...helpers,
    lockBillingState: async (...args: Parameters<typeof helpers.lockBillingState>) => {
      if (locks.refused.has(args[1])) throw new Error("canceling statement due to lock timeout");
      return helpers.lockBillingState(...args);
    },
  };
});

import { deleteOwnAccount } from "../../src/server/services/account-deletion.js";
import {
  applySetupIntentSucceeded,
  createPaymentSetup,
  getBillingStatus,
  runBillingReconciliation,
  setSubscription,
} from "../../src/server/services/billing.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("billing_stripe");

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const actorFor = (id: string): Actor => ({ userId: id, source: "web" });

const seed = async (id: string) => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return actorFor(id);
};

const mapCustomer = async (userId: string, stripeCustomerId: string) => {
  await getDb().insert(billingCustomers).values({ userId, stripeCustomerId });
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

const storedCustomer = async (userId: string) => {
  const [row] = await getDb()
    .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, userId));
  return row?.stripeCustomerId ?? null;
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

let keyCounter = 0;
const idempotencyKey = () => `key-${(keyCounter += 1)}-${Date.now()}`;

/**
 * The price check a live deployment's key reaches by default. Only a live key
 * that found both prices in live mode is believed about a missing customer or
 * subscription, and the environment above cannot say live — the configuration
 * refuses a live key outside production — so the check is what says it.
 */
const liveCheck = { problems: [], confirmedMode: "live" } as const;

const misfit = {
  problems: ["STRIPE_PRICE_MONTHLY_ID bills every year, and it is the monthly setting."],
  confirmedMode: "live",
} as const;

beforeEach(() => {
  for (const double of Object.values(stripe)) double.mockReset();
  locks.refused.clear();
  stripe.lastPriceCheck.mockReturnValue(liveCheck);
  stripe.fetchPlanPrices.mockResolvedValue({
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  });
  stripe.stripeCustomerStanding.mockResolvedValue("present");
  stripe.createStripeCustomer.mockResolvedValue("cus_new");
  stripe.createStripeSubscription.mockResolvedValue({
    subscriptionId: "sub_created",
    clientSecret: "pi_created_secret",
    // A second older than the resync that follows, so that read is the newer.
    snapshot: snapshotOf("sub_created", {
      status: "incomplete",
      syncedAt: new Date(Date.now() - 1000),
    }),
  });
  stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => snapshotOf(id));
  stripe.stripeScheduleFor.mockResolvedValue(null);
  stripe.stripeSubscriptionItem.mockResolvedValue({ itemId: "si_1", priceId: "price_monthly" });
  stripe.scheduleStripeSubscriptionPrice.mockResolvedValue("sub_sched_new");
  stripe.fetchSubscriptionClientSecret.mockResolvedValue(null);
  stripe.createStripeSetupIntent.mockResolvedValue({ id: "seti_new", clientSecret: "seti_secret" });
});

/**
 * A sale against prices that do not fit the plans they are sold as is refused
 * before anything reaches Stripe, and the plan tab stops offering one.
 */
integration("refusing a sale the prices cannot carry", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("refuses with a conflict and charges nobody", async () => {
    const actor = await seed("price-refused");
    stripe.lastPriceCheck.mockReturnValue(misfit);

    await expect(
      setSubscription(actor, { interval: "monthly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(stripe.createStripeCustomer).not.toHaveBeenCalled();
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();

    const status = await getBillingStatus(actor);
    expect(status.selling).toBe(false);
  });

  /**
   * Paying a renewal that is owed hands back an invoice that already exists,
   * on a plan the person has been on all along, and depends on neither price.
   * Refusing it here left the plan tab's pay buttons answering "Subscriptions
   * cannot be started" to somebody trying to pay what they owe.
   */
  it("still takes payment of a renewal that is owed", async () => {
    for (const status of ["past_due", "unpaid"] as const) {
      const actor = await seed(`price-refused-${status}`);
      await mapCustomer(actor.userId, `cus_owes_${status}`);
      await subscribe(actor.userId, {
        status,
        priceId: "price_yearly",
        pastDueSince: status === "past_due" ? new Date() : null,
      });
      stripe.lastPriceCheck.mockReturnValue(misfit);
      stripe.fetchSubscriptionClientSecret.mockResolvedValue(`pi_owed_${status}`);

      const result = await setSubscription(actor, {
        interval: "yearly",
        idempotencyKey: idempotencyKey(),
      });
      expect(result).toMatchObject({ status, clientSecret: `pi_owed_${status}` });
      expect(stripe.createStripeSubscription).not.toHaveBeenCalled();

      const shown = await getBillingStatus(actor);
      expect(shown.selling).toBe(false);
      expect(shown.subscription?.payable).toBe(true);
    }
  });

  /** Finishing a first payment starts a subscription, which is a sale. */
  it("still refuses to finish a first payment, before anything reaches Stripe", async () => {
    const actor = await seed("price-refused-incomplete");
    await mapCustomer(actor.userId, "cus_first_payment");
    await subscribe(actor.userId, { status: "incomplete", priceId: "price_yearly" });
    stripe.lastPriceCheck.mockReturnValue(misfit);
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "incomplete" }),
    );

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { prices: "misconfigured" } });
    expect(stripe.stripeCustomerStanding).not.toHaveBeenCalled();
    expect(stripe.fetchSubscriptionClientSecret).not.toHaveBeenCalled();
    expect((await getBillingStatus(actor)).subscription?.payable).toBe(false);
  });

  /**
   * The early read only spares Stripe a customer for a request that will be
   * refused; the row read under the lock is the one that decides. Changed in
   * between — here by the customer lookup that runs between the two — the
   * locked row wins.
   */
  it("decides by the row it locked, not the one it read first", async () => {
    const actor = await seed("price-refused-race");
    await mapCustomer(actor.userId, "cus_race");
    await subscribe(actor.userId, { status: "past_due", priceId: "price_yearly" });
    stripe.lastPriceCheck.mockReturnValue(misfit);
    const row = and(
      eq(billingSubscriptions.userId, actor.userId),
      eq(billingSubscriptions.stripeSubscriptionId, `sub_${actor.userId}`),
    );

    stripe.stripeCustomerStanding.mockImplementationOnce(async () => {
      await getDb().update(billingSubscriptions).set({ status: "incomplete" }).where(row);
      return "present";
    });
    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stripe.fetchSubscriptionClientSecret).not.toHaveBeenCalled();

    await getDb().update(billingSubscriptions).set({ status: "past_due" }).where(row);
    stripe.stripeCustomerStanding.mockImplementationOnce(async () => {
      await getDb().delete(billingSubscriptions).where(row);
      return "present";
    });
    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
  });

  it("refuses an upgrade, which prices something new", async () => {
    const actor = await seed("price-refused-upgrade");
    await mapCustomer(actor.userId, "cus_upgrade_refused");
    await subscribe(actor.userId, { priceId: "price_monthly" });
    stripe.lastPriceCheck.mockReturnValue(misfit);

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stripe.switchStripeSubscriptionNow).not.toHaveBeenCalled();
  });

  it("carries Stripe's interval to the plan tab", async () => {
    const actor = await seed("price-interval");
    const status = await getBillingStatus(actor);
    expect(status.selling).toBe(true);
    expect(status.prices.monthly?.interval).toBe("month");
    expect(status.prices.yearly?.interval).toBe("year");
  });

  /**
   * An unreachable Stripe says nothing about the prices, so it refuses
   * nothing: the sale meets Stripe on its own terms.
   */
  it("sells when the prices could not be checked", async () => {
    const actor = await seed("price-unchecked");
    stripe.fetchPlanPrices.mockRejectedValue(new Error("connect ETIMEDOUT"));
    stripe.lastPriceCheck.mockReturnValue(undefined);

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });
    expect(result.clientSecret).toBe("pi_created_secret");
  });
});

/**
 * Stripe gives a subscription one schedule, so a new one is made only after
 * the old one is let go — including for the states `none` cannot name.
 */
/**
 * Two presses of a plan button that overlap, before either subscription is in
 * the books.
 *
 * The per-user lock was held across Stripe but the new subscription was stored
 * after it was let go, so a second press waiting on the lock — a reload while
 * Stripe was slow, a second tab — read no subscription the moment the first
 * committed, made a second one, and the person could pay both. The row is
 * stored under the lock now, so the second press finds the first subscription
 * and resumes it.
 */
integration("two first subscriptions pressed at once", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("creates one subscription, and hands the second press the first one's payment", async () => {
    const actor = await seed("double-press");
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    stripe.createStripeSubscription.mockImplementation(async () => {
      await slow;
      return {
        subscriptionId: "sub_first",
        clientSecret: "pi_first_secret",
        snapshot: snapshotOf("sub_first", {
          status: "incomplete",
          syncedAt: new Date(Date.now() - 1000),
        }),
      };
    });
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_first_secret");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "incomplete" }),
    );

    const first = setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() });
    // The second press starts while the first is still waiting on Stripe.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(stripe.createStripeSubscription).toHaveBeenCalledTimes(1);
    expect(a.subscriptionId).toBe("sub_first");
    expect(b.subscriptionId).toBe("sub_first");
    expect(b.clientSecret).toBe("pi_first_secret");
  });
});

integration("scheduling a change over one already pending", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("releases an existing schedule before creating another", async () => {
    const actor = await seed("schedule-retired");
    await mapCustomer(actor.userId, "cus_schedule_retired");
    // On a retired price with a switch to monthly pending, and now asking for
    // annual: `schedule`, with a schedule already attached.
    await subscribe(actor.userId, {
      priceId: "price_retired",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    stripe.stripeScheduleFor.mockResolvedValue("sub_sched_existing");

    await setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() });

    expect(stripe.releaseStripeSchedule).toHaveBeenCalledTimes(1);
    const [scheduleId, releaseKey] = stripe.releaseStripeSchedule.mock.calls[0]!;
    expect(scheduleId).toBe("sub_sched_existing");
    expect(releaseKey).toMatch(/:release:sub_sched_existing$/);
    expect(stripe.scheduleStripeSubscriptionPrice).toHaveBeenCalledTimes(1);
    expect(stripe.releaseStripeSchedule.mock.invocationCallOrder[0]!).toBeLessThan(
      stripe.scheduleStripeSubscriptionPrice.mock.invocationCallOrder[0]!,
    );
  });

  it("releases nothing when there is nothing to release", async () => {
    const actor = await seed("schedule-plain");
    await mapCustomer(actor.userId, "cus_schedule_plain");
    await subscribe(actor.userId, { priceId: "price_yearly" });

    await setSubscription(actor, { interval: "monthly", idempotencyKey: idempotencyKey() });

    expect(stripe.releaseStripeSchedule).not.toHaveBeenCalled();
    expect(stripe.scheduleStripeSubscriptionPrice).toHaveBeenCalledTimes(1);
  });

  /**
   * The first attempt let the old schedule go, made its own, and failed to set
   * its phases; the retry finds that one attached and lets it go too. Stripe
   * answers a repeated key with its stored reply, so a creation under the
   * first attempt's key hands back the schedule just released, which refuses
   * every change. Each creation is keyed on what it replaced, so it cannot be.
   */
  it("recovers when a retry finds the schedule its own first attempt made", async () => {
    const actor = await seed("schedule-retry");
    await mapCustomer(actor.userId, "cus_schedule_retry");
    await subscribe(actor.userId, {
      priceId: "price_retired",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    stripe.stripeScheduleFor
      .mockResolvedValueOnce("sub_sched_old")
      .mockResolvedValueOnce("sub_sched_first_attempt");
    stripe.scheduleStripeSubscriptionPrice
      .mockRejectedValueOnce(new Error("Request timed out"))
      .mockResolvedValueOnce("sub_sched_retry");
    const request = { interval: "yearly", idempotencyKey: idempotencyKey() } as const;

    await expect(setSubscription(actor, request)).rejects.toThrow(/timed out/);
    await expect(setSubscription(actor, request)).resolves.toMatchObject({ status: "active" });

    const releases = stripe.releaseStripeSchedule.mock.calls;
    expect(releases.map(([id]) => id)).toEqual(["sub_sched_old", "sub_sched_first_attempt"]);
    for (const [id, key] of releases) expect(key).toMatch(new RegExp(`:release:${id}$`));
    const [first, retry] = stripe.scheduleStripeSubscriptionPrice.mock.calls.map(([, key]) => key);
    expect(first).toMatch(/:schedule:sub_sched_old$/);
    expect(retry).toMatch(/:schedule:sub_sched_first_attempt$/);
    // One request, so one Stripe key beneath both attempts.
    expect(first!.replace(/:schedule:.*$/, "")).toBe(retry!.replace(/:schedule:.*$/, ""));
  });
});

/**
 * An upgrade's charge the bank wants authenticated leaves the subscription
 * `past_due` with an open invoice, and the person has to be handed it now.
 */
integration("an upgrade that could not be collected on the spot", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("hands back the invoice's secret when the upgrade left something owing", async () => {
    const actor = await seed("upgrade-owing");
    await mapCustomer(actor.userId, "cus_upgrade_owing");
    await subscribe(actor.userId, { priceId: "price_monthly" });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "past_due" }),
    );
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_upgrade_secret");

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });

    expect(stripe.switchStripeSubscriptionNow).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "past_due", clientSecret: "pi_upgrade_secret" });
  });

  it("hands back nothing when the upgrade was paid", async () => {
    const actor = await seed("upgrade-paid");
    await mapCustomer(actor.userId, "cus_upgrade_paid");
    await subscribe(actor.userId, { priceId: "price_monthly" });

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });

    expect(result).toMatchObject({ status: "active", clientSecret: null });
    // A paid invoice still carries a secret, and confirming it again is an
    // error, so it is not even asked for.
    expect(stripe.fetchSubscriptionClientSecret).not.toHaveBeenCalled();
  });
});

/**
 * A deployment tried out in test mode and then switched to live keys: the
 * stored customer and subscriptions belong to a mode the live key cannot read.
 */
integration("a customer Stripe no longer has", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("replaces the mapping and closes what it owned, where the key's account is confirmed", async () => {
    const actor = await seed("switched-to-live");
    await mapCustomer(actor.userId, "cus_test_mode");
    await subscribe(actor.userId, { priceId: "price_yearly" });
    stripe.stripeCustomerStanding.mockResolvedValue("missing");

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });

    // The phantom subscription is closed, so this is a first subscribe against
    // a new customer rather than a change to one no key can see.
    expect((await storedSubscription(actor.userId))?.status).toBe("canceled");
    expect(await storedCustomer(actor.userId)).toBe("cus_new");
    expect(stripe.createStripeCustomer.mock.calls[0]![1]).toMatch(
      /:customer:replacing:cus_test_mode$/,
    );
    expect(stripe.createStripeSubscription).toHaveBeenCalledWith(
      { customerId: "cus_new", priceId: "price_yearly" },
      expect.any(String),
    );
    expect(result.clientSecret).toBe("pi_created_secret");
  });

  /**
   * To a key for the wrong account every customer is missing. Believing it
   * would replace every mapping and end every subscriber's plan.
   */
  it("keeps the mapping where the key's account cannot be confirmed", async () => {
    const actor = await seed("wrong-account-key");
    await mapCustomer(actor.userId, "cus_real");
    await subscribe(actor.userId, { priceId: "price_yearly" });
    stripe.stripeCustomerStanding.mockResolvedValue("missing");
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: null });

    await createPaymentSetup(actor, { idempotencyKey: idempotencyKey() });

    expect(await storedCustomer(actor.userId)).toBe("cus_real");
    expect((await storedSubscription(actor.userId))?.status).toBe("active");
    expect(stripe.createStripeSetupIntent).toHaveBeenCalledWith("cus_real", expect.any(String));
  });

  /**
   * A test key of the same account, put back on a deployment that has gone
   * live — to rehearse a subscription in test mode, say — finds the test
   * prices, and to it every live customer is missing. Believing it would drop
   * the mapping of anybody who pressed a button, leaving their live
   * subscription charging a card that no delivery and no deletion could reach.
   */
  it("keeps a live customer's mapping under a test key of the same account", async () => {
    const actor = await seed("test-key-on-live");
    await mapCustomer(actor.userId, "cus_live");
    await subscribe(actor.userId, { priceId: "price_yearly" });
    stripe.stripeCustomerStanding.mockResolvedValue("missing");
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "test" });

    await createPaymentSetup(actor, { idempotencyKey: idempotencyKey() });
    await setSubscription(actor, { interval: "monthly", idempotencyKey: idempotencyKey() });

    expect(await storedCustomer(actor.userId)).toBe("cus_live");
    expect((await storedSubscription(actor.userId))?.status).toBe("active");
    expect(stripe.createStripeCustomer).not.toHaveBeenCalled();
    expect(stripe.createStripeSetupIntent).toHaveBeenCalledWith("cus_live", expect.any(String));
  });

  it("replaces a customer Stripe says was deleted, whatever the key", async () => {
    const actor = await seed("deleted-customer");
    await mapCustomer(actor.userId, "cus_deleted");
    stripe.stripeCustomerStanding.mockResolvedValue("deleted");
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: null });
    stripe.createStripeCustomer.mockResolvedValue("cus_after_deletion");

    await createPaymentSetup(actor, { idempotencyKey: idempotencyKey() });

    expect(await storedCustomer(actor.userId)).toBe("cus_after_deletion");
    expect(stripe.createStripeSetupIntent).toHaveBeenCalledWith(
      "cus_after_deletion",
      expect.any(String),
    );
  });
});

/**
 * Deleting an account while Stripe says it has no such customer. The deletion
 * is refused wherever a subscription might still be charging, because the
 * mapping it drops is the only thing left that could reach one.
 */
integration("deleting an account whose customer Stripe cannot find", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const leaver = async (id: string) => {
    const actor = await seed(id);
    await mapCustomer(actor.userId, `cus_${id}`);
    await subscribe(actor.userId, { priceId: "price_yearly" });
    stripe.deleteStripeCustomer.mockRejectedValue(missing());
    return actor;
  };
  const deleting = (actor: Actor) =>
    deleteOwnAccount(actor, { confirmEmail: `${actor.userId}@example.com` });
  const stillThere = async (userId: string) =>
    (await getDb().select({ id: user.id }).from(user).where(eq(user.id, userId))).length > 0;

  /**
   * A test key put back on a deployment that has gone live finds the test
   * prices, and to it every live customer is missing. Believing it deleted the
   * account and the mapping with it, and the live subscription went on
   * charging a card that no delivery, sweep or deletion could reach again.
   */
  it("refuses under a test key on a deployment whose customer came from live mode", async () => {
    const actor = await leaver("delete-test-key");
    stripe.stripeCustomerStanding.mockResolvedValue("missing");
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "test" });

    // Waiting will not clear this one, so the refusal must not say it will.
    await expect(deleting(actor)).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
      details: { stage: "billing" },
      message: expect.stringMatching(/could not be confirmed as canceled/),
    });
    await expect(deleting(actor)).rejects.not.toMatchObject({
      message: expect.stringMatching(/try again/i),
    });
    expect(await storedCustomer(actor.userId)).toBe("cus_delete-test-key");
    expect(await stillThere(actor.userId)).toBe(true);
  });

  /** To a key for the wrong account, every customer is missing too. */
  it("refuses where the key's account cannot be confirmed", async () => {
    const actor = await leaver("delete-wrong-account");
    stripe.stripeCustomerStanding.mockResolvedValue("missing");
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: null });

    await expect(deleting(actor)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await storedCustomer(actor.userId)).toBe("cus_delete-wrong-account");
  });

  /** A read back that says nothing leaves the deletion as unconfirmed as before. */
  it("refuses where the customer could not be read back", async () => {
    const actor = await leaver("delete-unreadable");
    stripe.stripeCustomerStanding.mockRejectedValue(new Error("connect ETIMEDOUT"));

    // The one refusal waiting can clear, so this one does say try again.
    await expect(deleting(actor)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/try again in a few minutes/i),
    });
    expect(await storedCustomer(actor.userId)).toBe("cus_delete-unreadable");
  });

  /** A test-mode leftover, to a live key that reaches the prices' account. */
  it("goes ahead where a live key that found both prices cannot see the customer", async () => {
    const actor = await leaver("delete-live-key");
    stripe.stripeCustomerStanding.mockResolvedValue("missing");

    await expect(deleting(actor)).resolves.toMatchObject({ deleted: true });
    expect(await stillThere(actor.userId)).toBe(false);
    expect(await storedCustomer(actor.userId)).toBeNull();
  });

  /** Only a key's own mode can say a customer was deleted, so any key is believed. */
  it("goes ahead where the customer reads back as deleted, whatever the key", async () => {
    const actor = await leaver("delete-already-deleted");
    stripe.stripeCustomerStanding.mockResolvedValue("deleted");
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: null });

    await expect(deleting(actor)).resolves.toMatchObject({ deleted: true });
    expect(await stillThere(actor.userId)).toBe(false);
  });
});

/**
 * The sweep, and the two answers other than a snapshot. Each case seeds its
 * own stale rows into a fresh database, because the sweep reads every stale row
 * in the deployment.
 */
integration("the reconciliation sweep, when Stripe does not answer with a snapshot", () => {
  beforeEach(async () => {
    await database.create();
  }, 60_000);
  afterEach(async () => {
    await database.drop();
  });

  const longAgo = new Date("2026-01-01T00:00:00.000Z");
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

  it("stores a subscription Stripe has no record of as canceled", async () => {
    await seedStale();

    const before = Date.now();
    const summary = await runBillingReconciliation();

    expect(summary).toMatchObject({ examined: 3, written: 2, failed: 1 });
    const gone = await storedSubscription("sweep-gone");
    expect(gone?.status).toBe("canceled");
    expect(gone?.syncedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect((await storedSubscription("sweep-fine"))?.status).toBe("active");
  });

  /**
   * The row that failed goes to the back of the line and keeps what it said.
   * Left where it was, fifty such rows were every row the sweep would read.
   */
  it("moves a row that failed to the back of the line without changing it", async () => {
    await seedStale();

    const before = Date.now();
    await runBillingReconciliation();

    const flaky = await storedSubscription("sweep-flaky");
    expect(flaky?.status).toBe("active");
    expect(flaky?.priceId).toBe("price_yearly");
    expect(flaky?.syncedAt.getTime()).toBeGreaterThanOrEqual(before);

    // Nothing is stale anymore, so the next sweep reads nothing rather than
    // the same failing row again.
    stripe.fetchSubscriptionSnapshot.mockClear();
    await expect(runBillingReconciliation()).resolves.toMatchObject({ examined: 0 });
    expect(stripe.fetchSubscriptionSnapshot).not.toHaveBeenCalled();
  });

  it("does not believe a missing subscription from a key it cannot confirm", async () => {
    await seedStale();
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: null });

    const summary = await runBillingReconciliation();

    expect(summary).toMatchObject({ examined: 3, written: 1, failed: 2 });
    expect((await storedSubscription("sweep-gone"))?.status).toBe("active");
  });

  /**
   * The same test key in the sweep. To it every live subscription is missing,
   * and believing it canceled fifty paying subscribers a tick, where putting
   * the live keys back repaired nobody: the sweep reads only live rows. Each
   * is one more failure instead, moved to the back of the line and left
   * saying what it said.
   */
  it("cancels nobody under a test key on a deployment whose rows came from live mode", async () => {
    await seedStale();
    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "test" });

    const before = Date.now();
    const summary = await runBillingReconciliation();

    expect(summary).toMatchObject({ examined: 3, written: 1, failed: 2 });
    const gone = await storedSubscription("sweep-gone");
    expect(gone?.status).toBe("active");
    expect(gone?.syncedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  /**
   * A write that throws is one row's failure, not the sweep's. Unguarded, it
   * ended the loop at the row that could not be stored, and every row behind
   * it waited for a tick that would meet the same row first.
   */
  it("carries on past a row it could not store as gone, and defers it", async () => {
    await seedStale();
    // First in line, so the rows behind it are read only if the sweep goes on.
    await getDb()
      .update(billingSubscriptions)
      .set({ syncedAt: new Date("2025-06-01T00:00:00.000Z") })
      .where(eq(billingSubscriptions.userId, "sweep-gone"));
    locks.refused.add("sweep-gone");

    const before = Date.now();
    const summary = await runBillingReconciliation();

    expect(summary).toMatchObject({ examined: 3, written: 1, failed: 2 });
    const gone = await storedSubscription("sweep-gone");
    expect(gone?.status).toBe("active");
    // And to the back of the line like any other failure, which the deferral
    // can do without the lock the write timed out on. Left first, it was read
    // first on every tick while the write went on failing.
    expect(gone?.syncedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect((await storedSubscription("sweep-fine"))?.syncedAt.getTime()).toBeGreaterThan(
      longAgo.getTime(),
    );
  });
});

/**
 * Pinning a saved card from Stripe's delivery. The work comes first and the
 * claim last, so a failure between them leaves the delivery for Stripe to retry.
 */
integration("pinning a card from a setup_intent.succeeded delivery", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const delivery = (eventId: string, setupIntentId: string) => ({
    id: eventId,
    type: "setup_intent.succeeded",
    data: { object: { id: setupIntentId, object: "setup_intent" } },
  });
  const claimed = async (eventId: string) =>
    (
      await getDb()
        .select()
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.eventId, eventId))
    ).length > 0;

  it("still pins the card on Stripe's retry after the first attempt failed", async () => {
    const actor = await seed("setup-retry");
    await mapCustomer(actor.userId, "cus_setup_retry");
    await subscribe(actor.userId);
    stripe.fetchStripeSetupIntent.mockResolvedValue({
      status: "succeeded",
      customerId: "cus_setup_retry",
      paymentMethodId: "pm_new",
      paymentMethodCreated: new Date("2026-09-01T00:00:00.000Z"),
    });
    stripe.currentStripeDefaultPaymentMethod.mockResolvedValue({
      id: "pm_old",
      created: new Date("2026-01-01T00:00:00.000Z"),
    });
    stripe.setStripeDefaultPaymentMethod
      .mockRejectedValueOnce(new Error("Request timed out"))
      .mockResolvedValue(undefined);

    await expect(
      applySetupIntentSucceeded(actor.userId, delivery("evt_setup_retry", "seti_retry")),
    ).rejects.toThrow(/timed out/);
    // Not claimed, so the retry is not answered "duplicate".
    expect(await claimed("evt_setup_retry")).toBe(false);

    await expect(
      applySetupIntentSucceeded(actor.userId, delivery("evt_setup_retry", "seti_retry")),
    ).resolves.toBe("written");
    expect(stripe.setStripeDefaultPaymentMethod).toHaveBeenCalledTimes(2);
    for (const [input, key] of stripe.setStripeDefaultPaymentMethod.mock.calls) {
      expect(input).toEqual({
        customerId: "cus_setup_retry",
        subscriptionId: "sub_setup-retry",
        paymentMethodId: "pm_new",
      });
      expect(key).toBe("setup:seti_retry");
    }
    expect(await claimed("evt_setup_retry")).toBe(true);

    // A third delivery is a duplicate, answered without asking Stripe anything.
    stripe.fetchStripeSetupIntent.mockClear();
    await expect(
      applySetupIntentSucceeded(actor.userId, delivery("evt_setup_retry", "seti_retry")),
    ).resolves.toBe("duplicate");
    expect(stripe.fetchStripeSetupIntent).not.toHaveBeenCalled();
  });

  it("does not pin a card somebody has since replaced", async () => {
    const actor = await seed("setup-late");
    await mapCustomer(actor.userId, "cus_setup_late");
    await subscribe(actor.userId);
    stripe.fetchStripeSetupIntent.mockResolvedValue({
      status: "succeeded",
      customerId: "cus_setup_late",
      paymentMethodId: "pm_older",
      paymentMethodCreated: new Date("2026-09-01T00:00:00.000Z"),
    });
    stripe.currentStripeDefaultPaymentMethod.mockResolvedValue({
      id: "pm_newer",
      created: new Date("2026-09-03T00:00:00.000Z"),
    });

    await expect(
      applySetupIntentSucceeded(actor.userId, delivery("evt_setup_late", "seti_late")),
    ).resolves.toBe("ignored");
    expect(stripe.setStripeDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(await claimed("evt_setup_late")).toBe(true);
  });
});
