import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import {
  BILLING_GRACE_DAYS,
  cancellationPending,
  graceEndsAt,
  MAX_FREE_ACCOUNTS,
  paidForSubscriptionStatuses,
  PLAN_ENDING_REFUSAL,
  PLAN_LABELS,
  periodIsPaid,
  planChangeTakesEffect,
  PLAN_GRANTED_REFUSAL,
  planIsGranted,
  subscriptionAction,
  type OwedInvoiceOutcome,
  type PlanChangeInvoice,
  type SubscriptionAction,
} from "../../shared/domain.js";
// The `pure` entry, and the difference is the whole promise below. The default
// entry injects Stripe's script one microtask after it is *imported*, whether or
// not `loadStripe` is ever called — and this module is imported by the app shell,
// so every page of every deployment fetched Stripe.js: the sign-in screen, a
// subscriber's balances, a deployment that sells nothing at all. Where ads widen
// the policy it ran, fraud signals and all; everywhere else the policy refused it
// and the console said so on every load. `pure` loads it only when called.
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe, StripeError } from "@stripe/stripe-js";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CreditCard, ShieldCheck } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
} from "react";
import {
  api,
  json,
  type BillingStatus,
  type PlanPrice,
  type SubscriptionResult,
  type Session,
} from "../api.js";
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Note,
  PageHeader,
  SettingsTabs,
  Skeleton,
  useConfirm,
} from "../components.js";
import { newIdempotencyKey } from "../idempotency.js";
import { formatTimestamp } from "../money.js";
import { useTimezone } from "../timezone.js";
import { usePaintedTheme } from "../theme.js";
import type { BillingInterval } from "../../shared/domain.js";

type PlanSubscription = NonNullable<BillingStatus["subscription"]>;

/**
 * What confirming a saved payment method answers.
 *
 * `invoice` is what became of anything owed, and it is optional for the reason
 * `BillingStatus`'s later fields are — a bundle can be served by a container
 * from before the field existed — and one more: a replay of an idempotency key
 * stored before the server said it hands back only the first two fields.
 * `paidInvoice` alone cannot tell "nothing was owed" from "the new method was
 * declined", which is how a declined replacement closed the form as though it
 * had worked.
 */
type CardConfirmation = {
  readonly attached: boolean;
  readonly paidInvoice: boolean;
  readonly invoice?: OwedInvoiceOutcome;
  readonly declineMessage?: string | null;
};

/**
 * The sentence the Your plan panel says about what just happened, and whether
 * it takes focus.
 *
 * It takes focus when the control somebody used has gone or has let go of it,
 * which on this tab is every time: a payment or a saved method closes the form
 * its button was in, and every other button here disables itself while it
 * works, which makes the browser blur it. Focus then fell to `<body>`, so the
 * next Tab started from the top of the page (`web.md` 13.3). Not on a page
 * load, though — coming back from a bank's page is a fresh document, and
 * moving focus into the middle of one skips everything above it.
 */
type Notice = {
  readonly kind: NonNullable<ComponentProps<typeof Alert>["kind"]>;
  readonly text: string;
  readonly focus: boolean;
};

/** What the form confirmed, for the page to say and to act on. */
type Confirmed =
  | { readonly kind: "payment"; readonly processing: boolean }
  | {
      readonly kind: "setup";
      readonly setupIntentId: string | null;
      readonly processing: boolean;
    };

/**
 * What Stripe puts on the address when a confirmation leaves the tab — a bank's
 * page, a wallet's — and sends the person back to `return_url`. The client
 * secret is among them, so none of them outlives the load that reads them.
 */
const STRIPE_RETURN_PARAMS = [
  "setup_intent",
  "setup_intent_client_secret",
  "payment_intent",
  "payment_intent_client_secret",
  "redirect_status",
] as const;

/** A confirmation that came back by redirect, read off the address it came back to. */
type StripeReturn = {
  readonly intent: PendingConfirmation["kind"];
  readonly id: string;
  readonly status: string;
};

function stripeReturn(search: string): StripeReturn | null {
  const params = new URLSearchParams(search);
  const status = params.get("redirect_status");
  if (!status) return null;
  const setupIntent = params.get("setup_intent");
  if (setupIntent) return { intent: "setup", id: setupIntent, status };
  const paymentIntent = params.get("payment_intent");
  if (paymentIntent) return { intent: "payment", id: paymentIntent, status };
  return null;
}

/** This address without what Stripe added to it, and with everything else kept. */
function withoutStripeReturn(location: Location) {
  const params = new URLSearchParams(location.search);
  for (const name of STRIPE_RETURN_PARAMS) params.delete(name);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
}

const PAYMENT_PROCESSING =
  "Your payment is still being processed. This tab shows the plan as paid once it clears, and " +
  "nothing more is needed from you.";
const METHOD_PROCESSING =
  "Your new payment method is still being confirmed. Renewals charge it once it is, and nothing " +
  "more is needed from you.";

/**
 * What a return from a redirect says before anything else is asked, or null
 * where a saved method still has to be confirmed and that answer is the one to
 * say. A payment needs nothing more asked: the load that brought somebody back
 * reads the plan from Stripe as it is.
 */
function returnNotice(returned: StripeReturn): Notice | null {
  if (returned.intent === "payment") {
    if (returned.status === "succeeded") {
      return { kind: "success", text: "Payment received.", focus: false };
    }
    if (returned.status === "processing") {
      return { kind: "info", text: PAYMENT_PROCESSING, focus: false };
    }
    return {
      kind: "error",
      text: "That payment did not go through, and nothing was charged.",
      focus: false,
    };
  }
  if (returned.status === "succeeded") return null;
  if (returned.status === "processing") {
    return { kind: "info", text: METHOD_PROCESSING, focus: false };
  }
  return {
    kind: "error",
    text: "Your new payment method could not be saved, so nothing was changed and the one before it is still charged.",
    focus: false,
  };
}

/**
 * The button on this tab that pays what is owed, by the name it is drawn with,
 * or null where it draws none: the conditions `payableInterval` and
 * `finishInterval` render those two by, for a sentence that has to name one.
 */
function owedPaymentButton(subscription: PlanSubscription | null | undefined) {
  if (!subscription?.payable || !subscription.interval) return null;
  if (subscription.status === "past_due") return "Pay now";
  if (subscription.status === "unpaid") return "Pay what is owed";
  return null;
}

/**
 * What saving a new payment method did about anything owed, in words.
 *
 * Read after the plan has been read again, so the button it points at is the
 * one on screen. A declined method and one whose bank wants the payment
 * confirmed are both still saved — the part somebody asked for happened — so
 * neither undoes it, and neither is silent: both closed the form as though
 * everything had worked, beside an alert saying that replacing the card fixes
 * it right away.
 */
function savedNotice(result: CardConfirmation, subscription: PlanSubscription | null | undefined) {
  const button = owedPaymentButton(subscription);
  const invoice = result.invoice ?? (result.paidInvoice ? "paid" : null);
  if (invoice === "paid") {
    return {
      kind: "success",
      text: "Your new payment method is saved, and it paid what was owed.",
    } as const;
  }
  if (invoice === "declined") {
    return {
      kind: "error",
      text: [
        "Your new payment method is saved, but it could not pay what is owed.",
        result.declineMessage,
        button
          ? `Press ${button} to pay with a different one, or change the payment method again.`
          : "Change the payment method again to try a different one.",
      ]
        .filter(Boolean)
        .join(" "),
    } as const;
  }
  if (invoice === "needs_authentication") {
    return {
      kind: "info",
      text: [
        "Your new payment method is saved, but its bank wants to confirm the payment that is " +
          "owed, and Stripe will not charge it until that happens.",
        button ? `Press ${button} to confirm it.` : null,
      ]
        .filter(Boolean)
        .join(" "),
    } as const;
  }
  if (invoice === "none") {
    return {
      kind: "success",
      text: "Your new payment method is saved. Renewals charge it from now on.",
    } as const;
  }
  return { kind: "success", text: "Your new payment method is saved." } as const;
}

const planWord = (interval: BillingInterval) => (interval === "yearly" ? "annual" : "monthly");

/** The other of the two intervals this deployment sells. */
const otherThan = (interval: BillingInterval): BillingInterval =>
  interval === "yearly" ? "monthly" : "yearly";

/**
 * What a change of plan that asked for no payment did, in words.
 *
 * Every one of these presses disabled its button while it worked, and the one
 * letting a switch go took its button away with the switch, so focus fell to
 * `<body>` and nothing but a badge said the press had done anything — a charge
 * for the difference included. Worded by what the press was, which is the
 * shared rule asked of the plan the page showed: the server acts by the same
 * rule, and where the two read different plans — a second tab got there
 * first — the server's answer is `none`, or a refusal said as one, and each
 * sentence here is still true of the plan somebody is now on. Any date is the one the plan read after the
 * press says, never the one on screen before it. Money is the one thing the
 * press cannot say: what was billed comes from `changeInvoice`, the invoice
 * the server watched Stripe raise.
 *
 * Null for a press that hands back a payment, where the form is the answer,
 * unless the plan is plainly the one asked for and paid for.
 */
