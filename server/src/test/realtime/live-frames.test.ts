import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"

import type { MemberPresence, TrailFix, WsServerMessage } from "@hearth/shared"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import {
  createCircle,
  joinCircle,
  registerUser,
  setSharing,
  startTestApp,
  type TestContext,
} from "../helpers"

/**
 * A viewer who sees somebody precisely is handed every fix of each upload,
 * so a Live trail is the road they took and not one point per upload, and a
 * Live page coming back from a dropped socket fills the hole it missed. A
 * circle that sees them approximately is told only when the coarse cell
 * changes, on a coarse clock, and never sees a fix.
 */

interface RawSocket {
  on(event: string, listener: (...args: any[]) => void): void
  send(data: string): void
  close(): void
}

const WebSocketImpl = createRequire(import.meta.url)("ws") as new (url: string) => RawSocket

const METRES_PER_DEGREE_LAT = (Math.PI * 6_371_008.8) / 180
const STREET = { lat: 51.4545, lon: -2.5879 }
const northOf = (metres: number) => ({
  lat: STREET.lat + metres / METRES_PER_DEGREE_LAT,
  lon: STREET.lon,
})

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

const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

async function upload(headers: Headers, points: Array<Record<string, unknown>>) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  expect(response.statusCode).toBe(200)
}

async function family() {
  const viewer = await registerUser(ctx.app)
  const member = await registerUser(ctx.app, { deviceId: "pocket-phone" })
  const circle = await createCircle(ctx.app, viewer.headers)
  await joinCircle(ctx.app, member.headers, circle.invite.code)
  // Joined a while ago, so the fixes below are ones the circle may see.
  await getDb().execute(
    sql`update circle_members set created_at = now() - interval '2 hours'
        where user_id = ${member.user.id}::uuid`,
  )
  const trail = async (since: string, headers: Headers = viewer.headers) => {
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/members/${member.user.id}/live-trail`,
      query: { since },
      headers,
    })
    expect(response.statusCode).toBe(200)
    return response.json() as TrailFix[]
  }
  return { viewer, member, circle, trail }
}

const framesAbout = (messages: WsServerMessage[], userId: string) =>
  messages.flatMap((m) => (m.type === "location" && m.presence.userId === userId ? [m] : []))

describe("location frames", () => {
  it("carry every fix of an upload to a viewer who sees the member precisely", async () => {
    const { viewer, member } = await family()
    const app = await openApp(viewer.accessToken)

    await upload(member.headers, [
      { ...northOf(0), recordedAt: secondsAgo(3), accuracyMeters: 6 },
      { ...northOf(12), recordedAt: secondsAgo(2), accuracyMeters: 7 },
      { ...northOf(24), recordedAt: secondsAgo(1), accuracyMeters: 5 },
    ])

    expect(await waitFor(() => framesAbout(app.messages, member.user.id).length > 0)).toBe(true)
    const [frame] = framesAbout(app.messages, member.user.id)
    expect(frame!.fixes).toHaveLength(3)
    expect(frame!.fixes!.map((fix) => fix.accuracyMeters)).toEqual([6, 7, 5])
    expect(frame!.fixes![2]).toMatchObject({ ...northOf(24) })
    app.socket.close()
  })

  it("never carry a fix to a circle that sees the member approximately", async () => {
    const { viewer, member, circle } = await family()
    await setSharing(ctx.app, member.headers, circle.id, "approximate")
    const app = await openApp(viewer.accessToken)

    await upload(member.headers, [
      { ...northOf(0), recordedAt: secondsAgo(2), accuracyMeters: 6 },
      { ...northOf(12), recordedAt: secondsAgo(1), accuracyMeters: 7 },
    ])
    await waitFor(() => framesAbout(app.messages, member.user.id).length > 0, 500)
    for (const frame of framesAbout(app.messages, member.user.id)) {
      expect(frame.fixes).toBeUndefined()
    }
    app.socket.close()
  })

  // A fix a second while somebody else watches would otherwise tell an
  // approximate circle the moment the person crossed each grid line.
  it("go to an approximate circle only when the coarse cell changes", async () => {
    const { viewer, member, circle } = await family()
    await setSharing(ctx.app, member.headers, circle.id, "approximate")
    const app = await openApp(viewer.accessToken)

    for (let n = 0; n < 8; n += 1) {
      await upload(member.headers, [
        { ...northOf(n), recordedAt: secondsAgo(8 - n), accuracyMeters: 6 },
      ])
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    // One, or two when the coarse clock turned over during the test.
    expect(framesAbout(app.messages, member.user.id).length).toBeLessThanOrEqual(2)

    const before = framesAbout(app.messages, member.user.id).length
    await upload(member.headers, [
      { ...northOf(3_000), recordedAt: new Date().toISOString(), accuracyMeters: 6 },
    ])
    expect(
      await waitFor(() => framesAbout(app.messages, member.user.id).length === before + 1),
    ).toBe(true)
    app.socket.close()
  })

  it("show an approximate circle the time on a coarse clock", async () => {
    const { viewer, member, circle } = await family()
    await setSharing(ctx.app, member.headers, circle.id, "approximate")
    const at = new Date()
    await upload(member.headers, [{ ...STREET, recordedAt: at.toISOString(), accuracyMeters: 6 }])

    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/v1/circles/${circle.id}/locations`,
      headers: viewer.headers,
    })
    const seen = (response.json() as MemberPresence[]).find((p) => p.userId === member.user.id)!
    const shown = Date.parse(seen.recordedAt!)
    expect(shown % (5 * 60 * 1000)).toBe(0)
    expect(shown).toBeLessThanOrEqual(at.getTime())
    expect(at.getTime() - shown).toBeLessThan(5 * 60 * 1000)
    // Fresh, whatever the clock it is shown on says.
    expect(seen.stale).toBe(false)
  })
})

