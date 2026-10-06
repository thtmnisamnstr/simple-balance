// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AuthPublicOptions } from "../src/client/api.js";
import App from "../src/client/App.js";
import { ActiveAccountChooser } from "../src/client/pages/AccountsPage.js";
import DuplicateReviewPage from "../src/client/pages/DuplicateReviewPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import { MAX_FREE_ACCOUNTS } from "../src/shared/domain.js";

/**
 * Better Auth's client, which the sign-in screen reaches the reset endpoint
 * through. Mocked rather than answered by the `fetch` stub, because the client
 * is built when the module is imported and captures `globalThis.fetch` then —
 * before any `stubGlobal` in a test body — so a real request went out and came
 * back "fetch failed". Nothing here is about Better Auth's wire format; what is
 * under test is what the screen does once the call has returned.
 */
vi.mock("../src/client/auth-client.js", () => ({
  authClient: {
    requestPasswordReset: vi.fn(async () => ({ data: {}, error: null })),
    signIn: { email: vi.fn(async () => ({ data: {}, error: null })), social: vi.fn() },
    signOut: vi.fn(),
  },
}));

/**
 * `web.md` 13.3, the half of it stated as a shape rather than as a count of
 * pages: **a control whose own success removes or disables the control**.
 *
 * The guide records that writing it down as "the three pages that unmount their
 * own button and the plan tab" let three more of the identical shape ship
 * afterwards. These are the next three, all found the same way — a button that
 * `loading` disables (so the browser has already blurred it), answered by a
 * panel the button is not in. Focus was on `<body>` when the answer arrived and
 * nothing on screen carried a role that would announce it.
 *
 * Each case asserts the same two things, which is the whole rule: the sentence
 * exists and carries `role="status"`, and `document.activeElement` is that
 * sentence rather than `<body>`.
 */
const focusedStatus = (text: HTMLElement) => {
  // `Alert` wraps its children in an inner div, so the element `getByText`
  // lands on is one below the one carrying the role and the focus.
  const box = text.closest('[role="status"]');
  expect(box, "the outcome is announced, so it carries a live region's role").not.toBeNull();
  return box!;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  name: `Account ${id}`,
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  archivedAt: null,
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
  active: true,
  frozen: false,
  ...over,
});

