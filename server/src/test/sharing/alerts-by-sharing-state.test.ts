import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Every alert the server raises, checked against the sharing state of the
 * circle it would go to.
 *
 * One member, two circles. Circle A is kept at arm's length ("approximate",
 * then "paused"). Circle B is her household and sees everything.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4636, lon: -2.5952 }

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

type Headers = Record<string, string>

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

async function createCircle(headers: Headers, name: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function joinCircle(headers: Headers, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function setCircleSettings(
  headers: Headers,
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

async function setSharing(
  headers: Headers,
  circleId: string,
  payload: { sharingState: string; pausedUntil?: string | null },
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { sharingState: string; pausedUntil: string | null }
}

async function addPlace(
  headers: Headers,
  circleId: string,
  name: string,
  point: { lat: number; lon: number },
  radiusMeters = 150,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { name, ...point, radiusMeters },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string }
}

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number
  batteryLevel?: number
  isCharging?: boolean
}

async function uploadFixes(headers: Headers, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number; placeEvents: number }
}

async function feedItems(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events?limit=200`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { items: unknown }).items as Array<{
    type: string
    summary: string
    occurredAt: string
    payload: Record<string, unknown>
  }>
}

const feedTypes = async (headers: Headers, circleId: string) =>
  (await feedItems(headers, circleId)).map((item) => item.type)

async function presenceFor(headers: Headers, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as Array<{
    userId: string
    lat: number | null
    lon: number | null
    accuracyMeters: number | null
    speedMps: number | null
    approximate: boolean
    sharingState: string
    atPlace: { name: string } | null
    sosAlertId: string | null
  }>
  return rows.find((row) => row.userId === userId)!
}

async function circleBadge(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/circles", headers })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as Array<{ id: string; unreadEventCount: number }>
  return rows.find((row) => row.id === circleId)!.unreadEventCount
}

async function pushesFor(userId: string, circleId: string) {
  return (await getDb().execute(
    sql`select title, body from notification_outbox
        where user_id = ${userId}::uuid and circle_id = ${circleId}::uuid
        order by id`,
  )) as unknown as Array<{ title: string; body: string }>
}

/**
 * Clears the read watermark, so the unread badge covers every event the viewer
 * is allowed to see and can be compared with the feed itself.
 */
async function neverOpenedTheFeed(userId: string) {
  await getDb().execute(
    sql`update circle_members set feed_read_at = null where user_id = ${userId}::uuid`,
  )
}

/** Fast-forwards a timed pause instead of waiting an hour for it to lapse. */
async function elapsePause(userId: string, circleId: string) {
  await getDb().execute(
    sql`update circle_members set paused_until = now() - interval '5 minutes'
        where user_id = ${userId}::uuid and circle_id = ${circleId}::uuid`,
  )
}

/**
 * Nobody joins a circle and drives off in the same second. History and trips
 * are both bounded by when the member joined, so a family that has been using
 * the app for a month has to be set up that way or every scenario reads as
 * "this happened before you joined".
 */
async function joinedAMonthAgo(userId: string) {
  await getDb().execute(
    // `joinedAt` is stored in the shared created_at column.
    sql`update circle_members set created_at = now() - interval '30 days'
        where user_id = ${userId}::uuid`,
  )
}

/**
 * The subject and two watchers. Alice is in both circles; Bob only sees
 * circle A, Carol only sees circle B, so nothing can reach a feed by accident.
 */
async function household() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const carol = await registerUser(ctx.app, { displayName: "Carol" })

  const arms = await createCircle(alice.headers, "Neighbours")
  const home = await createCircle(alice.headers, "Household")
  await joinCircle(bob.headers, arms.invite.code)
  await joinCircle(carol.headers, home.invite.code)

  return { alice, bob, carol, A: arms.id, B: home.id }
}

// ---------------------------------------------------------------------------
// The matrix: every alert type against approximate, paused and precise.
// ---------------------------------------------------------------------------

describe("place arrivals and departures", () => {
  it("names the place to the precise circle only, while approximate and while paused", async () => {
    const { alice, bob, carol, A, B } = await household()
    await addPlace(alice.headers, A, "Clinic", SCHOOL)
    await addPlace(alice.headers, B, "School", SCHOOL)

    await setSharing(alice.headers, A, { sharingState: "approximate" })

    // At home first, so the fence has a state to leave, then the school run.
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-600), accuracyMeters: 11 }])
    await uploadFixes(alice.headers, [{ ...SCHOOL, recordedAt: iso(-120), accuracyMeters: 9 }])

    expect(await feedTypes(bob.headers, A)).not.toContain("place_arrive")
    const arrivals = (await feedItems(carol.headers, B)).filter(
      (item) => item.type === "place_arrive",
    )
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]!.payload.placeName).toBe("School")

    // And no push carrying the name either.
    expect(await pushesFor(bob.user.id, A)).toHaveLength(0)
    expect((await pushesFor(carol.user.id, B)).map((row) => row.title)).toContain("School")

    // Now paused, and she leaves.
    await setSharing(alice.headers, A, { sharingState: "paused" })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-30), accuracyMeters: 10 }])

    expect(await feedTypes(bob.headers, A)).not.toContain("place_leave")
    expect(await feedTypes(carol.headers, B)).toContain("place_leave")
  })
})

describe("speed alerts", () => {
  it("reaches the precise circle and not the approximate one", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setCircleSettings(alice.headers, A, { speedAlertKmh: 110 })
    await setCircleSettings(alice.headers, B, { speedAlertKmh: 110 })
    await setSharing(alice.headers, A, { sharingState: "approximate" })

    // Three fixes 30 s apart on the M32 at 120 km/h.
    await uploadFixes(alice.headers, [
      { ...northOf(HOME, 0), recordedAt: iso(-150), accuracyMeters: 8, speedMps: 33.4 },
      { ...northOf(HOME, 1000), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 33.6 },
      { ...northOf(HOME, 2000), recordedAt: iso(-90), accuracyMeters: 8, speedMps: 33.1 },
    ])

    const alert = (await feedItems(carol.headers, B)).find((item) => item.type === "speed_alert")
    expect(alert).toBeDefined()
    expect(alert!.payload.speedKmh).toBe(121)
    expect(await feedTypes(bob.headers, A)).not.toContain("speed_alert")
    expect(await pushesFor(bob.user.id, A)).toHaveLength(0)
  })

  it("reaches the precise circle and not the paused one", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setCircleSettings(alice.headers, A, { speedAlertKmh: 110 })
    await setCircleSettings(alice.headers, B, { speedAlertKmh: 110 })
    await setSharing(alice.headers, A, { sharingState: "paused" })

    await uploadFixes(alice.headers, [
      { ...northOf(HOME, 0), recordedAt: iso(-150), accuracyMeters: 8, speedMps: 33.4 },
      { ...northOf(HOME, 1000), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 33.6 },
      { ...northOf(HOME, 2000), recordedAt: iso(-90), accuracyMeters: 8, speedMps: 33.1 },
    ])

    expect(await feedTypes(carol.headers, B)).toContain("speed_alert")
    expect(await feedTypes(bob.headers, A)).not.toContain("speed_alert")
  })
})

describe("possible incident", () => {
  it("reaches the precise circle and not the approximate or paused one", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setCircleSettings(alice.headers, A, { incidentDetection: true })
    await setCircleSettings(alice.headers, B, { incidentDetection: true })
    await setSharing(alice.headers, A, { sharingState: "approximate" })

    // 90 km/h on the ring road, then a stop that lasts four minutes.
    await uploadFixes(alice.headers, [
      { ...northOf(HOME, 0), recordedAt: iso(-290), accuracyMeters: 8, speedMps: 25 },
      { ...northOf(HOME, 750), recordedAt: iso(-260), accuracyMeters: 8, speedMps: 24.2 },
      { ...northOf(HOME, 900), recordedAt: iso(-230), accuracyMeters: 9, speedMps: 0.2 },
      { ...northOf(HOME, 900), recordedAt: iso(-120), accuracyMeters: 12, speedMps: 0 },
      { ...northOf(HOME, 902), recordedAt: iso(-30), accuracyMeters: 12, speedMps: 0 },
    ])

    expect(await feedTypes(carol.headers, B)).toContain("possible_incident")
    expect(await feedTypes(bob.headers, A)).not.toContain("possible_incident")
    expect(await pushesFor(bob.user.id, A)).toHaveLength(0)
  })
})

describe("low battery", () => {
  it("reaches an approximate circle, because a battery level is not a location", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setSharing(alice.headers, A, { sharingState: "approximate" })

    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 14, batteryLevel: 0.11, isCharging: false },
    ])

    expect(await feedTypes(bob.headers, A)).toContain("low_battery")
    expect(await feedTypes(carol.headers, B)).toContain("low_battery")
  })

  it("does not reach a paused circle", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setSharing(alice.headers, A, { sharingState: "paused" })

    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 14, batteryLevel: 0.11, isCharging: false },
    ])

    expect(await feedTypes(bob.headers, A)).not.toContain("low_battery")
    expect(await feedTypes(carol.headers, B)).toContain("low_battery")
  })
})

describe("device offline", () => {
  it("reaches an approximate circle but not a paused one", async () => {
    const { alice, bob, carol, A, B } = await household()
    const quiet = await createCircle(alice.headers, "Quiet")
    await setSharing(alice.headers, A, { sharingState: "approximate" })
    await setSharing(alice.headers, quiet.id, { sharingState: "paused" })

    // The last fix her phone managed before it died, 90 minutes ago.
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 16 }])
    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect(await feedTypes(bob.headers, A)).toContain("device_offline")
    expect(await feedTypes(carol.headers, B)).toContain("device_offline")
    expect(await feedTypes(alice.headers, quiet.id)).not.toContain("device_offline")
  })

  it("announces the phone coming back to the circles entitled to hear it", async () => {
    const { alice, carol, B } = await household()

    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 16 }])
    await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(await feedTypes(carol.headers, B)).toContain("device_offline")

    // Back in signal, uploading normally again.
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-30), accuracyMeters: 12 }])
    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect(await feedTypes(carol.headers, B)).toContain("device_online")
  })
})

describe("trip completed", () => {
  it("announces a finished drive to the circle she shares precisely with", async () => {
    const { alice, carol, B } = await household()

    // A twelve-minute drive that finished ten minutes ago, sampled every 30 s.
    const start = Date.now() - 22 * 60 * 1000
    await uploadFixes(
      alice.headers,
      Array.from({ length: 25 }, (_, i) => ({
        ...northOf(HOME, i * 200),
        recordedAt: new Date(start + i * 30 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 12,
      })),
    )

    const report = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(report.tripsDetected).toBe(1)

    expect(await feedTypes(carol.headers, B)).toContain("trip_completed")
  })

  it("does not name a place borrowed from a circle she does not share precisely with", async () => {
    const { alice, carol, A, B } = await household()
    await joinedAMonthAgo(alice.user.id)
    // A place that exists only in the circle she keeps at arm's length.
    await addPlace(alice.headers, A, "Recovery Clinic", HOME, 150)
    await setSharing(alice.headers, A, { sharingState: "approximate" })

    const start = Date.now() - 22 * 60 * 1000
    await uploadFixes(
      alice.headers,
      Array.from({ length: 25 }, (_, i) => ({
        ...northOf(HOME, i * 200),
        recordedAt: new Date(start + i * 30 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 12,
      })),
    )
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${B}/members/${alice.user.id}/trips`,
      headers: carol.headers,
    })
    expect(response.statusCode).toBe(200)
    const [trip] = response.json() as Array<{ startPlaceName: string | null }>
    expect(trip).toBeDefined()
    expect(trip!.startPlaceName).toBeNull()
  })
})

