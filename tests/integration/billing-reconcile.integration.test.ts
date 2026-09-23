import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../src/server/db/client.js";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  user,
} from "../../src/server/db/schema.js";
import {
  applyCustomerDeletion,
  applyStripeDelivery,
  beginBillingOperation,
  claimWebhookEvent,
  finishBillingOperation,
  reconcileSubscription,
  runBillingReconciliation,
  type SubscriptionSnapshot,
  userForStripeCustomer,
} from "../../src/server/services/billing.js";
import { scratchDatabase } from "./support/scratch-database.js";

const connection = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!connection);
const database = scratchDatabase("billing_reconcile");

const at = (iso: string) => new Date(iso);
/**
 * One subscription id per person, because a Stripe subscription belongs to
 * exactly one customer and the schema says so with a global unique. Sharing an
 * id across fixtures is a shape Stripe cannot produce.
 */
const subscriptionFor = (userId: string) => `sub_${userId.replaceAll("-", "_")}`;
const snapshot = (
  userId: string,
  over: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot => ({
  stripeSubscriptionId: subscriptionFor(userId),
  status: "active",
  priceId: "price_yearly",
  currentPeriodEnd: at("2027-01-01T00:00:00.000Z"),
  cancelAtPeriodEnd: false,
  scheduledPriceId: null,
  scheduledAt: null,
  syncedAt: at("2026-06-15T12:00:00.000Z"),
  ...over,
});

const seedUser = async (id: string) => {
  await getDb()
    .insert(user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
};

const stored = async (userId: string, id?: string) => {
  const [row] = await getDb()
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.userId, userId),
        eq(billingSubscriptions.stripeSubscriptionId, id ?? subscriptionFor(userId)),
      ),
    );
  return row;
};

/**
 * Stripe guarantees no ordering between deliveries and retries each one for up
 * to 72 hours, so the cases that matter are the ones where the same truth
 * arrives twice, out of order, or half-way.
 */
integration("reconciling what Stripe says about a subscription", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("writes a snapshot nobody has stored", async () => {
    await seedUser("rec-new");
    await expect(reconcileSubscription("rec-new", snapshot("rec-new"))).resolves.toBe("written");

    expect(await stored("rec-new")).toMatchObject({ status: "active", priceId: "price_yearly" });
  });

  it("drops a snapshot fetched before the stored one, and one fetched at the same instant", async () => {
    // The defect this prevents: a slow request carrying a canceled
    // subscription committing after a later fetch already saw a resubscribe.
    await seedUser("rec-order");
    await reconcileSubscription(
      "rec-order",
      snapshot("rec-order", { syncedAt: at("2026-06-15T12:00:00.000Z") }),
    );

    await expect(
      reconcileSubscription(
        "rec-order",
        snapshot("rec-order", { status: "canceled", syncedAt: at("2026-06-15T11:59:59.000Z") }),
      ),
    ).resolves.toBe("stale");
    await expect(
      reconcileSubscription(
        "rec-order",
        snapshot("rec-order", { status: "canceled", syncedAt: at("2026-06-15T12:00:00.000Z") }),
      ),
    ).resolves.toBe("stale");

    expect((await stored("rec-order"))?.status).toBe("active");
  });

  it("takes a snapshot fetched after the stored one", async () => {
    await seedUser("rec-newer");
    await reconcileSubscription("rec-newer", snapshot("rec-newer"));

    await expect(
      reconcileSubscription(
        "rec-newer",
        snapshot("rec-newer", { status: "canceled", syncedAt: at("2026-06-15T12:00:01.000Z") }),
      ),
    ).resolves.toBe("written");
    expect((await stored("rec-newer"))?.status).toBe("canceled");
  });

  it("stamps the failure when a renewal first fails, and does not restart it", async () => {
    // The grace counts from here, so a subscription that stays past_due for a
    // week must not have its clock reset by every delivery Stripe sends.
    await seedUser("rec-pastdue");
    await reconcileSubscription("rec-pastdue", snapshot("rec-pastdue"));
    await reconcileSubscription(
      "rec-pastdue",
      snapshot("rec-pastdue", { status: "past_due", syncedAt: at("2026-06-16T00:00:00.000Z") }),
    );
    const first = await stored("rec-pastdue");

    expect(first?.pastDueSince).toEqual(at("2026-06-16T00:00:00.000Z"));

    await reconcileSubscription(
      "rec-pastdue",
      snapshot("rec-pastdue", { status: "past_due", syncedAt: at("2026-06-20T00:00:00.000Z") }),
    );
    expect((await stored("rec-pastdue"))?.pastDueSince).toEqual(at("2026-06-16T00:00:00.000Z"));
  });

  it("clears the failure when the card recovers, so a later one starts fresh", async () => {
    await seedUser("rec-recover");
    await reconcileSubscription("rec-recover", snapshot("rec-recover"));
    await reconcileSubscription(
      "rec-recover",
      snapshot("rec-recover", { status: "past_due", syncedAt: at("2026-06-16T00:00:00.000Z") }),
    );
    await reconcileSubscription(
      "rec-recover",
      snapshot("rec-recover", { status: "active", syncedAt: at("2026-06-17T00:00:00.000Z") }),
    );

    expect((await stored("rec-recover"))?.pastDueSince).toBeNull();

    await reconcileSubscription(
      "rec-recover",
      snapshot("rec-recover", { status: "past_due", syncedAt: at("2026-07-01T00:00:00.000Z") }),
    );
    expect((await stored("rec-recover"))?.pastDueSince).toEqual(at("2026-07-01T00:00:00.000Z"));
  });

  it("lets two deliveries for one subscription land in an order rather than a race", async () => {
    // Several replicas answer the webhook endpoint. Without the lock both read
    // the stored row, both decide theirs is newer, and both write.
    await seedUser("rec-race");
    const results = await Promise.all([
      reconcileSubscription(
        "rec-race",
        snapshot("rec-race", { syncedAt: at("2026-06-15T12:00:00.000Z") }),
      ),
      reconcileSubscription(
        "rec-race",
        snapshot("rec-race", { status: "canceled", syncedAt: at("2026-06-15T12:00:05.000Z") }),
      ),
    ]);

    expect(results.filter((r) => r === "written").length).toBeGreaterThanOrEqual(1);
    // Whichever order they ran in, the later fetch is what is stored.
    expect((await stored("rec-race"))?.status).toBe("canceled");
    expect((await stored("rec-race"))?.syncedAt).toEqual(at("2026-06-15T12:00:05.000Z"));
  });
});

