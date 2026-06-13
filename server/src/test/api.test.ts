import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../db/client"
import { getConfig } from "../env"
import { runJobs } from "../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "./helpers"

// A quiet residential street and a school ~1.2 km away, both in Bristol.
const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4636, lon: -2.5952 }

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

async function uploadFixes(
  headers: Record<string, string>,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    batteryLevel?: number
    isCharging?: boolean
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

describe("system", () => {
  it("answers health and readiness probes", async () => {
    const health = await ctx.app.inject({ method: "GET", url: "/healthz" })
    expect(health.statusCode).toBe(200)
    const ready = await ctx.app.inject({ method: "GET", url: "/readyz" })
    expect(ready.statusCode).toBe(200)
  })

  it("advertises capabilities without authentication", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/server-info" })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.pushProvider).toBe("none")
    expect(body.features.places).toBe(true)
    expect(body.mapStyleUrl).toContain("http")
  })
})

describe("auth", () => {
  it("makes the first account an administrator and later ones not", async () => {
    const first = await registerUser(ctx.app)
    const second = await registerUser(ctx.app)
    expect(first.user.isAdmin).toBe(true)
    expect(second.user.isAdmin).toBe(false)
  })

  it("has no first-account exemption from the invite gate", async () => {
    const admin = await registerUser(ctx.app)
    const set = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: admin.headers,
      payload: { registrationMode: "invite" },
    })
    expect(set.statusCode).toBe(200)

    // An empty user table with invite mode still in force is exactly the state
    // a freshly deployed server sits in, and it must not be claimable.
    await getDb().execute(sql`truncate table users restart identity cascade`)

    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "claimer@example.com",
        password: "correct-horse-battery",
        displayName: "Claimer",
        device: { deviceId: "device-claimer-1" },
      },
    })
    expect(blocked.statusCode).toBe(400)
  })

  it("rejects weak passwords and duplicate emails", async () => {
    const weak = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "weak@example.com",
        password: "short",
        displayName: "Weak",
        device: { deviceId: "device-weak-1" },
      },
    })
    expect(weak.statusCode).toBe(400)

    await registerUser(ctx.app, { email: "dupe@example.com" })
    const dupe = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "DUPE@example.com",
        password: "correct-horse-battery",
        displayName: "Dupe",
        device: { deviceId: "device-dupe-2" },
      },
    })
    expect(dupe.statusCode).toBe(409)
  })

  it("logs in, refreshes with rotation, and rejects the replayed token", async () => {
    const user = await registerUser(ctx.app, { email: "login@example.com" })

    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "login@example.com",
        password: "correct-horse-battery",
        device: { deviceId: "device-login-1", platform: "android" },
      },
    })
    expect(login.statusCode).toBe(200)
    const tokens = login.json() as { refreshToken: string }

    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(refreshed.json().refreshToken).not.toBe(tokens.refreshToken)

    const replay = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: tokens.refreshToken },
    })
    expect(replay.statusCode).toBe(401)

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: user.headers,
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().email).toBe("login@example.com")
  })

  it("does not reveal whether an email exists on bad login", async () => {
    await registerUser(ctx.app, { email: "exists@example.com" })
    const wrongPassword = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "exists@example.com",
        password: "nope-nope-nope",
        device: { deviceId: "d-1a2b3c" },
      },
    })
    const noAccount = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "ghost@example.com",
        password: "nope-nope-nope",
        device: { deviceId: "d-1a2b3c" },
      },
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(noAccount.statusCode).toBe(401)
    expect(wrongPassword.json().error.message).toBe(noAccount.json().error.message)
  })

  it("revokes the current session on logout", async () => {
    const user = await registerUser(ctx.app)
    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: user.headers,
    })
    expect(logout.statusCode).toBe(200)
    const refresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: user.refreshToken },
    })
    expect(refresh.statusCode).toBe(401)
  })
})

