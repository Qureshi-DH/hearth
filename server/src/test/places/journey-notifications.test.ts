import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { clockTime } from "../../services/place-news"
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
  setSharing,
  startTestApp,
  uploadFixes,
  type Fix,
  type TestContext,
} from "../helpers"

/**
 * At most two notifications for a journey between two named places, "left"
 * once the departure is real, and "arrived" as soon as it is, carrying the
 * journey. Everything else the fence notices goes to the feed.
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
const at = (point: { lat: number; lon: number }, secondsAgo: number, extra: Partial<Fix> = {}) => ({
  ...point,
  recordedAt: iso(-secondsAgo),
  accuracyMeters: 8,
  ...extra,
})

class FakeDriver implements PushDriver {
  readonly delivered: PushMessage[] = []
  constructor(readonly provider: "expo" | "ntfy" = "expo") {}
  async send(_target: DeliveryTarget, message: PushMessage): Promise<DeliveryResult> {
    this.delivered.push(message)
    return { ok: true }
  }
}

interface Row {
  id: number
  type: string
  body: string
  status: string
  last_error: string | null
  due_in_ms: number
}

async function placeRows(userId: string): Promise<Row[]> {
  return (await getDb().execute(sql`
    select id, data->>'type' as type, body, status, last_error,
           (extract(epoch from next_attempt_at - now()) * 1000)::float8 as due_in_ms
    from notification_outbox
    where user_id = ${userId}::uuid and data->>'type' in ('place_arrive', 'place_leave')
    order by id
  `)) as unknown as Row[]
}

/** A parent and a kid, the kid already at home before Home and School exist. */
async function household(where = HOME) {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const kid = await registerUser(ctx.app, { displayName: "Kid" })
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, kid.headers, circle.invite.code)
  await enablePush(parent.user.id, "ExponentPushToken[parent-phone]")
  await uploadFixes(ctx.app, kid.headers, [at(where, 20 * 60)])
  await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
  await createPlace(ctx.app, parent.headers, circle.id, { name: "School", ...SCHOOL })
  await clearOutbox()
  return { parent, kid, circle }
}

const soon = () => new Date(Date.now() + 2000)

describe("left", () => {
  it("is not sent for a fix that jumped out and came straight back", async () => {
    const { parent, kid } = await household()

    await uploadFixes(ctx.app, kid.headers, [at(northOf(HOME, 320), 40, { accuracyMeters: 30 })])
    await uploadFixes(ctx.app, kid.headers, [at(HOME, 20)])

    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => [row.type, row.status])).toEqual([["place_leave", "skipped"]])
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: new Date(Date.now() + 2 * 60_000) })
    expect(driver.delivered).toEqual([])
  })

  it("waits about a minute for the fix that would undo it", async () => {
    const { parent, kid } = await household()

    await uploadFixes(ctx.app, kid.headers, [at(northOf(HOME, 320), 5)])

    const [row] = await placeRows(parent.user.id)
    expect(row).toMatchObject({ type: "place_leave", body: "Kid left Home", status: "pending" })
    expect(row!.due_in_ms).toBeGreaterThan(50_000)
    expect(row!.due_in_ms).toBeLessThanOrEqual(60_000)
  })

  it("goes at once when a second fix outside confirms it", async () => {
    const { parent, kid } = await household()

    await uploadFixes(ctx.app, kid.headers, [at(northOf(HOME, 320), 30)])
    await uploadFixes(ctx.app, kid.headers, [at(northOf(HOME, 380), 10)])

    const [row] = await placeRows(parent.user.id)
    expect(row!.due_in_ms).toBeLessThanOrEqual(0)
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: soon() })
    expect(driver.delivered.map((message) => message.body)).toEqual(["Left Home"])
  })

  it("is sent even when the kid walked back in after the arrival had gone out", async () => {
    const { parent, kid } = await household(northOf(SCHOOL, -600))

    // Walking in, so the arrival goes straight away.
    await uploadFixes(ctx.app, kid.headers, [at(northOf(SCHOOL, 20), 60, { speedMps: 1.3 })])
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: soon() })
    expect(driver.delivered.map((message) => message.body)).toEqual(["Arrived at School"])

    await uploadFixes(ctx.app, kid.headers, [
      at(northOf(SCHOOL, 240), 30, { speedMps: 1.3 }),
      at(northOf(SCHOOL, 300), 10, { speedMps: 1.3 }),
    ])

    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => [row.type, row.status])).toEqual([
      ["place_arrive", "sent"],
      ["place_leave", "pending"],
    ])
  })

  it("is sent when a drive-in had been held and went out before the leave landed", async () => {
    const { parent, kid } = await household(northOf(SCHOOL, -900))

    await uploadFixes(ctx.app, kid.headers, [at(northOf(SCHOOL, 10), 90, { speedMps: 12 })])
    // The minute an arrival at speed is held for has gone by, and it was sent.
    await getDb().execute(sql`
      update notification_outbox set next_attempt_at = now() - interval '1 second';
      update place_memberships set settles_at = now() - interval '1 second';
    `)
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: soon() })
    expect(driver.delivered).toHaveLength(1)

    await uploadFixes(ctx.app, kid.headers, [
      at(northOf(SCHOOL, 400), 20, { speedMps: 12 }),
      at(northOf(SCHOOL, 600), 5, { speedMps: 12 }),
    ])

    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => [row.type, row.status])).toEqual([
      ["place_arrive", "sent"],
      ["place_leave", "pending"],
    ])
  })
})

