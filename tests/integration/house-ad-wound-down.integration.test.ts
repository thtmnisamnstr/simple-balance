/**
 * Stripe configured, nothing for sale, and the house ad switched on.
 *
 * A file of its own for the reason `ad-placement-wound-down.integration.test.ts`
 * is: `getConfig` memoizes, so a deployment's billing posture is fixed for the
 * life of the process. AdSense is removed rather than left to chance, because
 * with it set the house ad could be false for the AdSense rule's reasons rather
 * than its own.
 */
const woundDownEnvironment = {
  SB_HOUSE_AD: "true",
  STRIPE_SECRET_KEY: "sk_test_house_ad_wound_down",
  STRIPE_PUBLISHABLE_KEY: "pk_test_house_ad_wound_down",
  STRIPE_WEBHOOK_SECRET: "whsec_house_ad_wound_down",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const absent = [
  "SB_BILLING_ENABLED",
  "ADSENSE_CLIENT_ID",
  "ADSENSE_BANNER_SLOT_ID",
  "ADSENSE_FOOTER_SLOT_ID",
] as const;
const originalEnvironment = Object.fromEntries(
  [...Object.keys(woundDownEnvironment), ...absent].map((key) => [key, process.env[key]]),
);
Object.assign(process.env, woundDownEnvironment);
// The whole point of the file: Stripe reachable, nothing for sale.
for (const key of absent) delete process.env[key];

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingSubscriptions, user } from "../../src/server/db/schema.js";
import { getAdvertising } from "../../src/server/services/billing.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("house_ad_wound_down");

const seed = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

integration("the house ad on a deployment that has stopped selling", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /**
   * The row this file exists for. `getEntitlement` answers `{ billing: false }`
   * here, so a still-paying subscriber and an account that never paid look the
   * same, and the rule has to read that as "nobody is on a limited plan" rather
   * than "nobody is on the paid one". Read the second way, everybody a paused
   * deployment is still charging would be shown an offer of what they pay for.
   */
  it("shows nothing to a subscriber who is still being charged", async () => {
    const actor = await seed("house-wound-down-subscriber");
    await getDb()
      .insert(billingSubscriptions)
      .values({
        userId: actor.userId,
        stripeSubscriptionId: "sub_house_wound_down",
        status: "active",
        priceId: "price_yearly",
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        scheduledPriceId: null,
        scheduledAt: null,
        pastDueSince: null,
        syncedAt: new Date(),
      });
    expect(await getAdvertising(actor)).toEqual({ ads: null, houseAd: false });
  });

  /**
   * And nobody else, which is the same rule twice over for the house ad: no
   * plan is limited, and the plan it would offer is not for sale.
   */
  it("shows nothing to an account that never paid", async () => {
    const actor = await seed("house-wound-down-free");
    expect(await getAdvertising(actor)).toEqual({ ads: null, houseAd: false });
  });
});
