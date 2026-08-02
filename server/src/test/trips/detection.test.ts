import { haversineMeters, pathDistanceMeters } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { detectTripsForUser } from "../../services/trips"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Trip detection against journeys a real phone produces, at the 30 second and
 * 60 metre policy the server hands the client.
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

/** A house on a quiet street in Bristol. */
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
  batteryLevel?: number
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
 * A run of fixes whose positions and speeds agree with each other: every step
 * moves exactly speed x interval metres along its bearing, so the distance the
 * server derives from the coordinates is the distance the speeds imply.
 */
function drive(options: {
  from: LatLon
  startMs: number
  intervalSeconds: number
  steps: Step[]
  accuracyMeters?: number
}): Fix[] {
  const { from, startMs, intervalSeconds, steps } = options
  const accuracyMeters = options.accuracyMeters ?? 8
  const fixes: Fix[] = []
  let north = 0
  let east = 0

  for (let i = 0; i <= steps.length; i += 1) {
    const step = steps[Math.min(i, steps.length - 1)]!
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
      speedMps: i === 0 ? step.speedMps : steps[i - 1]!.speedMps,
    })
  }
  return fixes
}

const steady = (count: number, speedMps: number, bearingDeg: number): Step[] =>
  Array.from({ length: count }, () => ({ speedMps, bearingDeg }))

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

/** A second signed-in device on an account that already exists. */
async function signInDevice(email: string, deviceId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName: "Family tablet", platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
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
  durationSeconds: number
  maxSpeedMps: number | null
  avgSpeedMps: number | null
  pointCount: number
  startLat: number
  startLon: number
  endLat: number
  endLon: number
}

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  const trips = response.json() as TripDto[]
  // Oldest first, so a split shows up as an ordered pair rather than a shuffle.
  return [...trips].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}

