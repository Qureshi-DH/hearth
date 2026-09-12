import { createRequire } from "node:module"

import type { WsServerMessage } from "@hearth/shared"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { openEnvelope, sealEnvelope, userTopic } from "../../lib/bus"
import { getBus } from "../../runtime"
import { registerUser, sessionIdOf, startTestApp, type TestContext } from "../helpers"

/**
 * `ws` ships with @fastify/websocket but has no type package here, so the
 * handful of members these specs use are declared rather than pulled in.
 */
interface RawSocket {
  readyState: number
  on(event: "open", listener: () => void): void
  on(event: "message", listener: (data: Buffer) => void): void
  on(event: "close", listener: (code: number) => void): void
  on(event: "error", listener: (error: Error) => void): void
  send(data: string): void
  close(): void
}

const WebSocketImpl = createRequire(import.meta.url)("ws") as new (url: string) => RawSocket

interface Client {
  socket: RawSocket
  messages: WsServerMessage[]
  opened: Promise<boolean>
  closeCode(): number | null
  isOpen(): boolean
}

let ctx: TestContext
let origin: string

function connect(token: string): Client {
  const socket = new WebSocketImpl(`${origin}/api/v1/ws?access_token=${token}`)
  const messages: WsServerMessage[] = []
  let closeCode: number | null = null

  socket.on("message", (data) => {
    messages.push(JSON.parse(data.toString()) as WsServerMessage)
  })
  socket.on("close", (code) => {
    closeCode = code
  })
  // Without a listener, ws re-throws connection errors on the process.
  socket.on("error", () => {})

  const opened = new Promise<boolean>((resolve) => {
    socket.on("open", () => resolve(true))
    socket.on("close", () => resolve(false))
  })

  return {
    socket,
    messages,
    opened,
    closeCode: () => closeCode,
    isOpen: () => socket.readyState === 1,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

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

describe("websocket frame handling", () => {
  it("rejects hostile frames instead of taking the process down", async () => {
    const bob = await registerUser(ctx.app)
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    await waitFor(() => client.messages.some((message) => message.type === "hello"))

    // circleIds: 5 is the frame that crashed the server. `new Set(5)` throws
    // synchronously inside the ws listener, which is an uncaughtException.
    const hostile = [
      '{"type":"subscribe","circleIds":5}',
      '{"type":"subscribe","circleIds":{}}',
      '{"type":"subscribe","circleIds":true}',
      '{"type":"subscribe","circleIds":"c1"}',
      '{"type":"subscribe"}',
      '{"type":"subscribe","circleIds":[1,2]}',
      '{"type":42}',
      "null",
      "[]",
      "not json at all",
    ]
    for (const frame of hostile) client.socket.send(frame)

    const errors = () => client.messages.filter((message) => message.type === "error")
    expect(await waitFor(() => errors().length === hostile.length)).toBe(true)
    expect(client.isOpen()).toBe(true)

    // The socket still works, and so does the rest of the server.
    client.socket.send(JSON.stringify({ type: "ping" }))
    expect(await waitFor(() => client.messages.some((m) => m.type === "pong"))).toBe(true)

    const me = await ctx.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: bob.headers })
    expect(me.statusCode).toBe(200)

    client.socket.close()
  })

  it("honours a frame sent before the connect priming has finished", async () => {
    const bob = await registerUser(ctx.app)
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: bob.headers,
      payload: { name: "Home" },
    })

    // Sent in the same tick the socket opens, which lands while the server is
    // still loading memberships and priming presence.
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    client.socket.send(JSON.stringify({ type: "ping" }))

    expect(await waitFor(() => client.messages.some((m) => m.type === "pong"))).toBe(true)

    client.socket.close()
  })

  it("still narrows a subscription to circles the member belongs to", async () => {
    const bob = await registerUser(ctx.app)
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: bob.headers,
      payload: { name: "Home" },
    })
    const circleId = (created.json() as { id: string }).id

    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    await waitFor(() => client.messages.some((message) => message.type === "hello"))

    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        circleIds: [circleId, "00000000-0000-0000-0000-000000000000"],
      }),
    )

    const subscribedFrames = () =>
      client.messages.filter(
        (message): message is Extract<WsServerMessage, { type: "subscribed" }> =>
          message.type === "subscribed",
      )
    expect(await waitFor(() => subscribedFrames().length >= 2)).toBe(true)
    expect(subscribedFrames().at(-1)?.circleIds).toEqual([circleId])

    client.socket.close()
  })
})

