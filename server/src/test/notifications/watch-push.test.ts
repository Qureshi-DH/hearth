import type { WatchResponse } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { getDb } from "../../db/client"
import type { AppConfig } from "../../env"
import { getPushDriver, setRuntime } from "../../runtime"
import {
  createPushDriver,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import { registerUser, silentSinceLastFix, startTestApp, type TestContext } from "../helpers"

/**
 * The watch reply says whether the phone was reached, and the silent push
 * carries a lifetime so a wake held back by Doze does not fire an hour late.
 */

const ROAD = { lat: 51.4712, lon: -2.5601 }
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString()

class ExpoLikeDriver implements PushDriver {
  readonly provider = "expo" as const
  async send(_target: DeliveryTarget, _message: PushMessage): Promise<DeliveryResult> {
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
  vi.unstubAllGlobals()
})

async function family() {
  const owner = await registerUser(ctx.app)
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: owner.headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(created.statusCode).toBe(201)
  const circle = created.json() as { id: string; invite: { code: string } }
  const member = await registerUser(ctx.app)
  const joined = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${circle.invite.code}/accept`,
    headers: member.headers,
  })
  expect(joined.statusCode).toBe(200)
  const upload = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers: member.headers,
    payload: {
      points: [
        {
          ...ROAD,
          recordedAt: minutesAgo(10),
          accuracyMeters: 12,
          speedMps: 14,
          activity: "driving",
        },
      ],
    },
  })
  expect(upload.statusCode).toBe(200)
  // Quiet since that fix, so the pushes below are what the phone has to answer.
  await silentSinceLastFix(member.user.id)
  const watch = async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${member.user.id}/watch`,
      headers: owner.headers,
    })
    expect(response.statusCode).toBe(200)
    return response.json() as WatchResponse
  }
  return { owner, member, circle, watch }
}

async function giveToken(userId: string) {
  await getDb().execute(
    sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]'
        where user_id = ${userId}::uuid`,
  )
}

async function watchRows() {
  return (await getDb().execute(
    sql`select id, status from notification_outbox where data->>'type' = 'watch' order by id`,
  )) as unknown as Array<{ id: number; status: string }>
}

/** Every watch push queued so far went that many seconds ago. */
async function ageWatchPushes(seconds: number) {
  await getDb().execute(
    sql`update notification_outbox
        set created_at = created_at - make_interval(secs => ${seconds})
        where data->>'type' = 'watch'`,
  )
}

describe("the watch reply says whether the phone was reached", () => {
  it("says so when the provider cannot carry a silent push", async () => {
    const { watch } = await family()
    const reply = await watch()
    expect(reply).toMatchObject({
      watching: true,
      seconds: 600,
      pushed: "unsupported",
      activity: "driving",
      issues: [],
    })
    expect(Date.now() - Date.parse(reply.lastFixAt!)).toBeGreaterThan(2 * 60 * 1000)
    expect(reply.lastHeardAt).toBe(reply.lastFixAt)
  })

  it("says so when the member has no push token", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { watch } = await family()
    expect((await watch()).pushed).toBe("no_device")
    expect(await watchRows()).toHaveLength(0)
  })

  it("sends, holds, then asks again while nothing comes back, three times at most", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { member, watch } = await family()
    await giveToken(member.user.id)

    expect((await watch()).pushed).toBe("sent")
    expect((await watch()).pushed).toBe("held")

    // A minute and a half with no upload newer than the push: the push may
    // not have arrived, so it is worth one more.
    await ageWatchPushes(91)
    expect((await watch()).pushed).toBe("sent")
    await ageWatchPushes(91)
    expect((await watch()).pushed).toBe("sent")
    await ageWatchPushes(91)
    expect((await watch()).pushed).toBe("held")
    expect(await watchRows()).toHaveLength(3)
  })

  it("does not ask again once the phone has answered", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { member, watch } = await family()
    await giveToken(member.user.id)
    expect((await watch()).pushed).toBe("sent")
    await ageWatchPushes(91)

    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: member.headers,
      payload: {
        points: [{ ...ROAD, recordedAt: minutesAgo(0), accuracyMeters: 8, speedMps: 14 }],
      },
    })
    expect(upload.statusCode).toBe(200)
    expect((await watch()).pushed).toBe("held")
    expect(await watchRows()).toHaveLength(1)
  })

  it("does not count a push that never went", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { member, watch } = await family()
    await giveToken(member.user.id)
    expect((await watch()).pushed).toBe("sent")
    await getDb().execute(
      sql`update notification_outbox set status = 'skipped' where data->>'type' = 'watch'`,
    )
    expect((await watch()).pushed).toBe("sent")
  })

  it("carries what the phone said stands in its way", async () => {
    const { member, watch } = await family()
    const health = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/me/health",
      headers: member.headers,
      payload: { locationPermission: "foreground", locationServices: true, lowPowerMode: true },
    })
    expect(health.statusCode).toBe(200)
    expect((await watch()).issues).toEqual(["location_permission", "low_power_mode"])
  })

  it("tells a viewer nothing about someone sharing approximately", async () => {
    const { member, watch } = await family()
    await getDb().execute(
      sql`update circle_members set sharing_state = 'approximate'
          where user_id = ${member.user.id}::uuid`,
    )
    expect(await watch()).toEqual({
      watching: false,
      seconds: 0,
      pushed: "unsupported",
      lastFixAt: null,
      lastHeardAt: null,
      activity: null,
      issues: [],
    })
  })
})

describe("asking the circle's phones for a fix", () => {
  it("leaves alone a phone heard a minute ago, however old its last fix", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { owner, member, circle } = await family()
    await giveToken(member.user.id)
    const upload = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: member.headers,
      payload: { points: [{ ...ROAD, recordedAt: minutesAgo(30), accuracyMeters: 12 }] },
    })
    expect(upload.statusCode).toBe(200)

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/locations/refresh`,
      headers: owner.headers,
    })
    expect(response.json()).toEqual({ asked: 0 })
  })
})

