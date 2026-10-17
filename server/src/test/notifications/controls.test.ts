import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  drainOutbox,
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
 * What a person can choose to hear, per place, per person and at night.
 * The choices live on the server, so every phone they sign in on agrees, and
 * none of them reaches an SOS or a possible crash.
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

const HOME = { lat: 51.4545, lon: -2.5879 }
const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180
const northOf = (point: { lat: number; lon: number }, metres: number) => ({
  lat: point.lat + metres / M_PER_DEG_LAT,
  lon: point.lon,
})
const SCHOOL = northOf(HOME, 1200)
const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

class FakeDriver implements PushDriver {
  readonly provider = "expo" as const
  readonly delivered: Array<{ token: string; message: PushMessage }> = []
  async send(target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.delivered.push({ token: target.token, message })
    return { ok: true }
  }
}

type Headers = Record<string, string>

async function rowsFor(userId: string) {
  return (await getDb().execute(sql`
    select data->>'type' as type, body, status, last_error,
           (extract(epoch from next_attempt_at - now()) * 1000)::float8 as due_in_ms
    from notification_outbox where user_id = ${userId}::uuid order by id
  `)) as unknown as Array<{
    type: string
    body: string
    status: string
    last_error: string | null
    due_in_ms: number
  }>
}

async function settings(headers: Headers, patch: Record<string, unknown>) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: "/api/v1/me/notifications",
    headers,
    payload: patch,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Record<string, unknown>
}

async function circlePrefs(headers: Headers, circleId: string, patch: Record<string, unknown>) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/notifications`,
    headers,
    payload: patch,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Record<string, unknown>
}

/** A parent and an aunt who both hear about the kid, who starts at home. */
async function family() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const aunt = await registerUser(ctx.app, { displayName: "Aunt" })
  const kid = await registerUser(ctx.app, { displayName: "Kid" })
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, aunt.headers, circle.invite.code)
  await joinCircle(ctx.app, kid.headers, circle.invite.code)
  for (const person of [parent, aunt]) {
    await enablePush(person.user.id, `ExponentPushToken[${person.user.id}]`)
  }
  await uploadFixes(ctx.app, kid.headers, [{ ...HOME, recordedAt: iso(-1200), accuracyMeters: 8 }])
  const home = await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
  const school = await createPlace(ctx.app, parent.headers, circle.id, {
    name: "School",
    ...SCHOOL,
  })
  await clearOutbox()
  return { parent, aunt, kid, circle, home, school }
}

async function walkToSchoolAndBack(headers: Headers) {
  await uploadFixes(ctx.app, headers, [
    { ...northOf(HOME, 400), recordedAt: iso(-600), accuracyMeters: 8 },
    { ...northOf(HOME, 500), recordedAt: iso(-580), accuracyMeters: 8 },
  ])
  await uploadFixes(ctx.app, headers, [{ ...SCHOOL, recordedAt: iso(-400), accuracyMeters: 8 }])
  await uploadFixes(ctx.app, headers, [
    { ...northOf(SCHOOL, -400), recordedAt: iso(-200), accuracyMeters: 8 },
    { ...northOf(SCHOOL, -500), recordedAt: iso(-180), accuracyMeters: 8 },
  ])
}

const placeNews = (rows: Awaited<ReturnType<typeof rowsFor>>) =>
  rows.filter((row) => row.type.startsWith("place_")).map((row) => row.body)

/** "HH:MM" in UTC, minutes from now. */
const utcClock = (minutesFromNow: number) =>
  new Date(Date.now() + minutesFromNow * 60_000).toISOString().slice(11, 16)

describe("choosing what to hear about a place", () => {
  it("tells one parent only when the kid leaves school, and the other parent both", async () => {
    const { parent, aunt, kid, circle, school } = await family()
    const prefs = await circlePrefs(parent.headers, circle.id, { places: { [school.id]: "leave" } })
    expect(prefs).toMatchObject({ places: { [school.id]: "leave" } })

    await walkToSchoolAndBack(kid.headers)

    expect(placeNews(await rowsFor(parent.user.id))).toEqual(["Kid left Home", "Kid left School"])
    expect(placeNews(await rowsFor(aunt.user.id))).toEqual([
      "Kid left Home",
      "Kid arrived at School, 1.2 km from Home in 3 min",
      "Kid left School",
    ])
  })

  it("forgets the choice again when it is set back to both", async () => {
    const { parent, circle, school } = await family()
    await circlePrefs(parent.headers, circle.id, { places: { [school.id]: "none" } })
    const prefs = await circlePrefs(parent.headers, circle.id, { places: { [school.id]: "both" } })
    expect(prefs.places).toEqual({})
  })

  it("ignores a place that is not this circle's", async () => {
    const { parent, circle } = await family()
    const other = "00000000-0000-4000-8000-000000000000"
    const prefs = await circlePrefs(parent.headers, circle.id, { places: { [other]: "none" } })
    expect(prefs.places).toEqual({})
  })
})

describe("muting a person", () => {
  it("stops their comings and goings, and nothing else", async () => {
    const { parent, aunt, kid, circle } = await family()
    const saved = await settings(parent.headers, { mutedPeople: [kid.user.id] })
    expect(saved).toMatchObject({ mutedPeople: [kid.user.id] })

    await walkToSchoolAndBack(kid.headers)
    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: kid.headers,
      payload: { note: null },
    })
    expect(sos.statusCode).toBe(201)

    const parentRows = await rowsFor(parent.user.id)
    expect(placeNews(parentRows)).toEqual([])
    expect(parentRows.map((row) => row.type)).toContain("sos_started")
    expect(placeNews(await rowsFor(aunt.user.id))).toHaveLength(3)
  })

  it("is the same choice on every phone the person signs in on", async () => {
    const { parent, kid } = await family()
    await settings(parent.headers, { mutedPeople: [kid.user.id] })

    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: parent.email,
        password: "correct-horse-battery",
        device: { deviceId: "parent-tablet", deviceName: "Tablet", platform: "android" },
      },
    })
    expect(login.statusCode).toBe(200)
    const tablet = {
      authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}`,
    }
    const me = await ctx.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: tablet })
    expect(me.json()).toMatchObject({ notificationSettings: { mutedPeople: [kid.user.id] } })
  })
})

