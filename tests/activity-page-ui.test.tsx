// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent, Page } from "../src/client/api.js";
import ActivityPage from "../src/client/pages/ActivityPage.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * The history a person can read is the history an agent can read.
 *
 * The page fetched the latest hundred once and said so, while
 * `list_audit_events` walked the whole history with a cursor — an agent could
 * read further back into somebody's own record than they could. The page now
 * takes the same walk, and when the walk ends the button goes and focus lands
 * on the first row it brought in rather than on `<body>` (`web.md` 13.3).
 */
const event = (id: string, name: string): AuditEvent => ({
  id,
  actorSource: "web",
  entityType: "account",
  entityId: id,
  operation: "create",
  before: null,
  after: { name },
  createdAt: "2026-07-01T12:00:00.000Z",
});

const page = (items: AuditEvent[], nextCursor: string | null): Page<AuditEvent> => ({
  items,
  nextCursor,
});

function renderPage(pages: Record<string, Page<AuditEvent>>) {
  const asked: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      asked.push(url);
      return Response.json(pages[url.searchParams.get("cursor") ?? "first"]);
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimezoneProvider timezone="UTC">
        <ActivityPage />
      </TimezoneProvider>
    </QueryClientProvider>,
  );
  return asked;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the activity history", () => {
  it("reads further back a hundred at a time, as far as the history goes", async () => {
    const asked = renderPage({
      first: page([event("a", "Checking"), event("b", "Savings")], "older"),
      older: page([event("c", "Old card")], null),
    });
    expect(await screen.findByText(/“Savings”/)).toBeInTheDocument();
    expect(asked[0]!.searchParams.get("limit")).toBe("100");

    fireEvent.click(screen.getByRole("button", { name: "Show older activity" }));

    const arrived = (await screen.findByText(/“Old card”/)).closest(".activity-row");
    expect(asked.at(-1)!.searchParams.get("cursor")).toBe("older");
    // The walk is over, so the button has gone, and focus is on the first row
    // it brought in rather than nowhere.
    await waitFor(() => expect(document.activeElement).toBe(arrived));
    expect(screen.queryByRole("button", { name: "Show older activity" })).toBeNull();
    // Nothing already read is lost or repeated.
    expect(screen.getAllByText(/“(Checking|Savings|Old card)”/)).toHaveLength(3);
  });

  it("offers nothing older when the first page is all there is", async () => {
    renderPage({ first: page([event("a", "Checking")], null) });
    expect(await screen.findByText(/“Checking”/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show older activity" })).toBeNull();
  });
});
