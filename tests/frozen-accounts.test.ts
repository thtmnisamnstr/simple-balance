import { describe, expect, it } from "vitest";
import type { DbTransaction } from "../src/server/db/client.js";
import { assertAccountsWritable, setActiveAccounts } from "../src/server/services/accounts.js";
import {
  accountAllowance,
  accountsToMarkActive,
  activeAccountChange,
  activeChoicePending,
  type Entitlement,
  type FreezableAccount,
  freezeOnPlanEnd,
  frozenAccountIds,
  frozenAccountRefusal,
  MAX_FREE_ACCOUNTS,
  type Plan,
  resolveEntitlement,
  restoreAllowance,
} from "../src/shared/domain.js";

/**
 * Which accounts a limited plan leaves writable.
 *
 * The rule the browser grays a row with and the server refuses a write with,
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
    // in the browser than on the server, or the page grays out one row and the
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

  it("names the account, and says the same thing after it", () => {
    // The half of the sentence that changes, and the half that must not: the
    // browser had prefixed the name itself, so the two sides were one sentence
    // and a longer one instead of the same sentence.
    const named = frozenAccountRefusal(MAX_FREE_ACCOUNTS, "Checking");
    const general = frozenAccountRefusal(MAX_FREE_ACCOUNTS);
    expect(named.startsWith('"Checking" is frozen.')).toBe(true);
    expect(named).not.toContain("This account is frozen");
    expect(named.slice('"Checking" is frozen.'.length)).toBe(
      general.slice("This account is frozen.".length),
    );
  });

  it("falls back to the general sentence where no one account is meant", () => {
    // The Add button that is dead because *every* account is frozen. Naming
    // one of them there would be worse than naming none.
    expect(frozenAccountRefusal(MAX_FREE_ACCOUNTS, undefined)).toBe(
      frozenAccountRefusal(MAX_FREE_ACCOUNTS),
    );
  });

  it("is what the service throws, with the name it already had", () => {
    // `assertAccountsWritable` is handed the ids and the names together for
    // this: a transfer names two accounts and a bulk delete names none, so a
    // refusal that said "this account" left the person to guess which.
    const freeze = {
      frozen: new Map([
        ["acct_1", "Checking"],
        ["acct_2", "Savings"],
      ]),
      limit: MAX_FREE_ACCOUNTS,
    };
    expect(() => assertAccountsWritable(freeze, ["acct_3", "acct_2"])).toThrow(
      frozenAccountRefusal(MAX_FREE_ACCOUNTS, "Savings"),
    );
    expect(() => assertAccountsWritable(freeze, ["acct_3"])).not.toThrow();
    // Nothing frozen at all, which is every deployment that sells nothing.
    expect(() =>
      assertAccountsWritable({ frozen: new Map(), limit: null }, ["acct_1"]),
    ).not.toThrow();
  });
});

/**
 * What the plan tab says a cancellation will cost, before the press.
 *
 * The count is the server's because the rule is the shared one, and the ways
 * to get it wrong are all about the entitlement it is asked of: "live minus
 * three" ignores the choice somebody already made, "the free plan" ignores an
 * operator's grant that is still running once the plan has ended, and asking
 * at the wrong moment — or with every subscription dropped rather than the one
 * ending — answers a question nobody asked.
 */
