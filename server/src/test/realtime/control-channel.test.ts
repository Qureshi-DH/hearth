import { createRequire } from "node:module"

import type { WsServerMessage } from "@hearth/shared"
import { sql } from "drizzle-orm"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { wakeQuietPhones } from "../../jobs/scheduler"
import { CONTROL_FRESH_MS, CONTROL_HEARTBEAT_MS } from "../../services/control"
import { registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * An awake phone keeps a control channel open, and an ask (a watch, a profile
 * opened, the sweep's wake) reaches it there at once. The silent push is for a
 * phone with nothing open.
 */

interface RawSocket {
  readyState: number
  on(event: string, listener: (...args: any[]) => void): void
  send(data: string): void
  close(): void
}

const WebSocketImpl = createRequire(import.meta.url)("ws") as new (url: string) => RawSocket

let ctx: TestContext
let origin = ""

type Headers = Record<string, string>

function connect(token: string) {
  const socket = new WebSocketImpl(`${origin}/api/v1/ws?access_token=${token}`)
  const messages: WsServerMessage[] = []
  socket.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString()) as WsServerMessage)
  })
  socket.on("error", () => {})
  const opened = new Promise<boolean>((resolve) => {
    socket.on("open", () => resolve(true))
    socket.on("close", () => resolve(false))
  })
  return { socket, messages, opened }
}

/** The phone's own channel: a socket that has declared itself the device. */
async function openControl(token: string) {
  const client = connect(token)
  expect(await client.opened).toBe(true)
  client.socket.send(JSON.stringify({ type: "control" }))
  await waitFor(() => client.messages.some((m) => m.type === "control" && m.command === "ready"))
  return client
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

const controlCommands = (messages: WsServerMessage[]) =>
  messages.flatMap((m) => (m.type === "control" && m.command !== "ready" ? [m] : []))

async function createCircle(headers: Headers) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name: "Family", emoji: "🏠" },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as { id: string; invite: { code: string } }
}

async function join(headers: Headers, code: string) {
  const response = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  expect(response.statusCode).toBe(200)
}

async function upload(headers: Headers, minutesAgo: number) {
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: {
      points: [
        {
          lat: 51.4545,
          lon: -2.5879,
          recordedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          accuracyMeters: 12,
          speedMps: 9,
          source: "background",
        },
      ],
    },
  })
  expect(response.statusCode).toBe(200)
}

async function outboxRows(type: string) {
  const rows = (await getDb().execute(
    sql`select count(*)::int as n from notification_outbox where data->>'type' = ${type}`,
  )) as unknown as Array<{ n: number }>
  return rows[0]!.n
}

