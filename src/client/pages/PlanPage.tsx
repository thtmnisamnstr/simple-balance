import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { BILLING_GRACE_DAYS, PLAN_LABELS, subscriptionAction } from "../../shared/domain.js";
// The `pure` entry, and the difference is the whole promise below. The default
// entry injects Stripe's script one microtask after it is *imported*, whether or
// not `loadStripe` is ever called — and this module is imported by the app shell,
// so every page of every deployment fetched Stripe.js: the sign-in screen, a
// subscriber's balances, a deployment that sells nothing at all. Where ads widen
// the policy it ran, fraud signals and all; everywhere else the policy refused it
// and the console said so on every load. `pure` loads it only when called.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  api,
  json,
  type BillingStatus,
  type PlanPrice,
  type SubscriptionResult,
  type Session,
} from "../api.js";
import { Alert, Badge, Button, Note, PageHeader, SettingsTabs, Skeleton } from "../components.js";
import { newIdempotencyKey } from "../idempotency.js";
import { formatTimestamp } from "../money.js";
import { useTimezone } from "../timezone.js";
import type { BillingInterval } from "../../shared/domain.js";

/**
 * Stripe.js, fetched once for the life of the tab.
 *
 * Fetched only here, on the plan tab, once there is something to confirm: that
 * is the `pure` import above, which injects nothing until `loadStripe` runs.
 * Fetching Stripe's script anywhere else — a deployment that sells nothing, a
 * page that renders somebody's balances — is the one thing this whole feature
 * promises not to do, and `tests/stripe-script-loading.test.tsx` holds it.
 *
 * Keyed by the publishable key because the key arrives with the status
 * response, and a second key would need a second instance.
 */
const stripeByKey = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string) {
  const existing = stripeByKey.get(publishableKey);
  if (existing) return existing;
  const loading = loadStripe(publishableKey);
  stripeByKey.set(publishableKey, loading);
  return loading;
}

/**
 * How often a price is billed, in the words the button uses — Stripe's interval
 * rather than the slot the id was configured in, so the label says what the
 * charge will be. Null for anything else, and the button then names the amount
 * alone rather than guess.
 */
function perInterval(price: PlanPrice | null) {
  if (price?.interval === "year") return "a year";
  if (price?.interval === "month") return "a month";
  return null;
}

/** "$30.00 a year", or as much of it as is known. */
function priceLabel(price: PlanPrice | null) {
  const amount = formatPrice(price);
  if (!amount) return null;
  const per = perInterval(price);
  return per ? `${amount} ${per}` : amount;
}

/** An amount as Stripe holds it: minor units, and a currency that says how many. */
function formatPrice(price: { unitAmount: number | null; currency: string } | null) {
  if (!price || price.unitAmount === null) return null;
  // Stripe counts in the currency's smallest unit, and how many of those make a
  // major unit is the currency's business rather than a fixed hundred — which
  // is what `Intl` already knows and this would otherwise have to encode.
  //
  // And yes, this divides a number, which everywhere else in this product would
  // be wrong: `AGENTS.md` bans representing money as a float and the client
  // renders ledger amounts through `formatMoney`, which never converts. A price
  // is the one money-shaped value here that is not a ledger amount. It arrives
  // from Stripe as an integer count of minor units, it is displayed and never
  // stored, summed or posted, and the division is undone immediately by
  // `Intl.format` rounding to the same number of digits it was scaled by. Do
  // not copy this into anything that touches a posting.
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: price.currency.toUpperCase(),
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(price.unitAmount / 10 ** digits);
}

/**
 * What a Stripe subscription status means to somebody reading it.
 *
 * Stripe's words are Stripe's, and two of them are actively misleading on a
 * screen: `incomplete` reads as a fault of the person's rather than a payment
 * waiting to be confirmed, and `unpaid` reads as an accusation when it means
 * the retries have run out.
 */
