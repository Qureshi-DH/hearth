import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"

import type { WsServerMessage } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Somebody with an SOS open is on Live, a fix a second, wherever their app
 * is, until shortly after it is resolved. The phone already goes Live when an
 * upload reply or its control channel names a watch window, so the server
 * names one for as long as the alert is open, without touching the window a
 * family member's own watch holds.
 */

interface RawSocket {
  on(event: string, listener: (...args: any[]) => void): void
  send(data: string): void
  close(): void
}

const WebSocketImpl = createRequire(import.meta.url)("ws") as new (url: string) => RawSocket

const STREET = { lat: 51.4545, lon: -2.5879 }

let ctx: TestContext
let origin = ""

beforeAll(async () => {
  ctx = await startTestApp()
  await ctx.app.listen({ host: "127.0.0.1", port: 0 })
  const address = ctx.app.server.address() as AddressInfo
  origin = `ws://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

type Headers = Record<string, string>

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

/** The phone's own channel, a socket that has declared itself the device. */
async function openControl(token: string) {
  const socket = new WebSocketImpl(`${origin}/api/v1/ws?access_token=${token}`)
  const messages: WsServerMessage[] = []
  socket.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString()) as WsServerMessage)
  })
  socket.on("error", () => {})
  await new Promise<void>((resolve) => socket.on("open", () => resolve()))
  socket.send(JSON.stringify({ type: "control" }))
  await waitFor(() => messages.some((m) => m.type === "control" && m.command === "ready"))
  return { socket, messages }
}

/** An app's ordinary socket, subscribed to the viewer's circles. */
async function openApp(token: string) {
  const socket = new WebSocketImpl(`${origin}/api/v1/ws?access_token=${token}`)
  const messages: WsServerMessage[] = []
  socket.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString()) as WsServerMessage)
  })
  socket.on("error", () => {})
  await waitFor(() => messages.some((m) => m.type === "subscribed"))
  return { socket, messages }
}

const watchCommands = (messages: WsServerMessage[]) =>
  messages.flatMap((m) => (m.type === "control" && m.command === "watch" ? [m] : []))

async function upload(headers: Headers) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: {
      points: [
        {
          ...STREET,
          recordedAt: new Date().toISOString(),
          accuracyMeters: 8,
          speedMps: 0,
          source: "sos",
        },
      ],
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { watchedUntil: string | null; serverTime: string }
  return {
    watchedUntil: body.watchedUntil,
    /** How far ahead of the server's clock the window ends. */
    seconds: body.watchedUntil
      ? (Date.parse(body.watchedUntil) - Date.parse(body.serverTime)) / 1000
      : null,
  }
}

function raiseSos(headers: Headers, circleId: string) {
  return ctx.app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/sos`,
    headers,
    payload: { note: null },
  })
}

async function storedWindow(userId: string) {
  const rows = (await getDb().execute(
    sql`select watched_until from user_presence where user_id = ${userId}::uuid`,
  )) as unknown as Array<{ watched_until: Date | string | null }>
  const value = rows[0]?.watched_until
  return value == null ? null : new Date(value).toISOString()
}

async function household() {
  const mum = await registerUser(ctx.app, { displayName: "Mum" })
  const created = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers: mum.headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(created.statusCode).toBe(201)
  const circle = created.json() as { id: string; invite: { code: string } }
  const leila = await registerUser(ctx.app, {
    displayName: "Leila",
    inviteCode: circle.invite.code,
  })
  return { mum, leila, circleId: circle.id }
}

