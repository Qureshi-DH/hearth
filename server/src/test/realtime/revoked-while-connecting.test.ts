import { createRequire } from "node:module"

import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { getDb } from "../../db/client"
import { revokeSession } from "../../services/auth"
import { registerUser, sessionIdOf, startTestApp, type TestContext } from "../helpers"

/**
 * A socket checks its session, runs its setup queries, and only then listens
 * on the bus. A sign-out announced in between reached no listener. This runs
 * the sign-out inside that gap, while the socket primes its presence.
 */

let duringPriming: (() => Promise<void>) | null = null

vi.mock("../../services/presence", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../services/presence")>()
  return {
    ...original,
    getCirclePresence: async (...args: Parameters<typeof original.getCirclePresence>) => {
      const hook = duringPriming
      duringPriming = null
      if (hook) await hook()
      return original.getCirclePresence(...args)
    },
  }
})

interface RawSocket {
  readyState: number
  on(event: "open", listener: () => void): void
  on(event: "close", listener: (code: number) => void): void
  on(event: "error", listener: (error: Error) => void): void
  close(): void
}

const WebSocketImpl = createRequire(import.meta.url)("ws") as new (url: string) => RawSocket

let ctx: TestContext
let origin = ""

beforeAll(async () => {
  ctx = await startTestApp()
  await ctx.app.listen({ host: "127.0.0.1", port: 0 })
  const address = ctx.app.server.address() as AddressInfo
  origin = `ws://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

describe("a session signed out while its socket is connecting", () => {
  it("has the socket closed, not left open until the next timer pass", async () => {
    const owner = await registerUser(ctx.app)
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: owner.headers,
      payload: { name: "Family", emoji: "🏠" },
    })
    expect(created.statusCode).toBe(201)

    duringPriming = () => revokeSession(getDb(), sessionIdOf(owner.accessToken))

    const socket = new WebSocketImpl(`${origin}/api/v1/ws?access_token=${owner.accessToken}`)
    socket.on("error", () => {})
    const code = await new Promise<number | null>((resolve) => {
      socket.on("close", (closeCode) => resolve(closeCode))
      // The re-authorisation timer is a minute away, so a close inside two
      // seconds came from the check this is about.
      setTimeout(() => resolve(null), 2_000)
    })
    socket.close()
    expect(code).toBe(4401)
  })
})
