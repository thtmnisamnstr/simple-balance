import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  type Actor,
  type BillingInterval,
  cancellationPutSchema,
  type Entitlement,
  intervalOfPrice,
  liveSubscriptionStatuses,
  paymentSetupConfirmSchema,
  paymentSetupCreateSchema,
  resolveEntitlement,
  subscriptionAction,
  subscriptionPutSchema,
} from "../../shared/domain.js";
import { billingEnabled, getConfig } from "../config.js";
import { getDb, type DbTransaction, withTransaction } from "../db/client.js";
import {
  idempotencyRequestHash,
  lockBillingState,
  lockIdempotencyKey,
  type Executor,
} from "./helpers.js";
import { conflict, notFound } from "./errors.js";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import {
  createStripeCustomer,
  createStripeSetupIntent,
  fetchStripeSetupIntent,
  openStripeInvoiceFor,
  payStripeInvoice,
  setStripeDefaultPaymentMethod,
  cancelStripeSubscriptionNow,
  createStripeSubscription,
  deleteStripeCustomer,
  fetchPlanPrices,
  fetchSubscriptionClientSecret,
  fetchSubscriptionSnapshot,
  releaseStripeSchedule,
  scheduleStripeSubscriptionPrice,
  setStripeCancelAtPeriodEnd,
  stripeScheduleFor,
  stripeSubscriptionItem,
  switchStripeSubscriptionNow,
} from "../stripe.js";
import {
  billingCustomers,
  user as authUsers,
  billingOperations,
  billingSubscriptions,
  billingOverrides,
  billingWebhookEvents,
  ledgerAccounts,
} from "../db/schema.js";

/**
 * What this person's plan allows.
 *
 * Reads rather than writes, so it joins a caller's transaction with
 * `transaction ?? getDb()` instead of opening one: the call site that matters
 * is inside `createAccount`, which is already holding the account namespace
 * lock, and opening a second connection there would deadlock a deployment
 * running `DATABASE_POOL_SIZE=1` — which `single-connection.integration.test.ts`
 * says is supported.
 *
 * The first line is the one that matters for everybody who is not paying for
 * anything: a deployment that sells nothing answers without touching the
 * database at all, so the cost of this feature to an installation that never
 * enabled it is one boolean.
 */
export async function getEntitlement(
  actor: Actor,
  transaction?: DbTransaction,
): Promise<Entitlement> {
  if (!billingEnabled()) return { billing: false };
  const db = transaction ?? getDb();

  const [override] = await db
    .select({ plan: billingOverrides.plan, expiresAt: billingOverrides.expiresAt })
    .from(billingOverrides)
    .where(eq(billingOverrides.userId, actor.userId))
    .limit(1);
  // Every row, not the newest: somebody who canceled and resubscribed has two,
  // and Stripe guarantees no ordering between the deliveries that wrote them,
  // so picking by which was read last would let a late cancellation outrank the
  // live subscription beside it. There are only ever a handful per person.
  const subscriptions = await db
    .select({
      status: billingSubscriptions.status,
      pastDueSince: billingSubscriptions.pastDueSince,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, actor.userId));

  return resolveEntitlement({
    billingEnabled: true,
    override,
    subscriptions,
    now: new Date(),
  });
}

/**
 * How many financial accounts this person has made, as `MAX_FREE_ACCOUNTS`
 * counts them: archived ones included, the ledger's own counter-accounts not.
 * That constant carries the reasoning for both halves; repeating it here would
 * give one rule two homes and let the copy drift.
 *
 * The `system_kind is null` clause is the same one every user-facing account
 * read uses, so this counts exactly what a person can see.
 */
export async function countOwnedAccounts(tx: Executor, actor: Actor): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.userId, actor.userId), isNull(ledgerAccounts.systemKind)));
  return row?.count ?? 0;
}

/**
 * The plan and what it has been spent on, for the session the browser loads.
 *
 * Counted here rather than left to the browser because the accounts list it
 * holds depends on whether archived ones are being shown, and the limit counts
 * them either way — a page that derived the number from the list it happened to
 * have would offer the button to somebody who cannot use it. The browser
 * invalidates this query whenever it creates or deletes an account, so the only
 * window in which it is stale is a second tab, which the server still refuses.
 *
 * No count at all where nothing is sold, which is the default: the session read
 * costs exactly what it cost before this release.
 */
export async function getPlanSummary(
  actor: Actor,
): Promise<{ entitlement: Entitlement; accountsUsed: number | null }> {
  const entitlement = await getEntitlement(actor);
  if (!entitlement.billing || entitlement.accountLimit === null) {
    return { entitlement, accountsUsed: null };
  }
  return { entitlement, accountsUsed: await countOwnedAccounts(getDb(), actor) };
}

/**
 * What Stripe last said about one subscription, as this product stores it.
 *
 * `syncedAt` is when the snapshot was *read from Stripe*, not when the
 * subscription changed. It is the ordering this product trusts, because Stripe
 * publishes none: a Subscription carries no revision number, and its `created`
 * is the subscription's birthday rather than the revision's.
 */
export type SubscriptionSnapshot = {
  readonly stripeSubscriptionId: string;
  readonly status: string;
  readonly priceId: string;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  /** A price agreed for the next renewal, or null when the plan is not changing. */
  readonly scheduledPriceId: string | null;
  readonly scheduledAt: Date | null;
  readonly syncedAt: Date;
};

/**
 * Writes a subscription snapshot, unless a newer one is already stored.
 *
 * Takes a `userId` rather than an `Actor` because the caller is Stripe: a
 * delivery names a customer and this product resolves it to a person, so there
 * is no request naming an actor to derive one from — the same exception
 * `services.md` 1.1 already names for `revokeAllConnectedApps`.
 *
 * Two guards, and they do different jobs. The lock serializes the
 * read-decide-write so two replicas cannot both decide theirs is newer. The
 * `syncedAt` comparison is what decides: a snapshot fetched before the stored
 * one is dropped, which is what stops a slow request carrying a canceled
 * subscription from putting somebody back on the free plan after a later fetch
 * had already seen them resubscribe.
 *
 * Returns what it did, because the caller counts it.
 */
