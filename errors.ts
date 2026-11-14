export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_STATE"
  | "MANDATORY_DOCUMENT_MISSING" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA" | "RATE_LIMITED" | "INTERNAL";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
  static validation(message: string, details?: unknown) { return new AppError(400, "VALIDATION_ERROR", message, details); }
  static unauthenticated(message = "Authentication required") { return new AppError(401, "UNAUTHENTICATED", message); }
  static forbidden(message = "You are not permitted to do this") { return new AppError(403, "FORBIDDEN", message); }
  static notFound(what: string) { return new AppError(404, "NOT_FOUND", `${what} not found`); }
  static conflict(code: ErrorCode, message: string, details?: unknown) { return new AppError(409, code, message, details); }
}
