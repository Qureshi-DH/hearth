import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createCircle, registerUser, startTestApp, type TestContext } from "../helpers"

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

async function setPingInterval(headers: Record<string, string>, circleId: string, seconds: number) {
  return ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}`,
    headers,
    payload: { settings: { minUpdateIntervalSeconds: seconds } },
  })
}

describe("the ping interval a circle sets", () => {
  it("starts new circles on a ping every five minutes", async () => {
    const owner = await registerUser(ctx.app)
    const circle = (await createCircle(ctx.app, owner.headers)) as unknown as {
      settings: { minUpdateIntervalSeconds: number }
    }
    expect(circle.settings.minUpdateIntervalSeconds).toBe(300)
  })

  // An app from before the ping still offers half a minute. Refusing it is a
  // 4xx in ordinary use, which a firewall in front of the server can answer
  // by locking the phone out.
  it("raises an older app's half minute to the floor rather than refusing it", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers)
    const response = await setPingInterval(owner.headers, circle.id, 30)
    expect(response.statusCode).toBe(200)
    expect(
      (response.json() as { settings: { minUpdateIntervalSeconds: number } }).settings
        .minUpdateIntervalSeconds,
    ).toBe(120)
  })

  it("keeps an interval at or above the floor as it was set", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers)
    const response = await setPingInterval(owner.headers, circle.id, 600)
    expect(response.statusCode).toBe(200)
    expect(
      (response.json() as { settings: { minUpdateIntervalSeconds: number } }).settings
        .minUpdateIntervalSeconds,
    ).toBe(600)
  })
})
