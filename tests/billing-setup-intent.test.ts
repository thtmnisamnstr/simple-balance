import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing on, for this file only, and restored afterward because every file
 * shares one process. Only the reads below need it; the pure rule does not.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  STRIPE_SECRET_KEY: "sk_test_setup_intent",
  STRIPE_PUBLISHABLE_KEY: "pk_test_setup_intent",
  STRIPE_WEBHOOK_SECRET: "whsec_setup_intent",
  STRIPE_PRICE_MONTHLY_ID: "price_monthly",
  STRIPE_PRICE_YEARLY_ID: "price_yearly",
} as const;
const original = Object.fromEntries(
  Object.keys(billingEnvironment).map((key) => [key, process.env[key]]),
);
Object.assign(process.env, billingEnvironment);

afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * The parts of the SDK the card paths reach, and nothing else of it. Each is
 * a plain double reset before every test, so a call nothing arranged answers
 * undefined rather than reaching Stripe.
 */
const retrieve = vi.fn();
const sdk = {
  createSetupIntent: vi.fn(),
  createCustomer: vi.fn(),
  createSubscription: vi.fn(),
  retrieveSubscription: vi.fn(),
  updateSubscription: vi.fn(),
  updateCustomer: vi.fn(),
  retrieveInvoice: vi.fn(),
  updatePaymentIntent: vi.fn(),
  retrievePaymentIntent: vi.fn(),
};
vi.mock("stripe", () => ({
  default: class {
    setupIntents = { retrieve, create: sdk.createSetupIntent };
    subscriptions = {
      create: sdk.createSubscription,
      retrieve: sdk.retrieveSubscription,
      update: sdk.updateSubscription,
    };
    customers = { create: sdk.createCustomer, update: sdk.updateCustomer };
    invoices = { retrieve: sdk.retrieveInvoice };
    paymentIntents = { update: sdk.updatePaymentIntent, retrieve: sdk.retrievePaymentIntent };
  },
}));

beforeEach(() => {
  for (const double of Object.values(sdk)) double.mockReset();
});

const load = async () => {
  vi.resetModules();
  return {
    ...(await import("../src/server/stripe.js")),
    ...(await import("../src/server/services/billing.js")),
  };
};

const seconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/**
 * Whether a late `setup_intent.succeeded` may still pin its card.
 *
 * Stripe retries a delivery for up to 72 hours, so one can arrive after the
 * person has replaced that card with another. The three cases are the whole
 * rule, and the one that matters is the first: pinning there puts the card
 * somebody already replaced back in front of dunning.
 */
