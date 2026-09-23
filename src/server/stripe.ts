import Stripe from "stripe";
import { getConfig, stripeMode } from "./config.js";
import { log } from "./log.js";
import { stripeDuration, stripeRequests } from "./metrics.js";

/**
 * The only module in this product that talks to Stripe.
 *
 * One module rather than a client passed around, for the same reason
 * `src/server/mail.ts` owns the transport: the promise in
 * `docs/standards/operations.md` is that this server opens no connection
 * nobody configured, and a promise like that is only worth making if somebody
 * can check it. A grep for `from "stripe"` answers it in one line.
 *
 * Everything here assumes the caller has already asked `stripeConfigured()`.
 * A deployment that sells nothing never reaches this file at all.
 */
let client: Stripe | undefined;

/**
 * How long to wait on Stripe before giving up.
 *
 * The SDK's own default is eighty seconds, which is a sensible number for a
 * batch script and a very poor one on a request path: a person pressing Upgrade
 * would watch a spinner for well over a minute before being told anything, and
 * the connection this request is holding would be held for all of it. Ten
 * seconds is longer than Stripe's own published latency by a wide margin, and
 * short enough that a failure is reported rather than endured.
 */
const STRIPE_TIMEOUT_MS = 10_000;

export function getStripe(): Stripe {
  if (!client) {
    const { billing } = getConfig();
    if (!billing) {
      // Reached only by a caller that skipped `stripeConfigured()`, which is a
      // programming mistake rather than a misconfiguration: the deployment is
      // fine, the code asked the wrong question.
      throw new Error("Stripe is not configured on this deployment");
    }
    client = new Stripe(billing.secretKey, {
      // The API version is deliberately not set here. The SDK pins one of its
      // own, and passing a different string is how a payload shape and the
      // types describing it come to disagree: upgrading the package would then
      // change nothing until somebody remembered this line. `stripe@22.6.2`
      // pins `2026-08-26.dahlia`, and the webhook endpoint in the dashboard is
      // set to match it.
      timeout: STRIPE_TIMEOUT_MS,
      // Safe because every mutating call in this product carries an explicit
      // idempotency key, so a retried POST is the same POST to Stripe rather
      // than a second one.
      maxNetworkRetries: 2,
      // Off, and this is the line that matters most in this file. The SDK
      // enables it by default and reports request timings back to Stripe. It is
      // harmless and it is also a connection nobody asked for, which is the one
      // thing `operations.md` promises this server does not make.
      telemetry: false,
    });
  }
  return client;
}

/**
 * Every outbound call, counted and timed in one place.
 *
 * At the seam rather than in the services, which is `observability.md` 1.7 and
 * also the only arrangement that stays true: a call added to this file without
 * going through here is visible in review as the one line that looks different,
 * whereas a service that forgot to count looks like every other service.
 *
 * The operation name is a constant from this file, never anything from the
 * request, so the label set is closed and no identifier can leak into it.
 */
async function measured<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const stop = stripeDuration.startTimer({ operation });
  try {
    const result = await run();
    stripeRequests.inc({ operation, outcome: "ok" });
    return result;
  } catch (error) {
    stripeRequests.inc({ operation, outcome: "failed" });
    throw error;
  } finally {
    stop();
  }
}

/** Dropped between tests, and by nothing else. */
export function resetStripeClient() {
  client = undefined;
  priceCache = undefined;
  priceCheck = undefined;
  reportedPriceCheck = undefined;
}

/**
 * Whether Stripe's answer was "there is no such thing".
 *
 * Here rather than in the service because more than one caller has to tell it
 * apart from every other failure, and the distinction is Stripe's: a
 * `resource_missing` is a definite answer about one object, while a timeout or
 * a 500 says nothing about it at all.
 */
export function isMissingStripeResource(error: unknown): boolean {
  const code = (error as { code?: unknown; statusCode?: unknown } | null)?.code;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return code === "resource_missing" || status === 404;
}

/**
 * Turns a delivery into an event, or refuses it.
 *
 * The signature is checked against the raw bytes rather than a re-serialized
 * object, because re-serializing changes whitespace and key order and the
 * signature covers neither. Stripe's own verifier is used rather than a hand
 * rolled HMAC: it carries the timestamp tolerance that stops a captured request
 * being replayed a week later, and getting that wrong is silent.
 */
export function stripeEventFrom(rawBody: string, signature: string | undefined): Stripe.Event {
  const { billing } = getConfig();
  if (!billing) throw new Error("Stripe is not configured on this deployment");
  if (!signature) throw new Error("Stripe-Signature header is missing");
  return getStripe().webhooks.constructEvent(rawBody, signature, billing.webhookSecret);
}

/**
 * Reads a subscription from Stripe, as this product stores it.
 *
 * Re-read rather than taken from the delivery, which is what makes the webhook
 * a reconciler rather than an applier: Stripe guarantees no ordering between
 * deliveries and two events can describe one change, so the payload says what
 * happened at some point and only a fresh read says what is true now.
 *
 * `syncedAt` is stamped here, at the moment of the read, because that is the
 * ordering the stored row is compared against.
 */
