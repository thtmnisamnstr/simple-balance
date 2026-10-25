import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRIPE_FAILURE_REASONS, type StripeFailureReason } from "../src/server/metrics.js";

/**
 * Why a Stripe call failed, beside the count that it did.
 *
 * `stripe_requests_total{outcome="failed"}` is one rising line for two
 * different mornings: Stripe being down, which is a status page and a wait,
 * and this deployment's key being wrong, which is an operator with a fix to
 * make. The reason is read off the class the SDK built the error as, so the
 * errors here are built by the SDK itself — `generateV1Error` is the function
 * it maps an HTTP answer onto a class with — rather than shaped by hand to look
 * like what the classifier expects, which would only prove the two agree with
 * each other.
 */
const { default: RealStripe } = await vi.importActual<typeof import("stripe")>("stripe");
const answer = (raw: Record<string, unknown>) => RealStripe.errors.generateV1Error(raw);

/** The one write and the startup probe's lists, and nothing else of the SDK. */
const sdk = vi.hoisted(() => ({
  cancel: async (): Promise<unknown> => ({}),
  refusing: new Set<string>(),
  refusal: undefined as unknown,
}));

vi.mock("stripe", () => {
  const list = (resource: string) => async () => {
    if (sdk.refusing.has(resource)) throw sdk.refusal;
    return { data: [] };
  };
  return {
    default: class {
      customers = { list: list("customers") };
      subscriptions = { list: list("subscriptions"), cancel: () => sdk.cancel() };
      subscriptionSchedules = { list: list("subscriptionSchedules") };
      setupIntents = { list: list("setupIntents") };
      invoices = { list: list("invoices") };
      paymentIntents = { list: list("paymentIntents") };
      prices = { list: list("prices") };
    },
  };
});

beforeEach(() => {
  vi.stubEnv("SB_BILLING_ENABLED", "true");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_failures");
  vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_failures");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_failures");
  vi.stubEnv("STRIPE_PRICE_MONTHLY_ID", "price_monthly");
  vi.stubEnv("STRIPE_PRICE_YEARLY_ID", "price_yearly");
  sdk.cancel = async () => ({});
  sdk.refusing.clear();
  sdk.refusal = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The adapter and the registry it records into, both fresh, so counts start at zero. */
async function load() {
  vi.resetModules();
  const stripe = await import("../src/server/stripe.js");
  const metrics = await import("../src/server/metrics.js");
  const read = async (counter: typeof metrics.stripeRequests) =>
    (await counter.get()).values.map(({ labels, value }) => ({ labels, value }));
  return {
    ...stripe,
    failures: () => read(metrics.stripeRequestFailures),
    requests: () => read(metrics.stripeRequests),
  };
}

/**
 * One of each reason, as Stripe would answer it. Both codes about the key are
 * given a 403 here, as the fixtures in `stripe-prices.test.ts` give them, and
 * the SDK builds a 403 as a permission error — so the second is where a
 * classifier that read the class before the code would file a write held for
 * approval as a missing permission, and send an operator to replace a key that
 * works.
 */
const CASES: [StripeFailureReason, () => unknown][] = [
  [
    "card",
    () =>
      answer({ statusCode: 402, type: "card_error", code: "card_declined", message: "Declined" }),
  ],
  [
    "invalid_request",
    () => answer({ statusCode: 400, type: "invalid_request_error", code: "parameter_missing" }),
  ],
  ["idempotency", () => answer({ statusCode: 400, type: "idempotency_error" })],
  ["authentication", () => answer({ statusCode: 401, type: "invalid_request_error" })],
  [
    "permission",
    () =>
      answer({ statusCode: 403, type: "invalid_request_error", code: "more_permissions_required" }),
  ],
  [
    "approval_required",
    () => answer({ statusCode: 403, type: "invalid_request_error", code: "approval_required" }),
  ],
  [
    "rate_limit",
    () => answer({ statusCode: 429, type: "invalid_request_error", code: "rate_limit" }),
  ],
  // What the SDK throws once its own timeout has run out on every attempt.
  [
    "connection",
    () =>
      new RealStripe.errors.StripeConnectionError({
        message: "Request aborted due to timeout being reached (10000ms)",
      }),
  ],
  ["api", () => answer({ statusCode: 500, type: "api_error" })],
  // Not Stripe's answer at all: a fault in the code around the call.
  ["other", () => new TypeError("Cannot read properties of undefined (reading 'id')")],
];

describe("why a Stripe call failed", () => {
  it("has a case here for every reason the label can carry", () => {
    expect(CASES.map(([reason]) => reason).sort()).toEqual([...STRIPE_FAILURE_REASONS].sort());
  });

  it.each(CASES)(
    "files %s under its own reason, beside the failure it already counted",
    async (reason, build) => {
      const error = build();
      sdk.cancel = async () => {
        throw error;
      };
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const adapter = await load();

      await expect(adapter.cancelStripeSubscriptionNow("sub_1", "key")).rejects.toBe(error);

      expect(await adapter.failures()).toEqual([
        { labels: { operation: "subscription.cancel", reason }, value: 1 },
      ]);
      // The existing series is untouched by the new one: still one failure.
      expect(await adapter.requests()).toEqual([
        { labels: { operation: "subscription.cancel", outcome: "failed" }, value: 1 },
      ]);
      // And the line about the key agrees with the reason about the key, because
      // both are read off one classification: written for exactly the two
      // reasons that are the key's, and for nothing else.
      const aboutTheKey = reason === "permission" || reason === "approval_required";
      expect(logged).toHaveBeenCalledTimes(aboutTheKey ? 1 : 0);
    },
  );

  it("names no reason for a call that succeeded", async () => {
    const adapter = await load();

    await adapter.cancelStripeSubscriptionNow("sub_1", "key");

    expect(await adapter.requests()).toEqual([
      { labels: { operation: "subscription.cancel", outcome: "ok" }, value: 1 },
    ]);
    expect(await adapter.failures()).toEqual([]);
  });

  /**
   * The startup probe asks `measured` not to write its per-call line, because
   * it says what it found in one line of its own. That switch is about the log:
   * a key that cannot read Invoices is as much a failure in the count as any.
   */
  it("counts why the startup probe was refused, though it writes no line per call", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "rk_test_failures");
    sdk.refusing.add("invoices");
    sdk.refusal = answer({
      statusCode: 403,
      type: "invalid_request_error",
      code: "more_permissions_required",
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = await load();

    await expect(adapter.checkStripeAccess()).resolves.toEqual(["Invoices"]);

    expect(await adapter.failures()).toEqual([
      { labels: { operation: "invoice.list", reason: "permission" }, value: 1 },
    ]);
  });
});