describe("nudges", () => {
  it("puts the message in the recipient's feed, and refuses one aimed outside the circle", async () => {
    const owner = await registerUser(ctx.app, { displayName: "Amina" })
    const circle = await createCircle(owner.headers)
    const driver = await registerUser(ctx.app, { displayName: "Yusuf" })
    const accepted = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: driver.headers,
    })
    expect(accepted.statusCode).toBe(200)

    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${driver.user.id}`,
      headers: owner.headers,
      payload: { quickKey: "slow_down" },
    })
    expect(sent.statusCode).toBe(200)

    // Nothing is stored to read back, so the feed is the only record of it.
    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: driver.headers,
    })
    expect(feed.statusCode).toBe(200)
    const nudge = (feed.json().items as Array<{ type: string; summary: string }>).find(
      (item) => item.type === "nudge_requested",
    )
    expect(nudge?.summary).toBe("Amina: Please slow down.")

    const outsider = await registerUser(ctx.app)
    const rejected = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${outsider.user.id}`,
      headers: owner.headers,
      payload: { quickKey: "call_me" },
    })
    expect(rejected.statusCode).toBe(404)
  })

  it("still works with no message, as a bare request for a location", async () => {
    const owner = await registerUser(ctx.app, { displayName: "Amina" })
    const circle = await createCircle(owner.headers)
    const driver = await registerUser(ctx.app, { displayName: "Yusuf" })
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: driver.headers,
    })

    const sent = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${driver.user.id}`,
      headers: owner.headers,
    })
    expect(sent.statusCode).toBe(200)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: driver.headers,
    })
    const nudge = (feed.json().items as Array<{ type: string; summary: string }>).find(
      (item) => item.type === "nudge_requested",
    )
    expect(nudge?.summary).toBe("Amina asked for a location update")
  })
})

describe("circles and invites", () => {
  it("creates a circle, invites a second member, and lists both", async () => {
    const owner = await registerUser(ctx.app, { displayName: "Owner" })
    const circle = await createCircle(owner.headers)

    const preview = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/invites/${circle.invite.code}`,
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().valid).toBe(true)
    expect(preview.json().circleName).toBe("Family")

    const joiner = await registerUser(ctx.app, { displayName: "Joiner" })
    const accept = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: joiner.headers,
    })
    expect(accept.statusCode).toBe(200)
    expect(accept.json().alreadyMember).toBe(false)

    const members = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members`,
      headers: owner.headers,
    })
    expect(members.statusCode).toBe(200)
    expect(members.json()).toHaveLength(2)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: owner.headers,
    })
    const types = (feed.json().items as Array<{ type: string }>).map((e) => e.type)
    expect(types).toContain("member_joined")
  })

  it("enforces capped invites atomically", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/invites`,
      headers: owner.headers,
      payload: { maxUses: 1 },
    })
    expect(invite.statusCode).toBe(201)
    const code = invite.json().code as string

    const a = await registerUser(ctx.app)
    const b = await registerUser(ctx.app)
    const [first, second] = await Promise.all([
      ctx.app.inject({ method: "POST", url: `/api/v1/invites/${code}/accept`, headers: a.headers }),
      ctx.app.inject({ method: "POST", url: `/api/v1/invites/${code}/accept`, headers: b.headers }),
    ])
    const statuses = [first.statusCode, second.statusCode].sort()
    expect(statuses).toEqual([200, 400])
  })

  it("keeps non-members out and respects roles", async () => {
    const owner = await registerUser(ctx.app)
    const outsider = await registerUser(ctx.app)
    const circle = await createCircle(owner.headers)

    const denied = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members`,
      headers: outsider.headers,
    })
    expect(denied.statusCode).toBe(403)

    const joiner = await registerUser(ctx.app)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: joiner.headers,
    })
    const cannotDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}`,
      headers: joiner.headers,
    })
    expect(cannotDelete.statusCode).toBe(403)

    const canDelete = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}`,
      headers: owner.headers,
    })
    expect(canDelete.statusCode).toBe(200)
  })
})

describe("roles", () => {
  async function circleWithAdminAndMember() {
    const owner = await registerUser(ctx.app, { displayName: "Owner" })
    const admin = await registerUser(ctx.app, { displayName: "Admin" })
    const member = await registerUser(ctx.app, { displayName: "Member" })
    const circle = await createCircle(owner.headers)
    for (const person of [admin, member]) {
      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/invites/${circle.invite.code}/accept`,
        headers: person.headers,
      })
    }
    const promote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${admin.user.id}`,
      headers: owner.headers,
      payload: { role: "admin" },
    })
    expect(promote.statusCode).toBe(200)
    expect(promote.json().role).toBe("admin")
    return { owner, admin, member, circle }
  }

  it("never lets an admin touch the owner or a peer admin", async () => {
    const { owner, admin, member, circle } = await circleWithAdminAndMember()

    const demoteOwner = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${owner.user.id}`,
      headers: admin.headers,
      payload: { role: "member" },
    })
    expect(demoteOwner.statusCode).toBe(403)

    const second = await registerUser(ctx.app, { displayName: "Admin2" })
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: second.headers,
    })
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${second.user.id}`,
      headers: owner.headers,
      payload: { role: "admin" },
    })
    const demotePeer = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${second.user.id}`,
      headers: admin.headers,
      payload: { role: "member" },
    })
    expect(demotePeer.statusCode).toBe(403)

    // Admins may still set nicknames and demote plain members they outrank.
    const nickname = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${member.user.id}`,
      headers: admin.headers,
      payload: { nickname: "Kiddo" },
    })
    expect(nickname.statusCode).toBe(200)
    expect(nickname.json().nickname).toBe("Kiddo")

    const members = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members`,
      headers: owner.headers,
    })
    const roles = Object.fromEntries(
      (members.json() as Array<{ userId: string; role: string }>).map((m) => [m.userId, m.role]),
    )
    expect(roles[owner.user.id]).toBe("owner")
    expect(roles[admin.user.id]).toBe("admin")
    expect(roles[second.user.id]).toBe("admin")
  })

  it("transfers ownership atomically and refuses a transfer to a non-member", async () => {
    const { owner, admin, circle } = await circleWithAdminAndMember()
    const outsider = await registerUser(ctx.app)

    const bad = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${outsider.user.id}`,
      headers: owner.headers,
      payload: { role: "owner" },
    })
    expect(bad.statusCode).toBe(404)

    // The failed transfer must not have demoted the owner.
    const still = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}`,
      headers: owner.headers,
    })
    expect(still.json().role).toBe("owner")

    const good = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${admin.user.id}`,
      headers: owner.headers,
      payload: { role: "owner" },
    })
    expect(good.statusCode).toBe(200)
    expect(good.json().role).toBe("owner")
    const after = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}`,
      headers: owner.headers,
    })
    expect(after.json().role).toBe("admin")
  })
})