describe("what ending the paid plan would freeze", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  const five = ["a", "b", "c", "d", "e"].map((id, index) =>
    account(id, { createdAt: day(index + 1) }),
  );
  const ending = (
    accounts: FreezableAccount[],
    override?: { plan: Plan; expiresAt: Date | null },
  ) => freezeOnPlanEnd({ billingEnabled: true, override, endsAt: now, accounts });

  it("counts what the shared rule freezes, not every account past the limit", () => {
    expect(ending(five)).toEqual({ accountsFrozenOnFree: 2, activeChoicePendingOnFree: true });
    // Three of five chosen before the upgrade: the same two freeze again, and
    // there is nothing left to choose.
    const chosen = five.map((entry) => ({ ...entry, active: ["a", "b", "c"].includes(entry.id) }));
    expect(ending(chosen)).toEqual({ accountsFrozenOnFree: 2, activeChoicePendingOnFree: false });
    // One of the three then archived: four live, and still two frozen, which
    // is where "live minus three" would have said one.
    const archived = chosen.map((entry) =>
      entry.id === "a" ? { ...entry, archivedAt: day(20) } : entry,
    );
    expect(ending(archived)).toEqual({ accountsFrozenOnFree: 2, activeChoicePendingOnFree: false });
  });

  it("has no answer where a grant would still be running by then", () => {
    // Null rather than zero: nothing would be frozen *because no limit would
    // be in force*, and the tab says nothing rather than promising it.
    expect(ending(five, { plan: "plus", expiresAt: new Date("2026-04-01T12:00:00Z") })).toEqual({
      accountsFrozenOnFree: null,
      activeChoicePendingOnFree: false,
    });
    expect(ending(five, { plan: "plus", expiresAt: null })).toEqual({
      accountsFrozenOnFree: null,
      activeChoicePendingOnFree: false,
    });
    expect(
      freezeOnPlanEnd({ billingEnabled: false, endsAt: now, accounts: five }),
      "a deployment that sells nothing",
    ).toEqual({ accountsFrozenOnFree: null, activeChoicePendingOnFree: false });
  });

  it("counts under a grant that has expired, or one that grants the free plan", () => {
    // The two that an "is there an override?" test gets wrong, and it got the
    // first of them wrong on the page: a grant that ended in January hid the
    // count from somebody canceling in March.
    expect(ending(five, { plan: "plus", expiresAt: new Date("2026-01-01T12:00:00Z") })).toEqual({
      accountsFrozenOnFree: 2,
      activeChoicePendingOnFree: true,
    });
    expect(ending(five, { plan: "free", expiresAt: null })).toEqual({
      accountsFrozenOnFree: 2,
      activeChoicePendingOnFree: true,
    });
  });

  it("judges a grant against the day the plan ends, not today", () => {
    // A grant running two more days beside a period running a month. Asked at
    // `now` it resolved to `plus` and the tab said nothing at all, so the two
    // accounts that really do freeze on April 1 were never mentioned.
    const periodEnd = new Date("2026-04-01T12:00:00Z");
    expect(
      freezeOnPlanEnd({
        billingEnabled: true,
        override: { plan: "plus", expiresAt: new Date("2026-03-03T12:00:00Z") },
        endsAt: periodEnd,
        accounts: five,
      }),
    ).toEqual({ accountsFrozenOnFree: 2, activeChoicePendingOnFree: true });
    // The same grant outliving the period is still the case with no answer:
    // the moment moved, not the rule.
    expect(
      freezeOnPlanEnd({
        billingEnabled: true,
        override: { plan: "plus", expiresAt: new Date("2026-05-01T12:00:00Z") },
        endsAt: periodEnd,
        accounts: five,
      }),
    ).toEqual({ accountsFrozenOnFree: null, activeChoicePendingOnFree: false });
  });

  it("keeps the subscriptions that are not the one ending", () => {
    // Canceling one of two. Dropping every row answered "what if this person
    // had none", and promised two frozen accounts to somebody whose trial
    // keeps the plan open.
    expect(
      freezeOnPlanEnd({
        billingEnabled: true,
        subscriptions: [{ status: "trialing", pastDueSince: null }],
        endsAt: now,
        accounts: five,
      }),
    ).toEqual({ accountsFrozenOnFree: null, activeChoicePendingOnFree: false });
    // A row that does not entitle keeps nothing open, so the count is the
    // ordinary one rather than a null.
    expect(
      freezeOnPlanEnd({
        billingEnabled: true,
        subscriptions: [{ status: "canceled", pastDueSince: null }],
        endsAt: now,
        accounts: five,
      }),
    ).toEqual({ accountsFrozenOnFree: 2, activeChoicePendingOnFree: true });
    // And the moment settles a remaining grace too: fifteen days from the
    // failure, which covers today and has run out by the period end.
    const stillInGrace = { status: "past_due", pastDueSince: now };
    expect(
      freezeOnPlanEnd({
        billingEnabled: true,
        subscriptions: [stillInGrace],
        endsAt: now,
        accounts: five,
      }),
    ).toEqual({ accountsFrozenOnFree: null, activeChoicePendingOnFree: false });
    expect(
      freezeOnPlanEnd({
        billingEnabled: true,
        subscriptions: [stillInGrace],
        endsAt: new Date("2026-04-01T12:00:00Z"),
        accounts: five,
      }),
    ).toEqual({ accountsFrozenOnFree: 2, activeChoicePendingOnFree: true });
  });

  it("freezes nothing where the live accounts already fit", () => {
    expect(ending(five.slice(0, 3))).toEqual({
      accountsFrozenOnFree: 0,
      activeChoicePendingOnFree: false,
    });
  });
});

