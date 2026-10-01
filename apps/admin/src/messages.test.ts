import { describe, expect, it } from "vitest"

import { ApiError } from "./api"
import { signOutFailure } from "./messages"

describe("why signing out failed", () => {
  it("passes on what the server said when it answered", () => {
    expect(
      signOutFailure(
        new ApiError(403, "forbidden", "That request did not come from this server's portal."),
      ),
    ).toBe("Signing out failed. That request did not come from this server's portal.")
    expect(signOutFailure(new ApiError(429, "too_many_requests", "Slow down."))).toBe(
      "Signing out failed. Slow down.",
    )
  })

  it("says it did not reach the server only when no answer came back", () => {
    expect(signOutFailure(new TypeError("Failed to fetch"))).toBe(
      "Signing out did not reach the server. Try again.",
    )
  })
})
