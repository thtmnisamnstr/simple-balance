import { describe, expect, it } from "vitest";
import { intervalOfPrice } from "../src/shared/domain.js";
import {
  isNoteworthyEvent,
  stripeCustomerIdForEvent,
  subscriptionIdForEvent,
} from "../src/server/services/billing.js";
import { snapshotOfSubscription } from "../src/server/stripe.js";

const event = (type: string, object: unknown) => ({ type, data: { object } });

/**
 * Which deliveries this product acts on, and which it acknowledges and ignores.
 *
 * Worth testing exhaustively because both mistakes are expensive and neither is
 * loud: acting on the wrong event writes a plan somebody did not buy, and
 * ignoring the right one leaves a paying customer on the free tier.
 */
describe("deciding what a Stripe delivery is about", () => {
  it("reads the subscription out of a subscription event", () => {
    for (const type of [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "customer.subscription.paused",
    ]) {
      expect(
        subscriptionIdForEvent(event(type, { id: "sub_1", object: "subscription" })),
        type,
      ).toBe("sub_1");
    }
  });

  it("reads it out of an invoice, in both shapes Stripe sends", () => {
    // The reference moved between API versions. Betting on one spelling means a
    // payment that never grants anything, on whichever accounts send the other.
    expect(subscriptionIdForEvent(event("invoice.paid", { subscription: "sub_flat" }))).toBe(
      "sub_flat",
    );
    expect(subscriptionIdForEvent(event("invoice.paid", { subscription: { id: "sub_obj" } }))).toBe(
      "sub_obj",
    );
    expect(
      subscriptionIdForEvent(
        event("invoice.payment_failed", {
          parent: { subscription_details: { subscription: "sub_parent" } },
        }),
      ),
    ).toBe("sub_parent");
    expect(
      subscriptionIdForEvent(
        event("invoice.payment_action_required", {
          parent: { subscription_details: { subscription: { id: "sub_parent_obj" } } },
        }),
      ),
    ).toBe("sub_parent_obj");
  });

  it("has no opinion about an invoice that names no subscription", () => {
    // A one-time invoice is not a subscription change, and treating it as one
    // would reconcile something that does not exist.
    expect(subscriptionIdForEvent(event("invoice.paid", { id: "in_1" }))).toBeNull();
    expect(subscriptionIdForEvent(event("invoice.paid", { parent: {} }))).toBeNull();
  });

  it("has no opinion about the events this product does not act on", () => {
    for (const type of [
      "payment_intent.succeeded",
      "charge.refunded",
      "customer.created",
      "customer.deleted",
      "checkout.session.completed",
      "payout.paid",
    ]) {
      expect(
        subscriptionIdForEvent(event(type, { id: "x", subscription: "sub_x" })),
        type,
      ).toBeNull();
    }
  });

  it("survives a payload that is not shaped the way it expects", () => {
    // The body is attacker-reachable until the signature has been checked, and
    // a handler that throws on a surprising shape is a handler that answers 500
    // to Stripe — which stalls every invoice on the account for 72 hours.
    for (const object of [null, undefined, "a string", 42, [], { subscription: 7 }]) {
      expect(() => subscriptionIdForEvent(event("invoice.paid", object))).not.toThrow();
      expect(subscriptionIdForEvent(event("invoice.paid", object))).toBeNull();
    }
  });
});

/**
 * Which person a delivery is about — the sole gate between anything Stripe says
 * and anybody's entitlement.
 *
 * Null is not an error on this path: the route logs "a customer this deployment
 * does not know", answers `{received: true, acted: false}` with a 200, and
 * Stripe marks the delivery handled and never retries it. So a branch that goes
 * quiet here costs a plan somebody paid for, or leaves a failed renewal
 * uncollected, and nothing anywhere says so. Each expected id is a literal that
 * appears nowhere else in its own payload, so no assertion can be satisfied by
 * an implementation that echoes some other field back.
 */
