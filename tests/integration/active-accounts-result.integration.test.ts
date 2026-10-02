/**
 * What `setActiveAccounts` answers with when a caller supplies the transaction.
 *
 * It takes one, the way every composable mutation in `src/server/services`
 * does, and `withTransaction` hands a supplied one straight through — so the
 * write and the read that reports it are only on the same connection if the
 * read is told about it. Through the pool instead, at READ COMMITTED, the
 * answer describes the ledger as it was before the call, `frozen` and all; on
 * `DATABASE_POOL_SIZE=1` there is no second connection to describe it with, so
 * the call waits out `connectionTimeoutMillis` and fails rather than answering.
 *
 * Neither transport passes one today, which is why nothing failed: the hazard
 * is in the exported shape rather than in a route. `tests/service-transactions.ts`
 * cannot see it either — its check greps a service's own body for
 * `getDb().transaction`, and this escape was a bare `getDb()` one call down
 * inside `listAccounts`.
 *
 * Billing on, for this file only. Set at module scope because `getConfig`
 * memoizes on first call, and restored in `afterAll` because
 * `vitest.config.ts` sets `fileParallelism: false` — every integration file
 * shares one process, so a variable left behind here follows every file that
 * runs after it.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_active_result",
  STRIPE_PUBLISHABLE_KEY: "pk_test_active_result",
  STRIPE_WEBHOOK_SECRET: "whsec_active_result",
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
import { createAccount, setActiveAccounts } from "../../src/server/services/accounts.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("active_accounts_result");

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

/** More live accounts than the free plan keeps, so there is a choice to make. */
const overLimit = async (owner: Actor, names: readonly string[]) => {
  await getDb().insert(billingOverrides).values({
    userId: owner.userId,
    plan: "plus",
    expiresAt: null,
    reason: "seeding beyond the limit",
    operator: "tests",
  });
  const opened = [];
  for (const name of names) opened.push(await makeAccount(owner, name));
  await getDb().delete(billingOverrides).where(eq(billingOverrides.userId, owner.userId));
  return opened.map((account) => String(account.id));
};

integration("the list setActiveAccounts answers with", () => {
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

  it("describes the choice just made, on the caller's own transaction", async () => {
    const owner = actor("active-result-tx");
    await seedUser(owner.userId);
    const ids = await overLimit(owner, ["A", "B", "C", "D"]);
    const chosen = ids.slice(0, MAX_FREE_ACCOUNTS);

    // Held open across the call, which is what makes the read a question about
    // uncommitted state rather than about the pool.
    const answered = await getDb().transaction(async (tx) =>
      setActiveAccounts(owner, { accountIds: chosen }, tx),
    );

    expect(answered.map((account) => [String(account.id), account.active, account.frozen])).toEqual(
      ids.map((id) => [id, chosen.includes(id), !chosen.includes(id)]),
    );
  });

  it("answers the same thing when it opens the transaction itself", async () => {
    // The two shapes have to agree, or a caller's answer depends on how it
    // called rather than on what it asked for.
    const owner = actor("active-result-own");
    await seedUser(owner.userId);
    const ids = await overLimit(owner, ["A", "B", "C", "D"]);
    const chosen = ids.slice(0, MAX_FREE_ACCOUNTS);

    const answered = await setActiveAccounts(owner, { accountIds: chosen });

    expect(answered.map((account) => [String(account.id), account.active, account.frozen])).toEqual(
      ids.map((id) => [id, chosen.includes(id), !chosen.includes(id)]),
    );
  });
});
