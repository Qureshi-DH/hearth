import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import type { DeliveryResult, DeliveryTarget, PushDriver, PushMessage } from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A phone that uploads has been heard, whatever it uploaded, and "parked" is
 * judged from what the server knows before a quiet phone is called offline.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const ROAD = { lat: 51.4712, lon: -2.5601 }
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString()

class ExpoLikeDriver implements PushDriver {
  readonly provider = "expo" as const
  readonly sent: PushMessage[] = []
  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.sent.push(message)
    return { ok: true }
  }
}

let ctx: TestContext
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

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number | null
  activity?: string
  source?: string
}

async function upload(headers: Record<string, string>, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number }
}

async function createCircle(headers: Record<string, string>) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function presenceRow(userId: string) {
  const rows = (await getDb().execute(
    sql`select activity, recorded_at, last_heard_at, wake_requested_at, wake_count
        from user_presence where user_id = ${userId}::uuid`,
  )) as unknown as Array<{
    activity: string | null
    recorded_at: string
    last_heard_at: string | null
    wake_requested_at: string | null
    wake_count: number
  }>
  const row = rows[0]!
  return {
    activity: row.activity,
    recordedAt: new Date(row.recorded_at),
    lastHeardAt: row.last_heard_at ? new Date(row.last_heard_at) : null,
    wakeCount: row.wake_count,
  }
}

/** What the row looks like once the phone has really been quiet that long. */
async function quietFor(userId: string, minutes: number) {
  await getDb().execute(
    sql`update user_presence
        set last_heard_at = now() - make_interval(mins => ${minutes})
        where user_id = ${userId}::uuid`,
  )
}

async function ageLastWake(userId: string, minutes: number) {
  await getDb().execute(
    sql`update user_presence
        set wake_requested_at = now() - make_interval(mins => ${minutes})
        where user_id = ${userId}::uuid`,
  )
}

