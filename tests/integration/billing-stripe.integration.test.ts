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
import { type Actor, PLAN_ENDING_REFUSAL, PLAN_GRANTED_REFUSAL } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import {
  billingCustomers,
  billingOperations,
  billingOverrides,
  billingSubscriptions,
  billingWebhookEvents,
  ledgerAccounts,
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
  keepCardThatPays: vi.fn(),
  fetchOwedPayment: vi.fn(),
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
  confirmPaymentSetup,
  createPaymentSetup,
  getBillingStatus,
  hasLiveSubscription,
  runBillingReconciliation,
  setSubscription,
  setSubscriptionCancellation,
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
  stripe.stripeSubscriptionItem.mockResolvedValue({
    itemId: "si_1",
    priceId: "price_monthly",
    latestInvoiceId: "in_monthly",
  });
  stripe.scheduleStripeSubscriptionPrice.mockResolvedValue("sub_sched_new");
  stripe.fetchSubscriptionClientSecret.mockResolvedValue(null);
  stripe.createStripeSetupIntent.mockResolvedValue({ id: "seti_new", clientSecret: "seti_secret" });
  // What Stripe answers an upgrade with: the annual price, read a moment
  // before the resync that follows it, so that read is the newer — and beside
  // it what the update raised, which is the ordinary case where it billed.
  stripe.switchStripeSubscriptionNow.mockImplementation(async ({ subscriptionId }) => ({
    snapshot: snapshotOf(subscriptionId, { syncedAt: new Date(Date.now() - 500) }),
    invoice: "paid",
  }));
  stripe.keepCardThatPays.mockResolvedValue(false);
  stripe.fetchOwedPayment.mockResolvedValue(null);
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
      // The plan tab re-reads a row that owes, so Stripe has to say it still does.
      stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
        snapshotOf(id, { status }),
      );

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

/**
 * A first subscribe that loses the race for the Stripe customer.
 *
 * The race between two first-time requests is settled by the primary key on
 * `billing_customer.user_id` rather than by a lock — no lock is held across the
 * Stripe call — which is why this is an integration test and can be nothing
 * else: the conflict is the database's to raise. The window is opened by the
 * Stripe call itself writing the winner's row, so there is no concurrency here
 * and no timing to be flaky about.
 */
integration("a first subscribe that loses the race for the customer", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  /**
   * The subscription has to be created against the customer the books are
   * mapped to, never the one this request happened to make. Billed to the
   * loser, `userForStripeCustomer` finds nobody for it, every `invoice.paid`
   * and `customer.subscription.updated` is acknowledged and dropped, and no
   * `billing_subscription` row is ever written — so the sweep, which walks
   * stored rows, never notices either. The card is charged and the person
   * stays on Free.
   */
  it("subscribes the mapped customer and removes the one it made", async () => {
    const actor = await seed("customer-race-loser");
    stripe.createStripeCustomer.mockImplementation(async () => {
      // The winner commits while this request is still at Stripe. The select
      // before it found nothing, so the insert after it is the one that
      // conflicts — which is exactly the production ordering.
      await mapCustomer(actor.userId, "cus_winner");
      return "cus_loser";
    });

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });

    expect(stripe.createStripeSubscription).toHaveBeenCalledWith(
      { customerId: "cus_winner", priceId: "price_yearly" },
      expect.any(String),
    );
    // The orphan owns nothing and will never be found again, so it goes rather
    // than sitting in an operator's dashboard forever.
    expect(stripe.deleteStripeCustomer).toHaveBeenCalledWith("cus_loser");
    expect(await storedCustomer(actor.userId)).toBe("cus_winner");
    expect(result.subscriptionId).toBe("sub_created");
  });

  /**
   * Tidying the orphan away is not worth failing the request the person
   * actually made: the customer is empty and nothing will ever be billed to
   * it, and the warn names it for an operator.
   */
  it("subscribes anyway when the orphan cannot be deleted", async () => {
    const actor = await seed("customer-race-undeletable");
    stripe.createStripeCustomer.mockImplementation(async () => {
      await mapCustomer(actor.userId, "cus_winner_two");
      return "cus_loser_two";
    });
    stripe.deleteStripeCustomer.mockRejectedValue(new Error("connect ETIMEDOUT"));
    // Its own subscription id: `stripe_subscription_id` is unique across the
    // whole table, and the case above already stored the default one.
    stripe.createStripeSubscription.mockResolvedValue({
      subscriptionId: "sub_created_undeletable",
      clientSecret: "pi_created_undeletable_secret",
      snapshot: snapshotOf("sub_created_undeletable", {
        status: "incomplete",
        syncedAt: new Date(Date.now() - 1000),
      }),
    });

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ subscriptionId: "sub_created_undeletable" });
    expect(stripe.createStripeSubscription).toHaveBeenCalledWith(
      { customerId: "cus_winner_two", priceId: "price_yearly" },
      expect.any(String),
    );
  });

  /**
   * And where the mapping is gone again by the time it is read back, nothing
   * is charged. There is no customer to be sure of, and carrying on with the
   * one this request made is the failure the throw exists to prevent.
   */
  it("charges nobody when the winner is gone by the time it reads back", async () => {
    const actor = await seed("customer-race-vanished");
    stripe.createStripeCustomer.mockImplementation(async () => {
      await mapCustomer(actor.userId, "cus_winner_three");
      return "cus_loser_three";
    });
    // The account is deleted while the orphan is being tidied away, which is
    // the one window there is between the conflict and the read that follows.
    stripe.deleteStripeCustomer.mockImplementation(async () => {
      await getDb().delete(billingCustomers).where(eq(billingCustomers.userId, actor.userId));
    });
    // Answered although it must never be reached, so that a build which
    // carried on regardless fails here for having charged somebody rather
    // than on a collision with the subscription id of the case above.
    stripe.createStripeSubscription.mockResolvedValue({
      subscriptionId: "sub_created_vanished",
      clientSecret: "pi_created_vanished_secret",
      snapshot: snapshotOf("sub_created_vanished", { status: "incomplete" }),
    });

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toThrow(/disappeared between insert and read/);
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
  });
});

/**
 * Chose one interval, never paid, and has now pressed the other button.
 *
 * Stripe gives one person one subscription, so the unpaid one is canceled —
 * which voids its open invoice, making the change of mind free — and a new one
 * is made at the price actually asked for. Anything else here is somebody
 * pressing a $3 button and being charged $30, or the reverse, so what is
 * pinned is the choreography rather than the decision: which subscription is
 * canceled, which price the replacement carries, that the two Stripe keys
 * differ, and that the abandoned row is written back out of the live set
 * instead of going on being offered as the payment to finish.
 */
