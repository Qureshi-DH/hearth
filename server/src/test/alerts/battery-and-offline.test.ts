import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Low battery, device offline and device online alerts, through the HTTP API
 * and the scheduler against a real Postgres.
 */

// A quiet residential street in Bristol, the same one api.test.ts uses.
const HOME = { lat: 51.4545, lon: -2.5879 }

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function createCircle(headers: Record<string, string>, name = "Family") {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function joinCircle(headers: Record<string, string>, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number
  batteryLevel?: number
  isCharging?: boolean
}

async function uploadFixes(headers: Record<string, string>, points: Fix[]) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
  return response.json() as { accepted: number; rejected: number; placeEvents: number }
}

/** A second signed-in device for an account that already exists. */
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
  const body = response.json() as { accessToken: string }
  return { authorization: `Bearer ${body.accessToken}` }
}

async function setCircleSettings(
  headers: Record<string, string>,
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

async function setSharing(
  headers: Record<string, string>,
  circleId: string,
  payload: { sharingState: "precise" | "approximate" | "paused"; pausedUntil?: string | null },
) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload,
  })
  expect(response.statusCode).toBe(200)
}

async function feedTypes(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return ((response.json() as { items: unknown }).items as Array<{ type: string }>).map(
    (item) => item.type,
  )
}

async function feedItems(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { items: unknown }).items as Array<{
    type: string
    summary: string
    occurredAt: string
    payload: Record<string, unknown>
  }>
}

async function tick() {
  return runJobs(getDb(), getConfig(), ctx.app.log)
}

async function eventCount(type: string) {
  const rows = (await getDb().execute(
    sql`select count(*)::int as n from events where type = ${type}`,
  )) as unknown as Array<{ n: number }>
  return rows[0]!.n
}

async function presenceRow(userId: string) {
  const rows = (await getDb().execute(
    sql`select battery_level, low_battery_notified_at, low_battery_notified_level,
               offline_notified_at, recorded_at
        from user_presence where user_id = ${userId}::uuid`,
  )) as unknown as Array<{
    battery_level: number | null
    low_battery_notified_at: string | null
    low_battery_notified_level: number | null
    offline_notified_at: string | null
    recorded_at: string | null
  }>
  return rows[0] ?? null
}

async function outboxTypes() {
  const rows = (await getDb().execute(
    sql`select data->>'type' as type from notification_outbox`,
  )) as unknown as Array<{ type: string }>
  return rows.map((row) => row.type)
}

// ---------------------------------------------------------------------------
// Low battery
// ---------------------------------------------------------------------------

