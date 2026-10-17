import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  createCircle,
  createPlace,
  joinCircle,
  registerUser,
  startTestApp,
  type TestContext,
} from "../helpers"

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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

interface Exported {
  sosAlerts: Array<Record<string, unknown>>
  devices: Array<Record<string, unknown>>
  activityFeed: Array<{
    occurredAt: string
    circle: string
    type: string
    summary: string
    details: Record<string, unknown>
  }>
}

async function exportOf(headers: Headers): Promise<Exported> {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/me/export", headers })
  expect(response.statusCode).toBe(200)
  return response.json() as Exported
}

async function post(headers: Headers, url: string, payload: Record<string, unknown> = {}) {
  const response = await ctx.app.inject({ method: "POST", url, headers, payload })
  expect(response.statusCode).toBeLessThan(300)
  return response.json() as { id: string }
}

/** Mum runs the circle, Dan joins it, and both of them have been busy. */
async function family() {
  const mum = await registerUser(ctx.app, { displayName: "Mum" })
  const dan = await registerUser(ctx.app, { displayName: "Dan" })
  const circle = await createCircle(ctx.app, mum.headers, "Family")
  await joinCircle(ctx.app, dan.headers, circle.invite.code)
  return { mum, dan, circle }
}

describe("data export", () => {
  it("includes the SOS alerts the person raised, by name rather than id", async () => {
    const { mum, dan, circle } = await family()
    const raised = await post(dan.headers, `/api/v1/circles/${circle.id}/sos`, {
      note: "Flat tyre on the A40",
    })
    await post(mum.headers, `/api/v1/sos/${raised.id}/resolve`)

    const { sosAlerts } = await exportOf(dan.headers)
    expect(sosAlerts).toHaveLength(1)
    expect(sosAlerts[0]).toEqual({
      circle: "Family",
      note: "Flat tyre on the A40",
      startedAt: expect.stringMatching(ISO),
      resolvedAt: expect.stringMatching(ISO),
      resolvedBy: "Mum",
    })

    // Somebody else's alert is theirs to export.
    expect((await exportOf(mum.headers)).sosAlerts).toEqual([])
  })

  it("includes the devices signed in to the account, without their secrets", async () => {
    const dan = await registerUser(ctx.app, { displayName: "Dan" })
    const { devices } = await exportOf(dan.headers)

    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({
      device: "Test Phone",
      platform: "ios",
      thisDevice: true,
      signedInAt: expect.stringMatching(ISO),
      signedOutAt: null,
    })
    expect(Object.keys(devices[0]!)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/token|hash|spent/i)]),
    )
  })

  it("includes the feed entries about the person and leaves out everybody else's", async () => {
    const { mum, dan, circle } = await family()
    await createPlace(ctx.app, mum.headers, circle.id, { name: "Home", lat: 51.5, lon: -0.12 })
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/members/${dan.user.id}`,
      headers: mum.headers,
      payload: { role: "admin" },
    })
    await post(mum.headers, `/api/v1/circles/${circle.id}/nudge/${dan.user.id}`, {
      body: "Dinner at six",
    })
    const raised = await post(dan.headers, `/api/v1/circles/${circle.id}/sos`)
    await post(mum.headers, `/api/v1/sos/${raised.id}/resolve`)

    const { activityFeed } = await exportOf(dan.headers)
    const types = activityFeed.map((entry) => entry.type).sort()
    expect(types).toEqual([
      "member_joined",
      "nudge_requested",
      "role_changed",
      "sos_resolved",
      "sos_started",
    ])

    for (const entry of activityFeed) {
      expect(entry.circle).toBe("Family")
      expect(entry.occurredAt).toMatch(ISO)
      expect(entry.summary.length).toBeGreaterThan(0)
      expect(entry).not.toHaveProperty("id")
      for (const key of Object.keys(entry.details)) expect(key).not.toMatch(/(^id|Id)$/)
    }
    const nudge = activityFeed.find((entry) => entry.type === "nudge_requested")
    expect(nudge?.details).toMatchObject({ body: "Dinner at six" })

    // Mum's own place and her joining are not about Dan.
    const mumsTypes = (await exportOf(mum.headers)).activityFeed.map((entry) => entry.type)
    expect(mumsTypes).toContain("place_created")
  })
})