async function giveToken(userId: string, platform: "ios" | "android" = "android") {
  await getDb().execute(
    sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]',
        platform = ${platform}
        where user_id = ${userId}::uuid`,
  )
}

async function offlineEvents(userId: string) {
  const rows = (await getDb().execute(
    sql`select summary from events where type = 'device_offline'
        and actor_user_id = ${userId}::uuid order by id`,
  )) as unknown as Array<{ summary: string }>
  return rows.map((row) => row.summary)
}

async function wakeRows() {
  return (await getDb().execute(
    sql`select status from notification_outbox where data->>'type' = 'wake' order by id`,
  )) as unknown as Array<{ status: string }>
}

/** A phone last seen on the road that many minutes ago, and quiet since. */
async function quietDriver(minutes: number, fix: Partial<Fix> = {}) {
  const user = await registerUser(ctx.app)
  await createCircle(user.headers)
  await upload(user.headers, [
    {
      ...ROAD,
      recordedAt: minutesAgo(minutes),
      accuracyMeters: 12,
      speedMps: 14,
      activity: "driving",
      ...fix,
    },
  ])
  await quietFor(user.user.id, minutes)
  return user
}

describe("a phone that uploads has been heard", () => {
  it("records the upload, however old the fix it carried", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    await upload(user.headers, [{ ...ROAD, recordedAt: minutesAgo(180), speedMps: 14 }])

    const row = await presenceRow(user.user.id)
    expect(Date.now() - row.recordedAt.getTime()).toBeGreaterThan(170 * 60 * 1000)
    expect(Date.now() - row.lastHeardAt!.getTime()).toBeLessThan(10_000)

    // Three hours since the last fix, seconds since the phone spoke: the
    // sweep has nothing to announce.
    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
  })

  it("counts a retried batch as the phone speaking", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const fix = { ...ROAD, recordedAt: minutesAgo(5), speedMps: 14 }
    await upload(user.headers, [fix])
    await quietFor(user.user.id, 30)

    const retry = await upload(user.headers, [fix])
    expect(retry.accepted).toBe(0)
    const row = await presenceRow(user.user.id)
    expect(Date.now() - row.lastHeardAt!.getTime()).toBeLessThan(10_000)
  })
})

describe("the park fix lands on the settle fix's timestamp", () => {
  it("adopts 'still' from a fix the phone re-reports at the same instant", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const recordedAt = minutesAgo(1)
    await upload(user.headers, [
      { ...HOME, recordedAt, accuracyMeters: 12, speedMps: 2.5, activity: "driving" },
    ])
    expect((await presenceRow(user.user.id)).activity).toBe("driving")

    const park = await upload(user.headers, [
      {
        ...HOME,
        recordedAt,
        accuracyMeters: 12,
        speedMps: 0,
        activity: "still",
        source: "significant",
      },
    ])
    expect(park.accepted).toBe(1)
    expect((await presenceRow(user.user.id)).activity).toBe("still")

    const [point] = (await getDb().execute(
      sql`select activity, source from location_points where user_id = ${user.user.id}::uuid`,
    )) as unknown as Array<{ activity: string; source: string }>
    expect(point).toEqual({ activity: "still", source: "significant" })
  })

  it("leaves a fix alone when the re-report is not a stop", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const recordedAt = minutesAgo(1)
    await upload(user.headers, [
      { ...HOME, recordedAt, accuracyMeters: 12, speedMps: 2.5, activity: "driving" },
    ])
    const again = await upload(user.headers, [
      { ...HOME, recordedAt, accuracyMeters: 12, speedMps: 2.5, activity: "walking" },
    ])
    expect(again.accepted).toBe(0)
    expect((await presenceRow(user.user.id)).activity).toBe("driving")
  })

  it("does not let a same-instant re-report rewind a newer position", async () => {
    const user = await registerUser(ctx.app)
    await createCircle(user.headers)
    const earlier = minutesAgo(2)
    await upload(user.headers, [{ ...HOME, recordedAt: earlier, activity: "driving" }])
    await upload(user.headers, [{ ...ROAD, recordedAt: minutesAgo(1), activity: "driving" }])
    await upload(user.headers, [{ ...HOME, recordedAt: earlier, activity: "still" }])

    const [row] = (await getDb().execute(
      sql`select lat, activity from user_presence where user_id = ${user.user.id}::uuid`,
    )) as unknown as Array<{ lat: number; activity: string }>
    expect(row!.lat).toBeCloseTo(ROAD.lat, 6)
    expect(row!.activity).toBe("driving")
  })
})

describe("parked is judged from what the server knows", () => {
  it("treats a phone inside a named place as parked, whatever its last fix said", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)
    const place = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/places`,
      headers: user.headers,
      payload: { name: "Home", ...HOME, radiusMeters: 100 },
    })
    expect(place.statusCode).toBe(201)

    // The arrival fix is always a moving-tier fix: it crossed the fence while
    // the tracker still called the phone "driving".
    await upload(user.headers, [
      {
        ...HOME,
        recordedAt: minutesAgo(180),
        accuracyMeters: 12,
        speedMps: 3,
        activity: "driving",
      },
    ])
    await quietFor(user.user.id, 180)

    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await offlineEvents(user.user.id)).toEqual([])
  })

  it("treats a phone that measured itself standing still as parked", async () => {
    const user = await quietDriver(180, { speedMps: 0.4, accuracyMeters: 40, activity: "unknown" })
    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await offlineEvents(user.user.id)).toEqual([])
  })

  it("does not read a coarse fix at zero speed as parked", async () => {
    const user = await quietDriver(180, { speedMps: 0, accuracyMeters: 800, activity: "unknown" })
    const report = await tick()
    expect(report.offlineFlagged).toBe(1)
    expect(await offlineEvents(user.user.id)).toHaveLength(1)
  })

  it("still calls a phone last seen on the road offline after the hour", async () => {
    const user = await quietDriver(180)
    const report = await tick()
    expect(report.offlineFlagged).toBe(1)
    expect(await offlineEvents(user.user.id)).toEqual([
      `${user.email.split("@")[0]}'s phone stopped reporting`,
    ])
  })

  it("names the reason the phone gave in the offline alert", async () => {
    const user = await registerUser(ctx.app, { displayName: "Omar" })
    await createCircle(user.headers)
    await upload(user.headers, [
      {
        ...ROAD,
        recordedAt: minutesAgo(180),
        accuracyMeters: 12,
        speedMps: 14,
        activity: "driving",
      },
    ])
    const health = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/me/health",
      headers: user.headers,
      payload: { locationPermission: "always", locationServices: true, backgroundRestricted: true },
    })
    expect(health.statusCode).toBe(200)
    await quietFor(user.user.id, 180)

    await tick()
    expect(await offlineEvents(user.user.id)).toEqual([
      "Omar's phone cannot report: background activity is restricted",
    ])
  })
})