describe("which customer a Stripe delivery is about", () => {
  it("reads the bare id that every entitlement-bearing delivery carries", () => {
    // `invoice.paid`, `invoice.payment_failed` and the subscription events all
    // name their customer as a plain string on `object.customer`. This is the
    // branch the whole money path runs through.
    expect(
      stripeCustomerIdForEvent(
        event("invoice.paid", { id: "in_1", object: "invoice", customer: "cus_paid" }),
      ),
    ).toBe("cus_paid");
    expect(
      stripeCustomerIdForEvent(
        event("customer.subscription.deleted", {
          id: "sub_1",
          object: "subscription",
          customer: "cus_gone",
        }),
      ),
    ).toBe("cus_gone");
  });

  it("reads it out of a customer that arrived expanded", () => {
    // An endpoint configured to expand `customer` sends the whole record where
    // the id was. The same fact in the other shape, and betting on one spelling
    // is how half a deployment's deliveries stop resolving.
    expect(
      stripeCustomerIdForEvent(
        event("customer.subscription.updated", {
          id: "sub_1",
          object: "subscription",
          customer: { id: "cus_expanded", object: "customer" },
        }),
      ),
    ).toBe("cus_expanded");
  });

  it("reads it off a setup intent, which is how a card gets pinned", () => {
    // `setup_intent.succeeded` names no subscription at all, so this is the
    // only thing that says whose card was saved.
    expect(
      stripeCustomerIdForEvent(
        event("setup_intent.succeeded", {
          id: "seti_1",
          object: "setup_intent",
          customer: "cus_seti",
        }),
      ),
    ).toBe("cus_seti");
  });

  it("reads a customer delivery's own id, where there is no customer field", () => {
    // `customer.*` carries the customer itself: the id is on `id` and there is
    // no `customer` field anywhere in the payload. Without the last clause the
    // branch written for `customer.deleted` never fired for a single delivery
    // it was written for.
    expect(
      stripeCustomerIdForEvent(
        event("customer.deleted", { id: "cus_bye", object: "customer", deleted: true }),
      ),
    ).toBe("cus_bye");
    expect(
      stripeCustomerIdForEvent(
        event("customer.updated", { id: "cus_renamed", object: "customer", name: "New name" }),
      ),
    ).toBe("cus_renamed");
  });

  it("does not offer some other object's own id as a customer", () => {
    // The guard on the last clause. Unguarded it would answer `in_orphan` for
    // an invoice that names nobody, and the webhook would then hunt for a
    // customer record under an invoice id — finding none, or worse, finding a
    // deployment's unrelated row.
    expect(
      stripeCustomerIdForEvent(event("invoice.paid", { id: "in_orphan", object: "invoice" })),
    ).toBeNull();
    expect(
      stripeCustomerIdForEvent(
        event("customer.subscription.updated", { id: "sub_orphan", object: "subscription" }),
      ),
    ).toBeNull();
  });

  it("survives a payload that is not shaped the way it expects", () => {
    // Same reason as the subscription reader above: the body is
    // attacker-reachable until the signature has been checked, and a throw here
    // answers Stripe 500 and stalls every invoice on the account for 72 hours.
    for (const object of [null, undefined, "a string", 42, [], { customer: 7 }]) {
      expect(() => stripeCustomerIdForEvent(event("invoice.paid", object))).not.toThrow();
      expect(stripeCustomerIdForEvent(event("invoice.paid", object))).toBeNull();
    }
    // An expanded customer whose id is not a string is not an id. Answering
    // with the number would write it into a lookup as `"7"`.
    expect(
      stripeCustomerIdForEvent(
        event("invoice.paid", { id: "in_2", object: "invoice", customer: { id: 7 } }),
      ),
    ).toBeNull();
  });
});

/**
 * The deliveries that move money and move no entitlement.
 *
 * Separated from the rest because the mistake here is the quiet one: acting on
 * a refund would revoke a plan nobody agreed to revoke, and treating it as
 * uninteresting would leave an operator with no sign it happened.
 */
describe("deliveries that are noted rather than acted on", () => {
  it("notes refunds and disputes", () => {
    for (const type of [
      "charge.refunded",
      "charge.dispute.created",
      "charge.dispute.closed",
      "charge.dispute.funds_withdrawn",
    ]) {
      expect(isNoteworthyEvent(type), type).toBe(true);
    }
  });

  it("does not note a failed payment, which has to be reconciled", () => {
    // The one that looks like it belongs and does not. It names a subscription,
    // so it goes down the reconciling path — which is how `past_due` and the
    // fifteen-day grace it starts get recorded at all. Noting it instead would
    // make a failed renewal a log line and nothing else.
    expect(isNoteworthyEvent("invoice.payment_failed")).toBe(false);
    expect(subscriptionIdForEvent(event("invoice.payment_failed", { subscription: "sub_x" }))).toBe(
      "sub_x",
    );
  });

  it("does not note the ordinary subscription traffic", () => {
    for (const type of ["customer.subscription.updated", "invoice.paid", "customer.deleted"]) {
      expect(isNoteworthyEvent(type), type).toBe(false);
    }
  });
});

/**
 * Which interval a price id is. Shared between the browser and the server
 * because a page saying "switches to monthly" about a price it knows only by id
 * and a server deciding whether that is an upgrade have to agree.
 */
