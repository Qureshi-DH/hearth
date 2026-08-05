import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Speed alerts end to end, with the speeds, accuracies and 30 second cadence a
 * real phone reports.
 */

// A stretch of the M4 east of Bristol, and the junction the drives leave from.
const MOTORWAY = { lat: 51.52, lon: -2.57 }
const OFFICE = { lat: 51.4771, lon: -2.4939 }

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

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

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

async function joinCircle(headers: Record<string, string>, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBeLessThan(300)
}

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number | null
    activity?: string
    source?: string
    batteryLevel?: number
    isCharging?: boolean
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

/** A second device on the same account: the tablet left on the kitchen table. */
async function signInDevice(email: string, deviceId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName: "Kitchen Tablet", platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
}

async function setCircleSettings(
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

async function feedItems(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
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

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ maxSpeedMps: number | null; distanceMeters: number }>
}

const speedAlerts = async (headers: Record<string, string>, circleId: string) =>
  (await feedItems(headers, circleId)).filter((item) => item.type === "speed_alert")

async function queuedPushes() {
  const rows = (await getDb().execute(
    sql`select user_id, title, body, data->>'type' as type from notification_outbox`,
  )) as unknown as Array<{ user_id: string; title: string; body: string; type: string }>
  return rows
}

/**
 * A drive down the motorway. Fixes 30 seconds apart, positions advanced by
 * exactly the distance the speed implies, so history, trips and the geofence
 * all see a coherent journey rather than a teleporting phone.
 */
function drive(options: {
  from: { lat: number; lon: number }
  startSecondsAgo: number
  count: number
  speedMps: number | null
  intervalSeconds?: number
  accuracyMeters?: number
  activity?: string
}) {
  const interval = options.intervalSeconds ?? 30
  let metres = 0
  return Array.from({ length: options.count }, (_, i) => {
    const point = northOf(options.from, metres)
    metres += (options.speedMps ?? 0) * interval
    return {
      ...point,
      recordedAt: iso(options.startSecondsAgo + i * interval),
      accuracyMeters: options.accuracyMeters ?? 8,
      speedMps: options.speedMps,
      ...(options.activity ? { activity: options.activity } : {}),
    }
  })
}

describe("speed alerts: the positives", () => {
  it("raises one alert for a genuine 140 km/h motorway stretch", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const circle = await createCircle(teen.headers)
    await joinCircle(parent.headers, circle.invite.code)
    await setCircleSettings(teen.headers, circle.id, { speedAlertKmh: 120 })

    // 38.9 m/s is 140 km/h. Eight fixes, four minutes of motorway.
    await uploadFixes(
      teen.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -8 * 30, count: 8, speedMps: 38.9 }),
    )

    const alerts = await speedAlerts(parent.headers, circle.id)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.payload.speedKmh).toBe(140)
    expect(alerts[0]!.payload.thresholdKmh).toBe(120)

    // The parent is pushed, the teen is not pushed about themselves.
    const pushes = (await queuedPushes()).filter((row) => row.type === "speed_alert")
    expect(pushes.map((row) => row.user_id)).toEqual([parent.user.id])
  })

  it("fires just over a threshold set only a little above town driving", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 50 })

    // 14.2 m/s is 51.1 km/h in a 30 mph limit.
    await uploadFixes(
      user.headers,
      drive({ from: OFFICE, startSecondsAgo: -6 * 30, count: 6, speedMps: 14.2 }),
    )

    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })

  it("stays quiet at 49.7 km/h under that same 50 km/h threshold", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 50 })

    // 13.8 m/s is 49.68 km/h: the daily commute, which must never alert.
    await uploadFixes(
      user.headers,
      drive({ from: OFFICE, startSecondsAgo: -20 * 30, count: 20, speedMps: 13.8 }),
    )

    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(0)
  })

  it("carries the run across two uploads of the same drive", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 110 })

    // The tracker uploading one fix at a time, as it does on a good connection.
    await uploadFixes(user.headers, [
      { ...MOTORWAY, recordedAt: iso(-60), accuracyMeters: 8, speedMps: 33.3 },
    ])
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(0)

    await uploadFixes(user.headers, [
      { ...northOf(MOTORWAY, 999), recordedAt: iso(-30), accuracyMeters: 8, speedMps: 33.3 },
    ])
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })
})

