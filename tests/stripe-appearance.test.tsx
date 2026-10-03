// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BillingStatus, Session } from "../src/client/api.js";
import { PlanPage } from "../src/client/pages/PlanPage.js";
import { applyTheme } from "../src/client/theme.js";

/**
 * The one vendor surface in the product that takes a theming interface is given
 * one, and it is built from the tokens rather than typed out again.
 *
 * `web.md` 6.4 is Binding by way of 1.2: a surface drawn inside the page is part
 * of the page to the person reading it, whoever owns its markup. `Elements` was
 * passed `{ clientSecret }` and nothing else and the word `appearance` appeared
 * nowhere in `src`, so Stripe's card fields came up in the vendor's default
 * light theme — on a dark deployment, a white rectangle inside a dark panel, on
 * the one screen that takes somebody's money.
 *
 * 6.4 is explicit that the values have to be READ off the live tokens rather
 * than re-typed, or the appearance object becomes a fourth place a color is
 * written and 1.2's argument — one value, three questions — is lost. So these
 * tests set the tokens to values no stylesheet uses and assert those exact
 * values come back out: a hardcoded hex would pass an assertion that only
 * checked the key was present, and fails this one.
 *
 * Neither test tier could ever see the rendered result — the fields are in a
 * cross-origin iframe — so what is checkable is what is handed over, and this
 * captures the `options` the real bindings would receive.
 */
const given = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: () => Promise.resolve(null) }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children, options }: { children: ReactNode; options: Record<string, unknown> }) => {
    given.options.push(options);
    return children;
  },
  PaymentElement: () => createElement("div", { "data-testid": "payment-element" }),
  useStripe: () => null,
  useElements: () => null,
}));

const session = {
  user: { id: "u1", name: "Tester", email: "tester@example.com" },
} as unknown as Session;

const billing: BillingStatus = {
  selling: true,
  publishableKey: "pk_test_ui",
  prices: {
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  },
  entitlement: { billing: true, plan: "free", accountLimit: 3 } as BillingStatus["entitlement"],
  accountsUsed: null,
  subscription: null,
  override: null,
};

/** Values no stylesheet uses, so a re-typed hex cannot pass for a read one. */
const TOKENS = {
  "--focus-ring": "rgb(1, 2, 3)",
  "--field": "rgb(4, 5, 6)",
  "--ink": "rgb(7, 8, 9)",
  "--muted": "rgb(10, 11, 12)",
  "--red": "rgb(13, 14, 15)",
};

function paint(tokens: Record<string, string>) {
  for (const [name, value] of Object.entries(tokens)) {
    document.documentElement.style.setProperty(name, value);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  given.options.length = 0;
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

async function openPaymentForm() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(
        String(path) === "/api/v1/billing"
          ? billing
          : { subscriptionId: "sub_1", clientSecret: "pi_secret_1", status: "incomplete" },
      ),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlanPage session={session} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Annual/ }));
  await screen.findByTestId("payment-element");
}

const latest = () =>
  given.options.at(-1) as {
    clientSecret: string;
    appearance: { theme: string; variables: Record<string, string> };
  };

describe("Stripe's payment form", () => {
  it("is handed an appearance read off this page's tokens", async () => {
    paint(TOKENS);
    await openPaymentForm();

    const { clientSecret, appearance } = latest();
    expect(clientSecret).toBe("pi_secret_1");
    expect(appearance.variables).toMatchObject({
      colorPrimary: TOKENS["--focus-ring"],
      colorBackground: TOKENS["--field"],
      colorText: TOKENS["--ink"],
      colorTextSecondary: TOKENS["--muted"],
      colorTextPlaceholder: TOKENS["--muted"],
      colorDanger: TOKENS["--red"],
    });
  });

  it("picks the base theme from what is painted, not from the account's setting", async () => {
    applyTheme("dark");
    paint(TOKENS);
    await openPaymentForm();

    // Stripe's sub-elements carry defaults that no variable reaches, so the
    // base theme has to move too; the attribute is what the stylesheet reads,
    // and `public/theme-boot.js` writes it before this bundle exists.
    expect(latest().appearance.theme).toBe("night");
  });

  it("follows a theme switched while the form is open", async () => {
    applyTheme("light");
    paint(TOKENS);
    await openPaymentForm();
    expect(latest().appearance.theme).toBe("stripe");

    await act(async () => {
      applyTheme("dark");
      paint({ ...TOKENS, "--ink": "rgb(16, 17, 18)" });
    });

    // Somebody can switch the theme from the sidebar with this form open, so
    // reading the tokens once at mount would leave the card fields in the old
    // palette until the page reloaded.
    expect(latest().appearance.theme).toBe("night");
    expect(latest().appearance.variables.colorText).toBe("rgb(16, 17, 18)");
  });
});
