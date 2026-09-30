import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The speed alert and the trip card are built from the same fixes and quote
 * the same number, including on a stream that mixes GPS and network fixes.
 */

const MOTORWAY = { lat: 51.52, lon: -2.57 }
const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180
const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})

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

async function createCircle(headers: Record<string, string>, speedAlertKmh: number) {
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(created.statusCode).toBe(201)
  const circle = created.json() as { id: string }
  const patched = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circle.id}`,
    headers,
    payload: { settings: { speedAlertKmh } },
  })
  expect(patched.statusCode).toBe(200)
  return circle
}

/**
 * Sam's drive as the phone reported it: GPS fixes at 85 and 92 km/h, each
 * one sitting between network fixes that carry no speed and a wide error
 * circle, then the crawl into the car park. Positions advance exactly as far
 * as each speed says; a network fix is placed as if the car kept going.
 */
function theDrive(startMs: number) {
  const gps = (speedMps: number) => ({ count: 1, speedMps, accuracyMeters: 8 })
  const network = { count: 1, speedMps: null, accuracyMeters: 59 }
  const legs: Array<{ count: number; speedMps: number | null; accuracyMeters: number }> = [
    gps(23.6),
    network,
    gps(23.6),
    network,
    gps(23.6),
    network,
    gps(25.5),
    network,
    { count: 4, speedMps: 5.8, accuracyMeters: 9 },
  ]
  let metres = 0
  let index = 0
  return legs.flatMap((leg) =>
    Array.from({ length: leg.count }, () => {
      const fix = {
        ...northOf(MOTORWAY, metres),
        recordedAt: new Date(startMs + index * 30_000).toISOString(),
        speedMps: leg.speedMps,
        accuracyMeters: leg.accuracyMeters,
      }
      metres += (leg.speedMps ?? 24) * 30
      index += 1
      return fix
    }),
  )
}

describe("one speed rule for the alert and the trip", () => {
  it("files the drive at the speed it was announced at", async () => {
    const user = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(user.headers, 80)

    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: { points: theDrive(Date.now() - 14 * 60 * 1000) },
    })
    expect(upload.statusCode).toBe(200)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: user.headers,
    })
    const alerts = (
      feed.json() as {
        items: Array<{ type: string; summary: string; payload: { speedKmh: number } }>
      }
    ).items.filter((item) => item.type === "speed_alert")
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.payload.speedKmh).toBe(92)
    expect(alerts[0]!.summary).toBe("Sam was driving at 92 km/h")

    const trips = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/trips",
      headers: user.headers,
    })
    const [trip] = trips.json() as Array<{ maxSpeedMps: number | null; avgSpeedMps: number | null }>
    expect(trip).toBeDefined()
    expect(Math.round(trip!.maxSpeedMps! * 3.6)).toBe(92)
    expect(trip!.avgSpeedMps!).toBeLessThanOrEqual(trip!.maxSpeedMps!)
  })

  // A phone that hands over a drive after its classifier has moved on can
  // label every fix of it "walking". Nobody walks at 92 km/h.
  it("calls it driving when the phone's label is impossible at that speed", async () => {
    const user = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(user.headers, 80)

    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: {
        points: theDrive(Date.now() - 14 * 60 * 1000).map((fix) => ({
          ...fix,
          activity: "walking",
        })),
      },
    })
    expect(upload.statusCode).toBe(200)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: user.headers,
    })
    const alerts = (
      feed.json() as { items: Array<{ type: string; summary: string }> }
    ).items.filter((item) => item.type === "speed_alert")
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.summary).toBe("Sam was driving at 92 km/h")
  })

  it("shows the map a car rather than the impossible label", async () => {
    const user = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(user.headers, 80)
    const drive = theDrive(Date.now() - 2 * 60 * 1000)
    const moving = drive.filter((fix) => fix.speedMps != null && fix.speedMps > 20)
    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: { points: [{ ...moving[moving.length - 1]!, activity: "walking" }] },
    })
    expect(upload.statusCode).toBe(200)

    const map = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/locations`,
      headers: user.headers,
    })
    const [presence] = map.json() as Array<{ activity: string | null }>
    expect(presence?.activity).toBe("driving")
  })

  it("keeps a lone spike out of both", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers, 120)

    const points = theDrive(Date.now() - 14 * 60 * 1000)
    points[4]!.speedMps = 40
    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: { points },
    })
    expect(upload.statusCode).toBe(200)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: user.headers,
    })
    const alerts = (feed.json() as { items: Array<{ type: string }> }).items.filter(
      (item) => item.type === "speed_alert",
    )
    expect(alerts).toHaveLength(0)

    const trips = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/trips",
      headers: user.headers,
    })
    const [trip] = trips.json() as Array<{ maxSpeedMps: number | null }>
    expect(Math.round(trip!.maxSpeedMps! * 3.6)).toBe(92)
  })
})

describe("what a phone can say stands between it and reporting", () => {
  async function report(headers: Record<string, string>, health: Record<string, unknown>) {
    const response = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/me/health",
      headers,
      payload: { locationPermission: "always", locationServices: true, ...health },
    })
    expect(response.statusCode).toBe(200)
  }

  async function issuesOf(headers: Record<string, string>, circleId: string, userId: string) {
    const presence = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circleId}/locations`,
      headers,
    })
    expect(presence.statusCode).toBe(200)
    const rows = presence.json() as Array<{ userId: string; issues: string[] }>
    return rows.find((row) => row.userId === userId)!.issues
  }

  it("shows background restriction, power saving and a stopped service under the member", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers, 0)
    await report(user.headers, {
      backgroundRestricted: true,
      lowPowerMode: true,
      serviceStopped: true,
      manufacturer: "Xiaomi",
    })
    expect(await issuesOf(user.headers, circle.id, user.user.id)).toEqual([
      "low_power_mode",
      "background_restricted",
      "service_stopped",
    ])
  })
})
