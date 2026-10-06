// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TemplateDetailPage from "../src/client/pages/TemplateDetailPage.js";
import { BrowserRouter, Route, Routes } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";

/**
 * `web.md` 2.4: a hue means one thing everywhere. The template's type badge
 * chose between two tones, green for a deposit and red for anything else, so a
 * transfer between somebody's own accounts wore withdrawal red here while the
 * register drew the same type blue.
 */
const TEMPLATE = "44444444-4444-4444-8444-444444444444";

function renderPage(type: "deposit" | "withdrawal" | "transfer") {
  window.history.replaceState(null, "", `/templates/${TEMPLATE}?preset=all-time`);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === `/api/v1/transaction-templates/${TEMPLATE}`) {
        return Response.json({ id: TEMPLATE, name: "Monthly move", version: 1, draft: { type } });
      }
      if (url.pathname === "/api/v1/transactions") {
        return Response.json({
          items: [],
          nextCursor: null,
          page: 1,
          pageSize: 50,
          totalCount: 0,
          totalPages: 1,
          cursorAvailable: true,
        });
      }
      return Response.json([]);
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <Routes>
            <Route path="/templates/:templateId" element={<TemplateDetailPage />} />
          </Routes>
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a template's type badge", () => {
  it.each([
    ["deposit", "Deposit", "badge-green"],
    ["withdrawal", "Withdrawal", "badge-red"],
    ["transfer", "Transfer", "badge-blue"],
  ] as const)("draws a %s in the register's color", async (type, label, tone) => {
    renderPage(type);
    // The type filter's options say the same word, so the badge is the one
    // inside a `.badge`.
    const badges = (await screen.findAllByText(label))
      .map((element) => element.closest(".badge"))
      .filter((badge) => badge !== null);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveClass(tone);
  });
});