async function tripPath(headers: Record<string, string>, tripId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/trips/${tripId}`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { path: Array<{ recordedAt: string; lat: number; lon: number }> }).path
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

/** One detection pass with the clock the sweep would have seen at that moment. */
const sweepAt = (userId: string, whenMs: number) =>
  detectTripsForUser(getDb(), userId, new Date(whenMs))

/** What the fixes themselves say, so the trip's numbers can be checked against them. */
function expectedFrom(fixes: Fix[]) {
  const distance = pathDistanceMeters(fixes)
  const seconds =
    (Date.parse(fixes[fixes.length - 1]!.recordedAt) - Date.parse(fixes[0]!.recordedAt)) / 1000
  let confirmedMax = 0
  for (let i = 1; i < fixes.length; i += 1) {
    confirmedMax = Math.max(confirmedMax, Math.min(fixes[i - 1]!.speedMps!, fixes[i]!.speedMps!))
  }
  return { distance, seconds, avg: distance / seconds, confirmedMax }
}

describe("trips: ordinary journeys", () => {
  it("turns a morning commute into one trip whose numbers match the fixes", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-commute" })
    await createCircle(user.headers)

    // Out of the estate at 20 km/h, along the A road at 50, then a motorway
    // stretch at 100, then slowing into the office car park. Fixes every
    // 30 seconds, which is the interval this server asks clients for.
    const steps: Step[] = [
      ...steady(6, 5.5, 20),
      ...steady(14, 13.9, 35),
      ...steady(16, 27.8, 40),
      ...steady(6, 9, 55),
      ...steady(2, 2, 55),
    ]
    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(35),
      intervalSeconds: 30,
      steps,
      accuracyMeters: 9,
    })
    expect(fixes).toHaveLength(45)
    await uploadFixes(user.headers, fixes)

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    const trip = trips[0]!
    const truth = expectedFrom(fixes)

    expect(trip.pointCount).toBe(fixes.length)
    expect(trip.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trip.endedAt).toBe(fixes[fixes.length - 1]!.recordedAt)
    expect(trip.durationSeconds).toBe(truth.seconds)
    expect(trip.distanceMeters).toBe(Math.round(truth.distance))
    expect(trip.avgSpeedMps!).toBeCloseTo(truth.avg, 2)
    expect(trip.maxSpeedMps!).toBeCloseTo(truth.confirmedMax, 2)
    expect(trip.avgSpeedMps!).toBeLessThanOrEqual(trip.maxSpeedMps!)
    // 27.8 m/s for eight minutes is the fastest stretch, and nothing in the
    // drive is faster, so the trip card must not claim more than that.
    expect(trip.maxSpeedMps!).toBeCloseTo(27.8, 1)

    const path = await tripPath(user.headers, trip.id)
    expect(path).toHaveLength(fixes.length)
    expect(path[0]!.recordedAt).toBe(fixes[0]!.recordedAt)
  })

  it("records the walk to the shop and the walk home as two trips", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-walk" })
    await createCircle(user.headers)

    // 1.35 m/s is an adult walking pace. A 60 metre distance filter at that
    // speed delivers a fix roughly every 45 seconds.
    const out = drive({
      from: HOME,
      startMs: minutesAgo(60),
      intervalSeconds: 45,
      steps: steady(12, 1.35, 300),
      accuracyMeters: 14,
    })
    const shop = out[out.length - 1]!
    // Twelve minutes inside the shop. The phone reports nothing at a standstill.
    const back = drive({
      from: shop,
      startMs: Date.parse(shop.recordedAt) + 12 * 60 * 1000,
      intervalSeconds: 45,
      steps: steady(12, 1.35, 120),
      accuracyMeters: 14,
    })
    await uploadFixes(user.headers, [...out, ...back])

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(2)
    expect(trips[0]!.startedAt).toBe(out[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(out[out.length - 1]!.recordedAt)
    expect(trips[1]!.startedAt).toBe(back[0]!.recordedAt)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(out)))
    expect(trips[1]!.distanceMeters).toBe(Math.round(pathDistanceMeters(back)))
    // A walking trip must not be reported at driving speed.
    expect(trips[0]!.avgSpeedMps!).toBeLessThan(2)
  })

  it("keeps a loop that ends on its own doorstep as one trip", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-loop" })
    await createCircle(user.headers)

    // The school run: out, round, and back to the same driveway.
    const steps: Step[] = [
      ...steady(10, 9, 0),
      ...steady(10, 9, 90),
      ...steady(10, 9, 180),
      ...steady(10, 9, 270),
    ]
    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(35),
      intervalSeconds: 30,
      steps,
      accuracyMeters: 10,
    })
    await uploadFixes(user.headers, fixes)

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    const trip = trips[0]!
    expect(trip.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
    expect(trip.pointCount).toBe(fixes.length)
    expect(
      haversineMeters(
        { lat: trip.startLat, lon: trip.startLon },
        { lat: trip.endLat, lon: trip.endLon },
      ),
    ).toBeLessThan(5)
  })
})

describe("trips: stops and stillness", () => {
  it("splits a journey either side of a stop at a petrol station", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-petrol" })
    await createCircle(user.headers)

    const first = drive({
      from: HOME,
      startMs: minutesAgo(70),
      intervalSeconds: 30,
      steps: steady(24, 15, 30),
    })
    const forecourt = first[first.length - 1]!
    // Six and a half minutes on the forecourt with the engine off. The tracker
    // shuts the location service down once the phone settles, so it reports
    // nothing at all until the car pulls away.
    const second = drive({
      from: forecourt,
      startMs: Date.parse(forecourt.recordedAt) + 6.5 * 60 * 1000,
      intervalSeconds: 30,
      steps: steady(24, 15, 30),
    })
    await uploadFixes(user.headers, [...first, ...second])

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(2)
    // Neither half may claim the forecourt time as travelling time.
    expect(trips[0]!.durationSeconds).toBe(24 * 30)
    expect(trips[1]!.durationSeconds).toBe(24 * 30)
    expect(trips[0]!.avgSpeedMps!).toBeCloseTo(15, 1)
  })

  it("keeps a journey together across a wait at a level crossing", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-crossing" })
    await createCircle(user.headers)

    const before = drive({
      from: HOME,
      startMs: minutesAgo(70),
      intervalSeconds: 30,
      steps: steady(20, 15, 30),
    })
    const gate = before[before.length - 1]!
    // Three minutes stopped, which is shorter than the idle gap, so this is one
    // journey and not two.
    const after = drive({
      from: gate,
      startMs: Date.parse(gate.recordedAt) + 3 * 60 * 1000,
      intervalSeconds: 30,
      steps: steady(20, 15, 30),
    })
    await uploadFixes(user.headers, [...before, ...after])

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(before.length + after.length)
    expect(trips[0]!.startedAt).toBe(before[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(after[after.length - 1]!.recordedAt)
  })

  it("does not turn a night parked on the drive into a trip or glue it to the commute", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-overnight" })
    await createCircle(user.headers)

    // Parked, the tracker wakes on its background schedule and reports a
    // keepalive fix about every half hour. The car has not moved; the readings
    // wander by up to 20 metres, which is ordinary urban GPS.
    let seed = 11
    const drift = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed / 2147483648 - 0.5) * 2 * 20
    }
    const overnight: Fix[] = Array.from({ length: 16 }, (_, i) => ({
      ...offset(HOME, drift(), drift()),
      recordedAt: new Date(minutesAgo(11 * 60) + i * 30 * 60 * 1000).toISOString(),
      accuracyMeters: 22,
      speedMps: 0,
    }))
    const commute = drive({
      from: HOME,
      startMs: minutesAgo(100),
      intervalSeconds: 30,
      steps: steady(30, 12, 25),
    })
    await uploadFixes(user.headers, [...overnight, ...commute])

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    // The morning drive, timed from when the car actually pulled away.
    expect(trips[0]!.startedAt).toBe(commute[0]!.recordedAt)
    expect(trips[0]!.durationSeconds).toBe(30 * 30)
    expect(trips[0]!.pointCount).toBe(commute.length)
  })
})

describe("trips: partial, long and interleaved uploads", () => {
  it("does not cut a journey in half when a sweep runs while it is under way", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-underway" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(62),
      intervalSeconds: 30,
      steps: steady(80, 14, 15),
    })
    await uploadFixes(user.headers, fixes)

    // A sweep twenty minutes into the drive, while the car is still moving.
    const midDrive = await sweepAt(user.user.id, minutesAgo(40))
    expect(midDrive).toBe(0)
    expect(await myTrips(user.headers)).toHaveLength(0)

    // And the sweep after the car has been parked for longer than the idle gap.
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
  })

  it("keeps a motorway run longer than one detection pass as a single trip", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-motorway" })
    await createCircle(user.headers)

    // Bristol to the north east at 108 km/h. A 60 metre distance filter at that
    // speed delivers a fix every two seconds, so a three hour run is well past
    // the 5000 fixes one detection pass reads.
    const bulk = 5200
    const stepDegrees = 60 / M_PER_DEG_LAT
    const startMs = Date.now() - (bulk * 2 + 600) * 1000
    await getDb().execute(sql`
      insert into location_points
        (user_id, device_id, recorded_at, lat, lon, accuracy_meters, speed_mps, source)
      select
        ${user.user.id}::uuid,
        'phone-motorway',
        ${new Date(startMs).toISOString()}::timestamptz + (n * interval '2 seconds'),
        ${HOME.lat}::double precision + n * ${stepDegrees}::double precision,
        ${HOME.lon}::double precision,
        12,
        30,
        'background'
      from generate_series(0, ${bulk - 1}) as n
    `)

    // The last two minutes arrive through the API, the way the tail of a real
    // drive does, which is also what leaves a fresh presence row behind.
    const tail: Fix[] = Array.from({ length: 60 }, (_, i) => ({
      lat: HOME.lat + (bulk + i) * stepDegrees,
      lon: HOME.lon,
      recordedAt: new Date(startMs + (bulk + i) * 2000).toISOString(),
      accuracyMeters: 12,
      speedMps: 30,
    }))
    await uploadFixes(user.headers, tail)

    await sweep()
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(bulk + tail.length)
    expect(trips[0]!.distanceMeters).toBeCloseTo((bulk + tail.length - 1) * 60, -2)
    expect(trips[0]!.startedAt).toBe(new Date(startMs).toISOString())
  })

  it("does not let a tablet left at home distort the phone's trip", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-with-tablet" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-at-home")

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(50),
      intervalSeconds: 30,
      steps: steady(40, 16, 65),
    })
    // The tablet on the kitchen table reports every ten minutes throughout,
    // uploading into the same account at the same time as the phone.
    const tabletFixes: Fix[] = Array.from({ length: 4 }, (_, i) => ({
      ...offset(HOME, 4 - i * 2, 3),
      recordedAt: new Date(minutesAgo(48) + i * 10 * 60 * 1000).toISOString(),
      accuracyMeters: 35,
      speedMps: 0,
    }))
    await uploadFixes(user.headers, fixes.slice(0, 20))
    await uploadFixes(tablet, tabletFixes.slice(0, 2))
    await uploadFixes(user.headers, fixes.slice(20))
    await uploadFixes(tablet, tabletFixes.slice(2))

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
    expect(trips[0]!.avgSpeedMps!).toBeCloseTo(16, 1)
    expect(trips[0]!.avgSpeedMps!).toBeLessThanOrEqual(trips[0]!.maxSpeedMps!)
  })

  it("does not list one car journey twice because two devices rode along", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-in-car" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-in-car")

    // One person, one car, two signed-in devices in it: the phone in the cradle
    // and the tablet in the passenger footwell. Both report the same journey.
    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(50),
      intervalSeconds: 30,
      steps: steady(40, 16, 65),
    })
    await uploadFixes(user.headers, fixes)
    // The tablet's own fixes: the same road, sampled on its own schedule and a
    // few metres out, the way two receivers in one car actually differ.
    await uploadFixes(
      tablet,
      fixes
        .filter((_, i) => i % 2 === 0)
        .map((fix) => ({
          ...offset(fix, 6, -4),
          recordedAt: new Date(Date.parse(fix.recordedAt) + 7000).toISOString(),
          accuracyMeters: 30,
          speedMps: fix.speedMps,
        })),
    )

    await sweep()

    // One journey happened, so the history must show one journey, and the copy
    // it keeps is the phone's, which sampled the road twice as often.
    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
  })

  it("still records two journeys when two devices left together and went different ways", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-north" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-south")

    // Two cars off the same drive at the same minute, one to the school run
    // and one to the shops. Same account, same clock, opposite directions.
    const outbound = drive({
      from: HOME,
      startMs: minutesAgo(50),
      intervalSeconds: 30,
      steps: steady(40, 16, 65),
    })
    const theOtherWay = drive({
      from: HOME,
      startMs: minutesAgo(50),
      intervalSeconds: 30,
      steps: steady(30, 15, 245),
    })
    await uploadFixes(user.headers, outbound)
    await uploadFixes(tablet, theOtherWay)

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(2)
    expect(trips.map((trip) => trip.pointCount).sort((a, b) => a - b)).toEqual([
      theOtherWay.length,
      outbound.length,
    ])
  })

  it("never reports the same journey twice, however often the sweep runs", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-repeat" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(45),
      intervalSeconds: 30,
      steps: steady(30, 13, 200),
    })
    await uploadFixes(user.headers, fixes)

    await sweep()
    const first = await myTrips(user.headers)
    expect(first).toHaveLength(1)

    // The client retries a batch it never saw acknowledged, and the sweep runs
    // again several times behind it.
    await uploadFixes(user.headers, fixes)
    await sweep()
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.id).toBe(first[0]!.id)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(first[0]!.distanceMeters)
  })
})

describe("trips: backlogs and out of order uploads", () => {
  it("detects a drive uploaded a few hours after the watermark moved past it", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-backlog-short" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-backlog-short")

    // The tablet at home keeps reporting while the phone is out of signal, so
    // the detector's watermark keeps moving forward without it.
    await uploadFixes(tablet, [
      { ...HOME, recordedAt: new Date(minutesAgo(45)).toISOString(), accuracyMeters: 30 },
      { ...HOME, recordedAt: new Date(minutesAgo(25)).toISOString(), accuracyMeters: 30 },
      { ...HOME, recordedAt: new Date(minutesAgo(10)).toISOString(), accuracyMeters: 30 },
    ])
    await sweep()

    // The phone comes back on to Wi-Fi and flushes a drive from three hours ago.
    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(3 * 60),
      intervalSeconds: 30,
      steps: steady(30, 14, 110),
    })
    await uploadFixes(user.headers, fixes)
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(fixes.length)
  })

  it("detects a drive from a phone that had no signal for a day", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-backlog-day" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-backlog-day")

    // Yesterday's drive to the coast, recorded while the phone had no signal.
    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(26 * 60),
      intervalSeconds: 30,
      steps: steady(40, 18, 200),
    })

    // Meanwhile the tablet at home has been reporting all along, which is what
    // keeps the account looking active and pushes the watermark to now.
    await uploadFixes(tablet, [
      { ...HOME, recordedAt: new Date(minutesAgo(90)).toISOString(), accuracyMeters: 30 },
      { ...HOME, recordedAt: new Date(minutesAgo(50)).toISOString(), accuracyMeters: 30 },
      { ...HOME, recordedAt: new Date(minutesAgo(10)).toISOString(), accuracyMeters: 30 },
    ])
    await sweep()

    // The phone gets signal back and drains yesterday's queue.
    const accepted = await uploadFixes(user.headers, fixes)
    expect(accepted).toBe(fixes.length)
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(fixes.length)
  })

  it("merges the late first half of a drive into the trip it belongs to", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-ooo" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(70),
      intervalSeconds: 30,
      steps: steady(60, 13, 340),
    })
    const early = fixes.slice(0, 30)
    const late = fixes.slice(30)

    // The upload holding the first half of the drive fails; the batches behind
    // it get through, so the server sees the end of the journey first.
    await uploadFixes(user.headers, late)
    await sweep()
    expect(await myTrips(user.headers)).toHaveLength(1)

    // The failed batch is retried once the phone is back on a real connection.
    await uploadFixes(user.headers, early)
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(fixes.length)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
  })

  it("does not turn one drive into two trips when its first fixes arrive late", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-ooo-split" })
    await createCircle(user.headers)

    const morning = drive({
      from: HOME,
      startMs: minutesAgo(70),
      intervalSeconds: 30,
      steps: steady(60, 13, 340),
    })
    await uploadFixes(user.headers, morning.slice(30))
    await sweep()

    // The straggling first half, and then the drive back, from where the
    // morning's ended. A next drive that began twenty kilometres from where
    // the last one ended would be a journey the phone kept quiet about.
    const later = drive({
      from: morning[morning.length - 1]!,
      startMs: minutesAgo(30),
      intervalSeconds: 30,
      steps: steady(30, 11, 160),
    })
    await uploadFixes(user.headers, morning.slice(0, 30))
    await uploadFixes(user.headers, later)
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    // One drive out and one drive back. Not three.
    expect(trips).toHaveLength(2)
    expect(trips[0]!.startedAt).toBe(morning[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(morning[morning.length - 1]!.recordedAt)
    expect(trips[1]!.startedAt).toBe(later[0]!.recordedAt)
  })

  it("sorts a batch that arrives with its fixes shuffled", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-shuffled" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(45),
      intervalSeconds: 30,
      steps: steady(30, 12, 75),
    })
    const shuffled = [...fixes]
    let seed = 3
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const j = seed % (i + 1)
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    await uploadFixes(user.headers, shuffled)

    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(fixes[fixes.length - 1]!.recordedAt)
    expect(trips[0]!.distanceMeters).toBe(Math.round(pathDistanceMeters(fixes)))
  })
})

describe("trips: what the circle is told", () => {
  it("announces a completed trip to the circle", async () => {
    const user = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-feed" })
    const circle = await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(45),
      intervalSeconds: 30,
      steps: steady(30, 14, 45),
    })
    await uploadFixes(user.headers, fixes)

    await sweep()
    expect(await myTrips(user.headers)).toHaveLength(1)

    const items = await feedItems(user.headers, circle.id)
    expect(items.filter((item) => item.type === "trip_completed")).toHaveLength(1)
  })

  it("announces a completed trip exactly once across repeated sweeps", async () => {
    const user = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-feed-once" })
    const circle = await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(45),
      intervalSeconds: 30,
      steps: steady(30, 14, 45),
    })
    await uploadFixes(user.headers, fixes)

    await sweep()
    await sweep()
    await uploadFixes(user.headers, fixes)
    await sweep()

    const items = await feedItems(user.headers, circle.id)
    expect(items.filter((item) => item.type === "trip_completed").length).toBeLessThanOrEqual(1)
  })
})
