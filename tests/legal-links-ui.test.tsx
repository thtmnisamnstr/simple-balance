// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPublicOptions } from "../src/client/api.js";
import App from "../src/client/App.js";
import { BrowserRouter } from "../src/client/router.js";
import { blocks, stylesheet } from "./support/css.js";

// Stripe.js, never fetched: the plan tab mounts, and nothing here pays.
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe: () => Promise.resolve(null) }));

/**
 * The deployment's privacy policy and terms of use, on the screens a person
 * meets them on.
 *
 * California's online privacy law expects the policy conspicuous where
 * information is collected, and the first place this product collects any is
 * the sign-up form: a name, an address and a password. The policy used to be
 * linked from the sidebar alone, which nobody sees until they have handed all
 * three over, and only on a deployment serving ads. Both documents are on the
 * sign-in screen now whichever form is showing, and the sign-up form says, in
 * one sentence above its button, what creating the account accepts.
 */
const PRIVACY = "https://books.example.com/privacy/";
const TERMS = "https://books.example.com/terms/";

const methods = (over: Partial<AuthPublicOptions> = {}): AuthPublicOptions => ({
  mode: "local",
  localEnabled: true,
  googleEnabled: false,
  localRegistrationOpen: true,
  awaitingFirstAccount: false,
  setupTokenRequired: false,
  setupTokenOffered: false,
  passwordResetAvailable: false,
  notificationsAvailable: false,
  billingAvailable: false,
  adsAvailable: false,
  emailVerificationRequired: false,
  minimumPasswordLength: 12,
  ...over,
});

