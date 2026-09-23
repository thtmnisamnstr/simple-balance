import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing on, for this file only, and restored afterward because
 * `vitest.config.ts` sets `fileParallelism: false` and every file shares one
 * process.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_signature",
  STRIPE_PUBLISHABLE_KEY: "pk_test_signature",
  STRIPE_WEBHOOK_SECRET: "whsec_a_secret_only_stripe_and_this_deployment_share",
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

beforeEach(() => {
  vi.resetModules();
});

const load = async () => import("../src/server/stripe.js");

/** A delivery Stripe would actually send, signed the way Stripe signs it. */
const delivery = (body: string, over: { secret?: string; timestamp?: number } = {}) =>
  Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: over.secret ?? billingEnvironment.STRIPE_WEBHOOK_SECRET,
    ...(over.timestamp === undefined ? {} : { timestamp: over.timestamp }),
  });

const body = JSON.stringify({
  id: "evt_signature_1",
  object: "event",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1" } },
});

/**
 * The signature is the only thing standing between this deployment and anybody
 * who can reach the webhook route, and every failure mode here is silent: a
 * forged delivery that verified would simply be believed.
 */
describe("verifying a Stripe delivery", () => {
  it("accepts a delivery Stripe signed", async () => {
    const { stripeEventFrom } = await load();

    expect(stripeEventFrom(body, delivery(body))).toMatchObject({
      id: "evt_signature_1",
      type: "customer.subscription.updated",
    });
  });

  it("refuses a body that changed after it was signed", async () => {
    const { stripeEventFrom } = await load();
    const signature = delivery(body);
    const tampered = body.replace("sub_1", "sub_2");

    expect(() => stripeEventFrom(tampered, signature)).toThrow();
  });

  it("refuses a delivery signed with the wrong secret", async () => {
    const { stripeEventFrom } = await load();

    expect(() =>
      stripeEventFrom(body, delivery(body, { secret: "whsec_somebody_elses" })),
    ).toThrow();
  });

  it("refuses a delivery captured and replayed later", async () => {
    // Stripe's verifier carries a timestamp tolerance, and it is the half a
    // hand-rolled HMAC check leaves out: without it a delivery captured off the
    // wire stays valid forever.
    const { stripeEventFrom } = await load();
    const longAgo = Math.floor(Date.now() / 1000) - 60 * 60 * 24;

    expect(() => stripeEventFrom(body, delivery(body, { timestamp: longAgo }))).toThrow(
      /timestamp/i,
    );
  });

  it("refuses a delivery carrying no signature at all", async () => {
    const { stripeEventFrom } = await load();

    expect(() => stripeEventFrom(body, undefined)).toThrow(/Stripe-Signature/);
  });

  it("refuses to verify anything on a deployment that sells nothing", async () => {
    // Without the webhook secret there is nothing to check a delivery against,
    // and answering one would mean believing whatever arrived.
    delete process.env.SB_BILLING_ENABLED;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PRICE_MONTHLY_ID;
    delete process.env.STRIPE_PRICE_YEARLY_ID;
    vi.resetModules();
    const { stripeEventFrom } = await load();

    try {
      expect(() => stripeEventFrom(body, delivery(body))).toThrow(/not configured/);
    } finally {
      Object.assign(process.env, billingEnvironment);
    }
  });
});

describe("the client this product gives Stripe", () => {
  it("makes no connection Stripe did not ask for, and gives up in seconds", async () => {
    // The SDK defaults are telemetry on and an eighty-second timeout. The first
    // is a connection nobody configured, which is the one thing
    // `docs/standards/operations.md` promises this server does not make; the
    // second is a person watching a spinner for over a minute.
    const { getStripe, resetStripeClient } = await load();
    resetStripeClient();
    const client = getStripe() as unknown as {
      _enableTelemetry: boolean;
      _api: { timeout: number; maxNetworkRetries: number };
    };

    expect(client._enableTelemetry).toBe(false);
    expect(client._api.timeout).toBeLessThanOrEqual(10_000);
    // Safe only because every mutating call carries an explicit idempotency key.
    expect(client._api.maxNetworkRetries).toBeGreaterThan(0);
  });
});
