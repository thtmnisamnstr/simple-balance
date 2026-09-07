import { encodeProgressFrame, type ProgressFrame } from "../../src/shared/progress.js";

/**
 * A reply the test releases a frame at a time, and can tell has been read.
 *
 * Every other stub in this suite hands the client a `Response` built from a
 * string, which is exactly what the streaming path must never be given: the
 * frames are the point, and a body already complete when it is handed over
 * proves nothing about reading one that is not.
 *
 * `pulls` is what makes a negative assertion mean anything. The source only
 * asks for another frame once the reader has taken the last one and come back,
 * so waiting for the count to rise is waiting for the client to have *finished*
 * with a frame. Without it, "no bar appeared" is asserted in the same tick as
 * the push, before the client could possibly have seen it, and passes whether
 * the page consults its threshold or not.
 */
export function streamedResponse(): {
  response: Response;
  push: (frame: ProgressFrame) => void;
  close: () => void;
  pulls: () => number;
} {
  const encoder = new TextEncoder();
  const queued: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  let pulls = 0;

  const response = new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        while (!queued.length && !closed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (queued.length) {
          controller.enqueue(encoder.encode(queued.shift()!));
          return;
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  return {
    response,
    push: (frame) => {
      queued.push(encodeProgressFrame(frame));
      nudge();
    },
    close: () => {
      closed = true;
      nudge();
    },
    pulls: () => pulls,
  };
}
