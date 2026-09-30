/**
 * Replacing a card: the secret the form opens with, and the delivery that pins
 * the card when the form's own request never arrives.
 *
 * Billing on and selling, for this file only. Set at module scope because
 * `getConfig` memoizes on first call, and restored in `afterAll` because
 * `vitest.config.ts` sets `fileParallelism: false` — every integration file
 * shares one process.
 *
 * A file of its own rather than more of `billing-stripe`, which already runs
 * long: the harness is the same and the subject is not. Everything here is one
 * of the two halves of replacing a card — `createPaymentSetup` opening the
 * form, `confirmPaymentSetup` finishing it, `applySetupIntentSucceeded`
 * standing in for a browser that never came back — and every case is one the
 * happy path does not reach.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_billing_card",
  STRIPE_PUBLISHABLE_KEY: "pk_test_billing_card",
  STRIPE_WEBHOOK_SECRET: "whsec_billing_card",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 * Stripe, replaced at the one module that talks to it — the same doubles
 * `billing-stripe` uses, narrowed to the calls these two paths make.
 * `isOfferedPaymentMethodType`, `isUnusableDefaultPaymentMethod` and
 * `invoicePaymentRefusal` are deliberately left real: each is a reading of
 * Stripe's own answers rather than a call to Stripe, and a double would test
 * the double.
 */
const stripe = vi.hoisted(() => ({
  lastPriceCheck: vi.fn(),
  fetchPlanPrices: vi.fn(),
  stripeCustomerStanding: vi.fn(),
  createStripeCustomer: vi.fn(),
  deleteStripeCustomer: vi.fn(),
  fetchSubscriptionSnapshot: vi.fn(),
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

import {
  applySetupIntentSucceeded,
  confirmPaymentSetup,
  createPaymentSetup,
} from "../../src/server/services/billing.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("billing_card");

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seed = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
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
    .where(eq(billingSubscriptions.stripeSubscriptionId, id));
  return row;
};

/** What Stripe would say about a subscription on re-read, stamped now. */
const snapshotOf = (id: string, over: Record<string, unknown> = {}) => ({
  stripeSubscriptionId: id,
  status: "active",
  priceId: "price_monthly",
  currentPeriodEnd: new Date("2027-06-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  scheduledPriceId: null,
  scheduledAt: null,
  syncedAt: new Date(),
  stripeCustomerId: null,
  ...over,
});

let keyCounter = 0;
const idempotencyKey = () => `card-key-${(keyCounter += 1)}-${Date.now()}`;

beforeEach(() => {
  for (const double of Object.values(stripe)) double.mockReset();
  stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "live" });
  stripe.fetchPlanPrices.mockResolvedValue({
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  });
  stripe.stripeCustomerStanding.mockResolvedValue("present");
  stripe.createStripeCustomer.mockResolvedValue("cus_new");
  stripe.createStripeSetupIntent.mockResolvedValue({ id: "seti_new", clientSecret: "seti_secret" });
  stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => snapshotOf(id));
  stripe.setStripeDefaultPaymentMethod.mockResolvedValue(undefined);
  stripe.currentStripeDefaultPaymentMethod.mockResolvedValue(null);
  stripe.openStripeInvoiceFor.mockResolvedValue(null);
});