export type StripeSnapshot = {
  stripeSubscriptionId: string;
  status: string;
  priceId: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPriceId: string | null;
  scheduledAt: Date | null;
  syncedAt: Date;
  stripeCustomerId: string | null;
};

/** The price id on a phase item, whichever of the two shapes Stripe sent. */
function phasePriceId(phase: Stripe.SubscriptionSchedule.Phase | undefined): string | null {
  const price = phase?.items?.[0]?.price;
  if (typeof price === "string") return price;
  return price?.id ?? null;
}

/**
 * A price change that has been agreed and has not happened yet.
 *
 * Read off the schedule rather than stored when it is arranged, because a
 * schedule can also be changed or released in Stripe's own dashboard, and a
 * column written only by this product would then describe a plan nobody is on.
 * Null when no schedule governs the subscription, which is the ordinary case.
 */
function pendingPhase(schedule: unknown, now: Date): { priceId: string; startsAt: Date } | null {
  const phases = (schedule as Stripe.SubscriptionSchedule | null)?.phases;
  if (!phases) return null;
  for (const phase of phases) {
    const startsAt = new Date(phase.start_date * 1000);
    if (startsAt <= now) continue;
    const priceId = phasePriceId(phase);
    if (priceId) return { priceId, startsAt };
  }
  return null;
}

