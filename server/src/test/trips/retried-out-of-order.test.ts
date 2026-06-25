import { pathDistanceMeters } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * When the batch holding the first half of a drive is retried after the sweep
 * has made a trip of the second half, the two halves still end up one trip.
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

/** A house on a residential street in Bristol. */
const HOME = { lat: 51.4545, lon: -2.5879 }

const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

interface LatLon {
  lat: number
  lon: number
}

interface Fix extends LatLon {
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number
}

function offset(origin: LatLon, northMetres: number, eastMetres: number): LatLon {
  return {
    lat: origin.lat + northMetres / M_PER_DEG_LAT,
    lon: origin.lon + eastMetres / metresPerDegreeLon(origin.lat),
  }
}

interface Step {
  speedMps: number
  bearingDeg: number
}

/**
 * A run of fixes whose coordinates and speeds agree: each step advances exactly
 * speed x interval metres along its bearing, so the distance the server derives
 * from the path is the distance the speeds imply.
 */
function drive(options: {
  from: LatLon
  startMs: number
  intervalSeconds: number
  steps: Step[]
  accuracyMeters?: number
}): Fix[] {
  const { from, startMs, intervalSeconds, steps } = options
  const accuracyMeters = options.accuracyMeters ?? 9
  const fixes: Fix[] = []
  let north = 0
  let east = 0

  for (let i = 0; i <= steps.length; i += 1) {
    if (i > 0) {
      const previous = steps[i - 1]!
      const distance = previous.speedMps * intervalSeconds
      north += Math.cos((previous.bearingDeg * Math.PI) / 180) * distance
      east += Math.sin((previous.bearingDeg * Math.PI) / 180) * distance
    }
    fixes.push({
      ...offset(from, north, east),
      recordedAt: new Date(startMs + i * intervalSeconds * 1000).toISOString(),
      accuracyMeters,
      speedMps: i === 0 ? steps[0]!.speedMps : steps[i - 1]!.speedMps,
    })
  }
  return fixes
}

const steady = (count: number, speedMps: number, bearingDeg: number): Step[] =>
  Array.from({ length: count }, () => ({ speedMps, bearingDeg }))

const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000

/**
 * A real 30 minute commute out of Bristol: crawling out of the estate, an A road,
 * a dual carriageway stretch, then slowing into a car park. 30 second fixes,
 * which is the interval the server hands clients back (minUpdateIntervalSeconds).
 */
const COMMUTE: Step[] = [
  ...steady(8, 7.5, 15),
  ...steady(16, 14.5, 40),
  ...steady(24, 24.5, 55),
  ...steady(10, 11, 70),
  ...steady(2, 3, 70),
]

async function createCircle(headers: Record<string, string>) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string }
}

/** Uploads in client-sized batches, the way the tracker drains its queue. */
async function uploadFixes(headers: Record<string, string>, points: Fix[]) {
  let accepted = 0
  for (let i = 0; i < points.length; i += 200) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers,
      payload: { points: points.slice(i, i + 200) },
    })
    expect(response.statusCode).toBe(200)
    accepted += (response.json() as { accepted: number }).accepted
  }
  return accepted
}

interface TripDto {
  id: string
  startedAt: string
  endedAt: string
  distanceMeters: number
  pointCount: number
}

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  const trips = response.json() as TripDto[]
  return [...trips].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}

async function tripPath(headers: Record<string, string>, tripId: string) {
  const response = await ctx.app.inject({ method: "GET", url: `/api/v1/trips/${tripId}`, headers })
  expect(response.statusCode).toBe(200)
  return (response.json() as { path: Array<{ recordedAt: string }> }).path
}

const sweep = () => runJobs(getDb(), getConfig(), ctx.app.log)

/** Breadcrumbs this user has that belong to no trip at all. */
async function orphanCount(userId: string) {
  const rows = (await getDb().execute(
    sql`select count(*)::int as n from location_points
        where user_id = ${userId} and trip_id is null`,
  )) as unknown as { n: number }[]
  return rows[0]!.n
}

