import Stripe from "stripe";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type api from "../src/server/api.js";

/**
 * The wiring between Stripe and the services, which nothing else exercises.
 *
 * `tests/stripe-events.test.ts` proves the pure readers and
 * `tests/billing-setup-intent.test.ts` proves the appliers. What sat between
 * them — signature verification, the customer-id extraction that feeds the
 * dispatch, the order of the six exits, and the rule that every deliberate
 * no-op answers 2xx — was owned by the route and asserted by nobody. That gap
 * has already cost once: `stripeCustomerIdForEvent` answered null for every
 * `customer.deleted` delivery, which made the branch written for it dead, and
 * the suite stayed green because no test ever issued the request.
 *
 * So the pure dispatch is kept REAL here — `stripeEventFrom`,
 * `stripeCustomerIdForEvent`, `subscriptionIdForEvent`, `isNoteworthyEvent` —
 * and only what touches the database or the network is stood in for. Mocking
 * the readers would leave the same hole one level down.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_route",
  STRIPE_PUBLISHABLE_KEY: "pk_test_route",
  STRIPE_WEBHOOK_SECRET: "whsec_a_secret_only_stripe_and_this_deployment_share",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
  // Pinned rather than inherited: two of the six exits say what they did only
  // in the log, and a runner started with LOG_LEVEL=warn would silence them
  // and turn those assertions into a test of the environment.
  LOG_LEVEL: "info",
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

/**
 * One set of spies for the whole file, kept outside the factories on purpose.
 *
 * A `vi.fn()` created inside a mock factory is a new pair of eyes on every
 * import, and `freshApp` re-imports for every test, so each
 * `toHaveBeenCalledWith` below would be asked of an object the route never
 * touched.
 */
const stubs = {
  applyCustomerDeletion: vi.fn(),
  applySetupIntentSucceeded: vi.fn(),
  applyStripeDelivery: vi.fn(),
  userForStripeCustomer: vi.fn(),
  fetchSubscriptionSnapshot: vi.fn(),
};

/** What Stripe hands back for a subscription the route re-reads. */
const snapshot = {
  stripeSubscriptionId: "sub_1",
  status: "active",
  priceId: "price_monthly",
  currentPeriodEnd: new Date("2026-10-25T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  scheduledPriceId: null,
  scheduledAt: null,
  syncedAt: new Date("2026-09-25T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  stubs.applyCustomerDeletion.mockResolvedValue("written");
  stubs.applySetupIntentSucceeded.mockResolvedValue("written");
  stubs.applyStripeDelivery.mockResolvedValue("written");
  stubs.userForStripeCustomer.mockResolvedValue("user_1");
  stubs.fetchSubscriptionSnapshot.mockResolvedValue(snapshot);
});

/**
 * The API app, rebuilt against whatever the environment says right now.
 *
 * The route is registered at module scope under `if (getConfig().billing)`, so
 * the environment has to be in place before the import rather than before the
 * request. The metrics module is pulled from the same fresh graph for the same
 * reason: after `resetModules` the app increments counters in a registry that
 * is not the one a top-level import would be holding.
 *
 * `doMock` inside here rather than a hoisted `vi.mock` at the top, and that is
 * not a style choice. A hoisted factory is evaluated once and kept: the copy of
 * `stripe.js` it closes over stays bound to the `config.js` that existed the
 * first time, so the two tests below that change the environment would leave
 * every later test verifying signatures against a deployment that no longer
 * matches — 400 everywhere, in declaration order, for a reason nothing in the
 * failing test names. Re-registered per build, the mocked graph is always the
 * environment's own.
 */
async function freshApp() {
  vi.resetModules();
  vi.doMock("../src/server/services/billing.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/server/services/billing.js")>()),
    applyCustomerDeletion: stubs.applyCustomerDeletion,
    applySetupIntentSucceeded: stubs.applySetupIntentSucceeded,
    applyStripeDelivery: stubs.applyStripeDelivery,
    userForStripeCustomer: stubs.userForStripeCustomer,
  }));
  vi.doMock("../src/server/stripe.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/server/stripe.js")>()),
    // `stripeEventFrom` is deliberately not stubbed. It is the only thing
    // standing between the ledger and anybody who can reach the public URL, so
    // a test that stood in for it would prove the route calls something.
    fetchSubscriptionSnapshot: stubs.fetchSubscriptionSnapshot,
  }));
  const metrics = await import("../src/server/metrics.js");
  const app = (await import("../src/server/api.js")).default as typeof api;
  metrics.resetMetrics();
  return { app, metrics };
}

