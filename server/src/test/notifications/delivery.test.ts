import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  drainOutbox,
  requeueStuckSends,
  type DeliveryResult,
  type DeliveryTarget,
  type PushDriver,
  type PushMessage,
} from "../../services/push"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The delivery layer: feed rows, per-member mutes, recipients and the
 * notification outbox. The push driver is the only fake, because it is where
 * "the provider is down" and "that token is dead" come from.
 */

// A residential street and a school ~1.2 km away, both in Bristol.
const HOME = { lat: 51.4545, lon: -2.5879 }
const SCHOOL = { lat: 51.4636, lon: -2.5952 }

const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180
const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / METRES_PER_DEGREE_LAT,
  lon: point.lon,
})

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

const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

type Headers = Record<string, string>

async function createCircle(headers: Headers, name = "Family") {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function join(headers: Headers, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function createPlace(
  headers: Headers,
  circleId: string,
  place: { name: string; lat: number; lon: number; radiusMeters?: number },
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: {
      name: place.name,
      icon: "home",
      lat: place.lat,
      lon: place.lon,
      radiusMeters: place.radiusMeters ?? 150,
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; name: string }
}

async function uploadFixes(
  headers: Headers,
  points: Array<{
    lat: number
    lon: number
    recordedAt: string
    accuracyMeters?: number
    speedMps?: number
    batteryLevel?: number
    isCharging?: boolean
  }>,
) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number; placeEvents: number }
}

async function setCircleSettings(
  headers: Headers,
  circleId: string,
  settings: Record<string, unknown>,
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}`,
    headers,
    payload: { settings },
  })
  expect(response.statusCode).toBe(200)
}

async function setSharing(headers: Headers, circleId: string, sharingState: string) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload: { sharingState },
  })
  expect(response.statusCode).toBe(200)
}

async function setNotifications(
  headers: Headers,
  circleId: string,
  body: { muted?: string[]; mutedUntil?: string | null },
) {
  return ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/notifications`,
    headers,
    payload: body,
  })
}

