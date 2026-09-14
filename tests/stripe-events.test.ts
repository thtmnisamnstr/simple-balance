import { describe, expect, it } from "vitest";
import { intervalOfPrice } from "../src/shared/domain.js";
import { isNoteworthyEvent, subscriptionIdForEvent } from "../src/server/services/billing.js";

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
    // A one-off invoice is not a subscription change, and treating it as one
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
    // seven-day grace it starts get recorded at all. Noting it instead would
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
