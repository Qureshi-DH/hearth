import type { AdminOverview } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import type { DeliveryResult, DeliveryTarget, PushDriver, PushMessage } from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * When a parked phone's silence becomes news. An Android phone reports a
 * quarter of an hour apart and answers a wake even from Doze, so once its
 * wakes have gone unanswered it is not coming back. iOS throttles silent
 * pushes, so a parked iPhone keeps the night.
 */

let ctx: TestContext
const HOME = { lat: 51.4545, lon: -2.5879 }
const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

class ExpoLikeDriver implements PushDriver {
  readonly provider = "expo" as const
  async send(_target: DeliveryTarget, _message: PushMessage): Promise<DeliveryResult> {
    return { ok: true }
  }
}

const original = { driver: null as PushDriver | null }

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
  original.driver = getPushDriver()
})

afterEach(() => {
  setRuntime({ pushDriver: original.driver })
})

const tick = () => runJobs(getDb(), getConfig(), ctx.app.log)

interface Phone {
  minutesAgo: number
  platform?: "ios" | "android"
  activity?: "still" | "driving"
  battery?: number
  charging?: boolean
  /** Whether it took a push token. Without one the server cannot wake it. */
  pushable?: boolean
}

async function phone(options: Phone) {
  const user = await registerUser(ctx.app, { displayName: "Sami" })
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: user.headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(created.statusCode).toBe(201)
  // Somebody to tell, who has never shared a fix of their own.
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const joined = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${(created.json() as { invite: { code: string } }).invite.code}/accept`,
    headers: parent.headers,
  })
  expect(joined.statusCode).toBe(200)
  const upload = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers: user.headers,
    payload: {
      points: [
        {
          ...HOME,
          recordedAt: iso(-options.minutesAgo * 60),
          accuracyMeters: 12,
          activity: options.activity ?? "still",
          batteryLevel: options.battery ?? 0.6,
          isCharging: options.charging ?? false,
        },
      ],
    },
  })
  expect(upload.statusCode).toBe(200)
  await getDb().execute(
    options.pushable === false
      ? sql`update sessions set platform = ${options.platform ?? "android"}
            where user_id = ${user.user.id}::uuid`
      : sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]',
            platform = ${options.platform ?? "android"}
            where user_id = ${user.user.id}::uuid`,
  )
  await getDb().execute(
    sql`update user_presence set last_heard_at = recorded_at where user_id = ${user.user.id}::uuid`,
  )
  return user
}

/** The wakes the sweep sent, the last that long ago, none answered. */
async function wakesSpent(userId: string, count: number, minutesAgo: number) {
  await getDb().execute(
    sql`update user_presence
        set wake_count = ${count}, wake_requested_at = now() - make_interval(mins => ${minutesAgo})
        where user_id = ${userId}::uuid`,
  )
}

async function offlineNews(userId: string) {
  return (await getDb().execute(
    sql`select e.summary, o.title, o.body
        from events e left join notification_outbox o on (o.data->>'eventId') = e.id::text
        where e.type = 'device_offline' and e.actor_user_id = ${userId}::uuid`,
  )) as unknown as Array<{ summary: string; title: string | null; body: string | null }>
}

async function reportHealth(headers: Record<string, string>, health: Record<string, unknown>) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: "/api/v1/me/health",
    headers,
    payload: { locationPermission: "always", locationServices: true, ...health },
  })
  expect(response.statusCode).toBe(200)
}

describe("a parked Android phone", () => {
  it("is called offline once its three wakes have gone unanswered", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await phone({ minutesAgo: 105 })
    await wakesSpent(user.user.id, 3, 15)

    expect((await tick()).offlineFlagged).toBe(1)
  })

  it("is given time to answer the wakes first", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await phone({ minutesAgo: 80 })
    await wakesSpent(user.user.id, 2, 20)

    expect((await tick()).offlineFlagged).toBe(0)
  })

  it("is called offline after the same wait on a server that cannot wake it", async () => {
    await phone({ minutesAgo: 105, pushable: false })
    expect((await tick()).offlineFlagged).toBe(1)
  })

  it("shows in the admin portal as stopped reporting at the same moment", async () => {
    const admin = await registerUser(ctx.app, { displayName: "Admin" })
    const user = await phone({ minutesAgo: 105, pushable: false })
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/overview?tz=UTC",
      headers: admin.headers,
    })
    const body = response.json() as AdminOverview
    expect(body.phones.find((row) => row.userId === user.user.id)?.state).toBe("offline")
  })
})

describe("a parked iPhone", () => {
  it("keeps its night, whatever became of its wakes", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await phone({ minutesAgo: 105, platform: "ios" })
    await wakesSpent(user.user.id, 3, 15)

    expect((await tick()).offlineFlagged).toBe(0)
  })

  it("keeps it for an account signed in on an Android phone as well", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await phone({ minutesAgo: 105, platform: "ios" })
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: user.email,
        password: "correct-horse-battery",
        device: { deviceId: "tablet", deviceName: "Tablet", platform: "android" },
      },
    })
    expect(second.statusCode).toBe(200)
    await wakesSpent(user.user.id, 3, 15)

    expect((await tick()).offlineFlagged).toBe(0)
  })
})