async function checkIn(headers: Headers, circleId: string, at = HOME, note?: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/check-in`,
    headers,
    payload: { lat: at.lat, lon: at.lon, note: note ?? null },
  })
  expect(response.statusCode).toBe(201)
}

async function feedItems(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { items: unknown }).items as Array<{
    id: string
    type: string
    summary: string
    occurredAt: string
    payload: Record<string, unknown>
  }>
}

async function markFeedRead(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/events/read`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function unreadCount(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events/unread-count`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { unread: number }).unread
}

async function circleBadge(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/circles", headers })
  expect(response.statusCode).toBe(200)
  const rows = response.json() as Array<{ id: string; unreadEventCount: number }>
  return rows.find((row) => row.id === circleId)!.unreadEventCount
}

interface OutboxRowView {
  id: number
  user_id: string
  circle_id: string | null
  title: string
  body: string
  channel: string
  status: string
  attempts: number
  last_error: string | null
  type: string | null
}

async function outbox(): Promise<OutboxRowView[]> {
  return (await getDb().execute(
    sql`select id, user_id, circle_id, title, body, channel, status, attempts, last_error,
               data->>'type' as type
        from notification_outbox order by id`,
  )) as unknown as OutboxRowView[]
}

const queuedFor = (rows: OutboxRowView[], userId: string) =>
  rows.filter((row) => row.user_id === userId)

/**
 * Setting a scenario up queues "someone joined the circle" notifications. Those
 * went out days ago in the story every test below tells, so clear them and let
 * each test read the queue as the alert under test alone.
 */
async function clearQueue() {
  await getDb().execute(sql`delete from notification_outbox`)
}

/** A signed-in device that has accepted notifications. */
async function enablePush(userId: string, token: string, deviceId?: string) {
  await getDb().execute(
    deviceId
      ? sql`update sessions set push_provider = 'expo', push_token = ${token}
            where user_id = ${userId}::uuid and device_id = ${deviceId}`
      : sql`update sessions set push_provider = 'expo', push_token = ${token}
            where user_id = ${userId}::uuid`,
  )
}

async function pushTokensOf(userId: string): Promise<Array<string | null>> {
  const rows = (await getDb().execute(
    sql`select push_token from sessions where user_id = ${userId}::uuid order by created_at`,
  )) as unknown as Array<{ push_token: string | null }>
  return rows.map((row) => row.push_token)
}

async function signInDevice(email: string, deviceId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      email,
      password: "correct-horse-battery",
      device: { deviceId, deviceName: "Second Device", platform: "android" },
    },
  })
  expect(response.statusCode).toBe(200)
  return { authorization: `Bearer ${(response.json() as { accessToken: string }).accessToken}` }
}

/* ------------------------------------------------------------------ */
/* A push provider we can break on purpose                             */
/* ------------------------------------------------------------------ */

class FakeDriver implements PushDriver {
  readonly provider = "expo" as const
  /** Handed to the transport, whether or not the transport then accepted it. */
  readonly attempted: Array<{ token: string; message: PushMessage }> = []
  readonly delivered: Array<{ token: string; message: PushMessage }> = []

  constructor(
    private readonly behaviour: (
      target: DeliveryTarget,
      message: PushMessage,
    ) => Promise<DeliveryResult> | DeliveryResult = () => ({ ok: true }),
  ) {}

  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.attempted.push({ token: target.token, message })
    const result = await this.behaviour(target, message)
    if (result.ok) this.delivered.push({ token: target.token, message })
    return result
  }
}

/** Every phone in the family is asleep; the scheduler ticks hours later. */
const hoursLater = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000)

/**
 * The next scheduler tick, a couple of seconds after the event. Postgres
 * timestamps carry microseconds and a JS Date does not, so "now" from the
 * process clock can land a fraction before a row written in the same
 * millisecond and miss it.
 */
const nextTick = () => new Date(Date.now() + 2000)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/* ------------------------------------------------------------------ */
/* Shared scenario: a family with a Home place                         */
/* ------------------------------------------------------------------ */

/**
 * Parent, teen and aunt in one circle with Home fenced. The teen starts the
 * day out of the fence, so the fence is primed "outside" rather than guessing.
 */
async function household(options: { withAunt?: boolean; primeSecondsAgo?: number } = {}) {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const teen = await registerUser(ctx.app, { displayName: "Teen" })
  const circle = await createCircle(parent.headers)
  await join(teen.headers, circle.invite.code)

  const aunt = options.withAunt ? await registerUser(ctx.app, { displayName: "Aunt" }) : undefined
  if (aunt) await join(aunt.headers, circle.invite.code)

  await uploadFixes(teen.headers, [
    { ...SCHOOL, recordedAt: iso(-(options.primeSecondsAgo ?? 1800)), accuracyMeters: 12 },
  ])
  const place = await createPlace(parent.headers, circle.id, { name: "Home", ...HOME })
  await clearQueue()

  return { parent, teen, aunt, circle, place }
}

/** The teen walks in through the front door eight minutes ago. */
async function arriveHome(teenHeaders: Headers, secondsAgo = 480) {
  const result = await uploadFixes(teenHeaders, [
    { ...HOME, recordedAt: iso(-secondsAgo), accuracyMeters: 10 },
  ])
  expect(result.placeEvents).toBe(1)
}

/* ================================================================== */
/* Mutes                                                               */
/* ================================================================== */

describe("mutes", () => {
  it("queues an arrival for every other member when nobody has muted anything", async () => {
    const { parent, teen, aunt } = await household({ withAunt: true })

    await arriveHome(teen.headers)

    const rows = await outbox()
    expect(queuedFor(rows, parent.user.id)).toHaveLength(1)
    expect(queuedFor(rows, aunt!.user.id)).toHaveLength(1)
    expect(queuedFor(rows, teen.user.id)).toHaveLength(0)
    expect(rows[0]!.body).toContain("Teen arrived at Home")
  })

  it("silences only the muted type, and only for the member who muted it", async () => {
    const { parent, teen, aunt, circle } = await household({ withAunt: true })

    const muted = await setNotifications(parent.headers, circle.id, { muted: ["place_arrive"] })
    expect(muted.statusCode).toBe(200)

    // Home at 10 minutes ago, back out of the fence 4 minutes ago. Far enough
    // apart that the transient-visit filter keeps both crossings.
    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-600), accuracyMeters: 10 }])
    await uploadFixes(teen.headers, [{ ...SCHOOL, recordedAt: iso(-240), accuracyMeters: 10 }])

    const rows = await outbox()
    expect(queuedFor(rows, parent.user.id).map((row) => row.type)).toEqual(["place_leave"])
    expect(queuedFor(rows, aunt!.user.id).map((row) => row.type)).toEqual([
      "place_arrive",
      "place_leave",
    ])
  })

  it("honours a mute-all while it lasts and ignores one that has lapsed", async () => {
    const { parent, teen, aunt, circle } = await household({ withAunt: true })

    const eightHours = await setNotifications(parent.headers, circle.id, {
      mutedUntil: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    })
    expect(eightHours.statusCode).toBe(200)
    // The aunt's mute-all ran out half an hour ago.
    const lapsed = await setNotifications(aunt!.headers, circle.id, {
      mutedUntil: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    })
    expect(lapsed.statusCode).toBe(200)

    await arriveHome(teen.headers)

    const rows = await outbox()
    expect(queuedFor(rows, parent.user.id)).toHaveLength(0)
    expect(queuedFor(rows, aunt!.user.id)).toHaveLength(1)
  })

  it("keeps mutes to the circle they were set on", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const family = await createCircle(parent.headers, "Family")
    const grandparents = await createCircle(parent.headers, "Grandparents")
    await join(teen.headers, family.invite.code)
    await join(teen.headers, grandparents.invite.code)

    await uploadFixes(teen.headers, [{ ...SCHOOL, recordedAt: iso(-1800), accuracyMeters: 12 }])
    await createPlace(parent.headers, family.id, { name: "Home", ...HOME })
    await createPlace(parent.headers, grandparents.id, { name: "Home", ...HOME })
    await clearQueue()

    await setNotifications(parent.headers, family.id, { muted: ["place_arrive"] })

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-480), accuracyMeters: 10 }])

    const rows = await outbox()
    expect(rows.map((row) => row.circle_id)).toEqual([grandparents.id])
  })

  it("still delivers an SOS to someone who muted the circle", async () => {
    const { parent, teen, circle } = await household()
    await setNotifications(parent.headers, circle.id, {
      mutedUntil: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    })

    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: teen.headers,
      payload: { note: "I need help" },
    })
    expect(sos.statusCode).toBe(201)

    const rows = queuedFor(await outbox(), parent.user.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.channel).toBe("sos")
  })

  it("queues a possible incident to the rest of the circle", async () => {
    const { parent, teen, circle } = await household()
    await setCircleSettings(parent.headers, circle.id, { incidentDetection: true })

    await hardStopAfterMotorwaySpeed(teen.headers)

    const rows = queuedFor(await outbox(), parent.user.id)
    expect(rows.map((row) => row.type)).toContain("possible_incident")
    expect(rows.find((row) => row.type === "possible_incident")!.channel).toBe("sos")
  })

  it("does not let a mute-all swallow an alert the API refuses to let you mute", async () => {
    const { parent, teen, circle } = await household()
    await setCircleSettings(parent.headers, circle.id, { incidentDetection: true })

    // The product decides which alerts a member may silence, and a possible
    // incident is deliberately not one of them.
    const refused = await setNotifications(parent.headers, circle.id, {
      muted: ["possible_incident"],
    })
    expect(refused.statusCode).toBe(400)

    // So the parent uses the only mute the app offers: quiet the circle overnight.
    await setNotifications(parent.headers, circle.id, {
      mutedUntil: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    })

    await hardStopAfterMotorwaySpeed(teen.headers)
    // The same quiet hours, an alert the parent is allowed to silence.
    await checkIn(teen.headers, circle.id, SCHOOL, "at practice")

    const types = (await feedItems(parent.headers, circle.id)).map((item) => item.type)
    expect(types).toContain("possible_incident")
    expect(types).toContain("check_in")

    const rows = queuedFor(await outbox(), parent.user.id)
    expect(rows.map((row) => row.type)).toContain("possible_incident")
    expect(rows.map((row) => row.type)).not.toContain("check_in")
  })
})

/** 90 km/h on the ring road, then stopped and motionless for four minutes. */
async function hardStopAfterMotorwaySpeed(headers: Headers) {
  await uploadFixes(headers, [
    { ...northOf(HOME, 0), recordedAt: iso(-330), accuracyMeters: 8, speedMps: 25 },
    { ...northOf(HOME, 750), recordedAt: iso(-300), accuracyMeters: 8, speedMps: 24 },
    { ...northOf(HOME, 1000), recordedAt: iso(-270), accuracyMeters: 8, speedMps: 0 },
    { ...northOf(HOME, 1000), recordedAt: iso(-120), accuracyMeters: 8, speedMps: 0 },
    { ...northOf(HOME, 1000), recordedAt: iso(-30), accuracyMeters: 8, speedMps: 0 },
  ])
}

/* ================================================================== */
/* Who gets told                                                       */
/* ================================================================== */

describe("recipients", () => {
  it("never pushes your own arrival back at you", async () => {
    const { teen } = await household()
    await arriveHome(teen.headers)
    expect(queuedFor(await outbox(), teen.user.id)).toHaveLength(0)
  })

  it("never pushes your own check-in back at you", async () => {
    const { parent, teen, circle } = await household()
    await checkIn(parent.headers, circle.id, HOME, "home safe")

    const rows = await outbox()
    expect(queuedFor(rows, parent.user.id)).toHaveLength(0)
    expect(queuedFor(rows, teen.user.id)).toHaveLength(1)
  })

  it("aims a nudge at one person only", async () => {
    const { parent, teen, aunt, circle } = await household({ withAunt: true })

    const nudge = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/nudge/${teen.user.id}`,
      headers: parent.headers,
      payload: { quickKey: "where_are_you" },
    })
    expect(nudge.statusCode).toBe(200)

    const rows = await outbox()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.user_id).toBe(teen.user.id)
    expect(queuedFor(rows, aunt!.user.id)).toHaveLength(0)
    expect(queuedFor(rows, parent.user.id)).toHaveLength(0)
  })

  // KNOWN LIMITATION. The badge counts what the feed shows, and the feed shows
  // your own actions, so your own check-in counts toward it. Excluding them
  // breaks the stronger invariant that the badge never exceeds the feed, which
  // sharing/alerts-by-sharing-state.test.ts pins. Worth revisiting with a feed that hides
  // your own rows.
  it.fails("does not badge your own check-in as unread for you", async () => {
    const { parent, teen, circle } = await household()
    await markFeedRead(parent.headers, circle.id)
    await markFeedRead(teen.headers, circle.id)

    await checkIn(parent.headers, circle.id, HOME, "home safe")

    expect(await unreadCount(teen.headers, circle.id)).toBe(1)
    expect(await unreadCount(parent.headers, circle.id)).toBe(0)
  })
})