describe("speed alerts: things that must not alert", () => {
  it("ignores one 300 km/h GPS spike between two normal fixes", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // A steady 90 km/h A-road with one impossible sample from a provider
    // switch. 83.3 m/s is 300 km/h.
    const points = drive({ from: OFFICE, startSecondsAgo: -10 * 30, count: 10, speedMps: 25 })
    points[5]!.speedMps = 83.3

    await uploadFixes(user.headers, points)
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(0)
  })

  it("resets the run when one fix inside the batch drops under the threshold", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // Over, under, over: never two over-threshold fixes in a row.
    const speeds = [35, 25, 35, 25, 35, 25, 35]
    const points = drive({ from: MOTORWAY, startSecondsAgo: -7 * 30, count: 7, speedMps: 30 })
    points.forEach((point, i) => {
      point.speedMps = speeds[i]!
    })

    await uploadFixes(user.headers, points)
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(0)
  })

  it("resets the run across uploads when the driver slows for a roundabout", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    await uploadFixes(user.headers, [
      { ...MOTORWAY, recordedAt: iso(-180), accuracyMeters: 8, speedMps: 35 },
    ])
    await uploadFixes(user.headers, [
      { ...northOf(MOTORWAY, 1050), recordedAt: iso(-150), accuracyMeters: 8, speedMps: 9 },
    ])
    await uploadFixes(user.headers, [
      { ...northOf(MOTORWAY, 1320), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 35 },
    ])

    const [row] = (await getDb().execute(
      sql`select over_speed_count from user_presence where user_id = ${user.user.id}::uuid`,
    )) as unknown as Array<{ over_speed_count: number }>
    expect(row!.over_speed_count).toBe(1)
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(0)
  })

  it("raises one alert, not two, when the tracker retries the same batch", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    const points = drive({ from: MOTORWAY, startSecondsAgo: -6 * 30, count: 6, speedMps: 38.9 })
    await uploadFixes(user.headers, points)
    // The response was lost, so the client sends the identical batch again.
    await uploadFixes(user.headers, points)

    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })
})

describe("speed alerts: the consecutive-fix rule", () => {
  it("does not treat two fixes hours apart in one upload as consecutive", async () => {
    const user = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 100 })

    // A phone with no data all day. Its queue holds two lone samples: one as
    // GPS reacquired in the office car park this morning, one as it reacquired
    // on the way out this evening. Both are the 130 km/h artefact a cold fix
    // produces; the phone sat still in between and emitted nothing.
    await uploadFixes(user.headers, [
      { ...OFFICE, recordedAt: iso(-9 * 3600), accuracyMeters: 48, speedMps: 36.1 },
      { ...northOf(OFFICE, 30), recordedAt: iso(-90), accuracyMeters: 44, speedMps: 36.1 },
      { ...northOf(OFFICE, 65), recordedAt: iso(-60), accuracyMeters: 12, speedMps: 1.3 },
    ])

    const alerts = await speedAlerts(user.headers, circle.id)
    expect(alerts.map((alert) => alert.summary)).toEqual([])
  })

  it("keeps the run broken when the same two fixes arrive in separate uploads", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 100 })

    await uploadFixes(user.headers, [
      { ...OFFICE, recordedAt: iso(-9 * 3600), accuracyMeters: 48, speedMps: 36.1 },
    ])
    await uploadFixes(user.headers, [
      { ...northOf(OFFICE, 30), recordedAt: iso(-90), accuracyMeters: 44, speedMps: 36.1 },
    ])

    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(0)
  })

  it("still confirms a run when a fix in the middle carries no speed", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // iOS hands back speed -1 on a cell-derived fix and the tracker uploads it
    // as null. The car is still doing 140 km/h through all of them.
    const points = drive({ from: MOTORWAY, startSecondsAgo: -9 * 30, count: 9, speedMps: 38.9 })
    points.forEach((point, i) => {
      if (i % 2 === 1) point.speedMps = null
    })

    await uploadFixes(user.headers, points)
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })
})

