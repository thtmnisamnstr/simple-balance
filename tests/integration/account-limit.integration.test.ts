/**
 * Billing on, for this file only.
 *
 * Set at module scope because `getConfig` memoizes on first call and every
 * predicate below is derived from it, and restored in `afterAll` because
 * `vitest.config.ts` sets `fileParallelism: false` — every integration file
 * shares one process, so a variable left behind here follows every file that
 * runs after it and quietly caps their accounts at three.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_account_limit",
  STRIPE_PUBLISHABLE_KEY: "pk_test_account_limit",
  STRIPE_WEBHOOK_SECRET: "whsec_account_limit",
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
import { MAX_FREE_ACCOUNTS } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingOverrides, ledgerAccounts, user } from "../../src/server/db/schema.js";
import {
  createAccount,
  getAccount,
  listAccounts,
  setAccountArchived,
} from "../../src/server/services/accounts.js";
import { createTransaction } from "../../src/server/services/transactions.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("account_limit");

const actor = (id: string): Actor => ({ userId: id, source: "web" });

const seedUser = async (id: string) => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
};

const makeAccount = (owner: Actor, name: string) =>
  createAccount(owner, {
    name,
    type: "checking",
    currency: "USD",
    openingDate: "2026-01-01",
    openingBalance: "0",
  });

/**
 * The cap is enforced in one place, inside the lock that was already there, so
 * the cases that matter are the ones a unit test cannot reach: what the
 * database actually counts, and what two requests racing for the last slot do.
 */