function changedNotice(
  action: SubscriptionAction["kind"],
  requested: BillingInterval,
  invoice: PlanChangeInvoice | null | undefined,
  fresh: PlanSubscription | null | undefined,
  timezone: string,
): string | null {
  const plan = planWord(requested);
  if (action === "upgrade") {
    // What Stripe raised, never what the press meant. The upgrade anchors the
    // period at now, which bills the difference on the spot in the ordinary
    // case, and this sentence was written from the button alone — true until a
    // cancellation is pending, where Stripe caps the new term at the
    // cancellation, raises no invoice and parks the difference for later.
    // Somebody was told money had left their account when none had.
    if (invoice === "paid") {
      return `You are on the ${plan} plan now, and the difference was charged to your payment method.`;
    }
    if (invoice === "none") {
      return `You are on the ${plan} plan now. Nothing has been charged for the difference, and it goes on your next invoice.`;
    }
    // An invoice left open usually answers with its client secret, and the
    // form is then the sentence; this is the press that raised one the secret
    // could not be fetched for, where the charge really is still outstanding.
    if (invoice === "owed") {
      return `You are on the ${plan} plan now, and the difference is still to pay.`;
    }
    // Nothing said about an invoice — an older container, or an idempotency
    // key stored before the field existed — is the plan alone, which is true
    // whichever of the three happened.
    return `You are on the ${plan} plan now.`;
  }
  if (action === "schedule") {
    const at =
      fresh?.scheduledInterval === requested && fresh.scheduledAt
        ? formatTimestamp(fresh.scheduledAt, timezone)
        : "your next renewal";
    return `Your switch to the ${plan} plan is set for ${at}.`;
  }
  if (action === "release") {
    return `You are staying on the ${plan} plan, and the switch is canceled.`;
  }
  return fresh?.interval === requested && periodIsPaid(fresh.status)
    ? `You are on the ${plan} plan.`
    : null;
}

/**
 * What canceling, or taking the cancellation back, did, in words: the same
 * silence as a change of plan, for the same reason, since Cancel at period end
 * and Keep my plan disable themselves while they work.
 *
 * The date is a day the plan runs to only where the period has been paid for
 * (`periodIsPaid`), as on the status line. Keep my plan is named only once the
 * read says the plan is set to end, because that is when it is drawn.
 */
function cancellationNotice(
  ending: boolean,
  fresh: PlanSubscription | null | undefined,
  timezone: string,
) {
  const date =
    fresh?.currentPeriodEnd && periodIsPaid(fresh.status)
      ? formatTimestamp(fresh.currentPeriodEnd, timezone)
      : null;
  if (!ending) {
    return date ? `Your plan renews again on ${date}.` : "Your plan is no longer set to end.";
  }
  return [
    date ? `Your plan is set to end on ${date}.` : "Your plan is set to end.",
    fresh && cancellationPending(fresh) ? "Press Keep my plan to keep it." : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Reads the plan and the session again, and nothing else.
 *
 * Both, and in this order: the plan tab is the authority on the subscription
 * and the session carries the ceiling every other page reads off it, so
 * refreshing one and not the other leaves the accounts page still refusing a
 * fourth account to somebody who has just paid.
 */
async function reread(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: ["billing"] });
  await queryClient.invalidateQueries({ queryKey: ["session"] });
}

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

/** A token's live value, or nothing when the stylesheet has not been applied. */
function token(root: CSSStyleDeclaration, name: string): string | undefined {
  const value = root.getPropertyValue(name).trim();
  return value || undefined;
}

type FieldMetrics = { borderRadius?: string; fontSizeBase?: string };

/**
 * The two measurements a field takes from a rule rather than from a token.
 *
 * Measured off a `span.input` the stylesheet draws, for the same reason the
 * colors below are read rather than typed: a radius written here would be a
 * second place it is decided, and the first one to go stale. The probe is
 * attached because a detached element matches no rule, and removed in the same
 * turn, so nothing is ever painted.
 *
 * Attaching it is a write to the document, so this is called from an effect and
 * never while rendering. Neither value depends on the theme — `.input` is 8px
 * and 13px in both — so it is taken once.
 */
function fieldMetrics(): FieldMetrics {
  try {
    const probe = document.createElement("span");
    probe.className = "input";
    probe.setAttribute("aria-hidden", "true");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    try {
      const style = window.getComputedStyle(probe);
      const radius = style.borderTopLeftRadius;
      const size = style.fontSize;
      return {
        ...(radius ? { borderRadius: radius } : {}),
        ...(size ? { fontSizeBase: size } : {}),
      };
    } finally {
      probe.remove();
    }
  } catch {
    // Stripe's own defaults are a working surface; a measurement that could not
    // be taken is not worth failing the one screen that takes a payment.
    return {};
  }
}

/**
 * The theming interface Stripe's `Elements` accepts, filled from this page's
 * own tokens (`web.md` 6.4).
 *
 * It was passed `{ clientSecret }` and nothing else, so the card fields came up
 * in the vendor's light default: on a dark deployment, a white rectangle inside
 * a dark panel on the one screen that takes somebody's money — the only surface
 * in the product answering for one of the two themes 1.2 requires.
 *
 * Every value is READ off `:root` rather than re-typed, which is the half of
 * 6.4 that is easy to get wrong: a hex typed here would be a fourth place a
 * color is written, and 1.2's whole argument — one value, three questions —
 * would be lost to a surface nobody looks at twice. The base theme is picked by
 * what is painted rather than overridden variable by variable, because Stripe's
 * own sub-elements have defaults of their own that no variable reaches.
 *
 * A token that comes back empty is left out, so Stripe falls back to its own
 * value instead of being handed a blank one.
 */
