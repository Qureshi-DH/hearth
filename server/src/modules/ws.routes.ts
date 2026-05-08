import type { WsClientMessage, WsServerMessage } from "@hearth/shared"
import { eq } from "drizzle-orm"
import type { FastifyInstance, FastifyRequest } from "fastify"

import { getDb } from "../db/client"
import { circleMembers, sosAlerts, users } from "../db/schema"
import { circleTopic, userTopic, type BusEnvelope } from "../lib/bus"
import { toPublicUser } from "../lib/serialize"
import { extractToken, type AccessTokenClaims } from "../plugins/auth"
import { getBus } from "../runtime"
import {
  getCirclePresence,
  projectCirclePresence,
  type RawCirclePresence,
} from "../services/presence"

const HEARTBEAT_MS = 30_000
const REAUTH_MS = 60_000

/**
 * The bus carries word that something changed, never a rendered payload. What a
 * member may see depends on the viewer, so each socket re-projects presence for
 * its own user before sending.
 */
export async function registerWebsocket(app: FastifyInstance): Promise<void> {
  const db = getDb()

  app.get("/ws", { websocket: true }, async (socket, request: FastifyRequest) => {
    const token = extractToken(request)
    let claims: AccessTokenClaims

    try {
      if (!token) throw new Error("missing token")
      claims = app.jwt.verify<AccessTokenClaims>(token)
    } catch {
      socket.close(4401, "unauthorized")
      return
    }

    const userId = claims.sub
    const bus = getBus()

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

    async function reauthorise(): Promise<void> {
      memberOf = await loadMemberships()
      for (const circleId of [...subscribed]) {
        if (!memberOf.has(circleId)) subscribed.delete(circleId)
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
          case "message": {
            const message = payload.message as
              { author?: { id?: string }; toUser?: { id?: string } | null } | undefined
            const to = message?.toUser?.id ?? null
            // A directed message is between two people. Without this it would
            // fan out to every socket in the circle.
            if (to && to !== userId && message?.author?.id !== userId) break
            send({
              type: "message",
              circleId: circleId!,
              message: payload.message as never,
            })
            break
          }
          case "sos": {
            const [alert] = await db
              .select({ alert: sosAlerts, user: users })
              .from(sosAlerts)
              .innerJoin(users, eq(users.id, sosAlerts.userId))
              .where(eq(sosAlerts.id, payload.alertId as string))
              .limit(1)
            if (!alert) break
            send({
              type: "sos",
              circleId: circleId!,
              alert: {
                id: alert.alert.id,
                circleId: alert.alert.circleId,
                user: toPublicUser(alert.user),
                startedAt: alert.alert.startedAt.toISOString(),
                resolvedAt: alert.alert.resolvedAt?.toISOString() ?? null,
                resolvedBy: null,
                note: alert.alert.note,
                lastLat: null,
                lastLon: null,
                lastFixAt: null,
              },
            })
            break
          }
          case "nudge": {
            send({
              type: "nudge",
              circleId: (payload.circleId as string) ?? "",
              fromUserId: payload.fromUserId as string,
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
    })

    const heartbeat = setInterval(() => {
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
    }, HEARTBEAT_MS)

    const reauth = setInterval(() => void reauthorise(), REAUTH_MS)

    socket.on("message", (raw: Buffer) => {
      let message: WsClientMessage
      try {
        message = JSON.parse(raw.toString()) as WsClientMessage
      } catch {
        send({ type: "error", message: "malformed frame" })
        return
      }

      if (message.type === "ping") {
        send({ type: "pong", serverTime: new Date().toISOString() })
        return
      }

      if (message.type === "subscribe") {
        // A subscribe may narrow the set, never widen it past current membership.
        const requested = new Set(message.circleIds)
        const allowed = [...memberOf].filter((circleId) => requested.has(circleId))
        subscribed.clear()
        for (const circleId of allowed) subscribed.add(circleId)
        send({ type: "subscribed", circleIds: [...subscribed] })
      }
    })

    socket.on("close", () => {
      clearInterval(heartbeat)
      clearInterval(reauth)
      unsubscribe?.()
    })
  })
}
