import { describe, expect, it } from "vitest";
import { parseAdSettings, parseBillingSettings } from "../src/server/config.js";

/** All five Stripe names, so a case can leave exactly one of them out. */
const stripe = {
  STRIPE_SECRET_KEY: "sk_test_example",
  STRIPE_PUBLISHABLE_KEY: "pk_test_example",
  STRIPE_WEBHOOK_SECRET: "whsec_example",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
};

/**
 * Billing is the first setting here that can move somebody's money, so the
 * cases worth writing are the ones where a mistake is invisible until it has
 * already charged a card or failed to notice that one was charged.
 */
describe("reading the billing settings", () => {
  it("is off when nothing is set", () => {
    expect(parseBillingSettings({}, true)).toBeUndefined();
  });

  it("refuses to sell a plan it has no way to charge for", () => {
    expect(() => parseBillingSettings({ SB_BILLING_ENABLED: "true" }, true)).toThrow(
      /no Stripe settings are set/,
    );
  });

  it("refuses half a configuration, and blames the half that is actually missing", () => {
    // Asserted against the clause before "Set all five", because the sentence
    // ends by listing every name: a regex over the whole message matches any
    // of them and would pass while the message blamed the wrong variable.
    for (const absent of Object.keys(stripe)) {
      const partial = { ...stripe, [absent]: undefined };
      let blamed: string | undefined;
      try {
        parseBillingSettings(partial, true);
      } catch (error) {
        blamed = /half configured: (.+?) is missing/.exec((error as Error).message)?.[1];
      }

      expect(blamed, `removing ${absent}`).toBe(absent);
    }
  });

  it("names every missing variable when more than one is absent", () => {
    let blamed: string | undefined;
    try {
      parseBillingSettings({ STRIPE_SECRET_KEY: stripe.STRIPE_SECRET_KEY }, true);
    } catch (error) {
      blamed = /half configured: (.+?) are missing/.exec((error as Error).message)?.[1];
    }

    expect(blamed).toBe(
      "STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY_ID, STRIPE_PRICE_YEARLY_ID",
    );
  });

  it("reaches Stripe without selling anything, which is how a wind-down works", () => {
    // The whole point of two settings rather than one: a deployment that has
    // stopped taking new subscriptions still has to hear about the ones people
    // are paying for, or its idea of who has paid drifts away from Stripe's.
    expect(parseBillingSettings(stripe, true)).toMatchObject({ enforcing: false });
    expect(parseBillingSettings({ ...stripe, SB_BILLING_ENABLED: "true" }, true)).toMatchObject({
      enforcing: true,
    });
  });

  it("refuses an SB_BILLING_ENABLED that is not true or false", () => {
    expect(() => parseBillingSettings({ ...stripe, SB_BILLING_ENABLED: "yes" }, true)).toThrow(
      /SB_BILLING_ENABLED must be true or false/,
    );
  });

  it("refuses a product id where a price id belongs", () => {
    // Stripe shows both on the same dashboard page and they differ by a prefix.
    // Left to fail at runtime it fails at somebody's first upgrade attempt.
    expect(() =>
      parseBillingSettings({ ...stripe, STRIPE_PRICE_MONTHLY_ID: "prod_notaprice" }, true),
    ).toThrow(/STRIPE_PRICE_MONTHLY_ID/);
  });

  it("refuses a live key beside a test one, in either direction", () => {
    expect(() =>
      parseBillingSettings({ ...stripe, STRIPE_SECRET_KEY: "sk_live_example" }, true),
    ).toThrow(/live key and STRIPE_PUBLISHABLE_KEY is a test key/);
    expect(() =>
      parseBillingSettings(
        { ...stripe, STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x" },
        true,
      ),
    ).not.toThrow();
  });

  it("refuses a live key outside production, because a test run cannot un-charge a card", () => {
    const live = { ...stripe, STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x" };

    expect(() => parseBillingSettings(live, false)).toThrow(/live key and NODE_ENV/);
    expect(() => parseBillingSettings(live, true)).not.toThrow();
  });

  it("takes a restricted key, which is the smaller grant of the two forms", () => {
    expect(
      parseBillingSettings({ ...stripe, STRIPE_SECRET_KEY: "rk_test_example" }, true),
    ).toMatchObject({ secretKey: "rk_test_example" });
  });

  it("says nothing about a key shape it has not heard of", () => {
    // Stripe has added key forms before. A deployment holding one this file
    // cannot classify should start rather than stop, so the live/test check
    // only fires when both keys say which half they belong to.
    expect(() =>
      parseBillingSettings(
        { ...stripe, STRIPE_SECRET_KEY: "sk_future_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x" },
        true,
      ),
    ).not.toThrow();
  });
});

/**
 * Ads follow mail: presence is the switch. The cases that matter are the ones
 * that would leave an operator believing ads are configured when the page will
 * render nothing at all.
 */
describe("reading the ad settings", () => {
  const ads = {
    ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
    ADSENSE_BANNER_SLOT_ID: "9876543210",
    // Required once ads are configured: Google's program policies demand a
    // privacy policy on any site serving their ads.
    PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
  };

  it("is off when nothing is set", () => {
    expect(parseAdSettings({})).toBeUndefined();
  });

  it("refuses half a configuration, in either direction", () => {
    expect(() =>
      parseAdSettings({
        ADSENSE_CLIENT_ID: ads.ADSENSE_CLIENT_ID,
        PRIVACY_POLICY_URL: ads.PRIVACY_POLICY_URL,
      }),
    ).toThrow(/must be set together/);
    expect(() => parseAdSettings({ ADSENSE_BANNER_SLOT_ID: "1" })).toThrow(/must be set together/);
  });

  it("refuses a footer unit with no banner to sit under", () => {
    expect(() => parseAdSettings({ ADSENSE_FOOTER_SLOT_ID: "1" })).toThrow(
      /addition to the banner/,
    );
  });

  it("leaves the footer off unless it is asked for", () => {
    expect(parseAdSettings(ads)?.footerSlotId).toBeUndefined();
    expect(parseAdSettings({ ...ads, ADSENSE_FOOTER_SLOT_ID: " 5550000000 " })?.footerSlotId).toBe(
      "5550000000",
    );
  });

  it("refuses the publisher id as the dashboard prints it", () => {
    // The dashboard shows `pub-…`; the ad code wants `ca-pub-…`. Pasting the
    // first renders nothing, which looks exactly like having no inventory.
    expect(() => parseAdSettings({ ...ads, ADSENSE_CLIENT_ID: "pub-1234567890123456" })).toThrow(
      /ca-pub-/,
    );
  });

  it("refuses a slot id that is not a slot id", () => {
    for (const bad of ["slot-1", "1a", ""]) {
      expect(() => parseAdSettings({ ...ads, ADSENSE_BANNER_SLOT_ID: bad })).toThrow();
    }
  });

  /**
   * The length, not only the shape.
   *
   * A prefix check passes `ca-pub-1`, and every truncated, doubled or
   * short-by-one publisher id starts the process cleanly and then credits
   * nobody — which is indistinguishable from having no inventory, and is the
   * failure an operator is least able to diagnose. The same goes for a slot.
   */
  it("refuses an id of the wrong length, which is the mistake that earns nothing", () => {
    for (const bad of ["ca-pub-1", "ca-pub-123456789012345", "ca-pub-12345678901234567"]) {
      expect(() => parseAdSettings({ ...ads, ADSENSE_CLIENT_ID: bad }), bad).toThrow(/sixteen/);
    }
    for (const bad of ["1", "987654321", "98765432101"]) {
      expect(() => parseAdSettings({ ...ads, ADSENSE_BANNER_SLOT_ID: bad }), bad).toThrow(/ten/);
    }
  });
});

describe("the privacy policy an ad deployment owes", () => {
  const ads = {
    ADSENSE_CLIENT_ID: "ca-pub-1234567890123456",
    ADSENSE_BANNER_SLOT_ID: "9876543210",
  } as const;

  it("refuses ads with no privacy policy", () => {
    // Not a nicety: an operator who turns ads on without one is in breach
    // from the first impression, and the penalty is account suspension rather
    // than the ads simply not rendering.
    expect(() => parseAdSettings(ads)).toThrow(/PRIVACY_POLICY_URL must be set/);
  });

  it("refuses a policy that is not a URL", () => {
    expect(() => parseAdSettings({ ...ads, PRIVACY_POLICY_URL: "/privacy" })).toThrow(
      /absolute URL/,
    );
  });

  it("refuses a policy served over plain http", () => {
    // A document about what happens to somebody's data, delivered over a
    // channel that cannot prove it arrived unmodified.
    expect(() =>
      parseAdSettings({ ...ads, PRIVACY_POLICY_URL: "http://smpl.money/privacy/" }),
    ).toThrow(/must be https/);
  });

  it("keeps the policy on the ad settings, so the two cannot disagree", () => {
    const settings = parseAdSettings({ ...ads, PRIVACY_POLICY_URL: "https://smpl.money/privacy/" });
    expect(settings?.privacyPolicyUrl).toBe("https://smpl.money/privacy/");
  });

  it("asks for nothing when ads are off", () => {
    // A deployment with no ads owes Google nothing, and demanding a URL from
    // it would be this product inventing a requirement.
    expect(parseAdSettings({})).toBeUndefined();
  });
});
