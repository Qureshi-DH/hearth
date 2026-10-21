import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { users } from "../../db/schema"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Android runs no JavaScript timer for an app in the background, so the
 * phone's native tracker answers a wake or a Live request on its own. It
 * cannot refresh an access token to do it, and uploads with a key signed
 * for its session instead.
 */

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

const fix = () => ({
  recordedAt: new Date().toISOString(),
  lat: 33.6844,
  lon: 73.0479,
  accuracyMeters: 8,
})

function upload(key: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers: { authorization: `Bearer ${key}` },
    payload: { points: [fix()] },
  })
}

describe("an Android session's upload key", () => {
  it("comes with sign-up on Android and not on an iPhone", async () => {
    const android = await registerUser(ctx.app, { platform: "android" })
    const iphone = await registerUser(ctx.app, { platform: "ios" })
    expect(android.uploadKey).toMatch(/^hk1\./)
    expect(iphone.uploadKey).toBeUndefined()
  })

  it("stays the same across a refresh", async () => {
    const bob = await registerUser(ctx.app, { platform: "android" })
    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: bob.refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().uploadKey).toBe(bob.uploadKey)
  })

  it("uploads fixes, and the answer says what the phone should do next", async () => {
    const bob = await registerUser(ctx.app, { platform: "android" })
    const response = await upload(bob.uploadKey!)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ accepted: 1, watchedUntil: null })
  })

  it("opens nothing but the upload", async () => {
    const bob = await registerUser(ctx.app, { platform: "android" })
    for (const [method, url] of [
      ["GET", "/api/v1/auth/me"],
      ["POST", "/api/v1/auth/logout"],
      ["GET", "/api/v1/circles"],
    ] as const) {
      const response = await ctx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${bob.uploadKey}` },
      })
      expect(response.statusCode, url).toBe(401)
    }
  })

  it("is refused when it was not signed by this server", async () => {
    const bob = await registerUser(ctx.app, { platform: "android" })
    const [prefix, sessionId] = bob.uploadKey!.split(".")
    const forged = `${prefix}.${sessionId}.${"A".repeat(43)}`
    expect((await upload(forged)).statusCode).toBe(401)
    expect((await upload("hk1.not-a-session.x")).statusCode).toBe(401)
  })

  it("ends with the session", async () => {
    const bob = await registerUser(ctx.app, { platform: "android" })
    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: bob.headers,
    })
    expect(logout.statusCode).toBe(200)
    expect((await upload(bob.uploadKey!)).statusCode).toBe(401)
  })

  it("stops working for a deactivated account", async () => {
    const bob = await registerUser(ctx.app, { platform: "android" })
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, bob.user.id))
    expect((await upload(bob.uploadKey!)).statusCode).toBe(403)
  })
})