const STATUS_WORDS: Record<string, { label: string; tone: "green" | "amber" }> = {
  active: { label: "Active", tone: "green" },
  trialing: { label: "Trial", tone: "green" },
  past_due: { label: "Payment failed", tone: "amber" },
  incomplete: { label: "Waiting for payment", tone: "amber" },
  unpaid: { label: "Unpaid", tone: "amber" },
  paused: { label: "Paused", tone: "amber" },
  canceled: { label: "Canceled", tone: "amber" },
};

/**
 * How long a failed renewal keeps the plan, as the past-due alert says it.
 *
 * Worked out from `BILLING_GRACE_DAYS`, the number the server enforces, rather
 * than written here a second time, because "a few days" is what this said
 * while the grace went from seven to fifteen. In words because the alert is a
 * sentence; a number past the end of the list falls back to digits, which
 * reads worse and is still true.
 */
const NUMBER_WORDS = (
  "zero one two three four five six seven eight nine ten eleven twelve thirteen " +
  "fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one " +
  "twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven " +
  "twenty-eight twenty-nine thirty thirty-one"
).split(" ");
const GRACE_IN_WORDS = `${NUMBER_WORDS[BILLING_GRACE_DAYS] ?? String(BILLING_GRACE_DAYS)} days`;

/**
 * Which kind of secret the form is holding, carried rather than sniffed.
 *
 * The two look almost alike — `pi_…_secret_…` and `seti_…_secret_…` — and they
 * are confirmed by different methods. Stripe.js refuses the mismatch outright
 * rather than doing something approximate, so guessing from the prefix would be
 * a second place for the answer to live when the code that asked for the secret
 * already knew.
 */
type PendingConfirmation =
  | {
      readonly secret: string;
      readonly kind: "payment";
      /**
       * What the money is for, which is what the button taking it says. Carried
       * from the button that asked for the secret, because a first
       * subscription's invoice and a failed renewal's look exactly alike, and
       * "Pay and upgrade" to somebody already on the plan misdescribes the
       * charge on the page that takes it.
       */
      readonly purpose: PaymentPurpose;
    }
  | { readonly secret: string; readonly kind: "setup" };

/** `upgrade` starts or raises a plan; `settle` pays what is owed on the one somebody is on. */
type PaymentPurpose = "upgrade" | "settle";

/**
 * The card form, mounted only when there is something to confirm.
 *
 * Everything in here runs inside Stripe's iframe: no card number reaches this
 * app, this server, or this deployment's logs, which is the whole reason for
 * using Elements rather than a form of our own.
 */
function PaymentStep({
  pending,
  onDone,
}: {
  pending: PendingConfirmation;
  onDone: (setupIntentId: string | null) => void | Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paying = pending.kind === "payment";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      // Two methods, because Stripe has two. `confirmPayment` against a
      // SetupIntent does not fall back or approximate — it throws an
      // IntegrationError naming `confirmSetup`, which is a blank screen to
      // anybody who is not looking at a console. Saving a card for later and
      // paying an invoice now are different operations and this is where they
      // part.
      //
      // `return_url` is given to both even though `redirect: "if_required"`
      // means it is usually unused: a payment that does need a redirect — 3-D
      // Secure, or a non-card method — is refused before anything is charged
      // when there is nowhere to come back to. Coming back to this same tab is
      // right, because the page reads its state from the server on load.
      const confirmParams = { return_url: window.location.href };
      if (paying) {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams,
          redirect: "if_required",
        });
        if (result.error) {
          // Stripe's own sentence, not ours. It knows why a card was declined
          // and says it in the person's language; anything written here would
          // be a worse version of it.
          setError(result.error.message ?? "That could not be completed.");
          return;
        }
        await onDone(null);
        return;
      }
      const result = await stripe.confirmSetup({
        elements,
        confirmParams,
        redirect: "if_required",
      });
      if (result.error) {
        setError(result.error.message ?? "That card could not be saved.");
        return;
      }
      // The id goes back, because saving the card is only half of it: Stripe
      // has attached it to the customer and still bills whatever it billed
      // before. The server reads the intent back and pins it.
      await onDone(result.setupIntent?.id ?? null);
    } catch (thrown) {
      // Stripe.js throws rather than returning an error for a whole class of
      // integration mistakes. Without this the promise rejects, the `finally`
      // below never runs, and the button stays disabled saying "Working…"
      // forever with nothing on screen to explain it.
      setError(thrown instanceof Error ? thrown.message : "That could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="panel-stack">
      <PaymentElement />
      {error ? <Alert kind="error">{error}</Alert> : null}
      <div className="form-actions">
        <Button
          type="submit"
          loading={busy}
          disabled={!stripe}
          disabledReason="Stripe's payment form is still loading."
        >
          {pending.kind === "setup"
            ? "Save this card"
            : pending.purpose === "settle"
              ? "Pay now"
              : "Pay and upgrade"}
        </Button>
      </div>
      <Note>
        Your card details go straight to Stripe. They never reach this app, and nothing about them
        is stored here.
      </Note>
    </form>
  );
}

