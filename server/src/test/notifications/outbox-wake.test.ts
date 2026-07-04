import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb, getSql, type Database } from "../../db/client"
import {
  drainOutbox,
  enqueuePush,
  listenForOutbox,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

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

/** Records how many sends were in flight at once, which a sequential loop caps at one. */
class SlowDriver implements PushDriver {
  readonly provider = "expo" as const
  inFlight = 0
  peak = 0
  readonly order: string[] = []

  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.order.push(message.title)
    this.inFlight += 1
    this.peak = Math.max(this.peak, this.inFlight)
    await new Promise((resolve) => setTimeout(resolve, 30))
    this.inFlight -= 1
    return { ok: true }
  }
}

async function phoneWithPush() {
  const user = await registerUser(ctx.app)
  await getDb().execute(
    sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[x]'
        where user_id = ${user.user.id}::uuid`,
  )
  return user.user.id
}

const note = (userId: string, title: string, priority?: "normal" | "high"): PushMessage => ({
  userId,
  title,
  body: "",
  ...(priority ? { priority } : {}),
})

describe("outbox delivery", () => {
  it("queues everything as high priority unless told otherwise", async () => {
    const userId = await phoneWithPush()
    await enqueuePush(getDb(), [note(userId, "arrival")])
    const [row] = (await getDb().execute(
      sql`select priority from notification_outbox`,
    )) as unknown as Array<{ priority: string }>
    expect(row?.priority).toBe("high")
  })

  it("claims a high priority row ahead of an older normal one", async () => {
    const userId = await phoneWithPush()
    const db = getDb()
    await enqueuePush(db, [note(userId, "arrival", "normal")])
    await db.execute(
      sql`update notification_outbox set next_attempt_at = now() - interval '5 seconds'`,
    )
    await enqueuePush(db, [note(userId, "sos", "high")])

    // A moment later, so a row queued in the same millisecond counts as due.
    const driver = new SlowDriver()
    await drainOutbox(db, driver, { concurrency: 1, now: new Date(Date.now() + 1000) })
    expect(driver.order).toEqual(["sos", "arrival"])
  })

  it("sends claimed rows side by side rather than one after another", async () => {
    const userId = await phoneWithPush()
    const db = getDb()
    await enqueuePush(
      db,
      ["a", "b", "c", "d", "e", "f"].map((title) => note(userId, title)),
    )

    const driver = new SlowDriver()
    const summary = await drainOutbox(db, driver, {
      concurrency: 4,
      now: new Date(Date.now() + 1000),
    })
    expect(summary.sent).toBe(6)
    expect(driver.peak).toBeGreaterThan(1)
    expect(driver.peak).toBeLessThanOrEqual(4)
  })
})

describe("outbox wake-up", () => {
  it("wakes the moment a queued notification commits", async () => {
    const userId = await phoneWithPush()
    let wakes = 0
    let wake!: () => void
    const woke = new Promise<void>((resolve) => {
      wake = resolve
    })
    const handle = await listenForOutbox(getSql(), () => {
      wakes += 1
      wake()
    })
    // The listen has to be in place before the insert commits.
    await new Promise((resolve) => setTimeout(resolve, 100))

    await enqueuePush(getDb(), [note(userId, "arrival")])
    await Promise.race([
      woke,
      new Promise((_, reject) => setTimeout(() => reject(new Error("no wake-up")), 3000)),
    ])
    expect(wakes).toBe(1)
    await handle.stop()
  })

  it("stays quiet for a notification whose transaction rolled back", async () => {
    const userId = await phoneWithPush()
    let wakes = 0
    const handle = await listenForOutbox(getSql(), () => {
      wakes += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    await expect(
      getDb().transaction(async (tx) => {
        // The services hand transactions through as the database, see geofence.ts.
        await enqueuePush(tx as unknown as Database, [note(userId, "arrival")])
        throw new Error("the thing that caused it failed")
      }),
    ).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(wakes).toBe(0)
    await handle.stop()
  })
})