describe("a saved card's delivery arriving late", () => {
  const saved = { paymentMethodId: "pm_this", created: new Date("2026-09-10T00:00:00.000Z") };

  it("does not pin a card that a newer one has since replaced", async () => {
    const { isSupersededSetupIntent } = await load();
    expect(
      isSupersededSetupIntent(saved, {
        id: "pm_later",
        created: new Date("2026-09-12T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("pins over the older card it was saved to replace", async () => {
    const { isSupersededSetupIntent } = await load();
    expect(
      isSupersededSetupIntent(saved, {
        id: "pm_before",
        created: new Date("2026-03-01T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("pins again when it is already the card, and when there is none", async () => {
    const { isSupersededSetupIntent } = await load();
    expect(
      isSupersededSetupIntent(saved, {
        id: "pm_this",
        created: new Date("2026-09-10T00:01:00.000Z"),
      }),
    ).toBe(false);
    expect(isSupersededSetupIntent(saved, null)).toBe(false);
  });
});

/**
 * The date the rule compares is the intent's own card, not the intent. An
 * intent opened in one tab and confirmed after a second tab had already saved
 * and pinned a card holds the newer card of the two, and a 3-D Secure redirect
 * that never came back to the page leaves this delivery as the only way it is
 * ever pinned. Dated by the intent, it was judged the older and ignored.
 */
describe("dating a saved card", () => {
  const pinnedMeanwhile = { id: "pm_tab_b", created: new Date("2026-09-10T12:00:00.000Z") };

  it("dates the intent by its card, so a slow tab's newer card is still pinned", async () => {
    retrieve.mockResolvedValueOnce({
      id: "seti_tab_a",
      status: "succeeded",
      customer: "cus_1",
      created: seconds("2026-09-10T09:00:00.000Z"),
      payment_method: { id: "pm_tab_a", created: seconds("2026-09-10T15:00:00.000Z") },
    });
    const { fetchStripeSetupIntent, isSupersededSetupIntent } = await load();

    const intent = await fetchStripeSetupIntent("seti_tab_a");
    expect(retrieve).toHaveBeenCalledWith("seti_tab_a", { expand: ["payment_method"] });
    expect(intent.paymentMethodCreated).toEqual(new Date("2026-09-10T15:00:00.000Z"));
    expect(
      isSupersededSetupIntent(
        { paymentMethodId: "pm_tab_a", created: intent.paymentMethodCreated },
        pinnedMeanwhile,
      ),
    ).toBe(false);
  });

  it("falls back to the intent's own date only where the card came back as a bare id", async () => {
    retrieve.mockResolvedValueOnce({
      id: "seti_bare",
      status: "succeeded",
      customer: { id: "cus_1" },
      created: seconds("2026-09-10T09:00:00.000Z"),
      payment_method: "pm_bare",
    });
    const { fetchStripeSetupIntent } = await load();

    const intent = await fetchStripeSetupIntent("seti_bare");
    expect(intent).toMatchObject({ customerId: "cus_1", paymentMethodId: "pm_bare" });
    expect(intent.paymentMethodCreated).toEqual(new Date("2026-09-10T09:00:00.000Z"));
  });
});

/**
 * The payment methods a new subscription and a replacement card may use.
 *
 * Left to the account's configuration, a SetupIntent — which has no currency
 * to filter by — offered Satispay, Kakao Pay and Naver Pay for a USD
 * subscription, and saving one left the customer and the subscription billing
 * different methods. Card carries Apple Pay and Google Pay; Link is the other.
 *
 * Narrowed with the filter and never the strict list, because the strict list
 * refuses the whole request over a type the account has not turned on, and
 * Link is opt-in, and not offered at all in India.
 */
describe("which payment methods are offered", () => {
  /**
   * Stripe's two answers, on an account that has card and Satispay on and
   * Link off: a strict list naming a type the account lacks refuses the
   * request with the sentence Stripe sends, and the allowed list narrows what
   * the account's configuration would have offered.
   */
  const accountMethods = ["card", "satispay"];
  const notTurnedOn = (types: readonly string[] | undefined) => {
    const missing = types?.find((type) => !accountMethods.includes(type));
    return missing
      ? Object.assign(
          new Error(
            `The payment method type "${missing}" is invalid. Please ensure the provided type is activated in your dashboard.`,
          ),
          { statusCode: 400, type: "StripeInvalidRequestError", param: "payment_method_types" },
        )
      : null;
  };
  const accountWithoutLink = () => {
    sdk.createSetupIntent.mockImplementation(
      async (params: {
        payment_method_types?: string[];
        allowed_payment_method_types?: string[];
      }) => {
        const refusal = notTurnedOn(params.payment_method_types);
        if (refusal) throw refusal;
        const allowed = params.allowed_payment_method_types;
        return {
          id: "seti_1",
          client_secret: "seti_1_secret",
          payment_method_types: accountMethods.filter((type) => !allowed || allowed.includes(type)),
        };
      },
    );
    sdk.createSubscription.mockImplementation(
      async (params: { payment_settings?: { payment_method_types?: string[] } }) => {
        const refusal = notTurnedOn(params.payment_settings?.payment_method_types);
        if (refusal) throw refusal;
        return {
          id: "sub_1",
          status: "incomplete",
          customer: "cus_1",
          latest_invoice: { id: "in_1", confirmation_secret: { client_secret: "pi_1_secret" } },
          items: { data: [{ price: { id: "price_monthly" }, current_period_end: 1_800_000_000 }] },
        };
      },
    );
  };

  it("filters the account's methods to card and Link on the SetupIntent that replaces a card", async () => {
    sdk.createSetupIntent.mockResolvedValue({ id: "seti_1", client_secret: "seti_1_secret" });
    const { createStripeSetupIntent } = await load();

    await createStripeSetupIntent("cus_1", "key-1");

    expect(sdk.createSetupIntent).toHaveBeenCalledWith(
      { customer: "cus_1", usage: "off_session", allowed_payment_method_types: ["card", "link"] },
      { idempotencyKey: "key-1" },
    );
  });

  it("still opens a card replacement where the account has not turned Link on", async () => {
    accountWithoutLink();
    const { createStripeSetupIntent } = await load();

    await expect(createStripeSetupIntent("cus_1", "key-1")).resolves.toEqual({
      id: "seti_1",
      clientSecret: "seti_1_secret",
    });
    await expect(sdk.createSetupIntent.mock.results[0]!.value).resolves.toMatchObject({
      payment_method_types: ["card"],
    });
  });

  it("leaves a new subscription's invoices to Stripe, so an account without Link can still sell", async () => {
    accountWithoutLink();
    const { createStripeSubscription } = await load();

    await expect(
      createStripeSubscription({ customerId: "cus_1", priceId: "price_monthly" }, "key-2"),
    ).resolves.toMatchObject({ subscriptionId: "sub_1", clientSecret: "pi_1_secret" });
    const [params] = sdk.createSubscription.mock.calls[0]!;
    expect(params.payment_settings).toEqual({ save_default_payment_method: "on_subscription" });
  });

  it("offers card and Link, and does not refuse a method Stripe sent no type for", async () => {
    const { isOfferedPaymentMethodType } = await load();
    expect(isOfferedPaymentMethodType("card")).toBe(true);
    expect(isOfferedPaymentMethodType("link")).toBe(true);
    for (const type of ["satispay", "kakao_pay", "naver_pay", "us_bank_account"]) {
      expect(isOfferedPaymentMethodType(type), type).toBe(false);
    }
    expect(isOfferedPaymentMethodType(null)).toBe(true);
    expect(isOfferedPaymentMethodType(undefined)).toBe(true);
  });

  it("reads which kind of method a SetupIntent saved", async () => {
    retrieve.mockResolvedValueOnce({
      id: "seti_typed",
      status: "succeeded",
      customer: "cus_1",
      created: seconds("2026-09-10T09:00:00.000Z"),
      payment_method: {
        id: "pm_1",
        type: "satispay",
        created: seconds("2026-09-10T09:01:00.000Z"),
      },
    });
    const { fetchStripeSetupIntent } = await load();

    await expect(fetchStripeSetupIntent("seti_typed")).resolves.toMatchObject({
      paymentMethodType: "satispay",
    });
  });
});

/**
 * Making a card the one Stripe bills. The subscription is the write that can
 * refuse — it is the one that checks the currency — so it goes first, and a
 * refusal leaves the customer's default where it was rather than pointing at a
 * method the subscription will not bill.
 */
describe("pinning a card", () => {
  it("writes the subscription before the customer", async () => {
    sdk.updateSubscription.mockResolvedValue({});
    sdk.updateCustomer.mockResolvedValue({});
    const { setStripeDefaultPaymentMethod } = await load();

    await setStripeDefaultPaymentMethod(
      { customerId: "cus_1", subscriptionId: "sub_1", paymentMethodId: "pm_new" },
      "pin",
    );

    expect(sdk.updateSubscription).toHaveBeenCalledWith(
      "sub_1",
      { default_payment_method: "pm_new" },
      { idempotencyKey: "pin:subscription" },
    );
    expect(sdk.updateCustomer).toHaveBeenCalledWith(
      "cus_1",
      { invoice_settings: { default_payment_method: "pm_new" } },
      { idempotencyKey: "pin:customer" },
    );
    expect(sdk.updateSubscription.mock.invocationCallOrder[0]!).toBeLessThan(
      sdk.updateCustomer.mock.invocationCallOrder[0]!,
    );
  });

  it("changes nothing when the subscription refuses the method", async () => {
    sdk.updateSubscription.mockRejectedValue(
      Object.assign(
        new Error("The payment method type `satispay` does not support the currency usd."),
        {
          statusCode: 400,
          param: "default_payment_method",
        },
      ),
    );
    const { isUnusableDefaultPaymentMethod, setStripeDefaultPaymentMethod } = await load();

    const refused = await setStripeDefaultPaymentMethod(
      { customerId: "cus_1", subscriptionId: "sub_1", paymentMethodId: "pm_satispay" },
      "pin",
    ).catch((error: unknown) => error);

    expect(isUnusableDefaultPaymentMethod(refused)).toBe(true);
    expect(sdk.updateCustomer).not.toHaveBeenCalled();
  });

  it("tells that refusal apart from Stripe not answering", async () => {
    const { isUnusableDefaultPaymentMethod } = await load();
    expect(isUnusableDefaultPaymentMethod(new Error("connect ETIMEDOUT"))).toBe(false);
    expect(
      isUnusableDefaultPaymentMethod(
        Object.assign(new Error("No such price"), { statusCode: 400 }),
      ),
    ).toBe(false);
  });
});

/**
 * Why paying what is owed with a replaced card did not go through, in the
 * words the plan tab can use. A bank wanting 3-D Secure is its own answer,
 * because Stripe schedules no retry for it and only Pay now can confirm it; a
 * card error carries Stripe's sentence for the cardholder; anything else is a
 * decline with no sentence, because its message was written for a developer.
 */
describe("reading why an owed invoice was not paid", () => {
  it("names a payment the bank wants confirmed", async () => {
    const { invoicePaymentRefusal } = await load();
    for (const code of [
      "invoice_payment_intent_requires_action",
      "authentication_required",
      "payment_intent_action_required",
    ]) {
      expect(invoicePaymentRefusal(Object.assign(new Error("x"), { code })), code).toEqual({
        outcome: "needs_authentication",
        message: null,
      });
    }
  });

  it("carries Stripe's sentence for a declined card, and none for anything else", async () => {
    const { invoicePaymentRefusal } = await load();
    expect(
      invoicePaymentRefusal(
        Object.assign(new Error("Your card was declined."), { type: "StripeCardError" }),
      ),
    ).toEqual({ outcome: "declined", message: "Your card was declined." });
    expect(
      invoicePaymentRefusal(
        Object.assign(new Error("Your card has insufficient funds."), { rawType: "card_error" }),
      ),
    ).toEqual({ outcome: "declined", message: "Your card has insufficient funds." });
    expect(invoicePaymentRefusal(new Error("connect ETIMEDOUT"))).toEqual({
      outcome: "declined",
      message: null,
    });
  });
});

/**
 * A card typed into Pay now for a failed renewal paid the invoice and was
 * thrown away, because Stripe's own renewal PaymentIntent is not set up to keep
 * it, and the next renewal charged the card that had failed. The PaymentIntent
 * is marked before its secret goes to the browser.
 */
describe("keeping the card that pays an owed renewal", () => {
  const owedInvoice = (
    intent: Record<string, unknown> | null,
    over: Record<string, unknown> = {},
  ) => ({
    id: "in_renewal",
    status: "open",
    next_payment_attempt: null,
    payments: {
      data: [
        {
          is_default: true,
          status: "open",
          payment: { type: "payment_intent", payment_intent: intent },
        },
      ],
    },
    ...over,
  });
  const renewal = (over: Record<string, unknown> = {}) => ({
    id: "pi_renewal",
    status: "requires_payment_method",
    setup_future_usage: null,
    payment_method: null,
    last_payment_error: { message: "Your card was declined." },
    ...over,
  });

  it("marks a renewal's PaymentIntent to keep the card, keyed on the intent", async () => {
    sdk.retrieveSubscription.mockResolvedValue({ id: "sub_1", latest_invoice: "in_renewal" });
    sdk.retrieveInvoice.mockResolvedValue(owedInvoice(renewal()));
    sdk.updatePaymentIntent.mockResolvedValue({});
    const { keepCardThatPays } = await load();

    await expect(keepCardThatPays("sub_1", "req:keep-card")).resolves.toBe(true);

    expect(sdk.retrieveInvoice).toHaveBeenCalledWith("in_renewal", {
      expand: ["payments.data.payment.payment_intent"],
    });
    expect(sdk.updatePaymentIntent).toHaveBeenCalledWith(
      "pi_renewal",
      { setup_future_usage: "off_session" },
      { idempotencyKey: "req:keep-card:pi_renewal" },
    );
  });

  it("marks one waiting on 3-D Secure, which the form confirms anyway", async () => {
    sdk.retrieveSubscription.mockResolvedValue({
      id: "sub_1",
      latest_invoice: { id: "in_renewal" },
    });
    sdk.retrieveInvoice.mockResolvedValue(
      owedInvoice(renewal({ status: "requires_action", payment_method: "pm_old" })),
    );
    sdk.updatePaymentIntent.mockResolvedValue({});
    const { keepCardThatPays } = await load();

    await expect(keepCardThatPays("sub_1", "req")).resolves.toBe(true);
  });

  it("leaves alone an intent already set up to keep the card, one paid, and an invoice not owed", async () => {
    const { keepCardThatPays } = await load();
    sdk.retrieveSubscription.mockResolvedValue({ id: "sub_1", latest_invoice: "in_renewal" });

    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ setup_future_usage: "off_session" })),
    );
    await expect(keepCardThatPays("sub_1", "req")).resolves.toBe(false);

    sdk.retrieveInvoice.mockResolvedValueOnce(owedInvoice(renewal({ status: "succeeded" })));
    await expect(keepCardThatPays("sub_1", "req")).resolves.toBe(false);

    sdk.retrieveInvoice.mockResolvedValueOnce(owedInvoice(renewal(), { status: "paid" }));
    await expect(keepCardThatPays("sub_1", "req")).resolves.toBe(false);

    sdk.retrieveSubscription.mockResolvedValueOnce({ id: "sub_1", latest_invoice: null });
    await expect(keepCardThatPays("sub_1", "req")).resolves.toBe(false);

    expect(sdk.updatePaymentIntent).not.toHaveBeenCalled();
  });

  it("reads where an owed payment has got to, for the plan tab to say", async () => {
    const { fetchOwedPayment } = await load();

    sdk.retrieveInvoice.mockResolvedValueOnce(owedInvoice(renewal()));
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: "Your card was declined.",
      awaitingAuthentication: false,
      nextAttemptAt: null,
    });

    // Waiting on the bank is not a decline, even where Stripe recorded an
    // error on the way there, and Stripe says when it will try again.
    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ status: "requires_action", payment_method: "pm_1" }), {
        next_payment_attempt: seconds("2026-09-28T00:00:00.000Z"),
      }),
    );
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: null,
      awaitingAuthentication: true,
      nextAttemptAt: new Date("2026-09-28T00:00:00.000Z"),
    });

    // A first payment's intent before anybody has typed a card has no method
    // on it, and nothing to authenticate.
    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ status: "requires_confirmation", last_payment_error: null })),
    );
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: null,
      awaitingAuthentication: false,
    });

    sdk.retrieveInvoice.mockResolvedValueOnce(owedInvoice(null, { status: "paid" }));
    await expect(fetchOwedPayment("in_renewal")).resolves.toBeNull();
  });

  /**
   * Stripe clears `last_payment_error` on any write to a PaymentIntent, and
   * `keepCardThatPays` makes one the moment Pay now is pressed. From that press
   * onward the past-due alert lost the sentence saying why the card failed —
   * for good, not until a reload: only Stripe's next failed retry writes a new
   * one. The failed charge survives the write and still carries the reason.
   *
   * Read back through the intent with the charge expanded, never
   * `charges.retrieve`: the direct call needs a permission this product has
   * never asked for, and the expansion comes back under the PaymentIntents
   * Read that `docs/billing-operations.md` step 2 already requires. The
   * `charges` double is gone from the SDK stub above, so a reintroduced direct
   * call fails here rather than at a customer's restricted key.
   */
  it("reads the failed charge back through the intent when a write wiped the reason", async () => {
    const { fetchOwedPayment } = await load();

    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ last_payment_error: null, latest_charge: "ch_declined" })),
    );
    sdk.retrievePaymentIntent.mockResolvedValueOnce({
      id: "pi_renewal",
      status: "requires_payment_method",
      latest_charge: {
        id: "ch_declined",
        status: "failed",
        failure_code: "card_declined",
        failure_message: "Your card was declined.",
      },
    });

    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: "Your card was declined.",
    });
    expect(sdk.retrievePaymentIntent).toHaveBeenCalledWith("pi_renewal", {
      expand: ["latest_charge"],
    });
  });

  it("uses a charge already expanded, and asks only where the live reason is gone", async () => {
    const { fetchOwedPayment } = await load();

    // Nothing expands this far today — the intent is already at Stripe's
    // four-level limit — but a charge Stripe has handed over needs no second
    // round trip, and the shape has to be handled either way.
    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(
        renewal({
          last_payment_error: null,
          latest_charge: {
            id: "ch_expanded",
            status: "failed",
            failure_message: "Your card has insufficient funds.",
          },
        }),
      ),
    );
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: "Your card has insufficient funds.",
    });
    expect(sdk.retrievePaymentIntent).not.toHaveBeenCalled();

    // Stripe still has the reason, so the second read is not made at all.
    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ latest_charge: "ch_declined" })),
    );
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: "Your card was declined.",
    });
    expect(sdk.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  /**
   * An intent with no charge behind it has never been attempted, and a charge
   * that went through is not a refusal. Either way there is nothing to say, and
   * inventing a sentence would be worse than the missing one.
   */
  it("says nothing where there is no failed charge to read", async () => {
    const { fetchOwedPayment } = await load();

    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ last_payment_error: null, latest_charge: null })),
    );
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: null,
    });
    expect(sdk.retrievePaymentIntent).not.toHaveBeenCalled();

    sdk.retrieveInvoice.mockResolvedValueOnce(
      owedInvoice(renewal({ last_payment_error: null, latest_charge: "ch_ok" })),
    );
    sdk.retrievePaymentIntent.mockResolvedValueOnce({
      id: "pi_renewal",
      latest_charge: { id: "ch_ok", status: "succeeded", failure_message: null },
    });
    await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
      failureMessage: null,
    });
  });

  /**
   * The reason is one sentence; the retry date beside it and the intent under
   * the payment form are the rest of the alert. So the second read is
   * best-effort and its failure costs only the sentence.
   *
   * Without that, a key that cannot make it took the whole `OwedPayment` down
   * with it — `getBillingStatus` catches and stores the status alone — and the
   * past-due alert lost "Stripe tries it again on …" as well, which the live
   * intent had never carried the reason for in the first place. Strictly worse
   * than the defect this read exists to fix, and it happened on this
   * deployment's own restricted key.
   */
  it("keeps the retry date and the intent when the second read fails", async () => {
    const { fetchOwedPayment } = await load();

    const refused = Object.assign(
      new Error("Permission denied. The provided key does not have the required permissions."),
      { code: "more_permissions_required" },
    );
    for (const failure of [refused, new Error("connect ETIMEDOUT")]) {
      sdk.retrieveInvoice.mockResolvedValueOnce(
        owedInvoice(renewal({ last_payment_error: null, latest_charge: "ch_declined" }), {
          next_payment_attempt: seconds("2026-10-01T18:00:45.000Z"),
        }),
      );
      sdk.retrievePaymentIntent.mockRejectedValueOnce(failure);

      await expect(fetchOwedPayment("in_renewal")).resolves.toMatchObject({
        invoiceId: "in_renewal",
        failureMessage: null,
        nextAttemptAt: new Date("2026-10-01T18:00:45.000Z"),
        intent: { id: "pi_renewal", status: "requires_payment_method" },
      });
    }
  });
});

