import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { events } from "../../db/schema"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, silentSinceLastFix, startTestApp, type TestContext } from "../helpers"

/**
 * The feed re-checks the subject's current sharing state the way the map does,
 * a lapsed pause falls back to the state it replaced, and the offline alert is
 * owed to each circle separately.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const CLINIC = { lat: 51.4636, lon: -2.5952 }

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

async function addPlace(headers: Headers, circleId: string, name: string, point: typeof HOME) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { name, ...point, radiusMeters: 150 },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string }
}

async function uploadFixes(
  headers: Headers,
  points: { lat: number; lon: number; recordedAt: string; accuracyMeters?: number }[],
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
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

async function feed(headers: Headers, circleId: string, query = "") {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events${query}`,
    headers,
  })
  return {
    status: response.statusCode,
    body: response.json() as {
      items: { id: string; type: string; summary: string; payload: Record<string, unknown> }[]
      nextCursor: string | null
    },
  }
}

const feedTypes = async (headers: Headers, circleId: string) =>
  (await feed(headers, circleId)).body.items.map((item) => item.type)

async function unreadCount(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events/unread-count`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { unread: number }).unread
}

async function presenceFor(headers: Headers, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/locations`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as {
    userId: string
    lat: number | null
    accuracyMeters: number | null
    approximate: boolean
    sharingState: string
  }[]
  return rows.find((row) => row.userId === userId)!
}

/** The hour a member asked for has passed, without the test waiting for it. */
async function elapsePause(userId: string, circleId: string) {
  await getDb().execute(
    sql`update circle_members set paused_until = now() - interval '2 minutes'
        where user_id = ${userId}::uuid and circle_id = ${circleId}::uuid`,
  )
}

/**
 * Alice arrives at a named place while sharing precisely with the circle, which
 * is the trail every spec below expects her to be able to take back.
 */
async function trailAtTheClinic() {
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  // Bob owns the circle, so Alice is free to walk out of it in the spec below.
  const circle = await createCircle(bob.headers)
  await joinCircle(alice.headers, circle.invite.code)
  await addPlace(bob.headers, circle.id, "Therapist Office", CLINIC)

  await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-900), accuracyMeters: 11 }])
  await uploadFixes(alice.headers, [{ ...CLINIC, recordedAt: iso(-600), accuracyMeters: 9 }])

  const seen = await feed(bob.headers, circle.id)
  expect(seen.body.items.map((item) => item.type)).toContain("place_arrive")
  return { alice, bob, circle }
}

describe("the feed re-checks the sharing state the map already re-checks", () => {
  it("takes back a named-place trail when the member switches to approximate", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()

    await setSharing(alice.headers, circle.id, { sharingState: "approximate" })

    const items = (await feed(bob.headers, circle.id)).body.items
    expect(items.map((item) => item.type)).not.toContain("place_arrive")
    expect(items.map((item) => item.summary)).not.toContain("Alice arrived at Therapist Office")
    // The rest of the circle's record is not location, and stays. Naming the
    // place is fine there: the circle wrote the place down itself.
    expect(items.map((item) => item.type)).toContain("member_joined")
    expect(items.map((item) => item.type)).toContain("place_created")
  })

  it("takes it back while paused and hands it straight back when sharing resumes", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()

    await setSharing(alice.headers, circle.id, { sharingState: "paused" })
    expect(await feedTypes(bob.headers, circle.id)).not.toContain("place_arrive")

    // Read-time gating, not a purge: a pause of an hour must not cost her the
    // trail for good.
    await setSharing(alice.headers, circle.id, { sharingState: "precise" })
    expect(await feedTypes(bob.headers, circle.id)).toContain("place_arrive")
  })

  it("hides a speeding alert from a paused circle too", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()
    await getDb()
      .insert(events)
      .values({
        circleId: circle.id,
        actorUserId: alice.user.id,
        type: "speed_alert",
        summary: "Alice was driving at 121 km/h",
        payload: { speedKmh: 121 },
      })
    expect(await feedTypes(bob.headers, circle.id)).toContain("speed_alert")

    await setSharing(alice.headers, circle.id, { sharingState: "paused" })
    expect(await feedTypes(bob.headers, circle.id)).not.toContain("speed_alert")
  })

  it("still shows a member their own trail while they are paused", async () => {
    const { alice, circle } = await trailAtTheClinic()
    await setSharing(alice.headers, circle.id, { sharingState: "paused" })

    expect(await feedTypes(alice.headers, circle.id)).toContain("place_arrive")
  })

  it("gives a member who joins during the pause nothing to catch up on", async () => {
    const { alice, circle } = await trailAtTheClinic()
    await setSharing(alice.headers, circle.id, { sharingState: "paused" })

    const carol = await registerUser(ctx.app, { displayName: "Carol" })
    await joinCircle(carol.headers, circle.invite.code)

    const items = (await feed(carol.headers, circle.id)).body.items
    expect(items.map((item) => item.type)).not.toContain("place_arrive")
    expect(items.map((item) => item.type)).toContain("member_joined")
  })

  it("takes the trail with her when she leaves the circle", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${alice.user.id}`,
      headers: alice.headers,
    })
    expect(left.statusCode).toBe(200)

    expect(await feedTypes(bob.headers, circle.id)).not.toContain("place_arrive")
  })

  it("keeps the unread badge agreeing with the feed", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()

    const speeding = () =>
      getDb()
        .insert(events)
        .values({
          circleId: circle.id,
          actorUserId: alice.user.id,
          type: "speed_alert",
          summary: "Alice was driving at 121 km/h",
          payload: { speedKmh: 121 },
        })
    const markRead = async () => {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/events/read`,
        headers: bob.headers,
      })
      expect(response.statusCode).toBe(200)
    }

    await markRead()
    await speeding()
    expect(await unreadCount(bob.headers, circle.id)).toBe(1)

    // A badge over a feed with nothing in it is a leak of its own: the count
    // alone says how often somebody who stopped sharing sets alerts off.
    await setSharing(alice.headers, circle.id, { sharingState: "paused" })
    await markRead()
    await speeding()
    expect(await unreadCount(bob.headers, circle.id)).toBe(0)
    expect(await feedTypes(bob.headers, circle.id)).not.toContain("speed_alert")
  })

  it("goes on hiding it when a timed pause lapses back to approximate", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()

    await setSharing(alice.headers, circle.id, { sharingState: "approximate" })
    await setSharing(alice.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, circle.id)

    // No job has run, so the row still reads paused and only the read path can
    // work out that she is back on the coarse grid rather than precise.
    expect(await feedTypes(bob.headers, circle.id)).not.toContain("place_arrive")
  })

  it("hands it back when a timed pause lapses to precise", async () => {
    const { alice, bob, circle } = await trailAtTheClinic()

    await setSharing(alice.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, circle.id)

    expect(await feedTypes(bob.headers, circle.id)).toContain("place_arrive")
  })
})

