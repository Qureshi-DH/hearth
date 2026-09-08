import { createRequire } from "node:module"

import type { WsServerMessage } from "@hearth/shared"
import { eq, sql } from "drizzle-orm"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { getDb } from "../../db/client"
import { auditLog, sessions, users } from "../../db/schema"
import { circleTopic } from "../../lib/bus"
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

/**
 * Short on purpose. The socket's own re-authorisation timer is a minute away,
 * so anything these specs see inside a few seconds came from the revocation
 * itself rather than from the timer.
 */
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

/** Flips the flag behind the route's back, so no session is revoked with it. */
async function setAdminFlag(userId: string, isAdmin: boolean): Promise<void> {
  await getDb().update(users).set({ isAdmin }).where(eq(users.id, userId))
}

async function liveSessionCount(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(sql`${sessions.userId} = ${userId} and ${sessions.revokedAt} is null`)
  return row?.count ?? 0
}

describe("server admin is read from the row, not the token", () => {
  it("stops honouring a token whose account was demoted without being signed out", async () => {
    const admin = await registerUser(ctx.app)
    const deputy = await registerUser(ctx.app)

    const promote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${deputy.user.id}`,
      headers: admin.headers,
      payload: { isAdmin: true },
    })
    expect(promote.statusCode).toBe(200)

    // A token minted while the flag was true, exactly what the deputy's phone
    // is already holding when the demotion lands.
    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: deputy.email,
        password: "correct-horse-battery",
        device: { deviceId: "device-deputy-1" },
      },
    })
    expect(login.statusCode).toBe(200)
    const stale = { authorization: `Bearer ${login.json().accessToken}` }

    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: stale,
    })
    expect(before.statusCode).toBe(200)

    await setAdminFlag(deputy.user.id, false)

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: stale,
    })
    expect(after.statusCode).toBe(403)

    // The whole point: the demoted account cannot put the flag back.
    const selfPromote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${deputy.user.id}`,
      headers: stale,
      payload: { isAdmin: true },
    })
    expect(selfPromote.statusCode).toBe(403)

    const [row] = await getDb()
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, deputy.user.id))
    expect(row?.isAdmin).toBe(false)
  })

  it("honours a promotion on the token the account already holds", async () => {
    await registerUser(ctx.app)
    const member = await registerUser(ctx.app)

    const before = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: member.headers,
    })
    expect(before.statusCode).toBe(403)

    await setAdminFlag(member.user.id, true)

    const after = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/admin/stats",
      headers: member.headers,
    })
    expect(after.statusCode).toBe(200)
  })

  it("ends the demoted account's sessions the way deactivation does", async () => {
    const admin = await registerUser(ctx.app)
    const deputy = await registerUser(ctx.app)

    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${deputy.user.id}`,
      headers: admin.headers,
      payload: { isAdmin: true },
    })

    const demote = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${deputy.user.id}`,
      headers: admin.headers,
      payload: { isAdmin: false },
    })
    expect(demote.statusCode).toBe(200)

    expect(await liveSessionCount(deputy.user.id)).toBe(0)

    const stale = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: deputy.headers,
    })
    expect(stale.statusCode).toBe(401)

    const refresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: deputy.refreshToken },
    })
    expect(refresh.statusCode).toBe(401)
  })

  it("leaves an ordinary member signed in when a demotion changes nothing", async () => {
    const admin = await registerUser(ctx.app)
    const deputy = await registerUser(ctx.app)
    const member = await registerUser(ctx.app)

    // A second administrator, so the keep-one-administrator guard is not what
    // answers the demotion below.
    await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${deputy.user.id}`,
      headers: admin.headers,
      payload: { isAdmin: true },
    })

    const patch = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/admin/users/${member.user.id}`,
      headers: admin.headers,
      payload: { isAdmin: false },
    })
    expect(patch.statusCode).toBe(200)

    expect(await liveSessionCount(member.user.id)).toBe(1)
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: member.headers,
    })
    expect(me.statusCode).toBe(200)
  })
})

