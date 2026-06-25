import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The possible-incident heuristic in services/locations.ts.
 *
 * Every sequence is what the mobile tracker uploads: fixes 30 to 60 seconds
 * apart while moving, nothing while parked inside the distance filter, a null
 * speed whenever the platform has none to give, and accuracy in the hundreds of
 * metres once a fix comes from Wi-Fi or a cell.
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

/** A house on a 30 mph residential street in Bristol, and the M32 north of it. */
const HOME = { lat: 51.4545, lon: -2.5879 }
const MOTORWAY = { lat: 51.5017, lon: -2.558 }

const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180

const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})

/** Seconds before now, the way a fix's recordedAt reaches the server. */
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
    occurredAt: string
    payload: Record<string, unknown>
  }>
}

async function incidents(headers: Record<string, string>, circleId: string) {
  return (await feedItems(headers, circleId)).filter((item) => item.type === "possible_incident")
}

/** What each incident alert said, so a failure prints the claim being made. */
async function incidentSummaries(headers: Record<string, string>, circleId: string) {
  return (await incidents(headers, circleId)).map((item) => item.summary)
}

async function allIncidentRows() {
  return (await getDb().execute(
    sql`select id, circle_id, summary from events where type = 'possible_incident'`,
  )) as unknown as Array<{ id: string; circle_id: string; summary: string }>
}

async function incidentPushes() {
  return (await getDb().execute(
    sql`select user_id, title, body, channel, priority from notification_outbox
        where data->>'type' = 'possible_incident'`,
  )) as unknown as Array<{
    user_id: string
    title: string
    body: string
    channel: string
    priority: string
  }>
}

/** A second signed-in device on an account that already exists. */
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

/** A driver whose one circle has incident alerts switched on, plus a watcher. */
async function drivingFamily() {
  const driver = await registerUser(ctx.app, { displayName: "Sam" })
  const circle = await createCircle(driver.headers, "Family")
  await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
  const watcher = await registerUser(ctx.app, { displayName: "Watcher" })
  await joinCircle(watcher.headers, circle.invite.code)
  return { driver, watcher, circle }
}

describe("possible incident: it fires when it should", () => {
  it("raises one alert for a hard stop from motorway speed followed by stillness", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 110 km/h up the M32, then nothing but the same coordinate for four
    // minutes. Fixes 30 s apart, which is the tracker's minimum interval.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 915), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 1830), recordedAt: at(-240), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-210), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-150), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1932), recordedAt: at(-90), accuracyMeters: 11, speedMps: 0 },
      { ...northOf(MOTORWAY, 1931), recordedAt: at(-20), accuracyMeters: 10, speedMps: 0 },
    ])

    const raised = await incidents(watcher.headers, circle.id)
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload.fromSpeedKmh).toBe(111)

    const pushes = await incidentPushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(watcher.user.id)
    expect(pushes[0]!.channel).toBe("sos")
    expect(pushes[0]!.priority).toBe("high")
  })

  it("raises the alert exactly once while the stopped phone keeps reporting", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-330), accuracyMeters: 6, speedMps: 29.4 },
      { ...northOf(MOTORWAY, 880), recordedAt: at(-300), accuracyMeters: 6, speedMps: 29.1 },
      { ...northOf(MOTORWAY, 1750), recordedAt: at(-270), accuracyMeters: 7, speedMps: 28.8 },
      { ...northOf(MOTORWAY, 1810), recordedAt: at(-240), accuracyMeters: 12, speedMps: 0 },
    ])

    // An SOS-style ping every 20 s from a phone that is upright and reporting
    // but has not moved. Each upload is its own request, as it would be.
    for (const offset of [-180, -120, -60, -40, -20]) {
      await uploadFixes(driver.headers, [
        { ...northOf(MOTORWAY, 1810), recordedAt: at(offset), accuracyMeters: 12, speedMps: 0 },
      ])
    }

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
    expect(await incidentPushes()).toHaveLength(1)
  })

  it("waits for the stillness to last three minutes before saying anything", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 100 km/h, braking, and stationary from -190 s. At -30 s the stop is 170
    // seconds old measured from the last fix that was still moving, which is
    // under the threshold and must stay quiet.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-290), accuracyMeters: 6, speedMps: 28.0 },
      { ...northOf(MOTORWAY, 840), recordedAt: at(-260), accuracyMeters: 6, speedMps: 27.0 },
      { ...northOf(MOTORWAY, 1450), recordedAt: at(-230), accuracyMeters: 7, speedMps: 12.0 },
      { ...northOf(MOTORWAY, 1620), recordedAt: at(-200), accuracyMeters: 8, speedMps: 5.0 },
      { ...northOf(MOTORWAY, 1650), recordedAt: at(-190), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 1650), recordedAt: at(-100), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 1651), recordedAt: at(-30), accuracyMeters: 9, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])

    // The next fix pushes the stillness past three minutes.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 1650), recordedAt: at(-5), accuracyMeters: 9, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
  })
})

