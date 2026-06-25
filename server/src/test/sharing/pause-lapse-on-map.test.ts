import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A timed pause that has lapsed but has not yet been swept by the scheduler is
 * projected as the state it replaced, never as precise.
 */

// A residential street in Bristol, the same point api.test.ts uses.
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

type Headers = Record<string, string>

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

async function household() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })

  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: alice.headers,
    payload: { name: "Neighbours", emoji: "🏡" },
  })
  expect(created.statusCode).toBe(201)
  const circle = created.json() as { id: string; invite: { code: string } }

  const joined = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${circle.invite.code}/accept`,
    headers: bob.headers,
  })
  expect(joined.statusCode).toBe(200)

  return { alice, bob, circleId: circle.id }
}

async function setSharing(
  headers: Headers,
  circleId: string,
  payload: { sharingState: string; pausedUntil?: string | null },
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { sharingState: string; pausedUntil: string | null }
}

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  batteryLevel?: number
  isCharging?: boolean
}

async function uploadFixes(headers: Headers, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

interface SeenPresence {
  userId: string
  lat: number | null
  lon: number | null
  accuracyMeters: number | null
  batteryLevel: number | null
  approximate: boolean
  sharingState: string
  atPlace: { name: string } | null
}

async function presenceFor(headers: Headers, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as SeenPresence[]
  return rows.find((row) => row.userId === userId)!
}

/**
 * The hour on a "pause for an hour" passing, without a test that waits an
 * hour. Two minutes ago, so the pause is over but a 60 second job tick has
 * plausibly not run yet.
 */
async function theHourPasses(userId: string, circleId: string) {
  await getDb().execute(
    sql`update circle_members set paused_until = now() - interval '2 minutes'
        where user_id = ${userId}::uuid and circle_id = ${circleId}::uuid`,
  )
}

async function sharingRow(userId: string, circleId: string) {
  const [row] = await getDb().execute(
    sql`select sharing_state, resume_to_state from circle_members
        where user_id = ${userId}::uuid and circle_id = ${circleId}::uuid`,
  )
  return row as unknown as { sharing_state: string; resume_to_state: string | null }
}

describe("a timed pause lapsing on the map", () => {
  it("coarsens a plain approximate member", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.61, isCharging: false },
    ])
    await setSharing(alice.headers, circleId, { sharingState: "approximate" })

    const seen = await presenceFor(bob.headers, circleId, alice.user.id)
    expect(seen.sharingState).toBe("approximate")
    expect(seen.approximate).toBe(true)
    expect(seen.lat).not.toBe(HOME.lat)
    expect(seen.lon).not.toBe(HOME.lon)
    expect(seen.accuracyMeters).toBeGreaterThanOrEqual(750)
  })

  it("blanks a pause that is still running", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.61, isCharging: false },
    ])
    await setSharing(alice.headers, circleId, { sharingState: "approximate" })
    await setSharing(alice.headers, circleId, {
      sharingState: "paused",
      pausedUntil: iso(60 * 60),
    })

    const seen = await presenceFor(bob.headers, circleId, alice.user.id)
    expect(seen.sharingState).toBe("paused")
    expect(seen.lat).toBeNull()
    expect(seen.lon).toBeNull()
    expect(seen.batteryLevel).toBeNull()
  })

  it("restores approximate on the map, not precise", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.61, isCharging: false },
    ])
    await setSharing(alice.headers, circleId, { sharingState: "approximate" })
    await setSharing(alice.headers, circleId, {
      sharingState: "paused",
      pausedUntil: iso(60 * 60),
    })

    // What was stored is the mode to come back to, so the intent is on record.
    expect(await sharingRow(alice.user.id, circleId)).toMatchObject({
      sharing_state: "paused",
      resume_to_state: "approximate",
    })

    await theHourPasses(alice.user.id, circleId)

    // Her phone is quiet, which is often why somebody paused in the first
    // place, so nothing on the write path runs. Bob opens the map.
    const seen = await presenceFor(bob.headers, circleId, alice.user.id)
    expect(seen.sharingState).toBe("approximate")
    expect(seen.approximate).toBe(true)
    expect(seen.lat).not.toBe(HOME.lat)
    expect(seen.lon).not.toBe(HOME.lon)
    expect(seen.accuracyMeters).toBeGreaterThanOrEqual(750)
  })

  it("still comes back precise when precise is what she paused from", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 9, batteryLevel: 0.61, isCharging: false },
    ])
    await setSharing(alice.headers, circleId, {
      sharingState: "paused",
      pausedUntil: iso(60 * 60),
    })
    await theHourPasses(alice.user.id, circleId)

    const seen = await presenceFor(bob.headers, circleId, alice.user.id)
    expect(seen.sharingState).toBe("precise")
    expect(seen.approximate).toBe(false)
    expect(seen.lat).toBe(HOME.lat)
  })

  // The read path above has to agree with what the sweep then writes.
  it("the scheduler puts the row back to approximate", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.61, isCharging: false },
    ])
    await setSharing(alice.headers, circleId, { sharingState: "approximate" })
    await setSharing(alice.headers, circleId, {
      sharingState: "paused",
      pausedUntil: iso(60 * 60),
    })
    await theHourPasses(alice.user.id, circleId)

    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect(await sharingRow(alice.user.id, circleId)).toMatchObject({
      sharing_state: "approximate",
      resume_to_state: null,
    })
    const seen = await presenceFor(bob.headers, circleId, alice.user.id)
    expect(seen.sharingState).toBe("approximate")
    expect(seen.approximate).toBe(true)
  })
})