/** Turns a Stripe subscription into the row this product stores. */
export function snapshotOfSubscription(
  subscription: Stripe.Subscription,
  syncedAt: Date,
): StripeSnapshot {
  const item = subscription.items?.data?.[0];
  // Stripe moved the period boundary off the subscription and onto its items.
  // Read the item first and fall back, because an account still on an older API
  // version sends the other shape and a missing boundary silently becomes "no
  // grace" for a failed renewal.
  const periodEnd =
    item?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end ??
    null;
  const customer = subscription.customer;
  const pending = pendingPhase(subscription.schedule, syncedAt);
  return {
    stripeSubscriptionId: subscription.id,
    status: subscription.status,
    priceId: item?.price?.id ?? "",
    currentPeriodEnd: periodEnd === null ? null : new Date(periodEnd * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    scheduledPriceId: pending?.priceId ?? null,
    scheduledAt: pending?.startsAt ?? null,
    syncedAt,
    stripeCustomerId: typeof customer === "string" ? customer : (customer?.id ?? null),
  };
}

/**
 * Reads a subscription from Stripe, as this product stores it.
 *
 * Re-read rather than taken from the delivery, which is what makes the webhook
 * a reconciler rather than an applier: Stripe guarantees no ordering between
 * deliveries and two events can describe one change, so the payload says what
 * happened at some point and only a fresh read says what is true now.
 *
 * `syncedAt` is stamped here, at the moment of the read, because that is the
 * ordering the stored row is compared against.
 */
export async function fetchSubscriptionSnapshot(
  stripeSubscriptionId: string,
): Promise<StripeSnapshot> {
  const subscription = await measured("subscription.retrieve", () =>
    getStripe().subscriptions.retrieve(stripeSubscriptionId, {
      // The schedule comes back as an id otherwise, and a second round trip to
      // turn it into phases would be one more chance to fail on a webhook path.
      expand: ["schedule"],
    }),
  );
  return snapshotOfSubscription(subscription, new Date());
}

/**
 * The secret the browser needs to finish a payment, dug out of an invoice.
 *
 * Stripe removed `Invoice.payment_intent` outright in API version
 * `2025-03-31.basil` — it was not renamed, it went — and replaced it with
 * `confirmation_secret`. Anything written against the old field fails rather
 * than degrading, which is why this reads the new one and says so.
 */
function confirmationSecretOf(invoice: unknown): string | null {
  const secret = (invoice as { confirmation_secret?: { client_secret?: unknown } } | null)
    ?.confirmation_secret?.client_secret;
  return typeof secret === "string" ? secret : null;
}

/** Creates the Stripe customer for somebody who has never had one. */
export async function createStripeCustomer(
  input: {
    readonly email: string;
    readonly name: string;
    readonly userId: string;
  },
  idempotencyKey: string,
): Promise<string> {
  const customer = await measured("customer.create", () =>
    getStripe().customers.create(
      {
        email: input.email,
        name: input.name,
        // The only identifier that crosses to Stripe, and it is this product's
        // own opaque id rather than anything about the person: it is what an
        // operator needs to tie a dashboard row back to an account, and it says
        // nothing a support agent could not already see.
        metadata: { simpleBalanceUserId: input.userId },
      },
      { idempotencyKey },
    ),
  );
  return customer.id;
}

/**
 * Starts a subscription that is not paid for yet.
 *
 * `default_incomplete` is what makes the first payment the browser's job and
 * this server's authority: the subscription exists but grants nothing until
 * Stripe reports the invoice paid, so a client that claims success cannot
 * create one.
 */
export async function createStripeSubscription(
  input: { readonly customerId: string; readonly priceId: string },
  idempotencyKey: string,
): Promise<{ subscriptionId: string; clientSecret: string | null; snapshot: StripeSnapshot }> {
  const subscription = await measured("subscription.create", () =>
    getStripe().subscriptions.create(
      {
        customer: input.customerId,
        items: [{ price: input.priceId }],
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        expand: ["latest_invoice.confirmation_secret"],
      },
      { idempotencyKey },
    ),
  );
  return {
    subscriptionId: subscription.id,
    clientSecret: confirmationSecretOf(subscription.latest_invoice),
    // What was just made, for the caller to store while it still holds the
    // lock: a new subscription has no schedule, so the unexpanded one reads
    // as none, which is true.
    snapshot: snapshotOfSubscription(subscription, new Date()),
  };
}

/**
 * Moves a subscription onto the other price now, charging the difference.
 *
 * The item id is passed as well as the price, and leaving it out is the bug
 * this comment exists to prevent: Stripe reads an item with no id as a new one
 * and *adds* a second price rather than replacing the first, so the person ends
 * up billed monthly and annually at once.
 *
 * Used for the upgrade direction only — monthly to annual — where charging the
 * difference immediately is what the person asked for. The other direction goes
 * through a schedule, because taking a year's money and then halving the term
 * would be a refund nobody agreed to.
 */
export async function switchStripeSubscriptionNow(
  input: {
    readonly subscriptionId: string;
    readonly itemId: string;
    readonly priceId: string;
  },
  idempotencyKey: string,
) {
  await measured("subscription.update", () =>
    getStripe().subscriptions.update(
      input.subscriptionId,
      {
        items: [{ id: input.itemId, price: input.priceId }],
        proration_behavior: "create_prorations",
        // `billing_cycle_anchor: "now"` is what bills the difference on the
        // spot rather than parking it on the next invoice: the person is
        // upgrading in order to be upgraded, and an unpaid balance sitting
        // until renewal is a surprise either way. It also resets the renewal
        // date to today, which is the honest thing when the term changes.
        //
        // `allow_incomplete` has been the API default since 2019-03-14 and is
        // named rather than assumed: it decides what happens when the charge
        // *cannot* be collected — the subscription goes `past_due` and the
        // delivery for it brings the person back here to pay — rather than
        // deciding whether to charge at all.
        payment_behavior: "allow_incomplete",
        billing_cycle_anchor: "now",
      },
      { idempotencyKey },
    ),
  );
}

/**
 * Arranges for a subscription to move onto another price at its next renewal.
 *
 * A Subscription Schedule rather than an update, because an update takes effect
 * against the current period however the proration is spelled: somebody who
 * paid for a year and asks to go monthly would lose the rest of the year they
 * bought. The schedule keeps the paid phase exactly as it is and puts the new
 * price in a phase that starts when it ends.
 *
 * `end_behavior: "release"` lets the subscription carry on by itself once the
 * new phase has run, which is what makes this a one-time change of price rather
 * than a fixed-term plan that stops.
 */
export async function scheduleStripeSubscriptionPrice(
  input: {
    readonly subscriptionId: string;
    readonly priceId: string;
    readonly interval: "month" | "year";
  },
  idempotencyKey: string,
): Promise<string> {
  const stripe = getStripe();
  const schedule = await measured("schedule.create", () =>
    stripe.subscriptionSchedules.create(
      { from_subscription: input.subscriptionId },
      { idempotencyKey },
    ),
  );
  const current = schedule.phases[0];
  if (!current) throw new Error("Stripe returned a subscription schedule with no phases");

  // Stripe replaces a phase with exactly what is sent — anything previously set
  // and not repeated is unset — and none of these fall back to the schedule's
  // `default_settings` the way the collection method and the payment method do.
  // So the current phase has to be handed back whole. Leaving a field out
  // silently reprices a period somebody has already paid for: an operator's
  // dashboard coupon vanishes, a granted trial ends in a charge, and a tax rate
  // stops being applied.
  const idOf = (value: string | { readonly id: string } | null | undefined) =>
    typeof value === "string" ? value : (value?.id ?? null);
  type DiscountRef = {
    readonly coupon?: string | { readonly id: string } | null;
    readonly discount?: string | { readonly id: string } | null;
    readonly promotion_code?: string | { readonly id: string } | null;
  };
  // The existing discount object where there is one, rather than its coupon:
  // a discount carries how much of its duration is left, and naming the coupon
  // afresh starts it over.
  type DiscountParam = { discount?: string; coupon?: string; promotion_code?: string };
  const carry = (discounts: readonly DiscountRef[]): DiscountParam[] =>
    discounts.flatMap<DiscountParam>((d) => {
      const discount = idOf(d.discount);
      if (discount) return [{ discount }];
      const coupon = idOf(d.coupon);
      if (coupon) return [{ coupon }];
      const promotionCode = idOf(d.promotion_code);
      return promotionCode ? [{ promotion_code: promotionCode }] : [];
    });
  const discounts = current.discounts?.length ? carry(current.discounts) : null;

  const updated = await measured("schedule.update", () =>
    stripe.subscriptionSchedules.update(
      schedule.id,
      {
        phases: [
          {
            items: (current.items ?? []).map((item) => ({
              price: typeof item.price === "string" ? item.price : item.price.id,
              quantity: item.quantity ?? 1,
              ...(item.discounts?.length ? { discounts: carry(item.discounts) } : {}),
              ...(item.tax_rates?.length
                ? { tax_rates: item.tax_rates.map((rate) => rate.id) }
                : {}),
              ...(item.metadata ? { metadata: item.metadata } : {}),
            })),
            start_date: current.start_date,
            end_date: current.end_date,
            ...(discounts ? { discounts } : {}),
            ...(current.default_tax_rates?.length
              ? { default_tax_rates: current.default_tax_rates.map((rate) => rate.id) }
              : {}),
            ...(current.trial_end === null ? {} : { trial_end: current.trial_end }),
            ...(current.metadata ? { metadata: current.metadata } : {}),
          },
          {
            items: [{ price: input.priceId, quantity: 1 }],
            // The discount belongs to the person, not to the interval they were
            // on. Left out here it would end at the very renewal this downgrade
            // lands on, which is not something anybody asked for.
            ...(discounts ? { discounts } : {}),
            // One billing period of the new price, spelled as a duration because
            // the update call has no `iterations` — that field exists only when a
            // schedule is created from scratch, and the two parameter shapes are
            // easy to confuse.
            duration: { interval: input.interval, interval_count: 1 },
          },
        ],
        end_behavior: "release",
      },
      // A distinct key from the create above: Stripe scopes a key to one
      // request, and reusing it here would replay the creation's response
      // instead of making this change. Named for the schedule as well, so one
      // key is never spent on two schedules whatever key the caller hands in:
      // updating another schedule is a different endpoint, which Stripe
      // refuses under a key it has already seen.
      { idempotencyKey: `${idempotencyKey}:phases:${schedule.id}` },
    ),
  );
  return updated.id;
}

/**
 * Abandons a scheduled price change, leaving the subscription as it is.
 *
 * Released, never canceled. `subscription_schedules.cancel` cancels the
 * *subscription* the schedule governs, so the two calls differ by one word and
 * by whether the person is still a customer afterward.
 */
export async function releaseStripeSchedule(scheduleId: string, idempotencyKey: string) {
  await measured("schedule.release", () =>
    getStripe().subscriptionSchedules.release(scheduleId, undefined, {
      idempotencyKey,
    }),
  );
}

/** The schedule governing a subscription, if one does. */
export async function stripeScheduleFor(subscriptionId: string): Promise<string | null> {
  const subscription = await measured("subscription.retrieve", () =>
    getStripe().subscriptions.retrieve(subscriptionId),
  );
  const schedule = subscription.schedule;
  if (typeof schedule === "string") return schedule;
  return schedule?.id ?? null;
}

/**
 * Ends a subscription now, rather than at the end of its period.
 *
 * The one place this product cancels immediately, and it is reserved for a
 * subscription that was never paid for: somebody who chose annual, did not
 * complete the payment, and has now chosen monthly. The unpaid subscription has
 * to go before another can be made, because a person is meant to have one.
 *
 * Canceling voids the open invoice, so nobody is charged for the plan they
 * changed their mind about. Never call this on a subscription that has been
 * paid for — `setStripeCancelAtPeriodEnd` is that, and the difference is
 * whether somebody loses days they bought.
 */
export async function cancelStripeSubscriptionNow(subscriptionId: string, idempotencyKey: string) {
  await measured("subscription.cancel", () =>
    getStripe().subscriptions.cancel(subscriptionId, undefined, { idempotencyKey }),
  );
}

/** Sets or clears a pending cancellation. Never cancels immediately. */
export async function setStripeCancelAtPeriodEnd(
  subscriptionId: string,
  cancelAtPeriodEnd: boolean,
  idempotencyKey: string,
) {
  await measured("subscription.update", () =>
    getStripe().subscriptions.update(
      subscriptionId,
      { cancel_at_period_end: cancelAtPeriodEnd },
      { idempotencyKey },
    ),
  );
}

/**
 * A secret the browser uses to attach a new card without one reaching here.
 *
 * The id comes back beside the secret, and it is needed: confirming a
 * SetupIntent attaches a payment method to the *customer* and stops there.
 * Nothing about it tells Stripe which card to bill, so the id is how the
 * caller finds the attached method afterward and says so.
 */
export async function createStripeSetupIntent(
  customerId: string,
  idempotencyKey: string,
): Promise<{ id: string; clientSecret: string | null }> {
  const intent = await measured("setup_intent.create", () =>
    getStripe().setupIntents.create(
      { customer: customerId, usage: "off_session" },
      { idempotencyKey },
    ),
  );
  return { id: intent.id, clientSecret: intent.client_secret };
}

/**
 * What a SetupIntent came to, read back from Stripe rather than from a client.
 *
 * Re-read for the same reason the webhook re-reads a subscription: the browser
 * says a card was saved, and the browser is not the authority on that. The
 * customer comes back too, so the caller can check the intent belongs to the
 * person asking before pinning anything to their subscription.
 */
export async function fetchStripeSetupIntent(setupIntentId: string): Promise<{
  status: string;
  customerId: string | null;
  paymentMethodId: string | null;
  /**
   * When the intent's own card was saved, which is what tells a late delivery
   * from a current one — compared with the card Stripe bills now, card to
   * card. Not the intent's `created`: an intent opened in one tab and
   * confirmed after another tab had already saved and pinned a card holds the
   * newer card of the two, and dating it by the intent called it the older.
   * The intent's own date stands in only where Stripe sent the card as a bare
   * id, which an expanded read does not; a card is saved no earlier than the
   * intent that saved it, so that is the earliest it can be.
   */
  paymentMethodCreated: Date;
}> {
  const intent = await measured("setup_intent.retrieve", () =>
    getStripe().setupIntents.retrieve(setupIntentId, {
      // Expanded in the same read, for `created`: a second round trip for the
      // card would be one more chance to fail on a webhook path.
      expand: ["payment_method"],
    }),
  );
  const customer = intent.customer;
  const method = intent.payment_method;
  return {
    status: intent.status,
    customerId: typeof customer === "string" ? customer : (customer?.id ?? null),
    paymentMethodId: typeof method === "string" ? method : (method?.id ?? null),
    paymentMethodCreated: new Date(
      (method && typeof method !== "string" ? method.created : intent.created) * 1000,
    ),
  };
}

/**
 * The card Stripe bills now, and when that card was saved.
 *
 * The subscription's own `default_payment_method` first, because it outranks
 * the customer's and is the one dunning retries. The customer's
 * `invoice_settings.default_payment_method` is the fallback Stripe bills for a
 * subscription carrying none, and it is the one `setStripeDefaultPaymentMethod`
 * writes on every pin — including a pin made while there was no subscription
 * to update. Expanded in the same read, because `created` is the whole point
 * and a second round trip per card would be one more chance to fail on a
 * webhook path.
 */
export async function currentStripeDefaultPaymentMethod(input: {
  readonly customerId: string;
  readonly subscriptionId: string | null;
}): Promise<{ id: string; created: Date } | null> {
  const subscriptionId = input.subscriptionId;
  if (subscriptionId) {
    const subscription = await measured("subscription.retrieve", () =>
      getStripe().subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method"] }),
    );
    const method = subscription.default_payment_method;
    if (method && typeof method !== "string") {
      return { id: method.id, created: new Date(method.created * 1000) };
    }
  }
  const customer = await measured("customer.retrieve", () =>
    getStripe().customers.retrieve(input.customerId, {
      expand: ["invoice_settings.default_payment_method"],
    }),
  );
  if (customer.deleted) return null;
  const method = customer.invoice_settings?.default_payment_method;
  if (method && typeof method !== "string") {
    return { id: method.id, created: new Date(method.created * 1000) };
  }
  return null;
}

/**
 * Whether Stripe still has a customer this deployment has mapped somebody to.
 *
 * Three answers rather than a boolean, because the two ways of not having one
 * are not the same fact. `deleted` is this account saying the customer existed
 * and was removed — `customer.deleted` normally tells us, and this is the same
 * news arriving the other way. `missing` is this key being unable to see the
 * customer at all, which is what a test-mode customer looks like to a live key,
 * and also what every customer looks like to a key for the wrong account. The
 * caller has to tell those two apart before acting on it, and cannot from here.
 *
 * Anything else — a timeout, a 500, a refused key — is thrown, because it says
 * nothing about the customer and treating it as absence would replace a real
 * mapping on a bad afternoon.
 */
export async function stripeCustomerStanding(
  customerId: string,
): Promise<"present" | "deleted" | "missing"> {
  try {
    const customer = await measured("customer.retrieve", () =>
      getStripe().customers.retrieve(customerId),
    );
    return customer.deleted ? "deleted" : "present";
  } catch (error) {
    if (isMissingStripeResource(error)) return "missing";
    throw error;
  }
}

/**
 * Makes a card the one Stripe actually bills.
 *
 * Two writes, and both are needed. The subscription's own
 * `default_payment_method` outranks the customer's, so setting only the
 * customer leaves dunning retrying the card that already failed — which is the
 * whole reason somebody pressed Replace card. Setting only the subscription
 * leaves the next subscription they start on the old card.
 *
 * `save_default_payment_method: "on_subscription"` does not cover this: Stripe
 * applies that when a payment *succeeds*, and a SetupIntent pays nothing.
 *
 * Distinct idempotency keys, because Stripe scopes a key to one request and the
 * second call would otherwise replay the first one's answer.
 */
export async function setStripeDefaultPaymentMethod(
  input: {
    readonly customerId: string;
    readonly subscriptionId: string | null;
    readonly paymentMethodId: string;
  },
  idempotencyKey: string,
) {
  await measured("customer.update", () =>
    getStripe().customers.update(
      input.customerId,
      { invoice_settings: { default_payment_method: input.paymentMethodId } },
      { idempotencyKey: `${idempotencyKey}:customer` },
    ),
  );
  const subscriptionId = input.subscriptionId;
  if (!subscriptionId) return;
  await measured("subscription.update", () =>
    getStripe().subscriptions.update(
      subscriptionId,
      { default_payment_method: input.paymentMethodId },
      { idempotencyKey: `${idempotencyKey}:subscription` },
    ),
  );
}

/**
 * Pays a subscription's open invoice with whatever card is now the default.
 *
 * Called after a replacement card is pinned, so "replacing the card fixes it
 * right away" is true rather than "at Stripe's next retry, which may be days
 * away and may be after the grace has run out". Failure is not the caller's
 * problem: the card is attached either way and Stripe will retry on its own.
 */
export async function payStripeInvoice(invoiceId: string, idempotencyKey: string) {
  await measured("invoice.pay", () => getStripe().invoices.pay(invoiceId, {}, { idempotencyKey }));
}

/** The open invoice on a subscription, if it has one. */
export async function openStripeInvoiceFor(subscriptionId: string): Promise<string | null> {
  const subscription = await measured("subscription.retrieve", () =>
    getStripe().subscriptions.retrieve(subscriptionId),
  );
  const invoice = subscription.latest_invoice;
  const id = typeof invoice === "string" ? invoice : (invoice?.id ?? null);
  if (!id) return null;
  const latest = await measured("invoice.retrieve", () => getStripe().invoices.retrieve(id));
  return latest.status === "open" ? id : null;
}

/**
 * Deletes a Stripe customer, which cancels everything it owns.
 *
 * One idempotent call rather than a walk of the subscriptions, because the walk
 * has a gap: a subscription created between listing and canceling survives it.
 * Used when somebody deletes their account, where leaving a live subscription
 * behind would go on charging a person who asked to be forgotten.
 */
export async function deleteStripeCustomer(customerId: string) {
  await measured("customer.delete", () => getStripe().customers.del(customerId));
}

/**
 * The secret that finishes a payment somebody started and did not complete.
 *
 * A subscription sits `incomplete` for 23 hours waiting for its first payment,
 * and without this the person is stuck for all of them: pressing the button
 * again asks for the interval they are already on, which is a no-op, and no
 * second subscription may be created for them. Handing back the same secret
 * puts them in front of the same payment form.
 */
export async function fetchSubscriptionClientSecret(
  subscriptionId: string,
): Promise<string | null> {
  const subscription = await measured("subscription.retrieve", () =>
    getStripe().subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice.confirmation_secret"],
    }),
  );
  return confirmationSecretOf(subscription.latest_invoice);
}

