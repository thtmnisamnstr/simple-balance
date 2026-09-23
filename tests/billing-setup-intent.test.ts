import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Billing on, for this file only, and restored afterward because every file
 * shares one process. Only the reads below need it; the pure rule does not.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_setup_intent",
  STRIPE_PUBLISHABLE_KEY: "pk_test_setup_intent",
  STRIPE_WEBHOOK_SECRET: "whsec_setup_intent",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const original = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Stripe's SetupIntent read, and nothing else of the SDK. */
const retrieve = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    setupIntents = { retrieve };
  },
}));

const load = async () => {
  vi.resetModules();
  return {
    ...(await import("../src/server/stripe.js")),
    ...(await import("../src/server/services/billing.js")),
  };
};

const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/**
 * Whether a late `setup_intent.succeeded` may still pin its card.
 *
 * Stripe retries a delivery for up to 72 hours, so one can arrive after the
 * person has replaced that card with another. The three cases are the whole
 * rule, and the one that matters is the first: pinning there puts the card
 * somebody already replaced back in front of dunning.
 */
describe("a saved card's delivery arriving late", () => {
  const saved = { paymentMethodId: "pm_this", created: new Date("2026-09-10T00:00:00.000Z") };

  it("does not pin a card that a newer one has since replaced", async () => {
    const { isSupersededSetupIntent } = await load();
    expect(
      isSupersededSetupIntent(saved, {
        id: "pm_later",
        created: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("pins over the older card it was saved to replace", async () => {
    const { isSupersededSetupIntent } = await load();
    expect(
      isSupersededSetupIntent(saved, {
        id: "pm_before",
        created: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("pins again when it is already the card, and when there is none", async () => {
    const { isSupersededSetupIntent } = await load();
    expect(
      isSupersededSetupIntent(saved, {
        id: "pm_this",
        created: new Date("2026-09-10T00:01:00.000Z"),
      }),
    ).toBe(false);
    expect(isSupersededSetupIntent(saved, null)).toBe(false);
  });
});

/**
 * The date the rule compares is the intent's own card, not the intent. An
 * intent opened in one tab and confirmed after a second tab had already saved
 * and pinned a card holds the newer card of the two, and a 3-D Secure redirect
 * that never came back to the page leaves this delivery as the only way it is
 * ever pinned. Dated by the intent, it was judged the older and ignored.
 */
describe("dating a saved card", () => {
  const pinnedMeanwhile = { id: "pm_tab_b", created: new Date("2026-09-10T12:00:00.000Z") };

  it("dates the intent by its card, so a slow tab's newer card is still pinned", async () => {
    retrieve.mockResolvedValueOnce({
      id: "seti_tab_a",
      status: "succeeded",
      customer: "cus_1",
      created: seconds("2026-09-10T09:00:00.000Z"),
      payment_method: { id: "pm_tab_a", created: seconds("2026-09-10T15:00:00.000Z") },
    });
    const { fetchStripeSetupIntent, isSupersededSetupIntent } = await load();

    const intent = await fetchStripeSetupIntent("seti_tab_a");
    expect(retrieve).toHaveBeenCalledWith("seti_tab_a", { expand: ["payment_method"] });
    expect(intent.paymentMethodCreated).toEqual(new Date("2026-09-10T15:00:00.000Z"));
    expect(
      isSupersededSetupIntent(
        { paymentMethodId: "pm_tab_a", created: intent.paymentMethodCreated },
        pinnedMeanwhile,
      ),
    ).toBe(false);
  });

  it("falls back to the intent's own date only where the card came back as a bare id", async () => {
    retrieve.mockResolvedValueOnce({
      id: "seti_bare",
      status: "succeeded",
      customer: { id: "cus_1" },
      created: seconds("2026-09-10T09:00:00.000Z"),
      payment_method: "pm_bare",
    });
    const { fetchStripeSetupIntent } = await load();

    const intent = await fetchStripeSetupIntent("seti_bare");
    expect(intent).toMatchObject({ customerId: "cus_1", paymentMethodId: "pm_bare" });
    expect(intent.paymentMethodCreated).toEqual(new Date("2026-09-10T09:00:00.000Z"));
  });
});