integration("changing the interval before the first payment", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("cancels the unpaid subscription and starts the one that was asked for", async () => {
    const actor = await seed("replace-unpaid");
    await mapCustomer(actor.userId, "cus_replace");
    await subscribe(actor.userId, {
      status: "incomplete",
      priceId: "price_monthly",
      currentPeriodEnd: null,
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.cancelStripeSubscriptionNow.mockResolvedValue(undefined);
    stripe.createStripeSubscription.mockResolvedValue({
      subscriptionId: "sub_replacement",
      clientSecret: "pi_replacement_secret",
      snapshot: snapshotOf("sub_replacement", {
        status: "incomplete",
        priceId: "price_yearly",
        syncedAt: new Date(Date.now() - 1000),
      }),
    });
    // The old one comes back canceled; the new one is still waiting to be paid.
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      id === "sub_replace-unpaid"
        ? snapshotOf(id, { status: "canceled", priceId: "price_monthly" })
        : snapshotOf(id, { status: "incomplete", priceId: "price_yearly" }),
    );
    // What a regression to `resume` would hand the browser instead: the secret
    // of the monthly payment they have just changed their mind about.
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_monthly_secret");

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });

    // The unpaid one is canceled, and it is that one.
    expect(stripe.cancelStripeSubscriptionNow).toHaveBeenCalledTimes(1);
    const [canceled, cancelKey] = stripe.cancelStripeSubscriptionNow.mock.calls[0]!;
    expect(canceled).toBe("sub_replace-unpaid");
    // The replacement is at the price that was pressed, against the mapped
    // customer, and it is made after the old one is gone rather than beside it.
    expect(stripe.createStripeSubscription).toHaveBeenCalledTimes(1);
    const [request, createKey] = stripe.createStripeSubscription.mock.calls[0]!;
    expect(request).toEqual({ customerId: "cus_replace", priceId: "price_yearly" });
    expect(stripe.cancelStripeSubscriptionNow.mock.invocationCallOrder[0]!).toBeLessThan(
      stripe.createStripeSubscription.mock.invocationCallOrder[0]!,
    );
    // Two distinct Stripe keys beneath this request's one key. Stripe scopes a
    // key to one request and answers a repeat with the first call's stored
    // reply, so one key for both hands the person pressing Yearly the monthly
    // subscription that was just canceled.
    expect(cancelKey).toMatch(/:abandon$/);
    expect(createKey).toMatch(/:replace$/);
    expect(cancelKey).not.toBe(createKey);
    expect(cancelKey.replace(/:abandon$/, "")).toBe(createKey.replace(/:replace$/, ""));

    // The browser is handed the replacement's own payment, never the abandoned
    // one's, and the books agree about both subscriptions.
    expect(result).toMatchObject({
      subscriptionId: "sub_replacement",
      clientSecret: "pi_replacement_secret",
      status: "incomplete",
    });
    expect(stripe.fetchSubscriptionClientSecret).not.toHaveBeenCalled();
    expect(await storedSubscription(actor.userId, "sub_replace-unpaid")).toMatchObject({
      status: "canceled",
    });
    expect(await storedSubscription(actor.userId, "sub_replacement")).toMatchObject({
      status: "incomplete",
      priceId: "price_yearly",
    });
  });

  /**
   * The other thing a stored `incomplete` can mean, and the whole reason this
   * branch may not decide from the stored row alone: Stripe leaves a
   * subscription `incomplete` while its first PaymentIntent is `processing`,
   * and this product tells the person to sit through exactly that — "nothing
   * more is needed from you" — while leaving the other interval's button live
   * beside the notice. Canceling then voids an open invoice a charge is on its
   * way to, which `cancelStripeSubscriptionNow` forbids in its own words, and
   * costs a refund rather than nothing.
   *
   * The assertion is that Stripe was never told to cancel, not that the call
   * threw: a refusal raised after the subscription was destroyed would satisfy
   * the error check on its own.
   */
  it("refuses to abandon a first payment Stripe is still processing", async () => {
    const actor = await seed("replace-processing");
    await mapCustomer(actor.userId, "cus_replace_processing");
    await subscribe(actor.userId, {
      status: "incomplete",
      priceId: "price_monthly",
      currentPeriodEnd: null,
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, {
        status: "incomplete",
        priceId: "price_monthly",
        latestInvoiceId: "in_processing",
      }),
    );
    stripe.fetchOwedPayment.mockResolvedValue({
      invoiceId: "in_processing",
      failureMessage: null,
      awaitingAuthentication: false,
      nextAttemptAt: null,
      intent: { id: "pi_processing", status: "processing", setupFutureUsage: "off_session" },
    });

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { paymentSettling: true } });

    expect(stripe.cancelStripeSubscriptionNow).not.toHaveBeenCalled();
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
    expect(await storedSubscription(actor.userId, "sub_replace-processing")).toMatchObject({
      status: "incomplete",
      priceId: "price_monthly",
    });
  });

  /**
   * And one Stripe says has been paid for, which is the same press one state
   * further on: the payment landed, the delivery that says so has not arrived,
   * and the stored row still reads `incomplete`. Nothing else on this path
   * re-reads — `getBillingStatus` heals that row, and pressing a button does
   * not go through it.
   */
  it("refuses to abandon a subscription Stripe says is already active", async () => {
    const actor = await seed("replace-landed");
    await mapCustomer(actor.userId, "cus_replace_landed");
    await subscribe(actor.userId, {
      status: "incomplete",
      priceId: "price_monthly",
      currentPeriodEnd: null,
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "active", priceId: "price_monthly" }),
    );

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { paymentSettling: true } });

    expect(stripe.cancelStripeSubscriptionNow).not.toHaveBeenCalled();
  });

  /**
   * The narrow half, without which the fix above is just "never replace". A
   * first payment nobody has made leaves its PaymentIntent waiting for a card,
   * and that is the change of mind this branch exists for: it still abandons
   * the subscription and still makes the one that was pressed.
   */
  it("still abandons a first payment whose intent is waiting for a card", async () => {
    const actor = await seed("replace-abandoned");
    await mapCustomer(actor.userId, "cus_replace_abandoned");
    await subscribe(actor.userId, {
      status: "incomplete",
      priceId: "price_monthly",
      currentPeriodEnd: null,
      syncedAt: new Date(Date.now() - 60_000),
    });
    // Stripe's answer about the abandoned row changes under the cancel, so the
    // guard's read and the resync afterward cannot both be one literal.
    let reads = 0;
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => {
      if (id !== "sub_replace-abandoned") {
        return snapshotOf(id, { status: "incomplete", priceId: "price_yearly" });
      }
      reads += 1;
      return reads === 1
        ? snapshotOf(id, {
            status: "incomplete",
            priceId: "price_monthly",
            latestInvoiceId: "in_abandoned",
          })
        : snapshotOf(id, { status: "canceled", priceId: "price_monthly" });
    });
    stripe.fetchOwedPayment.mockResolvedValue({
      invoiceId: "in_abandoned",
      failureMessage: null,
      awaitingAuthentication: false,
      nextAttemptAt: null,
      intent: { id: "pi_abandoned", status: "requires_payment_method", setupFutureUsage: null },
    });
    stripe.cancelStripeSubscriptionNow.mockResolvedValue(undefined);
    stripe.createStripeSubscription.mockResolvedValue({
      subscriptionId: "sub_abandoned_replacement",
      clientSecret: "pi_abandoned_replacement_secret",
      snapshot: snapshotOf("sub_abandoned_replacement", {
        status: "incomplete",
        priceId: "price_yearly",
        syncedAt: new Date(Date.now() - 1000),
      }),
    });

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ subscriptionId: "sub_abandoned_replacement" });

    // The invoice really was asked about, so this passes by the guard running
    // and answering "abandoned" rather than by never reaching it.
    expect(stripe.fetchOwedPayment).toHaveBeenCalledWith("in_abandoned");
    expect(stripe.cancelStripeSubscriptionNow).toHaveBeenCalledTimes(1);
    expect(stripe.cancelStripeSubscriptionNow.mock.calls[0]![0]).toBe("sub_replace-abandoned");
    expect(await storedSubscription(actor.userId, "sub_replace-abandoned")).toMatchObject({
      status: "canceled",
    });
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
   * The plan tab's **Stay on the annual plan** — the browser's one control for
   * cancelling a pending interval switch, since both priced buttons are
   * disabled in that state. It has to let the schedule go and schedule nothing
   * in its place. Falling through to the branch that schedules would create a
   * fresh schedule onto the price they are already on, so the tab goes on
   * saying a switch is coming, the one control for it never clears, and the
   * next renewal is anchored a year out from a press that meant "leave it".
   */
  it("lets a pending switch go and schedules nothing in its place", async () => {
    const actor = await seed("schedule-release");
    await mapCustomer(actor.userId, "cus_schedule_release");
    // On annual with a downgrade to monthly pending, asking for annual again.
    await subscribe(actor.userId, {
      priceId: "price_yearly",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2027-01-01T00:00:00.000Z"),
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.stripeScheduleFor.mockResolvedValue("sub_sched_pending");
    // Stripe answers with whatever the last schedule call left behind, so the
    // stored row is not free to agree with a release that did not happen.
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, {
        priceId: "price_yearly",
        scheduledPriceId:
          stripe.scheduleStripeSubscriptionPrice.mock.calls.at(-1)?.[0]?.priceId ?? null,
      }),
    );

    const result = await setSubscription(actor, {
      interval: "yearly",
      idempotencyKey: idempotencyKey(),
    });

    expect(stripe.releaseStripeSchedule).toHaveBeenCalledTimes(1);
    const [released, releaseKey] = stripe.releaseStripeSchedule.mock.calls[0]!;
    expect(released).toBe("sub_sched_pending");
    expect(releaseKey).toMatch(/:release:sub_sched_pending$/);
    expect(stripe.scheduleStripeSubscriptionPrice).not.toHaveBeenCalled();
    expect(stripe.switchStripeSubscriptionNow).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "active", clientSecret: null, changeInvoice: null });
    expect(await storedSubscription(actor.userId)).toMatchObject({
      priceId: "price_yearly",
      scheduledPriceId: null,
      scheduledAt: null,
    });
  });

  /**
   * And it goes through on a deployment whose prices have stopped it selling.
   * Letting a pending switch go sells nothing — it keeps what has already been
   * paid for — which is why `sellsSomething` exempts it, for the reason paying
   * an owed renewal is exempt: refusing here would leave somebody stuck with a
   * switch they no longer want and no control on the page that could undo it.
   */
  it("lets a pending switch go where the prices are refusing every sale", async () => {
    const actor = await seed("schedule-release-unsold");
    await mapCustomer(actor.userId, "cus_schedule_release_unsold");
    await subscribe(actor.userId, {
      priceId: "price_yearly",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2027-01-01T00:00:00.000Z"),
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.lastPriceCheck.mockReturnValue(misfit);
    stripe.stripeScheduleFor.mockResolvedValue("sub_sched_unsold");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { priceId: "price_yearly" }),
    );

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ status: "active" });

    expect(stripe.releaseStripeSchedule).toHaveBeenCalledTimes(1);
    expect(stripe.scheduleStripeSubscriptionPrice).not.toHaveBeenCalled();
    expect(await storedSubscription(actor.userId)).toMatchObject({ scheduledPriceId: null });
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
 * Cancel at period end, and Keep my plan — the two directions of one button.
 *
 * Never immediate either way: the period has been paid for. What needs pinning
 * is the release that comes first. Stripe refuses `subscriptions.update` on a
 * subscription a schedule is managing, so somebody who has an interval switch
 * pending and presses Cancel gets a throw, a refusal on the page, and a plan
 * that goes on renewing — every retry failing the same way until the schedule
 * runs out. They cannot stop paying from inside the app.
 */
