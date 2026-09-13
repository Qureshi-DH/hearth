import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, silentSinceLastFix, startTestApp, type TestContext } from "../helpers"

/**
 * Three places where the server decides whether to say something: the outage
 * guard that holds back offline alerts, the last-administrator check, and a
 * speed run replayed from a backlog before the live part of the same drive.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180

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

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString()

async function upload(headers: Headers, points: Array<Record<string, unknown>>) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

async function family() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: parent.headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  const circle = created.json() as { id: string; invite: { code: string } }
  const teen = await registerUser(ctx.app, { displayName: "Teen", inviteCode: circle.invite.code })
  return { parent, teen, circleId: circle.id }
}

async function feedTypes(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  return (response.json() as { items: Array<{ type: string }> }).items.map((item) => item.type)
}

describe("the outage guard", () => {
  it("is not tripped by accounts whose phones went dark long ago", async () => {
    const { parent, teen, circleId } = await family()

    // Four phones reporting now, four that died days ago and were announced.
    for (let n = 0; n < 4; n += 1) {
      const live = await registerUser(ctx.app)
      await upload(live.headers, [{ ...HOME, recordedAt: minutesAgo(1), accuracyMeters: 10 }])
    }
    for (let n = 0; n < 4; n += 1) {
      const dead = await registerUser(ctx.app)
      await upload(dead.headers, [
        { ...HOME, recordedAt: minutesAgo(3 * 24 * 60), accuracyMeters: 10 },
      ])
      await silentSinceLastFix(dead.user.id)
      await getDb().execute(sql`
        update user_presence set offline_notified_at = now() - interval '3 days'
        where user_id = ${dead.user.id}::uuid
      `)
    }

    // The teen's phone goes dark on the road.
    await upload(teen.headers, [
      { ...HOME, recordedAt: minutesAgo(90), accuracyMeters: 10, speedMps: 12 },
    ])
    await silentSinceLastFix(teen.user.id)

    await runJobs(getDb(), getConfig(), ctx.app.log)
    expect(await feedTypes(parent.headers, circleId)).toContain("device_offline")
  })
})

describe("the last administrator", () => {
  it("survives two administrators demoting each other at the same moment", async () => {
    const first = await registerUser(ctx.app)
    const second = await registerUser(ctx.app)
    await getDb().execute(sql`update users set is_admin = true`)

    const demote = (headers: Headers, userId: string) =>
      ctx.app.inject({
        method: "PATCH",
        url: `/api/v1/admin/users/${userId}`,
        headers,
        payload: { isAdmin: false },
      })
    const results = await Promise.all([
      demote(first.headers, second.user.id),
      demote(second.headers, first.user.id),
    ])

    // One wins. The other is refused, or finds its own session already ended
    // by the demotion that won.
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1)
    const [{ admins } = { admins: 0 }] = (await getDb().execute(
      sql`select count(*)::int as admins from users where is_admin`,
    )) as unknown as Array<{ admins: number }>
    expect(admins).toBe(1)
  })
})

describe("a speed run replayed from a backlog", () => {
  it("does not use up the alert the live part of the same drive is owed", async () => {
    const { parent, teen, circleId } = await family()
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circleId}`,
      headers: parent.headers,
      payload: { settings: { speedAlertKmh: 100 } },
    })

    const run = (startMinutesAgo: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        lat: HOME.lat + (36 * 30 * i) / M_PER_DEG_LAT,
        lon: HOME.lon,
        recordedAt: minutesAgo(startMinutesAgo - i * 0.5),
        accuracyMeters: 8,
        speedMps: 36,
        activity: "driving",
      }))

    // The first batch of the backlog ends twenty minutes ago: a replay.
    await upload(teen.headers, run(40, 8))
    // The phone catches up to the present, still over the limit.
    await upload(teen.headers, run(3, 6))

    const pushes = (await getDb().execute(sql`
      select count(*)::int as n from notification_outbox where data->>'type' = 'speed_alert'
    `)) as unknown as Array<{ n: number }>
    expect(pushes[0]!.n).toBe(1)
  })
})
