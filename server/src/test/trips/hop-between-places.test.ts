import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { detectTripsForUser } from "../../services/trips"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A journey between two named places is a trip, however short and however
 * sparsely a parked iPhone reported it.
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

const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const HOME = { lat: 33.67353, lon: 73.06848 }
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
const offset = (origin: { lat: number; lon: number }, northMetres: number, eastMetres: number) => ({
  lat: origin.lat + northMetres / M_PER_DEG_LAT,
  lon: origin.lon + eastMetres / metresPerDegreeLon(origin.lat),
})
/** The clinic next door: 300 m up the road. */
const CLINIC = offset(HOME, 200, -225)

type Headers = Record<string, string>

async function createCircle(headers: Headers) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string }
}

async function createPlace(
  headers: Headers,
  circleId: string,
  place: { name: string; lat: number; lon: number; radiusMeters: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { icon: "home", ...place },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string }
}

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters: number
  speedMps?: number
  activity?: string
  source?: string
}

async function upload(headers: Headers, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

async function myTrips(headers: Headers) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    startedAt: string
    endedAt: string
    distanceMeters: number
    startPlaceName: string | null
    endPlaceName: string | null
  }>
}

const at = (base: number, minutes: number) => new Date(base + minutes * 60_000).toISOString()

/** Where a parked phone says it is, on the schedule a parked phone keeps. */
const parked = (where: { lat: number; lon: number }, base: number, minutes: number[]): Fix[] =>
  minutes.map((m) => ({
    ...where,
    recordedAt: at(base, m),
    accuracyMeters: 9,
    activity: "still",
    source: "background",
  }))