export function PlanPage({ session }: { session: Session }) {
  const timezone = useTimezone();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["billing"],
    queryFn: () => api<BillingStatus>("/api/v1/billing"),
  });

  const refresh = async () => {
    setPending(null);
    // Both, and in this order: the plan tab is the authority on the
    // subscription and the session carries the ceiling every other page reads
    // off it, so refreshing one and not the other leaves the accounts page
    // still refusing a fourth account to somebody who has just paid.
    await queryClient.invalidateQueries({ queryKey: ["billing"] });
    await queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const choose = useMutation({
    mutationFn: ({ interval }: { interval: BillingInterval; purpose: PaymentPurpose }) =>
      api<SubscriptionResult>("/api/v1/billing/subscription", {
        ...json({ interval, idempotencyKey: newIdempotencyKey() }),
        method: "PUT",
      }),
    onSuccess: async (result, { purpose }) => {
      setFailure(null);
      // A secret means there is a payment left to make; its absence means the
      // change was arranged without one, which is every case but a first
      // subscription.
      if (result.clientSecret) {
        setPending({ secret: result.clientSecret, kind: "payment", purpose });
        // Refreshed as well, and this is the part that is easy to leave out.
        // Without it the page still believes there is no subscription, so it
        // goes on offering both priced buttons directly under the open card
        // form — and pressing the other one hands back *this* secret, charging
        // the price nobody pressed. `refresh()` itself cannot be reused here:
        // it clears the pending confirmation, which would unmount the form
        // that was just created.
        await queryClient.invalidateQueries({ queryKey: ["billing"] });
      } else await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });

  const setCancellation = useMutation({
    mutationFn: (cancelAtPeriodEnd: boolean) =>
      api<SubscriptionResult>("/api/v1/billing/subscription/cancellation", {
        ...json({ cancelAtPeriodEnd, idempotencyKey: newIdempotencyKey() }),
        method: "PUT",
      }),
    onSuccess: async () => {
      setFailure(null);
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });

  const confirmCard = useMutation({
    mutationFn: (setupIntentId: string) =>
      api<{ attached: boolean; paidInvoice: boolean }>(
        "/api/v1/billing/payment-setups/confirmations",
        json({ setupIntentId, idempotencyKey: newIdempotencyKey() }),
      ),
    onError: (error: Error) => setFailure(error.message),
  });

  const replaceCard = useMutation({
    mutationFn: () =>
      api<{ clientSecret: string | null }>(
        "/api/v1/billing/payment-setups",
        json({ idempotencyKey: newIdempotencyKey() }),
      ),
    onSuccess: (result) => {
      setFailure(null);
      if (result.clientSecret) setPending({ secret: result.clientSecret, kind: "setup" });
    },
    onError: (error: Error) => setFailure(error.message),
  });

  if (status.isPending) return <Skeleton height={320} label="Loading your plan" />;
  if (status.isError) {
    return <Alert kind="error">Your plan could not be loaded. Reload the page to try again.</Alert>;
  }

  const billing = status.data;
  const plan = billing.entitlement.billing ? billing.entitlement.plan : "free";
  const limit = billing.entitlement.billing ? billing.entitlement.accountLimit : null;
  const subscription = billing.subscription;
  const monthly = priceLabel(billing.prices.monthly);
  const yearly = priceLabel(billing.prices.yearly);
  const busy = choose.isPending || setCancellation.isPending || replaceCard.isPending;
  // A subscription waiting for its first payment. Stripe holds it for 23 hours
  // and then expires it, so this state is not rare — it is what a closed tab or
  // a declined card leaves behind — and it needs a way back to the form rather
  // than a plan page that looks finished.
  // Money is owed on the plan they are already on. `incomplete` is a first
  // payment that was never finished and `unpaid` is one whose retries have run
  // out; both have an open invoice and both need a way to pay it rather than a
  // page that looks finished. Narrowed to a known interval because the button
  // asks the server for that same interval, which is what stops it handing back
  // an invoice for a price nobody chose.
  const owingInterval =
    subscription && (subscription.status === "incomplete" || subscription.status === "unpaid")
      ? subscription.interval
      : null;
  const owing = owingInterval !== null;
  // The button itself, only where the server would take the payment — which
  // for `incomplete` is only where something is for sale, because finishing a
  // first payment starts a subscription. `payable` is the server's answer, so
  // the page cannot offer what the next press is refused. The sale is also
  // asked of `selling` here, the flag the heading above the button reads,
  // because "Finish your payment" under "not selling subscriptions" is the page
  // contradicting itself whichever of the two is behind.
  const finishInterval =
    subscription?.payable && (billing.selling || subscription.status !== "incomplete")
      ? owingInterval
      : null;
  // The plan they are on, where pressing it lets a scheduled switch go in the
  // shared rule the server acts by, and null elsewhere. Not every pending
  // switch can be let go that way: on a renewal that is owed, the same press
  // is `resume` and pays the invoice, and on a price this deployment no longer
  // sells there is no plan of theirs to press at all.
  const releaseInterval =
    subscription?.interval &&
    subscription.scheduledInterval &&
    subscriptionAction({
      current: {
        status: subscription.status,
        interval: subscription.interval,
        scheduled: subscription.scheduledInterval,
      },
      requested: subscription.interval,
    }).kind === "release"
      ? subscription.interval
      : null;
  // A renewal, or an upgrade's charge, that Stripe is still retrying. Kept apart
  // from `owing` rather than folded into it, because the plan is still running:
  // the other plan, a new card and canceling all stay on offer beside this. The
  // button reaches the same `resume` the server already answers for `past_due`
  // — the open invoice's own secret — which is the one way to pay a charge the
  // bank wants authenticated. Replacing the card pays it off-session, and a
  // bank that asks for 3-D Secure refuses exactly that. Offered whether or not
  // anything is for sale, because paying what is owed is not a sale.
  const payableInterval =
    subscription?.status === "past_due" && subscription.payable ? subscription.interval : null;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Plan and billing"
        description="What your account includes, what it costs, and how to change it."
      />
      {/* Always shown here, without asking `/api/auth/methods`: this page does
          not exist on a deployment where billing is unavailable, so the answer
          is already known and a second request to find it out would only make
          the strip appear a moment after the heading. */}
      <SettingsTabs current="plan" billingAvailable />
      <div className="settings-grid">
        <div className="settings-column">
          <section className="panel panel-stack">
            <header className="section-title">
              <span>
                <ShieldCheck size={19} />
              </span>
              <div>
                <h2>Your plan</h2>
                <p>
                  {plan === "plus"
                    ? `${PLAN_LABELS.plus}: as many accounts as you need.`
                    : limit === null
                      ? "Everything is included on this deployment."
                      : `${PLAN_LABELS.free}: up to ${limit} accounts.`}
                </p>
              </div>
            </header>

            {limit !== null && billing.accountsUsed !== null ? (
              <p>
                {billing.accountsUsed} of {limit} places in use. Archiving or deleting an account
                frees its place, and a frozen account can then take it.
              </p>
            ) : null}

            {billing.override ? (
              <Note>
                An operator granted you {PLAN_LABELS[billing.override.plan]}
                {billing.override.expiresAt
                  ? ` until ${formatTimestamp(billing.override.expiresAt, timezone)}`
                  : " with no end date"}
                . That takes precedence over anything below.
              </Note>
            ) : null}

            {subscription ? (
              <p>
                <Badge tone={STATUS_WORDS[subscription.status]?.tone ?? "neutral"}>
                  {STATUS_WORDS[subscription.status]?.label ?? subscription.status}
                </Badge>{" "}
                {subscription.interval === "yearly"
                  ? "Annual"
                  : subscription.interval === "monthly"
                    ? "Monthly"
                    : // Neither of the two this deployment sells. Prices are
                      // immutable at Stripe, so raising one means pointing at a
                      // different id and everybody on the old one lands here.
                      // Saying "Monthly" to an annual subscriber would be a
                      // figure and a renewal date that are simply wrong.
                      "On a price this deployment no longer sells"}
                {subscription.currentPeriodEnd
                  ? subscription.cancelAtPeriodEnd
                    ? `, ending ${formatTimestamp(subscription.currentPeriodEnd, timezone)}`
                    : `, renews ${formatTimestamp(subscription.currentPeriodEnd, timezone)}`
                  : ""}
                .
              </p>
            ) : null}

            {subscription?.scheduledInterval && subscription.scheduledAt ? (
              <Note>
                Switching to the{" "}
                {subscription.scheduledInterval === "yearly" ? "annual" : "monthly"} price on{" "}
                {formatTimestamp(subscription.scheduledAt, timezone)}. Nothing changes before then
                {/* Each way out is named only beside the button that takes it.
                    Letting the switch go is a button whether or not anything is
                    for sale, because it sells nothing. Replacing it, on a price
                    this deployment no longer sells, is a new schedule and so a
                    sale, which the plan buttons offer only while selling. */}
                {releaseInterval
                  ? ", and choosing your current plan again cancels the switch."
                  : !subscription.interval && billing.selling && !owing
                    ? ", and choosing the other plan replaces the switch."
                    : "."}
              </Note>
            ) : null}

            {subscription?.pastDueSince ? (
              <Alert kind="info">
                A payment failed on {formatTimestamp(subscription.pastDueSince, timezone)}. Your
                plan continues for {GRACE_IN_WORDS} from then while Stripe retries.{" "}
                {/* Paying now is named only beside a button that does it: a
                    price this deployment no longer sells has none, and the
                    card is then the way to pay. */}
                {payableInterval
                  ? "Paying now, or replacing the card below, fixes it right away."
                  : "Replacing the card below fixes it right away."}
              </Alert>
            ) : null}

            {failure ? <Alert kind="error">{failure}</Alert> : null}
          </section>
        </div>

        <div className="settings-column">
          {pending ? (
            <section className="panel panel-stack">
              <header className="section-title">
                <span>
                  <CreditCard size={19} />
                </span>
                <div>
                  <h2>{pending.kind === "payment" ? "Payment" : "Your card"}</h2>
                  <p>Handled entirely by Stripe.</p>
                </div>
              </header>
              <Elements
                stripe={stripeFor(billing.publishableKey)}
                options={{ clientSecret: pending.secret }}
                // Remounted when the secret changes, because Elements binds to
                // the one it was created with and reusing the instance would
                // confirm the previous payment.
                key={pending.secret}
              >
                <PaymentStep
                  pending={pending}
                  onDone={async (setupIntentId) => {
                    // Saving a card is two steps and the second is this one.
                    // Stripe has attached it to the customer; until the server
                    // pins it, dunning goes on retrying the card that failed.
                    if (setupIntentId) await confirmCard.mutateAsync(setupIntentId);
                    await refresh();
                  }}
                />
              </Elements>
            </section>
          ) : null}

          <section className="panel panel-stack">
            <header className="section-title">
              <span>
                <CreditCard size={19} />
              </span>
              <div>
                <h2>{subscription ? "Change your plan" : `Upgrade to ${PLAN_LABELS.plus}`}</h2>
                <p>
                  {billing.selling
                    ? "Cancel whenever you like. A canceled plan runs to the end of the period you paid for."
                    : "This deployment is not selling subscriptions at the moment."}
                </p>
              </div>
            </header>

            {finishInterval ? (
              <div className="form-actions">
                {subscription?.status === "unpaid" ? (
                  <Button
                    onClick={() => choose.mutate({ interval: finishInterval, purpose: "settle" })}
                    loading={busy}
                  >
                    Pay what is owed
                  </Button>
                ) : (
                  <Button
                    onClick={() => choose.mutate({ interval: finishInterval, purpose: "upgrade" })}
                    loading={busy}
                  >
                    Finish your payment
                  </Button>
                )}
              </div>
            ) : null}

            {payableInterval ? (
              <div className="form-actions">
                <Button
                  onClick={() => choose.mutate({ interval: payableInterval, purpose: "settle" })}
                  loading={busy}
                >
                  Pay now
                </Button>
              </div>
            ) : null}

            {billing.selling && !owing ? (
              <div className="form-actions">
                <Button
                  onClick={() => choose.mutate({ interval: "yearly", purpose: "upgrade" })}
                  loading={busy}
                  // Pressable while a switch to the other price is pending,
                  // because pressing the plan you are on is how a scheduled
                  // switch is abandoned — which the note above says in so many
                  // words, and which the server handles. Only where that press
                  // is a release: on a renewal that is owed it would hand back
                  // the invoice under "Pay and upgrade", beside the Pay now
                  // button that already does it under its own name.
                  disabled={subscription?.interval === "yearly" && !releaseInterval}
                  disabledReason="You are on the annual plan already."
                >
                  {yearly ? `Annual — ${yearly}` : "Annual"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => choose.mutate({ interval: "monthly", purpose: "upgrade" })}
                  loading={busy}
                  disabled={subscription?.interval === "monthly" && !releaseInterval}
                  disabledReason="You are on the monthly plan already."
                >
                  {monthly ? `Monthly — ${monthly}` : "Monthly"}
                </Button>
              </div>
            ) : null}

            {/* The one change of plan left while nothing is for sale. Letting
                a scheduled switch go keeps the plan already paid for and sells
                nothing, so the server takes it, and without this button the
                note above would name a way out the page did not offer. */}
            {!billing.selling && releaseInterval ? (
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={() =>
                    // Never read: a release charges nothing and hands back no
                    // secret. `settle` because it is about the plan they are
                    // on, so a secret, were one ever sent, would not be named
                    // an upgrade.
                    choose.mutate({ interval: releaseInterval, purpose: "settle" })
                  }
                  loading={busy}
                >
                  {releaseInterval === "yearly"
                    ? "Stay on the annual plan"
                    : "Stay on the monthly plan"}
                </Button>
              </div>
            ) : null}

            {billing.selling && yearly && monthly && !owing ? (
              <Note>
                Moving from monthly to annual takes effect now and charges the difference. Moving
                the other way takes effect at your next renewal, because the period you are in has
                been paid for.
              </Note>
            ) : null}

            {subscription && !owing ? (
              <div className="form-actions">
                <Button variant="secondary" onClick={() => replaceCard.mutate()} loading={busy}>
                  Replace card
                </Button>
                {subscription.cancelAtPeriodEnd ? (
                  <Button
                    variant="secondary"
                    onClick={() => setCancellation.mutate(false)}
                    loading={busy}
                  >
                    Keep my plan
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => setCancellation.mutate(true)}
                    loading={busy}
                  >
                    Cancel at period end
                  </Button>
                )}
              </div>
            ) : null}
          </section>
        </div>
      </div>
      <Note>
        Signed in as {session.user.email}. Receipts and invoices come from Stripe by email.
      </Note>
    </>
  );
}