describe("a phone that can be woken is asked twice before it is called offline", () => {
  it("wakes at ten minutes, again ten minutes later, and only then gives up", async () => {
    const driver = new ExpoLikeDriver()
    setRuntime({ pushDriver: driver })
    const user = await quietDriver(70)
    await giveToken(user.user.id)

    const first = await tick()
    expect(first.phonesWoken).toBe(1)
    expect(first.offlineFlagged).toBe(0)
    expect((await presenceRow(user.user.id)).wakeCount).toBe(1)

    // Moments later the phone still has time to answer, so neither a second
    // wake nor a verdict.
    const second = await tick()
    expect(second.phonesWoken).toBe(0)
    expect(second.offlineFlagged).toBe(0)

    await ageLastWake(user.user.id, 11)
    const third = await tick()
    expect(third.phonesWoken).toBe(1)
    expect(third.offlineFlagged).toBe(0)
    expect((await presenceRow(user.user.id)).wakeCount).toBe(2)

    await ageLastWake(user.user.id, 11)
    const fourth = await tick()
    expect(fourth.offlineFlagged).toBe(1)
    expect(await offlineEvents(user.user.id)).toHaveLength(1)
    expect(await wakeRows()).toHaveLength(2)
  })

  it("does not ask a phone that has only been quiet for five minutes", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await quietDriver(5)
    await giveToken(user.user.id)
    expect((await tick()).phonesWoken).toBe(0)
  })

  it("asks a parked phone every half hour, three times at most", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const recent = await quietDriver(20, { ...HOME, speedMps: 0, activity: "still" })
    await giveToken(recent.user.id)
    expect((await tick()).phonesWoken).toBe(0)

    const user = await quietDriver(35, { ...HOME, speedMps: 0, activity: "still" })
    await giveToken(user.user.id)
    expect((await tick()).phonesWoken).toBe(1)
    expect((await tick()).phonesWoken).toBe(0)

    await ageLastWake(user.user.id, 31)
    expect((await tick()).phonesWoken).toBe(1)
    await ageLastWake(user.user.id, 31)
    expect((await tick()).phonesWoken).toBe(1)
    await ageLastWake(user.user.id, 31)
    expect((await tick()).phonesWoken).toBe(0)
    expect((await presenceRow(user.user.id)).wakeCount).toBe(3)
  })

  it("starts a fresh count once the phone speaks", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await quietDriver(70)
    await giveToken(user.user.id)
    await tick()
    expect((await presenceRow(user.user.id)).wakeCount).toBe(1)

    // Any upload is an answer, even one whose fix is older than the wake.
    await upload(user.headers, [{ ...ROAD, recordedAt: minutesAgo(65), speedMps: 14 }])
    expect((await presenceRow(user.user.id)).wakeCount).toBe(0)
    expect((await tick()).phonesWoken).toBe(0)
  })

  it("judges a phone with no push token on its silence alone", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await quietDriver(70)
    const report = await tick()
    expect(report.phonesWoken).toBe(0)
    expect(report.offlineFlagged).toBe(1)
    expect(await offlineEvents(user.user.id)).toHaveLength(1)
  })
})
