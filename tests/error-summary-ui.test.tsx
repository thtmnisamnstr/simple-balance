// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../src/client/api.js";
import { Modal } from "../src/client/components.js";
import { AccountForm } from "../src/client/forms.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import "./support/dialog.js";

/**
 * A refusal naming three bad fields used to show one sentence, at the bottom of
 * a form that can be fifty split rows long, with focus left on the button that
 * had just been pressed. Both halves of that are checked here: the client keeps
 * every sentence the server sent, and the summary that renders them takes focus.
 */
function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TimezoneProvider timezone="UTC">{node}</TimezoneProvider>
    </QueryClientProvider>,
  );
}

/** A refusal in the envelope the API actually sends. */
function refusal(details: unknown, message = "Request validation failed", status = 422) {
  return () =>
    Promise.resolve({
      ok: false,
      status,
      statusText: "Unprocessable Entity",
      json: () => Promise.resolve({ error: { code: "VALIDATION_ERROR", message, details } }),
    } as Response);
}

const issue = (path: string[], message: string) => ({ code: "custom", path, message });

/**
 * `fireEvent.submit` rather than clicking the button: jsdom runs constraint
 * validation on a click, and every field this form refuses is also `required`,
 * so a click never reaches the mutation at all.
 */
function submit(container: HTMLElement) {
  fireEvent.submit(container.querySelector("form")!);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the error summary on a form", () => {
  it("shows every sentence the refusal carried, not just the first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        refusal([
          issue(["name"], "Account name is already taken"),
          issue(["openingBalance"], "Amount must be greater than zero"),
        ]),
      ),
    );
    const { container } = mount(<AccountForm defaultCurrency="USD" onDone={() => {}} />);
    submit(container);
    await screen.findByText("There is a problem");
    expect(screen.getByText("Account name is already taken")).toBeInTheDocument();
    expect(screen.getByText("Amount must be greater than zero")).toBeInTheDocument();
  });

  it("keeps two fields refused in the same words as two lines", async () => {
    // Zod words a missing string identically wherever it is missing, and three
    // split legs left at zero are three identical sentences. Collapsing by
    // wording would report one bad field when there are two.
    const same = "Invalid input: expected string, received undefined";
    vi.stubGlobal("fetch", vi.fn(refusal([issue(["name"], same), issue(["currency"], same)])));
    const { container } = mount(<AccountForm defaultCurrency="USD" onDone={() => {}} />);
    submit(container);
    await screen.findByText("There is a problem");
    expect(screen.getAllByText(same)).toHaveLength(2);
  });

  it("shows one line when the same field is refused twice in the same words", async () => {
    const same = "Amount must be greater than zero";
    vi.stubGlobal(
      "fetch",
      vi.fn(refusal([issue(["openingBalance"], same), issue(["openingBalance"], same)])),
    );
    const { container } = mount(<AccountForm defaultCurrency="USD" onDone={() => {}} />);
    submit(container);
    await screen.findByText("There is a problem");
    expect(screen.getAllByText(same)).toHaveLength(1);
  });

  it("moves focus to itself so the message is not left behind the button", async () => {
    vi.stubGlobal("fetch", vi.fn(refusal([issue(["name"], "Account name is already taken")])));
    const { container } = mount(<AccountForm defaultCurrency="USD" onDone={() => {}} />);
    submit(container);
    await waitFor(() => expect(document.activeElement).toHaveClass("error-summary"));
  });

  it("announces an identical second failure again", async () => {
    // The case a message-shaped dependency cannot see: nothing was fixed, so the
    // second refusal reads word for word like the first. Without this the person
    // presses the button, is refused, and is left exactly where they were.
    vi.stubGlobal("fetch", vi.fn(refusal([issue(["name"], "Account name is already taken")])));
    const { container } = mount(<AccountForm defaultCurrency="USD" onDone={() => {}} />);
    submit(container);
    await waitFor(() => expect(document.activeElement).toHaveClass("error-summary"));
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).not.toHaveClass("error-summary");
    submit(container);
    await waitFor(() => expect(document.activeElement).toHaveClass("error-summary"));
  });

  it("heads itself below the dialog's own title rather than beside it", async () => {
    vi.stubGlobal("fetch", vi.fn(refusal([issue(["name"], "Account name is already taken")])));
    const { container } = mount(
      <Modal open title="Create an account" onClose={() => {}}>
        <AccountForm defaultCurrency="USD" onDone={() => {}} />
      </Modal>,
    );
    submit(container);
    const heading = await screen.findByText("There is a problem");
    expect(heading.tagName).toBe("H3");
    expect(screen.getAllByRole("heading", { level: 2 }).map((one) => one.textContent)).toEqual([
      "Create an account",
    ]);
  });
});

describe("what a refusal leaves on the error", () => {
  const call = async (details: unknown, message = "Request validation failed", status = 422) => {
    vi.stubGlobal("fetch", vi.fn(refusal(details, message, status)));
    return await api("/api/v1/accounts").then(
      () => null,
      (error: unknown) => error as ApiClientError,
    );
  };

  it("leads with the same sentence anything rendering one message already showed", async () => {
    const error = await call([
      issue(["name"], "Account name is already taken"),
      issue(["currency"], "Currency must be three letters"),
    ]);
    expect(error!.message).toBe("Account name is already taken");
    expect(error!.messages[0]).toBe(error!.message);
    expect(error!.messages).toHaveLength(2);
  });

  it("leaves a refusal whose details are not a list of fields with its own sentence", async () => {
    const error = await call({ currentVersion: 3 }, "This row changed while you were editing", 409);
    expect(error!.message).toBe("This row changed while you were editing");
    expect(error!.messages).toEqual(["This row changed while you were editing"]);
  });

  it("does not read a CSV parser's own errors as if they named fields", async () => {
    // Papa Parse's errors carry no `path`. Reading them as field messages is how
    // "CSV contains malformed quoted data" reached the import screen as Papa's
    // "Quoted field unterminated" instead.
    const error = await call(
      [{ type: "Quotes", code: "MissingQuotes", message: "Quoted field unterminated", row: 3 }],
      "CSV contains malformed quoted data",
    );
    expect(error!.message).toBe("CSV contains malformed quoted data");
    expect(error!.messages).toEqual(["CSV contains malformed quoted data"]);
  });
});