/** Everything the sweep uses to decide a phone has been quiet, moved into the past. */
async function backdate(userId: string, minutes: number) {
  const at = new Date(Date.now() - minutes * 60_000).toISOString()
  await getDb().execute(
    sql`update user_presence set recorded_at = ${at}::timestamptz, last_heard_at = ${at}::timestamptz
        where user_id = ${userId}::uuid`,
  )
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

async function family() {
  const viewer = await registerUser(ctx.app)
  const driver = await registerUser(ctx.app)
  const circle = await createCircle(viewer.headers)
  await join(driver.headers, circle.invite.code)
  return { viewer, driver, circle }
}

describe("the channel's heartbeat", () => {
  it("is slow enough to spare a backgrounded phone's radio, and the stamp outlasts two of them", () => {
    // A phone answers each ping with a radio wake. Thirty a second would be
    // the on-screen socket's pace; a phone in a pocket gets a slower one.
    expect(CONTROL_HEARTBEAT_MS).toBeGreaterThanOrEqual(2 * 60 * 1000)
    expect(CONTROL_FRESH_MS).toBeGreaterThan(2 * CONTROL_HEARTBEAT_MS)
  })
})

describe("a watch over the control channel", () => {
  it("reaches the phone at once and says so, with no push spent", async () => {
    const { viewer, driver, circle } = await family()
    const phone = await openControl(driver.accessToken)

    const watch = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    expect(watch.statusCode).toBe(200)
    expect(watch.json()).toMatchObject({ watching: true, pushed: "socket" })

    expect(await waitFor(() => controlCommands(phone.messages).length > 0)).toBe(true)
    expect(controlCommands(phone.messages)[0]).toMatchObject({
      type: "control",
      command: "watch",
      seconds: 600,
    })
    expect(await outboxRows("watch")).toBe(0)
    phone.socket.close()
  })

  it("falls back to the push on the next hold when the channel ask went unanswered", async () => {
    // The stamp says the channel is open, but a socket iOS let die without a
    // close keeps its stamp for minutes. An ask that got no answer in the
    // time an answer takes is not sent down it again.
    const { viewer, driver, circle } = await family()
    const phone = await openControl(driver.accessToken)

    const first = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    expect(first.json().pushed).toBe("socket")
    expect(await waitFor(() => controlCommands(phone.messages).length === 1)).toBe(true)

    // A minute on, with nothing heard from the phone since.
    await getDb().execute(
      sql`update user_presence set watched_until = watched_until - interval '60 seconds'
          where user_id = ${driver.user.id}::uuid`,
    )
    const hold = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    // The test server has no push provider; what matters is that the channel
    // was not trusted again.
    expect(hold.json().pushed).toBe("unsupported")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(controlCommands(phone.messages)).toHaveLength(1)
    phone.socket.close()
  })

  it("keeps using the channel across holds while the phone is answering", async () => {
    const { viewer, driver, circle } = await family()
    const phone = await openControl(driver.accessToken)
    const watch = () =>
      ctx.app.inject({
        method: "POST",
        url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
        headers: viewer.headers,
      })
    expect((await watch()).json().pushed).toBe("socket")
    await getDb().execute(
      sql`update user_presence set watched_until = watched_until - interval '60 seconds'
          where user_id = ${driver.user.id}::uuid`,
    )
    // The phone answered: an upload since the ask.
    await upload(driver.headers, 0)
    expect((await watch()).json().pushed).toBe("socket")
    phone.socket.close()
  })

  it("is not delivered to the viewer's own sockets, nor to a plain one of the phone's", async () => {
    const { viewer, driver, circle } = await family()
    const viewerSocket = connect(viewer.accessToken)
    const plain = connect(driver.accessToken)
    expect(await viewerSocket.opened).toBe(true)
    expect(await plain.opened).toBe(true)

    const watch = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    expect(watch.json().pushed).not.toBe("socket")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(controlCommands(viewerSocket.messages)).toHaveLength(0)
    expect(controlCommands(plain.messages)).toHaveLength(0)
    viewerSocket.socket.close()
    plain.socket.close()
  })

  it("stops counting a channel that has closed", async () => {
    const { viewer, driver, circle } = await family()
    const phone = await openControl(driver.accessToken)
    phone.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 150))

    const watch = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/watch`,
      headers: viewer.headers,
    })
    expect(watch.json().pushed).not.toBe("socket")
  })
})

describe("a profile opened", () => {
  it("asks the phone for one fix over the channel", async () => {
    const { viewer, driver, circle } = await family()
    const phone = await openControl(driver.accessToken)

    const ask = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/refresh`,
      headers: viewer.headers,
    })
    expect(ask.statusCode).toBe(200)
    expect(ask.json()).toEqual({ asked: "socket" })

    expect(await waitFor(() => controlCommands(phone.messages).length > 0)).toBe(true)
    expect(controlCommands(phone.messages)[0]).toMatchObject({ type: "control", command: "wake" })
    phone.socket.close()
  })

  it("does not ask a phone heard from in the last half minute", async () => {
    const { viewer, driver, circle } = await family()
    await upload(driver.headers, 0)
    const phone = await openControl(driver.accessToken)

    const ask = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/refresh`,
      headers: viewer.headers,
    })
    expect(ask.json()).toEqual({ asked: "fresh" })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(controlCommands(phone.messages)).toHaveLength(0)
    phone.socket.close()
  })

  it("says so when the phone has no channel and cannot be pushed", async () => {
    const { viewer, driver, circle } = await family()
    const ask = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circle.id}/members/${driver.user.id}/refresh`,
      headers: viewer.headers,
    })
    // The test server has no push provider.
    expect(ask.json()).toEqual({ asked: "unsupported" })
  })
})

describe("the sweep's wake", () => {
  it("goes over the channel to a phone that has one, whatever the push provider", async () => {
    const { driver } = await family()
    await upload(driver.headers, 0)
    await backdate(driver.user.id, 12)
    const phone = await openControl(driver.accessToken)

    const woken = await wakeQuietPhones(getDb(), null)
    expect(woken).toBe(1)
    expect(await waitFor(() => controlCommands(phone.messages).length > 0)).toBe(true)
    expect(controlCommands(phone.messages)[0]).toMatchObject({ type: "control", command: "wake" })
    expect(await outboxRows("wake")).toBe(0)
    phone.socket.close()
  })
})
