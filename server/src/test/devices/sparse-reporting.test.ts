import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { events } from "../../db/schema"
import { detectTripsForUser } from "../../services/trips"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A night of sparse reporting: the feed is in the order things happened, a
 * drive whose fixes are minutes apart is still a drive, and a watched phone
 * learns so from its own upload.
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

type Headers = Record<string, string>

/** A house on a quiet street in Bristol. */
const HOME = { lat: 51.4545, lon: -2.5879 }

const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

/** A point `metres` due east of `from`. */
const east = (from: { lat: number; lon: number }, metres: number) => ({
  lat: from.lat,
  lon: from.lon + metres / metresPerDegreeLon(from.lat),
})

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000)

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

async function join(headers: Headers, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function createPlace(headers: Headers, circleId: string, name: string, at: typeof HOME) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { name, lat: at.lat, lon: at.lon, radiusMeters: 200, icon: "home" },
  })
  expect(response.statusCode).toBe(201)
}

async function upload(
  headers: Headers,
  points: Array<{ lat: number; lon: number; recordedAt: Date; speedMps?: number }>,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: {
      points: points.map((point) => ({
        lat: point.lat,
        lon: point.lon,
        recordedAt: point.recordedAt.toISOString(),
        accuracyMeters: 12,
        speedMps: point.speedMps ?? 0,
        source: "background",
      })),
    },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; watchedUntil: string | null }
}

async function feed(headers: Headers, circleId: string, query = "") {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events${query}`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as {
    items: Array<{ id: string; summary: string; occurredAt: string }>
    nextCursor: string | null
  }
}

async function myTrips(headers: Headers) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ id: string; distanceMeters: number; pointCount: number }>
}

describe("the feed is in the order things happened", () => {
  /** Rows written in one order, about things that happened in another. */
  async function backlog(circleId: string, actorUserId: string) {
    const write = async (summary: string, occurredAt: Date) => {
      const [row] = await getDb()
        .insert(events)
        .values({ circleId, actorUserId, type: "check_in", summary, occurredAt, payload: {} })
        .returning({ id: events.id })
      return String(row!.id)
    }
    // The server came back at 1:10 PM and the phone's morning replayed then.
    const lunch = await write("arrived at Home", minutesAgo(10))
    const morningOut = await write("left Home", minutesAgo(300))
    const morningIn = await write("arrived at College", minutesAgo(280))
    const midday = await write("left College", minutesAgo(60))
    return { lunch, morningOut, morningIn, midday }
  }

  it("sorts by when it happened, not by when the row was written", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)
    const rows = await backlog(circle.id, owner.user.id)

    const page = await feed(owner.headers, circle.id)

    expect(page.items.map((item) => item.id)).toEqual([
      rows.lunch,
      rows.midday,
      rows.morningIn,
      rows.morningOut,
    ])
  })

  it("pages through that order without repeating or skipping a row", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)
    const rows = await backlog(circle.id, owner.user.id)

    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 6 && (cursor !== null || seen.length === 0); i += 1) {
      const page = await feed(
        owner.headers,
        circle.id,
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      )
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    }

    expect(seen).toEqual([rows.lunch, rows.midday, rows.morningIn, rows.morningOut])
    expect(cursor).toBeNull()
  })

  it("keeps two events from the same instant on separate pages in a fixed order", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)
    const at = minutesAgo(5)
    const ids: string[] = []
    for (const summary of ["first", "second", "third"]) {
      const [row] = await getDb()
        .insert(events)
        .values({
          circleId: circle.id,
          actorUserId: owner.user.id,
          type: "check_in",
          summary,
          occurredAt: at,
          payload: {},
        })
        .returning({ id: events.id })
      ids.push(String(row!.id))
    }

    const first = await feed(owner.headers, circle.id, "?limit=2")
    const second = await feed(
      owner.headers,
      circle.id,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
    )

    expect([...first.items, ...second.items].map((item) => item.id)).toEqual([...ids].reverse())
    expect(second.nextCursor).toBeNull()
  })

  it("rejects a cursor it did not hand out without a 500", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)
    for (const cursor of ["1.5", "abc", "1e26", "2026-01-01T00:00:00Z|x", "|1"]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/events?cursor=${encodeURIComponent(cursor)}`,
        headers: owner.headers,
      })
      expect(response.statusCode, cursor).toBe(200)
      expect((response.json() as { items: unknown[] }).items).toEqual([])
    }
  })
})

