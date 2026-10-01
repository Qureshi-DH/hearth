import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { getDb } from "../../db/client"
import { amendArrivalLine, replaceKey, threadBody } from "../../services/notification-groups"
import {
  createPushDriver,
  drainOutbox,
  enqueuePush,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import { getConfig, type AppConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import { detectTripsForUser } from "../../services/trips"
import {
  checkIn,
  clearOutbox,
  createCircle,
  createPlace,
  enablePush,
  joinCircle,
  registerUser,
  setSharing,
  silentSinceLastFix,
  startTestApp,
  uploadFixes,
  type Fix,
  type TestContext,
} from "../helpers"

/**
 * News about one person lands in one notification that grows, the way a
 * family follows somebody's afternoon, instead of a new buzz and a new card
 * for every fence they cross. The phone replaces the card it already shows,
 * so all of this is decided here, when the push goes out.
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

afterEach(() => {
  vi.unstubAllGlobals()
})

// A street in Bristol, a school 1.2 km north and a gym 2 km west of it.
const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4636, lon: -2.5952 }
const GYM = { lat: 51.457, lon: -2.6165 }

const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const metresPerDegreeLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()
const nextTick = () => new Date(Date.now() + 2000)
const hoursLater = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000)

interface QueuedRow {
  id: number
  user_id: string
  title: string
  body: string
  status: string
  last_error: string | null
  type: string | null
  group_key: string | null
  group_title: string | null
  group_line: string | null
}

async function queuedFor(userId: string): Promise<QueuedRow[]> {
  return (await getDb().execute(
    sql`select id, user_id, title, body, status, last_error, data->>'type' as type,
               group_key, group_title, group_line
        from notification_outbox where user_id = ${userId}::uuid order by id`,
  )) as unknown as QueuedRow[]
}

class FakeDriver implements PushDriver {
  readonly delivered: Array<{ token: string; message: PushMessage }> = []

  constructor(
    readonly provider: "expo" | "ntfy" = "expo",
    /** How long the provider takes to answer, which is when two sends can cross. */
    private readonly answerAfterMs = 0,
    /** Messages the provider turns away. */
    private readonly refuses: (message: PushMessage) => boolean = () => false,
  ) {}

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    if (this.refuses(message)) return { ok: false, error: "expo http 503" }
    this.delivered.push({ token: target.token, message })
    if (this.answerAfterMs) await new Promise((resolve) => setTimeout(resolve, this.answerAfterMs))
    return { ok: true }
  }
}

const lines = (message: PushMessage) => message.body.split("\n")

async function waitUntil(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out")
}

/** Two members with phones that take notifications, and a circle to share. */
async function family() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const teen = await registerUser(ctx.app, { displayName: "Teen" })
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, teen.headers, circle.invite.code)
  await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")
  await enablePush(teen.user.id, "ExponentPushToken[teen-phone]")
  await clearOutbox()
  return { parent, teen, circle }
}

/** One line of news about somebody, queued the way recordEvent queues it. */
function news(
  userId: string,
  group: { key: string; title: string; line: string },
  circleId: string | null = null,
): PushMessage {
  return {
    userId,
    circleId,
    title: `standalone ${group.line}`,
    body: `standalone body ${group.line}`,
    data: { type: "place_arrive" },
    group,
  }
}

