import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Edge cases for the driving alerts in services/locations.ts: an unknown speed,
 * a lone provider artefact, a second device, a run across a long gap, two
 * uploads racing for one latch, and a parked phone's heartbeat. Each sits
 * beside a positive case, so no fix can buy silence by never alerting.
 */

const MOTORWAY = { lat: 51.5017, lon: -2.558 }
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

const at = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number | null
  batteryLevel?: number
  isCharging?: boolean
  source?: string
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

async function joinCircle(headers: Record<string, string>, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
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

async function uploadFixes(headers: Record<string, string>, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number }
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
    payload: Record<string, unknown>
  }>
}

const eventsOfType = async (headers: Record<string, string>, circleId: string, type: string) =>
  (await feedItems(headers, circleId)).filter((item) => item.type === type)

async function pushesOfType(type: string) {
  return (await getDb().execute(
    sql`select user_id, body, channel, priority from notification_outbox
        where data->>'type' = ${type}`,
  )) as unknown as Array<{ user_id: string; body: string; channel: string; priority: string }>
}

/** A second device signed in to an account that already exists. */
async function signInDevice(email: string, deviceId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName: "Second Device", platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
}

async function drivingFamily() {
  const driver = await registerUser(ctx.app, { displayName: "Sam" })
  const circle = await createCircle(driver.headers, "Family")
  await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
  const watcher = await registerUser(ctx.app, { displayName: "Watcher" })
  await joinCircle(watcher.headers, circle.invite.code)
  return { driver, watcher, circle }
}

describe("a fix field too small for the column it lands in", () => {
  it("stores a subnormal reading as zero instead of failing the whole batch", async () => {
    const user = await registerUser(ctx.app)

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: {
        points: [
          { ...HOME, recordedAt: at(-120), accuracyMeters: 8, speedMps: 0 },
          {
            ...northOf(HOME, 40),
            recordedAt: at(-90),
            accuracyMeters: 5e-324,
            altitudeMeters: -5e-324,
            speedMps: 1e-300,
            headingDegrees: 5e-324,
            batteryLevel: 1e-300,
          },
          { ...northOf(HOME, 80), recordedAt: at(-60), accuracyMeters: 8, speedMps: 0 },
        ],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(3)

    const rows = (await getDb().execute(
      sql`select accuracy_meters, altitude_meters, speed_mps, heading_degrees, battery_level
          from location_points
          where user_id = ${user.user.id}::uuid
          order by recorded_at asc`,
    )) as unknown as Array<Record<string, number | null>>
    expect(rows[1]).toEqual({
      accuracy_meters: 0,
      altitude_meters: 0,
      speed_mps: 0,
      heading_degrees: 0,
      battery_level: 0,
    })
  })

  it("keeps a battery reading that sits exactly on a circle's threshold", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)
    await setCircleSettings(owner.headers, circle.id, { lowBatteryThreshold: 0.15 })

    await uploadFixes(owner.headers, [
      { ...HOME, recordedAt: at(-60), accuracyMeters: 8, batteryLevel: 0.15, isCharging: false },
    ])

    expect(await eventsOfType(owner.headers, circle.id, "low_battery")).toHaveLength(1)
  })
})