describe("privacy of derived data", () => {
  it("a timed pause resumes to the state it replaced, not to precise", async () => {
    // Waiting out a pause must not silently upgrade someone who had chosen to
    // share only an approximate location.
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    const setSharing = (payload: Record<string, unknown>) =>
      ctx.app.inject({
        method: "PATCH",
        url: `/api/v1/circles/${circle.id}/sharing`,
        headers: user.headers,
        payload,
      })

    expect((await setSharing({ sharingState: "approximate" })).statusCode).toBe(200)
    const paused = await setSharing({
      sharingState: "paused",
      pausedUntil: new Date(Date.now() - 1000).toISOString(),
    })
    expect(paused.statusCode).toBe(200)

    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [row] = await getDb().execute(
      sql`select sharing_state, resume_to_state from circle_members where circle_id = ${circle.id}`,
    )
    expect(row).toMatchObject({ sharing_state: "approximate", resume_to_state: null })
  })

  it("does not announce arrivals or expose trips for a member sharing approximately", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: teen.headers,
    })
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
      payload: { name: "Friend's house", ...SCHOOL, radiusMeters: 150 },
    })
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: teen.headers,
      payload: { sharingState: "approximate" },
    })

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-120), accuracyMeters: 10 }])
    const result = await uploadFixes(teen.headers, [
      { ...SCHOOL, recordedAt: iso(-30), accuracyMeters: 10 },
    ])
    expect(result.placeEvents).toBe(0)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: parent.headers,
    })
    const types = (feed.json().items as Array<{ type: string }>).map((e) => e.type)
    expect(types).not.toContain("place_arrive")

    const presence = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: parent.headers,
        })
      ).json() as Array<{ userId: string; atPlace: unknown }>
    ).find((p) => p.userId === teen.user.id)!
    expect(presence.atPlace).toBeNull()

    const trips = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members/${teen.user.id}/trips`,
      headers: parent.headers,
    })
    expect(trips.statusCode).toBe(403)
  })

  it("ignores a retried batch in the geofence engine", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: { name: "Home", ...HOME, radiusMeters: 150 },
    })
    const batch = [
      { ...SCHOOL, recordedAt: iso(-300), accuracyMeters: 10 },
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 10 },
    ]
    const first = await uploadFixes(user.headers, batch)
    expect(first.placeEvents).toBe(1)
    const retry = await uploadFixes(user.headers, batch)
    expect(retry.accepted).toBe(0)
    expect(retry.placeEvents).toBe(0)
  })
})

describe("locations, presence and privacy", () => {
  it("ingests a batch, dedupes retries, and projects presence per viewer", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const circle = await createCircle(alice.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: bob.headers,
    })

    const fix = { ...HOME, recordedAt: iso(-10), accuracyMeters: 12, batteryLevel: 0.8 }
    const first = await uploadFixes(alice.headers, [fix])
    expect(first.accepted).toBe(1)
    const retry = await uploadFixes(alice.headers, [fix])
    expect(retry.accepted).toBe(0)
    expect(retry.rejected).toBe(0)

    const seenByBob = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/locations`,
      headers: bob.headers,
    })
    expect(seenByBob.statusCode).toBe(200)
    const aliceRow = (
      seenByBob.json() as Array<{
        userId: string
        lat: number
        approximate: boolean
        sharingState: string
      }>
    ).find((p) => p.userId === alice.user.id)!
    expect(aliceRow.lat).toBeCloseTo(HOME.lat, 4)
    expect(aliceRow.approximate).toBe(false)

    // Alice switches to approximate. Bob sees a fuzzed point, Alice still sees herself exactly.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: alice.headers,
      payload: { sharingState: "approximate" },
    })
    const fuzzed = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: bob.headers,
        })
      ).json() as Array<{
        userId: string
        lat: number
        lon: number
        approximate: boolean
        accuracyMeters: number
      }>
    ).find((p) => p.userId === alice.user.id)!
    expect(fuzzed.approximate).toBe(true)
    expect(fuzzed.accuracyMeters).toBeGreaterThanOrEqual(750)
    expect(fuzzed.lat === HOME.lat && fuzzed.lon === HOME.lon).toBe(false)

    const self = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: alice.headers,
        })
      ).json() as Array<{ userId: string; lat: number; approximate: boolean }>
    ).find((p) => p.userId === alice.user.id)!
    expect(self.approximate).toBe(false)
    expect(self.lat).toBeCloseTo(HOME.lat, 4)

    // Paused: nothing leaks, not even battery.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: alice.headers,
      payload: { sharingState: "paused" },
    })
    const hidden = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: bob.headers,
        })
      ).json() as Array<{
        userId: string
        lat: number | null
        batteryLevel: number | null
        sharingState: string
      }>
    ).find((p) => p.userId === alice.user.id)!
    expect(hidden.lat).toBeNull()
    expect(hidden.batteryLevel).toBeNull()
    expect(hidden.sharingState).toBe("paused")

    // History is refused while not sharing precisely.
    const history = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members/${alice.user.id}/history`,
      headers: bob.headers,
    })
    expect(history.statusCode).toBe(403)
  })

  it("rejects garbage fixes without failing the batch", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: {
        points: [
          { ...HOME, recordedAt: iso(-5) },
          { ...HOME, recordedAt: iso(60 * 60) },
          { ...HOME, recordedAt: "not-a-date" },
        ],
      },
    })
    // The unparsable date fails schema validation for the whole body...
    expect(response.statusCode).toBe(400)

    const partial = await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-5) },
      { ...HOME, recordedAt: iso(60 * 60) },
    ])
    // ...while a well-formed but implausible timestamp is dropped individually.
    expect(partial.accepted).toBe(1)
    expect(partial.rejected).toBe(1)
  })

  it("never rewinds presence on an out-of-order upload", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await uploadFixes(user.headers, [{ ...SCHOOL, recordedAt: iso(-10) }])
    await uploadFixes(user.headers, [{ ...HOME, recordedAt: iso(-600) }])
    const presence = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: user.headers,
        })
      ).json() as Array<{ lat: number }>
    )[0]!
    expect(presence.lat).toBeCloseTo(SCHOOL.lat, 4)
  })
})

describe("places and geofencing", () => {
  it("emits arrive and leave with hysteresis, and primes members already inside", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: kid.headers,
    })

    // Kid is already at home when the place is created, so no spurious arrival.
    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-300), accuracyMeters: 10 }])
    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
      payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
    })
    expect(place.statusCode).toBe(201)
    expect(place.json().membersInside).toContain(kid.user.id)

    const school = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
      payload: { name: "School", icon: "school", ...SCHOOL, radiusMeters: 200 },
    })
    expect(school.statusCode).toBe(201)

    // Drift outside the radius but still inside the exit buffer, so still "home".
    const drift = { lat: HOME.lat + 0.00153, lon: HOME.lon }
    let result = await uploadFixes(kid.headers, [
      { ...drift, recordedAt: iso(-240), accuracyMeters: 10 },
    ])
    expect(result.placeEvents).toBe(0)

    // Walk to school: one leave (home) + one arrive (school).
    result = await uploadFixes(kid.headers, [
      { ...SCHOOL, recordedAt: iso(-120), accuracyMeters: 10 },
    ])
    expect(result.placeEvents).toBe(2)

    const feed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/events`,
      headers: parent.headers,
    })
    const summaries = feed.json().items as Array<{ type: string; summary: string }>
    expect(summaries.some((e) => e.type === "place_leave" && e.summary.includes("Home"))).toBe(true)
    expect(summaries.some((e) => e.type === "place_arrive" && e.summary.includes("School"))).toBe(
      true,
    )

    // A hopeless fix must not move anyone.
    result = await uploadFixes(kid.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 1000 },
    ])
    expect(result.placeEvents).toBe(0)

    const presence = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: parent.headers,
        })
      ).json() as Array<{ userId: string; atPlace: { name: string } | null }>
    ).find((p) => p.userId === kid.user.id)!
    expect(presence.atPlace?.name).toBe("School")

    // Notifications were queued for the parent but not the kid (the actor).
    const db = getDb()
    const outbox = (await db.execute(
      sql`select user_id, title from notification_outbox`,
    )) as unknown as Array<{ user_id: string; title: string }>
    const recipients = new Set(outbox.map((row) => row.user_id))
    expect(recipients.has(parent.user.id)).toBe(true)
    expect(recipients.has(kid.user.id)).toBe(false)
  })
})

