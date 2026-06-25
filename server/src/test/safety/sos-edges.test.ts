import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * SOS edge cases, at two addresses about 3 km apart so a leaked later fix is
 * unmistakably somewhere else.
 */
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

type Headers = Record<string, string>

const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

async function createCircle(headers: Headers, name = "Family") {
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

async function uploadFix(headers: Headers, point: { lat: number; lon: number }, secondsAgo = 30) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: {
      points: [
        {
          ...point,
          recordedAt: iso(secondsAgo),
          accuracyMeters: 11,
          batteryLevel: 0.5,
          isCharging: false,
          speedMps: 0,
          source: "background",
        },
      ],
    },
  })
  expect(response.statusCode).toBe(200)
}

function raiseSos(headers: Headers, circleId: string, note: string | null = null) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: { note },
  })
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

interface SosRow {
  id: string
  user: { id: string }
  resolvedAt: string | null
  lastLat: number | null
  lastLon: number | null
  lastFixAt: string | null
}

async function sosList(headers: Headers, circleId: string, activeOnly = true) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/sos?activeOnly=${activeOnly}`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as SosRow[]
}

async function mapRow(headers: Headers, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as Array<{
    userId: string
    lat: number | null
    lon: number | null
    sharingState: string
    approximate: boolean
  }>
  return rows.find((row) => row.userId === userId)!
}

async function countRows(query: ReturnType<typeof sql>) {
  const rows = await getDb().execute(query)
  return (rows as unknown as Array<{ n: number }>)[0]!.n
}

const sosStartedCount = (circleId: string) =>
  countRows(
    sql`select count(*)::int as n from events where circle_id = ${circleId}::uuid and type = 'sos_started'`,
  )

const sosResolvedCount = (circleId: string) =>
  countRows(
    sql`select count(*)::int as n from events where circle_id = ${circleId}::uuid and type = 'sos_resolved'`,
  )

const resolvedPushCount = (userId: string) =>
  countRows(
    sql`select count(*)::int as n from notification_outbox
        where user_id = ${userId}::uuid and title = 'SOS resolved'`,
  )

async function household() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const circle = await createCircle(alice.headers, "Neighbours")
  const bob = await registerUser(ctx.app, { displayName: "Bob", inviteCode: circle.invite.code })
  return { alice, bob, circleId: circle.id }
}

describe("the SOS raise budget is per circle", () => {
  it("tells the fourth circle when one emergency is raised in all of them", async () => {
    const yusuf = await registerUser(ctx.app, { displayName: "Yusuf" })
    const circles: string[] = []
    for (const name of ["Family", "Cousins", "Football", "Flatmates"]) {
      const created = await createCircle(yusuf.headers, name)
      const friend = await registerUser(ctx.app, { displayName: `${name} friend` })
      await joinCircle(friend.headers, created.invite.code)
      circles.push(created.id)
    }

    const codes: number[] = []
    for (const circleId of circles) {
      codes.push((await raiseSos(yusuf.headers, circleId, "Hit on Gloucester Rd")).statusCode)
    }

    expect({
      codes,
      alerts: await Promise.all(circles.map(sosStartedCount)),
    }).toEqual({ codes: [201, 201, 201, 201], alerts: [1, 1, 1, 1] })
  })

  it("still stops a fourth raise inside ten minutes in one circle", async () => {
    const { alice, circleId } = await household()

    const codes: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raised = await raiseSos(alice.headers, circleId)
      codes.push(raised.statusCode)
      if (raised.statusCode !== 201) continue
      const resolve = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/sos/${(raised.json() as { id: string }).id}/resolve`,
        headers: alice.headers,
      })
      expect(resolve.statusCode).toBe(200)
    }

    expect(codes).toEqual([201, 201, 201, 429])
  })
})