describe("SOS, check-ins and nudges", () => {
  it("an SOS reaches only the circle it was raised in, and lifts that circle's pause", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setSharing(alice.headers, A, { sharingState: "paused" })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-30), accuracyMeters: 10 }])

    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${A}/sos`,
      headers: alice.headers,
      payload: { note: "Car trouble on the A38." },
    })
    expect(sos.statusCode).toBe(201)

    expect(await feedTypes(bob.headers, A)).toContain("sos_started")
    expect(await feedTypes(carol.headers, B)).not.toContain("sos_started")

    // An SOS from someone whose location is paused would be useless, so the
    // route un-pauses that circle and only that circle.
    const seenByBob = await presenceFor(bob.headers, A, alice.user.id)
    expect(seenByBob.sharingState).toBe("precise")
    expect(seenByBob.lat).toBeCloseTo(HOME.lat, 5)

    const resolve = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${sos.json().id}/resolve`,
      headers: alice.headers,
    })
    expect(resolve.statusCode).toBe(200)
    expect(await feedTypes(bob.headers, A)).toContain("sos_resolved")
    expect(await feedTypes(carol.headers, B)).not.toContain("sos_resolved")
  })

  it("keeps an open SOS out of the map once she pauses again", async () => {
    const { alice, bob, A } = await household()
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-30), accuracyMeters: 10 }])
    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${A}/sos`,
      headers: alice.headers,
      payload: { note: null },
    })
    expect(sos.statusCode).toBe(201)

    // She pauses again while the alert is still open.
    await setSharing(alice.headers, A, { sharingState: "paused" })

    const seen = await presenceFor(bob.headers, A, alice.user.id)
    expect(seen.sharingState).toBe("paused")
    expect(seen.lat).toBeNull()

    // The SOS list must agree with the map about what the circle may see.
    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${A}/sos?activeOnly=true`,
      headers: bob.headers,
    })
    expect(list.statusCode).toBe(200)
    const [row] = list.json() as Array<{ lastLat: number | null; lastLon: number | null }>
    expect(row!.lastLat).toBeNull()
  })

  it("coarsens the SOS list the same way the map does once she goes approximate", async () => {
    const { alice, bob, A } = await household()
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-30), accuracyMeters: 10 }])
    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${A}/sos`,
      headers: alice.headers,
      payload: { note: null },
    })
    expect(sos.statusCode).toBe(201)

    await setSharing(alice.headers, A, { sharingState: "approximate" })

    const seen = await presenceFor(bob.headers, A, alice.user.id)
    expect(seen.approximate).toBe(true)
    expect(seen.lat).not.toBe(HOME.lat)

    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${A}/sos?activeOnly=true`,
      headers: bob.headers,
    })
    const [row] = list.json() as Array<{ lastLat: number | null }>
    expect(row!.lastLat).not.toBe(HOME.lat)
  })

  it("refuses a nudge to a paused member and allows one to an approximate member", async () => {
    const { alice, bob, A } = await household()

    await setSharing(alice.headers, A, { sharingState: "paused" })
    const blocked = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${A}/nudge/${alice.user.id}`,
      headers: bob.headers,
      payload: { quickKey: "where_are_you" },
    })
    expect(blocked.statusCode).toBe(403)

    await setSharing(alice.headers, A, { sharingState: "approximate" })
    const allowed = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${A}/nudge/${alice.user.id}`,
      headers: bob.headers,
      payload: { quickKey: "where_are_you" },
    })
    expect(allowed.statusCode).toBe(200)
  })

  it("keeps a check-in in the circle it was made in", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setSharing(alice.headers, A, { sharingState: "paused" })

    const checkIn = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${B}/check-in`,
      headers: alice.headers,
      payload: { lat: SCHOOL.lat, lon: SCHOOL.lon, note: "Here, all fine." },
    })
    expect(checkIn.statusCode).toBe(201)

    expect(await feedTypes(carol.headers, B)).toContain("check_in")
    expect(await feedTypes(bob.headers, A)).not.toContain("check_in")
    expect(await pushesFor(bob.user.id, A)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Transitions.
// ---------------------------------------------------------------------------

describe("transitions", () => {
  it("does not announce a fresh arrival when she resumes sharing without moving", async () => {
    const { alice, carol, B } = await household()
    await addPlace(alice.headers, B, "Home", HOME)

    // She gets home. That is the arrival the circle should hear about, and the
    // one push it should get.
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-600), accuracyMeters: 11 }])
    expect(
      (await feedItems(carol.headers, B)).filter((e) => e.type === "place_arrive"),
    ).toHaveLength(1)

    // She pauses for a few minutes. The phone keeps uploading; the circle just
    // is not told. Then she turns sharing back on, still sitting at home.
    await setSharing(alice.headers, B, { sharingState: "paused" })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-300), accuracyMeters: 12 }])
    await setSharing(alice.headers, B, { sharingState: "precise" })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 10 }])

    const items = await feedItems(carol.headers, B)
    expect(items.filter((e) => e.type === "place_leave")).toHaveLength(0)
    // She never left, so there is nothing to arrive at.
    const arrivals = items.filter((e) => e.type === "place_arrive").map((e) => e.summary)
    expect(arrivals).toHaveLength(1)
    // And no second push telling the family she has just got home.
    expect((await pushesFor(carol.user.id, B)).map((p) => p.body)).toHaveLength(1)
  })

  it("hides a trip in progress from a circle she pauses, and keeps it for the other", async () => {
    const { alice, bob, carol, A, B } = await household()
    await joinedAMonthAgo(alice.user.id)

    const start = Date.now() - 22 * 60 * 1000
    const drive = Array.from({ length: 25 }, (_, i) => ({
      ...northOf(HOME, i * 200),
      recordedAt: new Date(start + i * 30 * 1000).toISOString(),
      accuracyMeters: 8,
      speedMps: 12,
    }))
    // Half the drive, then she pauses mid-journey, then the rest.
    await uploadFixes(alice.headers, drive.slice(0, 12))
    await setSharing(alice.headers, A, { sharingState: "paused" })
    await uploadFixes(alice.headers, drive.slice(12))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const paused = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${A}/members/${alice.user.id}/trips`,
      headers: bob.headers,
    })
    expect(paused.statusCode).toBe(403)

    const precise = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${B}/members/${alice.user.id}/trips`,
      headers: carol.headers,
    })
    expect(precise.statusCode).toBe(200)
    expect((precise.json() as unknown[]).length).toBe(1)
  })

  it("tells a circle about the next speeding run even if it was paused for the last one", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setCircleSettings(alice.headers, A, { speedAlertKmh: 110 })
    await setCircleSettings(alice.headers, B, { speedAlertKmh: 110 })
    await setSharing(alice.headers, A, { sharingState: "paused" })

    // First run. Only the household hears it, which is correct.
    await uploadFixes(alice.headers, [
      { ...northOf(HOME, 0), recordedAt: iso(-660), accuracyMeters: 8, speedMps: 33.4 },
      { ...northOf(HOME, 1000), recordedAt: iso(-630), accuracyMeters: 8, speedMps: 33.6 },
      { ...northOf(HOME, 2000), recordedAt: iso(-600), accuracyMeters: 8, speedMps: 33.5 },
    ])
    expect(await feedTypes(carol.headers, B)).toContain("speed_alert")
    expect(await feedTypes(bob.headers, A)).not.toContain("speed_alert")

    // She turns sharing back on, then does it again a few minutes later.
    await setSharing(alice.headers, A, { sharingState: "precise" })
    await uploadFixes(alice.headers, [
      { ...northOf(HOME, 6000), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 34.5 },
      { ...northOf(HOME, 7000), recordedAt: iso(-90), accuracyMeters: 8, speedMps: 34.7 },
      { ...northOf(HOME, 8000), recordedAt: iso(-60), accuracyMeters: 8, speedMps: 34.2 },
    ])

    // She was sharing precisely with this circle for the whole second run, and
    // it has never been told anything at all about her driving. The cooldown
    // that silences it was claimed by an alert sent to a different circle,
    // during a stretch when this one was entitled to nothing.
    const armsLength = (await feedTypes(bob.headers, A)).filter((t) => t === "speed_alert")
    expect(armsLength).toHaveLength(1)
  })

  it("tells a circle the battery is low even if it was paused for the first warning", async () => {
    const { alice, bob, carol, A, B } = await household()
    await setSharing(alice.headers, A, { sharingState: "paused" })

    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-600), accuracyMeters: 14, batteryLevel: 0.13, isCharging: false },
    ])
    expect(await feedTypes(carol.headers, B)).toContain("low_battery")
    expect(await feedTypes(bob.headers, A)).not.toContain("low_battery")

    await setSharing(alice.headers, A, { sharingState: "precise" })
    await uploadFixes(alice.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 14, batteryLevel: 0.07, isCharging: false },
    ])

    // 7% is the first warning this circle is entitled to, and it is a worse
    // one than the 13% that spent the latch while it was still paused.
    expect(await feedTypes(bob.headers, A)).toContain("low_battery")
  })
})

// ---------------------------------------------------------------------------
// A timed pause lapsing.
// ---------------------------------------------------------------------------

describe("a timed pause lapsing", () => {
  it("restores approximate on the map, not precise", async () => {
    const { alice, bob, A } = await household()
    await setSharing(alice.headers, A, { sharingState: "approximate" })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 12 }])

    // "Pause for an hour", and the hour passes.
    await setSharing(alice.headers, A, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, A)

    const seen = await presenceFor(bob.headers, A, alice.user.id)
    expect(seen).toMatchObject({ sharingState: "approximate", approximate: true })
    expect(seen.lat).not.toBe(HOME.lat)
  })

  it("restores approximate for the alerts too, so no place is named", async () => {
    const { alice, bob, A } = await household()
    await addPlace(alice.headers, A, "Clinic", SCHOOL)
    await setSharing(alice.headers, A, { sharingState: "approximate" })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-600), accuracyMeters: 12 }])

    await setSharing(alice.headers, A, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, A)

    await uploadFixes(alice.headers, [{ ...SCHOOL, recordedAt: iso(-30), accuracyMeters: 9 }])
    expect(await feedTypes(bob.headers, A)).not.toContain("place_arrive")
  })

  it("lets the circle nudge her again once the pause has lapsed", async () => {
    const { alice, bob, A } = await household()
    await setSharing(alice.headers, A, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, A)

    const nudge = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${A}/nudge/${alice.user.id}`,
      headers: bob.headers,
      payload: { quickKey: "where_are_you" },
    })
    expect(nudge.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// The badge over the feed, and the pause request itself.
// ---------------------------------------------------------------------------

describe("the circle list badge", () => {
  it("counts what the feed shows and nothing else", async () => {
    const { alice, bob, A } = await household()
    await addPlace(alice.headers, A, "Clinic", SCHOOL)

    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-600), accuracyMeters: 11 }])
    await uploadFixes(alice.headers, [{ ...SCHOOL, recordedAt: iso(-120), accuracyMeters: 9 }])
    await neverOpenedTheFeed(bob.user.id)

    // Nothing has been read, so the badge is the whole of the feed.
    const beforeItems = await feedItems(bob.headers, A)
    expect(beforeItems.map((item) => item.type)).toContain("place_arrive")
    expect(await circleBadge(bob.headers, A)).toBe(beforeItems.length)

    await setSharing(alice.headers, A, { sharingState: "paused" })

    // A number over an empty feed reports how often she has been arriving
    // somewhere, which is the thing pausing is meant to stop.
    const afterItems = await feedItems(bob.headers, A)
    expect(afterItems.map((item) => item.type)).not.toContain("place_arrive")
    expect(await circleBadge(bob.headers, A)).toBe(afterItems.length)
  })
})

describe("the pause request itself", () => {
  it("refuses an instant Postgres cannot store rather than failing on it", async () => {
    const { alice, A } = await household()

    const paused = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${A}/sharing`,
      headers: alice.headers,
      payload: { sharingState: "paused", pausedUntil: "0000-01-01T00:00:00Z" },
    })
    expect(paused.statusCode).toBe(400)

    const muted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${A}/notifications`,
      headers: alice.headers,
      payload: { mutedUntil: "0000-01-01T00:00:00Z" },
    })
    expect(muted.statusCode).toBe(400)
  })
})