integration("replacing the card a subscription is billed on", () => {
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

  /**
   * The subscription named on the last pin. Read off the call rather than
   * asserted against a literal in two places, because the question both halves
   * of this feature have to answer the same way is *which row* they picked.
   */
  const lastPinned = () => {
    const call = stripe.setStripeDefaultPaymentMethod.mock.calls.at(-1);
    expect(call, "nothing was pinned").toBeDefined();
    return (call![0] as { subscriptionId: string | null }).subscriptionId;
  };

  /**
   * The answer is the whole point of `createPaymentSetup`: PlanPage only opens
   * the card form when `result.clientSecret` is there, so a null is not an
   * error anybody sees — the button does nothing. Nothing in the tree read
   * this answer, so dropping the secret was a silent change.
   */
  it("hands back the secret the card form opens with, and never a second time", async () => {
    const actor = await seed("card-secret");
    await mapCustomer(actor.userId, "cus_card_secret");
    await subscribe(actor.userId);
    const key = idempotencyKey();

    await expect(createPaymentSetup(actor, { idempotencyKey: key })).resolves.toEqual(
      expect.objectContaining({ clientSecret: "seti_secret" }),
    );

    /*
     * The same key again is the replay, and `withoutSecrets` is why it comes
     * back null: a `clientSecret` authorizes attaching a card and the row it
     * would be stored in is never deleted. A browser that still needs one asks
     * for a fresh key. What must not happen is a second SetupIntent at Stripe.
     */
    await expect(createPaymentSetup(actor, { idempotencyKey: key })).resolves.toEqual(
      expect.objectContaining({ clientSecret: null }),
    );
    expect(stripe.createStripeSetupIntent).toHaveBeenCalledTimes(1);
    expect(stripe.createStripeSetupIntent).toHaveBeenCalledWith(
      "cus_card_secret",
      expect.any(String),
    );
  });

  /**
   * The delivery Stripe sends when the browser half never came back. Its happy
   * path — a live subscription, a newer card, a clean re-read — is covered in
   * `billing-stripe`; every case here is one of the branches around it, and
   * each of them is somebody's card.
   */
  describe("pinning a card from a setup_intent.succeeded delivery", () => {
    /**
     * A payload with no id at all. There is nothing to re-read, so the only
     * safe answer is to ignore it — and ignoring it must not cost a call to
     * Stripe, which is what asking about `undefined` would be.
     */
    it("ignores a delivery whose payload names no setup intent", async () => {
      const actor = await seed("card-no-id");
      await mapCustomer(actor.userId, "cus_card_no_id");

      await expect(
        applySetupIntentSucceeded(actor.userId, {
          id: "evt_card_no_id",
          type: "setup_intent.succeeded",
          data: { object: { object: "setup_intent" } },
        }),
      ).resolves.toBe("ignored");
      expect(stripe.fetchStripeSetupIntent).not.toHaveBeenCalled();
      expect(stripe.setStripeDefaultPaymentMethod).not.toHaveBeenCalled();
      // Unclaimed, because nothing was decided: a delivery this deployment
      // could not read is not one it has answered.
      expect(await claimed("evt_card_no_id")).toBe(false);
    });

    /**
     * Stripe's own re-read disagreeing with the delivery is the one exit that
     * returns without claiming, and that is deliberate rather than an
     * oversight: the intent may still succeed, and a claim would answer every
     * one of Stripe's remaining 72 hours of retries "duplicate" and pin
     * nothing. Every neighbouring exit claims, so making this one match them
     * is the obvious tidy-up — and it would cost somebody their card.
     */
    it("leaves a delivery Stripe's own re-read cannot confirm for Stripe to retry", async () => {
      /*
       * Three ways the re-read disagrees with the delivery, and one answer:
       * ignored, and *not* claimed. Looped rather than three tests because
       * what is being defended is the single `if` all three fall into.
       */
      const unconfirmed = [
        ["not-succeeded", { status: "requires_action" }],
        ["no-card", { paymentMethodId: null }],
        ["no-customer", { customerId: null }],
      ] as const;
      for (const [label, over] of unconfirmed) {
        const actor = await seed(`card-unread-${label}`);
        await mapCustomer(actor.userId, `cus_card_${label}`);
        await subscribe(actor.userId);
        stripe.setStripeDefaultPaymentMethod.mockClear();
        stripe.fetchStripeSetupIntent.mockResolvedValue({
          status: "succeeded",
          customerId: `cus_card_${label}`,
          paymentMethodId: "pm_new",
          paymentMethodType: "card",
          paymentMethodCreated: new Date("2026-09-03T00:00:00.000Z"),
          ...over,
        });

        await expect(
          applySetupIntentSucceeded(actor.userId, delivery(`evt_card_${label}`, `seti_${label}`)),
        ).resolves.toBe("ignored");
        expect(stripe.setStripeDefaultPaymentMethod).not.toHaveBeenCalled();
        expect(await claimed(`evt_card_${label}`), label).toBe(false);
      }
    });

    /**
     * The case this branch exists for, and the one that is somebody's money: a
     * subscriber whose plan lapsed — Stripe gave up on dunning and the row
     * reads `canceled` — presses Replace card to get back on, and the 3-D
     * Secure redirect comes back to a tab that is gone. The delivery is then
     * the only thing that pins the card, and with no live subscription to pin
     * it to the pin must land on the customer, which is what the *next*
     * subscription they start will bill.
     *
     * The row is seeded rather than left out, so what is proved is the
     * `liveStatuses` filter and not merely the absence of a subscription:
     * passing `sub_card-lapsed` to Stripe would be a 400 on a canceled
     * subscription, and pinning nothing.
     */
    it("pins a lapsed subscriber's card to the customer alone, and re-reads no subscription", async () => {
      const actor = await seed("card-lapsed");
      await mapCustomer(actor.userId, "cus_card_lapsed");
      await subscribe(actor.userId, { status: "canceled" });
      stripe.fetchStripeSetupIntent.mockResolvedValue({
        status: "succeeded",
        customerId: "cus_card_lapsed",
        paymentMethodId: "pm_lapsed_new",
        paymentMethodType: "card",
        paymentMethodCreated: new Date("2026-09-03T00:00:00.000Z"),
      });

      await expect(
        applySetupIntentSucceeded(actor.userId, delivery("evt_card_lapsed", "seti_lapsed")),
      ).resolves.toBe("written");
      expect(stripe.currentStripeDefaultPaymentMethod).toHaveBeenCalledWith({
        customerId: "cus_card_lapsed",
        subscriptionId: null,
      });
      expect(stripe.setStripeDefaultPaymentMethod).toHaveBeenCalledTimes(1);
      expect(stripe.setStripeDefaultPaymentMethod).toHaveBeenCalledWith(
        { customerId: "cus_card_lapsed", subscriptionId: null, paymentMethodId: "pm_lapsed_new" },
        "setup:seti_lapsed",
      );
      // No subscription to re-read, so none is read: the resync is skipped
      // rather than run against a canceled id.
      expect(stripe.fetchSubscriptionSnapshot).not.toHaveBeenCalled();
      expect(await claimed("evt_card_lapsed")).toBe(true);
    });

    /**
     * The re-read after the claim, which is what keeps the plan tab from
     * showing a status Stripe has since changed. Asserted on the stored row
     * rather than on the call, because a re-read whose answer is thrown away
     * would satisfy `toHaveBeenCalledWith` and leave the tab exactly as stale.
     */
    it("re-reads the subscription after pinning, and stores what Stripe said", async () => {
      const actor = await seed("card-resync");
      await mapCustomer(actor.userId, "cus_card_resync");
      await subscribe(actor.userId, {
        status: "past_due",
        pastDueSince: new Date("2026-08-01T00:00:00.000Z"),
        syncedAt: new Date("2026-08-01T00:00:00.000Z"),
      });
      stripe.fetchStripeSetupIntent.mockResolvedValue({
        status: "succeeded",
        customerId: "cus_card_resync",
        paymentMethodId: "pm_resync",
        paymentMethodType: "card",
        paymentMethodCreated: new Date("2026-09-03T00:00:00.000Z"),
      });
      // The card was pinned and Stripe's retry went through, so the row Stripe
      // hands back on re-read is active again.
      stripe.fetchSubscriptionSnapshot.mockResolvedValue(
        snapshotOf("sub_card-resync", { status: "active" }),
      );

      await expect(
        applySetupIntentSucceeded(actor.userId, delivery("evt_card_resync", "seti_resync")),
      ).resolves.toBe("written");

      const stored = await storedSubscription(actor.userId);
      expect(stored?.status).toBe("active");
      // And the grace stopped counting, which is the column the plan tab dates
      // the lapse from.
      expect(stored?.pastDueSince).toBeNull();
      expect(stripe.fetchSubscriptionSnapshot).toHaveBeenCalledWith("sub_card-resync");
    });

    /**
     * And the re-read failing changes none of that. The card is pinned at
     * Stripe and the delivery is claimed before this runs, so throwing here
     * would have Stripe redeliver an event whose work is already done — and
     * the sweep re-reads the subscription within twelve hours regardless.
     */
    it("still reports the card pinned when the re-read fails", async () => {
      const actor = await seed("card-resync-fails");
      await mapCustomer(actor.userId, "cus_card_resync_fails");
      await subscribe(actor.userId);
      stripe.fetchStripeSetupIntent.mockResolvedValue({
        status: "succeeded",
        customerId: "cus_card_resync_fails",
        paymentMethodId: "pm_resync_fails",
        paymentMethodType: "card",
        paymentMethodCreated: new Date("2026-09-03T00:00:00.000Z"),
      });
      stripe.fetchSubscriptionSnapshot.mockRejectedValue(
        new Error("Stripe is having an afternoon"),
      );

      await expect(
        applySetupIntentSucceeded(
          actor.userId,
          delivery("evt_card_resync_fails", "seti_resync_fails"),
        ),
      ).resolves.toBe("written");
      expect(stripe.setStripeDefaultPaymentMethod).toHaveBeenCalledTimes(1);
      expect(await claimed("evt_card_resync_fails")).toBe(true);
    });

    /**
     * The two halves of replacing a card must name the same subscription.
     *
     * They did not for a release: `applySetupIntentSucceeded` ordered by
     * `synced_at` ascending and took the first — the oldest read — while
     * `confirmPaymentSetup` goes through `currentSubscription`, which sorts
     * newest first. On the one account where that differs, somebody who has
     * canceled and resubscribed, the delivery pinned the replacement card to
     * the abandoned subscription and dunning went on retrying the card that
     * failed. The delivery half is the half that runs when the browser never
     * came back, which is the whole reason it exists — so it was precisely the
     * person who could not correct it themselves who got the wrong row.
     *
     * Both halves are asserted here rather than only the one that was wrong,
     * because the defect was never in either half alone: it was the two
     * spellings of "the current subscription" disagreeing.
     */
    it("pins the card to the subscription that is billing, not the oldest row read", async () => {
      const actor = await seed("card-two-live");
      await mapCustomer(actor.userId, "cus_card_two_live");
      const abandoned = "sub_card_two_live_abandoned";
      const billing = "sub_card_two_live_billing";
      await subscribe(actor.userId, {
        stripeSubscriptionId: abandoned,
        status: "incomplete",
        syncedAt: new Date("2026-09-01T00:00:00.000Z"),
      });
      await subscribe(actor.userId, {
        stripeSubscriptionId: billing,
        status: "active",
        syncedAt: new Date("2026-09-02T00:00:00.000Z"),
      });
      stripe.fetchStripeSetupIntent.mockResolvedValue({
        status: "succeeded",
        customerId: "cus_card_two_live",
        paymentMethodId: "pm_two_live",
        paymentMethodType: "card",
        paymentMethodCreated: new Date("2026-09-03T00:00:00.000Z"),
      });

      await expect(
        applySetupIntentSucceeded(actor.userId, delivery("evt_card_two_live", "seti_two_live")),
      ).resolves.toBe("written");
      const byDelivery = lastPinned();

      stripe.setStripeDefaultPaymentMethod.mockClear();
      await confirmPaymentSetup(actor, {
        setupIntentId: "seti_two_live",
        idempotencyKey: idempotencyKey(),
      });
      const byBrowser = lastPinned();

      // The row that is billing, named by both halves. Written as the fixture's
      // own two ids so neither assertion can be satisfied by the other.
      expect(byDelivery).toBe(billing);
      expect(byBrowser).toBe(billing);
      expect(byDelivery).not.toBe(abandoned);
    });
  });
});