describe("token subject and session owner", () => {
  it("refuses a token whose subject is not the session's own account", async () => {
    const bob = await registerUser(ctx.app, { displayName: "Bob" })
    const carol = await registerUser(ctx.app, { displayName: "Carol" })

    const [bobSession] = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, bob.user.id))
      .limit(1)

    // Signed with the server's own secret, so only the subject is wrong. This
    // is the shape a signing bug or an algorithm confusion would produce.
    const forged = ctx.app.jwt.sign({ sub: carol.user.id, sid: bobSession!.id })

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${forged}` },
    })
    expect(response.statusCode).toBe(401)
  })

  it("still accepts the matching pair it issues itself", async () => {
    const bob = await registerUser(ctx.app)
    const [bobSession] = await getDb()
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, bob.user.id))
      .limit(1)

    const minted = ctx.app.jwt.sign({ sub: bob.user.id, sid: bobSession!.id })
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${minted}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().id).toBe(bob.user.id)
  })
})

describe("refresh rotation", () => {
  it("records the address and agent that refreshed, not the ones that signed in", async () => {
    const user = await registerUser(ctx.app)

    const refresh = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: user.refreshToken },
      headers: { "user-agent": "hearth-thief/1.0" },
    })
    expect(refresh.statusCode).toBe(200)

    const [row] = await getDb()
      .select({ userAgent: sessions.userAgent })
      .from(sessions)
      .where(eq(sessions.userId, user.user.id))
      .limit(1)
    expect(row?.userAgent).toBe("hearth-thief/1.0")
  })
})

describe("a revoked session cuts its live socket at once", () => {
  it("closes the socket when the account signs out", async () => {
    const bob = await registerUser(ctx.app)
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    expect(await waitFor(() => client.messages.some((message) => message.type === "hello"))).toBe(
      true,
    )

    const logout = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: bob.headers,
    })
    expect(logout.statusCode).toBe(200)

    // Well inside the minute the re-authorisation timer would have taken.
    expect(await waitFor(() => !client.isOpen())).toBe(true)
    expect(client.closeCode()).toBe(4401)
  })

  it("leaves the account's other phone and everybody else connected", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })
    const carol = await registerUser(ctx.app)

    const tablet = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: bob.email,
        password: "correct-horse-battery",
        device: { deviceId: "device-bob-tablet" },
      },
    })
    expect(tablet.statusCode).toBe(200)
    const tabletToken = (tablet.json() as { accessToken: string }).accessToken

    const phone = connect(bob.accessToken)
    const tabletClient = connect(tabletToken)
    const carolClient = connect(carol.accessToken)
    expect(await Promise.all([phone.opened, tabletClient.opened, carolClient.opened])).toEqual([
      true,
      true,
      true,
    ])

    const signOut = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${sessionIdOf(tabletToken)}`,
      headers: bob.headers,
    })
    expect(signOut.statusCode).toBe(200)

    expect(await waitFor(() => !tabletClient.isOpen())).toBe(true)
    expect(tabletClient.closeCode()).toBe(4401)
    expect({ phone: phone.isOpen(), carol: carolClient.isOpen() }).toEqual({
      phone: true,
      carol: true,
    })

    const stillLive = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bob.headers,
    })
    expect(stillLive.statusCode).toBe(200)

    phone.socket.close()
    carolClient.socket.close()
  })
})

describe("the socket takes its identity from the session row", () => {
  it("refuses a token whose subject is not the session's own account", async () => {
    const bob = await registerUser(ctx.app)
    const carol = await registerUser(ctx.app)

    const forged = ctx.app.jwt.sign({ sub: carol.user.id, sid: sessionIdOf(bob.accessToken) })
    const client = connect(forged)

    // The upgrade itself succeeds, so what matters is that the socket closes
    // before a single frame is sent rather than that the handshake was refused.
    await client.opened
    expect(await waitFor(() => !client.isOpen())).toBe(true)
    expect(client.closeCode()).toBe(4401)
    expect(client.messages).toEqual([])
  })

  it("still opens for the matching pair it issues itself", async () => {
    const bob = await registerUser(ctx.app)
    const client = connect(bob.accessToken)

    expect(await client.opened).toBe(true)
    expect(await waitFor(() => client.messages.some((message) => message.type === "hello"))).toBe(
      true,
    )
    const hello = client.messages.find((message) => message.type === "hello")
    expect(hello).toMatchObject({ userId: bob.user.id })

    client.socket.close()
  })
})