describe("speed alerts: what counts as one run", () => {
  it("does not join two lone samples nine hours apart into a run", async () => {
    const user = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 100 })

    // A phone with no data all day flushing its queue: one cold-start artefact
    // as the owner walked in this morning, one as they walked out tonight.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: at(-9 * 3600), accuracyMeters: 48, speedMps: 36.1 },
      { ...northOf(HOME, 30), recordedAt: at(-90), accuracyMeters: 44, speedMps: 36.1 },
      { ...northOf(HOME, 65), recordedAt: at(-60), accuracyMeters: 12, speedMps: 1.3 },
    ])

    expect(await eventsOfType(user.headers, circle.id, "speed_alert")).toEqual([])
  })

  it("reports the speed two fixes agreed on, not the spike between them", async () => {
    const user = await registerUser(ctx.app, { displayName: "Sam" })
    const family = await createCircle(user.headers, "Family")
    const roadtrip = await createCircle(user.headers, "Roadtrip")
    await setCircleSettings(user.headers, family.id, { speedAlertKmh: 120 })
    await setCircleSettings(user.headers, roadtrip.id, { speedAlertKmh: 160 })

    // A genuine 144 km/h run carrying one 300 km/h provider artefact.
    const speeds = [40, 40, 40, 83.3, 40, 40, 40, 40]
    await uploadFixes(
      user.headers,
      speeds.map((speedMps, i) => ({
        ...northOf(MOTORWAY, i * 1200),
        recordedAt: at(-8 * 30 + i * 30),
        accuracyMeters: 8,
        speedMps,
      })),
    )

    const [alert] = await eventsOfType(user.headers, family.id, "speed_alert")
    expect(alert!.payload.speedKmh).toBe(144)
    // 160 km/h was never reached by anything two fixes saw, so this circle,
    // which asked to hear about 160, hears nothing.
    expect(await eventsOfType(user.headers, roadtrip.id, "speed_alert")).toEqual([])
  })

  it("keeps a run together when the middle of it reports no speed at all", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 120 })

    // iOS hands back -1 on a cell-derived fix and the tracker uploads null.
    // The car is doing 140 km/h through all of them.
    await uploadFixes(
      user.headers,
      Array.from({ length: 6 }, (_, i) => ({
        ...northOf(MOTORWAY, i * 1167),
        recordedAt: at(-6 * 30 + i * 30),
        accuracyMeters: 8,
        speedMps: i % 2 === 1 ? null : 38.9,
      })),
    )

    expect(await eventsOfType(user.headers, circle.id, "speed_alert")).toHaveLength(1)
  })
})