/* ================================================================== */
/* The outbox                                                          */
/* ================================================================== */

describe("outbox delivery", () => {
  it("retries a provider outage and delivers exactly once when it recovers", async () => {
    const { parent, teen, circle } = await household()
    await enablePush(teen.user.id, "ExponentPushToken[teen-phone]")
    await checkIn(parent.headers, circle.id)

    const db = getDb()
    const down = new FakeDriver(() => ({ ok: false, error: "expo http 503: service unavailable" }))
    const first = await drainOutbox(db, down, { now: nextTick() })
    expect(first).toMatchObject({ processed: 1, sent: 0, failed: 1 })

    let [row] = await outbox()
    expect(row!.status).toBe("pending")
    expect(row!.attempts).toBe(1)

    // The scheduler ticks again straight away. The backoff has not elapsed, so
    // nothing may be claimed.
    const tooSoon = new FakeDriver()
    expect(await drainOutbox(db, tooSoon, { now: nextTick() })).toMatchObject({ processed: 0 })
    expect(tooSoon.delivered).toHaveLength(0)

    const back = new FakeDriver()
    const second = await drainOutbox(db, back, { now: hoursLater(1) })
    expect(second).toMatchObject({ processed: 1, sent: 1, failed: 0 })
    expect(back.delivered).toHaveLength(1)
    expect(back.delivered[0]!.token).toBe("ExponentPushToken[teen-phone]")
    expect(back.delivered[0]!.message.body).toContain("checked in")
    ;[row] = await outbox()
    expect(row!.status).toBe("sent")

    // And nothing is left to send.
    const after = new FakeDriver()
    await drainOutbox(db, after, { now: hoursLater(2) })
    expect(after.delivered).toHaveLength(0)
  })

  it("gives up after six attempts instead of retrying a dead provider forever", async () => {
    const { parent, teen, circle } = await household()
    await enablePush(teen.user.id, "ExponentPushToken[teen-phone]")
    await checkIn(parent.headers, circle.id)

    const db = getDb()
    const down = new FakeDriver(() => ({ ok: false, error: "expo http 500" }))
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await drainOutbox(db, down, { now: hoursLater(7 * attempt) })
    }

    const [row] = await outbox()
    expect(row!.attempts).toBe(6)
    expect(row!.status).toBe("failed")

    const later = new FakeDriver()
    await drainOutbox(db, later, { now: hoursLater(100) })
    expect(later.delivered).toHaveLength(0)
  })

  it("clears a token the provider has disowned", async () => {
    const { parent, teen, circle } = await household()
    await enablePush(teen.user.id, "ExponentPushToken[reinstalled]")
    await checkIn(parent.headers, circle.id)

    const db = getDb()
    const dead = new FakeDriver(() => ({
      ok: false,
      invalidToken: true,
      error: "expo error: DeviceNotRegistered",
    }))
    await drainOutbox(db, dead, { now: nextTick() })
    expect(await pushTokensOf(teen.user.id)).toEqual([null])

    const next = new FakeDriver()
    const summary = await drainOutbox(db, next, { now: hoursLater(1) })
    expect(summary).toMatchObject({ skipped: 1, sent: 0 })
    expect(next.delivered).toHaveLength(0)
    const [row] = await outbox()
    expect(row!.status).toBe("skipped")
    expect(row!.last_error).toBe("no registered device")
  })

  it("skips a member who has never turned notifications on", async () => {
    const { parent, circle } = await household()
    await checkIn(parent.headers, circle.id)

    const driver = new FakeDriver()
    const summary = await drainOutbox(getDb(), driver, { now: nextTick() })
    expect(summary).toMatchObject({ processed: 1, skipped: 1, sent: 0 })
    expect(driver.delivered).toHaveLength(0)
  })

  it("delivers to the live phone when an old one's token is dead", async () => {
    const { parent, teen, circle } = await household()
    await signInDevice(teen.email, "old-phone")
    await enablePush(teen.user.id, "ExponentPushToken[old]", "old-phone")
    await getDb().execute(
      sql`update sessions set push_provider = 'expo', push_token = 'ExponentPushToken[new]'
          where user_id = ${teen.user.id}::uuid and device_id <> 'old-phone'`,
    )
    expect((await pushTokensOf(teen.user.id)).sort()).toEqual([
      "ExponentPushToken[new]",
      "ExponentPushToken[old]",
    ])

    await checkIn(parent.headers, circle.id)

    const driver = new FakeDriver((target) =>
      target.token === "ExponentPushToken[old]"
        ? { ok: false, invalidToken: true, error: "expo error: DeviceNotRegistered" }
        : { ok: true },
    )
    const summary = await drainOutbox(getDb(), driver, { now: nextTick() })
    expect(summary).toMatchObject({ sent: 1, failed: 0 })
    expect(driver.delivered.map((entry) => entry.token)).toEqual(["ExponentPushToken[new]"])
    expect((await pushTokensOf(teen.user.id)).filter(Boolean)).toEqual(["ExponentPushToken[new]"])
  })

  it("does not send the same alert twice when a flush races the scheduler", async () => {
    const { parent, teen, circle } = await household()
    await enablePush(teen.user.id, "ExponentPushToken[teen-phone]")
    await checkIn(parent.headers, circle.id)

    const db = getDb()

    // The provider was misconfigured for hours, so this row has been retrying
    // and its next attempt fell due long ago. That is the state an operator
    // reaches for the "flush now" button in.
    await db.execute(
      sql`update notification_outbox
          set attempts = 4, status = 'pending', next_attempt_at = now() - interval '90 minutes'`,
    )

    const gate = deferred<void>()
    const slow = new FakeDriver(async () => {
      await gate.promise
      return { ok: true }
    })

    // The admin hits "flush now". It claims the row and is still mid-HTTP.
    const flush = drainOutbox(db, slow, { batchSize: 200 })
    await waitFor(() => slow.attempted.length === 1, "the flush to reach the transport")
    const claimed = (await db.execute(
      sql`select status from notification_outbox`,
    )) as unknown as Array<{ status: string }>
    expect(claimed[0]!.status).toBe("sending")

    // A minute later the scheduler ticks: requeue anything stuck, then drain.
    const requeued = await requeueStuckSends(db, new Date(Date.now() - 10 * 60 * 1000))
    const scheduled = new FakeDriver()
    await drainOutbox(db, scheduled, { batchSize: 100, now: nextTick() })

    gate.resolve()
    await flush

    expect({
      requeuedWhileInFlight: requeued,
      secondDelivery: scheduled.delivered.length,
      totalDeliveries: slow.delivered.length + scheduled.delivered.length,
    }).toEqual({ requeuedWhileInFlight: 0, secondDelivery: 0, totalDeliveries: 1 })
  })

  it("still rescues a send the replica holding it died on", async () => {
    const { parent, teen, circle } = await household()
    await enablePush(teen.user.id, "ExponentPushToken[teen-phone]")
    await checkIn(parent.headers, circle.id)

    // The replica that claimed this row twenty minutes ago never came back, so
    // nobody is waiting on the provider for it any more.
    await getDb().execute(
      sql`update notification_outbox
          set status = 'sending', next_attempt_at = now() - interval '20 minutes'`,
    )

    const db = getDb()
    expect(await requeueStuckSends(db, new Date(Date.now() - 10 * 60 * 1000))).toBe(1)

    const driver = new FakeDriver()
    expect(await drainOutbox(db, driver, { now: nextTick() })).toMatchObject({
      processed: 1,
      sent: 1,
    })
    expect(driver.delivered.map((entry) => entry.token)).toEqual(["ExponentPushToken[teen-phone]"])
  })

  it("delivers a notification that belongs to no circle at all", async () => {
    const { teen } = await household()
    await enablePush(teen.user.id, "ExponentPushToken[teen-phone]")

    const test = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/push/test",
      headers: teen.headers,
    })
    expect(test.statusCode).toBe(200)

    const driver = new FakeDriver()
    expect(await drainOutbox(getDb(), driver, { now: nextTick() })).toMatchObject({
      processed: 1,
      sent: 1,
      skipped: 0,
    })
    expect(driver.delivered.map((entry) => entry.message.title)).toEqual(["Hearth"])
  })

  it("skips a token left behind by a provider the server no longer uses", async () => {
    const { parent, teen, circle } = await household()
    // The household moved from Expo to self-hosted ntfy. The teen's phone has
    // not re-registered yet, so its stored token is for the old transport.
    await getDb().execute(
      sql`update sessions set push_provider = 'ntfy', push_token = 'hearth-abc123'
          where user_id = ${teen.user.id}::uuid`,
    )
    await checkIn(parent.headers, circle.id)

    const expo = new FakeDriver()
    const summary = await drainOutbox(getDb(), expo, { now: nextTick() })
    expect(summary).toMatchObject({ processed: 1, sent: 0, skipped: 1 })
    expect(expo.attempted).toHaveLength(0)
  })

  it("queues one arrival when both of a member's phones upload the same fix at once", async () => {
    const { parent, teen } = await household()
    const second = await signInDevice(teen.email, "teen-tablet")

    // The same walk home, flushed by two signed-in devices in the same moment.
    const batch = [{ ...HOME, recordedAt: iso(-480), accuracyMeters: 10 }]
    const [a, b] = await Promise.all([
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/locations/batch",
        headers: teen.headers,
        payload: { points: batch },
      }),
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/locations/batch",
        headers: second,
        payload: { points: batch },
      }),
    ])
    expect(a.statusCode).toBe(200)
    expect(b.statusCode).toBe(200)

    expect(queuedFor(await outbox(), parent.user.id).map((row) => row.type)).toEqual([
      "place_arrive",
    ])
  })

  it("does not queue a second arrival when the phone retries the same batch", async () => {
    const { parent, teen, circle } = await household()

    const batch = [{ ...HOME, recordedAt: iso(-480), accuracyMeters: 10 }]
    const first = await uploadFixes(teen.headers, batch)
    expect(first.placeEvents).toBe(1)
    // The upload timed out on the phone even though the server took it, so the
    // whole batch goes up again.
    const retry = await uploadFixes(teen.headers, batch)
    expect(retry.placeEvents).toBe(0)

    expect(queuedFor(await outbox(), parent.user.id)).toHaveLength(1)
    expect(
      (await feedItems(parent.headers, circle.id)).filter((item) => item.type === "place_arrive"),
    ).toHaveLength(1)
  })
})

