import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import {
  drainOutbox,
  enqueuePush,
  forgetPushProviderFailures,
  pruneOutbox,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import {
  clearOutbox,
  createCircle,
  enablePush,
  joinCircle,
  registerUser,
  silentSinceLastFix,
  startTestApp,
  uploadFixes,
  type TestContext,
} from "../helpers"

/**
 * "Phone offline" is news only while it is true. It is not delivered once the
 * phone has spoken again, not sent at all when the server is the one that
 * was cut off, and a family that was told gets told when it is over.
 */

let ctx: TestContext
const HOME = { lat: 51.4545, lon: -2.5879 }
const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()
const minutesLater = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000)

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

const original = { driver: null as PushDriver | null }

beforeEach(async () => {
  await ctx.reset()
  forgetPushProviderFailures()
  original.driver = getPushDriver()
})

afterEach(() => {
  setRuntime({ pushDriver: original.driver })
})

class FakeDriver implements PushDriver {
  readonly provider = "expo" as const
  readonly delivered: Array<{ token: string; message: PushMessage }> = []

  constructor(private readonly answer: () => DeliveryResult = () => ({ ok: true })) {}

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const result = this.answer()
    if (result.ok) this.delivered.push({ token: target.token, message })
    return result
  }
}

const providerDown = () => new FakeDriver(() => ({ ok: false, error: "expo http 503" }))
/** What a home server with no way out to the internet sees. */
const cutOff = () => new FakeDriver(() => ({ ok: false, unreachable: true, error: "fetch failed" }))

const tick = () => runJobs(getDb(), getConfig(), ctx.app.log)

/** Parent and aunt are told about the teen, whose phone went quiet ninety minutes ago. */
async function family() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const aunt = await registerUser(ctx.app, { displayName: "Aunt" })
  const teen = await registerUser(ctx.app, { displayName: "Teen" })
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, aunt.headers, circle.invite.code)
  await joinCircle(ctx.app, teen.headers, circle.invite.code)
  await enablePush(parent.user.id, "ExponentPushToken[parent]")
  await enablePush(aunt.user.id, "ExponentPushToken[aunt]")
  await uploadFixes(ctx.app, teen.headers, [
    { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
  ])
  await silentSinceLastFix(teen.user.id)
  await clearOutbox()
  return { parent, aunt, teen, circle }
}

async function phoneBack(headers: Record<string, string>) {
  await uploadFixes(ctx.app, headers, [
    { ...HOME, recordedAt: iso(-20), accuracyMeters: 12, batteryLevel: 0.5 },
  ])
}

async function rows(type: string) {
  return (await getDb().execute(
    sql`select user_id, channel, status, last_error from notification_outbox
        where data->>'type' = ${type} order by id`,
  )) as unknown as Array<{
    user_id: string
    channel: string
    status: string
    last_error: string | null
  }>
}

async function eventCount(type: string) {
  const [row] = (await getDb().execute(
    sql`select count(*)::int as n from events where type = ${type}`,
  )) as unknown as Array<{ n: number }>
  return row!.n
}

describe("an offline alert still waiting to go out", () => {
  it("is dropped once the phone has reported again", async () => {
    const { teen } = await family()
    expect((await tick()).offlineFlagged).toBe(1)
    await drainOutbox(getDb(), providerDown(), { now: minutesLater(1) })

    await phoneBack(teen.headers)

    const back = new FakeDriver()
    await drainOutbox(getDb(), back, { now: minutesLater(30) })
    expect(back.delivered).toHaveLength(0)
    expect((await rows("device_offline")).map((row) => row.status)).toEqual(["skipped", "skipped"])
  })

  it("is delivered while the phone stays quiet", async () => {
    await family()
    await tick()
    await drainOutbox(getDb(), providerDown(), { now: minutesLater(1) })

    const back = new FakeDriver()
    await drainOutbox(getDb(), back, { now: minutesLater(30) })
    expect(back.delivered.map((entry) => entry.token).sort()).toEqual([
      "ExponentPushToken[aunt]",
      "ExponentPushToken[parent]",
    ])
  })
})

