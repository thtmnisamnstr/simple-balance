/**
 * Stripe configured, nothing for sale — the state an operator winds down into.
 *
 * A file of its own, and that is forced rather than tidy: `getConfig` memoises
 * on first call, so a deployment's billing posture is fixed for the life of the
 * process and cannot be varied inside a describe block.
 *
 * It earns the file. This is the only state where the two plausible spellings
 * of the ad rule disagree, and the sibling suite — which runs with billing on —
 * cannot tell them apart. An inverted gate passes every test in this repository
 * except the ones below.
 */
const woundDownEnvironment = {
  STRIPE_SECRET_KEY: "sk_test_wound_down",
  STRIPE_PUBLISHABLE_KEY: "pk_test_wound_down",
  STRIPE_WEBHOOK_SECRET: "whsec_wound_down",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
  ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
  ADSENSE_BANNER_SLOT_ID: "9876543210",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(woundDownEnvironment).map((key) => [key, process.env[key]]),
);
const originalSelling = process.env.SB_BILLING_ENABLED;
Object.assign(process.env, woundDownEnvironment);
// The whole point of the file: Stripe reachable, nothing for sale.
delete process.env.SB_BILLING_ENABLED;

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingSubscriptions, user } from "../../src/server/db/schema.js";
import { getAdPlacement } from "../../src/server/services/billing.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("ad_placement_wound_down");

const seed = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

integration("advertising on a deployment that has stopped selling", () => {
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

  /**
   * The row this file exists for.
   *
   * An operator following the runbook sets `SB_BILLING_ENABLED=false` and keeps
   * the Stripe settings; their subscribers go on being charged. `getEntitlement`
   * short-circuits to `{ billing: false }` there, so a still-paying subscriber
   * and an account that never paid are indistinguishable — and the rule has to
   * read that as "nobody is on a limited plan" rather than "nobody is on Plus".
   *
   * Written the other way, every paying subscriber on a paused deployment is
   * shown advertising while still being billed for its removal.
   */
  it("shows nothing to a subscriber who is still being charged", async () => {
    const actor = await seed("wound-down-subscriber");
    await getDb()
      .insert(billingSubscriptions)
      .values({
        userId: actor.userId,
        stripeSubscriptionId: "sub_wound_down",
        status: "active",
        priceId: "price_yearly",
        currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
        cancelAtPeriodEnd: false,
        scheduledPriceId: null,
        scheduledAt: null,
        pastDueSince: null,
        syncedAt: new Date(),
      });
    expect(await getAdPlacement(actor)).toBeNull();
  });

  /**
   * And nobody else either, which is the same rule rather than a second one:
   * where nothing is for sale, no plan is limited, so there is no free tier to
   * advertise against. An operator who wants ads has to be selling something.
   */
  it("shows nothing to an account that never paid", async () => {
    const actor = await seed("wound-down-free");
    expect(await getAdPlacement(actor)).toBeNull();
  });
});