export async function reconcileSubscription(
  userId: string,
  snapshot: SubscriptionSnapshot,
  transaction?: DbTransaction,
): Promise<"written" | "stale"> {
  return withTransaction(transaction, async (tx) => {
    await lockBillingState(tx, userId);
    const [stored] = await tx
      .select({
        status: billingSubscriptions.status,
        syncedAt: billingSubscriptions.syncedAt,
        pastDueSince: billingSubscriptions.pastDueSince,
      })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.userId, userId),
          eq(billingSubscriptions.stripeSubscriptionId, snapshot.stripeSubscriptionId),
        ),
      )
      .limit(1);

    // Not newer, so not written. Equal counts as not newer: two fetches sharing
    // a millisecond cannot be ordered, and keeping the stored one makes the
    // outcome the same whichever arrives second.
    //
    // The comparison is of wall clocks, and on a deployment running more than
    // one API replica they are different machines' wall clocks, so a replica
    // whose clock is behind can have its newer read dropped. That is a stated
    // assumption rather than an oversight — `docs/deployment.md` names NTP among
    // the things a split deployment has to line up — and the twelve-hourly
    // sweep repairs it regardless, because it re-reads from Stripe with a fresh
    // stamp.
    if (stored && stored.syncedAt >= snapshot.syncedAt) return "stale";

    // The moment the renewal started failing, which is what the grace counts
    // from. Kept across snapshots so a subscription that stays `past_due` for a
    // week does not have its grace restarted by every delivery, and cleared on
    // any transition out so a recovery followed by a later failure starts a new
    // one rather than inheriting the old.
    const pastDueSince =
      snapshot.status === "past_due"
        ? ((stored?.status === "past_due" ? stored.pastDueSince : null) ?? snapshot.syncedAt)
        : null;

    const row = {
      userId,
      stripeSubscriptionId: snapshot.stripeSubscriptionId,
      status: snapshot.status,
      priceId: snapshot.priceId,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      scheduledPriceId: snapshot.scheduledPriceId,
      scheduledAt: snapshot.scheduledAt,
      pastDueSince,
      syncedAt: snapshot.syncedAt,
    };
    await tx
      .insert(billingSubscriptions)
      .values(row)
      .onConflictDoUpdate({
        target: [billingSubscriptions.userId, billingSubscriptions.stripeSubscriptionId],
        set: {
          status: row.status,
          priceId: row.priceId,
          currentPeriodEnd: row.currentPeriodEnd,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          scheduledPriceId: row.scheduledPriceId,
          scheduledAt: row.scheduledAt,
          pastDueSince: row.pastDueSince,
          syncedAt: row.syncedAt,
          updatedAt: new Date(),
        },
      });
    return "written";
  });
}

/**
 * Claims a Stripe delivery, or reports that it has already been handled.
 *
 * Called inside the same transaction as the work it guards, which is the whole
 * design. Claim and write commit together, so a crash between them rolls both
 * back and Stripe's retry — it retries for up to 72 hours — finds the event
 * unclaimed and does the work. Committing the claim separately would be the
 * shape that loses a delivery permanently: the row would say "handled" for work
 * that never happened, and the retry would be swallowed by this very check.
 *
 * The Stripe fetch happens *before* the transaction opens, so no database lock
 * is ever held across a network call.
 *
 * Two replicas handed the same delivery serialize here rather than racing: the
 * primary key makes the second wait for the first to commit, and it then finds
 * the event claimed and does nothing.
 *
 * Actor-less, and keyed on Stripe's event id alone: the row is the deployment's
 * record of what Stripe sent rather than somebody's data, so it carries no
 * `user_id` and outlives the account an event happened to be about.
 *
 * Returns false when the event has been seen before, which is the caller's
 * signal to answer 2xx and do nothing.
 */
export async function claimWebhookEvent(
  eventId: string,
  type: string,
  transaction?: DbTransaction,
): Promise<boolean> {
  return withTransaction(transaction, async (tx) => {
    const claimed = await tx
      .insert(billingWebhookEvents)
      .values({ eventId, type })
      .onConflictDoNothing({ target: billingWebhookEvents.eventId })
      .returning({ eventId: billingWebhookEvents.eventId });
    return claimed.length > 0;
  });
}

/**
 * Which subscription a delivery is about, or null when it is about none.
 *
 * Pure, and separated from the handler for that reason: which events matter is
 * the half of webhook handling that is worth exhaustive testing, and doing it
 * here means it can be tested without a Stripe account or a network.
 *
 * Two families arrive. A `customer.subscription.*` event carries the
 * subscription itself. An `invoice.*` event carries an invoice that names one,
 * and those matter because `invoice.paid` is the only thing this product treats
 * as proof that a first payment succeeded.
 *
 * Everything else returns null and is acknowledged without being acted on.
 * Answering anything but a 2xx to Stripe delays finalization of *every*
 * auto-collection invoice on the account for up to 72 hours, so "I have no
 * opinion about this event" must never be spelled as a failure.
 */
export function subscriptionIdForEvent(event: {
  readonly type: string;
  readonly data: { readonly object: unknown };
}): string | null {
  const object = event.data.object as Record<string, unknown> | null;
  if (!object || typeof object !== "object") return null;

  if (event.type.startsWith("customer.subscription.")) {
    return typeof object["id"] === "string" ? object["id"] : null;
  }
  if (event.type.startsWith("invoice.")) {
    // Stripe moved the invoice's subscription reference around: older payloads
    // carry a top-level `subscription`, newer ones put it on the parent. Read
    // both rather than betting on which shape a given account sends, because
    // the wrong guess is a payment that never grants anything.
    const direct = object["subscription"];
    if (typeof direct === "string") return direct;
    if (direct && typeof direct === "object") {
      const id = (direct as Record<string, unknown>)["id"];
      if (typeof id === "string") return id;
    }
    const parent = object["parent"] as Record<string, unknown> | undefined;
    const details = parent?.["subscription_details"] as Record<string, unknown> | undefined;
    const fromParent = details?.["subscription"];
    if (typeof fromParent === "string") return fromParent;
    if (fromParent && typeof fromParent === "object") {
      const id = (fromParent as Record<string, unknown>)["id"];
      if (typeof id === "string") return id;
    }
  }
  return null;
}

/**
 * Which person a Stripe customer belongs to, or null for one this deployment
 * has never heard of.
 *
 * Null is an ordinary answer rather than an error: an operator can create a
 * customer in Stripe's dashboard, and a deployment that was restored from a
 * backup can be behind. The caller acknowledges those and does nothing.
 */
export async function userForStripeCustomer(
  stripeCustomerId: string,
  transaction?: DbTransaction,
): Promise<string | null> {
  const db = transaction ?? getDb();
  const [row] = await db
    .select({ userId: billingCustomers.userId })
    .from(billingCustomers)
    .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row?.userId ?? null;
}