describe("a hop between two named places", () => {
  it("is a trip from the last fix at the origin to the arrival, however short and quiet", async () => {
    const sam = await registerUser(ctx.app)
    const circle = await createCircle(sam.headers)
    await createPlace(sam.headers, circle.id, { name: "Home", ...HOME, radiusMeters: 200 })
    await createPlace(sam.headers, circle.id, { name: "Clinic", ...CLINIC, radiusMeters: 120 })

    const t0 = Date.now() - 3 * 60 * 60_000
    await upload(sam.headers, [
      ...parked(HOME, t0, [0, 30, 60, 90]),
      // Nothing for 27 minutes: the parked session cannot see a move this
      // small, and the fence fires on arrival.
      {
        ...offset(CLINIC, -20, 30),
        recordedAt: at(t0, 117),
        accuracyMeters: 27,
        source: "significant",
      },
      { ...offset(CLINIC, -15, 25), recordedAt: at(t0, 117.15), accuracyMeters: 14, speedMps: 2.8 },
      { ...offset(CLINIC, 5, -5), recordedAt: at(t0, 123), accuracyMeters: 36 },
      {
        ...CLINIC,
        recordedAt: at(t0, 139),
        accuracyMeters: 38,
        speedMps: 0.2,
        activity: "still",
        source: "significant",
      },
      ...parked(CLINIC, t0, [170, 200]),
    ])

    await detectTripsForUser(getDb(), sam.user.id, new Date(t0 + 210 * 60_000))
    const trips = await myTrips(sam.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ startPlaceName: "Home", endPlaceName: "Clinic" })
    // It starts where the phone was last seen at home, not at the arrival.
    expect(trips[0]!.startedAt).toBe(at(t0, 90))
    expect(Date.parse(trips[0]!.endedAt)).toBeLessThanOrEqual(Date.parse(at(t0, 139)))
    expect(trips[0]!.distanceMeters).toBeGreaterThan(250)
  })

  it("does not glue the hop back to the trip that ended at the origin", async () => {
    // A drive that ended at Clinic, a stay, then the hop home. Two journeys.
    const sam = await registerUser(ctx.app)
    const circle = await createCircle(sam.headers)
    await createPlace(sam.headers, circle.id, { name: "Home", ...HOME, radiusMeters: 200 })
    await createPlace(sam.headers, circle.id, { name: "Clinic", ...CLINIC, radiusMeters: 120 })
    const FAR = offset(HOME, 3000, 3000)

    const t0 = Date.now() - 4 * 60 * 60_000
    const drive: Fix[] = Array.from({ length: 12 }, (_, i) => ({
      ...offset(FAR, (-3000 * i) / 11 + 200, (-3000 * i) / 11 - 225),
      recordedAt: at(t0, i),
      accuracyMeters: 8,
      speedMps: 8,
    }))
    await upload(sam.headers, [
      ...drive,
      {
        ...CLINIC,
        recordedAt: at(t0, 16),
        accuracyMeters: 10,
        speedMps: 0,
        activity: "still",
        source: "significant",
      },
      ...parked(CLINIC, t0, [40, 70]),
      { ...offset(HOME, 5, 5), recordedAt: at(t0, 95), accuracyMeters: 12, source: "significant" },
      {
        ...HOME,
        recordedAt: at(t0, 100),
        accuracyMeters: 9,
        activity: "still",
        source: "significant",
      },
      ...parked(HOME, t0, [130, 160]),
    ])

    await detectTripsForUser(getDb(), sam.user.id, new Date(t0 + 170 * 60_000))
    const trips = (await myTrips(sam.headers)).sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    )
    expect(trips).toHaveLength(2)
    expect(trips[0]).toMatchObject({ startPlaceName: null, endPlaceName: "Clinic" })
    expect(trips[1]).toMatchObject({ startPlaceName: "Clinic", endPlaceName: "Home" })
    expect(trips[1]!.startedAt).toBe(at(t0, 70))
  })

  it("allows the silence a parked phone keeps, up to three quarters of an hour", async () => {
    // Heard from at home, quiet for the half hour a parked phone keeps to
    // itself, then a short walk: the arrival lands forty minutes after the
    // last word from home.
    const sam = await registerUser(ctx.app)
    const circle = await createCircle(sam.headers)
    await createPlace(sam.headers, circle.id, { name: "Home", ...HOME, radiusMeters: 200 })
    await createPlace(sam.headers, circle.id, { name: "Clinic", ...CLINIC, radiusMeters: 120 })

    const t0 = Date.now() - 3 * 60 * 60_000
    await upload(sam.headers, [
      ...parked(HOME, t0, [0, 30]),
      { ...CLINIC, recordedAt: at(t0, 70), accuracyMeters: 12, source: "significant" },
      { ...offset(CLINIC, 5, 5), recordedAt: at(t0, 71), accuracyMeters: 12 },
      {
        ...CLINIC,
        recordedAt: at(t0, 76),
        accuracyMeters: 10,
        activity: "still",
        source: "significant",
      },
      ...parked(CLINIC, t0, [110]),
    ])

    await detectTripsForUser(getDb(), sam.user.id, new Date(t0 + 130 * 60_000))
    const trips = await myTrips(sam.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ startPlaceName: "Home", endPlaceName: "Clinic" })
    expect(trips[0]!.startedAt).toBe(at(t0, 30))
  })

  it("still refuses a wander inside one place, and a hop nobody could have made in the time", async () => {
    const sam = await registerUser(ctx.app)
    const circle = await createCircle(sam.headers)
    await createPlace(sam.headers, circle.id, { name: "Home", ...HOME, radiusMeters: 200 })
    await createPlace(sam.headers, circle.id, { name: "Clinic", ...CLINIC, radiusMeters: 120 })

    const t0 = Date.now() - 6 * 60 * 60_000
    await upload(sam.headers, [
      // Around the house all morning.
      ...parked(HOME, t0, [0, 30]),
      { ...offset(HOME, 40, 40), recordedAt: at(t0, 45), accuracyMeters: 15 },
      { ...offset(HOME, -30, 50), recordedAt: at(t0, 52), accuracyMeters: 15 },
      ...parked(HOME, t0, [80, 110]),
      // Then a silence far longer than any journey next door takes.
      {
        ...CLINIC,
        recordedAt: at(t0, 200),
        accuracyMeters: 12,
        activity: "still",
        source: "significant",
      },
      ...parked(CLINIC, t0, [230, 260]),
    ])

    await detectTripsForUser(getDb(), sam.user.id, new Date(t0 + 280 * 60_000))
    expect(await myTrips(sam.headers)).toHaveLength(0)
  })
})
