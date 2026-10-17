import { sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { getDb } from "../../db/client"
import { getConfig, type AppConfig } from "../../env"
import { runJobs } from "../../jobs/scheduler"
import { getPushDriver, setRuntime } from "../../runtime"
import {
  checkPushReceipts,
  createPushDriver,
  drainOutbox,
  enqueuePush,
  type PushDriver,
} from "../../services/push"
import { clearOutbox, enablePush, registerUser, startTestApp, type TestContext } from "../helpers"

/**
 * Expo answers a send with a ticket. Whether APNs or FCM then took it, and
 * so whether the app is still installed, is in the receipt read later.
 */

let ctx: TestContext
const original = { driver: null as PushDriver | null }

beforeAll(async () => {
  ctx = await startTestApp()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
  original.driver = getPushDriver()
})

afterEach(() => {
  setRuntime({ pushDriver: original.driver })
  vi.unstubAllGlobals()
})

interface Call {
  url: string
  headers: Record<string, string>
  body: unknown
}

/**
 * Expo, as far as the server can tell. A send gets the next ticket id, and
 * a receipt request is answered from `receipts`, or turned down outright.
 */
function stubExpo(
  options: {
    receipts?: Record<string, { status: string; details?: { error: string } }>
    receiptStatus?: number
  } = {},
) {
  const calls: Call[] = []
  let ticket = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as unknown
      calls.push({ url, headers: init.headers, body })
      if (url.endsWith("/push/send")) {
        ticket += 1
        return Response.json({ data: [{ status: "ok", id: `ticket-${ticket}` }] })
      }
      if (options.receiptStatus && options.receiptStatus !== 200) {
        return new Response("no", { status: options.receiptStatus })
      }
      const ids = (body as { ids: string[] }).ids
      const answer = Object.fromEntries(
        ids.flatMap((id) => (options.receipts?.[id] ? [[id, options.receipts[id]]] : [])),
      )
      return Response.json({ data: answer })
    }),
  )
  return calls
}

const expo = (extra: Record<string, string> = {}) =>
  createPushDriver({ PUSH_PROVIDER: "expo", ...extra } as unknown as AppConfig)

const receiptCalls = (calls: Call[]) => calls.filter((call) => call.url.endsWith("/getReceipts"))

async function phoneWithToken(token: string) {
  const user = await registerUser(ctx.app)
  await enablePush(user.user.id, token)
  const [session] = (await getDb().execute(
    sql`select id from sessions where user_id = ${user.user.id}::uuid`,
  )) as unknown as Array<{ id: string }>
  return { user, sessionId: session!.id }
}

async function addTicket(id: string, sessionId: string, token: string, minutesAgo: number) {
  await getDb().execute(
    sql`insert into push_tickets (id, session_id, token, created_at)
        values (${id}, ${sessionId}::uuid, ${token}, now() - make_interval(mins => ${minutesAgo}))`,
  )
}

async function ticketIds(): Promise<string[]> {
  const rows = (await getDb().execute(
    sql`select id from push_tickets order by id`,
  )) as unknown as Array<{ id: string }>
  return rows.map((row) => row.id)
}

async function tokenOf(sessionId: string): Promise<string | null> {
  const [row] = (await getDb().execute(
    sql`select push_token from sessions where id = ${sessionId}::uuid`,
  )) as unknown as Array<{ push_token: string | null }>
  return row!.push_token
}

describe("the ticket a send leaves behind", () => {
  it("is kept with the session and the token the push went to", async () => {
    stubExpo()
    const { user, sessionId } = await phoneWithToken("ExponentPushToken[parent]")
    await clearOutbox()
    await enqueuePush(getDb(), [
      { userId: user.user.id, title: "Hearth", body: "Notifications are working." },
    ])

    await drainOutbox(getDb(), expo(), { now: new Date(Date.now() + 2000) })

    const rows = (await getDb().execute(
      sql`select id, session_id, token from push_tickets`,
    )) as unknown as Array<{ id: string; session_id: string; token: string }>
    expect(rows).toEqual([
      { id: "ticket-1", session_id: sessionId, token: "ExponentPushToken[parent]" },
    ])
  })
})

