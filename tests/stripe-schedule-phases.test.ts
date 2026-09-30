import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing on, for this file only, and restored afterward because every file
 * shares one process. `getStripe` refuses to build a client without it.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_schedule_phases",
  STRIPE_PUBLISHABLE_KEY: "pk_test_schedule_phases",
  STRIPE_WEBHOOK_SECRET: "whsec_schedule_phases",
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
 * The two endpoints a scheduled price change touches, and nothing else of the
 * SDK. Anything this path reached that is not here would throw rather than
 * quietly reach Stripe.
 */
const create = vi.fn();
const update = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    subscriptionSchedules = { create, update };
  },
}));

beforeEach(() => {
  create.mockReset();
  update.mockReset();
});

const load = async () => {
  vi.resetModules();
  return await import("../src/server/stripe.js");
};

/**
 * A subscription schedule as Stripe hands one back from `from_subscription`,
 * carrying every field the update has to repeat.
 *
 * Both `discount` and `coupon` are populated on every discount entry, which is
 * the load-bearing part of this fixture: a discount Stripe sends always carries
 * both, and a fixture with only one of them would pass whichever arm of `carry`
 * survived a refactor and so would prove nothing.
 */
const phase = (over: Record<string, unknown> = {}) => ({
  start_date: 1_764_547_200,
  end_date: 1_796_083_200,
  items: [
    {
      price: { id: "price_yearly" },
      quantity: 3,
      discounts: [{ discount: { id: "di_item" }, coupon: { id: "co_item" }, promotion_code: null }],
      tax_rates: [{ id: "txr_item_vat" }],
      metadata: { seat_plan: "team" },
    },
  ],
  discounts: [
    { discount: { id: "di_phase" }, coupon: { id: "co_half_off" }, promotion_code: null },
  ],
  default_tax_rates: [{ id: "txr_vat" }],
  trial_end: 1_767_225_600,
  metadata: { granted_by: "support" },
  ...over,
});

type Phase = {
  items: { price: string; quantity: number; discounts?: unknown; tax_rates?: unknown }[];
  discounts?: { discount?: string; coupon?: string; promotion_code?: string }[];
  duration?: { interval: string; interval_count: number };
};

/**
 * Runs the real `scheduleStripeSubscriptionPrice` against a schedule whose
 * first phase is `current`, and hands back what it asked Stripe to store.
 */
const schedulePhases = async (
  current: Record<string, unknown> = phase(),
  input: { priceId: string; interval: "month" | "year" } = {
    priceId: "price_monthly",
    interval: "month",
  },
) => {
  create.mockResolvedValue({ id: "sub_sched_1", phases: [current] });
  update.mockResolvedValue({ id: "sub_sched_1" });
  const { scheduleStripeSubscriptionPrice } = await load();
  const id = await scheduleStripeSubscriptionPrice(
    { subscriptionId: "sub_1", ...input },
    "req_key",
  );
  const [scheduleId, body, options] = update.mock.calls[0] as [
    string,
    { phases: Phase[]; end_behavior: string },
    { idempotencyKey: string },
  ];
  return { id, scheduleId, body, options, phases: body.phases };
};

/**
 * Handing the paid phase back whole.
 *
 * Stripe replaces a phase with exactly what is sent: anything previously set
 * and not repeated is unset, and none of these fields falls back to the
 * schedule's `default_settings`. So a field left out of this payload silently
 * reprices a period somebody has already paid for, and the damage surfaces on
 * an invoice weeks later rather than on the call. TypeScript cannot catch it —
 * every one of these is optional.
 */