describe("quiet hours", () => {
  it("holds ordinary news until they end, and lets an SOS straight through", async () => {
    const { parent, kid, circle } = await family()
    await settings(parent.headers, {
      timeZone: "UTC",
      quietHours: { from: utcClock(-60), until: utcClock(60), then: "hold" },
    })

    await uploadFixes(ctx.app, kid.headers, [
      { ...northOf(HOME, 400), recordedAt: iso(-60), accuracyMeters: 8 },
      { ...northOf(HOME, 500), recordedAt: iso(-50), accuracyMeters: 8 },
    ])
    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: kid.headers,
      payload: { note: null },
    })
    expect(sos.statusCode).toBe(201)

    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: new Date(Date.now() + 2000) })
    const toParent = driver.delivered.filter((entry) => entry.token.includes(parent.user.id))
    expect(toParent.map((entry) => entry.message.data?.type)).toEqual(["sos_started"])

    const [held] = (await rowsFor(parent.user.id)).filter((row) => row.type === "place_leave")
    expect(held!.status).toBe("pending")
    expect(held!.due_in_ms).toBeGreaterThan(58 * 60_000)
    expect(held!.due_in_ms).toBeLessThanOrEqual(60 * 60_000)

    // The morning, when it goes, saying when it happened.
    await drainOutbox(getDb(), driver, { now: new Date(Date.now() + 61 * 60_000) })
    const last = driver.delivered.filter((entry) => entry.token.includes(parent.user.id)).at(-1)!
    expect(last.message.body).toMatch(/^Left Home at \d{1,2}:\d{2}$/)
  })

  it("holds the rest of the ordinary news too, such as somebody joining", async () => {
    const { parent, circle } = await family()
    await settings(parent.headers, {
      timeZone: "UTC",
      quietHours: { from: utcClock(-60), until: utcClock(60), then: "hold" },
    })

    await registerUser(ctx.app, { displayName: "Gran", inviteCode: circle.invite.code })
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: new Date(Date.now() + 2000) })

    expect(driver.delivered.filter((entry) => entry.token.includes(parent.user.id))).toEqual([])
    expect((await rowsFor(parent.user.id)).map((row) => [row.type, row.status])).toEqual([
      ["member_joined", "pending"],
    ])
  })

  it("can drop ordinary news instead", async () => {
    const { parent, kid } = await family()
    await settings(parent.headers, {
      timeZone: "UTC",
      quietHours: { from: utcClock(-60), until: utcClock(60), then: "drop" },
    })

    await uploadFixes(ctx.app, kid.headers, [
      { ...northOf(HOME, 400), recordedAt: iso(-60), accuracyMeters: 8 },
      { ...northOf(HOME, 500), recordedAt: iso(-50), accuracyMeters: 8 },
    ])
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: new Date(Date.now() + 2000) })

    expect(driver.delivered.filter((entry) => entry.token.includes(parent.user.id))).toEqual([])
    const [dropped] = await rowsFor(parent.user.id)
    expect(dropped).toMatchObject({ status: "skipped", last_error: "quiet hours" })
  })

  it("reads the hours on the phone's clock, not the server's", async () => {
    const { parent, kid } = await family()
    // Quiet hours that are now in UTC, read in a zone five hours ahead.
    await settings(parent.headers, {
      timeZone: "Asia/Karachi",
      quietHours: { from: utcClock(-60), until: utcClock(60), then: "drop" },
    })

    await uploadFixes(ctx.app, kid.headers, [
      { ...northOf(HOME, 400), recordedAt: iso(-60), accuracyMeters: 8 },
      { ...northOf(HOME, 500), recordedAt: iso(-50), accuracyMeters: 8 },
    ])
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: new Date(Date.now() + 2000) })

    expect(driver.delivered.filter((entry) => entry.token.includes(parent.user.id))).toHaveLength(1)
  })
})

