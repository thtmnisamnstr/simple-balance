import { describe, expect, it } from "vitest";
import {
  parseAdSettings,
  parseBillingSettings,
  parseLegalDocuments,
} from "../src/server/config.js";

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

  /**
   * Every one of the five slots, each holding a value that is a perfectly good
   * Stripe value belonging to a different slot.
   *
   * That is the mistake an operator actually makes: Stripe prints all of these
   * on adjacent dashboard pages, so a paste from the neighbour is far likelier
   * than a typo, and a same-mode paste is invisible to every other check in
   * this function. `stripeMode` reads a `sk_test_…` sitting in the publishable
   * slot as "test" beside a `sk_test_…` secret, so the mismatch refusal below
   * sees no mismatch at all; it reads `whsec_…` as nothing, which that refusal
   * is deliberately written to ignore. This loop is the only thing refusing
   * either, and the price rows are the only two with a second guard anywhere
   * (`planPriceProblems`, which asks Stripe whether the price exists).
   *
   * Matched from the start of the message rather than by the name alone: the
   * half-configured refusal above ends by listing all five names, so a bare
   * /NAME/ matches that message too and would pass while the wrong variable
   * was blamed. It is the trap the case above already works around.
   *
   * The loop runs before the live/test comparison, which is what lets a
   * same-mode substitute be refused here rather than for the wrong reason, and
   * the fixture is otherwise valid, so only the substituted slot can trip it.
   */
  it.each([
    // The publishable key pasted into the secret slot: nothing can charge.
    ["STRIPE_SECRET_KEY", "pk_test_example"],
    // The worst of the six, and the reason this row is not cosmetic. The
    // publishable key is copied into the /api/v1/billing response and handed
    // to loadStripe() by the plan tab, so a secret key here is a secret key
    // delivered to every browser that opens it.
    ["STRIPE_PUBLISHABLE_KEY", "sk_test_example"],
    ["STRIPE_PUBLISHABLE_KEY", "whsec_example"],
    ["STRIPE_WEBHOOK_SECRET", "sk_test_example"],
    // Stripe shows a product and its price on one page, differing by a prefix.
    // Left to fail at runtime it fails at somebody's first upgrade attempt.
    ["STRIPE_PRICE_MONTHLY_ID", "prod_notaprice"],
    ["STRIPE_PRICE_YEARLY_ID", "sk_test_example"],
  ] as const)("refuses %s holding %s, which belongs in another slot", (name, value) => {
    expect(() => parseBillingSettings({ ...stripe, [name]: value }, true)).toThrow(
      new RegExp(`^${name} does not look like a Stripe value`),
    );
  });

  it("refuses a live key beside a test one, in either direction", () => {
    expect(() =>
      parseBillingSettings({ ...stripe, STRIPE_SECRET_KEY: "sk_live_example" }, true),
    ).toThrow(/live key and STRIPE_PUBLISHABLE_KEY is a test key/);
    // The other direction, and the one the title has been claiming. A test
    // secret key beside a live publishable key lets the browser tokenize a
    // real card against a server that cannot charge it: the sale looks made
    // from every side except Stripe's. Asserted against the message's own
    // asymmetric half, so the sk_live + pk_test case above cannot satisfy it.
    expect(() =>
      parseBillingSettings({ ...stripe, STRIPE_PUBLISHABLE_KEY: "pk_live_example" }, true),
    ).toThrow(/test key and STRIPE_PUBLISHABLE_KEY is a live key/);
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
    // Asserted against the slot-id sentence rather than with a bare toThrow():
    // this one call site can raise three different refusals, and "something
    // threw" passes for whichever of them fires, including the one about a
    // setting being absent rather than malformed.
    //
    // "987654321a" and "9876 54321" are the cases a length check alone lets
    // through — ten characters, one of them not a digit — and they are the
    // mistake that starts cleanly and then earns nobody anything, which is
    // exactly what the comment above the regex says the check exists to stop.
    for (const bad of ["slot-1", "1a", "987654321a", "9876 54321"]) {
      expect(() => parseAdSettings({ ...ads, ADSENSE_BANNER_SLOT_ID: bad }), bad).toThrow(
        /ADSENSE_BANNER_SLOT_ID must be an ad unit's slot id, which is ten digits/,
      );
    }
    // The footer goes through the same loop and is the half nothing watched.
    // The message interpolates the name, so a check that only ever sees the
    // banner cannot tell whether the footer is checked at all: dropping the
    // footer from that loop left every assertion here passing.
    expect(() => parseAdSettings({ ...ads, ADSENSE_FOOTER_SLOT_ID: "987654321a" })).toThrow(
      /ADSENSE_FOOTER_SLOT_ID must be an ad unit's slot id, which is ten digits/,
    );
  });

  it("reads a blank slot id as one that was never filled in", () => {
    // `ADSENSE_BANNER_SLOT_ID=` in a .env file is an operator who has not
    // finished, not one who typed a bad slot, so it trims to absent and earns
    // the half-configured sentence. Asserted here rather than inside the
    // malformed-slot loop above, where it was passing for the other refusal's
    // reason and hiding that the loop had one fewer real case than it looked.
    for (const blank of ["", "   "]) {
      expect(
        () => parseAdSettings({ ...ads, ADSENSE_BANNER_SLOT_ID: blank }),
        JSON.stringify(blank),
      ).toThrow(/ADSENSE_CLIENT_ID and ADSENSE_BANNER_SLOT_ID must be set together/);
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
      expect(() => parseAdSettings({ ...ads, ADSENSE_BANNER_SLOT_ID: bad }), bad).toThrow(
        "ADSENSE_BANNER_SLOT_ID must be an ad unit's slot id, which is ten digits.",
      );
    }
    /*
     * The footer goes through the same loop, and reaching its entry needs a
     * valid banner beside it: a bad footer on its own exits at the "addition to
     * the banner" refusal above, which is why this cannot be folded into that
     * case and why the loop's second entry had nothing reaching it.
     *
     * Both halves match the message whole rather than /ten/, because the
     * interpolated name is the only thing telling an operator which of the two
     * ids to retype, and a check that accepted either name would pass a
     * refusal that sent them to the wrong variable.
     *
     * Only lengths here. A ten-character footer with a letter in it is a shape
     * failure and is asserted in the shape case above, so each of the two keeps
     * to the half it is named for.
     */
    for (const bad of ["1", "987654321", "98765432101"]) {
      expect(() => parseAdSettings({ ...ads, ADSENSE_FOOTER_SLOT_ID: bad }), bad).toThrow(
        "ADSENSE_FOOTER_SLOT_ID must be an ad unit's slot id, which is ten digits.",
      );
    }
  });

  /**
   * The consent flag, whose two directions fail differently.
   *
   * Off by mistake only costs money: every ad request then carries
   * `requestNonPersonalizedAds`, which earns less and has no symptom an
   * operator can see. On by mistake serves personalized ads to EEA, UK and
   * Swiss visitors from a deployment that collected no consent, which Google
   * suspends a publisher account for rather than simply not filling. Nothing in
   * this process can check that a consent platform exists, so the value is an
   * operator's assertion about the deployment and is read strictly: a typo
   * stops the process instead of quietly asserting a platform that is not
   * there.
   */
  it("refuses a consent flag that is not a boolean", () => {
    // The empty string is in the list because `??` catches only `undefined`, so
    // a compose file passing `${ADSENSE_CONSENT_MANAGED:-}` reaches the enum
    // with one. Keeping that spelling out of the recipes this repository ships
    // is `tests/env-example.test.ts`'s job, and this is the refusal it counts
    // on for every deployment written by hand.
    for (const bad of ["yes", "1", "on", ""])
      expect(() => parseAdSettings({ ...ads, ADSENSE_CONSENT_MANAGED: bad }), bad).toThrow(
        "ADSENSE_CONSENT_MANAGED must be true or false",
      );
  });

  it("leaves consent unmanaged unless it is asked for, and takes it however it is spelled", () => {
    // Unset is the safe answer rather than the profitable one: non-personalized
    // ads, which Google serves to a deployment that has no consent platform at
    // all.
    expect(parseAdSettings(ads)?.consentManaged).toBe(false);
    expect(parseAdSettings({ ...ads, ADSENSE_CONSENT_MANAGED: "false" })?.consentManaged).toBe(
      false,
    );
    expect(parseAdSettings({ ...ads, ADSENSE_CONSENT_MANAGED: "true" })?.consentManaged).toBe(true);
    // Case-folded, like the other booleans this file reads, so an operator who
    // wrote the word the way a person writes it is not turned away by it.
    expect(parseAdSettings({ ...ads, ADSENSE_CONSENT_MANAGED: "TRUE" })?.consentManaged).toBe(true);
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

  it("takes ads once the policy is there, and leaves publishing it to the legal documents", () => {
    // The address used to ride on the ad settings, which made it exist only
    // while ads did. It is read in one place now, so the two cannot disagree
    // by being read twice.
    const settings = parseAdSettings({ ...ads, PRIVACY_POLICY_URL: "https://smpl.money/privacy/" });
    expect(settings).toBeDefined();
    expect(settings).not.toHaveProperty("privacyPolicyUrl");
  });

  it("asks for nothing when ads are off", () => {
    // A deployment with no ads owes Google nothing, and demanding a URL from
    // it would be this product inventing a requirement.
    expect(parseAdSettings({})).toBeUndefined();
  });
});

