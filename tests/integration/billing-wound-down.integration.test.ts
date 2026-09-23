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
}));
vi.mock("../../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/stripe.js")>()),
  ...stripe,
}));

import { getBillingStatus, setSubscription } from "../../src/server/services/billing.js";

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

      await expect(setSubscription(actor, request())).resolves.toMatchObject({
        status,
        clientSecret: "pi_owed_secret",
      });
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
});
