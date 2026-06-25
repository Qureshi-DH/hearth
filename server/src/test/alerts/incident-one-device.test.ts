import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Both halves of the possible-incident evidence, the moving speed and the
 * stop, have to come from the same device. A tablet left at home must not lend
 * the driving phone its stillness.
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
const MOTORWAY = { lat: 51.5017, lon: -2.558 }

const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180
const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})

/** Seconds before now, the way a fix's recordedAt reaches the server. */
const at = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

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

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<Record<string, unknown>>,
) {
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
  }>
}

/** What each incident alert claimed, so a failure prints the accusation. */
async function incidentSummaries(headers: Record<string, string>, circleId: string) {
  return (await feedItems(headers, circleId))
    .filter((item) => item.type === "possible_incident")
    .map((item) => item.summary)
}

async function incidentPushes() {
  return (await getDb().execute(
    sql`select title, body, channel, priority from notification_outbox
        where data->>'type' = 'possible_incident'`,
  )) as unknown as Array<{ title: string; body: string; channel: string; priority: string }>
}

/** A second session on an account that already exists, bound to its own device. */
async function signInDevice(email: string, deviceId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName: "Kitchen tablet", platform: "android" },
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
  const accept = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${circle.invite.code}/accept`,
    headers: watcher.headers,
  })
  expect(accept.statusCode).toBe(200)
  return { driver, watcher, circle }
}

/** The phone on the M32 at 104 to 108 km/h, fixes 30 s apart. */
const MOTORWAY_RUN = [
  { ...northOf(MOTORWAY, 0), recordedAt: at(-320), accuracyMeters: 6, speedMps: 29.0 },
  { ...northOf(MOTORWAY, 870), recordedAt: at(-290), accuracyMeters: 6, speedMps: 30.0 },
  { ...northOf(MOTORWAY, 1770), recordedAt: at(-260), accuracyMeters: 6, speedMps: 30.0 },
]

describe("possible incident: both halves of the evidence must come from one device", () => {
  it("raises the alert for one phone that stops dead off the motorway", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The same run, and then the phone itself reports the stop and four
    // minutes of stillness at the roadside. This is what the heuristic is for.
    await uploadFixes(driver.headers, [
      ...MOTORWAY_RUN,
      { ...northOf(MOTORWAY, 1800), recordedAt: at(-230), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 1800), recordedAt: at(-140), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1801), recordedAt: at(-50), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 1800), recordedAt: at(-20), accuracyMeters: 8, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([
      "Sam stopped suddenly after driving at 108 km/h",
    ])
  })

  it("raises it when the drive and the stop arrive in two uploads from one phone", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The moving evidence sits in an earlier batch than the one carrying the
    // stop, which is the ordinary shape of a background upload.
    await uploadFixes(driver.headers, MOTORWAY_RUN)
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 1800), recordedAt: at(-230), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(MOTORWAY, 1800), recordedAt: at(-60), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1800), recordedAt: at(-20), accuracyMeters: 8, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([
      "Sam stopped suddenly after driving at 108 km/h",
    ])
  })

  it("does not let the kitchen tablet supply the stillness for the phone's speed", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    // The phone drives up the M32 and then loses signal in the cutting. It
    // never reports a stop. Noticing that it went quiet is the scheduler's
    // device_offline sweep, not this heuristic.
    await uploadFixes(driver.headers, MOTORWAY_RUN)

    // The tablet has sat on the kitchen table all evening, 7 km away, and
    // reports Wi-Fi fixes on its own timer. It has not stopped suddenly. It
    // has not started.
    await uploadFixes(tablet, [{ ...HOME, recordedAt: at(-200), accuracyMeters: 35, speedMps: 0 }])
    await uploadFixes(tablet, [{ ...HOME, recordedAt: at(-20), accuracyMeters: 35, speedMps: 0 }])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
    expect(await incidentPushes()).toEqual([])
  })

  it("does not let one manual fix from the tablet accuse the phone", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    await uploadFixes(driver.headers, MOTORWAY_RUN)

    // Somebody picks the tablet up and opens Hearth, which posts one fix with
    // source "manual" and, being Wi-Fi, no speed.
    await uploadFixes(tablet, [
      { ...HOME, recordedAt: at(-20), accuracyMeters: 42, speedMps: null, source: "manual" },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("says nothing for the tablet on its own, with no phone on the road", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    const tablet = await signInDevice(driver.email, "device-kitchen-tablet")

    await uploadFixes(tablet, [{ ...HOME, recordedAt: at(-200), accuracyMeters: 35, speedMps: 0 }])
    await uploadFixes(tablet, [{ ...HOME, recordedAt: at(-20), accuracyMeters: 35, speedMps: 0 }])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })
})
