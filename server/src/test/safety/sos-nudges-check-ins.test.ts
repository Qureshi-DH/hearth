import { haversineMeters } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * SOS, nudges and check-ins: what each writes to the feed and what it puts in
 * the notification outbox.
 */

// A residential street, a school and a hospital in Bristol.
const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4636, lon: -2.5952 }
const HOSPITAL = { lat: 51.4784, lon: -2.5586 }

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

async function setSharing(
  headers: Record<string, string>,
  circleId: string,
  body: { sharingState: string; pausedUntil?: string | null },
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload: body,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { sharingState: string; pausedUntil: string | null }
}

async function members(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/members`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    userId: string
    role: string
    sharingState: string
    pausedUntil: string | null
  }>
}

/** A single high-accuracy fix, the shape the tracker sends. */
async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number
    batteryLevel?: number
    isCharging?: boolean
    source?: string
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
    actor: { id: string } | null
    payload: Record<string, unknown>
  }>
}

interface OutboxRow {
  user_id: string
  circle_id: string | null
  title: string
  body: string
  data: Record<string, unknown>
  channel: string
  priority: string
}

/** Joining a circle pushes to everyone already in it. That is not our subject. */
async function clearOutbox() {
  await getDb().execute(sql`delete from notification_outbox`)
}

async function outbox(): Promise<OutboxRow[]> {
  const rows = await getDb().execute(sql`
    select user_id, circle_id, title, body, data, channel, priority
    from notification_outbox
    order by id
  `)
  return rows as unknown as OutboxRow[]
}

const COORD_KEYS = [
  "lat",
  "lon",
  "latitude",
  "longitude",
  "coords",
  "coordinates",
  "point",
  "lastLat",
  "lastLon",
  "location",
]

/**
 * A push payload leaves the server and, depending on the transport, a third
 * party. None of these alerts has any business carrying a position in one.
 */
function coordinateLeak(row: OutboxRow): string[] {
  const problems: string[] = []
  for (const key of Object.keys(row.data ?? {})) {
    if (COORD_KEYS.includes(key)) problems.push(`data.${key}`)
  }
  const blob = `${row.title} ${row.body} ${JSON.stringify(row.data ?? {})}`
  // A decimal carrying four or more places is a coordinate, not a percentage
  // or a speed.
  const decimals = blob.match(/-?\d+\.\d{4,}/g)
  if (decimals) problems.push(`decimal ${decimals.join(",")}`)
  for (const value of [HOME, SCHOOL, HOSPITAL]) {
    if (blob.includes(String(value.lat)) || blob.includes(String(value.lon))) {
      problems.push(`literal ${value.lat}`)
    }
  }
  return problems
}

function expectNoCoordinates(rows: OutboxRow[]) {
  for (const row of rows) expect([row.title, coordinateLeak(row)]).toEqual([row.title, []])
}

async function raiseSos(headers: Record<string, string>, circleId: string, note?: string | null) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: note === undefined ? {} : { note },
  })
}

async function activeSos(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/sos?activeOnly=true`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    id: string
    user: { id: string }
    lastLat: number | null
    lastLon: number | null
    resolvedAt: string | null
  }>
}

async function nudge(
  headers: Record<string, string>,
  circleId: string,
  userId: string,
  payload?: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/nudge/${userId}`,
    headers,
    ...(payload ? { payload } : {}),
  })
}

async function listCheckIns(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/check-ins`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    id: string
    user: { id: string }
    lat: number | null
    lon: number | null
    note: string | null
    placeId: string | null
    placeName: string | null
  }>
}

async function addPlace(
  headers: Record<string, string>,
  circleId: string,
  name: string,
  at: { lat: number; lon: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { name, ...at, radiusMeters: 200 },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; name: string }
}

