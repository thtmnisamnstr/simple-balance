/**
 * Billing on and the house ad on, with no AdSense, for this file only.
 *
 * Set at module scope because `getConfig` memoizes on first call, and restored
 * in `afterAll` because `vitest.config.ts` sets `fileParallelism: false` — every
 * integration file shares one process, so a variable left behind here follows
 * every file that runs after it. The AdSense ids are removed rather than merely
 * not set: with them present a house ad of `false` could be AdSense winning,
 * which is a different rule from the one each row below is about.
 */
const houseAdEnvironment = {
  SB_BILLING_ENABLED: "true",
  SB_HOUSE_AD: "true",
  STRIPE_SECRET_KEY: "sk_test_house_ad",
  STRIPE_PUBLISHABLE_KEY: "pk_test_house_ad",
  STRIPE_WEBHOOK_SECRET: "whsec_house_ad",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const absent = ["ADSENSE_CLIENT_ID", "ADSENSE_BANNER_SLOT_ID", "ADSENSE_FOOTER_SLOT_ID"] as const;
const originalEnvironment = Object.fromEntries(
  [...Object.keys(houseAdEnvironment), ...absent].map((key) => [key, process.env[key]]),
);
Object.assign(process.env, houseAdEnvironment);
for (const key of absent) delete process.env[key];

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingOverrides, billingSubscriptions, user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * Stripe, as far as this file needs it: the verdict on the prices, which is
 * what decides whether the plan the house ad offers is for sale, and the price
 * read the plan tab makes. Everything else is the real module.
 */
const stripe = vi.hoisted(() => ({
  lastPriceCheck: vi.fn(),
  fetchPlanPrices: vi.fn(),
}));
vi.mock("../../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/stripe.js")>()),
  ...stripe,
}));

import {
  getAdPlacement,
  getAdvertising,
  getBillingStatus,
} from "../../src/server/services/billing.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("house_ad");

const seed = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

const subscribe = async (userId: string, status: string) => {
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId,
      stripeSubscriptionId: `sub_${userId}`,
      status,
      priceId: "price_yearly",
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      scheduledAt: null,
      pastDueSince: status === "past_due" ? new Date() : null,
      syncedAt: new Date(),
    });
};

const shown = { ads: null, houseAd: true } as const;
const hidden = { ads: null, houseAd: false } as const;

/**
 * Who the server tells to show the house ad, asked of the real function.
 *
 * The same matrix `ad-placement.integration.test.ts` runs for AdSense, because
 * it is the same predicate — a limited plan is in force — and a house ad that
 * reached a paying subscriber would be an advertisement for the plan they are
 * already paying for. The browser cannot correct this: it is told or it is not.
 */
integration("which sessions are told to show the house ad", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  beforeEach(() => {
    // Stripe never answered, which is what a process that has not opened the
    // plan tab since it started holds: no verdict, so nothing known to be wrong.
    stripe.lastPriceCheck.mockReturnValue(undefined);
    stripe.fetchPlanPrices.mockResolvedValue({ monthly: null, yearly: null });
  });
  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("shows it to somebody on the free plan, and hands no AdSense ids with it", async () => {
    const actor = await seed("house-free");
    expect(await getAdvertising(actor)).toEqual(shown);
    expect(await getAdPlacement(actor)).toBeNull();
  });

  it("shows a subscriber nothing", async () => {
    const actor = await seed("house-subscriber");
    await subscribe(actor.userId, "active");
    expect(await getAdvertising(actor)).toEqual(hidden);
  });

  it("shows a trialing subscriber nothing", async () => {
    const actor = await seed("house-trialing");
    await subscribe(actor.userId, "trialing");
    expect(await getAdvertising(actor)).toEqual(hidden);
  });

  /**
   * Inside the fifteen-day grace a failed renewal still entitles. They are a
   * paying customer whose card bounced, and offering them the plan they are on
   * would be the wrong message at the worst moment.
   */
  it("shows nothing to a subscriber inside the failed-payment grace", async () => {
    const actor = await seed("house-past-due");
    await subscribe(actor.userId, "past_due");
    expect(await getAdvertising(actor)).toEqual(hidden);
  });

  it("shows nothing to somebody an operator granted the paid plan by hand", async () => {
    const actor = await seed("house-override");
    await getDb().insert(billingOverrides).values({
      userId: actor.userId,
      plan: "plus",
      expiresAt: null,
      reason: "a friend of the project",
      operator: "gavin",
    });
    expect(await getAdvertising(actor)).toEqual(hidden);
  });

  it("shows it again once an override has expired", async () => {
    const actor = await seed("house-expired-override");
    await getDb()
      .insert(billingOverrides)
      .values({
        userId: actor.userId,
        plan: "plus",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        reason: "lapsed",
        operator: "gavin",
      });
    expect(await getAdvertising(actor)).toEqual(shown);
  });

  it("shows it to a canceled subscriber, who is back on the free plan", async () => {
    const actor = await seed("house-canceled");
    await subscribe(actor.userId, "canceled");
    expect(await getAdvertising(actor)).toEqual(shown);
  });

  /**
   * The one condition the house ad has that AdSense does not. Its button opens
   * the plan tab, and where the configured prices do not fit the plans that tab
   * says this deployment is not selling — so the ad stands down until the
   * prices are fixed, and comes back on its own when they are.
   */
  it("stands down while the prices do not fit the plans, and returns when they do", async () => {
    const actor = await seed("house-unsellable");
    stripe.lastPriceCheck.mockReturnValue({
      problems: ["STRIPE_PRICE_YEARLY_ID bills monthly, so it cannot be sold as a year."],
      confirmedMode: null,
    });
    expect(await getAdvertising(actor)).toEqual(hidden);

    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "test" });
    expect(await getAdvertising(actor)).toEqual(shown);
  });

  /**
   * The plan tab has to agree with the ad about what upgrading buys, and the
   * ad says it takes the ad away. `advertises` is the deployment's answer, so
   * it is the same on both sides of the upgrade.
   */
  it("tells the plan tab that this deployment advertises, before and after upgrading", async () => {
    const free = await seed("house-plan-tab-free");
    const paying = await seed("house-plan-tab-paying");
    await subscribe(paying.userId, "active");

    expect((await getBillingStatus(free)).advertises).toBe(true);
    expect((await getBillingStatus(paying)).advertises).toBe(true);
  });

  /**
   * And not while the ad stands down. With no AdSense here, a free account is
   * shown no ad at all while the prices do not fit, so a tab that still said
   * "ads on the page" would be describing a page that has none. Still the
   * deployment's answer: both sides of the upgrade read the same.
   */
  it("tells the plan tab nothing is advertised while the plan is not for sale", async () => {
    const free = await seed("house-plan-tab-unsellable-free");
    const paying = await seed("house-plan-tab-unsellable-paying");
    await subscribe(paying.userId, "active");
    stripe.lastPriceCheck.mockReturnValue({
      problems: ["STRIPE_PRICE_YEARLY_ID bills monthly, so it cannot be sold as a year."],
      confirmedMode: null,
    });
    for (const actor of [free, paying]) {
      const status = await getBillingStatus(actor);
      expect(status.selling, actor.userId).toBe(false);
      expect(status.advertises, actor.userId).toBe(false);
    }
    expect(await getAdvertising(free), "and the ad agrees").toEqual(hidden);

    stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "test" });
    for (const actor of [free, paying]) {
      expect((await getBillingStatus(actor)).advertises, actor.userId).toBe(true);
    }
    expect(await getAdvertising(free)).toEqual(shown);
  });
});
