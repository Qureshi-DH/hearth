import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The speed alert cooldown is per member per circle, so a circle that was
 * paused during a run is not inside a cooldown another circle's alert spent.
 */

// The M4 east of Bristol.
const MOTORWAY = { lat: 51.52, lon: -2.57 }

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

async function createCircle(headers: Record<string, string>, name: string) {
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

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number | null
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

const speedAlerts = async (headers: Record<string, string>, circleId: string) =>
  (await feedItems(headers, circleId)).filter((item) => item.type === "speed_alert")

async function speedPushes(userId: string) {
  const rows = (await getDb().execute(
    sql`select user_id from notification_outbox where data->>'type' = 'speed_alert'
        and user_id = ${userId}::uuid`,
  )) as unknown as Array<{ user_id: string }>
  return rows
}

/** A stretch of motorway. Positions advance by exactly the distance the speed implies. */
function run(options: {
  from: { lat: number; lon: number }
  startSecondsAgo: number
  speeds: number[]
  intervalSeconds?: number
}) {
  const interval = options.intervalSeconds ?? 30
  let metres = 0
  return options.speeds.map((speedMps, i) => {
    const point = northOf(options.from, metres)
    metres += speedMps * interval
    return {
      ...point,
      recordedAt: iso(options.startSecondsAgo + i * interval),
      accuracyMeters: 8,
      speedMps,
    }
  })
}

// 120-121 km/h, then 123-125 km/h a minute later. Both runs clear 110.
const FIRST_RUN = [33.4, 33.5, 33.6]
const SECOND_RUN = [34.2, 34.5, 34.7]

async function cast() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const carol = await registerUser(ctx.app, { displayName: "Carol" })

  const household = await createCircle(alice.headers, "Household")
  const neighbours = await createCircle(alice.headers, "Neighbours")
  await joinCircle(bob.headers, household.invite.code)
  await joinCircle(carol.headers, neighbours.invite.code)
  await setCircleSettings(alice.headers, household.id, { speedAlertKmh: 110 })
  await setCircleSettings(alice.headers, neighbours.id, { speedAlertKmh: 110 })

  return { alice, bob, carol, household, neighbours }
}

describe("speed alerts: the cooldown across a pause", () => {
  it("tells a circle about the next speeding run even if it was paused for the last one", async () => {
    const { alice, bob, carol, household, neighbours } = await cast()

    await setSharing(alice.headers, neighbours.id, "paused")

    // Eleven minutes ago, 120 km/h. Only the household may hear about it.
    await uploadFixes(
      alice.headers,
      run({ from: MOTORWAY, startSecondsAgo: -11 * 60, speeds: FIRST_RUN }),
    )
    expect(await speedAlerts(bob.headers, household.id)).toHaveLength(1)
    expect(await speedAlerts(carol.headers, neighbours.id)).toHaveLength(0)

    // She turns sharing back on with the neighbours, precisely.
    await setSharing(alice.headers, neighbours.id, "precise")

    // A minute later, still on the motorway, now at 125 km/h. The neighbours
    // shared precisely for the whole of this run and have not been told about
    // her driving yet.
    await uploadFixes(
      alice.headers,
      run({ from: northOf(MOTORWAY, 3010), startSecondsAgo: -9 * 60, speeds: SECOND_RUN }),
    )

    expect(await speedAlerts(carol.headers, neighbours.id)).toHaveLength(1)
    expect(await speedPushes(carol.user.id)).toHaveLength(1)
  })

  it("keeps the second run silent for both circles when nobody was paused", async () => {
    const { alice, bob, carol, household, neighbours } = await cast()

    await uploadFixes(
      alice.headers,
      run({ from: MOTORWAY, startSecondsAgo: -11 * 60, speeds: FIRST_RUN }),
    )
    expect(await speedAlerts(bob.headers, household.id)).toHaveLength(1)
    expect(await speedAlerts(carol.headers, neighbours.id)).toHaveLength(1)

    await uploadFixes(
      alice.headers,
      run({ from: northOf(MOTORWAY, 3010), startSecondsAgo: -9 * 60, speeds: SECOND_RUN }),
    )

    // One alert per drive: a circle that has already been told about this drive
    // must not be told again a minute later.
    expect(await speedAlerts(bob.headers, household.id)).toHaveLength(1)
    expect(await speedAlerts(carol.headers, neighbours.id)).toHaveLength(1)
  })

  it("tells the resumed circle about a run after the cooldown expires", async () => {
    const { alice, carol, neighbours } = await cast()

    await setSharing(alice.headers, neighbours.id, "paused")
    await uploadFixes(
      alice.headers,
      run({ from: MOTORWAY, startSecondsAgo: -11 * 60, speeds: FIRST_RUN }),
    )
    await setSharing(alice.headers, neighbours.id, "precise")

    // Age the latch by 31 minutes rather than sleeping for them.
    await getDb().execute(
      sql`update user_presence set speed_alerted_at = now() - interval '31 minutes'
          where user_id = ${alice.user.id}::uuid`,
    )

    await uploadFixes(
      alice.headers,
      run({ from: northOf(MOTORWAY, 3010), startSecondsAgo: -4 * 60, speeds: SECOND_RUN }),
    )

    // An aged member-wide window releases every circle at once, so this is the
    // one alert it should be and not a second one on top of it.
    expect(await speedAlerts(carol.headers, neighbours.id)).toHaveLength(1)
  })
})