describe("possible incident: the evidence has to be about this stop", () => {
  it("says nothing when the car is still moving with no speed to report", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // Into a 6 km tunnel at 99 km/h. GPS is gone, so the fused provider falls
    // back to cell: no speed, accuracy in kilometres, and coordinates that
    // keep advancing at 27 m/s.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-260), accuracyMeters: 7, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 820), recordedAt: at(-230), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 2450), recordedAt: at(-170), accuracyMeters: 1600, speedMps: null },
      { ...northOf(MOTORWAY, 4080), recordedAt: at(-110), accuracyMeters: 1500, speedMps: null },
      { ...northOf(MOTORWAY, 5700), recordedAt: at(-50), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 6510), recordedAt: at(-20), accuracyMeters: 1300, speedMps: null },
    ])

    expect(await eventsOfType(watcher.headers, circle.id, "possible_incident")).toEqual([])
    expect(await pushesOfType("possible_incident")).toEqual([])
  })

  it("says nothing about an arrival that a nudge answers three minutes later", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The last two minutes of a commute: 48 km/h on the through road, the turn,
    // a crawl onto the drive, engine off.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, -1200), recordedAt: at(-330), accuracyMeters: 8, speedMps: 13.4 },
      { ...northOf(HOME, -800), recordedAt: at(-300), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(HOME, -480), recordedAt: at(-270), accuracyMeters: 8, speedMps: 8.0 },
      { ...northOf(HOME, -260), recordedAt: at(-240), accuracyMeters: 9, speedMps: 3.5 },
      { ...northOf(HOME, -20), recordedAt: at(-210), accuracyMeters: 9, speedMps: 1.2 },
      { ...HOME, recordedAt: at(-195), accuracyMeters: 10, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...HOME, recordedAt: at(-20), accuracyMeters: 32, speedMps: 0, source: "nudge" },
    ])

    expect(await eventsOfType(watcher.headers, circle.id, "possible_incident")).toEqual([])
    expect(await pushesOfType("possible_incident")).toEqual([])
  })

  it("says nothing when one impossible sample lands on a phone that never moved", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // An hour on the drive. Every fix is the same spot give or take jitter,
    // except one sample where the provider switched and claimed 101 km/h.
    await uploadFixes(driver.headers, [
      { ...HOME, recordedAt: at(-900), accuracyMeters: 14, speedMps: 0 },
      { ...northOf(HOME, 4), recordedAt: at(-400), accuracyMeters: 16, speedMps: 0.1 },
      { ...northOf(HOME, -3), recordedAt: at(-300), accuracyMeters: 15, speedMps: 0 },
      { ...northOf(HOME, 8), recordedAt: at(-260), accuracyMeters: 22, speedMps: 28.0 },
      { ...northOf(HOME, 2), recordedAt: at(-230), accuracyMeters: 15, speedMps: 0 },
      { ...northOf(HOME, -5), recordedAt: at(-150), accuracyMeters: 15, speedMps: 0 },
      { ...northOf(HOME, 1), recordedAt: at(-60), accuracyMeters: 14, speedMps: 0 },
      { ...HOME, recordedAt: at(-20), accuracyMeters: 14, speedMps: 0 },
    ])

    expect(await eventsOfType(watcher.headers, circle.id, "possible_incident")).toEqual([])
  })

  it("does not let a tablet at home supply the stillness for a phone on the motorway", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-320), accuracyMeters: 6, speedMps: 29.0 },
      { ...northOf(MOTORWAY, 870), recordedAt: at(-290), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 1770), recordedAt: at(-260), accuracyMeters: 6, speedMps: 30.0 },
    ])

    // Somebody picks the tablet up in the kitchen, 8 km away. A Wi-Fi fix has
    // no speed sensor behind it, so it reports none.
    await uploadFixes(tablet, [
      { ...HOME, recordedAt: at(-200), accuracyMeters: 35, speedMps: 0 },
      { ...HOME, recordedAt: at(-20), accuracyMeters: 42, speedMps: null, source: "manual" },
    ])

    expect(await eventsOfType(watcher.headers, circle.id, "possible_incident")).toEqual([])
    expect(await pushesOfType("possible_incident")).toEqual([])
  })

  it("says nothing about an arrival the app then reports from on a timer", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 47 km/h up the road, the turn onto the drive, engine off. The distance
    // filter delivers nothing after the arrival fix, and before heartbeats
    // existed nothing else did either.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, -1100), recordedAt: at(-330), accuracyMeters: 8, speedMps: 13.0 },
      { ...northOf(HOME, -710), recordedAt: at(-300), accuracyMeters: 8, speedMps: 13.0 },
      { ...northOf(HOME, -320), recordedAt: at(-270), accuracyMeters: 8, speedMps: 13.0 },
      { ...northOf(HOME, -60), recordedAt: at(-255), accuracyMeters: 9, speedMps: 3.0 },
      { ...HOME, recordedAt: at(-240), accuracyMeters: 9, speedMps: 0 },
    ])
    // Then the app open on the dashboard mount, asking for a fix every 30 s
    // and uploading each one as it lands.
    for (let i = 0; i < 7; i += 1) {
      await uploadFixes(driver.headers, [
        {
          ...HOME,
          recordedAt: at(-210 + i * 30),
          accuracyMeters: 12,
          speedMps: 0,
          source: "heartbeat",
        },
      ])
    }

    expect(await eventsOfType(watcher.headers, circle.id, "possible_incident")).toEqual([])
    expect(await pushesOfType("possible_incident")).toEqual([])
  })

  it("still raises one alert, quoting the confirmed speed, for a real hard stop", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 915), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 1830), recordedAt: at(-240), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-210), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-150), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1932), recordedAt: at(-90), accuracyMeters: 11, speedMps: 0 },
      { ...northOf(MOTORWAY, 1931), recordedAt: at(-20), accuracyMeters: 10, speedMps: 0 },
    ])

    const raised = await eventsOfType(watcher.headers, circle.id, "possible_incident")
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload.fromSpeedKmh).toBe(111)
    expect(await pushesOfType("possible_incident")).toHaveLength(1)
  })
})

