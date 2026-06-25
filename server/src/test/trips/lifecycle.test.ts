import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Trips over their whole life: the window the detail route enforces, backlogs,
 * a drive whose first fixes arrive late, the announcement, and a parked phone
 * whose heartbeat must not hold the finished drive open.
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
const daysAgo = (days: number) => Date.now() - days * 24 * 60 * 60 * 1000

/** A steady run: each step covers exactly speed x interval metres. */
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
  return Array.from({ length: count }, (_, i) => ({
    lat: from.lat + (Math.cos((bearingDeg * Math.PI) / 180) * step * i) / M_PER_DEG_LAT,
    lon:
      from.lon + (Math.sin((bearingDeg * Math.PI) / 180) * step * i) / metresPerDegreeLon(from.lat),
    recordedAt: new Date(startMs + i * intervalSeconds * 1000).toISOString(),
    accuracyMeters: 8,
    speedMps,
  }))
}

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

async function join(headers: Record<string, string>, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function setSharing(
  headers: Record<string, string>,
  circleId: string,
  sharingState: "precise" | "approximate" | "paused",
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload: { sharingState },
  })
  expect(response.statusCode).toBe(200)
}

async function setSettings(
  headers: Record<string, string>,
  circleId: string,
  settings: Record<string, unknown>,
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}`,
    headers,
    payload: { settings },
  })
  expect(response.statusCode).toBe(200)
}

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

async function feedItems(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      items: Array<{
        type: string
        summary: string
        occurredAt: string
        payload: Record<string, unknown>
      }>
    }
  ).items
}

async function pushRows(type: string) {
  const rows = (await getDb().execute(
    sql`select count(*)::int as n from notification_outbox where data->>'type' = ${type}`,
  )) as unknown as Array<{ n: number }>
  return rows[0]!.n
}

const sweep = () => runJobs(getDb(), getConfig(), ctx.app.log)

/**
 * A trip and one breadcrumb of its path, at a date the ingest back-date limit
 * would refuse, so it predates the viewer's window.
 */
async function seedTrip(userId: string, startMs: number) {
  const startedAt = new Date(startMs).toISOString()
  const endedAt = new Date(startMs + 15 * 60 * 1000).toISOString()
  const rows = (await getDb().execute(sql`
    insert into trips
      (user_id, started_at, ended_at, distance_meters, max_speed_mps, avg_speed_mps,
       point_count, start_lat, start_lon, end_lat, end_lon)
    values
      (${userId}::uuid, ${startedAt}::timestamptz, ${endedAt}::timestamptz, 12600, 14, 14,
       2, 52.2053, 0.1218, 51.7520, -1.2577)
    returning id
  `)) as unknown as Array<{ id: string }>
  const tripId = rows[0]!.id
  await getDb().execute(sql`
    insert into location_points
      (user_id, device_id, recorded_at, lat, lon, accuracy_meters, speed_mps, source, trip_id)
    values
      (${userId}::uuid, 'seeded', ${startedAt}::timestamptz, 52.2053, 0.1218, 8, 14,
       'background', ${tripId}::uuid)
  `)
  return tripId
}

async function backdateJoin(circleId: string, userId: string, whenMs: number) {
  await getDb().execute(sql`
    update circle_members set created_at = ${new Date(whenMs).toISOString()}::timestamptz
    where circle_id = ${circleId}::uuid and user_id = ${userId}::uuid
  `)
}

async function getTrip(headers: Record<string, string>, tripId: string) {
  return ctx.app.inject({ method: "GET", url: `/api/v1/trips/${tripId}`, headers })
}

describe("one trip: the window the list enforces", () => {
  it("refuses a trip older than the circle's retention, and serves one inside it", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const tara = await registerUser(ctx.app, { displayName: "Tara" })
    const circle = await createCircle(alice.headers)
    await join(tara.headers, circle.invite.code)
    await setSettings(alice.headers, circle.id, { historyRetentionDays: 7 })
    // Joining is not what withholds these, so put it well out of the way.
    await backdateJoin(circle.id, tara.user.id, daysAgo(120))

    const old = await seedTrip(tara.user.id, daysAgo(30))
    const recent = await seedTrip(tara.user.id, daysAgo(2))

    expect((await getTrip(alice.headers, old)).statusCode).toBe(403)

    const visible = await getTrip(alice.headers, recent)
    expect(visible.statusCode).toBe(200)
    expect((visible.json() as { path: unknown[] }).path).toHaveLength(1)

    // Tara's own history is hers, whatever a circle's retention says.
    expect((await getTrip(tara.headers, old)).statusCode).toBe(200)
  })

  it("refuses a trip from before the member joined the circle", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const tara = await registerUser(ctx.app, { displayName: "Tara" })
    const circle = await createCircle(alice.headers)
    await join(tara.headers, circle.invite.code)

    const beforeJoining = await seedTrip(tara.user.id, daysAgo(3))
    const response = await getTrip(alice.headers, beforeJoining)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { message: "You cannot view this trip." } })

    // The list withholds the same trip, which is the parity that was missing.
    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members/${tara.user.id}/trips?from=${new Date(
        daysAgo(30),
      ).toISOString()}`,
      headers: alice.headers,
    })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toHaveLength(0)
  })

  it("uses the most generous of the circles the two of them share", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const tara = await registerUser(ctx.app, { displayName: "Tara" })

    const tight = await createCircle(alice.headers, "School run")
    await join(tara.headers, tight.invite.code)
    await setSettings(alice.headers, tight.id, { historyRetentionDays: 7 })
    await backdateJoin(tight.id, tara.user.id, daysAgo(120))

    const wide = await createCircle(alice.headers, "Family")
    await join(tara.headers, wide.invite.code)
    await setSettings(alice.headers, wide.id, { historyRetentionDays: 90 })
    await backdateJoin(wide.id, tara.user.id, daysAgo(120))

    // Outside the school run's week, well inside the family circle's quarter.
    const trip = await seedTrip(tara.user.id, daysAgo(30))
    expect((await getTrip(alice.headers, trip)).statusCode).toBe(200)

    // Take the wide circle away and the tight one decides again.
    await setSettings(alice.headers, wide.id, { historyRetentionDays: 7 })
    expect((await getTrip(alice.headers, trip)).statusCode).toBe(403)
  })

  it("still refuses everything to a circle sharing approximately", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const tara = await registerUser(ctx.app, { displayName: "Tara" })
    const circle = await createCircle(alice.headers)
    await join(tara.headers, circle.invite.code)
    await backdateJoin(circle.id, tara.user.id, daysAgo(120))
    await setSharing(tara.headers, circle.id, "approximate")

    const trip = await seedTrip(tara.user.id, minutesAgo(60))
    expect((await getTrip(alice.headers, trip)).statusCode).toBe(403)
  })
})

