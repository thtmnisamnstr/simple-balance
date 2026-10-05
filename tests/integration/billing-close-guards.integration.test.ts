/**
 * The two places a live subscription is closed without Stripe telling us to:
 * a `customer.deleted` delivery, and somebody deleting their own account.
 *
 * Both end with the `billing_customer` mapping gone, which is what makes them
 * one subject. Once it is gone no later delivery can resolve the person —
 * `userForStripeCustomer` answers null and the delivery is acknowledged without
 * being acted on — so whatever `billing_subscription` says at that moment is
 * what `getEntitlement` goes on answering until the twelve-hourly sweep reaches
 * the row. A row left saying `active` there is a paid plan on a customer Stripe
 * no longer has, and nobody is being charged for it.
 *
 * Billing on and selling, for this file only. Set at module scope because
 * `getConfig` memoizes on first call, and restored in `afterAll` because
 * `vitest.config.ts` sets `fileParallelism: false` — every integration file
 * shares one process.
 */
const billingEnvironment = {
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_close_guards",
  STRIPE_PUBLISHABLE_KEY: "pk_test_close_guards",
  STRIPE_WEBHOOK_SECRET: "whsec_close_guards",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const originalEnvironment = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/shared/domain.js";
import { getDb } from "../../src/server/db/client.js";
import { billingCustomers, billingSubscriptions, user } from "../../src/server/db/schema.js";
import { scratchDatabase } from "./support/scratch-database.js";

const stripe = vi.hoisted(() => ({
  lastPriceCheck: vi.fn(),
  fetchPlanPrices: vi.fn(),
  deleteStripeCustomer: vi.fn(),
  customerIsDeleted: vi.fn(),
}));
vi.mock("../../src/server/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/stripe.js")>()),
  ...stripe,
}));

import {
  applyCustomerDeletion,
  closeBillingForDeletion,
  getEntitlement,
  reconcileSubscription,
} from "../../src/server/services/billing.js";
import { deleteOwnAccount } from "../../src/server/services/account-deletion.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("billing_close_guards");

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const seed = async (id: string): Promise<Actor> => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  return { userId: id, source: "web" };
};

const mapCustomer = async (userId: string, stripeCustomerId: string) => {
  await getDb().insert(billingCustomers).values({ userId, stripeCustomerId });
};

const subscribe = async (userId: string, syncedAt: Date) => {
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId,
      stripeSubscriptionId: `sub_${userId}`,
      status: "active",
      priceId: "price_monthly",
      currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z"),
      cancelAtPeriodEnd: false,
      scheduledPriceId: null,
      scheduledAt: null,
      pastDueSince: null,
      syncedAt,
    });
};

const stored = async (userId: string) => {
  const [row] = await getDb()
    .select()
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, userId));
  return row;
};

const mappings = async (userId: string) =>
  getDb().select().from(billingCustomers).where(eq(billingCustomers.userId, userId));

/** What Stripe would say about a subscription on a read stamped `syncedAt`. */
const snapshotOf = (userId: string, syncedAt: Date) => ({
  stripeSubscriptionId: `sub_${userId}`,
  status: "active" as const,
  priceId: "price_monthly",
  currentPeriodEnd: new Date("2027-06-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  cancelAt: null,
  scheduledPriceId: null,
  scheduledAt: null,
  syncedAt,
  stripeCustomerId: null,
});

/** Long enough ago that any stamp this file takes is newer. */
const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  for (const double of Object.values(stripe)) double.mockReset();
  stripe.lastPriceCheck.mockReturnValue({ problems: [], confirmedMode: "live" });
  stripe.fetchPlanPrices.mockResolvedValue({
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  });
  stripe.deleteStripeCustomer.mockResolvedValue(undefined);
});

