import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { clearOutbox, registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * One person in several circles. An emergency is one emergency, so a single
 * press tells every circle they are in, and somebody who shares more than one
 * of those circles with them hears about it once.
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

type Headers = Record<string, string>

async function createCircle(headers: Headers, name: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function joinCircle(headers: Headers, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function inviteCode(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/invites`,
    headers,
    payload: {},
  })
  expect(response.statusCode).toBe(201)
  return (response.json() as { code: string }).code
}

function raiseSos(
  headers: Headers,
  circleId: string,
  body: { note?: string | null; reason?: "sos" | "incident" } = { note: null },
) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: body,
  })
}

function resolveSos(headers: Headers, alertId: string) {
  return ctx.app.inject({ method: "POST", url: `/api/v1/sos/${alertId}/resolve`, headers })
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

async function setIncidentAlerts(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}`,
    headers,
    payload: { settings: { incidentDetection: true } },
  })
  expect(response.statusCode).toBe(200)
}

async function activeAlerts(headers: Headers, circleId: string) {
  const response = await ctx.app.inject({
    method: "GET",
    url: `/api/v1/circles/${circleId}/sos?activeOnly=true`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return response.json() as Array<{ id: string; user: { id: string } }>
}

async function count(query: ReturnType<typeof sql>) {
  const rows = await getDb().execute(query)
  return (rows as unknown as Array<{ n: number }>)[0]!.n
}

const feedCount = (circleId: string, type: "sos_started" | "sos_resolved") =>
  count(
    sql`select count(*)::int as n from events where circle_id = ${circleId}::uuid and type = ${type}`,
  )

const sosPushes = (userId: string) =>
  count(
    sql`select count(*)::int as n from notification_outbox
        where user_id = ${userId}::uuid and channel = 'sos'`,
  )

async function pushedAlertIds(userId: string, type: "sos_started" | "sos_resolved") {
  const rows = (await getDb().execute(
    sql`select data->>'alertId' as id from notification_outbox
        where user_id = ${userId}::uuid and data->>'type' = ${type}
        order by created_at`,
  )) as unknown as Array<{ id: string }>
  return rows.map((row) => row.id)
}

interface RaiseReply {
  id: string
  circleId: string
  notifiedMembers: number
  alerts: Array<{ id: string; circleId: string; resolvedAt: string | null }>
}

/** Yusuf owns one circle per name, and each has one friend of his in it. */
async function yusufInCircles(names: string[]) {
  const yusuf = await registerUser(ctx.app, { displayName: "Yusuf" })
  const circles: Array<{ id: string; name: string; friend: { id: string; headers: Headers } }> = []
  for (const name of names) {
    const created = await createCircle(yusuf.headers, name)
    const friend = await registerUser(ctx.app, { displayName: `${name} friend` })
    await joinCircle(friend.headers, created.invite.code)
    circles.push({
      id: created.id,
      name,
      friend: { id: friend.user.id, headers: friend.headers },
    })
  }
  await clearOutbox()
  return { yusuf, circles }
}

/** His mum, who is in two of his circles. */
async function addMum(yusufHeaders: Headers, circleIds: string[]) {
  const mum = await registerUser(ctx.app, { displayName: "Mum" })
  for (const circleId of circleIds) {
    await joinCircle(mum.headers, await inviteCode(yusufHeaders, circleId))
  }
  await clearOutbox()
  return mum
}

describe("one SOS reaches every circle", () => {
  it("raises in all four of his circles from one press and tells each friend once", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football", "Flatmates"])

    const raised = await raiseSos(yusuf.headers, circles[1]!.id, { note: "Hit on Gloucester Rd" })
    const reply = raised.json() as RaiseReply

    expect({
      code: raised.statusCode,
      pathCircle: reply.circleId,
      circles: reply.alerts.map((alert) => alert.circleId).sort(),
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
      pushes: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
      notifiedMembers: reply.notifiedMembers,
    }).toEqual({
      code: 201,
      pathCircle: circles[1]!.id,
      circles: circles.map((circle) => circle.id).sort(),
      feed: [1, 1, 1, 1],
      pushes: [1, 1, 1, 1],
      notifiedMembers: 4,
    })
    expect(reply.alerts.find((alert) => alert.circleId === circles[1]!.id)!.id).toBe(reply.id)
    for (const circle of circles) {
      expect((await activeAlerts(circle.friend.headers, circle.id)).length).toBe(1)
    }
  })

  it("tells somebody who shares two of his circles about it once", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football"])
    const mum = await addMum(yusuf.headers, [circles[0]!.id, circles[1]!.id])

    const raised = await raiseSos(yusuf.headers, circles[2]!.id, { note: "car hit me" })
    expect(raised.statusCode).toBe(201)

    expect({
      mum: await sosPushes(mum.user.id),
      friends: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
      notifiedMembers: (raised.json() as RaiseReply).notifiedMembers,
    }).toEqual({ mum: 1, friends: [1, 1, 1], notifiedMembers: 4 })
  })

  it("switches him back to precise in every circle it is raised in", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football"])
    await setSharing(yusuf.headers, circles[1]!.id, "approximate")
    await setSharing(yusuf.headers, circles[2]!.id, "paused")

    expect((await raiseSos(yusuf.headers, circles[0]!.id)).statusCode).toBe(201)

    const states: string[] = []
    for (const circle of circles) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/v1/circles/${circle.id}/members`,
        headers: circle.friend.headers,
      })
      const rows = response.json() as Array<{ userId: string; sharingState: string }>
      states.push(rows.find((row) => row.userId === yusuf.user.id)!.sharingState)
    }
    expect(states).toEqual(["precise", "precise", "precise"])
  })

  it("answers an old app pressing in each circle in turn with the alert already open", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football", "Flatmates"])

    // An app from before one press covered every circle sends no reason.
    const codes: number[] = []
    for (const circle of circles) {
      const response = await ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/sos`,
        headers: yusuf.headers,
        payload: { note: "I need help" },
      })
      codes.push(response.statusCode)
    }

    expect({
      codes,
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
      pushes: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
    }).toEqual({ codes: [201, 200, 200, 200], feed: [1, 1, 1, 1], pushes: [1, 1, 1, 1] })
  })

  it("recognises an older app's unanswered crash prompt by its note", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football"])
    await setIncidentAlerts(yusuf.headers, circles[0]!.id)

    // What an app from before `reason` sends when nobody answers the prompt.
    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circles[1]!.id}/sos`,
      headers: yusuf.headers,
      payload: { note: "Possible collision detected automatically. No answer from the phone." },
    })

    expect({
      code: raised.statusCode,
      circles: (raised.json() as RaiseReply).alerts.map((alert) => alert.circleId).sort(),
      football: await feedCount(circles[2]!.id, "sos_started"),
    }).toEqual({
      code: 201,
      circles: [circles[0]!.id, circles[1]!.id].sort(),
      football: 0,
    })
  })

  it("raises a crash alert only where crash alerts are on, and in the circle it came from", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football", "Flatmates"])
    const [family, cousins, football, flatmates] = circles as [
      (typeof circles)[0],
      (typeof circles)[0],
      (typeof circles)[0],
      (typeof circles)[0],
    ]
    await setIncidentAlerts(yusuf.headers, family.id)
    await setIncidentAlerts(yusuf.headers, flatmates.id)
    const mum = await addMum(yusuf.headers, [family.id, football.id])

    const incident = await raiseSos(yusuf.headers, cousins.id, {
      note: "Possible collision detected automatically.",
      reason: "incident",
    })
    expect(incident.statusCode).toBe(201)
    expect((incident.json() as RaiseReply).alerts.map((alert) => alert.circleId).sort()).toEqual(
      [family.id, cousins.id, flatmates.id].sort(),
    )
    expect(await feedCount(football.id, "sos_started")).toBe(0)

    // He gets to the phone and presses SOS himself. Football hears for the
    // first time. Mum heard through Family already.
    const manual = await raiseSos(yusuf.headers, cousins.id, { note: "I'm hurt" })
    expect(manual.statusCode).toBe(201)

    expect({
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
      friends: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
      mum: await sosPushes(mum.user.id),
    }).toEqual({ feed: [1, 1, 1, 1], friends: [1, 1, 1, 1], mum: 1 })
  })
})

describe("pressing again", () => {
  it("raises from a request that carries no body at all", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins"])

    const raised = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circles[0]!.id}/sos`,
      headers: yusuf.headers,
    })

    expect({
      code: raised.statusCode,
      circles: (raised.json() as RaiseReply).alerts?.length,
    }).toEqual({ code: 201, circles: 2 })
  })

  it("answers a repeat with the alert already open and writes nothing", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins"])

    const first = await raiseSos(yusuf.headers, circles[0]!.id, { note: "car hit me" })
    const again = await raiseSos(yusuf.headers, circles[0]!.id, { note: "car hit me" })

    expect({
      codes: [first.statusCode, again.statusCode],
      sameAlert: (again.json() as RaiseReply).id === (first.json() as RaiseReply).id,
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
      pushes: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
    }).toEqual({ codes: [201, 200], sameAlert: true, feed: [1, 1], pushes: [1, 1] })
  })

  it("answers twenty presses on a bad signal without refusing one", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins"])

    const codes: number[] = []
    for (let press = 0; press < 20; press += 1) {
      codes.push((await raiseSos(yusuf.headers, circles[0]!.id, { note: "help" })).statusCode)
    }

    expect({
      codes,
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
      pushes: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
    }).toEqual({
      codes: [201, ...Array.from({ length: 19 }, () => 200)],
      feed: [1, 1],
      pushes: [1, 1],
    })
  })

  it("raises once when two of his devices press at the same moment", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football"])
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: yusuf.email,
        password: "correct-horse-battery",
        device: { deviceId: "device-yusuf-tablet", deviceName: "Tablet", platform: "android" },
      },
    })
    expect(login.statusCode).toBe(200)
    const tablet = {
      authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}`,
    }

    const [phone, other] = await Promise.all([
      raiseSos(yusuf.headers, circles[0]!.id, { note: "Help" }),
      raiseSos(tablet, circles[2]!.id, { note: "Help" }),
    ])

    expect({
      codes: [phone.statusCode, other.statusCode].sort(),
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
      pushes: await Promise.all(circles.map((circle) => sosPushes(circle.friend.id))),
    }).toEqual({ codes: [200, 201], feed: [1, 1, 1], pushes: [1, 1, 1] })
  })

  /**
   * The budget belongs to the account, not to the address behind it. Yusuf
   * spends all of his from the same connection, and Amina, a different
   * account on that same connection, is still heard the first time she asks.
   */
  it("keeps each account's budget to itself", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family"])
    const amina = await registerUser(ctx.app, { displayName: "Amina" })
    await joinCircle(amina.headers, await inviteCode(yusuf.headers, circles[0]!.id))

    const codes = new Set<number>()
    for (let press = 0; press < 60; press += 1) {
      codes.add((await raiseSos(yusuf.headers, circles[0]!.id)).statusCode)
    }
    const yusufOver = await raiseSos(yusuf.headers, circles[0]!.id)
    const aminaFirst = await raiseSos(amina.headers, circles[0]!.id, { note: "I'm with him" })

    expect({
      yusuf: [...codes].sort(),
      yusufOver: yusufOver.statusCode,
      aminaFirst: aminaFirst.statusCode,
      alerts: (await activeAlerts(amina.headers, circles[0]!.id)).length,
    }).toEqual({ yusuf: [200, 201], yusufOver: 429, aminaFirst: 201, alerts: 2 })
  })

  /**
   * Somewhere else on the server a write to several of his member rows takes
   * them in another order, and Postgres breaks the deadlock by failing one
   * side. The SOS is the side that must not fail.
   */
  it("still raises when a deadlock over his member rows aborts the first try", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins"])
    const [low, high] = circles.map((circle) => circle.id).sort() as [string, string]
    const row = (circleId: string) =>
      sql`update circle_members set sharing_state = sharing_state
          where circle_id = ${circleId}::uuid and user_id = ${yusuf.user.id}::uuid`

    let raising!: ReturnType<typeof raiseSos>
    await getDb().transaction(async (tx) => {
      // The other writer holds the row the raise takes last, and then wants
      // the one the raise takes first.
      await tx.execute(row(high))
      raising = raiseSos(yusuf.headers, low, { note: "help" })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await tx.execute(row(low))
    })
    const raised = await raising

    expect({
      code: raised.statusCode,
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_started"))),
    }).toEqual({ code: 201, feed: [1, 1] })
  })
})

describe("fresh alarms are still limited", () => {
  it("lets him raise, resolve and raise again five times, and refuses a sixth", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family"])
    const family = circles[0]!

    const codes: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await raiseSos(yusuf.headers, family.id, { note: "help" })
      codes.push(response.statusCode)
      if (response.statusCode !== 201) continue
      expect((await resolveSos(yusuf.headers, (response.json() as RaiseReply).id)).statusCode).toBe(
        200,
      )
    }

    expect({ codes, alerts: await feedCount(family.id, "sos_started") }).toEqual({
      codes: [201, 201, 201, 201, 201, 429],
      alerts: 5,
    })
  })

  it("still answers a press on an open alert once the fresh ones are spent", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family"])
    const family = circles[0]!

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const raised = await raiseSos(yusuf.headers, family.id)
      await resolveSos(yusuf.headers, (raised.json() as RaiseReply).id)
    }
    const open = await raiseSos(yusuf.headers, family.id, { note: "this one is real" })
    const repeats: number[] = []
    for (let press = 0; press < 5; press += 1) {
      repeats.push((await raiseSos(yusuf.headers, family.id)).statusCode)
    }

    expect({ open: open.statusCode, repeats }).toEqual({
      open: 201,
      repeats: [200, 200, 200, 200, 200],
    })
  })
})

describe("resolving", () => {
  it("lets him close the rest after an admin closed one circle's copy", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins"])
    const sami = await registerUser(ctx.app, { displayName: "Sami" })
    for (const circle of circles) {
      await joinCircle(sami.headers, await inviteCode(yusuf.headers, circle.id))
    }
    const raised = (await raiseSos(sami.headers, circles[0]!.id)).json() as RaiseReply
    // Yusuf runs Family and closes Sami's alert there.
    expect((await resolveSos(yusuf.headers, raised.id)).statusCode).toBe(200)

    // Sami's app still holds the Family alert's id.
    const resolved = await resolveSos(sami.headers, raised.id)

    expect({
      code: resolved.statusCode,
      closedNow: Boolean((resolved.json() as { resolvedAt?: string }).resolvedAt),
      cousins: (await activeAlerts(sami.headers, circles[1]!.id)).length,
      cousinsFeed: await feedCount(circles[1]!.id, "sos_resolved"),
    }).toEqual({ code: 200, closedNow: true, cousins: 0, cousinsFeed: 1 })
  })

  it("closes his alert in every circle when he resolves it, with an entry in each", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins", "Football"])
    const mum = await addMum(yusuf.headers, [circles[0]!.id, circles[2]!.id])

    const raised = (await raiseSos(yusuf.headers, circles[1]!.id)).json() as RaiseReply
    const resolved = await resolveSos(yusuf.headers, raised.id)
    expect(resolved.statusCode).toBe(200)

    expect({
      open: await Promise.all(
        circles.map(
          async (circle) => (await activeAlerts(circle.friend.headers, circle.id)).length,
        ),
      ),
      feed: await Promise.all(circles.map((circle) => feedCount(circle.id, "sos_resolved"))),
      friends: await Promise.all(
        circles.map(
          async (circle) => (await pushedAlertIds(circle.friend.id, "sos_resolved")).length,
        ),
      ),
    }).toEqual({ open: [0, 0, 0], feed: [1, 1, 1], friends: [1, 1, 1] })

    // One all clear for Mum, naming the alert her alarm named, so her phone
    // puts one in place of the other.
    const alarm = await pushedAlertIds(mum.user.id, "sos_started")
    const allClear = await pushedAlertIds(mum.user.id, "sos_resolved")
    expect({ alarms: alarm.length, allClear }).toEqual({ alarms: 1, allClear: alarm })
  })

  it("closes only an admin's own circle when the admin resolves it", async () => {
    const { yusuf, circles } = await yusufInCircles(["Family", "Cousins"])
    const raiser = await registerUser(ctx.app, { displayName: "Sami" })
    for (const circle of circles) {
      await joinCircle(raiser.headers, await inviteCode(yusuf.headers, circle.id))
    }

    const raised = (await raiseSos(raiser.headers, circles[0]!.id)).json() as RaiseReply
    expect(raised.alerts).toHaveLength(2)

    // Yusuf owns Family, and closes Sami's alert there.
    const resolved = await resolveSos(yusuf.headers, raised.id)
    expect(resolved.statusCode).toBe(200)

    expect({
      family: (await activeAlerts(yusuf.headers, circles[0]!.id)).length,
      cousins: (await activeAlerts(yusuf.headers, circles[1]!.id)).length,
      familyFeed: await feedCount(circles[0]!.id, "sos_resolved"),
      cousinsFeed: await feedCount(circles[1]!.id, "sos_resolved"),
    }).toEqual({ family: 0, cousins: 1, familyFeed: 1, cousinsFeed: 0 })
  })
})