describe("refresh token reuse", () => {
  const refresh = (refreshToken: string) =>
    ctx.app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } })

  const reuseAudits = async () =>
    getDb().select().from(auditLog).where(eq(auditLog.action, "session.refresh_reuse"))

  /** What the row would look like had the rotation happened before the grace window. */
  async function ageRotation(userId: string, minutes = 5): Promise<void> {
    const ago = new Date(Date.now() - minutes * 60 * 1000).toISOString()
    await getDb().execute(sql`
      update sessions set spent_refresh = coalesce((
        select jsonb_agg(jsonb_set(entry, '{at}', to_jsonb(${ago}::text)))
        from jsonb_array_elements(spent_refresh) entry
      ), '[]'::jsonb)
      where user_id = ${userId}::uuid
    `)
  }

  it("ends the session when a spent token is replayed later", async () => {
    const bob = await registerUser(ctx.app)

    const rotated = await refresh(bob.refreshToken)
    expect(rotated.statusCode).toBe(200)
    const live = (rotated.json() as { refreshToken: string }).refreshToken

    await ageRotation(bob.user.id)

    const replay = await refresh(bob.refreshToken)
    expect(replay.statusCode).toBe(401)

    // Containment, not just refusal: the copy in the thief's hands and the
    // copy on the phone are both dead, and signing in again is what proves
    // who owns the account.
    expect(await liveSessionCount(bob.user.id)).toBe(0)
    expect((await refresh(live)).statusCode).toBe(401)
    expect(await reuseAudits()).toHaveLength(1)

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bob.headers,
    })
    expect(me.statusCode).toBe(401)
  })

  it("does not end the session over an app that sent the same refresh twice", async () => {
    const bob = await registerUser(ctx.app)

    const first = await refresh(bob.refreshToken)
    expect(first.statusCode).toBe(200)
    const live = (first.json() as { refreshToken: string }).refreshToken

    // Seconds after the rotation, the spent token is far better explained by a
    // client that fired twice, or retried a response it never received, than
    // by a thief. It is still refused, but signing the family out of a device
    // they are holding would be a worse outage than the one it prevents.
    const again = await refresh(bob.refreshToken)
    expect(again.statusCode).toBe(401)

    expect(await liveSessionCount(bob.user.id)).toBe(1)
    expect(await reuseAudits()).toHaveLength(0)
    expect((await refresh(live)).statusCode).toBe(200)

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: bob.headers,
    })
    expect(me.statusCode).toBe(200)
  })

  it("hands a same-device retry within the grace a fresh pair, since the answer it retried never arrived", async () => {
    // A phone on the road refreshed, the server rotated, and the response
    // was lost to the network. The phone still holds the spent token and
    // presents it again minutes later. Refusing it signed the family out
    // of a phone that had done nothing wrong, and the tracker with it.
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })
    const withDevice = (refreshToken: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken, deviceId: "device-bob-phone" },
      })

    const first = await withDevice(bob.refreshToken)
    expect(first.statusCode).toBe(200)
    const lost = (first.json() as { refreshToken: string }).refreshToken

    const retry = await withDevice(bob.refreshToken)
    expect(retry.statusCode).toBe(200)
    const fresh = (retry.json() as { refreshToken: string; accessToken: string }).refreshToken
    expect(fresh).not.toBe(lost)
    expect(await liveSessionCount(bob.user.id)).toBe(1)
    expect(await reuseAudits()).toHaveLength(0)

    // The pair it was handed is the live one now, and the lost one is spent.
    expect((await withDevice(fresh)).statusCode).toBe(200)
    expect((await withDevice(lost)).statusCode).toBe(401)
    expect(await liveSessionCount(bob.user.id)).toBe(1)
  })

  it("does not let the same spent token be retried for ever", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })
    const withDevice = (refreshToken: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken, deviceId: "device-bob-phone" },
      })
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(200)
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(200)

    // The grace is measured from the rotation the phone missed, not from the
    // retry, so a token that keeps being presented runs out of it once the
    // access token it went with has lived its life.
    await ageRotation(bob.user.id, 20)
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(401)
    expect(await liveSessionCount(bob.user.id)).toBe(0)
  })

  it("ends the session when a thief has rotated twice before the phone refreshes", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })
    const withDevice = (refreshToken: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken, deviceId: "device-bob-phone" },
      })

    // A copy of the phone's token, turned over twice from somewhere else.
    const first = await refresh(bob.refreshToken)
    const second = await refresh((first.json() as { refreshToken: string }).refreshToken)
    expect(second.statusCode).toBe(200)

    // The phone's own refresh comes due once its access token has run out.
    await ageRotation(bob.user.id, 20)
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(401)
    expect(await liveSessionCount(bob.user.id)).toBe(0)
    expect(await reuseAudits()).toHaveLength(1)
  })

  it("answers a same-device retry once and ends the session on the second", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })
    const withDevice = (refreshToken: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken, deviceId: "device-bob-phone" },
      })
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(200)
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(200)
    expect((await withDevice(bob.refreshToken)).statusCode).toBe(401)
    expect(await liveSessionCount(bob.user.id)).toBe(0)
    expect(await reuseAudits()).toHaveLength(1)
  })

  it("refuses the same retry from another device", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })
    const from = (refreshToken: string, deviceId: string) =>
      ctx.app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken, deviceId },
      })
    expect((await from(bob.refreshToken, "device-bob-phone")).statusCode).toBe(200)
    expect((await from(bob.refreshToken, "device-somebody-else")).statusCode).toBe(401)
    // Seconds after the rotation the session is kept, as before.
    expect(await liveSessionCount(bob.user.id)).toBe(1)
  })

  it("leaves the session alone when a token nobody issued is presented", async () => {
    const bob = await registerUser(ctx.app)

    const guess = await refresh("this-string-was-never-a-refresh-token")
    expect(guess.statusCode).toBe(401)

    expect(await liveSessionCount(bob.user.id)).toBe(1)
    expect(await reuseAudits()).toHaveLength(0)
    expect((await refresh(bob.refreshToken)).statusCode).toBe(200)
  })

  it("does not hold a session's own re-login against it", async () => {
    const bob = await registerUser(ctx.app, { deviceId: "device-bob-phone" })

    const rotated = await refresh(bob.refreshToken)
    expect(rotated.statusCode).toBe(200)

    // Same device, so this lands on the row the rotation above wrote.
    const again = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: bob.email,
        password: "correct-horse-battery",
        device: { deviceId: "device-bob-phone" },
      },
    })
    expect(again.statusCode).toBe(200)
    const signedIn = (again.json() as { refreshToken: string }).refreshToken

    await ageRotation(bob.user.id)

    // The token the previous session rotated away from must not end the one
    // that replaced it.
    expect((await refresh(bob.refreshToken)).statusCode).toBe(401)
    expect(await reuseAudits()).toHaveLength(0)
    expect((await refresh(signedIn)).statusCode).toBe(200)
  })
})

