import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, silentSinceLastFix, startTestApp, type TestContext } from "../helpers"

/**
 * One realistic positive case for every alert the server raises. The rest of
 * the suite mostly checks that alerts stay quiet when they should, and a change
 * that silences a false alarm by silencing the true one is worse than the bug.
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

/** A house on a residential street in Bristol, and the M32 north of it. */
const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4638, lon: -2.5871 }
const MOTORWAY = { lat: 51.5017, lon: -2.558 }

const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

interface LatLon {
  lat: number
  lon: number
}

function offset(origin: LatLon, northMetres: number, eastMetres: number): LatLon {
  return {
    lat: origin.lat + northMetres / M_PER_DEG_LAT,
    lon: origin.lon + eastMetres / metresPerDegreeLon(origin.lat),
  }
}

const northOf = (origin: LatLon, metres: number) => offset(origin, metres, 0)

/** Seconds before now, the way a fix's recordedAt reaches the server. */
const at = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000

interface Fix extends LatLon {
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number | null
  batteryLevel?: number
  isCharging?: boolean
}

// ---------------------------------------------------------------------------
// The HTTP surface, as a phone and a family member would use it
// ---------------------------------------------------------------------------

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

async function createPlace(
  headers: Record<string, string>,
  circleId: string,
  place: LatLon & { name: string; radiusMeters: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: {
      name: place.name,
      lat: place.lat,
      lon: place.lon,
      radiusMeters: place.radiusMeters,
      icon: "school",
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; name: string }
}

/** A second signed-in device on an account that already exists. */
async function signInDevice(email: string, deviceId: string, deviceName: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName, platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
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

interface FeedItem {
  type: string
  summary: string
  occurredAt: string
  payload: Record<string, unknown>
}

async function feedItems(headers: Record<string, string>, circleId: string): Promise<FeedItem[]> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { items: FeedItem[] }).items
}

async function eventsOfType(headers: Record<string, string>, circleId: string, type: string) {
  return (await feedItems(headers, circleId)).filter((item) => item.type === type)
}

interface PushRow {
  user_id: string
  title: string
  body: string
  channel: string
  priority: string
  data: Record<string, unknown>
}

/** The queued pushes for one alert type, which is what a phone would buzz for. */
async function pushesOfType(type: string): Promise<PushRow[]> {
  return (await getDb().execute(
    sql`select user_id, title, body, channel, priority, data
        from notification_outbox
        where data->>'type' = ${type}
        order by created_at`,
  )) as unknown as PushRow[]
}

/** Every push queued so far, for the rule that payloads carry no coordinates. */
async function allPushes(): Promise<PushRow[]> {
  return (await getDb().execute(
    sql`select user_id, title, body, channel, priority, data
        from notification_outbox order by created_at`,
  )) as unknown as PushRow[]
}

/**
 * A push must not let a reader reconstruct where somebody is. Coordinates are
 * the obvious form of that, so no key anywhere in a payload may hold one.
 */
function expectNoCoordinates(pushes: PushRow[]) {
  for (const push of pushes) {
    const keys = Object.keys(push.data ?? {}).map((key) => key.toLowerCase())
    for (const key of keys) {
      expect(key).not.toMatch(/lat|lon|lng|coord/)
    }
  }
}

async function mapMembers(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    userId: string
    atPlace: { id: string; name: string } | null
  }>
}