/** Which Stripe customer a delivery is about, or null when it names none. */
export function stripeCustomerIdForEvent(event: {
  readonly data: { readonly object: unknown };
}): string | null {
  const object = event.data.object as Record<string, unknown> | null;
  if (!object || typeof object !== "object") return null;
  const customer = object["customer"];
  if (typeof customer === "string") return customer;
  if (customer && typeof customer === "object") {
    const id = (customer as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  // A `customer.*` delivery carries the customer itself, so its id is on `id`
  // and there is no `customer` field at all — which made the `customer.deleted`
  // branch dead for every delivery it was written for. Last, and guarded on the
  // object's own type, so no other event's answer can change. `subscriptionIdForEvent`
  // beside this makes the same special case for `customer.subscription.*`.
  if (object["object"] === "customer" && typeof object["id"] === "string") return object["id"];
  return null;
}

/**
 * Claims a delivery and writes what it was about, in one transaction.
 *
 * The orchestration lives here rather than in the route because the transaction
 * boundary is a decision, and `docs/standards/code/services.md` 1.2 is that the
 * transport decides nothing. It also puts the two writes that must commit
 * together in one place, where the reason they must can be stated once.
 *
 * The snapshot is read from Stripe by the caller, *before* this is called, so
 * no database lock is ever held across a network request.
 */
export async function applyStripeDelivery(
  userId: string,
  event: { readonly id: string; readonly type: string },
  snapshot: SubscriptionSnapshot,
  transaction?: DbTransaction,
): Promise<"written" | "stale" | "duplicate" | "gone"> {
  try {
    return await withTransaction(transaction, async (tx) => {
      if (!(await claimWebhookEvent(event.id, event.type, tx))) return "duplicate";
      return reconcileSubscription(userId, snapshot, tx);
    });
  } catch (error) {
    // The person was deleted while this delivery was in flight.
    //
    // The user is resolved from the customer mapping *before* the Stripe read,
    // and that read is a network round trip — long enough for
    // `deleteOwnAccount` to cascade the row away underneath. The insert then
    // fails its foreign key, which without this catch is a 500 to Stripe.
    //
    // A 500 is the one answer this endpoint must never give for something it
    // has no opinion about: it makes Stripe retry, and while it retries Stripe
    // delays finalization of every auto-collection invoice on the account for
    // up to 72 hours. "The account is gone" is a deliberate no-op, and the
    // retry would resolve the customer to nobody anyway, because the mapping
    // went with them.
    if (!isMissingUserViolation(error)) throw error;
    log.info("Ignored a Stripe delivery for an account deleted while it was in flight");
    return "gone";
  }
}

/** Whether PostgreSQL refused a write because the person no longer exists. */
function isMissingUserViolation(error: unknown): boolean {
  // Read off `cause` as well as the error itself, because Drizzle wraps the
  // driver's error in one of its own carrying the failed query — the code and
  // the constraint are on the original, one level down. Checked against a real
  // PostgreSQL rather than assumed; a detector that only looked at the top
  // level matched nothing and answered Stripe 500 exactly as before.
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some((candidate) => {
    // 23503 is foreign_key_violation. Narrowed to the constraint that names
    // `auth_user`, so an unrelated referential failure still surfaces as the
    // bug it is rather than being answered 2xx and forgotten.
    const code = (candidate as { code?: unknown } | null)?.code;
    const constraint = (candidate as { constraint?: unknown } | null)?.constraint;
    return code === "23503" && typeof constraint === "string" && constraint.includes("auth_user");
  });
}

/**
 * What a caller should do with a billing operation it is about to attempt.
 *
 * `replay` means it already succeeded and this is the stored answer. `attempt`
 * carries the key to hand Stripe — freshly minted the first time, and the same
 * one on every retry, which is what turns a request that timed out mid-flight
 * into the same request rather than a second charge.
 */
export type BillingAttempt =
  | { readonly kind: "replay"; readonly result: unknown }
  | { readonly kind: "attempt"; readonly stripeIdempotencyKey: string };

/**
 * Records the intent to call Stripe, before calling it.
 *
 * Opens and commits its own transaction rather than taking a caller's, and that
 * is the whole point: the row has to be durable *before* the network request,
 * or a process that dies mid-call leaves no record of the key it already spent.
 * `deleteOwnAccount` owns its transaction for a related reason and
 * `services.md` 2.1 names that shape.
 *
 * A key reused with a different request is refused rather than replayed, the
 * same way `getIdempotent` refuses one: the caller has a bug, and answering
 * with somebody else's result would hide it.
 */
export async function beginBillingOperation(
  actor: Actor,
  operation: string,
  key: string,
  request: unknown,
): Promise<BillingAttempt> {
  const requestHash = idempotencyRequestHash(request);
  return getDb().transaction(async (tx) => {
    await lockIdempotencyKey(tx, actor, operation, key);
    const [stored] = await tx
      .select({
        requestHash: billingOperations.requestHash,
        stripeIdempotencyKey: billingOperations.stripeIdempotencyKey,
        state: billingOperations.state,
        result: billingOperations.result,
      })
      .from(billingOperations)
      .where(
        and(
          eq(billingOperations.userId, actor.userId),
          eq(billingOperations.operation, operation),
          eq(billingOperations.key, key),
        ),
      )
      .limit(1);

    if (stored) {
      if (stored.requestHash !== requestHash) {
        throw conflict("This idempotency key was already used with a different request", {
          operation,
        });
      }
      if (stored.state === "succeeded") return { kind: "replay", result: stored.result };
      // Pending or failed: the same key goes back to Stripe. Stripe answers a
      // repeated key with the original outcome, so a call that did charge is
      // not charged again and one that never landed is simply made.
      return { kind: "attempt", stripeIdempotencyKey: stored.stripeIdempotencyKey };
    }

    const stripeIdempotencyKey = randomUUID();
    await tx.insert(billingOperations).values({
      userId: actor.userId,
      operation,
      key,
      requestHash,
      stripeIdempotencyKey,
      state: "pending",
    });
    return { kind: "attempt", stripeIdempotencyKey };
  });
}

/** Records how a billing operation ended, so a retry replays rather than repeats. */
export async function finishBillingOperation(
  actor: Actor,
  operation: string,
  key: string,
  state: "succeeded" | "failed",
  result: unknown,
) {
  await getDb()
    .update(billingOperations)
    .set({ state, result: result ?? null, updatedAt: new Date() })
    .where(
      and(
        eq(billingOperations.userId, actor.userId),
        eq(billingOperations.operation, operation),
        eq(billingOperations.key, key),
      ),
    );
}

/**
 * The Stripe settings, for a caller that has already established they exist.
 *
 * Every function below is reachable only from routes registered when Stripe is
 * configured, so a missing configuration here is a wiring mistake rather than a
 * deployment's choice — an exception, not a refusal somebody could act on.
 */
function requireBilling() {
  const { billing } = getConfig();
  if (!billing) throw new Error("Stripe is not configured on this deployment");
  return billing;
}

function priceIdFor(interval: BillingInterval): string {
  const billing = requireBilling();
  return interval === "monthly" ? billing.monthlyPriceId : billing.yearlyPriceId;
}

/**
 * Refuses a sale on a deployment that has stopped selling.
 *
 * Canceling is deliberately *not* guarded by this. Turning `SB_BILLING_ENABLED`
 * off is how an operator stops taking new money without abandoning the people
 * already paying, and a switch that also took away their way out would turn a
 * pause into a trap.
 */
function assertSelling() {
  if (!billingEnabled()) {
    throw conflict("This deployment is not selling subscriptions", { selling: false });
  }
}

/**
 * The statuses that mean a subscription is somebody's current one.
 *
 * `canceled` and `incomplete_expired` are history: Stripe keeps the object
 * forever and somebody who resubscribes has both. Everything else is the row
 * this product acts on — including `incomplete`, a subscription waiting for its
 * first payment, and `unpaid`, one whose retries have run out. Both of those
 * have an open invoice and the plan tab hands the secret for it back, which is
 * what makes them states somebody can act on rather than dead ends.
 */
const liveStatuses = new Set<string>(liveSubscriptionStatuses);

type SubscriptionRow = {
  stripeSubscriptionId: string;
  status: string;
  priceId: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPriceId: string | null;
  scheduledAt: Date | null;
  pastDueSince: Date | null;
  syncedAt: Date;
};

/** Somebody's current subscription, or null when they have none. */
async function currentSubscription(
  actor: Actor,
  executor: Executor = getDb(),
): Promise<SubscriptionRow | null> {
  const rows = await executor
    .select({
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
      status: billingSubscriptions.status,
      priceId: billingSubscriptions.priceId,
      currentPeriodEnd: billingSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: billingSubscriptions.cancelAtPeriodEnd,
      scheduledPriceId: billingSubscriptions.scheduledPriceId,
      scheduledAt: billingSubscriptions.scheduledAt,
      pastDueSince: billingSubscriptions.pastDueSince,
      syncedAt: billingSubscriptions.syncedAt,
    })
    .from(billingSubscriptions)
    .where(eq(billingSubscriptions.userId, actor.userId));
  const live = rows.filter((row) => liveStatuses.has(row.status));
  // Newest read wins among live rows, which only matters in the window where a
  // cancellation and its replacement are both live. Ordered here rather than in
  // SQL because there are never more than a handful and the filter is in this
  // file's own vocabulary rather than the database's.
  return live.sort((a, b) => b.syncedAt.getTime() - a.syncedAt.getTime())[0] ?? null;
}

/**
 * The Stripe customer for this person, created if they have never had one.
 *
 * Committed before it returns, and that ordering is the point rather than an
 * implementation detail: `invoice.paid` can arrive before the call that created
 * the subscription has returned, and a webhook that cannot map the customer to
 * a person acknowledges the delivery and does nothing. Writing the mapping
 * afterwards would lose the activation that paid for it.
 *
 * The race between two first-time requests is settled by the insert rather than
 * by a lock, so no lock is held across the network call. The loser has made a
 * Stripe customer that owns nothing and will never be found again, so it is
 * deleted rather than left as litter in somebody's dashboard.
 */
async function ensureBillingCustomer(actor: Actor, stripeKey: string): Promise<string> {
  const existing = await getDb()
    .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, actor.userId))
    .limit(1);
  const found = existing[0]?.stripeCustomerId;
  if (found) return found;

  const [person] = await getDb()
    .select({ email: authUsers.email, name: authUsers.name })
    .from(authUsers)
    .where(eq(authUsers.id, actor.userId))
    .limit(1);
  if (!person) throw new Error("No such user");

  const created = await createStripeCustomer(
    { email: person.email, name: person.name, userId: actor.userId },
    `${stripeKey}:customer`,
  );
  const [won] = await getDb()
    .insert(billingCustomers)
    .values({ userId: actor.userId, stripeCustomerId: created })
    .onConflictDoNothing({ target: billingCustomers.userId })
    .returning({ stripeCustomerId: billingCustomers.stripeCustomerId });
  if (won) return won.stripeCustomerId;

  try {
    await deleteStripeCustomer(created);
  } catch (error) {
    // Not worth failing the request the person actually made. The customer is
    // empty, nothing will ever be billed to it, and an operator can find it by
    // the `simpleBalanceUserId` it carries.
    log.warn("billing.customer.orphaned", { stripeCustomerId: created, error: String(error) });
  }
  const [winner] = await getDb()
    .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, actor.userId))
    .limit(1);
  if (!winner) throw new Error("Billing customer disappeared between insert and read");
  return winner.stripeCustomerId;
}