describe("safety", () => {
  it("raises and resolves an SOS, un-pausing the sender's location", async () => {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const circle = await createCircle(alice.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: bob.headers,
    })
    await uploadFixes(alice.headers, [{ ...HOME, recordedAt: iso(-5) }])
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: alice.headers,
      payload: { sharingState: "paused" },
    })

    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: alice.headers,
      payload: { note: "Car broke down" },
    })
    expect(sos.statusCode).toBe(201)
    expect(sos.json().notifiedMembers).toBe(1)

    const seen = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: bob.headers,
        })
      ).json() as Array<{ userId: string; lat: number | null; sosAlertId: string | null }>
    ).find((p) => p.userId === alice.user.id)!
    expect(seen.lat).not.toBeNull()
    expect(seen.sosAlertId).toBe(sos.json().id)

    const duplicate = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: alice.headers,
      payload: {},
    })
    expect(duplicate.statusCode).toBe(409)

    const bobCannotResolve = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${sos.json().id}/resolve`,
      headers: bob.headers,
    })
    expect(bobCannotResolve.statusCode).toBe(403)

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${sos.json().id}/resolve`,
      headers: alice.headers,
    })
    expect(resolved.statusCode).toBe(200)
  })

  it("records a check-in and attaches the matching place", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: { name: "Home", ...HOME, radiusMeters: 150 },
    })
    const checkIn = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: user.headers,
      payload: { ...HOME, note: "Made it" },
    })
    expect(checkIn.statusCode).toBe(201)
    expect(checkIn.json().placeName).toBe("Home")
  })
})

