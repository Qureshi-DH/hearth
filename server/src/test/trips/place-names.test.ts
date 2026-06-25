import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A trip shown to a circle only carries place names from that circle.
 */

const CLINIC = { lat: 51.4545, lon: -2.5879 }

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

async function setSharing(headers: Headers, circleId: string, sharingState: string) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload: { sharingState },
  })
  expect(response.statusCode).toBe(200)
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

async function uploadFixes(
  headers: Headers,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number
  }>,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

/** The trips route hides anything from before the viewer's circle membership. */
async function joinedAMonthAgo(userId: string) {
  await getDb().execute(
    sql`update circle_members set created_at = now() - interval '30 days'
        where user_id = ${userId}::uuid`,
  )
}

/**
 * A drive that starts inside `origin` and heads north. It finished ten minutes
 * ago, which is more than one idle gap, so the detector treats it as closed.
 */
function driveFrom(origin: { lat: number; lon: number }) {
  const start = Date.now() - 20 * 60 * 1000
  return Array.from({ length: 20 }, (_, i) => ({
    ...northOf(origin, i * 300),
    recordedAt: new Date(start + i * 30 * 1000).toISOString(),
    accuracyMeters: 8,
    speedMps: 10,
  }))
}

async function tripsAsSeenBy(headers: Headers, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/members/${userId}/trips`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    startPlaceName: string | null
    endPlaceName: string | null
    startLat: number
    startLon: number
  }>
}

/**
 * Alice is in two circles. Neighbours holds people she keeps at arm's length,
 * Household holds Carol and sees everything.
 */
async function household() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const carol = await registerUser(ctx.app, { displayName: "Carol" })

  const neighbours = await createCircle(alice.headers, "Neighbours")
  const home = await createCircle(alice.headers, "Household")
  await joinCircle(bob.headers, neighbours.invite.code)
  await joinCircle(carol.headers, home.invite.code)

  return { alice, bob, carol, neighbours: neighbours.id, home: home.id }
}

describe("trip place names", () => {
  it("names a place the viewing circle owns", async () => {
    const { alice, carol, home } = await household()
    await addPlace(alice.headers, home, "Home", CLINIC, 150)
    await joinedAMonthAgo(alice.user.id)

    await uploadFixes(alice.headers, driveFrom(CLINIC))
    const report = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(report.tripsDetected).toBe(1)

    const [trip] = await tripsAsSeenBy(carol.headers, home, alice.user.id)
    expect(trip).toBeDefined()
    expect(trip!.startPlaceName).toBe("Home")
  })

  it("does not borrow the label another circle gave that address", async () => {
    const { alice, carol, neighbours, home } = await household()
    // The label exists only in the circle she shares approximately with, and
    // the Household has no place of its own at that address.
    await addPlace(alice.headers, neighbours, "Recovery Clinic", CLINIC, 150)
    await setSharing(alice.headers, neighbours, "approximate")
    await joinedAMonthAgo(alice.user.id)

    await uploadFixes(alice.headers, driveFrom(CLINIC))
    const report = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(report.tripsDetected).toBe(1)

    const [trip] = await tripsAsSeenBy(carol.headers, home, alice.user.id)
    expect(trip).toBeDefined()
    // The Household is entitled to the coordinates. It is not entitled to a
    // name written inside a circle it is not a member of.
    expect(trip!.startLat).toBeCloseTo(CLINIC.lat, 4)
    expect(trip!.startPlaceName).toBeNull()
  })

  it("does not borrow the label even when both circles see her precisely", async () => {
    const { alice, carol, neighbours, home } = await household()
    await addPlace(alice.headers, neighbours, "Recovery Clinic", CLINIC, 150)
    await joinedAMonthAgo(alice.user.id)

    await uploadFixes(alice.headers, driveFrom(CLINIC))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [trip] = await tripsAsSeenBy(carol.headers, home, alice.user.id)
    expect(trip).toBeDefined()
    expect(trip!.startPlaceName).toBeNull()
  })

  it("does not hand the Household a name a neighbour wrote", async () => {
    const { alice, bob, carol, neighbours, home } = await household()
    // Bob, not Alice, is the author of the label, and Bob is not in the
    // Household at all.
    await addPlace(bob.headers, neighbours, "Alice's rehab", CLINIC, 150)
    await joinedAMonthAgo(alice.user.id)

    await uploadFixes(alice.headers, driveFrom(CLINIC))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [trip] = await tripsAsSeenBy(carol.headers, home, alice.user.id)
    expect(trip).toBeDefined()
    expect(trip!.startPlaceName).toBeNull()
  })

  it("still names the Household's own place when another circle also labels that address", async () => {
    const { alice, carol, neighbours, home } = await household()
    // Two circles label the same address. The detector stores one id, picked
    // from an unordered scan of every place Alice can see, so which label the
    // trip ends up carrying is not the viewer's to decide.
    await addPlace(alice.headers, neighbours, "Recovery Clinic", CLINIC, 150)
    await addPlace(alice.headers, home, "Home", CLINIC, 150)
    await joinedAMonthAgo(alice.user.id)

    await uploadFixes(alice.headers, driveFrom(CLINIC))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [trip] = await tripsAsSeenBy(carol.headers, home, alice.user.id)
    expect(trip).toBeDefined()
    expect(trip!.startPlaceName).toBe("Home")
  })

  it("uses her own circle's label when she reads her own trip", async () => {
    const { alice, neighbours } = await household()
    await addPlace(alice.headers, neighbours, "Recovery Clinic", CLINIC, 150)

    await uploadFixes(alice.headers, driveFrom(CLINIC))
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/trips",
      headers: alice.headers,
    })
    expect(response.statusCode).toBe(200)
    const [mine] = response.json() as Array<{ startPlaceName: string | null }>
    expect(mine).toBeDefined()
    // She is in the Neighbours circle, so her own view of her own trip is
    // allowed to use its label.
    expect(mine!.startPlaceName).toBe("Recovery Clinic")
  })
})