function stripeAppearance(painted: "light" | "dark", metrics: FieldMetrics) {
  const root = window.getComputedStyle(document.documentElement);
  return {
    theme: painted === "dark" ? ("night" as const) : ("stripe" as const),
    variables: {
      // The token named for a field's focused edge, which is what Stripe paints
      // with `colorPrimary`.
      ...(token(root, "--focus-ring") ? { colorPrimary: token(root, "--focus-ring") } : {}),
      // `--field`, not `--surface`: this is the fill behind an input, and the
      // two differ in dark.
      ...(token(root, "--field") ? { colorBackground: token(root, "--field") } : {}),
      ...(token(root, "--ink") ? { colorText: token(root, "--ink") } : {}),
      ...(token(root, "--muted") ? { colorTextSecondary: token(root, "--muted") } : {}),
      ...(token(root, "--muted") ? { colorTextPlaceholder: token(root, "--muted") } : {}),
      ...(token(root, "--red") ? { colorDanger: token(root, "--red") } : {}),
      ...metrics,
    },
  };
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

/**
 * What one plan charges at each renewal, for the renewal terms: "$30.00 a
 * year", in the button's own words, wherever Stripe said both halves.
 *
 * Never a figure of its own. Where Stripe gave an amount and no interval this
 * says the amount and no frequency, which is what the button beside it does;
 * where it gave nothing, it names the plan's price and the frequency the plan is
 * sold at rather than inventing a number nobody would be charged. Only a
 * payment on a plan already running reaches that last case: nothing on the tab
 * starts one at a price Stripe did not give.
 */
function renewalCharge(interval: BillingInterval, price: PlanPrice | null) {
  const amount = formatPrice(price);
  const per = perInterval(price);
  if (amount && per) return `${amount} ${per}`;
  if (amount) return `${amount} each period`;
  return interval === "yearly" ? "its price once a year" : "its price once a month";
}

/**
 * The automatic renewal terms, beside the request that consents to them.
 *
 * California's Automatic Renewal Law (Business and Professions Code
 * 17602(a)(1)) wants them clear and conspicuous — larger or contrasting type,
 * or set off from the text around them (17601(a)(2)-(3)) — and in visual
 * proximity to the request for consent: that the plan renews until canceled,
 * what it charges and how often, that the charge can change, and how to cancel.
 * Two things on this tab ask for that consent, the plan buttons and the payment
 * form's confirm button, so it is drawn beside both. Each of those buttons names
 * it as its description as well, so somebody who tabs straight to the button on
 * a screen reader hears the terms the sighted reader has in front of them.
 *
 * Set off by its box and in ink rather than the muted 12px of the notes around
 * it, which is the conspicuousness the statute describes. The figures are the
 * ones the buttons render, read from Stripe.
 *
 * The price-change sentence is the clause the hosted service's terms of use
 * are being changed to, word for word, and the window in it is the law's
 * rather than a choice: 17602(g)(2) wants notice of a fee change no less than 7
 * and no more than 30 days before it takes effect, for a contract from July 1,
 * 2025 (17602(j)). So it is not conditional on `TERMS_OF_USE_URL` — an operator
 * with no terms of their own owes the same notice — and it names only a change
 * the operator makes. A switch somebody asks for themselves takes effect when
 * the note under the plan buttons says it does, and nothing sends a notice of
 * it. Nothing in this code sends this one either, so an operator who changes a
 * price sends it; `docs/monetization.md` says so to the operator.
 */
function RenewalTerms({
  id,
  charges,
  termsOfUseUrl,
}: {
  id: string;
  charges: readonly (readonly [BillingInterval, PlanPrice | null])[];
  termsOfUseUrl: string | undefined;
}) {
  const charged = charges
    .map(
      ([interval, price]) =>
        `${interval === "yearly" ? "Annual" : "Monthly"} charges ${renewalCharge(interval, price)}`,
    )
    .join(" and ");
  return (
    <div className="plan-renewal-terms" id={id}>
      <p>
        {/* "Payment method" rather than "card": the form takes Link, which
            can be funded from a bank account, so "card" was not always what
            is charged. */}
        <strong>{PLAN_LABELS.plus} renews automatically until you cancel.</strong> {charged}, to
        your payment method at the start of each period.
      </p>
      <p>
        If we change the price, or tax is added to what a renewal costs, we'll email you between 7
        and 30 days before the change takes effect, saying what it will cost and how to cancel, and
        you may cancel before it does.
      </p>
      <p>
        To cancel, press Cancel at period end here on the Plan and billing tab in Settings, whenever
        you like. A canceled plan runs to the end of the period you paid for.
        {termsOfUseUrl ? (
          <>
            {" "}
            The{" "}
            <a href={termsOfUseUrl} target="_blank" rel="noreferrer">
              terms of use
            </a>{" "}
            cover the rest.
          </>
        ) : null}
      </p>
    </div>
  );
}

/**
 * The scale Stripe *charges* at, for the currencies where it is not the
 * currency's own.
 *
 * `Intl` answers how many minor units make a major one, and for ordinary
 * currencies that is the whole answer — USD 2, JPY 0, KWD 3, and Stripe agrees
 * with every one of them. Four currencies it does not agree about, and it
 * publishes them itself under "Special cases"
 * (https://docs.stripe.com/currencies#special-cases):
 *
 * - **ISK** and **UGX** "transitioned to a zero-decimal currency, but backward
 *   compatibility requires you to represent it as a two-decimal value… to
 *   charge 5 ISK, provide an `amount` value of 500". CLDR records the currency,
 *   which is now zero-decimal, so `Intl` says 0 and dividing by 1 left the
 *   figure a hundred times what Stripe would take.
 * - **HUF** and **TWD**: "Stripe treats HUF as a zero-decimal currency *for
 *   payouts*, even though you can charge two-decimal amounts." A price is a
 *   charge, so both are two here. `Intl` already says 2 for TWD and 0 for HUF,
 *   which is why HUF was wrong and TWD was right by coincidence — it is
 *   written down anyway, because this table's membership is the vendor's list
 *   rather than wherever the two happen to disagree this year.
 *
 * This is not the per-currency scale table `common.md` §Money that is not a
 * ledger amount turned down — that one would restate what `Intl` already knows
 * and go stale against a currency nobody tested. This is the vendor's own
 * documented deviation from it, four currencies long, and `Intl` still answers
 * for the other 130-odd.
 */
const STRIPE_CHARGE_DIGITS: Record<string, number> = { ISK: 2, UGX: 2, HUF: 2, TWD: 2 };

/**
 * Every button on this tab that starts something, so a press can name itself.
 *
 * `finish` is one slot holding two spellings — "Pay what is owed" and "Finish
 * your payment" are a ternary on the subscription's status and never both on
 * screen.
 */
type Press = "finish" | "pay" | "yearly" | "monthly" | "release" | "card" | "keep" | "cancel";

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
  const currency = price.currency.toUpperCase();
  // What the currency itself says, which is what `Intl` resolves to unasked.
  const shown =
    new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  // What Stripe scaled the integer by — the same number everywhere but the
  // four currencies above, where its own documentation says otherwise.
  const scale = STRIPE_CHARGE_DIGITS[currency] ?? shown;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    // At least what the currency shows and at most what Stripe can charge, so
    // neither a digit nor a fraction goes missing: ISK 500 reads "5" rather
    // than "5.00", because the króna has no subunit and Stripe guarantees
    // those two digits are zero, while a HUF price of 1045 keeps its ".45",
    // because Stripe will take it. Wherever the two scales agree — every
    // currency but those four — both are the number `Intl` would have chosen
    // on its own, so nothing about the figure changes.
    minimumFractionDigits: shown,
    maximumFractionDigits: Math.max(shown, scale),
  }).format(price.unitAmount / 10 ** scale);
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
      /**
       * Which plan the money is for, so the renewal terms beside the button
       * name that plan's charge and not both. Carried for the reason `purpose`
       * is: the secret says nothing about it.
       */
      readonly interval: BillingInterval;
    }
  | { readonly secret: string; readonly kind: "setup" };

/** `upgrade` starts or raises a plan; `settle` pays what is owed on the one somebody is on. */
type PaymentPurpose = "upgrade" | "settle";

/**
 * The payment form, mounted only when there is something to confirm.
 *
 * Everything in here runs inside Stripe's iframe: no card number reaches this
 * app, this server, or this deployment's logs, which is the whole reason for
 * using Elements rather than a form of our own.
 */
