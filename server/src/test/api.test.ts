import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../db/client"
import { getConfig } from "../env"
import { runJobs } from "../jobs/scheduler"
import { registerUser, sessionIdOf, startTestApp, type TestContext } from "./helpers"

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
    speedMps?: number
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

/**
 * Metres to degrees of latitude on the same sphere the geofence maths uses, so
 * a point placed N metres north of a fence centre measures N metres from it.
 */
const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180

const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})

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

async function listSessions(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ id: string; platform: string | null; current: boolean }>
}

async function setCircleSettings(
  headers: Record<string, string>,
  circleId: string,
  settings: Record<string, unknown>,
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}`,
    headers,
    payload: { settings },
  })
  expect(response.statusCode).toBe(200)
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
    payload: Record<string, unknown>
  }>
}

async function myTrips(headers: Record<string, string>) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/trips", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{
    startedAt: string
    endedAt: string
    distanceMeters: number
    durationSeconds: number
    maxSpeedMps: number | null
    avgSpeedMps: number | null
    pointCount: number
  }>
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

  it("lists one row per device and hides one that has lapsed", async () => {
    const phone = await registerUser(ctx.app, { deviceId: "device-a" })
    await signInDevice(phone.email, "device-b")

    const both = await listSessions(phone.headers)
    expect(both).toHaveLength(2)
    expect(both.filter((row) => row.current).map((row) => row.id)).toEqual([
      sessionIdOf(phone.accessToken),
    ])

    // Signing in again from the same device reuses its row.
    const again = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: phone.email,
        password: "correct-horse-battery",
        device: { deviceId: "device-a", deviceName: "Test Phone", platform: "ios" },
      },
    })
    expect(again.statusCode).toBe(200)
    expect(await listSessions(phone.headers)).toHaveLength(2)

    // And so does a refresh.
    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: (again.json() as { refreshToken: string }).refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(await listSessions(phone.headers)).toHaveLength(2)

    // A row past its expiry can no longer refresh, so it is not signed in,
    // however long the prune job takes to get to it.
    await getDb().execute(sql`
      update sessions set expires_at = now() - interval '1 minute'
      where user_id = ${phone.user.id}::uuid and device_id = 'device-b'
    `)
    const remaining = await listSessions(phone.headers)
    expect(remaining.map((row) => row.platform)).toEqual(["ios"])
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

  it("stops naming someone inside a place once they pause sharing", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: kid.headers,
    })

    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-300), accuracyMeters: 10 }])
    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
      payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
    })
    expect(place.statusCode).toBe(201)
    expect(place.json().membersInside).toContain(kid.user.id)

    const paused = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: kid.headers,
      payload: { sharingState: "paused" },
    })
    expect(paused.statusCode).toBe(200)

    // Off to school with sharing paused. Nothing evaluates the fence now, so
    // the membership row is frozen at "at Home" and must not be served as fact.
    await uploadFixes(kid.headers, [{ ...SCHOOL, recordedAt: iso(-60), accuracyMeters: 10 }])

    const listed = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
    })
    expect(listed.statusCode).toBe(200)
    const home = (listed.json() as Array<{ name: string; membersInside: string[] }>).find(
      (row) => row.name === "Home",
    )!
    expect(home.membersInside).not.toContain(kid.user.id)
  })

  it("does not prime an approximate member into a new place", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(parent.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: kid.headers,
    })

    const coarse = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: kid.headers,
      payload: { sharingState: "approximate" },
    })
    expect(coarse.statusCode).toBe(200)

    // Presence is still recorded while approximate, so priming a new place
    // finds the kid standing in it. Naming a doorstep is what approximate exists
    // to withhold.
    await uploadFixes(kid.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 10 }])
    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
      payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
    })
    expect(place.statusCode).toBe(201)
    expect(place.json().membersInside).not.toContain(kid.user.id)
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

  it("streams a multi-point history as one valid export document", async () => {
    const walker = await registerUser(ctx.app, { displayName: "Walker" })
    await uploadFixes(walker.headers, [
      { ...HOME, recordedAt: iso(-300) },
      { ...HOME, recordedAt: iso(-240) },
      { ...SCHOOL, recordedAt: iso(-180) },
    ])

    const exported = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/me/export",
      headers: walker.headers,
    })
    expect(exported.statusCode).toBe(200)
    const body = exported.json() as {
      profile: { id: string }
      locationHistory: Array<{ recordedAt: string }>
    }
    expect(body.profile.id).toBe(walker.user.id)
    expect(body.locationHistory).toHaveLength(3)
    expect(new Date(body.locationHistory[0]!.recordedAt).getTime()).toBeGreaterThan(
      new Date(body.locationHistory[2]!.recordedAt).getTime(),
    )
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

  it("reports each account's longest silence over the last day", async () => {
    const admin = await registerUser(ctx.app)
    const member = await registerUser(ctx.app)
    await createCircle(member.headers)
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
    // Fixes 5, 20 and 22 minutes apart, then quiet for the last 10 minutes:
    // the twenty minute gap is the longest, not the silence since.
    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: member.headers,
      payload: {
        points: [57, 52, 32, 10].map((minutes) => ({
          lat: 51.45,
          lon: -2.58,
          recordedAt: at(minutes),
          accuracyMeters: 10,
        })),
      },
    })
    expect(upload.statusCode).toBe(200)

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: admin.headers,
    })
    const rows = listed.json() as { id: string; longestSilenceSeconds: number | null }[]
    const quiet = rows.find((entry) => entry.id === member.user.id)!
    expect(quiet.longestSilenceSeconds).toBeGreaterThanOrEqual(22 * 60 - 5)
    expect(quiet.longestSilenceSeconds).toBeLessThan(23 * 60)
    // Never reported: nothing to measure.
    expect(rows.find((entry) => entry.id === admin.user.id)?.longestSilenceSeconds).toBeNull()
  })
})

describe("trip detection over long and interleaved streams", () => {
  it("detects a later journey once an earlier run has filled a whole detection pass", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    // A little over 5000 fixes with no gap anywhere near the idle gap, which is
    // what a long motorway leg looks like on a device delivering on distance.
    const runStart = new Date(Date.now() - 200 * 60 * 1000)
    await getDb().execute(sql`
      insert into location_points
        (user_id, device_id, recorded_at, lat, lon, accuracy_meters, speed_mps, source)
      select
        ${user.user.id}::uuid,
        'long-leg',
        ${runStart.toISOString()}::timestamptz + (n * interval '2 seconds'),
        ${HOME.lat} + n * 0.00024,
        ${HOME.lon},
        8,
        13.3,
        'background'
      from generate_series(0, 5000) as n
    `)

    // A separate, fully settled drive well after the run ended.
    const secondStart = Date.now() - 25 * 60 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 10 }, (_, i) => ({
        ...northOf(SCHOOL, i * 600),
        recordedAt: new Date(secondStart + i * 60 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 10,
      })),
    )

    await runJobs(getDb(), getConfig(), ctx.app.log)
    await runJobs(getDb(), getConfig(), ctx.app.log)
    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect((await myTrips(user.headers)).length).toBeGreaterThan(0)
  })

  it("keeps a trip's average speed within the fastest fix it contains", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "device-tablet-merge")

    // A 12 km drive at a steady 10 m/s, twenty minutes long.
    const driveStart = Date.now() - 40 * 60 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 21 }, (_, i) => ({
        ...northOf(HOME, i * 600),
        recordedAt: new Date(driveStart + i * 60 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 10,
      })),
    )

    // The same account's second device never left the house.
    await uploadFixes(tablet, [
      {
        ...HOME,
        recordedAt: new Date(driveStart + 10 * 60 * 1000 + 30_000).toISOString(),
        accuracyMeters: 20,
        speedMps: 0,
      },
    ])

    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [trip] = await myTrips(user.headers)
    expect(trip).toBeDefined()
    expect(trip!.avgSpeedMps!).toBeLessThanOrEqual(trip!.maxSpeedMps!)
    expect(trip!.distanceMeters).toBeLessThan(15_000)
  })

  it("reports a top speed that two consecutive fixes agree on", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    // A steady 12 m/s drive carrying one impossible sample, the kind an Android
    // provider switch emits. The positions on either side of it are untouched.
    const driveStart = Date.now() - 40 * 60 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 21 }, (_, i) => ({
        ...northOf(HOME, i * 720),
        recordedAt: new Date(driveStart + i * 60 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: i === 8 ? 62 : 12,
      })),
    )

    await runJobs(getDb(), getConfig(), ctx.app.log)

    const [trip] = await myTrips(user.headers)
    expect(trip).toBeDefined()
    expect(trip!.maxSpeedMps).toBe(12)
  })

  it("never splits one drive into two trips when its last fixes arrive after a sweep", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    const driveStart = Date.now() - 20 * 60 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 17 }, (_, i) => ({
        ...northOf(HOME, i * 300),
        recordedAt: new Date(driveStart + i * 30 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 10,
      })),
    )
    await runJobs(getDb(), getConfig(), ctx.app.log)

    // The same drive, still under way, whose next fixes only reach the server
    // after that sweep. Thirty seconds is nowhere near the idle gap.
    await uploadFixes(
      user.headers,
      Array.from({ length: 8 }, (_, i) => ({
        ...northOf(HOME, 4800 + (i + 1) * 300),
        recordedAt: new Date(driveStart + (17 + i) * 30 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 10,
      })),
    )
    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect((await myTrips(user.headers)).length).toBeLessThanOrEqual(1)
  })

  it("detects a drive uploaded late by one device after another has already reported", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const tablet = await signInDevice(user.email, "device-tablet-watermark")

    // The tablet at home reports first, so the sweep has something to settle.
    await uploadFixes(tablet, [
      { ...HOME, recordedAt: iso(-6 * 60), accuracyMeters: 20, speedMps: 0 },
    ])
    await runJobs(getDb(), getConfig(), ctx.app.log)

    // The phone, out of signal for the whole drive, flushes its backlog.
    const driveStart = Date.now() - 40 * 60 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 17 }, (_, i) => ({
        ...northOf(SCHOOL, i * 300),
        recordedAt: new Date(driveStart + i * 30 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: 10,
      })),
    )
    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect(await myTrips(user.headers)).toHaveLength(1)
  })

  it("does not turn a phone sitting still and pinging on a timer into a trip", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    // An emergency ping repeats on a timer rather than on movement, so someone
    // sitting still still produces a dense stream. Its path length grows with
    // every ping while the person has not gone anywhere.
    const metresPerDegreeLon = METRES_PER_DEGREE_LAT * Math.cos((HOME.lat * Math.PI) / 180)
    let seed = 7
    const jitterMetres = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed / 2147483648 - 0.5) * 2 * 26
    }
    const start = Date.now() - 60 * 60 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 90 }, (_, i) => ({
        lat: HOME.lat + jitterMetres() / METRES_PER_DEGREE_LAT,
        lon: HOME.lon + jitterMetres() / metresPerDegreeLon,
        recordedAt: new Date(start + i * 20 * 1000).toISOString(),
        accuracyMeters: 15,
        speedMps: 0,
      })),
    )

    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect(await myTrips(user.headers)).toHaveLength(0)
  })
})

describe("geofence accuracy and ordering", () => {
  it("does not replay stragglers once a newer fix has been evaluated", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
    })

    // Outside, so the fence starts from a known state.
    await uploadFixes(user.headers, [
      { ...northOf(HOME, 400), recordedAt: iso(-300), accuracyMeters: 10 },
    ])

    // A fresh single fix, uploaded on its own the way a nudge reply is.
    const arrived = await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 10 },
    ])
    expect(arrived.placeEvents).toBe(1)

    // The OS now flushes the buffer it was holding while that reply went out.
    // Every fix in it predates the arrival, so the fence must ignore them.
    const held = await uploadFixes(user.headers, [
      { ...northOf(HOME, 400), recordedAt: iso(-120), accuracyMeters: 10 },
      { ...northOf(HOME, 400), recordedAt: iso(-100), accuracyMeters: 10 },
    ])
    expect(held.placeEvents).toBe(0)

    const rest = await uploadFixes(user.headers, [
      { ...northOf(HOME, 200), recordedAt: iso(-90), accuracyMeters: 10 },
      { ...northOf(HOME, 200), recordedAt: iso(-85), accuracyMeters: 10 },
    ])
    expect(rest.placeEvents).toBe(0)
  })

  it("ignores a fix whose accuracy circle is wider than the fence it would decide", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: { name: "School", icon: "school", ...SCHOOL, radiusMeters: 100 },
    })

    await uploadFixes(user.headers, [{ ...HOME, recordedAt: iso(-300), accuracyMeters: 10 }])

    // An urban wifi fix: 180 m of uncertainty deciding a 100 m fence. Its
    // reported point lands 60 m from the centre, well inside its own error.
    const coarse = await uploadFixes(user.headers, [
      { ...northOf(SCHOOL, 60), recordedAt: iso(-60), accuracyMeters: 180 },
    ])
    expect(coarse.placeEvents).toBe(0)
  })

  it("does not announce an arrival for a phone that only passes through a fence", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: { name: "School", icon: "school", ...SCHOOL, radiusMeters: 150 },
    })

    // Driving straight past: one fix lands inside, the next is already gone.
    const transit = await uploadFixes(user.headers, [
      { ...northOf(SCHOOL, -400), recordedAt: iso(-180), accuracyMeters: 10, speedMps: 15 },
      { ...northOf(SCHOOL, 40), recordedAt: iso(-150), accuracyMeters: 10, speedMps: 15 },
      { ...northOf(SCHOOL, 480), recordedAt: iso(-120), accuracyMeters: 10, speedMps: 15 },
    ])
    expect(transit.placeEvents).toBe(0)
  })

  it("reports the smallest place someone is inside when two fences overlap", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await uploadFixes(user.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 10 }])

    // A wide neighbourhood fence saved before the doorstep one.
    for (const payload of [
      { name: "Neighbourhood", ...HOME, radiusMeters: 2000 },
      { name: "Home", icon: "home" as const, ...HOME, radiusMeters: 100 },
    ]) {
      const created = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/places`,
        headers: user.headers,
        payload,
      })
      expect(created.statusCode).toBe(201)
    }

    const presence = (
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/v1/circles/${circle.id}/locations`,
          headers: user.headers,
        })
      ).json() as Array<{ userId: string; atPlace: { name: string } | null }>
    ).find((row) => row.userId === user.user.id)!
    expect(presence.atPlace?.name).toBe("Home")
  })

  it("stops listing a member inside a place once they stop sharing precisely", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/invites/${circle.invite.code}/accept`,
      headers: teen.headers,
    })

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-300), accuracyMeters: 10 }])
    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: parent.headers,
      payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
    })
    expect(place.json().membersInside).toContain(teen.user.id)

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: teen.headers,
      payload: { sharingState: "approximate" },
    })
    await uploadFixes(teen.headers, [{ ...SCHOOL, recordedAt: iso(-30), accuracyMeters: 10 }])

    const places = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/places`,
        headers: parent.headers,
      })
    ).json() as Array<{ name: string; membersInside: string[] }>
    expect(places.find((row) => row.name === "Home")!.membersInside).not.toContain(teen.user.id)
  })

  it("replays an offline backlog into history without alerting the family in the present", async () => {
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
      payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
    })

    // Two days out of signal, then the queue drains all at once.
    const twoDaysAgo = -48 * 60 * 60
    await uploadFixes(teen.headers, [
      { ...northOf(HOME, 900), recordedAt: iso(twoDaysAgo - 3600), accuracyMeters: 10 },
      { ...HOME, recordedAt: iso(twoDaysAgo), accuracyMeters: 10 },
    ])

    const pushed = (await getDb().execute(
      sql`select data->>'type' as type from notification_outbox`,
    )) as unknown as Array<{ type: string }>
    expect(pushed.map((row) => row.type)).not.toContain("place_arrive")

    const arrive = (await feedItems(parent.headers, circle.id)).find(
      (item) => item.type === "place_arrive",
    )!
    expect(arrive).toBeDefined()
    expect(Date.now() - Date.parse(arrive.occurredAt)).toBeGreaterThan(24 * 60 * 60 * 1000)
  })
})

describe("driving and battery alerts", () => {
  it("reports the fastest speed the streak itself sustained", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const roadtrip = await createCircle(user.headers, "Roadtrip")
    await setCircleSettings(user.headers, family.id, { speedAlertKmh: 100 })
    await setCircleSettings(user.headers, roadtrip.id, { speedAlertKmh: 130 })

    // One 40 m/s artifact, then a genuine two-fix run at 102.6 km/h.
    await uploadFixes(user.headers, [
      { ...northOf(HOME, 0), recordedAt: iso(-240), accuracyMeters: 8, speedMps: 40 },
      { ...northOf(HOME, 1000), recordedAt: iso(-180), accuracyMeters: 8, speedMps: 10 },
      { ...northOf(HOME, 2000), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 28.5 },
      { ...northOf(HOME, 3000), recordedAt: iso(-60), accuracyMeters: 8, speedMps: 28.5 },
    ])

    const alert = (await feedItems(user.headers, family.id)).find(
      (item) => item.type === "speed_alert",
    )!
    expect(alert).toBeDefined()
    expect(alert.payload.speedKmh).toBe(103)

    // 103 km/h never crossed this circle's own threshold, so it hears nothing.
    const other = await feedItems(user.headers, roadtrip.id)
    expect(other.map((item) => item.type)).not.toContain("speed_alert")
  })

  it("raises the speed alert for an episode that ended before the batch did", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 100 })

    // Fifteen fixes at 120 km/h, then the driver slows down and parks, all in
    // the one batch a phone flushes when it comes back into signal.
    const tail = [20, 12, 5, 1, 0, 0]
    const start = Date.now() - 21 * 30 * 1000
    await uploadFixes(
      user.headers,
      Array.from({ length: 21 }, (_, i) => ({
        ...northOf(HOME, i * 500),
        recordedAt: new Date(start + i * 30 * 1000).toISOString(),
        accuracyMeters: 8,
        speedMps: i < 15 ? 33.33 : tail[i - 15]!,
      })),
    )

    const types = (await feedItems(user.headers, circle.id)).map((item) => item.type)
    expect(types).toContain("speed_alert")
  })

  it("does not raise a low battery alert from a reading that is hours old", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    await uploadFixes(user.headers, [
      {
        ...HOME,
        recordedAt: iso(-4 * 3600),
        accuracyMeters: 8,
        batteryLevel: 0.5,
        isCharging: false,
      },
    ])
    // The backlog a phone drains after a night out of signal. It has been on a
    // charger since, so 8% is no longer true of anything.
    await uploadFixes(user.headers, [
      {
        ...HOME,
        recordedAt: iso(-3 * 3600),
        accuracyMeters: 8,
        batteryLevel: 0.08,
        isCharging: false,
      },
    ])

    const types = (await feedItems(user.headers, circle.id)).map((item) => item.type)
    expect(types).not.toContain("low_battery")
  })

  it("tells a circle with a lower battery threshold when the level reaches it", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const grandparents = await createCircle(user.headers, "Grandparents")
    await setCircleSettings(user.headers, family.id, { lowBatteryThreshold: 0.15 })
    await setCircleSettings(user.headers, grandparents.id, { lowBatteryThreshold: 0.05 })

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-600), accuracyMeters: 8, batteryLevel: 0.14, isCharging: false },
    ])
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 8, batteryLevel: 0.04, isCharging: false },
    ])

    expect((await feedItems(user.headers, family.id)).map((item) => item.type)).toContain(
      "low_battery",
    )
    expect((await feedItems(user.headers, grandparents.id)).map((item) => item.type)).toContain(
      "low_battery",
    )
  })

  it("raises a possible incident when motorway speed is followed by a hard stop", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    await setCircleSettings(user.headers, circle.id, { incidentDetection: true })

    await uploadFixes(user.headers, [
      { ...northOf(HOME, 0), recordedAt: iso(-300), accuracyMeters: 8, speedMps: 25 },
      { ...northOf(HOME, 750), recordedAt: iso(-270), accuracyMeters: 8, speedMps: 24 },
      // Three minutes of not moving. A red light is not this long, which is
      // the whole reason the stillness has to have a duration.
      { ...northOf(HOME, 1000), recordedAt: iso(-240), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(HOME, 1000), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 0 },
      { ...northOf(HOME, 1000), recordedAt: iso(-30), accuracyMeters: 8, speedMps: 0 },
    ])

    const types = (await feedItems(user.headers, circle.id)).map((item) => item.type)
    expect(types).toContain("possible_incident")
  })
})

describe("offline detection", () => {
  it("announces a phone as offline once while it keeps uploading", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // Every fix is stamped by a clock over an hour slow, so the device looks
    // quiet to the sweep while it is in fact reporting normally.
    await uploadFixes(user.headers, [{ ...HOME, recordedAt: iso(-75 * 60), accuracyMeters: 8 }])
    await runJobs(getDb(), getConfig(), ctx.app.log)

    await uploadFixes(user.headers, [{ ...HOME, recordedAt: iso(-74 * 60), accuracyMeters: 8 }])
    await runJobs(getDb(), getConfig(), ctx.app.log)

    const offline = (await feedItems(user.headers, circle.id)).filter(
      (item) => item.type === "device_offline",
    )
    expect(offline).toHaveLength(1)
  })

  it("alerts every quiet phone even when several in the household go quiet together", async () => {
    // Three phones missing their background window overnight is routine, not
    // evidence that the server itself is down.
    for (const offsetSeconds of [-90 * 60, -90 * 60, -90 * 60, -30, -30]) {
      const member = await registerUser(ctx.app)
      await createCircle(member.headers)
      await uploadFixes(member.headers, [
        { ...HOME, recordedAt: iso(offsetSeconds), accuracyMeters: 8 },
      ])
    }

    await runJobs(getDb(), getConfig(), ctx.app.log)

    const offline = (await getDb().execute(
      sql`select actor_user_id from events where type = 'device_offline'`,
    )) as unknown as Array<{ actor_user_id: string }>
    expect(offline).toHaveLength(3)
  })

  it("does not report a deactivated account's phone as having broken", async () => {
    const admin = await registerUser(ctx.app)
    const member = await registerUser(ctx.app)
    await createCircle(member.headers)
    await uploadFixes(member.headers, [{ ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 8 }])

    // Deactivation revokes every session, so the phone cannot report by design.
    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${member.user.id}`,
      headers: admin.headers,
      payload: { isActive: false },
    })
    expect(patch.statusCode).toBe(200)

    const report = await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(report.offlineFlagged).toBe(0)
  })
})