describe("trips and background jobs", () => {
  it("turns a run of breadcrumbs into a trip and prunes old history", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // A 20-minute drive, 15 minutes ago, sampled every minute, ending at school.
    const start = Date.now() - 35 * 60 * 1000
    const points = Array.from({ length: 21 }, (_, i) => {
      const t = i / 20
      return {
        lat: HOME.lat + (SCHOOL.lat - HOME.lat) * t,
        lon: HOME.lon + (SCHOOL.lon - HOME.lon) * t,
        recordedAt: new Date(start + i * 60 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 4,
      }
    })
    await uploadFixes(user.headers, points)

    // An old breadcrumb, kept by the circle's own retention until it is tightened below.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString() },
    ])

    const report = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(report.tripsDetected).toBe(1)

    const trips = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/trips",
      headers: user.headers,
    })
    expect(trips.statusCode).toBe(200)
    const [trip] = trips.json() as Array<{
      distanceMeters: number
      pointCount: number
      durationSeconds: number
    }>
    expect(trip).toBeDefined()
    expect(trip!.pointCount).toBe(21)
    expect(trip!.distanceMeters).toBeGreaterThan(1000)
    expect(trip!.durationSeconds).toBe(20 * 60)

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}`,
      headers: user.headers,
      payload: { settings: { historyRetentionDays: 1 } },
    })
    const second = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(second.prunedPoints).toBe(1)
  })

  it("applies the admin's history cap to the sweep, not just to the settings row", async () => {
    // The cap was readable, writable and persisted, and the job that enforces
    // retention read the value the process booted with instead. Changing it
    // from the app looked like it worked and swept nothing.
    const admin = await registerUser(ctx.app)
    await createCircle(admin.headers)

    // Old, but still inside the circle's own retention window.
    await uploadFixes(admin.headers, [
      { ...HOME, recordedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString() },
    ])
    const before = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(before.prunedPoints).toBe(0)

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: admin.headers,
      payload: { maxHistoryRetentionDays: 1 },
    })
    expect(patch.statusCode).toBe(200)

    // Server-wide, so it overrides the circle's looser setting.
    const after = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(after.prunedPoints).toBe(1)
  })
})

describe("account ownership", () => {
  it("exports and deletes an account, handing circles to an heir", async () => {
    const owner = await registerUser(ctx.app, { displayName: "Owner" })
    const heir = await registerUser(ctx.app, { displayName: "Heir" })
    const circle = await createCircle(owner.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: heir.headers,
    })
    await uploadFixes(owner.headers, [{ ...HOME, recordedAt: iso(-5) }])

    const exported = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/export",
      headers: owner.headers,
    })
    expect(exported.statusCode).toBe(200)
    expect(exported.json().locationHistory).toHaveLength(1)
    expect(exported.json().circles).toHaveLength(1)

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/me",
      headers: owner.headers,
      payload: { password: "correct-horse-battery" },
    })
    expect(deleted.statusCode).toBe(200)

    const circles = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/circles",
      headers: heir.headers,
    })
    expect(circles.statusCode).toBe(200)
    expect(circles.json()[0].role).toBe("owner")
    expect(circles.json()[0].memberCount).toBe(1)
  })
})

describe("admin", () => {
  it("gates admin routes and reports stats", async () => {
    const admin = await registerUser(ctx.app)
    const regular = await registerUser(ctx.app)

    const denied = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: regular.headers,
    })
    expect(denied.statusCode).toBe(403)

    const stats = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: admin.headers,
    })
    expect(stats.statusCode).toBe(200)
    expect(stats.json().users).toBe(2)

    const closed = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: admin.headers,
      payload: { registrationMode: "closed" },
    })
    expect(closed.statusCode).toBe(200)

    const blocked = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "late@example.com",
        password: "correct-horse-battery",
        displayName: "Late",
        device: { deviceId: "device-late-1" },
      },
    })
    expect(blocked.statusCode).toBe(403)
  })
})

describe("history bounds", () => {
  it("hides breadcrumbs recorded before the member joined the circle", async () => {
    const owner = await registerUser(ctx.app, { displayName: "Owner" })
    const newcomer = await registerUser(ctx.app, { displayName: "Newcomer" })
    const circle = await createCircle(owner.headers)

    await uploadFixes(newcomer.headers, [{ ...HOME, recordedAt: iso(-3600) }])

    const accepted = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: newcomer.headers,
    })
    expect(accepted.statusCode).toBe(200)

    await uploadFixes(newcomer.headers, [{ ...SCHOOL, recordedAt: iso(60) }])

    const history = await ctx.app.inject({
      method: "GET",
      url:
        `/api/v1/circles/${circle.id}/members/${newcomer.user.id}/history` +
        `?from=1970-01-01T00:00:00.000Z&to=${encodeURIComponent(iso(600))}`,
      headers: owner.headers,
    })
    expect(history.statusCode).toBe(200)
    const points = history.json() as { lat: number }[]
    expect(points).toHaveLength(1)
    expect(points[0]!.lat).toBe(SCHOOL.lat)
  })
})

describe("admin account state", () => {
  it("keeps an administrator and ends a deactivated account's sessions", async () => {
    const admin = await registerUser(ctx.app)
    const member = await registerUser(ctx.app)

    const self = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${admin.user.id}`,
      headers: admin.headers,
      payload: { isActive: false },
    })
    expect(self.statusCode).toBe(400)

    const deactivated = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${member.user.id}`,
      headers: admin.headers,
      payload: { isActive: false },
    })
    expect(deactivated.statusCode).toBe(200)

    const refresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: member.refreshToken },
    })
    expect(refresh.statusCode).toBe(401)

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: admin.headers,
    })
    const row = (listed.json() as { id: string; deviceCount: number }[]).find(
      (entry) => entry.id === member.user.id,
    )!
    expect(row.deviceCount).toBe(0)
  })
})
