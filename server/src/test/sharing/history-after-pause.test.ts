import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * The phone keeps uploading while a circle is paused or approximate, so what
 * it recorded then must stay out of that circle's reach after sharing goes
 * back to precise: in the history, in the trips list and detail, and in the
 * announcement of a trip that began while the circle was not allowed to watch.
 */

const HOME = { lat: 51.4545, lon: -2.5879 }
const M_PER_DEG_LAT = (Math.PI * 6_371_008.8) / 180

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

type Headers = Record<string, string>

const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000

/** A steady drive north at 14 m/s, one fix every 30 s. */
function drive(startMs: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    lat: HOME.lat + (14 * 30 * i) / M_PER_DEG_LAT,
    lon: HOME.lon,
    recordedAt: new Date(startMs + i * 30_000).toISOString(),
    accuracyMeters: 8,
    speedMps: 14,
    batteryLevel: 0.7,
  }))
}

async function household() {
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
  // Members of a while, so the join date is not what bounds anything below.
  await getDb().execute(
    sql`update circle_members set created_at = now() - interval '1 day' where circle_id = ${circle.id}::uuid`,
  )
  return { parent, teen, circleId: circle.id }
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

async function upload(headers: Headers, points: ReturnType<typeof drive>) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

/** Moves the start of the current precise stretch back, as if it began earlier. */
async function preciseSinceMinutesAgo(circleId: string, userId: string, minutes: number) {
  await getDb().execute(sql`
    update circle_members set precise_since = now() - make_interval(mins => ${minutes}::int)
    where circle_id = ${circleId}::uuid and user_id = ${userId}::uuid
  `)
}

async function history(headers: Headers, circleId: string, userId: string) {
  const from = new Date(minutesAgo(120)).toISOString()
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/members/${userId}/history?from=${from}`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ recordedAt: string }>
}

async function tripsOf(headers: Headers, circleId: string, userId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/members/${userId}/trips`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ id: string }>
}

async function feedTypes(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/events`,
    headers,
  })
  return (response.json() as { items: Array<{ type: string }> }).items.map((item) => item.type)
}

const sweep = () => runJobs(getDb(), getConfig(), ctx.app.log)

describe("history recorded while a circle could not watch", () => {
  it("stays hidden after sharing goes back to precise", async () => {
    const { parent, teen, circleId } = await household()

    await setSharing(teen.headers, circleId, "paused")
    await upload(teen.headers, drive(minutesAgo(60), 20))
    await setSharing(teen.headers, circleId, "precise")

    expect(await history(parent.headers, circleId, teen.user.id)).toEqual([])
  })

  it("shows what was recorded after the precise stretch began", async () => {
    const { parent, teen, circleId } = await household()

    await setSharing(teen.headers, circleId, "approximate")
    await setSharing(teen.headers, circleId, "precise")
    await preciseSinceMinutesAgo(circleId, teen.user.id, 30)
    await upload(teen.headers, drive(minutesAgo(60), 100))

    const seen = await history(parent.headers, circleId, teen.user.id)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((fix) => Date.parse(fix.recordedAt) >= minutesAgo(31))).toBe(true)
  })

  it("keeps a member who never paused visible from the day they joined", async () => {
    const { parent, teen, circleId } = await household()
    await upload(teen.headers, drive(minutesAgo(60), 10))

    expect(await history(parent.headers, circleId, teen.user.id)).toHaveLength(10)
  })
})

describe("trips made while a circle could not watch", () => {
  it("are neither listed nor announced once sharing is precise again", async () => {
    const { parent, teen, circleId } = await household()

    await setSharing(teen.headers, circleId, "paused")
    await upload(teen.headers, drive(minutesAgo(45), 31))
    await setSharing(teen.headers, circleId, "precise")
    await sweep()

    expect(await tripsOf(parent.headers, circleId, teen.user.id)).toEqual([])
    expect(await feedTypes(parent.headers, circleId)).not.toContain("trip_completed")
  })

  it("are listed and announced when the circle watched the whole drive", async () => {
    const { parent, teen, circleId } = await household()

    await upload(teen.headers, drive(minutesAgo(45), 31))
    await sweep()

    expect(await tripsOf(parent.headers, circleId, teen.user.id)).toHaveLength(1)
    expect(await feedTypes(parent.headers, circleId)).toContain("trip_completed")
  })
})