/**
 * The upgrade answers with what Stripe says the subscription now is, so the
 * caller can store it before a second press waiting on the lock reads it — and
 * with what the update actually raised, so the confirmation is written from
 * that rather than from the button that was pressed.
 */
describe("moving to annual now", () => {
  const upgraded = (over: Record<string, unknown> = {}) => ({
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    created: seconds("2026-09-01T00:00:00.000Z"),
    cancel_at_period_end: false,
    cancel_at: null,
    latest_invoice: { id: "in_upgrade", status: "paid" },
    schedule: null,
    items: {
      data: [
        {
          price: { id: "price_yearly" },
          current_period_end: seconds("2027-09-25T00:00:00.000Z"),
        },
      ],
    },
    ...over,
  });

  const switchTo = async (over: Record<string, unknown> = {}, previousInvoiceId = "in_monthly") => {
    sdk.updateSubscription.mockResolvedValue(upgraded(over));
    const { switchStripeSubscriptionNow } = await load();
    return switchStripeSubscriptionNow(
      { subscriptionId: "sub_1", itemId: "si_1", priceId: "price_yearly", previousInvoiceId },
      "req",
    );
  };

  it("answers with the subscription Stripe returned", async () => {
    const { snapshot } = await switchTo();

    expect(snapshot).toMatchObject({
      stripeSubscriptionId: "sub_1",
      priceId: "price_yearly",
      status: "active",
      scheduledPriceId: null,
      currentPeriodEnd: new Date("2027-09-25T00:00:00.000Z"),
    });
    expect(sdk.updateSubscription).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({ expand: ["latest_invoice"] }),
      { idempotencyKey: "req" },
    );
  });

  it("reports an invoice the update raised and collected as paid", async () => {
    await expect(switchTo()).resolves.toMatchObject({ invoice: "paid" });
  });

  /**
   * `allow_incomplete` leaves the charge open rather than refusing it, and the
   * client secret for that invoice is what the page mounts a form with.
   */
  it("reports one raised and not collected as owed", async () => {
    await expect(
      switchTo({ latest_invoice: { id: "in_upgrade", status: "open" }, status: "past_due" }),
    ).resolves.toMatchObject({ invoice: "owed" });
    await expect(
      switchTo({ latest_invoice: { id: "in_upgrade", status: "draft" } }),
    ).resolves.toMatchObject({ invoice: "owed" });
  });

  /**
   * The case the sentence was false for. A subscription set to stop has its new
   * term capped at that day, so Stripe raises nothing and parks the proration
   * as uninvoiced items — the invoice on the subscription afterward is the one
   * it already had. Told from the invoice's status alone this reads "paid", and
   * the person is told money moved that never did.
   */
  it("reports the invoice it already had as nothing billed", async () => {
    await expect(
      switchTo({ latest_invoice: { id: "in_monthly", status: "paid" } }),
    ).resolves.toMatchObject({ invoice: "none" });
    await expect(switchTo({ latest_invoice: null })).resolves.toMatchObject({ invoice: "none" });
  });

  /**
   * Neither paid nor payable. Called owed it would send the page to mount a
   * form for an invoice Stripe has given up on, which has nothing to confirm.
   */
  it("reports an invoice nobody can pay as nothing billed", async () => {
    await expect(
      switchTo({ latest_invoice: { id: "in_upgrade", status: "uncollectible" } }),
    ).resolves.toMatchObject({ invoice: "none" });
    await expect(
      switchTo({ latest_invoice: { id: "in_upgrade", status: "void" } }),
    ).resolves.toMatchObject({ invoice: "none" });
  });

  /**
   * `latest_invoice` as a bare id string, which is what Stripe sends without
   * the expand and what the SDK's type admits on every read of it.
   *
   * The answer is "nothing billed" rather than "owed": an id with no status
   * beside it is not an invoice the page can mount a form against, and the
   * delivery for the charge is the path that repairs it either way. What must
   * still survive is the id itself, on the snapshot — that is what the
   * reconciler picks the invoice back up by, and losing it there would leave a
   * real charge with nothing pointing at it.
   */
  it("reports an invoice it cannot read the status of as nothing billed", async () => {
    await expect(switchTo({ latest_invoice: "in_upgrade" })).resolves.toMatchObject({
      invoice: "none",
      snapshot: { latestInvoiceId: "in_upgrade" },
    });
  });
});