integration("stopping a subscription at the end of its period", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("releases a pending switch before telling Stripe to stop", async () => {
    const actor = await seed("cancel-scheduled");
    await mapCustomer(actor.userId, "cus_cancel_scheduled");
    await subscribe(actor.userId, {
      priceId: "price_yearly",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.stripeScheduleFor.mockResolvedValue("sub_sched_pending");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { priceId: "price_yearly", cancelAtPeriodEnd: true, scheduledPriceId: null }),
    );

    await setSubscriptionCancellation(actor, {
      cancelAtPeriodEnd: true,
      idempotencyKey: idempotencyKey(),
    });

    expect(stripe.releaseStripeSchedule).toHaveBeenCalledTimes(1);
    expect(stripe.releaseStripeSchedule.mock.calls[0]![0]).toBe("sub_sched_pending");
    expect(stripe.setStripeCancelAtPeriodEnd).toHaveBeenCalledWith(
      "sub_cancel-scheduled",
      true,
      expect.any(String),
    );
    // Before, not after. The update is the call Stripe refuses while a
    // schedule is attached, so the order is the whole of the fix.
    expect(stripe.releaseStripeSchedule.mock.invocationCallOrder[0]!).toBeLessThan(
      stripe.setStripeCancelAtPeriodEnd.mock.invocationCallOrder[0]!,
    );
    // And the resync landed. `currentPeriodEnd` is what says so rather than
    // the flag: the row was seeded with 2027-01-01 and Stripe answers
    // 2027-06-01, so a row that merely agreed already cannot pass this.
    expect(await storedSubscription(actor.userId)).toMatchObject({
      cancelAtPeriodEnd: true,
      scheduledPriceId: null,
      currentPeriodEnd: new Date("2027-06-01T00:00:00.000Z"),
    });
  });

  /**
   * Keeping the plan releases nothing. A switch somebody scheduled is still
   * theirs, and letting it go here would undo a change they made on purpose in
   * the course of pressing a button about something else entirely.
   */
  it("leaves a pending switch alone when the plan is kept", async () => {
    const actor = await seed("cancel-kept");
    await mapCustomer(actor.userId, "cus_cancel_kept");
    await subscribe(actor.userId, {
      priceId: "price_yearly",
      cancelAtPeriodEnd: true,
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.stripeScheduleFor.mockResolvedValue("sub_sched_kept");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, {
        priceId: "price_yearly",
        cancelAtPeriodEnd: false,
        scheduledPriceId: "price_monthly",
        scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
      }),
    );

    await setSubscriptionCancellation(actor, {
      cancelAtPeriodEnd: false,
      idempotencyKey: idempotencyKey(),
    });

    // Not even asked for: the lookup is inside the cancelling branch.
    expect(stripe.stripeScheduleFor).not.toHaveBeenCalled();
    expect(stripe.releaseStripeSchedule).not.toHaveBeenCalled();
    expect(stripe.setStripeCancelAtPeriodEnd).toHaveBeenCalledWith(
      "sub_cancel-kept",
      false,
      expect.any(String),
    );
    expect(await storedSubscription(actor.userId)).toMatchObject({
      cancelAtPeriodEnd: false,
      scheduledPriceId: "price_monthly",
    });
  });

  /**
   * Nothing to cancel is a refusal the page can render, not a 500 off a null
   * read one line further on.
   */
  it("refuses with a conflict when there is no subscription", async () => {
    const actor = await seed("cancel-none");

    await expect(
      setSubscriptionCancellation(actor, {
        cancelAtPeriodEnd: true,
        idempotencyKey: idempotencyKey(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", status: 409, details: { subscription: null } });
    expect(stripe.setStripeCancelAtPeriodEnd).not.toHaveBeenCalled();
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

  /**
   * What the update raised, carried out to the caller rather than worked out
   * from the button that was pressed. The tab was writing "the difference was
   * charged to your payment method" from the action alone, which is false for
   * the last of these: a subscription set to stop has its new term capped at
   * the cancellation, so Stripe raises no invoice and parks the proration as
   * uninvoiced items. Nobody is mischarged; they are told money moved when
   * none did.
   */
  it("reports what the upgrade raised, and nothing for a press that raised none", async () => {
    for (const invoice of ["paid", "owed", "none"] as const) {
      const actor = await seed(`upgrade-reports-${invoice}`);
      await mapCustomer(actor.userId, `cus_upgrade_reports_${invoice}`);
      await subscribe(actor.userId, { priceId: "price_monthly" });
      stripe.switchStripeSubscriptionNow.mockImplementation(async ({ subscriptionId }) => ({
        snapshot: snapshotOf(subscriptionId, { syncedAt: new Date(Date.now() - 500) }),
        invoice,
      }));

      await expect(
        setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
      ).resolves.toMatchObject({ changeInvoice: invoice });
    }

    // A repeat of the plan they are on changes no interval, so there is
    // nothing for the sentence to report and it says so rather than guessing.
    const same = await seed("upgrade-reports-none-pressed");
    await mapCustomer(same.userId, "cus_upgrade_reports_same");
    await subscribe(same.userId, { priceId: "price_monthly" });
    await expect(
      setSubscription(same, { interval: "monthly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ changeInvoice: null });
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

/**
 * Pay now on a renewal that failed, and Pay what is owed on one Stripe gave up
 * on. A renewal's PaymentIntent is one Stripe made by itself, with nothing set
 * to keep the card that pays it, so a card typed into Pay now paid once and was
 * thrown away and the next renewal charged the card that had failed. The
 * PaymentIntent is marked before its secret is handed out, because a card used
 * unattached can never be attached afterward.
 */
integration("paying an owed renewal on the plan tab", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("marks the owed renewal to keep the card that pays it, before handing out its secret", async () => {
    for (const status of ["past_due", "unpaid"] as const) {
      const actor = await seed(`keep-card-${status}`);
      await mapCustomer(actor.userId, `cus_keep_${status}`);
      await subscribe(actor.userId, { status, pastDueSince: new Date() });
      stripe.fetchSubscriptionClientSecret.mockResolvedValue(`pi_${status}_secret`);

      const result = await setSubscription(actor, {
        interval: "monthly",
        idempotencyKey: idempotencyKey(),
      });

      expect(result.clientSecret).toBe(`pi_${status}_secret`);
      expect(stripe.keepCardThatPays).toHaveBeenLastCalledWith(
        `sub_keep-card-${status}`,
        expect.stringMatching(/:keep-card$/),
      );
      const kept = stripe.keepCardThatPays.mock.invocationCallOrder.at(-1)!;
      const handed = stripe.fetchSubscriptionClientSecret.mock.invocationCallOrder.at(-1)!;
      expect(kept).toBeLessThan(handed);
    }
  });

  it("leaves a first payment's intent alone, which Stripe already set up to keep the card", async () => {
    const actor = await seed("keep-card-incomplete");
    await mapCustomer(actor.userId, "cus_keep_incomplete");
    await subscribe(actor.userId, { status: "incomplete" });
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_first_secret");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "incomplete", priceId: "price_monthly" }),
    );

    await setSubscription(actor, { interval: "monthly", idempotencyKey: idempotencyKey() });

    expect(stripe.keepCardThatPays).not.toHaveBeenCalled();
  });

  /** A key that may not update PaymentIntents still lets somebody pay what they owe. */
  it("still hands out the payment when the card cannot be marked", async () => {
    const actor = await seed("keep-card-refused");
    await mapCustomer(actor.userId, "cus_keep_refused");
    await subscribe(actor.userId, { status: "past_due", pastDueSince: new Date() });
    stripe.keepCardThatPays.mockRejectedValue(
      Object.assign(new Error("does not have the required permissions"), {
        code: "more_permissions_required",
      }),
    );
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_still_secret");

    await expect(
      setSubscription(actor, { interval: "monthly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ clientSecret: "pi_still_secret" });
  });
});

/**
 * The plan tab asks Stripe about every subscription that owes money, not only
 * one waiting for its first payment. The page's one re-read after Pay now lands
 * before `invoice.paid`, and served from the books it went on saying "Payment
 * failed" beside a live Pay now until somebody reloaded.
 */
integration("the plan tab's read of a subscription that owes", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("answers a renewal just paid in the browser as paid, before the delivery lands", async () => {
    for (const status of ["past_due", "unpaid"] as const) {
      const actor = await seed(`paid-just-now-${status}`);
      await subscribe(actor.userId, {
        status,
        priceId: "price_monthly",
        pastDueSince: status === "past_due" ? new Date() : null,
      });
      stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
        snapshotOf(id, { status: "active", priceId: "price_monthly" }),
      );

      const shown = await getBillingStatus(actor);

      expect(shown.subscription).toMatchObject({ status: "active", payable: false });
      expect(shown.entitlement).toMatchObject({ plan: "plus" });
    }
  });

  it("keeps when the grace began, where Stripe still says the renewal is failing", async () => {
    const actor = await seed("still-failing");
    const began = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await subscribe(actor.userId, {
      status: "past_due",
      priceId: "price_monthly",
      pastDueSince: began,
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "past_due", priceId: "price_monthly" }),
    );

    const shown = await getBillingStatus(actor);

    expect(shown.subscription?.pastDueSince).toBe(began.toISOString());
    expect(shown.subscription?.payable).toBe(true);
  });

  /**
   * A first payment declined in the form and then reloaded read exactly like
   * one nobody had tried, because the decline lived only in the form's state.
   */
  it("says why a first payment failed, and when the unfinished subscription lapses", async () => {
    const actor = await seed("first-declined");
    await subscribe(actor.userId, { status: "incomplete", priceId: "price_yearly" });
    const created = new Date("2026-09-24T21:36:00.000Z");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "incomplete", latestInvoiceId: "in_first", createdAt: created }),
    );
    stripe.fetchOwedPayment.mockResolvedValue({
      invoiceId: "in_first",
      failureMessage: "Your card has insufficient funds.",
      awaitingAuthentication: false,
      nextAttemptAt: null,
      intent: {
        id: "pi_first",
        status: "requires_payment_method",
        setupFutureUsage: "off_session",
      },
    });

    const shown = await getBillingStatus(actor);

    expect(stripe.fetchOwedPayment).toHaveBeenCalledWith("in_first");
    expect(shown.subscription).toMatchObject({
      status: "incomplete",
      lastPaymentError: "Your card has insufficient funds.",
      awaitingAuthentication: false,
      nextRetryAt: null,
      expiresAt: "2026-09-25T20:36:00.000Z",
    });
  });

  it("says a renewal is waiting on the bank, and when Stripe will try again", async () => {
    const actor = await seed("renewal-waiting");
    await subscribe(actor.userId, { status: "past_due", pastDueSince: new Date() });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "past_due", priceId: "price_monthly", latestInvoiceId: "in_due" }),
    );
    stripe.fetchOwedPayment.mockResolvedValue({
      invoiceId: "in_due",
      failureMessage: null,
      awaitingAuthentication: true,
      nextAttemptAt: new Date("2026-09-28T00:00:00.000Z"),
      intent: { id: "pi_due", status: "requires_action", setupFutureUsage: null },
    });

    const shown = await getBillingStatus(actor);

    expect(shown.subscription).toMatchObject({
      awaitingAuthentication: true,
      nextRetryAt: "2026-09-28T00:00:00.000Z",
      expiresAt: null,
    });
  });

  /**
   * The status is worth rendering even where the payment could not be read,
   * and so is what the subscription itself said: an unfinished first payment
   * still has the moment it lapses.
   */
  it("still answers where Stripe could not say where the payment got to", async () => {
    const actor = await seed("payment-unread");
    await subscribe(actor.userId, { status: "incomplete", priceId: "price_yearly" });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, {
        status: "incomplete",
        latestInvoiceId: "in_x",
        createdAt: new Date("2026-09-24T00:00:00.000Z"),
      }),
    );
    stripe.fetchOwedPayment.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const shown = await getBillingStatus(actor);

    expect(shown.subscription).toMatchObject({
      status: "incomplete",
      lastPaymentError: null,
      awaitingAuthentication: false,
      expiresAt: "2026-09-24T23:00:00.000Z",
    });
  });

  /**
   * Stripe's price API unreachable, or a restricted key without price read.
   * Everything the tab can still do — Pay now, Finish your payment, replacing
   * a card, cancelling — depends on neither price, and `PlanPage` returns
   * "Your plan could not be loaded" before every one of those buttons if this
   * read throws. There is no portal to fall back to, so the load has to
   * survive with the figures missing rather than fail whole.
   */
  it("still renders the tab when the prices cannot be read", async () => {
    const actor = await seed("prices-unreadable");
    await subscribe(actor.userId, {
      status: "past_due",
      priceId: "price_monthly",
      pastDueSince: new Date(),
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.fetchPlanPrices.mockRejectedValue(
      Object.assign(new Error("Permission denied."), { code: "more_permissions_required" }),
    );
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "past_due", priceId: "price_monthly" }),
    );

    const shown = await getBillingStatus(actor);

    // The two figures are the only thing missing.
    expect(shown.prices).toEqual({ monthly: null, yearly: null });
    // Pay now hangs off this, and it is worked out from the stored row against
    // the configured price ids rather than from the prices that failed.
    expect(shown.subscription).toMatchObject({ status: "past_due", payable: true });
    // The grace still entitles them, which comes from the row and not Stripe.
    expect(shown.entitlement).toMatchObject({ plan: "plus", source: "subscription" });
    // Whether to offer a sale is the last price *check*, a different question
    // from whether this one read succeeded.
    expect(shown.selling).toBe(true);
  });

  /**
   * And where the subscription itself cannot be re-read. The re-read is an
   * improvement on the stored row — it is what stops the tab saying "Payment
   * failed" beside a live Pay now — not a condition of showing one, and a
   * subscription nobody can reach is still a subscription worth rendering.
   */
  it("still renders the tab when the subscription cannot be re-read", async () => {
    const actor = await seed("resync-unreadable");
    const began = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await subscribe(actor.userId, {
      status: "past_due",
      priceId: "price_monthly",
      pastDueSince: began,
      syncedAt: new Date(Date.now() - 60_000),
    });
    stripe.fetchSubscriptionSnapshot.mockRejectedValue(new Error("connect ETIMEDOUT"));

    const shown = await getBillingStatus(actor);

    expect(shown.subscription).toMatchObject({
      status: "past_due",
      payable: true,
      pastDueSince: began.toISOString(),
      // Seeded here, never Stripe's 2027-06-01: this is the stored row being
      // shown, rather than a read that quietly succeeded.
      currentPeriodEnd: "2027-01-01T00:00:00.000Z",
    });
    // The read that failed is the one that would have named an invoice, so
    // nothing goes on to ask about the payment.
    expect(stripe.fetchOwedPayment).not.toHaveBeenCalled();
    // And the reads beside it are untouched.
    expect(shown.prices.monthly).toMatchObject({ id: "price_monthly", unitAmount: 300 });
    expect(shown.entitlement).toMatchObject({ plan: "plus" });
  });

  it("asks Stripe nothing about a subscription that owes nothing", async () => {
    const actor = await seed("owes-nothing");
    await subscribe(actor.userId);

    const shown = await getBillingStatus(actor);

    expect(stripe.fetchSubscriptionSnapshot).not.toHaveBeenCalled();
    expect(stripe.fetchOwedPayment).not.toHaveBeenCalled();
    expect(shown.subscription).toMatchObject({
      lastPaymentError: null,
      awaitingAuthentication: false,
      nextRetryAt: null,
      expiresAt: null,
    });
  });
});

/**
 * Two Annual presses that overlap. The upgrade stored nothing until after the
 * lock was let go, so the press waiting on it read monthly again and sent Stripe
 * a second anchor-now update, which moved the renewal a second time and left a
 * zero-amount proration on the next invoice.
 */
integration("two Annual presses at once", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("upgrades once, and answers the second press from the upgraded row", async () => {
    const actor = await seed("double-upgrade");
    await mapCustomer(actor.userId, "cus_double_upgrade");
    await subscribe(actor.userId, { priceId: "price_monthly" });
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    stripe.switchStripeSubscriptionNow.mockImplementation(async ({ subscriptionId }) => {
      await slow;
      return {
        snapshot: snapshotOf(subscriptionId, { status: "active", priceId: "price_yearly" }),
        invoice: "paid" as const,
      };
    });

    const first = setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(stripe.switchStripeSubscriptionNow).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ status: "active", clientSecret: null });
    expect(b).toMatchObject({ status: "active", clientSecret: null });
    expect((await storedSubscription(actor.userId))?.priceId).toBe("price_yearly");
  });
});