/** The subscription item a price change has to name. */
export async function stripeSubscriptionItem(
  subscriptionId: string,
): Promise<{ itemId: string; priceId: string } | null> {
  const subscription = await measured("subscription.retrieve", () =>
    getStripe().subscriptions.retrieve(subscriptionId),
  );
  const item = subscription.items?.data?.[0];
  return item ? { itemId: item.id, priceId: item.price.id } : null;
}

/** What one of the two configured prices costs, in Stripe's own words. */
export type StripePriceFacts = {
  readonly id: string;
  readonly unitAmount: number | null;
  readonly currency: string;
  /**
   * How often Stripe bills it, which is what the plan tab names — "a month",
   * "a year" — rather than which setting the id came from. The two agree when
   * the prices are right, and when they do not the label is the one that would
   * have lied: a swapped pair read "$3.00 a year" off a price billing monthly.
   */
  readonly interval: "month" | "year" | null;
};

/**
 * How long a fetched price is reused before being read again.
 *
 * Most of a Price is immutable in Stripe — changing an amount means pointing
 * the deployment at a different id, which needs a restart anyway. The one thing
 * that does change underneath is whether it is archived, and ten minutes is how
 * long an operator who archives the one being sold waits before the check below
 * notices. It also keeps the plan tab from making two network calls every time
 * somebody opens it.
 */
