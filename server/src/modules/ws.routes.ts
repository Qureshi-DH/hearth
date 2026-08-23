import type { WsClientMessage, WsServerMessage } from "@hearth/shared"
import { and, eq } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, sosAlerts, userPresence, users } from "../db/schema"
import { circleTopic, userTopic, type BusEnvelope } from "../lib/bus"
import { toPublicUser } from "../lib/serialize"
import { extractToken, resolveSession, type AccessTokenClaims } from "../plugins/auth"
import { getBus } from "../runtime"
import { CONTROL_HEARTBEAT_MS, clearControlSeen, markControlSeen } from "../services/control"
import {
  getCirclePresence,
  projectCirclePresence,
  projectPresence,
  type RawCirclePresence,
} from "../services/presence"

const HEARTBEAT_MS = 30_000
const REAUTH_MS = 60_000

/** Phone, tablet and a browser tab or two, with room for stale sockets a flaky network left behind. */
const MAX_SOCKETS_PER_USER = 12

/** 4401 tells the client its token is dead and to stop reconnecting. This one means try again later. */
const CLOSE_TOO_MANY = 4429

/** Room for a subscribe and a ping or two sent before the connect queries finish. */
const MAX_PENDING_FRAMES = 16

const resolver = alias(users, "resolver")

/** The raiser's membership of the circle the alert belongs to, which may be gone. */
const alertMember = alias(circleMembers, "alert_member")

/**
 * A frame arrives as whatever the peer felt like sending. The compile-time
 * WsClientMessage says nothing at runtime, so every frame is parsed before a
 * single field of it is touched.
 */
const clientMessage: z.ZodType<WsClientMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), circleIds: z.array(z.string()) }),
  z.object({ type: z.literal("control") }),
])

/**
 * The sockets that phones have declared their control channel, per user and
 * for this process. The stamp on the presence row is what the routes read;
 * this is for knowing whether a close leaves the user with none, so the
 * stamp can be cleared at once rather than aging out.
 */
const controlSocketsByUser = new Map<string, Set<TrackedSocket>>()

/** Only close() and identity are needed, and typing it this way keeps the ws types out of the module. */
interface TrackedSocket {
  close(code?: number, reason?: string): void
}

/**
 * Every open socket holds a heartbeat, a re-authorisation timer that queries
 * the database each minute, and a bus subscription, so one account must not be
 * able to pile them up without bound. The count is per user rather than per
 * address because a household shares one address, and behind a reverse proxy
 * every connection arrives from the proxy's.
 */
const socketsByUser = new Map<string, Set<TrackedSocket>>()

/**
 * The bus carries word that something changed, never a rendered payload. What a
 * member may see depends on the viewer, so each socket re-projects presence for
 * its own user before sending.
 */