describe("changing which accounts are active", () => {
  const change = (accounts: FreezableAccount[], wanted: string[]) =>
    activeAccountChange({ entitlement: free, accounts, wanted: new Set(wanted) });

  it("lets the first choice name any three, because nobody has chosen yet", () => {
    // What a downgrade leaves behind: every account still marked active,
    // because nothing writes the column on the way down. The ordering is
    // standing in for a choice, and standing in is not the same as chosen.
    expect(change(four, ["b", "c", "d"])).toEqual({ ok: true });
  });

  it("refuses more than the plan keeps", () => {
    const refusal = change(four, ["a", "b", "c", "d"]);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      // `reason` as a bare string and never a reference back to the union in
      // `domain.ts`, or the assertion inherits whatever that file now says.
      // It is the only thing `setActiveAccounts` branches on to choose which
      // of two sentences an agent is handed, and "nothing-frozen" tells it to
      // stop calling — which is the wrong move here, where the fix is to name
      // fewer accounts.
      expect(refusal.reason).toBe("over-limit");
      // Drawn from the input rather than from the limit: `toContain("3")` is
      // satisfied by the nothing-frozen message too, which also names 3, so it
      // could not tell the two branches apart.
      expect(refusal.message).toContain("this names 4");
    }
  });

  it("refuses giving up an account in use to make room for another", () => {
    // The whole rule. Having chosen a, b and c, swapping c for d would be
    // having all four a few seconds at a time.
    const chosen = four.map((entry) => ({ ...entry, active: entry.id !== "d" }));
    const refusal = change(chosen, ["a", "b", "d"]);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.reason).toBe("swap");
      expect(refusal.message.toLowerCase()).toContain("stays active");
    }
  });

  it("lets a frozen account into a place that has opened up", () => {
    // `c` was deleted, so only a and b are in use and there is one place left.
    const afterDeletion = [
      account("a", { createdAt: day(1) }),
      account("b", { createdAt: day(2) }),
      account("d", { createdAt: day(4), active: false }),
    ];
    // Three live accounts and a limit of three: nothing is frozen anymore,
    // so this is the case the rule lets through on its own.
    expect(frozenAccountIds(free, afterDeletion)).toEqual(new Set());

    const overSubscribed = [...afterDeletion, account("e", { createdAt: day(5), active: false })];
    expect(change(overSubscribed, ["a", "b", "d"])).toEqual({ ok: true });
  });

  it("lets a set be re-sent unchanged, so a retry is not a refusal", () => {
    const chosen = four.map((entry) => ({ ...entry, active: entry.id !== "d" }));
    expect(change(chosen, ["a", "b", "c"])).toEqual({ ok: true });
  });

  it("opens the choice again when a paid spell left accounts nobody chose about", () => {
    // Chose a, b and c of four. Subscribed, opened `e` while there was no
    // limit, then canceled. `e` is marked active because that is the column's
    // default, and the choice beside it was made about a ledger that did not
    // contain it — so reading the column as settled would freeze an account
    // nobody has ever been asked about, with no way back but archiving one of
    // the three.
    const secondDowngrade = [
      ...four.map((entry) => ({ ...entry, active: entry.id !== "d" })),
      account("e", { createdAt: day(5) }),
    ];
    // Four marked active against a limit of three: the column cannot be an
    // answer to the question being asked now.
    expect(activeChoicePending(MAX_FREE_ACCOUNTS, secondDowngrade)).toBe(true);
    expect(change(secondDowngrade, ["a", "b", "e"])).toEqual({ ok: true });
  });

  /**
   * The wire contract at `domain.ts`' `activeChoicePending`: `active` is
   * optional because a 0.1.x server sends no such field, and the column it
   * stands for defaults to true. One `!== false` is the whole of it.
   *
   * Written without the `account()` helper on purpose — supplying an explicit
   * `active: true` the way every other fixture here does is exactly what hides
   * the branch, and makes `!== false` and a plain truthy read the same
   * function under test.
   */
  it("reads an account with no `active` field as active, the way a 0.1.x server sends it", () => {
    const noField: readonly { readonly active?: boolean }[] = [{}, {}, {}, {}];
    // A truthy read counts these as not in use, which would answer false here
    // and close the one free choice a downgrade owes the person: they would be
    // left with whichever three the ordering picked and no way to say.
    expect(activeChoicePending(3, noField), "four unmarked against three places").toBe(true);
    // And not merely "a non-empty list is pending": at the limit it is settled.
    expect(activeChoicePending(3, noField.slice(0, 3))).toBe(false);
    // Mixed, because a partial answer is where an absent field really arrives.
    expect(activeChoicePending(3, [{}, {}, {}, { active: false }])).toBe(false);
    // Literal 3 rather than `MAX_FREE_ACCOUNTS`: the constant is not what is
    // under test, and a limit of null is the other half of the contract.
    expect(activeChoicePending(null, noField)).toBe(false);
  });

  it("does not reopen the choice when the paid spell opened nothing", () => {
    // Same round trip, no new account. The earlier choice is still an answer
    // to this question, so re-asking would be an invitation to swap.
    const unchangedByTheSpell = four.map((entry) => ({ ...entry, active: entry.id !== "d" }));
    expect(activeChoicePending(MAX_FREE_ACCOUNTS, unchangedByTheSpell)).toBe(false);
    expect(change(unchangedByTheSpell, ["a", "b", "d"]).ok).toBe(false);
  });

  it("reads a place freed by archiving as a place, not as a fresh choice", () => {
    // Below the limit rather than above it, which is the whole difference:
    // two in use and one place open takes a frozen account, and lets go of
    // neither of the two.
    const archivedOne = [
      account("a", { createdAt: day(1), archivedAt: day(9) }),
      account("b", { createdAt: day(2) }),
      account("c", { createdAt: day(3) }),
      account("d", { createdAt: day(4), active: false }),
      account("e", { createdAt: day(5), active: false }),
    ];
    const live = archivedOne.filter((entry) => entry.archivedAt === null);
    expect(activeChoicePending(MAX_FREE_ACCOUNTS, live)).toBe(false);
    expect(change(archivedOne, ["b", "c", "d"])).toEqual({ ok: true });
    expect(change(archivedOne, ["b", "d", "e"]).ok).toBe(false);
  });

  it("refuses to choose on a plan with no limit, where nothing can be frozen", () => {
    /*
     * This used to accept any set and write it, which the browser never offers
     * — the chooser is only drawn while something is frozen — so it was a
     * capability only an agent had. And a harmful one: marking two of six on
     * the paid plan left two marked active at the next downgrade, which is not
     * more than the limit, so the free first choice that downgrade owes the
     * person never came.
     */
    const onPaid = activeAccountChange({
      entitlement: paid,
      accounts: four,
      wanted: new Set(["a"]),
    });
    expect(onPaid.ok).toBe(false);
    if (!onPaid.ok) {
      expect(onPaid.reason).toBe("nothing-frozen");
      expect(onPaid.message.toLowerCase()).toContain("nothing is frozen");
    }
    expect(
      activeAccountChange({ entitlement: { billing: false }, accounts: four, wanted: new Set() })
        .ok,
    ).toBe(false);
  });

  it("refuses to choose while every account fits, where nothing can be frozen either", () => {
    // The other state the page draws no chooser in. Three live accounts and a
    // limit of three freeze nobody whatever the column says.
    const three = four.slice(0, 3);
    const refusal = change(three, ["a", "b"]);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.reason).toBe("nothing-frozen");
      expect(refusal.message).toContain(String(MAX_FREE_ACCOUNTS));
    }
  });

  it("lets the set already active through where there is nothing to choose, as a no-op", () => {
    // A retry of a call accepted a moment ago, or a page that sends what it
    // already shows. Refusing it would turn an idempotent write into an error
    // for having changed nothing.
    expect(
      activeAccountChange({
        entitlement: paid,
        accounts: four,
        wanted: new Set(["a", "b", "c", "d"]),
      }),
    ).toEqual({ ok: true });
    const chosenThenPaid = four.map((entry) => ({ ...entry, active: entry.id !== "d" }));
    expect(
      activeAccountChange({
        entitlement: paid,
        accounts: chosenThenPaid,
        wanted: new Set(["a", "b", "c"]),
      }),
    ).toEqual({ ok: true });
    expect(change(four.slice(0, 3), ["a", "b", "c"])).toEqual({ ok: true });
  });
});