describe("reading an interval off a price id", () => {
  const prices = { monthlyPriceId: "price_m", yearlyPriceId: "price_y" };

  it("names each of the two", () => {
    expect(intervalOfPrice("price_m", prices)).toBe("monthly");
    expect(intervalOfPrice("price_y", prices)).toBe("yearly");
  });

  it("answers null for a price this deployment does not sell", () => {
    // An operator who changed `STRIPE_PRICE_YEARLY_ID` leaves subscriptions on
    // the old one, and the honest answer about those is "not one of ours"
    // rather than a guess. The plan tab shows the status without an interval.
    expect(intervalOfPrice("price_retired", prices)).toBeNull();
    expect(intervalOfPrice(null, prices)).toBeNull();
  });
});

/**
 * One subscription as Stripe sends it, shared by the two describes below rather
 * than copied into each. They read different fields off the same payload — what
 * a pending cancellation looks like, and what a scheduled price change looks
 * like — and a second copy would be the one that stops matching Stripe.
 */
const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const subscription = (over: Record<string, unknown>, periodEnd = "2026-10-25T04:47:46.000Z") =>
  ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    created: seconds("2026-09-25T04:47:46.000Z"),
    cancel_at_period_end: false,
    cancel_at: null,
    latest_invoice: "in_1",
    schedule: null,
    items: {
      data: [{ price: { id: "price_monthly" }, current_period_end: seconds(periodEnd) }],
    },
    ...over,
  }) as unknown as Parameters<typeof snapshotOfSubscription>[0];
const at = new Date("2026-09-26T00:00:00.000Z");

/**
 * How a subscription Stripe sends is stored, for the one field that has two
 * spellings. A dashboard's "cancel on a custom date" and `cancel_at:
 * "min_period_end"` both end a subscription with `cancel_at_period_end` still
 * false; read as that flag alone, the plan tab said "renews" and hid Keep my
 * plan for a subscription that was ending.
 */
describe("reading a pending cancellation off a subscription", () => {
  it("reads a cancellation dated inside the current period as pending, as Stripe does", () => {
    // Stripe moves the period's end onto the custom date, which is why the tab's
    // "ending" date needs nothing more than the flag.
    const custom = seconds("2026-10-05T04:47:46.000Z");
    expect(
      snapshotOfSubscription(subscription({ cancel_at: custom }, "2026-10-05T04:47:46.000Z"), at),
    ).toMatchObject({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date("2026-10-05T04:47:46.000Z"),
    });
    const periodEnd = seconds("2026-10-25T04:47:46.000Z");
    expect(
      snapshotOfSubscription(subscription({ cancel_at: periodEnd }), at).cancelAtPeriodEnd,
    ).toBe(true);
  });

  it("leaves a period that really does renew as renewing", () => {
    const nextYear = seconds("2027-06-01T00:00:00.000Z");
    expect(
      snapshotOfSubscription(subscription({ cancel_at: nextYear }), at).cancelAtPeriodEnd,
    ).toBe(false);
    expect(snapshotOfSubscription(subscription({}), at).cancelAtPeriodEnd).toBe(false);
    expect(
      snapshotOfSubscription(subscription({ cancel_at_period_end: true }), at).cancelAtPeriodEnd,
    ).toBe(true);
  });

  /**
   * The day itself, beside the flag rather than inferred back out of it. A
   * `cancel_at` past the period end reads as `cancelAtPeriodEnd: false` — which
   * is right, that period does renew — and read as the whole answer it made the
   * cancellation invisible: the interval buttons stayed live, a downgrade press
   * folded it into a schedule that replaced it, and an upgrade press billed a
   * year against a subscription set to stop.
   */
  it("carries the day a cancellation lands on, on either side of the period end", () => {
    expect(
      snapshotOfSubscription(subscription({ cancel_at: seconds("2027-06-01T00:00:00.000Z") }), at),
    ).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelAt: new Date("2027-06-01T00:00:00.000Z"),
    });
    expect(
      snapshotOfSubscription(
        subscription(
          { cancel_at: seconds("2026-10-05T04:47:46.000Z") },
          "2026-10-05T04:47:46.000Z",
        ),
        at,
      ),
    ).toMatchObject({
      cancelAtPeriodEnd: true,
      cancelAt: new Date("2026-10-05T04:47:46.000Z"),
    });
  });

  /**
   * Stripe's own Cancel at period end sets the flag and leaves `cancel_at`
   * empty until the period rolls, so the day is null while the flag is true.
   * That is why the flag cannot simply be dropped in favour of the date.
   */
  it("carries no day where Stripe has set none", () => {
    expect(snapshotOfSubscription(subscription({}), at).cancelAt).toBeNull();
    expect(snapshotOfSubscription(subscription({ cancel_at_period_end: true }), at)).toMatchObject({
      cancelAtPeriodEnd: true,
      cancelAt: null,
    });
  });

  it("carries the owed invoice and when Stripe made the subscription, in either shape", () => {
    expect(snapshotOfSubscription(subscription({}), at)).toMatchObject({
      latestInvoiceId: "in_1",
      createdAt: new Date("2026-09-25T04:47:46.000Z"),
    });
    expect(
      snapshotOfSubscription(subscription({ latest_invoice: { id: "in_expanded" } }), at)
        .latestInvoiceId,
    ).toBe("in_expanded");
    expect(
      snapshotOfSubscription(subscription({ latest_invoice: null }), at).latestInvoiceId,
    ).toBeNull();
  });
});