describe("where the phone keeps its time", () => {
  it("is remembered from each launch's notification registration", async () => {
    await ctx.close()
    ctx = await startTestApp({ PUSH_PROVIDER: "expo" })
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/push/register",
      headers: parent.headers,
      payload: {
        provider: "expo",
        token: "ExponentPushToken[abc]",
        timeZone: "Europe/London",
        clock: "12h",
      },
    })
    expect(response.statusCode).toBe(200)
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: parent.headers,
    })
    expect(me.json()).toMatchObject({
      notificationSettings: { timeZone: "Europe/London", clock: "12h" },
    })
    await ctx.close()
    ctx = await startTestApp()
  })

  it("is offered by this server, so a newer app shows the controls", async () => {
    const response = await ctx.app.inject({ method: "GET", url: "/api/v1/server-info" })
    expect(response.json()).toMatchObject({ features: { notificationControls: true } })
  })
})

describe("pausing location sharing", () => {
  it("tells the family, for how long, unless they muted it", async () => {
    const { parent, aunt, kid, circle } = await family()
    await circlePrefs(aunt.headers, circle.id, { muted: ["sharing_paused"] })

    const paused = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: kid.headers,
      payload: { sharingState: "paused", pausedUntil: iso(3600) },
    })
    expect(paused.statusCode).toBe(200)
    const resumed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: kid.headers,
      payload: { sharingState: "precise" },
    })
    expect(resumed.statusCode).toBe(200)

    const parentRows = await rowsFor(parent.user.id)
    expect(parentRows.map((row) => [row.type, row.body])).toEqual([
      ["sharing_paused", "Kid paused location sharing for 1 hour"],
    ])
    expect(await rowsFor(aunt.user.id)).toEqual([])
  })
})
