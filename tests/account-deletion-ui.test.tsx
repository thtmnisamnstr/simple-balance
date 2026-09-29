// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../src/client/api.js";
import { DeleteAccount } from "../src/client/pages/SettingsPage.js";
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
