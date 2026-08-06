import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, silentSinceLastFix, startTestApp, type TestContext } from "../helpers"

/**
 * The device offline alert goes to each circle once per outage, and a circle
 * that was paused when the outage began hears about it once sharing is back.
 */

// A quiet residential street in Bristol, the same one api.test.ts uses.
const HOME = { lat: 51.4545, lon: -2.5879 }

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

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number
  batteryLevel?: number
  isCharging?: boolean
}

async function createCircle(headers: Record<string, string>, name = "Family") {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function joinCircle(headers: Record<string, string>, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function uploadFixes(headers: Record<string, string>, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number; placeEvents: number }
}

async function setSharing(
  headers: Record<string, string>,
  circleId: string,
  payload: { sharingState: "precise" | "approximate" | "paused"; pausedUntil?: string | null },
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload,
  })
  expect(response.statusCode).toBe(200)
}

async function feedTypes(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return ((response.json() as { items: unknown }).items as Array<{ type: string }>).map(
    (item) => item.type,
  )
}

async function outboxTitles() {
  const rows = (await getDb().execute(sql`select title from notification_outbox`)) as unknown as {
    title: string
  }[]
  return rows.map((row) => row.title)
}

async function presenceRow(userId: string) {
  const [row] = (await getDb().execute(
    sql`select offline_notified_at, recorded_at from user_presence where user_id = ${userId}::uuid`,
  )) as unknown as { offline_notified_at: string | null; recorded_at: string | null }[]
  return row ?? null
}

const tick = () => runJobs(getDb(), getConfig(), ctx.app.log)

/**
 * Three hours of wall clock passing while a dead phone sends nothing: the
 * pause expiry falls into the past and the last fix ages by the same amount.
 * The suite already moves recorded_at back this way rather than waiting.
 */
async function passTime(userId: string, minutes: number) {
  const db = getDb()
  await db.execute(
    sql`update circle_members
        set paused_until = paused_until - make_interval(mins => ${minutes}::int)
        where user_id = ${userId}::uuid and paused_until is not null`,
  )
  await db.execute(
    sql`update user_presence
        set recorded_at = recorded_at - make_interval(mins => ${minutes}::int),
            last_heard_at = last_heard_at - make_interval(mins => ${minutes}::int)
        where user_id = ${userId}::uuid`,
  )
}

describe("device offline and the once-per-outage latch", () => {
  it("announces a phone quiet for ninety minutes, once, to a circle it shares with", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 11, batteryLevel: 0.34 },
    ])
    await silentSinceLastFix(teen.user.id)

    const first = await tick()
    expect(first.offlineFlagged).toBe(1)
    await tick()

    expect(
      (await feedTypes(parent.headers, circle.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(1)
    expect(await outboxTitles()).toContain("Phone offline")
  })

  it("says nothing to a circle while sharing with it is paused", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 11, batteryLevel: 0.21 },
    ])
    await silentSinceLastFix(teen.user.id)
    await setSharing(teen.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    })

    await tick()

    expect(await feedTypes(parent.headers, circle.id)).not.toContain("device_offline")
    expect(await outboxTitles()).not.toContain("Phone offline")
  })

  it("records the outage on a sweep that told nobody", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 11, batteryLevel: 0.21 },
    ])
    await silentSinceLastFix(teen.user.id)
    await setSharing(teen.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    })

    const report = await tick()

    // No event anywhere, but the outage is on the row, so the next sweep does
    // not mistake it for a new one.
    expect(await feedTypes(parent.headers, circle.id)).not.toContain("device_offline")
    expect(report.offlineFlagged).toBe(1)
    expect((await presenceRow(teen.user.id))!.offline_notified_at).not.toBeNull()
  })

  it("announces a phone that went quiet while sharing was paused, once the pause lapses", async () => {
    // A teenager's phone dies at nine in the evening with sharing paused until
    // midnight, so the sweeps in between say nothing. The pause lapses on its
    // own and the phone is still dark.
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 11, batteryLevel: 0.07 },
    ])
    await silentSinceLastFix(teen.user.id)
    await setSharing(teen.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    })

    // A sweep while the pause is on. The circle must hear nothing yet.
    await tick()
    expect(await feedTypes(parent.headers, circle.id)).not.toContain("device_offline")

    // Three hours later. Nothing has been heard from the phone in four and a
    // half hours and the pause has run out.
    await passTime(teen.user.id, 3 * 60)

    await tick()
    const types = await feedTypes(parent.headers, circle.id)

    // runJobs resumes the pause first, so the family is told sharing is back.
    expect(types).toContain("sharing_resumed")
    // And that the phone is still dark.
    expect(types).toContain("device_offline")
  })

  it("tells the paused circle once sharing is back, after another circle was told", async () => {
    // Friends share precisely and hear about it at once. Family is paused and
    // hears when the member turns sharing back on by hand.
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const friend = await registerUser(ctx.app, { displayName: "Friend" })

    const family = await createCircle(parent.headers, "Family")
    const friends = await createCircle(friend.headers, "Friends")
    await joinCircle(teen.headers, family.invite.code)
    await joinCircle(teen.headers, friends.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-95 * 60), accuracyMeters: 14, batteryLevel: 0.05 },
    ])
    await silentSinceLastFix(teen.user.id)
    await setSharing(teen.headers, family.id, { sharingState: "paused" })

    await tick()
    expect(await feedTypes(friend.headers, friends.id)).toContain("device_offline")
    expect(await feedTypes(parent.headers, family.id)).not.toContain("device_offline")

    // Sharing with the family goes back on while the phone is still dark.
    await setSharing(teen.headers, family.id, { sharingState: "precise" })
    await tick()
    await tick()

    expect(await feedTypes(parent.headers, family.id)).toContain("device_offline")
  })
})
