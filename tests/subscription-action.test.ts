import { describe, expect, it } from "vitest";
import {
  type BillingInterval,
  liveSubscriptionStatuses,
  owesPaymentStatuses,
  paidForSubscriptionStatuses,
  periodIsPaid,
  planChangeTakesEffect,
  subscriptionAction,
} from "../src/shared/domain.js";

/**
 * What pressing a plan button means, for every state somebody can be in.
 *
 * This function had no test at all for a release, and three separate defects
 * lived in the branch it decides: an unpaid subscription handed back the wrong
 * interval's invoice, a second downgrade press sent Stripe a request it refuses,
 * and somebody on a retired price could be charged now for a switch that should
 * have waited. Each of those is one row below.
 *
 * The table is exhaustive on purpose rather than a sample. There are eight
 * Stripe statuses, two intervals plus "a price we no longer sell", and three
 * scheduled states, and the interesting cases are all in the corners.
 */
const on = (
  status: string,
  interval: BillingInterval | null,
  scheduled: BillingInterval | null = null,
) => ({ status, interval, scheduled });

/** The same, with a cancellation pending. */
const ending = (
  status: string,
  interval: BillingInterval | null,
  scheduled: BillingInterval | null = null,
) => ({ ...on(status, interval, scheduled), cancelAtPeriodEnd: true });

