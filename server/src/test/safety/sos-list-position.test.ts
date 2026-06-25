import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { registerUser, startTestApp, type TestContext } from "../helpers"

// A terraced street in Bedminster, Bristol, and a car park about 1.4 km north.
const HOME = { lat: 51.4545, lon: -2.5879 }
const CAR_PARK = { lat: 51.4671, lon: -2.5893 }

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

const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

async function household() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: alice.headers,
    payload: { name: "Neighbours", emoji: "🏘️" },
  })
  expect(created.statusCode).toBe(201)
  const circle = created.json() as { id: string; invite: { code: string } }

  const bob = await registerUser(ctx.app, {
    displayName: "Bob",
    inviteCode: circle.invite.code,
  })
  return { alice, bob, circleId: circle.id }
}

async function uploadFix(
  headers: Record<string, string>,
  point: {
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters: number
    batteryLevel: number
    speedMps?: number
  },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points: [{ ...point, isCharging: false, source: "background" }] },
  })
  expect(response.statusCode).toBe(200)
}

async function raiseSos(headers: Record<string, string>, circleId: string, note: string | null) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: { note },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; lastLat: number | null; lastLon: number | null }
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

interface Presence {
  userId: string
  lat: number | null
  lon: number | null
  accuracyMeters: number | null
  approximate: boolean
  sharingState: string
  sosAlertId: string | null
}

async function mapView(headers: Record<string, string>, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as Presence[]
  const row = rows.find((r) => r.userId === userId)
  expect(row).toBeDefined()
  return row!
}

interface SosRow {
  id: string
  lastLat: number | null
  lastLon: number | null
  lastFixAt: string | null
  resolvedAt: string | null
}

async function activeSos(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/sos?activeOnly=true`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as SosRow[]
}

describe("the SOS list projects a position the way the map does", () => {
  it("hides an open alert's position once the raiser pauses that circle again", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, {
      ...HOME,
      recordedAt: iso(35),
      accuracyMeters: 12,
      batteryLevel: 0.41,
      speedMps: 0,
    })

    await raiseSos(alice.headers, circleId, "Someone is following me.")
    // She pauses again while the alert is still open.
    await setSharing(alice.headers, circleId, "paused")

    const seen = await mapView(bob.headers, circleId, alice.user.id)
    const [row] = await activeSos(bob.headers, circleId)

    expect(seen.sharingState).toBe("paused")
    expect(seen.lat).toBeNull()
    expect(row!.lastLat).toBeNull()
  })

  it("coarsens an open alert's position once the raiser goes approximate", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, {
      ...HOME,
      recordedAt: iso(35),
      accuracyMeters: 12,
      batteryLevel: 0.41,
      speedMps: 0,
    })

    await raiseSos(alice.headers, circleId, null)
    await setSharing(alice.headers, circleId, "approximate")

    const seen = await mapView(bob.headers, circleId, alice.user.id)
    const [row] = await activeSos(bob.headers, circleId)

    expect(seen.approximate).toBe(true)
    expect(row!.lastLat).toBe(seen.lat)
    expect(row!.lastLon).toBe(seen.lon)
  })

  it("does not follow a paused raiser's later fixes through the open alert", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, {
      ...HOME,
      recordedAt: iso(600),
      accuracyMeters: 12,
      batteryLevel: 0.41,
      speedMps: 0,
    })
    await raiseSos(alice.headers, circleId, null)
    await setSharing(alice.headers, circleId, "paused")

    // Pausing is a read-time projection, so her phone keeps uploading.
    await uploadFix(alice.headers, {
      ...CAR_PARK,
      recordedAt: iso(25),
      accuracyMeters: 9,
      batteryLevel: 0.36,
      speedMps: 0,
    })

    const seen = await mapView(bob.headers, circleId, alice.user.id)
    const [row] = await activeSos(bob.headers, circleId)

    expect(seen.lat).toBeNull()
    expect(row!.lastLat).toBeNull()
    // The map nulls recordedAt for a paused member; "seen 25 seconds ago" is
    // itself something a pause is meant to withhold.
    expect(row!.lastFixAt).toBeNull()
  })

  it("still shows the raiser her own exact position", async () => {
    const { alice, circleId } = await household()
    await uploadFix(alice.headers, {
      ...HOME,
      recordedAt: iso(35),
      accuracyMeters: 12,
      batteryLevel: 0.41,
    })
    await raiseSos(alice.headers, circleId, null)
    await setSharing(alice.headers, circleId, "paused")

    const [row] = await activeSos(alice.headers, circleId)
    expect(row!.lastLat).toBeCloseTo(HOME.lat, 5)
  })

  it("shows the circle the exact position while she is still precise", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, {
      ...HOME,
      recordedAt: iso(35),
      accuracyMeters: 12,
      batteryLevel: 0.41,
    })
    await raiseSos(alice.headers, circleId, "Fell off the bike on Ashton Road.")

    const [row] = await activeSos(bob.headers, circleId)
    expect(row!.lastLat).toBeCloseTo(HOME.lat, 5)
    expect(row!.lastLon).toBeCloseTo(HOME.lon, 5)
  })
})
