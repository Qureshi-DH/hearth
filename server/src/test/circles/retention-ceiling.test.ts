import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createCircle, registerUser, startTestApp, type TestContext } from "../helpers"

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestApp({ MAX_HISTORY_RETENTION_DAYS: "90" })
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

async function serverInfo() {
  const response = await ctx.app.inject({ method: "GET", url: "/api/v1/server-info" })
  expect(response.statusCode).toBe(200)
  return response.json() as { maxHistoryRetentionDays?: number }
}

async function setRetention(headers: Record<string, string>, circleId: string, days: number) {
  return ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}`,
    headers,
    payload: { settings: { historyRetentionDays: days } },
  })
}

describe("history retention ceiling", () => {
  it("tells the app the ceiling the server prunes at", async () => {
    expect((await serverInfo()).maxHistoryRetentionDays).toBe(90)

    const admin = await registerUser(ctx.app)
    const lowered = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: admin.headers,
      payload: { maxHistoryRetentionDays: 30 },
    })
    expect(lowered.statusCode).toBe(200)
    expect((await serverInfo()).maxHistoryRetentionDays).toBe(30)

    // Cleared, the cap is the environment's again.
    await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: admin.headers,
      payload: { maxHistoryRetentionDays: null },
    })
    expect((await serverInfo()).maxHistoryRetentionDays).toBe(90)
  })

  // An older app offers up to ten years, and refusing it would be a 400 in
  // ordinary use.
  it("stores a longer setting as the ceiling rather than refusing it", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers)

    const response = await setRetention(owner.headers, circle.id, 365)
    expect(response.statusCode).toBe(200)
    expect(response.json().settings.historyRetentionDays).toBe(90)
  })

  it("keeps a setting inside the ceiling as it was sent", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers)

    expect((await setRetention(owner.headers, circle.id, 45)).json().settings).toMatchObject({
      historyRetentionDays: 45,
    })
    expect((await setRetention(owner.headers, circle.id, 0)).json().settings).toMatchObject({
      historyRetentionDays: 0,
    })
  })

  it("follows a ceiling an admin set from the app", async () => {
    const owner = await registerUser(ctx.app)
    await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: owner.headers,
      payload: { maxHistoryRetentionDays: 14 },
    })
    const circle = await createCircle(ctx.app, owner.headers)

    const response = await setRetention(owner.headers, circle.id, 30)
    expect(response.statusCode).toBe(200)
    expect(response.json().settings.historyRetentionDays).toBe(14)
  })

  it("caps a new circle's retention too", async () => {
    const owner = await registerUser(ctx.app)
    await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings",
      headers: owner.headers,
      payload: { maxHistoryRetentionDays: 7 },
    })

    const asked = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: owner.headers,
      payload: { name: "Family", settings: { historyRetentionDays: 400 } },
    })
    expect(asked.statusCode).toBe(201)
    expect(asked.json().settings.historyRetentionDays).toBe(7)

    // The default of 30 is longer than this server keeps as well.
    const plain = await createCircle(ctx.app, owner.headers, "Cousins")
    const detail = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${plain.id}`,
      headers: owner.headers,
    })
    expect(detail.json().settings.historyRetentionDays).toBe(7)
  })
})
