import { ZodError } from "zod";
import type { ApiErrorCode, ValidationIssue } from "../../shared/domain.js";

export class AppError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (message = "The requested record was not found") =>
  new AppError("NOT_FOUND", message, 404);

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
