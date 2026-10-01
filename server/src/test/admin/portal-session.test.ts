import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { users } from "../../db/schema"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The admin portal signs in here rather than through /auth/login. Only an
 * administrator gets a session, and the refresh token lives in a cookie the
 * page's own script cannot read.
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

const PASSWORD = "correct-horse-battery"
const DEVICE = "portal-test-browser"

async function portalLogin(email: string, password = PASSWORD) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/portal/login",
    payload: { email, password, deviceId: DEVICE },
  })
}

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"]
  const first = Array.isArray(header) ? header[0] : header
  return String(first ?? "")
}

const valueOf = (setCookie: string) => setCookie.split(";")[0]!

async function sessionCount(email: string): Promise<number> {
  const rows = (await getDb().execute(sql`
    select count(*)::int as count from sessions s join users u on u.id = s.user_id
    where u.email_normalized = ${email.toLowerCase()} and s.revoked_at is null
  `)) as unknown as Array<{ count: number }>
  return rows[0]?.count ?? 0
}

describe("portal sign-in", () => {
  it("gives an administrator an access token and keeps the refresh token in a locked cookie", async () => {
    const admin = await registerUser(ctx.app)
    const response = await portalLogin(admin.email)
    expect(response.statusCode).toBe(200)

    const body = response.json() as {
      accessToken: string
      refreshToken?: string
      user: { isAdmin: boolean }
    }
    expect(body.accessToken).toBeTruthy()
    expect(body.refreshToken).toBeUndefined()
    expect(body.user.isAdmin).toBe(true)

    const cookie = cookieFrom(response)
    expect(cookie).toMatch(/^hearth_portal=[^;]+/)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).toContain("Path=/api/v1/auth/portal")
    // The test server's public address is plain HTTP.
    expect(cookie).not.toContain("Secure")

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: { authorization: `Bearer ${body.accessToken}` },
    })
    expect(me.statusCode).toBe(200)
  })

  it("turns away an account that is not an administrator, without starting a session", async () => {
    await registerUser(ctx.app)
    const member = await registerUser(ctx.app)
    const before = await sessionCount(member.email)

    const response = await portalLogin(member.email)
    expect(response.statusCode).toBe(403)
    expect(cookieFrom(response)).toBe("")
    expect(await sessionCount(member.email)).toBe(before)
  })

  it("refuses a wrong password the way the app's sign-in does", async () => {
    const admin = await registerUser(ctx.app)
    const response = await portalLogin(admin.email, "not-the-password")
    expect(response.statusCode).toBe(401)
    expect(cookieFrom(response)).toBe("")
  })
})