describe("a cursor that is not an events.id", () => {
  it("answers with an empty page instead of a 500", async () => {
    const { bob, circle } = await trailAtTheClinic()

    for (const cursor of ["1.5", "0.0000001", "1e-7", "2.9999999999999996", "9".repeat(26)]) {
      const response = await feed(bob.headers, circle.id, `?limit=5&cursor=${cursor}`)
      expect([cursor, response.status]).toEqual([cursor, 200])
      expect(response.body.items).toEqual([])
    }
  })

  it("still pages on a real one", async () => {
    const { bob, circle } = await trailAtTheClinic()

    const first = await feed(bob.headers, circle.id, "?limit=1")
    expect(first.body.nextCursor).not.toBeNull()

    const second = await feed(bob.headers, circle.id, `?limit=5&cursor=${first.body.nextCursor}`)
    expect(second.status).toBe(200)
    expect(second.body.items.length).toBeGreaterThan(0)
    expect(second.body.items.map((item) => item.id)).not.toContain(first.body.items[0]!.id)
  })
})

describe("a timed pause lapsing on the map", () => {
  it("comes back to approximate, not to the exact fix", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const circle = await createCircle(alice.headers)
    await joinCircle(bob.headers, circle.invite.code)

    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 12 }])
    await setSharing(alice.headers, circle.id, { sharingState: "approximate" })
    await setSharing(alice.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, circle.id)

    const seen = await presenceFor(bob.headers, circle.id, alice.user.id)
    expect(seen.sharingState).toBe("approximate")
    expect(seen.approximate).toBe(true)
    expect(seen.lat).not.toBe(HOME.lat)
    expect(seen.accuracyMeters).toBe(750)
  })

  it("comes back to precise when precise is what it replaced", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const circle = await createCircle(alice.headers)
    await joinCircle(bob.headers, circle.invite.code)

    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 12 }])
    await setSharing(alice.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    })
    await elapsePause(alice.user.id, circle.id)

    const seen = await presenceFor(bob.headers, circle.id, alice.user.id)
    expect(seen.sharingState).toBe("precise")
    expect(seen.lat).toBe(HOME.lat)
  })
})

describe("the offline alert is owed to each circle separately", () => {
  const tick = () => runJobs(getDb(), getConfig(), ctx.app.log)

  it("tells the circle that was paused for the first sweep, once, later", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const friend = await registerUser(ctx.app, { displayName: "Friend" })
    const family = await createCircle(parent.headers, "Family")
    const friends = await createCircle(friend.headers, "Friends")
    await joinCircle(teen.headers, family.invite.code)
    await joinCircle(teen.headers, friends.invite.code)

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-95 * 60), accuracyMeters: 14 }])
    await silentSinceLastFix(teen.user.id)
    await setSharing(teen.headers, family.id, { sharingState: "paused" })

    await tick()
    expect(await feedTypes(friend.headers, friends.id)).toContain("device_offline")
    expect(await feedTypes(parent.headers, family.id)).not.toContain("device_offline")

    await setSharing(teen.headers, family.id, { sharingState: "precise" })
    await tick()
    await tick()

    const family_ = (await feedTypes(parent.headers, family.id)).filter(
      (type) => type === "device_offline",
    )
    const friends_ = (await feedTypes(friend.headers, friends.id)).filter(
      (type) => type === "device_offline",
    )
    expect([family_.length, friends_.length]).toEqual([1, 1])
  })

  it("says it once more when the phone comes back and goes quiet again", async () => {
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const family = await createCircle(parent.headers, "Family")
    await joinCircle(teen.headers, family.invite.code)

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-95 * 60), accuracyMeters: 14 }])
    await silentSinceLastFix(teen.user.id)
    await tick()
    await tick()

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-30), accuracyMeters: 12 }])
    await getDb().execute(
      sql`update user_presence
          set recorded_at = now() - interval '95 minutes',
              last_heard_at = now() - interval '95 minutes'
          where user_id = ${teen.user.id}::uuid`,
    )
    await tick()

    expect(
      (await feedTypes(parent.headers, family.id)).filter((type) => type === "device_offline"),
    ).toHaveLength(2)
  })
})