describe("one notification per person", () => {
  it("adds a second event about someone to the notification already showing", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left Home" })])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at School" })])
    await drainOutbox(db, driver, { now: nextTick() })

    const [first, second] = driver.delivered.map((entry) => entry.message)
    expect(first).toMatchObject({ title: "Teen", body: "Left Home" })
    expect(second).toMatchObject({ title: "Teen", body: "Arrived at School\nLeft Home" })
    expect(first!.replaceKey).toBeTruthy()
    expect(second!.replaceKey).toBe(first!.replaceKey)
    expect(Buffer.byteLength(first!.replaceKey!)).toBeLessThanOrEqual(64)
  })

  it("starts a new notification after two quiet hours", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at School" })])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left School" })])
    await drainOutbox(db, driver, { now: hoursLater(2.5) })

    const [morning, afternoon] = driver.delivered.map((entry) => entry.message)
    expect(afternoon!.body).toBe("Left School")
    expect(afternoon!.replaceKey).not.toBe(morning!.replaceKey)
  })

  it("keeps different people, and somebody's messages, in notifications of their own", async () => {
    const { parent, teen } = await family()
    const aunt = await registerUser(ctx.app, { displayName: "Aunt" })
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [
      news(parent.user.id, { key: `outing:${teen.user.id}`, title: "Teen", line: "Left Home" }),
    ])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [
      news(parent.user.id, { key: `outing:${aunt.user.id}`, title: "Aunt", line: "Left Gym" }),
    ])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [
      news(parent.user.id, { key: `messages:${teen.user.id}`, title: "Teen", line: "Call me" }),
    ])
    await drainOutbox(db, driver, { now: nextTick() })

    const [teenOuting, auntOuting, teenMessage] = driver.delivered.map((entry) => entry.message)
    expect(auntOuting!.body).toBe("Left Gym")
    expect(teenMessage!.body).toBe("Call me")
    const keys = new Set([teenOuting!.replaceKey, auntOuting!.replaceKey, teenMessage!.replaceKey])
    expect(keys.size).toBe(3)
  })

  // After an outage the phone buzzes once with the whole afternoon, not once
  // for every line of it in a row.
  it("sends a backlog about one person as one notification, with the newest five lines", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    for (let i = 1; i <= 7; i += 1) {
      await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: `Stop ${i}` })])
    }
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered).toHaveLength(1)
    expect((await queuedFor(parent.user.id)).map((row) => row.status)).toEqual(
      new Array(7).fill("sent"),
    )
    expect(lines(driver.delivered[0]!.message)).toEqual([
      "Stop 7",
      "Stop 6",
      "Stop 5",
      "Stop 4",
      "Stop 3",
      "and 2 earlier",
    ])
  })

  it("still sends the same words twice when someone says them twice", async () => {
    const { parent, teen, circle } = await family()
    const key = `messages:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Call me" }, circle.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Call me" }, circle.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered.map((entry) => entry.message.body)).toEqual([
      "Call me",
      "Call me\nCall me",
    ])
  })

  it("keeps the lines in the order things happened when an earlier one was retried", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at Shop" })])
    const down = new FakeDriver("expo", 0, () => true)
    await drainOutbox(db, down, { now: nextTick() })
    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left Shop" })])

    const driver = new FakeDriver()
    await drainOutbox(db, driver, { now: hoursLater(0.1) })
    expect(driver.delivered.map((entry) => entry.message.body)).toEqual([
      "Left Shop\nArrived at Shop",
    ])
  })

  it("treats the same words from another circle as news again once enough time has passed", async () => {
    const { parent, teen, circle } = await family()
    const club = await createCircle(ctx.app, teen.headers, "Club")
    await joinCircle(ctx.app, parent.headers, club.invite.code)
    await clearOutbox()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Arrived at Home" }, circle.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Arrived at Home" }, club.id),
    ])
    await drainOutbox(db, driver, { now: new Date(Date.now() + 11 * 60_000) })

    expect(driver.delivered.at(-1)!.message.body).toBe("Arrived at Home\nArrived at Home")
  })

  it("does not let a second drain pick up someone whose notification is still going out", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: PushDriver = {
      provider: "expo",
      async send() {
        await held
        return { ok: true }
      },
    }

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left Home" })])
    const first = drainOutbox(db, slow, { now: nextTick() })
    await waitUntil(async () => (await queuedFor(parent.user.id))[0]?.status === "sending")

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at School" })])
    const second = await drainOutbox(db, new FakeDriver(), { now: nextTick() })
    expect(second.processed).toBe(0)

    release()
    await first
    const third = new FakeDriver()
    await drainOutbox(db, third, { now: nextTick() })
    expect(third.delivered.map((entry) => entry.message.body)).toEqual([
      "Arrived at School\nLeft Home",
    ])
  })

  // A replica that died mid-send leaves a row claimed for good, until the
  // sweep frees it. That must not hold every later line about the person.
  it("does not let a send abandoned long ago hold up the person's news", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left Home" })])
    await db.execute(sql`update notification_outbox
      set status = 'sending', next_attempt_at = now() - interval '5 minutes'`)

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at School" })])
    const driver = new FakeDriver()
    const summary = await drainOutbox(db, driver, { now: nextTick() })
    expect(summary.sent).toBe(1)
  })

  it("says when news it had to leave waiting is due, so the caller can go round again", async () => {
    const { parent, teen } = await family()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: PushDriver = {
      provider: "expo",
      async send() {
        await held
        return { ok: true }
      },
    }

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left Home" })])
    const first = drainOutbox(db, slow, { now: nextTick() })
    await waitUntil(async () => (await queuedFor(parent.user.id))[0]?.status === "sending")
    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at School" })])
    await drainOutbox(db, new FakeDriver(), { now: nextTick() })

    release()
    expect((await first).waiting).toBe(true)
  })

  it("compares a second circle's copy with the newest line of the card, not any line of it", async () => {
    const { parent, teen, circle } = await family()
    const club = await createCircle(ctx.app, teen.headers, "Club")
    await joinCircle(ctx.app, parent.headers, club.invite.code)
    await clearOutbox()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Left Home" }, circle.id),
      news(parent.user.id, { key, title: "Teen", line: "Arrived at School" }, circle.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })
    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Arrived at School" }, club.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered).toHaveLength(1)
  })

  it("opens what the card shows when tapped, not a copy it left out", async () => {
    const { parent, teen, circle } = await family()
    const club = await createCircle(ctx.app, teen.headers, "Club")
    await joinCircle(ctx.app, parent.headers, club.invite.code)
    await clearOutbox()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()
    const copy = (circleId: string, eventId: number): PushMessage => ({
      ...news(parent.user.id, { key, title: "Teen", line: "Arrived at Home" }, circleId),
      data: { type: "place_arrive", eventId },
    })

    await enqueuePush(db, [copy(circle.id, 101), copy(club.id, 102)])
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered.map((entry) => entry.message.data?.eventId)).toEqual([101])
  })

  it("sends each notification as it was written to a provider that cannot replace one", async () => {
    const { parent, teen } = await family()
    await getDb().execute(sql`update sessions set push_provider = 'ntfy'`)
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver("ntfy")

    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Left Home" })])
    await enqueuePush(db, [news(parent.user.id, { key, title: "Teen", line: "Arrived at School" })])
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered.map((entry) => entry.message.title)).toEqual([
      "standalone Left Home",
      "standalone Arrived at School",
    ])
    expect(driver.delivered.every((entry) => !entry.message.replaceKey)).toBe(true)
  })

  it("leaves out earlier lines from a circle the recipient has since left", async () => {
    const { parent, teen, circle } = await family()
    const club = await createCircle(ctx.app, teen.headers, "Club")
    await joinCircle(ctx.app, parent.headers, club.invite.code)
    await clearOutbox()
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const driver = new FakeDriver()

    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Arrived at Gym" }, club.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${club.id}/members/${parent.user.id}`,
      headers: teen.headers,
    })
    expect(left.statusCode).toBe(200)

    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Arrived at Home" }, circle.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered.at(-1)!.message.body).toBe("Arrived at Home")
  })
})