const PRICE_CACHE_MS = 10 * 60 * 1000;

let priceCache: { readonly at: number; readonly prices: PlanPrices } | undefined;

export type PlanPrices = {
  readonly monthly: StripePriceFacts | null;
  readonly yearly: StripePriceFacts | null;
};

function priceFactsOf(price: Stripe.Price): StripePriceFacts {
  const interval: string | undefined = price.recurring?.interval;
  return {
    id: price.id,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: interval === "month" || interval === "year" ? interval : null,
  };
}

/** The part of a Price the check reads, so the rule can be tested without Stripe. */
export type PriceShape = {
  readonly id: string;
  readonly type: string;
  readonly interval: string | null;
  readonly intervalCount: number | null;
  readonly active: boolean;
  readonly currency: string;
  readonly product: string | null;
  readonly livemode: boolean;
};

function shapeOfPrice(price: Stripe.Price): PriceShape {
  const product = price.product;
  return {
    id: price.id,
    type: price.type,
    interval: price.recurring?.interval ?? null,
    intervalCount: price.recurring?.interval_count ?? null,
    active: price.active,
    currency: price.currency,
    product: typeof product === "string" ? product : (product?.id ?? null),
    livemode: price.livemode,
  };
}

/**
 * Every way the two configured prices do not fit the plans they are sold as.
 *
 * The configuration holds two ids and checks only that each starts `price_`,
 * which is all a string can say. What the ids name is Stripe's to answer, and
 * every mistake below passed that check and started cleanly: swapped ids sell
 * "Annual" at the monthly price, billed every month; a one-time price or one
 * from the other mode makes every subscribe a 500 with the reason only in the
 * log; a price billed every three months is sold as monthly. None of them shows
 * until a customer is charged the wrong amount or cannot be charged at all.
 *
 * Only definite answers are problems. A price that could not be *read* is not
 * one of them — that is Stripe being unreachable, which says nothing about the
 * price — and the caller keeps the previous verdict rather than inventing one.
 *
 * `selling` is here for one rule. An archived price cannot start a
 * subscription, so it is a problem wherever something is for sale — and exactly
 * what an operator winding a deployment down is expected to have done, where
 * nothing is for sale and saying so every ten minutes would be noise.
 *
 * `null` is a price Stripe answered `resource_missing` for, which is the
 * definite form of "wrong id".
 */
