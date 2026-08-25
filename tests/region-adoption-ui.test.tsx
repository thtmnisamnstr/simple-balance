// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

const realDateTimeFormat = Intl.DateTimeFormat;

/**
 * Pin what the browser implies, so both cases turn on the stored `chosen` flag
 * and not on the timezone of whichever machine runs the suite. A host already
 * on UTC would otherwise make the guess equal to what is stored, and the write
 * would be skipped for a reason that has nothing to do with the rule here.
 */
function stubBrowserRegion() {
  const pinned = new Proxy(realDateTimeFormat, {
    construct(target, args) {
      const formatter = Reflect.construct(target, args) as Intl.DateTimeFormat;
      // An explicit request keeps its answer; only the ambient guess is pinned.
      if ((args[1] as Intl.DateTimeFormatOptions | undefined)?.timeZone) {
        return formatter;
      }
      const resolved = formatter.resolvedOptions.bind(formatter);
      formatter.resolvedOptions = () => ({
        ...resolved(),
        timeZone: "Europe/Berlin",
      });
      return formatter;
    },
    apply: (target, _thisArg, args) => Reflect.construct(target, args),
  });
  Object.defineProperty(Intl, "DateTimeFormat", {
    value: pinned,
    configurable: true,
    writable: true,
  });
  for (const [key, value] of [
    ["languages", ["de-DE"]],
    ["language", "de-DE"],
  ] as const) {
    Object.defineProperty(window.navigator, key, { value, configurable: true });
  }
}

function stubApi(chosen: boolean) {
  bodies = [];
  stubBrowserRegion();
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
  Object.defineProperty(Intl, "DateTimeFormat", {
    value: realDateTimeFormat,
    configurable: true,
    writable: true,
  });
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
      expect(bodies.find((one) => one.url === "/api/v1/preferences")).toBeDefined(),
    );
    const written = bodies.find((one) => one.url === "/api/v1/preferences")!;
    expect(written.body).toMatchObject({ ifUnchosen: true });
  });

  it("does not write at all once somebody has chosen", async () => {
    stubApi(true);
    renderApp();
    // The write is fired from an effect in the shell, so waiting on any request
    // at all would settle on the session load, before the shell has mounted and
    // before there is anything for this to be true about.
    await screen.findByRole("navigation", { name: "Main navigation" });
    expect(bodies.filter((one) => one.url === "/api/v1/preferences")).toEqual([]);
  });
});
