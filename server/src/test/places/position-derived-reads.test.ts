import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The read routes that hand back position-derived data: the place list, one
 * place's arrive and leave history, and the trips list. Each is checked in both
 * directions, dropping a member who shares less and keeping one who does not.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const CLINIC = { lat: 51.4636, lon: -2.5952 }

const YEAR_ZERO = "0000-01-01T00:00:00Z"

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

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
}

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

async function uploadFixes(headers: Headers, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

/** One request per fix, which is what a moving phone actually does. */
async function uploadOneByOne(headers: Headers, points: Fix[]) {
  for (const point of points) await uploadFixes(headers, [point])
}

async function createPlace(
  headers: Headers,
  circleId: string,
  payload: { name: string; lat: number; lon: number; radiusMeters?: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { radiusMeters: 150, ...payload },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; name: string; membersInside: string[] }
}

async function listPlaces(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { id: string; name: string; membersInside: string[] }[]
}

async function locations(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as {
    userId: string
    sharingState: string
    atPlace: { id: string; name: string } | null
  }[]
}

async function setSharing(
  headers: Headers,
  circleId: string,
  payload: { sharingState: "precise" | "approximate" | "paused"; pausedUntil?: string | null },
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload,
  })
  expect(response.statusCode).toBe(200)
}

/**
 * A timed pause lapses on read, so the suite rewinds the expiry rather than
 * waiting an hour for it. Postgres decides the time, so no Date goes near the
 * template.
 */
async function lapsePause(userId: string) {
  await getDb().execute(
    sql`update circle_members
        set paused_until = now() - interval '5 minutes'
        where user_id = ${userId} and sharing_state = 'paused'`,
  )
}

async function crossingsOf(headers: Headers, circleId: string, placeId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/places/${placeId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { placeName: string; userId: string; type: string }[]
}

describe("the place list agrees with the map about who is inside", () => {
  async function household() {
    const parent = await registerUser(ctx.app, { displayName: "Pat" })
    const circle = await createCircle(parent.headers)
    const kid = await registerUser(ctx.app, { displayName: "Kit" })
    await join(kid.headers, circle.invite.code)
    // The fix the fence and the map both read back afterwards.
    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 12 }])
    return { parent, kid, circleId: circle.id }
  }

  it("keeps a lapsed pause over an approximate baseline out of membersInside", async () => {
    const { parent, kid, circleId } = await household()

    await setSharing(kid.headers, circleId, { sharingState: "approximate" })
    await setSharing(kid.headers, circleId, {
      sharingState: "paused",
      pausedUntil: iso(3600),
    })
    await lapsePause(kid.user.id)

    // Creating a place re-seeds membership rows for everyone with a fix, which
    // is what puts back the row that going approximate deleted.
    const created = await createPlace(parent.headers, circleId, { name: "Home", ...HOME })
    expect(created.membersInside).toEqual([])

    const [place] = await listPlaces(parent.headers, circleId)
    expect(place?.membersInside).toEqual([])

    const seen = (await locations(parent.headers, circleId)).find(
      (row) => row.userId === kid.user.id,
    )
    expect(seen?.sharingState).toBe("approximate")
    expect(seen?.atPlace).toBeNull()
  })

  it("still reports a member who is sharing precisely", async () => {
    const { parent, kid, circleId } = await household()

    const created = await createPlace(parent.headers, circleId, { name: "Home", ...HOME })
    expect(created.membersInside).toEqual([kid.user.id])

    const [place] = await listPlaces(parent.headers, circleId)
    expect(place?.membersInside).toEqual([kid.user.id])

    const seen = (await locations(parent.headers, circleId)).find(
      (row) => row.userId === kid.user.id,
    )
    expect(seen?.sharingState).toBe("precise")
    expect(seen?.atPlace?.name).toBe("Home")
  })

  it("still reports a lapsed pause that resumes into precise", async () => {
    const { parent, kid, circleId } = await household()

    await setSharing(kid.headers, circleId, { sharingState: "paused", pausedUntil: iso(3600) })
    await lapsePause(kid.user.id)

    const created = await createPlace(parent.headers, circleId, { name: "Home", ...HOME })
    expect(created.membersInside).toEqual([kid.user.id])

    const seen = (await locations(parent.headers, circleId)).find(
      (row) => row.userId === kid.user.id,
    )
    expect(seen?.sharingState).toBe("precise")
    expect(seen?.atPlace?.name).toBe("Home")
  })
})

