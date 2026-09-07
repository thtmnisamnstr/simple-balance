/**
 * How a long write says where it has got to, on the response that is doing it.
 *
 * A bulk commit and a CSV stage each do all their work inside one transaction,
 * and the books depend on that: "Bulk commits are explicit-ID, validate-first,
 * and atomic." So there is nowhere else for progress to come from. A row
 * written to a progress table inside that transaction is invisible to every
 * other connection until it commits, and `NOTIFY` is queued until then too, so
 * a database channel would say nothing for a minute and then everything at
 * once — which is the problem, not a fix for it. A count held in the process
 * cannot be polled either, because a deployment runs more than one of them and
 * the poll lands on whichever answers.
 *
 * What is left is the socket already open: the same response reports its own
 * progress as it goes. Server-Sent Events, because the shape is exactly that —
 * a sequence of named events ending in a terminal one — and because the proxy
 * in front of this already streams `text/event-stream` without buffering.
 *
 * Encoder and decoder sit together in one shared module for the reason
 * `AGENTS.md` gives about previews: a format the browser reads and the server
 * writes has to be one function, or the two drift and the drift is invisible
 * until somebody watches a real import.
 */

/** What a streamed reply is asked for with, and answered as. */
export const PROGRESS_MEDIA_TYPE = "text/event-stream";

/**
 * The phases a person can be told about, named for the loop each one is.
 *
 * A commit walks all three in this order. A CSV stage has one, because the
 * per-row cost is concentrated in a single loop: everything before it resolves
 * categories and payees for the file as a whole rather than row by row.
 */
type ProgressPhase = "validating" | "duplicates" | "posting" | "staging";

/** Where a phase has got to. `done` never goes backwards inside one phase. */
export type ProgressEvent = {
  phase: ProgressPhase;
  done: number;
  total: number;
};

/**
 * One frame off the wire.
 *
 * Exactly one terminal frame — `result` or `error` — and it is last. A
 * `progress` frame carries no committed fact: it says which row the loop is
 * on, and for an atomic write nothing before the terminal frame has happened
 * yet.
 */
export type ProgressFrame =
  | { type: "progress"; event: ProgressEvent }
  | { type: "result"; value: unknown }
  | { type: "error"; error: ApiErrorEnvelope };

/**
 * The refusal shape both transports already send, carried in a frame instead of
 * a status line.
 *
 * A streamed response answers 200 before it knows the outcome, so a refusal has
 * nowhere else to go. It is the same object the ordinary error handler renders,
 * from the same function, so the two cannot drift.
 */
export type ApiErrorEnvelope = {
  error: { code: string; message: string; details?: unknown };
};

/**
 * The past participle each phase is described with, kept beside the phase names
 * rather than in the page.
 *
 * A phase added here without a word for it would render as a blank sentence
 * beside a moving bar, which is the one thing a progress bar must never be.
 */
export const PROGRESS_VERB: Record<ProgressPhase, string> = {
  validating: "checked",
  duplicates: "compared",
  posting: "committed",
  staging: "staged",
};

/**
 * What each phase is worth, and what has already been spent when it starts.
 *
 * These are weights, not measurements, and the guide says so. They come from
 * counting database round trips per row in each loop — roughly three to
 * validate, one to compare, eleven to post — because equal thirds would park a
 * commit at 66% for most of its life. The bar is honest about which row it is
 * on; the sentence beside it carries the phase's own true figures, which is
 * where a person reads the numbers that matter.
 */
const PHASE_SHARE: Record<ProgressPhase, { spent: number; share: number }> = {
  validating: { spent: 0, share: 0.2 },
  duplicates: { spent: 0.2, share: 0.07 },
  posting: { spent: 0.27, share: 0.73 },
  staging: { spent: 0, share: 1 },
};

/**
 * How full the bar is, from 0 to 1.
 *
 * Monotonic across a phase change, which is the property worth having: a bar
 * that restarts at each phase reads as work being redone.
 */
export function progressFraction(event: ProgressEvent): number {
  const { spent, share } = PHASE_SHARE[event.phase];
  // A phase with nothing in it is finished, not divided by zero.
  const within = event.total > 0 ? Math.min(event.done / event.total, 1) : 1;
  return Math.min(spent + share * within, 1);
}

/** One frame, as the bytes that carry it. */
export function encodeProgressFrame(frame: ProgressFrame): string {
  const data =
    frame.type === "progress" ? frame.event : frame.type === "result" ? frame.value : frame.error;
  // Newlines inside the payload would end the frame early. `JSON.stringify`
  // escapes every one it could produce, so this holds without a replacer — but
  // it is the reason nothing here is ever concatenated by hand.
  return `event: ${frame.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * A decoder over a chunked body, holding whatever arrived mid-frame.
 *
 * Chunk boundaries fall wherever the network puts them, so a frame routinely
 * arrives in two pieces and two frames routinely arrive in one. Anything that
 * parsed a chunk on its own would drop the split ones silently — the failure
 * would only show up on a big import over a slow link, which is the one case
 * this exists for.
 */
export function createProgressDecoder(): (chunk: string) => ProgressFrame[] {
  let buffered = "";
  return (chunk: string) => {
    buffered += chunk;
    const frames: ProgressFrame[] = [];
    let boundary = buffered.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
      boundary = buffered.indexOf("\n\n");
    }
    return frames;
  };
}

/**
 * One `event:`/`data:` pair, or nothing.
 *
 * Anything unrecognised is dropped rather than thrown on: a comment line is
 * legal SSE and is what an intermediary sends to keep a connection warm, and a
 * frame type this build does not know is what a newer server would send to an
 * older page mid-upgrade. Neither is a reason to abandon a commit that is
 * already running.
 */
function parseBlock(block: string): ProgressFrame | null {
  let name = "";
  let payload = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    // The single space after the colon is optional in SSE and both spellings
    // are the same frame.
    else if (line.startsWith("data:")) payload += line.slice(5).trimStart();
  }
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (name === "progress" && isProgressEvent(parsed)) return { type: "progress", event: parsed };
  if (name === "result") return { type: "result", value: parsed };
  if (name === "error" && isErrorEnvelope(parsed)) return { type: "error", error: parsed };
  return null;
}

function isProgressEvent(value: unknown): value is ProgressEvent {
  const event = value as Partial<ProgressEvent> | null;
  return (
    typeof event === "object" &&
    event !== null &&
    typeof event.done === "number" &&
    typeof event.total === "number" &&
    typeof event.phase === "string" &&
    // `hasOwn`, not `in`: `in` walks the prototype, so a frame naming
    // "toString" as its phase would pass the guard and then throw in
    // `progressFraction`, which destructures a phase share that is not there.
    // Unreachable from this server, and the point of a guard is not to depend
    // on that.
    Object.hasOwn(PROGRESS_VERB, event.phase)
  );
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  const envelope = value as { error?: { code?: unknown; message?: unknown } } | null;
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    typeof envelope.error === "object" &&
    envelope.error !== null &&
    typeof envelope.error.code === "string" &&
    typeof envelope.error.message === "string"
  );
}
