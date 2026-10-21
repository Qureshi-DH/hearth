import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { sessions, userPresence } from "../../db/schema"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A session used to keep the app and OS versions it was signed in with. A
 * phone updated since went on showing the old ones, in the admin portal and on
 * the devices screen, so nobody could tell which phones had a fix.
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

async function report(headers: Record<string, string>, extra: Record<string, string>) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: "/api/v1/me/health",
    headers,
    payload: { locationPermission: "always", locationServices: true, ...extra },
  })
  expect(response.statusCode).toBe(200)
}

async function sessionOf(userId: string) {
  const [row] = await getDb()
    .select({ appVersion: sessions.appVersion, osVersion: sessions.osVersion })
    .from(sessions)
    .where(eq(sessions.userId, userId))
  return row
}

describe("the versions a session shows", () => {
  it("follow the phone's health report", async () => {
    const bob = await registerUser(ctx.app)
    await report(bob.headers, { appVersion: "1.3.0", osVersion: "17" })
    expect(await sessionOf(bob.user.id)).toEqual({ appVersion: "1.3.0", osVersion: "17" })
  })

  it("stay as they were for a report that does not name them", async () => {
    const bob = await registerUser(ctx.app)
    await report(bob.headers, { appVersion: "1.3.0", osVersion: "17" })
    await report(bob.headers, {})
    expect(await sessionOf(bob.user.id)).toEqual({ appVersion: "1.3.0", osVersion: "17" })
  })

  it("are kept on the session, not in the health the circle reads", async () => {
    const bob = await registerUser(ctx.app)
    await report(bob.headers, { appVersion: "1.3.0", osVersion: "17" })
    const [presence] = await getDb()
      .select({ health: userPresence.health })
      .from(userPresence)
      .where(eq(userPresence.userId, bob.user.id))
    expect(presence?.health).not.toHaveProperty("appVersion")
    expect(presence?.health).not.toHaveProperty("osVersion")
  })
})