function PaymentStep({
  pending,
  prices,
  termsOfUseUrl,
  onDone,
}: {
  pending: PendingConfirmation;
  prices: BillingStatus["prices"];
  termsOfUseUrl: string | undefined;
  /** Never rejects: whatever goes wrong after Stripe has confirmed is the page's to say. */
  onDone: (confirmed: Confirmed) => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const renewalTermsId = useId();
  const paying = pending.kind === "payment";
  // A first payment is the consent to a plan that renews, and it is not taken
  // beside terms that cannot say what the plan charges. Nothing opens this form
  // for one at an unknown price; this is the refresh that follows the press,
  // asking Stripe again and hearing nothing back.
  const unpriced =
    pending.kind === "payment" &&
    pending.purpose === "upgrade" &&
    formatPrice(pending.interval === "yearly" ? prices.yearly : prices.monthly) === null;

  /**
   * Stripe's refusal, said once.
   *
   * Stripe's own sentence, not ours: it knows why a card was declined and says
   * it in the person's language, and anything written here would be a worse
   * version of it. Except a `validation_error`, which the element has already
   * drawn inline beside the field it is about and clears by itself once that
   * field is right — a copy of it here was the one left behind, saying
   * "Please select a payment method" beside a Link wallet that had just been
   * unlocked. Focus goes to the element, where that sentence is.
   */
  const refused = (refusal: StripeError, fallback: string) => {
    if (refusal.type === "validation_error") {
      elements?.getElement("payment")?.focus();
      return;
    }
    setError(refusal.message ?? fallback);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);
    try {
      // Two methods, because Stripe has two. `confirmPayment` against a
      // SetupIntent does not fall back or approximate — it throws an
      // IntegrationError naming `confirmSetup`, which is a blank screen to
      // anybody who is not looking at a console. Saving a payment method for
      // later and paying an invoice now are different operations and this is
      // where they part.
      //
      // `return_url` is given to both even though `redirect: "if_required"`
      // means it is usually unused: a payment that does need a redirect — a
      // bank's page, a wallet's — is refused before anything is charged when
      // there is nowhere to come back to. Coming back to this same tab is
      // right, because the page reads its state from the server on load and
      // finishes a redirected confirmation from the address. The path alone,
      // not `href`: Stripe appends its own parameters, the client secret among
      // them, and `href` carried the last return's set into the next one, so
      // they piled up and a stale `redirect_status` was the first one read.
      const confirmParams = {
        return_url: `${window.location.origin}${window.location.pathname}`,
      };
      if (paying) {
        const result = await stripe.confirmPayment({
          elements,
          confirmParams,
          redirect: "if_required",
        });
        if (result.error) {
          refused(result.error, "That could not be completed.");
          return;
        }
        await onDone({
          kind: "payment",
          processing: result.paymentIntent?.status === "processing",
        });
        return;
      }
      const result = await stripe.confirmSetup({
        elements,
        confirmParams,
        redirect: "if_required",
      });
      if (result.error) {
        refused(result.error, "That payment method could not be saved.");
        return;
      }
      // The id goes back, because saving the method is only half of it:
      // Stripe has attached it to the customer and still bills whatever it
      // billed before. The server reads the intent back and pins it.
      await onDone({
        kind: "setup",
        setupIntentId: result.setupIntent?.id ?? null,
        processing: result.setupIntent?.status === "processing",
      });
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
      {/* Cleared once the element holds a method it could confirm, because
          the element clears its own copy then and this one stayed. Only on
          `complete`: the element also reports an incomplete change in the
          middle of a declined confirm, which would erase the decline. */}
      <PaymentElement
        onChange={(event) => {
          if (event.complete) setError(null);
        }}
      />
      {/* Takes focus although the button is still here, because the button
          no longer has it: it was disabled while it worked, which makes the
          browser blur it, and Stripe's 3-D Secure window never hands focus
          back to anything. `submit` clears the error first, so a second
          failure remounts this and takes focus again even when the sentence
          is the same. */}
      {error ? (
        <Alert kind="error" takeFocus>
          {error}
        </Alert>
      ) : null}
      {/* A payment is consent to a plan that renews, whether it starts one or
          settles the one somebody is on. Saving a payment method consents to
          nothing new, so it has no terms to draw. */}
      {pending.kind === "payment" ? (
        <RenewalTerms
          id={renewalTermsId}
          charges={[
            [pending.interval, pending.interval === "yearly" ? prices.yearly : prices.monthly],
          ]}
          termsOfUseUrl={termsOfUseUrl}
        />
      ) : null}
      <div className="form-actions">
        <Button
          type="submit"
          loading={busy}
          disabled={!stripe || unpriced}
          disabledReason={
            unpriced
              ? "Stripe could not say what this plan costs just now. Reload the page to try again."
              : "Stripe's payment form is still loading."
          }
          aria-describedby={pending.kind === "payment" ? renewalTermsId : undefined}
        >
          {pending.kind === "setup"
            ? "Save this payment method"
            : pending.purpose === "settle"
              ? "Pay now"
              : "Pay and upgrade"}
        </Button>
      </div>
      <Note>
        Your payment details go straight to Stripe. They never reach this app, and nothing about
        them is stored here.
      </Note>
    </form>
  );
}

export function PlanPage({
  session,
  termsOfUseUrl,
}: {
  session: Session;
  /** The deployment's terms of use, linked from the renewal terms where one is set. */
  termsOfUseUrl?: string | undefined;
}) {
  const timezone = useTimezone();
  const renewalTermsId = useId();
  const keepTermsId = useId();
  const releaseTermsId = useId();
  const paymentHeadingId = useId();
  const paymentPanel = useRef<HTMLElement>(null);
  const queryClient = useQueryClient();
  // Before every early return below, as every hook here has to be.
  const confirmCharge = useConfirm<BillingInterval>();
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  // Which button was pressed, not merely that one was. Set as each press goes
  // out and cleared by that mutation's `onSettled`, so it is non-null only
  // while something really is in flight — the one claim `working` below rests
  // on. Never set by the card form's own confirmation, which is the form's
  // spinner to show and none of these buttons'.
  const [pressed, setPressed] = useState<Press | null>(null);
  const openSecret = pending?.secret ?? null;
  const painted = usePaintedTheme();
  const [fieldLook, setFieldLook] = useState<FieldMetrics>({});
  useEffect(() => {
    // Taking this measurement attaches a probe to the document, which a render
    // may not do; and the first pass costs nothing, because Stripe applies an
    // appearance change to an element that is already mounted.
    // oxlint-disable-next-line react/set-state-in-effect
    setFieldLook(fieldMetrics());
  }, []);
  // Rebuilt only when the secret or the painted theme changes. `react-stripe-js`
  // forwards an options change to `elements.update()`, so a fresh object every
  // render would be an update every render; and the theme has to be in the
  // dependencies rather than read once, because somebody can switch it from the
  // sidebar with this form open. The empty secret is never reached: the
  // `Elements` below renders only while `pending`, where it is `pending.secret`.
  const elementsOptions = useMemo(
    () => ({
      clientSecret: openSecret ?? "",
      appearance: stripeAppearance(painted, fieldLook),
    }),
    [openSecret, painted, fieldLook],
  );
  // Read once, at mount, and without touching the address: a state initializer
  // runs twice under StrictMode and must not have side effects. The effect
  // below strips it.
  const [returned] = useState(() => stripeReturn(window.location.search));
  const [notice, setNotice] = useState<Notice | null>(() =>
    returned ? returnNotice(returned) : null,
  );
  const returnHandled = useRef(false);

  const status = useQuery({
    queryKey: ["billing"],
    queryFn: () => api<BillingStatus>("/api/v1/billing"),
  });

  /** Closes the form and reads the plan again. */
  const refresh = async () => {
    setPending(null);
    await reread(queryClient);
  };

  /**
   * A refusal, said, and then the plan read again.
   *
   * A refusal is the moment the page learns its picture of the plan was out of
   * date — a sale that closed, a price that stopped fitting, a subscription
   * changed in another tab — and it read nothing, so pressing the same stale
   * button repeated the same refusal. Not `refresh()`, which closes an open
   * payment form along with it.
   */
  const refusedWith = async (error: Error, focus = true) => {
    setNotice({ kind: "error", text: error.message, focus });
    await reread(queryClient);
  };
  // Cleared as each action starts, so an answer to the last one is never left
  // beside the next, and a refusal repeated word for word still remounts its
  // alert and takes focus again.
  const starting = () => setNotice(null);

  /** The plan as the read after a press left it, for the sentence about the press. */
  const freshSubscription = () =>
    queryClient.getQueryData<BillingStatus>(["billing"])?.subscription;

  const choose = useMutation({
    mutationFn: ({
      interval,
    }: {
      interval: BillingInterval;
      purpose: PaymentPurpose;
      /** What the press was by the shared rule, for the sentence saying what it did. */
      action: SubscriptionAction["kind"];
    }) =>
      api<SubscriptionResult>("/api/v1/billing/subscription", {
        ...json({ interval, idempotencyKey: newIdempotencyKey() }),
        method: "PUT",
      }),
    onMutate: starting,
    onSuccess: async (result, { interval, purpose, action }) => {
      // A secret means there is a payment left to make; its absence means the
      // change was arranged without one, which is every case but a first
      // subscription.
      if (result.clientSecret) {
        setPending({ secret: result.clientSecret, kind: "payment", purpose, interval });
        // Refreshed as well, and this is the part that is easy to leave out.
        // Without it the page still believes there is no subscription, so it
        // goes on offering both priced buttons directly under the open card
        // form — and pressing the other one hands back *this* secret, charging
        // the price nobody pressed. `refresh()` itself cannot be reused here:
        // it clears the pending confirmation, which would unmount the form
        // that was just created.
        await queryClient.invalidateQueries({ queryKey: ["billing"] });
        return;
      }
      await refresh();
      const text = changedNotice(
        action,
        interval,
        result.changeInvoice,
        freshSubscription(),
        timezone,
      );
      if (text) setNotice({ kind: "success", text, focus: true });
    },
    onError: (error: Error) => refusedWith(error),
    // After `onSuccess`, which this awaits, so a button stays working for the
    // whole of what it started rather than for the request alone.
    onSettled: () => setPressed(null),
  });

  const setCancellation = useMutation({
    mutationFn: (cancelAtPeriodEnd: boolean) =>
      api<SubscriptionResult>("/api/v1/billing/subscription/cancellation", {
        ...json({ cancelAtPeriodEnd, idempotencyKey: newIdempotencyKey() }),
        method: "PUT",
      }),
    onMutate: starting,
    onSuccess: async (_result, cancelAtPeriodEnd) => {
      await refresh();
      setNotice({
        kind: "success",
        text: cancellationNotice(cancelAtPeriodEnd, freshSubscription(), timezone),
        focus: true,
      });
    },
    onError: (error: Error) => refusedWith(error),
    onSettled: () => setPressed(null),
  });

  const confirmCard = useMutation({
    mutationFn: ({
      setupIntentId,
      idempotencyKey,
    }: {
      setupIntentId: string;
      idempotencyKey: string;
      focus: boolean;
    }) =>
      api<CardConfirmation>(
        "/api/v1/billing/payment-setups/confirmations",
        json({ setupIntentId, idempotencyKey }),
      ),
    onError: (error: Error, { focus }) => refusedWith(error, focus),
  });
  const { mutateAsync: confirmSaved } = confirmCard;

  const replaceCard = useMutation({
    mutationFn: () =>
      api<{ clientSecret: string | null }>(
        "/api/v1/billing/payment-setups",
        json({ idempotencyKey: newIdempotencyKey() }),
      ),
    onMutate: starting,
    onSuccess: (result) => {
      if (result.clientSecret) setPending({ secret: result.clientSecret, kind: "setup" });
    },
    onError: (error: Error) => refusedWith(error),
    onSettled: () => setPressed(null),
  });

  /**
   * The form's answer, once Stripe has confirmed it.
   *
   * A payment's sentence mounts in the same render that removes the form, so
   * focus has somewhere to go the moment its button does. A saved method's
   * waits for the plan to be read again, because what it says about anything
   * owed names the button that pays it, and that is the button on screen once
   * the read is back. Nothing here throws: a refusal from the confirmation is
   * said by its `onError`, and the form closes either way, because the intent
   * it holds has been used and a second try needs a fresh one.
   */
  const confirmed = async (done: Confirmed, paid: PendingConfirmation) => {
    if (done.kind === "payment") {
      setNotice({
        kind: done.processing ? "info" : "success",
        // By what the money was for, which the form was opened with: a first
        // payment and an upgrade's charge put somebody on a plan, and a
        // settled renewal keeps them on the one they had.
        text: done.processing
          ? PAYMENT_PROCESSING
          : paid.kind === "payment" && paid.purpose === "upgrade"
            ? `Payment received, and you are on the ${paid.interval === "yearly" ? "annual" : "monthly"} plan.`
            : "Payment received, and what was owed is paid.",
        focus: true,
      });
      await refresh();
      return;
    }
    // Stripe has not finished with it yet, so there is nothing to pin: the
    // `setup_intent.succeeded` delivery does that once it has.
    if (!done.setupIntentId || done.processing) {
      setNotice({ kind: "info", text: METHOD_PROCESSING, focus: true });
      await refresh();
      return;
    }
    const result = await confirmSaved({
      setupIntentId: done.setupIntentId,
      idempotencyKey: newIdempotencyKey(),
      focus: true,
    }).catch(() => null);
    await refresh();
    if (result) setNotice({ ...savedNotice(result, freshSubscription()), focus: true });
  };

  // Coming back from a confirmation that left the tab. Stripe sends the person
  // to `return_url` with the intent's id, its client secret and how it went on
  // the address, and nothing read them: a method saved on a bank's or a
  // wallet's page was never pinned by this tab, so it said nothing, and the
  // secret stayed in the address bar and in the history entry. The address
  // loses them before anything else happens. Then a saved method goes through
  // the same confirmation an in-page one does, under a key made from the
  // intent, so a second run of this — StrictMode, a restored page — replays
  // the first rather than repeating it; the ref is what stops the second run
  // here. A payment needs nothing asked: this load reads the plan from Stripe.
  useEffect(() => {
    if (!returned || returnHandled.current) return;
    returnHandled.current = true;
    window.history.replaceState(window.history.state, "", withoutStripeReturn(window.location));
    if (returned.intent !== "setup" || returned.status !== "succeeded") return;
    void (async () => {
      const result = await confirmSaved({
        setupIntentId: returned.id,
        idempotencyKey: `return:${returned.id}`,
        focus: false,
      }).catch(() => null);
      await reread(queryClient);
      if (result) {
        const fresh = queryClient.getQueryData<BillingStatus>(["billing"])?.subscription;
        setNotice({ ...savedNotice(result, fresh), focus: false });
      }
    })();
  }, [returned, confirmSaved, queryClient]);

  // Into the form, the moment one opens. Only a press opens one — a return from
  // a redirect never does — so this never takes focus on a page load. The
  // button pressed is gone or has let go: Pay now, Finish your payment and Pay
  // what is owed are hidden while the form is open, a first subscription's
  // plan buttons go with the read that follows, and Change payment method is
  // disabled while it works, which blurs it. Focus fell to `<body>`, and the
  // form somebody had just asked for was a Tab from the top of the page away
  // (`web.md` 13.3). The region rather than its heading, for the reason
  // `<main>` is the target on a route change: entering it announces the panel
  // and reads it from the top, and the next Tab is Stripe's first field.
  // Keyed on the secret, so a second form replacing the first moves focus too.
  useEffect(() => {
    if (openSecret) paymentPanel.current?.focus();
  }, [openSecret]);

  /**
   * The title and the Settings strip, before the four states rather than
   * after them. `web.md` 12.1's states are states of the page's body: both
   * early returns here replaced the whole page, so the error branch removed
   * this tab's own navigation while telling somebody to reload — and the tab
   * read the bare app name for as long as the query took, since
   * `document.title` is set inside `PageHeader`.
   */
  const header = (
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
    </>
  );

  if (status.isPending)
    return (
      <>
        {header}
        {/* The one skeleton label in the app that had no ellipsis, which is
            invisible on the page and obvious read down a list of twenty-one. */}
        <Skeleton height={320} label="Loading your plan…" />
      </>
    );
  if (status.isError) {
    return (
      <>
        {header}
        <Alert kind="error">Your plan could not be loaded. Reload the page to try again.</Alert>
      </>
    );
  }

  const billing = status.data;
  const plan = billing.entitlement.billing ? billing.entitlement.plan : "free";
  const limit = billing.entitlement.billing ? billing.entitlement.accountLimit : null;
  const subscription = billing.subscription;
  const monthly = priceLabel(billing.prices.monthly);
  const yearly = priceLabel(billing.prices.yearly);
  const priceOf = (interval: BillingInterval) =>
    interval === "yearly" ? billing.prices.yearly : billing.prices.monthly;
  // Whether Stripe said what a plan costs, which is what the renewal terms
  // beside any request to start one have to state: 17601(b)(3) makes the
  // recurring charge one of the terms, and "its price once a year" is not it.
  const priced = (interval: BillingInterval) => formatPrice(priceOf(interval)) !== null;
  // Any of the four in flight, and the "any" is the whole of what was wrong
  // with handing this to every button as `loading`: `Button` turns `loading`
  // into a spinner, `aria-busy` and an sr-only "Working…" inside the
  // button's own name, so one press told a screen reader that four controls
  // were working and renamed three of them to things like "Working… Annual
  // — $30.00 a year". `App.tsx`'s consent screen carries the same note,
  // found a release earlier on a pair rather than on a row of four.
  const anyPending =
    choose.isPending || setCancellation.isPending || replaceCard.isPending || confirmCard.isPending;
  // The one button that may say it is working: the one pressed, and only while
  // its mutation really is running. Every other button is plainly disabled
  // instead, because only one of these may run at a time and `web.md` 12.3
  // exempts exactly that from carrying a reason — the sibling's spinner is
  // the answer, and a reason beside it would be a second answer to a question
  // already answered. `tests/field-contract.test.tsx` names this file for it.
  const working = anyPending ? pressed : null;
  // A payment form is open. It is the one way to pay while it is: the buttons
  // that open it — Finish your payment, Pay what is owed, Pay now — stayed
  // drawn beside it as a second primary button for the same payment, one of
  // them under the same name as the form's own submit. Pressing one fetched
  // the secret already on screen and changed nothing, and it stayed pressable
  // while the form was confirming. They come back when the form closes, which
  // a decline does not do, so no way to pay goes missing. A card form is not
  // this: Pay now beside it is a different way to pay, and stays.
  const paymentOpen = pending?.kind === "payment";
  // An operator's grant decides this plan, so nothing here may spend money on
  // one. Asked of the resolved entitlement rather than of `billing.override`,
  // which is the stored row and is still there after it has expired -- the
  // grant note below read that row and claimed precedence over buttons that
  // were, correctly, live again.
  const granted = planIsGranted(billing.entitlement);
  // What each plan button would do, asked of the shared rule the server acts
  // by, with the pending cancellation in it: the tab previews the answer and
  // the server enforces the same one (`AGENTS.md`).
  const current = subscription
    ? {
        status: subscription.status,
        interval: subscription.interval,
        scheduled: subscription.scheduledInterval,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        // Both spellings of a cancellation, because the rule asks
        // `cancellationPending` about them: leaving the day out here is the
        // page and the server reading the same rule off different plans, which
        // is the disagreement `AGENTS.md` keeps this one function for.
        cancelAt: subscription.cancelAt ?? null,
      }
    : null;
  const actionFor = (requested: BillingInterval) => subscriptionAction({ current, requested });
  const takesEffect = (requested: BillingInterval) => planChangeTakesEffect(actionFor(requested));
  /**
   * Every press that asks for a plan, carrying what the press is for the
   * sentence after it, and which button made it so only that one says so.
   */
  const press = (interval: BillingInterval, purpose: PaymentPurpose, id: Press) => {
    setPressed(id);
    choose.mutate({ interval, purpose, action: actionFor(interval).kind });
  };
  /**
   * Asked first only where the press itself charges a card.
   *
   * Moving from monthly to annual bills the difference the moment it is
   * pressed, and every other change here waits: a move to monthly is
   * scheduled for the renewal and a cancellation runs to the end of the
   * period, and both are undone on this same tab with one more press. So a
   * confirmation stands in front of the one press that spends money now, and
   * nowhere else — least of all in front of canceling, which has to stay as
   * easy as subscribing was.
   */
  const pressPlan = (interval: BillingInterval, id: Press) => {
    if (actionFor(interval).kind === "upgrade") {
      confirmCharge.ask(interval, () => press(interval, "upgrade", id));
      return;
    }
    press(interval, "upgrade", id);
  };
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
  // Whether there is a plan to change, for the heading over the buttons.
  // `incomplete` is a row Stripe makes the moment a price is pressed and holds
  // for 23 hours: nothing was charged, the entitlement is still Free, and the
  // only payment on offer is the first one — so "Change your plan" was the tab
  // telling somebody on Free to change the plan they have not got.
  // `paidForSubscriptionStatuses` is the set that already answers this, the one
  // the settings page asks before warning that deleting an account cancels a
  // plan. Not `periodIsPaid`, which is false for `past_due` too: a subscriber
  // whose renewal card failed is changing a real plan.
  const hasPlanToChange =
    subscription !== null &&
    (paidForSubscriptionStatuses as readonly string[]).includes(subscription.status);
  // The button itself, only where the server would take the payment — which
  // for `incomplete` is only where something is for sale, because finishing a
  // first payment starts a subscription. `payable` is the server's answer, so
  // the page cannot offer what the next press is refused. The sale is also
  // asked of `selling` here, the flag the heading above the button reads,
  // because "Finish your payment" under "not selling subscriptions" is the page
  // contradicting itself whichever of the two is behind.
  //
  // And a first payment only at a price Stripe has given: finishing it is the
  // consent to a plan that renews. Paying what is owed on a plan already
  // running asks for no new consent, so a price Stripe could not say does not
  // hold that up.
  const finishingFirst =
    subscription?.status === "incomplete" && subscription.payable && billing.selling && !granted
      ? owingInterval
      : null;
  const finishInterval =
    subscription?.payable &&
    // A grant refuses the first payment and nothing else: `sellsSomething`
    // counts a resume as a sale only on `incomplete`, so the service's line and
    // this one are the same line.
    !(granted && subscription.status === "incomplete") &&
    (billing.selling || subscription.status !== "incomplete") &&
    (finishingFirst === null || priced(finishingFirst))
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
    actionFor(subscription.interval).kind === "release"
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
  // The plans the tab would sell, and the ones it does: only at a price Stripe
  // gave, because a button whose terms cannot say what it charges is asking for
  // consent to an amount nobody has been told. A price Stripe could not say is
  // named instead, so a plan does not vanish with no word why.
  //
  // While a first payment is outstanding, or the retries have run out, the
  // plan they chose is paid for by the button above and the *other* one is a
  // real press: `replace` on an `incomplete` — abandon the subscription nobody
  // paid for and make the one they asked for, which voids its invoice and
  // charges nothing — and `schedule` on an `unpaid`. Emptying this instead
  // pinned somebody who pressed the wrong price to it, with nothing else on
  // the tab to press, until Stripe expired the subscription 23 hours later.
  // The plan they are on is left out rather than drawn disabled, because
  // "You are on the annual plan already" is not true of one nobody has paid
  // for, and the button above it takes that payment under its own name.
  const offers: BillingInterval[] = !billing.selling
    ? []
    : owingInterval
      ? [otherThan(owingInterval)]
      : ["yearly", "monthly"];
  const offered = offers.filter(priced);
  const unpricedPlan =
    finishingFirst !== null && !priced(finishingFirst)
      ? "your plan"
      : // "Either" only where either is the word: with a first payment
        // outstanding one plan is on offer, and calling it both named a plan
        // the tab was not offering anyway.
        offers.length > 1 && offered.length === 0
        ? "either plan"
        : offered.length < offers.length
          ? offers.find((interval) => !priced(interval)) === "yearly"
            ? "Annual"
            : "Monthly"
          : null;
  // The note under the buttons describes pressing the plans `offers` names, so
  // it waits until every one of them has a price and a button. It asked for
  // both prices by name, which was the same question only while both plans
  // were always offered together, and the wrong one once a first payment
  // leaves the other alone on the tab.
  const movingDescribesButtons = offered.length > 0 && offered.length === offers.length;
  // Undoing a cancellation turns renewal back on, which is the consent the
  // renewal terms are for, so the button doing it has them too: the plan
  // buttons' where those are drawn and name this plan, and its own otherwise.
  // Otherwise includes a deployment selling nothing, because keeping a plan
  // sells nothing new and is offered either way. Only at a price Stripe gave,
  // for the reason the plan buttons are.
  //
  // Both spellings, because Keep my plan is what turns renewal back on and a
  // cancellation an operator dated past this period is one to turn back on
  // too. Off the flag alone the tab offered Cancel at period end in its place,
  // which would have pulled the operator's chosen day forward.
  const keptInterval =
    subscription &&
    cancellationPending(subscription) &&
    !owing &&
    subscription.interval &&
    priced(subscription.interval)
      ? subscription.interval
      : null;
  const keptTermsShared = keptInterval !== null && offered.includes(keptInterval);
  // Letting a scheduled switch go is consent of the same kind: it decides what
  // the next renewal charges — $30.00 a year rather than $3.00 a month — and
  // 17601(b)(3) makes the recurring charge a term. So Stay on the … plan has
  // the terms as Keep my plan does: the plan buttons' where those name this
  // plan, its own otherwise, and only at a price Stripe gave. Before it had a
  // button of its own the release was the priced plan button, which carried
  // them; the button that replaced it had lost them.
  const releaseTermsInterval =
    releaseInterval !== null && priced(releaseInterval) ? releaseInterval : null;
  const releaseTermsShared =
    releaseTermsInterval !== null && offered.includes(releaseTermsInterval);
  const releaseTermsOwn = releaseTermsInterval !== null && !releaseTermsShared;
  // A plan set to end with a switch still scheduled, which only a change made
  // in Stripe's dashboard leaves (canceling here lets the switch go): both
  // buttons keep the plan somebody is on, so one copy of its terms, above the
  // first of them, serves both rather than the same terms drawn twice.
  const keptTermsOwn = keptInterval !== null && !keptTermsShared && !releaseTermsOwn;

  // Whether a plan button can be pressed, and why not, from what the press
  // would be. `planChangeTakesEffect` is null exactly where the press changes
  // no interval — the plan they are on (paid already, or owed and paid by the
  // button named for that), a switch already set, a release (its own button,
  // below), a plan set to end — so those are disabled and every other press
  // is not. The buttons asked a narrower question than the server did: an
  // annual subscriber with a switch to monthly already set had an enabled
  // Monthly that the server answered with nothing, and while the plan was set
  // to end one button quietly dropped the cancellation and the other charged
  // for a year that was going to end.
  const planButton = (interval: BillingInterval) => {
    const action = actionFor(interval);
    const set = subscription?.interval !== interval && subscription?.scheduledInterval === interval;
    return {
      disabled: granted || planChangeTakesEffect(action) === null,
      // The grant is blamed only for the presses it is actually blocking.
      // `planChangeTakesEffect` is non-null for exactly the four that spend
      // money, so a plan somebody is already on, a switch already set and a
      // plan set to end keep their own sentence -- each is disabled on its own
      // account, and saying "your plan was set by an operator" there would
      // answer a question nobody asked. It is also what keeps this agreeing
      // with the route: the early check answers `ending` before it looks at a
      // grant at all.
      reason:
        granted && planChangeTakesEffect(action) !== null
          ? PLAN_GRANTED_REFUSAL
          : action.kind === "ending"
            ? PLAN_ENDING_REFUSAL
            : set
              ? `Your switch to the ${planWord(interval)} plan is already set${
                  subscription?.scheduledAt
                    ? ` for ${formatTimestamp(subscription.scheduledAt, timezone)}`
                    : ""
                }.`
              : `You are on the ${planWord(interval)} plan already.`,
    };
  };
  const annualButton = planButton("yearly");
  const monthlyButton = planButton("monthly");

  // When a change of plan takes effect, asked of the same rule the press is
  // decided by. The note said "takes effect now and charges the difference"
  // from a condition of its own that left out `past_due`, where the press
  // schedules the switch for the renewal instead of charging a failing card a
  // second time; and "at your next renewal" to somebody whose plan was set to
  // end and had none. Somebody with no plan yet reads both halves of it as the
  // description of what a later change would do, which they carry only while
  // neither half asserts anything about them: the second one ended "because
  // the period you are in has been paid for", said to a reader who has never
  // paid for a period.
  const moving: string[] = [];
  if (owingInterval) {
    // The one plan on offer while a payment is outstanding, and what pressing
    // it does — which for a first payment is abandoning a subscription nobody
    // has paid for, so the sentence says that before the press rather than
    // after it. Asked of the press's own kind and not of `takesEffect`, which
    // answers "now" for a `replace` and would have put "charges the
    // difference" beside a press that charges nothing at all.
    const other = otherThan(owingInterval);
    moving.push(
      actionFor(other).kind === "replace"
        ? `Choosing the ${planWord(other)} plan abandons this unfinished payment and starts ` +
            "that plan in its place. Nothing has been charged for this one."
        : `While a payment is owed, moving to ${planWord(other)} waits for your next renewal ` +
            "rather than charging now. Pay what is owed first to move now.",
    );
  } else if (!subscription) {
    moving.push(
      "Moving from monthly to annual takes effect now and charges the difference.",
      "Moving the other way takes effect at your next renewal.",
    );
  } else if (subscription.interval === "monthly") {
    const annual = takesEffect("yearly");
    if (annual === "now") {
      moving.push("Moving from monthly to annual takes effect now and charges the difference.");
    } else if (annual === "renewal") {
      moving.push(
        "While a payment is owed, moving to annual waits for your next renewal rather than " +
          "charging now. Pay what is owed first to move now.",
      );
    }
  } else if (subscription.interval === "yearly") {
    if (takesEffect("monthly") === "renewal") {
      moving.push(
        `Moving to monthly takes effect at your next renewal${
          periodIsPaid(subscription.status)
            ? ", because the period you are in has been paid for"
            : ""
        }.`,
      );
    }
  } else {
    // A price this deployment no longer sells: every move waits for the
    // renewal, whichever button it is.
    const waiting = offers.filter((interval) => takesEffect(interval) === "renewal");
    if (waiting.length === 2)
      moving.push("Moving to either plan takes effect at your next renewal.");
    else if (waiting[0]) {
      moving.push(`Moving to ${planWord(waiting[0])} takes effect at your next renewal.`);
    }
  }

  // The period end is a date the plan runs to only where the period has been
  // paid for (`periodIsPaid`). Stripe dates every period from its start, paid
  // or not: a first payment nobody finished carries an end a month or a year
  // out from the second it was made, and a failed renewal's end is the close
  // of the period whose invoice failed. The tab said "renews" beside both,
  // which told somebody the day after a declined card that they were paid up
  // for a year. For those, what is true is said instead: a first payment that
  // lapses, a grace that ends, a plan that is not in force.
  const periodEnd = !subscription
    ? ""
    : subscription.currentPeriodEnd && periodIsPaid(subscription.status)
      ? `${subscription.cancelAtPeriodEnd ? ", ending" : ", renews"} ${formatTimestamp(
          subscription.currentPeriodEnd,
          timezone,
        )}`
      : subscription.cancelAtPeriodEnd
        ? ", set to end"
        : "";

  // The day the plan stops, for the note saying what ending it freezes:
  // `currentPeriodEnd` where the flag says it stops there, which is what that
  // flag means, and `cancelAt` where an operator dated it further out. That
  // one is a real ending the flag is false for, and it had no note of its own
  // while the note below went on asking "if the plan ends". The status line
  // keeps asking the flag, because the date it prints beside "renews" is the
  // renewal's and not the ending's (`docs/billing-operations.md`).
  const endsOn = !subscription
    ? null
    : subscription.cancelAtPeriodEnd
      ? subscription.currentPeriodEnd
      : (subscription.cancelAt ?? null);

  // The past-due alert, from what Stripe says about the payment rather than
  // one sentence for all of them. A payment the bank wants confirmed with
  // 3-D Secure is never retried by Stripe, so "while Stripe retries" was false
  // for exactly the renewal that most needed the person, and a replaced card
  // pays off-session and meets the same question. The date the plan runs to
  // is `graceEndsAt`, the moment `resolveEntitlement` drops it, rather than
  // arithmetic left to the reader beside a "renews" date nobody had paid for.
  let pastDue: string | null = null;
  if (subscription?.pastDueSince) {
    const graceEnds = graceEndsAt(subscription.pastDueSince);
    const graceEnd = formatTimestamp(graceEnds.toISOString(), timezone);
    const waitingOnBank = subscription.awaitingAuthentication === true;
    pastDue = [
      `A payment failed on ${formatTimestamp(subscription.pastDueSince, timezone)}.`,
      subscription.lastPaymentError,
      waitingOnBank
        ? "Your bank wants you to confirm it, and Stripe will not try it again until you do."
        : null,
      // Against the moment the plan was read rather than the clock during
      // render, which would make the sentence change with no new answer.
      graceEnds.getTime() > status.dataUpdatedAt
        ? `Your plan continues for ${GRACE_IN_WORDS} from then, until ${graceEnd}.`
        : `The ${GRACE_IN_WORDS} your plan continued for ended on ${graceEnd}, so it is on ` +
          `${PLAN_LABELS.free} until what is owed is paid.`,
      !waitingOnBank && subscription.nextRetryAt
        ? `Stripe tries it again on ${formatTimestamp(subscription.nextRetryAt, timezone)}.`
        : null,
      // Paying now is named only beside a button that does it: a price this
      // deployment no longer sells has none, and changing the payment method
      // is then the way to pay — except for a bank that asks again.
      waitingOnBank
        ? payableInterval
          ? "Press Pay now to confirm it."
          : "Changing the payment method below fixes it only if the new one's bank does not ask as well."
        : payableInterval
          ? "Paying now, or changing the payment method below, fixes it right away."
          : "Changing the payment method below fixes it right away.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  // Accounts a plan freezes, said on the tab where the plan is. It said "3 of
  // 3 places in use" whether two more were frozen or none, and nothing before
  // a cancellation said what it would freeze. A frozen account is still read
  // and counted everywhere; only changes stop. The free plan's limit is the
  // one a plan ending lands on.
  //
  // What ending freezes is the server's count, never this page's: it said
  // "live minus three" and "you choose which three", and the shared rule keeps
  // the accounts marked in use instead. Somebody who chose three of five and
  // then upgraded has the same two frozen again, with no choice to make; one
  // who then archived one of the three has two frozen, not one. The count also
  // knows about an operator's grant — none where one outlasts the plan, and
  // the usual number where it has already expired, which `!billing.override`
  // here had hidden. A server that sends no count says nothing freezes, and
  // the tab says nothing rather than guessing.
  const frozen = billing.accountsFrozen ?? 0;
  const live = billing.accountsLive ?? 0;
  const freezes =
    plan === "plus" && subscription !== null && periodIsPaid(subscription.status)
      ? (billing.accountsFrozenOnFree ?? 0)
      : 0;
  const freezeWord = freezes === 1 ? "freezes" : "freeze";
  // Who picks the ones that stay usable once it has. The choice cannot be made
  // before then — nothing is frozen on the paid plan, so there is nothing to
  // choose — and where the accounts marked in use already fit, there is none
  // after it either: the ones chosen before stay.
  const choosesOnEnd = billing.activeChoicePendingOnFree === true;

  return (
    <>
      {header}
      <div className="settings-grid">
        <div className="settings-column">
          <section className="panel panel-stack">
            <header className="section-title">
              <span>
                <ShieldCheck size={19} />
              </span>
              <div>
                <h2>Your plan</h2>
                {/* Half of what the paid plan buys is the absence of
                    something a subscriber cannot see, so the ads are named on
                    both plans rather than only on the one that shows them.
                    `billing.advertises` is the deployment's configuration and
                    not this person's entitlement, which is why it still reads
                    true after somebody subscribes; `getAdPlacement` answers the
                    other question and is null for them.

                    "accounts in use at once" rather than "up to N accounts".
                    The free plan caps how many you can keep adding to, never
                    how many you keep, and the shorter phrasing is the limit
                    this product stopped enforcing two releases ago. The
                    pricing page corrected it and this tab did not, which is
                    one customer reading two numbers. */}
                <p>
                  {plan === "plus"
                    ? `${PLAN_LABELS.plus}: as many accounts as you need${
                        billing.advertises === true ? ", and no ads" : ""
                      }.`
                    : limit === null
                      ? "Everything is included on this deployment."
                      : `${PLAN_LABELS.free}: up to ${limit} accounts in use at once${
                          billing.advertises === true ? ", and ads on the page" : ""
                        }.`}
                </p>
              </div>
            </header>

            {limit !== null && billing.accountsUsed !== null ? (
              <p>
                {billing.accountsUsed} of {limit} places in use. Archiving or deleting an account
                frees its place{frozen > 0 ? ", and a frozen account can then take it" : ""}.
              </p>
            ) : null}

            {/* A plain anchor, not the router's link: leaving the plan tab is a
                document load either way, for the policy `router.tsx` explains. */}
            {limit !== null && frozen > 0 ? (
              <p>
                {frozen} of your accounts {frozen === 1 ? "is" : "are"} frozen: still readable and
                counted in every total, and closed to changes
                {billing.activeChoicePending
                  ? ` until you choose which ${limit} stay usable. `
                  : ". "}
                <a href="/accounts">
                  {billing.activeChoicePending
                    ? "Choose which accounts stay usable"
                    : "See them on Accounts"}
                </a>
              </p>
            ) : null}

            {granted && billing.override ? (
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
                {periodEnd}.
              </p>
            ) : null}

            {/* Stripe expires an unfinished first payment 23 hours after it
                was made, and charges nothing; the period end it carries is a
                date that only comes true if it is paid. */}
            {subscription?.status === "incomplete" ? (
              <Note>
                Nothing has been charged yet, and {PLAN_LABELS.plus} starts once the first payment
                goes through.{" "}
                {subscription.expiresAt
                  ? `If it is not finished by ${formatTimestamp(subscription.expiresAt, timezone)}, it lapses and nothing is charged.`
                  : "If it is not finished within a day, it lapses and nothing is charged."}
              </Note>
            ) : null}

            {subscription?.status === "unpaid" ? (
              <Note>
                Stripe has stopped retrying the payment, so the plan is not in force until what is
                owed is paid.
              </Note>
            ) : null}

            {freezes > 0 && endsOn ? (
              <Note>
                When the plan ends on {formatTimestamp(endsOn, timezone)}, {freezes} of your {live}{" "}
                accounts {freezeWord}: still readable and counted in every total, and closed to
                changes.{" "}
                {choosesOnEnd ? (
                  <>
                    You then choose which {MAX_FREE_ACCOUNTS} stay usable, on{" "}
                    <a href="/accounts">Accounts</a>.
                  </>
                ) : (
                  "The ones you chose to keep before stay usable."
                )}
              </Note>
            ) : null}

            {subscription?.scheduledInterval && subscription.scheduledAt ? (
              <Note>
                Switching to the{" "}
                {subscription.scheduledInterval === "yearly" ? "annual" : "monthly"} price on{" "}
                {formatTimestamp(subscription.scheduledAt, timezone)}. Nothing changes before then
                {/* Each way out is named only beside the button that takes it,
                    and by that button's name. Letting the switch go is a button
                    whether or not anything is for sale, because it sells
                    nothing. Replacing it, on a price this deployment no longer
                    sells, is a new schedule and so a sale, which the plan
                    buttons offer only while selling. */}
                {releaseInterval
                  ? `, and pressing Stay on the ${planWord(releaseInterval)} plan cancels the switch.`
                  : !subscription.interval && offered.length > 0
                    ? ", and choosing the other plan replaces the switch."
                    : "."}
              </Note>
            ) : null}

            {pastDue ? <Alert kind="info">{pastDue}</Alert> : null}

            {notice ? (
              <Alert kind={notice.kind} takeFocus={notice.focus}>
                {notice.text}
              </Alert>
            ) : null}
          </section>
        </div>

        <div className="settings-column">
          {pending ? (
            <section
              className="panel panel-stack"
              ref={paymentPanel}
              tabIndex={-1}
              aria-labelledby={paymentHeadingId}
            >
              <header className="section-title">
                <span>
                  <CreditCard size={19} />
                </span>
                <div>
                  {/* "Payment method", not "card": Link is offered beside a
                      card, and can be funded from a bank account. */}
                  <h2 id={paymentHeadingId}>
                    {pending.kind === "payment" ? "Payment" : "Payment method"}
                  </h2>
                  <p>Handled entirely by Stripe.</p>
                </div>
              </header>
              <Elements
                stripe={stripeFor(billing.publishableKey)}
                options={elementsOptions}
                // Remounted when the secret changes, because Elements binds to
                // the one it was created with and reusing the instance would
                // confirm the previous payment.
                key={pending.secret}
              >
                <PaymentStep
                  pending={pending}
                  prices={billing.prices}
                  termsOfUseUrl={termsOfUseUrl}
                  // Saving a payment method is two steps and the second is in
                  // here. Stripe has attached it to the customer; until the
                  // server pins it, dunning goes on retrying the one that failed.
                  onDone={(done) => confirmed(done, pending)}
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
                <h2>{hasPlanToChange ? "Change your plan" : `Upgrade to ${PLAN_LABELS.plus}`}</h2>
                {/* What the money buys, before the reassurance about stopping.
                    The tab described the plans by account count alone, which
                    left a customer on the pricing page and a customer on this
                    screen reading two different offers — and the pricing page's
                    whole argument is that the paid plan adds no feature, it
                    lifts a limit and removes advertising. `content.md` 6.3 in
                    the site's guides is the rule, and it is about exactly this:
                    two surfaces using different words at one customer. */}
                <p>
                  {billing.selling
                    ? `Every feature is on both plans. What ${PLAN_LABELS.plus} buys is the account limit lifted${
                        billing.advertises === true ? " and the ads gone" : ""
                      }. Cancel whenever you like; a canceled plan runs to the end of the period you paid for.`
                    : "This deployment is not selling subscriptions at the moment."}
                </p>
              </div>
            </header>

            {/* Why the last attempt failed, from Stripe on this load rather than
                from the form that saw it, which a reload unmounted: a declined
                first payment came back looking like one nobody had tried. */}
            {finishInterval && !paymentOpen && subscription?.lastPaymentError ? (
              <Alert kind="info">
                The last attempt to pay did not go through. {subscription.lastPaymentError}
              </Alert>
            ) : null}

            {finishInterval && !paymentOpen ? (
              <div className="form-actions">
                {subscription?.status === "unpaid" ? (
                  <Button
                    onClick={() => press(finishInterval, "settle", "finish")}
                    loading={working === "finish"}
                    disabled={anyPending}
                  >
                    Pay what is owed
                  </Button>
                ) : (
                  <Button
                    onClick={() => press(finishInterval, "upgrade", "finish")}
                    loading={working === "finish"}
                    disabled={anyPending}
                  >
                    Finish your payment
                  </Button>
                )}
              </div>
            ) : null}

            {payableInterval && !paymentOpen ? (
              <div className="form-actions">
                <Button
                  onClick={() => press(payableInterval, "settle", "pay")}
                  loading={working === "pay"}
                  disabled={anyPending}
                >
                  Pay now
                </Button>
              </div>
            ) : null}

            {unpricedPlan ? (
              <Note>
                Stripe could not say what {unpricedPlan} costs just now, and nothing is sold here
                without its price beside it. Reload the page to try again.
              </Note>
            ) : null}

            {offered.length > 0 ? (
              <RenewalTerms
                id={renewalTermsId}
                charges={offered.map((interval) => [interval, priceOf(interval)] as const)}
                termsOfUseUrl={termsOfUseUrl}
              />
            ) : null}

            {offered.length > 0 ? (
              <div className="form-actions">
                {/* The plan somebody is on stays disabled even while a switch
                    away from it is pending. Pressing it did let the switch go,
                    and it was the only thing that did while anything was for
                    sale: a filled "Annual — $30.00 a year" that bought
                    something in one state and canceled a switch for nothing
                    in the other. Letting it go has its own button now. */}
                {offered.includes("yearly") ? (
                  <Button
                    onClick={() => pressPlan("yearly", "yearly")}
                    loading={working === "yearly"}
                    aria-describedby={renewalTermsId}
                    disabled={annualButton.disabled || anyPending}
                    // The reason belongs to the button's own refusal, never to the
                    // sibling that happens to be working. `annualButton.reason` answers
                    // "why can you not press this", and `anyPending` is a different
                    // question with its own answer -- the spinner beside it, which
                    // the rule above says is the whole answer. Handed over anyway,
                    // somebody on no plan at all who pressed the other button was
                    // told "You are on the annual plan already", and told it through
                    // `aria-describedby` rather than only in passing.
                    disabledReason={annualButton.disabled ? annualButton.reason : undefined}
                  >
                    {yearly ? `Annual — ${yearly}` : "Annual"}
                  </Button>
                ) : null}
                {offered.includes("monthly") ? (
                  <Button
                    variant="secondary"
                    onClick={() => pressPlan("monthly", "monthly")}
                    loading={working === "monthly"}
                    aria-describedby={renewalTermsId}
                    disabled={monthlyButton.disabled || anyPending}
                    // The reason belongs to the button's own refusal, never to the
                    // sibling that happens to be working. `monthlyButton.reason` answers
                    // "why can you not press this", and `anyPending` is a different
                    // question with its own answer -- the spinner beside it, which
                    // the rule above says is the whole answer. Handed over anyway,
                    // somebody on no plan at all who pressed the other button was
                    // told "You are on the monthly plan already", and told it through
                    // `aria-describedby` rather than only in passing.
                    disabledReason={monthlyButton.disabled ? monthlyButton.reason : undefined}
                  >
                    {monthly ? `Monthly — ${monthly}` : "Monthly"}
                  </Button>
                ) : null}
              </div>
            ) : null}

            {/* Letting a scheduled switch go, by name, whenever the shared rule
                says the press on the plan somebody is on is a release — for
                sale or not, priced or not, because it keeps the plan already
                paid for and sells nothing new. Its renewal terms directly
                above it where the plan buttons' do not name this plan. */}
            {releaseInterval && releaseTermsOwn ? (
              <RenewalTerms
                id={releaseTermsId}
                charges={[[releaseInterval, priceOf(releaseInterval)]]}
                termsOfUseUrl={termsOfUseUrl}
              />
            ) : null}
            {releaseInterval ? (
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={() =>
                    // Never read: a release charges nothing and hands back no
                    // secret. `settle` because it is about the plan they are
                    // on, so a secret, were one ever sent, would not be named
                    // an upgrade.
                    press(releaseInterval, "settle", "release")
                  }
                  loading={working === "release"}
                  disabled={anyPending}
                  aria-describedby={
                    releaseTermsShared
                      ? renewalTermsId
                      : releaseTermsOwn
                        ? releaseTermsId
                        : undefined
                  }
                >
                  {releaseInterval === "yearly"
                    ? "Stay on the annual plan"
                    : "Stay on the monthly plan"}
                </Button>
              </div>
            ) : null}

            {movingDescribesButtons && moving.length > 0 ? <Note>{moving.join(" ")}</Note> : null}

            {keptInterval && keptTermsOwn ? (
              <RenewalTerms
                id={keepTermsId}
                charges={[[keptInterval, priceOf(keptInterval)]]}
                termsOfUseUrl={termsOfUseUrl}
              />
            ) : null}

            {/* What canceling freezes, before the press rather than after it:
                nothing else on the tab said so until the plan had ended. */}
            {freezes > 0 && subscription && !cancellationPending(subscription) ? (
              <Note>
                If the plan ends, {freezes} of your {live} accounts {freezeWord}: still readable and
                counted in every total, and closed to changes.{" "}
                {choosesOnEnd
                  ? `You then choose which ${MAX_FREE_ACCOUNTS} stay usable.`
                  : "The ones you chose to keep before stay usable."}
              </Note>
            ) : null}

            {subscription && !owing ? (
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPressed("card");
                    replaceCard.mutate();
                  }}
                  loading={working === "card"}
                  disabled={anyPending}
                >
                  Change payment method
                </Button>
                {cancellationPending(subscription) ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setPressed("keep");
                      setCancellation.mutate(false);
                    }}
                    loading={working === "keep"}
                    disabled={anyPending}
                    aria-describedby={
                      keptInterval
                        ? keptTermsShared
                          ? renewalTermsId
                          : keptTermsOwn
                            ? keepTermsId
                            : releaseTermsId
                        : undefined
                    }
                  >
                    Keep my plan
                  </Button>
                ) : (
                  <Button
                    variant="danger"
                    onClick={() => {
                      setPressed("cancel");
                      setCancellation.mutate(true);
                    }}
                    loading={working === "cancel"}
                    disabled={anyPending}
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
      <ConfirmDialog
        open={confirmCharge.open}
        title="Switch to the annual plan now?"
        description={`The annual plan${
          yearly ? ` (${yearly})` : ""
        } starts today. What is left of this month is credited against it, the difference is charged to your payment method now, and the plan then renews every year.`}
        confirmLabel="Switch and pay the difference"
        confirmVariant="primary"
        onConfirm={confirmCharge.confirm}
        onCancel={confirmCharge.cancel}
      />
    </>
  );
}
