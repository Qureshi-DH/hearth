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

async function createPlace(
  headers: Record<string, string>,
  circleId: string,
  place: { name: string; lat: number; lon: number; radiusMeters: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { icon: "pin", ...place },
  })
  expect(response.statusCode).toBe(201)
}

/** Fixes `interval` seconds apart, the car advancing by what each speed says. */
function fixesFrom(
  start: { lat: number; lon: number },
  startSecondsAgo: number,
  interval: number,
  speeds: number[],
  accuracyMeters = 6,
): Fix[] {
  let metres = 0
  return speeds.map((speedMps, i) => {
    const fix = {
      ...northOf(start, metres),
      recordedAt: at(startSecondsAgo + i * interval),
      accuracyMeters,
      speedMps,
    }
    metres += speedMps * interval
    return fix
  })
}

/** Uploaded a minute's worth at a time, the way a phone on Live flushes. */
async function uploadInMinutes(headers: Record<string, string>, points: Fix[]) {
  for (let i = 0; i < points.length; i += 60) await uploadFixes(headers, points.slice(i, i + 60))
}

describe("possible incident: an ordinary stop is not a sudden one", () => {
  /** A filling station on the A38 out of Bristol. */
  const STATION = northOf(HOME, 2400)

  it("stays quiet at a petrol pump after a 45 km/h approach", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // In off the main road at 45 km/h, through the forecourt at 4 m/s, and
    // three and a half minutes at the pump.
    await uploadFixes(driver.headers, [
      { ...northOf(STATION, -760), recordedAt: at(-300), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(STATION, -385), recordedAt: at(-270), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(STATION, -60), recordedAt: at(-240), accuracyMeters: 9, speedMps: 4.0 },
      { ...STATION, recordedAt: at(-210), accuracyMeters: 9, speedMps: 0 },
      { ...STATION, recordedAt: at(-150), accuracyMeters: 9, speedMps: 0 },
      { ...STATION, recordedAt: at(-90), accuracyMeters: 10, speedMps: 0 },
      { ...STATION, recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
    expect(await incidentPushes()).toEqual([])
  })

  it("stays quiet when the queue to pay keeps the car at the pump for seven minutes", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The same approach and a long stop. Road speed to standing took a
    // minute and a slow fix in between, which is a car pulling in.
    await uploadFixes(driver.headers, [
      { ...northOf(STATION, -760), recordedAt: at(-540), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(STATION, -385), recordedAt: at(-510), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(STATION, -60), recordedAt: at(-480), accuracyMeters: 9, speedMps: 4.0 },
      { ...STATION, recordedAt: at(-450), accuracyMeters: 9, speedMps: 0 },
      { ...STATION, recordedAt: at(-330), accuracyMeters: 9, speedMps: 0 },
      { ...STATION, recordedAt: at(-210), accuracyMeters: 10, speedMps: 0 },
      { ...STATION, recordedAt: at(-90), accuracyMeters: 9, speedMps: 0 },
      { ...STATION, recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when a watched phone brakes to a stop the ordinary way", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // Live, so a fix a second. 45 km/h, a firm brake at 2.5 m/s² to the
    // line, and six minutes parked on the verge. Six seconds from road speed
    // to standing is quick for a driver and slow for a collision.
    const approach = fixesFrom(northOf(HOME, -800), -420, 1, [
      ...Array.from({ length: 30 }, () => 12.5),
      ...Array.from({ length: 6 }, (_, i) => Math.max(0, 12.5 - 2.5 * (i + 1))),
    ])
    const stoppedAt = approach[approach.length - 1]!
    const parked = Array.from({ length: 384 }, (_, i) => ({
      lat: stoppedAt.lat,
      lon: stoppedAt.lon,
      recordedAt: at(-384 + i),
      accuracyMeters: 5,
      speedMps: 0,
    }))
    await uploadInMinutes(driver.headers, [...approach, ...parked])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("stays quiet when a watched phone brakes hard for a light from 45 km/h", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // Live again, and a firmer brake, 4 m/s² from the moment after the last
    // fix at cruising speed. It goes through 35 km/h within a second, so
    // counting from there makes three seconds to standing look like a crash.
    // Counted from cruising speed it is an ordinary stop.
    const approach = fixesFrom(northOf(HOME, -800), -420, 1, [
      ...Array.from({ length: 30 }, () => 12.5),
      8.5,
      4.5,
      0.5,
    ])
    const stoppedAt = approach[approach.length - 1]!
    const parked = Array.from({ length: 387 }, (_, i) => ({
      lat: stoppedAt.lat,
      lon: stoppedAt.lon,
      recordedAt: at(-387 + i),
      accuracyMeters: 5,
      speedMps: 0,
    }))
    await uploadInMinutes(driver.headers, [...approach, ...parked])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })
})

describe("possible incident: a named place is somewhere people stop", () => {
  /** A stop that has everything else a collision has. */
  const hardStopAt = (point: { lat: number; lon: number }): Fix[] => [
    { ...northOf(point, -1800), recordedAt: at(-420), accuracyMeters: 6, speedMps: 30.0 },
    { ...northOf(point, -900), recordedAt: at(-390), accuracyMeters: 6, speedMps: 30.2 },
    { ...northOf(point, -10), recordedAt: at(-360), accuracyMeters: 7, speedMps: 29.8 },
    { ...point, recordedAt: at(-330), accuracyMeters: 9, speedMps: 0 },
    { ...point, recordedAt: at(-210), accuracyMeters: 9, speedMps: 0 },
    { ...point, recordedAt: at(-90), accuracyMeters: 10, speedMps: 0 },
    { ...point, recordedAt: at(-20), accuracyMeters: 9, speedMps: 0 },
  ]

  it("stays quiet for a stop just outside a place the circle named", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    // Gran's is a farmhouse off a fast road, and the car stops in the lane
    // past the edge of the circle drawn round it.
    const GRANS = northOf(MOTORWAY, 5000)
    await createPlace(driver.headers, circle.id, {
      name: "Gran's",
      ...GRANS,
      radiusMeters: 100,
    })

    await uploadFixes(driver.headers, hardStopAt(northOf(GRANS, 125)))

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
    expect(await incidentPushes()).toEqual([])
  })

  it("tells a circle that has not named the place, and not the one that has", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Sam" })
    const family = await createCircle(driver.headers, "Family")
    const club = await createCircle(driver.headers, "Running club")
    await setCircleSettings(driver.headers, family.id, { incidentDetection: true })
    await setCircleSettings(driver.headers, club.id, { incidentDetection: true })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, family.invite.code)
    const coach = await registerUser(ctx.app, { displayName: "Coach" })
    await joinCircle(coach.headers, club.invite.code)

    const GRANS = northOf(MOTORWAY, 5000)
    await createPlace(driver.headers, family.id, { name: "Gran's", ...GRANS, radiusMeters: 100 })

    await uploadFixes(driver.headers, hardStopAt(GRANS))

    expect(await incidentSummaries(parent.headers, family.id)).toEqual([])
    expect(await incidentSummaries(coach.headers, club.id)).toEqual([
      "Sam stopped suddenly after driving at 109 km/h",
    ])
  })

  it("still raises the alert for the same stop well clear of any place", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    await createPlace(driver.headers, circle.id, {
      name: "Gran's",
      ...northOf(MOTORWAY, 5000),
      radiusMeters: 100,
    })

    await uploadFixes(driver.headers, hardStopAt(northOf(MOTORWAY, 5400)))

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
  })

  it("still raises the alert for a stop inside a place the size of a town", async () => {
    const { driver, watcher, circle } = await drivingFamily()
    // A place drawn round a whole town says the family is about, not where
    // they would pull up, and the bypass runs through it.
    await createPlace(driver.headers, circle.id, {
      name: "Town",
      ...northOf(MOTORWAY, 5000),
      radiusMeters: 3000,
    })

    await uploadFixes(driver.headers, hardStopAt(northOf(MOTORWAY, 5900)))

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
  })
})

describe("possible incident: a collision at every cadence the phone reports at", () => {
  it("raises the alert for a car stopped dead between two fixes of a drive", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // The driving tier, a fix every ten seconds at 100 km/h, and then the
    // next one is standing still and stays that way for six minutes.
    const run = fixesFrom(MOTORWAY, -420, 10, [27.8, 27.8, 27.8, 27.8, 27.8, 27.8])
    const last = run[run.length - 1]!
    const stoppedAt = northOf(last, 40)
    const still = Array.from({ length: 36 }, (_, i) => ({
      ...stoppedAt,
      recordedAt: at(-360 + i * 10),
      accuracyMeters: 7,
      speedMps: 0,
    }))
    await uploadFixes(driver.headers, [...run, ...still])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([
      "Sam stopped suddenly after driving at 100 km/h",
    ])
  })

  it("raises the alert for a watched phone that goes from road speed to nothing in a second", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // Live, a fix a second at 100 km/h, a reading that lags the impact, and
    // then nothing for six minutes.
    const run = fixesFrom(MOTORWAY, -400, 1, [...Array.from({ length: 30 }, () => 27.8), 6])
    const last = run[run.length - 1]!
    const still = Array.from({ length: 369 }, (_, i) => ({
      ...northOf(last, 3),
      recordedAt: at(-369 + i),
      accuracyMeters: 5,
      speedMps: 0,
    }))
    await uploadInMinutes(driver.headers, [...run, ...still])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([
      "Sam stopped suddenly after driving at 100 km/h",
    ])
  })

  it("raises the alert for a watched phone in a crash that slides to a halt", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 90 km/h, the impact, and four seconds sliding at 8, 5 and 2 m/s before
    // the car comes to rest. Four seconds from cruising speed to nothing is
    // more than any brake sheds.
    const run = fixesFrom(MOTORWAY, -400, 1, [...Array.from({ length: 30 }, () => 25), 8, 5, 2])
    const last = run[run.length - 1]!
    const still = Array.from({ length: 367 }, (_, i) => ({
      ...northOf(last, 2),
      recordedAt: at(-367 + i),
      accuracyMeters: 5,
      speedMps: 0,
    }))
    await uploadInMinutes(driver.headers, [...run, ...still])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([
      "Sam stopped suddenly after driving at 90 km/h",
    ])
  })

  it("raises the alert from just the fixes the tracker sends after a crash", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // A phone in the driving tier sends a fix every ten seconds at speed, the
    // first fix that stands still straight after, and then nothing until its
    // distance gate lets one through five minutes on.
    const run = fixesFrom(MOTORWAY, -340, 10, [27.8, 27.8, 27.8, 27.8])
    const stoppedAt = northOf(run[run.length - 1]!, 50)
    await uploadFixes(driver.headers, run)
    await uploadFixes(driver.headers, [
      { ...stoppedAt, recordedAt: at(-300), accuracyMeters: 7, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])

    await uploadFixes(driver.headers, [
      { ...stoppedAt, recordedAt: at(0), accuracyMeters: 8, speedMps: 0 },
    ])
    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([
      "Sam stopped suddenly after driving at 100 km/h",
    ])
  })
})

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
      { ...northOf(HOME, -1200), recordedAt: at(-450), accuracyMeters: 8, speedMps: 13.4 },
      { ...northOf(HOME, -800), recordedAt: at(-420), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(HOME, -480), recordedAt: at(-390), accuracyMeters: 8, speedMps: 8.0 },
      { ...northOf(HOME, -260), recordedAt: at(-360), accuracyMeters: 9, speedMps: 3.5 },
      { ...northOf(HOME, -20), recordedAt: at(-330), accuracyMeters: 9, speedMps: 1.2 },
      { ...HOME, recordedAt: at(-315), accuracyMeters: 10, speedMps: 0 },
    ])
    const jitter = [3, -2, 1, 4, -1, 2, -3, 1, 0, 2]
    for (let i = 0; i < jitter.length; i += 1) {
      await uploadFixes(driver.headers, [
        {
          ...northOf(HOME, jitter[i]!),
          recordedAt: at(-285 + i * 30),
          accuracyMeters: 12 + (i % 4),
          speedMps: 0,
        },
      ])
    }

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("quotes a speed two fixes agreed on, not the lone artefact earlier in the window", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // A real hard stop off the motorway, with one 144 km/h sample from a
    // provider switch a minute before it. The alert has to quote the 111 km/h
    // the drive actually sustained: a number no second fix ever corroborated
    // is the one thing a family cannot be told about a crash.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-420), accuracyMeters: 6, speedMps: 30.0 },
      { ...northOf(MOTORWAY, 450), recordedAt: at(-405), accuracyMeters: 6, speedMps: 40.0 },
      { ...northOf(MOTORWAY, 900), recordedAt: at(-390), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 1815), recordedAt: at(-360), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 2745), recordedAt: at(-330), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 2790), recordedAt: at(-320), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 2791), recordedAt: at(-220), accuracyMeters: 9, speedMps: 0 },
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
      { ...northOf(HOME, 0), recordedAt: at(-470), accuracyMeters: 8, speedMps: 12.5 },
      { ...northOf(HOME, 375), recordedAt: at(-440), accuracyMeters: 8, speedMps: 12.0 },
      { ...northOf(HOME, 600), recordedAt: at(-410), accuracyMeters: 8, speedMps: 9.0 },
      { ...northOf(HOME, 720), recordedAt: at(-380), accuracyMeters: 10, speedMps: 3.0 },
      { ...northOf(HOME, 765), recordedAt: at(-350), accuracyMeters: 10, speedMps: 1.5 },
      { ...northOf(HOME, 770), recordedAt: at(-335), accuracyMeters: 11, speedMps: 0.4 },
    ])

    // Five minutes at the window, then "arrived safe" from the check-in
    // screen, which reports one fix of its own.
    await uploadFixes(driver.headers, [
      {
        ...northOf(HOME, 770),
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
    // 1600 m with no speed at all, and the first of them seventy seconds on,
    // which is how long the network took to place the phone. The car stops
    // five metres past where it was and never moves again. A crash in a
    // tunnel, an underground car park or a cutting reports exactly these null
    // speeds and these error circles, so a rule that needs a well-placed fix
    // before it will believe in stillness is silent for the crashes people
    // most need telling about.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-400), accuracyMeters: 9, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 820), recordedAt: at(-330), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 824), recordedAt: at(-290), accuracyMeters: 1500, speedMps: null },
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
    // keep advancing at 27 m/s, through ten kilometres of tunnels and
    // cuttings. That beats even a 3 km error circle at every step, so this is
    // movement and stays movement.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-400), accuracyMeters: 9, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 1920), recordedAt: at(-330), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 3540), recordedAt: at(-270), accuracyMeters: 1600, speedMps: null },
      { ...northOf(MOTORWAY, 5160), recordedAt: at(-210), accuracyMeters: 1500, speedMps: null },
      { ...northOf(MOTORWAY, 6780), recordedAt: at(-150), accuracyMeters: 1400, speedMps: null },
      { ...northOf(MOTORWAY, 8400), recordedAt: at(-90), accuracyMeters: 1300, speedMps: null },
      { ...northOf(MOTORWAY, 10020), recordedAt: at(-30), accuracyMeters: 1500, speedMps: null },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("raises the alert for a hard stop in a 500 m accuracy blackspot", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 100 km/h, then stopped, on a road where the phone can only place itself
    // to within half a kilometre. The stop is measured, the stillness is not
    // measurable, and the drive it came off is not in question.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-420), accuracyMeters: 9, speedMps: 28 },
      { ...northOf(MOTORWAY, 840), recordedAt: at(-390), accuracyMeters: 9, speedMps: 28 },
      { ...northOf(MOTORWAY, 1680), recordedAt: at(-360), accuracyMeters: 12, speedMps: 27.5 },
      { ...northOf(MOTORWAY, 1685), recordedAt: at(-330), accuracyMeters: 500, speedMps: 0 },
      { ...northOf(MOTORWAY, 1684), recordedAt: at(-220), accuracyMeters: 510, speedMps: 0 },
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
      { ...northOf(HOME, 0), recordedAt: at(-420), accuracyMeters: 8, speedMps: 12.4 },
      { ...northOf(HOME, 330), recordedAt: at(-390), accuracyMeters: 9, speedMps: 10.8 },
      { ...northOf(HOME, 500), recordedAt: at(-360), accuracyMeters: 25, speedMps: 4.0 },
      { ...northOf(HOME, 520), recordedAt: at(-320), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 530), recordedAt: at(-200), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 540), recordedAt: at(-100), accuracyMeters: 1800, speedMps: null },
      { ...northOf(HOME, 515), recordedAt: at(-15), accuracyMeters: 1650, speedMps: null },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toEqual([])
  })

  it("still raises the alert for a real hard stop from motorway speed", async () => {
    const { driver, watcher, circle } = await drivingFamily()

    // 110 km/h, then the same coordinate for five minutes. The fix before the
    // stop is at full speed: nothing decelerated, the car simply stopped.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-420), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 915), recordedAt: at(-390), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 1830), recordedAt: at(-360), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-330), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-240), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-150), accuracyMeters: 9, speedMps: 0 },
      { ...northOf(MOTORWAY, 1932), recordedAt: at(-90), accuracyMeters: 11, speedMps: 0 },
      { ...northOf(MOTORWAY, 1931), recordedAt: at(-20), accuracyMeters: 10, speedMps: 0 },
    ])

    expect(await incidentSummaries(watcher.headers, circle.id)).toHaveLength(1)
  })
})
