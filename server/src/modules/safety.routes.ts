import {
  coarsenLocation,
  DEFAULTS,
  haversineMeters,
  QUICK_MESSAGE_KEYS,
  QUICK_MESSAGES,
  type SharingState,
} from "@hearth/shared"
import { and, desc, eq, isNull } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { checkIns, circleMembers, places, sosAlerts, userPresence, users } from "../db/schema"
import { badRequest, conflict, forbidden, notFound } from "../lib/errors"
import { circleTopic, userTopic } from "../lib/bus"
import { toPublicUser } from "../lib/serialize"
import { rateLimitKey, requireAuth, requireMembership } from "../plugins/auth"
import { getBus } from "../runtime"
import { recordEvent } from "../services/feed"
import { effectiveSharingState, preciseSinceAfter, projectPresence } from "../services/presence"
import { enqueuePush } from "../services/push"

const circleIdParam = z.object({ circleId: z.string().uuid() })

const resolver = alias(users, "resolver")
// The row's subject, which is rarely the caller, so it cannot reuse the
// membership row requireMembership already loaded.
const subject = alias(circleMembers, "subject_member")

/**
 * Characters that carry no width but change how a line reads. Kept to the ones
 * with no legitimate use in a sentence: the tab and the two line breaks are
 * deliberately absent, because \s+ below folds them away anyway.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B\u202A-\u202E\u2060\uFEFF]/gu

/** Anything Unicode calls a combining mark. */
const COMBINING_RUN = /\p{M}{4,}/gu

/**
 * Flattens one composed line. A push title, a push body and a feed summary are
 * each a single line of text built from things a member typed, and a newline
 * in any of them forges a second line in everybody else's notification while
 * seventy stacked accents smear over the rows underneath.
 *
 * This runs where the line is built rather than where the text is stored,
 * because a check-in note and a nudge message are legitimately several lines
 * and the stored copy has to keep them.
 */
function singleLine(value: string): string {
  return value
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(COMBINING_RUN, (run) => [...run].slice(0, 3).join(""))
    .replace(/\s+/gu, " ")
    .trim()
}

/**
 * What one circle may be told about a check-in. The button reports a position
 * like any other fix, so it answers to the same per-circle setting: a circle on
 * the coarse grid is told the cell and never the building, and one that is
 * paused hears that she is fine and nothing about where. Without this, checking
 * in every minute would hand out the exact doorstep the map is refusing to show.
 */
function projectCheckIn(
  state: SharingState,
  point: { lat: number; lon: number },
  place: { id: string; name: string } | null,
): { lat: number | null; lon: number | null; placeId: string | null; placeName: string | null } {
  if (state === "paused") return { lat: null, lon: null, placeId: null, placeName: null }
  if (state === "approximate") {
    const coarse = coarsenLocation(point)
    return { lat: coarse.lat, lon: coarse.lon, placeId: null, placeName: null }
  }
  return {
    lat: point.lat,
    lon: point.lon,
    placeId: place?.id ?? null,
    placeName: place?.name ?? null,
  }
}

