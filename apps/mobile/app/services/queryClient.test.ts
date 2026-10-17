import { ApiError } from "@/services/api"

import { shouldRetry } from "./queryClient"

describe("which failed queries are tried again", () => {
  // Every 4xx is the server's answer to this request, and asking again only
  // repeats it. A firewall in front of a home server counts each one.
  it("never tries a 4xx again, a 409 or a 429 included", () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422, 429]) {
      expect([status, shouldRetry(0, new ApiError(status, "x", "x"))]).toEqual([status, false])
    }
  })

  it("tries a dropped connection and a 5xx twice more", () => {
    for (const error of [new ApiError(0, "network_error", "x"), new ApiError(502, "x", "x")]) {
      expect([0, 1, 2].map((count) => shouldRetry(count, error))).toEqual([true, true, false])
    }
  })

  it("tries a request that timed out at the server", () => {
    expect(shouldRetry(0, new ApiError(408, "x", "x"))).toBe(true)
  })
})