describe("the same arrival in two circles", () => {
  it("is sent once", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const family = await createCircle(ctx.app, parent.headers, "Family")
    const cousins = await createCircle(ctx.app, parent.headers, "Cousins")
    await joinCircle(ctx.app, teen.headers, family.invite.code)
    await joinCircle(ctx.app, teen.headers, cousins.invite.code)
    await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")

    await uploadFixes(ctx.app, teen.headers, [
      { ...SCHOOL, recordedAt: iso(-1800), accuracyMeters: 12 },
    ])
    await createPlace(ctx.app, parent.headers, family.id, { name: "Home", ...HOME })
    await createPlace(ctx.app, parent.headers, cousins.id, { name: "Home", ...HOME })
    await clearOutbox()

    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-480), accuracyMeters: 10 },
    ])
    expect(await queuedFor(parent.user.id)).toHaveLength(2)

    // A slow provider, so a second copy sent alongside the first would find
    // nothing delivered yet and go out too.
    const driver = new FakeDriver("expo", 200)
    await drainOutbox(getDb(), driver, { now: nextTick() })

    expect(driver.delivered.map((entry) => entry.message.body)).toEqual(["Arrived at Home"])
    const statuses = (await queuedFor(parent.user.id)).map((row) => row.status).sort()
    expect(statuses).toEqual(["sent", "skipped"])
  })
})

