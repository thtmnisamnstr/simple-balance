import { describe, expect, it } from "vitest";
import {
  type BillingInterval,
  cancellationPending,
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

/** The same, with a cancellation pending at the end of the stored period. */
const ending = (
  status: string,
  interval: BillingInterval | null,
  scheduled: BillingInterval | null = null,
) => ({ ...on(status, interval, scheduled), cancelAtPeriodEnd: true });

/**
 * The other spelling: a day an operator set in Stripe's dashboard, past the
 * current period. That period really does renew, so `cancelAtPeriodEnd` is
 * false and the status line's "renews" is true — and the plan is still set to
 * stop, which is the half that was being missed.
 */
const endingLater = (
  status: string,
  interval: BillingInterval | null,
  scheduled: BillingInterval | null = null,
) => ({
  ...on(status, interval, scheduled),
  cancelAtPeriodEnd: false,
  cancelAt: new Date("2027-11-13T18:53:33.000Z"),
});

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

  /**
   * Every live status, in both directions, under all three spellings of where
   * a cancellation stands — written down rather than walked.
   *
   * This walked the same 108 rows asserting only that `action.kind` was
   * truthy, which every reachable input satisfies: each return is a non-empty
   * string literal in a union the compiler already closes, so the one
   * regression it could catch was a throw. Three behaviours sat behind it
   * pinned by nothing. `paused` had no assertion anywhere in the repository.
   * `trialing` had one row. And the order of the `incomplete` check against
   * the cancellation check — which `subscriptionAction`'s own comment calls
   * one of the four load-bearing ones — moves eight rows below when it swaps,
   * turning "finish paying for the plan you asked for" into "your plan is set
   * to end, press Keep my plan first", which is advice that leads nowhere: the
   * subscription set to end is the one that was never paid for.
   *
   * A committed literal and not a snapshot. The repository keeps no snapshots,
   * and a regenerated expectation is the defect this replaces one step along —
   * it agrees with whatever the code says today.
   *
   * The key carries the shape too. `${status}/${interval}/${requested}`, which
   * is what the old walk labelled its rows with, collides: the three shapes
   * give three different answers under one label, so a map keyed that way
   * keeps only the last and hides two thirds of the table.
   */
  const ANSWERS: Record<string, string> = {
    "on/active/monthly->monthly": "none",
    "ending/active/monthly->monthly": "none",
    "endingLater/active/monthly->monthly": "none",
    "on/active/yearly->monthly": "schedule",
    "ending/active/yearly->monthly": "ending",
    "endingLater/active/yearly->monthly": "ending",
    "on/active/null->monthly": "schedule",
    "ending/active/null->monthly": "ending",
    "endingLater/active/null->monthly": "ending",
    "on/active/monthly->yearly": "upgrade",
    "ending/active/monthly->yearly": "ending",
    "endingLater/active/monthly->yearly": "ending",
    "on/active/yearly->yearly": "none",
    "ending/active/yearly->yearly": "none",
    "endingLater/active/yearly->yearly": "none",
    "on/active/null->yearly": "schedule",
    "ending/active/null->yearly": "ending",
    "endingLater/active/null->yearly": "ending",

    "on/trialing/monthly->monthly": "none",
    "ending/trialing/monthly->monthly": "none",
    "endingLater/trialing/monthly->monthly": "none",
    "on/trialing/yearly->monthly": "schedule",
    "ending/trialing/yearly->monthly": "ending",
    "endingLater/trialing/yearly->monthly": "ending",
    "on/trialing/null->monthly": "schedule",
    "ending/trialing/null->monthly": "ending",
    "endingLater/trialing/null->monthly": "ending",
    "on/trialing/monthly->yearly": "upgrade",
    "ending/trialing/monthly->yearly": "ending",
    "endingLater/trialing/monthly->yearly": "ending",
    "on/trialing/yearly->yearly": "none",
    "ending/trialing/yearly->yearly": "none",
    "endingLater/trialing/yearly->yearly": "none",
    "on/trialing/null->yearly": "schedule",
    "ending/trialing/null->yearly": "ending",
    "endingLater/trialing/null->yearly": "ending",

    "on/past_due/monthly->monthly": "resume",
    "ending/past_due/monthly->monthly": "resume",
    "endingLater/past_due/monthly->monthly": "resume",
    "on/past_due/yearly->monthly": "schedule",
    "ending/past_due/yearly->monthly": "ending",
    "endingLater/past_due/yearly->monthly": "ending",
    "on/past_due/null->monthly": "schedule",
    "ending/past_due/null->monthly": "ending",
    "endingLater/past_due/null->monthly": "ending",
    "on/past_due/monthly->yearly": "schedule",
    "ending/past_due/monthly->yearly": "ending",
    "endingLater/past_due/monthly->yearly": "ending",
    "on/past_due/yearly->yearly": "resume",
    "ending/past_due/yearly->yearly": "resume",
    "endingLater/past_due/yearly->yearly": "resume",
    "on/past_due/null->yearly": "schedule",
    "ending/past_due/null->yearly": "ending",
    "endingLater/past_due/null->yearly": "ending",

    "on/incomplete/monthly->monthly": "resume",
    "ending/incomplete/monthly->monthly": "resume",
    "endingLater/incomplete/monthly->monthly": "resume",
    "on/incomplete/yearly->monthly": "replace",
    "ending/incomplete/yearly->monthly": "replace",
    "endingLater/incomplete/yearly->monthly": "replace",
    "on/incomplete/null->monthly": "replace",
    "ending/incomplete/null->monthly": "replace",
    "endingLater/incomplete/null->monthly": "replace",
    "on/incomplete/monthly->yearly": "replace",
    "ending/incomplete/monthly->yearly": "replace",
    "endingLater/incomplete/monthly->yearly": "replace",
    "on/incomplete/yearly->yearly": "resume",
    "ending/incomplete/yearly->yearly": "resume",
    "endingLater/incomplete/yearly->yearly": "resume",
    "on/incomplete/null->yearly": "replace",
    "ending/incomplete/null->yearly": "replace",
    "endingLater/incomplete/null->yearly": "replace",

    "on/unpaid/monthly->monthly": "resume",
    "ending/unpaid/monthly->monthly": "resume",
    "endingLater/unpaid/monthly->monthly": "resume",
    "on/unpaid/yearly->monthly": "schedule",
    "ending/unpaid/yearly->monthly": "ending",
    "endingLater/unpaid/yearly->monthly": "ending",
    "on/unpaid/null->monthly": "schedule",
    "ending/unpaid/null->monthly": "ending",
    "endingLater/unpaid/null->monthly": "ending",
    "on/unpaid/monthly->yearly": "schedule",
    "ending/unpaid/monthly->yearly": "ending",
    "endingLater/unpaid/monthly->yearly": "ending",
    "on/unpaid/yearly->yearly": "resume",
    "ending/unpaid/yearly->yearly": "resume",
    "endingLater/unpaid/yearly->yearly": "resume",
    "on/unpaid/null->yearly": "schedule",
    "ending/unpaid/null->yearly": "ending",
    "endingLater/unpaid/null->yearly": "ending",

    "on/paused/monthly->monthly": "none",
    "ending/paused/monthly->monthly": "none",
    "endingLater/paused/monthly->monthly": "none",
    "on/paused/yearly->monthly": "schedule",
    "ending/paused/yearly->monthly": "ending",
    "endingLater/paused/yearly->monthly": "ending",
    "on/paused/null->monthly": "schedule",
    "ending/paused/null->monthly": "ending",
    "endingLater/paused/null->monthly": "ending",
    "on/paused/monthly->yearly": "upgrade",
    "ending/paused/monthly->yearly": "ending",
    "endingLater/paused/monthly->yearly": "ending",
    "on/paused/yearly->yearly": "none",
    "ending/paused/yearly->yearly": "none",
    "endingLater/paused/yearly->yearly": "none",
    "on/paused/null->yearly": "schedule",
    "ending/paused/null->yearly": "ending",
    "endingLater/paused/null->yearly": "ending",
  };

  it("answers every live status, both directions and every cancellation, exactly this", () => {
    const answers: Record<string, string> = {};
    for (const status of liveSubscriptionStatuses) {
      for (const requested of ["monthly", "yearly"] as const) {
        for (const interval of ["monthly", "yearly", null] as const) {
          for (const [shape, current] of [
            ["on", on(status, interval)],
            ["ending", ending(status, interval)],
            ["endingLater", endingLater(status, interval)],
          ] as const) {
            answers[`${shape}/${status}/${interval}->${requested}`] = subscriptionAction({
              current,
              requested,
            }).kind;
          }
        }
      }
    }
    // Counted first, because a key template that collided would quietly fold
    // rows together and leave a shorter table agreeing with itself.
    expect(Object.keys(answers)).toHaveLength(108);
    expect(answers).toEqual(ANSWERS);
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

  /**
   * The day past the period end, which read off `cancelAtPeriodEnd` alone was
   * no cancellation at all. Both presses went through and both did what the
   * refusal exists to stop: the downgrade's schedule replaced the cancellation
   * so the plan renewed forever, and the upgrade charged the difference for a
   * year Stripe then capped at the cancellation day.
   */
  it("refuses a change of interval for a cancellation dated past the period end", () => {
    expect(
      subscriptionAction({ current: endingLater("active", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "ending" });
    expect(
      subscriptionAction({ current: endingLater("active", "yearly"), requested: "monthly" }),
    ).toEqual({ kind: "ending" });
    expect(
      subscriptionAction({ current: endingLater("past_due", "monthly"), requested: "yearly" }),
    ).toEqual({ kind: "ending" });
    expect(
      subscriptionAction({ current: endingLater("active", null), requested: "yearly" }),
    ).toEqual({ kind: "ending" });
  });

  it("still pays, repeats and releases under a further-out cancellation too", () => {
    expect(
      subscriptionAction({ current: endingLater("past_due", "monthly"), requested: "monthly" }),
    ).toEqual({ kind: "resume" });
    expect(
      subscriptionAction({ current: endingLater("active", "monthly"), requested: "monthly" }),
    ).toEqual({ kind: "none" });
    expect(
      subscriptionAction({
        current: endingLater("active", "yearly", "monthly"),
        requested: "yearly",
      }),
    ).toEqual({ kind: "release" });
  });

  /**
   * One predicate answers both spellings, so nothing downstream has to know
   * which one Stripe used. The browser is handed the ISO string it was sent
   * rather than a Date, and reads the same.
   */
  it("answers the same question of both spellings, and of a string date", () => {
    expect(cancellationPending({ cancelAtPeriodEnd: true })).toBe(true);
    expect(cancellationPending({ cancelAt: new Date("2027-11-13T00:00:00.000Z") })).toBe(true);
    expect(cancellationPending({ cancelAt: "2027-11-13T00:00:00.000Z" })).toBe(true);
    expect(cancellationPending({ cancelAtPeriodEnd: false, cancelAt: null })).toBe(false);
    expect(cancellationPending({})).toBe(false);
    expect(
      subscriptionAction({
        current: { ...on("active", "monthly"), cancelAt: "2027-11-13T00:00:00.000Z" },
        requested: "yearly",
      }),
    ).toEqual({ kind: "ending" });
  });

  it("reads a caller that does not say as nothing pending", () => {
    expect(subscriptionAction({ current: on("active", "monthly"), requested: "yearly" })).toEqual({
      kind: "upgrade",
    });
    expect(
      subscriptionAction({
        current: { ...on("active", "yearly"), cancelAtPeriodEnd: false, cancelAt: null },
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
    expect(timing(endingLater("active", "monthly"), "yearly")).toBeNull();
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

  /**
   * Held against the literal, the way `tests/migrations.test.ts` holds the
   * frozen list to what is on disk. The identity below cannot do it: the
   * paid-for set is `liveSubscriptionStatuses` filtered, so a member dropped
   * from the live set leaves both sides of that comparison at once and it goes
   * on passing. `paused` and `trialing` were pinned by nothing at all, and each
   * is a row `currentSubscription` has to keep finding — a live row the service
   * stops seeing is one `setSubscription` makes a second subscription beside,
   * and the person is charged twice.
   *
   * The order is the declaration's rather than sorted, because the list is read
   * as well as used: a member appended instead of inserted still has to be
   * noticed here.
   */
  it("is the six statuses the product acts on, and no fewer", () => {
    expect([...liveSubscriptionStatuses]).toEqual([
      "active",
      "trialing",
      "past_due",
      "incomplete",
      "unpaid",
      "paused",
    ]);
  });

  it("counts every live subscription paid for at least once, and not an unfinished first payment", () => {
    expect(paidForSubscriptionStatuses).not.toContain("incomplete");
    expect([...paidForSubscriptionStatuses, "incomplete"].sort()).toEqual(
      [...liveSubscriptionStatuses].sort(),
    );
  });
});