describe("reading receipts", () => {
  it("clears the token of a phone Expo says the app is no longer on", async () => {
    const calls = stubExpo({
      receipts: { "ticket-a": { status: "error", details: { error: "DeviceNotRegistered" } } },
    })
    const { sessionId } = await phoneWithToken("ExponentPushToken[gone]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[gone]", 60)

    const outcome = await checkPushReceipts(getDb(), expo())

    expect(outcome).toEqual({ read: 1, cleared: 1 })
    expect(await tokenOf(sessionId)).toBeNull()
    expect(await ticketIds()).toEqual([])
    expect(receiptCalls(calls)[0]!.body).toEqual({ ids: ["ticket-a"] })
  })

  it("leaves alone a token the phone registered after the push went out", async () => {
    stubExpo({
      receipts: { "ticket-a": { status: "error", details: { error: "DeviceNotRegistered" } } },
    })
    const { sessionId } = await phoneWithToken("ExponentPushToken[new]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[old]", 60)

    await checkPushReceipts(getDb(), expo())

    expect(await tokenOf(sessionId)).toBe("ExponentPushToken[new]")
    expect(await ticketIds()).toEqual([])
  })

  it("keeps a token whose receipt went through, or failed for another reason", async () => {
    stubExpo({
      receipts: {
        "ticket-a": { status: "ok" },
        "ticket-b": { status: "error", details: { error: "MessageRateExceeded" } },
      },
    })
    const { sessionId } = await phoneWithToken("ExponentPushToken[alive]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[alive]", 60)
    await addTicket("ticket-b", sessionId, "ExponentPushToken[alive]", 60)

    expect(await checkPushReceipts(getDb(), expo())).toEqual({ read: 2, cleared: 0 })
    expect(await tokenOf(sessionId)).toBe("ExponentPushToken[alive]")
    expect(await ticketIds()).toEqual([])
  })

  it("keeps a ticket that has no receipt yet, and lets one over a day old go unasked", async () => {
    const calls = stubExpo({ receipts: { "ticket-read": { status: "ok" } } })
    const { sessionId } = await phoneWithToken("ExponentPushToken[x]")
    await addTicket("ticket-read", sessionId, "ExponentPushToken[x]", 60)
    await addTicket("ticket-waiting", sessionId, "ExponentPushToken[x]", 50)
    await addTicket("ticket-ancient", sessionId, "ExponentPushToken[x]", 25 * 60)

    await checkPushReceipts(getDb(), expo())

    expect(await ticketIds()).toEqual(["ticket-waiting"])
    const asked = receiptCalls(calls).flatMap((call) => (call.body as { ids: string[] }).ids)
    expect(asked).not.toContain("ticket-ancient")
    // The one without a receipt is not asked about twice in one pass.
    expect(receiptCalls(calls)).toHaveLength(1)
  })

  it("does not ask about a ticket too new to have a receipt", async () => {
    const calls = stubExpo()
    const { sessionId } = await phoneWithToken("ExponentPushToken[x]")
    await addTicket("ticket-fresh", sessionId, "ExponentPushToken[x]", 5)

    await checkPushReceipts(getDb(), expo())

    expect(receiptCalls(calls)).toHaveLength(0)
    expect(await ticketIds()).toEqual(["ticket-fresh"])
  })

  it("asks for at most a thousand at a time", async () => {
    const receipts = Object.fromEntries(
      Array.from({ length: 1500 }, (_, i) => [`ticket-${i}`, { status: "ok" }]),
    )
    const calls = stubExpo({ receipts })
    const { sessionId } = await phoneWithToken("ExponentPushToken[x]")
    await getDb().execute(
      sql`insert into push_tickets (id, session_id, token, created_at)
          select 'ticket-' || n, ${sessionId}::uuid, 'ExponentPushToken[x]', now() - interval '1 hour'
          from generate_series(0, 1499) n`,
    )

    expect((await checkPushReceipts(getDb(), expo())).read).toBe(1500)

    const sizes = receiptCalls(calls).map((call) => (call.body as { ids: string[] }).ids.length)
    expect(sizes).toEqual([1000, 500])
    expect(await ticketIds()).toEqual([])
  })

  it("asks once and keeps the tickets when Expo turns the request down", async () => {
    const calls = stubExpo({ receiptStatus: 503 })
    const { sessionId } = await phoneWithToken("ExponentPushToken[x]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[x]", 60)
    await addTicket("ticket-b", sessionId, "ExponentPushToken[x]", 60)

    expect(await checkPushReceipts(getDb(), expo())).toEqual({ read: 0, cleared: 0 })
    expect(receiptCalls(calls)).toHaveLength(1)
    expect(await ticketIds()).toEqual(["ticket-a", "ticket-b"])
  })

  it("sends the access token when one is configured", async () => {
    const calls = stubExpo({ receipts: { "ticket-a": { status: "ok" } } })
    const { sessionId } = await phoneWithToken("ExponentPushToken[x]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[x]", 60)

    await checkPushReceipts(getDb(), expo({ EXPO_ACCESS_TOKEN: "secret" }))

    expect(receiptCalls(calls)[0]!.headers.authorization).toBe("Bearer secret")
  })

  it("is read on the scheduler's tick", async () => {
    stubExpo({
      receipts: { "ticket-a": { status: "error", details: { error: "DeviceNotRegistered" } } },
    })
    setRuntime({ pushDriver: expo() })
    const { sessionId } = await phoneWithToken("ExponentPushToken[gone]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[gone]", 60)

    await runJobs(getDb(), getConfig(), ctx.app.log)

    expect(await tokenOf(sessionId)).toBeNull()
  })
})