/** A delivery signed the way Stripe signs one. */
const signed = (payload: string, secret: string = billingEnvironment.STRIPE_WEBHOOK_SECRET) =>
  Stripe.webhooks.generateTestHeaderString({ payload, secret });

const bodyOf = (event: Record<string, unknown>) => JSON.stringify({ object: "event", ...event });

/**
 * `signature: null` omits the header entirely, which is a different failure
 * from a header that does not verify and has its own branch in Stripe's
 * verifier.
 */
async function deliver(
  app: typeof api,
  body: string,
  over: { signature?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = over.signature === undefined ? signed(body) : over.signature;
  if (signature !== null) headers["stripe-signature"] = signature;
  return app.request("http://localhost/api/billing/webhook", { method: "POST", headers, body });
}

/** What every route below the two API prefixes answers for a path it does not own. */
const notFound = { error: { code: "NOT_FOUND", message: "No such endpoint" } };

/**
 * The body as JSON, or the raw text when it is not JSON at all — which is the
 * answer this file is watching for, so it has to arrive in a diff rather than
 * as a `SyntaxError` from the assertion itself.
 */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

/** Every environment key this file's `billing` half owns, for the two gate tests. */
const stripeKeys = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY_ID",
  "STRIPE_PRICE_YEARLY_ID",
] as const;

