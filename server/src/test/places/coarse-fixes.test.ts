import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A parked Android phone on its resting request is answered from Wi-Fi when
 * it can and from the cell network when it can't, which on some nights is
 * for hours. A cell estimate carries a round 200 m of doubt and can sit a
 * few hundred metres from the house, on the same spot every time. Replayed
 * here from a real week: the phone never left, and the family was told it
 * went to the grandmother's up the road and back, twice in one night.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180
const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})
const GRANDMA = northOf(HOME, -330)

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

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters: number
  activity?: string
}

async function familyWithPlaces() {
  const user = await registerUser(ctx.app, { displayName: "Sabeen" })
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: user.headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(created.statusCode).toBe(201)
  const circle = created.json() as { id: string }
  for (const place of [
    { name: "Home", ...HOME, radiusMeters: 150 },
    { name: "Grandma's", ...GRANDMA, radiusMeters: 100 },
  ]) {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: place,
    })
    expect(response.statusCode).toBe(201)
  }
  return { user, circle }
}

/** One request per fix, which is how a parked phone reports. */
async function upload(headers: Record<string, string>, fixes: Fix[]) {
  for (const fix of fixes) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers,
      payload: { points: [fix] },
    })
    expect(response.statusCode).toBe(200)
  }
}

async function whatTheFamilyHeard(headers: Record<string, string>, circleId: string) {
  await runJobs(getDb(), getConfig(), ctx.app.log)
  const feed = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  const trips = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  return {
    types: (feed.json() as { items: Array<{ type: string }> }).items.map((item) => item.type),
    trips: trips.json() as unknown[],
  }
}

const at = (start: number, minutes: number) => new Date(start + minutes * 60_000).toISOString()
const home = (start: number, minutes: number, accuracyMeters: number): Fix => ({
  ...HOME,
  recordedAt: at(start, minutes),
  accuracyMeters,
  activity: "still",
})

/** Her night: two good fixes at home, five hours of one cell estimate, home again. */
function theNight(start: number): Fix[] {
  const cell = northOf(HOME, -306)
  const night: Fix[] = [home(start, 0, 12), home(start, 5, 100)]
  for (let step = 0; step < 18; step += 1) {
    night.push({
      ...cell,
      recordedAt: at(start, 11 + step * 17),
      accuracyMeters: 200,
      activity: "still",
    })
  }
  night.push(home(start, 11 + 18 * 17, 30))
  return night
}

/** A few minutes at home with one estimate 446 m out in the middle of them. */
function oneStray(start: number): Fix[] {
  const stray = northOf(HOME, 446)
  return [
    home(start, 0, 12),
    home(start, 1, 12),
    { ...stray, recordedAt: at(start, 2.6), accuracyMeters: 200, activity: "still" },
    home(start, 4, 13),
    { ...HOME, recordedAt: at(start, 6.7), accuracyMeters: 12, activity: "walking" },
    home(start, 9.3, 57),
  ]
}

describe("rough network fixes", () => {
  it("do not take somebody out of the house on a night of cell estimates", async () => {
    const { user, circle } = await familyWithPlaces()
    await upload(user.headers, theNight(Date.now() - 8 * 60 * 60_000))
    const heard = await whatTheFamilyHeard(user.headers, circle.id)
    expect(heard.types).not.toContain("place_leave")
  })

  // Twice its own doubt away is further than an estimate strays, so a phone
  // that really left and is only heard from through estimates still leaves.
  it("still take somebody out of the house when they are clearly elsewhere", async () => {
    const { user, circle } = await familyWithPlaces()
    const start = Date.now() - 3 * 60 * 60_000
    const town = northOf(HOME, 5_000)
    await upload(user.headers, [
      home(start, 0, 12),
      home(start, 5, 100),
      { ...town, recordedAt: at(start, 40), accuracyMeters: 200, activity: "still" },
      { ...town, recordedAt: at(start, 57), accuracyMeters: 200, activity: "still" },
    ])
    const heard = await whatTheFamilyHeard(user.headers, circle.id)
    expect(heard.types).toContain("place_leave")
  })

  it("do not make trips out of a night of cell estimates", async () => {
    const { user, circle } = await familyWithPlaces()
    await upload(user.headers, theNight(Date.now() - 8 * 60 * 60_000))
    const heard = await whatTheFamilyHeard(user.headers, circle.id)
    expect(heard.trips).toHaveLength(0)
    expect(heard.types).not.toContain("trip_completed")
  })

  it("do not take somebody out of the house with one estimate between two good fixes", async () => {
    const { user, circle } = await familyWithPlaces()
    await upload(user.headers, oneStray(Date.now() - 2 * 60 * 60_000))
    const heard = await whatTheFamilyHeard(user.headers, circle.id)
    expect(heard.types).not.toContain("place_leave")
  })

  // Leaving them out of trips must not leave them standing in for the phone
  // still reporting: a finished drive with one estimate after it was held open
  // until the next sharp fix, which for a parked phone is the next morning.
  it("do not hold a finished drive open", async () => {
    const { user } = await familyWithPlaces()
    const start = Date.now() - 60 * 60_000
    const drive: Fix[] = Array.from({ length: 21 }, (_, step) => ({
      ...northOf(HOME, 400 + step * 90),
      recordedAt: at(start, step * 0.5),
      accuracyMeters: 8,
      activity: "driving",
    }))
    const parked = northOf(HOME, 400 + 20 * 90)
    drive.push({ ...parked, recordedAt: at(start, 13), accuracyMeters: 200, activity: "still" })
    await upload(user.headers, drive)

    await runJobs(getDb(), getConfig(), ctx.app.log)
    const trips = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/trips",
      headers: user.headers,
    })
    expect(trips.json() as unknown[]).toHaveLength(1)
  })

  it("do not make a trip out of one estimate between two good fixes", async () => {
    const { user, circle } = await familyWithPlaces()
    await upload(user.headers, oneStray(Date.now() - 2 * 60 * 60_000))
    const heard = await whatTheFamilyHeard(user.headers, circle.id)
    expect(heard.trips).toHaveLength(0)
    expect(heard.types).not.toContain("trip_completed")
  })
})