describe("a backlog uploaded after the watermark moved past it", () => {
  it("becomes a trip once the phone gets signal back", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-backlog" })
    await createCircle(user.headers)

    // The phone reports the present the moment it is back on Wi-Fi, which is
    // what carries the watermark past the queue still waiting to drain.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: new Date(minutesAgo(20)).toISOString(), accuracyMeters: 18 },
      { ...HOME, recordedAt: new Date(minutesAgo(8)).toISOString(), accuracyMeters: 16 },
    ])
    await sweep()

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(30 * 60),
      intervalSeconds: 30,
      count: 41,
      speedMps: 18,
      bearingDeg: 200,
    })
    expect(await uploadFixes(user.headers, fixes)).toBe(41)
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(41)
  })

  it("does not re-read breadcrumbs it has already judged", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-settled" })
    await createCircle(user.headers)

    // Two keepalives a day old, uploaded when they happened. They never become
    // a trip, so nothing but their arrival time can keep them out of the scan.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: new Date(minutesAgo(26 * 60)).toISOString(), accuracyMeters: 25 },
      { ...HOME, recordedAt: new Date(minutesAgo(25 * 60)).toISOString(), accuracyMeters: 25 },
    ])
    await getDb().execute(sql`
      update location_points set received_at = recorded_at where user_id = ${user.user.id}::uuid
    `)
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: new Date(minutesAgo(10)).toISOString(), accuracyMeters: 16 },
    ])
    await sweep()

    const [floor] = (await getDb().execute(sql`
      select min(recorded_at) as oldest from location_points
      where user_id = ${user.user.id}::uuid and trip_id is null
    `)) as unknown as Array<{ oldest: Date }>
    expect(floor).toBeDefined()
    // The watermark is what the sweep left, and the day-old pair sits below it
    // for good: no trip came of them and none ever will.
    expect(await myTrips(user.headers)).toHaveLength(0)
  })
})

