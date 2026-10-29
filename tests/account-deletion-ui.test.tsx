// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/client/api.js";
import SettingsPage, { DeleteAccount } from "../src/client/pages/SettingsPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import "./support/dialog.js";

/**
 * What deleting an account says about a subscription that goes with it.
 *
 * The flag it reads is true only for a subscription paid for at least once,
 * which is narrower than what the deletion cancels — deleting the Stripe
 * customer ends an unfinished first payment too — and the gap is the fix: the
 * note used to tell somebody whose first payment never went through, and whom
 * the plan tab calls Free, that their paid plan was canceled. And the deletion
 * cancels at once with no refund, which neither the note nor the final
 * dialog said: a year paid for in March was simply gone, and the last thing
 * somebody confirmed did not mention the subscription at all.
 */
const session = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  preferences: { userId: "u1", timezone: "UTC", defaultCurrency: "USD", chosen: true },
  auth: { localEnabled: true, googleEnabled: false },
} as unknown as Session;

const summary = (activeSubscription: boolean) => ({
  accounts: 2,
  transactions: 14,
  categories: 5,
  stagedTransactions: 0,
  recurrences: 0,
  importBatches: 0,
  payees: 3,
  connectedAgents: 0,
  activeSubscription,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The panel opened, the address typed, and the final dialog up. */
async function openDeletion(activeSubscription: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      new URL(String(input), window.location.origin).pathname === "/api/v1/me/data"
        ? Response.json(summary(activeSubscription))
        : Response.json({}),
    ),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DeleteAccount session={session} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete this account" }));
  const note = (await screen.findByText(/This will delete 14 transactions across 2 accounts/))
    .parentElement!;
  fireEvent.change(screen.getByLabelText("Type your email address to confirm"), {
    target: { value: session.user.email },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete my account and all my data" }));
  const dialog = screen.getByRole("dialog", { name: "Delete this account for good?" });
  return { note, dialog };
}

describe("deleting an account that has a subscription", () => {
  it("says the subscription ends with it and nothing is refunded, in the note and the last dialog", async () => {
    const { note, dialog } = await openDeletion(true);
    expect(note).toHaveTextContent(
      "Your subscription is canceled at the same time, immediately and for good",
    );
    expect(note).toHaveTextContent(
      "Nothing is refunded, so any time left on what you paid for is lost.",
    );
    expect(note).toHaveTextContent("contact whoever runs this server before you delete");
    // True of an unfinished first payment too, which "paid plan" was not.
    expect(note).not.toHaveTextContent("paid plan");
    expect(
      within(dialog).getByText(/Your subscription ends now, and nothing is refunded\./),
    ).toBeInTheDocument();
  });

  it("says nothing about one when there is none", async () => {
    const { note, dialog } = await openDeletion(false);
    expect(note).toHaveTextContent("This will delete 14 transactions across 2 accounts");
    expect(note).not.toHaveTextContent("subscription");
    expect(within(dialog).getByText(/There is no copy and no undo\./)).toBeInTheDocument();
    expect(within(dialog).queryByText(/subscription/)).not.toBeInTheDocument();
  });
});

/**
 * The rest of the settings page's account panel, rendered whole. `web.md`
 * 12.1: a failure is shown rather than read as there being nothing. The note
 * under the password form read `authOptions.data?.passwordResetAvailable`, so a
 * read in flight, or one that failed, told somebody their deployment had no
 * mail server — a fact about the server stated from the absence of an answer.
 */
describe("the note under the password form", () => {
  const signedIn = {
    ...session,
    preferences: { ...session.preferences, theme: "system" },
    auth: {
      localEnabled: true,
      googleEnabled: false,
      localPasswordConfigured: true,
      googleLinked: false,
    },
  } as unknown as Session;

  const renderSettings = (methods: () => Promise<Response>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        new URL(String(input), window.location.origin).pathname === "/api/auth/methods"
          ? methods()
          : Response.json([]),
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TimezoneProvider timezone="UTC">
          <BrowserRouter>
            <SettingsPage session={signedIn} />
          </BrowserRouter>
        </TimezoneProvider>
      </QueryClientProvider>,
    );
    return client;
  };

  it("says nothing about mail when the deployment's answer did not arrive", async () => {
    const client = renderSettings(async () =>
      Response.json({ error: { code: "INTERNAL_ERROR", message: "No." } }, { status: 500 }),
    );
    await screen.findByRole("heading", { name: "Preferences" });
    // The read has failed and the page has rendered with the failure.
    await waitFor(() => expect(client.getQueryState(["auth-methods"])?.status).toBe("error"));
    expect(screen.queryByText(/has no mail server/)).toBeNull();
    expect(screen.queryByText(/Forgot this password/)).toBeNull();
  });

  it("says each of the two things once the deployment has said", async () => {
    renderSettings(async () => Response.json({ passwordResetAvailable: false }));
    expect(await screen.findByText(/has no mail server/)).toBeInTheDocument();
    cleanup();
    renderSettings(async () => Response.json({ passwordResetAvailable: true }));
    expect(await screen.findByText(/Forgot this password/)).toBeInTheDocument();
  });
});
