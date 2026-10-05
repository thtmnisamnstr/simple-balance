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
  cancelAt: null,
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
 * Whether the deployment has recorded this Stripe delivery as handled.
 *
 * Read back rather than inferred, because the claim and the write it guards are
 * meant to commit together: the only way to tell a claim that rolled back from
 * one that outlived its write is to look for the row.
 */
const claimed = async (eventId: string) =>
  (
    await getDb()
      .select()
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.eventId, eventId))
  ).length > 0;

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

  it("stores the day a cancellation lands on, and the price agreed for the next renewal", async () => {
    // The insert half of the write, and four columns nothing else in the tree
    // ever reads back off the row.
    //
    // An operator dating a cancellation in Stripe's dashboard for a day past
    // this period leaves `cancel_at_period_end` false — that period genuinely
    // does renew — so the date is the only record that the subscription is
    // stopping. Lose it here and `cancellationPending` is false,
    // `PLAN_ENDING_REFUSAL` never fires, and both plan-change buttons go live
    // on a subscription Stripe is about to stop: a downgrade press folds it
    // into a schedule that destroys it, an upgrade press bills a full year.
    // Migration `0025` exists for exactly that defect.
    await seedUser("rec-cancel-insert");
    await expect(
      reconcileSubscription(
        "rec-cancel-insert",
        snapshot("rec-cancel-insert", {
          cancelAtPeriodEnd: false,
          currentPeriodEnd: at("2027-01-01T00:00:00.000Z"),
          cancelAt: at("2027-11-13T18:53:33.000Z"),
          scheduledPriceId: "price_monthly",
          scheduledAt: at("2027-01-01T00:00:00.000Z"),
        }),
      ),
    ).resolves.toBe("written");

    expect(await stored("rec-cancel-insert")).toMatchObject({
      cancelAtPeriodEnd: false,
      cancelAt: at("2027-11-13T18:53:33.000Z"),
      currentPeriodEnd: at("2027-01-01T00:00:00.000Z"),
      scheduledPriceId: "price_monthly",
      scheduledAt: at("2027-01-01T00:00:00.000Z"),
    });
  });

  it("carries a dashboard cancellation onto a row it already has, and lets it be taken back", async () => {
    // The `on conflict` half, which is separate code from the insert above and
    // survives a mutation to it. `cancelAtPeriodEnd` is false on both
    // snapshots on purpose: the flag never moves, so `cancel_at` is the only
    // field in the SET clause that differs apart from `syncedAt`, and neither
    // half of this case can pass off the flag by accident.
    //
    // Clearing it is what **Keep my plan** is. `setSubscriptionCancellation`
    // tells Stripe to stop the cancellation — Stripe really does clear
    // `cancel_at`, really does renew, really does charge the card — and then
    // resyncs a snapshot carrying `cancelAt: null`. If that null does not land,
    // `cancellationPending` is permanently true on a subscription that is being
    // billed, and every plan control stays refused with no way back.
    await seedUser("rec-cancel-update");
    await reconcileSubscription("rec-cancel-update", snapshot("rec-cancel-update"));
    expect((await stored("rec-cancel-update"))?.cancelAt).toBeNull();

    await reconcileSubscription(
      "rec-cancel-update",
      snapshot("rec-cancel-update", {
        cancelAtPeriodEnd: false,
        cancelAt: at("2027-11-13T18:53:33.000Z"),
        syncedAt: at("2026-06-15T12:00:01.000Z"),
      }),
    );
    const ending = await stored("rec-cancel-update");
    expect(ending?.cancelAt).toEqual(at("2027-11-13T18:53:33.000Z"));
    expect(ending?.cancelAtPeriodEnd, "the flag must not be what moved").toBe(false);

    await reconcileSubscription(
      "rec-cancel-update",
      snapshot("rec-cancel-update", {
        cancelAtPeriodEnd: false,
        cancelAt: null,
        syncedAt: at("2026-06-15T12:00:02.000Z"),
      }),
    );
    const kept = await stored("rec-cancel-update");
    expect(kept?.cancelAt, "Keep my plan is this write").toBeNull();
    expect(kept?.cancelAtPeriodEnd).toBe(false);
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
 *
 * Every case here also pins the transaction boundary, because that is what the
 * catch is reasoning about: the claim on the delivery and the write it guards
 * commit together, so whatever a failure inside takes with it, it takes both.
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
    // The claim was taken inside the transaction that then rolled back, so it
    // went with it. Answering 2xx is only safe because nothing was recorded.
    expect(await claimed("evt_gone"), "a claim must not outlive the write it guards").toBe(false);
  });

  it("leaves the delivery for Stripe to retry when the write inside it fails", async () => {
    // The boundary stated as its consequence rather than as an implementation
    // detail. Hoisting the claim out of the transaction passes every other
    // test in this repository and loses a paid entitlement permanently: the
    // claim commits, the write does not, and Stripe's retry is then swallowed
    // by the dedupe row the failed attempt left behind.
    const event = { id: "evt_boundary", type: "customer.subscription.updated" } as const;
    // No user row, so the write inside the transaction fails its `auth_user`
    // key — a real in-transaction failure, needing no mocking. That the claim
    // went down with it is the case above; this one is about what happens
    // next, and the check is left out here on purpose so the assertion that
    // bites is the one stating the consequence rather than the mechanism.
    await expect(
      applyStripeDelivery("boundary-user", event, snapshot("boundary-user")),
    ).resolves.toBe("gone");

    // The account is present now. In production the same second attempt is any
    // transient failure clearing: a lock wait, a statement timeout, a
    // failover, a deploy killing the process mid-transaction. Stripe retries
    // the same event id for up to 72 hours, and that retry must do the work
    // rather than meet a dedupe row the failed attempt left behind.
    await seedUser("boundary-user");
    await expect(
      applyStripeDelivery("boundary-user", event, snapshot("boundary-user")),
    ).resolves.toBe("written");
    expect((await stored("boundary-user"))?.status).toBe("active");
    // Claimed now — by the write that did happen, and only by it.
    expect(await claimed("evt_boundary")).toBe(true);
  });

  it("claims a delivery it did write, so Stripe's retry changes nothing", async () => {
    // The other side of that boundary, and a branch nothing exercised for this
    // function: deleting the claim outright passes the whole suite today. The
    // retry carries a *newer* snapshot on purpose, so an unclaimed second call
    // would be written rather than dropped as stale — "duplicate" here is the
    // claim doing the work, not the monotonic guard standing in for it.
    const event = { id: "evt_twice", type: "customer.subscription.updated" } as const;
    await seedUser("retry-user");
    await expect(applyStripeDelivery("retry-user", event, snapshot("retry-user"))).resolves.toBe(
      "written",
    );

    await expect(
      applyStripeDelivery(
        "retry-user",
        event,
        snapshot("retry-user", { status: "canceled", syncedAt: at("2026-06-15T12:00:05.000Z") }),
      ),
    ).resolves.toBe("duplicate");
    expect((await stored("retry-user"))?.status, "the retry must write nothing").toBe("active");
  });

  it("still fails loudly on a database error that is not that", async () => {
    // The narrowing is what makes the catch safe, and widening it is a
    // one-word change — "catch every 23503", or a bare `catch { return
    // "gone" }`. Then any failure inside the transaction answers HTTP 200,
    // Stripe never retries, the transaction rolled back so
    // `billing_webhook_event` holds nothing either, and the delivery simply
    // ceases to exist with a log line as its only trace.
    //
    // A Stripe subscription belongs to exactly one customer and
    // `billing_subscription_stripe_id_unique` says so, so a second person
    // claiming one is a shape Stripe cannot produce — which is the point: a
    // shape Stripe cannot produce is a bug here, and a bug must surface.
    // `reconcileSubscription` arbitrates its upsert on
    // `[user_id, stripe_subscription_id]`, which does not conflict for a
    // person who has no row, so the global unique raises rather than being
    // absorbed into an update.
    await seedUser("sub-holder");
    await seedUser("sub-thief");
    await expect(
      applyStripeDelivery(
        "sub-holder",
        { id: "evt_held", type: "customer.subscription.updated" },
        snapshot("sub-holder"),
      ),
    ).resolves.toBe("written");

    // Named rather than merely "something threw", so this still means
    // something if the failure mode moves.
    await expect(
      applyStripeDelivery(
        "sub-thief",
        { id: "evt_stolen_sub", type: "customer.subscription.updated" },
        snapshot("sub-thief", { stripeSubscriptionId: subscriptionFor("sub-holder") }),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });

    // And the rollback checked on both sides: no claim, so Stripe's retry is
    // not swallowed, and the row it collided with is untouched.
    expect(await claimed("evt_stolen_sub")).toBe(false);
    expect(await stored("sub-holder")).toMatchObject({ userId: "sub-holder", status: "active" });
  });
});
