import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What each Stripe read asks Stripe to expand, which nothing else asserts.
 *
 * `tests/stripe-events.test.ts` proves `pendingPhase` and `phasePriceId` over
 * every phase shape, but it runs `snapshotOfSubscription` directly on a
 * hand-built subscription and never calls the function that fetches one. So the
 * one line that decides whether a real sync ever sees a phase at all —
 * `expand: ["schedule"]` in `fetchSubscriptionSnapshot` — was asserted nowhere.
 *
 * Drop it and Stripe sends `schedule` as a bare id string. `pendingPhase`
 * answers null for every delivery, and `tests/stripe-events.test.ts` goes on
 * passing, because it asserts — correctly — that null is the right reading of
 * exactly that shape. The suite would be green on the only payload production
 * would ever receive again.
 *
 * What that costs downstream: `scheduledPriceId` reaches `subscriptionAction`
 * in `src/shared/domain.ts` as the person's pending switch. Forced to null, an
 * annual subscriber with a downgrade pending gets `none` from the Yearly button
 * — the press that would call the switch off does nothing — and `schedule` from
 * the Monthly one, which releases the live schedule and writes a fresh one,
 * moving the boundary they were promised. The tab never says a word about the
 * switch either way.
 *
 * A file of its own rather than an addition to either neighbour, and both
 * reasons are structural: `tests/stripe-events.test.ts` carries no `vi.mock` at
 * all, so an SDK double added there rewires the module graph under its other
 * tests; and `tests/stripe-schedule-phases.test.ts` scopes its double, in its
 * own docblock, to "the two endpoints a scheduled price change touches", which
 * a third endpoint would contradict.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_snapshot_expand",
  STRIPE_PUBLISHABLE_KEY: "pk_test_snapshot_expand",
  STRIPE_WEBHOOK_SECRET: "whsec_snapshot_expand",
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

/**
 * The three subscription endpoints that expand something, and nothing else of
 * the SDK. A call this file's paths made to anything not here would throw
 * rather than quietly reach Stripe.
 */
const retrieve = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    subscriptions = { retrieve, create, update };
  },
}));

beforeEach(() => {
  retrieve.mockReset();
  create.mockReset();
  update.mockReset();
});

const load = async () => {
  vi.resetModules();
  return await import("../src/server/stripe.js");
};

/** 2023-11-14: before any `now` this test can be run at. */
const STARTED = 1_700_000_000;
/** 2100-01-01: after any `now` this test can be run at. */
const PENDING = 4_102_444_800;

/**
 * An annual subscription carrying a schedule, as Stripe hands one back when the
 * `schedule` expand is in place: the object, with its phases, rather than its
 * id. The phase prices are bare id strings because the expand expands the
 * schedule and not the prices on it, which is the shape a real sync receives.
 */
const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  customer: "cus_1",
  created: STARTED,
  cancel_at_period_end: false,
  cancel_at: null,
  latest_invoice: "in_1",
  items: { data: [{ price: { id: "price_yearly" }, current_period_end: PENDING }] },
  schedule: {
    id: "sub_sched_1",
    phases: [
      { start_date: STARTED, items: [{ price: "price_yearly" }] },
      { start_date: PENDING, items: [{ price: "price_monthly" }] },
    ],
  },
  ...over,
});

describe("reading a subscription back from Stripe", () => {
  it("asks Stripe to expand the schedule, so the phases arrive as phases", async () => {
    retrieve.mockResolvedValue(subscription());
    const { fetchSubscriptionSnapshot } = await load();

    const snapshot = await fetchSubscriptionSnapshot("sub_1");

    // Compared whole rather than with `objectContaining`, so narrowing the
    // expand to some other field and dropping the options object altogether
    // both fail here, rather than one of them passing as "an options object was
    // sent". This is the only assertion in the repository on this argument.
    expect(retrieve).toHaveBeenCalledWith("sub_1", { expand: ["schedule"] });
    // And the fact the expand exists for, so the test names its purpose rather
    // than only its spelling: with the schedule expanded a pending phase is
    // readable, and a literal that differs from the subscription's own price
    // is what a schedule-blind implementation cannot satisfy by echoing back.
    expect(snapshot).toMatchObject({
      priceId: "price_yearly",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date(PENDING * 1000),
    });
  });

  it("keeps each read's expand on its own call rather than crossing them", async () => {
    // The copy-paste hazard: several subscription calls on one client, each
    // expanding something different, and nothing failing to compile if a line
    // moves between them. Crossed, each is silent in its own way — the snapshot
    // stops seeing schedules, and the create stops carrying the client secret
    // the browser needs to pay the first invoice, so a subscription is made
    // that nobody can complete and the plan tab has nothing to mount a form on.
    //
    // These two rather than all three of the subscription reads:
    // `switchStripeSubscriptionNow`'s expand is asserted by
    // `tests/billing-setup-intent.test.ts`, and its shape is the one still
    // moving on this branch, so pinning it twice would pin it in two places
    // that have to be changed together.
    retrieve.mockResolvedValue(subscription());
    create.mockResolvedValue(
      subscription({
        latest_invoice: { id: "in_new", confirmation_secret: { client_secret: "pi_1_secret" } },
        schedule: null,
      }),
    );
    const { createStripeSubscription, fetchSubscriptionSnapshot } = await load();

    await fetchSubscriptionSnapshot("sub_1");
    const created = await createStripeSubscription(
      { customerId: "cus_1", priceId: "price_monthly" },
      "key_create",
    );

    // `retrieve` takes its options as a second argument and `create` carries
    // `expand` in the body, which is itself part of why a line moved between
    // them is not a type error.
    expect(retrieve.mock.calls[0]?.[1]).toEqual({ expand: ["schedule"] });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      expand: ["latest_invoice.confirmation_secret"],
    });
    // What the create's expand is for, named rather than only spelled: without
    // it `latest_invoice` arrives as an id string and the secret is null.
    expect(created.clientSecret).toBe("pi_1_secret");
  });
});