describe("arrived", () => {
  it("goes at once at walking pace", async () => {
    const { parent, kid } = await household(northOf(SCHOOL, -500))

    await uploadFixes(ctx.app, kid.headers, [at(SCHOOL, 5, { speedMps: 1.2 })])

    const [row] = await placeRows(parent.user.id)
    expect(row).toMatchObject({ type: "place_arrive", status: "pending" })
    expect(row!.due_in_ms).toBeLessThanOrEqual(0)
  })

  it("waits about a minute at driving speed, in case the car is passing", async () => {
    const { parent, kid } = await household(northOf(SCHOOL, -900))

    await uploadFixes(ctx.app, kid.headers, [at(northOf(SCHOOL, -100), 5, { speedMps: 13 })])

    const [row] = await placeRows(parent.user.id)
    expect(row!.due_in_ms).toBeGreaterThan(50_000)
    expect(row!.due_in_ms).toBeLessThanOrEqual(60_000)
  })

  it("says nothing for a car that drove straight through", async () => {
    const { parent, kid } = await household(northOf(SCHOOL, -900))

    await uploadFixes(ctx.app, kid.headers, [at(northOf(SCHOOL, -420), 45, { speedMps: 13 })])
    await uploadFixes(ctx.app, kid.headers, [at(northOf(SCHOOL, 30), 25, { speedMps: 13 })])
    await uploadFixes(ctx.app, kid.headers, [at(northOf(SCHOOL, 480), 5, { speedMps: 13 })])

    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => [row.type, row.status])).toEqual([["place_arrive", "skipped"]])
  })

  it("carries the journey from where they left", async () => {
    const PARK = northOf(HOME, 550)
    const { parent, kid, circle } = await household()
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Park", ...PARK })
    await clearOutbox()
    const driver = new FakeDriver()

    await uploadFixes(ctx.app, kid.headers, [
      at(northOf(HOME, 200), 100, { speedMps: 3 }),
      at(northOf(HOME, 260), 90, { speedMps: 3 }),
    ])
    await drainOutbox(getDb(), driver, { now: soon() })
    await uploadFixes(ctx.app, kid.headers, [
      at(northOf(HOME, 340), 40, { speedMps: 3 }),
      at(northOf(HOME, 420), 10, { speedMps: 3 }),
    ])
    await drainOutbox(getDb(), driver, { now: soon() })

    expect(driver.delivered.map((message) => message.body)).toEqual([
      "Left Home",
      "Arrived at Park, 420 m from Home in 2 min\nLeft Home",
    ])
    expect((await placeRows(parent.user.id)).at(-1)!.body).toBe(
      "Kid arrived at Park, 420 m from Home in 2 min",
    )
  })

  it("leaves out a journey the circle was not allowed to watch", async () => {
    const { parent, kid, circle } = await household()

    await uploadFixes(ctx.app, kid.headers, [
      at(northOf(HOME, 300), 600, { speedMps: 1.3 }),
      at(northOf(HOME, 400), 560, { speedMps: 1.3 }),
    ])
    await setSharing(ctx.app, kid.headers, circle.id, "approximate")
    await uploadFixes(ctx.app, kid.headers, [at(northOf(HOME, 900), 300, { speedMps: 1.3 })])
    await setSharing(ctx.app, kid.headers, circle.id, "precise")
    await uploadFixes(ctx.app, kid.headers, [at(SCHOOL, 20, { speedMps: 1.3 })])

    expect((await placeRows(parent.user.id)).map((row) => row.body)).toEqual([
      "Kid left Home",
      "Kid arrived at School",
    ])
  })

  it("goes alone when the phone's next word after home was from school", async () => {
    const { parent, kid } = await household()

    // A parked phone, silent on the way.
    await uploadFixes(ctx.app, kid.headers, [at(SCHOOL, 30, { speedMps: 0 })])
    const driver = new FakeDriver()
    await drainOutbox(getDb(), driver, { now: soon() })

    expect(driver.delivered.map((message) => message.body)).toEqual([
      "Arrived at School, 1.2 km from Home",
    ])
    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => [row.type, row.status])).toEqual([
      ["place_leave", "skipped"],
      ["place_arrive", "sent"],
    ])
  })

  it("says when it happened once it is late, on the reader's clock", async () => {
    const { parent, kid } = await household(northOf(SCHOOL, -600))
    await getDb().execute(sql`
      update users set notification_settings =
        '{"timeZone":"Asia/Karachi","clock":"24h","quietHours":null,"mutedPeople":[]}'::jsonb
      where id = ${parent.user.id}::uuid
    `)
    await getDb().execute(sql`update sessions set push_provider = 'ntfy'`)
    const arrivedAt = new Date(Date.now() - 9 * 60_000)

    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: arrivedAt.toISOString(), accuracyMeters: 8, speedMps: 1 },
      at(SCHOOL, 30, { speedMps: 0 }),
    ])
    const driver = new FakeDriver("ntfy")
    await drainOutbox(getDb(), driver, { now: soon() })

    const clock = clockTime(arrivedAt, "Asia/Karachi", "24h")
    expect(driver.delivered.map((message) => message.body)).toEqual([
      `Kid arrived at School at ${clock}`,
    ])
  })
})