describe("a place's arrive/leave history answers to the state shared now", () => {
  // Ben holds the circle so that Ann is free to walk out of it below. The last
  // admin cannot leave, and the case worth pinning is the member who does.
  async function visit() {
    const ben = await registerUser(ctx.app, { displayName: "Ben" })
    const circle = await createCircle(ben.headers)
    const ann = await registerUser(ctx.app, { displayName: "Ann" })
    await join(ann.headers, circle.invite.code)

    const place = await createPlace(ann.headers, circle.id, {
      name: "Therapist Office",
      ...CLINIC,
    })
    await uploadOneByOne(ann.headers, [
      { ...HOME, recordedAt: iso(-900), accuracyMeters: 12 },
      { ...CLINIC, recordedAt: iso(-600), accuracyMeters: 12 },
      { ...HOME, recordedAt: iso(-300), accuracyMeters: 12 },
    ])

    return { ann, ben, circle, placeId: place.id }
  }

  it("shows the crossings to the circle while the member shares precisely", async () => {
    const { ben, circle, placeId } = await visit()

    const rows = await crossingsOf(ben.headers, circle.id, placeId)
    expect(rows.map((row) => row.type)).toEqual(["leave", "arrive"])
    expect(rows.every((row) => row.placeName === "Therapist Office")).toBe(true)
  })

  it("withholds them once the member pauses, and gives them back on resume", async () => {
    const { ann, ben, circle, placeId } = await visit()

    await setSharing(ann.headers, circle.id, { sharingState: "paused" })
    expect(await crossingsOf(ben.headers, circle.id, placeId)).toEqual([])

    // The trail is still the member's own to read.
    expect((await crossingsOf(ann.headers, circle.id, placeId)).length).toBe(2)

    await setSharing(ann.headers, circle.id, { sharingState: "precise" })
    expect((await crossingsOf(ben.headers, circle.id, placeId)).length).toBe(2)
  })

  it("withholds them from a circle the member only shares approximately with", async () => {
    const { ann, ben, circle, placeId } = await visit()

    await setSharing(ann.headers, circle.id, { sharingState: "approximate" })
    expect(await crossingsOf(ben.headers, circle.id, placeId)).toEqual([])
  })

  it("withholds them from somebody who joined after the member turned sharing down", async () => {
    const { ann, circle, placeId } = await visit()
    await setSharing(ann.headers, circle.id, { sharingState: "approximate" })

    const carol = await registerUser(ctx.app, { displayName: "Carol" })
    await join(carol.headers, circle.invite.code)

    expect(await crossingsOf(carol.headers, circle.id, placeId)).toEqual([])
  })

  it("withholds them once the member leaves the circle", async () => {
    const { ann, ben, circle, placeId } = await visit()

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${ann.user.id}`,
      headers: ann.headers,
    })
    expect(left.statusCode).toBe(200)

    expect(await crossingsOf(ben.headers, circle.id, placeId)).toEqual([])
  })

  it("keeps a lapsed pause over an approximate baseline withheld", async () => {
    const { ann, ben, circle, placeId } = await visit()

    await setSharing(ann.headers, circle.id, { sharingState: "approximate" })
    await setSharing(ann.headers, circle.id, { sharingState: "paused", pausedUntil: iso(3600) })
    await lapsePause(ann.user.id)

    expect(await crossingsOf(ben.headers, circle.id, placeId)).toEqual([])
  })
})

describe("trips reject a timestamp Postgres cannot hold", () => {
  async function soloTraveller() {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers, "Home")
    return { ...user, circleId: circle.id }
  }

  it("answers 400 rather than handing year zero to the driver", async () => {
    const user = await soloTraveller()
    const base = `/api/v1/circles/${user.circleId}/members/${user.user.id}/trips`

    for (const url of [`${base}?to=${YEAR_ZERO}`, `${base}?from=${YEAR_ZERO}`]) {
      const response = await ctx.app.inject({ method: "GET", url, headers: user.headers })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { error: { code: string } }).error.code).toBe("validation_error")
    }
  })

  it("still accepts the window a client actually asks for", async () => {
    const user = await soloTraveller()
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)

    const response = await ctx.app.inject({
      method: "GET",
      url:
        `/api/v1/circles/${user.circleId}/members/${user.user.id}/trips` +
        `?from=${yesterday.toISOString()}&to=${now.toISOString()}`,
      headers: user.headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual([])
  })
})