describe("possible incident: it must not fire", () => {
  it("stays quiet at a red light after a 40 km/h approach", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 40 km/h down the high street, ninety seconds at the lights.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 0), recordedAt: at(-170), accuracyMeters: 8, speedMps: 11.2 },
      { ...northOf(HOME, 336), recordedAt: at(-140), accuracyMeters: 8, speedMps: 11.0 },
      { ...northOf(HOME, 550), recordedAt: at(-110), accuracyMeters: 8, speedMps: 4.6 },
      { ...northOf(HOME, 566), recordedAt: at(-80), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(HOME, 566), recordedAt: at(-50), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(HOME, 566), recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet in a jam that creeps forward every couple of minutes", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // Motorway speed, then eight minutes of queueing: a crawl, a standstill,
    // another crawl. Nothing here is a stop that lasted.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-540), accuracyMeters: 6, speedMps: 29.0 },
      { ...northOf(MOTORWAY, 1740), recordedAt: at(-480), accuracyMeters: 6, speedMps: 24.0 },
      { ...northOf(MOTORWAY, 2900), recordedAt: at(-420), accuracyMeters: 7, speedMps: 12.0 },
      { ...northOf(MOTORWAY, 3050), recordedAt: at(-360), accuracyMeters: 8, speedMps: 2.2 },
      { ...northOf(MOTORWAY, 3090), recordedAt: at(-300), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 3160), recordedAt: at(-240), accuracyMeters: 8, speedMps: 1.8 },
      { ...northOf(MOTORWAY, 3200), recordedAt: at(-180), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 3290), recordedAt: at(-120), accuracyMeters: 8, speedMps: 2.0 },
      { ...northOf(MOTORWAY, 3320), recordedAt: at(-60), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 3325), recordedAt: at(-30), accuracyMeters: 8, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet in stop-start traffic on a 50 km/h road", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    const speeds = [13.8, 0, 6.2, 0, 9.4, 0, 4.8, 0, 11.1, 0, 3.6, 0]
    let metres = 0
    await uploadFixes(
      driver.headers,
      speeds.map((speedMps, i) => {
        metres += speedMps * 30
        return {
          ...northOf(HOME, metres),
          recordedAt: at(-30 * (speeds.length - i)),
          accuracyMeters: 9,
          speedMps,
        }
      }),
    )

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when someone parks at home and a nudge is answered three minutes later", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The last two minutes of a commute: 48 km/h on the through road, slowing
    // for the turn, crawling onto the drive, engine off. This is the ordinary
    // end of every journey the app will ever see.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, -1200), recordedAt: at(-330), accuracyMeters: 8, speedMps: 13.4 },
      { ...northOf(HOME, -800), recordedAt: at(-300), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(HOME, -480), recordedAt: at(-270), accuracyMeters: 8, speedMps: 8.0 },
      { ...northOf(HOME, -260), recordedAt: at(-240), accuracyMeters: 9, speedMps: 3.5 },
      { ...northOf(HOME, -20), recordedAt: at(-210), accuracyMeters: 9, speedMps: 1.2 },
      { ...HOME, recordedAt: at(-195), accuracyMeters: 10, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])

    // Nothing more is uploaded while the car sits on the drive: the OS holds
    // fixes back inside the 60 m distance filter. Then the watcher nudges, and
    // notifications.ts answers with exactly one fix from indoors.
    await uploadFixes(driver.headers, [
      { ...HOME, recordedAt: at(-20), accuracyMeters: 32, speedMps: 0, source: "nudge" },
    ])

    expect(
      (await incidentPushes()).map((row) => `${row.priority}/${row.channel}: ${row.body}`),
    ).toEqual([])
    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when a check-in answers from a drive-through queue", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 0), recordedAt: at(-320), accuracyMeters: 8, speedMps: 12.0 },
      { ...northOf(HOME, 300), recordedAt: at(-290), accuracyMeters: 8, speedMps: 9.0 },
      { ...northOf(HOME, 420), recordedAt: at(-260), accuracyMeters: 10, speedMps: 3.0 },
      { ...northOf(HOME, 465), recordedAt: at(-230), accuracyMeters: 10, speedMps: 1.5 },
      { ...northOf(HOME, 470), recordedAt: at(-215), accuracyMeters: 11, speedMps: 0.4 },
    ])

    // Three and a half minutes at the window, then "arrived safe" from the
    // check-in screen, which reports one fix of its own.
    await uploadFixes(driver.headers, [
      {
        ...northOf(HOME, 470),
        recordedAt: at(-25),
        accuracyMeters: 18,
        speedMps: 0,
        source: "manual",
      },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet while the car is still moving through a long tunnel", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 100 km/h into a 6 km tunnel. GPS is gone, so the fused provider falls
    // back to cell: speed unavailable (the client sends null for that) and
    // accuracy in the kilometre range. The coordinates keep advancing at
    // 27 m/s the whole time, which is the opposite of not having moved.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-260), accuracyMeters: 7, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 820), recordedAt: at(-230), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 2450), recordedAt: at(-170), accuracyMeters: 1600, speedMps: null },
      { ...northOf(MOTORWAY, 4080), recordedAt: at(-110), accuracyMeters: 1500, speedMps: null },
      { ...northOf(MOTORWAY, 5700), recordedAt: at(-50), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 6510), recordedAt: at(-20), accuracyMeters: 1300, speedMps: null },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when the car is parked underground and fixes fall back to the network", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 0), recordedAt: at(-300), accuracyMeters: 8, speedMps: 12.4 },
      { ...northOf(HOME, 330), recordedAt: at(-270), accuracyMeters: 9, speedMps: 10.8 },
      { ...northOf(HOME, 500), recordedAt: at(-240), accuracyMeters: 25, speedMps: 4.0 },
      // Down the ramp. No sky, no GPS, no speed.
      { ...northOf(HOME, 520), recordedAt: at(-200), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 540), recordedAt: at(-100), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 515), recordedAt: at(-15), accuracyMeters: 1650, speedMps: null },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet for a passenger dropped at the station who sits down inside", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The passenger's own phone: in a car at 90 km/h, dropped at the entrance,
    // walks twenty metres inside (too little for the distance filter) and sits.
    // The next fix is a Wi-Fi one from the concourse.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 0), recordedAt: at(-330), accuracyMeters: 7, speedMps: 25.0 },
      { ...northOf(HOME, 750), recordedAt: at(-300), accuracyMeters: 7, speedMps: 24.2 },
      { ...northOf(HOME, 1200), recordedAt: at(-270), accuracyMeters: 8, speedMps: 9.0 },
      { ...northOf(HOME, 1250), recordedAt: at(-250), accuracyMeters: 9, speedMps: 1.4 },
      { ...northOf(HOME, 1258), recordedAt: at(-230), accuracyMeters: 12, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 1268), recordedAt: at(-30), accuracyMeters: 45, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when one impossible speed sample lands on a phone that never moved", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The car has been on the drive for an hour. Every fix is the same spot
    // give or take GPS jitter, except one sample where the provider switched
    // and reported 101 km/h without the phone going anywhere.
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

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when a second device at home reports while the phone is out of signal", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    // The phone is on the motorway and then loses signal in a cutting. The
    // scheduler's device_offline sweep is what exists to notice that.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-320), accuracyMeters: 6, speedMps: 29.0 },
      { ...northOf(MOTORWAY, 870), recordedAt: at(-290), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 1770), recordedAt: at(-260), accuracyMeters: 6, speedMps: 30.0 },
    ])

    // The tablet has been on the kitchen table all evening and reports a
    // Wi-Fi fix on its own timer. It has not stopped suddenly. It has not
    // started.
    await uploadFixes(tablet, [{ ...HOME, recordedAt: at(-200), accuracyMeters: 35, speedMps: 0 }])
    await uploadFixes(tablet, [{ ...HOME, recordedAt: at(-20), accuracyMeters: 35, speedMps: 0 }])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet for a backlog uploaded after the battery died mid-drive", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The phone recorded a hard stop and four minutes of stillness, then died
    // at 3%. Forty minutes later it is on a charger and drains its queue. The
    // stop is long over and nobody should be told "they have not moved since".
    const base = -40 * 60
    await uploadFixes(driver.headers, [
      {
        ...northOf(MOTORWAY, 0),
        recordedAt: at(base - 300),
        accuracyMeters: 7,
        speedMps: 28.0,
        batteryLevel: 0.04,
        isCharging: false,
      },
      {
        ...northOf(MOTORWAY, 840),
        recordedAt: at(base - 270),
        accuracyMeters: 7,
        speedMps: 27.6,
        batteryLevel: 0.03,
        isCharging: false,
      },
      {
        ...northOf(MOTORWAY, 900),
        recordedAt: at(base - 240),
        accuracyMeters: 9,
        speedMps: 0,
        batteryLevel: 0.03,
        isCharging: false,
      },
      {
        ...northOf(MOTORWAY, 900),
        recordedAt: at(base - 60),
        accuracyMeters: 9,
        speedMps: 0,
        batteryLevel: 0.02,
        isCharging: false,
      },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
    expect(await incidentPushes()).toEqual([])
  })

  it("stays quiet for a circle that has not switched incident alerts on", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(driver.headers, "Colleagues")
    const watcher = await registerUser(ctx.app)
    await joinCircle(watcher.headers, circle.invite.code)

    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 900), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 960), recordedAt: at(-240), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 960), recordedAt: at(-120), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 961), recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })
})