describe("speed alerts: what the alert claims", () => {
  it("does not report a speed only one fix ever saw", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // A real 144 km/h motorway run carrying one impossible sample. The drive
    // ended seven minutes ago so the trip detector can close it too.
    const points = drive({ from: MOTORWAY, startSecondsAgo: -11 * 60, count: 8, speedMps: 40 })
    points[3]!.speedMps = 83.3
    await uploadFixes(user.headers, points)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [alert] = await speedAlerts(user.headers, circle.id)
    expect(alert).toBeDefined()
    // The trip card built from these very fixes says 144 km/h, because trips
    // take the fastest speed two consecutive fixes agree on. The alert must
    // not tell the family a number no second fix ever corroborated.
    const [trip] = await myTrips(user.headers)
    expect(trip!.maxSpeedMps).toBe(40)
    expect(alert!.payload.speedKmh).toBeLessThanOrEqual(145)
  })

  it("does not call a fix the phone labelled cycling driving", async () => {
    const user = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 50 })

    // 16.7 m/s is 60 km/h: a teenager on a bike down Park Street, tagged
    // cycling by the OS activity recogniser.
    await uploadFixes(
      user.headers,
      drive({
        from: OFFICE,
        startSecondsAgo: -5 * 30,
        count: 5,
        speedMps: 16.7,
        activity: "cycling",
      }),
    )

    const [alert] = await speedAlerts(user.headers, circle.id)
    expect(alert).toBeDefined()
    expect(alert!.summary).not.toMatch(/driving/i)
  })
})

describe("speed alerts: vehicles the server cannot tell apart", () => {
  it("alerts about a passenger the same as a driver", async () => {
    const passenger = await registerUser(ctx.app, { displayName: "Nan" })
    const circle = await createCircle(passenger.headers)
    await setCircleSettings(passenger.headers, circle.id, { speedAlertKmh: 120 })

    // Sitting in someone else's car at 130 km/h. The phone cannot know, and
    // neither can the server, so the alert fires. Recorded here so the
    // maintainer sees the wording claims driving about a passenger.
    await uploadFixes(
      passenger.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -6 * 30, count: 6, speedMps: 36.1 }),
    )

    const [alert] = await speedAlerts(passenger.headers, circle.id)
    expect(alert).toBeDefined()
    expect(alert!.summary).toContain("driving at 130 km/h")
  })

  it("alerts on a 160 km/h train the same as a car", async () => {
    const user = await registerUser(ctx.app, { displayName: "Ali" })
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // 44.4 m/s is 160 km/h: the Paddington train, not a car.
    await uploadFixes(
      user.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -8 * 30, count: 8, speedMps: 44.4 }),
    )

    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })
})

describe("speed alerts: per-circle thresholds", () => {
  it("tells only the circle whose threshold the drive actually crossed", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const roadtrip = await createCircle(user.headers, "Roadtrip")
    await setCircleSettings(user.headers, family.id, { speedAlertKmh: 90 })
    await setCircleSettings(user.headers, roadtrip.id, { speedAlertKmh: 130 })

    // 26.4 m/s is 95 km/h.
    await uploadFixes(
      user.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -6 * 30, count: 6, speedMps: 26.4 }),
    )

    expect(await speedAlerts(user.headers, family.id)).toHaveLength(1)
    expect(await speedAlerts(user.headers, roadtrip.id)).toHaveLength(0)
  })

  it("tells the second circle the first time its own threshold is crossed", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const roadtrip = await createCircle(user.headers, "Roadtrip")
    await setCircleSettings(user.headers, family.id, { speedAlertKmh: 90 })
    await setCircleSettings(user.headers, roadtrip.id, { speedAlertKmh: 130 })

    // 95 km/h on the ring road: only the stricter circle wants to hear it.
    await uploadFixes(user.headers, [
      { ...MOTORWAY, recordedAt: iso(-600), accuracyMeters: 8, speedMps: 26.4 },
      { ...northOf(MOTORWAY, 792), recordedAt: iso(-570), accuracyMeters: 8, speedMps: 26.4 },
    ])
    expect(await speedAlerts(user.headers, family.id)).toHaveLength(1)
    expect(await speedAlerts(user.headers, roadtrip.id)).toHaveLength(0)

    // Eight minutes and twelve kilometres later the same drive reaches
    // 145 km/h, which is the first thing that has ever crossed the second
    // circle's threshold. That circle has been told nothing so far, so it has
    // no cooldown to be inside.
    await uploadFixes(
      user.headers,
      drive({ from: northOf(MOTORWAY, 12_000), startSecondsAgo: -120, count: 4, speedMps: 40.3 }),
    )

    const heard = await speedAlerts(user.headers, roadtrip.id)
    expect(heard.map((alert) => alert.payload.speedKmh)).toEqual([145])
  })
})

