import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  drainOutbox,
  enqueuePush,
  pruneOutbox,
  requeueStuckSends,
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
  startTestApp,
  uploadFixes,
  type TestContext,
} from "../helpers"

/**
 * An SOS outlasts a push provider outage, and goes ahead of everything else
 * waiting in the queue.
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

const hoursLater = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000)
const nextTick = () => new Date(Date.now() + 2000)

class FakeDriver implements PushDriver {
  readonly provider = "expo" as const
  readonly delivered: PushMessage[] = []

  constructor(
    private readonly answer: (message: PushMessage) => DeliveryResult = () => ({ ok: true }),
  ) {}

  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    const result = this.answer(message)
    if (result.ok) this.delivered.push(message)
    return result
  }
}

const down = () => new FakeDriver(() => ({ ok: false, error: "expo http 503" }))

const subjectHeaders = new Map<string, Record<string, string>>()

async function family() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const teen = await registerUser(ctx.app, { displayName: "Teen" })
  subjectHeaders.set(teen.user.id, teen.headers)
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, teen.headers, circle.invite.code)
  await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")
  await clearOutbox()
  return { parent, teen, circle }
}

async function raiseSos(headers: Record<string, string>, circleId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: {},
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { id: string }).id
}

const STOP = { lat: 51.4545, lon: -2.5879 }
const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString()
const minutesLater = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000)

/**
 * A possible incident as the server raises one, with the stop uploaded, its
 * feed row, and the alert queued for the parent on the SOS channel.
 */
async function incidentFor(recipientId: string, subjectId: string, circleId: string) {
  const stopAt = iso(-11 * 60)
  const headers = subjectHeaders.get(subjectId)!
  await uploadFixes(ctx.app, headers, [{ ...STOP, recordedAt: stopAt, accuracyMeters: 8 }])
  const [event] = (await getDb().execute(sql`
    insert into events (circle_id, actor_user_id, type, payload, summary)
    values (${circleId}::uuid, ${subjectId}::uuid, 'possible_incident',
            ${JSON.stringify({ fromSpeedKmh: 60, at: stopAt })}::jsonb, 'Teen stopped suddenly')
    returning id
  `)) as unknown as Array<{ id: number }>
  await enqueuePush(getDb(), [
    {
      userId: recipientId,
      circleId,
      title: "Check on Teen",
      body: "They stopped suddenly after driving at 60 km/h and have not moved since.",
      channel: "sos",
      priority: "high",
      data: { type: "possible_incident", circleId, eventId: String(event!.id) },
    },
  ])
}

async function incidentStatus() {
  const rows = (await getDb().execute(
    sql`select status from notification_outbox where data->>'type' = 'possible_incident'`,
  )) as unknown as Array<{ status: string }>
  return rows[0]!.status
}

async function sosRow() {
  const rows = (await getDb().execute(
    sql`select status, attempts, next_attempt_at from notification_outbox
        where data->>'type' = 'sos_started'`,
  )) as unknown as Array<{ status: string; attempts: number; next_attempt_at: string }>
  return rows[0]!
}