describe("possible incident: sharing state", () => {
  /** The crash sequence used by both privacy tests. */
  const hardStop = () => [
    { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.0 },
    { ...northOf(MOTORWAY, 900), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.4 },
    { ...northOf(MOTORWAY, 980), recordedAt: at(-240), accuracyMeters: 9, speedMps: 0 },
    { ...northOf(MOTORWAY, 980), recordedAt: at(-120), accuracyMeters: 9, speedMps: 0 },
    { ...northOf(MOTORWAY, 981), recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
  ]

  it("never tells a circle the member shares approximately with", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Sam" })
    const close = await createCircle(driver.headers, "Family")
    const wider = await createCircle(driver.headers, "Neighbours")
    await setCircleSettings(driver.headers, close.id, { incidentDetection: true })
    await setCircleSettings(driver.headers, wider.id, { incidentDetection: true })

    const nearest = await registerUser(ctx.app, { displayName: "Partner" })
    await joinCircle(nearest.headers, close.invite.code)
    const neighbour = await registerUser(ctx.app, { displayName: "Neighbour" })
    await joinCircle(neighbour.headers, wider.invite.code)

    // Precise with the family, a coarse grid with the neighbours. Where they
    // stopped and how fast they were going are both precise facts.
    await setSharing(driver.headers, wider.id, "approximate")

    await uploadFixes(driver.headers, hardStop())

    expect(await incidentSummaries(nearest.headers, close.id)).toHaveLength(1)
    expect(await incidentSummaries(neighbour.headers, wider.id)).toEqual([])

    const pushed = await incidentPushes()
    expect(pushed.map((row) => row.user_id)).toEqual([nearest.user.id])
  })

  it("never tells a circle sharing is paused with", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Sam" })
    const circle = await createCircle(driver.headers, "Family")
    await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
    const watcher = await registerUser(ctx.app)
    await joinCircle(watcher.headers, circle.invite.code)
    await setSharing(driver.headers, circle.id, "paused")

    await uploadFixes(driver.headers, hardStop())

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
    expect(await incidentPushes()).toEqual([])
  })
})

