import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/** A quiet residential street in Bristol, and the road heading north out of it. */
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

const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180

const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})

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

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number
  }>,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number; placeEvents: number }
}

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    startedAt: string
    endedAt: string
    distanceMeters: number
    durationSeconds: number
    pointCount: number
  }>
}

/**
 * One commute. 61 fixes thirty seconds apart at 13 m/s (47 km/h), so 390 m of
 * road between neighbouring fixes and 23.4 km in half an hour. `from`/`to` pick
 * the stretch of it that a particular upload carried.
 */
function commuteFixes(driveStartMs: number, from: number, to: number) {
  const fixes = []
  for (let i = from; i < to; i += 1) {
    fixes.push({
      ...northOf(HOME, i * 390),
      recordedAt: new Date(driveStartMs + i * 30_000).toISOString(),
      accuracyMeters: 8,
      speedMps: 13,
    })
  }
  return fixes
}

/** A separate errand later the same morning: 31 fixes at 11 m/s, 9.9 km. */
function errandFixes(startMs: number) {
  return Array.from({ length: 31 }, (_, i) => ({
    ...northOf(HOME, 23_400 + i * 330),
    recordedAt: new Date(startMs + i * 30_000).toISOString(),
    accuracyMeters: 8,
    speedMps: 11,
  }))
}

/** Readable rows in the failure output, so a split drive is visible at a glance. */
const summarise = (trips: Awaited<ReturnType<typeof myTrips>>) =>
  trips.map((t) => `${t.startedAt} -> ${t.endedAt} (${t.pointCount} pts, ${t.distanceMeters} m)`)

describe("trips: half a drive arriving after the sweep that made the trip", () => {
  it("is one trip for the commute when the whole drive arrives in order", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    const driveStart = Date.now() - 65 * 60 * 1000
    await uploadFixes(user.headers, commuteFixes(driveStart, 0, 61))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    await uploadFixes(user.headers, errandFixes(driveStart + 40 * 60 * 1000))
    await runJobs(getDb(), getConfig(), ctx.app.log)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const trips = await myTrips(user.headers)
    expect(summarise(trips)).toHaveLength(2)
    expect(trips.find((t) => t.pointCount === 61)).toBeDefined()
  })

  it("stays one trip when the drive's LATER fixes arrive after a sweep", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    const driveStart = Date.now() - 65 * 60 * 1000

    // The first half gets through, and a sweep turns it into a trip.
    await uploadFixes(user.headers, commuteFixes(driveStart, 0, 30))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    // The rest of the same drive lands afterwards. persistSegment looks back one
    // idle gap, finds the trip that owns the head, and grows it.
    await uploadFixes(user.headers, commuteFixes(driveStart, 30, 61))
    await runJobs(getDb(), getConfig(), ctx.app.log)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const trips = await myTrips(user.headers)
    expect(summarise(trips)).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(61)
  })

  it("does not turn one drive into two trips when its FIRST fixes arrive late", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    const driveStart = Date.now() - 65 * 60 * 1000

    // The upload carrying the first half is delayed while the batches behind it
    // get through, so the server sees the second half of the commute first.
    await uploadFixes(user.headers, commuteFixes(driveStart, 30, 61))
    await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(await myTrips(user.headers)).toHaveLength(1)

    // The straggler lands. Its last fix is thirty seconds before the first fix
    // of the trip that already owns the rest of this drive, nowhere near the
    // five-minute idle gap, so it belongs to that trip.
    await uploadFixes(user.headers, commuteFixes(driveStart, 0, 30))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    // A second, genuinely separate journey, twenty-five minutes later.
    await uploadFixes(user.headers, errandFixes(driveStart + 40 * 60 * 1000))
    await runJobs(getDb(), getConfig(), ctx.app.log)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    // The commute and the errand, and the commute is all 61 fixes.
    const trips = await myTrips(user.headers)
    expect(summarise(trips)).toHaveLength(2)
    expect(trips.find((t) => t.pointCount === 61)).toBeDefined()
  })
})
