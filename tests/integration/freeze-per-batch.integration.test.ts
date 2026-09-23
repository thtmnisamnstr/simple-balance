/**
 * Billing on, for this file only — see `account-limit.integration.test.ts` for
 * why this is at module scope and restored afterwards.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_freeze_per_batch",
  STRIPE_PUBLISHABLE_KEY: "pk_test_freeze_per_batch",
  STRIPE_WEBHOOK_SECRET: "whsec_freeze_per_batch",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { withTransaction } from "../../src/server/db/client.js";
import { getDb } from "../../src/server/db/client.js";
import { user } from "../../src/server/db/schema.js";
import { createAccount } from "../../src/server/services/accounts.js";
import { getEntitlement } from "../../src/server/services/billing.js";
import {
  commitStages,
  insertImportedStages,
  insertRecurringStages,
} from "../../src/server/services/staging.js";
import { scratchDatabase } from "./support/scratch-database.js";

// The real function, counted. Every service reaches it through this module, so
// wrapping it here counts every read the batch paths make and changes none.
vi.mock("../../src/server/services/billing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/services/billing.js")>();
  return { ...actual, getEntitlement: vi.fn(actual.getEntitlement) };
});

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("freeze_per_batch");
const owner: Actor = { userId: "freeze-per-batch", source: "web" };
let accountId = "";
let batchSeed = 0;

const draft = (index: number, batch: number) => ({
  type: "withdrawal",
  date: "2026-02-01",
  // Distinct per row and per batch, so no row is a duplicate of another and
  // every draft is valid: the count is about reads, not about refusals.
  payee: `Shop ${batch}-${index}`,
  description: null,
  fromAccountId: accountId,
  amount: `${index + 1}.${String(batch).padStart(2, "0")}`,
});

/** How many times the entitlement is read while `work` runs. */
const entitlementReads = async (work: () => Promise<unknown>) => {
  vi.mocked(getEntitlement).mockClear();
  await work();
  return vi.mocked(getEntitlement).mock.calls.length;
};

const stage = (rows: number) => {
  batchSeed += 1;
  const batch = batchSeed;
  return withTransaction(undefined, (tx) =>
    insertImportedStages(
      tx,
      owner,
      Array.from({ length: rows }, (_, index) => ({
        draft: draft(index, batch),
        rawData: {},
        importBatchId: null,
        initialIssues: [],
      })),
    ),
  );
};

/**
 * Which accounts are frozen is a tenant-wide answer, so a batch asks for it
 * once. Asked per row it was an entitlement check — two billing queries — and a
 * whole-table read for every line of a CSV import and twice for every row of a
 * commit, on exactly the deployments that sell a plan. The measure is that the
 * count does not grow with the batch: two rows and twelve read it equally often.
 */
integration("the freeze a batch is checked against", () => {
  beforeAll(async () => {
    await database.create();
    await getDb()
      .insert(user)
      .values({ id: owner.userId, name: "Batch", email: "batch@example.com", emailVerified: true });
    accountId = (
      await createAccount(owner, {
        name: "Checking",
        type: "checking",
        currency: "USD",
        openingDate: "2026-01-01",
        openingBalance: "0",
      })
    ).id;
  });

  afterAll(async () => {
    await database.drop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("is read once for an import, however many rows it stages", async () => {
    const small = await entitlementReads(() => stage(2));
    const large = await entitlementReads(() => stage(12));
    expect(large).toBe(small);
    expect(large).toBe(1);
  });

  it("is read once for a commit, however many rows it posts", async () => {
    const commit = async (rows: number) => {
      const staged = await stage(rows);
      return entitlementReads(() =>
        commitStages(owner, {
          stagedIds: staged.map((row) => row.id),
          expectedVersions: Object.fromEntries(staged.map((row) => [row.id, row.version])),
          idempotencyKey: randomUUID(),
        }),
      );
    };
    const small = await commit(2);
    const large = await commit(12);
    expect(large).toBe(small);
    expect(large).toBe(1);
  });

  it("is read once for a recurrence's proposals, however many are due", async () => {
    const propose = (rows: number) => {
      batchSeed += 1;
      const batch = batchSeed;
      const recurrenceId = randomUUID();
      return entitlementReads(() =>
        withTransaction(undefined, (tx) =>
          insertRecurringStages(
            tx,
            owner,
            Array.from({ length: rows }, (_, index) => ({
              draft: draft(index, batch),
              rawData: {},
              recurrenceId,
              occurrenceDate: `2026-03-${String(index + 1).padStart(2, "0")}`,
            })),
          ),
        ),
      );
    };
    const small = await propose(2);
    const large = await propose(12);
    expect(large).toBe(small);
    expect(large).toBe(1);
  });
});