describe("possible incident: exactly once", () => {
  it("holds the alert back for an hour and then allows the next one", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 900), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 960), recordedAt: at(-240), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 960), recordedAt: at(-120), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 961), recordedAt: at(-30), accuracyMeters: 9, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)

    // The car has not moved, so every later fix still satisfies the heuristic.
    // Twenty minutes on, it is inside the cooldown and must stay quiet.
    // Backdating the latch is how twenty minutes pass in a test.
    await getDb().execute(
      sql`update user_presence set incident_flagged_at = now() - interval '20 minutes'`,
    )
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 961), recordedAt: at(-25), accuracyMeters: 9, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)

    // Past the hour, the same evidence is allowed to speak again.
    await getDb().execute(
      sql`update user_presence set incident_flagged_at = now() - interval '61 minutes'`,
    )
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 960), recordedAt: at(-15), accuracyMeters: 9, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(2)
  })

  it("raises one alert when the upload is retried after a lost response", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    const batch = [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 31.0 },
      { ...northOf(MOTORWAY, 930), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.6 },
      { ...northOf(MOTORWAY, 1000), recordedAt: at(-240), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1000), recordedAt: at(-120), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1001), recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
    ]
    await uploadFixes(driver.headers, batch)
    // The response never reached the phone, so it sends the same batch again,
    // then the same batch with one new fix on the end.
    await uploadFixes(driver.headers, batch)
    await uploadFixes(driver.headers, [
      ...batch,
      { ...northOf(MOTORWAY, 1000), recordedAt: at(-5), accuracyMeters: 9, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
    expect(await incidentPushes()).toHaveLength(1)
  })

  it("raises one alert when two devices report the same stop at the same moment", async () => {
    // One attempt would be a coin toss rather than a regression test, so this
    // repeats the race over several independent accounts.
    const attempts = 6

    for (let i = 0; i < attempts; i += 1) {
      const { driver } = await drivingFamily()
      const second = await signInDevice(driver.email, `device-incident-race-${i}`)

      await uploadFixes(driver.headers, [
        { ...northOf(MOTORWAY, 0), recordedAt: at(-290), accuracyMeters: 6, speedMps: 29.0 },
        { ...northOf(MOTORWAY, 870), recordedAt: at(-260), accuracyMeters: 6, speedMps: 28.6 },
        { ...northOf(MOTORWAY, 940), recordedAt: at(-230), accuracyMeters: 9, speedMps: 0 },
      ])

      // The phone in the driver's pocket and the phone in the cradle both
      // report the stop as the stillness matures.
      await Promise.all([
        uploadFixes(driver.headers, [
          { ...northOf(MOTORWAY, 940), recordedAt: at(-25), accuracyMeters: 9, speedMps: 0 },
        ]),
        uploadFixes(second, [
          { ...northOf(MOTORWAY, 941), recordedAt: at(-20), accuracyMeters: 11, speedMps: 0 },
        ]),
      ])
    }

    const rows = await allIncidentRows()
    expect(rows).toHaveLength(attempts)
    expect(await incidentPushes()).toHaveLength(attempts)
  })
})
