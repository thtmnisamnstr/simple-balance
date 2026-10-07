import { ZodError } from "zod";
import type { ServiceErrorCode, TransportErrorCode, ValidationIssue } from "../../shared/domain.js";

/**
 * A refusal that belongs to the transport rather than to the ledger.
 *
 * Separate from `AppError` because the two enumerations are separate on
 * purpose: `mcp-output-schemas.ts` declares `serviceErrorCodes` alone, since a
 * transport code cannot reach a tool call. A body that is not JSON is the one
 * transport refusal a route raises by throwing rather than by returning, so it
 * needs a class; the rest are `errorResponse` in `http-security.ts`.
 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly status: number;

  constructor(code: TransportErrorCode, message: string, status: number) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Narrower than the published `ApiErrorCode` on purpose. The transport half of
 * that union is `TransportError` above, refused before a route reaches a
 * service, so a service raising one would be reporting something it cannot have
 * seen; typing this on the service half lets the compiler say so.
 */
export class AppError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /**
   * The same diagnosis, with the move an agent can actually make.
   *
   * `common.md` rules that where two callers need different advice it is the
   * advice that differs and never the diagnosis, so this is not a second error:
   * it is the second half of the same sentence. Only `src/server/mcp.ts` reads
   * it. HTTP keeps rendering `message`, which leaves browser copy under the
   * browser's control and means a throw site that has nothing extra to tell an
   * agent says nothing extra.
   */
  readonly agentMessage?: string;

  constructor(
    code: ServiceErrorCode,
    message: string,
    status: number,
    details?: unknown,
    agentMessage?: string,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.agentMessage = agentMessage;
  }
}

export const notFound = (message: string, details?: unknown) =>
  new AppError("NOT_FOUND", message, 404, details);

/**
 * `agentMessage` is optional and widens this constructor rather than adding a
 * sixth: the five-constructor rule in `docs/standards/code/errors.md` 2 is about
 * how a service raises a refusal, not about how many arguments the refusal
 * carries. The account limit is the first caller to need it, because the move
 * that works — upgrading a plan — is one only a person signed into a browser
 * can make, so the sentence an agent should hear is not the sentence a person
 * should read.
 */
export const conflict = (message: string, details?: unknown, agentMessage?: string) =>
  new AppError("CONFLICT", message, 409, details, agentMessage);

/**
 * Whether this throw site carried the number the agent sentence would name.
 *
 * Thirteen of the fifty-three `staleVersion` sites throw with no details at
 * all, and pointing an agent at `details.currentVersion` when nothing is there
 * is the "a refusal offers the move that works" rule failing one level down —
 * the same fault as telling an agent to refresh, one field deeper.
 */
const carries = (details: unknown, key: string) =>
  typeof details === "object" && details !== null && key in details;

/**
 * The same fault twice over, and the second one has no version to offer.
 *
 * A mass change describes its set with a count and a fingerprint rather than
 * with a version, so when the set has moved underneath it there is nothing to
 * "retry with the version it reports": the move that works is previewing the
 * selection again, which is what issues the next count and fingerprint. Both
 * messages said to read the row again, which is advice a caller cannot take on
 * a refusal that is not about a row.
 *
 * The code stays `STALE_VERSION` either way. It is the same event and a client
 * keying on the code has been seeing it since 0.1.4; only the sentence changes.
 */
export const staleVersion = (details?: unknown) =>
  new AppError(
    "STALE_VERSION",
    carries(details, "currentFingerprint")
      ? "The rows this was about have changed. Preview the selection again and retry with the count and fingerprint it returns."
      : "This changed while you were editing it. Reload to see the current version.",
    409,
    details,
    carries(details, "currentFingerprint")
      ? "The selected set has changed since it was previewed. Preview the selection again and send the count and fingerprint it returns."
      : carries(details, "currentVersion")
        ? "This changed since you read it. Read it again and retry with the version in details.currentVersion."
        : "This changed since you read it. Read it again and retry with the version it reports.",
  );

export const duplicate = (message: string, details?: unknown) =>
  new AppError("DUPLICATE", message, 409, details);

/**
 * What a person or an agent is told when the server failed and nothing about
 * the request can say why. It says what happened and the one move left,
 * because errors.md 3.1 refuses "an unexpected error occurred": three words of
 * apology-shaped noise and no information. The cause goes to the log, never
 * here.
 */
export const INTERNAL_ERROR_MESSAGE =
  "This could not be finished because of a problem on the server. Try again, and if it keeps happening, tell whoever runs this server.";

/**
 * `agentMessage` is here for the same reason `conflict` carries one, and for a
 * refusal that needs it more: a frozen account arrives under the code that
 * means "fix the arguments", and no argument an agent can change gets past it.
 * The browser sentence offers making the account active or upgrading a plan,
 * and a token handed to a program can do neither on its own.
 */
export const validationError = (message: string, details?: unknown, agentMessage?: string) =>
  new AppError("VALIDATION_ERROR", message, 422, details, agentMessage);

/**
 * What to say about a field a draft left out, by the name it has in every
 * draft shape.
 *
 * Zod words a missing field "Invalid input: expected string, received
 * undefined", which is a sentence about its own types, and the staged queue
 * showed it under a row an agent had proposed without an account. A staged row
 * is the one place a person meets an incomplete draft — every form here marks
 * these fields required — so this is the queue's vocabulary rather than a
 * second error system: a name not listed keeps Zod's wording.
 */
const MISSING_FIELD: Record<string, string> = {
  type: "Choose deposit, withdrawal or transfer",
  date: "Enter the date",
  payee: "Enter a payee",
  // `common.md`'s worked sentence for an empty amount, for all three: the
  // field beside the message already says which amount it is.
  amount: "Enter an amount",
  sourceAmount: "Enter an amount",
  destinationAmount: "Enter an amount",
  fromAccountId: "Choose the account the money comes from",
  toAccountId: "Choose the account the money goes to",
};

/**
 * Missing rather than wrong, which Zod 4 does not record: an issue carries no
 * input unless the parse asked for it, so the caller hands the input over and
 * the path is walked to see whether anything is there.
 */
function missingFieldMessage(issue: ZodError["issues"][number], input: unknown) {
  if (issue.code !== "invalid_type") return undefined;
  let value = input;
  for (const key of issue.path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  const leaf = issue.path.at(-1);
  return value === undefined && typeof leaf === "string" ? MISSING_FIELD[leaf] : undefined;
}

export function zodIssues(error: ZodError, input?: unknown): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "draft",
    message: (input === undefined ? undefined : missingFieldMessage(issue, input)) ?? issue.message,
  }));
}