describe("filling a Live trail", () => {
  it("hands back the fixes since a moment, oldest first", async () => {
    const { member, trail } = await family()
    await upload(member.headers, [
      { ...northOf(0), recordedAt: secondsAgo(30), accuracyMeters: 6 },
      { ...northOf(10), recordedAt: secondsAgo(20), accuracyMeters: 6 },
      { ...northOf(20), recordedAt: secondsAgo(10), accuracyMeters: 6 },
    ])
    const points = await trail(secondsAgo(25))
    expect(points.map((point) => point.lat)).toEqual([northOf(10).lat, northOf(20).lat])
  })

  it("works in a circle with history turned off, for the watch window only", async () => {
    const { viewer, member, circle, trail } = await family()
    const settings = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}`,
      headers: viewer.headers,
      payload: { settings: { allowHistory: false } },
    })
    expect(settings.statusCode).toBe(200)
    await upload(member.headers, [
      { ...northOf(0), recordedAt: secondsAgo(20 * 60), accuracyMeters: 6 },
      { ...northOf(10), recordedAt: secondsAgo(60), accuracyMeters: 6 },
    ])
    const points = await trail(secondsAgo(60 * 60))
    expect(points.map((point) => point.lat)).toEqual([northOf(10).lat])
  })

  it("is empty for a circle that sees the member approximately or not at all", async () => {
    const { member, circle, trail } = await family()
    await upload(member.headers, [{ ...STREET, recordedAt: secondsAgo(10), accuracyMeters: 6 }])
    await setSharing(ctx.app, member.headers, circle.id, "approximate")
    expect(await trail(secondsAgo(60))).toEqual([])
    await setSharing(ctx.app, member.headers, circle.id, "paused")
    expect(await trail(secondsAgo(60))).toEqual([])
  })

  it("follows the device the map follows", async () => {
    const { member, trail } = await family()
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: member.email,
        password: "correct-horse-battery",
        device: { deviceId: "kitchen-tablet", deviceName: "Tablet", platform: "android" },
      },
    })
    const tablet = {
      authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}`,
    }
    await upload(member.headers, [
      { ...northOf(500), recordedAt: secondsAgo(20), accuracyMeters: 6, activity: "driving" },
    ])
    await upload(tablet, [
      { ...STREET, recordedAt: secondsAgo(10), accuracyMeters: 20, activity: "still" },
    ])
    const points = await trail(secondsAgo(60))
    expect(points.map((point) => point.lat)).toEqual([northOf(500).lat])
  })

  it("hands members their own", async () => {
    const { member, trail } = await family()
    await upload(member.headers, [{ ...STREET, recordedAt: secondsAgo(10), accuracyMeters: 6 }])
    expect((await trail(secondsAgo(60), member.headers)).length).toBe(1)
  })
})