/**
 * The same plan change sent twice under one idempotency key — a double submit,
 * or a browser retrying after a dropped response.
 *
 * The replay is the reason billing idempotency exists, and what it hands back
 * matters as much as what it declines to repeat. A `clientSecret` authorizes
 * confirming a payment, the row it would be stored in is never deleted, and
 * handed out a second time the page mounts a payment form against an intent
 * Stripe has already confirmed. So the answer survives the replay and the
 * secret does not, which the caller reads as "there is nothing left to
 * confirm" — and if there is, the page asks for a fresh one.
 */
integration("a plan change submitted twice under one key", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("replays the answer without the secret, and without going back to Stripe", async () => {
    const actor = await seed("replay-key");
    await mapCustomer(actor.userId, "cus_replay");
    stripe.createStripeSubscription.mockResolvedValue({
      subscriptionId: "sub_replay",
      clientSecret: "pi_replay_secret",
      snapshot: snapshotOf("sub_replay", {
        status: "incomplete",
        priceId: "price_yearly",
        syncedAt: new Date(Date.now() - 1000),
      }),
    });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) =>
      snapshotOf(id, { status: "incomplete", priceId: "price_yearly" }),
    );
    // What the live path would answer a second press with — the stored
    // subscription is `incomplete`, so a press that reached Stripe again would
    // be a `resume` and would fetch this. Without it, `clientSecret: null`
    // below would pass against a build that never hands one out at all.
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_resumed_secret");
    const key = "replay-once";

    const first = await setSubscription(actor, { interval: "yearly", idempotencyKey: key });
    // Proof the live path really does hand out a secret.
    expect(first).toMatchObject({
      subscriptionId: "sub_replay",
      clientSecret: "pi_replay_secret",
    });

    const second = await setSubscription(actor, { interval: "yearly", idempotencyKey: key });

    expect(stripe.createStripeSubscription).toHaveBeenCalledTimes(1);
    // Nothing was asked of Stripe at all on the second press: the answer came
    // out of the operation row.
    expect(stripe.fetchSubscriptionClientSecret).not.toHaveBeenCalled();
    expect(second).toMatchObject({
      subscriptionId: "sub_replay",
      status: "incomplete",
      clientSecret: null,
    });

    // And the secret is not at rest in the row the replay is served from.
    const [stored] = await getDb()
      .select({ state: billingOperations.state, result: billingOperations.result })
      .from(billingOperations)
      .where(
        and(
          eq(billingOperations.userId, actor.userId),
          eq(billingOperations.operation, "subscription.set"),
          eq(billingOperations.key, key),
        ),
      );
    expect(stored).toMatchObject({
      state: "succeeded",
      result: { subscriptionId: "sub_replay", clientSecret: null },
    });
  });
});

