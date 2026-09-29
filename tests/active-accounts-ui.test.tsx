// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../src/client/api.js";
import { ActiveAccountChooser } from "../src/client/pages/AccountsPage.js";
import { MAX_FREE_ACCOUNTS } from "../src/shared/domain.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The panel somebody picks their three accounts in.
 *
 * It had no test, and that is how it shipped unable to do the one thing it is
 * for: the save button's "nothing changed" check compared the *size* of the
 * selection against the size of what was already in use, and during the first
 * choice those are always both the limit — so every full choice was refused
 * with "Nothing to save yet." Three green tiers did not see it, because
 * nothing rendered this component.
 */
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

/** Five accounts on a three-account plan, nobody having chosen yet. */
const firstChoice = [
  account("a"),
  account("b"),
  account("c"),
  account("d", { frozen: true }),
  account("e", { frozen: true }),
];

function mount(accounts: readonly Account[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ActiveAccountChooser accounts={accounts} limit={MAX_FREE_ACCOUNTS} />
    </QueryClientProvider>,
  );
}

const saveButton = () =>
  screen.getByRole("button", { name: /save which accounts|bring these back/i });
const boxFor = (name: string) => screen.getByLabelText(new RegExp(name)) as HTMLInputElement;

/** Every save the panel sends, answered the way the server answers one. */
function recordSaves() {
  const saves: { method: string | undefined; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      saves.push({
        method: init?.method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json([]);
    }),
  );
  return saves;
}

describe("choosing which accounts stay usable", () => {
  it("saves the three it started on, untouched, as the one-time choice", async () => {
    // After a downgrade every live account is still marked active, so the
    // three the ordering keeps are a change to what is stored, and
    // `activeAccountChange` accepts them. The panel compared against the three
    // it had derived instead, called them "Nothing to save yet.", and left the
    // choice for an agent to close.
    const saves = recordSaves();
    mount(firstChoice);
    expect(saveButton(), "the default is a choice, and the panel is for making it").toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toEqual({
      method: "PUT",
      path: "/api/v1/accounts/active",
      body: { accountIds: ["a", "b", "c"] },
    });
  });

  it("saves a first choice that swaps one account for another", () => {
    mount(firstChoice);

    // The choice this panel exists to take: drop one of the three the ordering
    // picked, take one it did not. Same size, different set.
    fireEvent.click(boxFor("Account c"));
    fireEvent.click(boxFor("Account d"));

    expect(saveButton(), "a same-size swap is a change and must be savable").toBeEnabled();
  });

  it("still offers the save when a first choice is put back the way it started", () => {
    // Where it started is not what is stored: five accounts are marked active
    // and the plan keeps three, so the question is still open.
    mount(firstChoice);
    fireEvent.click(boxFor("Account c"));
    expect(saveButton(), "two within a limit of three is a choice too").toBeEnabled();
    fireEvent.click(boxFor("Account c"));
    expect(saveButton(), "back to the default is still the choice to make").toBeEnabled();
  });

  it("has nothing to save once the choice is made and nothing has changed", () => {
    // `d` and `e` are marked inactive, so the stored choice is a, b and c —
    // exactly what the panel starts on — and sending it would change nothing.
    mount([
      account("a"),
      account("b"),
      account("c"),
      account("d", { frozen: true, active: false }),
      account("e", { frozen: true, active: false }),
    ]);
    expect(saveButton()).toBeDisabled();
    expect(saveButton()).toHaveAccessibleDescription("Nothing to save yet.");
  });

  it("refuses more than the plan keeps, and says why", () => {
    mount(firstChoice);
    fireEvent.click(boxFor("Account d"));
    expect(saveButton()).toBeDisabled();
  });

  it("fixes the accounts in use once the choice has been made", () => {
    // `d` is frozen and marked inactive, so somebody has chosen: the accounts
    // in use can no longer be given up, and only a free place takes another.
    const chosen = [
      account("a"),
      account("b"),
      account("c"),
      account("d", { frozen: true, active: false }),
    ];
    mount(chosen);
    expect(boxFor("Account a"), "an account in use cannot be traded away").toBeDisabled();
    expect(boxFor("Account d"), "and there is no place for the frozen one").toBeDisabled();
    expect(screen.getByText(/All 3 places are in use/)).toBeInTheDocument();
  });

  it("offers the frozen account a place that has opened up", () => {
    // One of the three was archived, which frees the place it held.
    const freed = [
      account("a", { archivedAt: "2026-02-01" }),
      account("b"),
      account("c"),
      account("d", { frozen: true, active: false }),
      account("e", { frozen: true, active: false }),
    ];
    mount(freed);
    expect(boxFor("Account d")).toBeEnabled();
    fireEvent.click(boxFor("Account d"));
    expect(saveButton()).toBeEnabled();
    // And only one place opened up, so the second frozen account cannot follow.
    expect(boxFor("Account e")).toBeDisabled();
  });

  it("asks again when a paid spell left an account nobody chose about", () => {
    // Chose a, b and c; subscribed; opened `f` while there was no limit;
    // canceled. `f` arrives marked active and frozen, and the panel has to
    // put the question rather than tell somebody their answer is final — the
    // old predicate looked only at whether any frozen account was inactive,
    // which d and e satisfy, so it read this as settled.
    const secondDowngrade = [
      account("a"),
      account("b"),
      account("c"),
      account("d", { frozen: true, active: false }),
      account("f", { frozen: true }),
    ];
    mount(secondDowngrade);
    expect(screen.getByText("Choose which accounts stay usable")).toBeInTheDocument();
    expect(boxFor("Account a"), "nothing is fixed while the question is open").toBeEnabled();
    fireEvent.click(boxFor("Account c"));
    fireEvent.click(boxFor("Account f"));
    expect(saveButton()).toBeEnabled();
  });

  it("renders nothing at all when no account is frozen", () => {
    const { container } = mount([account("a"), account("b")]);
    expect(container).toBeEmptyDOMElement();
  });
});