integration("the free plan's account limit", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("allows the first three and refuses the fourth", async () => {
    const owner = actor("limit-basic");
    await seedUser(owner.userId);
    for (let n = 0; n < MAX_FREE_ACCOUNTS; n += 1) {
      await expect(makeAccount(owner, `Account ${n}`)).resolves.toMatchObject({
        name: `Account ${n}`,
      });
    }
    await expect(makeAccount(owner, "One too many")).rejects.toMatchObject({
      code: "CONFLICT",
      details: { limit: MAX_FREE_ACCOUNTS, current: MAX_FREE_ACCOUNTS },
    });
  });

  it("does not count the counter-accounts the ledger makes for itself", async () => {
    // Writing a transaction creates income/expense counter-accounts. Charging
    // somebody a slot for a row they did not make and cannot see would make the
    // limit depend on how many currencies they hold.
    const owner = actor("limit-system");
    await seedUser(owner.userId);
    const account = await makeAccount(owner, "Checking");
    await createTransaction(
      owner,
      {
        type: "deposit",
        date: "2026-02-01",
        payee: "Work",
        description: null,
        toAccountId: account.id,
        amount: "100",
      },
      "limit-system-1",
    );

    const all = await getDb()
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.userId, owner.userId));
    const owned = await getDb()
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, owner.userId), isNull(ledgerAccounts.systemKind)));

    expect(all.length).toBeGreaterThan(owned.length);
    // Two more are still allowed, so the counter-accounts cost nothing.
    await expect(makeAccount(owner, "Savings")).resolves.toBeTruthy();
    await expect(makeAccount(owner, "Cash")).resolves.toBeTruthy();
    await expect(makeAccount(owner, "Fourth")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("frees the place an archived account held, and refuses to give it back twice", async () => {
    /*
     * This assertion used to read the other way, and the reversal is the
     * point. The limit counted every account ever opened, so archiving freed
     * nothing — the rule existed to stop a quota being cycled by archiving
     * and restoring. It now counts the accounts somebody is *using*, and the
     * cycle is closed at the other end instead: archiving frees the place,
     * and coming back out of the archive needs a free place of its own. So a
     * fourth account can be opened, and the third one cannot simply return.
     */
    const owner = actor("limit-archived");
    await seedUser(owner.userId);
    const first = await makeAccount(owner, "Archived one");
    await makeAccount(owner, "Second");
    await makeAccount(owner, "Third");
    await setAccountArchived(owner, first.id, first.version, true);

    await expect(makeAccount(owner, "Fourth")).resolves.toBeTruthy();

    const archived = await getAccount(owner, first.id);
    await expect(
      setAccountArchived(owner, first.id, archived.version, false),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // And the ledger is where it says it is: four accounts, three of them in use.
    await expect(makeAccount(owner, "Fifth")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets exactly one of two requests take the last slot", async () => {
    // The whole reason the count sits inside `lockAccountNamespace`: without it
    // both of these read three and both insert.
    const owner = actor("limit-race");
    await seedUser(owner.userId);
    await makeAccount(owner, "One");
    await makeAccount(owner, "Two");

    const results = await Promise.allSettled([
      makeAccount(owner, "Racer A"),
      makeAccount(owner, "Racer B"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [{ count }] = await getDb()
      .select({ count: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, owner.userId), isNull(ledgerAccounts.systemKind)))
      .then((rows) => [{ count: rows.length }]);
    expect(count).toBe(MAX_FREE_ACCOUNTS);
  });

  it("refuses inside a transaction the caller opened, which is how MCP arrives", async () => {
    // `runIdempotentMcpMutation` opens the transaction and hands it down, so the
    // check has to fire on the joined transaction rather than only on the one
    // `createAccount` opens for itself. If it did not, every cap would hold in
    // the browser and none of them over MCP.
    const owner = actor("limit-joined-tx");
    await seedUser(owner.userId);
    for (let n = 0; n < MAX_FREE_ACCOUNTS; n += 1) await makeAccount(owner, `Account ${n}`);

    await expect(
      getDb().transaction(async (tx) =>
        createAccount(
          owner,
          {
            name: "Through a caller's transaction",
            type: "checking",
            currency: "USD",
            openingDate: "2026-01-01",
            openingBalance: "0",
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { current: MAX_FREE_ACCOUNTS } });
  });

  it("lets an operator's override lift the limit", async () => {
    const owner = actor("limit-override");
    await seedUser(owner.userId);
    for (let n = 0; n < MAX_FREE_ACCOUNTS; n += 1) await makeAccount(owner, `Account ${n}`);
    await expect(makeAccount(owner, "Blocked")).rejects.toMatchObject({ code: "CONFLICT" });

    await getDb().insert(billingOverrides).values({
      userId: owner.userId,
      plan: "plus",
      expiresAt: null,
      reason: "integration test",
      operator: "tests",
    });

    await expect(makeAccount(owner, "Allowed")).resolves.toBeTruthy();
  });

  it("keeps every account somebody already had when the limit starts binding", async () => {
    // The grandfathering promise: an account over the limit is never taken
    // away, archived or hidden — only the next one is refused.
    const owner = actor("limit-grandfathered");
    await seedUser(owner.userId);
    await getDb().insert(billingOverrides).values({
      userId: owner.userId,
      plan: "plus",
      expiresAt: null,
      reason: "seeding beyond the limit",
      operator: "tests",
    });
    for (let n = 0; n < MAX_FREE_ACCOUNTS + 2; n += 1) await makeAccount(owner, `Account ${n}`);
    await getDb().delete(billingOverrides).where(eq(billingOverrides.userId, owner.userId));

    const owned = await getDb()
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.userId, owner.userId), isNull(ledgerAccounts.systemKind)));

    expect(owned).toHaveLength(MAX_FREE_ACCOUNTS + 2);
    /*
     * Still five accounts and still nothing taken away — but the figure the
     * refusal reports is now three rather than five, and the difference is
     * the rule rather than a rounding of it. The limit is on the accounts
     * somebody can *use*: five are kept, three are in use, and it is the
     * three that decide whether another may be opened.
     */
    await expect(makeAccount(owner, "One more")).rejects.toMatchObject({
      details: { current: MAX_FREE_ACCOUNTS },
    });
    const frozen = (await listAccounts(owner)).filter((account) => account.frozen);
    expect(frozen, "the two over the limit are frozen, not gone").toHaveLength(2);
  });
});