/**
 * The only code in the product that ever produces a non-null `scheduledPriceId`
 * or `scheduledAt`: `pendingPhase` and `phasePriceId`, reading the schedule
 * `fetchSubscriptionSnapshot` asked Stripe to expand.
 *
 * Wrong in either direction it is silent and it costs somebody their plan. Read
 * as null while a phase really is pending, the plan tab never says "Switching
 * to the monthly price on <date>", and `subscriptionAction` answers a press
 * with `none` — so the button that would release the schedule is disabled and
 * the switch lands unannounced. Read as pending when nothing is, the tab
 * announces a change nobody arranged and offers to cancel a schedule that does
 * not exist.
 *
 * Every expectation is a literal that differs from the subscription's own
 * current price, because an assertion a schedule-blind implementation could
 * satisfy by echoing `priceId` back would prove nothing at all.
 */
describe("reading a scheduled price change off a subscription", () => {
  /** An annual subscriber with a schedule on it: the downgrade shape. */
  const scheduled = (phases: unknown[], current = "price_yearly") =>
    subscription({
      items: {
        data: [{ price: { id: current }, current_period_end: seconds("2026-10-25T04:47:46.000Z") }],
      },
      schedule: { id: "sub_sched_1", phases },
    });
  /** The phase that has been running since before `at`: the year already paid for. */
  const paid = {
    start_date: seconds("2026-08-25T00:00:00.000Z"),
    items: [{ price: "price_yearly" }],
  };
  const renewal = seconds("2026-10-25T04:47:46.000Z");

  it("reads a future phase whose price Stripe sent as a bare id", () => {
    // The shape production actually receives. `expand: ["schedule"]` expands the
    // schedule, not the prices on its phases, so every phase item arrives as an
    // id string — which makes the string arm of `phasePriceId` the branch that
    // runs, and the tidy-up to `price?.id ?? null` the regression that writes
    // null on every sync while the whole suite stays green.
    expect(
      snapshotOfSubscription(
        scheduled([paid, { start_date: renewal, items: [{ price: "price_monthly" }] }]),
        at,
      ),
    ).toMatchObject({
      priceId: "price_yearly",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-10-25T04:47:46.000Z"),
    });
  });

  it("reads the same phase when the price came back expanded", () => {
    // The other arm, which an endpoint with `price` in its expand list sends.
    // Both have to work: half a deployment's reads would otherwise go quiet.
    expect(
      snapshotOfSubscription(
        scheduled([paid, { start_date: renewal, items: [{ price: { id: "price_monthly" } }] }]),
        at,
      ),
    ).toMatchObject({
      priceId: "price_yearly",
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-10-25T04:47:46.000Z"),
    });
  });

  it("has nothing scheduled once every phase has started", () => {
    // Stripe leaves the schedule attached after its phase lands, so the phases
    // are still there and `!phases` cannot be what answers this. The skip is.
    // Without it the subscription would go on advertising a switch to the price
    // it is already on, for as long as the schedule sits there.
    const landed = new Date("2026-12-15T00:00:00.000Z");
    expect(
      snapshotOfSubscription(
        scheduled(
          [paid, { start_date: renewal, items: [{ price: "price_monthly" }] }],
          "price_monthly",
        ),
        landed,
      ),
    ).toMatchObject({ priceId: "price_monthly", scheduledPriceId: null, scheduledAt: null });
  });

  it("treats a phase starting at this very instant as landed, not pending", () => {
    // `<=`, not `<`. The comparison is against `syncedAt`, which this same sync
    // stamped, so equality is reachable rather than theoretical — and announcing
    // a switch that is already in force is the one wrong answer at the boundary.
    expect(
      snapshotOfSubscription(
        scheduled(
          [{ start_date: Math.floor(at.getTime() / 1000), items: [{ price: "price_monthly" }] }],
          "price_monthly",
        ),
        at,
      ),
    ).toMatchObject({ scheduledPriceId: null, scheduledAt: null });
  });

  it("reads nothing off a schedule that came back as a bare id", () => {
    // Without the expand Stripe sends the schedule as its own id string, and
    // there are no phases to read. Null is the honest answer; throwing would
    // answer Stripe 500 on the webhook and stall the account for 72 hours.
    const bare = subscription({ schedule: "sub_sched_1" });
    expect(() => snapshotOfSubscription(bare, at)).not.toThrow();
    expect(snapshotOfSubscription(bare, at)).toMatchObject({
      scheduledPriceId: null,
      scheduledAt: null,
    });
    expect(snapshotOfSubscription(subscription({}), at)).toMatchObject({
      scheduledPriceId: null,
      scheduledAt: null,
    });
  });

  it("never dates a switch it cannot name a price for, and keeps looking", () => {
    // The two fields are one fact and have to travel together: a `scheduledAt`
    // with no `scheduledPriceId` renders as a date with a blank plan beside it.
    // A phase it cannot read is skipped rather than ending the search, so a
    // later one that names a price is still found.
    expect(
      snapshotOfSubscription(scheduled([paid, { start_date: renewal, items: [] }]), at),
    ).toMatchObject({ scheduledPriceId: null, scheduledAt: null });
    expect(
      snapshotOfSubscription(
        scheduled([
          paid,
          { start_date: renewal, items: [] },
          {
            start_date: seconds("2026-12-01T00:00:00.000Z"),
            items: [{ price: "price_monthly" }],
          },
        ]),
        at,
      ),
    ).toMatchObject({
      scheduledPriceId: "price_monthly",
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
    });
  });
});