/* ================================================================== */
/* Membership at delivery time                                         */
/* ================================================================== */

describe("membership", () => {
  it("does not queue anything for someone who has already left", async () => {
    const { parent, teen, aunt, circle } = await household({ withAunt: true })

    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${aunt!.user.id}`,
      headers: aunt!.headers,
    })
    expect(left.statusCode).toBe(200)

    await arriveHome(teen.headers)

    const rows = await outbox()
    expect(queuedFor(rows, aunt!.user.id)).toHaveLength(0)
    expect(queuedFor(rows, parent.user.id)).toHaveLength(1)
  })

  it("does not deliver a queued alert to somebody who left before the queue drained", async () => {
    const { parent, teen, aunt, circle } = await household({ withAunt: true })
    await enablePush(aunt!.user.id, "ExponentPushToken[aunt-phone]")
    await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")

    // The push provider is down, so the evening's alerts pile up.
    await arriveHome(teen.headers)
    const db = getDb()
    const down = new FakeDriver(() => ({ ok: false, error: "expo http 503" }))
    await drainOutbox(db, down, { now: nextTick() })

    // The aunt is removed from the circle while the queue is still backed up.
    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${aunt!.user.id}`,
      headers: parent.headers,
    })
    expect(removed.statusCode).toBe(200)

    // The provider recovers and the backlog goes out.
    const back = new FakeDriver()
    await drainOutbox(db, back, { now: hoursLater(3) })

    const toAunt = back.delivered.filter((entry) => entry.token === "ExponentPushToken[aunt-phone]")
    expect(toAunt.map((entry) => entry.message.body)).toEqual([])

    // The parent is still in the circle, so the same backlog still reaches her.
    const toParent = back.delivered.filter(
      (entry) => entry.token === "ExponentPushToken[parent-phone]",
    )
    expect(toParent.map((entry) => entry.message.body)).toEqual(["Teen arrived at Home"])
  })
})