describe("speed alerts: the cooldown", () => {
  it("raises one alert, not one per upload, across a long fast drive", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // Twelve minutes of motorway, uploaded in six batches as it happens.
    for (let batch = 0; batch < 6; batch += 1) {
      await uploadFixes(
        user.headers,
        drive({
          from: northOf(MOTORWAY, batch * 4668),
          startSecondsAgo: -720 + batch * 120,
          count: 4,
          speedMps: 38.9,
        }),
      )
    }

    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })

  it("alerts again once the cooldown has expired", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    await uploadFixes(
      user.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -8 * 30, count: 4, speedMps: 38.9 }),
    )
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)

    // Age the latch by 31 minutes rather than sleeping for them.
    await getDb().execute(
      sql`update user_presence set speed_alerted_at = now() - interval '31 minutes'
          where user_id = ${user.user.id}::uuid`,
    )

    await uploadFixes(
      user.headers,
      drive({ from: northOf(MOTORWAY, 5000), startSecondsAgo: -120, count: 4, speedMps: 38.9 }),
    )
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(2)
  })

  it("says nothing about a second drive that starts inside the cooldown", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // First drive, alerted.
    await uploadFixes(
      user.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -13 * 60, count: 4, speedMps: 38.9 }),
    )
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)

    // Parked for six minutes, engine off.
    await uploadFixes(user.headers, [
      { ...northOf(MOTORWAY, 4668), recordedAt: iso(-11 * 60), accuracyMeters: 12, speedMps: 0 },
      { ...northOf(MOTORWAY, 4668), recordedAt: iso(-8 * 60), accuracyMeters: 12, speedMps: 0 },
    ])

    // A separate journey at 150 km/h. The counter reset with the stop, so the
    // only thing holding this back is the 30 minute latch.
    await uploadFixes(
      user.headers,
      drive({ from: northOf(MOTORWAY, 4700), startSecondsAgo: -5 * 60, count: 6, speedMps: 41.7 }),
    )

    // The cooldown is per circle and per half hour, not per drive: a circle
    // already told about the first run hears nothing about the second.
    expect(await speedAlerts(user.headers, circle.id)).toHaveLength(1)
  })
})

describe("speed alerts: two devices on one account", () => {
  it("reports the drive even though the tablet reports between the phone's uploads", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Alice" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const circle = await createCircle(driver.headers)
    await joinCircle(parent.headers, circle.invite.code)
    await setCircleSettings(driver.headers, circle.id, { speedAlertKmh: 110 })
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    // The phone flushes each fix as its own request, as it does on a good
    // connection, and the tablet sits at home reporting a standstill in
    // between. 33.4-33.6 m/s is 120-121 km/h.
    const speeds = [33.4, 33.5, 33.6, 33.5]
    for (let i = 0; i < speeds.length; i += 1) {
      await uploadFixes(driver.headers, [
        {
          ...northOf(MOTORWAY, i * 1000),
          recordedAt: iso(-600 + i * 60),
          accuracyMeters: 8,
          speedMps: speeds[i]!,
        },
      ])
      await uploadFixes(tablet, [
        { ...OFFICE, recordedAt: iso(-585 + i * 60), accuracyMeters: 25, speedMps: 0 },
      ])
    }

    const heard = await speedAlerts(parent.headers, circle.id)
    expect(heard.map((alert) => alert.payload.speedKmh)).toEqual([121])
  })

  it("does not add one fix from each device up into a run", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Alice" })
    const circle = await createCircle(driver.headers)
    await setCircleSettings(driver.headers, circle.id, { speedAlertKmh: 110 })
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    // One fast fix from the phone and one from the tablet. Two devices are two
    // sets of eyes on different things, never two halves of one run.
    await uploadFixes(driver.headers, [
      { ...MOTORWAY, recordedAt: iso(-120), accuracyMeters: 8, speedMps: 33.4 },
    ])
    await uploadFixes(tablet, [
      { ...northOf(MOTORWAY, 1000), recordedAt: iso(-90), accuracyMeters: 8, speedMps: 33.5 },
    ])

    expect(await speedAlerts(driver.headers, circle.id)).toHaveLength(0)
  })
})

