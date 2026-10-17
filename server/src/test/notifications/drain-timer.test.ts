import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb, getSql } from "../../db/client"
import { createOutboxDrainer } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import {
  enqueuePush,
  listenForOutbox,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import {
  clearOutbox,
  createCircle,
  createPlace,
  enablePush,
  joinCircle,
  registerUser,
  startTestApp,
  uploadFixes,
  type TestContext,
} from "../helpers"

/**
 * A notification held back for a moment, such as an arrival at driving speed
 * or a departure waiting for its second fix, goes the moment it falls due
 * rather than on the next minute's tick. Nothing in the database announces
 * that moment, so the drain keeps a timer for it.
 */

let ctx: TestContext
let configured: PushDriver | null

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
  configured = getPushDriver()
})

afterEach(() => {
  setRuntime({ pushDriver: configured })
})

class StampingDriver implements PushDriver {
  readonly provider = "expo" as const
  readonly delivered: Array<{ at: number; message: PushMessage }> = []
  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.delivered.push({ at: Date.now(), message })
    return { ok: true }
  }
}

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return check()
}

async function phone() {
  const user = await registerUser(ctx.app, { displayName: "Parent" })
  await enablePush(user.user.id, "ExponentPushToken[parent-phone]")
  return user
}

describe("a notification held back for a moment", () => {
  it("goes when it falls due, with no tick to wake the drain", async () => {
    const user = await phone()
    const driver = new StampingDriver()
    setRuntime({ pushDriver: driver })
    const drainer = createOutboxDrainer(getDb(), ctx.app.log)
    const listener = await listenForOutbox(getSql(), drainer.wake)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const due = Date.now() + 1500
    await enqueuePush(getDb(), [
      { userId: user.user.id, title: "Home", body: "Held", notBefore: new Date(due) },
    ])

    expect(await until(() => driver.delivered.length > 0, 4000)).toBe(true)
    expect(driver.delivered[0]!.at).toBeGreaterThanOrEqual(due)
    expect(driver.delivered[0]!.at - due).toBeLessThan(500)

    await listener.stop()
    drainer.stop()
    await drainer.idle()
  })

  it("is picked up again by a server that restarted while it waited", async () => {
    const user = await phone()
    const due = Date.now() + 1200
    await enqueuePush(getDb(), [
      { userId: user.user.id, title: "Home", body: "Held", notBefore: new Date(due) },
    ])

    const driver = new StampingDriver()
    setRuntime({ pushDriver: driver })
    const drainer = createOutboxDrainer(getDb(), ctx.app.log)
    // What the scheduler does on boot.
    drainer.wake()

    expect(await until(() => driver.delivered.length > 0, 4000)).toBe(true)
    expect(driver.delivered[0]!.at - due).toBeLessThan(500)
    drainer.stop()
    await drainer.idle()
  })
})

describe("how soon the family hears of an arrival", () => {
  it("is well under a second at walking pace", async () => {
    const parent = await phone()
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(ctx.app, parent.headers)
    await joinCircle(ctx.app, kid.headers, circle.invite.code)
    const home = { lat: 51.4545, lon: -2.5879 }
    await uploadFixes(ctx.app, kid.headers, [
      { lat: 51.46, lon: -2.5879, recordedAt: new Date(Date.now() - 600_000).toISOString() },
    ])
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...home })
    await clearOutbox()

    const driver = new StampingDriver()
    setRuntime({ pushDriver: driver })
    const drainer = createOutboxDrainer(getDb(), ctx.app.log)
    const listener = await listenForOutbox(getSql(), drainer.wake)
    await new Promise((resolve) => setTimeout(resolve, 100))

    const seen = Date.now()
    await uploadFixes(ctx.app, kid.headers, [
      { ...home, recordedAt: new Date().toISOString(), accuracyMeters: 8, speedMps: 1.2 },
    ])
    expect(await until(() => driver.delivered.length > 0, 3000)).toBe(true)
    const latency = driver.delivered[0]!.at - seen
    expect(driver.delivered[0]!.message.body).toBe("Arrived at Home")
    expect(latency).toBeLessThan(1000)

    await listener.stop()
    drainer.stop()
    await drainer.idle()
  })
})
