import { expect, test, type Page } from "@playwright/test";
import type { BillingStatus } from "../../src/client/api.js";

/**
 * The plan tab's two priced buttons, and whether they sit on the same line.
 *
 * `web.md` 12.3 records the defect and what could not be checked. A row that
 * centers its items centers every one of them in the height of the tallest,
 * and the one wrapper showing a reason — button, 4px, the sentence — is the
 * tallest thing in it: the enabled button sat 8.5px above the disabled one
 * beside it, 15px where the reason ran to two lines on a phone. The plan tab
 * showed it on every visit, because one of its two plan buttons is always
 * disabled with a reason.
 *
 * `tests/plan-page-ui.test.tsx` reads the fix out of the stylesheet and cannot
 * see the offset: jsdom has no layout engine, so it can say the rule is there
 * and nothing about whether the browser applies it — a later rule on these
 * rows could bring the lift back with that test still green. This tier can ask
 * the two buttons where they are.
 */

/**
 * A fresh account per run, for the reason `budgets.spec.ts` gives: these specs
 * write real rows through the real API and a shared identity would make one
 * run's leftovers another run's mystery.
 */
const person = {
  email: `plan-browser-${Date.now()}@example.com`,
  password: "correct-horse-battery-staple-9",
  name: "Plan Tier",
};

/**
 * What the plan tab reads, answered from here rather than seeded through the
 * API like everything else in this tier.
 *
 * There is no seeding path to this state. A priced button exists only at a
 * price Stripe gave, so reaching it for real needs a Stripe account, its keys
 * in the server's environment and a subscription already running against them
 * — which no test can create, and the last of which would charge a card. This
 * one response is the whole of what is faked: the stylesheet, the components
 * and the layout below it are the real ones, which is the half the rule is
 * about.
 *
 * Typed as `BillingStatus` so a field the route learns to send is a typecheck
 * failure here rather than a page that quietly renders something else.
 *
 * An annual subscription with both plans for sale is the row as the tab shows
 * it: pressing the plan somebody is on changes no interval, which is the press
 * the shared rule answers with nothing, so Annual is disabled and says why
 * while Monthly stays live.
 */
const status: BillingStatus = {
  selling: true,
  // Never fetched. Stripe.js is loaded only once there is something to
  // confirm, and nothing here opens a payment form.
  publishableKey: "pk_test_browser_tier",
  prices: {
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  },
  entitlement: { billing: true, plan: "plus", accountLimit: null, source: "subscription" },
  accountsUsed: null,
  subscription: {
    status: "active",
    interval: "yearly",
    // Far enough out that no clock this runs under has passed it. A renewal
    // already behind would make the page say the plan had ended.
    currentPeriodEnd: "2099-01-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    scheduledInterval: null,
    scheduledAt: null,
    payable: false,
  },
  override: null,
};

/**
 * The same sign-up `budgets.spec.ts` does, and the waiting there is the reason:
 * whether this run meets the sign-up form or the toggle into it depends on
 * whether the database already holds an account, and the sign-in form renders
 * before the options query answers — so both are waited for and whichever
 * arrives decides.
 */
async function signUp(page: Page) {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Create an account" });
  const heading = page.getByRole("heading", { name: "Create your account" });
  await expect(heading.or(toggle)).toBeVisible();
  if (await toggle.isVisible()) await toggle.click();
  await expect(heading).toBeVisible();
  await page.getByLabel("Your name").fill(person.name);
  await page.getByLabel("Email address").fill(person.email);
  // Not an exact match: `Field` wraps its control in a label that includes the
  // hint, so the accessible name is "Password At least 12 characters".
  await page.getByLabel(/^Password/).fill(person.password);
  await page.getByLabel(/^Confirm password/).fill(person.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test.describe("the plan tab's priced buttons in a browser", () => {
  test("keep the same top while one of them says why it is disabled", async ({ page }) => {
    // By pathname rather than by a glob: the tab's other billing paths hang off
    // this one — `/api/v1/billing/subscription`, `/api/v1/billing/payment-setups`
    // — and a pattern that swallowed them would answer a press with a plan
    // status. Nothing here presses anything, and a route that quietly covers
    // more than it was written for is the next person's afternoon.
    await page.route(
      (url) => url.pathname === "/api/v1/billing",
      (route) => route.fulfill({ json: status }),
    );
    await signUp(page);
    await page.goto("/settings/plan");

    // The row rather than the page: the tab has several `.form-actions`, and
    // the one this is about is the one holding the priced buttons.
    const row = page
      .locator(".form-actions")
      .filter({ has: page.getByRole("button", { name: /^Annual —/ }) });
    const annual = row.getByRole("button", { name: /^Annual —/ });
    const monthly = row.getByRole("button", { name: /^Monthly —/ });
    // Asserted before the measurement, because two enabled buttons also line up
    // perfectly and would pass a test of tops alone.
    await expect(annual).toBeDisabled();
    await expect(monthly).toBeEnabled();
    const reason = row.locator(".button-reason");
    await expect(reason).toHaveText("You are on the annual plan already.");

    /**
     * Where the browser put each button, in the row's own order. Read in one
     * evaluation so both are measured against the same layout: two round trips
     * could straddle a reflow and compare a top against one that no longer
     * exists.
     */
    const tops = () =>
      row
        .locator("button.button")
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
    const height = () => reason.evaluate((line) => line.getBoundingClientRect().height);

    const wide = await tops();
    expect(wide).toHaveLength(2);
    // Not exact equality: a browser lays out in fractional pixels, and a
    // sub-pixel difference is nothing anybody can see, while the defect this is
    // about was 8.5px on a desktop and 15px on a phone.
    expect(Math.abs(wide[0]! - wide[1]!)).toBeLessThan(0.5);
    const oneLine = await height();

    // And on a phone, where the reason wraps and the lift was nearly twice as
    // big. The row itself does not wrap — `.form-actions` sets no `flex-wrap` —
    // so the buttons are still side by side and their tops still answer the
    // same question.
    await page.setViewportSize({ width: 390, height: 844 });
    // The second line is what the 15px figure came from, so a width where the
    // sentence still fits on one would leave this passing on the smaller defect
    // alone. Measured against the same sentence a moment earlier rather than
    // against a line height written down here, which would be this test
    // asserting a font metric it has no business knowing. Retried because it is
    // the one reading a resize not yet laid out answers wrongly: both tops move
    // together and go on agreeing, while a height read before the reflow is the
    // single line the wide viewport had.
    await expect(async () => expect(await height()).toBeGreaterThan(oneLine * 1.5)).toPass();

    const narrow = await tops();
    expect(narrow).toHaveLength(2);
    expect(Math.abs(narrow[0]! - narrow[1]!)).toBeLessThan(0.5);
  });
});