describe("speed alerts: sharing state", () => {
  it("never tells a circle the member shares approximately with", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Driver" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const neighbour = await registerUser(ctx.app, { displayName: "Neighbour" })

    const family = await createCircle(driver.headers, "Family")
    const street = await createCircle(driver.headers, "Street")
    await joinCircle(parent.headers, family.invite.code)
    await joinCircle(neighbour.headers, street.invite.code)
    await setCircleSettings(driver.headers, family.id, { speedAlertKmh: 120 })
    await setCircleSettings(driver.headers, street.id, { speedAlertKmh: 120 })

    const shared = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${street.id}/sharing`,
      headers: driver.headers,
      payload: { sharingState: "approximate" },
    })
    expect(shared.statusCode).toBe(200)

    await uploadFixes(
      driver.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -6 * 30, count: 6, speedMps: 38.9 }),
    )

    expect(await speedAlerts(parent.headers, family.id)).toHaveLength(1)
    expect(await speedAlerts(neighbour.headers, street.id)).toHaveLength(0)
    const pushed = (await queuedPushes()).filter((row) => row.type === "speed_alert")
    expect(pushed.map((row) => row.user_id)).toEqual([parent.user.id])
  })

  it("never tells a circle the member has paused", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Driver" })
    const family = await createCircle(driver.headers, "Family")
    await setCircleSettings(driver.headers, family.id, { speedAlertKmh: 120 })

    const paused = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${family.id}/sharing`,
      headers: driver.headers,
      payload: { sharingState: "paused" },
    })
    expect(paused.statusCode).toBe(200)

    await uploadFixes(
      driver.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -6 * 30, count: 6, speedMps: 38.9 }),
    )

    expect(await speedAlerts(driver.headers, family.id)).toHaveLength(0)
  })

  it("does not let an approximate circle's stricter threshold raise an alert anywhere", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Driver" })
    const family = await createCircle(driver.headers, "Family")
    const work = await createCircle(driver.headers, "Work")
    await setCircleSettings(driver.headers, family.id, { speedAlertKmh: 120 })
    await setCircleSettings(driver.headers, work.id, { speedAlertKmh: 60 })
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${work.id}/sharing`,
      headers: driver.headers,
      payload: { sharingState: "approximate" },
    })

    // 100 km/h: over the approximate circle's threshold, under the precise
    // one's. Nobody may hear anything.
    await uploadFixes(
      driver.headers,
      drive({ from: MOTORWAY, startSecondsAgo: -6 * 30, count: 6, speedMps: 27.8 }),
    )

    expect(await speedAlerts(driver.headers, family.id)).toHaveLength(0)
    expect(await speedAlerts(driver.headers, work.id)).toHaveLength(0)
  })
})

describe("speed alerts: late data", () => {
  it("records a fast stretch that arrives late without pushing about it", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const circle = await createCircle(teen.headers)
    await joinCircle(parent.headers, circle.invite.code)
    await setCircleSettings(teen.headers, circle.id, { speedAlertKmh: 120 })

    const destination = northOf(MOTORWAY, 20_000)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: teen.headers,
      payload: { name: "Gran's", icon: "home", ...destination, radiusMeters: 150 },
    })

    // No signal on the motorway. The queue drains once the phone is indoors,
    // and it holds a 150 km/h stretch that ended fifty minutes ago plus the
    // arrival that followed it.
    const backlog = [
      ...drive({ from: MOTORWAY, startSecondsAgo: -60 * 60, count: 10, speedMps: 41.7 }),
      { ...destination, recordedAt: iso(-50 * 60), accuracyMeters: 12, speedMps: 0 },
      { ...destination, recordedAt: iso(-49 * 60), accuracyMeters: 12, speedMps: 0 },
    ]
    await uploadFixes(teen.headers, backlog)

    const pushes = await queuedPushes()
    expect(pushes.map((row) => row.type)).not.toContain("speed_alert")

    // The arrival from the same batch is in the feed at the time it happened.
    const items = await feedItems(parent.headers, circle.id)
    expect(items.map((item) => item.type)).toContain("place_arrive")

    // The 150 km/h stretch happened too, and the family has no record of it.
    expect(items.map((item) => item.type)).toContain("speed_alert")
    const alert = items.find((item) => item.type === "speed_alert")
    expect(Date.now() - Date.parse(alert!.occurredAt)).toBeGreaterThan(30 * 60 * 1000)
  })
})
