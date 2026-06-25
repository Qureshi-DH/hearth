import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { detectTripsForUser } from "../../services/trips"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A drive uploaded a day late still becomes a trip. The detector's scan floor
 * follows what has arrived, not a fixed distance behind the watermark.
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
}

const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000

/**
 * A steady drive: every step moves speed x interval metres along one bearing,
 * so the distance the server derives from the coordinates is the distance the
 * reported speeds imply.
 */
function drive(options: {
  from: LatLon
  startMs: number
  intervalSeconds: number
  count: number
  speedMps: number
  bearingDeg: number
  accuracyMeters?: number
}): Fix[] {
  const { from, startMs, intervalSeconds, count, speedMps, bearingDeg } = options
  const accuracyMeters = options.accuracyMeters ?? 8
  const step = speedMps * intervalSeconds
  const fixes: Fix[] = []
  for (let i = 0; i < count; i += 1) {
    const north = Math.cos((bearingDeg * Math.PI) / 180) * step * i
    const east = Math.sin((bearingDeg * Math.PI) / 180) * step * i
    fixes.push({
      lat: from.lat + north / M_PER_DEG_LAT,
      lon: from.lon + east / metresPerDegreeLon(from.lat),
      recordedAt: new Date(startMs + i * intervalSeconds * 1000).toISOString(),
      accuracyMeters,
      speedMps,
    })
  }
  return fixes
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
  pointCount: number
}

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  const trips = response.json() as TripDto[]
  return [...trips].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}

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

const sweep = () => runJobs(getDb(), getConfig(), ctx.app.log)

/** The tablet in the kitchen, reporting while the phone is out of signal. */
const tabletFixes = (): Fix[] => [
  { ...HOME, recordedAt: new Date(minutesAgo(90)).toISOString(), accuracyMeters: 30 },
  { ...HOME, recordedAt: new Date(minutesAgo(50)).toISOString(), accuracyMeters: 30 },
  { ...HOME, recordedAt: new Date(minutesAgo(10)).toISOString(), accuracyMeters: 30 },
]

/** A 20 minute drive: 41 fixes, 30 s apart, 18 m/s, 21.6 km. */
const theDrive = (startMinutesAgo: number) =>
  drive({
    from: HOME,
    startMs: minutesAgo(startMinutesAgo),
    intervalSeconds: 30,
    count: 41,
    speedMps: 18,
    bearingDeg: 200,
  })

describe("trips: a backlog uploaded a day late", () => {
  it("turns that same drive into one trip when it arrives live", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-live" })
    await createCircle(user.headers)

    const fixes = theDrive(45)
    expect(await uploadFixes(user.headers, fixes)).toBe(41)
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(41)
  })

  it("detects a three hour old backlog after the tablet moved the watermark", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-3h" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-3h")

    await uploadFixes(tablet, tabletFixes())
    await sweep()

    const fixes = theDrive(3 * 60)
    expect(await uploadFixes(user.headers, fixes)).toBe(41)
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(41)
  })

  it("detects a day old backlog after the tablet moved the watermark", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-26h" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-26h")

    // Yesterday's drive, recorded while the phone had no signal. The tablet at
    // home keeps reporting throughout, which is what moves the watermark.
    await uploadFixes(tablet, tabletFixes())
    await sweep()

    const fixes = theDrive(26 * 60)
    expect(await uploadFixes(user.headers, fixes)).toBe(41)
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(41)
  })

  it("detects a day old backlog when the phone's own live fixes moved the watermark", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-solo" })
    await createCircle(user.headers)

    // Back on Wi-Fi in the kitchen, the tracker reports the present straight
    // away while the OS has not yet let the background task drain the queue.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: new Date(minutesAgo(20)).toISOString(), accuracyMeters: 18 },
      { ...HOME, recordedAt: new Date(minutesAgo(13)).toISOString(), accuracyMeters: 22 },
      { ...HOME, recordedAt: new Date(minutesAgo(7)).toISOString(), accuracyMeters: 16 },
    ])
    await sweep()

    // Then the queue drains yesterday's drive. No second device involved.
    const fixes = theDrive(26 * 60)
    expect(await uploadFixes(user.headers, fixes)).toBe(41)
    await sweep()
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(41)
  })

  it("leaves the history alone when the scan floor is lowered over a filed drive", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-floor" })
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "tablet-floor")

    await uploadFixes(tablet, tabletFixes())
    await sweep()

    const fixes = theDrive(26 * 60)
    expect(await uploadFixes(user.headers, fixes)).toBe(41)
    await sweep()

    // The sweep reaches below the watermark on its own, so the drive is
    // already here.
    const found = await myTrips(user.headers)
    expect(found).toHaveLength(1)

    // Lowering the floor by hand puts those same 41 fixes back in front of the
    // detector. Every one of them belongs to a trip by now, so the second look
    // has to leave the history exactly as it is rather than file the drive a
    // second time.
    await getDb().execute(
      sql`update user_presence set trips_processed_until = ${new Date(
        Date.parse(fixes[0]!.recordedAt) - 1000,
      ).toISOString()}::timestamptz where user_id = ${user.user.id}`,
    )
    await detectTripsForUser(getDb(), user.user.id)

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.id).toBe(found[0]!.id)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(41)
  })
})