describe("a display name is stored as one line", () => {
  const patchName = (headers: Record<string, string>, displayName: string) =>
    ctx.app.inject({ method: "PATCH", url: "/api/v1/auth/me", headers, payload: { displayName } })

  it("removes what would forge a second line in another member's notification", async () => {
    const bob = await registerUser(ctx.app)

    const response = await patchName(bob.headers, "Mum\u202E\nSOS: tap here\u200B")
    expect(response.statusCode).toBe(200)
    expect((response.json() as { displayName: string }).displayName).toBe("Mum SOS: tap here")
  })

  it("caps a run of combining marks instead of letting it cover the rows below", async () => {
    const bob = await registerUser(ctx.app)

    const response = await patchName(bob.headers, `A${"\u0301".repeat(20)}`)
    expect(response.statusCode).toBe(200)
    // NFC pulls the first acute into the A, and the run left over is what gets
    // cut down, so what survives is one accented letter and three marks.
    expect((response.json() as { displayName: string }).displayName).toBe(
      `\u00C1${"\u0301".repeat(3)}`,
    )
  })

  it("cleans the name at registration too", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "rlo@example.com",
        password: "correct-horse-battery",
        displayName: "Dad\u202E\nBattery low",
        device: { deviceId: "device-registration-1" },
      },
    })
    expect(response.statusCode).toBe(201)
    expect((response.json() as { user: { displayName: string } }).user.displayName).toBe(
      "Dad Battery low",
    )
  })

  it("leaves an ordinary name exactly as it was typed", async () => {
    const bob = await registerUser(ctx.app)

    const response = await patchName(bob.headers, "José Ñuñez 👩\u200D👦")
    expect(response.statusCode).toBe(200)
    // The accents survive, and the zero-width joiner holding the family emoji
    // together is not one of the invisible characters worth removing.
    expect((response.json() as { displayName: string }).displayName).toBe("José Ñuñez 👩\u200D👦")
  })

  it("still refuses a name that is nothing but formatting", async () => {
    const bob = await registerUser(ctx.app)

    const response = await patchName(bob.headers, "\u202E\u200B \n")
    expect(response.statusCode).toBe(400)
  })
})

