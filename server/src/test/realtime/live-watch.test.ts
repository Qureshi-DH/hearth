import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"

import type { WatchResponse, WsServerMessage } from "@hearth/shared"
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
 * A watch is held per viewer. Each viewer's Live page holds its own, a viewer
 * who leaves takes only their own away, and the last one out ends the window
 * on the phone within seconds, by its next upload reply and down its control
 * channel. Turning the circle down to approximate or pausing ends it too. An
 * open SOS keeps the phone on Live whoever leaves.
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

/** The phone's own channel. It acknowledges every ask, as the app does. */
async function openControl(token: string) {
  const socket = new WebSocketImpl(`${origin}/api/v1/ws?access_token=${token}`)
  const messages: WsServerMessage[] = []
  socket.on("message", (data: Buffer) => {
    const message = JSON.parse(data.toString()) as WsServerMessage
    messages.push(message)
    if (message.type === "control" && message.ask) {
      socket.send(JSON.stringify({ type: "control", ack: message.ask }))
    }
  })
  socket.on("error", () => {})
  await new Promise<void>((resolve) => socket.on("open", () => resolve()))
  socket.send(JSON.stringify({ type: "control" }))
  await waitFor(() => messages.some((m) => m.type === "control" && m.command === "ready"))
  return { socket, messages }
}

const watchCommands = (messages: WsServerMessage[]) =>
  messages.flatMap((m) => (m.type === "control" && m.command === "watch" ? [m] : []))

async function family() {
  const first = await registerUser(ctx.app)
  const second = await registerUser(ctx.app)
  const member = await registerUser(ctx.app)
  const circle = await createCircle(ctx.app, first.headers)
  await joinCircle(ctx.app, second.headers, circle.invite.code)
  await joinCircle(ctx.app, member.headers, circle.invite.code)
  const path = `/api/v1/circles/${circle.id}/members/${member.user.id}/watch`
  const watch = async (headers: Headers) => {
    const response = await ctx.app.inject({ method: "POST", url: path, headers })
    expect(response.statusCode).toBe(200)
    return response.json() as WatchResponse
  }
  const release = async (headers: Headers) => {
    const response = await ctx.app.inject({ method: "DELETE", url: path, headers })
    expect(response.statusCode).toBe(200)
    return response.json() as { ok: true }
  }
  /** What the phone reads off its next upload. */
  const reply = async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers: member.headers,
      payload: {
        points: [{ ...STREET, recordedAt: new Date().toISOString(), accuracyMeters: 8 }],
      },
    })
    expect(response.statusCode).toBe(200)
    return (response.json() as { watchedUntil: string | null }).watchedUntil
  }
  return { first, second, member, circle, watch, release, reply }
}

describe("a watch held per viewer", () => {
  it("says the server takes a release and fills a trail", async () => {
    const { first, watch } = await family()
    expect((await watch(first.headers)).supports).toEqual({ release: true, trail: true })
  })

  it("stays open while another viewer still holds it, and ends with the last one out", async () => {
    const { first, second, watch, release, reply } = await family()
    await watch(first.headers)
    await watch(second.headers)

    await release(first.headers)
    expect(await reply()).not.toBeNull()

    await release(second.headers)
    expect(await reply()).toBeNull()
  })

  it("tells the phone down its channel that the window ended", async () => {
    const { first, member, watch, release } = await family()
    const phone = await openControl(member.accessToken)
    await watch(first.headers)
    expect(await waitFor(() => watchCommands(phone.messages).length === 1)).toBe(true)

    await release(first.headers)
    expect(await waitFor(() => watchCommands(phone.messages).length === 2)).toBe(true)
    expect(watchCommands(phone.messages)[1]).toMatchObject({ command: "watch", seconds: 0 })
    phone.socket.close()
  })

  it("leaves the phone alone while somebody else still watches", async () => {
    const { first, second, member, watch, release } = await family()
    const phone = await openControl(member.accessToken)
    await watch(first.headers)
    await watch(second.headers)
    await release(first.headers)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(watchCommands(phone.messages).every((m) => (m.seconds ?? 0) > 0)).toBe(true)
    phone.socket.close()
  })

  it("keeps an open SOS on Live when the last viewer leaves", async () => {
    const { first, member, circle, watch, release, reply } = await family()
    const sos = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/sos`,
      headers: member.headers,
      payload: { note: null },
    })
    expect(sos.statusCode).toBe(201)
    const phone = await openControl(member.accessToken)
    await watch(first.headers)
    await release(first.headers)

    expect(await reply()).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(watchCommands(phone.messages).every((m) => (m.seconds ?? 0) > 0)).toBe(true)
    phone.socket.close()
  })

  it.each(["approximate", "paused"] as const)(
    "ends when the member turns the circle to %s",
    async (state) => {
      const { first, member, circle, watch, reply } = await family()
      const phone = await openControl(member.accessToken)
      await watch(first.headers)

      await setSharing(ctx.app, member.headers, circle.id, state)
      expect(await reply()).toBeNull()
      expect(await waitFor(() => watchCommands(phone.messages).some((m) => m.seconds === 0))).toBe(
        true,
      )
      phone.socket.close()
    },
  )

  it("ends the hold of a viewer who leaves the circle", async () => {
    const { first, second, circle, watch, reply } = await family()
    await watch(second.headers)
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${second.user.id}`,
      headers: second.headers,
    })
    expect(left.statusCode).toBe(200)
    expect(await reply()).toBeNull()
    // Somebody else asking again is a fresh window.
    await watch(first.headers)
    expect(await reply()).not.toBeNull()
  })

  // The Live page holds every minute, and one left open on the phone of
  // somebody just removed from the circle would otherwise be refused each
  // time, a 4xx a firewall can answer by locking the household out.
  it("tells a viewer who left the circle there is nothing to watch", async () => {
    const { second, circle, watch } = await family()
    await watch(second.headers)
    const left = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${second.user.id}`,
      headers: second.headers,
    })
    expect(left.statusCode).toBe(200)
    expect((await watch(second.headers)).watching).toBe(false)
  })

  // A release goes out as a page closes, whatever has happened meanwhile, and
  // a 4xx in ordinary use can lock the household out at a firewall.
  it("is never refused", async () => {
    const { first, member, circle, release } = await family()
    await release(first.headers)
    const self = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${member.user.id}/watch`,
      headers: member.headers,
    })
    expect(self.statusCode).toBe(200)
    const stranger = await registerUser(ctx.app)
    const outside = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${circle.id}/members/${member.user.id}/watch`,
      headers: stranger.headers,
    })
    expect(outside.statusCode).toBe(200)
  })

  it("keeps one row per viewer however often they hold", async () => {
    const { first, member, watch } = await family()
    await watch(first.headers)
    await watch(first.headers)
    await watch(first.headers)
    const rows = (await getDb().execute(
      sql`select count(*)::int as n from live_watches where user_id = ${member.user.id}::uuid`,
    )) as unknown as Array<{ n: number }>
    expect(rows[0]!.n).toBe(1)
  })
})