describe("a place somebody stopped sharing precisely", () => {
  it("drops out of the notification along with the feed", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const sports = await createCircle(ctx.app, parent.headers, "Sports")
    const family = await createCircle(ctx.app, parent.headers, "Family")
    await joinCircle(ctx.app, teen.headers, sports.invite.code)
    await joinCircle(ctx.app, teen.headers, family.invite.code)
    await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")

    await uploadFixes(ctx.app, teen.headers, [
      { ...SCHOOL, recordedAt: iso(-1800), accuracyMeters: 12 },
    ])
    await createPlace(ctx.app, parent.headers, sports.id, { name: "Gym", ...GYM })
    await createPlace(ctx.app, parent.headers, family.id, { name: "Home", ...HOME })
    await clearOutbox()

    const db = getDb()
    const driver = new FakeDriver()
    await uploadFixes(ctx.app, teen.headers, [
      { ...GYM, recordedAt: iso(-720), accuracyMeters: 10 },
    ])
    await drainOutbox(db, driver, { now: nextTick() })
    expect(driver.delivered.map((entry) => entry.message.body)).toEqual(["Arrived at Gym"])

    await setSharing(ctx.app, teen.headers, sports.id, "approximate")
    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-300), accuracyMeters: 10 },
    ])
    await drainOutbox(db, driver, { now: new Date(Date.now() + 3 * 60 * 1000) })

    expect(driver.delivered.at(-1)!.message.body).toBe("Arrived at Home")
  })
})

describe("a check-in somebody stopped sharing precisely", () => {
  it("drops out of the notification as its place does from the feed", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const sports = await createCircle(ctx.app, parent.headers, "Sports")
    const family = await createCircle(ctx.app, parent.headers, "Family")
    await joinCircle(ctx.app, teen.headers, sports.invite.code)
    await joinCircle(ctx.app, teen.headers, family.invite.code)
    await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")
    await createPlace(ctx.app, parent.headers, sports.id, { name: "Gym", ...GYM })
    await clearOutbox()

    const db = getDb()
    const driver = new FakeDriver()
    await checkIn(ctx.app, teen.headers, sports.id, GYM)
    await drainOutbox(db, driver, { now: nextTick() })
    expect(driver.delivered.map((entry) => entry.message.body)).toEqual(["Checked in at Gym."])

    await setSharing(ctx.app, teen.headers, sports.id, "approximate")
    const key = `outing:${teen.user.id}`
    await enqueuePush(db, [
      news(parent.user.id, { key, title: "Teen", line: "Arrived at Home" }, family.id),
    ])
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered.at(-1)!.message.body).toBe("Arrived at Home")
  })
})