describe("the silent push envelope", () => {
  const sent: Array<Record<string, unknown>> = []

  function stubExpo() {
    sent.length = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(...(JSON.parse(init.body) as Array<Record<string, unknown>>))
        return new Response(JSON.stringify({ data: [{ status: "ok" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
    )
    return createPushDriver({ PUSH_PROVIDER: "expo" } as unknown as AppConfig)
  }

  const target = (platform: "ios" | "android"): DeliveryTarget => ({
    sessionId: "s",
    token: "ExponentPushToken[x]",
    provider: "expo",
    platform,
  })

  const silent = (type: string): PushMessage => ({
    userId: "u",
    title: "",
    body: "",
    silent: true,
    data: { type },
  })

  it("gives a watch a minute to arrive, at normal priority on iOS", async () => {
    const driver = stubExpo()
    const before = Math.floor(Date.now() / 1000)
    await driver.send(target("ios"), silent("watch"))
    expect(sent[0]).toMatchObject({ ttl: 60, priority: "normal", _contentAvailable: true })
    expect(sent[0]!.expiration as number).toBeGreaterThanOrEqual(before + 60)
    expect(sent[0]!.expiration as number).toBeLessThanOrEqual(before + 62)
  })

  it("keeps Android at high priority and gives a wake five minutes", async () => {
    const driver = stubExpo()
    await driver.send(target("android"), silent("wake"))
    expect(sent[0]).toMatchObject({ ttl: 300, priority: "high" })
  })

  it("gives a nudge ten minutes", async () => {
    const driver = stubExpo()
    await driver.send(target("android"), silent("nudge_requested"))
    expect(sent[0]).toMatchObject({ ttl: 600 })
  })

  it("leaves a visible notification without a lifetime", async () => {
    const driver = stubExpo()
    await driver.send(target("ios"), {
      userId: "u",
      title: "Phone offline",
      body: "Sami's phone has not reported in for a while.",
      channel: "alerts",
      priority: "high",
    })
    expect(sent[0]).not.toHaveProperty("ttl")
    expect(sent[0]).toMatchObject({ priority: "high", title: "Phone offline" })
  })
})
