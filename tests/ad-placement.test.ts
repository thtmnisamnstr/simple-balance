import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveEntitlement } from "../src/shared/domain.js";

/**
 * Who is shown an ad, decided as the server decides it.
 *
 * The rule is exercised here against `resolveEntitlement` directly rather than
 * through `getAdPlacement`, which needs a database: what is worth pinning is the
 * *shape* of the condition, because the two ways of writing it differ only on
 * the states that matter and agree everywhere else.
 *
 * Show an ad where a limited plan is in force:
 *     entitlement.billing && entitlement.plan === "free"
 * and NOT as the inverse of being on Plus:
 *     !(entitlement.billing && entitlement.plan === "plus")
 *
 * The two disagree exactly where `billing` is false, which is a deployment that
 * sells nothing — and, the case that matters, a deployment that has *stopped*
 * selling while its subscribers go on being charged at Stripe.
 */
const shown = (entitlement: ReturnType<typeof resolveEntitlement>) =>
  entitlement.billing && entitlement.plan === "free";

const inverted = (entitlement: ReturnType<typeof resolveEntitlement>) =>
  !(entitlement.billing && entitlement.plan === "plus");

const now = new Date("2026-09-14T12:00:00.000Z");
const active = [{ status: "active", pastDueSince: null }];

describe("who is shown an ad", () => {
  it("shows one to somebody on the free plan", () => {
    expect(shown(resolveEntitlement({ billingEnabled: true, subscriptions: [], now }))).toBe(true);
  });

  it("shows none to a subscriber", () => {
    expect(shown(resolveEntitlement({ billingEnabled: true, subscriptions: active, now }))).toBe(
      false,
    );
  });

  it("shows none to somebody an operator granted Plus by hand", () => {
    const entitlement = resolveEntitlement({
      billingEnabled: true,
      override: { plan: "plus", expiresAt: null },
      subscriptions: [],
      now,
    });
    expect(shown(entitlement)).toBe(false);
  });

  it("shows none on a deployment that sells nothing", () => {
    // `{ billing: false }` means unrestricted, not "not paying". Nobody there
    // is on a limited plan, so nobody there is shown an ad — which is also what
    // makes ads-without-billing a coherent configuration rather than a trap.
    expect(shown(resolveEntitlement({ billingEnabled: false, subscriptions: [], now }))).toBe(
      false,
    );
  });

  /**
   * The state the two spellings disagree on, and the reason the rule is written
   * the way it is.
   *
   * An operator winding down sets `SB_BILLING_ENABLED=false` and keeps the
   * Stripe settings, exactly as the runbook says. Their subscribers are still
   * being charged. `getEntitlement` short-circuits to `{ billing: false }`
   * there, so a still-paying subscriber and an account that never paid are
   * indistinguishable — and the inverted spelling shows an ad to both.
   */
  it("shows none to a paying subscriber on a deployment that stopped selling", () => {
    const winding = resolveEntitlement({ billingEnabled: false, subscriptions: active, now });
    expect(shown(winding), "the rule as written").toBe(false);
    expect(inverted(winding), "the inverted spelling, which is why it is not used").toBe(true);
  });

  it("is the only state the two spellings disagree on, among the ones that occur", () => {
    const states = [
      resolveEntitlement({ billingEnabled: true, subscriptions: [], now }),
      resolveEntitlement({ billingEnabled: true, subscriptions: active, now }),
      resolveEntitlement({ billingEnabled: false, subscriptions: [], now }),
      resolveEntitlement({ billingEnabled: false, subscriptions: active, now }),
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "past_due", pastDueSince: now }],
        now,
      }),
    ];
    const disagreements = states.filter((s) => shown(s) !== inverted(s));
    // Both of the `billing: false` rows. Stated as a count so a third state
    // appearing here fails rather than passing quietly.
    expect(disagreements).toHaveLength(2);
    expect(disagreements.every((s) => !s.billing)).toBe(true);
  });
});

/**
 * And the same rule through the function that actually decides it.
 *
 * Everything above argues about two spellings of the condition without ever
 * calling `getAdPlacement`, and the file's own header says so. The cost is that
 * `src/server/services/billing.ts` could be rewritten to the inverted spelling
 * and this file would stay green — as would `npm run verify`, which runs the
 * integration tier with `TEST_DATABASE_URL` blank and therefore skips the two
 * files that do call it. So the default gate was blind to a change that shows
 * an ad to every paying subscriber on a deployment that stopped selling.
 *
 * The wound-down arm is the one the fast tier can reach without a database:
 * `getEntitlement` short-circuits on `billingEnabled()` and returns
 * `{ billing: false }` before it asks for a row. It is also the only arm the
 * two spellings disagree on, which is what makes it the one worth having here
 * rather than a convenient one.
 *
 * The positive arm — a free-plan account really being handed slot ids — stays
 * in `tests/integration/ad-placement.integration.test.ts`, because it needs
 * rows. This block on its own would not notice a `getAdPlacement` that answered
 * null to everybody, and saying that plainly is better than standing a fake
 * database up in the fast tier to pretend otherwise.
 */
describe("the ad rule as the server runs it", () => {
  /**
   * The wind-down shape: the five Stripe names kept, so the people already
   * paying go on being charged, and the switch that sells a plan gone. Ads stay
   * configured, which is the state an operator lands in by turning ads on
   * before they start selling or leaving them on after they stop.
   */
  const environment: Record<string, string> = {
    NODE_ENV: "test",
    ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
    ADSENSE_BANNER_SLOT_ID: "9876543210",
    // Refused without it: Google requires a privacy policy on any site serving
    // their ads, so ad settings without one do not parse at all.
    PRIVACY_POLICY_URL: "https://example.test/privacy",
    STRIPE_SECRET_KEY: "sk_test_ads",
    STRIPE_PUBLISHABLE_KEY: "pk_test_ads",
    STRIPE_WEBHOOK_SECRET: "whsec_a_secret_only_stripe_and_this_deployment_share",
    STRIPE_PRICE_MONTHLY_ID: "price_monthly",
    STRIPE_PRICE_YEARLY_ID: "price_yearly",
  };
  const original: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(environment)) {
      original[key] = process.env[key];
      process.env[key] = value;
    }
    // Deleted rather than set to "false". Unset is what a wound-down deployment
    // really has, and `parseBillingSettings` is entitled to read the two
    // differently, so the fixture must not quietly pick the easier one.
    original.SB_BILLING_ENABLED = process.env.SB_BILLING_ENABLED;
    delete process.env.SB_BILLING_ENABLED;
    // `getConfig` memoizes, so the environment above only reaches a module
    // graph that has not read it yet.
    vi.resetModules();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  });

  it("shows nothing to a subscriber a wound-down deployment is still charging", async () => {
    const { adsEnabled, billingEnabled } = await import("../src/server/config.js");
    const { getAdPlacement } = await import("../src/server/services/billing.js");

    // Both halves of the fixture asserted before the answer is read. Without
    // them a null below is indistinguishable from ads never having been
    // configured at all, which is the first arm of the same function and would
    // make this test pass for a reason that has nothing to do with the rule.
    expect(adsEnabled(), "ads are configured, so a refusal is not the first arm").toBe(true);
    expect(billingEnabled(), "and this deployment has stopped selling").toBe(false);

    // No database is reached: `billingEnabled()` is false, so `getEntitlement`
    // answers `{ billing: false }` without a query. A regression that started
    // querying here would fail this test by throwing rather than by returning
    // the wrong thing, which is the right way round.
    expect(await getAdPlacement({ userId: "wound-down-subscriber", source: "web" })).toBeNull();
  });
});
