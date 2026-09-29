// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingStatus, Session } from "../src/client/api.js";
import { formatTimestamp } from "../src/client/money.js";
import { blocks, stylesheet } from "./support/css.js";
import { PlanPage } from "../src/client/pages/PlanPage.js";
import {
  activeChoicePending,
  BILLING_GRACE_DAYS,
  frozenAccountIds,
  graceEndsAt,
  MAX_FREE_ACCOUNTS,
  PLAN_ENDING_REFUSAL,
} from "../src/shared/domain.js";

/**
 * Stripe.js, never fetched. The payment form mounts around a promise that
 * resolves to no Stripe at all, which is enough to render the form's own
 * button — the thing these tests read — without a script or a network.
 */
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: () => Promise.resolve(null) }));

/**
 * Stripe's React bindings, with a Stripe the test controls.
 *
 * By default there is none — `useStripe()` answers null, as the real bindings
 * do while Stripe.js loads — which is what most of these tests read against. A
 * test that needs a confirmation to happen sets `fake.stripe`, whose
 * `confirmPayment` and `confirmSetup` answer as it says, and calls
 * `fake.onChange` to play somebody finishing the form. Nothing here reaches
 * Stripe: the element is a placeholder, and the confirmation is the answer
 * the test wrote.
 */
const fake = vi.hoisted(() => ({
  stripe: null as null | {
    confirmPayment: (options: unknown) => Promise<unknown>;
    confirmSetup: (options: unknown) => Promise<unknown>;
  },
  onChange: undefined as undefined | ((event: { complete: boolean }) => void),
  focusElement: vi.fn(),
}));
vi.mock("@stripe/react-stripe-js", async () => {
  const { createElement } = await import("react");
  return {
    Elements: ({ children }: { children: ReactNode }) => children,
    PaymentElement: ({ onChange }: { onChange?: (event: { complete: boolean }) => void }) => {
      fake.onChange = onChange;
      return createElement("div", { "data-testid": "payment-element" });
    },
    useStripe: () => fake.stripe,
    useElements: () => (fake.stripe ? { getElement: () => ({ focus: fake.focusElement }) } : null),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fake.stripe = null;
  fake.onChange = undefined;
  fake.focusElement.mockClear();
  window.history.replaceState(null, "", "/");
});

const session = {
  user: { id: "u1", name: "Tester", email: "tester@example.com" },
} as unknown as Session;

const status = (over: Partial<BillingStatus> = {}): BillingStatus => ({
  selling: true,
  publishableKey: "pk_test_ui",
  prices: {
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  },
  entitlement: { billing: true, plan: "plus", accountLimit: null } as BillingStatus["entitlement"],
  accountsUsed: null,
  subscription: null,
  override: null,
  ...over,
});

type Subscription = NonNullable<BillingStatus["subscription"]>;
const subscription = (over: Partial<Subscription> = {}): Subscription => ({
  status: "active",
  interval: "yearly",
  currentPeriodEnd: "2027-01-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  scheduledInterval: null,
  scheduledAt: null,
  payable: false,
  ...over,
});

const DAY = 24 * 60 * 60 * 1000;

/**
 * A renewal Stripe is still retrying, on an interval this deployment sells.
 * Failed five days ago rather than on a fixed date, so the fifteen-day grace is
 * still running whenever this runs: the alert says something else once it has
 * ended.
 */
const pastDue = (over: Partial<Subscription> = {}) =>
  subscription({
    status: "past_due",
    pastDueSince: new Date(Date.now() - 5 * DAY).toISOString(),
    payable: true,
    ...over,
  });

/** An instant as the page writes it, in the timezone the page reads. */
const shown = (instant: string | Date) =>
  formatTimestamp(
    typeof instant === "string" ? instant : instant.toISOString(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

type Sent = { path: string; method: string; body: Record<string, unknown> | null };

/**
 * The plan tab against a server that answers each request as `answer` says —
 * a body, or a whole `Response` for a refusal — and records what the page
 * asked it to do.
 */
function serve(
  answer: (request: Sent) => unknown,
  termsOfUseUrl?: string,
  { strict = false }: { strict?: boolean } = {},
) {
  const requests: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const request = {
        path,
        method: init?.method ?? (init?.body ? "POST" : "GET"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      requests.push(request);
      const answered = answer(request);
      return answered instanceof Response ? answered : Response.json(answered);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (
    <QueryClientProvider client={client}>
      <PlanPage session={session} termsOfUseUrl={termsOfUseUrl} />
    </QueryClientProvider>
  );
  // StrictMode where the app runs under it and a test is about what running an
  // effect twice must not do.
  render(strict ? <StrictMode>{page}</StrictMode> : page);
  return requests;
}

/**
 * The plan tab against a server that answers from `billing`, and records what
 * the page asked it to do. `clientSecret` is what a change of plan answers with.
 */
function mount(billing: BillingStatus, clientSecret: string | null = null, termsOfUseUrl?: string) {
  return serve(
    ({ path }) =>
      path === "/api/v1/billing"
        ? billing
        : { subscriptionId: "sub_1", clientSecret, status: "past_due" },
    termsOfUseUrl,
  );
}

/** A sentence anywhere in a description that carries others beside it. */
const including = (text: string) => new RegExp(text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** A refusal as the server sends one. */
const refusal = (message: string, status = 409) =>
  Response.json({ error: { code: "CONFLICT", message } }, { status });

/** The paragraph the status badge opens, found by the badge's words. */
const statusLine = (badge: string) => screen.getByText(badge).closest("p")!;

/** The card form's section, once a secret has mounted it. */
const paymentForm = async (name = "Payment") => {
  const heading = await screen.findByRole("heading", { name });
  const form = heading.closest("section");
  if (!form) throw new Error("The payment form is not in a section");
  return form;
};

/** The submit button of the card form, once a secret has mounted it. */
const paymentFormButton = async () => within(await paymentForm()).getByRole("button");

/** The one set of renewal terms inside `scope`, found by the sentence that opens it. */
const renewalTermsIn = (scope: HTMLElement) =>
  within(scope)
    .getByText(/renews automatically until you cancel/)
    .closest("div")!;

describe("the plan tab", () => {
  /**
   * The words beside the amount are Stripe's interval, not the slot the id was
   * configured in. When the two disagree the server stops selling, so this is
   * about the label never being the one that lies.
   */
  it("says how often each price is billed in Stripe's own words", async () => {
    mount(status());
    expect(await screen.findByRole("button", { name: /Annual — \$30\.00 a year/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Monthly — \$3\.00 a month/ })).toBeVisible();
  });

  it("names the amount alone when Stripe bills it on some other interval", async () => {
    mount(
      status({
        prices: {
          monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: null },
          yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
        },
      }),
    );
    expect(await screen.findByRole("button", { name: "Monthly — $3.00" })).toBeVisible();
  });

  /**
   * A renewal or an upgrade's charge Stripe is still retrying. The server
   * answers `resume` for the interval they are on, with the open invoice's
   * secret — the one way to pay a charge the bank wants authenticated, which
   * replacing the card cannot do because that pays off-session.
   */
  it("offers to pay a failed charge now, beside the rest of the plan's controls", async () => {
    const requests = mount(status({ subscription: pastDue() }));

    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    await waitFor(() =>
      expect(requests.find((r) => r.path === "/api/v1/billing/subscription")?.body).toMatchObject({
        interval: "yearly",
      }),
    );
    // Still on a plan that is running, so changing the payment method and
    // canceling stay on offer rather than being hidden behind the payment.
    expect(screen.getByRole("button", { name: "Change payment method" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel at period end" })).toBeVisible();
  });

  it("offers no payment where nothing is owed", async () => {
    mount(status({ subscription: subscription() }));
    await screen.findByRole("button", { name: "Change payment method" });
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  });

  /**
   * Somebody settling a failed renewal is already on the plan, so the button
   * that takes the money says what it is for. "Pay and upgrade" stays for the
   * payment that does start or raise a plan.
   */
  it("names a settling payment for what it is", async () => {
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    expect(await paymentFormButton()).toHaveTextContent(/^Pay now$/);
  });

  it("names what is owed after the retries have run out as settling too", async () => {
    mount(status({ subscription: subscription({ status: "unpaid", payable: true }) }), "pi_2");
    fireEvent.click(await screen.findByRole("button", { name: "Pay what is owed" }));
    expect(await paymentFormButton()).toHaveTextContent(/^Pay now$/);
  });

  it("keeps 'Pay and upgrade' for the payment that starts a plan", async () => {
    mount(status(), "pi_first_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: /Annual/ }));
    expect(await paymentFormButton()).toHaveTextContent(/^Pay and upgrade$/);
  });

  /**
   * `payable` is the server's word on whether it would take the payment, and
   * the tab offers exactly that. Finishing a first payment is a sale, so a
   * deployment that has stopped selling refuses it; paying a renewal that is
   * owed is not, so it is offered there too.
   */
  it("offers a payment only where the server would take it", async () => {
    mount(
      status({
        selling: false,
        subscription: subscription({ status: "incomplete", payable: false }),
      }),
    );
    await screen.findByText(/not selling subscriptions/);
    expect(screen.queryByRole("button", { name: "Finish your payment" })).toBeNull();
    cleanup();

    mount(status({ selling: false, subscription: pastDue() }));
    expect(await screen.findByRole("button", { name: "Pay now" })).toBeVisible();
    cleanup();

    mount(
      status({ selling: false, subscription: subscription({ status: "unpaid", payable: true }) }),
    );
    expect(await screen.findByRole("button", { name: "Pay what is owed" })).toBeVisible();
    cleanup();

    mount(status({ subscription: pastDue({ interval: null, payable: false }) }));
    await screen.findByRole("button", { name: "Change payment method" });
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
  });

  /**
   * `selling` is asked as well as `payable`, because finishing a first payment
   * starts a subscription, and a "Finish your payment" button under "not
   * selling subscriptions" contradicts the heading whichever answer is behind.
   */
  it("never offers to finish a first payment while nothing is for sale", async () => {
    mount(
      status({
        selling: false,
        subscription: subscription({ status: "incomplete", payable: true }),
      }),
    );
    await screen.findByText(/not selling subscriptions/);
    expect(screen.queryByRole("button", { name: "Finish your payment" })).toBeNull();
    cleanup();

    mount(status({ subscription: subscription({ status: "incomplete", payable: true }) }));
    expect(await screen.findByRole("button", { name: "Finish your payment" })).toBeVisible();
  });

  /**
   * Letting a scheduled switch go sells nothing, so the server takes it while
   * nothing is for sale, and the tab keeps the one button that sends it. The
   * sentence naming it stays beside it, and only there.
   */
  it("keeps the way out of a scheduled switch while nothing is for sale", async () => {
    const switching = subscription({
      scheduledInterval: "monthly",
      scheduledAt: "2027-01-01T00:00:00.000Z",
    });
    const requests = mount(status({ selling: false, subscription: switching }));

    const stay = await screen.findByRole("button", { name: "Stay on the annual plan" });
    expect(screen.getByText(/Switching to the monthly price/)).toHaveTextContent(
      /pressing Stay on the annual plan cancels the switch/,
    );
    expect(screen.queryByRole("button", { name: /Monthly/ })).toBeNull();
    fireEvent.click(stay);
    await waitFor(() =>
      expect(requests.find((r) => r.path === "/api/v1/billing/subscription")?.body).toMatchObject({
        interval: "yearly",
      }),
    );
  });

  /**
   * On a price this deployment no longer sells there is no plan of theirs to
   * press, and replacing the switch is a sale. With nothing for sale, the note
   * names neither.
   */
  /**
   * Selling, and the plan somebody is on has no price to show: its button is
   * not drawn, and letting the switch go needs no price, so the one that sells
   * nothing is drawn in its place rather than the note naming a way out the
   * page does not offer.
   */
  it("keeps the way out of a scheduled switch when the plan has no price to show", async () => {
    mount(
      status({
        prices: { monthly: null, yearly: null },
        subscription: subscription({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    expect(await screen.findByRole("button", { name: "Stay on the annual plan" })).toBeVisible();
    expect(screen.getByText(/Switching to the monthly price/)).toHaveTextContent(
      /pressing Stay on the annual plan cancels the switch/,
    );
  });

  it("names no way out of a switch the page has no button for", async () => {
    mount(
      status({
        selling: false,
        subscription: subscription({
          interval: null,
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    const note = await screen.findByText(/Switching to the monthly price/);
    expect(note).not.toHaveTextContent(/choosing/);
    expect(screen.queryByRole("button", { name: /Stay on/ })).toBeNull();
    cleanup();

    mount(
      status({
        subscription: subscription({
          interval: null,
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    expect(await screen.findByText(/Switching to the monthly price/)).toHaveTextContent(
      /choosing the other plan replaces the switch/,
    );
    cleanup();

    // For sale, and neither plan with a price: no plan button to choose.
    mount(
      status({
        prices: { monthly: null, yearly: null },
        subscription: subscription({
          interval: null,
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    expect(await screen.findByText(/Switching to the monthly price/)).not.toHaveTextContent(
      /choosing/,
    );
  });

  /**
   * On a renewal that is owed, pressing the plan they are on is `resume`, which
   * pays the invoice rather than letting the switch go. Pay now does that under
   * its own name, so the plan button stays disabled, no Stay button is drawn,
   * and the note does not promise a cancellation it would not deliver.
   */
  it("promises no cancellation of a switch where the press would pay instead", async () => {
    mount(
      status({
        subscription: pastDue({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    const note = await screen.findByText(/Switching to the monthly price/);
    expect(note).not.toHaveTextContent(/cancels the switch/);
    expect(screen.getByRole("button", { name: /Annual/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Stay on/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Pay now" })).toBeVisible();
  });

  /**
   * Letting a switch go has a button of its own, named for what it does, while
   * the plans are for sale too. The priced button of the plan somebody is on
   * stays disabled: it was the only way out, a filled "Annual — $30.00 a year"
   * that bought a plan in one state and let a switch go for nothing in the
   * other. The Stay button decides what the next renewal charges, so it is
   * described by the terms the priced button was.
   */
  it("lets a switch go by its own button, never by the priced one", async () => {
    const requests = mount(
      status({
        subscription: subscription({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    const stay = await screen.findByRole("button", { name: "Stay on the annual plan" });
    expect(stay).toBeEnabled();
    expect(stay).toHaveAccessibleDescription(/renews automatically until you cancel/);
    const annual = screen.getByRole("button", { name: /Annual —/ });
    expect(annual).toBeDisabled();
    expect(annual).toHaveAccessibleDescription(/You are on the annual plan already\./);
    expect(screen.getByText(/Switching to the monthly price/)).toHaveTextContent(
      /pressing Stay on the annual plan cancels the switch/,
    );

    fireEvent.click(stay);
    await waitFor(() =>
      expect(requests.find((r) => r.path === "/api/v1/billing/subscription")?.body).toMatchObject({
        interval: "yearly",
      }),
    );
  });

  /**
   * A press the shared rule answers with nothing is a press the page does not
   * offer. With a switch already set, the plan it switches to was an enabled
   * button that sent a request, changed nothing and said nothing.
   */
  it("says a switch is already set on the button that would set it again", async () => {
    mount(
      status({
        subscription: subscription({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    const monthly = await screen.findByRole("button", { name: /Monthly —/ });
    expect(monthly).toBeDisabled();
    expect(monthly).toHaveAccessibleDescription(
      new RegExp(
        `Your switch to the monthly plan is already set for ${shown("2027-01-01T00:00:00.000Z")}`,
      ),
    );
    // Still described by the terms, beside the reason.
    expect(monthly).toHaveAccessibleDescription(/renews automatically until you cancel/);
    cleanup();

    // The mirror: a past-due monthly plan whose press on Annual was scheduled.
    mount(
      status({
        subscription: pastDue({
          interval: "monthly",
          scheduledInterval: "yearly",
          scheduledAt: "2026-11-25T00:00:00.000Z",
        }),
      }),
    );
    const annual = await screen.findByRole("button", { name: /Annual —/ });
    expect(annual).toBeDisabled();
    expect(annual).toHaveAccessibleDescription(/Your switch to the annual plan is already set/);
  });

  /**
   * While a cancellation is pending, a change of interval is refused by the
   * server with `PLAN_ENDING_REFUSAL`, and the buttons that would ask for one
   * are disabled with the same sentence rather than a second one. Before, one
   * button quietly dropped the cancellation and the other charged for a year
   * that was going to end.
   */
  it("holds both plans while the plan is set to end, in the server's words", async () => {
    mount(status({ subscription: subscription({ cancelAtPeriodEnd: true }) }));
    const monthly = await screen.findByRole("button", { name: /Monthly —/ });
    expect(monthly).toBeDisabled();
    expect(monthly).toHaveAccessibleDescription(including(PLAN_ENDING_REFUSAL));
    expect(screen.getByRole("button", { name: /Annual —/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep my plan" })).toBeEnabled();
    // And nothing tells somebody with no renewal ahead about their next one.
    expect(screen.queryByText(/next renewal/)).toBeNull();
    cleanup();

    mount(status({ subscription: subscription({ interval: "monthly", cancelAtPeriodEnd: true }) }));
    const annual = await screen.findByRole("button", { name: /Annual —/ });
    expect(annual).toBeDisabled();
    expect(annual).toHaveAccessibleDescription(including(PLAN_ENDING_REFUSAL));
  });

  /** How a change of plan takes effect is said only where a plan can be changed. */
  it("describes moving between plans only while they are for sale", async () => {
    mount(status({ selling: false, subscription: subscription({ interval: "monthly" }) }));
    await screen.findByText(/not selling subscriptions/);
    expect(screen.queryByText(/Moving from monthly to annual/)).toBeNull();
    cleanup();

    mount(status({ subscription: subscription({ interval: "monthly" }) }));
    expect(await screen.findByText(/Moving from monthly to annual/)).toBeVisible();
  });

  /**
   * The note asks the shared rule when a press takes effect. A past-due
   * monthly plan's press on Annual is a `schedule` for the renewal — charging
   * a failing card a second time is what the rule refuses to do — and the note
   * said "takes effect now and charges the difference" beside it.
   */
  it("says when a move takes effect as the press would make it", async () => {
    mount(status({ subscription: pastDue({ interval: "monthly" }) }));
    const owed = await screen.findByText(/moving to annual waits for your next renewal/);
    expect(owed).not.toHaveTextContent(/takes effect now/);
    cleanup();

    mount(status({ subscription: subscription({ interval: "monthly" }) }));
    expect(await screen.findByText(/Moving from monthly to annual/)).toHaveTextContent(
      "takes effect now and charges the difference",
    );
    cleanup();

    // Paid for, so the period they are in is the reason it waits.
    mount(status({ subscription: subscription() }));
    expect(await screen.findByText(/Moving to monthly takes effect/)).toHaveTextContent(
      "Moving to monthly takes effect at your next renewal, because the period you are in has " +
        "been paid for.",
    );
    cleanup();

    // Owed, so it is not.
    mount(status({ subscription: pastDue() }));
    expect(await screen.findByText(/Moving to monthly takes effect/)).not.toHaveTextContent(
      /has been paid for/,
    );
  });

  /**
   * The alert names paying now only beside a button that does it. A price
   * this deployment no longer sells has none, and the card is then the way.
   */
  it("mentions paying now only where there is a button for it", async () => {
    mount(status({ subscription: pastDue() }));
    expect(await screen.findByText(/A payment failed/)).toHaveTextContent(
      "Paying now, or changing the payment method below, fixes it right away.",
    );
    cleanup();

    mount(status({ subscription: pastDue({ interval: null, payable: false }) }));
    const alert = await screen.findByText(/A payment failed/);
    expect(alert).not.toHaveTextContent(/Paying now/);
    expect(alert).toHaveTextContent(/Changing the payment method below fixes it right away/);
  });

  /**
   * How long the plan runs on is the server's number, `BILLING_GRACE_DAYS`, so
   * the sentence cannot go on saying "a few days", or seven, after the number
   * changes. The words are this test's own list, not the page's.
   */
  it("says how long the plan continues in the server's own number of days", async () => {
    const days = BILLING_GRACE_DAYS;
    expect(days).toBeGreaterThan(0);
    const words =
      "zero one two three four five six seven eight nine ten eleven twelve thirteen " +
      "fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two " +
      "twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight " +
      "twenty-nine thirty thirty-one";
    const word = words.split(" ")[days];
    expect(word).toBeDefined();

    mount(status({ subscription: pastDue() }));
    expect(await screen.findByText(/A payment failed/)).toHaveTextContent(
      new RegExp(`continues for ${word} days from then`),
    );
  });

  /** `plus` is the wire value; a person reads the label. */
  it("names an operator's grant by the plan's label, never its wire value", async () => {
    mount(status({ override: { plan: "plus", expiresAt: null } }));
    const note = await screen.findByText(/An operator granted you/);
    expect(note).toHaveTextContent(/granted you Premium with no end date/);
    expect(note).not.toHaveTextContent(/\bplus\b/);
  });
});

/**
 * California's Automatic Renewal Law, on the screen that asks for the consent.
 *
 * Business and Professions Code 17602(a)(1) wants the renewal terms clear and
 * conspicuous and in visual proximity to the request for consent, and 17601(b)
 * says what they are: that the plan goes on until canceled, the recurring
 * charge and how often, that it may change, and how to cancel. Notice of a
 * change comes by email between 7 and 30 days ahead, which is 17602(g)(2)'s
 * window and the clause the hosted service's terms of use are being changed
 * to, word for word. Four requests on this tab, so four places — the plan
 * buttons, the payment form's confirm button, "Keep my plan", which turns
 * renewal back on, and "Stay on the … plan", which decides which price renews
 * — and each is read against the figures the buttons show rather than a price
 * written into the page. A plan Stripe could not price is not offered at all,
 * because its terms could not say what it charges.
 */
describe("the renewal terms", () => {
  it("sit beside the plan buttons, in the prices those buttons show", async () => {
    mount(
      status({
        prices: {
          monthly: {
            id: "price_monthly",
            unitAmount: 450,
            currency: "usd",
            interval: "month",
          },
          yearly: {
            id: "price_yearly",
            unitAmount: 4200,
            currency: "usd",
            interval: "year",
          },
        },
      }),
    );
    const annual = await screen.findByRole("button", {
      name: /Annual — \$42\.00 a year/,
    });
    const terms = renewalTermsIn(document.body);

    expect(terms).toHaveTextContent(
      "Premium renews automatically until you cancel. Annual charges $42.00 a year and Monthly " +
        "charges $4.50 a month, to your payment method at the start of each period.",
    );
    // The operator's change and nobody else's: a switch somebody asks for
    // takes effect when the note under the buttons says, with no notice.
    expect(terms).toHaveTextContent(
      "If we change the price, or tax is added to what a renewal costs, we'll email you between " +
        "7 and 30 days before the change takes effect, saying what it will cost and how to " +
        "cancel, and you may cancel before it does.",
    );
    expect(terms).toHaveTextContent(
      "To cancel, press Cancel at period end here on the Plan and billing tab in Settings",
    );
    expect(terms).toHaveTextContent("A canceled plan runs to the end of the period you paid for.");
    // Beside the buttons, in the same section, and the very thing each of them
    // is described by — so a screen reader hears it on the button too.
    expect(annual.closest("section")).toContainElement(terms);
    expect(annual).toHaveAccessibleDescription(/renews automatically until you cancel/);
    expect(
      screen.getByRole("button", { name: /Monthly — \$4\.50 a month/ }),
    ).toHaveAccessibleDescription(/Monthly charges \$4\.50 a month/);
  });

  it("sit beside the payment form's confirm button, for the plan being paid for alone", async () => {
    mount(status(), "pi_first_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: /Monthly/ }));
    const form = await paymentForm();
    const terms = renewalTermsIn(form);

    expect(terms).toHaveTextContent("Monthly charges $3.00 a month, to your payment method");
    expect(terms).not.toHaveTextContent(/Annual/);
    expect(
      within(form).getByRole("button", { name: "Pay and upgrade" }),
    ).toHaveAccessibleDescription(
      /Premium renews automatically until you cancel\. Monthly charges \$3\.00 a month/,
    );
  });

  it("go with a payment that settles the plan somebody is on, which goes on renewing", async () => {
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));

    expect(renewalTermsIn(await paymentForm())).toHaveTextContent(
      "Annual charges $30.00 a year, to your payment method",
    );
  });

  /**
   * Stripe unreachable, or holding no such price. The tab still renders, and
   * somebody who owes money can still pay it: that asks for no new consent. The
   * terms beside that payment name no figure rather than one written here,
   * which would be the one nobody is charged.
   */
  it("name no figure Stripe did not give", async () => {
    mount(
      status({ prices: { monthly: null, yearly: null }, subscription: pastDue() }),
      "pi_owed_secret_1",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    const terms = renewalTermsIn(await paymentForm());

    expect(terms).toHaveTextContent("Annual charges its price once a year, to your payment method");
    expect(terms).not.toHaveTextContent(/\$/);
  });

  /**
   * 17601(b)(3) makes the recurring charge one of the terms, so a plan Stripe
   * could not price is not offered: its button would ask for consent to an
   * amount nobody had been told. The page says which, rather than a plan
   * vanishing with no word why.
   */
  it("offer no plan Stripe could not price, and say so", async () => {
    mount(status({ prices: { monthly: null, yearly: null } }));
    expect(
      await screen.findByText(/Stripe could not say what either plan costs just now/),
    ).toHaveTextContent("nothing is sold here without its price beside it");
    expect(screen.queryByRole("button", { name: /Annual|Monthly/ })).toBeNull();
    expect(screen.queryByText(/renews automatically/)).toBeNull();
    cleanup();

    mount(
      status({
        prices: {
          monthly: null,
          yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
        },
      }),
    );
    const annual = await screen.findByRole("button", { name: /Annual — \$30\.00 a year/ });
    expect(screen.queryByRole("button", { name: /Monthly/ })).toBeNull();
    expect(screen.getByText(/Stripe could not say what Monthly costs just now/)).toBeVisible();
    const terms = renewalTermsIn(document.body);
    expect(terms).toHaveTextContent("Annual charges $30.00 a year, to your payment method");
    expect(terms).not.toHaveTextContent(/Monthly/);
    expect(annual).toHaveAccessibleDescription(/Annual charges \$30\.00 a year/);
  });

  /** Finishing a first payment starts the plan, so it waits on a price too. */
  it("hold a first payment for a price, and never one that is owed", async () => {
    mount(
      status({
        prices: { monthly: null, yearly: null },
        subscription: subscription({ status: "incomplete", payable: true }),
      }),
    );
    expect(
      await screen.findByText(/Stripe could not say what your plan costs just now/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Finish your payment" })).toBeNull();
    cleanup();

    mount(
      status({
        prices: { monthly: null, yearly: null },
        subscription: subscription({ status: "unpaid", payable: true }),
      }),
    );
    expect(await screen.findByRole("button", { name: "Pay what is owed" })).toBeVisible();
    expect(screen.queryByText(/Stripe could not say/)).toBeNull();
  });

  /**
   * The refresh after the press asks Stripe again, and the form it opens
   * reads the answer. A first payment beside terms that lost their figure is
   * not confirmed until the figure is back.
   */
  it("hold the confirm button while the plan being started has no price", async () => {
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/v1/billing") {
          reads += 1;
          return Response.json(
            reads === 1 ? status() : status({ prices: { monthly: null, yearly: null } }),
          );
        }
        return Response.json({ subscriptionId: "sub_1", clientSecret: "pi_first_secret_1" });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PlanPage session={session} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Monthly — \$3\.00 a month/ }));
    const form = await paymentForm();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    const pay = await within(form).findByRole("button", { name: "Pay and upgrade" });

    await waitFor(() => expect(pay).toBeDisabled());
    expect(pay).toHaveAccessibleDescription(/Stripe could not say what this plan costs just now/);
  });

  /**
   * "Keep my plan" undoes a cancellation, which turns renewal back on. It is
   * offered whether or not anything is for sale, so it carries the terms either
   * way: the plan buttons' when those name this plan, its own otherwise.
   */
  it("go with keeping a plan that was going to end", async () => {
    mount(
      status({ selling: false, subscription: subscription({ cancelAtPeriodEnd: true }) }),
      null,
      "https://smpl.money/terms/",
    );
    const keep = await screen.findByRole("button", { name: "Keep my plan" });
    const terms = renewalTermsIn(document.body);
    expect(terms).toHaveTextContent("Annual charges $30.00 a year, to your payment method");
    expect(terms).not.toHaveTextContent(/Monthly/);
    expect(within(terms).getByRole("link", { name: "terms of use" })).toBeVisible();
    expect(keep).toHaveAccessibleDescription(/renews automatically until you cancel/);
    // Directly above the row the button is in.
    expect(terms.nextElementSibling).toContainElement(keep);
    cleanup();

    mount(status({ subscription: subscription({ cancelAtPeriodEnd: true }) }));
    const shared = await screen.findByRole("button", { name: "Keep my plan" });
    expect(screen.getAllByText(/renews automatically until you cancel/)).toHaveLength(1);
    expect(shared).toHaveAccessibleDescription(/Annual charges \$30\.00 a year/);
    cleanup();

    mount(
      status({
        selling: false,
        prices: { monthly: null, yearly: null },
        subscription: subscription({ cancelAtPeriodEnd: true }),
      }),
    );
    const unpriced = await screen.findByRole("button", { name: "Keep my plan" });
    expect(screen.queryByText(/renews automatically/)).toBeNull();
    expect(unpriced).not.toHaveAttribute("aria-describedby");
  });

  /**
   * Letting a scheduled switch go decides what the next renewal charges —
   * $30.00 a year rather than $3.00 a month — which is a term 17601(b)(3)
   * names, so "Stay on the … plan" carries the terms the way "Keep my plan"
   * does. Before it had a button of its own the release was the priced plan
   * button, which did.
   */
  it("go with letting a scheduled switch go, which decides what renews", async () => {
    const switching = subscription({
      scheduledInterval: "monthly",
      scheduledAt: "2027-01-01T00:00:00.000Z",
    });
    mount(status({ subscription: switching }));
    const stay = await screen.findByRole("button", { name: "Stay on the annual plan" });
    expect(screen.getAllByText(/renews automatically until you cancel/)).toHaveLength(1);
    expect(stay).toHaveAccessibleDescription(/Annual charges \$30\.00 a year/);
    cleanup();

    // Nothing for sale, so no plan buttons and no terms of theirs: its own,
    // for this plan alone, directly above the row it is in.
    mount(status({ selling: false, subscription: switching }));
    const alone = await screen.findByRole("button", { name: "Stay on the annual plan" });
    const terms = renewalTermsIn(document.body);
    expect(terms).toHaveTextContent("Annual charges $30.00 a year, to your payment method");
    expect(terms).not.toHaveTextContent(/Monthly/);
    expect(terms.nextElementSibling).toContainElement(alone);
    expect(alone).toHaveAccessibleDescription(/renews automatically until you cancel/);
    cleanup();

    // No price Stripe gave: the button still, and no terms without a figure.
    mount(
      status({
        selling: false,
        prices: { monthly: null, yearly: null },
        subscription: switching,
      }),
    );
    const unpriced = await screen.findByRole("button", { name: "Stay on the annual plan" });
    expect(screen.queryByText(/renews automatically/)).toBeNull();
    expect(unpriced).not.toHaveAttribute("aria-describedby");
  });

  /**
   * A plan set to end that still has a switch scheduled — a change made in
   * Stripe's dashboard; canceling here lets the switch go — has two buttons
   * that keep the plan, and one copy of its terms between them.
   */
  it("are drawn once where two buttons keep the same plan", async () => {
    mount(
      status({
        selling: false,
        subscription: subscription({
          cancelAtPeriodEnd: true,
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    const keep = await screen.findByRole("button", { name: "Keep my plan" });
    const stay = screen.getByRole("button", { name: "Stay on the annual plan" });
    expect(screen.getAllByText(/renews automatically until you cancel/)).toHaveLength(1);
    expect(keep).toHaveAccessibleDescription(/Annual charges \$30\.00 a year/);
    expect(stay).toHaveAccessibleDescription(/Annual charges \$30\.00 a year/);
  });

  it("link the terms of use where the deployment has them, and only there", async () => {
    mount(status(), null, "https://smpl.money/terms/");
    const terms = await screen.findByText(/renews automatically until you cancel/);
    const link = within(terms.closest("div")!).getByRole("link", {
      name: "terms of use",
    });
    expect(link).toHaveAttribute("href", "https://smpl.money/terms/");
    cleanup();

    mount(status());
    const unlinked = await screen.findByText(/renews automatically until you cancel/);
    expect(within(unlinked.closest("div")!).queryByRole("link")).toBeNull();
  });

  it("are not drawn where nothing asks for consent", async () => {
    // Nothing for sale: no plan buttons, so no request to put them beside.
    mount(status({ selling: false, subscription: subscription() }));
    await screen.findByText(/not selling subscriptions/);
    expect(screen.queryByText(/renews automatically/)).toBeNull();
    cleanup();

    // Saving a card agrees to nothing new.
    mount(status({ selling: false, subscription: subscription() }), "seti_card_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Change payment method" }));
    await paymentForm("Payment method");
    expect(screen.queryByText(/renews automatically/)).toBeNull();
  });

  /**
   * "Clear and conspicuous" is 17601(a)(3)'s phrase for type larger than the
   * text around it, or contrasting with it, or set off from it. The notes
   * beside these terms are muted 12px, so the terms are a size larger, in ink,
   * and boxed.
   */
  it("are set off from the notes around them, and larger", () => {
    const rules = blocks(stylesheet()).filter((block) => block.context.length === 0);
    const body = (selector: string) =>
      rules.find((block) => block.selector === selector)?.body ?? "";
    const size = (declarations: string) => Number(/font-size:\s*(\d+)px/.exec(declarations)?.[1]);

    const terms = body(".plan-renewal-terms");
    expect(terms).toMatch(/border:\s*1px solid var\(--line-strong\)/);
    expect(terms).toMatch(/color:\s*var\(--ink\)/);
    expect(size(terms)).toBeGreaterThan(size(body(".note")));
  });
});

/**
 * One way to pay at a time.
 *
 * The buttons that open a payment — Finish your payment, Pay what is owed, Pay
 * now — stayed drawn beside the form they had opened: a second primary button
 * for the same payment, one of them named exactly like the form's submit, that
 * fetched the secret already on screen and changed nothing. The re-read after
 * the press still says money is owed, which is what kept them there, so each
 * case answers that way.
 */
describe("a payment form that is open", () => {
  it("is the only way to finish a first payment while it is", async () => {
    mount(
      status({ subscription: subscription({ status: "incomplete", payable: true }) }),
      "pi_first_secret_1",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Finish your payment" }));
    await paymentForm();
    expect(screen.queryByRole("button", { name: "Finish your payment" })).toBeNull();
  });

  it("is the only Pay now while it is open", async () => {
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    const form = await paymentForm();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Pay now" })).toHaveLength(1));
    expect(form).toContainElement(screen.getByRole("button", { name: "Pay now" }));
  });

  it("is the only way to pay what is owed while it is", async () => {
    mount(status({ subscription: subscription({ status: "unpaid", payable: true }) }), "pi_2");
    fireEvent.click(await screen.findByRole("button", { name: "Pay what is owed" }));
    await paymentForm();
    expect(screen.queryByRole("button", { name: "Pay what is owed" })).toBeNull();
  });

  /** A form saving a new payment method is not a payment, and Pay now is another way to pay. */
  it("hides nothing while it only saves a payment method", async () => {
    mount(status({ subscription: pastDue() }), "seti_card_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Change payment method" }));
    await paymentForm("Payment method");
    expect(screen.getByRole("button", { name: "Pay now" })).toBeVisible();
  });
});

/**
 * What the status line says a date is.
 *
 * Stripe dates a period from its start whether or not it is paid, so the
 * period end is a renewal only where `periodIsPaid` says the period has been
 * paid for. A first payment nobody finished read "Waiting for payment Annual,
 * renews" a year out; a failed renewal read "renews" on the end of the period
 * whose invoice failed, beside an alert saying the plan had fifteen days.
 */
describe("the status line", () => {
  it("names no renewal for a first payment that has not gone through, and says when it lapses", async () => {
    const lapses = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
    mount(
      status({
        subscription: subscription({
          status: "incomplete",
          payable: true,
          currentPeriodEnd: new Date(Date.now() + 365 * DAY).toISOString(),
          expiresAt: lapses,
        }),
      }),
    );
    await screen.findByText("Waiting for payment");
    expect(statusLine("Waiting for payment")).not.toHaveTextContent(/renews|ending/);
    expect(screen.getByText(/Nothing has been charged yet/)).toHaveTextContent(
      `If it is not finished by ${shown(lapses)}, it lapses and nothing is charged.`,
    );
  });

  it("names no renewal while a renewal is owed, and dates the grace instead", async () => {
    const failing = pastDue({ currentPeriodEnd: new Date(Date.now() + 25 * DAY).toISOString() });
    mount(status({ subscription: failing }));
    await screen.findByText("Payment failed");
    expect(statusLine("Payment failed")).not.toHaveTextContent(/renews|ending/);
    expect(screen.getByText(/A payment failed/)).toHaveTextContent(
      `until ${shown(graceEndsAt(failing.pastDueSince!))}.`,
    );
    cleanup();

    // Set to end, and still owed: the end is not a date anybody paid to reach.
    mount(status({ subscription: pastDue({ cancelAtPeriodEnd: true }) }));
    await screen.findByText("Payment failed");
    expect(statusLine("Payment failed")).toHaveTextContent(/, set to end\.$/);
  });

  it("names no renewal once the retries have run out", async () => {
    mount(status({ subscription: subscription({ status: "unpaid", payable: true }) }));
    await screen.findByText("Unpaid");
    expect(statusLine("Unpaid")).not.toHaveTextContent(/renews|ending/);
    expect(screen.getByText(/Stripe has stopped retrying/)).toBeVisible();
  });

  it("names the renewal, or the end, of a period that has been paid for", async () => {
    mount(status({ subscription: subscription() }));
    await screen.findByText("Active");
    expect(statusLine("Active")).toHaveTextContent(`renews ${shown("2027-01-01T00:00:00.000Z")}.`);
    cleanup();

    mount(status({ subscription: subscription({ cancelAtPeriodEnd: true }) }));
    await screen.findByText("Active");
    expect(statusLine("Active")).toHaveTextContent(`ending ${shown("2027-01-01T00:00:00.000Z")}.`);
  });

  /** Stripe's own sentence for the last failed attempt, read from Stripe on this load. */
  it("says why the last attempt at a first payment failed, beside the way to finish it", async () => {
    mount(
      status({
        subscription: subscription({
          status: "incomplete",
          payable: true,
          lastPaymentError: "Your card has insufficient funds.",
        }),
      }),
    );
    const said = await screen.findByText(/The last attempt to pay did not go through/);
    expect(said).toHaveTextContent("Your card has insufficient funds.");
    expect(said.closest("section")).toContainElement(
      screen.getByRole("button", { name: "Finish your payment" }),
    );
  });
});

/**
 * The past-due alert, from where Stripe says the payment has got to.
 *
 * A renewal the bank wants confirmed with 3-D Secure is never retried by
 * Stripe, and the alert said "while Stripe retries" for it; a new card pays
 * off-session and meets the same question, which the alert did not say either.
 */
describe("the past-due alert", () => {
  it("says the bank is waiting, not that Stripe is retrying, and points at Pay now", async () => {
    mount(status({ subscription: pastDue({ awaitingAuthentication: true }) }));
    const alert = await screen.findByText(/A payment failed/);
    expect(alert).toHaveTextContent("Your bank wants you to confirm it");
    expect(alert).toHaveTextContent("Stripe will not try it again until you do.");
    expect(alert).toHaveTextContent("Press Pay now to confirm it.");
    expect(alert).not.toHaveTextContent(/retries|tries it again on|fixes it right away/);
  });

  it("says when Stripe tries again, and why the last try failed", async () => {
    const retry = new Date(Date.now() + 2 * DAY).toISOString();
    mount(
      status({
        subscription: pastDue({ nextRetryAt: retry, lastPaymentError: "Your card was declined." }),
      }),
    );
    const alert = await screen.findByText(/A payment failed/);
    expect(alert).toHaveTextContent("Your card was declined.");
    expect(alert).toHaveTextContent(`Stripe tries it again on ${shown(retry)}.`);
  });

  it("says the grace has ended once it has", async () => {
    const since = new Date(Date.now() - 20 * DAY).toISOString();
    mount(status({ subscription: pastDue({ pastDueSince: since }) }));
    expect(await screen.findByText(/A payment failed/)).toHaveTextContent(
      `The fifteen days your plan continued for ended on ${shown(graceEndsAt(since))}`,
    );
  });
});

/**
 * Accounts the plan freezes, said where the plan is.
 *
 * "3 of 3 places in use" read the same with two more accounts frozen or none,
 * and nothing said a cancellation would freeze any until it had.
 */
describe("frozen accounts on the plan tab", () => {
  const free = { billing: true, plan: "free", accountLimit: 3 } as BillingStatus["entitlement"];

  it("says how many are frozen and points at the choice that is still open", async () => {
    mount(
      status({
        entitlement: free,
        accountsUsed: 3,
        accountsFrozen: 2,
        accountsLive: 5,
        activeChoicePending: true,
      }),
    );
    const said = await screen.findByText(/2 of your accounts are frozen/);
    expect(said).toHaveTextContent("until you choose which 3 stay usable.");
    expect(
      within(said).getByRole("link", { name: "Choose which accounts stay usable" }),
    ).toHaveAttribute("href", "/accounts");
    cleanup();

    mount(status({ entitlement: free, accountsUsed: 3, accountsFrozen: 1, accountsLive: 4 }));
    const made = await screen.findByText(/1 of your accounts is frozen/);
    expect(within(made).getByRole("link", { name: "See them on Accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    cleanup();

    mount(status({ entitlement: free, accountsUsed: 3, accountsFrozen: 0, accountsLive: 3 }));
    await screen.findByText(/3 of 3 places in use/);
    expect(screen.queryByText(/frozen:/)).toBeNull();
  });

  /** Five accounts, the oldest first, marked in use or not. */
  const ledger = (active: (n: number) => boolean, archived: (n: number) => boolean = () => false) =>
    [1, 2, 3, 4, 5].map((n) => ({
      id: `acct_${n}`,
      createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
      archivedAt: archived(n) ? new Date(Date.UTC(2026, 5, n)).toISOString() : null,
      active: active(n),
    }));
  /**
   * What the server says ending the paid plan would do to `accounts`: the
   * shared rule, under the free plan's limit. The page shows this and works
   * nothing out of its own.
   */
  const onFree = (accounts: ReturnType<typeof ledger>) => {
    const live = accounts.filter((account) => account.archivedAt === null);
    return {
      accountsLive: live.length,
      accountsFrozenOnFree: frozenAccountIds(
        { billing: true, plan: "free", accountLimit: MAX_FREE_ACCOUNTS, source: "subscription" },
        accounts,
      ).size,
      activeChoicePendingOnFree: activeChoicePending(MAX_FREE_ACCOUNTS, live),
    };
  };

  it("says what ending the plan will freeze, before the press and after it", async () => {
    // Five opened on the paid plan, every one in use: two freeze, and the
    // choice of which is still to make.
    const opened = onFree(ledger(() => true));
    mount(status({ ...opened, subscription: subscription() }));
    expect(await screen.findByText(/If the plan ends/)).toHaveTextContent(
      "If the plan ends, 2 of your 5 accounts freeze: still readable and counted in every total, " +
        "and closed to changes. You then choose which 3 stay usable.",
    );
    cleanup();

    mount(status({ ...opened, subscription: subscription({ cancelAtPeriodEnd: true }) }));
    const note = await screen.findByText(/When the plan ends on/);
    expect(note).toHaveTextContent(
      `When the plan ends on ${shown("2027-01-01T00:00:00.000Z")}, 2 of your 5 accounts freeze`,
    );
    expect(note).toHaveTextContent("You then choose which 3 stay usable, on Accounts.");
    expect(within(note).getByRole("link", { name: "Accounts" })).toHaveAttribute(
      "href",
      "/accounts",
    );
    cleanup();

    // Three fit on the free plan, so ending it freezes nothing.
    mount(
      status({
        ...onFree(
          ledger(
            (n) => n <= 3,
            (n) => n > 3,
          ),
        ),
        subscription: subscription(),
      }),
    );
    await screen.findByRole("button", { name: "Cancel at period end" });
    expect(screen.queryByText(/If the plan ends/)).toBeNull();
  });

  /**
   * The shared rule keeps the accounts marked in use, so what ending freezes
   * is not "every account past the third". Somebody who chose three of five on
   * the free plan and then upgraded gets the same two frozen again, with no
   * choice left to make; one who then archived one of the three has four live
   * and still two frozen. The page said "1 of your 4 accounts freeze" and
   * "you choose which 3" for that.
   */
  it("says what the shared rule freezes, not every account past the limit", async () => {
    const chose = onFree(ledger((n) => n <= 3));
    expect(chose).toEqual({
      accountsLive: 5,
      accountsFrozenOnFree: 2,
      activeChoicePendingOnFree: false,
    });
    mount(status({ ...chose, subscription: subscription() }));
    const note = await screen.findByText(/If the plan ends/);
    expect(note).toHaveTextContent("2 of your 5 accounts freeze");
    expect(note).toHaveTextContent("The ones you chose to keep before stay usable.");
    expect(note).not.toHaveTextContent(/choose which/);
    cleanup();

    mount(status({ ...chose, subscription: subscription({ cancelAtPeriodEnd: true }) }));
    const after = await screen.findByText(/When the plan ends on/);
    expect(after).toHaveTextContent("The ones you chose to keep before stay usable.");
    expect(within(after).queryByRole("link")).toBeNull();
    cleanup();

    const archivedOne = onFree(
      ledger(
        (n) => n <= 3,
        (n) => n === 1,
      ),
    );
    expect(archivedOne).toMatchObject({ accountsLive: 4, accountsFrozenOnFree: 2 });
    mount(status({ ...archivedOne, subscription: subscription() }));
    expect(await screen.findByText(/If the plan ends/)).toHaveTextContent(
      "If the plan ends, 2 of your 4 accounts freeze",
    );
    cleanup();

    // One, and the verb agrees with it.
    mount(status({ accountsLive: 4, accountsFrozenOnFree: 1, subscription: subscription() }));
    expect(await screen.findByText(/If the plan ends/)).toHaveTextContent(
      "If the plan ends, 1 of your 4 accounts freezes:",
    );
  });

  /**
   * The count is the server's, and it knows about an operator's grant. A
   * server that sends none says nothing freezes, and the page does not work
   * one out of the live count. A grant that has expired no longer hides it.
   *
   * A container from before the two fields sends neither, and this bundle can
   * be served by one: the whole sentence has to go rather than be guessed at,
   * before the cancellation and after it alike.
   */
  it("says nothing the server did not count, and is not hidden by a grant that has ended", async () => {
    mount(status({ accountsLive: 5, subscription: subscription() }));
    await screen.findByRole("button", { name: "Cancel at period end" });
    expect(screen.queryByText(/If the plan ends/)).toBeNull();
    cleanup();

    mount(status({ accountsLive: 5, subscription: subscription({ cancelAtPeriodEnd: true }) }));
    await screen.findByRole("button", { name: "Keep my plan" });
    expect(screen.queryByText(/When the plan ends on/)).toBeNull();
    cleanup();

    mount(
      status({
        ...onFree(ledger(() => true)),
        override: { plan: "plus", expiresAt: "2026-01-01T00:00:00.000Z" },
        subscription: subscription(),
      }),
    );
    expect(await screen.findByText(/If the plan ends/)).toHaveTextContent("2 of your 5 accounts");
  });
});

/** Stripe confirming the form, as the test says it did. */
function stripeAnswers(answers: {
  confirmPayment?: () => Promise<unknown>;
  confirmSetup?: () => Promise<unknown>;
}) {
  const calls: unknown[] = [];
  fake.stripe = {
    confirmPayment: async (options) => {
      calls.push(options);
      return (await answers.confirmPayment?.()) ?? {};
    },
    confirmSetup: async (options) => {
      calls.push(options);
      return (await answers.confirmSetup?.()) ?? {};
    },
  };
  return calls;
}

/**
 * What happens once Stripe has answered the form.
 *
 * Focus, first: the button disables itself while it works, which makes the
 * browser blur it, and Stripe's 3-D Secure window never hands focus back, so a
 * decline and a success both left it on `<body>` (`web.md` 13.3). It lands on
 * the sentence saying what happened. And the plan is read again after every
 * one of them, so a renewal just paid is not left saying "Payment failed".
 */
describe("after the form is confirmed", () => {
  it("puts focus on Stripe's refusal, inside the form", async () => {
    stripeAnswers({
      confirmPayment: async () => ({
        error: { type: "card_error", message: "Your card was declined." },
      }),
    });
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    const form = await paymentForm();
    fireEvent.click(await within(form).findByRole("button", { name: "Pay now" }));

    const refused = await within(form).findByRole("alert");
    expect(refused).toHaveTextContent("Your card was declined.");
    await waitFor(() => expect(document.activeElement).toBe(refused));
  });

  /**
   * Stripe's element draws a validation error inline, beside the field, and
   * clears it itself. A copy here stayed after the element cleared its own,
   * saying "select a payment method" beside a Link wallet just unlocked.
   */
  it("leaves a validation error to the element, and clears its own once the form is complete", async () => {
    let answer: unknown = {
      error: { type: "validation_error", message: "Please select a payment method." },
    };
    stripeAnswers({ confirmSetup: async () => answer });
    mount(status({ subscription: subscription() }), "seti_card_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Change payment method" }));
    const form = await paymentForm("Payment method");
    const save = await within(form).findByRole("button", { name: "Save this payment method" });

    fireEvent.click(save);
    await waitFor(() => expect(fake.focusElement).toHaveBeenCalled());
    expect(within(form).queryByRole("alert")).toBeNull();

    answer = { error: { type: "card_error", message: "Your card was declined." } };
    fireEvent.click(save);
    await within(form).findByRole("alert");
    act(() => fake.onChange?.({ complete: false }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Your card was declined.");
    act(() => fake.onChange?.({ complete: true }));
    await waitFor(() => expect(within(form).queryByRole("alert")).toBeNull());
  });

  it("says a payment went through, takes focus, and reads the plan again", async () => {
    stripeAnswers({ confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }) });
    let billing = status({ subscription: pastDue() });
    const requests = serve(({ path }) =>
      path === "/api/v1/billing"
        ? billing
        : { subscriptionId: "sub_1", clientSecret: "pi_owed_secret_1", status: "past_due" },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    const form = await paymentForm();
    const reads = requests.filter((r) => r.path === "/api/v1/billing").length;
    billing = status({ subscription: subscription() });
    fireEvent.click(await within(form).findByRole("button", { name: "Pay now" }));

    const said = await screen.findByText("Payment received, and what was owed is paid.");
    const alert = said.closest(".alert")!;
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(requests.filter((r) => r.path === "/api/v1/billing").length).toBeGreaterThan(reads);
    await screen.findByText("Active");
    expect(screen.queryByRole("button", { name: "Pay now" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Payment" })).toBeNull();
  });

  /** A first payment, or an upgrade's charge, puts somebody on the plan it was for. */
  it("says which plan a payment that starts one put somebody on", async () => {
    stripeAnswers({ confirmPayment: async () => ({ paymentIntent: { status: "succeeded" } }) });
    mount(status(), "pi_first_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: /Annual —/ }));
    fireEvent.click(
      await within(await paymentForm()).findByRole("button", { name: "Pay and upgrade" }),
    );
    expect(
      await screen.findByText("Payment received, and you are on the annual plan."),
    ).toBeVisible();
  });

  /** A bank payment Stripe has not settled yet is not called paid. */
  it("says a payment still being processed is, rather than that it went through", async () => {
    stripeAnswers({ confirmPayment: async () => ({ paymentIntent: { status: "processing" } }) });
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    fireEvent.click(await within(await paymentForm()).findByRole("button", { name: "Pay now" }));
    expect(await screen.findByText(/Your payment is still being processed/)).toBeVisible();
    expect(screen.queryByText(/Payment received/)).toBeNull();
  });

  /** Where Stripe comes back to: this tab, and nothing a previous return put on the address. */
  it("comes back to the tab's own path, whatever is on the address", async () => {
    window.history.replaceState(null, "", "/settings/plan?stale=1");
    const calls = stripeAnswers({
      confirmPayment: async () => ({ error: { type: "card_error", message: "Declined." } }),
    });
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    fireEvent.click(await screen.findByRole("button", { name: "Pay now" }));
    fireEvent.click(await within(await paymentForm()).findByRole("button", { name: "Pay now" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      confirmParams: { return_url: `${window.location.origin}/settings/plan` },
    });
  });
});

/**
 * A new payment method, and what it did about anything owed.
 *
 * The confirmation says whether the new method paid what was owed, was
 * declined, or met a bank that wants the payment confirmed, and the page
 * says which. It read none of it, so a declined replacement closed the form as
 * though it had worked, beside an alert saying that replacing the card fixes
 * it right away.
 */
describe("a saved payment method", () => {
  const saving = (confirmation: unknown) => {
    stripeAnswers({
      confirmSetup: async () => ({ setupIntent: { id: "seti_1", status: "succeeded" } }),
    });
    return serve(({ path }) => {
      if (path === "/api/v1/billing") return status({ subscription: pastDue() });
      if (path === "/api/v1/billing/payment-setups") return { clientSecret: "seti_1_secret_x" };
      return confirmation;
    });
  };
  const save = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Change payment method" }));
    const form = await paymentForm("Payment method");
    fireEvent.click(await within(form).findByRole("button", { name: "Save this payment method" }));
  };

  it("says a declined method is saved and did not pay, in Stripe's words, with focus", async () => {
    const requests = saving({
      attached: true,
      paidInvoice: false,
      invoice: "declined",
      declineMessage: "Your card was declined.",
    });
    await save();
    const said = await screen.findByText(/could not pay what is owed/);
    expect(said).toHaveTextContent(
      "Your new payment method is saved, but it could not pay what is owed. Your card was " +
        "declined. Press Pay now to pay with a different one, or change the payment method again.",
    );
    const alert = said.closest(".alert")!;
    expect(alert).toHaveAttribute("role", "alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(
      requests.find((r) => r.path === "/api/v1/billing/payment-setups/confirmations")?.body,
    ).toMatchObject({ setupIntentId: "seti_1" });
    expect(screen.queryByRole("heading", { name: "Payment method" })).toBeNull();
  });

  it("says the bank wants the payment confirmed, and names the button that does it", async () => {
    saving({ attached: true, paidInvoice: false, invoice: "needs_authentication" });
    await save();
    expect(await screen.findByText(/its bank wants to confirm/)).toHaveTextContent(
      "Press Pay now to confirm it.",
    );
  });

  it("says a method that paid what was owed did, and one with nothing owed is simply saved", async () => {
    saving({ attached: true, paidInvoice: true, invoice: "paid" });
    await save();
    expect(
      await screen.findByText("Your new payment method is saved, and it paid what was owed."),
    ).toBeVisible();
    cleanup();

    saving({ attached: true, paidInvoice: false, invoice: "none" });
    await save();
    expect(
      await screen.findByText("Your new payment method is saved. Renewals charge it from now on."),
    ).toBeVisible();
  });

  it("says the server's refusal, and closes the form whose intent is spent", async () => {
    saving(
      refusal(
        "That payment method cannot pay this subscription. Use a card or Link instead. Nothing was changed.",
      ),
    );
    await save();
    const said = await screen.findByText(/cannot pay this subscription/);
    await waitFor(() => expect(document.activeElement).toBe(said.closest(".alert")));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Payment method" })).toBeNull(),
    );
  });
});

/**
 * A refused change of plan is the moment the page learns its picture was out of
 * date, and it read nothing, so the same stale button refused again.
 */
describe("a refused change of plan", () => {
  it("reads the plan again, and offers what the server now says", async () => {
    let billing = status();
    const requests = serve(({ path }) => {
      if (path === "/api/v1/billing") return billing;
      billing = status({ selling: false });
      return refusal("This deployment is not selling subscriptions at the moment.");
    });
    fireEvent.click(await screen.findByRole("button", { name: /Annual —/ }));

    const said = await screen.findByRole("alert");
    expect(said).toHaveTextContent("This deployment is not selling subscriptions at the moment.");
    // The button that was pressed let go of focus while it worked.
    await waitFor(() => expect(document.activeElement).toBe(said));
    await waitFor(() =>
      expect(requests.filter((r) => r.path === "/api/v1/billing")).toHaveLength(2),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /Annual —/ })).toBeNull());
  });
});

/**
 * The plan tab against a server whose plan is `before` until the page writes
 * something, and `after` from then on: the read that follows a press.
 */
function changing(
  before: BillingStatus,
  after: BillingStatus,
  answer: unknown = { subscriptionId: "sub_1", clientSecret: null, status: "active" },
) {
  let billing = before;
  return serve(({ path }) => {
    if (path === "/api/v1/billing") return billing;
    billing = after;
    return answer;
  });
}

/** Presses a button the way a keyboard does: focused first, then activated. */
const pressFocused = async (name: string | RegExp) => {
  const button = await screen.findByRole("button", { name });
  act(() => button.focus());
  fireEvent.click(button);
};

/** The alert a sentence is in, once it is the element with focus. */
const focusedOn = async (text: string) => {
  const said = await screen.findByText(text);
  const alert = said.closest(".alert");
  await waitFor(() => expect(document.activeElement).toBe(alert));
};

/**
 * A press that needs no payment, and says what it did.
 *
 * Each of these buttons disables itself while it works — which makes the
 * browser blur it — or goes with what it changed, as Stay on the … plan goes
 * with the switch, and none of them said anything: focus fell to `<body>`,
 * and a charge for the difference happened with nothing but a badge to show
 * for it. The date in each sentence is the one the read after the press gave.
 */
describe("a change that needs no payment", () => {
  it("says the plan is set to end, and when, with focus", async () => {
    changing(
      status({ subscription: subscription() }),
      status({ subscription: subscription({ cancelAtPeriodEnd: true }) }),
    );
    await pressFocused("Cancel at period end");
    await focusedOn(
      `Your plan is set to end on ${shown("2027-01-01T00:00:00.000Z")}. Press Keep my plan to keep it.`,
    );
    expect(screen.getByRole("button", { name: "Keep my plan" })).toBeVisible();
    cleanup();

    // Owed: the period end is not a day anybody paid to reach.
    changing(
      status({ subscription: pastDue() }),
      status({ subscription: pastDue({ cancelAtPeriodEnd: true }) }),
    );
    await pressFocused("Cancel at period end");
    await focusedOn("Your plan is set to end. Press Keep my plan to keep it.");
    cleanup();

    // A read that does not show it yet names no button it does not draw.
    changing(status({ subscription: subscription() }), status({ subscription: subscription() }));
    await pressFocused("Cancel at period end");
    await focusedOn(`Your plan is set to end on ${shown("2027-01-01T00:00:00.000Z")}.`);
  });

  it("says the plan renews again once it is kept, with focus", async () => {
    changing(
      status({ subscription: subscription({ cancelAtPeriodEnd: true }) }),
      status({ subscription: subscription() }),
    );
    await pressFocused("Keep my plan");
    await focusedOn(`Your plan renews again on ${shown("2027-01-01T00:00:00.000Z")}.`);
    cleanup();

    changing(
      status({ subscription: pastDue({ cancelAtPeriodEnd: true }) }),
      status({ subscription: pastDue() }),
    );
    await pressFocused("Keep my plan");
    await focusedOn("Your plan is no longer set to end.");
  });

  it("says an upgrade is in force and was charged for, with focus", async () => {
    changing(
      status({ subscription: subscription({ interval: "monthly" }) }),
      status({ subscription: subscription() }),
    );
    await pressFocused(/Annual —/);
    await focusedOn(
      "You are on the annual plan now, and the difference was charged to your payment method.",
    );
  });

  it("says when a scheduled switch happens, by the date the read after it gave", async () => {
    changing(
      status({ subscription: subscription() }),
      status({
        subscription: subscription({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    await pressFocused(/Monthly —/);
    await focusedOn(
      `Your switch to the monthly plan is set for ${shown("2027-01-01T00:00:00.000Z")}.`,
    );
    cleanup();

    changing(status({ subscription: subscription() }), status({ subscription: subscription() }));
    await pressFocused(/Monthly —/);
    await focusedOn("Your switch to the monthly plan is set for your next renewal.");
  });

  it("says a switch was let go, where the button that did it has gone", async () => {
    changing(
      status({
        subscription: subscription({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
      status({ subscription: subscription() }),
    );
    await pressFocused("Stay on the annual plan");
    await focusedOn("You are staying on the annual plan, and the switch is canceled.");
    expect(screen.queryByRole("button", { name: "Stay on the annual plan" })).toBeNull();
  });

  /**
   * A press that usually hands back a payment, answered with none because
   * nothing is owed any more — a second tab paid it. The plan it left is
   * said where it is the one asked for and paid for, and nothing otherwise.
   */
  it("says the plan a payment found already paid, and nothing it cannot vouch for", async () => {
    changing(status({ subscription: pastDue() }), status({ subscription: subscription() }));
    await pressFocused("Pay now");
    await focusedOn("You are on the annual plan.");
    cleanup();

    changing(status({ subscription: pastDue() }), status({ subscription: pastDue() }));
    await pressFocused("Pay now");
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay now" })).toBeEnabled());
    expect(screen.queryByText("You are on the annual plan.")).toBeNull();
  });
});

/**
 * The form a press opens.
 *
 * The button that opened it is gone — Pay now, Finish your payment and Pay
 * what is owed are hidden while a payment form is open, and a first
 * subscription's plan buttons go with the read that follows — or disabled
 * while it worked, which blurs it. Focus fell to `<body>`, and the form was a
 * Tab from the top of the page away.
 */
describe("a form that opens", () => {
  it("takes focus from the button that opened it", async () => {
    mount(status({ subscription: pastDue() }), "pi_owed_secret_1");
    await pressFocused("Pay now");
    const paying = await screen.findByRole("region", { name: "Payment" });
    await waitFor(() => expect(document.activeElement).toBe(paying));
    cleanup();

    mount(status(), "pi_first_secret_1");
    await pressFocused(/Annual —/);
    const starting = await screen.findByRole("region", { name: "Payment" });
    await waitFor(() => expect(document.activeElement).toBe(starting));
    cleanup();

    mount(
      status({ subscription: subscription({ status: "incomplete", payable: true }) }),
      "pi_first_secret_1",
    );
    await pressFocused("Finish your payment");
    const finishing = await screen.findByRole("region", { name: "Payment" });
    await waitFor(() => expect(document.activeElement).toBe(finishing));
  });

  /** Keyed on the secret, so a form replacing another moves focus into it too. */
  it("takes focus again when a second form replaces the first", async () => {
    serve(({ path }) => {
      if (path === "/api/v1/billing") return status({ subscription: pastDue() });
      if (path === "/api/v1/billing/payment-setups") return { clientSecret: "seti_1_secret_x" };
      return { subscriptionId: "sub_1", clientSecret: "pi_owed_secret_1", status: "past_due" };
    });
    await pressFocused("Change payment method");
    const saving = await screen.findByRole("region", { name: "Payment method" });
    await waitFor(() => expect(document.activeElement).toBe(saving));

    await pressFocused("Pay now");
    const paying = await screen.findByRole("region", { name: "Payment" });
    await waitFor(() => expect(document.activeElement).toBe(paying));
  });
});

/**
 * Coming back from a confirmation that left the tab — a bank's page, a
 * wallet's. Stripe puts the intent, its client secret and how it went on the
 * address, and nothing read them: the method was never pinned from here, the
 * tab said nothing, and the secret stayed in the address bar.
 */
describe("a return from a redirect", () => {
  it("confirms a saved method through the same route, once, and takes the secret off the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/settings/plan?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret_y&redirect_status=succeeded",
    );
    // Under StrictMode, as `main.tsx` renders the app, which runs the effect
    // that reads the return twice on mount.
    const requests = serve(
      ({ path }) =>
        path === "/api/v1/billing"
          ? status({ subscription: pastDue() })
          : { attached: true, paidInvoice: true, invoice: "paid" },
      undefined,
      { strict: true },
    );
    expect(
      await screen.findByText("Your new payment method is saved, and it paid what was owed."),
    ).toBeVisible();
    expect(window.location.pathname).toBe("/settings/plan");
    expect(window.location.search).toBe("");
    const confirmations = requests.filter(
      (r) => r.path === "/api/v1/billing/payment-setups/confirmations",
    );
    expect(confirmations).toHaveLength(1);
    // A key made from the intent, so running this again replays the first.
    expect(confirmations[0]!.body).toEqual({
      setupIntentId: "seti_x",
      idempotencyKey: "return:seti_x",
    });
    // A fresh document: the sentence is announced, and focus is left alone.
    expect(document.activeElement).toBe(document.body);
  });

  it("says a method that failed to save was not saved, and asks nothing", async () => {
    window.history.replaceState(
      null,
      "",
      "/settings/plan?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret_y&redirect_status=failed",
    );
    const requests = mount(status({ subscription: pastDue() }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your new payment method could not be saved",
    );
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/billing"]);
    expect(window.location.search).toBe("");
  });

  it("says a payment went through, and keeps anything on the address that was not Stripe's", async () => {
    window.history.replaceState(
      null,
      "",
      "/settings/plan?payment_intent=pi_x&payment_intent_client_secret=pi_x_secret_y&redirect_status=succeeded&from=mail",
    );
    const requests = mount(status({ subscription: subscription() }));
    expect(await screen.findByText("Payment received.")).toBeVisible();
    expect(window.location.search).toBe("?from=mail");
    expect(requests.map((r) => r.path)).toEqual(["/api/v1/billing"]);
  });
});

/**
 * The row a disabled plan button shares with an enabled one. The disabled
 * one's reason hangs under it, which made its wrapper the tallest thing in a
 * row centered on its cross axis, so the enabled button sat half the reason's
 * height lower — 8.5px, 15px on a phone. Only where a reason is showing is the
 * row lined up on its tops, so a row with none is centered as it always was.
 */
describe("the plan buttons' row", () => {
  it("is lined up on the buttons' tops wherever one of them says why it is disabled", () => {
    const rules = blocks(stylesheet()).filter((block) => block.context.length === 0);
    const selectors = (rule: { selector: string }) =>
      rule.selector.split(",").map((one) => one.replaceAll(/\s+/g, " ").trim());
    const lined = rules.find((rule) =>
      selectors(rule).includes(".form-actions:has(> .button-with-reason > .button-reason)"),
    );
    expect(lined?.body).toMatch(/align-items:\s*flex-start/);
    expect(selectors(lined!)).toContain(
      ".modal-footer:has(> .button-with-reason > .button-reason)",
    );
    expect(rules.find((rule) => rule.selector === ".form-actions")?.body).toMatch(
      /align-items:\s*center/,
    );
    // A line of text in such a row takes a button's height and centers in it,
    // so lining the row up on its tops does not lift the text off the buttons'
    // midline.
    const text = rules.find((rule) => selectors(rule).includes(".form-actions > .subtle"));
    expect(text?.body).toMatch(/min-height:\s*39px/);
    expect(rules.find((rule) => rule.selector === ".button")?.body).toMatch(/min-height:\s*39px/);
  });
});
