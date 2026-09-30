/**
 * Stripe configured, nothing for sale — the state an operator winds down into,
 * with subscribers still being charged at Stripe.
 *
 * A file of its own because `getConfig` memoizes on first call, so whether a
 * deployment is selling is fixed for the life of the process. Restored in
 * `afterAll` because every integration file shares one process.
 */
const woundDownEnvironment = {
  STRIPE_SECRET_KEY: "sk_test_billing_wound_down",
  STRIPE_PUBLISHABLE_KEY: "pk_test_billing_wound_down",
  STRIPE_WEBHOOK_SECRET: "whsec_billing_wound_down",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(woundDownEnvironment).map((key) => [key, process.env[key]]),
);
const originalSelling = process.env.SB_BILLING_ENABLED;
Object.assign(process.env, woundDownEnvironment);
delete process.env.SB_BILLING_ENABLED;

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingCustomers, billingSubscriptions, user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

const stripe = vi.hoisted(() => ({
  lastPriceCheck: vi.fn(),
  fetchPlanPrices: vi.fn(),
  stripeCustomerStanding: vi.fn(),
  createStripeCustomer: vi.fn(),
  createStripeSubscription: vi.fn(),
  fetchSubscriptionSnapshot: vi.fn(),
  fetchSubscriptionClientSecret: vi.fn(),
  createStripeSetupIntent: vi.fn(),
  keepCardThatPays: vi.fn(),
  fetchOwedPayment: vi.fn(),
}));
vi.mock("../../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/stripe.js")>()),
  ...stripe,
}));

import {
  createPaymentSetup,
  getBillingStatus,
  runBillingReconciliation,
  setSubscription,
} from "../../src/server/services/billing.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("billing_wound_down");

const seed = async (id: string, status: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  await getDb()
    .insert(billingCustomers)
    .values({ userId: id, stripeCustomerId: `cus_${id}` });
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId: id,
      stripeSubscriptionId: `sub_${id}`,
      status,
      priceId: "price_yearly",
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      pastDueSince: status === "past_due" ? new Date() : null,
      syncedAt: new Date(),
    });
  return { userId: id, source: "web" };
};

let keyCounter = 0;
const request = () => ({ interval: "yearly", idempotencyKey: `wound-down-${(keyCounter += 1)}` });

beforeEach(() => {
  for (const double of Object.values(stripe)) double.mockReset();
  stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "test" });
  stripe.fetchPlanPrices.mockResolvedValue({ monthly: null, yearly: null });
  stripe.stripeCustomerStanding.mockResolvedValue("present");
  stripe.fetchSubscriptionClientSecret.mockResolvedValue("pi_owed_secret");
  stripe.createStripeSetupIntent.mockResolvedValue({
    id: "seti_wd",
    clientSecret: "seti_wd_secret",
  });
  stripe.keepCardThatPays.mockResolvedValue(false);
  stripe.fetchOwedPayment.mockResolvedValue(null);
});

/**
 * Winding down stops new money, and must not trap the money already owed. A
 * renewal Stripe is retrying, or has given up on, is paid by handing back an
 * invoice that already exists — nothing is sold — so the plan tab's pay button
 * works here exactly as it does on a deployment that is selling. Finishing a
 * first payment starts a subscription, and that is refused.
 */
