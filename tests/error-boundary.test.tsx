// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../src/client/api.js";
import { ErrorBoundary } from "../src/client/error-boundary.js";

/**
 * A render throw must not blank the page.
 *
 * Before this boundary existed one bad render unmounted the whole tree and left
 * white — no message, no way back, and nothing saying whether the ledger was
 * affected. That last part is why the copy says so explicitly: somebody whose
 * accounting app just vanished wants to know their money is still there before
 * they want anything else.
 */
function Boom({ error }: { error: Error }): never {
  throw error;
}

// React logs a caught render error to the console on purpose. Silencing it here
// keeps a passing run readable; the boundary's own logging is asserted below.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  cleanup();
});

describe("the error boundary", () => {
  it("shows the children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All well</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("All well")).toBeInTheDocument();
  });

  it("catches a render throw and says the data is safe", () => {
    render(
      <ErrorBoundary>
        <Boom error={new Error("kaboom")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Your data is safe/)).toBeInTheDocument();
    // The raw message is a stack-trace fragment, not a sentence for a person.
    expect(screen.queryByText(/kaboom/)).not.toBeInTheDocument();
  });

  it("shows an API error's own sentence, because somebody wrote it to be read", () => {
    render(
      <ErrorBoundary>
        <Boom error={new ApiClientError("VALIDATION_ERROR", "A budget cannot be negative.")} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("A budget cannot be negative.")).toBeInTheDocument();
  });

  it("offers a way back", () => {
    render(
      <ErrorBoundary>
        <Boom error={new Error("kaboom")} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the dashboard" })).toHaveAttribute("href", "/");
  });

  it("retries, and shows the children again when the throw has stopped", () => {
    let shouldThrow = true;
    function Sometimes() {
      if (shouldThrow) throw new Error("kaboom");
      return <p>Recovered</p>;
    }
    render(
      <ErrorBoundary>
        <Sometimes />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Recovered")).toBeInTheDocument();
  });

  it("logs what it caught", () => {
    render(
      <ErrorBoundary>
        <Boom error={new Error("kaboom")} />
      </ErrorBoundary>,
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Unhandled render error",
      expect.objectContaining({ message: "kaboom" }),
      expect.anything(),
    );
  });
});