/**
 * A change of interval while a cancellation is pending. A move to monthly
 * quietly turned renewal back on, and a move to annual charged the difference
 * for a year set to end; renewing again is Keep my plan's to agree to.
 */
integration("changing plan while it is set to end", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("refuses either change of interval, and sends Stripe nothing", async () => {
    for (const [on, asked] of [
      ["price_monthly", "yearly"],
      ["price_yearly", "monthly"],
    ] as const) {
      const actor = await seed(`ending-${asked}`);
      await mapCustomer(actor.userId, `cus_ending_${asked}`);
      await subscribe(actor.userId, { priceId: on, cancelAtPeriodEnd: true });

      await expect(
        setSubscription(actor, { interval: asked, idempotencyKey: idempotencyKey() }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        message: PLAN_ENDING_REFUSAL,
        details: { planEnding: true },
      });
    }
    expect(stripe.stripeCustomerStanding).not.toHaveBeenCalled();
    expect(stripe.switchStripeSubscriptionNow).not.toHaveBeenCalled();
    expect(stripe.scheduleStripeSubscriptionPrice).not.toHaveBeenCalled();
    expect(stripe.releaseStripeSchedule).not.toHaveBeenCalled();
  });

  /**
   * The other spelling, and the one the refusal used to miss entirely: a day an
   * operator set in Stripe's dashboard, past the stored period end. That period
   * really does renew, so `cancel_at_period_end` is false — and read off that
   * flag alone the cancellation did not exist, so both presses went through.
   * The downgrade's schedule replayed the cancel date as a phase boundary and
   * then appended a phase past it with `end_behavior: "release"`, destroying the
   * cancellation; the upgrade billed a year's difference against a subscription
   * Stripe was about to stop.
   */
  it("refuses a cancellation dated past the period end just the same", async () => {
    for (const [on, asked] of [
      ["price_monthly", "yearly"],
      ["price_yearly", "monthly"],
    ] as const) {
      const actor = await seed(`ending-later-${asked}`);
      await mapCustomer(actor.userId, `cus_ending_later_${asked}`);
      await subscribe(actor.userId, {
        priceId: on,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAt: new Date("2027-11-13T18:53:33.000Z"),
      });

      await expect(
        setSubscription(actor, { interval: asked, idempotencyKey: idempotencyKey() }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
        message: PLAN_ENDING_REFUSAL,
        details: { planEnding: true },
      });
    }
    expect(stripe.switchStripeSubscriptionNow).not.toHaveBeenCalled();
    expect(stripe.scheduleStripeSubscriptionPrice).not.toHaveBeenCalled();
  });

  /**
   * And the day is what the browser reads it from, so the tab can disable the
   * same buttons for the same reason. `cancelAtPeriodEnd` stays false here
   * because the status line's date is `currentPeriodEnd`, which this period
   * genuinely reaches.
   */
  it("reports the day beside the flag, each answering its own question", async () => {
    const actor = await seed("ending-later-status");
    await mapCustomer(actor.userId, "cus_ending_later_status");
    await subscribe(actor.userId, {
      cancelAtPeriodEnd: false,
      cancelAt: new Date("2027-11-13T18:53:33.000Z"),
    });

    await expect(getBillingStatus(actor)).resolves.toMatchObject({
      subscription: {
        cancelAtPeriodEnd: false,
        cancelAt: "2027-11-13T18:53:33.000Z",
      },
    });
  });

  it("still takes payment of what is owed, and a repeat of the plan they are on", async () => {
    const actor = await seed("ending-owes");
    await mapCustomer(actor.userId, "cus_ending_owes");
    await subscribe(actor.userId, {
      status: "past_due",
      pastDueSince: new Date(),
      cancelAtPeriodEnd: true,
    });
    stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_owed_while_ending");

    await expect(
      setSubscription(actor, { interval: "monthly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ clientSecret: "pi_owed_while_ending" });

    const paidUp = await seed("ending-repeat");
    await mapCustomer(paidUp.userId, "cus_ending_repeat");
    await subscribe(paidUp.userId, { cancelAtPeriodEnd: true });
    await expect(
      setSubscription(paidUp, { interval: "monthly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ clientSecret: null });
  });
});

/**
 * Replacing a card while a renewal is owed, and what the answer says about the
 * invoice. `paidInvoice: false` meant both "nothing was owed" and "the new card
 * was declined for it", so the page closed the form as a success over a card
 * that had just failed.
 */
integration("confirming a replacement card", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const replacing = async (id: string, status = "past_due", type = "card") => {
    const actor = await seed(id);
    await mapCustomer(actor.userId, `cus_${id}`);
    await subscribe(actor.userId, {
      status,
      pastDueSince: status === "past_due" ? new Date() : null,
    });
    stripe.fetchStripeSetupIntent.mockResolvedValue({
      status: "succeeded",
      customerId: `cus_${id}`,
      paymentMethodId: "pm_replacement",
      paymentMethodCreated: new Date(),
      paymentMethodType: type,
    });
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (sub: string) =>
      snapshotOf(sub, { status, priceId: "price_monthly" }),
    );
    return actor;
  };
  const confirming = (actor: Actor) =>
    confirmPaymentSetup(actor, {
      setupIntentId: "seti_replacement",
      idempotencyKey: idempotencyKey(),
    });

  it("says the new card paid what was owed", async () => {
    const actor = await replacing("replace-paid");
    stripe.openStripeInvoiceFor.mockResolvedValue("in_owed");

    await expect(confirming(actor)).resolves.toEqual({
      attached: true,
      paidInvoice: true,
      invoice: "paid",
      declineMessage: null,
    });
    expect(stripe.payStripeInvoice).toHaveBeenCalledWith(
      "in_owed",
      expect.stringMatching(/:invoice$/),
    );
  });

  it("says the new card was declined for what is owed, in Stripe's words", async () => {
    const actor = await replacing("replace-declined");
    stripe.openStripeInvoiceFor.mockResolvedValue("in_owed");
    stripe.payStripeInvoice.mockRejectedValue(
      Object.assign(new Error("Your card was declined."), {
        type: "StripeCardError",
        code: "card_declined",
      }),
    );

    await expect(confirming(actor)).resolves.toEqual({
      attached: true,
      paidInvoice: false,
      invoice: "declined",
      declineMessage: "Your card was declined.",
    });
  });

  it("says the bank wants the payment confirmed, which only Pay now can do", async () => {
    const actor = await replacing("replace-authenticate");
    stripe.openStripeInvoiceFor.mockResolvedValue("in_owed");
    stripe.payStripeInvoice.mockRejectedValue(
      Object.assign(new Error("This payment requires additional user action."), {
        code: "invoice_payment_intent_requires_action",
      }),
    );

    await expect(confirming(actor)).resolves.toMatchObject({
      invoice: "needs_authentication",
      declineMessage: null,
    });
  });

  it("never says nothing was owed where it could not find out and the row says something is", async () => {
    const actor = await replacing("replace-unread");
    stripe.openStripeInvoiceFor.mockRejectedValue(new Error("connect ETIMEDOUT"));

    await expect(confirming(actor)).resolves.toMatchObject({
      paidInvoice: false,
      invoice: "declined",
      declineMessage: null,
    });
  });

  it("says nothing was owed where nothing was", async () => {
    const actor = await replacing("replace-nothing-owed", "active");
    stripe.openStripeInvoiceFor.mockResolvedValue(null);

    await expect(confirming(actor)).resolves.toEqual({
      attached: true,
      paidInvoice: false,
      invoice: "none",
      declineMessage: null,
    });
  });

  it("turns away a method this product does not offer before anything is written", async () => {
    const actor = await replacing("replace-satispay", "past_due", "satispay");

    await expect(confirming(actor)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { paymentMethodType: "satispay" },
    });
    expect(stripe.setStripeDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(stripe.payStripeInvoice).not.toHaveBeenCalled();
  });

  it("answers a method the subscription refuses to bill with a sentence, and pays nothing", async () => {
    const actor = await replacing("replace-refused");
    stripe.setStripeDefaultPaymentMethod.mockRejectedValue(
      Object.assign(
        new Error("The payment method type `kakao_pay` does not support the currency usd."),
        {
          statusCode: 400,
          param: "default_payment_method",
        },
      ),
    );

    await expect(confirming(actor)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/cannot pay this subscription/),
    });
    expect(stripe.payStripeInvoice).not.toHaveBeenCalled();
  });

  /**
   * A first payment is the one outstanding invoice whose collection is a sale,
   * so this call asks `saleRefusal` before taking it — and on a deployment
   * that is selling the answer is yes. Without this the narrow guard in
   * `confirmPaymentSetup` could become "never finish a first payment here",
   * which is the card form closing over an invoice nothing will ever collect,
   * on the deployment that was happy to sell it.
   */
  it("finishes a first payment with the new card where the deployment is selling", async () => {
    const actor = await replacing("replace-first-payment", "incomplete");
    stripe.openStripeInvoiceFor.mockResolvedValue("in_first_payment");

    await expect(confirming(actor)).resolves.toMatchObject({
      paidInvoice: true,
      invoice: "paid",
    });
    expect(stripe.payStripeInvoice).toHaveBeenCalledWith(
      "in_first_payment",
      expect.stringMatching(/:invoice$/),
    );
  });

  /**
   * The other door a sale is refused through, and the one that has nothing to
   * do with winding down: prices that do not fit the plans they are sold as.
   * `setSubscription` refuses every press while that is true — a yearly price
   * on the monthly setting bills a year every month — and collecting the first
   * payment here would be that same charge, raised by the button beside it.
   */
  it("does not finish a first payment while the configured prices do not fit", async () => {
    const actor = await replacing("replace-first-misfit", "incomplete");
    stripe.lastPriceCheck.mockReturnValue(misfit);
    stripe.openStripeInvoiceFor.mockResolvedValue("in_first_misfit");

    await expect(confirming(actor)).resolves.toEqual({
      attached: true,
      paidInvoice: false,
      invoice: "none",
      declineMessage: null,
    });
    expect(stripe.payStripeInvoice).not.toHaveBeenCalled();
    // The card is pinned all the same: it is the half that is not a sale, and
    // it is what the subscriber needs in place before the prices are fixed.
    expect(stripe.setStripeDefaultPaymentMethod).toHaveBeenCalledTimes(1);
  });

  /**
   * The only route here that takes an identifier this deployment did not issue,
   * and one comparison is the whole of its cross-tenant guard: the SetupIntent
   * is read back from Stripe and refused unless its customer is the asker's.
   *
   * Every other case in this block mocks a matching customer, so the branch
   * that refuses was taken by nothing. What it costs to lose is not a write —
   * Stripe will not make a foreign PaymentMethod a customer's default — but the
   * answer: `notFound` is deliberately the same reply an id that does not exist
   * gets, and without the comparison the route distinguishes the two, which
   * makes it an existence oracle for another tenant's Stripe objects.
   */
  it("refuses a SetupIntent that belongs to another customer, and writes nothing", async () => {
    const asker = await replacing("replace-foreign");
    const other = await seed("replace-foreign-other");
    await mapCustomer(other.userId, "cus_replace_foreign_other");
    stripe.fetchStripeSetupIntent.mockResolvedValue({
      status: "succeeded",
      customerId: "cus_replace_foreign_other",
      paymentMethodId: "pm_someone_elses",
      paymentMethodCreated: new Date(),
      paymentMethodType: "card",
    });

    await expect(confirming(asker)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No such payment setup",
    });
    expect(stripe.setStripeDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(stripe.payStripeInvoice).not.toHaveBeenCalled();
  });
});

/**
 * A saved card's delivery that no retry can make good: a method this product
 * does not offer, or one the subscription refuses to bill in its currency. Each
 * was a 500 on every one of Stripe's retries for three days, while Stripe held
 * back the account's other invoices.
 */
integration("a setup_intent.succeeded delivery that cannot be pinned", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const delivery = (eventId: string) => ({
    id: eventId,
    type: "setup_intent.succeeded",
    data: { object: { id: `seti_${eventId}`, object: "setup_intent" } },
  });
  const claimed = async (eventId: string) =>
    (
      await getDb()
        .select()
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.eventId, eventId))
    ).length > 0;
  const saved = async (id: string, type: string) => {
    const actor = await seed(id);
    await mapCustomer(actor.userId, `cus_${id}`);
    await subscribe(actor.userId);
    stripe.fetchStripeSetupIntent.mockResolvedValue({
      status: "succeeded",
      customerId: `cus_${id}`,
      paymentMethodId: "pm_saved",
      paymentMethodCreated: new Date(),
      paymentMethodType: type,
    });
    stripe.currentStripeDefaultPaymentMethod.mockResolvedValue(null);
    return actor;
  };

  it("records a method this product does not offer and leaves the card Stripe bills alone", async () => {
    const actor = await saved("setup-unoffered", "naver_pay");

    await expect(applySetupIntentSucceeded(actor.userId, delivery("evt_unoffered"))).resolves.toBe(
      "ignored",
    );
    expect(stripe.setStripeDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(await claimed("evt_unoffered")).toBe(true);
  });

  it("records a method the subscription refuses, rather than failing every retry", async () => {
    const actor = await saved("setup-refused", "card");
    stripe.setStripeDefaultPaymentMethod.mockRejectedValue(
      Object.assign(
        new Error("The payment method type `satispay` does not support the currency usd."),
        {
          statusCode: 400,
          param: "default_payment_method",
        },
      ),
    );

    await expect(applySetupIntentSucceeded(actor.userId, delivery("evt_refused"))).resolves.toBe(
      "ignored",
    );
    expect(await claimed("evt_refused")).toBe(true);
    await expect(applySetupIntentSucceeded(actor.userId, delivery("evt_refused"))).resolves.toBe(
      "duplicate",
    );
  });
});