describe("two devices uploading at the same moment", () => {
  // One attempt would be a coin toss rather than a regression test.
  const attempts = 6

  it("raises one incident alert, not one per device", async () => {
    for (let i = 0; i < attempts; i += 1) {
      const { driver } = await drivingFamily()
      const second = await signInDevice(driver.email, `device-incident-latch-${i}`)

      // Both devices ride in the same car, so both have the drive behind them.
      const drive = [
        { ...northOf(MOTORWAY, 0), recordedAt: at(-290), accuracyMeters: 6, speedMps: 29.0 },
        { ...northOf(MOTORWAY, 870), recordedAt: at(-260), accuracyMeters: 6, speedMps: 28.6 },
        { ...northOf(MOTORWAY, 940), recordedAt: at(-230), accuracyMeters: 9, speedMps: 0 },
      ]
      await uploadFixes(driver.headers, drive)
      await uploadFixes(second, drive)

      await Promise.all([
        uploadFixes(driver.headers, [
          { ...northOf(MOTORWAY, 940), recordedAt: at(-25), accuracyMeters: 9, speedMps: 0 },
        ]),
        uploadFixes(second, [
          { ...northOf(MOTORWAY, 941), recordedAt: at(-20), accuracyMeters: 11, speedMps: 0 },
        ]),
      ])
    }

    const rows = (await getDb().execute(
      sql`select id from events where type = 'possible_incident'`,
    )) as unknown as Array<{ id: string }>
    expect(rows).toHaveLength(attempts)
    expect(await pushesOfType("possible_incident")).toHaveLength(attempts)
  })

  it("raises one low battery alert, not one per device", async () => {
    for (let i = 0; i < attempts; i += 1) {
      const owner = await registerUser(ctx.app, { displayName: "Priya" })
      const circle = await createCircle(owner.headers)
      const watcher = await registerUser(ctx.app)
      await joinCircle(watcher.headers, circle.invite.code)
      const tablet = await signInDevice(owner.email, `device-battery-latch-${i}`)

      // Both come back on the house wifi at once and flush what they buffered.
      await Promise.all([
        uploadFixes(owner.headers, [
          { ...HOME, recordedAt: at(-60), accuracyMeters: 18, batteryLevel: 0.11 },
        ]),
        uploadFixes(tablet, [
          { ...northOf(HOME, 3), recordedAt: at(-50), accuracyMeters: 22, batteryLevel: 0.1 },
        ]),
      ])
    }

    const rows = (await getDb().execute(
      sql`select id from events where type = 'low_battery'`,
    )) as unknown as Array<{ id: string }>
    expect(rows).toHaveLength(attempts)
    expect(await pushesOfType("low_battery")).toHaveLength(attempts)
  })

  it("still tells a circle whose own battery threshold the drain reaches later", async () => {
    const owner = await registerUser(ctx.app)
    const family = await createCircle(owner.headers, "Family")
    const grandparents = await createCircle(owner.headers, "Grandparents")
    await setCircleSettings(owner.headers, family.id, { lowBatteryThreshold: 0.15 })
    await setCircleSettings(owner.headers, grandparents.id, { lowBatteryThreshold: 0.05 })

    await uploadFixes(owner.headers, [
      { ...HOME, recordedAt: at(-600), accuracyMeters: 8, batteryLevel: 0.14, isCharging: false },
    ])
    expect(await eventsOfType(owner.headers, family.id, "low_battery")).toHaveLength(1)
    expect(await eventsOfType(owner.headers, grandparents.id, "low_battery")).toEqual([])

    await uploadFixes(owner.headers, [
      { ...HOME, recordedAt: at(-60), accuracyMeters: 8, batteryLevel: 0.04, isCharging: false },
    ])
    expect(await eventsOfType(owner.headers, grandparents.id, "low_battery")).toHaveLength(1)
    // Inside the six hour cooldown, and told at a level below its own
    // threshold already, so this circle hears nothing new.
    expect(await eventsOfType(owner.headers, family.id, "low_battery")).toHaveLength(1)
  })
})
