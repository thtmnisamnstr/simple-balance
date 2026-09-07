// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, CsvPreview, PaginatedPage, StagedTransaction } from "../src/client/api.js";
import ImportPage from "../src/client/pages/ImportPage.js";
import StagingPage from "../src/client/pages/StagingPage.js";
import { BrowserRouter } from "../src/client/router.js";
import { TimezoneProvider } from "../src/client/timezone.js";
import { PROGRESS_STREAM_MIN_ROWS } from "../src/shared/domain.js";
import type { ProgressFrame } from "../src/shared/progress.js";
import { streamedResponse } from "./support/streamed-response.js";

/**
 * What a person watching a long write is shown, and that they are shown nothing
 * they should not be.
 *
 * Queried by role rather than by class, because that is the claim worth making:
 * `<progress>` is used precisely so the role and the accessible name come from
 * the element rather than from hand-declared ARIA, and Testing Library resolves
 * both here. What no tier checks is that the bar is *painted* — jsdom has no
 * layout engine and the fill comes from vendor pseudo-elements.
 */

const account: Account = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Checking",
  type: "checking",
  currency: "USD",
  openingDate: "2026-01-01",
  openingBalance: "0",
  version: 1,
  balance: "0",
  balancePresentation: { label: "Balance", amount: "0" },
};

const staged = (index: number): StagedTransaction => ({
  // Deterministic and distinct, because the page keys its selection by id.
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  draft: {
    type: "withdrawal",
    date: "2026-07-30",
    payee: `Row ${index}`,
    description: null,
    fromAccountId: account.id,
    amount: "10.00",
  },
  validationIssues: [],
  importBatchId: null,
  version: 1,
  status: "staged",
  createdAt: "2026-07-30T12:00:00.000Z",
});

const meter = () => screen.queryByRole("progressbar");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Call = { accept: string | null };

/** A queue of `count` rows, and whatever the commit is told to answer with. */
function stubQueue(count: number, commit: (init?: RequestInit) => Response | Promise<Response>) {
  const commits: Call[] = [];
  const items = Array.from({ length: count }, (_, index) => staged(index));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/staged-transactions/commit") {
        commits.push({ accept: new Headers(init?.headers).get("Accept") });
        return commit(init);
      }
      if (url.pathname === "/api/v1/staged-transactions") {
        if (url.searchParams.get("validity") === "duplicate") {
          return Response.json({
            items: [],
            nextCursor: null,
            page: 1,
            pageSize: 200,
            totalCount: 0,
            cursorAvailable: false,
            totalPages: 1,
          } satisfies PaginatedPage<StagedTransaction>);
        }
        return Response.json({
          items,
          nextCursor: null,
          page: 1,
          pageSize: 200,
          totalCount: count,
          cursorAvailable: false,
          totalPages: 1,
        } satisfies PaginatedPage<StagedTransaction>);
      }
      if (url.pathname === "/api/v1/import-batches") {
        return Response.json({ items: [], nextCursor: null });
      }
      if (url.pathname === "/api/v1/accounts") return Response.json([account]);
      if (url.pathname === "/api/v1/categories") return Response.json([]);
      return new Response("Not found", { status: 404 });
    }),
  );
  return commits;
}

async function commitEverything(count: number) {
  window.history.replaceState(null, "", "/staged?start=2026-07-01&end=2026-07-31");
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <TimezoneProvider timezone="UTC">
        <BrowserRouter>
          <StagingPage />
        </BrowserRouter>
      </TimezoneProvider>
    </QueryClientProvider>,
  );
  await screen.findByText(`Row ${count - 1}`);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select all staged transactions on this page" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Commit selected/ }));
}

const committed = (count: number): ProgressFrame => ({
  type: "result",
  value: {
    committed: Array.from({ length: count }, (_, index) => ({
      stagedId: staged(index).id,
      transactionId: `tx-${index}`,
    })),
  },
});