/* ================================================================== */
/* Backlog replay                                                      */
/* ================================================================== */

describe("backlog replay", () => {
  it("records a replayed arrival at the time it happened and pushes nothing", async () => {
    // The fence was primed yesterday, before the fixes the phone is holding.
    const { parent, teen, circle } = await household({ primeSecondsAgo: 26 * 3600 })

    // The phone lost signal at breakfast and reconnects in the evening.
    await uploadFixes(teen.headers, [
      { ...northOf(HOME, 900), recordedAt: iso(-9 * 3600), accuracyMeters: 12 },
      { ...HOME, recordedAt: iso(-8 * 3600), accuracyMeters: 10 },
    ])

    const arrive = (await feedItems(parent.headers, circle.id)).find(
      (item) => item.type === "place_arrive",
    )!
    expect(arrive).toBeDefined()
    expect(arrive.summary).toContain("Teen arrived at Home")
    const ageHours = (Date.now() - Date.parse(arrive.occurredAt)) / 3_600_000
    expect(ageHours).toBeGreaterThan(7.5)

    expect((await outbox()).map((row) => row.type)).not.toContain("place_arrive")
  })

  it("badges a replayed arrival as unread for a parent who read the feed meanwhile", async () => {
    const { parent, teen, circle } = await household({ primeSecondsAgo: 26 * 3600 })

    // The parent checked the feed at lunchtime and there was nothing new.
    await markFeedRead(parent.headers, circle.id)
    expect(await unreadCount(parent.headers, circle.id)).toBe(0)

    // In the evening the teen's phone drains a day of queued fixes, including
    // the arrival home at breakfast time.
    await uploadFixes(teen.headers, [
      { ...northOf(HOME, 900), recordedAt: iso(-9 * 3600), accuracyMeters: 12 },
      { ...HOME, recordedAt: iso(-8 * 3600), accuracyMeters: 10 },
    ])

    const items = await feedItems(parent.headers, circle.id)
    expect(items.some((item) => item.type === "place_arrive")).toBe(true)

    expect({
      unread: await unreadCount(parent.headers, circle.id),
      badge: await circleBadge(parent.headers, circle.id),
    }).toEqual({ unread: 1, badge: 1 })
  })
})