describe("a sparse drive is still a drive", () => {
  it("counts a run out to a kilometre away and back with fixes ten minutes apart", async () => {
    const dan = await registerUser(ctx.app)
    const circle = await createCircle(dan.headers)
    await createPlace(dan.headers, circle.id, "Home", HOME)

    // Home, then a fix a kilometre out, a little further, then home again,
    // with the silences a phone that only spoke every ten minutes left.
    await upload(dan.headers, [
      { ...HOME, recordedAt: minutesAgo(40) },
      { ...east(HOME, 1_000), recordedAt: minutesAgo(30), speedMps: 8 },
      { ...east(HOME, 1_200), recordedAt: minutesAgo(27), speedMps: 1 },
      { ...HOME, recordedAt: minutesAgo(19) },
    ])
    await detectTripsForUser(getDb(), dan.user.id)

    const trips = await myTrips(dan.headers)
    expect(trips).toHaveLength(1)
    expect(trips[0]!.pointCount).toBe(4)
    expect(trips[0]!.distanceMeters).toBeGreaterThan(2_000)
  })

  it("still ends a drive where the phone sat and said so", async () => {
    const dan = await registerUser(ctx.app)
    await createCircle(dan.headers)

    // Out to a shop, a resting fix from the same spot after the silence,
    // then home. Two journeys, with the stop in between.
    const SHOP = east(HOME, 2_000)
    await upload(dan.headers, [
      { ...HOME, recordedAt: minutesAgo(90) },
      { ...east(HOME, 1_000), recordedAt: minutesAgo(87), speedMps: 8 },
      { ...SHOP, recordedAt: minutesAgo(84) },
      { ...SHOP, recordedAt: minutesAgo(60) },
      { ...east(HOME, 1_000), recordedAt: minutesAgo(50), speedMps: 8 },
      { ...HOME, recordedAt: minutesAgo(45) },
    ])
    await detectTripsForUser(getDb(), dan.user.id)

    expect(await myTrips(dan.headers)).toHaveLength(2)
  })

  it("does not join two fixes a street apart across a long silence", async () => {
    const dan = await registerUser(ctx.app)
    await createCircle(dan.headers)

    // Parked, and the phone drifted 250 m over an hour. Not a journey.
    await upload(dan.headers, [
      { ...HOME, recordedAt: minutesAgo(120) },
      { ...east(HOME, 250), recordedAt: minutesAgo(60) },
      { ...HOME, recordedAt: minutesAgo(20) },
    ])
    await detectTripsForUser(getDb(), dan.user.id)

    expect(await myTrips(dan.headers)).toHaveLength(0)
  })
})

describe("a watched phone learns so from its own upload", () => {
  it("returns until when it is watched, once someone has a page open on it", async () => {
    const viewer = await registerUser(ctx.app)
    const driver = await registerUser(ctx.app)
    const circle = await createCircle(viewer.headers)
    await join(driver.headers, circle.invite.code)

    const before = await upload(driver.headers, [{ ...HOME, recordedAt: minutesAgo(2) }])
    expect(before.watchedUntil).toBeNull()

    const watch = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    expect(watch.statusCode).toBe(200)
    expect(watch.json()).toMatchObject({ watching: true })

    const after = await upload(driver.headers, [{ ...HOME, recordedAt: minutesAgo(1) }])
    expect(after.watchedUntil).not.toBeNull()
    const remaining = (Date.parse(after.watchedUntil!) - Date.now()) / 1000
    expect(remaining).toBeGreaterThan(500)
    expect(remaining).toBeLessThanOrEqual(600)
  })

  it("says nothing once the window has passed", async () => {
    const viewer = await registerUser(ctx.app)
    const driver = await registerUser(ctx.app)
    const circle = await createCircle(viewer.headers)
    await join(driver.headers, circle.invite.code)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    await getDb().execute(
      sql`update user_presence set watched_until = now() - interval '1 minute' where user_id = ${driver.user.id}::uuid`,
    )

    const reply = await upload(driver.headers, [{ ...HOME, recordedAt: minutesAgo(1) }])
    expect(reply.watchedUntil).toBeNull()
  })

  it("is not watched by someone it shares approximately with", async () => {
    const viewer = await registerUser(ctx.app)
    const driver = await registerUser(ctx.app)
    const circle = await createCircle(viewer.headers)
    await join(driver.headers, circle.invite.code)
    const sharing = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: driver.headers,
      payload: { sharingState: "approximate" },
    })
    expect(sharing.statusCode).toBe(200)

    const watch = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    expect(watch.json()).toMatchObject({ watching: false })

    const reply = await upload(driver.headers, [{ ...HOME, recordedAt: minutesAgo(1) }])
    expect(reply.watchedUntil).toBeNull()
  })
})