describe("batch validation", () => {
  it("keeps a batch in which one fix reports an invalid altitude accuracy", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)

    // iOS reports a negative verticalAccuracy whenever altitude is unknown,
    // which is routine for a wifi-derived fix indoors.
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: {
        points: [
          { ...HOME, recordedAt: iso(-120), accuracyMeters: 65 },
          { ...HOME, recordedAt: iso(-90), accuracyMeters: 65, altitudeAccuracyMeters: -1 },
          { ...HOME, recordedAt: iso(-60), accuracyMeters: 65 },
        ],
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted).toBe(3)
  })
})

describe("concurrent uploads from two devices", () => {
  // One attempt would be a coin toss rather than a regression test, so both of
  // these repeat the race over several independent accounts.
  const attempts = 6

  it("emits one arrival when both devices report the same crossing at once", async () => {
    for (let i = 0; i < attempts; i += 1) {
      const user = await registerUser(ctx.app)
      const circle = await createCircle(user.headers)
      await ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/places`,
        headers: user.headers,
        payload: { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
      })
      await uploadFixes(user.headers, [
        { ...northOf(HOME, 900), recordedAt: iso(-600), accuracyMeters: 10 },
      ])

      const second = await signInDevice(user.email, `device-arrive-race-${i}`)
      await Promise.all([
        uploadFixes(user.headers, [{ ...HOME, recordedAt: iso(-60), accuracyMeters: 10 }]),
        uploadFixes(second, [{ ...HOME, recordedAt: iso(-50), accuracyMeters: 10 }]),
      ])
    }

    const arrivals = (await getDb().execute(
      sql`select id from place_events where type = 'arrive'`,
    )) as unknown as Array<{ id: string }>
    expect(arrivals).toHaveLength(attempts)
  })

  it("raises one speed alert when both devices report the same fast run at once", async () => {
    for (let i = 0; i < attempts; i += 1) {
      const user = await registerUser(ctx.app)
      const circle = await createCircle(user.headers)
      await setCircleSettings(user.headers, circle.id, { speedAlertKmh: 100 })

      // One fix over the threshold, so the stored streak stands at one.
      await uploadFixes(user.headers, [
        { ...HOME, recordedAt: iso(-180), accuracyMeters: 8, speedMps: 30 },
      ])

      const second = await signInDevice(user.email, `device-speed-race-${i}`)
      await Promise.all([
        uploadFixes(user.headers, [
          { ...northOf(HOME, 500), recordedAt: iso(-60), accuracyMeters: 8, speedMps: 31 },
        ]),
        uploadFixes(second, [
          { ...northOf(HOME, 600), recordedAt: iso(-50), accuracyMeters: 8, speedMps: 32 },
        ]),
      ])
    }

    const alerts = (await getDb().execute(
      sql`select id from events where type = 'speed_alert'`,
    )) as unknown as Array<{ id: string }>
    expect(alerts).toHaveLength(attempts)
  })
})
