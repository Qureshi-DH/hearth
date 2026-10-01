import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { serverChecks } from "../../services/checks"
import { enqueuePush } from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * What the admin portal adds to the admin API: a member's devices, a new
 * password for the member who forgot theirs, the circles on the server, and
 * a check list for the operator. None of it shows where anybody is.
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

async function adminAndMember() {
  const admin = await registerUser(ctx.app, { displayName: "Daniyal" })
  const member = await registerUser(ctx.app, { displayName: "Sabeen" })
  return { admin, member }
}

const stillSignedIn = async (headers: Record<string, string>) =>
  (await ctx.app.inject({ method: "GET", url: "/api/v1/auth/me", headers })).statusCode === 200

async function auditActions(): Promise<string[]> {
  const rows = (await getDb().execute(
    sql`select action from audit_log order by id`,
  )) as unknown as Array<{ action: string }>
  return rows.map((row) => row.action)
}

describe("a member's devices", () => {
  it("lists them and signs one out", async () => {
    const { admin, member } = await adminAndMember()
    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${member.user.id}/sessions`,
      headers: admin.headers,
    })
    expect(list.statusCode).toBe(200)
    const devices = list.json() as Array<{ id: string; deviceName: string; current: boolean }>
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ deviceName: "Test Phone", current: false })

    const ended = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${member.user.id}/sessions/${devices[0]!.id}`,
      headers: admin.headers,
    })
    expect(ended.statusCode).toBe(200)
    expect(await stillSignedIn(member.headers)).toBe(false)
    expect(await auditActions()).toContain("session.revoke")
  })

  it("will not end a session through somebody else's account", async () => {
    const { admin, member } = await adminAndMember()
    const list = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${member.user.id}/sessions`,
      headers: admin.headers,
    })
    const [device] = list.json() as Array<{ id: string }>

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${admin.user.id}/sessions/${device!.id}`,
      headers: admin.headers,
    })
    expect(response.statusCode).toBe(404)
    expect(await stillSignedIn(member.headers)).toBe(true)
  })

  it("signs every device out at once", async () => {
    const { admin, member } = await adminAndMember()
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${member.user.id}/sessions/revoke-all`,
      headers: admin.headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, revokedSessions: 1 })
    expect(await stillSignedIn(member.headers)).toBe(false)
    expect(await stillSignedIn(admin.headers)).toBe(true)
    expect(await auditActions()).toContain("session.revoke_all")
  })

  it("is for administrators only", async () => {
    const { admin, member } = await adminAndMember()
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${admin.user.id}/sessions`,
      headers: member.headers,
    })
    expect(response.statusCode).toBe(403)
  })
})

