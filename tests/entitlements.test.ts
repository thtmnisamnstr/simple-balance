import { describe, expect, it } from "vitest";
import { accountAllowance, MAX_FREE_ACCOUNTS, resolveEntitlement } from "../src/shared/domain.js";

const now = new Date("2026-06-15T12:00:00.000Z");

/**
 * The rule the browser previews and the server enforces, which is why it is one
 * function. The cases worth writing are the ones where getting it wrong either
 * charges somebody who should be free or gives the paid plan away.
 */
describe("what a plan allows", () => {
  it("limits nobody where nothing is sold", () => {
    // The default, and every deployment upgrading into this release.
    expect(resolveEntitlement({ billingEnabled: false, now })).toEqual({ billing: false });
  });

  it("puts somebody with no subscription on the free plan", () => {
    expect(resolveEntitlement({ billingEnabled: true, now })).toEqual({
      billing: true,
      plan: "free",
      accountLimit: MAX_FREE_ACCOUNTS,
      source: "free",
    });
  });

  it("honours an active subscription", () => {
    expect(
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "active", pastDueSince: null }],
        now,
      }),
    ).toMatchObject({ plan: "plus", accountLimit: null, source: "subscription" });
  });

  it("honours a trial an operator created, because nothing else could have made one", () => {
    expect(
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "trialing", pastDueSince: null }],
        now,
      }),
    ).toMatchObject({ plan: "plus" });
  });

  it("keeps a failed renewal for seven days from the failure, to the minute", () => {
    // Literal dates rather than arithmetic on BILLING_GRACE_DAYS: a test that
    // derives its boundary from the constant it is checking passes for any
    // value of that constant, and says nothing about whether the comparison is
    // inclusive. `now` is 2026-06-15T12:00:00Z.
    const failedAt = (iso: string) =>
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "past_due", pastDueSince: new Date(iso) }],
        now,
      });

    expect(failedAt("2026-06-15T11:59:00.000Z"), "just now").toMatchObject({ plan: "plus" });
    expect(failedAt("2026-06-08T12:00:01.000Z"), "a second inside").toMatchObject({ plan: "plus" });
    // Exactly seven days is over, not still running: the boundary is strict.
    expect(failedAt("2026-06-08T12:00:00.000Z"), "exactly seven days").toMatchObject({
      plan: "free",
    });
    expect(failedAt("2026-06-08T11:59:59.000Z"), "a second past").toMatchObject({ plan: "free" });
  });

  it("gives a past_due row with no recorded failure time no grace at all", () => {
    // The column is nullable and the writer owns it. An unbounded grace on a
    // missing timestamp would be the worst of the options.
    expect(
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "past_due", pastDueSince: null }],
        now,
      }),
    ).toMatchObject({ plan: "free" });
  });

  it("gives no grace to a subscription Stripe has given up on", () => {
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(
        resolveEntitlement({
          billingEnabled: true,
          subscriptions: [{ status, pastDueSince: new Date("2026-06-15T11:59:00.000Z") }],
          now,
        }),
        status,
      ).toMatchObject({ plan: "free" });
    }
  });

  it("treats a status it has never heard of as unpaid rather than guessing", () => {
    expect(
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "something_stripe_added_later", pastDueSince: null }],
        now,
      }),
    ).toMatchObject({ plan: "free" });
  });

  it("takes the live subscription when a cancelled one sits beside it, in either order", () => {
    // Somebody who cancelled and resubscribed has two rows, and Stripe
    // guarantees no ordering between the deliveries that wrote them.
    const active = { status: "active", pastDueSince: null } as const;
    const cancelled = { status: "canceled", pastDueSince: null } as const;

    for (const subscriptions of [
      [cancelled, active],
      [active, cancelled],
    ]) {
      expect(resolveEntitlement({ billingEnabled: true, subscriptions, now })).toMatchObject({
        plan: "plus",
      });
    }
  });

  it("lets an operator's grant outrank Stripe, in both directions", () => {
    const withOverride = (plan: "free" | "plus") =>
      resolveEntitlement({
        billingEnabled: true,
        override: { plan, expiresAt: null },
        subscriptions: [{ status: plan === "plus" ? "canceled" : "active", pastDueSince: null }],
        now,
      });

    expect(withOverride("plus")).toMatchObject({ plan: "plus", source: "override" });
    // A forced-free override changes what somebody may do and does not stop
    // Stripe charging them, which is why the operator documentation says so.
    expect(withOverride("free")).toMatchObject({ plan: "free", source: "override" });
  });

  it("falls back to Stripe once an override has expired, at the moment it expires", () => {
    const expiring = (expiresAt: Date) =>
      resolveEntitlement({
        billingEnabled: true,
        override: { plan: "plus", expiresAt },
        subscriptions: [{ status: "canceled", pastDueSince: null }],
        now,
      });

    expect(expiring(new Date("2026-06-15T12:00:01.000Z"))).toMatchObject({ source: "override" });
    // Exactly now is expired, not still running.
    expect(expiring(new Date("2026-06-15T12:00:00.000Z"))).toMatchObject({
      plan: "free",
      source: "subscription",
    });
  });
});

describe("whether another account may be made", () => {
  const free = resolveEntitlement({ billingEnabled: true, now });
  const plus = resolveEntitlement({
    billingEnabled: true,
    subscriptions: [{ status: "active", pastDueSince: null }],
    now,
  });

  it("allows everything where nothing is sold", () => {
    expect(accountAllowance({ billing: false }, 99)).toEqual({ ok: true });
  });

  it("allows everything on the paid plan", () => {
    expect(accountAllowance(plus, 500)).toEqual({ ok: true });
  });

  it("allows up to the limit and refuses at it", () => {
    for (let used = 0; used < MAX_FREE_ACCOUNTS; used += 1) {
      expect(accountAllowance(free, used), `${used} used`).toEqual({ ok: true });
    }
    expect(accountAllowance(free, MAX_FREE_ACCOUNTS).ok).toBe(false);
  });

  it("keeps refusing somebody already over the limit, and takes nothing away", () => {
    // Somebody who had five accounts before an operator turned billing on keeps
    // all five. Only the sixth is refused, and the sentence still says the
    // number rather than pretending they are at three.
    const refusal = accountAllowance(free, 5);

    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("expected a refusal");
    expect(refusal.current).toBe(5);
    expect(refusal.limit).toBe(MAX_FREE_ACCOUNTS);
    expect(refusal.message).toContain("Upgrade");
  });

  it("names a move that works, and not one that does not", () => {
    const refusal = accountAllowance(free, MAX_FREE_ACCOUNTS);
    if (refusal.ok) throw new Error("expected a refusal");
    // Archiving does not free a slot and deleting a used account is refused, so
    // suggesting either would be offering a move that fails.
    expect(refusal.message).not.toMatch(/archiv/i);
    expect(refusal.message).not.toMatch(/delete/i);
  });
});
