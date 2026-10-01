import type { AdminOverview } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { enqueuePush } from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The portal's dashboard: how much the server did each day, what became of
 * its notifications, and whether each person's phone is reporting. Counts,
 * times and phone models only. Nothing here says where anybody is.
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

const HOUR = 60 * 60 * 1000

/** The calendar day an instant falls on in a time zone, as the endpoint names it. */
const dayIn = (instant: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant)

/** Today as the database sees it, which is the clock the endpoint reads. */
async function databaseToday(timeZone: string): Promise<string> {
  const [row] = (await getDb().execute(
    sql`select to_char(now() at time zone ${timeZone}, 'YYYY-MM-DD') as day`,
  )) as unknown as Array<{ day: string }>
  return row!.day
}

async function addFix(userId: string, at: Date) {
  await getDb().execute(
    sql`insert into location_points (user_id, device_id, recorded_at, lat, lon, accuracy_meters)
        values (${userId}::uuid, 'phone', ${at.toISOString()}::timestamptz, 51.45, -2.59, 10)`,
  )
}

async function overview(headers: Record<string, string>, tz = "UTC") {
  return ctx.app.inject({
    method: "GET",
    url: `/api/v1/admin/overview?tz=${encodeURIComponent(tz)}`,
    headers,
  })
}

async function family() {
  const admin = await registerUser(ctx.app, { displayName: "Daniyal" })
  const member = await registerUser(ctx.app, { displayName: "Sabeen" })
  return { admin, member }
}

describe("the dashboard's days", () => {
  it("counts fixes and the people who sent them on each of the last fourteen days", async () => {
    const { admin, member } = await family()
    const now = Date.now()
    await addFix(admin.user.id, new Date(now - 1 * HOUR))
    await addFix(member.user.id, new Date(now - 2 * HOUR))
    await addFix(member.user.id, new Date(now - 3 * HOUR))
    await addFix(member.user.id, new Date(now - 50 * HOUR))
    // Older than the window, so it counts nowhere.
    await addFix(member.user.id, new Date(now - 20 * 24 * HOUR))

    const response = await overview(admin.headers)
    expect(response.statusCode).toBe(200)
    const body = response.json() as AdminOverview

    expect(body.days).toHaveLength(14)
    expect(body.days.at(-1)).toBe(await databaseToday("UTC"))
    const expectFixes = new Map<string, number>()
    const expectPeople = new Map<string, Set<string>>()
    for (const [user, hoursAgo] of [
      [admin.user.id, 1],
      [member.user.id, 2],
      [member.user.id, 3],
      [member.user.id, 50],
    ] as const) {
      const key = dayIn(new Date(now - hoursAgo * HOUR), "UTC")
      expectFixes.set(key, (expectFixes.get(key) ?? 0) + 1)
      expectPeople.set(key, (expectPeople.get(key) ?? new Set()).add(user))
    }
    expect(body.fixes).toEqual(body.days.map((day) => expectFixes.get(day) ?? 0))
    expect(body.activeAccounts).toEqual(body.days.map((day) => expectPeople.get(day)?.size ?? 0))
  })

  it("draws the days in the viewer's own time zone", async () => {
    const { admin } = await family()
    // 19:30 UTC two days ago is half past midnight the next day in Karachi.
    const twoDaysAgo = new Date(Date.now() - 48 * HOUR)
    const lateEvening = new Date(
      Date.UTC(
        twoDaysAgo.getUTCFullYear(),
        twoDaysAgo.getUTCMonth(),
        twoDaysAgo.getUTCDate(),
        19,
        30,
      ),
    )
    await addFix(admin.user.id, lateEvening)

    const utc = (await overview(admin.headers, "UTC")).json() as AdminOverview
    const karachi = (await overview(admin.headers, "Asia/Karachi")).json() as AdminOverview

    const onDay = (body: AdminOverview, day: string) => body.fixes[body.days.indexOf(day)]
    expect(onDay(utc, dayIn(lateEvening, "UTC"))).toBe(1)
    expect(onDay(karachi, dayIn(lateEvening, "Asia/Karachi"))).toBe(1)
    expect(dayIn(lateEvening, "UTC")).not.toBe(dayIn(lateEvening, "Asia/Karachi"))
  })

  it("counts the notifications people saw by what became of them, not the silent wakes", async () => {
    const { admin, member } = await family()
    const db = getDb()
    const visible = { userId: member.user.id, title: "Home", body: "Daniyal arrived at Home" }
    await enqueuePush(db, [visible, visible, visible, visible])
    await enqueuePush(db, [{ userId: member.user.id, title: "", body: "", silent: true }])
    await db.execute(sql`
      update notification_outbox set status = case id % 4
        when 0 then 'sent' when 1 then 'failed' when 2 then 'skipped' else 'pending' end
      where silent = false`)

    const body = (await overview(admin.headers)).json() as AdminOverview
    const today = body.days.length - 1
    expect({
      sent: body.notifications.sent[today],
      failed: body.notifications.failed[today],
      skipped: body.notifications.skipped[today],
      waiting: body.notifications.waiting[today],
    }).toEqual({ sent: 1, failed: 1, skipped: 1, waiting: 1 })
  })
})

