import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type api from "../src/server/api.js";

/**
 * Whether the five `/api/v1/billing` routes exist at all.
 *
 * They are registered inside `if (getConfig().billing)` at module scope
 * (`src/server/api.ts`), and `docs/standards/http.md` publishes the claim that
 * a deployment with no Stripe has no billing surface. Nothing checked it.
 * `tests/http-route-table.test.ts` reads the route names out of the source with
 * a regex, so the guard is invisible to it — a route inside the `if` and a
 * route outside it look identical to a text scan — and the four billing
 * integration files call the services directly without ever issuing a request.
 *
 * Written as a pair on purpose. The 404 arm alone proves nothing: a probe that
 * 404s because the path was misspelled, or because a middleware refused it
 * first, passes forever and says the guard works. The control arm, with the
 * keys in place, is what makes the refusal mean "this route is not registered"
 * rather than "something answered 404".
 *
 * It is a file of its own rather than another block in
 * `tests/stripe-webhook-route.test.ts`, which owns the same guard one prefix
 * over: this one has to stand in for a signed-in session, and doing that inside
 * that file would put an auth mock in front of its eighteen unauthenticated
 * webhook tests for no reason of theirs.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  // Pinned rather than inherited: `protectBrowserMutation` compares the
  // `Origin` header of every PUT and POST below against this, and a runner
  // started with another would turn four of the five probes into a 403 that
  // looks exactly like the absence being tested for.
  APP_BASE_URL: "http://localhost:5173",
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_routes",
  STRIPE_PUBLISHABLE_KEY: "pk_test_routes",
  STRIPE_WEBHOOK_SECRET: "whsec_a_secret_only_stripe_and_this_deployment_share",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;

/** Every name that decides whether the guard is open, so a case can close it. */
const stripeKeys = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY_ID",
  "STRIPE_PRICE_YEARLY_ID",
] as const;

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
 * One set of spies for the file, kept outside the mock factories.
 *
 * `freshApp` re-imports the whole graph for every test, and a `vi.fn()` created
 * inside a factory is a new pair of eyes on each import — so every
 * `not.toHaveBeenCalled()` below would be asked of an object the route never
 * touched, and would pass whatever the route did.
 */
const stubs = {
  getBillingStatus: vi.fn(),
  setSubscription: vi.fn(),
  setSubscriptionCancellation: vi.fn(),
  createPaymentSetup: vi.fn(),
  confirmPaymentSetup: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, stub] of Object.entries(stubs)) stub.mockResolvedValue({ stub: name });
});

/**
 * The API app, rebuilt against whatever the environment says right now.
 *
 * The routes are registered at module scope, so the environment has to be in
 * place before the import rather than before the request. `doMock` inside here
 * rather than a hoisted `vi.mock`, because a hoisted factory is evaluated once
 * and keeps the `config.js` that existed the first time — which is the one
 * thing this file changes between tests.
 *
 * `getWebIdentity` is stood in for because the middleware over `/api/v1/*`
 * answers 401 before the unmatched-path catch-all is ever reached, so an
 * anonymous request cannot tell a registered route from an absent one. It is
 * the only thing standing in for authentication here, and it is replaced rather
 * than weakened: nothing below asserts anything about who is signed in.
 */
async function freshApp() {
  vi.resetModules();
  vi.doMock("../src/server/auth.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/server/auth.js")>()),
    getWebIdentity: async () => ({
      user: { id: "user_1", email: "somebody@example.test" },
      session: { createdAt: new Date("2026-09-01T00:00:00.000Z").toISOString() },
    }),
  }));
  vi.doMock("../src/server/services/billing.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/server/services/billing.js")>()),
    ...stubs,
  }));
  return (await import("../src/server/api.js")).default as typeof api;
}

/** The five routes the guard owns, in the order `src/server/api.ts` registers them. */
const routes = [
  ["GET", "/api/v1/billing"],
  ["PUT", "/api/v1/billing/subscription"],
  ["PUT", "/api/v1/billing/subscription/cancellation"],
  ["POST", "/api/v1/billing/payment-setups"],
  ["POST", "/api/v1/billing/payment-setups/confirmations"],
] as const;

/**
 * What each of the five answered, labelled so a failure names the route rather
 * than saying one of five changed.
 */
async function answers(app: typeof api) {
  const collected: unknown[][] = [];
  for (const [method, path] of routes) {
    const response = await app.request(`${billingEnvironment.APP_BASE_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        // Required of a PUT or POST by `protectBrowserMutation`, and harmless
        // on the GET.
        origin: billingEnvironment.APP_BASE_URL,
      },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    collected.push([
      `${method} ${path}`,
      response.status,
      (response.headers.get("content-type") ?? "").includes("application/json"),
    ]);
  }
  return collected;
}

describe("the billing routes on a deployment with no Stripe", () => {
  it("registers all five where Stripe is configured", async () => {
    // The control. Without it the refusal below proves only that something
    // answered 404, which a typo in any of these five paths would also do.
    const app = await freshApp();

    expect(await answers(app)).toEqual(
      routes.map(([method, path]) => [`${method} ${path}`, 200, true]),
    );
    for (const stub of Object.values(stubs)) expect(stub).toHaveBeenCalledTimes(1);
  });

  it("registers none of them where it is not", async () => {
    // Absent rather than refused, and the difference is the one an operator
    // reads: a 403 says the deployment sells plans and will not let this person
    // buy one, and a 404 says it sells nothing at all. The JSON is asserted
    // beside the status because the unmatched-path catch-all over `/api/v1/*`
    // is what answers here, and a shell served in its place would be a 200.
    for (const key of stripeKeys) delete process.env[key];
    delete process.env.SB_BILLING_ENABLED;
    try {
      const app = await freshApp();

      expect(await answers(app)).toEqual(
        routes.map(([method, path]) => [`${method} ${path}`, 404, true]),
      );
      // Nothing reached a service on the way out. A route that answered 404
      // after calling one would have spent the Stripe request anyway.
      for (const stub of Object.values(stubs)) expect(stub).not.toHaveBeenCalled();
    } finally {
      Object.assign(process.env, billingEnvironment);
    }
  });
});