describe("a phone whose battery was nearly flat", () => {
  it("says the battery likely ran out, not that power saving is on", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.04 })
    await reportHealth(user.headers, { lowPowerMode: true })

    await tick()

    const [news] = await offlineNews(user.user.id)
    expect(news?.summary).toBe("Sami's phone stopped reporting on 4% battery")
    expect(news?.title).toBe("Battery likely ran out")
    expect(news?.body).toBe(
      "Sami's phone stopped reporting on 4% battery. It has most likely run out.",
    )
  })

  it("says so with no health report at all", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.05 })
    await tick()
    const [news] = await offlineNews(user.user.id)
    expect(news?.title).toBe("Battery likely ran out")
  })

  it("still says power saving is on above five percent", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.3 })
    await reportHealth(user.headers, { lowPowerMode: true })
    await tick()
    const [news] = await offlineNews(user.user.id)
    expect(news?.summary).toContain("power saving mode is on")
  })

  it("does not blame the battery of a phone that was on the charger", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.03, charging: true })
    await tick()
    const [news] = await offlineNews(user.user.id)
    expect(news?.title).toBe("Phone offline")
  })

  it("still names a switch the phone said was off", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.03 })
    await reportHealth(user.headers, { locationPermission: "foreground" })
    await tick()
    const [news] = await offlineNews(user.user.id)
    expect(news?.summary).toContain("location permission is not set to Always")
  })
})

describe("what the family reads under the name of a phone that ran out", () => {
  async function issuesSeenBy(viewer: Record<string, string>, userId: string) {
    const circles = await ctx.app.inject({ method: "GET", url: "/api/v1/circles", headers: viewer })
    const [circle] = circles.json() as Array<{ id: string }>
    const presence = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle!.id}/locations`,
      headers: viewer,
    })
    return (presence.json() as Array<{ userId: string; issues: string[] }>).find(
      (row) => row.userId === userId,
    )!.issues
  }

  it("leaves out the power saving a nearly flat phone turned on by itself", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.04 })
    await reportHealth(user.headers, { lowPowerMode: true, batteryOptimised: true })
    expect(await issuesSeenBy(user.headers, user.user.id)).toEqual([])
  })

  it("still names a switch somebody turned off", async () => {
    const user = await phone({ minutesAgo: 90, activity: "driving", battery: 0.04 })
    await reportHealth(user.headers, { locationPermission: "foreground", lowPowerMode: true })
    expect(await issuesSeenBy(user.headers, user.user.id)).toEqual(["location_permission"])
  })

  it("names power saving on a phone that is still reporting, or on the charger", async () => {
    const fresh = await phone({ minutesAgo: 2, activity: "driving", battery: 0.04 })
    await reportHealth(fresh.headers, { lowPowerMode: true })
    expect(await issuesSeenBy(fresh.headers, fresh.user.id)).toEqual(["low_power_mode"])

    const charging = await phone({ minutesAgo: 90, battery: 0.04, charging: true })
    await reportHealth(charging.headers, { lowPowerMode: true })
    expect(await issuesSeenBy(charging.headers, charging.user.id)).toEqual(["low_power_mode"])
  })

  it("tells the admin portal the battery likely ran out, and not that power saving is on", async () => {
    const admin = await registerUser(ctx.app, { displayName: "Admin" })
    const flat = await phone({ minutesAgo: 90, activity: "driving", battery: 0.04 })
    await reportHealth(flat.headers, { lowPowerMode: true })
    const fresh = await phone({ minutesAgo: 2, activity: "driving", battery: 0.04 })

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/overview?tz=UTC",
      headers: admin.headers,
    })
    const phones = (response.json() as AdminOverview).phones
    expect(phones.find((row) => row.userId === flat.user.id)).toMatchObject({
      batteryRanOut: true,
      issues: [],
    })
    expect(phones.find((row) => row.userId === fresh.user.id)?.batteryRanOut).toBe(false)
  })
})

describe("the admin portal and the app agree on a parked phone", () => {
  async function adminSees(admin: { headers: Record<string, string> }, userId: string) {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/overview?tz=UTC",
      headers: admin.headers,
    })
    return (response.json() as AdminOverview).phones.find((row) => row.userId === userId)!
  }

  // A parked phone reports a quarter of an hour apart, so twenty minutes of
  // quiet is a healthy phone between two reports, whatever its battery says.
  it("does not say the battery ran out between a parked phone's reports", async () => {
    const admin = await registerUser(ctx.app, { displayName: "Admin" })
    const user = await phone({ minutesAgo: 20, battery: 0.04 })
    expect((await adminSees(admin, user.user.id)).batteryRanOut).toBe(false)
  })

  it("says it once the app would call the phone stale", async () => {
    const admin = await registerUser(ctx.app, { displayName: "Admin" })
    const user = await phone({ minutesAgo: 40, battery: 0.04 })
    expect((await adminSees(admin, user.user.id)).batteryRanOut).toBe(true)
  })
})