describe("committing a batch big enough to watch", () => {
  const count = PROGRESS_STREAM_MIN_ROWS;

  it("asks for frames and draws the bar from them", async () => {
    const stream = streamedResponse();
    const commits = stubQueue(count, () => stream.response);
    await commitEverything(count);
    await waitFor(() => expect(commits).toHaveLength(1));

    stream.push({ type: "progress", event: { phase: "validating", done: count, total: count } });
    stream.push({ type: "progress", event: { phase: "posting", done: 10, total: count } });

    // By role and by name in one query: the accessible name is the sentence
    // beside the bar, which is the whole reason it is labelled rather than
    // captioned.
    const bar = await screen.findByRole("progressbar", { name: `10 of ${count} committed` });
    // The bar is weighted across phases, so the figure is not 10/50. What is
    // asserted is that it is a real fraction of a real maximum, and that the
    // sentence beside it carries the phase's own true numbers.
    expect(bar).toHaveAttribute("max", "1");
    expect(Number(bar.getAttribute("value"))).toBeGreaterThan(0);
    expect(Number(bar.getAttribute("value"))).toBeLessThan(1);
    expect(commits).toEqual([{ accept: "text/event-stream" }]);

    stream.push(committed(count));
    stream.close();
    // Gone the moment the work settles, rather than frozen at whatever
    // fraction it had reached.
    await waitFor(() => expect(meter()).toBeNull());
  });

  it("draws nothing before the first frame", async () => {
    const stream = streamedResponse();
    const commits = stubQueue(count, () => stream.response);
    await commitEverything(count);
    await waitFor(() => expect(commits).toHaveLength(1));

    // The setup a commit does before its first row — the idempotency record,
    // the row read, the locks — reports no count, so there is none to draw.
    // The button's own busy state is the whole indicator until one arrives.
    expect(meter()).toBeNull();
    stream.push(committed(count));
    stream.close();
    // The selection clears on success, which is how this waits for the whole
    // stream to have been read rather than for a timer.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Commit selected/ })).toBeNull(),
    );
    expect(meter()).toBeNull();
  });

  it("says nothing was committed when a refusal ends the stream", async () => {
    const stream = streamedResponse();
    const commits = stubQueue(count, () => stream.response);
    await commitEverything(count);
    await waitFor(() => expect(commits).toHaveLength(1));

    stream.push({ type: "progress", event: { phase: "posting", done: 30, total: count } });
    await screen.findByRole("progressbar", { name: `30 of ${count} committed` });
    stream.push({
      type: "error",
      error: {
        error: { code: "STALE_VERSION", message: "This record changed since you loaded it." },
      },
    });
    stream.close();

    // Both halves, because either alone is the defect: a bar left at 60% beside
    // a refusal claims 60% of the work stuck, and a refusal with no bar and no
    // reassurance leaves somebody who watched it climb with no way to know that
    // nothing happened.
    expect(
      await screen.findByText("This record changed since you loaded it. Nothing was committed."),
    ).toBeInTheDocument();
    expect(meter()).toBeNull();
  });

  it("claims nothing when the connection ends without an answer", async () => {
    const stream = streamedResponse();
    const commits = stubQueue(count, () => stream.response);
    await commitEverything(count);
    await waitFor(() => expect(commits).toHaveLength(1));

    stream.push({ type: "progress", event: { phase: "posting", done: 40, total: count } });
    await screen.findByRole("progressbar", { name: `40 of ${count} committed` });
    // No terminal frame. The transaction is never cancelled because a browser
    // went away, so those forty rows — and the rest — may well be in the books.
    stream.close();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The connection ended before this reported back. Reload to see whether it completed.",
    );
    // The sentence a refusal earns must not appear here. It would contradict the
    // one beside it, and it would be false exactly when it mattered most.
    expect(alert).not.toHaveTextContent("Nothing was committed");
    expect(meter()).toBeNull();
  });
});

describe("committing a batch too small to watch", () => {
  it("asks for no frames, and draws no bar", async () => {
    const count = PROGRESS_STREAM_MIN_ROWS - 1;
    const commits = stubQueue(count, () =>
      Response.json({
        committed: Array.from({ length: count }, (_, index) => ({
          stagedId: staged(index).id,
          transactionId: `tx-${index}`,
        })),
      }),
    );
    await commitEverything(count);

    await waitFor(() => expect(commits).toHaveLength(1));
    expect(commits[0]?.accept).toBeNull();
    expect(meter()).toBeNull();
  });
});

