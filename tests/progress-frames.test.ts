import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { MAX_BULK_SELECTION_ENTRIES, PROGRESS_STREAM_MIN_ROWS } from "../src/shared/domain.js";
import { streamProgress } from "../src/server/stream.js";
import {
  createProgressDecoder,
  encodeProgressFrame,
  progressFraction,
  PROGRESS_VERB,
  type ProgressEvent,
  type ProgressFrame,
} from "../src/shared/progress.js";

/**
 * The format the server writes and the browser reads, held to one function.
 *
 * Every failure this catches is silent in the ordinary sense: a frame split
 * across two network chunks, a phase with no word for it, a bar that goes
 * backwards at a phase change. None of them throws, none of them shows up on a
 * small import, and all of them show up on the thousand-row one this exists
 * for.
 */

const decode = (chunks: string[]): ProgressFrame[] => {
  const decoder = createProgressDecoder();
  return chunks.flatMap((chunk) => decoder(chunk));
};

describe("the progress frame format", () => {
  it("round-trips each of the three frames", () => {
    const frames: ProgressFrame[] = [
      { type: "progress", event: { phase: "validating", done: 12, total: 90 } },
      { type: "result", value: { committed: [{ stagedId: "a", transactionId: "b" }] } },
      {
        type: "error",
        error: { error: { code: "STALE_VERSION", message: "Reload and try again" } },
      },
    ];
    expect(decode(frames.map(encodeProgressFrame))).toEqual(frames);
  });

  it("delivers a frame split across two chunks once, and whole", () => {
    const wire = encodeProgressFrame({
      type: "progress",
      event: { phase: "posting", done: 4000, total: 5000 },
    });
    // The boundary is put inside the JSON payload on purpose: that is where a
    // real one lands, and it is the case a per-chunk parser drops in silence.
    const cut = wire.indexOf("done") + 2;
    expect(decode([wire.slice(0, cut), wire.slice(cut)])).toEqual([
      { type: "progress", event: { phase: "posting", done: 4000, total: 5000 } },
    ]);
  });

  it("delivers two frames that arrived in one chunk", () => {
    const wire =
      encodeProgressFrame({ type: "progress", event: { phase: "staging", done: 1, total: 2 } }) +
      encodeProgressFrame({ type: "progress", event: { phase: "staging", done: 2, total: 2 } });
    expect(
      decode([wire]).map((frame) => (frame.type === "progress" ? frame.event.done : null)),
    ).toEqual([1, 2]);
  });

  it("drops what it does not recognise rather than throwing", () => {
    // A comment line is legal SSE and is what an intermediary sends to keep a
    // connection warm; an unknown event is what a newer server would send to a
    // page loaded before an upgrade. Abandoning a commit already running over
    // either would be the wrong answer to both.
    const frames = decode([
      ": keep-alive\n\n",
      "event: rumour\ndata: {}\n\n",
      "event: progress\ndata: not json\n\n",
      encodeProgressFrame({ type: "result", value: { committed: [] } }),
    ]);
    expect(frames).toEqual([{ type: "result", value: { committed: [] } }]);
  });

  it("refuses a phase that is only on the prototype", () => {
    // `in` would have accepted this and `progressFraction` would then have
    // thrown on a share that is not there.
    expect(decode(['event: progress\ndata: {"phase":"toString","done":1,"total":2}\n\n'])).toEqual(
      [],
    );
  });

  it("gives every phase a word to be described with", () => {
    // A phase added without one renders a blank sentence beside a moving bar,
    // which is the one thing a bar must never be.
    for (const phase of ["validating", "duplicates", "posting", "staging"] as const) {
      expect(PROGRESS_VERB[phase], phase).toMatch(/^[a-z]+$/);
    }
  });
});

describe("how full the bar is", () => {
  it("never goes backwards across a phase change", () => {
    const walk: ProgressEvent[] = [
      { phase: "validating", done: 0, total: 100 },
      { phase: "validating", done: 100, total: 100 },
      { phase: "duplicates", done: 1, total: 100 },
      { phase: "duplicates", done: 100, total: 100 },
      { phase: "posting", done: 1, total: 100 },
      { phase: "posting", done: 100, total: 100 },
    ];
    const fractions = walk.map(progressFraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(0)).toBe(0);
    expect(fractions.at(-1)).toBe(1);
  });

  it("finishes a phase that had nothing in it rather than dividing by zero", () => {
    expect(progressFraction({ phase: "staging", done: 0, total: 0 })).toBe(1);
  });

  it("stays inside the bar when a count overshoots", () => {
    expect(progressFraction({ phase: "posting", done: 200, total: 100 })).toBe(1);
  });
});

