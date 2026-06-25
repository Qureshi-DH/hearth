import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A finished trip is announced to the circle, in the feed and as a push, and
 * the Trips switch that mutes it is stored.
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

/** A house on a quiet street in Bristol, the same one the other specs use. */
const HOME = { lat: 51.4545, lon: -2.5879 }

const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

interface LatLon {
  lat: number
  lon: number
}

interface Fix extends LatLon {
  recordedAt: string
  accuracyMeters: number
  speedMps: number
  batteryLevel: number
}

/**
 * A steady run north-east at `speedMps`, one fix every `intervalSeconds`. Each
 * step moves exactly speed x interval metres, so the distance the server
 * derives from the coordinates agrees with the speeds the fixes carry.
 */
function drive(options: {
  from: LatLon
  startMs: number
  intervalSeconds: number
  count: number
  speedMps: number
  bearingDeg: number
}): Fix[] {
  const { from, startMs, intervalSeconds, count, speedMps, bearingDeg } = options
  const step = speedMps * intervalSeconds
  const north = Math.cos((bearingDeg * Math.PI) / 180) * step
  const east = Math.sin((bearingDeg * Math.PI) / 180) * step

  return Array.from({ length: count }, (_, i) => ({
    lat: from.lat + (north * i) / M_PER_DEG_LAT,
    lon: from.lon + (east * i) / metresPerDegreeLon(from.lat),
    recordedAt: new Date(startMs + i * intervalSeconds * 1000).toISOString(),
    accuracyMeters: 8,
    speedMps,
    // A phone on a 15 minute drive, off the charger, drifting down a percent.
    batteryLevel: 0.68 - i * 0.0002,
  }))
}

const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000

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

/** Uploads in client-sized batches, the way the tracker drains its queue. */
async function uploadFixes(headers: Record<string, string>, points: Fix[]) {
  for (let i = 0; i < points.length; i += 200) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers,
      payload: { points: points.slice(i, i + 200) },
    })
    expect(response.statusCode).toBe(200)
  }
}

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    id: string
    startedAt: string
    endedAt: string
    distanceMeters: number
    maxSpeedMps: number | null
  }>
}

async function feedItems(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { items: Array<{ type: string; summary: string }> }).items
}

const sweep = () => runJobs(getDb(), getConfig(), ctx.app.log)

/** 12.6 km at 50 km/h, finished half an hour ago. */
const commute = () =>
  drive({
    from: HOME,
    startMs: minutesAgo(45),
    intervalSeconds: 30,
    count: 31,
    speedMps: 14,
    bearingDeg: 45,
  })

describe("trips: what the circle is told when a drive finishes", () => {
  it("detects the drive and announces it in the circle's feed", async () => {
    const aisha = await registerUser(ctx.app, {
      displayName: "Aisha",
      deviceId: "pixel-trip-announce",
    })
    const circle = await createCircle(aisha.headers)

    const fixes = commute()
    await uploadFixes(aisha.headers, fixes)
    await sweep()

    // The trip itself is detected, with the numbers the fixes imply.
    const trips = await myTrips(aisha.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(fixes[fixes.length - 1]!.recordedAt)
    // 30 steps x 14 m/s x 30 s = 12 600 m, give or take the projection.
    expect(trips[0]!.distanceMeters).toBeGreaterThan(12_500)
    expect(trips[0]!.distanceMeters).toBeLessThan(12_700)
    expect(trips[0]!.maxSpeedMps).toBeCloseTo(14, 5)

    // A check-in beside it, so a missing trip row cannot be a broken feed.
    const checkIn = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: aisha.headers,
      payload: { lat: HOME.lat, lon: HOME.lon, note: "home safe" },
    })
    expect(checkIn.statusCode).toBe(201)

    const items = await feedItems(aisha.headers, circle.id)
    expect(items.filter((item) => item.type === "check_in")).toHaveLength(1)

    expect(items.filter((item) => item.type === "trip_completed")).toHaveLength(1)
  })

  it("stores a mute for trip_completed and clears it again", async () => {
    const aisha = await registerUser(ctx.app, {
      displayName: "Aisha",
      deviceId: "pixel-trip-toggle",
    })
    const circle = await createCircle(aisha.headers)

    // The app renders one switch per MUTABLE_EVENT_TYPE, and trip_completed is
    // one of them. Turning it off and back on is accepted and persisted.
    const off = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/notifications`,
      headers: aisha.headers,
      payload: { muted: ["trip_completed"] },
    })
    expect(off.statusCode).toBe(200)

    const on = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/notifications`,
      headers: aisha.headers,
      payload: { muted: [] },
    })
    expect(on.statusCode).toBe(200)

    const stored = (await getDb().execute(
      sql`select notifications from circle_members where circle_id = ${circle.id}::uuid
          and user_id = ${aisha.user.id}::uuid`,
    )) as unknown as Array<{ notifications: { muted: string[] } }>
    expect(stored[0]!.notifications.muted).toEqual([])
  })

  it("queues one push for a completed drive to a listening circle", async () => {
    const aisha = await registerUser(ctx.app, {
      displayName: "Aisha",
      deviceId: "pixel-trip-push",
    })
    const circle = await createCircle(aisha.headers)

    // A second member, so there is somebody to push to who is not the actor.
    await registerUser(ctx.app, {
      displayName: "Yusuf",
      deviceId: "pixel-trip-watcher",
      inviteCode: circle.invite.code,
    })

    await uploadFixes(aisha.headers, commute())
    // push.drain runs before trips.detect in the same pass, so a row queued by
    // the detector is still sitting in the outbox when this pass returns.
    await sweep()

    expect(await myTrips(aisha.headers)).toHaveLength(1)

    const rows = (await getDb().execute(
      sql`select count(*)::int as n from notification_outbox
          where data->>'type' = 'trip_completed'`,
    )) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })
})