describe("the dashboard's phones", () => {
  async function presence(
    userId: string,
    heardMinutesAgo: number,
    extra: { activity?: string; health?: Record<string, unknown> } = {},
  ) {
    const heard = new Date(Date.now() - heardMinutesAgo * 60_000).toISOString()
    await getDb().execute(sql`
      insert into user_presence (user_id, lat, lon, recorded_at, last_heard_at, activity, health)
      values (${userId}::uuid, 51.45, -2.59, ${heard}::timestamptz, ${heard}::timestamptz,
              ${extra.activity ?? null}, ${extra.health ? JSON.stringify(extra.health) : null}::jsonb)`)
    return heard
  }

  it("lists each person's phone, when it was last heard and what it says is wrong", async () => {
    const { admin, member } = await family()
    const heard = await presence(member.user.id, 5, {
      health: { locationPermission: "foreground", locationServices: true },
    })
    await getDb().execute(sql`
      update sessions set platform = 'android', app_version = '1.1.0', device_name = 'Pixel 9'
      where user_id = ${member.user.id}::uuid`)

    // The administrator's own portal session is a browser, not a phone.
    const portal = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/portal/login",
      headers: { origin: "http://localhost" },
      payload: { email: admin.email, password: "correct-horse-battery", deviceId: "portal-x" },
    })
    expect(portal.statusCode).toBe(200)

    const response = await overview(admin.headers)
    const body = response.json() as AdminOverview
    const byName = new Map(body.phones.map((phone) => [phone.displayName, phone]))

    expect(byName.get("Sabeen")).toEqual({
      userId: member.user.id,
      displayName: "Sabeen",
      avatarColor: expect.any(String),
      deviceName: "Pixel 9",
      platform: "android",
      appVersion: "1.1.0",
      lastHeardAt: heard,
      state: "reporting",
      issues: ["location_permission"],
    })
    expect(byName.get("Daniyal")).toMatchObject({
      deviceName: "Test Phone",
      platform: "ios",
      lastHeardAt: null,
      state: "never",
      issues: [],
    })
    expect(response.body).not.toMatch(/"lat"|"lon"|51\.45|-2\.59/)
  })

  it("judges a quiet phone the way the offline alert does", async () => {
    const { admin } = await family()
    const ids: Record<string, string> = {}
    for (const name of ["Moving", "Driving", "Parked", "Asleep", "Gone"]) {
      ids[name] = (await registerUser(ctx.app, { displayName: name })).user.id
    }
    await presence(ids.Moving!, 30, { activity: "walking" })
    await presence(ids.Driving!, 90, { activity: "in_vehicle" })
    // Parked phones are allowed the night before the family hears.
    await presence(ids.Parked!, 30, { activity: "still" })
    await presence(ids.Asleep!, 5 * 60, { activity: "still" })
    await presence(ids.Gone!, 13 * 60, { activity: "still" })

    const body = (await overview(admin.headers)).json() as AdminOverview
    const state = (name: string) => body.phones.find((phone) => phone.displayName === name)?.state

    expect({
      Moving: state("Moving"),
      Driving: state("Driving"),
      Parked: state("Parked"),
      Asleep: state("Asleep"),
      Gone: state("Gone"),
    }).toEqual({
      Moving: "quiet",
      Driving: "offline",
      Parked: "parked",
      Asleep: "parked",
      Gone: "offline",
    })
  })

  it("says an account with no phone signed in has none", async () => {
    const { admin, member } = await family()
    await getDb().execute(
      sql`update sessions set platform = 'web' where user_id = ${member.user.id}::uuid`,
    )

    const body = (await overview(admin.headers)).json() as AdminOverview
    expect(body.phones.find((phone) => phone.userId === member.user.id)).toMatchObject({
      platform: null,
      deviceName: null,
      state: "none",
    })
  })

  it("leaves out a deactivated account", async () => {
    const { admin, member } = await family()
    await getDb().execute(
      sql`update users set is_active = false where id = ${member.user.id}::uuid`,
    )

    const body = (await overview(admin.headers)).json() as AdminOverview
    expect(body.phones.map((phone) => phone.displayName)).toEqual(["Daniyal"])
  })
})

describe("the dashboard", () => {
  it("turns down a time zone it does not know", async () => {
    const { admin } = await family()
    expect((await overview(admin.headers, "Mars/Olympus")).statusCode).toBe(400)
  })

  // Postgres reads "+05:00" as POSIX, where the sign is the other way round,
  // and every day would shift by ten hours.
  it("turns down a bare offset in place of a zone name", async () => {
    const { admin } = await family()
    expect((await overview(admin.headers, "+05:00")).statusCode).toBe(400)
  })

  it("draws an empty server as empty days", async () => {
    const { admin } = await family()
    const body = (await overview(admin.headers)).json() as AdminOverview
    expect(body.fixes).toEqual(new Array(14).fill(0))
    expect(body.activeAccounts).toEqual(new Array(14).fill(0))
    expect(body.notifications.sent).toEqual(new Array(14).fill(0))
  })

  it("is for administrators only", async () => {
    const { member } = await family()
    expect((await overview(member.headers)).statusCode).toBe(403)
  })
})
