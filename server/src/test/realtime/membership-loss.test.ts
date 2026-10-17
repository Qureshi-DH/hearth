import { createRequire } from "node:module"

import type { WsServerMessage } from "@hearth/shared"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createCircle, joinCircle, registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * A circle the app no longer belongs to, because somebody removed it or the
 * circle was deleted, has to be said over the socket. The app otherwise
 * keeps polling it, and every poll is a 403 that a firewall in front of a
 * home server can answer by locking every phone in the house out.
 */

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

/** Alice owns two circles and Bob is in both, with his app open. */
async function bobConnected() {
  const alice = await registerUser(ctx.app, { displayName: "Alice" })
  const bob = await registerUser(ctx.app, { displayName: "Bob" })
  const family = await createCircle(ctx.app, alice.headers, "Family")
  const school = await createCircle(ctx.app, alice.headers, "School run")
  await joinCircle(ctx.app, bob.headers, family.invite.code)
  await joinCircle(ctx.app, bob.headers, school.invite.code)
  const client = connect(bob.accessToken)
  expect(await client.opened).toBe(true)
  expect(
    await waitFor(() =>
      client.messages.some(
        (message) => message.type === "subscribed" && message.circleIds.length === 2,
      ),
    ),
  ).toBe(true)
  return { alice, bob, family, school, client }
}

const lastSubscribed = (client: Client) =>
  client.messages
    .filter(
      (message): message is Extract<WsServerMessage, { type: "subscribed" }> =>
        message.type === "subscribed",
    )
    .at(-1)?.circleIds

describe("losing a circle while the app is open", () => {
  it("is told over the socket when the circle is deleted", async () => {
    const { alice, school, family, client } = await bobConnected()

    const deleted = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${school.id}`,
      headers: alice.headers,
    })
    expect(deleted.statusCode).toBe(200)

    expect(await waitFor(() => lastSubscribed(client)?.length === 1)).toBe(true)
    expect(lastSubscribed(client)).toEqual([family.id])
    client.socket.close()
  })

  it("is told over the socket when somebody removes them", async () => {
    const { alice, bob, school, family, client } = await bobConnected()

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/circles/${school.id}/members/${bob.user.id}`,
      headers: alice.headers,
    })
    expect(removed.statusCode).toBe(200)

    expect(await waitFor(() => lastSubscribed(client)?.length === 1)).toBe(true)
    expect(lastSubscribed(client)).toEqual([family.id])
    client.socket.close()
  })
})