/* ================================================================== */
/* Place names and sharing state                                       */
/* ================================================================== */

describe("place names and sharing state", () => {
  it("names the place to the circle shared precisely with and to no other", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const flatmate = await registerUser(ctx.app, { displayName: "Flatmate" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })

    const family = await createCircle(parent.headers, "Family")
    const flatshare = await createCircle(flatmate.headers, "Flatshare")
    await join(teen.headers, family.invite.code)
    await join(teen.headers, flatshare.invite.code)

    await uploadFixes(teen.headers, [{ ...SCHOOL, recordedAt: iso(-1800), accuracyMeters: 12 }])
    await createPlace(parent.headers, family.id, { name: "Home", ...HOME })
    await createPlace(flatmate.headers, flatshare.id, { name: "Dr Shah's surgery", ...HOME })

    // The teen shares precisely with family, coarsely with the flatshare.
    await setSharing(teen.headers, flatshare.id, "approximate")
    await clearQueue()

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-480), accuracyMeters: 10 }])

    const familyFeed = await feedItems(parent.headers, family.id)
    expect(
      familyFeed.some((item) => item.type === "place_arrive" && item.summary.includes("Home")),
    ).toBe(true)

    const flatFeed = await feedItems(flatmate.headers, flatshare.id)
    expect(flatFeed.map((item) => item.type)).not.toContain("place_arrive")
    // "Added the place" is the flatmate's own doing. What must not appear is
    // the surgery being named because the teen turned up at it.
    expect(
      flatFeed.some(
        (item) => item.type !== "place_created" && item.summary.includes("Dr Shah's surgery"),
      ),
    ).toBe(false)

    const rows = await outbox()
    expect(queuedFor(rows, flatmate.user.id)).toHaveLength(0)
    expect(queuedFor(rows, parent.user.id).map((row) => row.body)).toEqual(["Teen arrived at Home"])
  })

  it("tells a paused circle nothing about a named place", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await join(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [{ ...SCHOOL, recordedAt: iso(-1800), accuracyMeters: 12 }])
    await createPlace(parent.headers, circle.id, { name: "Clinic", ...HOME })
    await setSharing(teen.headers, circle.id, "paused")
    await clearQueue()

    await uploadFixes(teen.headers, [{ ...HOME, recordedAt: iso(-480), accuracyMeters: 10 }])

    const feed = await feedItems(parent.headers, circle.id)
    expect(feed.map((item) => item.type)).not.toContain("place_arrive")
    expect(
      feed.some((item) => item.type !== "place_created" && item.summary.includes("Clinic")),
    ).toBe(false)
    expect(await outbox()).toHaveLength(0)
  })
})