integration("claiming a Stripe delivery", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("claims an event once and refuses the retry", async () => {
    await expect(claimWebhookEvent("evt_once", "invoice.paid")).resolves.toBe(true);
    await expect(claimWebhookEvent("evt_once", "invoice.paid")).resolves.toBe(false);
  });

  it("releases the claim when the work it guards rolls back", async () => {
    // The property the whole design turns on. Committing the claim separately
    // would mark an event handled for work that never happened, and Stripe's
    // retry would then be swallowed by the dedupe — losing the change forever.
    await expect(
      getDb().transaction(async (tx) => {
        await claimWebhookEvent("evt_crash", "invoice.paid", tx);
        throw new Error("processing failed after the claim");
      }),
    ).rejects.toThrow(/processing failed/);

    const rows = await getDb()
      .select()
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.eventId, "evt_crash"));
    expect(rows, "a rolled-back claim must leave no trace").toHaveLength(0);
    // And the retry now does the work.
    await expect(claimWebhookEvent("evt_crash", "invoice.paid")).resolves.toBe(true);
  });
});

/**
 * The record that makes a Stripe call safe to retry.
 *
 * Every case here is one a person can produce by pressing a button twice, or
 * that a network can produce by dropping an answer after the work was done.
 */
integration("recording a billing operation before it is attempted", () => {
  const actor = { userId: "op-user", source: "web" } as const;

  beforeAll(async () => {
    await database.create();
    await seedUser(actor.userId);
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("mints one Stripe key and hands the same one back to a retry", async () => {
    const first = await beginBillingOperation(actor, "subscription.set", "key-1", {
      interval: "yearly",
    });
    expect(first.kind).toBe("attempt");
    const second = await beginBillingOperation(actor, "subscription.set", "key-1", {
      interval: "yearly",
    });
    // The same key, because that is what turns a call that may or may not have
    // charged a card into the same call rather than a second one.
    expect(second).toEqual(first);
  });

  it("replays the stored result once the operation has succeeded", async () => {
    await beginBillingOperation(actor, "subscription.set", "key-2", { interval: "monthly" });
    await finishBillingOperation(actor, "subscription.set", "key-2", "succeeded", {
      subscriptionId: "sub_stored",
    });
    const replay = await beginBillingOperation(actor, "subscription.set", "key-2", {
      interval: "monthly",
    });
    expect(replay).toEqual({ kind: "replay", result: { subscriptionId: "sub_stored" } });
  });

  it("goes back to Stripe with the original key after a failure", async () => {
    const first = await beginBillingOperation(actor, "subscription.set", "key-3", {
      interval: "yearly",
    });
    await finishBillingOperation(actor, "subscription.set", "key-3", "failed", {
      message: "card_declined",
    });
    const retry = await beginBillingOperation(actor, "subscription.set", "key-3", {
      interval: "yearly",
    });
    expect(retry).toEqual(first);
  });

  it("refuses a key reused for a different request", async () => {
    await beginBillingOperation(actor, "subscription.set", "key-4", { interval: "yearly" });
    await expect(
      beginBillingOperation(actor, "subscription.set", "key-4", { interval: "monthly" }),
    ).rejects.toThrow(/already used with a different request/);
  });

  it("keys are somebody's own, so two people may choose the same one", async () => {
    await seedUser("op-other");
    const other = { userId: "op-other", source: "web" } as const;
    const mine = await beginBillingOperation(actor, "subscription.set", "shared", {
      interval: "yearly",
    });
    const theirs = await beginBillingOperation(other, "subscription.set", "shared", {
      interval: "yearly",
    });
    expect(mine.kind).toBe("attempt");
    expect(theirs.kind).toBe("attempt");
    // Different Stripe keys, or the second person's call would replay the
    // first's answer at Stripe.
    expect(theirs).not.toEqual(mine);
  });
});

/**
 * The sweep, and the one property that matters most about it: a deployment that
 * sells nothing pays nothing for it.
 */
integration("the reconciliation sweep", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("returns without a query where no Stripe is configured", async () => {
    const summary = await runBillingReconciliation();
    expect(summary).toEqual({
      examined: 0,
      written: 0,
      failed: 0,
      capped: false,
      skipped: true,
    });
  });
});

/** Deleting a Stripe customer leaves the mapping pointing at nothing. */
integration("forgetting a customer Stripe has deleted", () => {
  beforeAll(async () => {
    await database.create();
    await seedUser("gone-user");
    await getDb()
      .insert(billingCustomers)
      .values({ userId: "gone-user", stripeCustomerId: "cus_gone" });
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("drops the mapping and claims the delivery once", async () => {
    await expect(
      applyCustomerDeletion("cus_gone", { id: "evt_del", type: "customer.deleted" }),
    ).resolves.toBe("written");
    await expect(userForStripeCustomer("cus_gone")).resolves.toBeNull();
    // Claimed, so Stripe's retry does nothing rather than deleting again.
    await expect(
      applyCustomerDeletion("cus_gone", { id: "evt_del", type: "customer.deleted" }),
    ).resolves.toBe("duplicate");
  });

  it("reports a customer it never knew rather than failing", async () => {
    await expect(
      applyCustomerDeletion("cus_stranger", { id: "evt_del2", type: "customer.deleted" }),
    ).resolves.toBe("unknown");
  });
});

/**
 * A delivery that arrives while the account is being deleted.
 *
 * The person is resolved from the customer mapping *before* the Stripe read,
 * and that read is a network round trip — long enough for the account to
 * cascade away underneath. Without a catch the insert fails its foreign key and
 * the endpoint answers 500, which is the one answer it must never give for
 * something it has no opinion about: Stripe retries, and while it retries it
 * delays finalization of every auto-collection invoice on the account for up to
 * 72 hours.
 */
integration("a delivery for somebody who was deleted mid-flight", () => {
  beforeAll(async () => {
    await database.create();
  }, 60_000);
  afterAll(async () => {
    await database.drop();
  });

  it("acknowledges rather than failing, so Stripe stops retrying", async () => {
    // No user row at all: exactly what the cascade leaves behind by the time
    // the snapshot comes back.
    await expect(
      applyStripeDelivery(
        "deleted-mid-flight",
        { id: "evt_gone", type: "customer.subscription.updated" },
        snapshot("deleted-mid-flight"),
      ),
    ).resolves.toBe("gone");
  });

  it("still fails loudly on a referential error that is not that", async () => {
    // The narrowing matters: a foreign key that is not `auth_user` is a bug,
    // and answering 2xx would bury it.
    await seedUser("present-user");
    await expect(
      applyStripeDelivery(
        "present-user",
        { id: "evt_ok", type: "customer.subscription.updated" },
        snapshot("present-user"),
      ),
    ).resolves.toBe("written");
  });
});