describe("the account chooser, whose save can remove the chooser", () => {
  /** The accounts the save answers with, which is what the sentence is read from. */
  function stubSave(answer: readonly Account[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(answer)),
    );
  }

  function mount(accounts: readonly Account[]) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <ActiveAccountChooser accounts={accounts} limit={MAX_FREE_ACCOUNTS} />
      </QueryClientProvider>,
    );
    return {
      ...view,
      // What the page does when the save invalidates `["accounts"]` and the
      // query comes back: the panel is handed a new list.
      refetched: (next: readonly Account[]) =>
        view.rerender(
          <QueryClientProvider client={client}>
            <ActiveAccountChooser accounts={next} limit={MAX_FREE_ACCOUNTS} />
          </QueryClientProvider>,
        ),
    };
  }

  const saveButton = () =>
    screen.getByRole("button", { name: /save which accounts|bring these back/i });

  it("says which accounts are in use, and puts focus on the sentence", async () => {
    // One account stays frozen, so the panel survives its own save — and the
    // only thing that changed on it was `disabledReason` turning back into
    // "Nothing to save yet.", the sentence written for an untouched form.
    const after = [
      account("a"),
      account("b"),
      account("c"),
      account("d", { frozen: true, active: false }),
    ];
    stubSave(after);
    mount([account("a"), account("b"), account("c"), account("d", { frozen: true })]);

    fireEvent.click(saveButton());

    const sentence = await screen.findByText(/are the accounts you are using now/);
    expect(sentence).toHaveTextContent("Account a, Account b and Account c");
    expect(document.activeElement).toBe(focusedStatus(sentence));
  });

  it("keeps the sentence when the save is what removes the panel", async () => {
    // The save unfroze the last frozen account, so `!anyFrozen` is true and
    // there is no longer a choice to put. The panel is gone and the report of
    // what it did has to outlive it, or the answer to "did that land?" is an
    // empty space where the panel was.
    const after = [account("a"), account("b")];
    stubSave(after);
    const { refetched } = mount([account("a"), account("b", { frozen: true })]);

    fireEvent.click(saveButton());
    await screen.findByText(/are the accounts you are using now/);
    refetched(after);

    expect(screen.queryByRole("button", { name: /bring these back/i })).toBeNull();
    const sentence = screen.getByText(/are the accounts you are using now/);
    expect(sentence).toHaveTextContent("Account a and Account b");
    expect(document.activeElement).toBe(focusedStatus(sentence));
  });

  it("reports nothing before a save, so a fresh panel steals no focus", () => {
    mount([account("a"), account("b", { frozen: true })]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("the duplicate queue, whose last drop removes the page it was on", () => {
  const stagedSide = {
    kind: "staged" as const,
    staged: {
      id: "staged-1",
      draft: {
        type: "withdrawal",
        date: "2026-03-12",
        payee: "Blue Bottle Coffee",
        amount: "42.50",
        fromAccountId: "acc-1",
        categoryId: "cat-2",
      },
      validationIssues: [],
      version: 1,
      status: "staged" as const,
      createdAt: "2026-03-12T00:00:00.000Z",
    },
    committed: null,
  };
  const committedSide = {
    kind: "committed" as const,
    staged: null,
    committed: {
      id: "tx-1",
      type: "withdrawal" as const,
      date: "2026-03-10",
      payee: "SQ *BLUE BOTTLE",
      description: null,
      categoryId: "cat-1",
      sourceAccountId: "acc-1",
      sourceAmount: "42.5",
      sourceCurrency: "USD",
      legs: [],
      version: 3,
    },
  };

  /** One pair in the queue, so dropping it is the end of the run. */
  function stubQueueOfOne() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname.endsWith("/duplicate")) {
          return Response.json({ first: stagedSide, second: committedSide });
        }
        if (url.pathname === "/api/v1/staged-transactions") {
          const duplicates = url.searchParams.get("validity") === "duplicate";
          return Response.json({
            items: duplicates ? [stagedSide.staged] : [],
            page: 1,
            pageSize: 200,
            totalCount: duplicates ? 1 : 0,
            cursorAvailable: false,
            totalPages: 1,
            nextCursor: null,
          });
        }
        if (url.pathname === "/api/v1/accounts") {
          return Response.json([
            {
              id: "acc-1",
              name: "Checking",
              type: "checking",
              currency: "USD",
              openingDate: "2026-01-01",
              openingBalance: "0",
              version: 1,
              balance: "0",
              balancePresentation: { label: "Balance", amount: "0" },
            },
          ]);
        }
        if (url.pathname === "/api/v1/categories") {
          return Response.json([{ id: "cat-2", name: "Coffee", kind: "expense", version: 1 }]);
        }
        return Response.json([]);
      }),
    );
  }

  it("announces the drop and takes focus when the queue empties", async () => {
    stubQueueOfOne();
    window.history.replaceState(null, "", "/staged/duplicates/staged-1");
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <Routes>
              <Route path="/staged/duplicates/:id" element={<DuplicateReviewPage />} />
              <Route path="/staged" element={<p>The queue itself</p>} />
            </Routes>
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    await screen.findByLabelText("Staged row under review");

    fireEvent.click(screen.getByRole("button", { name: /delete this staged row/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete staged row" }));

    // The screen that says the run is over is still there; what was missing was
    // anywhere for the person who pressed Drop to be standing.
    expect(await screen.findByText(/no duplicates left to review/i)).toBeInTheDocument();
    const sentence = screen.getByText(/The row was deleted/);
    expect(document.activeElement).toBe(focusedStatus(sentence));
  });
});

describe("the sign-in screen, whose only button is replaced by its own answer", () => {
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

  function renderSignIn(options: AuthPublicOptions) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), window.location.origin);
        if (url.pathname === "/api/auth/methods") return Response.json(options);
        if (url.pathname === "/api/v1/session") {
          return Response.json(
            { error: { code: "UNAUTHORIZED", message: "Sign in" } },
            { status: 401 },
          );
        }
        if (url.pathname === "/api/auth/sign-up/email") return Response.json({ ok: true });
        return Response.json({});
      }),
    );
    return render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
          })
        }
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  }

  const fill = (label: RegExp | string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("announces the confirmation panel after signing up, and lands focus on it", async () => {
    renderSignIn(methods({ awaitingFirstAccount: true, emailVerificationRequired: true }));
    const create = await screen.findByRole("button", { name: "Create account" });

    fill("Your name", "Tester");
    fill("Email address", "tester@example.com");
    fill("Password", "a-long-enough-password");
    fill("Confirm password", "a-long-enough-password");
    fireEvent.submit(create.closest("form")!);

    const sentence = await screen.findByText(/A message is on its way to/);
    expect(sentence).toHaveTextContent("tester@example.com");
    await waitFor(() => expect(document.activeElement).toBe(focusedStatus(sentence)));
  });

  it("announces the reset link, and lands focus on it", async () => {
    renderSignIn(methods({ passwordResetAvailable: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Forgot your password?" }));

    fill("Email address", "tester@example.com");
    fireEvent.submit(screen.getByRole("button", { name: "Send the link" }).closest("form")!);

    const sentence = await screen.findByText(/a link to choose a new password is on its way/);
    await waitFor(() => expect(document.activeElement).toBe(focusedStatus(sentence)));
  });
});