describe("an SOS through a push provider outage", () => {
  it("keeps trying for as long as the outage lasts, and goes out once it ends", async () => {
    const { teen, circle } = await family()
    await raiseSos(teen.headers, circle.id)

    // A day and a half of the provider refusing every attempt, far past the
    // six tries ordinary news gets.
    const db = getDb()
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await drainOutbox(db, down(), { now: hoursLater(3 * attempt) })
    }
    expect(await sosRow()).toMatchObject({ status: "pending", attempts: 12 })

    // The weekly sweep of old rows and the rescue of abandoned sends run in
    // between, and neither may take it.
    await pruneOutbox(db, hoursLater(24 * 30))
    await requeueStuckSends(db, hoursLater(24 * 30))
    expect(await sosRow()).toMatchObject({ status: "pending" })

    const back = new FakeDriver()
    await drainOutbox(db, back, { now: hoursLater(40) })
    expect(back.delivered.map((message) => message.title)).toEqual(["🚨 SOS from Teen"])
    expect((await sosRow()).status).toBe("sent")
  })

  it("tries again within a few minutes, however many attempts have failed", async () => {
    const { teen, circle } = await family()
    await raiseSos(teen.headers, circle.id)

    const db = getDb()
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await drainOutbox(db, down(), { now: hoursLater(attempt) })
    }
    const waitMs = Date.parse((await sosRow()).next_attempt_at) - Date.now()
    expect(waitMs).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it("stops once the SOS is resolved", async () => {
    const { teen, circle } = await family()
    const alertId = await raiseSos(teen.headers, circle.id)
    const db = getDb()
    await drainOutbox(db, down(), { now: nextTick() })

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${alertId}/resolve`,
      headers: teen.headers,
    })
    expect(resolved.statusCode).toBe(200)

    const back = new FakeDriver()
    await drainOutbox(db, back, { now: hoursLater(1) })
    expect(back.delivered.map((message) => message.title)).toEqual(["SOS resolved"])
    expect((await sosRow()).status).toBe("skipped")
  })

  it("gives up on an SOS the provider turns away as malformed, as it would any other", async () => {
    const { teen, circle } = await family()
    await raiseSos(teen.headers, circle.id)

    const refused = new FakeDriver(() => ({
      ok: false,
      rejected: true,
      error: "expo http 400: bad request",
    }))
    const db = getDb()
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await drainOutbox(db, refused, { now: hoursLater(7 * attempt) })
    }
    expect(await sosRow()).toMatchObject({ status: "failed", attempts: 6 })
  })

  // "Have not moved since" an hour late is a different message, and the
  // phone's own prompt forgets the incident after an hour for the same reason.
  it("keeps a possible incident alert going for an hour, then lets it go", async () => {
    const { parent, teen, circle } = await family()
    await incidentFor(parent.user.id, teen.user.id, circle.id)

    const db = getDb()
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await drainOutbox(db, down(), { now: minutesLater(10 * attempt) })
    }
    expect(await incidentStatus()).toBe("pending")

    await drainOutbox(db, down(), { now: minutesLater(61) })
    expect(await incidentStatus()).toBe("failed")
  })

  it("drops a possible incident once the person no longer shares precisely", async () => {
    const { parent, teen, circle } = await family()
    await incidentFor(parent.user.id, teen.user.id, circle.id)
    await drainOutbox(getDb(), down(), { now: nextTick() })

    const changed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: teen.headers,
      payload: { sharingState: "approximate" },
    })
    expect(changed.statusCode).toBe(200)

    const back = new FakeDriver()
    await drainOutbox(getDb(), back, { now: minutesLater(5) })
    expect(back.delivered).toHaveLength(0)
    expect(await incidentStatus()).toBe("skipped")
  })

  it("drops a possible incident once a newer fix shows they drove on", async () => {
    const { parent, teen, circle } = await family()
    await incidentFor(parent.user.id, teen.user.id, circle.id)
    await drainOutbox(getDb(), down(), { now: nextTick() })

    // Two kilometres up the road, ten minutes later.
    await uploadFixes(ctx.app, teen.headers, [
      { lat: STOP.lat + 0.018, lon: STOP.lon, recordedAt: iso(-60), accuracyMeters: 10 },
    ])

    const back = new FakeDriver()
    await drainOutbox(getDb(), back, { now: minutesLater(5) })
    expect(back.delivered).toHaveLength(0)
    expect(await incidentStatus()).toBe("skipped")
  })

  it("still sends it while the newer fixes are where they stopped", async () => {
    const { parent, teen, circle } = await family()
    await incidentFor(parent.user.id, teen.user.id, circle.id)
    await drainOutbox(getDb(), down(), { now: nextTick() })

    await uploadFixes(ctx.app, teen.headers, [
      { lat: STOP.lat + 0.0003, lon: STOP.lon, recordedAt: iso(-60), accuracyMeters: 10 },
    ])

    const back = new FakeDriver()
    await drainOutbox(getDb(), back, { now: minutesLater(5) })
    expect(back.delivered.map((message) => message.title)).toEqual(["Check on Teen"])
  })

  it("drops an SOS whose alert no longer exists", async () => {
    const { teen, circle } = await family()
    await raiseSos(teen.headers, circle.id)
    await drainOutbox(getDb(), down(), { now: nextTick() })

    // The account that raised it was deleted, and the alert with it.
    await getDb().execute(sql`delete from sos_alerts`)

    const back = new FakeDriver()
    await drainOutbox(getDb(), back, { now: minutesLater(5) })
    expect(back.delivered).toHaveLength(0)
    expect((await sosRow()).status).toBe("skipped")
  })
})

describe("what goes first", () => {
  async function backlog(userId: string, rows: number) {
    await enqueuePush(
      getDb(),
      Array.from({ length: rows }, (_, i) => ({
        userId,
        title: "Hearth",
        body: `Update ${i}`,
        data: { type: "check_in" },
      })),
    )
  }

  it("claims an SOS ahead of a backlog of ordinary news queued before it", async () => {
    const { parent, teen, circle } = await family()
    await backlog(parent.user.id, 30)
    await raiseSos(teen.headers, circle.id)

    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: nextTick(), batchSize: 5, concurrency: 1 })
    expect(driver.delivered[0]!.title).toBe("🚨 SOS from Teen")
  })

  it("claims a possible incident ahead of it too", async () => {
    const { parent, circle } = await family()
    await backlog(parent.user.id, 30)
    await enqueuePush(getDb(), [
      {
        userId: parent.user.id,
        circleId: circle.id,
        title: "Check on Teen",
        body: "They stopped suddenly after driving at 60 km/h and have not moved since.",
        channel: "sos",
        priority: "high",
        data: { type: "possible_incident", circleId: circle.id },
      },
    ])

    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: nextTick(), batchSize: 5, concurrency: 1 })
    expect(driver.delivered[0]!.title).toBe("Check on Teen")
  })

  it("still sends ordinary news at high priority", async () => {
    const { parent } = await family()
    await backlog(parent.user.id, 1)
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: nextTick() })
    expect(driver.delivered[0]!.priority).toBe("high")
  })
})
