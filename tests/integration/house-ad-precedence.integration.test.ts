/**
 * The house ad and AdSense both configured, on a deployment that sells a plan.
 *
 * A file of its own because `getConfig` memoizes, and this is the one posture
 * in which the two kinds of ad could meet on a page. The sign-in settings are
 * here because the last block asks the session route itself, which is where
 * the two fields are sent side by side.
 */
const BASE = "http://localhost:3000";
const precedenceEnvironment = {
  NODE_ENV: "development",
  AUTH_MODE: "local",
  APP_BASE_URL: BASE,
  AUTH_SECRET: "house-ad-precedence-secret-at-least-32-characters",
  ALLOWED_EMAILS: "*",
  SB_BILLING_ENABLED: "true",
  SB_HOUSE_AD: "true",
  STRIPE_SECRET_KEY: "sk_test_house_ad_precedence",
  STRIPE_PUBLISHABLE_KEY: "pk_test_house_ad_precedence",
  STRIPE_WEBHOOK_SECRET: "whsec_house_ad_precedence",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
  ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
  ADSENSE_BANNER_SLOT_ID: "9876543210",
  // Required once AdSense is configured: the server refuses to start without
  // it, because Google's terms require a policy on any site serving ads.
  PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(precedenceEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, precedenceEnvironment);

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingSubscriptions, user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

/**
 * The verdict on the prices, which is the one thing the house ad asks of
 * Stripe, and the price read the plan tab makes.
 */
const stripe = vi.hoisted(() => ({ lastPriceCheck: vi.fn(), fetchPlanPrices: vi.fn() }));
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
const database = scratchDatabase("house_ad_precedence");

const seed = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

const subscribe = async (userId: string) => {
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId,
      stripeSubscriptionId: `sub_${userId}`,
      status: "active",
      priceId: "price_yearly",
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      scheduledAt: null,
      pastDueSince: null,
      syncedAt: new Date(),
    });
};

const adsense = {
  clientId: "ca-pub-1234567890123456",
  bannerSlotId: "9876543210",
  consentManaged: false,
} as const;

integration("the house ad and AdSense on one deployment", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  beforeEach(() => {
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

  /**
   * The precedence. The house ad wins for whoever it is shown to, and their
   * AdSense placement is null, so the two can never stack on one page.
   */
  it("shows a free account the house ad and hands it no AdSense ids", async () => {
    const actor = await seed("precedence-free");
    expect(await getAdvertising(actor)).toEqual({ ads: null, houseAd: true });
    expect(await getAdPlacement(actor)).toBeNull();
  });

  it("shows a subscriber neither", async () => {
    const actor = await seed("precedence-subscriber");
    await subscribe(actor.userId);
    expect(await getAdvertising(actor)).toEqual({ ads: null, houseAd: false });
  });

  /**
   * Only for the person it is shown to. Where the house ad stands down because
   * the plan it offers is not for sale at a price that fits, a free account is
   * shown the AdSense unit its operator configured — which is all those
   * settings have ever meant on their own.
   */
  it("hands back the AdSense ids while the house ad stands down", async () => {
    const actor = await seed("precedence-unsellable");
    stripe.lastPriceCheck.mockReturnValue({
      problems: ["STRIPE_PRICE_MONTHLY_ID is not a recurring price."],
      confirmedMode: null,
    });
    expect(await getAdvertising(actor)).toEqual({ ads: adsense, houseAd: false });
    // So the plan tab still names the ads: they are AdSense's now, not none.
    expect((await getBillingStatus(actor)).advertises).toBe(true);
  });

  /**
   * The contract as the browser reads it: both fields on the session, the
   * house ad always sent — false included — and `ads` null beside a true one.
   */
  it("sends both fields on the session, never set together", async () => {
    const { default: app } = await import("../../src/server/api.js");
    const signUp = await app.request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Precedence",
        email: "precedence-session@example.test",
        password: "house-ad-precedence-password",
      }),
    });
    expect(signUp.status, await signUp.clone().text()).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const { user: created } = (await signUp.json()) as { user: { id: string } };
    const session = async () => {
      const response = await app.request(`${BASE}/api/v1/session`, {
        headers: { origin: BASE, cookie },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    };

    expect(await session()).toMatchObject({ ads: null, houseAd: true });

    await subscribe(created.id);
    const paying = await session();
    expect(paying).toMatchObject({ ads: null, houseAd: false });
    expect(paying).toHaveProperty("houseAd", false);
  });
});