/** What the plan tab reads. Entirely from this deployment's own tables, bar the two prices. */
export type BillingStatus = {
  readonly selling: boolean;
  readonly publishableKey: string;
  readonly prices: {
    readonly monthly: { id: string; unitAmount: number | null; currency: string } | null;
    readonly yearly: { id: string; unitAmount: number | null; currency: string } | null;
  };
  readonly entitlement: Entitlement;
  readonly accountsUsed: number | null;
  readonly subscription: {
    readonly status: string;
    readonly interval: BillingInterval | null;
    readonly currentPeriodEnd: string | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly pastDueSince: string | null;
    readonly scheduledInterval: BillingInterval | null;
    readonly scheduledAt: string | null;
  } | null;
  readonly override: { readonly plan: string; readonly expiresAt: string | null } | null;
};

/**
 * Everything the plan tab needs, in one read.
 *
 * The prices are the only part that leaves this deployment, and a failure to
 * fetch them is not a failure of the tab: somebody whose card has expired needs
 * to get at the payment form whether or not Stripe can tell us what a year
 * costs today. So the amounts come back null and the page renders without a
 * figure, rather than the whole screen refusing to open.
 */
export async function getBillingStatus(actor: Actor): Promise<BillingStatus> {
  const billing = requireBilling();

  // A payment that has just been made, before Stripe has told us about it.
  //
  // The browser confirms a card and reloads this within a moment; `invoice.paid`
  // arrives later, so without this the person who has just been charged reads
  // "Waiting for payment" and "Free: up to 3 accounts" on the screen they were
  // returned to. Asking Stripe directly is not trusting the client — the client
  // said nothing, and Stripe is still the authority for the answer. Bounded to
  // a plan-tab load that already has an unpaid row, and tolerant of failure the
  // way the price lookup below is, because a subscription nobody can re-read is
  // still a subscription worth rendering.
  const stale = await currentSubscription(actor);
  if (stale && stale.status === "incomplete") {
    try {
      await resync(actor.userId, stale.stripeSubscriptionId);
    } catch (error) {
      log.warn("billing.status.resync_failed", { error: String(error) });
    }
  }

  const [summary, row, override, prices] = await Promise.all([
    getPlanSummary(actor),
    currentSubscription(actor),
    getDb()
      .select({ plan: billingOverrides.plan, expiresAt: billingOverrides.expiresAt })
      .from(billingOverrides)
      .where(eq(billingOverrides.userId, actor.userId))
      .limit(1),
    fetchPlanPrices().catch((error: unknown) => {
      log.warn("billing.prices.unavailable", { error: String(error) });
      return { monthly: null, yearly: null };
    }),
  ]);

  return {
    selling: billingEnabled(),
    publishableKey: billing.publishableKey,
    prices: {
      monthly: prices.monthly
        ? {
            id: prices.monthly.id,
            unitAmount: prices.monthly.unitAmount,
            currency: prices.monthly.currency,
          }
        : null,
      yearly: prices.yearly
        ? {
            id: prices.yearly.id,
            unitAmount: prices.yearly.unitAmount,
            currency: prices.yearly.currency,
          }
        : null,
    },
    entitlement: summary.entitlement,
    accountsUsed: summary.accountsUsed,
    subscription: row
      ? {
          status: row.status,
          interval: intervalOfPrice(row.priceId, billing),
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          pastDueSince: row.pastDueSince?.toISOString() ?? null,
          scheduledInterval: intervalOfPrice(row.scheduledPriceId, billing),
          scheduledAt: row.scheduledAt?.toISOString() ?? null,
        }
      : null,
    override: override[0]
      ? { plan: override[0].plan, expiresAt: override[0].expiresAt?.toISOString() ?? null }
      : null,
  };
}

/**
 * Runs one Stripe-side operation under the caller's idempotency key.
 *
 * The shape every mutating billing service shares: record the intent and commit
 * it, do the work, record how it ended. A retry of a key that already succeeded
 * replays the stored answer without calling Stripe at all, and a retry of one
 * that failed or never finished goes back to Stripe with the *same* Stripe-side
 * key, so an ambiguous first attempt resolves into one charge rather than two.
 *
 * Failures are recorded and rethrown rather than swallowed. A recorded failure
 * is what lets the next attempt reuse the key instead of minting a new one.
 */
