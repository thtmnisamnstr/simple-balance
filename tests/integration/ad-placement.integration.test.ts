/**
 * Billing and advertising both on, for this file only.
 *
 * Set at module scope because `getConfig` memoizes on first call and every
 * predicate below is derived from it, and restored in `afterAll` because
 * `vitest.config.ts` sets `fileParallelism: false` — every integration file
 * shares one process, so a variable left behind here follows every file that
 * runs after it.
 */
const adEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_ad_placement",
  STRIPE_PUBLISHABLE_KEY: "pk_test_ad_placement",
  STRIPE_WEBHOOK_SECRET: "whsec_ad_placement",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
  ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
  ADSENSE_BANNER_SLOT_ID: "9876543210",
  // Required once AdSense is configured: the server refuses to start without
  // it, because Google's terms require a policy on any site serving ads.
  PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(adEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, adEnvironment);

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingOverrides, billingSubscriptions, user } from "../../src/server/db/schema.js";
import { getAdPlacement } from "../../src/server/services/billing.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ad_placement");

const actorFor = (id: string): Actor => ({ userId: id, source: "web" });

const seed = async (id: string) => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return actorFor(id);
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

/**
 * Who the server hands ad ids to, asked of the real function.
 *
 * `tests/ad-placement.test.ts` pins the *shape* of the rule against
 * `resolveEntitlement`, which is where the two plausible spellings differ. It
 * does not call this function, and that gap was worth closing on its own: a gate
 * inverted here — `entitlement.billing && plan === "plus"`, which reads just as
 * naturally — passed that test and every other one in the suite while handing a
 * paying subscriber the ids to render an ad with.
 *
 * The browser cannot correct this. It is given the ids or it is not.
 */
integration("which sessions carry ad configuration", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
    Object.assign(process.env, originalEnvironment);
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
    }
  });

  it("hands the ids to somebody on the free plan", async () => {
    const actor = await seed("ads-free");
    const placement = await getAdPlacement(actor);
    expect(placement).toEqual({
      clientId: "ca-pub-1234567890123456",
      bannerSlotId: "9876543210",
      consentManaged: false,
    });
  });

  it("hands a subscriber nothing at all", async () => {
    const actor = await seed("ads-subscriber");
    await subscribe(actor.userId, "active");
    expect(await getAdPlacement(actor)).toBeNull();
  });

  it("hands a trialing subscriber nothing", async () => {
    const actor = await seed("ads-trialing");
    await subscribe(actor.userId, "trialing");
    expect(await getAdPlacement(actor)).toBeNull();
  });

  /**
   * Inside the fifteen-day grace a failed renewal still entitles, so there is
   * still nothing to show them. They are a paying customer whose card bounced,
   * not a free account.
   */
  it("hands nothing to a subscriber inside the failed-payment grace", async () => {
    const actor = await seed("ads-past-due");
    await subscribe(actor.userId, "past_due");
    expect(await getAdPlacement(actor)).toBeNull();
  });

  it("hands nothing to somebody an operator granted Plus by hand", async () => {
    const actor = await seed("ads-override");
    await getDb().insert(billingOverrides).values({
      userId: actor.userId,
      plan: "plus",
      expiresAt: null,
      reason: "a friend of the project",
      operator: "gavin",
    });
    expect(await getAdPlacement(actor)).toBeNull();
  });

  it("hands the ids back once an override has expired", async () => {
    const actor = await seed("ads-expired-override");
    await getDb()
      .insert(billingOverrides)
      .values({
        userId: actor.userId,
        plan: "plus",
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        reason: "lapsed",
        operator: "gavin",
      });
    expect(await getAdPlacement(actor)).not.toBeNull();
  });

  it("hands nothing to a canceled subscriber, who is back on the free plan", async () => {
    // Canceled is history: they are entitled to nothing, so they are shown an
    // ad like any other free account. The assertion is that they get one — the
    // opposite of the rows above, and the reason this rule cannot simply be
    // "anybody who has ever had a subscription".
    const actor = await seed("ads-canceled");
    await subscribe(actor.userId, "canceled");
    expect(await getAdPlacement(actor)).not.toBeNull();
  });
});
