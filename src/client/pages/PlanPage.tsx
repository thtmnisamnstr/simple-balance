import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { PLAN_LABELS } from "../../shared/domain.js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, json, type BillingStatus, type SubscriptionResult, type Session } from "../api.js";
import { Alert, Badge, Button, Note, PageHeader, SettingsTabs, Skeleton } from "../components.js";
import { newIdempotencyKey } from "../idempotency.js";
import { formatTimestamp } from "../money.js";
import { useTimezone } from "../timezone.js";
import type { BillingInterval } from "../../shared/domain.js";

/**
 * Stripe.js, fetched once for the life of the tab.
 *
 * Keyed by the publishable key rather than loaded at module scope, because the
 * key arrives with the status response: loading at import time would mean
 * fetching Stripe's script on a deployment that sells nothing, which is the one
 * thing this whole feature promises not to do.
 */
const stripeByKey = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string) {
  const existing = stripeByKey.get(publishableKey);
  if (existing) return existing;
  const loading = loadStripe(publishableKey);
  stripeByKey.set(publishableKey, loading);
  return loading;
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
 * Which kind of secret the form is holding, carried rather than sniffed.
 *
 * The two look almost alike — `pi_…_secret_…` and `seti_…_secret_…` — and they
 * are confirmed by different methods. Stripe.js refuses the mismatch outright
 * rather than doing something approximate, so guessing from the prefix would be
 * a second place for the answer to live when the code that asked for the secret
 * already knew.
 */
type PendingConfirmation = {
  readonly secret: string;
  readonly kind: "payment" | "setup";
};

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
          {paying ? "Pay and upgrade" : "Save this card"}
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
    mutationFn: (interval: BillingInterval) =>
      api<SubscriptionResult>("/api/v1/billing/subscription", {
        ...json({ interval, idempotencyKey: newIdempotencyKey() }),
        method: "PUT",
      }),
    onSuccess: async (result) => {
      setFailure(null);
      // A secret means there is a payment left to make; its absence means the
      // change was arranged without one, which is every case but a first
      // subscription.
      if (result.clientSecret) {
        setPending({ secret: result.clientSecret, kind: "payment" });
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
  const monthly = formatPrice(billing.prices.monthly);
  const yearly = formatPrice(billing.prices.yearly);
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
                {billing.accountsUsed} of {limit} accounts used. Archived accounts count, because an
                archived account is kept rather than deleted.
              </p>
            ) : null}

            {billing.override ? (
              <Note>
                An operator granted you {billing.override.plan}
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
                {formatTimestamp(subscription.scheduledAt, timezone)}. Nothing changes before then,
                and choosing your current plan again cancels the switch.
              </Note>
            ) : null}

            {subscription?.pastDueSince ? (
              <Alert kind="info">
                A payment failed on {formatTimestamp(subscription.pastDueSince, timezone)}. Your
                plan continues for a few days while Stripe retries. Replacing the card below fixes
                it straight away.
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

            {owingInterval ? (
              <div className="form-actions">
                <Button onClick={() => choose.mutate(owingInterval)} loading={busy}>
                  {subscription?.status === "unpaid" ? "Pay what is owed" : "Finish your payment"}
                </Button>
              </div>
            ) : null}

            {billing.selling && !owing ? (
              <div className="form-actions">
                <Button
                  onClick={() => choose.mutate("yearly")}
                  loading={busy}
                  // Pressable while a switch to the other price is pending,
                  // because pressing the plan you are on is how a scheduled
                  // switch is abandoned — which the note above says in so many
                  // words, and which the server handles.
                  disabled={subscription?.interval === "yearly" && !subscription.scheduledInterval}
                  disabledReason="You are on the annual plan already."
                >
                  {yearly ? `Annual — ${yearly} a year` : "Annual"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => choose.mutate("monthly")}
                  loading={busy}
                  disabled={subscription?.interval === "monthly" && !subscription.scheduledInterval}
                  disabledReason="You are on the monthly plan already."
                >
                  {monthly ? `Monthly — ${monthly} a month` : "Monthly"}
                </Button>
              </div>
            ) : null}

            {yearly && monthly && !owing ? (
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