describe("an open SOS keeps the raiser on Live", () => {
  it("names a short window on every upload while it is open, and none once it is resolved", async () => {
    const { leila, circleId } = await household()
    const before = await upload(leila.headers)

    const raised = await raiseSos(leila.headers, circleId)
    expect(raised.statusCode).toBe(201)
    const during = await upload(leila.headers)

    const resolved = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/sos/${(raised.json() as { id: string }).id}/resolve`,
      headers: leila.headers,
    })
    expect(resolved.statusCode).toBe(200)
    const after = await upload(leila.headers)

    expect(before.watchedUntil).toBeNull()
    // Short, so the phone steps down soon after the all clear, and long
    // enough to ride out a minute or so of uploads not getting through.
    expect(during.seconds).toBeGreaterThan(60)
    expect(during.seconds).toBeLessThanOrEqual(120)
    expect(after.watchedUntil).toBeNull()
  })

  it("lets her phone go after the alert's first half hour, even left open", async () => {
    const { leila, circleId } = await household()
    const raised = await raiseSos(leila.headers, circleId)
    expect(raised.statusCode).toBe(201)
    const id = (raised.json() as { id: string }).id

    // A minute short of the half hour, the window runs only to its end.
    await getDb().execute(
      sql`update sos_alerts set started_at = now() - interval '29 minutes',
          live_from = now() - interval '29 minutes' where id = ${id}::uuid`,
    )
    const late = await upload(leila.headers)
    expect(late.seconds).toBeGreaterThan(30)
    expect(late.seconds).toBeLessThanOrEqual(60)

    // A false crash alarm nobody resolved held a phone on Live for days.
    await getDb().execute(
      sql`update sos_alerts set started_at = now() - interval '31 minutes',
          live_from = now() - interval '31 minutes' where id = ${id}::uuid`,
    )
    const past = await upload(leila.headers)
    expect(past.watchedUntil).toBeNull()
  })

  it("puts her back on Live when she presses again on an alert still open", async () => {
    const { leila, circleId } = await household()
    const raised = await raiseSos(leila.headers, circleId)
    const id = (raised.json() as { id: string }).id
    await getDb().execute(
      sql`update sos_alerts set started_at = now() - interval '40 minutes',
          live_from = now() - interval '40 minutes' where id = ${id}::uuid`,
    )
    expect((await upload(leila.headers)).watchedUntil).toBeNull()

    const again = await raiseSos(leila.headers, circleId)
    expect(again.statusCode).toBe(200)
    const during = await upload(leila.headers)
    expect(during.seconds).toBeGreaterThan(60)
    expect(during.seconds).toBeLessThanOrEqual(120)
  })

  it("asks her phone to go Live at once over its control channel", async () => {
    const { leila, circleId } = await household()
    await upload(leila.headers)
    const phone = await openControl(leila.accessToken)

    expect((await raiseSos(leila.headers, circleId)).statusCode).toBe(201)

    expect(await waitFor(() => watchCommands(phone.messages).length > 0)).toBe(true)
    const [command] = watchCommands(phone.messages)
    expect(command!.seconds).toBeGreaterThan(60)
    expect(command!.seconds).toBeLessThanOrEqual(120)
    phone.socket.close()
  })

  it("leaves a family member's own watch exactly as it was", async () => {
    const { mum, leila, circleId } = await household()
    await upload(leila.headers)
    const watched = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/members/${leila.user.id}/watch`,
      headers: mum.headers,
    })
    expect(watched.statusCode).toBe(200)
    const held = await storedWindow(leila.user.id)
    expect(held).not.toBeNull()

    const phone = await openControl(leila.accessToken)
    expect((await raiseSos(leila.headers, circleId)).statusCode).toBe(201)
    expect(await waitFor(() => watchCommands(phone.messages).length > 0)).toBe(true)
    const during = await upload(leila.headers)

    expect({
      stored: await storedWindow(leila.user.id),
      replied: during.watchedUntil,
      // The ask down the channel carries the longer of the two windows, so
      // the phone is not told to cut Mum's short.
      askedFor: watchCommands(phone.messages)[0]!.seconds! > 500,
    }).toEqual({ stored: held, replied: held, askedFor: true })
    phone.socket.close()
  })

  it("does not hold her on Live once she has turned the circle down", async () => {
    const { leila, circleId } = await household()
    expect((await raiseSos(leila.headers, circleId)).statusCode).toBe(201)
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circleId}/sharing`,
      headers: leila.headers,
      payload: { sharingState: "approximate" },
    })
    expect(response.statusCode).toBe(200)

    expect((await upload(leila.headers)).watchedUntil).toBeNull()
  })

  it("does not hold her on Live for a circle she has left", async () => {
    const { leila, circleId } = await household()
    expect((await raiseSos(leila.headers, circleId)).statusCode).toBe(201)
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circleId}/members/${leila.user.id}`,
      headers: leila.headers,
    })
    expect(left.statusCode).toBe(200)

    expect((await upload(leila.headers)).watchedUntil).toBeNull()
  })
})

describe("the SOS frame on an open map", () => {
  it("reads as paused, like the map, when her phone's sharing switch is off", async () => {
    const { mum, leila, circleId } = await household()
    await upload(leila.headers)
    const health = await ctx.app.inject({
      method: "PATCH",
      url: "/api/v1/me/health",
      headers: leila.headers,
      payload: { locationPermission: "always", locationServices: true, sharingEnabled: false },
    })
    expect(health.statusCode).toBe(200)
    const map = await openApp(mum.accessToken)

    expect((await raiseSos(leila.headers, circleId)).statusCode).toBe(201)
    expect(await waitFor(() => map.messages.some((m) => m.type === "sos"))).toBe(true)
    const frame = map.messages.find((m) => m.type === "sos")
    const presence = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circleId}/locations`,
      headers: mum.headers,
    })
    const row = (
      presence.json() as Array<{ userId: string; lat: number | null; sharingState: string }>
    ).find((entry) => entry.userId === leila.user.id)!

    expect({
      mapState: row.sharingState,
      frameLat: frame?.type === "sos" ? frame.alert.lastLat : "missing",
      frameFixAt: frame?.type === "sos" ? frame.alert.lastFixAt : "missing",
    }).toEqual({ mapState: "paused", frameLat: null, frameFixAt: null })
    map.socket.close()
  })
})