describe("the threshold a bar earns its row at", () => {
  /**
   * The direction, not the digit.
   *
   * Fifty is a judgement about when a bar is worth a row of layout, and a test
   * that pinned it would fail on every reconsideration of that judgement while
   * proving nothing. What matters is that it stays a threshold: above a single
   * row, and below the cap on how many rows one request may carry, because
   * either end would make it mean nothing.
   */
  it("sits between one row and the bulk cap", () => {
    expect(PROGRESS_STREAM_MIN_ROWS).toBeGreaterThan(1);
    expect(PROGRESS_STREAM_MIN_ROWS).toBeLessThan(MAX_BULK_SELECTION_ENTRIES);
  });
});

describe("the response that carries the frames", () => {
  /**
   * A reply readable before the work behind it has finished.
   *
   * This is the only claim that matters and the only one a completed response
   * cannot make: if the frames were buffered and sent at the end, everything
   * else in this file would still pass and the bar would sit at nothing for a
   * minute and then vanish.
   */
  const held = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { gate, release };
  };

  const readOnce = async (response: Response) => {
    const { value } = await response.body!.getReader().read();
    return new TextDecoder().decode(value);
  };

  it("writes a frame while the work is still running", async () => {
    const { gate, release } = held();
    const app = new Hono();
    app.get(
      "/work",
      (c) =>
        streamProgress(
          c,
          async (report) => {
            report({ phase: "posting", done: 1, total: 2 });
            await gate;
            return { committed: [] };
          },
          () => ({ error: { code: "INTERNAL_ERROR", message: "unreachable" } }),
        ).response,
    );

    const response = await app.request("/work");
    // The pump wakes on its own timer, so the first frame is the one it sends
    // — while the work above is still parked on the gate.
    const first = await readOnce(response);
    expect(createProgressDecoder()(first)).toEqual([
      { type: "progress", event: { phase: "posting", done: 1, total: 2 } },
    ]);
    release();
  });

  it("settles only once the last frame is out", async () => {
    const { gate, release } = held();
    const app = new Hono();
    let settled: Promise<void> | null = null;
    app.get("/work", (c) => {
      const stream = streamProgress(
        c,
        async () => {
          await gate;
          return { committed: [] };
        },
        () => ({ error: { code: "INTERNAL_ERROR", message: "unreachable" } }),
      );
      settled = stream.settled;
      return stream.response;
    });

    const response = await app.request("/work");
    // The request timer hangs off this. Resolving it when the response object
    // was handed over — which is immediately — would record a ninety second
    // commit as a sub-millisecond 200.
    const marker = Symbol("still running");
    expect(await Promise.race([settled!, Promise.resolve(marker)])).toBe(marker);
    release();
    await response.text();
    await expect(settled!).resolves.toBeUndefined();
  });

  it("ends a refusal in a frame, because the status line was already spent", async () => {
    const app = new Hono();
    app.get(
      "/work",
      (c) =>
        streamProgress(
          c,
          async () => {
            throw new Error("refused");
          },
          () => ({ error: { code: "STALE_VERSION", message: "Reload and try again" } }),
        ).response,
    );

    const response = await app.request("/work");
    expect(response.status).toBe(200);
    const frames = createProgressDecoder()(await response.text());
    expect(frames).toEqual([
      {
        type: "error",
        error: { error: { code: "STALE_VERSION", message: "Reload and try again" } },
      },
    ]);
  });

  it("settles even when the work throws, so nothing waiting on it hangs", async () => {
    const app = new Hono();
    let settled: Promise<void> | null = null;
    app.get("/work", (c) => {
      const stream = streamProgress(
        c,
        async () => {
          throw new Error("refused");
        },
        () => ({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }),
      );
      settled = stream.settled;
      return stream.response;
    });

    const response = await app.request("/work");
    await response.text();
    // The request timer awaits this. A stream that never settled would leave a
    // request uncounted and a timer running for the life of the process.
    await expect(settled!).resolves.toBeUndefined();
  });
});