describe("whether the deployment has a webhook route at all", () => {
  it("has none when there is no Stripe to answer for", async () => {
    // The route is the one unauthenticated, public, body-reading endpoint in
    // the process. A deployment that sells nothing must not have it standing
    // open: the catch-all under the prefix answers 404, which is also what
    // tells Stripe a misdirected delivery did not arrive.
    for (const key of stripeKeys) delete process.env[key];
    delete process.env.SB_BILLING_ENABLED;
    try {
      const { app } = await freshApp();
      const body = bodyOf({
        id: "evt_absent",
        type: "customer.deleted",
        data: { object: { object: "customer", id: "cus_absent" } },
      });

      const response = await app.request("http://localhost/api/billing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const text = await response.text();

      expect(response.status).toBe(404);
      // The status alone is not the claim. Hono answers an unmatched path with
      // its own 404 too, and in production the shell below this prefix answers
      // 200 text/html — so a status-only assertion passes with the catch-all
      // that makes this true deleted. The content type and the body are what
      // separate "this deployment has no such endpoint" from "here is a web
      // page", and Stripe records the second as delivered.
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(parsed(text)).toEqual(notFound);
      expect(stubs.applyCustomerDeletion).not.toHaveBeenCalled();
    } finally {
      Object.assign(process.env, billingEnvironment);
    }
  });

  it("still answers deliveries on a deployment that stopped selling", async () => {
    // `SB_BILLING_ENABLED=false` with the keys still set is the documented way
    // to stop selling (`docs/billing-operations.md` §Stopping selling), and the
    // subscriptions somebody already pays for keep arriving. Gating the route
    // on `enforcing` rather than on `billing` would strand every one of them:
    // Stripe would get a 404, retry for 72 hours, and give up with the
    // deployment still showing a plan that has been canceled.
    process.env.SB_BILLING_ENABLED = "false";
    try {
      const { app } = await freshApp();
      const body = bodyOf({
        id: "evt_wound_down",
        type: "customer.deleted",
        data: { object: { object: "customer", id: "cus_wound_down" } },
      });

      const response = await deliver(app, body);

      expect(response.status).toBe(200);
      expect(stubs.applyCustomerDeletion).toHaveBeenCalledWith(
        "cus_wound_down",
        expect.objectContaining({ id: "evt_wound_down" }),
      );
    } finally {
      process.env.SB_BILLING_ENABLED = billingEnvironment.SB_BILLING_ENABLED;
    }
  });
});

/**
 * The guard below every route this prefix owns and above the single-page shell.
 *
 * `app.all("/api/billing/*", ...)` was reachable by nothing in the suite: the
 * one test that hit it asserted its status and nothing else, and Hono's own
 * unmatched-path answer is a 404 as well, so the line could be deleted outright
 * with everything green. Its twin over `/api/v1/*` is asserted properly, in
 * `tests/integration/auth.integration.test.ts`, which is what made the
 * asymmetry worth closing rather than arguing about.
 *
 * What it prevents is the failure nothing retries. In production the shell is
 * mounted below this prefix, so a delivery aimed at a misspelled path — or at
 * a deployment with no Stripe, where the endpoint genuinely does not exist —
 * would come back 200 text/html, which Stripe records as delivered and never
 * sends again. The same answer is owed to an API client, which parses the shell
 * into a syntax error rather than reading the 404 it asked for.
 */
describe("what the billing prefix does with a path it does not own", () => {
  /**
   * Every shape a misdirected delivery really takes: a misspelling, the
   * trailing slash Hono does not fold away, the bare prefix, and the right path
   * under the wrong method. The last one matters because a Stripe endpoint
   * saved with the wrong method fails this way and looks identical from the
   * dashboard.
   */
  const strays = [
    ["POST", "/api/billing/does-not-exist"],
    ["POST", "/api/billing/webhook/"],
    ["POST", "/api/billing/"],
    ["GET", "/api/billing/webhook"],
  ] as const;

  const strayBody = bodyOf({
    id: "evt_stray",
    type: "customer.deleted",
    data: { object: { object: "customer", id: "cus_stray" } },
  });

  /** What each stray answered, labelled so a failure names the path. */
  const strayAnswers = async (app: typeof api) => {
    const answers: unknown[][] = [];
    for (const [method, path] of strays) {
      const response = await app.request(
        `http://localhost${path}`,
        method === "POST"
          ? {
              method,
              headers: {
                "content-type": "application/json",
                "stripe-signature": signed(strayBody),
              },
              body: strayBody,
            }
          : { method },
      );
      answers.push([
        `${method} ${path}`,
        response.status,
        (response.headers.get("content-type") ?? "").includes("application/json"),
        parsed(await response.text()),
      ]);
    }
    return answers;
  };

  const expected = strays.map(([method, path]) => [`${method} ${path}`, 404, true, notFound]);

  it("answers a misdirected delivery as JSON, never as the app's own page", async () => {
    const { app } = await freshApp();

    expect(await strayAnswers(app)).toEqual(expected);
    // And nothing was claimed on the way: a 404 that had already written
    // something would be the worst of both, since Stripe will not send it again.
    expect(stubs.applyCustomerDeletion).not.toHaveBeenCalled();
    expect(stubs.applyStripeDelivery).not.toHaveBeenCalled();
  });

  it("answers the same way on a deployment that has no Stripe at all", async () => {
    // The case the guard exists for. With no webhook route registered, the
    // exact path Stripe was configured with falls through to the catch-all too,
    // so it is in the list here and not in the one above.
    for (const key of stripeKeys) delete process.env[key];
    delete process.env.SB_BILLING_ENABLED;
    try {
      const { app } = await freshApp();

      expect(await strayAnswers(app)).toEqual(expected);
      expect(
        parsed(
          await (
            await app.request("http://localhost/api/billing/webhook", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: strayBody,
            })
          ).text(),
        ),
      ).toEqual(notFound);
    } finally {
      Object.assign(process.env, billingEnvironment);
    }
  });
});