export const safetyRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.post(
    "/circles/:circleId/sos",
    {
      preHandler: app.authenticate,
      // SOS bypasses mutes and fires at top priority, so spamming it must be hard.
      config: {
        rateLimit: {
          max: 3,
          timeWindow: "10 minutes",
          // Per circle, not per account. Spamming means badgering an audience,
          // and the audience is one circle. Somebody in four circles holding
          // the button in each is one emergency reaching everyone who might be
          // near them, and an account-wide budget answers the last circle 429
          // and tells nobody in it anything.
          keyGenerator: (request) => {
            const account = rateLimitKey(app, request)
            // An unauthenticated caller falls back to their address, and
            // splitting that per path parameter would hand anyone an unlimited
            // supply of fresh buckets by inventing circle ids.
            if (!account.startsWith("user:")) return account
            const { circleId } = request.params as { circleId?: string }
            return `${account}:${circleId ?? ""}`
          },
        },
      },
      schema: {
        tags: ["safety"],
        summary: "Raise an SOS alert",
        description:
          "Notifies every other member at the highest priority the transport allows, and " +
          "switches the sender's sharing back to precise and leaves it there. An SOS from " +
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
          // resume_to_state goes with the pause it belonged to. Left behind, the
          // next pause coalesces onto it, and one raised during an approximate
          // pause would make an unrelated pause weeks later resume to
          // approximate rather than to the precise state this line just set.
          .set({
            sharingState: "precise",
            preciseSince: preciseSinceAfter("precise"),
            pausedUntil: null,
            resumeToState: null,
          })
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

      // A display name reaches this circle through a push title and a feed
      // line, and it is stored as typed.
      const name = singleLine(actor?.displayName ?? "") || "Someone"

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "sos_started",
        actorUserId: auth.userId,
        payload: { alertId: alert.id, note: alert.note },
        summary: singleLine(`${name} raised an SOS`),
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
          body: singleLine(alert.note ?? "") || "Tap to see their location.",
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

      // The read above is a courtesy, not a guard: two admins tapping at the
      // same moment both pass it. Putting the same condition in the WHERE makes
      // the close itself the arbiter, so only one request writes the row, the
      // feed entry and the pushes, and the loser gets the answer a retry after
      // a lost response would have got anyway.
      const [resolved] = await db
        .update(sosAlerts)
        .set({ resolvedAt: new Date(), resolvedBy: auth.userId })
        .where(and(eq(sosAlerts.id, alert.id), isNull(sosAlerts.resolvedAt)))
        .returning()
      if (!resolved) return { ok: true, alreadyResolved: true }

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

      return { ok: true, resolvedAt: resolved.resolvedAt?.toISOString() ?? null }
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
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      const now = new Date()

      const rows = await db
        .select({ alert: sosAlerts, user: users, resolver, presence: userPresence, subject })
        .from(sosAlerts)
        .innerJoin(users, eq(users.id, sosAlerts.userId))
        .leftJoin(resolver, eq(resolver.id, sosAlerts.resolvedBy))
        .leftJoin(userPresence, eq(userPresence.userId, sosAlerts.userId))
        // Left, not inner: somebody can leave a circle with an alert still
        // open, and the alert stays in the circle's own record. Their presence
        // row keeps updating from the circles they are still in, so without
        // this join the list would follow them around after they left.
        .leftJoin(
          subject,
          and(eq(subject.circleId, sosAlerts.circleId), eq(subject.userId, sosAlerts.userId)),
        )
        .where(
          and(
            eq(sosAlerts.circleId, membership.circleId),
            request.query.activeOnly ? isNull(sosAlerts.resolvedAt) : undefined,
          ),
        )
        .orderBy(desc(sosAlerts.startedAt))
        .limit(request.query.limit)

      return rows.map((row) => {
        // Raising an SOS un-pauses the raiser by writing sharingState, so an
        // ordinary open alert still hands the circle an exact live position.
        // Reading user_presence raw would make it a read-time bypass on top of
        // that write, and this list would keep tracking somebody who set their
        // sharing back or left the circle, while the map honoured them.
        const seen =
          row.subject && !row.alert.resolvedAt
            ? projectPresence(
                {
                  userId: row.alert.userId,
                  sharingState: row.subject.sharingState,
                  pausedUntil: row.subject.pausedUntil,
                  resumeToState: row.subject.resumeToState,
                  lat: row.presence?.lat ?? null,
                  lon: row.presence?.lon ?? null,
                  accuracyMeters: row.presence?.accuracyMeters ?? null,
                  recordedAt: row.presence?.recordedAt ?? null,
                  batteryLevel: row.presence?.batteryLevel ?? null,
                  isCharging: row.presence?.isCharging ?? null,
                  activity: row.presence?.activity ?? null,
                  speedMps: row.presence?.speedMps ?? null,
                  headingDegrees: row.presence?.headingDegrees ?? null,
                },
                auth.userId,
                { atPlace: null, sosAlertId: row.alert.id, now },
              )
            : null

        return {
          id: row.alert.id,
          circleId: row.alert.circleId,
          user: toPublicUser(row.user),
          startedAt: row.alert.startedAt.toISOString(),
          resolvedAt: row.alert.resolvedAt?.toISOString() ?? null,
          resolvedBy: row.resolver ? toPublicUser(row.resolver) : null,
          note: row.alert.note,
          lastLat: seen?.lat ?? null,
          lastLon: seen?.lon ?? null,
          // On its own this still says the phone reported a moment ago, which
          // is the one thing a pause is meant to withhold, so it follows the
          // coordinates rather than being served unconditionally.
          lastFixAt: seen?.recordedAt ?? null,
        }
      })
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

      // The membership row stops short of resume_to_state, and a pause that has
      // run out has to land on the state its owner chose before it, or checking
      // in publishes the exact position that state was turned down to hide.
      const [gate] = await db
        .select({ resumeToState: circleMembers.resumeToState })
        .from(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, auth.userId),
          ),
        )
        .limit(1)
      const shared = effectiveSharingState(
        membership.sharingState,
        membership.pausedUntil,
        new Date(),
        gate?.resumeToState ?? null,
      )

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
      const name = singleLine(actor?.displayName ?? "") || "Someone"

      // The row keeps what she reported. The feed keeps what this circle is
      // allowed to know, and it keeps it forever, so the coarsening happens
      // before the write rather than on the way out.
      const seen = projectCheckIn(
        shared,
        { lat: created.lat, lon: created.lon },
        match ? { id: match.id, name: match.name } : null,
      )
      const where = seen.placeName ? ` at ${seen.placeName}` : ""

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "check_in",
        actorUserId: auth.userId,
        payload: {
          checkInId: created.id,
          lat: seen.lat,
          lon: seen.lon,
          placeId: seen.placeId,
          note: created.note,
        },
        summary: singleLine(`${name} checked in${where}`),
        notify: {
          title: "Check-in",
          body: singleLine(
            `${name} checked in${where}.${created.note ? ` "${created.note}"` : ""}`,
          ),
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

      // Unprojected: this reply goes to the one person who just checked in,
      // and the confirmation screen names the place she is standing in.
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
      const now = new Date()
      const rows = await db
        .select({ checkIn: checkIns, user: users, placeName: places.name, subject })
        .from(checkIns)
        .innerJoin(users, eq(users.id, checkIns.userId))
        .leftJoin(places, eq(places.id, checkIns.placeId))
        // Left, not inner: a check-in belongs to the circle's own record and
        // stays in it after the person who made it leaves.
        .leftJoin(
          subject,
          and(eq(subject.circleId, checkIns.circleId), eq(subject.userId, checkIns.userId)),
        )
        .where(eq(checkIns.circleId, membership.circleId))
        .orderBy(desc(checkIns.createdAt))
        .limit(request.query.limit)

      return rows.map((row) => {
        // Read time, like the map: turning sharing down has to take the old
        // check-ins with it, and somebody who has left the circle leaves no
        // position behind in it. Your own are always yours.
        const state: SharingState =
          row.checkIn.userId === membership.userId
            ? "precise"
            : row.subject
              ? effectiveSharingState(
                  row.subject.sharingState,
                  row.subject.pausedUntil,
                  now,
                  row.subject.resumeToState,
                )
              : "paused"
        const seen = projectCheckIn(
          state,
          { lat: row.checkIn.lat, lon: row.checkIn.lon },
          row.checkIn.placeId && row.placeName
            ? { id: row.checkIn.placeId, name: row.placeName }
            : null,
        )

        return {
          id: row.checkIn.id,
          circleId: row.checkIn.circleId,
          user: toPublicUser(row.user),
          lat: seen.lat,
          lon: seen.lon,
          note: row.checkIn.note,
          placeId: seen.placeId,
          placeName: seen.placeName,
          createdAt: row.checkIn.createdAt.toISOString(),
        }
      })
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
          // nullish, not optional: a POST with no body at all reaches
          // validation as null, and a bare nudge that carries no message is
          // the original shape of this route.
          .nullish(),
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
        .select({
          userId: circleMembers.userId,
          sharingState: circleMembers.sharingState,
          pausedUntil: circleMembers.pausedUntil,
          resumeToState: circleMembers.resumeToState,
        })
        .from(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, request.params.userId),
          ),
        )
        .limit(1)
      if (!target) throw notFound("That person is not in this circle.")
      // Through the same helper the map reads, so a pause that has run out
      // stops refusing here at the moment it stops hiding her on the map. A
      // stale phone during a lapsed pause is the case a nudge is for.
      const targetState = effectiveSharingState(
        target.sharingState,
        target.pausedUntil,
        new Date(),
        target.resumeToState,
      )
      if (targetState === "paused") {
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
      const name = singleLine(actor?.displayName ?? "") || "Someone"

      const quickKey = request.body?.quickKey ?? null
      const messageBody =
        request.body?.body ??
        (quickKey ? (QUICK_MESSAGES.find((m) => m.key === quickKey)?.body ?? null) : null)
      // The message keeps its own shape in the payload, which the app renders
      // as a block of text. The feed line and the push are one line each.
      const oneLine = messageBody ? singleLine(messageBody) : ""

      // recordEvent puts it in the feed and queues the push through the path
      // that honours each member's mute settings, narrowed to the one person
      // it is aimed at.
      const dto = await recordEvent(db, {
        circleId: membership.circleId,
        type: "nudge_requested",
        actorUserId: auth.userId,
        payload: { targetUserId: target.userId, quickKey, body: messageBody },
        summary: oneLine ? `${name}: ${oneLine}` : `${name} asked for a location update`,
        notify: {
          title: oneLine ? name : "Location requested",
          body: oneLine || `${name} asked where you are.`,
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
