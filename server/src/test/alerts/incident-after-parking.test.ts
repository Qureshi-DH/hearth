import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * An ordinary arrival and park followed by a one-off fix a few minutes later
 * is not a possible incident.
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

const at = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number | null
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

async function drivingFamily() {
  const driver = await registerUser(ctx.app, { displayName: "Sam" })
  const circle = await createCircle(driver.headers, "Family")
  await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
  const watcher = await registerUser(ctx.app, { displayName: "Watcher" })
  await joinCircle(watcher.headers, circle.invite.code)
  return { driver, watcher, circle }
}

describe("possible incident: arriving and parking", () => {
  it("stays quiet when Sam parks at home and answers a nudge three minutes later", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The last two minutes of a commute. 48 km/h on the through road, off the
    // gas for the turn, walking pace onto the drive, engine off. Every speed
    // here is a car decelerating normally, not a car being stopped by anything.
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
    // fixes back inside the 60 m distance filter. Then the watcher nudges and
    // reportNow("nudge") answers with exactly one fix from indoors.
    await uploadFixes(driver.headers, [
      { ...HOME, recordedAt: at(-20), accuracyMeters: 32, speedMps: 0, source: "nudge" },
    ])

    expect(
      (await incidentPushes()).map((row) => `${row.priority}/${row.channel}: ${row.body}`),
    ).toEqual([])
    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when the parked phone keeps reporting on its own, with no nudge at all", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The same arrival, except the tracker is still in moving mode for the
    // first five minutes after the stop and the OS keeps handing it a fix.
    // No nudge, no check-in, nobody doing anything: just a car on a drive.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, -1200), recordedAt: at(-330), accuracyMeters: 8, speedMps: 13.4 },
      { ...northOf(HOME, -800), recordedAt: at(-300), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(HOME, -480), recordedAt: at(-270), accuracyMeters: 8, speedMps: 8.0 },
      { ...northOf(HOME, -260), recordedAt: at(-240), accuracyMeters: 9, speedMps: 3.5 },
      { ...northOf(HOME, -20), recordedAt: at(-210), accuracyMeters: 9, speedMps: 1.2 },
      { ...HOME, recordedAt: at(-195), accuracyMeters: 10, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 3), recordedAt: at(-165), accuracyMeters: 12, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, -2), recordedAt: at(-135), accuracyMeters: 14, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 1), recordedAt: at(-105), accuracyMeters: 13, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 4), recordedAt: at(-75), accuracyMeters: 15, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, -1), recordedAt: at(-45), accuracyMeters: 13, speedMps: 0 },
    ])
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 2), recordedAt: at(-15), accuracyMeters: 14, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("quotes a speed two fixes agreed on, not the lone artefact earlier in the window", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // A real hard stop off the motorway, with one 144 km/h sample from a
    // provider switch a minute before it. The alert has to quote the 111 km/h
    // the drive actually sustained: a number no second fix ever corroborated
    // is the one thing a family cannot be told about a crash.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 450), recordedAt: at(-285), accuracyMeters: 6, speedMps: 40.0 },
      { ...northOf(MOTORWAY, 900), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 1815), recordedAt: at(-240), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 2745), recordedAt: at(-210), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 2790), recordedAt: at(-200), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 2792), recordedAt: at(-120), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 2789), recordedAt: at(-60), accuracyMeters: 10, speedMps: 0 },
      { ...northOf(MOTORWAY, 2791), recordedAt: at(-15), accuracyMeters: 10, speedMps: 0 },
    ])

    const raised = (await feedItems(watcher.headers, circle.id)).filter(
      (item) => item.type === "possible_incident",
    )
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload.fromSpeedKmh).toBe(111)
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

  it("stays quiet at a red light after a 40 km/h approach", async () => {
    const { driver, watcher, circle } = await drivingFamily()

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

  it("raises the alert when the car stops dead inside a tunnel and every fix is coarse", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 99 km/h into the tunnel, GPS gone, the fixes coming from cell at 1300 to
    // 1600 m with no speed at all. The car stops five metres past where it was
    // and never moves again. A crash in a tunnel, an underground car park or a
    // cutting reports exactly these null speeds and these error circles, so a
    // rule that needs a well-placed fix before it will believe in stillness is
    // silent for the crashes people most need telling about.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 9, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 820), recordedAt: at(-230), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 823), recordedAt: at(-170), accuracyMeters: 1600, speedMps: null },
      { ...northOf(MOTORWAY, 821), recordedAt: at(-110), accuracyMeters: 1500, speedMps: null },
      { ...northOf(MOTORWAY, 825), recordedAt: at(-50), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 822), recordedAt: at(-20), accuracyMeters: 1300, speedMps: null },
    ])

    const raised = (await feedItems(watcher.headers, circle.id)).filter(
      (item) => item.type === "possible_incident",
    )
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload.fromSpeedKmh).toBe(99)
  })

  it("stays quiet in that same tunnel when the car drives straight through it", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The only thing that separates this from the test above: the coordinates
    // keep advancing at 27 m/s. Six kilometres of tunnel beats
    // even a 3 km error circle, so this is movement and stays movement.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 9, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 820), recordedAt: at(-230), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 2450), recordedAt: at(-170), accuracyMeters: 1600, speedMps: null },
      { ...northOf(MOTORWAY, 4080), recordedAt: at(-110), accuracyMeters: 1500, speedMps: null },
      { ...northOf(MOTORWAY, 5700), recordedAt: at(-50), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 6510), recordedAt: at(-20), accuracyMeters: 1300, speedMps: null },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("raises the alert for a hard stop in a 500 m accuracy blackspot", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 100 km/h, then stopped, on a road where the phone can only place itself
    // to within half a kilometre. The stop is measured, the stillness is not
    // measurable, and the drive it came off is not in question.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 9, speedMps: 28 },
      { ...northOf(MOTORWAY, 840), recordedAt: at(-270), accuracyMeters: 9, speedMps: 28 },
      { ...northOf(MOTORWAY, 1680), recordedAt: at(-240), accuracyMeters: 12, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 1685), recordedAt: at(-200), accuracyMeters: 500, speedMps: 0 },
      { ...northOf(MOTORWAY, 1683), recordedAt: at(-110), accuracyMeters: 480, speedMps: 0 },
      { ...northOf(MOTORWAY, 1687), recordedAt: at(-15), accuracyMeters: 520, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
  })

  it("stays quiet when the coarse fixes start after a crawl down a car park ramp", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The blackspot above with one difference, the speed the fixes went dark
    // at. 14 km/h and slowing is a car arriving somewhere, and nothing that
    // follows can be told apart from a car park.
    await uploadFixes(driver.headers, [
      { ...northOf(HOME, 0), recordedAt: at(-300), accuracyMeters: 8, speedMps: 12.4 },
      { ...northOf(HOME, 330), recordedAt: at(-270), accuracyMeters: 9, speedMps: 10.8 },
      { ...northOf(HOME, 500), recordedAt: at(-240), accuracyMeters: 25, speedMps: 4.0 },
      { ...northOf(HOME, 520), recordedAt: at(-200), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 540), recordedAt: at(-100), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 515), recordedAt: at(-15), accuracyMeters: 1650, speedMps: null },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("still raises the alert for a real hard stop from motorway speed", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 110 km/h, then the same coordinate for four minutes. The fix before the
    // stop is at full speed: nothing decelerated, the car simply stopped.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 915), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 1830), recordedAt: at(-240), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-210), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-150), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1932), recordedAt: at(-90), accuracyMeters: 11, speedMps: 0 },
      { ...northOf(MOTORWAY, 1931), recordedAt: at(-20), accuracyMeters: 10, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
  })
})