describe("resolving an SOS twice at once", () => {
  it("writes one feed entry and one push per member when two admins tap together", async () => {
    const mum = await registerUser(ctx.app, { displayName: "Mum" })
    const circle = await createCircle(mum.headers, "Household")
    const dad = await registerUser(ctx.app, { displayName: "Dad", inviteCode: circle.invite.code })
    const bob = await registerUser(ctx.app, { displayName: "Bob", inviteCode: circle.invite.code })

    const promoted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${dad.user.id}`,
      headers: mum.headers,
      payload: { role: "admin" },
    })
    expect(promoted.statusCode).toBe(200)

    const raised = await raiseSos(bob.headers, circle.id, "Stuck in the lift")
    expect(raised.statusCode).toBe(201)
    const alertId = (raised.json() as { id: string }).id

    const resolve = (headers: Headers) =>
      ctx.app.inject({ method: "POST", url: `/api/v1/sos/${alertId}/resolve`, headers })
    const [first, second] = await Promise.all([resolve(mum.headers), resolve(dad.headers)])

    expect([first.statusCode, second.statusCode]).toEqual([200, 200])
    // Exactly one of the two closed it, and only that one wrote anything.
    expect(
      [first, second].filter(
        (response) => (response.json() as { alreadyResolved?: boolean }).alreadyResolved === true,
      ),
    ).toHaveLength(1)

    expect({
      feed: await sosResolvedCount(circle.id),
      toBob: await resolvedPushCount(bob.user.id),
      toMum: await resolvedPushCount(mum.user.id),
      toDad: await resolvedPushCount(dad.user.id),
    }).toEqual({ feed: 1, toBob: 1, toMum: 1, toDad: 1 })
  })

  it("still resolves normally when one admin taps once", async () => {
    const { alice, bob, circleId } = await household()
    const raised = await raiseSos(bob.headers, circleId, "Feeling unsafe")
    expect(raised.statusCode).toBe(201)

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${(raised.json() as { id: string }).id}/resolve`,
      headers: alice.headers,
    })
    expect(resolved.statusCode).toBe(200)
    expect((resolved.json() as { resolvedAt: string | null }).resolvedAt).toBeTruthy()
    expect({
      feed: await sosResolvedCount(circleId),
      toBob: await resolvedPushCount(bob.user.id),
    }).toEqual({ feed: 1, toBob: 1 })
  })
})