describe("low battery", () => {
  it("announces the drop past the default 15 percent threshold once", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // A morning of ordinary readings. Nothing here is low.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-600), accuracyMeters: 12, batteryLevel: 0.42, isCharging: false },
      { ...HOME, recordedAt: iso(-540), accuracyMeters: 12, batteryLevel: 0.38, isCharging: false },
    ])
    expect(await feedTypes(user.headers, circle.id)).not.toContain("low_battery")

    // Now it crosses.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-120), accuracyMeters: 12, batteryLevel: 0.14, isCharging: false },
    ])

    const low = (await feedItems(user.headers, circle.id)).filter(
      (item) => item.type === "low_battery",
    )
    expect(low).toHaveLength(1)
    expect(low[0]!.payload.batteryLevel).toBeCloseTo(0.14, 5)
    expect(low[0]!.summary).toBe("Battery at 14%")
  })

  it("does not repeat the alert as the same drain continues below the threshold", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // A phone reporting every couple of minutes as it drains from 14% to 9%.
    for (const [offset, level] of [
      [-480, 0.14],
      [-360, 0.13],
      [-240, 0.11],
      [-120, 0.1],
      [-60, 0.09],
    ] as const) {
      await uploadFixes(user.headers, [
        {
          ...HOME,
          recordedAt: iso(offset),
          accuracyMeters: 12,
          batteryLevel: level,
          isCharging: false,
        },
      ])
    }

    const low = (await feedTypes(user.headers, circle.id)).filter((type) => type === "low_battery")
    expect(low).toHaveLength(1)
  })

  it("does not alert twice when the phone retries the same batch", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    const batch: Fix[] = [
      { ...HOME, recordedAt: iso(-180), accuracyMeters: 12, batteryLevel: 0.12, isCharging: false },
      { ...HOME, recordedAt: iso(-120), accuracyMeters: 12, batteryLevel: 0.12, isCharging: false },
    ]
    await uploadFixes(user.headers, batch)
    // The upload timed out on the phone's side, so it sends the batch again.
    await uploadFixes(user.headers, batch)

    const low = (await feedTypes(user.headers, circle.id)).filter((type) => type === "low_battery")
    expect(low).toHaveLength(1)
  })

  it("tells a circle with a 5 percent threshold when the drain reaches it", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const grandparents = await createCircle(user.headers, "Grandparents")
    await setCircleSettings(user.headers, family.id, { lowBatteryThreshold: 0.15 })
    await setCircleSettings(user.headers, grandparents.id, { lowBatteryThreshold: 0.05 })

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-600), accuracyMeters: 12, batteryLevel: 0.14, isCharging: false },
    ])
    expect(
      (await feedTypes(user.headers, family.id)).filter((t) => t === "low_battery"),
    ).toHaveLength(1)
    expect(await feedTypes(user.headers, grandparents.id)).not.toContain("low_battery")

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.04, isCharging: false },
    ])

    // The stricter circle hears it now, and the looser one is not told twice.
    expect(
      (await feedTypes(user.headers, grandparents.id)).filter((t) => t === "low_battery"),
    ).toHaveLength(1)
    expect(
      (await feedTypes(user.headers, family.id)).filter((t) => t === "low_battery"),
    ).toHaveLength(1)
  })

  it("treats a phone reporting 0 percent as a reading and not a missing one", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // The last fix an iPhone manages to send before it shuts itself down.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-45), accuracyMeters: 35, batteryLevel: 0, isCharging: false },
    ])

    const low = (await feedItems(user.headers, circle.id)).filter(
      (item) => item.type === "low_battery",
    )
    expect(low).toHaveLength(1)
    expect(low[0]!.summary).toBe("Battery at 0%")
  })

  it("says nothing while the phone is on the charger below the threshold", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // Plugged in at 8% and climbing. Nobody needs telling.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-300), accuracyMeters: 12, batteryLevel: 0.08, isCharging: true },
      { ...HOME, recordedAt: iso(-180), accuracyMeters: 12, batteryLevel: 0.11, isCharging: true },
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.14, isCharging: true },
    ])

    expect(await feedTypes(user.headers, circle.id)).not.toContain("low_battery")
  })

  it("alerts again after the phone charges past the recovery band and drains a second time", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-700), accuracyMeters: 12, batteryLevel: 0.13, isCharging: false },
    ])
    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "low_battery"),
    ).toHaveLength(1)

    // On the charger through the afternoon, up to 64%.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-500), accuracyMeters: 12, batteryLevel: 0.31, isCharging: true },
      { ...HOME, recordedAt: iso(-400), accuracyMeters: 12, batteryLevel: 0.64, isCharging: true },
    ])
    expect((await presenceRow(user.user.id))!.low_battery_notified_at).toBeNull()

    // Unplugged, and down it goes again inside the same six hour cooldown.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-120), accuracyMeters: 12, batteryLevel: 0.12, isCharging: false },
    ])

    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "low_battery"),
    ).toHaveLength(2)
  })

  it("does not tell a circle the member has paused sharing with", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await setSharing(teen.headers, circle.id, { sharingState: "paused" })

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90), accuracyMeters: 12, batteryLevel: 0.06, isCharging: false },
    ])

    expect(await feedTypes(parent.headers, circle.id)).not.toContain("low_battery")
    expect(await outboxTypes()).not.toContain("low_battery")
  })

  it("does tell a circle the member shares approximately with", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await setSharing(teen.headers, circle.id, { sharingState: "approximate" })

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90), accuracyMeters: 12, batteryLevel: 0.06, isCharging: false },
    ])

    // A battery level is not a location, and the presence projection already
    // shows it to an approximate viewer, so this one should still land.
    expect(await feedTypes(parent.headers, circle.id)).toContain("low_battery")
    expect(await outboxTypes()).toContain("low_battery")
  })

  it("raises the alert for a 4 percent reading buffered twenty minutes before the flush", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // The tracker runs with pausesUpdatesAutomatically and a deferred-updates
    // interval, so a phone that stops moving stops recording. Sitting still
    // indoors on a weak signal, the newest fix it has to flush is twenty
    // minutes old and says 4%. The same shape covers a phone whose clock runs
    // slow, which is the case the offline latch was already hardened against.
    await uploadFixes(user.headers, [
      {
        ...HOME,
        recordedAt: iso(-20 * 60),
        accuracyMeters: 45,
        batteryLevel: 0.04,
        isCharging: false,
      },
    ])
    await uploadFixes(user.headers, [
      {
        ...HOME,
        recordedAt: iso(-19 * 60),
        accuracyMeters: 45,
        batteryLevel: 0.03,
        isCharging: false,
      },
    ])

    // Twenty minutes is well inside the hour the offline sweep allows, so
    // nothing else is going to tell the family either.
    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await feedTypes(user.headers, circle.id)).not.toContain("device_offline")

    expect(await feedTypes(user.headers, circle.id)).toContain("low_battery")
  })

  it("raises a single alert when two devices on one account upload together", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const friends = await createCircle(user.headers, "Friends")
    const school = await createCircle(user.headers, "School run")
    for (const circle of [family, friends, school]) {
      for (const place of [
        { name: "Home", icon: "home", ...HOME, radiusMeters: 150 },
        { name: "Work", icon: "work", lat: 51.4571, lon: -2.5978, radiusMeters: 200 },
      ]) {
        const created = await ctx.app.inject({
          method: "POST",
          url: `/api/v1/circles/${circle.id}/places`,
          headers: user.headers,
          payload: place,
        })
        expect(created.statusCode).toBe(201)
      }
    }

    const second = await signInDevice(user.email, "device-tablet-audit-1")

    // Phone and tablet both come back on the house wifi at the same moment and
    // flush the ten minutes of breadcrumbs each of them buffered.
    const batchFor = (level: number, offset: number): Fix[] =>
      Array.from({ length: 12 }, (_, i) => ({
        ...HOME,
        recordedAt: iso(offset + i * 45),
        accuracyMeters: 14,
        batteryLevel: level,
        isCharging: false,
      }))

    await Promise.all([
      uploadFixes(user.headers, batchFor(0.11, -600)),
      uploadFixes(second, batchFor(0.1, -570)),
    ])

    const low = (await feedTypes(user.headers, family.id)).filter((t) => t === "low_battery")
    expect(low).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Device offline
// ---------------------------------------------------------------------------

describe("device offline", () => {
  it("announces a phone quiet for over an hour exactly once across three ticks", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-70 * 60), accuracyMeters: 12, batteryLevel: 0.55 },
    ])

    const first = await tick()
    expect(first.offlineFlagged).toBe(1)
    await tick()
    await tick()

    const offline = (await feedTypes(user.headers, circle.id)).filter(
      (type) => type === "device_offline",
    )
    expect(offline).toHaveLength(1)
  })

  it("does not announce a phone that reported fifty five minutes ago", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // A stationary phone in a pocket. Long enough to be greyed out on the map,
    // nowhere near long enough to say the phone has broken.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-55 * 60), accuracyMeters: 12, batteryLevel: 0.55 },
    ])

    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await feedTypes(user.headers, circle.id)).not.toContain("device_offline")
  })

  it("announces once in each circle the member shares with", async () => {
    const user = await registerUser(ctx.app)
    const family = await createCircle(user.headers, "Family")
    const friends = await createCircle(user.headers, "Friends")

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-80 * 60), accuracyMeters: 12, batteryLevel: 0.2 },
    ])
    await tick()
    await tick()

    expect(
      (await feedTypes(user.headers, family.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(1)
    expect(
      (await feedTypes(user.headers, friends.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(1)
  })

  it("says nothing to a circle the member has paused sharing with", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.4 },
    ])
    await setSharing(teen.headers, circle.id, { sharingState: "paused" })

    await tick()

    expect(await feedTypes(parent.headers, circle.id)).not.toContain("device_offline")
    expect(await outboxTypes()).not.toContain("device_offline")
  })

  it("does not report a deactivated account as having a broken phone", async () => {
    const admin = await registerUser(ctx.app)
    const member = await registerUser(ctx.app)
    const circle = await createCircle(member.headers)

    await uploadFixes(member.headers, [
      { ...HOME, recordedAt: iso(-95 * 60), accuracyMeters: 12, batteryLevel: 0.6 },
    ])

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${member.user.id}`,
      headers: admin.headers,
      payload: { isActive: false },
    })
    expect(patch.statusCode).toBe(200)

    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await eventCount("device_offline")).toBe(0)
    void circle
  })

  it("never announces an account that has not uploaded a fix in its life", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // Signed up, joined, never granted background location.
    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await feedTypes(user.headers, circle.id)).not.toContain("device_offline")
    expect(await presenceRow(user.user.id)).toBeNull()
  })

  it("withholds every alert while no phone on the server has reported at all", async () => {
    // Nine households, every phone last heard from ninety minutes ago. That is
    // what our own ingest having been down looks like.
    for (let i = 0; i < 9; i += 1) {
      const member = await registerUser(ctx.app)
      await createCircle(member.headers)
      await uploadFixes(member.headers, [
        { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
      ])
    }

    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await eventCount("device_offline")).toBe(0)
  })

  it("alerts every member of a family-sized server when the server itself was down", async () => {
    // Characterisation, not an endorsement. The outage guard needs eight
    // reporting devices before it engages, so on the one-household server this
    // project is built for, an ingest outage longer than an hour tells every
    // family that every phone has broken. The code documents the trade-off.
    for (let i = 0; i < 4; i += 1) {
      const member = await registerUser(ctx.app)
      await createCircle(member.headers)
      await uploadFixes(member.headers, [
        { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
      ])
    }

    const report = await tick()
    expect(report.offlineFlagged).toBe(4)
    expect(await eventCount("device_offline")).toBe(4)
  })

  it("keeps withholding them when the first phone reconnects after the outage", async () => {
    const members: Awaited<ReturnType<typeof registerUser>>[] = []
    for (let i = 0; i < 9; i += 1) {
      const member = await registerUser(ctx.app)
      await createCircle(member.headers)
      await uploadFixes(member.headers, [
        { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
      ])
      members.push(member)
    }

    // The tick right after the server came back, before anything reconnected.
    expect((await tick()).offlineFlagged).toBe(0)

    // One phone gets its background window first and uploads. The other eight
    // are perfectly healthy and will be along in the next few minutes.
    await uploadFixes(members[0]!.headers, [
      { ...HOME, recordedAt: iso(-20), accuracyMeters: 12, batteryLevel: 0.5 },
    ])

    const report = await tick()
    expect(report.offlineFlagged).toBe(0)
    expect(await eventCount("device_offline")).toBe(0)
  })

  it("still announces eight quiet phones on a server where the rest are reporting", async () => {
    // The other direction of the withholding rule, and the one that matters
    // more: eight dark phones alongside eight healthy ones is not an outage,
    // it is eight families owed an alert. A guard that cannot tell them apart
    // has replaced a noisy bug with a silent one.
    for (let i = 0; i < 8; i += 1) {
      const member = await registerUser(ctx.app)
      await createCircle(member.headers)
      await uploadFixes(member.headers, [
        { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.5 },
      ])
    }
    for (let i = 0; i < 8; i += 1) {
      const member = await registerUser(ctx.app)
      await createCircle(member.headers)
      await uploadFixes(member.headers, [
        { ...HOME, recordedAt: iso(-30), accuracyMeters: 12, batteryLevel: 0.8 },
      ])
    }

    const report = await tick()
    expect(report.offlineFlagged).toBe(8)
    expect(await eventCount("device_offline")).toBe(8)
  })

  it("announces the phone again after it came back and went quiet a second time", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-70 * 60), accuracyMeters: 12, batteryLevel: 0.3 },
    ])
    await tick()
    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(1)

    // It comes back.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-30), accuracyMeters: 12, batteryLevel: 0.28 },
    ])
    expect((await presenceRow(user.user.id))!.offline_notified_at).toBeNull()

    // Ninety minutes pass with nothing further from it. Moving the stored fix
    // back is how this suite gets to skip the wait.
    await getDb().execute(
      sql`update user_presence set recorded_at = now() - interval '95 minutes'
          where user_id = ${user.user.id}::uuid`,
    )

    await tick()
    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(2)
  })

  it("announces a phone that went quiet while sharing was paused, once the pause lapses", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.09 },
    ])

    // Sharing paused for the evening, with an expiry so it lapses on its own.
    await setSharing(teen.headers, circle.id, {
      sharingState: "paused",
      pausedUntil: new Date(Date.now() + 1500).toISOString(),
    })

    // A sweep while the pause is still on. The circle must hear nothing yet.
    await tick()
    expect(await feedTypes(parent.headers, circle.id)).not.toContain("device_offline")

    await sleep(2000)

    // The pause has lapsed. The phone is still dark and the circle is sharing
    // again, so this is the moment they should be told.
    await tick()
    const types = await feedTypes(parent.headers, circle.id)
    expect(types).toContain("sharing_resumed")
    expect(types).toContain("device_offline")
  })

  it("does not re-announce or misdate anything when a phone drains two days of backlog", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // Last heard from fifty hours ago, on 35%.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-50 * 3600), accuracyMeters: 12, batteryLevel: 0.35 },
    ])
    await tick()
    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(1)

    // Back in signal. The queue drains oldest first: two days of breadcrumbs
    // that end with the phone running itself down to 3% before it died.
    const backlog: Fix[] = Array.from({ length: 12 }, (_, i) => ({
      ...HOME,
      recordedAt: iso(-49 * 3600 + i * 2 * 3600),
      accuracyMeters: 18,
      batteryLevel: Number((0.35 - i * 0.027).toFixed(3)),
    }))
    await uploadFixes(user.headers, backlog)

    // Nothing in that backlog is true now, so nobody is told about 3%.
    expect(await feedTypes(user.headers, circle.id)).not.toContain("low_battery")
    // And the phone has not come back yet, so the latch is still spent.
    expect((await presenceRow(user.user.id))!.offline_notified_at).not.toBeNull()

    // The last chunk: it charged overnight and is reporting normally again.
    await uploadFixes(user.headers, [
      {
        ...HOME,
        recordedAt: iso(-8 * 60),
        accuracyMeters: 12,
        batteryLevel: 0.62,
        isCharging: true,
      },
      { ...HOME, recordedAt: iso(-60), accuracyMeters: 12, batteryLevel: 0.64, isCharging: true },
    ])
    expect((await presenceRow(user.user.id))!.offline_notified_at).toBeNull()

    await tick()
    await tick()
    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "device_offline"),
    ).toHaveLength(1)
    expect(await feedTypes(user.headers, circle.id)).not.toContain("low_battery")
  })
})

// ---------------------------------------------------------------------------
// Device online
// ---------------------------------------------------------------------------

describe("device online", () => {
  it("announces the phone coming back after it was announced offline", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-2 * 24 * 3600), accuracyMeters: 12, batteryLevel: 0.22 },
    ])
    await tick()
    expect(await feedTypes(user.headers, circle.id)).toContain("device_offline")

    // Two days later the phone is charged, back on wifi and reporting.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-30), accuracyMeters: 12, batteryLevel: 0.88, isCharging: true },
    ])
    await tick()

    const online = (await feedTypes(user.headers, circle.id)).filter(
      (type) => type === "device_online",
    )
    expect(online).toHaveLength(1)
  })

  it("says it once however many ticks the phone stays back", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-95 * 60), accuracyMeters: 12, batteryLevel: 0.15 },
    ])
    await tick()

    // Stamped half a minute ago, which on a phone whose clock runs slow lands
    // behind the sweep that announced the silence. Ordering the two by the
    // device's own clock would leave the return owed on every later tick.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-30), accuracyMeters: 12, batteryLevel: 0.91, isCharging: true },
    ])
    await tick()
    await tick()
    await tick()

    expect(
      (await feedTypes(user.headers, circle.id)).filter((t) => t === "device_online"),
    ).toHaveLength(1)
  })

  it("does not tell a circle sharing was paused with that the phone is back", async () => {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const teen = await registerUser(ctx.app, { displayName: "Teen" })
    const circle = await createCircle(parent.headers)
    await joinCircle(teen.headers, circle.invite.code)

    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-90 * 60), accuracyMeters: 12, batteryLevel: 0.12 },
    ])
    await tick()
    expect(await feedTypes(parent.headers, circle.id)).toContain("device_offline")

    // Sharing off before the phone comes back. Being reachable again is a
    // presence signal like any other, so a circle she has stopped sharing with
    // does not get to watch her reconnect.
    await setSharing(teen.headers, circle.id, { sharingState: "paused" })
    await uploadFixes(teen.headers, [
      { ...HOME, recordedAt: iso(-20), accuracyMeters: 12, batteryLevel: 0.44 },
    ])
    await tick()

    expect(await feedTypes(parent.headers, circle.id)).not.toContain("device_online")
    expect(await outboxTypes()).not.toContain("device_online")
  })

  it("does not announce a phone coming online that was never announced offline", async () => {
    const user = await registerUser(ctx.app)
    const circle = await createCircle(user.headers)

    // Ordinary reporting, a couple of gaps well inside the hour.
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-40 * 60), accuracyMeters: 12, batteryLevel: 0.7 },
    ])
    await tick()
    await uploadFixes(user.headers, [
      { ...HOME, recordedAt: iso(-45), accuracyMeters: 12, batteryLevel: 0.66 },
    ])
    await tick()

    expect(await feedTypes(user.headers, circle.id)).not.toContain("device_online")
  })
})