/**
 * The deletion note names the paid plan it cancels. A first payment that never
 * went through is a current subscription on the free plan, and its owner was
 * told their paid plan would be canceled.
 */
integration("whether deleting an account cancels a paid plan", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("counts every subscription paid for at least once, and not an unfinished first payment", async () => {
    for (const [status, answer] of [
      ["incomplete", false],
      ["active", true],
      ["past_due", true],
      ["unpaid", true],
    ] as const) {
      const actor = await seed(`deleting-${status}`);
      await subscribe(actor.userId, { status });
      expect(await hasLiveSubscription(actor), status).toBe(answer);
    }
  });
});

/**
 * What the plan tab can say about frozen accounts. The count of places in use
 * reads the same with none frozen or two, and on the paid plan there was no
 * count at all, so a subscriber about to cancel could not be told what freezes.
 */
integration("the plan tab's count of accounts", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const accounts = async (userId: string, count: number) => {
    for (let index = 0; index < count; index += 1) {
      await getDb()
        .insert(ledgerAccounts)
        .values({
          userId,
          name: `Account ${index + 1}`,
          type: "cash",
          currency: "USD",
          openingDate: "2026-01-01",
          createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        });
    }
  };

  it("counts the frozen accounts on the free plan, and says the choice is still open", async () => {
    const actor = await seed("counts-free");
    await accounts(actor.userId, 5);

    const shown = await getBillingStatus(actor);

    expect(shown).toMatchObject({
      accountsUsed: 3,
      accountsFrozen: 2,
      accountsLive: 5,
      activeChoicePending: true,
      // Nothing is being ended here, and the pair is still answered: the tab
      // is one page whichever plan is in force, so the fields do not come and
      // go with the subscription.
      accountsFrozenOnFree: 2,
      activeChoicePendingOnFree: true,
    });
  });

  it("says what ending a live subscription would freeze, while nothing is frozen yet", async () => {
    // The case the plan tab exists for: on the paid plan there is no count of
    // frozen accounts to show, because none is frozen, and the person about to
    // press Cancel is the one who needs the number.
    const actor = await seed("counts-ending");
    await accounts(actor.userId, 5);
    await subscribe(actor.userId);

    expect(await getBillingStatus(actor)).toMatchObject({
      accountsUsed: null,
      accountsFrozen: null,
      accountsLive: 5,
      accountsFrozenOnFree: 2,
      activeChoicePendingOnFree: true,
    });
  });

  it("counts under a grant that runs out before the paid period does", async () => {
    // The grant keeps the limit off today and not on the day the plan ends,
    // so the count has to be asked of the period end rather than of now. Asked
    // of now it answered null and the tab said nothing whatever about the two
    // accounts that freeze the moment the subscription lapses.
    const actor = await seed("counts-grant-lapses");
    await accounts(actor.userId, 5);
    await subscribe(actor.userId);
    await getDb()
      .insert(billingOverrides)
      .values({
        userId: actor.userId,
        plan: "plus",
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        reason: "test",
        operator: "test",
      });

    expect(await getBillingStatus(actor)).toMatchObject({
      accountsFrozen: null,
      accountsLive: 5,
      accountsFrozenOnFree: 2,
      activeChoicePendingOnFree: true,
    });
  });

  it("says nothing would freeze while a second subscription is live", async () => {
    // Canceling one of two. The count drops the row the Cancel button ends and
    // keeps the rest, because dropping every subscription answers "what if
    // this person had none" — a different question, and the wrong one here.
    const actor = await seed("counts-two-live");
    await accounts(actor.userId, 5);
    await subscribe(actor.userId);
    await subscribe(actor.userId, {
      stripeSubscriptionId: `sub_${actor.userId}_trial`,
      status: "trialing",
      syncedAt: new Date(Date.now() - 60_000),
    });

    expect(await getBillingStatus(actor)).toMatchObject({
      accountsLive: 5,
      accountsFrozenOnFree: null,
      activeChoicePendingOnFree: false,
    });
  });

  it("counts the live accounts on the paid plan, where none is frozen", async () => {
    const actor = await seed("counts-premium");
    await accounts(actor.userId, 5);
    await getDb().insert(billingOverrides).values({
      userId: actor.userId,
      plan: "plus",
      expiresAt: null,
      reason: "test",
      operator: "test",
    });

    const shown = await getBillingStatus(actor);

    expect(shown).toMatchObject({
      accountsUsed: null,
      accountsFrozen: null,
      accountsLive: 5,
      activeChoicePending: false,
      // The grant has no end date, so it outlives any subscription and no
      // limit would be in force once one ended. Null, not zero: "how many
      // would freeze" has no answer rather than the answer none.
      accountsFrozenOnFree: null,
      activeChoicePendingOnFree: false,
    });
  });
});