describe("a new password for somebody who forgot theirs", () => {
  const setPassword = (
    headers: Record<string, string>,
    userId: string,
    body: { password: string; currentPassword?: string },
  ) =>
    ctx.app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/password`,
      headers,
      payload: body,
    })

  it("sets it, signs them out everywhere, and keeps the password out of the log", async () => {
    const { admin, member } = await adminAndMember()
    const response = await setPassword(admin.headers, member.user.id, {
      password: "a-brand-new-passphrase",
      currentPassword: "correct-horse-battery",
    })
    expect(response.statusCode).toBe(200)
    expect(await stillSignedIn(member.headers)).toBe(false)

    const signIn = (password: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: member.email, password, device: { deviceId: "after-reset" } },
      })
    expect((await signIn("correct-horse-battery")).statusCode).toBe(401)
    expect((await signIn("a-brand-new-passphrase")).statusCode).toBe(200)

    const logged = (await getDb().execute(
      sql`select meta::text as meta from audit_log where action = 'user.password'`,
    )) as unknown as Array<{ meta: string }>
    expect(logged).toHaveLength(1)
    expect(logged[0]!.meta).not.toContain("a-brand-new-passphrase")
  })

  // Setting somebody's password is a way into their account, and from there
  // to where their family is. A browser left signed in to the portal must not
  // be enough.
  it("asks for the administrator's own password first", async () => {
    const { admin, member } = await adminAndMember()
    const missing = await setPassword(admin.headers, member.user.id, {
      password: "a-brand-new-passphrase",
    })
    expect(missing.statusCode).toBe(400)

    const wrong = await setPassword(admin.headers, member.user.id, {
      password: "a-brand-new-passphrase",
      currentPassword: "not-my-password",
    })
    expect(wrong.statusCode).toBe(401)
    expect((wrong.json() as { error: { code: string } }).error.code).toBe("wrong_password")
    expect(await stillSignedIn(member.headers)).toBe(true)
    expect(await stillSignedIn(admin.headers)).toBe(true)
  })

  it("stops taking guesses at the administrator's password", async () => {
    const { admin, member } = await adminAndMember()
    const guess = () =>
      setPassword(admin.headers, member.user.id, {
        password: "a-brand-new-passphrase",
        currentPassword: "a-wrong-guess",
      })
    for (let i = 0; i < 10; i += 1) expect((await guess()).statusCode).toBe(401)
    expect((await guess()).statusCode).toBe(429)
  })

  it("refuses a weak one", async () => {
    const { admin, member } = await adminAndMember()
    const response = await setPassword(admin.headers, member.user.id, {
      password: "short",
      currentPassword: "correct-horse-battery",
    })
    expect(response.statusCode).toBe(400)
    expect(await stillSignedIn(member.headers)).toBe(true)
  })

  it("leaves your own password to the page that asks for the current one", async () => {
    const { admin } = await adminAndMember()
    const response = await setPassword(admin.headers, admin.user.id, {
      password: "a-brand-new-passphrase",
      currentPassword: "correct-horse-battery",
    })
    expect(response.statusCode).toBe(400)
  })

  it("says so when there is no such account", async () => {
    const { admin } = await adminAndMember()
    const response = await setPassword(admin.headers, "00000000-0000-4000-8000-000000000000", {
      password: "a-brand-new-passphrase",
      currentPassword: "correct-horse-battery",
    })
    expect(response.statusCode).toBe(404)
  })
})

describe("a wrong current password", () => {
  // The portal renews its session on a 401 that means the token ran out. A
  // mistyped password is a different answer and must not look like one.
  it("is told apart from a session that has run out", async () => {
    const { admin } = await adminAndMember()
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: admin.headers,
      payload: { currentPassword: "not-my-password", newPassword: "a-brand-new-passphrase" },
    })
    expect(response.statusCode).toBe(401)
    expect((response.json() as { error: { code: string } }).error.code).toBe("wrong_password")
  })
})

describe("the circles on the server", () => {
  it("names the members and counts the places, and says nothing about where anyone is", async () => {
    const { admin, member } = await adminAndMember()
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: member.headers,
      payload: { name: "Qureshis", emoji: "🏠" },
    })
    const circle = created.json() as { id: string }
    await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: member.headers,
      payload: { name: "Home", lat: 33.6844, lon: 73.0479, radiusMeters: 150 },
    })
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: member.headers,
      payload: {
        points: [
          { lat: 33.6844, lon: 73.0479, accuracyMeters: 10, recordedAt: new Date().toISOString() },
        ],
      },
    })

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/circles",
      headers: admin.headers,
    })
    expect(response.statusCode).toBe(200)
    const [listed] = response.json() as Array<{
      name: string
      placeCount: number
      memberCount: number
      members: Array<{ displayName: string; role: string }>
    }>
    expect(listed).toMatchObject({ name: "Qureshis", placeCount: 1, memberCount: 1 })
    expect(listed!.members).toEqual([
      expect.objectContaining({ displayName: "Sabeen", role: "owner" }),
    ])
    expect(response.body).not.toMatch(/"(lat|lon|latitude|longitude)"/)
    expect(response.body).not.toContain("33.68")
  })
})

describe("the check list", () => {
  it("names what will bite on the test server's setup", async () => {
    const { admin } = await adminAndMember()
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/checks",
      headers: admin.headers,
    })
    expect(response.statusCode).toBe(200)
    const checks = response.json() as Array<{ id: string; level: string; title: string }>
    const level = (id: string) => checks.find((check) => check.id === id)?.level
    // Plain HTTP address, open sign-up, no push provider and one administrator.
    expect(level("public_address")).toBe("warning")
    expect(level("registration")).toBe("warning")
    expect(level("push")).toBe("info")
    expect(level("administrators")).toBe("info")
    expect(checks.every((check) => check.title.length > 0)).toBe(true)
  })
})

describe("failed notifications in the check list", () => {
  it("counts the ones people would have seen, not silent wakes that ran out", async () => {
    const { member } = await adminAndMember()
    const db = getDb()
    await enqueuePush(db, [
      { userId: member.user.id, title: "Home", body: "Daniyal arrived at Home" },
      { userId: member.user.id, title: "", body: "", silent: true, data: { type: "wake" } },
    ])
    await db.execute(sql`update notification_outbox set status = 'failed'`)

    const checks = await serverChecks(db, { ...getConfig(), PUSH_PROVIDER: "expo" })
    expect(checks.find((check) => check.id === "failed_notifications")?.title).toBe(
      "1 notification failed in the last day",
    )
  })
})

describe("the notification queue", () => {
  it("names each recipient, and shows only the administrator's own words", async () => {
    const { admin, member } = await adminAndMember()
    await enqueuePush(getDb(), [
      { userId: member.user.id, title: "Home", body: "Daniyal arrived at Home" },
      { userId: admin.user.id, title: "Hearth", body: "Notifications are working." },
    ])

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/push/queue",
      headers: admin.headers,
    })
    const rows = response.json() as Array<{ userName: string; title: string | null }>
    expect(rows.map((row) => [row.userName, row.title])).toEqual([
      ["Daniyal", "Hearth"],
      ["Sabeen", null],
    ])
  })
})

describe("the activity log", () => {
  it("names who did it and to whom", async () => {
    const { admin, member } = await adminAndMember()
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${member.user.id}`,
      headers: admin.headers,
      payload: { isActive: false },
    })
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/audit",
      headers: admin.headers,
    })
    const [entry] = response.json() as Array<{
      actorName: string | null
      targetName: string | null
    }>
    expect(entry).toMatchObject({ actorName: "Daniyal", targetName: "Sabeen" })
  })
})
