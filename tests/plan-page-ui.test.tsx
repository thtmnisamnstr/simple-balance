// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingStatus, Session } from "../src/client/api.js";
import { PlanPage } from "../src/client/pages/PlanPage.js";
import { BILLING_GRACE_DAYS } from "../src/shared/domain.js";

/**
 * Stripe.js, never fetched. The payment form mounts around a promise that
 * resolves to no Stripe at all, which is enough to render the form's own
 * button — the thing these tests read — without a script or a network.
 */
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: () => Promise.resolve(null) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

/** A renewal Stripe is still retrying, on an interval this deployment sells. */
const pastDue = (over: Partial<Subscription> = {}) =>
  subscription({
    status: "past_due",
    pastDueSince: "2026-09-20T00:00:00.000Z",
    payable: true,
    ...over,
  });

/**
 * The plan tab against a server that answers from `billing`, and records what
 * the page asked it to do. `clientSecret` is what a change of plan answers with.
 */
function mount(billing: BillingStatus, clientSecret: string | null = null) {
  const requests: { path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, body });
      if (path === "/api/v1/billing") return Response.json(billing);
      return Response.json({ subscriptionId: "sub_1", clientSecret, status: "past_due" });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlanPage session={session} />
    </QueryClientProvider>,
  );
  return requests;
}

/** The submit button of the card form, once a secret has mounted it. */
const paymentFormButton = async () => {
  const heading = await screen.findByRole("heading", { name: "Payment" });
  const form = heading.closest("section");
  if (!form) throw new Error("The payment form is not in a section");
  return within(form).getByRole("button");
};

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
    // Still on a plan that is running, so replacing the card and canceling
    // stay on offer rather than being hidden behind the payment.
    expect(screen.getByRole("button", { name: "Replace card" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel at period end" })).toBeVisible();
  });

  it("offers no payment where nothing is owed", async () => {
    mount(status({ subscription: subscription() }));
    await screen.findByRole("button", { name: "Replace card" });
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
    await screen.findByRole("button", { name: "Replace card" });
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
      /choosing your current plan again cancels the switch/,
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
  });

  /**
   * On a renewal that is owed, pressing the plan they are on is `resume`, which
   * pays the invoice rather than letting the switch go. Pay now does that under
   * its own name, so the plan button stays disabled and the note does not
   * promise a cancellation it would not deliver.
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
    expect(screen.getByRole("button", { name: "Pay now" })).toBeVisible();
    cleanup();

    mount(
      status({
        subscription: subscription({
          scheduledInterval: "monthly",
          scheduledAt: "2027-01-01T00:00:00.000Z",
        }),
      }),
    );
    expect(await screen.findByRole("button", { name: /Annual/ })).toBeEnabled();
    expect(screen.getByText(/Switching to the monthly price/)).toHaveTextContent(
      /choosing your current plan again cancels the switch/,
    );
  });

  /** How a change of plan takes effect is said only where a plan can be changed. */
  it("describes moving between plans only while they are for sale", async () => {
    mount(status({ selling: false, subscription: subscription() }));
    await screen.findByText(/not selling subscriptions/);
    expect(screen.queryByText(/Moving from monthly to annual/)).toBeNull();
    cleanup();

    mount(status({ subscription: subscription() }));
    expect(await screen.findByText(/Moving from monthly to annual/)).toBeVisible();
  });

  /**
   * The alert names paying now only beside a button that does it. A price
   * this deployment no longer sells has none, and the card is then the way.
   */
  it("mentions paying now only where there is a button for it", async () => {
    mount(status({ subscription: pastDue() }));
    expect(await screen.findByText(/A payment failed/)).toHaveTextContent(/Paying now, or/);
    cleanup();

    mount(status({ subscription: pastDue({ interval: null, payable: false }) }));
    const alert = await screen.findByText(/A payment failed/);
    expect(alert).not.toHaveTextContent(/Paying now/);
    expect(alert).toHaveTextContent(/Replacing the card below fixes it right away/);
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
