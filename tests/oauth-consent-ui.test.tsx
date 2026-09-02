// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthConsent, samePagePath } from "../src/client/App.js";
import { BrowserRouter } from "../src/client/router.js";

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function renderConsent(search: string) {
  window.history.replaceState({}, "", `/oauth/consent${search}`);
  return render(
    <QueryClientProvider client={queryClient()}>
      <BrowserRouter>
        <OAuthConsent />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

/**
 * The link that opens this screen is written by whoever wants consent, so
 * every claim it makes about the client and the access being granted has to
 * come back from the server instead.
 */
describe("the MCP consent screen", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/auth/oauth2/consent-request")) {
          return new Response(
            JSON.stringify({
              clientId: "real-client",
              clientName: "Some Unfamiliar Agent",
              scopes: ["ledger:read", "ledger:write"],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  });

  it("shows the client and scopes the server resolved, not the ones in the link", async () => {
    renderConsent("?consent_code=abc&client_id=Claude%20Desktop&scope=ledger%3Aread");
    await waitFor(() => expect(screen.getByText("Some Unfamiliar Agent")).toBeInTheDocument());
    expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
    expect(screen.getByText(/ledger:write/)).toBeInTheDocument();
  });

  it("asks the server about the consent code and nothing else in the link", async () => {
    renderConsent("?consent_code=abc&client_id=Claude%20Desktop");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [requested] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(requested)).toBe("/api/auth/oauth2/consent-request?consent_code=abc");
  });

  it("refuses to offer a decision when the link carries no consent code", async () => {
    renderConsent("?client_id=Claude%20Desktop&scope=ledger%3Aread");
    await waitFor(() => expect(screen.getByText(/not one this server issued/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Allow access/ })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("where signing in is allowed to land", () => {
  it.each(["/transactions", "/staged?page=2", "/accounts#top"])("keeps the path %s", (path) => {
    expect(samePagePath(path)).toBe(path);
  });

  it.each([
    "//elsewhere.example/steal",
    "/\\elsewhere.example/steal",
    "///elsewhere.example",
    "",
    "https://elsewhere.example",
  ])("sends %s to the overview instead", (path) => {
    expect(samePagePath(path)).toBe("/");
  });
});