async function underIdempotency<T>(
  actor: Actor,
  operation: string,
  key: string,
  request: unknown,
  run: (stripeKey: string) => Promise<T>,
): Promise<T> {
  const attempt = await beginBillingOperation(actor, operation, key, request);
  if (attempt.kind === "replay") return attempt.result as T;
  try {
    const result = await run(attempt.stripeIdempotencyKey);
    await finishBillingOperation(actor, operation, key, "succeeded", withoutSecrets(result));
    return result;
  } catch (error) {
    await finishBillingOperation(actor, operation, key, "failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * The same answer with the client secrets taken out, for storing.
 *
 * A `clientSecret` authorizes confirming a payment or attaching a card, and the
 * row it would be written to is never deleted. Keeping one is a credential at
 * rest with no expiry and no reason: the replay path exists so a retried write
 * is not a second charge, and a browser that needs a secret asks for a fresh
 * one. A retry therefore gets the stored answer with a null where the secret
 * was, which is honest rather than convenient — the caller reads it as "there
 * is nothing left to confirm", and if there is, the page asks again.
 */
function withoutSecrets(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const copy = { ...(result as Record<string, unknown>) };
  if ("clientSecret" in copy) copy["clientSecret"] = null;
  return copy;
}

/** Re-reads a subscription from Stripe and stores what it says. */
async function resync(userId: string, stripeSubscriptionId: string) {
  await resyncStatus(userId, stripeSubscriptionId);
}

/** The same, reporting the status Stripe gave, for a caller that answers with it. */
async function resyncStatus(userId: string, stripeSubscriptionId: string): Promise<string> {
  const snapshot = await fetchSubscriptionSnapshot(stripeSubscriptionId);
  await reconcileSubscription(userId, snapshot);
  return snapshot.status;
}

/**
 * Clears a schedule off a subscription so it can be changed directly.
 *
 * Stripe refuses an update to a subscription a schedule is managing, so a
 * pending interval change has to be let go before anything else can be asked
 * for. That is the right precedence anyway: somebody who cancels, or who
 * upgrades, has just said something more recent about the same subscription.
 */
async function releaseAnySchedule(subscriptionId: string, stripeKey: string) {
  const scheduleId = await stripeScheduleFor(subscriptionId);
  if (scheduleId) await releaseStripeSchedule(scheduleId, `${stripeKey}:release`);
}

/**
 * What the locked section decided, for the unlocked half to store.
 *
 * `resync` is false only where nothing was sent to Stripe, so the stored row is
 * already what Stripe would say. `abandoned` names a second subscription that
 * also needs re-reading — the unpaid one somebody replaced by changing their
 * mind, which would otherwise stay `incomplete` here and go on being offered as
 * a payment to finish.
 */
type StripeChange = {
  readonly subscriptionId: string;
  readonly clientSecret: string | null;
  readonly resync: boolean;
  readonly abandoned?: string;
};

export type SubscriptionResult = {
  readonly subscriptionId: string;
  /** Present only when the browser has a payment left to confirm. */
  readonly clientSecret: string | null;
  readonly status: string;
};

/**
 * Puts somebody on a plan: a first subscription, or a change of interval.
 *
 * One entry point for both because it is one request from the person's side —
 * "I want the annual plan" — and splitting it would make the browser decide
 * which case it is from a status it may have read a moment ago.
 *
 * The decision and the Stripe calls that act on it run under a per-user lock,
 * and this is the one place in this file that holds one across a network call.
 * The alternative is two concurrent requests each creating a subscription for
 * the same person, which is somebody charged twice and no constraint able to
 * say so.
 *
 * Say the cost plainly, because the obvious reading of "a lock scoped to that
 * person blocks nobody else" is wrong: an advisory lock lives on a transaction,
 * a transaction holds a pooled connection, and the connection is not scoped to
 * anybody. One subscribe occupies one connection of `DATABASE_POOL_SIZE` — ten
 * by default — for the length of the Stripe calls. That is a second or two in
 * the ordinary case, and with the client's ten-second timeout and two retries
 * it is about half a minute per call if Stripe is unreachable. On a deployment
 * running a pool of one, which is supported, everything else waits for it.
 *
 * The trade is deliberate and this is the direction to err in: being charged
 * twice is unrecoverable without a refund, while a request that queues is slow.
 * What does *not* need the lock is kept out of it — the customer is ensured
 * before it opens, and every snapshot is re-read and stored after it closes, so
 * only the calls that change something at Stripe are inside.
 */
export async function setSubscription(actor: Actor, input: unknown): Promise<SubscriptionResult> {
  assertSelling();
  const parsed = subscriptionPutSchema.parse(input);
  const billing = requireBilling();
  const targetPriceId = priceIdFor(parsed.interval);

  return underIdempotency(
    actor,
    "subscription.set",
    parsed.idempotencyKey,
    { interval: parsed.interval },
    async (stripeKey) => {
      // The customer first, and outside the lock: it is idempotent, it is the
      // slowest part of a first subscribe, and it has to be committed before
      // anything creates a subscription against it.
      const customerId = await ensureBillingCustomer(actor, stripeKey);

      // Everything from here to `commit` holds one connection. `changed` is what
      // the lock protects; storing what Stripe then says is done afterwards,
      // without one, because `reconcileSubscription` takes the same lock itself
      // and drops a snapshot older than the stored one.
      const changed = await getDb().transaction(async (tx): Promise<StripeChange> => {
        await lockBillingState(tx, actor.userId);
        const row = await currentSubscription(actor, tx);

        if (!row) {
          const created = await createStripeSubscription(
            { customerId, priceId: targetPriceId },
            stripeKey,
          );
          return {
            subscriptionId: created.subscriptionId,
            clientSecret: created.clientSecret,
            resync: true,
          };
        }

        const current = intervalOfPrice(row.priceId, billing);
        const scheduled = intervalOfPrice(row.scheduledPriceId, billing);
        // The whole branch decision, in one shared pure function the browser
        // previews with. Seven outcomes, each tested against every Stripe status
        // in `tests/subscription-action.test.ts`.
        const action = subscriptionAction({
          current: { status: row.status, interval: current, scheduled },
          requested: parsed.interval,
        });

        if (action.kind === "resume") {
          return {
            subscriptionId: row.stripeSubscriptionId,
            clientSecret: await fetchSubscriptionClientSecret(row.stripeSubscriptionId),
            // Nothing was changed at Stripe, so there is nothing to re-read.
            resync: false,
          };
        }

        // Chose one interval, did not pay, and has now chosen the other. The
        // unpaid subscription is abandoned and a new one made at the price they
        // actually asked for. Canceling voids its open invoice, so the change
        // of mind costs nothing — and doing anything else here is how somebody
        // presses a $3 button and is charged $30.
        //
        // Suffixed keys because Stripe scopes a key to one request, and the
        // original create already spent the unsuffixed one.
        if (action.kind === "replace") {
          await cancelStripeSubscriptionNow(row.stripeSubscriptionId, `${stripeKey}:abandon`);
          const created = await createStripeSubscription(
            { customerId, priceId: targetPriceId },
            `${stripeKey}:replace`,
          );
          return {
            subscriptionId: created.subscriptionId,
            clientSecret: created.clientSecret,
            resync: true,
            // The abandoned one has to be stored as well, or it stays `incomplete`
            // in this deployment's books and goes on being offered as the payment
            // to finish.
            abandoned: row.stripeSubscriptionId,
          };
        }

        if (action.kind === "none") {
          return { subscriptionId: row.stripeSubscriptionId, clientSecret: null, resync: false };
        }

        if (action.kind === "release") {
          await releaseAnySchedule(row.stripeSubscriptionId, stripeKey);
        } else if (action.kind === "upgrade") {
          // Monthly to annual takes effect now and charges the difference: the
          // person is buying more, and waiting a month to give it to them would
          // be a worse deal than the one they asked for.
          await releaseAnySchedule(row.stripeSubscriptionId, stripeKey);
          const item = await stripeSubscriptionItem(row.stripeSubscriptionId);
          if (!item) throw new Error("Stripe returned a subscription with no items");
          await switchStripeSubscriptionNow(
            {
              subscriptionId: row.stripeSubscriptionId,
              itemId: item.itemId,
              priceId: targetPriceId,
            },
            stripeKey,
          );
        } else {
          // Everything else waits for the renewal: annual to monthly, because
          // doing it now would shorten a year somebody has already paid for and
          // refunding the difference is not what they asked for either, and a
          // move off a retired price, because charging now for a plan we cannot
          // price is worse than waiting.
          await scheduleStripeSubscriptionPrice(
            {
              subscriptionId: row.stripeSubscriptionId,
              priceId: targetPriceId,
              // Derived, never assumed. The phase lasts one billing period of
              // the price it names, and hardcoding a month here put an annual
              // target on a one-month phase.
              interval: parsed.interval === "yearly" ? "year" : "month",
            },
            stripeKey,
          );
        }

        return { subscriptionId: row.stripeSubscriptionId, clientSecret: null, resync: true };
      });

      // Outside the lock, so the connection is back in the pool before any of
      // this. Each of these re-reads from Stripe and stores what it says.
      if (changed.abandoned) await resync(actor.userId, changed.abandoned);
      const status = changed.resync
        ? await resyncStatus(actor.userId, changed.subscriptionId)
        : ((await currentSubscription(actor))?.status ?? "incomplete");
      return {
        subscriptionId: changed.subscriptionId,
        clientSecret: changed.clientSecret,
        status,
      };
    },
  );
}

/**
 * Stops a subscription at the end of the period, or takes that back.
 *
 * Never immediate, in either direction. The period has been paid for, and
 * ending it early would either hand back money nobody asked to have handed
 * back or take away days somebody bought.
 */
export async function setSubscriptionCancellation(
  actor: Actor,
  input: unknown,
): Promise<SubscriptionResult> {
  const parsed = cancellationPutSchema.parse(input);
  const row = await currentSubscription(actor);
  if (!row) throw conflict("There is no subscription to change", { subscription: null });

  return underIdempotency(
    actor,
    "subscription.cancellation",
    parsed.idempotencyKey,
    { cancelAtPeriodEnd: parsed.cancelAtPeriodEnd },
    async (stripeKey) => {
      if (parsed.cancelAtPeriodEnd) {
        // A pending interval change is moot once the subscription is ending,
        // and Stripe will not accept the update while a schedule manages it.
        await releaseAnySchedule(row.stripeSubscriptionId, stripeKey);
      }
      await setStripeCancelAtPeriodEnd(
        row.stripeSubscriptionId,
        parsed.cancelAtPeriodEnd,
        stripeKey,
      );
      await resync(actor.userId, row.stripeSubscriptionId);
      return {
        subscriptionId: row.stripeSubscriptionId,
        clientSecret: null,
        status: row.status,
      };
    },
  );
}

/**
 * A secret the browser uses to attach a card, without one ever reaching here.
 *
 * Not guarded by `assertSelling`: somebody whose card expired has to be able to
 * replace it on a deployment that has stopped taking new subscribers, or the
 * pause becomes a way of canceling people by attrition.
 */
export async function createPaymentSetup(
  actor: Actor,
  input: unknown,
): Promise<{ clientSecret: string | null }> {
  const parsed = paymentSetupCreateSchema.parse(input);
  return underIdempotency(actor, "payment.setup", parsed.idempotencyKey, {}, async (stripeKey) => {
    const customerId = await ensureBillingCustomer(actor, stripeKey);
    const intent = await createStripeSetupIntent(customerId, stripeKey);
    return { clientSecret: intent.clientSecret, setupIntentId: intent.id };
  });
}

/**
 * Makes a card somebody just saved the one Stripe bills.
 *
 * The second half of replacing a card, and the half without which the first is
 * decoration: confirming a SetupIntent attaches a payment method to the
 * customer and changes nothing about what gets charged. A subscription's own
 * `default_payment_method` outranks the customer's, so dunning would go on
 * retrying the card that failed while the new one sat there unused.
 *
 * The browser names an id and nothing else. This reads the intent back from
 * Stripe — the browser is not the authority on whether a card was saved — and
 * refuses one whose customer is not this person's, because a SetupIntent id is
 * otherwise an unowned string and pinning somebody else's card to their
 * subscription would be a stranger paying, or not paying, their bill.
 *
 * Not guarded by `assertSelling`, for the same reason `createPaymentSetup` is
 * not: this is how somebody whose card expired stays a customer on a deployment
 * that has stopped taking new ones.
 */
export async function confirmPaymentSetup(
  actor: Actor,
  input: unknown,
): Promise<{ attached: boolean; paidInvoice: boolean }> {
  const parsed = paymentSetupConfirmSchema.parse(input);
  return underIdempotency(
    actor,
    "payment.setup.confirm",
    parsed.idempotencyKey,
    { setupIntentId: parsed.setupIntentId },
    async (stripeKey) => {
      const [customer] = await getDb()
        .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
        .from(billingCustomers)
        .where(eq(billingCustomers.userId, actor.userId))
        .limit(1);
      if (!customer) throw notFound("No such payment setup");

      const intent = await fetchStripeSetupIntent(parsed.setupIntentId);
      // Not found rather than forbidden, and deliberately the same answer as an
      // id that does not exist: telling somebody their guess named a real
      // SetupIntent belonging to someone else is the half of the answer they
      // were fishing for.
      if (intent.customerId !== customer.stripeCustomerId) throw notFound("No such payment setup");
      if (intent.status !== "succeeded") {
        throw conflict("That card has not been confirmed yet", { status: intent.status });
      }
      if (!intent.paymentMethodId) {
        throw conflict("That payment setup carries no card", { status: intent.status });
      }

      const row = await currentSubscription(actor);
      await setStripeDefaultPaymentMethod(
        {
          customerId: customer.stripeCustomerId,
          subscriptionId: row?.stripeSubscriptionId ?? null,
          paymentMethodId: intent.paymentMethodId,
        },
        stripeKey,
      );

      // And pay what is outstanding, so replacing a card fixes a failed renewal
      // now rather than at Stripe's next retry — which may be days away and may
      // be after the seven-day grace has run out. Best effort: the card is
      // attached and pinned either way, and Stripe retries on its own schedule,
      // so a failure here costs the person nothing they had.
      let paidInvoice = false;
      if (row) {
        try {
          const invoiceId = await openStripeInvoiceFor(row.stripeSubscriptionId);
          if (invoiceId) {
            await payStripeInvoice(invoiceId, `${stripeKey}:invoice`);
            paidInvoice = true;
          }
        } catch (error) {
          log.warn("billing.invoice.retry_failed", { error: String(error) });
        }
        await resync(actor.userId, row.stripeSubscriptionId);
      }
      return { attached: true, paidInvoice };
    },
  );
}

/**
 * Makes sure nobody is still being charged, before their account is destroyed.
 *
 * Refuses the deletion rather than logging and carrying on. The `billing_customer`
 * row cascades away with `auth_user`, so a subscription that survives this call
 * belongs to no one this deployment can name: Stripe keeps billing the card, the
 * webhook for it is acknowledged as "a customer we do not know", and nothing left
 * here can find it to stop it. A 409 somebody can act on is the better failure.
 *
 * The Stripe customer is deleted rather than each subscription canceled, which
 * is the difference between one call and a loop with a gap in it: a subscription
 * created between listing and canceling would survive a loop. Deleting the
 * customer cancels everything it owns, immediately and idempotently.
 *
 * Silent — doing nothing and refusing nothing — on a deployment with no Stripe
 * configured, which is the default, and on a person who never subscribed.
 */
export async function closeBillingForDeletion(actor: Actor): Promise<void> {
  if (!getConfig().billing) return;
  const [row] = await getDb()
    .select({ stripeCustomerId: billingCustomers.stripeCustomerId })
    .from(billingCustomers)
    .where(eq(billingCustomers.userId, actor.userId))
    .limit(1);
  if (!row) return;

  try {
    await deleteStripeCustomer(row.stripeCustomerId);
  } catch (error) {
    // A customer already deleted at Stripe is the outcome this was asking for,
    // so it is not a reason to keep somebody's account alive. Anything else is.
    if (!isMissingStripeResource(error)) {
      log.warn("billing.deletion.blocked", { error: String(error) });
      throw conflict(
        "Your subscription could not be canceled, so the account was not deleted. Try again in a few minutes.",
        { stage: "billing" },
        "Stripe could not be reached to cancel this person's subscription. Nothing was deleted. The deletion is safe to retry.",
      );
    }
  }
  // The mapping goes now rather than with the cascade, so a retry of a deletion
  // that failed later does not ask Stripe about a customer that is already gone.
  await getDb().delete(billingCustomers).where(eq(billingCustomers.userId, actor.userId));
}

/** Whether Stripe's answer was "there is no such thing", which here is success. */
function isMissingStripeResource(error: unknown): boolean {
  const code = (error as { code?: unknown; statusCode?: unknown } | null)?.code;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return code === "resource_missing" || status === 404;
}

/**
 * How stale a stored subscription may get before the sweep re-reads it.
 *
 * Stripe retries a failed delivery for up to 72 hours, so anything shorter than
 * that is asking Stripe a question it is already answering. Twelve hours is
 * inside that window on purpose: the case this exists for is not a delivery
 * Stripe is still retrying but one it has given up on, or one that never
 * arrived because the endpoint was misconfigured while it happened.
 */
const BILLING_SYNC_STALE_HOURS = 12;

/**
 * How many subscriptions one sweep re-reads.
 *
 * Each is a network call, so this is a rate as much as a cap: fifty per tick at
 * the default five-minute interval is a deployment of any size caught up within
 * a day, without a restart after an outage turning into a burst at Stripe.
 */
const BILLING_SWEEP_MAX = 50;

export type BillingSweepSummary = {
  readonly examined: number;
  readonly written: number;
  readonly failed: number;
  readonly capped: boolean;
  /** True when the deployment sells nothing, which is the default. */
  readonly skipped: boolean;
};

/**
 * Re-reads subscriptions nothing has heard about lately.
 *
 * The safety net under the webhook, not a replacement for it: a delivery that
 * never arrived leaves a row saying somebody is subscribed long after they
 * stopped paying, or the reverse, and nothing else would ever notice. Stripe is
 * the authority, so the repair is simply to ask it again.
 *
 * Actor-less, like the two sweeps beside it. There is no request and no session
 * — the work is "every stale row in the deployment" — so `services.md` 1.1 names
 * it in the table of entry points that take no actor rather than leaving it as
 * an exception somebody has to notice.
 *
 * Returns without touching the database when no Stripe is configured, which is
 * the default: the cost of this feature to a deployment that never enabled it
 * is one function call per tick, the same bargain `runDueNotifications` strikes
 * with mail.
 */
export async function runBillingReconciliation(
  stopped: () => boolean = () => false,
): Promise<BillingSweepSummary> {
  if (!getConfig().billing) {
    return { examined: 0, written: 0, failed: 0, capped: false, skipped: true };
  }

  const staleBefore = new Date(Date.now() - BILLING_SYNC_STALE_HOURS * 60 * 60 * 1000);
  const rows = await getDb()
    .select({
      userId: billingSubscriptions.userId,
      stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId,
    })
    .from(billingSubscriptions)
    .where(
      and(
        lt(billingSubscriptions.syncedAt, staleBefore),
        inArray(billingSubscriptions.status, [...liveStatuses]),
      ),
    )
    // Oldest first, so a backlog drains in the order it fell behind rather than
    // leaving the same few rows unread every tick.
    .orderBy(billingSubscriptions.syncedAt)
    .limit(BILLING_SWEEP_MAX);

  let examined = 0;
  let written = 0;
  let failed = 0;
  for (const row of rows) {
    if (stopped()) break;
    examined += 1;
    try {
      // One at a time rather than in parallel. These are network calls to one
      // vendor, and fanning fifty of them out at once is how a sweep turns a
      // restart into rate limiting. `no-await-in-loop` is off in this
      // repository, and this is one of the loops it is off for.
      const snapshot = await fetchSubscriptionSnapshot(row.stripeSubscriptionId);
      if ((await reconcileSubscription(row.userId, snapshot)) === "written") written += 1;
    } catch (error) {
      // Counted and carried on. One subscription Stripe cannot answer about
      // must not stop the forty-nine behind it, and the next sweep will find
      // this row still stale and try again.
      failed += 1;
      log.warn("billing.reconcile.failed", { error: String(error) });
    }
  }

  return { examined, written, failed, capped: rows.length === BILLING_SWEEP_MAX, skipped: false };
}

/**
 * Pins a card somebody saved, from Stripe's own delivery.
 *
 * The same work `confirmPaymentSetup` does, reached the other way. Both exist
 * because neither is sufficient alone: the request path fails when a 3-D Secure
 * redirect lands somewhere the browser never comes back from, and the delivery
 * fails when a deployment's Stripe endpoint is not subscribed to
 * `setup_intent.succeeded` — which is dashboard configuration this repository
 * cannot see.
 *
 * Doing it twice is harmless: pinning the same card again is the same state.
 * The event is still claimed, so Stripe's retries stop after the first.
 *
 * Actor-less like the rest of the webhook path — the delivery names a customer,
 * and the person was resolved from it before this was called.
 */
export async function applySetupIntentSucceeded(
  userId: string,
  event: {
    readonly id: string;
    readonly type: string;
    readonly data: { readonly object: unknown };
  },
): Promise<"written" | "duplicate" | "ignored"> {
  const object = event.data.object as Record<string, unknown> | null;
  const setupIntentId = object && typeof object["id"] === "string" ? object["id"] : null;
  if (!setupIntentId) return "ignored";

  // Re-read rather than trusting the payload, for the reason the subscription
  // path re-reads: a delivery says what happened at some point, and only a
  // fresh read says what is true now.
  const intent = await fetchStripeSetupIntent(setupIntentId);
  if (intent.status !== "succeeded" || !intent.paymentMethodId || !intent.customerId) {
    return "ignored";
  }

  const claimed = await withTransaction(undefined, async (tx) =>
    claimWebhookEvent(event.id, event.type, tx),
  );
  if (!claimed) return "duplicate";

  const [row] = await getDb()
    .select({ stripeSubscriptionId: billingSubscriptions.stripeSubscriptionId })
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.userId, userId),
        inArray(billingSubscriptions.status, [...liveStatuses]),
      ),
    )
    .orderBy(billingSubscriptions.syncedAt)
    .limit(1);

  await setStripeDefaultPaymentMethod(
    {
      customerId: intent.customerId,
      subscriptionId: row?.stripeSubscriptionId ?? null,
      paymentMethodId: intent.paymentMethodId,
    },
    `setup:${setupIntentId}`,
  );
  if (row) await resync(userId, row.stripeSubscriptionId);
  return "written";
}