/** How far the trip detector believes it has processed this user. */
async function watermark(userId: string) {
  const rows = (await getDb().execute(
    sql`select trips_processed_until as t from user_presence where user_id = ${userId}`,
  )) as unknown as { t: Date | string | null }[]
  const value = rows[0]?.t
  return value == null ? null : new Date(value).toISOString()
}

describe("trips: a batch retried out of order", () => {
  it("merges the late first half of a commute into the trip made from its second half", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-late-half" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(75),
      intervalSeconds: 30,
      steps: COMMUTE,
    })
    expect(fixes).toHaveLength(61)
    const early = fixes.slice(0, 30)
    const late = fixes.slice(30)

    // The batch holding the first half fails on a flaky cell connection. The
    // batches behind it get through, so the server sees the end of the drive
    // first and sessionises it.
    await uploadFixes(user.headers, late)
    await sweep()
    expect(await myTrips(user.headers)).toHaveLength(1)

    // The queue is drained once the phone is back on Wi-Fi, and three more
    // sweeps run before anybody opens the app.
    expect(await uploadFixes(user.headers, early)).toBe(early.length)
    await sweep()
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(fixes[fixes.length - 1]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))

    // The map on the trip detail screen draws the whole commute, not half of it.
    expect(await tripPath(user.headers, trips[0]!.id)).toHaveLength(fixes.length)

    // And no breadcrumb is left behind belonging to nothing.
    expect(await orphanCount(user.user.id)).toBe(0)
  })

  it("shows the whole commute's distance on the trip card", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-late-half-card" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(75),
      intervalSeconds: 30,
      steps: COMMUTE,
    })
    await uploadFixes(user.headers, fixes.slice(30))
    await sweep()
    await uploadFixes(user.headers, fixes.slice(0, 30))
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    // 61 fixes and about 23.6 km.
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
  })

  it("does not leave the early breadcrumbs belonging to nothing, sweep after sweep", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-late-half-orphans" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(75),
      intervalSeconds: 30,
      steps: COMMUTE,
    })
    await uploadFixes(user.headers, fixes.slice(30))
    await sweep()
    await uploadFixes(user.headers, fixes.slice(0, 30))

    // Five more passes, an hour of a real deployment's sweeps.
    for (let i = 0; i < 5; i += 1) await sweep()

    expect(await orphanCount(user.user.id)).toBe(0)
  })

  it("keeps the watermark at the end of the drive once the late half is merged", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-late-half-watermark" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(75),
      intervalSeconds: 30,
      steps: COMMUTE,
    })

    await uploadFixes(user.headers, fixes.slice(30))
    await sweep()
    expect(await watermark(user.user.id)).toBe(fixes[fixes.length - 1]!.recordedAt)

    await uploadFixes(user.headers, fixes.slice(0, 30))
    for (let i = 0; i < 3; i += 1) await sweep()

    expect(await watermark(user.user.id)).toBe(fixes[fixes.length - 1]!.recordedAt)
  })

  it("makes one trip of the same commute when the batches arrive in order", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-in-order" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(75),
      intervalSeconds: 30,
      steps: COMMUTE,
    })
    await uploadFixes(user.headers, fixes)
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
    expect(await orphanCount(user.user.id)).toBe(0)
  })

  it("merges a late second half into the trip made from its first half", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-late-second-half" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(75),
      intervalSeconds: 30,
      steps: COMMUTE,
    })

    // The other ordering: the first half lands, the sweep closes it because the
    // device has been quiet for longer than the idle gap, and the rest turns up
    // afterwards.
    await uploadFixes(user.headers, fixes.slice(0, 30))
    await sweep()
    expect(await myTrips(user.headers)).toHaveLength(1)

    await uploadFixes(user.headers, fixes.slice(30))
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(await orphanCount(user.user.id)).toBe(0)
  })
})
