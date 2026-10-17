import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { detectTripsForUser } from "../../services/trips"
import {
  clearOutbox,
  createCircle,
  createPlace,
  enablePush,
  joinCircle,
  registerUser,
  startTestApp,
  uploadFixes,
  type Fix,
  type TestContext,
} from "../helpers"

/**
 * A trip that ends at a named place is the arrival's news, and the arrival
 * already carries the journey, so the trip only goes to the feed. One that
 * ends anywhere else still tells the family the journey is over.
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

const HOME = { lat: 51.4545, lon: -2.5879 }
const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()
const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / M_PER_DEG_LAT,
  lon: point.lon,
})

/** North-east from Home at 50 km/h, a fix every 30 s, 4.2 km in five minutes. */
function drive(endedSecondsAgo: number): Fix[] {
  const step = 14 * 30
  const north = Math.cos(Math.PI / 4) * step
  const east = Math.sin(Math.PI / 4) * step
  return Array.from({ length: 11 }, (_, i) => ({
    lat: HOME.lat + (north * i) / M_PER_DEG_LAT,
    lon: HOME.lon + (east * i) / metresPerDegreeLon(HOME.lat),
    recordedAt: iso(-endedSecondsAgo - 300 + i * 30),
    accuracyMeters: 8,
    speedMps: 14,
  }))
}

async function family() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const teen = await registerUser(ctx.app, { displayName: "Teen" })
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, teen.headers, circle.invite.code)
  await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")
  await uploadFixes(ctx.app, teen.headers, [
    { ...HOME, recordedAt: iso(-60 * 60), accuracyMeters: 10 },
  ])
  return { parent, teen, circle }
}

async function tripFeed(circleId: string) {
  return (
    (await getDb().execute(
      sql`select summary from events where circle_id = ${circleId}::uuid and type = 'trip_completed'`,
    )) as unknown as Array<{ summary: string }>
  ).map((row) => row.summary)
}

async function queued(userId: string, type: string) {
  return (
    (await getDb().execute(sql`
      select body, group_line from notification_outbox
      where user_id = ${userId}::uuid and data->>'type' = ${type} order by id
    `)) as unknown as Array<{ body: string; group_line: string }>
  ).map((row) => [row.body, row.group_line])
}

describe("a trip that ends at a named place", () => {
  it("goes to the feed only, and the arrival carries the journey", async () => {
    const { parent, teen, circle } = await family()
    const route = drive(6 * 60)
    const end = route.at(-1)!
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Work",
      lat: end.lat,
      lon: end.lon,
    })
    await clearOutbox()

    await uploadFixes(ctx.app, teen.headers, route)
    expect(await detectTripsForUser(getDb(), teen.user.id)).toBe(1)

    expect(await tripFeed(circle.id)).toEqual(["Teen travelled 4.2 km from Home to Work"])
    expect(await queued(parent.user.id, "trip_completed")).toEqual([])
    expect(await queued(parent.user.id, "place_arrive")).toEqual([
      [
        "Teen arrived at Work, 4.2 km from Home in 5 min",
        "Arrived at Work, 4.2 km from Home in 5 min",
      ],
    ])
  })

  it("names the place the fence saw them arrive at, and none when it saw no arrival", async () => {
    const { parent, teen, circle } = await family()
    const route = drive(6 * 60)
    const end = route.at(-1)!
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    // The car stops 97 m from the middle of a 100 m place, with 8 m of doubt.
    // That is inside the circle on a map, and not yet inside by the fence's rule.
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "School",
      ...northOf(end, 97),
      radiusMeters: 100,
    })
    await clearOutbox()

    await uploadFixes(ctx.app, teen.headers, route)
    expect(await detectTripsForUser(getDb(), teen.user.id)).toBe(1)

    expect(await queued(parent.user.id, "place_arrive")).toEqual([])
    expect(await tripFeed(circle.id)).toEqual(["Teen travelled 4.2 km from Home"])
    expect(await queued(parent.user.id, "trip_completed")).toEqual([
      ["Teen stopped 4.2 km from Home", "Stopped 4.2 km from Home"],
    ])
  })

  it("agrees with the arrival about which of two overlapping places it was", async () => {
    const { parent, teen, circle } = await family()
    const route = drive(6 * 60)
    const end = route.at(-1)!
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Town",
      ...HOME,
      radiusMeters: 5000,
    })
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Work",
      lat: end.lat,
      lon: end.lon,
    })
    await clearOutbox()

    await uploadFixes(ctx.app, teen.headers, route)
    expect(await detectTripsForUser(getDb(), teen.user.id)).toBe(1)

    expect(await tripFeed(circle.id)).toEqual(["Teen travelled 4.2 km from Home to Work"])
  })
})

describe("a trip that ends nowhere the family named", () => {
  it("says where they stopped", async () => {
    const { parent, teen, circle } = await family()
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await clearOutbox()

    await uploadFixes(ctx.app, teen.headers, drive(6 * 60))
    expect(await detectTripsForUser(getDb(), teen.user.id)).toBe(1)

    expect(await queued(parent.user.id, "trip_completed")).toEqual([
      ["Teen stopped 4.2 km from Home", "Stopped 4.2 km from Home"],
    ])
  })

  it("is as late as an arrival may be and no later", async () => {
    const { parent, teen, circle } = await family()
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await clearOutbox()

    // Stopped forty minutes ago, and the phone has been sitting there since.
    const route = drive(40 * 60)
    const end = route.at(-1)!
    await uploadFixes(ctx.app, teen.headers, [
      ...route,
      { lat: end.lat, lon: end.lon, recordedAt: iso(-60), accuracyMeters: 8, speedMps: 0 },
    ])
    expect(await detectTripsForUser(getDb(), teen.user.id)).toBe(1)

    expect(await tripFeed(circle.id)).toEqual(["Teen travelled 4.2 km from Home"])
    expect(await queued(parent.user.id, "trip_completed")).toEqual([])
  })
})