describe("verifying a delivery before acting on it", () => {
  const body = bodyOf({
    id: "evt_forged",
    type: "customer.deleted",
    data: { object: { object: "customer", id: "cus_victim" } },
  });

  /**
   * Each of these asserts the spy as well as the status, because a 400 alone
   * cannot show that nothing was written. `applyCustomerDeletion` is the
   * expensive one to get wrong: it drops the customer mapping and cancels every
   * live subscription row, with no Stripe read to contradict it, so a forged
   * delivery that got through takes somebody off the plan they are paying for
   * and leaves no way back through the app.
   */
  it("refuses a body that changed after Stripe signed it", async () => {
    const { app } = await freshApp();
    const signature = signed(body);
    const tampered = body.replace("cus_victim", "cus_attacker");

    const response = await deliver(app, tampered, { signature });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(stubs.applyCustomerDeletion).not.toHaveBeenCalled();
  });

  it("refuses a delivery signed with somebody else's secret", async () => {
    const { app } = await freshApp();

    const response = await deliver(app, body, { signature: signed(body, "whsec_somebody_elses") });

    expect(response.status).toBe(400);
    expect(stubs.applyCustomerDeletion).not.toHaveBeenCalled();
  });

  it("refuses a delivery carrying no signature at all", async () => {
    const { app } = await freshApp();

    const response = await deliver(app, body, { signature: null });

    expect(response.status).toBe(400);
    expect(stubs.applyCustomerDeletion).not.toHaveBeenCalled();
  });

  it("says a delivery was refused and never how close it was", async () => {
    // The body is attacker-reachable until verification succeeds, so the
    // response must not be an oracle. Stripe's own error text names the
    // timestamp, the tolerance and how many signatures it found, and passing
    // that through would tell somebody guessing exactly which knob to turn.
    const { app } = await freshApp();

    const response = await deliver(app, body, { signature: "t=1,v1=deadbeef" });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toMatch(/timestamp|tolerance|whsec|expected|no signatures|t=1|deadbeef/i);
  });
});