integration("paying what is owed on a deployment that has stopped selling", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (originalSelling === undefined) delete process.env.SB_BILLING_ENABLED;
    else process.env.SB_BILLING_ENABLED = originalSelling;
  });

  it("takes payment of a renewal that is owed, and offers it", async () => {
    for (const status of ["past_due", "unpaid"]) {
      const actor = await seed(`wound-down-${status}`, status);
      // The plan tab re-reads a row that owes, so Stripe has to say it still does.
      stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => ({
        stripeSubscriptionId: id,
        status,
        priceId: "price_yearly",
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        scheduledPriceId: null,
        scheduledAt: null,
        syncedAt: new Date(),
        stripeCustomerId: null,
      }));

      await expect(setSubscription(actor, request())).resolves.toMatchObject({
        status,
        clientSecret: "pi_owed_secret",
      });
      // Paying what is owed keeps the card that pays it, selling or not.
      expect(stripe.keepCardThatPays).toHaveBeenLastCalledWith(
        `sub_${actor.userId}`,
        expect.any(String),
      );
      const shown = await getBillingStatus(actor);
      expect(shown.selling).toBe(false);
      expect(shown.subscription?.payable).toBe(true);
    }
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
  });

  it("refuses to finish a first payment, and does not offer it", async () => {
    const actor = await seed("wound-down-incomplete", "incomplete");
    stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => ({
      stripeSubscriptionId: id,
      status: "incomplete",
      priceId: "price_yearly",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      scheduledAt: null,
      syncedAt: new Date(),
      stripeCustomerId: null,
    }));

    await expect(setSubscription(actor, request())).rejects.toMatchObject({
      code: "CONFLICT",
      details: { selling: false },
    });
    expect(stripe.fetchSubscriptionClientSecret).not.toHaveBeenCalled();
    expect((await getBillingStatus(actor)).subscription?.payable).toBe(false);
  });

  it("refuses a first subscription before anything reaches Stripe", async () => {
    const actor: Actor = { userId: "wound-down-new", source: "web" };
    await getDb()
      .insert(user)
      .values({ id: actor.userId, name: "new", email: "new@example.com", emailVerified: true });

    await expect(setSubscription(actor, request())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(stripe.createStripeCustomer).not.toHaveBeenCalled();
    expect(stripe.createStripeSubscription).not.toHaveBeenCalled();
  });

  /**
   * The rest of what a wound-down deployment still owes the subscribers it has
   * not stopped charging. Both cases below gate on "Stripe is reachable"
   * rather than "this deployment sells", and the two spellings are one
   * identifier apart: `getConfig().billing` against `billingEnabled()`. Nothing
   * in the tree could tell them apart, so the edit that makes winding down mean
   * "stop everything Stripe" would have passed every suite.
   */
  describe("what a wound-down deployment still has to do", () => {
    const stored = async (userId: string) => {
      const [row] = await getDb()
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.userId, userId));
      return row;
    };

    /**
     * Replacing a card is how somebody whose card expired stays a customer
     * here, so it is the one purchase-shaped call that is not refused: no plan
     * is sold by it, and refusing it would turn a pause into a way of
     * canceling people by attrition. The secret is the whole answer — PlanPage
     * opens the card form only when it is there — so a null would show up as a
     * button that does nothing, on the deployment least able to get it fixed.
     */
    it("opens a card replacement, because a dead card is not a new sale", async () => {
      const actor = await seed("wound-down-card", "past_due");
      stripe.fetchSubscriptionSnapshot.mockImplementation(async (id: string) => ({
        stripeSubscriptionId: id,
        status: "past_due",
        priceId: "price_yearly",
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        scheduledPriceId: null,
        scheduledAt: null,
        syncedAt: new Date(),
        stripeCustomerId: null,
      }));

      await expect(
        createPaymentSetup(actor, { idempotencyKey: "wound-down-card-1" }),
      ).resolves.toEqual(expect.objectContaining({ clientSecret: "seti_wd_secret" }));
      expect(stripe.createStripeSetupIntent).toHaveBeenCalledWith(
        "cus_wound-down-card",
        expect.any(String),
      );
      // And nothing about that made this deployment a seller again.
      expect((await getBillingStatus(actor)).selling).toBe(false);
    });

    /**
     * The sweep is what catches a delivery that never arrived, and winding
     * down is when one is most likely to go missing: the operator has just
     * reconfigured, and the endpoint at Stripe may have moved or been turned
     * off while a subscription changed. Stripe goes on charging the
     * subscribers who remain, so this deployment goes on re-reading them.
     *
     * The assertion is the row, not `skipped: false`. A sweep that selected
     * the row, called Stripe and then wrote nothing reports `skipped: false`
     * just the same — which is the shape of unfalsifiable test this repository
     * has been bitten by before.
     */
    it("goes on re-reading stale subscriptions, because Stripe is still charging for them", async () => {
      const actor = await seed("wound-down-stale", "active");
      // `seed` stamps `syncedAt` now, and the sweep only reads rows older than
      // the twelve-hour window.
      await getDb()
        .update(billingSubscriptions)
        .set({ syncedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(billingSubscriptions.userId, actor.userId));
      // Stripe ended it while this deployment was being reconfigured, and the
      // delivery that said so is the one that went missing.
      stripe.fetchSubscriptionSnapshot.mockResolvedValue({
        stripeSubscriptionId: "sub_wound-down-stale",
        status: "canceled",
        priceId: "price_yearly",
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        scheduledPriceId: null,
        scheduledAt: null,
        syncedAt: new Date(),
        stripeCustomerId: null,
      });

      const summary = await runBillingReconciliation();

      expect((await stored(actor.userId))?.status).toBe("canceled");
      expect(stripe.fetchSubscriptionSnapshot).toHaveBeenCalledWith("sub_wound-down-stale");
      // One row examined, because every other row this file seeded was stamped
      // now: the sweep reads what is stale and nothing else.
      expect(summary).toMatchObject({ skipped: false, examined: 1, written: 1, failed: 0 });
    });
  });
});