describe("a send Expo turns down for the project's credentials", () => {
  // InvalidCredentials is about the Expo project's FCM or APNs keys, not the
  // phone. Clearing the token for it would unregister every phone on the
  // server at the first send after a key expired.
  it("keeps the token, retries the send, and says what is wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              status: "error",
              message: "Unable to retrieve the FCM server key for the recipient's app.",
              details: { error: "InvalidCredentials" },
            },
          ],
        }),
      ),
    )
    const { user, sessionId } = await phoneWithToken("ExponentPushToken[fine]")
    await clearOutbox()
    await enqueuePush(getDb(), [{ userId: user.user.id, title: "Hearth", body: "Hello" }])
    const log = { error: vi.fn() }

    await drainOutbox(getDb(), expo(), { now: new Date(Date.now() + 2000), log })

    expect(await tokenOf(sessionId)).toBe("ExponentPushToken[fine]")
    const [row] = (await getDb().execute(
      sql`select status, attempts, last_error from notification_outbox`,
    )) as unknown as Array<{ status: string; attempts: number; last_error: string }>
    expect(row).toMatchObject({ status: "pending", attempts: 1 })
    expect(row!.last_error).toContain("InvalidCredentials")
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "expo" }),
      expect.stringContaining("credentials"),
    )
  })

  it("still clears the token of a phone the app is gone from", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [{ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }],
        }),
      ),
    )
    const { user, sessionId } = await phoneWithToken("ExponentPushToken[gone]")
    await clearOutbox()
    await enqueuePush(getDb(), [{ userId: user.user.id, title: "Hearth", body: "Hello" }])

    await drainOutbox(getDb(), expo(), { now: new Date(Date.now() + 2000) })

    expect(await tokenOf(sessionId)).toBeNull()
  })
})

describe("a receipt that says the project's credentials were refused", () => {
  it("keeps the token and says what is wrong", async () => {
    stubExpo({
      receipts: { "ticket-a": { status: "error", details: { error: "InvalidCredentials" } } },
    })
    const { sessionId } = await phoneWithToken("ExponentPushToken[fine]")
    await addTicket("ticket-a", sessionId, "ExponentPushToken[fine]", 60)
    const log = { error: vi.fn() }

    expect(await checkPushReceipts(getDb(), expo(), { log })).toEqual({ read: 1, cleared: 0 })
    expect(await tokenOf(sessionId)).toBe("ExponentPushToken[fine]")
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ receipts: 1 }),
      expect.stringContaining("credentials"),
    )
  })
})