describe("what each kind of news says when it is grouped", () => {
  it("files arrivals under the person who arrived", async () => {
    const { parent, teen, circle } = await family()
    await uploadFixes(ctx.app, teen.headers, [
      { ...SCHOOL, recordedAt: iso(-1800), accuracyMeters: 12 },
    ])
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await clearOutbox()

    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-480), accuracyMeters: 10 },
    ])

    const [row] = await queuedFor(parent.user.id)
    expect(row).toMatchObject({
      group_key: `outing:${teen.user.id}`,
      group_title: "Teen",
      group_line: "Arrived at Home",
      // What a provider that cannot replace a notification still shows.
      title: "Home",
      body: "Teen arrived at Home",
    })
  })

  it("files a check-in with the rest of the person's outing", async () => {
    const { parent, teen, circle } = await family()
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await clearOutbox()

    await checkIn(ctx.app, teen.headers, circle.id, HOME, "Made it back")

    const [row] = await queuedFor(parent.user.id)
    expect(row).toMatchObject({
      group_key: `outing:${teen.user.id}`,
      group_title: "Teen",
      group_line: 'Checked in at Home. "Made it back"',
    })
  })

  it("files quick messages and location requests by who sent them", async () => {
    const { parent, teen, circle } = await family()

    const message = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${parent.user.id}`,
      headers: teen.headers,
      payload: { body: "Call me when you can." },
    })
    expect(message.statusCode).toBeLessThan(300)
    const ask = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${parent.user.id}`,
      headers: teen.headers,
    })
    expect(ask.statusCode).toBeLessThan(300)

    const rows = (await queuedFor(parent.user.id)).filter((row) => row.group_key)
    expect(rows.map((row) => [row.group_key, row.group_title, row.group_line])).toEqual([
      [`messages:${teen.user.id}`, "Teen", "Call me when you can."],
      [`messages:${teen.user.id}`, "Teen", "Asked where you are"],
    ])
  })

  it("files a low battery under the person's phone", async () => {
    const { parent, teen, circle } = await family()
    const settings = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}`,
      headers: parent.headers,
      payload: { settings: { lowBatteryThreshold: 0.15 } },
    })
    expect(settings.statusCode).toBe(200)

    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-600), accuracyMeters: 14, batteryLevel: 0.22, isCharging: false },
      { ...HOME, recordedAt: iso(-300), accuracyMeters: 14, batteryLevel: 0.13, isCharging: false },
    ])

    const rows = (await queuedFor(parent.user.id)).filter((row) => row.type === "low_battery")
    expect(rows.map((row) => [row.group_key, row.group_title, row.group_line])).toEqual([
      [`phone:${teen.user.id}`, "Teen's phone", "Battery at 13%"],
    ])
  })

  it("files a phone that went quiet under the same phone", async () => {
    const { parent, teen } = await family()
    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 11, batteryLevel: 0.34 },
    ])
    await silentSinceLastFix(teen.user.id)
    await clearOutbox()

    await runJobs(getDb(), getConfig(), ctx.app.log)

    const rows = (await queuedFor(parent.user.id)).filter((row) => row.type === "device_offline")
    expect(rows.map((row) => [row.group_key, row.group_title, row.group_line])).toEqual([
      [`phone:${teen.user.id}`, "Teen's phone", "Has not reported in for a while"],
    ])
  })
})

/**
 * A steady drive north-east from Home, one fix every 30 seconds at 50 km/h.
 * Ten steps of 420 m make 4.2 km.
 */
function drive(startSecondsAgo: number): Fix[] {
  const step = 14 * 30
  const north = Math.cos(Math.PI / 4) * step
  const east = Math.sin(Math.PI / 4) * step
  return Array.from({ length: 11 }, (_, i) => ({
    lat: HOME.lat + (north * i) / M_PER_DEG_LAT,
    lon: HOME.lon + (east * i) / metresPerDegreeLon(HOME.lat),
    recordedAt: iso(-startSecondsAgo + i * 30),
    accuracyMeters: 8,
    speedMps: 14,
    batteryLevel: 0.7,
  }))
}

describe("a finished trip", () => {
  let configured: PushDriver | null

  beforeEach(() => {
    configured = getPushDriver()
  })

  afterEach(() => {
    setRuntime({ pushDriver: configured })
  })

  it("adds its distance to the arrival instead of buzzing again", async () => {
    const { parent, teen, circle } = await family()
    const route = drive(13 * 60)
    const end = route.at(-1)!

    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-40 * 60), accuracyMeters: 10 },
    ])
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Work",
      lat: end.lat,
      lon: end.lon,
    })
    await clearOutbox()

    const db = getDb()
    const driver = new FakeDriver()
    setRuntime({ pushDriver: driver })
    await uploadFixes(ctx.app, teen.headers, route)
    await drainOutbox(db, driver, { now: nextTick() })
    expect(driver.delivered.map((entry) => entry.message.body)).toEqual([
      "Arrived at Work\nLeft Home",
    ])

    expect(await detectTripsForUser(db, teen.user.id)).toBe(1)
    await drainOutbox(db, driver, { now: nextTick() })
    expect(driver.delivered).toHaveLength(1)
    expect((await queuedFor(parent.user.id)).map((row) => row.type)).not.toContain("trip_completed")

    await checkIn(ctx.app, teen.headers, circle.id, end)
    await drainOutbox(db, driver, { now: nextTick() })
    expect(lines(driver.delivered.at(-1)!.message)).toEqual([
      "Checked in at Work.",
      "Arrived at Work after 4.2 km",
      "Left Home",
    ])
  })

  it("still buzzes on its own where the provider cannot replace a notification", async () => {
    const { parent, teen, circle } = await family()
    const route = drive(13 * 60)
    const end = route.at(-1)!

    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-40 * 60), accuracyMeters: 10 },
    ])
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Work",
      lat: end.lat,
      lon: end.lon,
    })
    await clearOutbox()
    setRuntime({ pushDriver: new FakeDriver("ntfy") })

    const db = getDb()
    await uploadFixes(ctx.app, teen.headers, route)
    expect(await detectTripsForUser(db, teen.user.id)).toBe(1)

    const trips = (await queuedFor(parent.user.id)).filter((row) => row.type === "trip_completed")
    expect(trips.map((row) => row.body)).toEqual(["Teen travelled 4.2 km from Home to Work."])
  })

  it("does not buzz for a second circle that already heard the arrival through the first", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const family = await createCircle(ctx.app, parent.headers, "Family")
    const cousins = await createCircle(ctx.app, parent.headers, "Cousins")
    await joinCircle(ctx.app, teen.headers, family.invite.code)
    await joinCircle(ctx.app, teen.headers, cousins.invite.code)
    await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")
    const route = drive(13 * 60)
    const end = route.at(-1)!

    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-40 * 60), accuracyMeters: 10 },
    ])
    for (const circle of [family, cousins]) {
      await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
      await createPlace(ctx.app, parent.headers, circle.id, {
        name: "Work",
        lat: end.lat,
        lon: end.lon,
      })
    }
    await clearOutbox()

    const db = getDb()
    const driver = new FakeDriver()
    setRuntime({ pushDriver: driver })
    await uploadFixes(ctx.app, teen.headers, route)
    await drainOutbox(db, driver, { now: nextTick() })
    expect(await detectTripsForUser(db, teen.user.id)).toBe(1)
    await drainOutbox(db, driver, { now: nextTick() })

    expect(driver.delivered).toHaveLength(1)
    expect((await queuedFor(parent.user.id)).map((row) => row.type)).not.toContain("trip_completed")
  })

  it("is a line of its own when it ends somewhere unsaved", async () => {
    const { parent, teen, circle } = await family()
    await uploadFixes(ctx.app, teen.headers, [
      { ...HOME, recordedAt: iso(-40 * 60), accuracyMeters: 10 },
    ])
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await clearOutbox()

    const db = getDb()
    const driver = new FakeDriver()
    setRuntime({ pushDriver: driver })
    await uploadFixes(ctx.app, teen.headers, drive(13 * 60))
    await drainOutbox(db, driver, { now: nextTick() })
    expect(await detectTripsForUser(db, teen.user.id)).toBe(1)
    await drainOutbox(db, driver, { now: nextTick() })

    expect(lines(driver.delivered.at(-1)!.message)).toEqual([
      "Travelled 4.2 km from Home",
      "Left Home",
    ])
  })
})

describe("finishing an arrival's line", () => {
  it("picks the arrival the trip ended in, not an earlier one at the same place", async () => {
    const { parent, teen, circle } = await family()
    const place = await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    const key = `outing:${teen.user.id}`
    const db = getDb()
    const arrival = (line: string, minutesAgo: number): PushMessage => ({
      userId: parent.user.id,
      circleId: circle.id,
      title: "Home",
      body: `Teen ${line}`,
      data: {
        type: "place_arrive",
        placeId: place.id,
        occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      },
      group: { key, title: "Teen", line },
    })
    await clearOutbox()
    // A late upload: home at 8:05, out at 8:08, home again at 8:30.
    await enqueuePush(db, [arrival("Arrived at Home", 30), arrival("Arrived at Home", 5)])

    const found = await amendArrivalLine(db, {
      userIds: [parent.user.id],
      circleId: circle.id,
      groupKey: key,
      placeId: place.id,
      startedAt: new Date(Date.now() - 27 * 60_000),
      endedAt: new Date(Date.now() - 6 * 60_000),
      line: "Arrived at Home after 5.0 km",
    })

    expect([...found]).toEqual([parent.user.id])
    expect((await queuedFor(parent.user.id)).map((row) => row.group_line)).toEqual([
      "Arrived at Home",
      "Arrived at Home after 5.0 km",
    ])
  })
})

describe("an SOS", () => {
  it("is replaced by the notice that it was resolved", async () => {
    const { teen, circle } = await family()
    const db = getDb()
    const driver = new FakeDriver()

    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: teen.headers,
      payload: {},
    })
    expect(raised.statusCode).toBe(201)
    const alertId = (raised.json() as { id: string }).id
    await drainOutbox(db, driver, { now: nextTick() })

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${alertId}/resolve`,
      headers: teen.headers,
    })
    expect(resolved.statusCode).toBe(200)
    await drainOutbox(db, driver, { now: nextTick() })

    const toParent = driver.delivered
      .filter((entry) => entry.token === "ExponentPushToken[parent-phone]")
      .map((entry) => entry.message)
    expect(toParent.map((message) => message.title)).toEqual(["🚨 SOS from Teen", "SOS resolved"])
    expect(toParent[0]!.replaceKey).toBe(`sos:${alertId}`)
    expect(toParent[1]!.replaceKey).toBe(`sos:${alertId}`)
  })

  it("is not sent once resolved, so a late retry cannot cover the all clear", async () => {
    const { teen, circle } = await family()
    const db = getDb()

    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: teen.headers,
      payload: {},
    })
    const alertId = (raised.json() as { id: string }).id
    const down = new FakeDriver("expo", 0, () => true)
    await drainOutbox(db, down, { now: nextTick() })

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${alertId}/resolve`,
      headers: teen.headers,
    })
    expect(resolved.statusCode).toBe(200)

    const back = new FakeDriver()
    await drainOutbox(db, back, { now: hoursLater(1) })
    const toParent = back.delivered.filter(
      (entry) => entry.token === "ExponentPushToken[parent-phone]",
    )
    expect(toParent.map((entry) => entry.message.title)).toEqual(["SOS resolved"])
  })
})

describe("the Expo envelope", () => {
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

  const target: DeliveryTarget = {
    sessionId: "s",
    token: "ExponentPushToken[x]",
    provider: "expo",
    platform: "ios",
  }

  const grouped: PushMessage = {
    userId: "u",
    title: "Teen",
    body: "Arrived at School\nLeft Home",
    replaceKey: "outing:abc#12",
  }

  it("asks iOS to replace the notification by its collapse id", async () => {
    const driver = stubExpo()
    await driver.send(target, grouped)
    expect(sent[0]).toMatchObject({ collapseId: "outing:abc#12" })
  })

  // On Android a collapse id becomes an FCM collapse key, and FCM keeps only
  // four of those for a phone that is offline, which could cost it an SOS.
  it("asks Android to replace it by tag alone", async () => {
    const driver = stubExpo()
    await driver.send({ ...target, platform: "android" }, grouped)
    expect(sent[0]).toMatchObject({ tag: "outing:abc#12" })
    expect(sent[0]).not.toHaveProperty("collapseId")
  })

  it("leaves a notification without a key to stand on its own", async () => {
    const driver = stubExpo()
    await driver.send(target, { userId: "u", title: "Hearth", body: "Notifications are working." })
    expect(sent[0]).not.toHaveProperty("collapseId")
    expect(sent[0]).not.toHaveProperty("tag")
  })
})

describe("the key a card is replaced by", () => {
  it("stays inside what APNs takes, and apart for different threads", () => {
    const long = `outing:${"x".repeat(80)}`
    expect(Buffer.byteLength(replaceKey(long, 12))).toBeLessThanOrEqual(64)
    expect(replaceKey(long, 12)).not.toBe(replaceKey(long, 13))
    expect(replaceKey("outing:abc", 12)).toBe("outing:abc#12")
  })
})

describe("the body of a card", () => {
  it("cuts even the newest line once it is longer than any message can be", () => {
    const body = threadBody(["a".repeat(5000)])
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3000)
  })

  it("cuts older lines short and keeps the newest whole", () => {
    const message = "Please call me back when you get a moment. ".repeat(10).trim()
    const body = threadBody([message, message]).split("\n")
    expect(body[0]).toBe(message)
    expect(Array.from(body[1]!)).toHaveLength(100)
    expect(body[1]!.endsWith("…")).toBe(true)
  })

  it("stays inside what Expo accepts however long the lines are", () => {
    const long = "بیٹا گھر پہنچ کر فون کرنا 🙏 ".repeat(20).trim()
    const body = threadBody([long, long, long, long, long, long, long])
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(3000)
    expect(body.split("\n").at(-1)).toMatch(/^and \d+ earlier$/)
  })
})