describe("a server that is itself cut off", () => {
  async function failToReachProvider(userId: string) {
    await enqueuePush(getDb(), [{ userId, title: "Hearth", body: "Hello" }])
    await drainOutbox(getDb(), cutOff(), { now: minutesLater(1) })
    await clearOutbox()
  }

  it("holds offline alerts while the push provider cannot be reached", async () => {
    const { parent } = await family()
    await failToReachProvider(parent.user.id)

    expect((await tick()).offlineFlagged).toBe(0)
    expect(await eventCount("device_offline")).toBe(0)
  })

  it("lets them go once the provider has been reachable for half an hour", async () => {
    const { parent } = await family()
    const realNow = Date.now()
    const spy = vi.spyOn(Date, "now").mockReturnValue(realNow - 31 * 60 * 1000)
    try {
      await failToReachProvider(parent.user.id)
    } finally {
      spy.mockRestore()
    }

    expect((await tick()).offlineFlagged).toBe(1)
  })

  it("does not count a provider that answered with an error as unreachable", async () => {
    const { parent } = await family()
    await enqueuePush(getDb(), [{ userId: parent.user.id, title: "Hearth", body: "Hello" }])
    await drainOutbox(
      getDb(),
      new FakeDriver(() => ({ ok: false, rejected: true, error: "expo http 400" })),
      { now: minutesLater(1) },
    )
    await clearOutbox()

    expect((await tick()).offlineFlagged).toBe(1)
  })

  it("holds them on a family server where every phone went quiet at once", async () => {
    for (const name of ["Mum", "Dad", "Teen"]) {
      const member = await registerUser(ctx.app, { displayName: name })
      await createCircle(ctx.app, member.headers)
      await uploadFixes(ctx.app, member.headers, [
        { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
      ])
      await silentSinceLastFix(member.user.id)
    }

    expect((await tick()).offlineFlagged).toBe(0)
    expect(await eventCount("device_offline")).toBe(0)
  })

  it("still tells the family about one phone that went dark while the rest report", async () => {
    const { parent } = await family()
    await uploadFixes(ctx.app, parent.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.8 },
    ])

    expect((await tick()).offlineFlagged).toBe(1)
  })

  it("still tells them about the only phone on a server that has one", async () => {
    await family()
    expect((await tick()).offlineFlagged).toBe(1)
  })
})

