import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

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

async function createCircle(headers: Record<string, string>, name: string) {
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

function raiseSos(headers: Record<string, string>, circleId: string, note?: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: { note: note ?? null },
  })
}

async function sosEventCount(circleId: string) {
  const rows = await getDb().execute(
    sql`select count(*)::int as n from events
        where circle_id = ${circleId} and type = 'sos_started'`,
  )
  return (rows as unknown as Array<{ n: number }>)[0]!.n
}

async function sosPushCount(userId: string) {
  const rows = await getDb().execute(
    sql`select count(*)::int as n from notification_outbox
        where user_id = ${userId} and channel = 'sos'`,
  )
  return (rows as unknown as Array<{ n: number }>)[0]!.n
}

/**
 * One person in several circles. Nothing caps how many circles an account
 * belongs to, and SOS is raised per circle, so alerting everyone means raising
 * it once in each.
 */
async function yusufInCircles(names: string[]) {
  const yusuf = await registerUser(ctx.app, { displayName: "Yusuf" })
  const circles: Array<{ id: string; name: string; witnessUserId: string }> = []
  for (const name of names) {
    const created = await createCircle(yusuf.headers, name)
    const witness = await registerUser(ctx.app, { displayName: `${name} friend` })
    await joinCircle(witness.headers, created.invite.code)
    circles.push({ id: created.id, name, witnessUserId: witness.user.id })
  }
  return { yusuf, circles }
}

describe("sos", () => {
  it("alerts every circle when someone in four raises one everywhere", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football", "Flatmates"])

    const codes: number[] = []
    const bodies: string[] = []
    for (const circle of circles) {
      const response = await raiseSos(
        yusuf.headers,
        circle.id,
        "I've been hit, I'm on Gloucester Rd",
      )
      codes.push(response.statusCode)
      bodies.push(response.body)
    }

    // Every circle he raised in should hold exactly one alert, and the other
    // member of each should have exactly one SOS push waiting.
    const counts = await Promise.all(circles.map((circle) => sosEventCount(circle.id)))
    const pushes = await Promise.all(circles.map((circle) => sosPushCount(circle.witnessUserId)))

    expect({
      codes,
      counts,
      pushes,
      refused: bodies.filter((body) => body.includes("too_many_requests")),
    }).toEqual({
      codes: [201, 201, 201, 201],
      counts: [1, 1, 1, 1],
      pushes: [1, 1, 1, 1],
      refused: [],
    })
  })

  it("still alerts the third circle after a panicked double tap in the first", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football"])

    // The raise takes a row lock, so the second press is answered 409 and
    // writes nothing.
    const first = await raiseSos(yusuf.headers, circles[0]!.id, "car hit me")
    const doubleTap = await raiseSos(yusuf.headers, circles[0]!.id, "car hit me")
    const second = await raiseSos(yusuf.headers, circles[1]!.id, "car hit me")
    const third = await raiseSos(yusuf.headers, circles[2]!.id, "car hit me")

    const counts = await Promise.all(circles.map((circle) => sosEventCount(circle.id)))

    expect({
      first: first.statusCode,
      doubleTap: doubleTap.statusCode,
      second: second.statusCode,
      third: third.statusCode,
      counts,
    }).toEqual({
      first: 201,
      doubleTap: 409,
      second: 201,
      third: 201,
      counts: [1, 1, 1],
    })
  })

  /**
   * The budget belongs to the account, not to the address behind it. Yusuf
   * raises one in each of his four circles from the same phone on the same
   * connection, and Amina, a different account on that same connection, is
   * still heard the first time she asks.
   */
  it("keeps each account's budget to itself", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football", "Flatmates"])
    const amina = await registerUser(ctx.app, { displayName: "Amina" })

    // Amina joins the fourth circle, the last one Yusuf raises in.
    const fourth = circles[3]!
    const invite = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${fourth.id}/invites`,
      headers: yusuf.headers,
      payload: {},
    })
    expect(invite.statusCode).toBe(201)
    await joinCircle(amina.headers, (invite.json() as { code: string }).code)

    for (const circle of circles) await raiseSos(yusuf.headers, circle.id, "hit by a car")

    const aminaFirst = await raiseSos(amina.headers, fourth.id, "I'm with him, we need help")

    // Two alerts from two people in the fourth circle, his and hers. An
    // account-wide budget would have refused his fourth raise.
    expect({
      aminaFirst: aminaFirst.statusCode,
      fourthCircleAlerts: await sosEventCount(fourth.id),
    }).toEqual({ aminaFirst: 201, fourthCircleAlerts: 2 })
  })

  /**
   * The other side of the same budget. Keying it per circle must not amount to
   * turning it off: one circle is still an audience, and holding the button at
   * it is still badgering, so the fourth press inside ten minutes is refused.
   */
  it("still refuses a fourth raise at the same circle inside ten minutes", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family"])
    const family = circles[0]!

    const codes: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const response = await raiseSos(yusuf.headers, family.id, "help")
      codes.push(response.statusCode)
      // Cleared between presses, so each one is a real raise rather than the
      // 409 an alert that is still open would answer with.
      if (response.statusCode !== 201) continue
      const resolved = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/sos/${(response.json() as { id: string }).id}/resolve`,
        headers: yusuf.headers,
      })
      expect(resolved.statusCode).toBe(200)
    }

    expect({ codes, alerts: await sosEventCount(family.id) }).toEqual({
      codes: [201, 201, 201, 429],
      alerts: 3,
    })
  })
})
