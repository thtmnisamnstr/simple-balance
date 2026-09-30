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

/**
 * What the public endpoint does when it is leaned on, which is deliberately
 * nothing.
 *
 * `/api/billing/webhook` is the one unauthenticated, unbounded, un-rate-limited
 * route in the process, and it looks exactly like the shape a hardening sweep
 * flags. It must not be hardened. Any non-2xx tells Stripe to retry, and while
 * Stripe retries it delays finalization of *every* auto-collection invoice on
 * the account for up to 72 hours — so a limiter, an auth guard, an `Origin`
 * check or a content-type gate in front of this route does not throttle an
 * attacker, it stops billing for every customer on the account. The cost of
 * leaving it open is one warn line and one HMAC per request, which is log
 * storage and CPU and nobody's ledger.
 *
 * This describe holds only that. What each verified delivery *does* is
 * `tests/stripe-webhook-route.test.ts`.
 */
describe("the endpoint Stripe talks to", () => {
  const level = process.env.LOG_LEVEL;

  beforeEach(() => {
    // The default, because the question is what an operator sees without
    // having asked for anything. A runner started at `warn` would hide the
    // second half of this and a runner at `debug` would prove nothing about
    // the first.
    delete process.env.LOG_LEVEL;
  });

  afterAll(() => {
    if (level === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = level;
  });

  /** The API app and the logger, both rebuilt against this environment. */
  async function freshApi() {
    const logging = await import("../src/server/log.js");
    logging.resetLogLevel();
    return (await import("../src/server/api.js")).default;
  }

  const post = async (api: Awaited<ReturnType<typeof freshApi>>, signature: string) =>
    api.request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });

  /** Twelve, because one proves the answer and a run proves nothing changed. */
  const RUN = 12;

  it("refuses a flood of unverifiable deliveries without ever throttling one", async () => {
    const api = await freshApi();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const responses: Response[] = [];
    for (let attempt = 0; attempt < RUN; attempt += 1) {
      responses.push(await post(api, "t=1,v1=deadbeef"));
    }

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: RUN }, () => 400),
    );
    // A limiter announces itself in the headers before it announces itself in
    // the status, so these are what a sweep would leave behind even if it were
    // tuned high enough that twelve requests never reached the ceiling.
    const announced = responses.flatMap((response) =>
      ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "ratelimit-limit"].filter(
        (header) => response.headers.has(header),
      ),
    );
    expect(announced).toEqual([]);
    vi.restoreAllMocks();
  });

  it("answers a run of verified deliveries it has no opinion about with 2xx", async () => {
    // The same rule from the other side: the endpoint must stay open to the
    // deliveries that verify, too. `body` names `sub_1` and no customer, so
    // this falls out at the unknown-customer exit without a query.
    const api = await freshApi();
    vi.spyOn(console, "info").mockImplementation(() => {});

    const statuses: number[] = [];
    for (let attempt = 0; attempt < RUN; attempt += 1) {
      statuses.push((await post(api, delivery(body))).status);
    }

    expect(statuses).toEqual(Array.from({ length: RUN }, () => 200));
    vi.restoreAllMocks();
  });

  it("writes one identical line per refusal, carrying nothing from the request", async () => {
    // The flood's real cost, stated so that the cheaper fix — quieting the line
    // rather than throttling the route — is a deliberate change instead of an
    // accident. And the line has to stay useless to whoever is sending the
    // floods: the body is attacker-reachable until the signature verifies, so
    // neither the signature, the payload nor Stripe's own diagnosis of what was
    // wrong may appear in it.
    const api = await freshApi();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let attempt = 0; attempt < RUN; attempt += 1) {
      await post(api, `t=1,v1=deadbeef${attempt}`);
    }

    const lines = warn.mock.calls.map((call) => call.map(String).join(" "));
    expect(lines).toHaveLength(RUN);
    expect(new Set(lines).size).toBe(1);
    expect(lines[0]).toMatch(/signature/i);
    expect(lines[0]).not.toMatch(
      /deadbeef|evt_signature_1|sub_1|whsec|timestamp|tolerance|expected|no signatures/i,
    );
    vi.restoreAllMocks();
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