/**
 * What crosses to Stripe when this product makes somebody a customer.
 *
 * Stripe holds the email and the name because it bills with them, and the one
 * thing this product adds is `simpleBalanceUserId` — its own opaque id, which
 * is what an operator needs to tie a dashboard row back to an account and says
 * nothing a support agent could not already see. Nothing in the tree reached
 * this call before: every suite that gets as far as a customer stubs the
 * adapter function whole, so the payload itself was never looked at.
 */
describe("creating the Stripe customer for somebody who has never had one", () => {
  it("sends this product's own id and nothing else about the person", async () => {
    sdk.createCustomer.mockResolvedValue({ id: "cus_new" });
    const { createStripeCustomer } = await load();

    await expect(
      createStripeCustomer(
        { email: "person@example.com", name: "A Person", userId: "usr_opaque" },
        "req-1",
      ),
    ).resolves.toBe("cus_new");
    // The whole body, by equality rather than by `objectContaining`. A field
    // added here later — a plan name, a balance, an account count — would be
    // this product volunteering somebody's ledger to a payment processor, and
    // containment is exactly the assertion that would let it through.
    expect(sdk.createCustomer).toHaveBeenCalledWith(
      {
        email: "person@example.com",
        name: "A Person",
        metadata: { simpleBalanceUserId: "usr_opaque" },
      },
      { idempotencyKey: "req-1" },
    );
  });
});

