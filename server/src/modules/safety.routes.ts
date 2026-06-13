import { DEFAULTS, haversineMeters, QUICK_MESSAGE_KEYS, QUICK_MESSAGES } from "@hearth/shared"
import { and, desc, eq, isNull } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { checkIns, circleMembers, places, sosAlerts, userPresence, users } from "../db/schema"
import { badRequest, conflict, forbidden, notFound } from "../lib/errors"
import { circleTopic, userTopic } from "../lib/bus"
import { toPublicUser } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { getBus } from "../runtime"
import { recordEvent } from "../services/feed"
import { enqueuePush } from "../services/push"

const circleIdParam = z.object({ circleId: z.string().uuid() })

const resolver = alias(users, "resolver")

export const safetyRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.post(
    "/circles/:circleId/sos",
    {
      preHandler: app.authenticate,
      // SOS bypasses mutes and fires at top priority, so spamming it must be hard.
      config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
      schema: {
        tags: ["safety"],
        summary: "Raise an SOS alert",
        description:
          "Notifies every other member at the highest priority the transport allows, and " +
          "overrides the sender's sharing state for the duration of the alert. An SOS from " +
          "someone whose location is paused would be useless.",
        params: circleIdParam,
        body: z.object({ note: z.string().max(500).nullish() }),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const alert = await db.transaction(async (tx) => {
        // An emergency is not the moment to respect ghost mode. Taking this row
        // first also serialises two alerts racing from the same person, which
        // the duplicate check below cannot do on its own: a panicked double tap
        // would otherwise raise two, and resolving the one the app shows would
        // leave the other lit with nothing able to clear it.
        await tx
          .update(circleMembers)
          .set({ sharingState: "precise", pausedUntil: null })
          .where(
            and(
              eq(circleMembers.circleId, membership.circleId),
              eq(circleMembers.userId, auth.userId),
            ),
          )

        const [existing] = await tx
          .select({ id: sosAlerts.id })
          .from(sosAlerts)
          .where(
            and(
              eq(sosAlerts.circleId, membership.circleId),
              eq(sosAlerts.userId, auth.userId),
              isNull(sosAlerts.resolvedAt),
            ),
          )
          .limit(1)
        if (existing) throw conflict("You already have an active alert in this circle.")

        const [created] = await tx
          .insert(sosAlerts)
          .values({
            circleId: membership.circleId,
            userId: auth.userId,
            note: request.body.note ?? null,
          })
          .returning()
        if (!created) throw badRequest("Could not raise the alert.")
        return created
      })

      const [actor] = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          avatarColor: users.avatarColor,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)

      const name = actor?.displayName ?? "Someone"

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "sos_started",
        actorUserId: auth.userId,
        payload: { alertId: alert.id, note: alert.note },
        summary: `${name} raised an SOS`,
      })

      // No mute filter. This is the one alert an earlier "mute this circle" tap
      // is not allowed to silence.
      const recipients = (
        await db
          .select({ userId: circleMembers.userId })
          .from(circleMembers)
          .where(eq(circleMembers.circleId, membership.circleId))
      )
        .map((row) => row.userId)
        .filter((userId) => userId !== auth.userId)

      await enqueuePush(
        db,
        recipients.map((userId) => ({
          userId,
          circleId: membership.circleId,
          title: `🚨 SOS from ${name}`,
          body: alert.note ?? "Tap to see their location.",
          channel: "sos" as const,
          priority: "high" as const,
          data: { type: "sos_started", alertId: alert.id, circleId: membership.circleId },
        })),
      )

      await getBus()?.publish(circleTopic(membership.circleId), {
        type: "sos",
        circleId: membership.circleId,
        alertId: alert.id,
        userId: auth.userId,
      })

      const [presence] = await db
        .select({
          lat: userPresence.lat,
          lon: userPresence.lon,
          recordedAt: userPresence.recordedAt,
        })
        .from(userPresence)
        .where(eq(userPresence.userId, auth.userId))
        .limit(1)

      return reply.code(201).send({
        id: alert.id,
        circleId: alert.circleId,
        user: toPublicUser(
          actor ?? { id: auth.userId, displayName: name, avatarColor: "#888888", avatarUrl: null },
        ),
        startedAt: alert.startedAt.toISOString(),
        resolvedAt: null,
        resolvedBy: null,
        note: alert.note,
        lastLat: presence?.lat ?? null,
        lastLon: presence?.lon ?? null,
        lastFixAt: presence?.recordedAt?.toISOString() ?? null,
        notifiedMembers: recipients.length,
      })
    },
  )

  app.post(
    "/sos/:alertId/resolve",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["safety"],
        summary: "Mark an SOS as resolved",
        description: "The person who raised it, or any admin of that circle, may resolve it.",
        params: z.object({ alertId: z.string().uuid() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)

      const [alert] = await db
        .select()
        .from(sosAlerts)
        .where(eq(sosAlerts.id, request.params.alertId))
        .limit(1)
      if (!alert) throw notFound("No such alert.")
      if (alert.resolvedAt) return { ok: true, alreadyResolved: true }

      const membership = await requireMembership(
        request,
        alert.circleId,
        alert.userId === auth.userId ? "member" : "admin",
      )

      const [resolved] = await db
        .update(sosAlerts)
        .set({ resolvedAt: new Date(), resolvedBy: auth.userId })
        .where(eq(sosAlerts.id, alert.id))
        .returning()

      const [actor] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "sos_resolved",
        actorUserId: auth.userId,
        payload: { alertId: alert.id },
        summary: `${actor?.displayName ?? "Someone"} marked the SOS as resolved`,
        notify: {
          title: "SOS resolved",
          body: `${actor?.displayName ?? "Someone"} marked the alert as resolved.`,
          channel: "alerts",
          excludeActor: false,
        },
      })

      return { ok: true, resolvedAt: resolved?.resolvedAt?.toISOString() ?? null }
    },
  )

  app.get(
    "/circles/:circleId/sos",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["safety"],
        summary: "SOS history for a circle",
        params: circleIdParam,
        querystring: z.object({
          // z.coerce.boolean() would turn the string "false" into true.
          activeOnly: z
            .enum(["true", "false"])
            .default("false")
            .transform((value) => value === "true"),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId)

      const rows = await db
        .select({ alert: sosAlerts, user: users, resolver, presence: userPresence })
        .from(sosAlerts)
        .innerJoin(users, eq(users.id, sosAlerts.userId))
        .leftJoin(resolver, eq(resolver.id, sosAlerts.resolvedBy))
        .leftJoin(userPresence, eq(userPresence.userId, sosAlerts.userId))
        .where(
          and(
            eq(sosAlerts.circleId, membership.circleId),
            request.query.activeOnly ? isNull(sosAlerts.resolvedAt) : undefined,
          ),
        )
        .orderBy(desc(sosAlerts.startedAt))
        .limit(request.query.limit)

      return rows.map((row) => ({
        id: row.alert.id,
        circleId: row.alert.circleId,
        user: toPublicUser(row.user),
        startedAt: row.alert.startedAt.toISOString(),
        resolvedAt: row.alert.resolvedAt?.toISOString() ?? null,
        resolvedBy: row.resolver ? toPublicUser(row.resolver) : null,
        note: row.alert.note,
        lastLat: row.alert.resolvedAt ? null : (row.presence?.lat ?? null),
        lastLon: row.alert.resolvedAt ? null : (row.presence?.lon ?? null),
        lastFixAt: row.presence?.recordedAt?.toISOString() ?? null,
      }))
    },
  )

  app.post(
    "/circles/:circleId/check-in",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["safety"],
        summary: "Check in at your current location",
        description: "A deliberate 'I am here and I am fine', separate from passive tracking.",
        params: circleIdParam,
        body: z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          note: z.string().max(280).nullish(),
        }),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const nearby = await db
        .select({
          id: places.id,
          name: places.name,
          lat: places.lat,
          lon: places.lon,
          radiusMeters: places.radiusMeters,
        })
        .from(places)
        .where(eq(places.circleId, membership.circleId))

      const match = nearby.find(
        (place) =>
          haversineMeters(
            { lat: request.body.lat, lon: request.body.lon },
            { lat: place.lat, lon: place.lon },
          ) <= place.radiusMeters,
      )

      const [created] = await db
        .insert(checkIns)
        .values({
          circleId: membership.circleId,
          userId: auth.userId,
          lat: request.body.lat,
          lon: request.body.lon,
          note: request.body.note ?? null,
          placeId: match?.id ?? null,
        })
        .returning()
      if (!created) throw badRequest("Could not record the check-in.")

      const [actor] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)
      const name = actor?.displayName ?? "Someone"
      const where = match ? ` at ${match.name}` : ""

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "check_in",
        actorUserId: auth.userId,
        payload: {
          checkInId: created.id,
          lat: created.lat,
          lon: created.lon,
          placeId: created.placeId,
          note: created.note,
        },
        summary: `${name} checked in${where}`,
        notify: {
          title: "Check-in",
          body: `${name} checked in${where}.${created.note ? ` "${created.note}"` : ""}`,
        },
      })

      const [actorRow] = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          avatarColor: users.avatarColor,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)

      return reply.code(201).send({
        id: created.id,
        circleId: created.circleId,
        user: actorRow ? toPublicUser(actorRow) : null,
        lat: created.lat,
        lon: created.lon,
        note: created.note,
        placeId: created.placeId,
        placeName: match?.name ?? null,
        createdAt: created.createdAt.toISOString(),
      })
    },
  )

  app.get(
    "/circles/:circleId/check-ins",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["safety"],
        summary: "Recent check-ins",
        params: circleIdParam,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId)
      const rows = await db
        .select({ checkIn: checkIns, user: users, placeName: places.name })
        .from(checkIns)
        .innerJoin(users, eq(users.id, checkIns.userId))
        .leftJoin(places, eq(places.id, checkIns.placeId))
        .where(eq(checkIns.circleId, membership.circleId))
        .orderBy(desc(checkIns.createdAt))
        .limit(request.query.limit)

      return rows.map((row) => ({
        id: row.checkIn.id,
        circleId: row.checkIn.circleId,
        user: toPublicUser(row.user),
        lat: row.checkIn.lat,
        lon: row.checkIn.lon,
        note: row.checkIn.note,
        placeId: row.checkIn.placeId,
        placeName: row.placeName,
        createdAt: row.checkIn.createdAt.toISOString(),
      }))
    },
  )

  app.post(
    "/circles/:circleId/nudge/:userId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["safety"],
        summary: "Nudge someone",
        description:
          "Asks their device to report a fresh location, and optionally puts a short message " +
          "on their screen. Rate limited so it cannot be used to badger someone.",
        params: circleIdParam.extend({ userId: z.string().uuid() }),
        body: z
          .object({
            quickKey: z.enum(QUICK_MESSAGE_KEYS).optional(),
            body: z.string().trim().min(1).max(DEFAULTS.maxMessageLength).optional(),
          })
          .optional(),
      },
      config: { rateLimit: { max: 6, timeWindow: "10 minutes" } },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      if (request.params.userId === auth.userId) {
        throw badRequest("You do not need to nudge yourself.")
      }

      const [target] = await db
        .select({ userId: circleMembers.userId, sharingState: circleMembers.sharingState })
        .from(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, request.params.userId),
          ),
        )
        .limit(1)
      if (!target) throw notFound("That person is not in this circle.")
      if (target.sharingState === "paused") {
        throw forbidden("That member has paused location sharing.")
      }

      const [actor] = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          avatarColor: users.avatarColor,
          avatarUrl: users.avatarUrl,
        })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)
      const name = actor?.displayName ?? "Someone"

      const quickKey = request.body?.quickKey ?? null
      const messageBody =
        request.body?.body ??
        (quickKey ? (QUICK_MESSAGES.find((m) => m.key === quickKey)?.body ?? null) : null)

      // recordEvent puts it in the feed and queues the push through the path
      // that honours each member's mute settings, narrowed to the one person
      // it is aimed at.
      const dto = await recordEvent(db, {
        circleId: membership.circleId,
        type: "nudge_requested",
        actorUserId: auth.userId,
        payload: { targetUserId: target.userId, quickKey, body: messageBody },
        summary: messageBody ? `${name}: ${messageBody}` : `${name} asked for a location update`,
        notify: {
          title: messageBody ? name : "Location requested",
          body: messageBody ?? `${name} asked where you are.`,
          channel: "alerts",
          priority: "high",
          onlyUserIds: [target.userId],
          data: { fromUserId: auth.userId },
        },
      })

      // On the user topic rather than the circle's, so it reaches the one
      // person without every other socket having to filter it out.
      await getBus()?.publish(userTopic(target.userId), {
        type: "nudge",
        circleId: membership.circleId,
        nudge: {
          circleId: membership.circleId,
          from: toPublicUser(actor!),
          body: messageBody,
          quickKey,
          sentAt: dto.occurredAt,
        },
      })

      return { ok: true }
    },
  )
}