integration("a customer Stripe no longer has", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  const deletion = (eventId: string) => ({ id: eventId, type: "customer.deleted" });

  it("stamps the close as read now, so a snapshot taken before it cannot revive the row", async () => {
    // The interleaving: a delivery reads the subscription from Stripe at T0, an
    // operator deletes the customer at T1 > T0, the `customer.deleted` delivery
    // lands and commits, and only then does the first delivery commit. Without
    // the stamp the close leaves `synced_at` at T-old, the T0 snapshot counts as
    // newer, and the person is stored as `active` on a customer that is gone —
    // with the mapping deleted, so no later delivery can correct it.
    const actor = await seed("close-stamp");
    await mapCustomer(actor.userId, "cus_close_stamp");
    const readFromStripeAt = new Date();
    await subscribe(actor.userId, LONG_AGO);

    expect(await applyCustomerDeletion("cus_close_stamp", deletion("evt_close_stamp"))).toBe(
      "written",
    );
    const closed = await stored(actor.userId);
    expect(closed!.status).toBe("canceled");
    expect(closed!.syncedAt.getTime()).toBeGreaterThan(readFromStripeAt.getTime());

    expect(
      await reconcileSubscription(actor.userId, snapshotOf(actor.userId, readFromStripeAt)),
    ).toBe("stale");
    expect((await stored(actor.userId))!.status).toBe("canceled");
    expect(await getEntitlement(actor)).toMatchObject({ plan: "free" });
  });

  it("still lets a snapshot read after the close win, which Stripe reports as canceled", async () => {
    // The guard drops what was read earlier, not everything. A delivery whose
    // read happened after the customer was deleted saw the truth, so it writes.
    const actor = await seed("close-later");
    await mapCustomer(actor.userId, "cus_close_later");
    await subscribe(actor.userId, LONG_AGO);

    await applyCustomerDeletion("cus_close_later", deletion("evt_close_later"));
    const afterTheClose = new Date(Date.now() + 60_000);

    expect(await reconcileSubscription(actor.userId, snapshotOf(actor.userId, afterTheClose))).toBe(
      "written",
    );
  });
});

integration("closing billing because the account is being deleted", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("marks the live subscription canceled rather than leaving it to the cascade", async () => {
    // The cascade in `deleteOwnAccount` runs a few statements later and takes
    // these rows with the user — if it runs. A statement timeout on a large
    // ledger, a deadlock on the `verification` delete or a dropped connection
    // leaves the person here: `billing_customer` gone, so no delivery resolves
    // them, and `billing_subscription` still saying `active`.
    const actor = await seed("deletion-close");
    await mapCustomer(actor.userId, "cus_deletion_close");
    await subscribe(actor.userId, LONG_AGO);

    await closeBillingForDeletion(actor);

    expect(await mappings(actor.userId)).toEqual([]);
    expect((await stored(actor.userId))!.status).toBe("canceled");
    expect(await getEntitlement(actor)).toMatchObject({ plan: "free" });
  });

  it("stamps that close too, so nothing in flight writes `active` back", async () => {
    const actor = await seed("deletion-stamp");
    await mapCustomer(actor.userId, "cus_deletion_stamp");
    const readFromStripeAt = new Date();
    await subscribe(actor.userId, LONG_AGO);

    await closeBillingForDeletion(actor);

    expect(
      await reconcileSubscription(actor.userId, snapshotOf(actor.userId, readFromStripeAt)),
    ).toBe("stale");
  });

  it("leaves the deletion receipt saying what they held when they asked", async () => {
    // `deleteOwnAccount` takes the summary before closing the billing, because
    // the close is now what makes `activeSubscription` false. Taken after, as
    // it was while the cascade did the closing, every receipt would say nobody
    // was subscribed — and this is the only record of it left, since their
    // audit history goes with them.
    const actor = await seed("deletion-receipt");
    await mapCustomer(actor.userId, "cus_deletion_receipt");
    await subscribe(actor.userId, LONG_AGO);

    const { removed } = await deleteOwnAccount(actor, {
      confirmEmail: `${actor.userId}@example.com`,
    });

    expect(removed.activeSubscription).toBe(true);
    expect(stripe.deleteStripeCustomer).toHaveBeenCalledWith("cus_deletion_receipt");
  });
});
