import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing on, for this file only, and restored afterward because
 * `vitest.config.ts` sets `fileParallelism: false` and every file shares one
 * process.
 */
const billingEnvironment = {
  NODE_ENV: "test",
  SB_BILLING_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_prices",
  STRIPE_PUBLISHABLE_KEY: "pk_test_prices",
  STRIPE_WEBHOOK_SECRET: "whsec_prices",
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
 * Stripe's price retrieval, and nothing else of the SDK. The client is built
 * with `new Stripe(key, options)`, so the double is a class whose one method
 * answers from `answers`, by id.
 */
const answers = new Map<string, unknown>();
const retrieve = vi.fn(async (id: string) => {
  const answer = answers.get(id);
  if (answer instanceof Error) throw answer;
  if (answer === undefined) throw new Error(`no answer for ${id}`);
  return answer;
});
/**
 * The one-item lists the startup probe reads, and the one write a key can be
 * refused for approval on. Nothing else of the SDK exists here, so a probe that
 * wrote anything would throw rather than pass.
 */
const lists = {
  customers: vi.fn(),
  subscriptions: vi.fn(),
  subscriptionSchedules: vi.fn(),
  setupIntents: vi.fn(),
  invoices: vi.fn(),
  paymentIntents: vi.fn(),
  prices: vi.fn(),
};
const cancel = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    prices = { retrieve, list: lists.prices };
    customers = { list: lists.customers };
    subscriptions = { list: lists.subscriptions, cancel };
    subscriptionSchedules = { list: lists.subscriptionSchedules };
    setupIntents = { list: lists.setupIntents };
    invoices = { list: lists.invoices };
    paymentIntents = { list: lists.paymentIntents };
  },
}));

const recurring = (id: string, interval: "month" | "year", over: Record<string, unknown> = {}) => ({
  id,
  object: "price",
  type: "recurring",
  recurring: { interval, interval_count: 1 },
  active: true,
  currency: "usd",
  product: "prod_plan",
  livemode: false,
  unit_amount: interval === "month" ? 300 : 3000,
  ...over,
});

const missing = () => Object.assign(new Error("No such price"), { code: "resource_missing" });

const load = async () => {
  vi.resetModules();
  return import("../src/server/stripe.js");
};

beforeEach(() => {
  answers.clear();
  retrieve.mockClear();
  for (const list of Object.values(lists)) list.mockReset().mockResolvedValue({ data: [] });
  cancel.mockReset();
});

/**
 * The shape of every mistake the two price ids can carry, each of which passed
 * the `price_` prefix check and started cleanly: swapped ids billed the annual
 * price monthly, a one-time or other-mode price failed at the first payment
 * with the reason only in the log.
 */
