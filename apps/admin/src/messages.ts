import { ApiError } from "./api"

/** A server that answered and refused, for its origin check or a rate limit, did hear it. */
export function signOutFailure(error: unknown): string {
  return error instanceof ApiError
    ? `Signing out failed. ${error.message}`
    : "Signing out did not reach the server. Try again."
}
