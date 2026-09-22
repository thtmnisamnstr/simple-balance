import Stripe from "stripe";
import { getConfig } from "./config.js";
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
): Promise<{ subscriptionId: string; clientSecret: string | null }> {
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
 * new phase has run, which is what makes this a one-off change of price rather
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
      // instead of making this change.
      { idempotencyKey: `${idempotencyKey}:phases` },
    ),
  );
  return updated.id;
}

/**
 * Abandons a scheduled price change, leaving the subscription as it is.
 *
 * Released, never canceled. `subscription_schedules.cancel` cancels the
 * *subscription* the schedule governs, so the two calls differ by one word and
 * by whether the person is still a customer afterwards.
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
 * caller finds the attached method afterwards and says so.
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
}> {
  const intent = await measured("setup_intent.retrieve", () =>
    getStripe().setupIntents.retrieve(setupIntentId),
  );
  const customer = intent.customer;
  const method = intent.payment_method;
  return {
    status: intent.status,
    customerId: typeof customer === "string" ? customer : (customer?.id ?? null),
    paymentMethodId: typeof method === "string" ? method : (method?.id ?? null),
  };
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
 * straight away" is true rather than "at Stripe's next retry, which may be days
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
  readonly interval: "month" | "year" | null;
};

/**
 * How long a fetched price is reused before being read again.
 *
 * Prices are immutable in Stripe — changing one means pointing the deployment
 * at a different id — so the only thing this staleness can hide is an operator
 * editing the environment, which needs a restart anyway. Ten minutes keeps the
 * plan tab from making two network calls every time somebody opens it.
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

/**
 * The two prices this deployment sells, read from Stripe rather than from the
 * environment.
 *
 * The environment holds ids, not amounts, and that is deliberate: an amount
 * copied into configuration is a second place for the price to live and the one
 * that does not get charged. A page that showed it would eventually lie.
 *
 * A failure here is not a failure of the page. The caller still knows which
 * plan somebody is on and what it allows; it just cannot name the amount, so
 * this answers with nulls and lets the tab render without a figure rather than
 * refusing to open.
 */
export async function fetchPlanPrices(): Promise<PlanPrices> {
  const cached = priceCache;
  if (cached && Date.now() - cached.at < PRICE_CACHE_MS) return cached.prices;
  const { billing } = getConfig();
  if (!billing) throw new Error("Stripe is not configured on this deployment");
  const stripe = getStripe();
  const [monthly, yearly] = await measured("price.retrieve", () =>
    Promise.all([
      stripe.prices.retrieve(billing.monthlyPriceId),
      stripe.prices.retrieve(billing.yearlyPriceId),
    ]),
  );
  const prices = {
    monthly: priceFactsOf(monthly),
    yearly: priceFactsOf(yearly),
  };
  priceCache = { at: Date.now(), prices };
  return prices;
}

/** Dropped between tests, and by nothing else. */
export function resetPlanPriceCache() {
  priceCache = undefined;
}