export function planPriceProblems(input: {
  readonly monthlyId: string;
  readonly yearlyId: string;
  readonly monthly: PriceShape | null;
  readonly yearly: PriceShape | null;
  readonly keyMode: "live" | "test" | undefined;
  readonly selling: boolean;
}): string[] {
  const problems: string[] = [];
  const slots = [
    ["STRIPE_PRICE_MONTHLY_ID", input.monthlyId, input.monthly, "month", "monthly"],
    ["STRIPE_PRICE_YEARLY_ID", input.yearlyId, input.yearly, "year", "annual"],
  ] as const;
  for (const [name, id, price, interval, plan] of slots) {
    if (!price) {
      problems.push(
        `${name} is ${id}, and Stripe has no such price for this key. A price from the ` +
          "other mode — a test price beside a live key, or the reverse — or from another " +
          "Stripe account is the usual cause.",
      );
      continue;
    }
    if (input.keyMode && price.livemode !== (input.keyMode === "live")) {
      problems.push(
        `${name} is a ${price.livemode ? "live" : "test"}-mode price and ` +
          `STRIPE_SECRET_KEY is a ${input.keyMode} key.`,
      );
    }
    if (price.type !== "recurring") {
      problems.push(
        `${name} is a ${price.type === "one_time" ? "one-time" : price.type} price, and a ` +
          "subscription can only be started on a recurring one.",
      );
      continue;
    }
    if (price.interval !== interval) {
      problems.push(
        `${name} bills every ${price.interval ?? "unknown interval"}, and it is the ${plan} ` +
          "setting. Swapped ids are the usual cause.",
      );
    }
    if (price.intervalCount !== 1) {
      problems.push(
        `${name} bills every ${price.intervalCount ?? "unknown number of"} ` +
          `${price.interval ?? "interval"}s, and the ${plan} plan is sold one ${interval} ` +
          "at a time.",
      );
    }
    if (!price.active && input.selling) {
      problems.push(`${name} is archived at Stripe, and no subscription can start on it.`);
    }
  }
  const { monthly, yearly } = input;
  if (monthly && yearly) {
    // Between the two rather than of either, because each can be a perfectly
    // good price on its own. Moving monthly to annual is an update to one
    // subscription, which Stripe bills in one currency for its whole life; and
    // two products are two plans, where this deployment sells one.
    if (monthly.currency !== yearly.currency) {
      problems.push(
        `STRIPE_PRICE_MONTHLY_ID is in ${monthly.currency.toUpperCase()} and ` +
          `STRIPE_PRICE_YEARLY_ID is in ${yearly.currency.toUpperCase()}. Both plans have ` +
          "to be in one currency, or moving between them changes what somebody pays in.",
      );
    }
    if (monthly.product !== yearly.product) {
      problems.push(
        "STRIPE_PRICE_MONTHLY_ID and STRIPE_PRICE_YEARLY_ID belong to different products " +
          `(${monthly.product ?? "none"} and ${yearly.product ?? "none"}). They are meant ` +
          "to be two prices of one plan.",
      );
    }
  }
  return problems;
}

