import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

// A dual carriageway heading north out of Bristol.
const ROAD = { lat: 51.4545, lon: -2.5879 }

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

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number
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

function uploadRequest(headers: Record<string, string>, points: Fix[]) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
}

async function uploadFixes(headers: Record<string, string>, points: Fix[]) {
  const response = await uploadRequest(headers, points)
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number }
}

/** A second signed-in device for an account that already exists. */
async function signInDevice(email: string, deviceId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName: "Second Phone", platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
}

/**
 * The drive that precedes the stop: 105 km/h on a dual carriageway, fixes 30
 * seconds apart, then a hard stop and two minutes of not moving. It ends
 * before the stillness the heuristic demands has accumulated, so this upload
 * cannot raise the alert on its own.
 */
function driveThenStop(): Fix[] {
  return [
    { ...northOf(ROAD, 0), recordedAt: iso(-330), accuracyMeters: 9, speedMps: 29 },
    { ...northOf(ROAD, 870), recordedAt: iso(-300), accuracyMeters: 8, speedMps: 29 },
    { ...northOf(ROAD, 1710), recordedAt: iso(-270), accuracyMeters: 11, speedMps: 28 },
    { ...northOf(ROAD, 1940), recordedAt: iso(-240), accuracyMeters: 12, speedMps: 0.4 },
    { ...northOf(ROAD, 1942), recordedAt: iso(-120), accuracyMeters: 16, speedMps: 0 },
  ]
}

/** The heartbeat a stationary tracker still sends. */
const stillFix = (secondsAgo: number, accuracy: number): Fix => ({
  ...northOf(ROAD, 1943),
  recordedAt: iso(secondsAgo),
  accuracyMeters: accuracy,
  speedMps: 0,
})

async function eventCount(circleId: string, type: string) {
  const rows = await getDb().execute(
    sql`select count(*)::int as n from events where circle_id = ${circleId} and type = ${type}`,
  )
  return (rows as unknown as Array<{ n: number }>)[0]!.n
}

async function pushCount(userId: string, channel: string) {
  const rows = await getDb().execute(
    sql`select count(*)::int as n from notification_outbox
        where user_id = ${userId} and channel = ${channel}`,
  )
  return (rows as unknown as Array<{ n: number }>)[0]!.n
}

async function setUpCar(index: number) {
  const driver = await registerUser(ctx.app, { displayName: `Driver ${index}` })
  const watcher = await registerUser(ctx.app, { displayName: `Watcher ${index}` })
  const circle = await createCircle(driver.headers)
  await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
  await joinCircle(watcher.headers, circle.invite.code)
  await uploadFixes(driver.headers, driveThenStop())
  const second = await signInDevice(driver.email, `second-device-${index}`)
  return { driver, watcher, circle, second }
}

describe("possible incident, one stop and two devices", () => {
  const attempts = 6

  it("raises the alert at all when a single device reports the matured stop", async () => {
    const { watcher, circle, driver } = await setUpCar(0)

    await uploadFixes(driver.headers, [stillFix(-25, 18)])

    expect(await eventCount(circle.id, "possible_incident")).toBe(1)
    expect(await pushCount(watcher.user.id, "sos")).toBe(1)
  })

  it("raises it once when the two devices report the stop one after the other", async () => {
    const { watcher, circle, driver, second } = await setUpCar(0)

    await uploadFixes(driver.headers, [stillFix(-25, 18)])
    await uploadFixes(second, [stillFix(-20, 22)])

    expect(await eventCount(circle.id, "possible_incident")).toBe(1)
    expect(await pushCount(watcher.user.id, "sos")).toBe(1)
  })

  it("raises one alert when two devices report the same stop at the same moment", async () => {
    const cars: Array<{ circleId: string; watcherId: string }> = []

    for (let i = 0; i < attempts; i += 1) {
      const { watcher, circle, driver, second } = await setUpCar(i)
      cars.push({ circleId: circle.id, watcherId: watcher.user.id })

      const [phone, other] = await Promise.all([
        uploadRequest(driver.headers, [stillFix(-25, 18)]),
        uploadRequest(second, [stillFix(-20, 22)]),
      ])
      expect(phone.statusCode).toBe(200)
      expect(other.statusCode).toBe(200)
    }

    const events = await Promise.all(
      cars.map((car) => eventCount(car.circleId, "possible_incident")),
    )
    const pushes = await Promise.all(cars.map((car) => pushCount(car.watcherId, "sos")))

    expect({ events, pushes }).toEqual({
      events: cars.map(() => 1),
      pushes: cars.map(() => 1),
    })
  })
})