async function activeSosAlerts(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/sos?activeOnly=true`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ id: string; resolvedAt: string | null }>
}

const tick = () => runJobs(getDb(), getConfig(), ctx.app.log)

// ---------------------------------------------------------------------------
// 1. A real crash
// ---------------------------------------------------------------------------

describe("possible_incident fires for a real crash", () => {
  it("tells a circle sharing precisely, once, about a hard stop from motorway speed", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Sam", deviceId: "sam-phone" })
    const circle = await createCircle(driver.headers, "Family")
    await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
    const watcher = await registerUser(ctx.app, { displayName: "Watcher" })
    await joinCircle(watcher.headers, circle.invite.code)

    // 110 km/h north up the M32, then a stop, then three and a half minutes on
    // the same coordinate. Fixes 30 s apart, the tracker's minimum interval,
    // and GPS accuracies a handset returns on an open motorway.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-300), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 915), recordedAt: at(-270), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 1830), recordedAt: at(-240), accuracyMeters: 7, speedMps: 30.2 },
      { ...northOf(MOTORWAY, 1930), recordedAt: at(-210), accuracyMeters: 9, speedMps: 0 },
    ])

    // The phone is upright and still reporting, so the fixes keep coming from
    // the same spot. Each is its own request, the way the tracker sends them.
    for (const seconds of [-150, -90, -45, -15]) {
      await uploadFixes(driver.headers, [
        { ...northOf(MOTORWAY, 1930), recordedAt: at(seconds), accuracyMeters: 9, speedMps: 0 },
      ])
    }

    const raised = await eventsOfType(watcher.headers, circle.id, "possible_incident")
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload.fromSpeedKmh).toBe(111)
    expect(raised[0]!.summary).toBe("Sam stopped suddenly after driving at 111 km/h")

    // One push, to the watcher rather than to Sam, on the channel that gets
    // through a muted circle.
    const pushes = await pushesOfType("possible_incident")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(watcher.user.id)
    expect(pushes[0]!.channel).toBe("sos")
    expect(pushes[0]!.priority).toBe("high")
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// 2. A real arrival, and the departure an hour later
// ---------------------------------------------------------------------------

describe("place_arrive and place_leave fire for a real visit", () => {
  it("announces the arrival once when the car pulls into a 150 m fence", async () => {
    const kid = await registerUser(ctx.app, { displayName: "Kid", deviceId: "kid-phone" })
    const circle = await createCircle(kid.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)
    const school = await createPlace(parent.headers, circle.id, {
      ...SCHOOL,
      name: "School",
      radiusMeters: 150,
    })

    // Down the road at 30 km/h, through the gate, and parked. The last fixes
    // are 60 s apart because the tracker's distance filter holds uploads back
    // once the car stops moving.
    await uploadFixes(kid.headers, [
      { ...northOf(SCHOOL, -620), recordedAt: at(-330), accuracyMeters: 8, speedMps: 8.3 },
      { ...northOf(SCHOOL, -370), recordedAt: at(-300), accuracyMeters: 8, speedMps: 8.3 },
      { ...northOf(SCHOOL, -120), recordedAt: at(-270), accuracyMeters: 9, speedMps: 8.3 },
      { ...northOf(SCHOOL, -30), recordedAt: at(-240), accuracyMeters: 9, speedMps: 1.2 },
      { ...northOf(SCHOOL, -25), recordedAt: at(-180), accuracyMeters: 11, speedMps: 0 },
      { ...northOf(SCHOOL, -25), recordedAt: at(-120), accuracyMeters: 11, speedMps: 0 },
      { ...northOf(SCHOOL, -24), recordedAt: at(-60), accuracyMeters: 12, speedMps: 0 },
    ])

    const arrivals = await eventsOfType(parent.headers, circle.id, "place_arrive")
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]!.summary).toBe("Kid arrived at School")
    expect(arrivals[0]!.payload.placeId).toBe(school.id)

    const pushes = await pushesOfType("place_arrive")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(parent.user.id)
    expect(pushes[0]!.body).toBe("Kid arrived at School")
    expectNoCoordinates(await allPushes())

    // And the map agrees with the feed.
    const members = await mapMembers(parent.headers, circle.id)
    const shown = members.find((member) => member.userId === kid.user.id)
    expect(shown?.atPlace?.name).toBe("School")
  })

  it("announces the departure once when they drive away an hour later", async () => {
    const kid = await registerUser(ctx.app, { displayName: "Kid", deviceId: "kid-phone" })
    const circle = await createCircle(kid.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)
    await createPlace(parent.headers, circle.id, {
      ...SCHOOL,
      name: "School",
      radiusMeters: 150,
    })

    // Arrives at the fence eighty five minutes ago and parks. This batch is
    // uploaded as the phone would have uploaded it then, so by the time the
    // test's wall clock sees it the crossing is history and gets a feed line
    // rather than a buzz. That is the backlog rule doing its job, not the
    // arrival being lost.
    const arrival: Fix[] = [
      { ...northOf(SCHOOL, -620), recordedAt: at(-88 * 60), accuracyMeters: 8, speedMps: 8.3 },
      { ...northOf(SCHOOL, -370), recordedAt: at(-87 * 60), accuracyMeters: 8, speedMps: 8.3 },
      { ...northOf(SCHOOL, -120), recordedAt: at(-86 * 60), accuracyMeters: 9, speedMps: 8.3 },
      { ...northOf(SCHOOL, -25), recordedAt: at(-85 * 60), accuracyMeters: 9, speedMps: 0 },
    ]
    // Twenty minutes parked, reporting every five minutes from the same spot.
    const stay: Fix[] = [20, 15, 10, 5, 0].map((remaining) => ({
      ...northOf(SCHOOL, -25),
      recordedAt: at(-(65 + remaining) * 60),
      accuracyMeters: 12,
      speedMps: 0,
    }))
    await uploadFixes(kid.headers, [...arrival, ...stay])

    expect(await eventsOfType(parent.headers, circle.id, "place_arrive")).toHaveLength(1)
    expect(await eventsOfType(parent.headers, circle.id, "place_leave")).toHaveLength(0)

    // An hour later the car pulls out and drives off. Leaving needs the radius
    // plus the exit buffer cleared, so this run gets properly clear of it.
    await uploadFixes(kid.headers, [
      { ...northOf(SCHOOL, -30), recordedAt: at(-240), accuracyMeters: 10, speedMps: 2.5 },
      { ...northOf(SCHOOL, -260), recordedAt: at(-210), accuracyMeters: 9, speedMps: 8.3 },
      { ...northOf(SCHOOL, -510), recordedAt: at(-180), accuracyMeters: 9, speedMps: 8.3 },
      { ...northOf(SCHOOL, -760), recordedAt: at(-150), accuracyMeters: 8, speedMps: 8.3 },
      { ...northOf(SCHOOL, -1010), recordedAt: at(-120), accuracyMeters: 8, speedMps: 8.3 },
    ])

    const arrivals = await eventsOfType(parent.headers, circle.id, "place_arrive")
    const departures = await eventsOfType(parent.headers, circle.id, "place_leave")
    expect(arrivals).toHaveLength(1)
    expect(departures).toHaveLength(1)
    expect(departures[0]!.summary).toBe("Kid left School")
    // The departure is the news, and it is fresh, so it also buzzes.
    const pushes = await pushesOfType("place_leave")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(parent.user.id)
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// 3. A real departure from home in the morning
// ---------------------------------------------------------------------------

describe("place_leave fires for the morning departure from home", () => {
  it("announces one departure when the phone that was at home drives off", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen", deviceId: "teen-phone" })
    const circle = await createCircle(teen.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)

    // Asleep at home. The fence is drawn around a phone that is already inside
    // it, so priming records the membership without announcing an arrival.
    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: at(-40 * 60), accuracyMeters: 14, speedMps: 0, batteryLevel: 0.91 },
    ])
    await createPlace(parent.headers, circle.id, { ...HOME, name: "Home", radiusMeters: 150 })
    expect(await eventsOfType(parent.headers, circle.id, "place_arrive")).toHaveLength(0)

    // Out of the door and down the road at 30 km/h.
    await uploadFixes(teen.headers, [
      { ...northOf(HOME, 40), recordedAt: at(-330), accuracyMeters: 12, speedMps: 1.4 },
      { ...northOf(HOME, 190), recordedAt: at(-300), accuracyMeters: 10, speedMps: 6.0 },
      { ...northOf(HOME, 440), recordedAt: at(-270), accuracyMeters: 9, speedMps: 8.3 },
      { ...northOf(HOME, 690), recordedAt: at(-240), accuracyMeters: 9, speedMps: 8.3 },
      { ...northOf(HOME, 940), recordedAt: at(-210), accuracyMeters: 8, speedMps: 8.3 },
    ])

    const departures = await eventsOfType(parent.headers, circle.id, "place_leave")
    expect(departures).toHaveLength(1)
    expect(departures[0]!.summary).toBe("Teen left Home")

    const pushes = await pushesOfType("place_leave")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(parent.user.id)

    // And they are no longer shown at Home on the map.
    const members = await mapMembers(parent.headers, circle.id)
    expect(members.find((member) => member.userId === teen.user.id)?.atPlace).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. A real speeding run
// ---------------------------------------------------------------------------

describe("speed_alert fires for a real speeding run", () => {
  it("announces 140 km/h held across several consecutive fixes, once", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen", deviceId: "teen-phone" })
    const circle = await createCircle(teen.headers, "Family")
    await setCircleSettings(teen.headers, circle.id, { speedAlertKmh: 120 })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)

    // Five fixes 30 s apart at a shade under and over 140 km/h. Doppler noise
    // of a few tenths is what a real receiver returns, and the positions move
    // at the speeds the fixes claim.
    const speeds = [38.7, 38.9, 39.1, 38.8, 39.0]
    let metres = 0
    await uploadFixes(
      teen.headers,
      speeds.map((speedMps, i) => {
        if (i > 0) metres += speeds[i - 1]! * 30
        return {
          ...northOf(MOTORWAY, metres),
          recordedAt: at(-30 * (speeds.length - i) - 20),
          accuracyMeters: 7,
          speedMps,
        }
      }),
    )

    const alerts = await eventsOfType(parent.headers, circle.id, "speed_alert")
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.summary).toBe("Teen was driving at 141 km/h")
    expect(alerts[0]!.payload.speedKmh).toBe(141)
    expect(alerts[0]!.payload.thresholdKmh).toBe(120)

    const pushes = await pushesOfType("speed_alert")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(parent.user.id)
    expect(pushes[0]!.body).toBe("Teen was driving at 141 km/h.")
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// 5. A real trip
// ---------------------------------------------------------------------------

describe("trip_completed fires for a real commute", () => {
  it("records the 20 minute, 12 km drive with sane distance, duration and speeds", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "aisha-phone" })
    const circle = await createCircle(driver.headers, "Family")
    const partner = await registerUser(ctx.app, { displayName: "Partner" })
    await joinCircle(partner.headers, circle.invite.code)

    // Out of the estate at 22 km/h, along the A road at 40, a faster stretch
    // at 47, then slowing into the office car park. Fixes every 30 s, the
    // interval this server asks clients for, and each step moves exactly the
    // ground its speed implies: forty intervals, 1200 seconds, 12 km.
    const intervalSeconds = 30
    const legs: Array<{ count: number; speedMps: number }> = [
      { count: 4, speedMps: 6 },
      { count: 12, speedMps: 11 },
      { count: 16, speedMps: 13 },
      { count: 6, speedMps: 5 },
      { count: 2, speedMps: 3 },
    ]
    const speeds = legs.flatMap((leg) => Array.from({ length: leg.count }, () => leg.speedMps))
    const startMs = minutesAgo(30)
    let metres = 0
    const fixes: Fix[] = [
      {
        ...northOf(HOME, 0),
        recordedAt: new Date(startMs).toISOString(),
        accuracyMeters: 9,
        speedMps: speeds[0]!,
      },
      ...speeds.map((speedMps, i) => {
        metres += speedMps * intervalSeconds
        return {
          ...northOf(HOME, metres),
          recordedAt: new Date(startMs + (i + 1) * intervalSeconds * 1000).toISOString(),
          accuracyMeters: 9,
          speedMps,
        }
      }),
    ]
    expect(metres).toBe(12_000)
    await uploadFixes(driver.headers, fixes)

    await tick()

    const completed = await eventsOfType(partner.headers, circle.id, "trip_completed")
    expect(completed).toHaveLength(1)
    expect(completed[0]!.summary).toBe("Aisha travelled 12.0 km")
    expect(completed[0]!.payload.durationSeconds).toBe(1200)
    expect(completed[0]!.payload.distanceMeters as number).toBeGreaterThan(11_990)
    expect(completed[0]!.payload.distanceMeters as number).toBeLessThan(12_010)

    // The stored trip carries the same numbers, and the speeds are the ones
    // the drive was actually done at rather than a spike.
    const trips = (await ctx.app
      .inject({
        method: "GET",
        url: "/api/v1/me/trips",
        headers: driver.headers,
      })
      .then((response) => {
        expect(response.statusCode).toBe(200)
        return response.json()
      })) as Array<{
      distanceMeters: number
      durationSeconds: number
      maxSpeedMps: number | null
      avgSpeedMps: number | null
      pointCount: number
    }>
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(41)
    expect(trips[0]!.durationSeconds).toBe(1200)
    // 13 m/s is the fastest stretch two consecutive fixes agree on, and the
    // average is the 12 km over the 20 minutes it took.
    expect(trips[0]!.maxSpeedMps!).toBeCloseTo(13, 2)
    expect(trips[0]!.avgSpeedMps!).toBeCloseTo(10, 1)
    expect(trips[0]!.avgSpeedMps!).toBeLessThanOrEqual(trips[0]!.maxSpeedMps!)

    const pushes = await pushesOfType("trip_completed")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(partner.user.id)
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// 6. A real low battery
// ---------------------------------------------------------------------------

describe("low_battery fires as the phone drains", () => {
  it("announces the drop past 15 percent, and tells a stricter circle at its own threshold", async () => {
    const user = await registerUser(ctx.app, { displayName: "Nan", deviceId: "nan-phone" })
    const family = await createCircle(user.headers, "Family")
    const carers = await createCircle(user.headers, "Carers")
    await setCircleSettings(user.headers, family.id, { lowBatteryThreshold: 0.15 })
    await setCircleSettings(user.headers, carers.id, { lowBatteryThreshold: 0.05 })

    // An afternoon of ordinary readings from a phone in a handbag.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: at(-900), accuracyMeters: 14, batteryLevel: 0.31, isCharging: false },
      { ...HOME, recordedAt: at(-600), accuracyMeters: 14, batteryLevel: 0.22, isCharging: false },
    ])
    expect(await eventsOfType(user.headers, family.id, "low_battery")).toHaveLength(0)

    // It crosses 15%.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: at(-420), accuracyMeters: 14, batteryLevel: 0.13, isCharging: false },
    ])

    const familyLow = await eventsOfType(user.headers, family.id, "low_battery")
    expect(familyLow).toHaveLength(1)
    expect(familyLow[0]!.summary).toBe("Battery at 13%")
    // The stricter circle has not been reached yet, so it hears nothing.
    expect(await eventsOfType(user.headers, carers.id, "low_battery")).toHaveLength(0)

    // The drain continues past the stricter threshold.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: at(-240), accuracyMeters: 14, batteryLevel: 0.09, isCharging: false },
      { ...HOME, recordedAt: at(-60), accuracyMeters: 14, batteryLevel: 0.04, isCharging: false },
    ])

    const carersLow = await eventsOfType(user.headers, carers.id, "low_battery")
    expect(carersLow).toHaveLength(1)
    expect(carersLow[0]!.summary).toBe("Battery at 4%")
    // And the circle already told stays told once, rather than once per fix.
    expect(await eventsOfType(user.headers, family.id, "low_battery")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 7. A real phone going quiet, and coming back
// ---------------------------------------------------------------------------

describe("device_offline and device_online fire for a real outage", () => {
  it("announces the phone quiet for over an hour once, and its return once", async () => {
    const kid = await registerUser(ctx.app, { displayName: "Kid", deviceId: "kid-phone" })
    const circle = await createCircle(kid.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)

    // Last heard from seventy minutes ago on a dwindling battery.
    await uploadFixes(kid.headers, [
      { ...HOME, recordedAt: at(-70 * 60), accuracyMeters: 14, batteryLevel: 0.22 },
    ])
    await silentSinceLastFix(kid.user.id)

    const first = await tick()
    expect(first.offlineFlagged).toBe(1)
    // Three sweeps, because the outage lasting must not mean saying it again.
    await tick()
    await tick()

    const offline = await eventsOfType(parent.headers, circle.id, "device_offline")
    expect(offline).toHaveLength(1)
    expect(offline[0]!.summary).toBe("Kid's phone stopped reporting")

    const pushes = await pushesOfType("device_offline")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(parent.user.id)
    expect(pushes[0]!.channel).toBe("alerts")

    // Charged and back on wifi.
    await uploadFixes(kid.headers, [
      { ...HOME, recordedAt: at(-45), accuracyMeters: 12, batteryLevel: 0.74, isCharging: true },
    ])
    await tick()
    await tick()

    const online = await eventsOfType(parent.headers, circle.id, "device_online")
    expect(online).toHaveLength(1)
    expect(online[0]!.summary).toBe("Kid's phone is reporting again")
    // Still exactly one outage on record, not a second one.
    expect(await eventsOfType(parent.headers, circle.id, "device_offline")).toHaveLength(1)
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// 8. A real SOS, raised and resolved
// ---------------------------------------------------------------------------

describe("sos_started and sos_resolved fire for a real emergency", () => {
  it("reaches every other member at top priority, and closes when it is resolved", async () => {
    const raiser = await registerUser(ctx.app, { displayName: "Aisha", deviceId: "aisha-phone" })
    const circle = await createCircle(raiser.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const sibling = await registerUser(ctx.app, { displayName: "Sibling" })
    await joinCircle(parent.headers, circle.invite.code)
    await joinCircle(sibling.headers, circle.invite.code)

    await uploadFixes(raiser.headers, [
      { ...HOME, recordedAt: at(-60), accuracyMeters: 10, speedMps: 0, batteryLevel: 0.44 },
    ])

    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: raiser.headers,
      payload: { note: "Car broke down on the A38." },
    })
    expect(raised.statusCode).toBe(201)
    const alert = raised.json() as { id: string; notifiedMembers: number }
    expect(alert.notifiedMembers).toBe(2)

    const started = await eventsOfType(parent.headers, circle.id, "sos_started")
    expect(started).toHaveLength(1)
    expect(started[0]!.summary).toBe("Aisha raised an SOS")

    const startPushes = await pushesOfType("sos_started")
    expect(startPushes.map((push) => push.user_id).sort()).toEqual(
      [parent.user.id, sibling.user.id].sort(),
    )
    for (const push of startPushes) {
      expect(push.channel).toBe("sos")
      expect(push.priority).toBe("high")
      expect(push.title).toBe("🚨 SOS from Aisha")
    }

    // It shows as active until somebody closes it.
    expect(await activeSosAlerts(parent.headers, circle.id)).toHaveLength(1)

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${alert.id}/resolve`,
      headers: raiser.headers,
    })
    expect(resolved.statusCode).toBe(200)

    const closed = await eventsOfType(parent.headers, circle.id, "sos_resolved")
    expect(closed).toHaveLength(1)
    expect(closed[0]!.summary).toBe("Aisha marked the SOS as resolved")
    // The person who resolved it hears about it too, which is the one case
    // where the actor is not excluded from their own alert.
    expect((await pushesOfType("sos_resolved")).map((push) => push.user_id).sort()).toEqual(
      [parent.user.id, raiser.user.id, sibling.user.id].sort(),
    )

    expect(await activeSosAlerts(parent.headers, circle.id)).toHaveLength(0)
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// 9. A real nudge, and a real check-in
// ---------------------------------------------------------------------------

