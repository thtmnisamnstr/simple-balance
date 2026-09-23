/**
 * Billing on, for this file only — see `account-limit.integration.test.ts` for
 * why this is at module scope and restored afterward.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_frozen_accounts",
  STRIPE_PUBLISHABLE_KEY: "pk_test_frozen_accounts",
  STRIPE_WEBHOOK_SECRET: "whsec_frozen_accounts",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { activeChoicePending, MAX_FREE_ACCOUNTS } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { auditEvents, billingOverrides, ledgerAccounts, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  setAccountArchived,
  setActiveAccounts,
  updateAccount,
} from "../../src/server/services/accounts.js";
import { mergePayees } from "../../src/server/services/payees.js";
import { getSummary } from "../../src/server/services/summary.js";
import {
  createTransaction,
  setTransactionDeleted,
  updateTransaction,
} from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("frozen_accounts");
const actor: Actor = { userId: "frozen-user", source: "web" };

let keySeed = 0;
const nextKey = () => `frozen-${String((keySeed += 1)).padStart(6, "0")}`;

/** The four accounts, oldest first. The fourth is the one that freezes. */
const ids: Record<string, string> = {};

const paidUntilFor = async (owner: Actor, expiresAt: Date | null) => {
  await getDb().delete(billingOverrides).where(eq(billingOverrides.userId, owner.userId));
  if (expiresAt === null) return;
  await getDb().insert(billingOverrides).values({
    userId: owner.userId,
    plan: "plus",
    expiresAt,
    reason: "frozen-accounts fixture",
    operator: "test",
  });
};
const paidUntil = (expiresAt: Date | null) => paidUntilFor(actor, expiresAt);

/** The stored choice, read straight from the column rather than through a rule. */
const activeColumn = async (accountId: string) =>
  (
    await getDb()
      .select({ active: ledgerAccounts.active, version: ledgerAccounts.version })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, accountId))
  )[0];

const far = new Date("2099-01-01");

/** A ledger of its own, so the cases at the end do not walk the shared one. */
const freshOwner = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

const openFor = async (owner: Actor, name: string) =>
  (
    await createAccount(owner, {
      name,
      type: "checking",
      currency: "USD",
      openingDate: "2026-01-01",
      openingBalance: "0",
    })
  ).id;

const archivedFor = async (owner: Actor, id: string, archived: boolean) => {
  const account = await getAccount(owner, id);
  return setAccountArchived(owner, id, account.version, archived);
};

const frozenNames = async (owner: Actor) =>
  (await listAccounts(owner))
    .filter((account) => account.frozen)
    .map((account) => account.name)
    .sort();

/** The chooser's own question, asked of the live accounts the page would hold. */
const choiceOpen = async (owner: Actor) =>
  activeChoicePending(MAX_FREE_ACCOUNTS, await listAccounts(owner));

const spend = (accountId: string, amount: string, payee = "Corner shop") =>
  createTransaction(
    actor,
    {
      type: "withdrawal",
      date: "2026-02-01",
      payee,
      description: null,
      fromAccountId: accountId,
      amount,
    },
    nextKey(),
  );

/**
 * What a frozen account refuses, against a real database.
 *
 * The unit tests hold the rule; these hold the enforcement, and the cases that
 * earn a database are the ones where the account is not in the request at all:
 * an entry deleted by id, an edit that moves money *off* a frozen account, and
 * a payee merge that names no account anywhere.
 */
