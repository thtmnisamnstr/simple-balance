import { describe, expect, it } from "vitest";
import { resolveEntitlement } from "../src/shared/domain.js";

/**
 * Who is shown an ad, decided as the server decides it.
 *
 * The rule is exercised here against `resolveEntitlement` directly rather than
 * through `getAdPlacement`, which needs a database: what is worth pinning is the
 * *shape* of the condition, because the two ways of writing it differ only on
 * the states that matter and agree everywhere else.
 *
 * Show an ad where a limited plan is in force:
 *     entitlement.billing && entitlement.plan === "free"
 * and NOT as the inverse of being on Plus:
 *     !(entitlement.billing && entitlement.plan === "plus")
 *
 * The two disagree exactly where `billing` is false, which is a deployment that
 * sells nothing — and, the case that matters, a deployment that has *stopped*
 * selling while its subscribers go on being charged at Stripe.
 */
const shown = (entitlement: ReturnType<typeof resolveEntitlement>) =>
  entitlement.billing && entitlement.plan === "free";

const inverted = (entitlement: ReturnType<typeof resolveEntitlement>) =>
  !(entitlement.billing && entitlement.plan === "plus");

const now = new Date("2026-09-14T12:00:00.000Z");
const active = [{ status: "active", pastDueSince: null }];

describe("who is shown an ad", () => {
  it("shows one to somebody on the free plan", () => {
    expect(shown(resolveEntitlement({ billingEnabled: true, subscriptions: [], now }))).toBe(true);
  });

  it("shows none to a subscriber", () => {
    expect(shown(resolveEntitlement({ billingEnabled: true, subscriptions: active, now }))).toBe(
      false,
    );
  });

  it("shows none to somebody an operator granted Plus by hand", () => {
    const entitlement = resolveEntitlement({
      billingEnabled: true,
      override: { plan: "plus", expiresAt: null },
      subscriptions: [],
      now,
    });
    expect(shown(entitlement)).toBe(false);
  });

  it("shows none on a deployment that sells nothing", () => {
    // `{ billing: false }` means unrestricted, not "not paying". Nobody there
    // is on a limited plan, so nobody there is shown an ad — which is also what
    // makes ads-without-billing a coherent configuration rather than a trap.
    expect(shown(resolveEntitlement({ billingEnabled: false, subscriptions: [], now }))).toBe(
      false,
    );
  });

  /**
   * The state the two spellings disagree on, and the reason the rule is written
   * the way it is.
   *
   * An operator winding down sets `SB_BILLING_ENABLED=false` and keeps the
   * Stripe settings, exactly as the runbook says. Their subscribers are still
   * being charged. `getEntitlement` short-circuits to `{ billing: false }`
   * there, so a still-paying subscriber and an account that never paid are
   * indistinguishable — and the inverted spelling shows an ad to both.
   */
  it("shows none to a paying subscriber on a deployment that stopped selling", () => {
    const winding = resolveEntitlement({ billingEnabled: false, subscriptions: active, now });
    expect(shown(winding), "the rule as written").toBe(false);
    expect(inverted(winding), "the inverted spelling, which is why it is not used").toBe(true);
  });

  it("is the only state the two spellings disagree on, among the ones that occur", () => {
    const states = [
      resolveEntitlement({ billingEnabled: true, subscriptions: [], now }),
      resolveEntitlement({ billingEnabled: true, subscriptions: active, now }),
      resolveEntitlement({ billingEnabled: false, subscriptions: [], now }),
      resolveEntitlement({ billingEnabled: false, subscriptions: active, now }),
      resolveEntitlement({
        billingEnabled: true,
        subscriptions: [{ status: "past_due", pastDueSince: now }],
        now,
      }),
    ];
    const disagreements = states.filter((s) => shown(s) !== inverted(s));
    // Both of the `billing: false` rows. Stated as a count so a third state
    // appearing here fails rather than passing quietly.
    expect(disagreements).toHaveLength(2);
    expect(disagreements.every((s) => !s.billing)).toBe(true);
  });
});
