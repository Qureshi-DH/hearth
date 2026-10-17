import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getPushDriver, setRuntime } from "../../runtime"
import type { DeliveryResult, PushDriver } from "../../services/push"
import {
  clearOutbox,
  createCircle,
  enablePush,
  joinCircle,
  registerUser,
  setSharing,
  startTestApp,
  uploadFixes,
  type TestContext,
} from "../helpers"

/**
 * What a nudge tells the person who sent it. "Ask for location" has to say
 * what became of it rather than that it worked, and a paused member is an
 * answer rather than a refusal, which a firewall in front of a home server
 * reads as an attack.
 */

let ctx: TestContext

class ExpoLikeDriver implements PushDriver {
  readonly provider = "expo" as const
  async send(): Promise<DeliveryResult> {
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

const HOME = { lat: 51.4545, lon: -2.5879 }
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

async function family() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const circle = await createCircle(ctx.app, alice.headers)
  await joinCircle(ctx.app, bob.headers, circle.invite.code)
  await clearOutbox()
  return { alice, bob, circle }
}

/** Bob's phone last reported a quarter of an hour ago and has said nothing since. */
async function quietFor(user: { headers: Record<string, string>; user: { id: string } }) {
  await uploadFixes(ctx.app, user.headers, [
    { ...HOME, recordedAt: secondsAgo(15 * 60), accuracyMeters: 12 },
  ])
  await getDb().execute(
    sql`update user_presence set last_heard_at = recorded_at where user_id = ${user.user.id}::uuid`,
  )
}

async function nudge(
  headers: Record<string, string>,
  circleId: string,
  userId: string,
  payload?: Record<string, unknown>,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/nudge/${userId}`,
    headers,
    ...(payload ? { payload } : {}),
  })
  return { status: response.statusCode, body: response.json() as Record<string, unknown> }
}

async function outbox() {
  return (await getDb().execute(sql`
    select user_id, title, body, silent, data->>'type' as type from notification_outbox order by id
  `)) as unknown as Array<{
    user_id: string
    title: string
    body: string
    silent: boolean
    type: string
  }>
}

async function nudgesInFeed(circleId: string) {
  const rows = (await getDb().execute(sql`
    select count(*)::int as n from events
    where circle_id = ${circleId}::uuid and type = 'nudge_requested'
  `)) as unknown as Array<{ n: number }>
  return rows[0]!.n
}

describe("asking for a location", () => {
  it("asks the quiet phone for a fix along with the notification, and says so", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await quietFor(bob)
    await enablePush(bob.user.id, "ExponentPushToken[bob]")

    const sent = await nudge(alice.headers, circle.id, bob.user.id)

    expect(sent).toEqual({ status: 200, body: { ok: true, notified: "sent", asked: "pushed" } })
    const rows = await outbox()
    expect(rows.map((row) => [row.user_id, row.type, row.silent])).toEqual([
      [bob.user.id, "nudge_requested", false],
      [bob.user.id, "wake", true],
    ])
  })

  it("says when there is no phone of theirs that can be asked", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await quietFor(bob)

    expect(await nudge(alice.headers, circle.id, bob.user.id)).toEqual({
      status: 200,
      body: { ok: true, notified: "sent", asked: "no_device" },
    })
  })

  it("says when this server cannot wake a phone at all", async () => {
    const { alice, bob, circle } = await family()
    await quietFor(bob)

    expect(await nudge(alice.headers, circle.id, bob.user.id)).toEqual({
      status: 200,
      body: { ok: true, notified: "sent", asked: "unsupported" },
    })
  })

  it("says when the phone reported moments ago and was not woken for nothing", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await uploadFixes(ctx.app, bob.headers, [
      { ...HOME, recordedAt: secondsAgo(5), accuracyMeters: 12 },
    ])
    await enablePush(bob.user.id, "ExponentPushToken[bob]")

    expect(await nudge(alice.headers, circle.id, bob.user.id)).toEqual({
      status: 200,
      body: { ok: true, notified: "sent", asked: "fresh" },
    })
    expect((await outbox()).filter((row) => row.type === "wake")).toHaveLength(0)
  })

  it("answers that a paused member paused, and sends them nothing", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await quietFor(bob)
    await enablePush(bob.user.id, "ExponentPushToken[bob]")
    await setSharing(ctx.app, bob.headers, circle.id, "paused")
    await clearOutbox()

    expect(await nudge(alice.headers, circle.id, bob.user.id)).toEqual({
      status: 200,
      body: { ok: true, notified: "paused", asked: "paused" },
    })
    expect(await outbox()).toEqual([])
    expect(await nudgesInFeed(circle.id)).toBe(0)
  })

  // The member's page and Live tell a viewer nothing about the phone of
  // somebody sharing approximately, whether it is connected, reported a
  // moment ago or has no push, and a nudge must not either.
  it("asks nothing of the phone of a member sharing approximately, and says so", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await quietFor(bob)
    await enablePush(bob.user.id, "ExponentPushToken[bob]")
    await setSharing(ctx.app, bob.headers, circle.id, "approximate")
    await clearOutbox()

    expect(await nudge(alice.headers, circle.id, bob.user.id)).toEqual({
      status: 200,
      body: { ok: true, notified: "sent", asked: "unsupported" },
    })
    expect((await outbox()).map((row) => row.type)).toEqual(["nudge_requested"])
  })

  it("does not notify twice when the same person asks again a moment later", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await quietFor(bob)
    await enablePush(bob.user.id, "ExponentPushToken[bob]")

    await nudge(alice.headers, circle.id, bob.user.id)
    const again = await nudge(alice.headers, circle.id, bob.user.id)

    expect(again).toEqual({ status: 200, body: { ok: true, notified: "held", asked: "held" } })
    expect((await outbox()).filter((row) => row.type === "nudge_requested")).toHaveLength(1)
    expect(await nudgesInFeed(circle.id)).toBe(1)
  })
})

describe("somebody no longer in the circle", () => {
  // The member's page stays up after they leave, and its button still
  // points at them. A 404 for pressing it is a 4xx in ordinary use.
  it("is answered as gone, and sent nothing", async () => {
    const { alice, bob, circle } = await family()
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${bob.user.id}`,
      headers: bob.headers,
    })
    expect(left.statusCode).toBe(200)
    await clearOutbox()

    expect(await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })).toEqual({
      status: 200,
      body: { ok: true, notified: "gone", asked: null },
    })
    expect(await nudge(alice.headers, circle.id, bob.user.id)).toEqual({
      status: 200,
      body: { ok: true, notified: "gone", asked: "unsupported" },
    })
    expect(await outbox()).toEqual([])
    expect(await nudgesInFeed(circle.id)).toBe(0)
  })
})