integration("a frozen account", () => {
  beforeAll(async () => {
    await database.create();
    await getDb().insert(user).values({
      id: actor.userId,
      name: "Frozen",
      email: "frozen@example.com",
      emailVerified: true,
    });
    // Four accounts needs the paid plan; the limit refuses a fourth otherwise.
    await paidUntil(new Date("2099-01-01"));
    for (const name of ["First", "Second", "Third", "Fourth"]) {
      ids[name] = (
        await createAccount(actor, {
          name,
          type: "checking",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "500",
        })
      ).id;
    }
    // And then the plan lapses, with nobody present and nothing written.
    await paidUntil(null);
  });

  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is the newest one, and only it, once the plan lapses", async () => {
    const accounts = await listAccounts(actor);
    expect(accounts.filter((account) => account.frozen).map((account) => account.name)).toEqual([
      "Fourth",
    ]);
    expect(accounts).toHaveLength(MAX_FREE_ACCOUNTS + 1);
  });

  it("still counts, everywhere money is counted", async () => {
    // The whole promise of freezing rather than hiding. Four accounts at 500.
    const summary = await getSummary(actor, { start: "2026-01-01", end: "2026-12-31" });
    const usd = summary.currencies.find((entry) => entry.currency === "USD");
    expect(usd?.accounts.map((account) => account.name).sort()).toEqual([
      "First",
      "Fourth",
      "Second",
      "Third",
    ]);
    expect(usd?.balance).toBe("2000");
  });

  it("refuses a new entry", async () => {
    await expect(spend(ids.Fourth!, "10")).rejects.toThrow(/frozen/i);
  });

  it("refuses a transfer that touches it, from either side", async () => {
    const transfer = (from: string, to: string) =>
      createTransaction(
        actor,
        {
          type: "transfer",
          date: "2026-02-01",
          payee: "Moving money",
          description: null,
          fromAccountId: from,
          toAccountId: to,
          sourceAmount: "5",
        },
        nextKey(),
      );
    await expect(transfer(ids.First!, ids.Fourth!)).rejects.toThrow(/frozen/i);
    await expect(transfer(ids.Fourth!, ids.First!)).rejects.toThrow(/frozen/i);
  });

  it("refuses every change to the account itself", async () => {
    const before = await getAccount(actor, ids.Fourth!);
    await expect(
      updateAccount(actor, ids.Fourth!, { name: "Renamed", expectedVersion: before.version }),
    ).rejects.toThrow(/frozen/i);
    await expect(setAccountArchived(actor, ids.Fourth!, before.version, true)).rejects.toThrow(
      /frozen/i,
    );
  });

  it("refuses an entry being deleted, which names no account at all", async () => {
    // Made while the account was still usable, then frozen underneath it. The
    // request carries an id and a version; the accounts come from the row.
    await paidUntil(new Date("2099-01-01"));
    const entry = await spend(ids.Fourth!, "25");
    await paidUntil(null);
    await expect(setTransactionDeleted(actor, entry.id, entry.version, true)).rejects.toThrow(
      /frozen/i,
    );
  });

  it("refuses an edit that moves an entry off it", async () => {
    await paidUntil(new Date("2099-01-01"));
    const entry = await spend(ids.Fourth!, "30");
    await paidUntil(null);
    await expect(
      updateTransaction(actor, entry.id, {
        draft: {
          type: "withdrawal",
          date: "2026-02-01",
          payee: "Corner shop",
          description: null,
          fromAccountId: ids.First!,
          amount: "30",
        },
        expectedVersion: entry.version,
      }),
    ).rejects.toThrow(/frozen/i);
  });

  it("refuses a payee merge that would rewrite one of its rows", async () => {
    // The merge names no account anywhere — it selects by payee across the
    // whole ledger — so this is the case a check on the request would miss.
    await paidUntil(new Date("2099-01-01"));
    await spend(ids.Fourth!, "12", "Village Stores");
    await paidUntil(null);
    // Both payees exist and neither names an account; the merge finds the row
    // on the frozen account by walking the ledger.
    await spend(ids.First!, "9", "Corner shop");
    await expect(
      mergePayees(actor, {
        targetPayee: "Corner shop",
        sourcePayees: ["Village Stores"],
        idempotencyKey: nextKey(),
      }),
    ).rejects.toThrow(/frozen/i);
  });

  it("takes the one choice, which may name any three", async () => {
    // Nobody has chosen yet: every account is still marked active, and the
    // ordering has only been standing in.
    await setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Fourth!] });
    const accounts = await listAccounts(actor);
    expect(accounts.filter((account) => account.frozen).map((account) => account.name)).toEqual([
      "Third",
    ]);
    // And the one that was frozen now takes an entry.
    await expect(spend(ids.Fourth!, "7")).resolves.toMatchObject({ id: expect.any(String) });
    await expect(spend(ids.Third!, "7")).rejects.toThrow(/frozen/i);
  });

  it("refuses a swap once the choice has been made", async () => {
    // The rule, against a real database: Third is frozen and Fourth is in
    // use, and trading one for the other would be having both.
    await expect(
      setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Third!] }),
    ).rejects.toThrow(/stays active/i);
    const accounts = await listAccounts(actor);
    expect(accounts.filter((account) => account.frozen).map((account) => account.name)).toEqual([
      "Third",
    ]);
  });

  it("accepts the same set again, so a retry is not a refusal", async () => {
    await expect(
      setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Fourth!] }),
    ).resolves.toBeDefined();
  });

  it("refuses a choice larger than the plan allows", async () => {
    await expect(
      setActiveAccounts(actor, {
        accountIds: [ids.First!, ids.Second!, ids.Third!, ids.Fourth!],
      }),
    ).rejects.toThrow(/keeps 3 accounts active/i);
  });

  it("unfreezes everything the moment the plan does, with nothing written", async () => {
    // Here, while the choice has left Third frozen, because an upgrade over a
    // ledger with nothing frozen would pass whether or not it unfroze anything.
    expect(await frozenNames(actor)).toEqual(["Third"]);
    const columns = () =>
      getDb().execute(
        `select active from ledger_account where user_id = '${actor.userId}' order by created_at`,
      );
    const accountAudit = async () =>
      (
        await getDb()
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(and(eq(auditEvents.userId, actor.userId), eq(auditEvents.entityType, "account")))
      ).length;
    const before = await columns();
    const auditedBefore = await accountAudit();
    await paidUntil(new Date("2099-01-01"));
    expect(await frozenNames(actor)).toEqual([]);
    await expect(spend(ids.Third!, "3")).resolves.toMatchObject({ id: expect.any(String) });
    // The column is the choice and the plan is the answer: upgrading changed
    // no row, which is what makes an override expiring at 3am correct too.
    expect((await columns()).rows).toEqual(before.rows);
    expect(await accountAudit()).toBe(auditedBefore);
    await paidUntil(null);
    // And the lapse brings the choice back into force as it stood.
    expect(await frozenNames(actor)).toEqual(["Third"]);
  });

  it("stops freezing once archiving leaves room for every account, and says so in the column", async () => {
    // Four live, three in use, Third frozen. Archiving Fourth leaves three live
    // against three places, so Third is in use again — and the column has to
    // say so, or a later paid spell that opens one more lapses with two marked
    // active and freezes Third, an account in use, without asking anybody.
    const thirdBefore = await activeColumn(ids.Third!);
    expect(thirdBefore?.active).toBe(false);
    const fourth = await getAccount(actor, ids.Fourth!);
    await setAccountArchived(actor, ids.Fourth!, fourth.version, true);

    const thirdAfter = await activeColumn(ids.Third!);
    expect(thirdAfter?.active).toBe(true);
    // Not an edit of the account, so a form open on it is not made stale.
    expect(thirdAfter?.version).toBe(thirdBefore?.version);
    const activations = await getDb()
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, ids.Third!), eq(auditEvents.operation, "activate")));
    expect(activations).toHaveLength(1);
    expect((await listAccounts(actor)).some((account) => account.frozen)).toBe(false);
    await expect(spend(ids.Third!, "4")).resolves.toMatchObject({ id: expect.any(String) });

    // With nothing frozen there is nothing to choose: a different set is
    // refused, and the set already active goes through as the no-op it is.
    await expect(
      setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/nothing is frozen/i),
      // An agent is told to stop, not to try a different list.
      agentMessage: expect.stringMatching(/only while one of them is frozen/),
    });
    await expect(
      setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Third!] }),
    ).resolves.toBeDefined();

    // And Fourth cannot come back while all three places are in use.
    const archived = await getAccount(actor, ids.Fourth!);
    await expect(setAccountArchived(actor, ids.Fourth!, archived.version, false)).rejects.toThrow(
      /Bringing this one back needs one of those places/,
    );
  });

  it("asks again after a paid spell that opened accounts nobody chose about", async () => {
    // The state this walks into: First, Second and Third in use, Fourth
    // archived, nothing frozen. Subscribe, open two more, and the plan lapses
    // again with five live accounts all marked active — the first choice.
    const open = async (name: string) =>
      (
        await createAccount(actor, {
          name,
          type: "checking",
          currency: "USD",
          openingDate: "2026-01-01",
          openingBalance: "0",
        })
      ).id;
    await paidUntil(new Date("2099-01-01"));
    ids["Fifth"] = await open("Fifth");
    ids["Sixth"] = await open("Sixth");
    await paidUntil(null);
    await setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Fifth!] });

    // Now the discriminating half. Subscribe once more, open a seventh, and
    // lapse. Third and Sixth are still marked inactive from the choice above,
    // so "every live account is marked active" is false — and reading that as
    // "already chosen" would freeze Seventh, an account nobody was ever asked
    // about, leaving no way to use it but archiving one of the three.
    await paidUntil(new Date("2099-01-01"));
    ids["Seventh"] = await open("Seventh");
    await paidUntil(null);
    const reopened = await listAccounts(actor);
    expect(
      reopened
        .filter((account) => account.frozen)
        .map((account) => account.name)
        .sort(),
    ).toEqual(["Seventh", "Sixth", "Third"]);

    // Four marked active against a limit of three: the question is open, so
    // this may name any three — including one that drops Fifth, which the
    // settled rule refuses.
    await setActiveAccounts(actor, {
      accountIds: [ids.First!, ids.Second!, ids.Seventh!],
    });
    await expect(spend(ids.Seventh!, "2")).resolves.toMatchObject({ id: expect.any(String) });
    await expect(spend(ids.Fifth!, "2")).rejects.toThrow(/frozen/i);

    // And it is settled again right away: three in use, none to spare.
    await expect(
      setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Fifth!] }),
    ).rejects.toThrow(/stays active/i);
  });

  it("lets a frozen account into a place archiving one frees", async () => {
    // Six live — First, Second and Seventh in use, the other three frozen.
    // Archiving Second leaves five live, still more than the plan keeps, so
    // nothing is rewritten and the choice stays settled: two in use and one
    // place free. Archiving is not a swap — the account is closed at zero and
    // coming back needs a place of its own — but the place it held is free.
    const second = await getAccount(actor, ids.Second!);
    await setAccountArchived(actor, ids.Second!, second.version, true);
    expect(
      (await listAccounts(actor))
        .filter((account) => account.frozen)
        .map((account) => account.name)
        .sort(),
    ).toEqual(["Fifth", "Sixth", "Third"]);

    await setActiveAccounts(actor, { accountIds: [ids.First!, ids.Seventh!, ids.Third!] });
    await expect(spend(ids.Third!, "6")).resolves.toMatchObject({ id: expect.any(String) });
    await expect(spend(ids.Fifth!, "6")).rejects.toThrow(/frozen/i);

    // And Second cannot come back while all three places are in use.
    const archived = await getAccount(actor, ids.Second!);
    await expect(setAccountArchived(actor, ids.Second!, archived.version, false)).rejects.toThrow(
      /Bringing this one back needs one of those places/,
    );
  });

  /**
   * `active` kept true to what is in use, on every path that changes the live set.
   *
   * The column went stale whenever everything fit: the rule stops reading it
   * there, and nothing wrote it. A later paid spell that opened an account then
   * lapsed with too few marked active to reopen the choice, and froze accounts
   * the person had been using while keeping the new one. Each case is its own
   * ledger, because each is a sequence and the sequence is the point.
   */
  describe("the active column", () => {
    it("is rewritten when a delete leaves room for every account", async () => {
      const owner = await freshOwner("active-after-delete");
      await paidUntilFor(owner, far);
      const [a, b, c, d] = [
        await openFor(owner, "A"),
        await openFor(owner, "B"),
        await openFor(owner, "C"),
        await openFor(owner, "D"),
      ];
      await paidUntilFor(owner, null);
      await setActiveAccounts(owner, { accountIds: [a, b, c] });
      expect(await frozenNames(owner)).toEqual(["D"]);

      const unused = await getAccount(owner, c);
      await deleteAccount(owner, c, unused.version);
      expect((await activeColumn(d))?.active).toBe(true);
      expect(await frozenNames(owner)).toEqual([]);
    });

    it("reopens the choice after a paid spell, when the archives happened on the free plan", async () => {
      const owner = await freshOwner("active-sequence-free");
      await paidUntilFor(owner, far);
      const [a, b, c, d, e] = [
        await openFor(owner, "A"),
        await openFor(owner, "B"),
        await openFor(owner, "C"),
        await openFor(owner, "D"),
        await openFor(owner, "E"),
      ];
      await paidUntilFor(owner, null);
      await setActiveAccounts(owner, { accountIds: [a, b, c] });
      await archivedFor(owner, b, true);
      await archivedFor(owner, c, true);
      // Three live: D and E are back in use, and the column says so.
      expect(await frozenNames(owner)).toEqual([]);
      expect((await activeColumn(d))?.active).toBe(true);
      expect((await activeColumn(e))?.active).toBe(true);

      await paidUntilFor(owner, far);
      await openFor(owner, "F");
      await paidUntilFor(owner, null);
      // Four marked active against three places: the choice is open again, and
      // until it is made the ordering keeps the three the person has been using.
      expect(await choiceOpen(owner)).toBe(true);
      expect(await frozenNames(owner)).toEqual(["F"]);
      await expect(setActiveAccounts(owner, { accountIds: [a, d, e] })).resolves.toBeDefined();
    });

    it("reopens it the same way when the archives happened during the paid spell", async () => {
      // The stretch a rewrite keyed on the entitlement's limit would miss: that
      // limit is null while subscribed, which is exactly when these archives run.
      const owner = await freshOwner("active-sequence-paid");
      await paidUntilFor(owner, far);
      const [a, b, c] = [
        await openFor(owner, "A"),
        await openFor(owner, "B"),
        await openFor(owner, "C"),
      ];
      const [d, e] = [await openFor(owner, "D"), await openFor(owner, "E")];
      await paidUntilFor(owner, null);
      await setActiveAccounts(owner, { accountIds: [a, b, c] });

      await paidUntilFor(owner, far);
      // Nothing is frozen while subscribed, so there is no choice to make — the
      // call that would have bound silently at the next downgrade is refused.
      await expect(setActiveAccounts(owner, { accountIds: [a] })).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(/nothing is frozen/i),
      });
      await archivedFor(owner, b, true);
      await archivedFor(owner, c, true);
      expect((await activeColumn(d))?.active).toBe(true);
      expect((await activeColumn(e))?.active).toBe(true);
      await openFor(owner, "F");
      await paidUntilFor(owner, null);

      expect(await choiceOpen(owner)).toBe(true);
      expect(await frozenNames(owner)).toEqual(["F"]);
    });

    /*
     * The two below start from a column already stale, which no path writes
     * anymore — it is what a database carries from before the rewrite existed —
     * so it is set directly. They hold the backstop behind the archive and
     * delete paths: the column is settled again before anything joins the live
     * set.
     */
    it("is settled before a restore adds to the live set", async () => {
      const owner = await freshOwner("active-before-restore");
      await paidUntilFor(owner, far);
      const [, b] = [
        await openFor(owner, "A"),
        await openFor(owner, "B"),
        await openFor(owner, "C"),
      ];
      const x = await openFor(owner, "X");
      await archivedFor(owner, x, true);
      await getDb().update(ledgerAccounts).set({ active: false }).where(eq(ledgerAccounts.id, b));

      await archivedFor(owner, x, false);
      expect((await activeColumn(b))?.active).toBe(true);
      await paidUntilFor(owner, null);
      // Four marked active: the choice is open, and B — in use all along — is
      // not the one frozen.
      expect(await choiceOpen(owner)).toBe(true);
      expect(await frozenNames(owner)).toEqual(["X"]);
    });

    it("is settled before a create adds to the live set", async () => {
      const owner = await freshOwner("active-before-create");
      await paidUntilFor(owner, far);
      const [, b] = [
        await openFor(owner, "A"),
        await openFor(owner, "B"),
        await openFor(owner, "C"),
      ];
      await getDb().update(ledgerAccounts).set({ active: false }).where(eq(ledgerAccounts.id, b));

      await openFor(owner, "D");
      expect((await activeColumn(b))?.active).toBe(true);
      await paidUntilFor(owner, null);
      expect(await choiceOpen(owner)).toBe(true);
      expect(await frozenNames(owner)).toEqual(["D"]);
    });

    it("restores an account marked inactive into the place it was allowed", async () => {
      /*
       * D was frozen by the choice and archived during a paid spell, so it went
       * into the archive still marked inactive. Back on the free plan, archiving
       * C frees a place with four live accounts, which is still more than the
       * plan keeps, so nothing is rewritten. The restore is allowed that place —
       * and without writing the row active it came straight back frozen, with
       * the place standing empty and the reply saying `frozen: false`.
       */
      const owner = await freshOwner("active-restore-inactive");
      await paidUntilFor(owner, far);
      const [a, b, c, d] = [
        await openFor(owner, "A"),
        await openFor(owner, "B"),
        await openFor(owner, "C"),
        await openFor(owner, "D"),
      ];
      await openFor(owner, "E");
      await openFor(owner, "F");
      await paidUntilFor(owner, null);
      await setActiveAccounts(owner, { accountIds: [a, b, c] });
      await paidUntilFor(owner, far);
      await archivedFor(owner, d, true);
      await paidUntilFor(owner, null);
      await archivedFor(owner, c, true);
      expect(await frozenNames(owner)).toEqual(["E", "F"]);

      const restored = await archivedFor(owner, d, false);
      expect(restored.frozen).toBe(false);
      expect(await frozenNames(owner)).toEqual(["E", "F"]);
      expect((await activeColumn(d))?.active).toBe(true);
      // And the place is taken: nothing else comes back.
      await expect(archivedFor(owner, c, false)).rejects.toThrow(
        /Bringing this one back needs one of those places/,
      );
      const live = await getDb()
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(
          and(
            eq(ledgerAccounts.userId, owner.userId),
            eq(ledgerAccounts.active, true),
            isNull(ledgerAccounts.archivedAt),
            isNull(ledgerAccounts.systemKind),
          ),
        );
      expect(live).toHaveLength(MAX_FREE_ACCOUNTS);
    });
  });
});