describe("what a request to change plan means", () => {
  it("makes a subscription for somebody who has none", () => {
    expect(subscriptionAction({ current: null, requested: "yearly" })).toEqual({ kind: "create" });
    expect(subscriptionAction({ current: null, requested: "monthly" })).toEqual({ kind: "create" });
  });

  it("hands back the open invoice when money is owed on the plan they are on", () => {
    for (const status of owesPaymentStatuses) {
      expect(
        subscriptionAction({ current: on(status, "yearly"), requested: "yearly" }),
        status,
      ).toEqual({ kind: "resume" });
      expect(
        subscriptionAction({ current: on(status, "monthly"), requested: "monthly" }),
        status,
      ).toEqual({ kind: "resume" });
    }
  });

  /**
   * The one that charged the wrong price.
   *
   * The invoice belongs to the subscription that exists, so handing its secret
   * back for a different interval means pressing "Monthly — $3" and being
   * charged $30. It has to be a replacement, never a resume.
   */
  it("never resumes somebody else's interval", () => {
    expect(
      subscriptionAction({ current: on("incomplete", "yearly"), requested: "monthly" }),
    ).toEqual({ kind: "replace" });
    expect(
      subscriptionAction({ current: on("incomplete", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "replace" });
  });

  it("does nothing when the answer is already true", () => {
    expect(subscriptionAction({ current: on("active", "yearly"), requested: "yearly" })).toEqual({
      kind: "none",
    });
    expect(
      subscriptionAction({ current: on("trialing", "monthly"), requested: "monthly" }),
    ).toEqual({ kind: "none" });
  });

  it("reads the plan they are on, while a switch is pending, as abandoning it", () => {
    expect(
      subscriptionAction({ current: on("active", "yearly", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "release" });
  });

  /**
   * The one that 500ed. Stripe gives a subscription exactly one schedule, so a
   * second `from_subscription` against one that already has one is refused —
   * not the no-op a second press means it as. Before this, the plan tab had no
   * working plan-change control at all once a downgrade was pending: the button
   * for the current plan was disabled and the other one failed.
   */
  it("does nothing when the change asked for is already scheduled", () => {
    expect(
      subscriptionAction({ current: on("active", "yearly", "monthly"), requested: "monthly" }),
    ).toEqual({ kind: "none" });
    expect(
      subscriptionAction({ current: on("active", "monthly", "yearly"), requested: "yearly" }),
    ).toEqual({ kind: "none" });
  });

  it("upgrades monthly to annual immediately", () => {
    expect(subscriptionAction({ current: on("active", "monthly"), requested: "yearly" })).toEqual({
      kind: "upgrade",
    });
  });

  it("moves annual to monthly at the renewal rather than now", () => {
    expect(subscriptionAction({ current: on("active", "yearly"), requested: "monthly" })).toEqual({
      kind: "schedule",
    });
  });

  /**
   * Prices are immutable at Stripe, so raising one means pointing the
   * deployment at a different id — and every existing subscriber is then on a
   * price this code cannot name. Charging them now, and moving the renewal date
   * they have been billed against, off a value that means "I do not recognize
   * this" is not a thing to do.
   */
  it("waits for the renewal for somebody on a price this deployment retired", () => {
    expect(subscriptionAction({ current: on("active", null), requested: "yearly" })).toEqual({
      kind: "schedule",
    });
    expect(subscriptionAction({ current: on("active", null), requested: "monthly" })).toEqual({
      kind: "schedule",
    });
  });

  /**
   * The states that reach `schedule` while a schedule is already attached.
   *
   * `none` only recognizes a repeat of a change it can name. A pending switch
   * for somebody on a retired price, and the monthly phase of a downgrade that
   * has already begun and then failed its renewal, both read as nothing
   * pending — so they come here, and the service has to let the existing
   * schedule go before making another, or Stripe refuses the second
   * `from_subscription` and the press is a 500.
   * `tests/integration/billing-stripe.integration.test.ts` holds the service to
   * releasing first; these rows hold which states depend on it.
   */
  it("schedules over a switch it cannot name, which the service releases first", () => {
    expect(
      subscriptionAction({ current: on("active", null, "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "schedule" });
    expect(
      subscriptionAction({ current: on("active", null, "yearly"), requested: "monthly" }),
    ).toEqual({ kind: "schedule" });
    expect(subscriptionAction({ current: on("past_due", "monthly"), requested: "yearly" })).toEqual(
      { kind: "schedule" },
    );
  });

  it("never upgrades on the spot from a status that owes money", () => {
    // `past_due` and `unpaid` reach the interval branches, unlike `incomplete`,
    // and neither may take the immediate-charge path: there is already an
    // unpaid invoice, and adding a proration charge on top of it bills somebody
    // twice for a card that is failing.
    for (const status of ["past_due", "unpaid"]) {
      expect(
        subscriptionAction({ current: on(status, "monthly"), requested: "yearly" }).kind,
        status,
      ).not.toBe("upgrade");
    }
  });

  it("decides something for every live status, in both directions", () => {
    // No status falls through to an undefined answer, which is the failure that
    // would show up as a 500 on a button press.
    for (const status of liveSubscriptionStatuses) {
      for (const requested of ["monthly", "yearly"] as const) {
        for (const interval of ["monthly", "yearly", null] as const) {
          for (const current of [on(status, interval), ending(status, interval)]) {
            const action = subscriptionAction({ current, requested });
            expect(action.kind, `${status}/${interval}/${requested}`).toBeTruthy();
          }
        }
      }
    }
  });
});

/**
 * A change of interval while a cancellation is pending.
 *
 * A move to monthly went through a schedule that carried the cancellation into
 * its phases and replaced it, so the plan renewed forever at the monthly price;
 * a move to annual kept the cancellation and charged the difference for a year
 * set to end. Neither was shown beforehand. Renewing again is Keep my plan's
 * to agree to, so both are refused until it is pressed.
 */
describe("changing plan while it is set to end", () => {
  it("refuses a change of interval either way", () => {
    expect(
      subscriptionAction({ current: ending("active", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "ending" });
    expect(
      subscriptionAction({ current: ending("active", "yearly"), requested: "monthly" }),
    ).toEqual({ kind: "ending" });
    expect(
      subscriptionAction({ current: ending("past_due", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "ending" });
    expect(subscriptionAction({ current: ending("active", null), requested: "yearly" })).toEqual({
      kind: "ending",
    });
  });

  it("still pays what is owed, repeats the plan they are on, and lets a switch go", () => {
    for (const status of owesPaymentStatuses) {
      expect(
        subscriptionAction({ current: ending(status, "monthly"), requested: "monthly" }),
        status,
      ).toEqual({ kind: "resume" });
    }
    expect(
      subscriptionAction({ current: ending("active", "monthly"), requested: "monthly" }),
    ).toEqual({ kind: "none" });
    expect(
      subscriptionAction({ current: ending("active", "yearly", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "release" });
    expect(
      subscriptionAction({ current: ending("active", "yearly", "monthly"), requested: "monthly" }),
    ).toEqual({ kind: "none" });
  });

  it("reads a caller that does not say as nothing pending", () => {
    expect(subscriptionAction({ current: on("active", "monthly"), requested: "yearly" })).toEqual({
      kind: "upgrade",
    });
    expect(
      subscriptionAction({
        current: { ...on("active", "yearly"), cancelAtPeriodEnd: false },
        requested: "monthly",
      }),
    ).toEqual({ kind: "schedule" });
  });
});

/**
 * When a plan button's change takes effect, for the sentence beside it.
 *
 * The plan tab wrote its own rule and told a past-due monthly subscriber that
 * annual "takes effect now and charges the difference"; the press scheduled it
 * for the renewal, which is what the shared rule answers there.
 */
describe("when a change of plan takes effect", () => {
  const timing = (
    current: Parameters<typeof subscriptionAction>[0]["current"],
    requested: BillingInterval,
  ) => planChangeTakesEffect(subscriptionAction({ current, requested }));

  it("is now only for an upgrade from a paid-up monthly, or a subscription that starts on payment", () => {
    expect(timing(on("active", "monthly"), "yearly")).toBe("now");
    expect(timing(null, "yearly")).toBe("now");
    expect(timing(on("incomplete", "monthly"), "yearly")).toBe("now");
  });

  it("is the renewal for a past-due monthly, a move to monthly, and a retired price", () => {
    expect(timing(on("past_due", "monthly"), "yearly")).toBe("renewal");
    expect(timing(on("unpaid", "monthly"), "yearly")).toBe("renewal");
    expect(timing(on("active", "yearly"), "monthly")).toBe("renewal");
    expect(timing(on("active", null), "yearly")).toBe("renewal");
  });

  it("is nothing where the press changes no interval, or is refused", () => {
    expect(timing(on("active", "monthly"), "monthly")).toBeNull();
    expect(timing(on("past_due", "monthly"), "monthly")).toBeNull();
    expect(timing(on("active", "yearly", "monthly"), "yearly")).toBeNull();
    expect(timing(on("active", "monthly", "yearly"), "yearly")).toBeNull();
    expect(timing(ending("active", "monthly"), "yearly")).toBeNull();
  });
});

/**
 * Which statuses mean the period somebody is in has been paid for. Stripe
 * dates every period from the moment it begins, so a first payment never
 * finished and a renewal that failed both carry a period end that the plan
 * tab called the renewal date.
 */
describe("whether the current period has been paid for", () => {
  it("is paid only while the plan is granted for it", () => {
    expect(periodIsPaid("active")).toBe(true);
    expect(periodIsPaid("trialing")).toBe(true);
    for (const status of ["incomplete", "past_due", "unpaid", "paused", "canceled"]) {
      expect(periodIsPaid(status), status).toBe(false);
    }
  });

  it("counts every live subscription paid for at least once, and not an unfinished first payment", () => {
    expect(paidForSubscriptionStatuses).not.toContain("incomplete");
    expect([...paidForSubscriptionStatuses, "incomplete"].sort()).toEqual(
      [...liveSubscriptionStatuses].sort(),
    );
  });
});