/**
 * Where the period boundary is read from, which is the one field in a snapshot
 * that has a version-dependent home: Stripe moved `current_period_end` off the
 * subscription and onto its items, and an account still pinned to an older API
 * version sends the other shape.
 *
 * Both arms matter and neither is loud. Read only off the item, a deployment on
 * the older version stores `currentPeriodEnd: null` — which makes
 * `cancelAtPeriodEnd` unable to see a `cancel_at` inside the period, collapses
 * the subscription's end to the moment of the read in `src/server/services/
 * billing.ts`, and leaves the plan tab with no renewal date to show. Read only
 * off the subscription, every current deployment gets the same thing. The
 * fixtures below are the two shapes, plus the one that has both, because a fix
 * for either failure that simply swaps the arms passes the other two.
 */
describe("reading the period boundary off a subscription", () => {
  /** The older shape: a price on the item and the boundary one level up. */
  const legacy = (over: Record<string, unknown>) =>
    subscription({ items: { data: [{ price: { id: "price_monthly" } }] }, ...over });

  it("reads it off the item Stripe puts it on today", () => {
    expect(snapshotOfSubscription(subscription({}), at).currentPeriodEnd).toEqual(
      new Date("2026-10-25T04:47:46.000Z"),
    );
  });

  it("falls back to the subscription when an older API version put it there", () => {
    // `cancelAtPeriodEnd` is asserted beside the date because it is the damage
    // rather than the symptom: the flag is false whenever the boundary is null,
    // so a subscription Stripe has already dated to stop reads as renewing and
    // the tab offers Cancel at period end to somebody who has cancelled.
    expect(
      snapshotOfSubscription(
        legacy({
          current_period_end: seconds("2026-11-30T12:00:00.000Z"),
          cancel_at: seconds("2026-11-20T00:00:00.000Z"),
        }),
        at,
      ),
    ).toMatchObject({
      currentPeriodEnd: new Date("2026-11-30T12:00:00.000Z"),
      cancelAtPeriodEnd: true,
    });
  });

  it("prefers the item when a subscription carries both", () => {
    // Stripe sends both during the version's overlap, and the item is the
    // current spelling. Without this the honest-looking fix for the case above
    // — reading the subscription first — would pass everything else here.
    expect(
      snapshotOfSubscription(
        subscription({ current_period_end: seconds("2026-11-30T12:00:00.000Z") }),
        at,
      ).currentPeriodEnd,
    ).toEqual(new Date("2026-10-25T04:47:46.000Z"));
  });

  it("carries no boundary when neither shape has one", () => {
    // Null rather than a throw or an invented date: the webhook that is reading
    // this would answer Stripe 500 and stall the account for 72 hours.
    expect(snapshotOfSubscription(legacy({}), at).currentPeriodEnd).toBeNull();
  });
});