/**
 * What the service writes, applied to the rows the way it applies it: on every
 * change to the live set, every live account is marked active while they all
 * fit on the free plan. Run here on the shared rule alone, so the sequence the
 * column went stale through is held without a database.
 */
function settle(accounts: FreezableAccount[]): FreezableAccount[] {
  const flip = new Set(accountsToMarkActive(accounts));
  return accounts.map((entry) => (flip.has(entry.id) ? { ...entry, active: true } : entry));
}

function choose(accounts: FreezableAccount[], wanted: string[]): FreezableAccount[] {
  expect(activeAccountChange({ entitlement: free, accounts, wanted: new Set(wanted) })).toEqual({
    ok: true,
  });
  return accounts.map((entry) =>
    entry.archivedAt === null ? { ...entry, active: wanted.includes(entry.id) } : entry,
  );
}

function archive(accounts: FreezableAccount[], id: string): FreezableAccount[] {
  return settle(
    accounts.map((entry) => (entry.id === id ? { ...entry, archivedAt: day(20) } : entry)),
  );
}

function open(accounts: FreezableAccount[], id: string, createdAt: string): FreezableAccount[] {
  return [...settle(accounts), account(id, { createdAt })];
}

describe("keeping `active` true to what is in use", () => {
  const five = ["a", "b", "c", "d", "e"].map((id, index) =>
    account(id, { createdAt: day(index + 1) }),
  );

  it("marks nothing while more accounts are live than the free plan keeps", () => {
    // A spell that opened nothing must leave the earlier choice standing, or
    // every round trip through the paid plan would invite a swap.
    const chosen = five.map((entry) => ({ ...entry, active: ["a", "b", "c"].includes(entry.id) }));
    expect(accountsToMarkActive(chosen)).toEqual([]);
  });

  it("marks every live account that says false once they all fit, and leaves archived ones", () => {
    const fitting = [
      account("a", { createdAt: day(1) }),
      account("b", { createdAt: day(2), archivedAt: day(9), active: false }),
      account("d", { createdAt: day(4), active: false }),
      account("e", { createdAt: day(5), active: false }),
    ];
    expect(accountsToMarkActive(fitting)).toEqual(["d", "e"]);
  });

  /*
   * The dead end, end to end. Choose three of five, archive two of the three,
   * and the other two are back in use while the column still said they were
   * not. A paid spell then opened one more and lapsed with two marked active
   * against a limit of three: the choice stayed closed, and the two accounts
   * in use for months were the ones frozen.
   */
  it("reopens the choice after a paid spell, when the archives happened on the free plan", () => {
    let ledger = choose(five, ["a", "b", "c"]);
    ledger = archive(ledger, "b");
    ledger = archive(ledger, "c");
    expect(frozenAccountIds(free, ledger), "three live, nothing frozen").toEqual(new Set());

    // Subscribed, opened `f`, and the plan lapsed.
    ledger = open(ledger, "f", day(6));
    const live = ledger.filter((entry) => entry.archivedAt === null);
    expect(activeChoicePending(MAX_FREE_ACCOUNTS, live)).toBe(true);
    // Any three, so neither account the person had been using is lost.
    expect(
      activeAccountChange({
        entitlement: free,
        accounts: ledger,
        wanted: new Set(["a", "d", "e"]),
      }),
    ).toEqual({ ok: true });
  });

  it("reopens it the same way when the archives happened during the paid spell", () => {
    // The case a rewrite keyed on the entitlement's limit missed: that limit
    // is null while subscribed, which is exactly when these archives ran.
    let ledger = choose(five, ["a", "b", "c"]);
    // Subscribed from here. Nothing is frozen, so archiving b and c is allowed.
    ledger = archive(ledger, "b");
    ledger = archive(ledger, "c");
    ledger = open(ledger, "f", day(6));
    const live = ledger.filter((entry) => entry.archivedAt === null);
    expect(activeChoicePending(MAX_FREE_ACCOUNTS, live)).toBe(true);
    expect(
      activeAccountChange({
        entitlement: free,
        accounts: ledger,
        wanted: new Set(["d", "e", "f"]),
      }),
    ).toEqual({ ok: true });
  });
});