export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get("/ws", { websocket: true }, async (socket, request: FastifyRequest) => {
    // Empty rather than null, so the same verify below rejects a missing token.
    const token = extractToken(request) ?? ""

    let claims: AccessTokenClaims
    try {
      claims = app.jwt.verify<AccessTokenClaims>(token)
    } catch {
      socket.close(4401, "unauthorized")
      return
    }

    const sessionId = claims.sid
    const bus = getBus()

    // The peer can hang up during any of the awaits below, and a close listener
    // attached afterwards would never fire, leaving the timers and the bus
    // subscription running for the life of the process.
    let closed = false
    // Whether this socket is the phone's control channel; see services/control.
    let isControl = false
    const disposers: Array<() => void> = []
    const onClose = (dispose: () => void) => {
      if (closed) dispose()
      else disposers.push(dispose)
    }
    socket.on("close", () => {
      closed = true
      for (const dispose of disposers.splice(0)) dispose()
    })

    // A client may send the moment the socket opens, while the queries below
    // are still running, and ws drops any frame that has no listener yet. Hold
    // those until the state they act on exists, and only as many as a client
    // could plausibly mean to send in that window.
    const pending: Buffer[] = []
    let acceptingFrames = false
    socket.on("message", (raw: Buffer) => {
      if (acceptingFrames) handleFrame(raw)
      else if (pending.length < MAX_PENDING_FRAMES) pending.push(raw)
    })

    /**
     * A signature says nothing about the session behind it. REST re-checks the
     * session row on every request, and a socket outlives the request that
     * opened it, so it has to check at connect and then keep checking. Without
     * the check at connect, a signed-out token opens fresh sockets and is
     * primed with live coordinates for as long as the token itself is valid.
     * It goes through the helper the REST path uses, so a token naming a
     * subject that does not own the session is refused here too.
     */
    const liveSession = async () => {
      const resolved = await resolveSession(claims)
      return resolved?.isActive ? resolved : null
    }

    const session = await liveSession()
    if (!session) {
      socket.close(4401, "unauthorized")
      return
    }

    // From the row rather than from the token's subject, so everything below
    // is authorised as the account that actually owns this session.
    const userId = session.userId

    const openForUser = socketsByUser.get(userId) ?? new Set<TrackedSocket>()
    socketsByUser.set(userId, openForUser)
    // The oldest goes rather than the newcomer: a phone reconnecting through a
    // bad network would otherwise be locked out by the sockets it abandoned.
    while (openForUser.size >= MAX_SOCKETS_PER_USER) {
      const oldest = openForUser.values().next().value
      if (!oldest) break
      openForUser.delete(oldest)
      oldest.close(CLOSE_TOO_MANY, "too many connections")
    }
    openForUser.add(socket)
    onClose(() => {
      openForUser.delete(socket)
      // An evicted socket is dropped from the set before it closes, so by the
      // time this runs the map may already hold a newer set for this user.
      if (openForUser.size === 0 && socketsByUser.get(userId) === openForUser) {
        socketsByUser.delete(userId)
      }
    })

    const loadMemberships = async () =>
      new Set(
        (
          await db
            .select({ circleId: circleMembers.circleId })
            .from(circleMembers)
            .where(eq(circleMembers.userId, userId))
        ).map((row) => row.circleId),
      )

    // Authorisation is not frozen at connect time. Membership is re-read on a
    // timer and when a removal event for this user arrives, so someone kicked
    // from a circle stops receiving its coordinates.
    let memberOf = await loadMemberships()
    const subscribed = new Set(memberOf)

    const send = (message: WsServerMessage) => {
      if (socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify(message))
    }

    send({ type: "hello", userId, serverTime: new Date().toISOString() })
    send({ type: "subscribed", circleIds: [...subscribed] })

    // Prime the client with the current state so it never renders an empty map
    // while waiting for the first movement.
    for (const circleId of subscribed) {
      const presences = await getCirclePresence(db, circleId, userId)
      send({ type: "presence", circleId, presences })
    }

    const unsubscribe = bus?.onMessage((envelope: BusEnvelope) => {
      void handleEnvelope(envelope)
    })
    onClose(() => unsubscribe?.())

    async function reauthorise(): Promise<void> {
      // Revocation is checked against the session row rather than by
      // re-verifying the connect-time token. The token expires in minutes and
      // the socket has no way to be handed a new one, so re-verifying it would
      // close every healthy connection on a timer. The session row is what
      // signing out, changing a password or deactivating an account updates,
      // and it is the thing that has to stop the feed.
      if (!(await liveSession())) {
        socket.close(4401, "unauthorized")
        return
      }

      const previous = memberOf
      memberOf = await loadMemberships()
      for (const circleId of [...subscribed]) {
        if (!memberOf.has(circleId)) subscribed.delete(circleId)
      }

      // Only circles gained since the last pass are added, so a client that
      // narrowed its own subscription keeps that choice.
      const gained = [...memberOf].filter((circleId) => !previous.has(circleId))
      if (gained.length === 0) return

      for (const circleId of gained) subscribed.add(circleId)
      send({ type: "subscribed", circleIds: [...subscribed] })
      for (const circleId of gained) {
        const presences = await getCirclePresence(db, circleId, userId)
        send({ type: "presence", circleId, presences })
      }
    }

    async function handleEnvelope(envelope: BusEnvelope): Promise<void> {
      const payload = envelope.payload as Record<string, unknown>
      const isMine = envelope.topic === userTopic(userId)
      const circleId = typeof payload.circleId === "string" ? payload.circleId : null

      if (!isMine && (!circleId || !subscribed.has(circleId))) return
      if (!isMine && envelope.topic !== circleTopic(circleId!)) return

      try {
        switch (payload.type) {
          case "session_revoked": {
            // Signing out has to cut the feed now, not at the next timer pass.
            // Only ever published on the user's own topic. A missing sessionId
            // means every session of theirs went.
            if (!isMine) break
            const revoked = payload.sessionId
            if (typeof revoked !== "string" || revoked === sessionId) {
              socket.close(4401, "unauthorized")
            }
            break
          }
          case "location": {
            const raw = payload.raw as RawCirclePresence | undefined
            const presences = raw
              ? projectCirclePresence(raw, userId)
              : await getCirclePresence(db, circleId!, userId)
            const presence = presences.find((entry) => entry.userId === payload.userId)
            if (presence) send({ type: "location", circleId: circleId!, presence })
            break
          }
          case "event": {
            const event = payload.event as
              { type?: string; payload?: { userId?: string } } | undefined
            const aboutMe =
              (event?.type === "member_removed" || event?.type === "member_left") &&
              event.payload?.userId === userId
            if (aboutMe) {
              subscribed.delete(circleId!)
              send({ type: "subscribed", circleIds: [...subscribed] })
              void reauthorise()
              break
            }
            send({
              type: "event",
              circleId: circleId!,
              event: payload.event as never,
            })
            break
          }
          case "sos": {
            const [alert] = await db
              .select({
                alert: sosAlerts,
                user: users,
                resolver,
                presence: userPresence,
                member: alertMember,
              })
              .from(sosAlerts)
              .innerJoin(users, eq(users.id, sosAlerts.userId))
              .leftJoin(resolver, eq(resolver.id, sosAlerts.resolvedBy))
              .leftJoin(userPresence, eq(userPresence.userId, sosAlerts.userId))
              // Left, not inner: somebody can leave a circle with an alert
              // still open, and the alert stays in that circle's record while
              // their presence row goes on updating from the circles they are
              // still in.
              .leftJoin(
                alertMember,
                and(
                  eq(alertMember.circleId, sosAlerts.circleId),
                  eq(alertMember.userId, sosAlerts.userId),
                ),
              )
              .where(eq(sosAlerts.id, payload.alertId as string))
              .limit(1)
            if (!alert) break

            // The same projection the REST list uses, because the same map
            // screen reads both. Raising an SOS un-pauses the raiser by
            // writing their sharing state, so an open alert already hands the
            // circle an exact position. Reading user_presence raw on top of
            // that would keep tracking somebody who set their sharing back or
            // left the circle, while every other surface honoured them.
            const seen =
              alert.member && !alert.alert.resolvedAt
                ? projectPresence(
                    {
                      userId: alert.alert.userId,
                      sharingState: alert.member.sharingState,
                      pausedUntil: alert.member.pausedUntil,
                      resumeToState: alert.member.resumeToState,
                      lat: alert.presence?.lat ?? null,
                      lon: alert.presence?.lon ?? null,
                      accuracyMeters: alert.presence?.accuracyMeters ?? null,
                      recordedAt: alert.presence?.recordedAt ?? null,
                      batteryLevel: alert.presence?.batteryLevel ?? null,
                      isCharging: alert.presence?.isCharging ?? null,
                      activity: alert.presence?.activity ?? null,
                      speedMps: alert.presence?.speedMps ?? null,
                      headingDegrees: alert.presence?.headingDegrees ?? null,
                    },
                    userId,
                    { atPlace: null, sosAlertId: alert.alert.id },
                  )
                : null

            send({
              type: "sos",
              circleId: circleId!,
              alert: {
                id: alert.alert.id,
                circleId: alert.alert.circleId,
                user: toPublicUser(alert.user),
                startedAt: alert.alert.startedAt.toISOString(),
                resolvedAt: alert.alert.resolvedAt?.toISOString() ?? null,
                resolvedBy: alert.resolver ? toPublicUser(alert.resolver) : null,
                note: alert.alert.note,
                lastLat: seen?.lat ?? null,
                lastLon: seen?.lon ?? null,
                // On its own this still says the phone reported a moment ago,
                // which is the one thing a pause is meant to withhold, so it
                // follows the coordinates rather than being sent regardless.
                lastFixAt: seen?.recordedAt ?? null,
              },
            })
            break
          }
          case "control": {
            // Addressed to the user, meant for the phone: only the socket
            // that declared itself the channel gets it, not the app open on
            // the same account elsewhere.
            if (!isControl) break
            const command = payload.command
            if (command !== "watch" && command !== "wake") break
            send({
              type: "control",
              command,
              ...(typeof payload.seconds === "number" ? { seconds: payload.seconds } : {}),
            })
            break
          }
          case "nudge": {
            // Published to this user's own topic, so it is already addressed
            // and needs no filtering here.
            send({
              type: "nudge",
              circleId: (payload.circleId as string) ?? "",
              nudge: payload.nudge as never,
            })
            break
          }
          default:
            break
        }
      } catch (error) {
        request.log.warn({ err: error }, "websocket fan-out failed")
      }
    }

    let alive = true
    socket.on("pong", () => {
      alive = true
      // Each answered heartbeat renews the stamp the routes read as "open".
      if (isControl) void markControlSeen(db, userId).catch(() => undefined)
    })

    const beat = () => {
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      try {
        socket.ping()
      } catch {
        socket.terminate()
      }
    }
    let heartbeat = setInterval(beat, HEARTBEAT_MS)
    // A phone's control socket is answered from a pocket, and every answer
    // wakes its radio, so a declared one is pinged at the slower pace.
    const slowHeartbeat = () => {
      clearInterval(heartbeat)
      heartbeat = setInterval(beat, CONTROL_HEARTBEAT_MS)
    }

    const reauth = setInterval(() => void reauthorise(), REAUTH_MS)

    onClose(() => {
      clearInterval(heartbeat)
      clearInterval(reauth)
    })

    // Nothing in here may throw. The listener that calls it runs synchronously
    // inside the socket's receiver, so an escaping error becomes an
    // uncaughtException and takes the server down for every household on it.
    function handleFrame(raw: Buffer): void {
      try {
        const parsed = clientMessage.safeParse(JSON.parse(raw.toString()))
        if (!parsed.success) {
          send({ type: "error", message: "malformed frame" })
          return
        }
        const message = parsed.data

        if (message.type === "ping") {
          send({ type: "pong", serverTime: new Date().toISOString() })
          return
        }

        if (message.type === "control") {
          if (!isControl) {
            isControl = true
            slowHeartbeat()
            const mine = controlSocketsByUser.get(userId) ?? new Set<TrackedSocket>()
            mine.add(socket)
            controlSocketsByUser.set(userId, mine)
            onClose(() => {
              mine.delete(socket)
              if (mine.size === 0) {
                controlSocketsByUser.delete(userId)
                void clearControlSeen(db, userId).catch(() => undefined)
              }
            })
          }
          void markControlSeen(db, userId)
            .then(() => send({ type: "control", command: "ready" }))
            .catch((error) => request.log.warn({ err: error }, "control channel stamp failed"))
          return
        }

        // A subscribe may narrow the set, never widen it past current membership.
        const requested = new Set(message.circleIds)
        const allowed = [...memberOf].filter((circleId) => requested.has(circleId))
        subscribed.clear()
        for (const circleId of allowed) subscribed.add(circleId)
        send({ type: "subscribed", circleIds: [...subscribed] })
      } catch (error) {
        request.log.warn({ err: error }, "websocket frame rejected")
        send({ type: "error", message: "malformed frame" })
      }
    }

    acceptingFrames = true
    for (const raw of pending.splice(0)) handleFrame(raw)
  })
}