async function checkIn(
  headers: Record<string, string>,
  circleId: string,
  at: { lat: number; lon: number },
  note?: string | null,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/check-in`,
    headers,
    payload: { ...at, note: note ?? null },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; placeName: string | null; lat: number; lon: number }
}

async function sharingStateSeenBy(
  headers: Record<string, string>,
  circleId: string,
  userId: string,
) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as Array<{ userId: string; sharingState: string }>
  return rows.find((row) => row.userId === userId)?.sharingState ?? null
}

/** A second signed-in device for an account that already exists. */
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

/** Alice owns the circle, Bob and Carol are ordinary members. */
async function household() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const carol = await registerUser(ctx.app, { displayName: "Carol" })
  const circle = await createCircle(alice.headers)
  await joinCircle(bob.headers, circle.invite.code)
  await joinCircle(carol.headers, circle.invite.code)
  await clearOutbox()
  return { alice, bob, carol, circle }
}

describe("sos", () => {
  it("raises from a paused member, un-pauses them, and tells the others exactly once", async () => {
    const { alice, bob, carol, circle } = await household()

    // Carol has muted the circle for the evening. An SOS must reach her anyway.
    const muted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/notifications`,
      headers: carol.headers,
      payload: { mutedUntil: iso(4 * 60 * 60) },
    })
    expect(muted.statusCode).toBe(200)

    await uploadFixes(bob.headers, [
      { ...SCHOOL, recordedAt: iso(-40), accuracyMeters: 12, speedMps: 0, batteryLevel: 0.41 },
    ])
    await setSharing(bob.headers, circle.id, { sharingState: "paused" })

    const response = await raiseSos(bob.headers, circle.id, "Car hit me, I'm on the pavement")
    expect(response.statusCode).toBe(201)
    const alert = response.json() as { id: string; notifiedMembers: number }
    expect(alert.notifiedMembers).toBe(2)

    const bobMember = (await members(alice.headers, circle.id)).find(
      (m) => m.userId === bob.user.id,
    )!
    expect(bobMember.sharingState).toBe("precise")
    expect(bobMember.pausedUntil).toBeNull()

    const started = (await feedItems(alice.headers, circle.id)).filter(
      (item) => item.type === "sos_started",
    )
    expect(started).toHaveLength(1)
    expect(started[0]!.summary).toBe("Bob raised an SOS")
    expect(started[0]!.payload).toMatchObject({ alertId: alert.id })

    const rows = await outbox()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set([alice.user.id, carol.user.id]))
    for (const row of rows) {
      expect(row.channel).toBe("sos")
      expect(row.priority).toBe("high")
      expect(row.title).toBe("🚨 SOS from Bob")
      expect(row.data).toMatchObject({ type: "sos_started", alertId: alert.id })
    }
    expectNoCoordinates(rows)
  })

  it("raises once when a panicked double tap arrives at the same moment", async () => {
    const { alice, bob, carol, circle } = await household()
    // His phone and his tablet, both signed into the same account.
    const tablet = await signInDevice(bob.email, "device-bob-tablet")

    const [first, second] = await Promise.all([
      raiseSos(bob.headers, circle.id, "Help"),
      raiseSos(tablet, circle.id, "Help"),
    ])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([201, 409])

    expect(await activeSos(alice.headers, circle.id)).toHaveLength(1)
    const started = (await feedItems(carol.headers, circle.id)).filter(
      (item) => item.type === "sos_started",
    )
    expect(started).toHaveLength(1)
    expect(await outbox()).toHaveLength(2)
  })

  it("lets a resolved alert be followed by a new one", async () => {
    const { alice, bob, circle } = await household()

    const first = await raiseSos(bob.headers, circle.id, "Broken down on the M32")
    expect(first.statusCode).toBe(201)
    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${first.json().id}/resolve`,
      headers: bob.headers,
    })
    expect(resolved.statusCode).toBe(200)

    const second = await raiseSos(bob.headers, circle.id, "Someone is following me")
    expect(second.statusCode).toBe(201)
    expect(second.json().id).not.toBe(first.json().id)

    const feed = await feedItems(alice.headers, circle.id)
    expect(feed.filter((item) => item.type === "sos_started")).toHaveLength(2)
    expect(feed.filter((item) => item.type === "sos_resolved")).toHaveLength(1)
    expect(await activeSos(alice.headers, circle.id)).toHaveLength(1)
  })

  it("keeps two alerts raised at the same instant apart", async () => {
    const { alice, bob, carol, circle } = await household()

    const [bobRaise, carolRaise] = await Promise.all([
      raiseSos(bob.headers, circle.id, "Fell off my bike"),
      raiseSos(carol.headers, circle.id, null),
    ])
    expect(bobRaise.statusCode).toBe(201)
    expect(carolRaise.statusCode).toBe(201)

    const active = await activeSos(alice.headers, circle.id)
    expect(active).toHaveLength(2)
    expect(new Set(active.map((a) => a.user.id))).toEqual(new Set([bob.user.id, carol.user.id]))

    const rows = await outbox()
    // Two alerts, three members: Alice hears about both, Bob and Carol about
    // each other's.
    expect(rows.filter((row) => row.user_id === alice.user.id)).toHaveLength(2)
    expect(rows.filter((row) => row.user_id === bob.user.id)).toHaveLength(1)
    expect(rows.filter((row) => row.user_id === carol.user.id)).toHaveLength(1)
    expectNoCoordinates(rows)
  })

  it("lets the owner and an admin resolve somebody else's alert, but not a plain member", async () => {
    const { alice, bob, carol, circle } = await household()

    const raised = await raiseSos(bob.headers, circle.id, "Lost")
    expect(raised.statusCode).toBe(201)
    const alertId = raised.json().id as string

    const byMember = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${alertId}/resolve`,
      headers: carol.headers,
    })
    expect(byMember.statusCode).toBe(403)
    expect(
      (await feedItems(alice.headers, circle.id)).filter((item) => item.type === "sos_resolved"),
    ).toHaveLength(0)
    expect(await activeSos(alice.headers, circle.id)).toHaveLength(1)

    const byOwner = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${alertId}/resolve`,
      headers: alice.headers,
    })
    expect(byOwner.statusCode).toBe(200)

    const resolvedEvents = (await feedItems(alice.headers, circle.id)).filter(
      (item) => item.type === "sos_resolved",
    )
    expect(resolvedEvents).toHaveLength(1)
    expect(resolvedEvents[0]!.summary).toBe("Alice marked the SOS as resolved")

    const rows = (await outbox()).filter((row) => row.data.type === "sos_resolved")
    // Everyone including the person who resolved it, so a second phone in the
    // family stops showing the alert.
    expect(new Set(rows.map((row) => row.user_id))).toEqual(
      new Set([alice.user.id, bob.user.id, carol.user.id]),
    )
    expectNoCoordinates(rows)

    // And an admin who is not the owner may resolve too.
    const promote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${carol.user.id}`,
      headers: alice.headers,
      payload: { role: "admin" },
    })
    expect(promote.statusCode).toBe(200)

    const again = await raiseSos(bob.headers, circle.id, "Lost again")
    expect(again.statusCode).toBe(201)
    const byAdmin = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${again.json().id}/resolve`,
      headers: carol.headers,
    })
    expect(byAdmin.statusCode).toBe(200)
    expect(await activeSos(alice.headers, circle.id)).toHaveLength(0)
  })

  it("resolves once when two admins tap resolve at the same moment", async () => {
    const { alice, bob, carol, circle } = await household()
    const promote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${carol.user.id}`,
      headers: alice.headers,
      payload: { role: "admin" },
    })
    expect(promote.statusCode).toBe(200)

    const raised = await raiseSos(bob.headers, circle.id, "Stuck in the lift")
    expect(raised.statusCode).toBe(201)
    const alertId = raised.json().id as string

    // Mum and Dad both see the alert clear and both tap "mark resolved".
    const results = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: `/api/v1/sos/${alertId}/resolve`,
        headers: alice.headers,
      }),
      ctx.app.inject({
        method: "POST",
        url: `/api/v1/sos/${alertId}/resolve`,
        headers: carol.headers,
      }),
    ])
    expect(results.map((r) => r.statusCode)).toEqual([200, 200])

    const resolvedEvents = (await feedItems(bob.headers, circle.id)).filter(
      (item) => item.type === "sos_resolved",
    )
    const rows = (await outbox()).filter((row) => row.data.type === "sos_resolved")
    expect({
      feedEntries: resolvedEvents.length,
      pushesToBob: rows.filter((row) => row.user_id === bob.user.id).length,
    }).toEqual({ feedEntries: 1, pushesToBob: 1 })
  })

  it("stops sharing an alert's live position with a circle the member has left", async () => {
    const { alice, bob, circle } = await household()

    await uploadFixes(bob.headers, [
      { ...SCHOOL, recordedAt: iso(-30), accuracyMeters: 9, speedMps: 0, batteryLevel: 0.62 },
    ])
    const raised = await raiseSos(bob.headers, circle.id, "Feeling unsafe")
    expect(raised.statusCode).toBe(201)

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${bob.user.id}`,
      headers: bob.headers,
    })
    expect(left.statusCode).toBe(200)

    // He cannot raise a new one in a circle he is no longer part of.
    expect((await raiseSos(bob.headers, circle.id, "Again")).statusCode).toBe(403)

    // Nor may the circle keep watching him move. The presence endpoint has
    // already forgotten him.
    await uploadFixes(bob.headers, [
      { ...HOSPITAL, recordedAt: iso(-5), accuracyMeters: 14, speedMps: 0, batteryLevel: 0.58 },
    ])
    const presence = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/locations`,
        headers: alice.headers,
      })
    ).json() as Array<{ userId: string }>
    expect(presence.map((p) => p.userId)).not.toContain(bob.user.id)

    const stillWatched = (await activeSos(alice.headers, circle.id)).filter(
      (a) => a.user.id === bob.user.id && a.lastLat !== null,
    )
    expect(stillWatched).toEqual([])
  })

  it("respects a member who re-pauses sharing while their alert is still open", async () => {
    const { alice, bob, circle } = await household()

    await uploadFixes(bob.headers, [
      { ...HOSPITAL, recordedAt: iso(-20), accuracyMeters: 11, speedMps: 0, batteryLevel: 0.33 },
    ])
    expect((await raiseSos(bob.headers, circle.id, "At A&E")).statusCode).toBe(201)
    await setSharing(bob.headers, circle.id, { sharingState: "paused" })

    const shown = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/locations`,
        headers: alice.headers,
      })
    ).json() as Array<{ userId: string; lat: number | null }>
    expect(shown.find((p) => p.userId === bob.user.id)!.lat).toBeNull()

    // The two endpoints must not disagree about whether he is sharing.
    const fromAlert = (await activeSos(alice.headers, circle.id)).find(
      (a) => a.user.id === bob.user.id,
    )!
    expect(fromAlert.lastLat).toBeNull()
  })

  it("takes the twenty second ping cadence without inventing extra alerts", async () => {
    const { alice, bob, circle } = await household()

    expect((await raiseSos(bob.headers, circle.id, "Someone followed me home")).statusCode).toBe(
      201,
    )
    const before = (await outbox()).length

    // The SOS screen calls reportNow every twenty seconds while the alert is up.
    const pings = Array.from({ length: 6 }, (_, i) => ({
      ...HOME,
      recordedAt: new Date(Date.now() - (6 - i) * 20_000).toISOString(),
      accuracyMeters: 8,
      speedMps: 1.3,
      batteryLevel: 0.47,
      source: "sos" as const,
    }))
    for (const ping of pings) {
      const result = await uploadFixes(bob.headers, [ping])
      expect(result.accepted).toBe(1)
    }

    // A retried upload of the same fixes must not be counted twice.
    const retry = await uploadFixes(bob.headers, pings)
    expect(retry.accepted).toBe(0)

    const feed = await feedItems(alice.headers, circle.id)
    expect(feed.filter((item) => item.type === "sos_started")).toHaveLength(1)
    expect(feed.filter((item) => item.type === "speed_alert")).toHaveLength(0)
    expect(feed.filter((item) => item.type === "possible_incident")).toHaveLength(0)
    expect((await outbox()).length).toBe(before)

    const seen = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: alice.headers,
        })
      ).json() as Array<{ userId: string; lat: number | null }>
    ).find((p) => p.userId === bob.user.id)!
    expect(seen.lat).toBeCloseTo(HOME.lat, 5)
  })

  it("still alerts the fourth circle when someone in several raises one everywhere", async () => {
    const kid = await registerUser(ctx.app, { displayName: "Yusuf" })
    const circleIds: string[] = []
    for (const name of ["Family", "Cousins", "Football", "Flatmates"]) {
      const owner = await registerUser(ctx.app)
      const circle = await createCircle(owner.headers, name)
      await joinCircle(kid.headers, circle.invite.code)
      circleIds.push(circle.id)
    }

    const results: Array<number | string> = []
    for (const circleId of circleIds) {
      const response = await raiseSos(kid.headers, circleId, "I need help")
      results.push(response.statusCode === 201 ? 201 : `${response.statusCode} ${response.body}`)
    }
    expect(results).toEqual([201, 201, 201, 201])
  })

  /**
   * An open alert is not a licence to read the raiser's exact position for as
   * long as it stays open. The list has to agree with the map, and the map
   * resolves a pause that has run out to the state its owner chose before it.
   */
  it("holds an open alert to the grid a lapsed pause resumes to", async () => {
    const { alice, bob, circle } = await household()
    await uploadFixes(bob.headers, [{ ...SCHOOL, recordedAt: iso(-60), accuracyMeters: 12 }])

    expect((await raiseSos(bob.headers, circle.id, "I need help")).statusCode).toBe(201)

    // He turns this circle down to the coarse grid, then takes half an hour off
    // on top of that, and it runs out while the alert is still open.
    await setSharing(bob.headers, circle.id, { sharingState: "approximate" })
    await setSharing(bob.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: iso(30 * 60),
    })
    await getDb().execute(sql`
      update circle_members
      set paused_until = now() - interval '5 minutes'
      where circle_id = ${circle.id} and user_id = ${bob.user.id}
    `)

    const [open] = await activeSos(alice.headers, circle.id)
    expect({
      mapSays: await sharingStateSeenBy(alice.headers, circle.id, bob.user.id),
      listIsExact: open!.lastLat === SCHOOL.lat && open!.lastLon === SCHOOL.lon,
      // The alert still points the circle at the right neighbourhood.
      listIsNearby:
        open!.lastLat !== null &&
        open!.lastLon !== null &&
        haversineMeters({ lat: open!.lastLat, lon: open!.lastLon }, SCHOOL) < 1500,
    }).toEqual({ mapSays: "approximate", listIsExact: false, listIsNearby: true })
  })

  /**
   * An SOS overrides the pause it was raised during. The state that pause was
   * going to resume to has to go with it, or it survives to be picked up by the
   * next pause weeks later, and an unrelated evening off ends with the circle
   * back on the coarse grid nobody chose.
   */
  it("clears the resume state it overrode, and leaves an untouched one alone", async () => {
    const { alice, bob, carol, circle } = await household()

    // Both are on the coarse grid with this circle, and both then pause.
    for (const person of [bob, carol]) {
      await setSharing(person.headers, circle.id, { sharingState: "approximate" })
      await setSharing(person.headers, circle.id, {
        sharingState: "paused",
        pausedUntil: iso(30 * 60),
      })
    }

    const raised = await raiseSos(bob.headers, circle.id, "I need help")
    expect(raised.statusCode).toBe(201)
    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${(raised.json() as { id: string }).id}/resolve`,
      headers: bob.headers,
    })
    expect(resolved.statusCode).toBe(200)

    // Weeks later, an ordinary half hour off each, and it has run out.
    for (const person of [bob, carol]) {
      await setSharing(person.headers, circle.id, {
        sharingState: "paused",
        pausedUntil: iso(30 * 60),
      })
    }
    await getDb().execute(sql`
      update circle_members
      set paused_until = now() - interval '5 minutes'
      where circle_id = ${circle.id} and user_id in (${bob.user.id}, ${carol.user.id})
    `)

    expect({
      bob: await sharingStateSeenBy(alice.headers, circle.id, bob.user.id),
      carol: await sharingStateSeenBy(alice.headers, circle.id, carol.user.id),
    }).toEqual({
      // The SOS put him on precise and nothing has moved him since.
      bob: "precise",
      // Carol never raised one, so hers still resumes where she left it.
      carol: "approximate",
    })
  })
})