/**
 * Events that change nothing here but that an operator needs to know happened.
 *
 * A refund and a dispute both move money and neither moves an entitlement:
 * Stripe does not change the subscription for either, so there is nothing for
 * the reconciler to read. What there is instead is a decision — whether to
 * keep somebody on the paid plan after charging back a year of it — and that is
 * a person's to make, with `docs/billing-operations.md` to make it from.
 *
 * A dispute that does end the subscription arrives again as a
 * `customer.subscription.updated`, and that is the delivery that acts.
 */
const noteworthyEvents = new Set([
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
]);

// `invoice.payment_failed` is deliberately not in that set, and it is the one
// that looks like it belongs. It names a subscription, so it goes down the
// reconciling path and re-reads it — which is how `past_due` and the grace it
// starts get recorded at all. Noting it here instead would have made a failed
// renewal a log line and nothing else.

export function isNoteworthyEvent(type: string): boolean {
  return noteworthyEvents.has(type);
}

/**
 * Forgets a Stripe customer that Stripe no longer has.
 *
 * Deleting a customer in Stripe's dashboard cancels everything it owns, and
 * those cancellations arrive as their own deliveries, so the subscriptions look
 * after themselves. What is left is the mapping, which now points at nothing:
 * kept, it would make the next attempt to subscribe fail against a customer
 * Stripe has deleted, and there is no way back from that without a database
 * edit. Dropped, the next attempt makes a new customer and works.
 *
 * Actor-less for the same reason the rest of the webhook path is: the delivery
 * names a customer, and this is the lookup that would have found a person.
 */
