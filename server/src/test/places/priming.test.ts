import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Creating or moving a place seeds who is inside from each member's last fix,
 * but only from a fix accurate enough for the fence to have decided it.
 */

// The quiet residential street api.test.ts uses for HOME.
const HOME = { lat: 51.4545, lon: -2.5879 }

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

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

async function createCircle(headers: Record<string, string>) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name: "Family", emoji: "🏠" },
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

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{ lat: number; lon: number; recordedAt: string; accuracyMeters?: number }>,
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

async function createPlace(
  headers: Record<string, string>,
  circleId: string,
  place: { name: string; lat: number; lon: number; radiusMeters: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { icon: "home", ...place },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; membersInside: string[] }
}

async function feedItems(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { items: Array<{ type: string; summary: string }> }).items
}

async function queuedPushes() {
  return (await getDb().execute(
    sql`select user_id, title, body from notification_outbox`,
  )) as unknown as Array<{ user_id: string; title: string; body: string }>
}

async function placeEventRows() {
  return (await getDb().execute(
    sql`select type from place_events order by occurred_at`,
  )) as unknown as Array<{ type: string }>
}

describe("place creation seeds membership from the last presence fix", () => {
  it("primes a member really at home, and a real departure alerts once", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await joinCircle(kid.headers, circle.invite.code)

    // Genuinely at home, an ordinary warm GPS fix.
    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-300), accuracyMeters: 9 }])
    const place = await createPlace(parent.headers, circle.id, {
      name: "Home",
      ...HOME,
      radiusMeters: 150,
    })
    expect(place.membersInside).toContain(kid.user.id)

    // Still in the garden: no event, and no spurious arrival either.
    let result = await uploadFixes(kid.headers, [
      { ...northOf(HOME, 30), recordedAt: iso(-240), accuracyMeters: 11 },
    ])
    expect(result.placeEvents).toBe(0)

    // Really walks 500 m up the road: exactly one leave, and it is true.
    result = await uploadFixes(kid.headers, [
      { ...northOf(HOME, 500), recordedAt: iso(-60), accuracyMeters: 11 },
    ])
    expect(result.placeEvents).toBe(1)
    expect((await placeEventRows()).map((row) => row.type)).toEqual(["leave"])
  })

  it("does not announce a departure from a place the member was never in", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await joinCircle(kid.headers, circle.invite.code)

    // The kid is 500 m up the road. The handset has dropped to 2G and is
    // reporting the mast on the family's street, so the position lands on the
    // house and the reported accuracy is 2 km. Every other part of this engine
    // refuses a fix like that outright.
    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-420), accuracyMeters: 2000 }])

    const place = await createPlace(parent.headers, circle.id, {
      name: "Home",
      ...HOME,
      radiusMeters: 150,
    })

    // GPS recovers and reports where the kid actually is.
    const result = await uploadFixes(kid.headers, [
      { ...northOf(HOME, 500), recordedAt: iso(-60), accuracyMeters: 11 },
    ])

    const leaveFeed = (await feedItems(parent.headers, circle.id)).filter(
      (item) => item.type === "place_leave",
    )
    const leavePushes = (await queuedPushes()).filter((row) => row.body.includes("left"))

    expect({
      // A 2 km fix cannot put anybody inside a 150 m fence.
      seededInside: place.membersInside.includes(kid.user.id),
      placeEvents: result.placeEvents,
      rows: (await placeEventRows()).map((row) => row.type),
      feed: leaveFeed.map((item) => item.summary),
      pushed: leavePushes.map(
        (row) => `${row.user_id === parent.user.id ? "parent" : "?"}: ${row.body}`,
      ),
    }).toEqual({ seededInside: false, placeEvents: 0, rows: [], feed: [], pushed: [] })
  })

  it("does not announce one seeded by an ordinary 300 m network fix either", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await joinCircle(kid.headers, circle.invite.code)

    // Only just past the 250 m the engine accepts, centred 120 m from the
    // house: an everyday coarse fix, no 2 km outlier needed.
    await uploadFixes(kid.headers, [
      { ...northOf(HOME, 120), recordedAt: iso(-600), accuracyMeters: 300 },
    ])
    await createPlace(parent.headers, circle.id, { name: "Home", ...HOME, radiusMeters: 150 })

    const result = await uploadFixes(kid.headers, [
      { ...northOf(HOME, 500), recordedAt: iso(-60), accuracyMeters: 11 },
    ])
    expect({
      placeEvents: result.placeEvents,
      rows: (await placeEventRows()).map((row) => row.type),
    }).toEqual({ placeEvents: 0, rows: [] })
  })

  it("lets the same coarse fix decide nothing once the place exists", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await joinCircle(kid.headers, circle.invite.code)

    await uploadFixes(kid.headers, [
      { ...northOf(HOME, 500), recordedAt: iso(-600), accuracyMeters: 11 },
    ])
    await createPlace(parent.headers, circle.id, { name: "Home", ...HOME, radiusMeters: 150 })

    // The same 2 km fix on the house, arriving through the normal upload path.
    const result = await uploadFixes(kid.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 2000 },
    ])
    expect(result.placeEvents).toBe(0)
    expect(await placeEventRows()).toHaveLength(0)
  })

  it("applies the same rule when a parent moves the Home pin", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await joinCircle(kid.headers, circle.invite.code)

    // Kid is at school, 500 m north, on good GPS. Home already exists and the
    // kid has never been inside it.
    await uploadFixes(kid.headers, [
      { ...northOf(HOME, 500), recordedAt: iso(-900), accuracyMeters: 11 },
    ])
    const place = await createPlace(parent.headers, circle.id, {
      name: "Home",
      ...HOME,
      radiusMeters: 150,
    })
    expect(place.membersInside).not.toContain(kid.user.id)

    // Kid goes indoors and the phone falls back to a coarse network fix
    // centred on the house.
    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-600), accuracyMeters: 2000 }])

    // Parent nudges the radius from 150 m to 120 m, which re-primes every
    // membership from presence.
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/places/${place.id}`,
      headers: parent.headers,
      payload: { radiusMeters: 120 },
    })
    expect(patch.statusCode).toBe(200)

    // GPS recovers: the kid is back at school, where they have been all along.
    const result = await uploadFixes(kid.headers, [
      { ...northOf(HOME, 500), recordedAt: iso(-60), accuracyMeters: 11 },
    ])
    expect({
      placeEvents: result.placeEvents,
      rows: (await placeEventRows()).map((row) => row.type),
    }).toEqual({ placeEvents: 0, rows: [] })
  })
})
