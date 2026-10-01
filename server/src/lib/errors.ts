/** An error that is safe to render to an API client verbatim. */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = "AppError"
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details)

export const unauthorized = (message = "Authentication required.") =>
  new AppError(401, "unauthorized", message)

/**
 * A password the person typed was wrong. Its own code, because a client
 * renews its session on an "unauthorized" and must not mistake one for the
 * other.
 */
export const wrongPassword = (message = "That password is not right.") =>
  new AppError(401, "wrong_password", message)

export const forbidden = (message = "You do not have access to this resource.") =>
  new AppError(403, "forbidden", message)

export const notFound = (message = "Not found.") => new AppError(404, "not_found", message)

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, "conflict", message, details)

export const tooManyRequests = (message = "Slow down.") =>
  new AppError(429, "too_many_requests", message)
