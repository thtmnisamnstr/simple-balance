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

  constructor(code: ServiceErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (message = "The requested record was not found", details?: unknown) =>
  new AppError("NOT_FOUND", message, 404, details);

export const conflict = (message: string, details?: unknown) =>
  new AppError("CONFLICT", message, 409, details);

export const staleVersion = (details?: unknown) =>
  new AppError(
    "STALE_VERSION",
    "This record changed since it was loaded. Refresh and try again.",
    409,
    details,
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