describe("the phone reporting again", () => {
  it("is pushed to everyone who was sent the offline alert, on the alerts channel", async () => {
    const { teen } = await family()
    await tick()
    const first = new FakeDriver()
    await drainOutbox(getDb(), first, { now: minutesLater(1) })
    expect(first.delivered).toHaveLength(2)

    await phoneBack(teen.headers)
    await tick()

    const back = await rows("device_online")
    expect(back).toHaveLength(2)
    expect(back.every((row) => row.channel === "alerts")).toBe(true)

    const second = new FakeDriver()
    await drainOutbox(getDb(), second, { now: minutesLater(2) })
    const toParent = second.delivered.find((entry) => entry.token === "ExponentPushToken[parent]")
    // It joins the card that said the phone had gone quiet.
    expect(toParent?.message.title).toBe("Teen's phone")
    expect(toParent?.message.body.split("\n")[0]).toBe("Reporting again")
    expect(toParent?.message.replaceKey).toBe(
      first.delivered.find((entry) => entry.token === "ExponentPushToken[parent]")?.message
        .replaceKey,
    )
  })

  it("is not pushed to someone who has muted phone offline since", async () => {
    const { aunt, teen, circle } = await family()
    await tick()
    await drainOutbox(getDb(), new FakeDriver(), { now: minutesLater(1) })

    const muted = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/notifications`,
      headers: aunt.headers,
      payload: { muted: ["device_offline"] },
    })
    expect(muted.statusCode).toBe(200)

    await phoneBack(teen.headers)
    await tick()

    expect((await rows("device_online")).map((row) => row.user_id)).not.toContain(aunt.user.id)
    expect(await rows("device_online")).toHaveLength(1)
  })

  it("is not pushed when the offline alert never went out", async () => {
    const { teen } = await family()
    await tick()
    await drainOutbox(getDb(), providerDown(), { now: minutesLater(1) })

    await phoneBack(teen.headers)
    await tick()

    expect(await eventCount("device_online")).toBe(1)
    expect(await rows("device_online")).toHaveLength(0)
  })
})

describe("a long outage of the server's own connection, through Expo", () => {
  /** Three phones that can be woken, and Gran, who is told about them. */
  async function wakeableFamily() {
    const gran = await registerUser(ctx.app, { displayName: "Gran" })
    const circle = await createCircle(ctx.app, gran.headers)
    await enablePush(gran.user.id, "ExponentPushToken[gran]")
    const phones = []
    for (const name of ["Mum", "Dad", "Teen"]) {
      const member = await registerUser(ctx.app, { displayName: name })
      await joinCircle(ctx.app, member.headers, circle.invite.code)
      await enablePush(member.user.id, `ExponentPushToken[${name}]`)
      await uploadFixes(ctx.app, member.headers, [
        { ...HOME, recordedAt: iso(-150 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
      ])
      await silentSinceLastFix(member.user.id)
      phones.push(member)
    }
    await clearOutbox()
    return { gran, circle, phones }
  }

  /** The wakes the last tick queued reach nobody, and time moves past the next gap. */
  async function wakesGoNowhere() {
    const db = getDb()
    await drainOutbox(db, cutOff(), { now: minutesLater(0.1) })
    await drainOutbox(db, cutOff(), { now: minutesLater(10) })
    await db.execute(
      sql`update user_presence set wake_requested_at = wake_requested_at - interval '30 minutes'
          where wake_requested_at is not null`,
    )
  }

  async function wakeCounts() {
    const rows = (await getDb().execute(
      sql`select wake_count from user_presence order by user_id`,
    )) as unknown as Array<{ wake_count: number }>
    return rows.map((row) => row.wake_count)
  }

  it("does not count a wake that never got out", async () => {
    setRuntime({ pushDriver: cutOff() })
    await wakeableFamily()
    expect((await tick()).phonesWoken).toBe(3)
    await wakesGoNowhere()
    expect(await wakeCounts()).toEqual([0, 0, 0])
  })

  it("tells nobody about the rest when the first phone gets back through", async () => {
    setRuntime({ pushDriver: cutOff() })
    const { phones } = await wakeableFamily()
    for (let round = 0; round < 3; round += 1) {
      await tick()
      await wakesGoNowhere()
    }
    // The process restarted, or simply went half an hour without trying
    // the provider, so nothing in memory remembers the outage.
    forgetPushProviderFailures()
    setRuntime({ pushDriver: new FakeDriver() })

    await phoneBack(phones[0]!.headers)
    expect((await tick()).offlineFlagged).toBe(0)
    expect(await eventCount("device_offline")).toBe(0)
  })

  it("keeps the hold for half an hour after it last held, across a restart", async () => {
    const { phones } = await wakeableFamily()
    // No push provider at all, so the family guard is the only one that holds.
    expect((await tick()).offlineFlagged).toBe(0)
    forgetPushProviderFailures()

    await phoneBack(phones[0]!.headers)
    expect((await tick()).offlineFlagged).toBe(0)

    await getDb().execute(
      sql`update server_settings set updated_at = now() - interval '31 minutes'`,
    )
    expect((await tick()).offlineFlagged).toBe(2)
  })
})

describe("a phone already announced offline", () => {
  it("does not hold back the alert for a second phone that goes quiet later", async () => {
    const { teen } = await family()
    const brother = await registerUser(ctx.app, { displayName: "Brother" })
    await uploadFixes(ctx.app, brother.headers, [
      { ...HOME, recordedAt: iso(-5 * 60 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
    ])
    await silentSinceLastFix(brother.user.id)
    await getDb().execute(
      sql`update user_presence set offline_notified_at = now() - interval '3 hours'
          where user_id = ${brother.user.id}::uuid`,
    )

    expect((await tick()).offlineFlagged).toBe(1)
    void teen
  })
})

describe("the record of who was told", () => {
  it("counts an offline alert still on its way when the phone gets back", async () => {
    const { parent, teen } = await family()
    await tick()
    await getDb().execute(
      sql`update notification_outbox set status = 'sending' where data->>'type' = 'device_offline'
          and user_id = ${parent.user.id}::uuid`,
    )

    await phoneBack(teen.headers)
    await tick()

    expect((await rows("device_online")).map((row) => row.user_id)).toEqual([parent.user.id])
  })

  it("is kept past the week while the phone is still out, so the all clear still finds it", async () => {
    const { teen } = await family()
    await tick()
    await drainOutbox(getDb(), new FakeDriver(), { now: minutesLater(1) })
    await getDb().execute(
      sql`update notification_outbox set created_at = now() - interval '8 days'`,
    )
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const told = (await rows("device_offline")).length

    // The teen's own ask to open Hearth goes with the week's other mail.
    // The record of who was told stays while the phone is out.
    expect(await pruneOutbox(getDb(), weekAgo)).toBe(1)
    expect(await rows("device_offline")).toHaveLength(told)
    await phoneBack(teen.headers)
    await tick()
    expect(await rows("device_online")).toHaveLength(2)
    // Once the phone is back the alert has done its job, and the same tick's
    // prune, which runs after the all clear, takes it.
    expect(await rows("device_offline")).toHaveLength(0)
  })
})