describe("places inside places", () => {
  it("tells the family about one arrival when somebody walks into both at once", async () => {
    const { parent, kid, circle } = await household(northOf(HOME, 5000))
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Town",
      ...HOME,
      radiusMeters: 2000,
    })
    await clearOutbox()

    await uploadFixes(ctx.app, kid.headers, [at(HOME, 20, { speedMps: 0 })])

    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => row.body)).toEqual(["Kid arrived at Home"])
  })
})

describe("every reader names the same place for one spot", () => {
  async function inTown() {
    const parent = await registerUser(ctx.app, { displayName: "Parent" })
    const kid = await registerUser(ctx.app, { displayName: "Kid" })
    const circle = await createCircle(ctx.app, parent.headers)
    await joinCircle(ctx.app, kid.headers, circle.invite.code)
    // The big place first, so a reader that takes whichever comes back first
    // from the database names it.
    await createPlace(ctx.app, parent.headers, circle.id, {
      name: "Town",
      ...HOME,
      radiusMeters: 5000,
    })
    await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
    await createPlace(ctx.app, parent.headers, circle.id, { name: "School", ...SCHOOL })
    return { parent, kid, circle }
  }

  it("checks somebody in at the smallest place they are in", async () => {
    const { kid, circle } = await inTown()
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/check-in`,
      headers: kid.headers,
      payload: { ...HOME, note: null },
    })
    expect(response.statusCode).toBe(201)
    const [row] = (await getDb().execute(
      sql`select p.name from check_ins c join places p on p.id = c.place_id`,
    )) as unknown as Array<{ name: string }>
    expect(row?.name).toBe("Home")
  })

  it("lists a trip between the places the arrival and departure named", async () => {
    const { parent, kid, circle } = await inTown()
    await getDb().execute(
      sql`update circle_members set created_at = now() - interval '1 hour' where user_id = ${kid.user.id}::uuid`,
    )
    await getDb().execute(sql`
      insert into trips (user_id, started_at, ended_at, distance_meters, point_count,
                         start_lat, start_lon, end_lat, end_lon)
      values (${kid.user.id}::uuid, now() - interval '30 minutes', now() - interval '15 minutes',
              1200, 20, ${HOME.lat}, ${HOME.lon}, ${SCHOOL.lat}, ${SCHOOL.lon})
    `)
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members/${kid.user.id}/trips`,
      headers: parent.headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject([{ startPlaceName: "Home", endPlaceName: "School" }])
  })
})

describe("somebody pacing a boundary", () => {
  it("sends one pair, not a pair every time they step back in", async () => {
    const { parent, kid } = await household()
    const out = (secondsAgo: number) => [
      at(northOf(HOME, 300), secondsAgo),
      at(northOf(HOME, 320), secondsAgo - 10),
    ]

    for (const step of [
      out(14 * 60),
      [at(HOME, 12 * 60)],
      out(10 * 60),
      [at(HOME, 8 * 60)],
      out(6 * 60),
      [at(HOME, 4 * 60)],
    ]) {
      await uploadFixes(ctx.app, kid.headers, step)
    }

    const rows = await placeRows(parent.user.id)
    expect(rows.map((row) => row.body)).toEqual(["Kid left Home", "Kid arrived at Home"])
  })
})