/**
 * What the last definite read of the two prices found.
 *
 * `confirmedMode` is the other half, and it answers a different question: in
 * which of Stripe's two modes this key found both prices, or null where it did
 * not find both in its own. Finding them is the one piece of evidence in this
 * process that the key belongs to the account the deployment's records came
 * from, and the mode is read off the prices rather than the key's prefix,
 * because a Price says which half it lives in and a key can read only its own
 * half. A caller about to read "no such customer" or "no such subscription" as
 * the object really being gone asks this first — see `missingMeansGone` in the
 * billing service for why only `live` will do.
 */
export type PriceCheck = {
  readonly problems: readonly string[];
  readonly confirmedMode: "live" | "test" | null;
};

/**
 * Undefined until Stripe has answered once. Kept across a failed read rather
 * than cleared, because an unreachable Stripe says nothing new about the prices
 * and forgetting a definite mismatch then would let a sale through it.
 */
let priceCheck: PriceCheck | undefined;
/** The problems last written to the log, so a verdict is said once rather than every refresh. */
let reportedPriceCheck: string | undefined;

/** The verdict `fetchPlanPrices` last reached, or undefined when Stripe has never answered. */
export function lastPriceCheck(): PriceCheck | undefined {
  return priceCheck;
}

function recordPriceCheck(check: PriceCheck) {
  priceCheck = check;
  const summary = check.problems.join(" ");
  if (summary === reportedPriceCheck) return;
  const first = reportedPriceCheck === undefined;
  reportedPriceCheck = summary;
  // An error rather than a warning, and a refusal rather than a warning at the
  // point of sale, because every one of these is money taken wrongly or not at
  // all. Said on the change rather than on every read, which is every ten
  // minutes on a deployment that would otherwise repeat it until somebody
  // stopped reading.
  if (check.problems.length > 0) {
    log.error(
      "The configured Stripe prices do not fit the plans they are sold as, so no " +
        `subscription will be started until they do. ${summary}`,
    );
  } else if (first) {
    log.info("Stripe is configured, and both prices fit the plans they are sold as.");
  } else {
    log.info("The configured Stripe prices fit the plans they are sold as again.");
  }
}