describe("nudges", () => {
  it("reaches only the person it is aimed at, with the message and no position", async () => {
    const { alice, bob, carol, circle } = await household()

    const sent = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })
    expect(sent.statusCode).toBe(200)

    const feed = (await feedItems(carol.headers, circle.id)).filter(
      (item) => item.type === "nudge_requested",
    )
    expect(feed).toHaveLength(1)
    expect(feed[0]!.summary).toBe("Alice: Call me when you can.")
    expect(feed[0]!.payload).toMatchObject({
      targetUserId: bob.user.id,
      quickKey: "call_me",
      body: "Call me when you can.",
    })

    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(bob.user.id)
    expect(rows[0]!.title).toBe("Alice")
    expect(rows[0]!.body).toBe("Call me when you can.")
    expect(rows[0]!.channel).toBe("alerts")
    expect(rows[0]!.priority).toBe("high")
    expect(rows[0]!.data).toMatchObject({ type: "nudge_requested", fromUserId: alice.user.id })
    expectNoCoordinates(rows)
  })

  it("sends a bare request for a location when there is no message", async () => {
    const { alice, bob, circle } = await household()

    const sent = await nudge(alice.headers, circle.id, bob.user.id)
    expect(sent.statusCode).toBe(200)

    const feed = (await feedItems(bob.headers, circle.id)).filter(
      (item) => item.type === "nudge_requested",
    )
    expect(feed).toHaveLength(1)
    expect(feed[0]!.summary).toBe("Alice asked for a location update")

    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe("Location requested")
    expect(rows[0]!.body).toBe("Alice asked where you are.")
    expectNoCoordinates(rows)
  })

  it("refuses a nudge to yourself and records nothing", async () => {
    const { alice, circle } = await household()

    const sent = await nudge(alice.headers, circle.id, alice.user.id, { quickKey: "call_me" })
    expect(sent.statusCode).toBe(400)
    expect(await feedItems(alice.headers, circle.id)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ type: "nudge_requested" })]),
    )
    expect(await outbox()).toHaveLength(0)
  })

  it("refuses a nudge aimed at someone outside the circle", async () => {
    const { alice, circle } = await household()
    const stranger = await registerUser(ctx.app, { displayName: "Stranger" })

    const sent = await nudge(alice.headers, circle.id, stranger.user.id, { quickKey: "call_me" })
    expect(sent.statusCode).toBe(404)
    expect(await outbox()).toHaveLength(0)
  })

  it("refuses a nudge to a member who has paused sharing", async () => {
    const { alice, bob, circle } = await household()
    await setSharing(bob.headers, circle.id, { sharingState: "paused" })

    const sent = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "where_are_you" })
    expect(sent.statusCode).toBe(403)
    expect(await outbox()).toHaveLength(0)
  })

  it("nudges a member whose timed pause has already lapsed", async () => {
    const { alice, bob, circle } = await household()

    await uploadFixes(bob.headers, [
      { ...SCHOOL, recordedAt: iso(-90), accuracyMeters: 15, speedMps: 0, batteryLevel: 0.55 },
    ])
    // Bob paused for half an hour. That was thirty five minutes ago and his
    // phone has not uploaded since, which is exactly why Alice wants a nudge.
    await setSharing(bob.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: iso(30 * 60),
    })
    await getDb().execute(sql`
      update circle_members
      set paused_until = now() - interval '5 minutes'
      where circle_id = ${circle.id} and user_id = ${bob.user.id}
    `)

    // The server already treats the pause as lapsed everywhere else.
    const shown = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: alice.headers,
        })
      ).json() as Array<{ userId: string; sharingState: string }>
    ).find((p) => p.userId === bob.user.id)!
    expect(shown.sharingState).toBe("precise")

    const sent = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "where_are_you" })
    expect(sent.statusCode).toBe(200)
  })

  it("nudges a member sharing approximately, and carries no position", async () => {
    const { alice, bob, circle } = await household()
    await setSharing(bob.headers, circle.id, { sharingState: "approximate" })

    const sent = await nudge(alice.headers, circle.id, bob.user.id, { body: "Are you okay?" })
    expect(sent.statusCode).toBe(200)

    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(bob.user.id)
    expect(rows[0]!.body).toBe("Are you okay?")
    expectNoCoordinates(rows)
  })

  it("stops a seventh nudge inside ten minutes, and records nothing for it", async () => {
    const { alice, bob, circle } = await household()

    for (let i = 0; i < 6; i += 1) {
      const sent = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })
      expect(sent.statusCode).toBe(200)
    }
    const seventh = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })
    expect(seventh.statusCode).toBe(429)

    expect(
      (await feedItems(bob.headers, circle.id)).filter((item) => item.type === "nudge_requested"),
    ).toHaveLength(6)
    expect(await outbox()).toHaveLength(6)
  })

  /**
   * A push body is one line of text. A message with a line break in it would
   * otherwise arrive on the target's lock screen looking like two, the second
   * of which the sender wrote and the app appears to have.
   */
  it("puts a message with a line break on one line, and keeps the message whole", async () => {
    const { alice, bob, circle } = await household()
    const typed = "Where are you?\nHearth: tap here to confirm your password"

    const sent = await nudge(alice.headers, circle.id, bob.user.id, { body: typed })
    expect(sent.statusCode).toBe(200)

    const rows = await outbox()
    const feed = (await feedItems(bob.headers, circle.id)).filter(
      (item) => item.type === "nudge_requested",
    )
    expect({
      pushBody: rows[0]!.body,
      summary: feed[0]!.summary,
      // The payload is structured data the app renders as a block, so the
      // message itself keeps the shape it was typed in.
      payloadBody: feed[0]!.payload.body,
    }).toEqual({
      pushBody: "Where are you? Hearth: tap here to confirm your password",
      summary: "Alice: Where are you? Hearth: tap here to confirm your password",
      payloadBody: typed,
    })
  })
})