/**
 * An operator's grant, against the one route that spends money.
 *
 * A grant already beats Stripe in `resolveEntitlement`, so before this every
 * sale under one charged for a plan the person already had, and the only place
 * it showed was the Stripe dashboard: the tab said Premium, the grant note said
 * Premium, and the charge went through. `docs/billing-operations.md` Granting a
 * plan by hand names "somebody whose payment went wrong" as the case to use it
 * for, which is precisely somebody holding an unfinished subscription with a
 * live button on it.
 */
integration("what an operator's grant refuses", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const grant = async (userId: string, expiresAt: Date | null = null) => {
    await getDb()
      .insert(billingOverrides)
      .values({ userId, plan: "plus", expiresAt, reason: "Integration test", operator: "test" });
  };

  it("refuses a first subscription before anything reaches Stripe", async () => {
    const actor = await seed("grant-refused-first");
    await grant(actor.userId);

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: PLAN_GRANTED_REFUSAL,
      details: { planGranted: true },
    });
    // The early read earns its place here: no customer is made for a request
    // that was never going to be allowed to buy anything.
    expect(stripe.createStripeCustomer).not.toHaveBeenCalled();
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
  });

  it("refuses an upgrade on a subscription somebody already has", async () => {
    const actor = await seed("grant-refused-upgrade");
    await mapCustomer(actor.userId, "cus_grant_upgrade");
    await subscribe(actor.userId, { priceId: "price_monthly" });
    await grant(actor.userId);

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { planGranted: true } });
    expect(stripe.switchStripeSubscriptionNow).not.toHaveBeenCalled();
  });

  /**
   * The decision is made late, not carried down from the edge. The grant is
   * written here *after* the early read has already let the request through,
   * so a service that reused that answer would charge this card -- which is
   * the failure `docs/standards/code/services.md` 2.8 calls out by name,
   * resolving an entitlement once in the route and passing the answer along.
   *
   * What this does *not* pin is the `tx` argument on that second read. Proved
   * by mutation: changing it to `getEntitlement(actor)` leaves all 82 cases
   * here green, because by then the grant is committed and a pool read sees it
   * too. The argument still has to be the transaction's -- a second connection
   * taken while `lockBillingState` is held deadlocks on the one-connection
   * pool the deployment profiles document -- but that is held by 2.8 and by
   * review, not by this test, and saying otherwise would make this one of the
   * checks that cannot fail for what it claims.
   */
  it("refuses a grant written while the request was already in flight", async () => {
    const actor = await seed("grant-mid-flight");
    await mapCustomer(actor.userId, "cus_grant_midflight");

    stripe.stripeCustomerStanding.mockImplementationOnce(async () => {
      await grant(actor.userId);
      return "present";
    });

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { planGranted: true } });
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
  });

  /**
   * And the line inside `resume`, which is the service's own rather than a
   * second one: `sellsSomething` counts a resume as a sale on `incomplete`
   * only. A renewal whose retries ran out is a debt on a subscription that did
   * run, and settling it is not buying a plan, so a grant leaves it alone --
   * which also keeps `docs/standards/http.md`'s "paying what is owed still
   * succeeds" true.
   */
  it("leaves a renewal that is owed payable", async () => {
    const actor = await seed("grant-owed-renewal");
    await mapCustomer(actor.userId, "cus_grant_owed");
    await subscribe(actor.userId, { status: "unpaid", priceId: "price_yearly" });
    await grant(actor.userId);

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).resolves.toMatchObject({ subscriptionId: `sub_${actor.userId}` });
  });

  it("stops refusing once the grant has expired", async () => {
    const actor = await seed("grant-expired");
    await mapCustomer(actor.userId, "cus_grant_expired");
    await grant(actor.userId, new Date(Date.now() - 60_000));

    await expect(
      setSubscription(actor, { interval: "yearly", idempotencyKey: idempotencyKey() }),
    ).resolves.toBeTruthy();
  });
});
