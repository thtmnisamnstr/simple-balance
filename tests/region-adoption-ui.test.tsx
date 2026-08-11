// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/client/App.js";
import { BrowserRouter } from "../src/client/router.js";

const session = (chosen: boolean) => ({
  user: { id: "u", name: "Gavin", email: "gavin@example.com" },
  preferences: {
    userId: "u",
    timezone: "UTC",
    defaultCurrency: "USD",
    chosen,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  auth: {
    localEnabled: true,
    localPasswordConfigured: true,
    googleEnabled: false,
    googleLinked: false,
  },
});

let bodies: { url: string; body: unknown }[] = [];

function stubApi(chosen: boolean) {
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (init?.body) {
        bodies.push({ url: url.pathname, body: JSON.parse(String(init.body)) });
      }
      if (url.pathname === "/api/v1/session") {
        return Response.json(session(chosen));
      }
      if (url.pathname === "/api/v1/preferences") {
        return Response.json(session(true).preferences);
      }
      return Response.json([]);
    }),
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The offer the browser makes is conditional: only while nobody has chosen.
 * The page holds the session it loaded with, so the condition has to travel
 * with the write and be checked where the row is — a choice made in Settings on
 * another tab while this page is open would otherwise be overwritten by a guess.
 */
describe("adopting the region the browser implies", () => {
  const renderApp = () => {
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
  };

  it("marks the write as one that must lose to a decision", async () => {
    stubApi(false);
    renderApp();
    await waitFor(() =>
      expect(
        bodies.find((one) => one.url === "/api/v1/preferences"),
      ).toBeDefined(),
    );
    const written = bodies.find((one) => one.url === "/api/v1/preferences")!;
    expect(written.body).toMatchObject({ ifUnchosen: true });
  });

  it("does not write at all once somebody has chosen", async () => {
    stubApi(true);
    renderApp();
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0),
    );
    expect(bodies.filter((one) => one.url === "/api/v1/preferences")).toEqual([]);
  });
});
