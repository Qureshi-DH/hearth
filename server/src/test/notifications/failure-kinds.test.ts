import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { getDb } from "../../db/client"
import type { AppConfig } from "../../env"
import {
  createPushDriver,
  drainOutbox,
  enqueuePush,
  forgetPushProviderFailures,
  pushProviderFailedSince,
  type DeliveryTarget,
} from "../../services/push"
import { clearOutbox, enablePush, registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * How the Expo driver tells a provider that is down from one that turned
 * the message away, through a real fetch stubbed at the edge. The offline
 * sweep holds its alerts on the first, and an SOS stops trying on the second.
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
  forgetPushProviderFailures()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const expo = () => createPushDriver({ PUSH_PROVIDER: "expo" } as unknown as AppConfig)
const target: DeliveryTarget = {
  sessionId: "s",
  token: "ExponentPushToken[x]",
  provider: "expo",
  platform: "android",
}
const message = { userId: "u", title: "Hearth", body: "Hello" }
const minuteAgo = () => new Date(Date.now() - 60_000)

function answer(status: number, body = "{}") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  )
}

/** One row through the drain, to see what the provider's answer made of it. */
async function drainOne(options: { sendTimeoutMs?: number } = {}) {
  const user = await registerUser(ctx.app)
  await enablePush(user.user.id, "ExponentPushToken[x]")
  await clearOutbox()
  await enqueuePush(getDb(), [{ userId: user.user.id, title: "Hearth", body: "Hello" }])
  await drainOutbox(getDb(), expo(), { now: new Date(Date.now() + 2000), ...options })
  const [row] = (await getDb().execute(
    sql`select status, attempts, last_error from notification_outbox`,
  )) as unknown as Array<{ status: string; attempts: number; last_error: string }>
  return row!
}

describe("a provider that is down", () => {
  it("counts a 5xx as unreachable", async () => {
    answer(503, "service unavailable")
    expect(await expo().send(target, message)).toMatchObject({ ok: false, unreachable: true })
    expect(await drainOne()).toMatchObject({ status: "pending", attempts: 1 })
    expect(pushProviderFailedSince(minuteAgo())).toBe(true)
  })

  it("counts a fetch that throws as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }),
    )
    expect((await drainOne()).last_error).toContain("fetch failed")
    expect(pushProviderFailedSince(minuteAgo())).toBe(true)
  })

  it("counts a provider that never answers as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    )
    expect((await drainOne({ sendTimeoutMs: 50 })).last_error).toContain("no answer")
    expect(pushProviderFailedSince(minuteAgo())).toBe(true)
  })
})

describe("a provider that turned the message away", () => {
  it("counts an Expo 400 as rejected, and not as the provider being down", async () => {
    answer(400, '{"errors":[{"code":"VALIDATION_ERROR"}]}')
    expect(await expo().send(target, message)).toMatchObject({ ok: false, rejected: true })
    await drainOne()
    expect(pushProviderFailedSince(minuteAgo())).toBe(false)
  })

  it("counts a rate limit as neither, so it is simply tried again", async () => {
    answer(429)
    const result = await expo().send(target, message)
    expect(result.rejected).toBeFalsy()
    expect(result.unreachable).toBeFalsy()
  })
})