async function forgetStripeCustomer(
  stripeCustomerId: string,
  transaction?: DbTransaction,
): Promise<string | null> {
  return withTransaction(transaction, async (tx) => {
    const removed = await tx
      .delete(billingCustomers)
      .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
      .returning({ userId: billingCustomers.userId });
    return removed[0]?.userId ?? null;
  });
}

/**
 * Claims a `customer.deleted` delivery and drops the mapping, in one
 * transaction — the same pairing, and for the same reason, as the subscription
 * path beside it.
 */
export async function applyCustomerDeletion(
  stripeCustomerId: string,
  event: { readonly id: string; readonly type: string },
  transaction?: DbTransaction,
): Promise<"written" | "duplicate" | "unknown"> {
  return withTransaction(transaction, async (tx) => {
    if (!(await claimWebhookEvent(event.id, event.type, tx))) return "duplicate";
    const userId = await forgetStripeCustomer(stripeCustomerId, tx);
    if (!userId) return "unknown";

    // And close what the customer owned, in the same transaction. Deleting a
    // customer cancels its subscriptions and Stripe sends a delivery for each —
    // but those name the customer that has just stopped existing here, so
    // `userForStripeCustomer` answers null and they are acknowledged without
    // being acted on. Waiting for them would leave somebody on `active`
    // forever, entitled to a plan nobody is paying for and invisible to the
    // sweep, which only re-reads rows it can still resolve.
    await tx
      .update(billingSubscriptions)
      .set({ status: "canceled", cancelAtPeriodEnd: false, updatedAt: new Date() })
      .where(
        and(
          eq(billingSubscriptions.userId, userId),
          inArray(billingSubscriptions.status, [...liveStatuses]),
        ),
      );
    return "written";
  });
}