describe("websocket session revocation", () => {
  it("refuses a socket for a signed-out session", async () => {
    const bob = await registerUser(ctx.app)

    const loggedOut = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: bob.headers,
    })
    expect(loggedOut.statusCode).toBe(200)

    // The upgrade itself succeeds, so what matters is that the socket is closed
    // before a single frame is sent, not that the handshake was refused.
    const client = connect(bob.accessToken)
    await client.opened
    expect(await waitFor(() => !client.isOpen())).toBe(true)
    expect(client.closeCode()).toBe(4401)
    expect(client.messages).toEqual([])
  })

  it("refuses a socket for a deactivated account", async () => {
    // The first account registered on an empty server is the administrator.
    const admin = await registerUser(ctx.app)
    const bob = await registerUser(ctx.app)

    const deactivated = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${bob.user.id}`,
      headers: admin.headers,
      payload: { isActive: false },
    })
    expect(deactivated.statusCode).toBe(200)

    const client = connect(bob.accessToken)
    await client.opened
    expect(await waitFor(() => !client.isOpen())).toBe(true)
    expect(client.closeCode()).toBe(4401)
    expect(client.messages).toEqual([])
  })

  it("closes an open socket the moment its session is revoked", async () => {
    const bob = await registerUser(ctx.app)
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    await waitFor(() => client.messages.some((message) => message.type === "hello"))

    await getBus()?.publish(userTopic(bob.user.id), {
      type: "session_revoked",
      sessionId: sessionIdOf(bob.accessToken),
    })

    expect(await waitFor(() => !client.isOpen())).toBe(true)
    expect(client.closeCode()).toBe(4401)
  })

  it("leaves a socket alone when another session of the same account is revoked", async () => {
    const bob = await registerUser(ctx.app)
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)

    await getBus()?.publish(userTopic(bob.user.id), {
      type: "session_revoked",
      sessionId: "00000000-0000-0000-0000-000000000000",
    })

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(client.isOpen()).toBe(true)

    client.socket.close()
  })
})

describe("websocket connection cap", () => {
  it("bounds how many sockets one account can hold open", async () => {
    const bob = await registerUser(ctx.app)
    const clients: Client[] = []
    for (let index = 0; index < 20; index += 1) {
      const client = connect(bob.accessToken)
      await client.opened
      clients.push(client)
    }

    expect(
      await waitFor(() => clients.filter((client) => client.isOpen()).length === 12, 10_000),
    ).toBe(true)

    const evicted = clients.filter((client) => !client.isOpen())
    expect(evicted).toHaveLength(8)
    // 4429, not 4401, so the client backs off and reconnects instead of
    // concluding its token is dead.
    for (const client of evicted) expect(client.closeCode()).toBe(4429)

    // The newcomer is the one that survives, which is what keeps a phone
    // reconnecting through a bad network from being locked out by the sockets
    // it abandoned.
    const latecomer = connect(bob.accessToken)
    expect(await latecomer.opened).toBe(true)
    expect(await waitFor(() => latecomer.messages.some((m) => m.type === "hello"))).toBe(true)
    expect(clients.filter((client) => client.isOpen()).length + 1).toBe(12)

    latecomer.socket.close()
    for (const client of clients) client.socket.close()
  })
})

describe("realtime bus envelopes", () => {
  const key = Buffer.alloc(32, 7)

  it("round-trips an envelope", () => {
    const envelope = { topic: "circle:abc", payload: { type: "location", lat: 51.5 } }
    expect(openEnvelope(key, sealEnvelope(key, envelope))).toEqual(envelope)
  })

  it("rejects a plain JSON envelope published by anything else on the channel", () => {
    const forged = JSON.stringify({
      topic: "circle:abc",
      payload: {
        type: "location",
        raw: { rows: [{ userId: "dave", sharingState: "precise", lat: 12.3, lon: -98.7 }] },
      },
    })
    expect(openEnvelope(key, forged)).toBeNull()
  })

  it("rejects an envelope sealed with a different server secret", () => {
    const other = Buffer.alloc(32, 9)
    expect(openEnvelope(key, sealEnvelope(other, { topic: "circle:abc", payload: {} }))).toBeNull()
  })

  it("rejects a tampered frame", () => {
    const frame = sealEnvelope(key, { topic: "circle:abc", payload: { type: "location" } })
    const [version, iv, tag, body] = frame.split(".")
    const flipped = Buffer.from(body ?? "", "base64url")
    flipped[0] = (flipped[0] ?? 0) ^ 0xff
    expect(
      openEnvelope(key, [version, iv, tag, flipped.toString("base64url")].join(".")),
    ).toBeNull()
  })
})

describe("websocket frame budget", () => {
  it("closes a socket that floods frames", async () => {
    const bob = await registerUser(ctx.app)
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)

    for (let n = 0; n < 200; n += 1) client.socket.send(JSON.stringify({ type: "ping" }))

    expect(await waitFor(() => client.closeCode() !== null)).toBe(true)
    expect(client.closeCode()).toBe(1008)
  })
})

describe("location frames for a paused member", () => {
  it("are not sent again while nothing a paused circle may see has changed", async () => {
    const parent = await registerUser(ctx.app)
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: parent.headers,
      payload: { name: "Family", emoji: "🏠" },
    })
    const circle = created.json() as { id: string; invite: { code: string } }
    const teen = await registerUser(ctx.app, { inviteCode: circle.invite.code })
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circle.id}/sharing`,
      headers: teen.headers,
      payload: { sharingState: "paused" },
    })

    const watcher = connect(parent.accessToken)
    expect(await watcher.opened).toBe(true)
    expect(await waitFor(() => watcher.messages.some((m) => m.type === "subscribed"))).toBe(true)

    for (let n = 0; n < 4; n += 1) {
      await ctx.app.inject({
        method: "POST",
        url: "/api/v1/locations/batch",
        headers: teen.headers,
        payload: {
          points: [
            {
              lat: 51.4545 + n * 0.001,
              lon: -2.5879,
              recordedAt: new Date(Date.now() - (4 - n) * 1000).toISOString(),
              accuracyMeters: 8,
            },
          ],
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 300))

    const aboutTeen = watcher.messages.filter(
      (m) => m.type === "location" && m.presence.userId === teen.user.id,
    )
    expect(aboutTeen.length).toBeLessThanOrEqual(1)
    watcher.socket.close()
  })
})
