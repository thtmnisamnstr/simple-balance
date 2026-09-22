import { describe, expect, it } from "vitest";
import {
  type Entitlement,
  type FreezableAccount,
  frozenAccountIds,
  frozenAccountRefusal,
  MAX_FREE_ACCOUNTS,
  resolveEntitlement,
} from "../src/shared/domain.js";

/**
 * Which accounts a limited plan leaves writable.
 *
 * The rule the browser greys a row with and the server refuses a write with,
 * so it is one function and these are the cases both are held to. The ones
 * worth reading are the entitlement cases rather than the ordering ones: a
 * deployment that sells nothing, and one that has stopped selling while its
 * subscribers are still being charged, must freeze nobody at all.
 */
const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

function account(id: string, extra: Partial<FreezableAccount> = {}): FreezableAccount {
  return { id, active: true, archivedAt: null, createdAt: day(1), ...extra };
}

/** Four accounts, a day apart, oldest first. */
const four = [
  account("a", { createdAt: day(1) }),
  account("b", { createdAt: day(2) }),
  account("c", { createdAt: day(3) }),
  account("d", { createdAt: day(4) }),
];

const free: Entitlement = {
  billing: true,
  plan: "free",
  accountLimit: MAX_FREE_ACCOUNTS,
  source: "free",
};
const paid: Entitlement = {
  billing: true,
  plan: "plus",
  accountLimit: null,
  source: "subscription",
};

describe("who is frozen, and who is not", () => {
  it("freezes nobody where the deployment sells nothing", () => {
    // Every self-hosted install and every deployment arriving from the release
    // before this one is on this path. It is the case a rule written as "not
    // on the paid plan" would get wrong, and it would get it wrong by locking
    // somebody out of their own books.
    expect(frozenAccountIds({ billing: false }, four)).toEqual(new Set());
  });

  it("freezes nobody on a plan with no limit", () => {
    expect(frozenAccountIds(paid, four)).toEqual(new Set());
  });

  it("freezes nobody who is inside the limit", () => {
    expect(frozenAccountIds(free, four.slice(0, 3))).toEqual(new Set());
  });

  it("keeps the oldest when nobody has chosen yet", () => {
    // Nobody is present when a subscription lapses, so every account is still
    // marked active. Rather than have a webhook guess and write, the ordering
    // decides until the person says otherwise.
    expect(frozenAccountIds(free, four)).toEqual(new Set(["d"]));
  });

  it("keeps what the person chose, not what is oldest", () => {
    const chosen = [
      account("a", { createdAt: day(1), active: false }),
      account("b", { createdAt: day(2) }),
      account("c", { createdAt: day(3) }),
      account("d", { createdAt: day(4) }),
    ];
    expect(frozenAccountIds(free, chosen)).toEqual(new Set(["a"]));
  });

  it("freezes the rest when somebody chooses fewer than the limit", () => {
    const one = four.map((entry) => ({ ...entry, active: entry.id === "b" }));
    expect(frozenAccountIds(free, one)).toEqual(new Set(["a", "c", "d"]));
  });

  it("stops freezing once the accounts fit again, whatever the old choice said", () => {
    /*
     * The dead end this closes. Choose three of four, then archive one of the
     * three: the fourth is still marked inactive, but there is nothing left to
     * enforce — and the browser panel that could clear the flag only appears
     * when something is frozen, so a stale choice would have left an account
     * unusable with no way on screen to get it back.
     */
    const chosen = [
      account("a", { createdAt: day(1) }),
      account("b", { createdAt: day(2) }),
      account("c", { createdAt: day(3) }),
      account("d", { createdAt: day(4), active: false }),
    ];
    expect(frozenAccountIds(free, chosen), "four live, one unchosen").toEqual(new Set(["d"]));

    const archived = chosen.map((entry) =>
      entry.id === "a" ? { ...entry, archivedAt: day(9) } : entry,
    );
    expect(frozenAccountIds(free, archived), "three live now, so nothing to enforce").toEqual(
      new Set(),
    );
  });

  it("leaves archived accounts out of it, and out of the slots they would cost", () => {
    // An archived account already refuses every write, so freezing one changes
    // nothing — and letting one hold a slot would mean somebody with three
    // archived accounts could not use the one they still have.
    const archived = [
      account("old-1", { createdAt: day(1), archivedAt: day(5) }),
      account("old-2", { createdAt: day(2), archivedAt: day(5) }),
      account("old-3", { createdAt: day(3), archivedAt: day(5) }),
      account("live", { createdAt: day(4) }),
    ];
    expect(frozenAccountIds(free, archived)).toEqual(new Set());
  });

  it("breaks a tie on the id, so two machines agree", () => {
    // Two accounts created in the same millisecond must not order differently
    // in the browser than on the server, or the page greys out one row and the
    // server refuses another.
    const same = ["d", "c", "b", "a"].map((id) => account(id, { createdAt: day(1) }));
    expect(frozenAccountIds(free, same)).toEqual(new Set(["d"]));
    expect(frozenAccountIds(free, [...same].reverse())).toEqual(new Set(["d"]));
  });
});

describe("the entitlement this rule is asked about", () => {
  it("freezes nobody on a deployment that has stopped selling", () => {
    // `SB_BILLING_ENABLED=false` with live subscriptions at Stripe. The ad
    // version of getting this wrong shows somebody an advertisement; this
    // version stops a paying customer writing to their own ledger.
    const stopped = resolveEntitlement({ billingEnabled: false, now: new Date() });
    expect(frozenAccountIds(stopped, four)).toEqual(new Set());
  });

  it("follows an override the moment it expires, with no code having run", () => {
    const now = new Date("2026-03-01T12:00:00Z");
    const granted = resolveEntitlement({
      billingEnabled: true,
      override: { plan: "plus", expiresAt: new Date("2026-03-01T13:00:00Z") },
      now,
    });
    expect(frozenAccountIds(granted, four)).toEqual(new Set());

    const lapsed = resolveEntitlement({
      billingEnabled: true,
      override: { plan: "plus", expiresAt: new Date("2026-03-01T11:00:00Z") },
      now,
    });
    // Same rows, same column values, one hour later. Nothing was written.
    expect(frozenAccountIds(lapsed, four)).toEqual(new Set(["d"]));
  });
});

describe("what a frozen account says", () => {
  it("names both ways out, including the one an agent can take", () => {
    const message = frozenAccountRefusal(MAX_FREE_ACCOUNTS);
    expect(message).toContain(String(MAX_FREE_ACCOUNTS));
    expect(message.toLowerCase()).toContain("frozen");
    // `accountAllowance` deliberately names upgrading and nothing else. This
    // one has to name the move that does not cost money, because an agent
    // meeting it cannot buy a plan.
    expect(message.toLowerCase()).toContain("active");
  });
});