/**
 * The two prices this deployment sells, read from Stripe rather than from the
 * environment, and checked against the plans they are sold as.
 *
 * The environment holds ids, not amounts, and that is deliberate: an amount
 * copied into configuration is a second place for the price to live and the one
 * that does not get charged. A page that showed it would eventually lie.
 *
 * Every refresh is also a check — see `planPriceProblems` — and the verdict is
 * kept for `lastPriceCheck`. A price Stripe says does not exist is an answer
 * rather than a failure: it comes back null and the verdict says why.
 *
 * A failure to reach Stripe is not a failure of the page. The caller still
 * knows which plan somebody is on and what it allows; it just cannot name the
 * amount, so the plan tab catches this and renders without a figure rather
 * than refusing to open.
 */
export async function fetchPlanPrices(): Promise<PlanPrices> {
  const cached = priceCache;
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.prices;
  const { billing } = getConfig();
  if (!billing) throw new Error("Stripe is not configured on this deployment");
  const stripe = getStripe();
  const retrieve = (id: string) =>
    stripe.prices.retrieve(id).catch((error: unknown) => {
      if (isMissingStripeResource(error)) return null;
      throw error;
    });
  const [monthly, yearly] = await measured("price.retrieve", () =>
    Promise.all([retrieve(billing.monthlyPriceId), retrieve(billing.yearlyPriceId)]),
  );
  const monthlyShape = monthly ? shapeOfPrice(monthly) : null;
  const yearlyShape = yearly ? shapeOfPrice(yearly) : null;
  const keyMode = stripeMode(billing.secretKey);
  const inKeyMode = (shape: PriceShape | null): shape is PriceShape =>
    shape !== null && (keyMode === undefined || shape.livemode === (keyMode === "live"));
  // Both found, both in the key's own mode, and both in the same one — which a
  // key of an unrecognized form is not held to by the check above.
  const confirmedMode =
    inKeyMode(monthlyShape) &&
    inKeyMode(yearlyShape) &&
    monthlyShape.livemode === yearlyShape.livemode
      ? monthlyShape.livemode
        ? "live"
        : "test"
      : null;
  recordPriceCheck({
    problems: planPriceProblems({
      monthlyId: billing.monthlyPriceId,
      yearlyId: billing.yearlyPriceId,
      monthly: monthlyShape,
      yearly: yearlyShape,
      keyMode,
      selling: billing.enforcing,
    }),
    confirmedMode,
  });
  const prices = {
    monthly: monthly ? priceFactsOf(monthly) : null,
    yearly: yearly ? priceFactsOf(yearly) : null,
  };
  priceCache = { at: Date.now(), prices };
  return prices;
}

/**
 * Checks the two prices once, for a process starting up.
 *
 * The same rule `checkMailTransport` follows, for the same reason: the ledger
 * is what people came for, and Stripe being unreachable at the moment a
 * container starts is not a reason to keep it from starting. So an unreachable
 * Stripe is a warning and nothing else, and a definite mismatch is an error in
 * the log and a refusal at the point of sale — `setSubscription` asks
 * `lastPriceCheck` before charging anybody — rather than a process that will
 * not start. Neither stops the webhook or the sweep, which serve subscriptions
 * that already exist and do not care what a new one would cost.
 *
 * Returns whether the prices are known to fit, for a caller that wants to say
 * so; nothing depends on the answer.
 */
export async function checkStripePrices(): Promise<boolean> {
  if (!getConfig().billing) return true;
  try {
    await fetchPlanPrices();
  } catch (error) {
    log.warn(
      "Stripe could not be reached to check STRIPE_PRICE_MONTHLY_ID and " +
        "STRIPE_PRICE_YEARLY_ID. Carrying on; they are checked again the next time " +
        "the plan tab is opened and before any subscription is started.",
      String(error),
    );
    return false;
  }
  return priceCheck?.problems.length === 0;
}

/** Dropped between tests, and by nothing else. */
export function resetPlanPriceCache() {
  priceCache = undefined;
}