describe("portal refresh", () => {
  it("swaps the cookie for a new access token and a new cookie", async () => {
    const admin = await registerUser(ctx.app)
    const first = valueOf(cookieFrom(await portalLogin(admin.email)))

    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      headers: { cookie: first },
      payload: { deviceId: DEVICE },
    })
    expect(refreshed.statusCode).toBe(200)
    expect((refreshed.json() as { accessToken: string }).accessToken).toBeTruthy()
    const second = valueOf(cookieFrom(refreshed))
    expect(second).not.toBe(first)
  })

  // A portal left open in a browser is a way into every member's account,
  // so its session ends after a working day however often it renews.
  it("lasts a working day, and renewing does not stretch it", async () => {
    const admin = await registerUser(ctx.app)
    const cookie = valueOf(cookieFrom(await portalLogin(admin.email)))
    const expiry = async () => {
      const rows = (await getDb().execute(sql`
        select expires_at from sessions where device_id = ${DEVICE} and revoked_at is null`)) as unknown as Array<{
        expires_at: string | Date
      }>
      return new Date(rows[0]!.expires_at).getTime()
    }
    const first = await expiry()
    expect(first - Date.now()).toBeGreaterThan(11 * 60 * 60 * 1000)
    expect(first - Date.now()).toBeLessThanOrEqual(12 * 60 * 60 * 1000)

    const refreshed = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      headers: { cookie },
      payload: { deviceId: DEVICE },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(await expiry()).toBe(first)
  })

  it("is not stretched by renewing through the app's own route", async () => {
    const admin = await registerUser(ctx.app)
    const cookie = valueOf(cookieFrom(await portalLogin(admin.email)))
    const before = (await getDb().execute(sql`
      select expires_at from sessions where device_id = ${DEVICE} and revoked_at is null`)) as unknown as Array<{
      expires_at: string | Date
    }>

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: cookie.split("=")[1], deviceId: DEVICE },
    })
    expect(response.statusCode).toBe(200)
    const after = (await getDb().execute(sql`
      select expires_at from sessions where device_id = ${DEVICE} and revoked_at is null`)) as unknown as Array<{
      expires_at: string | Date
    }>
    expect(new Date(after[0]!.expires_at).getTime()).toBe(new Date(before[0]!.expires_at).getTime())
  })

  it("clears the cookie when the session it names is over", async () => {
    const admin = await registerUser(ctx.app)
    const cookie = valueOf(cookieFrom(await portalLogin(admin.email)))
    await getDb().execute(sql`update sessions set revoked_at = now() where device_id = ${DEVICE}`)

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      headers: { cookie },
      payload: { deviceId: DEVICE },
    })
    expect(response.statusCode).toBe(401)
    expect(cookieFrom(response)).toContain("Max-Age=0")
  })

  it("has nothing to do without the cookie", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      payload: { deviceId: DEVICE },
    })
    expect(response.statusCode).toBe(401)
  })

  it("refuses a request another site made", async () => {
    const admin = await registerUser(ctx.app)
    const cookie = valueOf(cookieFrom(await portalLogin(admin.email)))
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      headers: { cookie, origin: "https://evil.example" },
      payload: { deviceId: DEVICE },
    })
    expect(response.statusCode).toBe(403)
  })

  it("stops working once the account is no longer an administrator", async () => {
    const admin = await registerUser(ctx.app)
    const cookie = valueOf(cookieFrom(await portalLogin(admin.email)))
    await getDb().update(users).set({ isAdmin: false }).where(eq(users.id, admin.user.id))

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      headers: { cookie },
      payload: { deviceId: DEVICE },
    })
    expect(response.statusCode).toBe(403)
    expect(await sessionCount(admin.email)).toBe(1)
  })
})

describe("portal sign-in, in the audit log", () => {
  it("records each administrator who signs in", async () => {
    const admin = await registerUser(ctx.app)
    await portalLogin(admin.email)
    const rows = (await getDb().execute(
      sql`select actor_user_id from audit_log where action = 'portal.sign_in'`,
    )) as unknown as Array<{ actor_user_id: string }>
    expect(rows.map((row) => row.actor_user_id)).toEqual([admin.user.id])
  })
})

describe("portal sign-out", () => {
  it("refuses a request another site made", async () => {
    const admin = await registerUser(ctx.app)
    const cookie = valueOf(cookieFrom(await portalLogin(admin.email)))
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/logout",
      headers: { cookie, origin: "https://evil.example" },
    })
    expect(response.statusCode).toBe(403)
    expect(await sessionCount(admin.email)).toBe(2)
  })

  it("ends the session the cookie names and clears the cookie", async () => {
    const admin = await registerUser(ctx.app)
    const login = await portalLogin(admin.email)
    const cookie = valueOf(cookieFrom(login))
    const accessToken = (login.json() as { accessToken: string }).accessToken

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/logout",
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    expect(cookieFrom(response)).toContain("Max-Age=0")

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: { authorization: `Bearer ${accessToken}` },
    })
    expect(after.statusCode).toBe(401)
    const again = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/refresh",
      headers: { cookie },
      payload: { deviceId: DEVICE },
    })
    expect(again.statusCode).toBe(401)
  })
})