describe("an SOS frame on the socket serves the same position the map does", () => {
  const BRISTOL = { lat: 51.4636, lon: -2.5952 }

  async function household() {
    const alice = await registerUser(ctx.app, { displayName: "Alice" })
    const circle = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/circles",
      headers: alice.headers,
      payload: { name: "Neighbours", emoji: "🏠" },
    })
    expect(circle.statusCode).toBe(201)
    const created = circle.json() as { id: string; invite: { code: string } }
    const bob = await registerUser(ctx.app, {
      displayName: "Bob",
      inviteCode: created.invite.code,
    })
    return { alice, bob, circleId: created.id }
  }

  async function raise(headers: Record<string, string>, circleId: string) {
    await ctx.app.inject({
      method: "POST",
      url: "/api/v1/locations/batch",
      headers,
      payload: {
        points: [
          {
            ...BRISTOL,
            recordedAt: new Date(Date.now() - 30_000).toISOString(),
            accuracyMeters: 11,
            batteryLevel: 0.5,
            isCharging: false,
            speedMps: 0,
            source: "background",
          },
        ],
      },
    })
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/circles/${circleId}/sos`,
      headers,
      payload: { note: null },
    })
    expect(response.statusCode).toBe(201)
    return (response.json() as { id: string }).id
  }

  const sosFrames = (client: Client) =>
    client.messages.filter(
      (message): message is Extract<WsServerMessage, { type: "sos" }> => message.type === "sos",
    )

  it("carries the exact position during an ordinary alert", async () => {
    const { alice, bob, circleId } = await household()
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    expect(await waitFor(() => client.messages.some((message) => message.type === "hello"))).toBe(
      true,
    )

    await raise(alice.headers, circleId)

    expect(await waitFor(() => sosFrames(client).length === 1)).toBe(true)
    const [frame] = sosFrames(client)
    expect(frame!.alert.lastLat).toBeCloseTo(BRISTOL.lat, 5)
    expect(frame!.alert.lastLon).toBeCloseTo(BRISTOL.lon, 5)
    expect(frame!.alert.lastFixAt).not.toBeNull()

    client.socket.close()
  })

  it("stops carrying it once the raiser has paused her sharing again", async () => {
    const { alice, bob, circleId } = await household()
    const client = connect(bob.accessToken)
    expect(await client.opened).toBe(true)
    expect(await waitFor(() => client.messages.some((message) => message.type === "hello"))).toBe(
      true,
    )

    const alertId = await raise(alice.headers, circleId)
    expect(await waitFor(() => sosFrames(client).length === 1)).toBe(true)

    const paused = await ctx.app.inject({
      method: "PATCH",
      url: `/api/v1/circles/${circleId}/sharing`,
      headers: alice.headers,
      payload: { sharingState: "paused" },
    })
    expect(paused.statusCode).toBe(200)

    // The same alert re-broadcast, which is what a resolve or a second circle
    // event does. The REST list has honoured the pause since the last round.
    await getBus()?.publish(circleTopic(circleId), {
      type: "sos",
      circleId,
      alertId,
      userId: alice.user.id,
    })

    expect(await waitFor(() => sosFrames(client).length === 2)).toBe(true)
    const latest = sosFrames(client)[1]!
    expect({
      lat: latest.alert.lastLat,
      lon: latest.alert.lastLon,
      fixAt: latest.alert.lastFixAt,
    }).toEqual({ lat: null, lon: null, fixAt: null })

    client.socket.close()
  })
})