describe("the SOS list serves the same position the map does", () => {
  it("hides the coordinates and the freshness once the raiser pauses again", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, SCHOOL, 600)
    expect((await raiseSos(alice.headers, circleId, "Followed")).statusCode).toBe(201)
    await setSharing(alice.headers, circleId, "paused")

    // Her phone keeps uploading: pausing is a read-time projection.
    await uploadFix(alice.headers, HOSPITAL, 20)

    const seen = await mapRow(bob.headers, circleId, alice.user.id)
    const [row] = await sosList(bob.headers, circleId)

    expect({
      mapLat: seen.lat,
      mapState: seen.sharingState,
      alertLat: row!.lastLat,
      alertLon: row!.lastLon,
      alertFixAt: row!.lastFixAt,
    }).toEqual({
      mapLat: null,
      mapState: "paused",
      alertLat: null,
      alertLon: null,
      alertFixAt: null,
    })
  })

  it("coarsens to the same grid point the map serves an approximate viewer", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, SCHOOL)
    expect((await raiseSos(alice.headers, circleId)).statusCode).toBe(201)
    await setSharing(alice.headers, circleId, "approximate")

    const seen = await mapRow(bob.headers, circleId, alice.user.id)
    const [row] = await sosList(bob.headers, circleId)

    expect(seen.approximate).toBe(true)
    expect([row!.lastLat, row!.lastLon]).toEqual([seen.lat, seen.lon])
    expect(row!.lastLat).not.toBe(SCHOOL.lat)
  })

  it("stops following someone who has left the circle the alert was raised in", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(bob.headers, SCHOOL, 120)
    expect((await raiseSos(bob.headers, circleId, "Followed")).statusCode).toBe(201)

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circleId}/members/${bob.user.id}`,
      headers: bob.headers,
    })
    expect(left.statusCode).toBe(200)
    await uploadFix(bob.headers, HOSPITAL, 10)

    const active = (await sosList(alice.headers, circleId)).find((r) => r.user.id === bob.user.id)
    const history = (await sosList(alice.headers, circleId, false)).find(
      (r) => r.user.id === bob.user.id,
    )

    // The alert stays in the circle's own record so an admin can still clear it.
    expect(active).toBeDefined()
    expect({
      activeLat: active!.lastLat,
      activeFixAt: active!.lastFixAt,
      historyLat: history!.lastLat,
    }).toEqual({ activeLat: null, activeFixAt: null, historyLat: null })
  })

  it("stops the freshness timestamp moving once the alert is resolved", async () => {
    const { alice, bob, circleId } = await household()
    await uploadFix(alice.headers, SCHOOL, 300)
    const raised = await raiseSos(alice.headers, circleId)
    expect(raised.statusCode).toBe(201)
    const resolve = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${(raised.json() as { id: string }).id}/resolve`,
      headers: alice.headers,
    })
    expect(resolve.statusCode).toBe(200)

    await setSharing(alice.headers, circleId, "paused")
    await uploadFix(alice.headers, HOSPITAL, 2)

    const [row] = await sosList(bob.headers, circleId, false)
    expect({ lat: row!.lastLat, lon: row!.lastLon, fixAt: row!.lastFixAt }).toEqual({
      lat: null,
      lon: null,
      fixAt: null,
    })
  })

  it("still hands the circle an exact live position during an ordinary alert", async () => {
    const { alice, bob, circleId } = await household()
    // She was paused when it happened, which is the case the override exists for.
    await setSharing(alice.headers, circleId, "paused")
    await uploadFix(alice.headers, SCHOOL, 300)
    expect((await raiseSos(alice.headers, circleId, "Off the bike")).statusCode).toBe(201)
    await uploadFix(alice.headers, HOSPITAL, 5)

    const [row] = await sosList(bob.headers, circleId)
    expect(row!.lastLat).toBeCloseTo(HOSPITAL.lat, 5)
    expect(row!.lastLon).toBeCloseTo(HOSPITAL.lon, 5)
    expect(row!.lastFixAt).not.toBeNull()
  })

  it("still shows the raiser her own exact position while she is paused", async () => {
    const { alice, circleId } = await household()
    await uploadFix(alice.headers, SCHOOL)
    expect((await raiseSos(alice.headers, circleId)).statusCode).toBe(201)
    await setSharing(alice.headers, circleId, "paused")

    const [row] = await sosList(alice.headers, circleId)
    expect(row!.lastLat).toBeCloseTo(SCHOOL.lat, 5)
  })
})

describe("nudging through a lapsed pause", () => {
  it("allows a nudge once a timed pause has run out", async () => {
    const { alice, bob, circleId } = await household()
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circleId}/sharing`,
      headers: bob.headers,
      payload: {
        sharingState: "paused",
        pausedUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      },
    })
    await getDb().execute(sql`
      update circle_members set paused_until = now() - interval '5 minutes'
      where circle_id = ${circleId}::uuid and user_id = ${bob.user.id}::uuid
    `)

    const nudged = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/nudge/${bob.user.id}`,
      headers: alice.headers,
      payload: { quickKey: "where_are_you" },
    })
    expect(nudged.statusCode).toBe(200)
  })

  it("still refuses a nudge to someone whose pause has no expiry", async () => {
    const { alice, bob, circleId } = await household()
    await setSharing(bob.headers, circleId, "paused")

    const nudged = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/nudge/${bob.user.id}`,
      headers: alice.headers,
      payload: { quickKey: "where_are_you" },
    })
    expect(nudged.statusCode).toBe(403)
  })
})
