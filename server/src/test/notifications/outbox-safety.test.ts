import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  drainOutbox,
  enqueuePush,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * What the drain does when the outside world misbehaves: a provider that
 * never answers, a row another claimant took over, a silent push that has
 * outlived its question, and news of a place for a circle that may no longer
 * hear it.
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

class Driver implements PushDriver {
  readonly provider = "expo" as const
  readonly attempted: PushMessage[] = []
  constructor(
    private readonly behaviour: (message: PushMessage) => Promise<DeliveryResult> = async () => ({
      ok: true,
    }),
  ) {}
  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.attempted.push(message)
    return this.behaviour(message)
  }
}

async function withPushToken(userId: string) {
  await getDb().execute(sql`
    update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]'
    where user_id = ${userId}::uuid
  `)
}

async function outbox() {
  return (await getDb().execute(
    sql`select id, status, last_error from notification_outbox order by id`,
  )) as unknown as Array<{ id: number; status: string; last_error: string | null }>
}

const soon = () => new Date(Date.now() + 2000)

describe("a provider that never answers", () => {
  it("costs one attempt, not the drain", async () => {
    const user = await registerUser(ctx.app)
    await withPushToken(user.user.id)
    await enqueuePush(getDb(), [{ userId: user.user.id, title: "Hearth", body: "Hello" }])

    const stalled = new Driver(() => new Promise<DeliveryResult>(() => {}))
    const summary = await drainOutbox(getDb(), stalled, { now: soon(), sendTimeoutMs: 200 })

    expect(summary.failed).toBe(1)
    const [row] = await outbox()
    expect(row).toMatchObject({ status: "pending" })
    expect(row!.last_error).toContain("no answer")
  })
})

describe("a row another claimant took over", () => {
  it("keeps the result the new owner wrote", async () => {
    const user = await registerUser(ctx.app)
    await withPushToken(user.user.id)
    await enqueuePush(getDb(), [{ userId: user.user.id, title: "Hearth", body: "Hello" }])

    // While this send is on the wire the row is requeued and delivered by
    // somebody else, which moves its claim stamp on.
    const slow = new Driver(async () => {
      await getDb().execute(sql`
        update notification_outbox set status = 'sent', next_attempt_at = now() + interval '1 hour'
      `)
      return { ok: false, error: "provider said no" }
    })
    await drainOutbox(getDb(), slow, { now: soon() })

    const [row] = await outbox()
    expect(row).toMatchObject({ status: "sent" })
  })
})

describe("a silent push past its lifetime", () => {
  it("is failed rather than sent to a phone whose viewer has gone", async () => {
    const user = await registerUser(ctx.app)
    await withPushToken(user.user.id)
    await enqueuePush(getDb(), [
      {
        userId: user.user.id,
        title: "",
        body: "",
        silent: true,
        data: { type: "watch", seconds: 600 },
      },
    ])
    await getDb().execute(
      sql`update notification_outbox set created_at = now() - interval '1 hour'`,
    )

    const driver = new Driver()
    await drainOutbox(getDb(), driver, { now: soon() })

    expect(driver.attempted).toHaveLength(0)
    const [row] = await outbox()
    expect(row).toMatchObject({ status: "failed" })
  })
})

describe("news of a place for a circle that stopped seeing it", () => {
  it("is dropped once the member pauses that circle, and a crash alert is not", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const create = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: parent.headers,
      payload: { name: "Family", emoji: "🏠" },
    })
    const circle = create.json() as { id: string; invite: { code: string } }
    const teen = await registerUser(ctx.app, {
      displayName: "Teen",
      inviteCode: circle.invite.code,
    })
    await withPushToken(parent.user.id)

    for (const type of ["place_arrive", "possible_incident"]) {
      const [event] = (await getDb().execute(sql`
        insert into events (circle_id, type, actor_user_id, summary)
        values (${circle.id}::uuid, ${type}, ${teen.user.id}::uuid, 'Teen arrived at Clinic')
        returning id
      `)) as unknown as Array<{ id: number }>
      await enqueuePush(getDb(), [
        {
          userId: parent.user.id,
          circleId: circle.id,
          title: "Clinic",
          body: "Teen arrived at Clinic",
          data: { type, circleId: circle.id, eventId: String(event!.id) },
        },
      ])
    }

    const paused = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: teen.headers,
      payload: { sharingState: "paused" },
    })
    expect(paused.statusCode).toBe(200)

    const driver = new Driver()
    await drainOutbox(getDb(), driver, { now: soon() })

    const rows = (await getDb().execute(
      sql`select status from notification_outbox where title = 'Clinic' order by id`,
    )) as unknown as Array<{ status: string }>
    expect(rows.map((row) => row.status)).toEqual(["skipped", "sent"])
    expect(
      driver.attempted.filter((message) => message.title === "Clinic").map((m) => m.data?.type),
    ).toEqual(["possible_incident"])
  })
})

describe("the admin's view of the outbox", () => {
  it("shows the text of the admin's own notifications only", async () => {
    const admin = await registerUser(ctx.app)
    const other = await registerUser(ctx.app)
    await enqueuePush(getDb(), [
      { userId: admin.user.id, title: "Mine", body: "For the admin" },
      { userId: other.user.id, title: "Clinic", body: "Someone arrived at Clinic" },
    ])

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/push/queue",
      headers: admin.headers,
    })
    expect(response.statusCode).toBe(200)
    const rows = response.json() as Array<{
      userId: string
      title: string | null
      body: string | null
    }>
    expect(rows.find((row) => row.userId === admin.user.id)).toMatchObject({ title: "Mine" })
    expect(rows.find((row) => row.userId === other.user.id)).toMatchObject({
      title: null,
      body: null,
    })
  })
})
