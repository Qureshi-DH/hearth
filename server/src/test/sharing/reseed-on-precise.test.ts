import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { getConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import {
  clearOutbox,
  createCircle,
  createPlace,
  joinCircle,
  registerUser,
  setSharing,
  startTestApp,
  uploadFixes,
  type TestContext,
} from "../helpers"

/**
 * While somebody shares approximately with a circle, or has paused it, the
 * fence says nothing to that circle and its idea of where they are goes
 * stale. Sharing precisely again starts it from where they are now, so
 * nothing that happened in between is announced as if it just had.
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
const SCHOOL = { lat: 51.4636, lon: -2.5952 }
const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString()

async function placeNews(circleId: string) {
  return (
    (await getDb().execute(sql`
      select body from notification_outbox
      where circle_id = ${circleId}::uuid and data->>'type' in ('place_arrive', 'place_leave')
      order by id
    `)) as unknown as Array<{ body: string }>
  ).map((row) => row.body)
}

/** At home when Home and School are created, then off to school unseen. */
async function wentToSchoolUnseen() {
  const parent = await registerUser(ctx.app, { displayName: "Parent" })
  const kid = await registerUser(ctx.app, { displayName: "Kid" })
  const circle = await createCircle(ctx.app, parent.headers)
  await joinCircle(ctx.app, kid.headers, circle.invite.code)
  await uploadFixes(ctx.app, kid.headers, [
    { ...HOME, recordedAt: iso(-3 * 3600), accuracyMeters: 10 },
  ])
  await createPlace(ctx.app, parent.headers, circle.id, { name: "Home", ...HOME })
  await createPlace(ctx.app, parent.headers, circle.id, { name: "School", ...SCHOOL })
  await clearOutbox()
  return { parent, kid, circle }
}

describe("sharing precisely again", () => {
  it("does not announce a departure from home that happened hours ago", async () => {
    const { kid, circle } = await wentToSchoolUnseen()

    await setSharing(ctx.app, kid.headers, circle.id, "approximate")
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-2 * 3600), accuracyMeters: 10 },
    ])
    await setSharing(ctx.app, kid.headers, circle.id, "precise")
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-20), accuracyMeters: 10 },
    ])

    expect(await placeNews(circle.id)).toEqual([])
  })

  it("does the same when a timed pause runs out on the next upload", async () => {
    const { kid, circle } = await wentToSchoolUnseen()

    await setSharing(ctx.app, kid.headers, circle.id, "paused")
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-2 * 3600), accuracyMeters: 10 },
    ])
    await getDb().execute(sql`
      update circle_members set paused_until = now() - interval '1 minute', resume_to_state = 'precise'
      where user_id = ${kid.user.id}::uuid
    `)
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-20), accuracyMeters: 10 },
    ])
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-10), accuracyMeters: 10 },
    ])

    expect(await placeNews(circle.id)).toEqual([])
  })

  it("does the same when the scheduler lapses the pause first", async () => {
    const { kid, circle } = await wentToSchoolUnseen()

    await setSharing(ctx.app, kid.headers, circle.id, "paused")
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-2 * 3600), accuracyMeters: 10 },
    ])
    await getDb().execute(sql`
      update circle_members set paused_until = now() - interval '1 minute', resume_to_state = 'precise'
      where user_id = ${kid.user.id}::uuid
    `)
    await runJobs(getDb(), getConfig(), ctx.app.log)
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-20), accuracyMeters: 10 },
    ])

    expect(await placeNews(circle.id)).toEqual([])
  })

  it("still tells the family about the next real crossing", async () => {
    const { kid, circle } = await wentToSchoolUnseen()

    await setSharing(ctx.app, kid.headers, circle.id, "approximate")
    await uploadFixes(ctx.app, kid.headers, [
      { ...SCHOOL, recordedAt: iso(-2 * 3600), accuracyMeters: 10 },
    ])
    await setSharing(ctx.app, kid.headers, circle.id, "precise")
    await uploadFixes(ctx.app, kid.headers, [
      { ...HOME, recordedAt: iso(-90), accuracyMeters: 10 },
      { ...HOME, recordedAt: iso(-20), accuracyMeters: 10 },
    ])

    // The fixes are stamped before sharing went back to precise, so the
    // circle hears the arrival without the journey to it.
    expect(await placeNews(circle.id)).toEqual(["Kid left School", "Kid arrived at Home"])
  })
})