/**
 * The seam every outbound Stripe call is counted and timed at.
 *
 * Two halves, and the suite had neither. `tests/metrics.test.ts` holds the
 * *label names* on these two metrics — no `user`, no `account`, no `id` — but
 * nothing asserted a label *value*, so `measured` could have been handed a
 * subscription id in place of a constant and every test would still have
 * passed. That is the half of the `AGENTS.md` rule with the cost attached: a
 * label built from the request is one series per customer, and the customer
 * ids are then readable by whoever can reach the scrape endpoint. Nothing
 * asserted the counters move at all either, so a `measured` wrapper dropped
 * from a call site was invisible.
 *
 * The HTTP side has both tests — `tests/metrics.test.ts` and
 * `tests/stripe-webhook-route.test.ts` — and this is the same pair for the
 * outbound side. It lives in this file rather than a new one because this file
 * already stands the SDK up behind a double, and a new file would move a
 * counted number in `docs/standards/code/testing.md`.
 */
describe("counting a call to Stripe", () => {
  /**
   * `stripe.ts` and `metrics.ts` from the same fresh module graph.
   *
   * The registry is module state, so a `metrics.js` imported at the top of this
   * file would be a different registry from the one `stripe.js` increments
   * after `vi.resetModules()` — and the assertions below would read zeros off
   * an untouched copy and pass for the wrong reason.
   */
  const loadCounted = async () => {
    vi.resetModules();
    return {
      stripe: await import("../src/server/stripe.js"),
      metrics: await import("../src/server/metrics.js"),
    };
  };

  const create = (
    stripe: { createStripeCustomer: typeof import("../src/server/stripe.js").createStripeCustomer },
    key: string,
  ) => stripe.createStripeCustomer({ email: "a@b.test", name: "A", userId: "usr_counted" }, key);

  it("counts and times it under a name from this file, in both outcomes", async () => {
    const { stripe, metrics } = await loadCounted();
    metrics.resetMetrics();

    sdk.createCustomer.mockResolvedValueOnce({ id: "cus_counted" });
    await expect(create(stripe, "req-ok")).resolves.toBe("cus_counted");
    // A plain Error, so `reportKeyRefusal` says nothing: it speaks only for the
    // two codes Stripe uses to refuse on the key rather than the request.
    sdk.createCustomer.mockRejectedValueOnce(new Error("Stripe is unreachable"));
    await expect(create(stripe, "req-fail")).rejects.toThrow("Stripe is unreachable");

    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'simple_balance_stripe_requests_total{operation="customer.create",outcome="ok"} 1',
    );
    // The failed arm counts too, and separately. Counting only successes is the
    // shape that reads as a healthy, quiet integration while every call fails.
    expect(text).toContain(
      'simple_balance_stripe_requests_total{operation="customer.create",outcome="failed"} 1',
    );
    // The duration histogram had no test of any kind, and it is the one that
    // tells a slow plan tab caused by Stripe apart from a slow one caused here.
    // Both calls are timed, the failed one included, because `measured` stops
    // the timer in a `finally`.
    expect(text).toContain(
      'simple_balance_stripe_request_duration_seconds_count{operation="customer.create"} 2',
    );
    // Neither id reached a label, which is the property the whole seam exists
    // for: a metric is read by whoever can scrape it, not by the person whose
    // money it counts.
    expect(text).not.toContain("cus_counted");
    expect(text).not.toContain("usr_counted");
  });

  it("names every counted call with a literal, never with anything from the request", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "..", "src", "server", "stripe.ts"),
      "utf8",
    );
    // Every first argument `measured` is called with, as written. The
    // definition reads `measured<T>(` and so is not matched.
    const args = [...source.matchAll(/\bmeasured\(\s*([^,]+?)\s*,/g)].map((one) => one[1]!);
    expect(args.length).toBeGreaterThan(20);
    // One identifier is allowed and it is the startup probe's, which reads its
    // names out of `accessProbes` in this same file. Everything else must be a
    // quoted literal: a template string is how a subscription id gets into a
    // label without anybody deciding to put it there.
    const literal = /^"[a-z_]+\.[a-z_]+"$/;
    expect(args.filter((one) => !literal.test(one))).toEqual(["operation"]);

    const probes = /const accessProbes[\s\S]*?\n\];/.exec(source)?.[0] ?? "";
    const names = new Set([
      ...args.filter((one) => literal.test(one)).map((one) => one.slice(1, -1)),
      ...[...probes.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((one) => one[1]!),
    ]);
    // Equality rather than containment, so the set is closed in both
    // directions: a call added without a name fails here rather than in a
    // dashboard nobody is watching yet, and one removed is noticed too.
    expect([...names].sort()).toEqual([
      "customer.create",
      "customer.delete",
      "customer.list",
      "customer.retrieve",
      "customer.update",
      "invoice.list",
      "invoice.pay",
      "invoice.retrieve",
      "payment_intent.list",
      "payment_intent.retrieve",
      "payment_intent.update",
      "price.list",
      "price.retrieve",
      "schedule.create",
      "schedule.list",
      "schedule.release",
      "schedule.update",
      "setup_intent.create",
      "setup_intent.list",
      "setup_intent.retrieve",
      "subscription.cancel",
      "subscription.create",
      "subscription.list",
      "subscription.retrieve",
      "subscription.update",
    ]);
  });
});

/**
 * Confirming a replacement card holds the billing lock and a pooled connection
 * while it pays what is owed, which it has to. The price check under that lock
 * also reaches Stripe whenever its cache has gone stale, which it does not have
 * to: so it is warmed before the transaction opens, and the only calls the lock
 * is held across are the two that find and pay the invoice.
 */
describe("confirming a replacement card", () => {
  it("checks the prices before it takes the billing lock", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../src/server/services/billing.ts"),
      "utf8",
    );
    const start = source.indexOf("export async function confirmPaymentSetup(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const warmed = body.indexOf("await saleRefusal();");
    const locked = body.indexOf("await getDb().transaction(");
    expect(warmed, "warmed").toBeGreaterThan(-1);
    expect(locked, "the locked transaction").toBeGreaterThan(-1);
    expect(warmed).toBeLessThan(locked);
  });
});