describe("what a restore says when there is no place for it", () => {
  it("is the allowance's sentence, and one more", () => {
    const refusal = restoreAllowance(free, MAX_FREE_ACCOUNTS);
    const allowance = accountAllowance(free, MAX_FREE_ACCOUNTS);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok && !allowance.ok) {
      expect(refusal.message.startsWith(allowance.message)).toBe(true);
      expect(refusal.message).toContain("Bringing this one back needs one of those places.");
    }
  });

  it("lets it come back wherever there is a place, and wherever there is no limit", () => {
    expect(restoreAllowance(free, MAX_FREE_ACCOUNTS - 1)).toEqual({ ok: true });
    expect(restoreAllowance(paid, 50)).toEqual({ ok: true });
    expect(restoreAllowance({ billing: false }, 50)).toEqual({ ok: true });
  });
});

describe("the refusal on a deployment that sells nothing", () => {
  it("names no plan, because there is none to name", async () => {
    /*
     * With billing off there is no "free" plan, and an agent repeats what the
     * details say to the person; `whoami` answers null for the same state.
     * Nothing is sold in this process, so the entitlement answers without a
     * query, and the refusal comes before any write — which is why a stand-in
     * for the transaction that can only lock and read the accounts is enough.
     */
    const ids = [
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000b",
      "00000000-0000-4000-8000-00000000000c",
      "00000000-0000-4000-8000-00000000000d",
    ];
    const rows = ids.map((id, index) => ({
      ...account(id, { createdAt: day(index + 1) }),
      systemKind: null,
    }));
    const tx = {
      execute: async () => ({ rows: [] }),
      select: () => ({ from: () => ({ where: async () => rows }) }),
    } as unknown as DbTransaction;
    await expect(
      setActiveAccounts({ userId: "sells-nothing", source: "web" }, { accountIds: [ids[0]] }, tx),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/nothing is frozen/i),
      details: { plan: null, limit: null, current: 1 },
    });
  });
});