const preview: CsvPreview = {
  delimiter: ",",
  headers: ["date", "payee", "amount"],
  rows: [{ date: "2026-07-31", payee: "ACME", amount: "-12.34" }],
  errors: [],
};

/** An import that answers `stage` for the real run and plain JSON for a dry one. */
function stubImport(stage: (dryRun: boolean) => Response) {
  const accepts: (string | null)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/v1/accounts") return Response.json([account]);
      if (url.pathname === "/api/v1/categories") return Response.json([]);
      if (url.pathname === "/api/v1/csv/preview") return Response.json(preview);
      if (url.pathname === "/api/v1/csv/stage") {
        accepts.push(new Headers(init?.headers).get("Accept"));
        const body = JSON.parse(String(init?.body)) as { dryRun: boolean };
        return stage(body.dryRun);
      }
      return new Response("Not found", { status: 404 });
    }),
  );
  return accepts;
}

async function openImport(csv: string) {
  const { container } = render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <BrowserRouter>
        <ImportPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("heading", { name: "Choose a CSV file" });
  const file = new File([csv], "bank.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => csv });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  await screen.findByRole("button", { name: /Stage all rows/ });
}

/** A stage reply. A dry run has no batch, because it wrote nothing. */
const stageResult = (rowCount: number, staged = true) => ({
  type: "result" as const,
  value: {
    fileName: "bank.csv",
    rowCount,
    validCount: rowCount,
    invalidCount: 0,
    ...(staged ? { importBatchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : {}),
    sample: [],
    referenceResolution: { categories: [], payees: [] },
  },
});

describe("staging a CSV", () => {
  const csv = ["date,payee,amount", "2026-07-31,ACME,-12.34"].join("\n");

  it("asks for frames every time, because the row count is the server's to know", async () => {
    const rows = PROGRESS_STREAM_MIN_ROWS + 1;
    const stream = streamedResponse();
    const accepts = stubImport(() => stream.response);
    await openImport(csv);
    fireEvent.click(screen.getByRole("button", { name: /Stage all rows/ }));
    await waitFor(() => expect(accepts).toHaveLength(1));

    stream.push({ type: "progress", event: { phase: "staging", done: 20, total: rows } });
    expect(await screen.findByText(`20 of ${rows} staged`)).toBeInTheDocument();
    expect(accepts).toEqual(["text/event-stream"]);

    stream.push(stageResult(rows));
    stream.close();
    await screen.findByText(/ready and/);
    expect(meter()).toBeNull();
  });

  it("draws no bar for a file under the threshold, frames or not", async () => {
    const rows = PROGRESS_STREAM_MIN_ROWS - 1;
    const stream = streamedResponse();
    const accepts = stubImport(() => stream.response);
    await openImport(csv);
    fireEvent.click(screen.getByRole("button", { name: /Stage all rows/ }));
    await waitFor(() => expect(accepts).toHaveLength(1));

    const before = stream.pulls();
    stream.push({ type: "progress", event: { phase: "staging", done: 1, total: rows } });
    // Waited out rather than asserted in the same tick: the source is only
    // asked for another frame once the client has finished with this one, so
    // this is the moment the bar would exist if the threshold were not
    // consulted. A file this size is over before a bar could be read, and a bar
    // that flashes is worse than none.
    await waitFor(() => expect(stream.pulls()).toBeGreaterThan(before));
    expect(meter()).toBeNull();
    stream.push(stageResult(rows));
    stream.close();
    await screen.findByText(/ready and/);
    expect(meter()).toBeNull();
  });

  it("never asks for frames on a dry run", async () => {
    // A dry run returns before the import batch and before a single row is
    // prepared, so there is no per-row work to report and nothing to draw.
    const accepts = stubImport(() =>
      Response.json(stageResult(PROGRESS_STREAM_MIN_ROWS * 2, false).value),
    );
    await openImport(csv);
    fireEvent.click(screen.getByRole("button", { name: /Dry run/ }));

    await screen.findByText(/Nothing was changed during this dry run/);
    expect(accepts).toEqual([null]);
    expect(meter()).toBeNull();
  });
});