/**
 * The privacy policy and the terms of use, which a deployment publishes
 * whether or not it serves an ad.
 *
 * The policy was read only inside the ad settings, so a deployment that sold a
 * plan and showed no advertising linked no policy anywhere, on the screens that
 * collect an address and a payment. Both are optional here; what can make the
 * policy required is ads, and that is the block above.
 */
describe("the documents a deployment links to", () => {
  it("publishes a privacy policy with no ads configured at all", () => {
    expect(
      parseLegalDocuments({
        PRIVACY_POLICY_URL: " https://smpl.money/privacy/ ",
      }),
    ).toEqual({
      privacyPolicyUrl: "https://smpl.money/privacy/",
    });
  });

  it("publishes the terms of use beside it, and either without the other", () => {
    expect(
      parseLegalDocuments({
        PRIVACY_POLICY_URL: "https://smpl.money/privacy/",
        TERMS_OF_USE_URL: "https://smpl.money/terms/",
      }),
    ).toEqual({
      privacyPolicyUrl: "https://smpl.money/privacy/",
      termsOfUseUrl: "https://smpl.money/terms/",
    });
    expect(parseLegalDocuments({ TERMS_OF_USE_URL: "https://smpl.money/terms/" })).toEqual({
      termsOfUseUrl: "https://smpl.money/terms/",
    });
  });

  it("reads a blank value as unset, the way every compose recipe passes one", () => {
    expect(parseLegalDocuments({})).toEqual({});
    expect(parseLegalDocuments({ PRIVACY_POLICY_URL: "", TERMS_OF_USE_URL: "  " })).toEqual({});
  });

  it.each(["PRIVACY_POLICY_URL", "TERMS_OF_USE_URL"] as const)(
    "holds %s to an absolute https address, and names it when it is not",
    (name) => {
      expect(() => parseLegalDocuments({ [name]: "/terms" })).toThrow(
        new RegExp(`^${name} must be an absolute URL`),
      );
      expect(() => parseLegalDocuments({ [name]: "http://smpl.money/terms/" })).toThrow(
        new RegExp(`^${name} must be https`),
      );
    },
  );
});