/**
 * The ad slots this person should be shown, or null for no ads at all.
 *
 * The decision is made here and never in the browser, and that is the whole
 * design. A client-side gate has to be written the right way round — show an ad
 * where a *limited* plan is in force, never as the inverse of "is on Plus" —
 * and it has to wait for an entitlement that arrives a round trip after first
 * paint. Both are easy to get wrong, and both fail towards showing an ad to
 * somebody who is paying.
 *
 * Deciding on the server removes the question. A subscriber's session simply
 * carries no ad configuration, so the browser has nothing to render a slot
 * from: it cannot show an ad to a paying customer by mistake, because it was
 * never told how. Absent reads as "no ads", which is the direction a bug here
 * should fail in.
 *
 * Three conditions, and the middle one is the subtle one:
 *
 *  - Ads are configured at all. Nothing to show otherwise.
 *  - A *limited* plan is in force. `{ billing: false }` means unrestricted —
 *    it is what a deployment that sells nothing returns, and also what a
 *    deployment that has *stopped* selling returns while its subscribers go on
 *    being charged at Stripe. Nobody in either state is on a limited plan, so
 *    nobody in either state is shown an ad. Reading this as "not on Plus" would
 *    put ads in front of every paying subscriber on a wound-down deployment.
 *  - The plan is the free one. An operator override to Plus counts, because
 *    `resolveEntitlement` has already folded it in.
 */
export async function getAdPlacement(actor: Actor): Promise<AdPlacement | null> {
  const ads = getConfig().ads;
  if (!ads) return null;
  const entitlement = await getEntitlement(actor);
  if (!entitlement.billing || entitlement.plan !== "free") return null;
  return {
    clientId: ads.clientId,
    bannerSlotId: ads.bannerSlotId,
    ...(ads.footerSlotId ? { footerSlotId: ads.footerSlotId } : {}),
    consentManaged: ads.consentManaged,
  };
}

/**
 * What the browser needs to render an ad, and nothing else.
 *
 * The publisher id is per-operator configuration that has to reach a bundle
 * built once and shipped as an image, so it travels at runtime on a response
 * rather than being compiled in. A build-time define would bake one operator's
 * id — or nobody's — into the image every deployment then serves, which is the
 * difference between an operator being paid and not.
 */
export type AdPlacement = {
  readonly clientId: string;
  readonly bannerSlotId: string;
  readonly footerSlotId?: string;
  /** False unless an operator asserted they have a consent platform. */
  readonly consentManaged: boolean;
};

/**
 * Whether deleting this account would cancel something somebody is paying for.
 *
 * Read for the deletion confirmation, which otherwise lists what is destroyed
 * without naming the one item that costs money: the subscription goes with the
 * account, immediately, and nothing brings a canceled one back.
 *
 * False without a word to Stripe when no Stripe is configured, which is the
 * default — the confirmation must not become a network call for a deployment
 * that sells nothing.
 */
export async function hasLiveSubscription(actor: Actor): Promise<boolean> {
  if (!getConfig().billing) return false;
  return (await currentSubscription(actor)) !== null;
}
