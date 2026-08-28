import { ZodError } from "zod";
import type { ServiceErrorCode, ValidationIssue } from "../../shared/domain.js";

/**
 * Narrower than the published `ApiErrorCode` on purpose. The transport half of
 * that union is refused before a route runs, so a service raising one would be
 * reporting something it cannot have seen; typing this on the service half lets
 * the compiler say so.
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

export const conflict = (message: string, details?: unknown) =>
  new AppError("CONFLICT", message, 409, details);

/**
 * Whether this throw site carried the number the agent sentence would name.
 *
 * Thirteen of the fifty `staleVersion` sites throw with no details at all, and
 * pointing an agent at `details.currentVersion` when nothing is there is the
 * "a refusal offers the move that works" rule failing one level down — the same
 * fault as telling an agent to refresh, one field deeper.
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

export const validationError = (message: string, details?: unknown) =>
  new AppError("VALIDATION_ERROR", message, 422, details);

export function zodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "draft",
    message: issue.message,
  }));
}