describe("scheduling a price change against a paid period", () => {
  it("repeats the whole of the phase Stripe is already running", async () => {
    const { phases } = await schedulePhases();

    // Compared whole rather than field by field, because the defect is a field
    // that stops being sent and a `toMatchObject` would not notice one going.
    expect(phases[0]).toEqual({
      items: [
        {
          price: "price_yearly",
          quantity: 3,
          discounts: [{ discount: "di_item" }],
          tax_rates: ["txr_item_vat"],
          metadata: { seat_plan: "team" },
        },
      ],
      start_date: 1_764_547_200,
      end_date: 1_796_083_200,
      discounts: [{ discount: "di_phase" }],
      default_tax_rates: ["txr_vat"],
      trial_end: 1_767_225_600,
      metadata: { granted_by: "support" },
    });
  });

  it("carries the discount itself, never the coupon it came from", async () => {
    // The highest-value line in the function. A discount object knows how much
    // of its duration is spent; the coupon it was cut from does not. Name the
    // coupon afresh and "50% off for 3 months" with one month left restarts at
    // three, and the deployment gives away two months of revenue with nothing
    // anywhere reporting it.
    const { phases } = await schedulePhases();

    expect(phases[0].discounts).toEqual([{ discount: "di_phase" }]);
    expect(phases[0].discounts?.[0]).not.toHaveProperty("coupon");
    expect(phases[0].items[0].discounts).toEqual([{ discount: "di_item" }]);
  });

  it("falls back to a coupon, then a promotion code, and drops an empty entry", async () => {
    // Stripe sends `discount: null` on a phase discount that has not been
    // applied yet, so the fallbacks are reached in practice rather than being
    // defensive padding. An entry naming nothing at all is dropped rather than
    // sent as `{}`, which Stripe refuses outright.
    const { phases } = await schedulePhases(
      phase({
        discounts: [
          { discount: null, coupon: { id: "co_only" }, promotion_code: null },
          { discount: null, coupon: null, promotion_code: "promo_only" },
          { discount: null, coupon: null, promotion_code: null },
        ],
      }),
    );

    expect(phases[0].discounts).toEqual([{ coupon: "co_only" }, { promotion_code: "promo_only" }]);
  });

  it("sends back a bare price id as the id, not as an object", async () => {
    // A phase read without `expand` carries its price as a string. Reaching for
    // `.id` on it sends `price: undefined`, which Stripe rejects — the one
    // failure in this file that is loud, and only because the call fails.
    const { phases } = await schedulePhases(
      phase({ items: [{ price: "price_yearly_bare", quantity: 2 }] }),
    );

    expect(phases[0].items[0]).toEqual({ price: "price_yearly_bare", quantity: 2 });
  });

  it("leaves out what the phase does not have, rather than sending it empty", async () => {
    // `trial_end: null` sent back is not the same as leaving it out, and an
    // empty `discounts` or `tax_rates` array unsets what was there. A quantity
    // Stripe omitted defaults to one rather than to `undefined`, which would
    // remove the item.
    const { phases } = await schedulePhases(
      phase({
        items: [{ price: { id: "price_yearly" } }],
        discounts: [],
        default_tax_rates: [],
        trial_end: null,
        metadata: null,
      }),
    );

    expect(phases[0]).toEqual({
      items: [{ price: "price_yearly", quantity: 1 }],
      start_date: 1_764_547_200,
      end_date: 1_796_083_200,
    });
  });
});

/**
 * The phase that is being bought, and the call that writes both of them.
 */
describe("the phase the price change lands in", () => {
  it("runs one billing period at the new price, keeping the discount", async () => {
    // The discount belongs to the person rather than to the interval they were
    // on. Left out of the new phase it would end at the very renewal this
    // downgrade lands on, which is not something anybody asked for.
    const { phases, body } = await schedulePhases();

    expect(phases[1]).toEqual({
      items: [{ price: "price_monthly", quantity: 1 }],
      discounts: [{ discount: "di_phase" }],
      duration: { interval: "month", interval_count: 1 },
    });
    // Released afterward, so this is a one-time change of price rather than a
    // fixed-term plan that stops when the phase runs out.
    expect(body.end_behavior).toBe("release");
  });

  it("spells the duration as the interval that was asked for", async () => {
    const { phases } = await schedulePhases(phase(), {
      priceId: "price_yearly_next",
      interval: "year",
    });

    expect(phases[1].duration).toEqual({ interval: "year", interval_count: 1 });
    expect(phases[1].items[0].price).toBe("price_yearly_next");
  });

  it("spends a different idempotency key on the update than on the create", async () => {
    // Stripe scopes a key to one request. Reused here it would replay the
    // create's response, so the phases would never be written and the caller
    // would be told a schedule was arranged that still holds the old price.
    const { id, scheduleId, options } = await schedulePhases();

    expect(create).toHaveBeenCalledWith(
      { from_subscription: "sub_1" },
      { idempotencyKey: "req_key" },
    );
    expect(scheduleId).toBe("sub_sched_1");
    expect(options.idempotencyKey).toBe("req_key:phases:sub_sched_1");
    expect(id).toBe("sub_sched_1");
  });

  it("refuses a schedule that came back with no phases at all", async () => {
    // Without the check the next line reads `current.discounts` off undefined,
    // and a TypeError from the adapter is not something the plan tab can say
    // anything useful about.
    create.mockResolvedValue({ id: "sub_sched_2", phases: [] });
    const { scheduleStripeSubscriptionPrice } = await load();

    await expect(
      scheduleStripeSubscriptionPrice(
        { subscriptionId: "sub_1", priceId: "price_monthly", interval: "month" },
        "req_key",
      ),
    ).rejects.toThrow("Stripe returned a subscription schedule with no phases");
    expect(update).not.toHaveBeenCalled();
  });
});
