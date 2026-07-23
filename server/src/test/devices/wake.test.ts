import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import {
  drainOutbox,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

let ctx: TestContext
const HOME = { lat: 51.4545, lon: -2.5879 }
const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

/** Records what the transport was handed, so a silent send can be inspected. */
class ExpoLikeDriver implements PushDriver {
  readonly provider = "expo" as const
  readonly sent: PushMessage[] = []
  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.sent.push(message)
    return { ok: true }
  }
}

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

const original = { driver: null as PushDriver | null }

beforeEach(async () => {
  await ctx.reset()
  original.driver = getPushDriver()
})

afterEach(() => {
  setRuntime({ pushDriver: original.driver })
})

async function phoneLastHeard(secondsAgo: number) {
  const user = await registerUser(ctx.app)
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: user.headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  const upload = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers: user.headers,
    payload: { points: [{ ...HOME, recordedAt: iso(-secondsAgo), accuracyMeters: 12 }] },
  })
  expect(upload.statusCode).toBe(200)
  await getDb().execute(
    sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]'
        where user_id = ${user.user.id}::uuid`,
  )
  return user
}

async function outboxRows() {
  return (await getDb().execute(
    sql`select title, silent, data->>'type' as type, status from notification_outbox order by id`,
  )) as unknown as Array<{ title: string; silent: boolean; type: string; status: string }>
}

async function offlineEvents(userId: string) {
  const rows = (await getDb().execute(
    sql`select count(*)::int as n from events where type = 'device_offline' and actor_user_id = ${userId}::uuid`,
  )) as unknown as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

const tick = () => runJobs(getDb(), getConfig(), ctx.app.log)

describe("waking a quiet phone", () => {
  it("pings a phone quiet for half an hour, silently, and only once per silence", async () => {
    const driver = new ExpoLikeDriver()
    setRuntime({ pushDriver: driver })
    const user = await phoneLastHeard(40 * 60)

    const first = await tick()
    expect(first.phonesWoken).toBe(1)
    expect(first.offlineFlagged).toBe(0)

    const rows = (await outboxRows()).filter((row) => row.type === "wake")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ silent: true, title: "" })

    // In production the commit wakes the drain. Here the next tick's drain
    // is the first to see the row, and hands the transport nothing to show
    // and only the data to act on.
    await tick()
    const wake = driver.sent.find((message) => message.data?.type === "wake")
    expect(wake?.silent).toBe(true)
    expect(wake?.title).toBe("")

    expect((await outboxRows()).filter((row) => row.type === "wake")).toHaveLength(1)
    expect(await offlineEvents(user.user.id)).toBe(0)
  })

  it("leaves a phone alone that reported twenty minutes ago", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    await phoneLastHeard(20 * 60)
    const report = await tick()
    expect(report.phonesWoken).toBe(0)
  })

  it("flags the phone offline only after the wake went unanswered", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const user = await phoneLastHeard(70 * 60)

    // Quiet well past the hour, but never asked: the first sweep asks.
    const first = await tick()
    expect(first.phonesWoken).toBe(1)
    expect(first.offlineFlagged).toBe(0)

    // Moments later the phone still has time to answer.
    const second = await tick()
    expect(second.offlineFlagged).toBe(0)

    await getDb().execute(
      sql`update user_presence set wake_requested_at = now() - interval '11 minutes'
          where user_id = ${user.user.id}::uuid`,
    )
    const third = await tick()
    expect(third.offlineFlagged).toBe(1)
    expect(await offlineEvents(user.user.id)).toBe(1)
  })

  it("does not wait for a wake nobody can send", async () => {
    // The test app runs the none provider, which cannot wake a phone, so the
    // hour of silence alone is the verdict, as it always was.
    const user = await phoneLastHeard(70 * 60)
    const report = await tick()
    expect(report.phonesWoken).toBe(0)
    expect(report.offlineFlagged).toBe(1)
    expect(await offlineEvents(user.user.id)).toBe(1)
  })

  it("skips a silent row on a provider that cannot carry one", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    await phoneLastHeard(40 * 60)
    await getDb().execute(sql`update notification_outbox set status = 'pending'`)
    // Queue it as expo, drain it as ntfy.
    await tick()
    await getDb().execute(
      sql`update notification_outbox set status = 'pending', next_attempt_at = now() - interval '1 minute'`,
    )
    const ntfy: PushDriver = {
      provider: "ntfy",
      send: async () => ({ ok: true }),
    }
    const summary = await drainOutbox(getDb(), ntfy, { now: new Date(Date.now() + 1000) })
    expect(summary.skipped).toBeGreaterThanOrEqual(1)
    const rows = (await outboxRows()).filter((row) => row.type === "wake")
    expect(rows[0]?.status).toBe("skipped")
  })
})

describe("asking phones for a fix on demand", () => {
  async function familyOf(members: number) {
    const owner = await registerUser(ctx.app)
    const circle = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: owner.headers,
      payload: { name: "Family", emoji: "🏠" },
    })
    expect(circle.statusCode).toBe(201)
    const { id, invite } = circle.json() as { id: string; invite: { code: string } }
    const others = []
    for (let i = 0; i < members; i += 1) {
      const member = await registerUser(ctx.app)
      const joined = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/invites/${invite.code}/accept`,
        headers: member.headers,
      })
      expect(joined.statusCode).toBe(200)
      await getDb().execute(
        sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]'
            where user_id = ${member.user.id}::uuid`,
      )
      others.push(member)
    }
    return { owner, circleId: id, others }
  }

  async function reportedAgo(user: { headers: Record<string, string> }, secondsAgo: number) {
    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: user.headers,
      payload: { points: [{ ...HOME, recordedAt: iso(-secondsAgo), accuracyMeters: 12 }] },
    })
    expect(upload.statusCode).toBe(200)
  }

  it("wakes the quiet members once, leaves the fresh one alone, and not again for ten minutes", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { owner, circleId, others } = await familyOf(3)
    await reportedAgo(others[0]!, 15 * 60)
    await reportedAgo(others[1]!, 30)
    await reportedAgo(others[2]!, 15 * 60)

    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/locations/refresh`,
      headers: owner.headers,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ asked: 2 })

    const again = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/locations/refresh`,
      headers: owner.headers,
    })
    expect(again.json()).toEqual({ asked: 0 })
    expect((await outboxRows()).filter((row) => row.type === "wake")).toHaveLength(2)
  })

  it("asks nobody on a provider that cannot carry a silent push", async () => {
    const { owner, circleId, others } = await familyOf(1)
    await reportedAgo(others[0]!, 15 * 60)
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/locations/refresh`,
      headers: owner.headers,
    })
    expect(response.json()).toEqual({ asked: 0 })
  })

  it("puts one person on live updates for the window, once per window, and never someone sharing approximately", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { owner, circleId, others } = await familyOf(2)
    const [watched, approximate] = others

    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/members/${watched!.user.id}/watch`,
      headers: owner.headers,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ watching: true, seconds: 600 })

    // The page calls again a minute later to hold it. No second push.
    const held = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/members/${watched!.user.id}/watch`,
      headers: owner.headers,
    })
    expect(held.json()).toEqual({ watching: true, seconds: 600 })
    const rows = (await outboxRows()).filter((row) => row.type === "watch")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ silent: true })

    await getDb().execute(
      sql`update circle_members set sharing_state = 'approximate'
          where user_id = ${approximate!.user.id}::uuid`,
    )
    const refused = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/members/${approximate!.user.id}/watch`,
      headers: owner.headers,
    })
    expect(refused.json()).toEqual({ watching: false, seconds: 0 })

    const self = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/members/${owner.user.id}/watch`,
      headers: owner.headers,
    })
    expect(self.statusCode).toBe(400)
  })
})
