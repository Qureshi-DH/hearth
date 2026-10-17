import { haversineMeters } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  checkIn,
  createCircle,
  createPlace,
  joinCircle,
  registerUser,
  setSharing,
  startTestApp,
  type TestContext,
} from "../helpers"

/**
 * A check-in is shown no more exactly than the circle could see her when she
 * made it. Going back to precise does not open up the time in between, and a
 * check-in from that time is part of it.
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

const HOSPITAL = { lat: 51.4784, lon: -2.5586 }

async function family() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const circle = await createCircle(ctx.app, alice.headers)
  await joinCircle(ctx.app, bob.headers, circle.invite.code)
  const place = await createPlace(ctx.app, alice.headers, circle.id, {
    name: "Hospital",
    ...HOSPITAL,
    radiusMeters: 200,
  })
  return { alice, bob, circle, place }
}

interface Seen {
  lat: number | null
  lon: number | null
  placeId: string | null
  placeName: string | null
}

async function listed(headers: Record<string, string>, circleId: string): Promise<Seen> {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/check-ins`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as Seen[])[0]!
}

async function inFeed(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const items = (
    response.json() as {
      items: Array<{ type: string; summary: string; payload: Record<string, unknown> }>
    }
  ).items
  return items.find((item) => item.type === "check_in")!
}

const exact = (seen: { lat: unknown; lon: unknown }) =>
  seen.lat === HOSPITAL.lat && seen.lon === HOSPITAL.lon

describe("a check-in keeps the precision it was made with", () => {
  it("stays on the grid after she goes back to precise", async () => {
    const { alice, bob, circle } = await family()
    await setSharing(ctx.app, bob.headers, circle.id, "approximate")
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL, "Made it")
    await setSharing(ctx.app, bob.headers, circle.id, "precise")

    const seen = await listed(alice.headers, circle.id)
    const feed = await inFeed(alice.headers, circle.id)

    expect({
      listIsExact: exact(seen),
      listIsNearby:
        seen.lat !== null &&
        seen.lon !== null &&
        haversineMeters({ lat: seen.lat, lon: seen.lon }, HOSPITAL) < 1500,
      listPlace: [seen.placeId, seen.placeName],
      feedIsExact: exact(feed.payload as { lat: unknown; lon: unknown }),
      feedPlace: feed.payload.placeId,
      summary: feed.summary,
    }).toEqual({
      listIsExact: false,
      listIsNearby: true,
      listPlace: [null, null],
      feedIsExact: false,
      feedPlace: null,
      summary: "Bob checked in",
    })
  })

  it("stays without a position after a pause ends", async () => {
    const { alice, bob, circle } = await family()
    await setSharing(ctx.app, bob.headers, circle.id, "paused")
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL)
    await setSharing(ctx.app, bob.headers, circle.id, "precise")

    expect(await listed(alice.headers, circle.id)).toMatchObject({
      lat: null,
      lon: null,
      placeId: null,
      placeName: null,
    })
  })

  it("follows her down when she shares less than she did", async () => {
    const { alice, bob, circle } = await family()
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL)
    await setSharing(ctx.app, bob.headers, circle.id, "paused")

    expect(await listed(alice.headers, circle.id)).toMatchObject({ lat: null, placeName: null })
  })

  it("shows a precise one exactly while she still shares precisely", async () => {
    const { alice, bob, circle, place } = await family()
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL)

    const seen = await listed(alice.headers, circle.id)
    expect([exact(seen), seen.placeId, seen.placeName]).toEqual([true, place.id, "Hospital"])
  })

  it("keeps her own exact for her, whatever she shared", async () => {
    const { bob, circle } = await family()
    await setSharing(ctx.app, bob.headers, circle.id, "approximate")
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL)

    const seen = await listed(bob.headers, circle.id)
    expect([exact(seen), seen.placeName]).toEqual([true, "Hospital"])
  })

  it("records what the circle could see when she checked in", async () => {
    const { bob, circle } = await family()
    await setSharing(ctx.app, bob.headers, circle.id, "approximate")
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL)

    const rows = (await getDb().execute(sql`select shared_as from check_ins`)) as unknown as Array<{
      shared_as: string | null
    }>
    expect(rows).toEqual([{ shared_as: "approximate" }])
  })

  it("leaves a row from before the record was kept to her sharing now", async () => {
    const { alice, bob, circle } = await family()
    await setSharing(ctx.app, bob.headers, circle.id, "approximate")
    await checkIn(ctx.app, bob.headers, circle.id, HOSPITAL)
    await getDb().execute(sql`update check_ins set shared_as = null`)
    await setSharing(ctx.app, bob.headers, circle.id, "precise")

    expect(exact(await listed(alice.headers, circle.id))).toBe(true)
  })
})
