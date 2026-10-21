import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { auditLog, sessions } from "../../db/schema"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * One Android phone can run two JavaScript runtimes, each with its own copy of
 * the token pair, and any phone can lose the answer to a renewal. A replay of a
 * spent refresh token from the same device inside one access token's lifetime
 * is that race, and one while nothing newer has been used is the lost answer.
 * Neither is a theft.
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

const refresh = (refreshToken: string, deviceId?: string) =>
  ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken, ...(deviceId ? { deviceId } : {}) },
  })

const reuseAudits = () =>
  getDb().select().from(auditLog).where(eq(auditLog.action, "session.refresh_reuse"))

async function liveSessions(userId: string) {
  return (
    await getDb()
      .select({ revokedAt: sessions.revokedAt })
      .from(sessions)
      .where(eq(sessions.userId, userId))
  ).filter((row) => row.revokedAt === null).length
}

async function rotatedMinutesAgo(userId: string, minutes: number) {
  const ago = new Date(Date.now() - minutes * 60 * 1000).toISOString()
  await getDb().execute(sql`
      update sessions set spent_refresh = coalesce((
        select jsonb_agg(jsonb_set(entry, '{at}', to_jsonb(${ago}::text)))
        from jsonb_array_elements(spent_refresh) entry
      ), '[]'::jsonb)
      where user_id = ${userId}::uuid
    `)
}

describe("a spent refresh token replayed by the same device", () => {
  it("is answered with a fresh pair, for as long as an access token lives", async () => {
    // The phone whose refresh answer never arrived presents the token it
    // still has. Refusing it, even without ending the session, signed the
    // phone out of an account the server still held open for it.
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-pixel" })
    const rotated = await refresh(bob.refreshToken)
    expect(rotated.statusCode).toBe(200)
    const lost = (rotated.json() as { refreshToken: string }).refreshToken

    await rotatedMinutesAgo(bob.user.id, 5)

    const replay = await refresh(bob.refreshToken, "device-bob-pixel")
    expect(replay.statusCode).toBe(200)
    expect(await liveSessions(bob.user.id)).toBe(1)
    expect(await reuseAudits()).toHaveLength(0)
    // The pair nobody received is spent by the one that replaced it.
    expect((await refresh(lost, "device-bob-pixel")).statusCode).toBe(401)
    expect(await liveSessions(bob.user.id)).toBe(1)
  })

  it("is still a theft when it comes from another device", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-pixel" })
    expect((await refresh(bob.refreshToken)).statusCode).toBe(200)
    await rotatedMinutesAgo(bob.user.id, 5)

    expect((await refresh(bob.refreshToken, "device-somebody-else")).statusCode).toBe(401)
    expect(await liveSessions(bob.user.id)).toBe(0)
    expect(await reuseAudits()).toHaveLength(1)
  })

  it("is still a theft when no device is named", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-pixel" })
    expect((await refresh(bob.refreshToken)).statusCode).toBe(200)
    await rotatedMinutesAgo(bob.user.id, 5)

    expect((await refresh(bob.refreshToken)).statusCode).toBe(401)
    expect(await liveSessions(bob.user.id)).toBe(0)
    expect(await reuseAudits()).toHaveLength(1)
  })

  // A parked phone that lost one renewal's answer next renews when it next
  // wakes, often a quarter of an hour or more later. Counted as a theft, it
  // signed the phone out, and with it the tracking, for good.
  it("is answered however late, while the token that replaced it was never used", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-pixel" })
    expect((await refresh(bob.refreshToken)).statusCode).toBe(200)
    await rotatedMinutesAgo(bob.user.id, 81)

    const replay = await refresh(bob.refreshToken, "device-bob-pixel")
    expect(replay.statusCode).toBe(200)
    expect(await liveSessions(bob.user.id)).toBe(1)
    expect(await reuseAudits()).toHaveLength(0)
  })

  it("is still a theft once the token that replaced it has been used", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-pixel" })
    const rotated = await refresh(bob.refreshToken)
    const next = (rotated.json() as { refreshToken: string }).refreshToken
    expect((await refresh(next, "device-bob-pixel")).statusCode).toBe(200)
    await rotatedMinutesAgo(bob.user.id, 20)

    expect((await refresh(bob.refreshToken, "device-bob-pixel")).statusCode).toBe(401)
    expect(await liveSessions(bob.user.id)).toBe(0)
    expect(await reuseAudits()).toHaveLength(1)
  })
})