describe("whether the two configured prices fit the plans they are sold as", () => {
  const sound = async () => {
    const { planPriceProblems } = await load();
    return (over: Partial<Parameters<typeof planPriceProblems>[0]> = {}) =>
      planPriceProblems({
        monthlyId: "price_monthly",
        yearlyId: "price_yearly",
        monthly: shape("price_monthly", "month"),
        yearly: shape("price_yearly", "year"),
        keyMode: "test",
        selling: true,
        ...over,
      });
  };
  const shape = (id: string, interval: string, over: Record<string, unknown> = {}) => ({
    id,
    type: "recurring",
    interval,
    intervalCount: 1,
    active: true,
    currency: "usd",
    product: "prod_plan",
    livemode: false,
    ...over,
  });

  it("finds nothing wrong with a matching pair", async () => {
    expect((await sound())()).toEqual([]);
  });

  it("names swapped ids", async () => {
    const problems = (await sound())({
      monthly: shape("price_monthly", "year"),
      yearly: shape("price_yearly", "month"),
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/STRIPE_PRICE_MONTHLY_ID bills every year/);
    expect(problems[1]).toMatch(/STRIPE_PRICE_YEARLY_ID bills every month/);
  });

  it("names a one-time price, and says nothing about its interval", async () => {
    const problems = (await sound())({
      monthly: shape("price_monthly", "month", { type: "one_time", interval: null }),
    });
    expect(problems).toEqual([expect.stringMatching(/one-time price/)]);
  });

  it("names a price billed every few months", async () => {
    expect(
      (await sound())({ monthly: shape("price_monthly", "month", { intervalCount: 3 }) }),
    ).toEqual([expect.stringMatching(/bills every 3 months/)]);
  });

  it("names a price Stripe has no record of for this key", async () => {
    expect((await sound())({ yearly: null })).toEqual([
      expect.stringMatching(/STRIPE_PRICE_YEARLY_ID is price_yearly, and Stripe has no such price/),
    ]);
  });

  it("names a price from the other mode", async () => {
    expect(
      (await sound())({ keyMode: "live", monthly: shape("price_monthly", "month") }).join(" "),
    ).toMatch(/test-mode price and STRIPE_SECRET_KEY is a live key/);
  });

  it("names two prices in different currencies, or of different products", async () => {
    const problems = (await sound())({
      yearly: shape("price_yearly", "year", { currency: "eur", product: "prod_other" }),
    });
    expect(problems.join(" ")).toMatch(/in USD and STRIPE_PRICE_YEARLY_ID is in EUR/);
    expect(problems.join(" ")).toMatch(/different products \(prod_plan and prod_other\)/);
  });

  /**
   * An archived price cannot start a subscription, so it stops a sale — and is
   * what an operator winding a deployment down is expected to have done, where
   * nothing is for sale and saying so every ten minutes would be noise.
   */
  it("names an archived price only where something is for sale", async () => {
    const check = await sound();
    const archived = { monthly: shape("price_monthly", "month", { active: false }) };
    expect(check(archived)).toEqual([expect.stringMatching(/archived at Stripe/)]);
    expect(check({ ...archived, selling: false })).toEqual([]);
  });
});

describe("reading the prices, and keeping the verdict", () => {
  /**
   * A test key that finds both prices confirms the account in *test* mode, and
   * that is the answer the billing service refuses to act on: the same key on
   * a deployment that has gone live finds the test prices too, and says every
   * live customer is missing.
   */
  it("names the mode it found both prices in, which for a test key is test", async () => {
    answers.set("price_monthly", recurring("price_monthly", "month"));
    answers.set("price_yearly", recurring("price_yearly", "year"));
    const { fetchPlanPrices, lastPriceCheck } = await load();

    const prices = await fetchPlanPrices();
    expect(prices.monthly).toMatchObject({ unitAmount: 300, interval: "month" });
    expect(prices.yearly).toMatchObject({ unitAmount: 3000, interval: "year" });
    expect(lastPriceCheck()).toEqual({ problems: [], confirmedMode: "test" });
  });

  it("reads a missing price as an answer, not as a failure", async () => {
    answers.set("price_monthly", missing());
    answers.set("price_yearly", recurring("price_yearly", "year"));
    const { fetchPlanPrices, lastPriceCheck } = await load();

    const prices = await fetchPlanPrices();
    expect(prices.monthly).toBeNull();
    expect(lastPriceCheck()?.problems).toEqual([expect.stringMatching(/no such price/)]);
    // To a key for another account every object is missing, which is why
    // nothing else may believe "no such customer" from it.
    expect(lastPriceCheck()?.confirmedMode).toBeNull();
  });

  it("never confirms live mode for a test key, whatever the prices claim", async () => {
    answers.set("price_monthly", recurring("price_monthly", "month", { livemode: true }));
    answers.set("price_yearly", recurring("price_yearly", "year", { livemode: true }));
    const { fetchPlanPrices, lastPriceCheck } = await load();

    await fetchPlanPrices();
    expect(lastPriceCheck()?.confirmedMode).toBeNull();
  });

  /**
   * A Price says which half of Stripe it lives in, and a key can read only its
   * own half, so the mode comes off the prices when the key's form says
   * nothing — and only when the two agree.
   */
  it("reads the mode off the prices where the key's form does not say", async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    const publishable = process.env.STRIPE_PUBLISHABLE_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_unmarked_prices";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_unmarked_prices";
    try {
      answers.set("price_monthly", recurring("price_monthly", "month", { livemode: true }));
      answers.set("price_yearly", recurring("price_yearly", "year", { livemode: true }));
      const first = await load();
      await first.fetchPlanPrices();
      expect(first.lastPriceCheck()?.confirmedMode).toBe("live");

      answers.set("price_yearly", recurring("price_yearly", "year"));
      const second = await load();
      await second.fetchPlanPrices();
      expect(second.lastPriceCheck()?.confirmedMode).toBeNull();
    } finally {
      process.env.STRIPE_SECRET_KEY = key;
      process.env.STRIPE_PUBLISHABLE_KEY = publishable;
    }
  });

  /**
   * Unreachable says nothing about the prices, so a definite mismatch found
   * earlier stands. Forgetting it would let a sale through the very price the
   * check had refused a minute before.
   */
  it("keeps the last definite verdict when Stripe cannot be reached", async () => {
    answers.set("price_monthly", recurring("price_monthly", "year"));
    answers.set("price_yearly", recurring("price_yearly", "year"));
    const { fetchPlanPrices, lastPriceCheck, resetPlanPriceCache, checkStripePrices } =
      await load();
    await fetchPlanPrices();
    const before = lastPriceCheck();
    expect(before?.problems.length).toBe(1);

    resetPlanPriceCache();
    answers.set("price_monthly", new Error("connect ETIMEDOUT"));
    await expect(fetchPlanPrices()).rejects.toThrow(/ETIMEDOUT/);
    expect(lastPriceCheck()).toEqual(before);

    // And the startup check says so without throwing, because an unreachable
    // Stripe is not a reason to keep the ledger from starting.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(checkStripePrices()).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("could not be reached"),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("says a mismatch once, at error, rather than on every refresh", async () => {
    answers.set("price_monthly", recurring("price_monthly", "month", { type: "one_time" }));
    answers.set("price_yearly", recurring("price_yearly", "year"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fetchPlanPrices, resetPlanPriceCache } = await load();
      await fetchPlanPrices();
      resetPlanPriceCache();
      await fetchPlanPrices();
      expect(retrieve).toHaveBeenCalledTimes(4);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("one-time price"));
    } finally {
      error.mockRestore();
    }
  });

  /**
   * The archived-price rule reaches the check only through this caller, and
   * `selling` is the argument that carries it. The pure-function test above
   * proves the rule; this proves the wiring, on the one deployment where the
   * two answers differ — and that is the only deployment where it can be
   * observed at all, because every other file that touches `fetchPlanPrices`
   * replaces it with a double.
   *
   * Both halves are load-bearing. Asserting only the empty verdict would catch
   * a hardcoded `selling: true` and miss a hardcoded `selling: false`, which is
   * the worse of the two: a deployment that IS selling would then start
   * subscriptions on an archived price with nothing in the log to say why they
   * fail. The `console.error` line is asserted beside the verdict because the
   * log is the whole symptom here — no figure and no refusal changes on a
   * wound-down deployment, every reader of `problems` already sitting behind a
   * `billingEnabled()` gate that answers false there.
   */
  it("suppresses the archived-price problem only where the deployment sells", async () => {
    answers.set("price_monthly", recurring("price_monthly", "month", { active: false }));
    answers.set("price_yearly", recurring("price_yearly", "year"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const selling = process.env.SB_BILLING_ENABLED;
    try {
      // Winding down is exactly when an operator archives the prices, so
      // saying so is noise rather than news.
      delete process.env.SB_BILLING_ENABLED;
      const woundDown = await load();
      await woundDown.fetchPlanPrices();
      expect(woundDown.lastPriceCheck()?.problems).toEqual([]);
      expect(error).not.toHaveBeenCalled();

      // The same prices on a deployment that is still selling stop a sale.
      process.env.SB_BILLING_ENABLED = "true";
      const open = await load();
      await open.fetchPlanPrices();
      expect(open.lastPriceCheck()?.problems).toEqual([
        "STRIPE_PRICE_MONTHLY_ID is archived at Stripe, and no subscription can start on it.",
      ]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("archived at Stripe"));
    } finally {
      if (selling === undefined) delete process.env.SB_BILLING_ENABLED;
      else process.env.SB_BILLING_ENABLED = selling;
      error.mockRestore();
    }
  });
});

/** What Stripe throws for a key that lacks a permission, as the sandbox threw it. */
const lacking = () =>
  Object.assign(
    new Error(
      "The provided key 'rk_test_***' does not have the required permissions for this endpoint.",
    ),
    { type: "StripePermissionError", code: "more_permissions_required", statusCode: 403 },
  );

/**
 * A restricted key missing a permission started cleanly and failed later, at
 * the call that needed it, and Stripe did not always say which: a key without
 * PaymentIntents made a first subscription fail as "An unknown error occurred".
 * So the key is asked at startup what it may read, with one-item lists that
 * write nothing, and whatever it cannot is named in one line.
 */
describe("what a restricted key may read, asked at startup", () => {
  const withKey = async <T>(key: string, run: () => Promise<T>) => {
    const original = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = key;
    try {
      return await run();
    } finally {
      process.env.STRIPE_SECRET_KEY = original;
    }
  };
  const spy = (level: "error" | "warn" | "info") =>
    vi.spyOn(console, level).mockImplementation(() => {});

  it("names every resource the key cannot read, in one line, and carries on", async () => {
    lists.invoices.mockRejectedValue(lacking());
    lists.paymentIntents.mockRejectedValue(lacking());
    const error = spy("error");
    try {
      const refused = await withKey("rk_test_access", async () =>
        (await load()).checkStripeAccess(),
      );

      expect(refused).toEqual(["Invoices", "PaymentIntents"]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          /cannot read Invoices, PaymentIntents.*docs\/billing-operations\.md step 2/,
        ),
      );
      for (const list of Object.values(lists)) expect(list).toHaveBeenCalledWith({ limit: 1 });
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("says it could not look when Stripe does not answer, and never throws", async () => {
    for (const list of Object.values(lists)) list.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const error = spy("error");
    const warn = spy("warn");
    try {
      await expect(
        withKey("rk_test_access", async () => (await load()).checkStripeAccess()),
      ).resolves.toEqual([]);
      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be asked"));
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("says once that the key can read everything", async () => {
    const info = spy("info");
    try {
      await withKey("rk_test_access", async () => (await load()).checkStripeAccess());
      expect(info).toHaveBeenCalledWith(expect.stringContaining("can read everything"));
    } finally {
      info.mockRestore();
    }
  });

  it("asks nothing of a standard secret key, which holds every permission", async () => {
    await expect((await load()).checkStripeAccess()).resolves.toEqual([]);
    for (const list of Object.values(lists)) expect(list).not.toHaveBeenCalled();
  });
});

/**
 * A call Stripe refuses because of the key rather than the request. The dump
 * the request's error handler writes is forty lines of headers with the code
 * and the operation two words among them, and Stripe's message names neither
 * this product's call nor, sometimes, the permission. One line names both, and
 * the fix.
 */
describe("a call Stripe refuses because of the key", () => {
  it("names the call, the code and the fix for a missing permission", async () => {
    answers.set("price_monthly", lacking());
    answers.set("price_yearly", recurring("price_yearly", "year"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fetchPlanPrices } = await load();
      await expect(fetchPlanPrices()).rejects.toMatchObject({ code: "more_permissions_required" });
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          /Stripe refused price\.retrieve .*\(more_permissions_required\).*docs\/billing-operations\.md step 2/,
        ),
      );
    } finally {
      error.mockRestore();
    }
  });

  /**
   * An agent-tagged key has its writes held for a person to approve, and by
   * default that includes canceling a subscription — which this product does,
   * with nobody to approve it, when somebody abandons an unpaid first payment.
   *
   * Both ways out are asserted, not just the sentence. The line used to offer
   * one — replace the key — and `docs/billing-operations.md` step 2 offers two,
   * so an operator reading the log at the moment a cancel failed was sent to
   * rotate a working key by the page that then told them to delete a rule. A
   * refusal and the page it cites saying different things is the failure this
   * holds shut, and only the halves can hold it: matching the whole sentence
   * would break on every rewording and say nothing about what is missing.
   */
  it("names both ways out when Stripe holds a call for approval", async () => {
    cancel.mockRejectedValue(
      Object.assign(new Error("This action requires human approval before it can be completed."), {
        type: "StripePermissionError",
        code: "approval_required",
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { cancelStripeSubscriptionNow } = await load();
      await expect(cancelStripeSubscriptionNow("sub_1", "key")).rejects.toMatchObject({
        code: "approval_required",
      });
      expect(error).toHaveBeenCalledTimes(1);
      const [line] = error.mock.calls[0] as [string];
      expect(line).toMatch(/held subscription\.cancel .*\(approval_required\)/);
      expect(line, "the key half").toMatch(/create the key without that intended use/);
      expect(line, "the rule half").toMatch(/delete the rule .*Settings > Approvals > Rules/);
      expect(line, "where the two are written out").toMatch(/docs\/billing-operations\.md step 2/);
    } finally {
      error.mockRestore();
    }
  });

  it("adds nothing to a failure that is not about the key", async () => {
    cancel.mockRejectedValue(new Error("connect ETIMEDOUT"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { cancelStripeSubscriptionNow } = await load();
      await expect(cancelStripeSubscriptionNow("sub_1", "key")).rejects.toThrow(/ETIMEDOUT/);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