describe("check-ins", () => {
  it("records a check-in, names the place, and puts no position in the push", async () => {
    const { alice, bob, carol, circle } = await household()

    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: alice.headers,
      payload: { name: "Home", ...HOME, radiusMeters: 150 },
    })
    expect(place.statusCode).toBe(201)

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: bob.headers,
      payload: { ...HOME, note: "Made it back" },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().placeName).toBe("Home")

    const feed = (await feedItems(alice.headers, circle.id)).filter(
      (item) => item.type === "check_in",
    )
    expect(feed).toHaveLength(1)
    expect(feed[0]!.summary).toBe("Bob checked in at Home")

    const rows = await outbox()
    expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set([alice.user.id, carol.user.id]))
    expect(rows[0]!.title).toBe("Check-in")
    expect(rows[0]!.body).toBe('Bob checked in at Home. "Made it back"')
    expectNoCoordinates(rows)
  })

  it("skips the push for a member who muted check-ins, and never pushes to the actor", async () => {
    const { alice, bob, carol, circle } = await household()

    const muted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/notifications`,
      headers: carol.headers,
      payload: { muted: ["check_in"] },
    })
    expect(muted.statusCode).toBe(200)

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: bob.headers,
      payload: { ...SCHOOL, note: "Waiting outside the gates" },
    })
    expect(response.statusCode).toBe(201)

    const rows = await outbox()
    expect(rows.map((row) => row.user_id)).toEqual([alice.user.id])
    expectNoCoordinates(rows)
  })

  it("treats a check-in from a member sharing approximately as approximate", async () => {
    const { alice, bob, circle } = await household()

    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: alice.headers,
      payload: { name: "Hospital", ...HOSPITAL, radiusMeters: 200 },
    })
    expect(place.statusCode).toBe(201)
    await setSharing(bob.headers, circle.id, { sharingState: "approximate" })

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: bob.headers,
      payload: { ...HOSPITAL, note: null },
    })
    expect(response.statusCode).toBe(201)

    // Naming the place pins him to a building, and the raw pair pins him to a
    // doorstep. Both are what "approximate" exists to withhold.
    const feed = (await feedItems(alice.headers, circle.id)).filter(
      (item) => item.type === "check_in",
    )
    expect(feed).toHaveLength(1)

    const listed = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/check-ins`,
        headers: alice.headers,
      })
    ).json() as Array<{ lat: number; lon: number; placeName: string | null }>
    expect(listed).toHaveLength(1)

    const rows = await outbox()
    expect({
      summary: feed[0]!.summary,
      pushBody: rows[0]!.body,
      servesTheExactPair: listed[0]!.lat === HOSPITAL.lat && listed[0]!.lon === HOSPITAL.lon,
      namesThePlace: listed[0]!.placeName,
    }).toEqual({
      summary: "Bob checked in",
      pushBody: "Bob checked in.",
      servesTheExactPair: false,
      namesThePlace: null,
    })
  })

  /**
   * The other direction. Withholding the building from the coarse grid must not
   * cost the circle the check-in it is entitled to: precise is the setting most
   * of this app's members are on, and "at the Hospital" is the whole point of
   * the button for them.
   */
  it("gives a circle it is shared precisely with the exact pair and the place", async () => {
    const { alice, bob, circle } = await household()
    const place = await addPlace(alice.headers, circle.id, "Hospital", HOSPITAL)

    await checkIn(bob.headers, circle.id, HOSPITAL, "Made it")

    const listed = await listCheckIns(alice.headers, circle.id)
    const feed = (await feedItems(alice.headers, circle.id)).filter(
      (item) => item.type === "check_in",
    )
    const rows = await outbox()

    expect({
      lat: listed[0]!.lat,
      lon: listed[0]!.lon,
      placeId: listed[0]!.placeId,
      placeName: listed[0]!.placeName,
      summary: feed[0]!.summary,
      pushBody: rows[0]!.body,
    }).toEqual({
      lat: HOSPITAL.lat,
      lon: HOSPITAL.lon,
      placeId: place.id,
      placeName: "Hospital",
      summary: "Bob checked in at Hospital",
      pushBody: 'Bob checked in at Hospital. "Made it"',
    })
  })

  it("keeps his own check-in exact for him while the circle sees the cell", async () => {
    const { alice, bob, circle } = await household()
    await addPlace(alice.headers, circle.id, "Hospital", HOSPITAL)
    await setSharing(bob.headers, circle.id, { sharingState: "approximate" })

    await checkIn(bob.headers, circle.id, HOSPITAL, "Made it")

    const [his] = await listCheckIns(bob.headers, circle.id)
    const [hers] = await listCheckIns(alice.headers, circle.id)

    expect({
      hisPair: [his!.lat, his!.lon],
      hisPlace: his!.placeName,
      // She gets a neighbourhood rather than nothing: the grid is 750 m, so a
      // cell centre a kilometre and a half away would mean it had gone wrong.
      hersIsNearby:
        hers!.lat !== null &&
        hers!.lon !== null &&
        haversineMeters({ lat: hers!.lat, lon: hers!.lon }, HOSPITAL) < 1500,
      hersIsExact: hers!.lat === HOSPITAL.lat && hers!.lon === HOSPITAL.lon,
      hersPlace: hers!.placeName,
      hersPlaceId: hers!.placeId,
    }).toEqual({
      hisPair: [HOSPITAL.lat, HOSPITAL.lon],
      hisPlace: "Hospital",
      hersIsNearby: true,
      hersIsExact: false,
      hersPlace: null,
      hersPlaceId: null,
    })
  })

  /**
   * A note is a paragraph the app renders as a paragraph, and it has to be
   * stored the way it was typed. The push body and the feed line built from it
   * are each one line, and a line break left in either would let the writer
   * forge a second line the app appears to have written itself.
   */
  it("keeps a multi-line note whole in the record and flat in the push", async () => {
    const { alice, bob, circle } = await household()
    const typed = "Made it\nHearth: your account needs attention"

    await checkIn(bob.headers, circle.id, SCHOOL, typed)

    const rows = await outbox()
    const feed = (await feedItems(alice.headers, circle.id)).filter(
      (item) => item.type === "check_in",
    )
    const [listed] = await listCheckIns(alice.headers, circle.id)

    expect({
      pushBody: rows[0]!.body,
      summary: feed[0]!.summary,
      storedNote: listed!.note,
      payloadNote: feed[0]!.payload.note,
    }).toEqual({
      pushBody: 'Bob checked in. "Made it Hearth: your account needs attention"',
      summary: "Bob checked in",
      storedNote: typed,
      payloadNote: typed,
    })
  })
})