describe("a message", () => {
  it("reaches a member who has paused sharing, because a message is not a location", async () => {
    setRuntime({ pushDriver: new ExpoLikeDriver() })
    const { alice, bob, circle } = await family()
    await quietFor(bob)
    await enablePush(bob.user.id, "ExponentPushToken[bob]")
    await setSharing(ctx.app, bob.headers, circle.id, "paused")
    await clearOutbox()

    const sent = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })

    expect(sent).toEqual({ status: 200, body: { ok: true, notified: "sent", asked: null } })
    // The words, and no wake. A message asks nothing of the phone.
    expect((await outbox()).map((row) => [row.type, row.body])).toEqual([
      ["nudge_requested", "Call me when you can."],
    ])
  })

  it("is held when the same words go to the same person a moment later, and a new one is not", async () => {
    const { alice, bob, circle } = await family()

    const first = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })
    const repeat = await nudge(alice.headers, circle.id, bob.user.id, { quickKey: "call_me" })
    const different = await nudge(alice.headers, circle.id, bob.user.id, { body: "At the gate" })

    expect([first.body.notified, repeat.body.notified, different.body.notified]).toEqual([
      "sent",
      "held",
      "sent",
    ])
    expect((await outbox()).map((row) => row.body)).toEqual([
      "Call me when you can.",
      "At the gate",
    ])
  })
})