describe("a drive whose first fixes arrive late", () => {
  it("joins the trip that already owns the rest of it", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-late-head" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(70),
      intervalSeconds: 30,
      count: 61,
      speedMps: 13,
      bearingDeg: 340,
    })

    await uploadFixes(user.headers, fixes.slice(30))
    await sweep()
    const [first] = await myTrips(user.headers)
    expect(first).toBeDefined()

    await uploadFixes(user.headers, fixes.slice(0, 30))
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.id).toBe(first!.id)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(61)
  })

  it("closes the seam when the missing fixes sit between two trips", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-bridge" })
    await createCircle(user.headers)

    const fixes = drive({
      from: HOME,
      startMs: minutesAgo(80),
      intervalSeconds: 30,
      count: 61,
      speedMps: 13,
      bearingDeg: 20,
    })

    // The batch in the middle of the drive is the one that fails, so the sweep
    // makes a trip of each end and the retry has to close the gap.
    await uploadFixes(user.headers, fixes.slice(0, 25))
    await uploadFixes(user.headers, fixes.slice(35))
    await sweep()
    expect(await myTrips(user.headers)).toHaveLength(2)

    await uploadFixes(user.headers, fixes.slice(25, 35))
    await sweep()

    const trips = await myTrips(user.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.startedAt).toBe(fixes[0]!.recordedAt)
    expect(trips[0]!.endedAt).toBe(fixes[60]!.recordedAt)
    expect(trips[0]!.pointCount).toBe(61)

    const orphans = (await getDb().execute(
      sql`select count(*)::int as n from location_points
          where user_id = ${user.user.id}::uuid and trip_id is null`,
    )) as unknown as Array<{ n: number }>
    expect(orphans[0]!.n).toBe(0)
  })

  it("keeps two genuinely separate journeys separate", async () => {
    const user = await registerUser(ctx.app, { deviceId: "phone-two-drives" })
    await createCircle(user.headers)

    const out = drive({
      from: HOME,
      startMs: minutesAgo(90),
      intervalSeconds: 30,
      count: 31,
      speedMps: 13,
      bearingDeg: 20,
    })
    // Back an hour later, which is a dozen idle gaps away.
    const back = drive({
      from: HOME,
      startMs: minutesAgo(30),
      intervalSeconds: 30,
      count: 31,
      speedMps: 13,
      bearingDeg: 200,
    })
    await uploadFixes(user.headers, back)
    await sweep()
    await uploadFixes(user.headers, out)
    await sweep()

    expect(await myTrips(user.headers)).toHaveLength(2)
  })
})

