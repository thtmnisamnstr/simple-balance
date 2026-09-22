/**
 * Billing on, for this file only — see `account-limit.integration.test.ts` for
 * why this is at module scope and restored afterwards.
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

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { MAX_FREE_ACCOUNTS } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingOverrides, user } from "../../src/server/db/schema.js";
import {
  createAccount,
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

const paidUntil = async (expiresAt: Date | null) => {
  await getDb().delete(billingOverrides).where(eq(billingOverrides.userId, actor.userId));
  if (expiresAt === null) return;
  await getDb().insert(billingOverrides).values({
    userId: actor.userId,
    plan: "plus",
    expiresAt,
    reason: "frozen-accounts fixture",
    operator: "test",
  });
};

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

  it("lets a frozen account into a place archiving one frees", async () => {
    // Archiving is not a swap: the account is closed at zero and coming back
    // needs a place of its own. What it does do is free the place it held.
    const fourth = await getAccount(actor, ids.Fourth!);
    await setAccountArchived(actor, ids.Fourth!, fourth.version, true);
    await setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Third!] });
    await expect(spend(ids.Third!, "4")).resolves.toMatchObject({ id: expect.any(String) });

    // And it cannot come back while all three places are in use.
    const archived = await getAccount(actor, ids.Fourth!);
    await expect(setAccountArchived(actor, ids.Fourth!, archived.version, false)).rejects.toThrow(
      /accounts active/i,
    );
  });

  it("unfreezes everything the moment the plan does, with nothing written", async () => {
    const before = await getDb().execute(
      `select active from ledger_account where user_id = '${actor.userId}' order by created_at`,
    );
    await paidUntil(new Date("2099-01-01"));
    const accounts = await listAccounts(actor);
    expect(accounts.some((account) => account.frozen)).toBe(false);
    await expect(spend(ids.Third!, "3")).resolves.toMatchObject({ id: expect.any(String) });
    const after = await getDb().execute(
      `select active from ledger_account where user_id = '${actor.userId}' order by created_at`,
    );
    // The column is the choice and the plan is the answer: upgrading changed
    // no row, which is what makes an override expiring at 3am correct too.
    expect(after.rows).toEqual(before.rows);
    await paidUntil(null);
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

    // And it is settled again straight away: three in use, none to spare.
    await expect(
      setActiveAccounts(actor, { accountIds: [ids.First!, ids.Second!, ids.Fifth!] }),
    ).rejects.toThrow(/stays active/i);
  });
});