describe("nudge_requested fires for a real nudge", () => {
  it("delivers the quick message to the one person it is aimed at", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const circle = await createCircle(parent.headers, "Family")
    const teen = await registerUser(ctx.app, { displayName: "Teen", deviceId: "teen-phone" })
    const sibling = await registerUser(ctx.app, { displayName: "Sibling" })
    await joinCircle(teen.headers, circle.invite.code)
    await joinCircle(sibling.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: at(-120), accuracyMeters: 12, speedMps: 0, batteryLevel: 0.5 },
    ])

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${teen.user.id}`,
      headers: parent.headers,
      payload: { quickKey: "call_me" },
    })
    expect(response.statusCode).toBe(200)

    const nudges = await eventsOfType(teen.headers, circle.id, "nudge_requested")
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.summary).toBe("Parent: Call me when you can.")
    expect(nudges[0]!.payload.targetUserId).toBe(teen.user.id)

    // Only the teen is buzzed. The sibling is in the circle and hears nothing.
    const pushes = await pushesOfType("nudge_requested")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(teen.user.id)
    expect(pushes[0]!.title).toBe("Parent")
    expect(pushes[0]!.body).toBe("Call me when you can.")
    expect(pushes[0]!.priority).toBe("high")
    expectNoCoordinates(await allPushes())
  })
})

describe("check_in fires for a real check-in", () => {
  it("names the place they checked in at and tells the rest of the circle", async () => {
    const kid = await registerUser(ctx.app, { displayName: "Kid", deviceId: "kid-phone" })
    const circle = await createCircle(kid.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)
    await createPlace(parent.headers, circle.id, {
      ...SCHOOL,
      name: "School",
      radiusMeters: 150,
    })

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: kid.headers,
      payload: { ...northOf(SCHOOL, -20), note: "Made it" },
    })
    expect(response.statusCode).toBe(201)

    const checkIns = await eventsOfType(parent.headers, circle.id, "check_in")
    expect(checkIns).toHaveLength(1)
    expect(checkIns[0]!.summary).toBe("Kid checked in at School")

    const pushes = await pushesOfType("check_in")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(parent.user.id)
    expectNoCoordinates(await allPushes())
  })
})

// ---------------------------------------------------------------------------
// The same alerts, with a second device signed in to the account
//
// A household tablet on a charger reports all day. Every fix in this section
// is one a real pair of devices would produce, and every alert below is one
// the family is owed. This is where a fix aimed at two-device ping-pong shows
// whether it silenced the true alarm along with the false one.
// ---------------------------------------------------------------------------

describe("a tablet left at home does not silence the phone that is being carried", () => {
  it("still announces the walk out of Home and into School", async () => {
    const kid = await registerUser(ctx.app, { displayName: "Kid", deviceId: "kid-phone" })
    const circle = await createCircle(kid.headers, "Family")
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)
    const tablet = await signInDevice(kid.email, "home-tablet", "Kitchen tablet")

    // At home, asleep. The fences are drawn around a phone already inside
    // Home, so priming records that without announcing an arrival.
    await uploadFixes(kid.headers, [
      { ...HOME, recordedAt: at(-40 * 60), accuracyMeters: 14, speedMps: 0, batteryLevel: 0.88 },
    ])
    await createPlace(parent.headers, circle.id, { ...HOME, name: "Home", radiusMeters: 150 })
    await createPlace(parent.headers, circle.id, { ...SCHOOL, name: "School", radiusMeters: 150 })

    // The tablet reports from the kitchen on its own slow cadence, in between
    // the phone's uploads, and each fix is its own request as it would be.
    const tabletFix = (seconds: number): Fix => ({
      ...HOME,
      recordedAt: at(seconds),
      accuracyMeters: 22,
      speedMps: 0,
      batteryLevel: 1,
      isCharging: true,
    })

    await uploadFixes(tablet, [tabletFix(-900)])

    // The walk to school, 1 km north at about 5 km/h, uploaded fix by fix.
    const walk: Fix[] = [
      { ...northOf(HOME, 60), recordedAt: at(-800), accuracyMeters: 10, speedMps: 1.3 },
      { ...northOf(HOME, 255), recordedAt: at(-650), accuracyMeters: 10, speedMps: 1.3 },
      { ...northOf(HOME, 450), recordedAt: at(-500), accuracyMeters: 11, speedMps: 1.3 },
      { ...northOf(HOME, 645), recordedAt: at(-350), accuracyMeters: 11, speedMps: 1.3 },
      { ...northOf(HOME, 840), recordedAt: at(-200), accuracyMeters: 10, speedMps: 1.3 },
      { ...northOf(HOME, 970), recordedAt: at(-100), accuracyMeters: 9, speedMps: 1.3 },
      { ...northOf(HOME, 1022), recordedAt: at(-60), accuracyMeters: 9, speedMps: 1.3 },
      { ...northOf(HOME, 1034), recordedAt: at(-30), accuracyMeters: 12, speedMps: 0.4 },
      { ...northOf(HOME, 1034), recordedAt: at(-10), accuracyMeters: 12, speedMps: 0 },
    ]
    for (const [index, fix] of walk.entries()) {
      await uploadFixes(kid.headers, [fix])
      // The tablet keeps talking throughout, and its uploads land in between
      // the phone's, which is what two devices on their own schedules do.
      if (index === 1) await uploadFixes(tablet, [tabletFix(-640)])
      if (index === 3) await uploadFixes(tablet, [tabletFix(-340)])
    }

    const departures = await eventsOfType(parent.headers, circle.id, "place_leave")
    const arrivals = await eventsOfType(parent.headers, circle.id, "place_arrive")
    expect(departures.map((item) => item.summary)).toEqual(["Kid left Home"])
    expect(arrivals.map((item) => item.summary)).toEqual(["Kid arrived at School"])

    // Both crossings buzzed the parent, and the map ends up at School.
    expect(await pushesOfType("place_leave")).toHaveLength(1)
    expect(await pushesOfType("place_arrive")).toHaveLength(1)
    const members = await mapMembers(parent.headers, circle.id)
    expect(members.find((member) => member.userId === kid.user.id)?.atPlace?.name).toBe("School")
  })

  it("still announces a fast drive while the tablet reports zero from the kitchen", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen", deviceId: "teen-phone" })
    const circle = await createCircle(teen.headers, "Family")
    await setCircleSettings(teen.headers, circle.id, { speedAlertKmh: 120 })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    await joinCircle(parent.headers, circle.invite.code)
    const tablet = await signInDevice(teen.email, "home-tablet", "Kitchen tablet")

    const speeds = [38.7, 38.9, 39.1, 38.8, 39.0]
    let metres = 0
    const run: Fix[] = speeds.map((speedMps, i) => {
      if (i > 0) metres += speeds[i - 1]! * 30
      return {
        ...northOf(MOTORWAY, metres),
        recordedAt: at(-30 * (speeds.length - i) - 20),
        accuracyMeters: 7,
        speedMps,
      }
    })

    for (const [index, fix] of run.entries()) {
      await uploadFixes(teen.headers, [fix])
      // A charging tablet reporting a measured zero between the phone's fixes,
      // and always slightly behind them, which is the order two devices on
      // their own schedules actually produce.
      if (index === 1 || index === 3) {
        await uploadFixes(tablet, [
          {
            ...HOME,
            recordedAt: at(-30 * (speeds.length - index) - 5),
            accuracyMeters: 24,
            speedMps: 0,
            batteryLevel: 1,
            isCharging: true,
          },
        ])
      }
    }

    const alerts = await eventsOfType(parent.headers, circle.id, "speed_alert")
    expect(alerts).toHaveLength(1)
    // Told as soon as two consecutive fixes confirm the run rather than once
    // the drive is over, so the number quoted is the pair that confirmed it.
    // The point is that it is over the threshold and it is said exactly once.
    expect(alerts[0]!.payload.speedKmh).toBe(140)
    expect(alerts[0]!.summary).toBe("Teen was driving at 140 km/h")
    expect(await pushesOfType("speed_alert")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The crash whose aftermath is measured badly
// ---------------------------------------------------------------------------

describe("possible_incident survives an accuracy gate", () => {
  it("still fires when the fixes after the impact are too coarse to place a street", async () => {
    const driver = await registerUser(ctx.app, { displayName: "Sam", deviceId: "sam-phone" })
    const circle = await createCircle(driver.headers, "Family")
    await setCircleSettings(driver.headers, circle.id, { incidentDetection: true })
    const watcher = await registerUser(ctx.app, { displayName: "Watcher" })
    await joinCircle(watcher.headers, circle.invite.code)

    // 110 km/h on the motorway, then the phone ends up somewhere with no sky:
    // wedged in a footwell, or the car on its side against an embankment. The
    // platform stops offering a speed at all and the fixes come back from the
    // cell network with accuracies in the hundreds of metres. The car has not
    // moved, and the last thing anybody measured was motorway speed.
    await uploadFixes(driver.headers, [
      { ...northOf(MOTORWAY, 0), recordedAt: at(-290), accuracyMeters: 6, speedMps: 30.5 },
      { ...northOf(MOTORWAY, 915), recordedAt: at(-260), accuracyMeters: 6, speedMps: 30.9 },
      { ...northOf(MOTORWAY, 1830), recordedAt: at(-230), accuracyMeters: 7, speedMps: 30.2 },
    ])

    for (const seconds of [-200, -140, -80, -20]) {
      await uploadFixes(driver.headers, [
        {
          ...northOf(MOTORWAY, 1900),
          recordedAt: at(seconds),
          accuracyMeters: 420,
          speedMps: null,
        },
      ])
    }

    const raised = await eventsOfType(watcher.headers, circle.id, "possible_incident")
    expect(raised).toHaveLength(1)
    expect(raised[0]!.payload.fromSpeedKmh).toBe(111)

    const pushes = await pushesOfType("possible_incident")
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.user_id).toBe(watcher.user.id)
    expect(pushes[0]!.channel).toBe("sos")
    expect(pushes[0]!.priority).toBe("high")
  })
})