const session = {
  user: { id: "u", name: "Tester", email: "tester@example.com" },
  preferences: {
    userId: "u",
    timezone: "UTC",
    defaultCurrency: "USD",
    chosen: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  auth: {
    localEnabled: true,
    localPasswordConfigured: true,
    googleEnabled: false,
    googleLinked: false,
  },
};

/** What the plan tab reads: a plan for sale, nobody subscribed yet. */
const billing = {
  selling: true,
  publishableKey: "pk_test_ui",
  prices: {
    monthly: { id: "price_monthly", unitAmount: 300, currency: "usd", interval: "month" },
    yearly: { id: "price_yearly", unitAmount: 3000, currency: "usd", interval: "year" },
  },
  entitlement: { billing: true, plan: "free", accountLimit: 3 },
  accountsUsed: 1,
  subscription: null,
  override: null,
};

/**
 * The app against a server that answers `/api/auth/methods` with `options`.
 * Signed in, it opens on `page`: the import page by default, whose own
 * requests are content with the empty list every other path answers with.
 */
function renderApp(options: AuthPublicOptions, signedIn = false, page = "/import") {
  if (signedIn) window.history.replaceState({}, "", page);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/auth/methods") return Response.json(options);
      if (url.pathname === "/api/v1/billing") return Response.json(billing);
      if (url.pathname === "/api/v1/session") {
        return signedIn
          ? Response.json(session)
          : Response.json({ error: { code: "UNAUTHORIZED", message: "Sign in" } }, { status: 401 });
      }
      return Response.json([]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

/** A link a keyboard can reach: a real `href`, and nothing taking it out of the tab order. */
function expectReachableLink(link: HTMLElement, href: string) {
  expect(link).toHaveAttribute("href", href);
  expect(link.tabIndex).toBeGreaterThanOrEqual(0);
  // A new tab, as the policy link always opened, so a half-filled form is not
  // thrown away by reading what it agrees to.
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the sign-in screen", () => {
  it("links both documents under the sign-in form", async () => {
    renderApp(methods({ privacyPolicyUrl: PRIVACY, termsOfUseUrl: TERMS }));
    await screen.findByRole("heading", { name: "Sign in with your email" });

    expectReachableLink(screen.getByRole("link", { name: "Privacy policy" }), PRIVACY);
    expectReachableLink(screen.getByRole("link", { name: "Terms of use" }), TERMS);
    // Signing in accepts nothing new, so the sentence belongs to the other form.
    expect(screen.queryByText(/By creating an account/)).toBeNull();
  });

  it("says what creating an account accepts, directly above the button that does it", async () => {
    renderApp(
      methods({ awaitingFirstAccount: true, privacyPolicyUrl: PRIVACY, termsOfUseUrl: TERMS }),
    );
    const create = await screen.findByRole("button", { name: "Create account" });
    const sentence = screen.getByText(/By creating an account/);

    expect(sentence).toHaveTextContent(
      "By creating an account you accept the terms of use, and the privacy policy says how your " +
        "information is used.",
    );
    expectReachableLink(within(sentence).getByRole("link", { name: "terms of use" }), TERMS);
    expectReachableLink(within(sentence).getByRole("link", { name: "privacy policy" }), PRIVACY);
    // Next to the button in the order a person reads and tabs, and its
    // description, so somebody who tabs straight to it is told as well.
    expect(sentence.nextElementSibling).toContainElement(create);
    expect(create).toHaveAccessibleDescription(
      /By creating an account you accept the terms of use/,
    );
    // And the links under the form stay, whichever form is showing.
    expect(screen.getByRole("link", { name: "Privacy policy" })).toBeVisible();
  });

  it("names only the terms when there is no policy to point at", async () => {
    renderApp(methods({ awaitingFirstAccount: true, termsOfUseUrl: TERMS }));
    await screen.findByRole("button", { name: "Create account" });

    expect(screen.getByText(/By creating an account/)).toHaveTextContent(
      /^By creating an account you accept the terms of use\.$/,
    );
    expect(screen.queryByRole("link", { name: /privacy/i })).toBeNull();
  });

  it("asks nobody to accept terms the deployment has not published", async () => {
    renderApp(methods({ awaitingFirstAccount: true, privacyPolicyUrl: PRIVACY }));
    const create = await screen.findByRole("button", { name: "Create account" });

    expect(screen.queryByText(/By creating an account/)).toBeNull();
    expect(create).not.toHaveAttribute("aria-describedby");
    // The policy is linked all the same: it does not wait on there being terms.
    expectReachableLink(screen.getByRole("link", { name: "Privacy policy" }), PRIVACY);
  });

  /**
   * "Continue with Google" creates an account too, with no form in between:
   * config refuses to start with Google on and an `ALLOWED_EMAILS` that admits
   * nobody, so somebody the list admits and nobody has seen yet signs up with
   * that press. It says so above the button, whichever form is showing.
   */
  it("says what creating an account with Google accepts, above that button", async () => {
    renderApp(
      methods({
        mode: "both",
        googleEnabled: true,
        privacyPolicyUrl: PRIVACY,
        termsOfUseUrl: TERMS,
      }),
    );
    const google = await screen.findByRole("button", { name: "Continue with Google" });
    const sentence = screen.getByText(/By creating an account with Google/);

    expect(sentence).toHaveTextContent(
      "By creating an account with Google you accept the terms of use, and the privacy policy " +
        "says how your information is used.",
    );
    expectReachableLink(within(sentence).getByRole("link", { name: "terms of use" }), TERMS);
    expectReachableLink(within(sentence).getByRole("link", { name: "privacy policy" }), PRIVACY);
    expect(sentence.nextElementSibling).toContainElement(google);
    expect(google).toHaveAccessibleDescription(
      /By creating an account with Google you accept the terms of use/,
    );
    // The email form is signing in here, which accepts nothing new.
    expect(screen.queryByText(/^By creating an account you accept/)).toBeNull();
  });

  it("says it where Google is the only way in", async () => {
    renderApp(
      methods({
        mode: "google",
        localEnabled: false,
        localRegistrationOpen: false,
        googleEnabled: true,
        termsOfUseUrl: TERMS,
      }),
    );
    const google = await screen.findByRole("button", { name: "Continue with Google" });

    expect(screen.getByText(/By creating an account with Google/)).toHaveTextContent(
      /^By creating an account with Google you accept the terms of use\.$/,
    );
    expect(google).toHaveAccessibleDescription(/you accept the terms of use/);
  });

  it("asks nothing of a Google sign-up where there are no terms", async () => {
    renderApp(methods({ mode: "both", googleEnabled: true, privacyPolicyUrl: PRIVACY }));
    const google = await screen.findByRole("button", { name: "Continue with Google" });

    expect(screen.queryByText(/By creating an account/)).toBeNull();
    expect(google).not.toHaveAttribute("aria-describedby");
  });

  /**
   * The Google sentence sits in the card itself rather than in a form, where
   * `.auth-card > p` outranks `.auth-terms` and would set it as the 14px body
   * text of the card's introduction. It reads at the email form's size.
   */
  it("sets the Google sentence at the email form's size, not as body text", () => {
    const rules = blocks(stylesheet()).filter((block) => block.context.length === 0);
    const size = (selector: string) =>
      Number(
        /font-size:\s*(\d+)px/.exec(
          rules.find((block) => block.selector === selector)?.body ?? "",
        )?.[1],
      );

    expect(size(".auth-card > p")).toBe(14);
    expect(size(".auth-card > .auth-terms")).toBe(size(".auth-terms"));
  });

  it("draws no links where the operator configured neither", async () => {
    renderApp(methods({ awaitingFirstAccount: true }));
    await screen.findByRole("button", { name: "Create account" });

    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("the sidebar", () => {
  it("links both documents on every page", async () => {
    renderApp(methods({ privacyPolicyUrl: PRIVACY, termsOfUseUrl: TERMS }), true);
    const navigation = await screen.findByRole("navigation", { name: "Main navigation" });
    const sidebar = navigation.closest("aside")!;

    expectReachableLink(
      await within(sidebar).findByRole("link", { name: "Privacy policy" }),
      PRIVACY,
    );
    expectReachableLink(within(sidebar).getByRole("link", { name: "Terms of use" }), TERMS);
  });

  it("links the policy with no terms beside it, and neither when neither is set", async () => {
    renderApp(methods({ privacyPolicyUrl: PRIVACY }), true);
    const navigation = await screen.findByRole("navigation", { name: "Main navigation" });
    const sidebar = navigation.closest("aside")!;

    await within(sidebar).findByRole("link", { name: "Privacy policy" });
    expect(within(sidebar).queryByRole("link", { name: "Terms of use" })).toBeNull();
    cleanup();

    renderApp(methods(), true);
    const bare = (await screen.findByRole("navigation", { name: "Main navigation" })).closest(
      "aside",
    )!;
    expect(within(bare).queryByRole("link", { name: /Privacy|Terms/ })).toBeNull();
  });
});

/**
 * The plan tab reads the terms from the shell rather than asking for them
 * itself, so the wiring between the two is what is under test: a plan tab
 * handed nothing draws its renewal terms with no link and looks finished.
 */
describe("the plan tab", () => {
  it("links the deployment's terms of use from the renewal terms", async () => {
    renderApp(methods({ billingAvailable: true, termsOfUseUrl: TERMS }), true, "/settings/plan");
    const opening = await screen.findByText(/renews automatically until you cancel/);
    const terms = opening.closest("div")!;

    expectReachableLink(await within(terms).findByRole("link", { name: "terms of use" }), TERMS);
  });
});
