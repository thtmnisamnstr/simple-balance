import type { Context } from "hono";
import { stream } from "hono/streaming";
import {
  encodeProgressFrame,
  PROGRESS_MEDIA_TYPE,
  type ApiErrorEnvelope,
  type ProgressEvent,
} from "../shared/progress.js";

/**
 * The other way a long write may answer: as it goes, rather than at the end.
 *
 * A transport adapter and nothing more. It decides when a frame is written and
 * how it is framed; the service decides what is in one. That split is what
 * keeps the service callable from MCP, from a test and from the plain JSON
 * route with nothing about streaming in it.
 */

/**
 * Four times a second, which is a decision rather than a default.
 *
 * The service reports every row. A ten thousand row commit would otherwise be
 * ten thousand frames and ten thousand renders, so the snapshot is coalesced
 * and only the latest is ever sent. Slower than this and the bar stutters;
 * faster and it is redrawing a figure nobody can read that quickly.
 */
const FRAME_INTERVAL_MS = 250;

/** What a service is handed to say where it has got to. */
export type ProgressReporter = (event: ProgressEvent) => void;

/**
 * Run `work`, reporting its progress on the response that is running it.
 *
 * The reporter handed to `work` writes three numbers into an object and
 * returns. It awaits nothing and cannot throw, which is the whole design: the
 * work runs inside one database transaction, and anything that touched a socket
 * from in there would let a slow reader hold the connection open or fail the
 * commit. The pump lives out here, outside the transaction, and sends whatever
 * the latest snapshot is.
 *
 * The status line is spent on the first frame, so a refusal cannot be a status
 * code any more. It becomes a terminal `error` frame carrying the envelope the
 * ordinary handler would have rendered — from the same function, so the two
 * cannot drift.
 *
 * `settled` comes back rather than being written onto the context, because the
 * response object is handed over immediately and the request is not over until
 * the last frame is out. Whoever times the request awaits it.
 */
export function streamProgress<T>(
  c: Context,
  work: (report: ProgressReporter) => Promise<T>,
  renderError: (error: unknown) => ApiErrorEnvelope,
): { response: Response; settled: Promise<void> } {
  c.header("Content-Type", PROGRESS_MEDIA_TYPE);
  // Named explicitly, because the Node adapter reads it: with the header
  // present it flushes the head and pipes, and without it it first races
  // several non-blocking reads trying to work out a Content-Length. That delay
  // lands on exactly the first frame, which is the one the bar waits for.
  c.header("Transfer-Encoding", "chunked");
  // For an operator whose reverse proxy buffers by default. The proxy this
  // repository ships already has buffering off for `/api`, so this changes
  // nothing there; it is what rescues a deployment behind somebody else's.
  c.header("X-Accel-Buffering", "no");

  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const response = stream(c, async (writer) => {
    // Mutable on purpose, and read by the pump rather than pushed to it. This
    // is the object the reporter writes into.
    let latest: ProgressEvent | null = null;
    let sent: ProgressEvent | null = null;
    let running = true;
    let wake = () => {};

    const write = async (frame: Parameters<typeof encodeProgressFrame>[0]) => {
      // Hono's writer swallows a failed write itself, which is what should
      // happen here: a browser that vanished mid-commit is not a reason to
      // abandon a transaction that is nine tenths done. The person closed a
      // tab; they did not ask for a rollback, and their retry replays through
      // the idempotency record rather than committing twice.
      await writer.write(encodeProgressFrame(frame));
    };

    const flush = async () => {
      const snapshot = latest;
      if (!snapshot) return;
      if (sent && sent.phase === snapshot.phase && sent.done === snapshot.done) return;
      sent = snapshot;
      await write({ type: "progress", event: snapshot });
    };

    const pump = (async () => {
      while (running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, FRAME_INTERVAL_MS);
          // Woken rather than waited out, so the terminal frame is not held
          // behind a quarter second of sleep on every small request.
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (running) await flush();
      }
    })();

    const stop = async () => {
      running = false;
      wake();
      await pump;
    };

    try {
      const value = await work((event) => {
        latest = event;
      });
      await stop();
      // The last figure the loops reported, so a bar caught mid-phase is not
      // left showing a number the result contradicts.
      await flush();
      await write({ type: "result", value });
    } catch (error) {
      await stop();
      await write({ type: "error", error: renderError(error) });
    } finally {
      // Nothing may throw past here. Hono's own handler for an unhandled throw
      // in this callback writes to `console`, and nothing outside the
      // configuration layer may name it.
      settle();
    }
  });

  return { response, settled };
}
