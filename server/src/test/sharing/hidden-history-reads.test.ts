import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  createCircle,
  joinCircle,
  registerUser,
  setSharing,
  startTestApp,
  uploadFixes,
  type TestContext,
} from "../helpers"

/**
 * A member's page asks for their trips whatever they share, and a trip list
 * stays on screen after the sharing behind it changes. A refusal there is a
 * 4xx in ordinary use, and a firewall in front of a home server reads those
 * as an attack and locks every phone behind the address out. What the viewer
 * may not see comes back empty instead, which says nothing more than the
 * refusal did.
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

const HOME = { lat: 51.4545, lon: -2.5879 }
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000)

async function seedTrip(userId: string, startedAt: Date) {
  const endedAt = new Date(startedAt.getTime() + 15 * 60 * 1000)
  const rows = (await getDb().execute(sql`
    insert into trips
      (user_id, started_at, ended_at, distance_meters, max_speed_mps, avg_speed_mps,
       point_count, start_lat, start_lon, end_lat, end_lon)
    values
      (${userId}::uuid, ${startedAt.toISOString()}::timestamptz,
       ${endedAt.toISOString()}::timestamptz, 12600, 14, 14, 2, 52.2053, 0.1218, 51.752, -1.2577)
    returning id
  `)) as unknown as Array<{ id: string }>
  return rows[0]!.id
}

/** Alice watches, Tara is watched. Tara has a trip and a breadcrumb the circle can see. */
async function family() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const tara = await registerUser(ctx.app, { displayName: "Tara" })
  const circle = await createCircle(ctx.app, alice.headers)
  await joinCircle(ctx.app, tara.headers, circle.invite.code)
  // Joining is not what withholds anything here, so put it well out of the way.
  await getDb().execute(sql`
    update circle_members set created_at = ${minutesAgo(24 * 60).toISOString()}::timestamptz
    where circle_id = ${circle.id}::uuid and user_id = ${tara.user.id}::uuid
  `)
  await uploadFixes(ctx.app, tara.headers, [
    { ...HOME, recordedAt: minutesAgo(5).toISOString(), accuracyMeters: 10 },
  ])
  const trip = await seedTrip(tara.user.id, minutesAgo(30))
  return { alice, tara, circle, trip }
}

async function read(headers: Record<string, string>, url: string) {
  const response = await ctx.app.inject({ method: "GET", url, headers })
  return { status: response.statusCode, body: response.json() as unknown }
}

const tripsUrl = (circleId: string, userId: string) =>
  `/api/v1/circles/${circleId}/members/${userId}/trips`
const historyUrl = (circleId: string, userId: string) =>
  `/api/v1/circles/${circleId}/members/${userId}/history`

describe("trips and history the viewer may not see", () => {
  it("shows both while she shares precisely, so the empty answers below mean something", async () => {
    const { alice, tara, circle } = await family()

    const trips = await read(alice.headers, tripsUrl(circle.id, tara.user.id))
    const history = await read(alice.headers, historyUrl(circle.id, tara.user.id))

    expect([trips.status, (trips.body as unknown[]).length]).toEqual([200, 1])
    expect([history.status, (history.body as unknown[]).length]).toEqual([200, 1])
  })

  for (const state of ["approximate", "paused"] as const) {
    it(`answers an empty list, not a refusal, while she shares ${state}`, async () => {
      const { alice, tara, circle } = await family()
      await setSharing(ctx.app, tara.headers, circle.id, state)

      expect(await read(alice.headers, tripsUrl(circle.id, tara.user.id))).toEqual({
        status: 200,
        body: [],
      })
      expect(await read(alice.headers, historyUrl(circle.id, tara.user.id))).toEqual({
        status: 200,
        body: [],
      })
    })
  }

  it("answers an empty list in a circle that has history turned off", async () => {
    const { alice, tara, circle } = await family()
    const off = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}`,
      headers: alice.headers,
      payload: { settings: { allowHistory: false } },
    })
    expect(off.statusCode).toBe(200)

    expect(await read(alice.headers, tripsUrl(circle.id, tara.user.id))).toEqual({
      status: 200,
      body: [],
    })
    expect(await read(alice.headers, historyUrl(circle.id, tara.user.id))).toEqual({
      status: 200,
      body: [],
    })
  })

  it("answers an empty list for somebody who has left the circle", async () => {
    const { alice, tara, circle } = await family()
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${tara.user.id}`,
      headers: tara.headers,
    })
    expect(left.statusCode).toBe(200)

    expect(await read(alice.headers, tripsUrl(circle.id, tara.user.id))).toEqual({
      status: 200,
      body: [],
    })
    expect(await read(alice.headers, historyUrl(circle.id, tara.user.id))).toEqual({
      status: 200,
      body: [],
    })
  })

  it("still refuses somebody who is not in the circle at all", async () => {
    const { tara, circle } = await family()
    const stranger = await registerUser(ctx.app, { displayName: "Stranger" })

    expect((await read(stranger.headers, tripsUrl(circle.id, tara.user.id))).status).toBe(403)
    expect((await read(stranger.headers, historyUrl(circle.id, tara.user.id))).status).toBe(403)
  })
})

describe("one trip opened from a list that has gone out of date", () => {
  it("says the trip is not visible, when the app asks for that answer", async () => {
    const { alice, tara, circle, trip } = await family()
    await setSharing(ctx.app, tara.headers, circle.id, "approximate")

    expect(await read(alice.headers, `/api/v1/trips/${trip}?soft=true`)).toEqual({
      status: 200,
      body: { id: trip, visible: false },
    })
  })

  it("says the same of a trip that no longer exists", async () => {
    const { alice } = await family()
    const gone = "00000000-0000-4000-8000-000000000000"

    expect(await read(alice.headers, `/api/v1/trips/${gone}?soft=true`)).toEqual({
      status: 200,
      body: { id: gone, visible: false },
    })
  })

  it("marks a trip it does serve as visible, and keeps the old answers for an older app", async () => {
    const { alice, tara, circle, trip } = await family()

    const shown = await read(alice.headers, `/api/v1/trips/${trip}?soft=true`)
    expect(shown.status).toBe(200)
    expect(shown.body).toMatchObject({ id: trip, visible: true, path: [] })

    // An app from before this answer renders whatever comes back as a trip,
    // so without the flag it keeps getting the refusal it already handles.
    await setSharing(ctx.app, tara.headers, circle.id, "approximate")
    expect((await read(alice.headers, `/api/v1/trips/${trip}`)).status).toBe(403)
    expect(
      (await read(alice.headers, "/api/v1/trips/00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404)
  })
})
