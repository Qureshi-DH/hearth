import type { RegisterResponse } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
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

async function register(inviteCode?: string): Promise<RegisterResponse> {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `new-${Math.random().toString(36).slice(2, 10)}@example.com`,
      password: "correct-horse-battery",
      displayName: "Newcomer",
      inviteCode,
      device: { deviceId: `device-${Math.random().toString(36).slice(2, 12)}` },
    },
  })
  // The account is made whatever became of the code.
  expect(response.statusCode).toBe(201)
  return response.json() as RegisterResponse
}

describe("an invite sent with sign-up", () => {
  it("says which circle it joined", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers, "Family")

    const body = await register(circle.invite.code)
    expect(body.invite).toEqual({ joined: true, circleId: circle.id, circleName: "Family" })
  })

  it("says why it did not join, rather than only logging it", async () => {
    const owner = await registerUser(ctx.app)
    const circle = await createCircle(ctx.app, owner.headers)
    await getDb().execute(
      sql`update invites set expires_at = now() - interval '1 hour' where code = ${circle.invite.code}`,
    )

    const body = await register(circle.invite.code)
    expect(body.invite).toEqual({
      joined: false,
      reason: "expired",
      message: "That invite has expired.",
    })

    const circles = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/circles",
      headers: { authorization: `Bearer ${body.accessToken}` },
    })
    expect(circles.json()).toEqual([])
  })

  it("says when there is no such code", async () => {
    const body = await register("ZZZZ9999")
    expect(body.invite).toMatchObject({ joined: false, reason: "not_found" })
  })

  it("says nothing about an invite nobody sent", async () => {
    const body = await register()
    expect(body.invite).toBeUndefined()
  })
})