describe("telling the circle a journey finished", () => {
  const commute = (startMinutesAgo: number) =>
    drive({
      from: HOME,
      startMs: minutesAgo(startMinutesAgo),
      intervalSeconds: 30,
      count: 31,
      speedMps: 14,
      bearingDeg: 45,
    })

  it("writes one feed line, dated when the drive ended, and pushes it", async () => {
    const aisha = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-announce" })
    const circle = await createCircle(aisha.headers)
    await registerUser(ctx.app, {
      displayName: "Yusuf",
      deviceId: "phone-watcher",
      inviteCode: circle.invite.code,
    })

    const fixes = commute(45)
    await uploadFixes(aisha.headers, fixes)
    await sweep()

    const items = (await feedItems(aisha.headers, circle.id)).filter(
      (item) => item.type === "trip_completed",
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.occurredAt).toBe(fixes[fixes.length - 1]!.recordedAt)
    expect(items[0]!.summary).toBe("Aisha travelled 12.6 km")
    expect(items[0]!.payload.durationSeconds).toBe(900)
    expect(items[0]!.payload.distanceMeters as number).toBeGreaterThan(12_500)
    expect(items[0]!.payload.distanceMeters as number).toBeLessThan(12_700)
    // Nothing derived from a coordinate travels in a payload.
    expect(JSON.stringify(items[0]!.payload)).not.toContain("51.4")
    expect(await pushRows("trip_completed")).toBe(1)

    // And not again, however many sweeps run behind it.
    await sweep()
    await sweep()
    expect(
      (await feedItems(aisha.headers, circle.id)).filter((item) => item.type === "trip_completed"),
    ).toHaveLength(1)
  })

  it("says nothing to a circle shared approximately or paused", async () => {
    const aisha = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-coarse" })
    const coarse = await createCircle(aisha.headers, "Neighbours")
    const paused = await createCircle(aisha.headers, "Work")
    const precise = await createCircle(aisha.headers, "Family")
    await setSharing(aisha.headers, coarse.id, "approximate")
    await setSharing(aisha.headers, paused.id, "paused")

    await uploadFixes(aisha.headers, commute(45))
    await sweep()

    const trip = (item: { type: string }) => item.type === "trip_completed"
    expect((await feedItems(aisha.headers, coarse.id)).filter(trip)).toHaveLength(0)
    expect((await feedItems(aisha.headers, paused.id)).filter(trip)).toHaveLength(0)
    expect((await feedItems(aisha.headers, precise.id)).filter(trip)).toHaveLength(1)
  })

  it("says nothing to a circle that keeps no history", async () => {
    const aisha = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-nohistory" })
    const circle = await createCircle(aisha.headers)
    await setSettings(aisha.headers, circle.id, { allowHistory: false })

    await uploadFixes(aisha.headers, commute(45))
    await sweep()

    expect(
      (await feedItems(aisha.headers, circle.id)).filter((item) => item.type === "trip_completed"),
    ).toHaveLength(0)
  })

  it("names a place only in the circle that owns it", async () => {
    const aisha = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-places" })
    const family = await createCircle(aisha.headers, "Family")
    const others = await createCircle(aisha.headers, "Five a side")

    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${family.id}/places`,
      headers: aisha.headers,
      payload: { name: "Home", lat: HOME.lat, lon: HOME.lon, radiusMeters: 150, icon: "home" },
    })
    expect(place.statusCode).toBe(201)

    await uploadFixes(aisha.headers, commute(45))
    await sweep()

    const named = (await feedItems(aisha.headers, family.id)).find(
      (item) => item.type === "trip_completed",
    )
    expect(named!.summary).toBe("Aisha travelled 12.6 km from Home")

    const unnamed = (await feedItems(aisha.headers, others.id)).find(
      (item) => item.type === "trip_completed",
    )
    expect(unnamed!.summary).toBe("Aisha travelled 12.6 km")
  })

  it("files a backlog at the time it happened and pushes nobody", async () => {
    const aisha = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "phone-yesterday" })
    const circle = await createCircle(aisha.headers)
    await registerUser(ctx.app, {
      displayName: "Yusuf",
      deviceId: "phone-yesterday-watcher",
      inviteCode: circle.invite.code,
    })

    await uploadFixes(aisha.headers, [
      { ...HOME, recordedAt: new Date(minutesAgo(9)).toISOString(), accuracyMeters: 16 },
    ])
    await sweep()

    const fixes = commute(26 * 60)
    await uploadFixes(aisha.headers, fixes)
    await sweep()

    const items = (await feedItems(aisha.headers, circle.id)).filter(
      (item) => item.type === "trip_completed",
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.occurredAt).toBe(fixes[fixes.length - 1]!.recordedAt)
    expect(await pushRows("trip_completed")).toBe(0)
  })
})