describe("which branch a verified delivery takes", () => {
  it("reads the customer's own id off a customer.deleted delivery", async () => {
    // A `customer.*` delivery carries the customer itself, so its id is on
    // `id` and there is no `customer` field at all. That is the shape Stripe
    // actually sends and the one the extraction missed for a whole release,
    // which made this branch dead while the route went on answering 200.
    const { app } = await freshApp();
    const body = bodyOf({
      id: "evt_customer_deleted",
      type: "customer.deleted",
      data: { object: { object: "customer", id: "cus_gone", email: "nobody@example.test" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: true });
    expect(stubs.applyCustomerDeletion).toHaveBeenCalledWith(
      "cus_gone",
      expect.objectContaining({ id: "evt_customer_deleted", type: "customer.deleted" }),
    );
    expect(stubs.applyStripeDelivery).not.toHaveBeenCalled();
    expect(stubs.applySetupIntentSucceeded).not.toHaveBeenCalled();
  });

  it("reports a customer.deleted it had already handled as acted on nothing", async () => {
    // The claim is what makes a retry safe, and Stripe retries for 72 hours.
    // `acted` is the honest answer rather than the reassuring one: it says this
    // delivery changed nothing, and the 200 still stops the retries.
    const { app } = await freshApp();
    stubs.applyCustomerDeletion.mockResolvedValue("duplicate");
    const body = bodyOf({
      id: "evt_customer_deleted_again",
      type: "customer.deleted",
      data: { object: { object: "customer", id: "cus_gone" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: false });
  });

  it("makes a card saved outside the tab the one Stripe bills", async () => {
    // The only route by which a method saved through a 3-D Secure redirect that
    // came back somewhere else becomes the default. Without this branch the
    // card is attached and never used, dunning keeps retrying the dead one, and
    // the subscriber loses the plan with a good card on file.
    const { app } = await freshApp();
    stubs.userForStripeCustomer.mockResolvedValue("user_setup");
    const body = bodyOf({
      id: "evt_setup",
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_1", customer: "cus_setup", payment_method: "pm_1" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: true });
    expect(stubs.applySetupIntentSucceeded).toHaveBeenCalledWith(
      "user_setup",
      expect.objectContaining({ id: "evt_setup" }),
    );
    expect(stubs.applyStripeDelivery).not.toHaveBeenCalled();
  });

  it("acknowledges a setup intent for a customer it has never heard of", async () => {
    const { app } = await freshApp();
    stubs.userForStripeCustomer.mockResolvedValue(null);
    const body = bodyOf({
      id: "evt_setup_stranger",
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_2", customer: "cus_stranger" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: false });
    expect(stubs.applySetupIntentSucceeded).not.toHaveBeenCalled();
  });

  it("says a refund arrived and changes no entitlement for it", async () => {
    // Money moved and no entitlement did. Whether to keep somebody on the paid
    // plan after charging back a year of it is a person's decision, so the only
    // thing owed here is that the person is told it happened.
    const { app } = await freshApp();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const body = bodyOf({
      id: "evt_refund",
      type: "charge.refunded",
      data: { object: { id: "ch_1", customer: "cus_refunded", amount_refunded: 900 } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: false });
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toContain("charge.refunded");
    expect(stubs.applyStripeDelivery).not.toHaveBeenCalled();
    expect(stubs.applyCustomerDeletion).not.toHaveBeenCalled();
    expect(stubs.applySetupIntentSucceeded).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("re-reads the subscription from Stripe and applies what it read", async () => {
    // Re-read rather than taken from the payload, which is what makes this a
    // reconciler: Stripe guarantees no ordering between deliveries, so the
    // event says what happened at some point and only a fresh read says what is
    // true now. The assertion is on the object identity for that reason — the
    // thing applied has to be the thing Stripe just answered with.
    const { app } = await freshApp();
    stubs.userForStripeCustomer.mockResolvedValue("user_sub");
    const body = bodyOf({
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", customer: "cus_sub", status: "past_due" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: true });
    expect(stubs.fetchSubscriptionSnapshot).toHaveBeenCalledWith("sub_1");
    expect(stubs.applyStripeDelivery).toHaveBeenCalledWith(
      "user_sub",
      expect.objectContaining({ id: "evt_sub_updated" }),
      snapshot,
    );
  });

  it("finds the subscription an invoice names on the parent Stripe moved it to", async () => {
    // `invoice.paid` is the only thing this product treats as proof that a
    // first payment succeeded, and newer payloads carry the subscription on
    // `parent.subscription_details` rather than at the top level. Read through
    // the route because that is where the two halves meet.
    const { app } = await freshApp();
    stubs.userForStripeCustomer.mockResolvedValue("user_invoice");
    const body = bodyOf({
      id: "evt_invoice_paid",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_1",
          customer: "cus_invoice",
          parent: { subscription_details: { subscription: "sub_from_parent" } },
        },
      },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(stubs.fetchSubscriptionSnapshot).toHaveBeenCalledWith("sub_from_parent");
    expect(stubs.applyStripeDelivery).toHaveBeenCalledWith(
      "user_invoice",
      expect.objectContaining({ id: "evt_invoice_paid" }),
      snapshot,
    );
  });

  it("acknowledges an unknown customer without claiming the delivery", async () => {
    // A customer created in Stripe's dashboard, or belonging to another
    // deployment on the same account. Acknowledged so Stripe stops retrying,
    // and *not* claimed so an operator who later maps it can replay the event
    // rather than find it marked handled. Nothing is read from Stripe either:
    // there is nobody to apply it to, and the read costs a request.
    const { app } = await freshApp();
    stubs.userForStripeCustomer.mockResolvedValue(null);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const body = bodyOf({
      id: "evt_stranger",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_stranger", customer: "cus_unmapped" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: false });
    expect(stubs.fetchSubscriptionSnapshot).not.toHaveBeenCalled();
    expect(stubs.applyStripeDelivery).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(
      /customer this deployment does not know/i,
    );
    info.mockRestore();
  });

  it("does nothing with a delivery that names no subscription", async () => {
    const { app } = await freshApp();
    const body = bodyOf({
      id: "evt_payment_intent",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1", customer: "cus_sub" } },
    });

    const response = await deliver(app, body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, acted: false });
    expect(stubs.userForStripeCustomer).not.toHaveBeenCalled();
    expect(stubs.fetchSubscriptionSnapshot).not.toHaveBeenCalled();
    expect(stubs.applyStripeDelivery).not.toHaveBeenCalled();
  });
});

/**
 * The rule the whole handler is shaped around, asserted over every way of
 * doing nothing rather than one.
 *
 * A non-2xx tells Stripe to retry, and while it retries Stripe delays
 * finalization of *every* auto-collection invoice on the account for up to 72
 * hours. So "this event is not mine" spelled as a failure does not affect one
 * delivery, it stops billing for every customer on the account.
 */
describe("every deliberate no-op answering 2xx", () => {
  const noOps: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["charge.dispute.created", { id: "dp_1", customer: "cus_x" }],
    ["charge.dispute.funds_withdrawn", { id: "dp_2", customer: "cus_x" }],
    ["payment_intent.succeeded", { id: "pi_2", customer: "cus_x" }],
    ["customer.updated", { object: "customer", id: "cus_x" }],
    ["setup_intent.succeeded", { id: "seti_3", customer: "cus_unmapped" }],
    ["customer.subscription.deleted", { id: "sub_2", customer: "cus_unmapped" }],
    ["invoice.payment_failed", { id: "in_2", customer: "cus_unmapped", subscription: "sub_3" }],
  ];

  it("answers 200 to each of them, whatever it decided not to do", async () => {
    const { app } = await freshApp();
    // Nobody this deployment knows, so the last three fall out at the unknown
    // customer exit rather than the ones above it.
    stubs.userForStripeCustomer.mockResolvedValue(null);
    vi.spyOn(console, "info").mockImplementation(() => {});

    const answered: Array<[string, number]> = [];
    for (const [type, object] of noOps) {
      const response = await deliver(
        app,
        bodyOf({ id: `evt_noop_${type}`, type, data: { object } }),
      );
      answered.push([type, response.status]);
    }

    // Written out rather than `every(...)`, so a regression names the delivery
    // that started failing instead of saying one of seven did.
    expect(answered).toEqual([
      ["charge.dispute.created", 200],
      ["charge.dispute.funds_withdrawn", 200],
      ["payment_intent.succeeded", 200],
      ["customer.updated", 200],
      ["setup_intent.succeeded", 200],
      ["customer.subscription.deleted", 200],
      ["invoice.payment_failed", 200],
    ]);
    vi.restoreAllMocks();
  });
});

describe("what an operator can see of a delivery", () => {
  it("counts the delivery under the route's pattern and writes no id into a label", async () => {
    // This is the one route whose body an unauthenticated caller supplies and
    // the only one a Stripe customer id passes through, so the rule that no
    // metric label carries somebody's identity is worth holding here
    // specifically. The status is part of the series because a refused
    // delivery and an accepted one are the same route.
    const { app, metrics } = await freshApp();
    const good = bodyOf({
      id: "evt_counted",
      type: "customer.deleted",
      data: { object: { object: "customer", id: "cus_counted" } },
    });

    await deliver(app, good);
    await deliver(app, good, { signature: "t=1,v1=deadbeef" });
    const text = await metrics.registry.metrics();

    expect(text).toMatch(
      /simple_balance_http_requests_total\{[^}]*route="\/api\/billing\/webhook"[^}]*status="200"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /simple_balance_http_requests_total\{[^}]*route="\/api\/billing\/webhook"[^}]*status="400"[^}]*\} 1/,
    );
    expect(text).not.toContain("cus_counted");
    expect(text).not.toContain("evt_counted");
  });

  /**
   * The question `http_requests_total` cannot answer, which is the only
   * question an operator has about this route.
   *
   * Five of the six no-op and acted-on exits reply `200 {"received":true}` on
   * one route with one method, so route+method+status counts them as one thing.
   * `docs/deployment.md` therefore sent anybody asking "did the subscription
   * path work?" to the reconciliation *sweep*'s counter — the wrong instrument,
   * because the sweep is the twelve-hourly catch-up and reads healthy right up
   * to the tick that repairs a webhook which has been failing for hours.
   *
   * Asserted as the whole series map compared to a literal, not as "some series
   * exists". A counter incremented with one constant label on every exit would
   * satisfy the weaker form while answering nothing, and that is the shape of
   * defect this repository has shipped before. Exact equality also catches the
   * two failures a per-exit counter really has: a branch that returns without
   * counting, and a branch counted twice.
   */
  it("counts what the delivery did, not only that it arrived", async () => {
    const { app, metrics } = await freshApp();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    // Four deliveries this deployment can place, all answering 200
    // {"received":true} — two that changed an entitlement, two that changed
    // nothing — plus the one exit that is not a 200 at all.
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_deleted",
        type: "customer.deleted",
        data: { object: { object: "customer", id: "cus_outcome" } },
      }),
    );
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_card",
        type: "setup_intent.succeeded",
        data: { object: { id: "seti_outcome", customer: "cus_outcome" } },
      }),
    );
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_refund",
        type: "charge.refunded",
        data: { object: { id: "ch_outcome", customer: "cus_outcome", amount_refunded: 900 } },
      }),
    );
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_other",
        type: "customer.updated",
        data: { object: { object: "customer", id: "cus_outcome" } },
      }),
    );
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_forged",
        type: "customer.deleted",
        data: { object: { object: "customer", id: "cus_outcome" } },
      }),
      { signature: "t=1,v1=deadbeef" },
    );

    // The sixth, and the branch this counter exists for: a subscription
    // delivery for a customer the deployment knows, re-read from Stripe and
    // applied. Every other exit here changed no entitlement, so `reconciled` is
    // the one an operator asking "did the subscription path work?" is actually
    // watching — and it is the one `http_requests_total` cannot separate from
    // the four 200s above it. Left out of the map below, relabelling it to
    // `ignored` would file every grant and revocation under "nothing to see"
    // with the whole suite green.
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_subscription",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_outcome", customer: "cus_outcome", status: "active" } },
      }),
    );

    // The seventh: a customer this deployment never mapped, which is a different
    // fact from any of the above and the one an operator sharing a Stripe
    // account between deployments watches.
    stubs.userForStripeCustomer.mockResolvedValue(null);
    await deliver(
      app,
      bodyOf({
        id: "evt_outcome_stranger",
        type: "invoice.payment_failed",
        data: { object: { id: "in_outcome", customer: "cus_stranger", subscription: "sub_x" } },
      }),
    );

    const series = (await metrics.registry.getMetricsAsJSON()).find(
      (metric) => metric.name === "simple_balance_billing_webhook_deliveries_total",
    );
    const byOutcome = Object.fromEntries(
      (series?.values ?? []).map((sample) => [String(sample.labels["outcome"]), sample.value]),
    );

    // Whole map, not `toMatchObject`: an exit that stopped counting leaves its
    // key out and an exit counted twice changes its value, and both have to
    // fail here rather than pass because the key being looked for is present.
    expect(byOutcome).toEqual({
      customer_deleted: 1,
      payment_method_pinned: 1,
      noteworthy: 1,
      ignored: 1,
      signature_refused: 1,
      unknown_customer: 1,
      reconciled: 1,
    });
    // Exact equality catches a branch that stopped counting and one counted
    // twice, but only among the branches something drove. So the closed set the
    // route can name is asserted as well: an exit added later with an outcome
    // of its own fails here, rather than going uncounted on the dashboard until
    // somebody notices the numbers do not add up.
    expect(Object.keys(byOutcome).sort()).toEqual([
      "customer_deleted",
      "ignored",
      "noteworthy",
      "payment_method_pinned",
      "reconciled",
      "signature_refused",
      "unknown_customer",
    ]);

    // The same rule as the series above it, restated because this counter is
    // the one fed by a body an unauthenticated caller supplies: the outcome
    // names a branch and never anything of Stripe's own vocabulary.
    const text = await metrics.registry.metrics();
    expect(text).not.toContain("cus_outcome");
    expect(text).not.toContain("cus_stranger");
    expect(text).not.toContain("evt_outcome");
    expect(text).not.toContain("seti_outcome");
    expect(text).not.toContain("sub_outcome");
    info.mockRestore();
  });
});
