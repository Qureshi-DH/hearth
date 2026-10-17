import {
  coarsenLocation,
  DEFAULTS,
  placeAt,
  QUICK_MESSAGE_KEYS,
  QUICK_MESSAGES,
  SHARING_STATES,
  SOS_REASONS,
  type NudgeResponse,
  type RaiseSosResponse,
  type SharingState,
  type SosAlert,
} from "@hearth/shared"
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import {
  checkIns,
  circleMembers,
  circles,
  events,
  places,
  sosAlerts,
  userPresence,
  users,
} from "../db/schema"
import { badRequest, notFound } from "../lib/errors"
import { circleTopic, userTopic } from "../lib/bus"
import { toPublicUser } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { getBus } from "../runtime"
import { recordEvent } from "../services/feed"
import { messagesGroup, outingGroup } from "../services/notification-groups"
import { effectiveSharingState } from "../services/presence"
import { enqueuePush } from "../services/push"
import {
  alertPosition,
  assignRecipients,
  openSosAlerts,
  sosReason,
  startSosLive,
  type SosAlertRow,
} from "../services/sos"
import { askPhoneForFix } from "../services/wake"

const circleIdParam = z.object({ circleId: z.string().uuid() })

/**
 * The same words to the same person inside this long are one ask tapped
 * twice, or tapped again because nothing seemed to happen, and a second
 * notification says nothing the first did not.
 */
const NUDGE_HELD_MS = 60 * 1000

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

/** Paused beats approximate beats precise, which is the order SHARING_STATES lists them in. */
function lessPrecise(a: SharingState, b: SharingState): SharingState {
  return SHARING_STATES.indexOf(a) >= SHARING_STATES.indexOf(b) ? a : b
}

export const safetyRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.post(
    "/circles/:circleId/sos",
    {
      preHandler: app.authenticate,
      config: {
        // A press on an alert that is already open writes nothing and pushes
        // nothing, so pressing again on a bad signal, or a phone retrying an
        // automatic alert, must never meet this. A 429 behind a firewall that
        // blocks on any 4xx silences every phone in the house. One press
        // covers every circle, so the budget is the account's. What keeps SOS
        // from being used to badger people is the cap on fresh alarms in
        // openSosAlerts, which a repeat never touches.
        rateLimit: { max: 60, timeWindow: "10 minutes" },
      },
      schema: {
        tags: ["safety"],
        summary: "Raise an SOS alert",
        description:
          "Raises the caller's alert in every circle they belong to, or with `reason: incident` " +
          "(a crash prompt nobody answered) in the circles that turned crash alerts on and this " +
          "one. Every other member of those circles is notified once at the highest priority " +
          "the transport allows, whatever their mutes, however many of the circles they share " +
          "with the sender. The sender's sharing goes back to precise in each of those circles " +
          "and stays there, since an SOS from someone whose location is paused would be " +
          "useless. While an alert is open the sender's phone is held on live updates, a fix a " +
          "second, by its control channel and its upload replies, until shortly after it is " +
          "resolved. Pressing again while it is open raises nothing and answers 200 with what " +
          "is already open, so a client may retry freely, and 201 means something new was " +
          "raised. The reply is the alert in this circle, with `alerts` holding one per circle.",
        params: circleIdParam,
        body: z
          .object({
            note: z.string().max(500).nullish(),
            reason: z.enum(SOS_REASONS).optional(),
          })
          // Nullish, because a POST with no body reaches validation as null,
          // and refusing an SOS over its envelope is the worst 400 there is.
          .nullish(),
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      const now = new Date()

      const raised = await openSosAlerts(db, {
        userId: auth.userId,
        circleId: membership.circleId,
        note: request.body?.note ?? null,
        reason: sosReason(request.body),
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

      // A display name reaches these circles through a push title and a feed
      // line, and it is stored as typed.
      const name = singleLine(actor?.displayName ?? "") || "Someone"

      for (const alert of raised.created) {
        await recordEvent(db, {
          circleId: alert.circleId,
          type: "sos_started",
          actorUserId: auth.userId,
          payload: { alertId: alert.id, note: alert.note },
          summary: singleLine(`${name} raised an SOS`),
        })
      }

      const members = await db
        .select({ circleId: circleMembers.circleId, userId: circleMembers.userId })
        .from(circleMembers)
        .where(
          inArray(
            circleMembers.circleId,
            raised.alerts.map((alert) => alert.circleId),
          ),
        )
      // Somebody in a circle where it was already open was told when it opened.
      const openBefore = new Set(raised.alreadyOpen.map((alert) => alert.circleId))
      const told = new Set([
        auth.userId,
        ...members.filter((m) => openBefore.has(m.circleId)).map((m) => m.userId),
      ])
      const recipients = assignRecipients(raised.created, members, told)

      // No mute filter. This is the one alert an earlier "mute this circle" tap
      // is not allowed to silence.
      await enqueuePush(
        db,
        raised.created.flatMap((alert) =>
          (recipients.get(alert.id) ?? []).map((userId) => ({
            userId,
            circleId: alert.circleId,
            title: `🚨 SOS from ${name}`,
            body: singleLine(alert.note ?? "") || "Tap to see their location.",
            channel: "sos" as const,
            priority: "high" as const,
            data: { type: "sos_started", alertId: alert.id, circleId: alert.circleId },
          })),
        ),
      )

      for (const alert of raised.created) {
        await getBus()?.publish(circleTopic(alert.circleId), {
          type: "sos",
          circleId: alert.circleId,
          alertId: alert.id,
          userId: auth.userId,
        })
      }

      await startSosLive(db, auth.userId, now)

      const [presence] = await db
        .select({
          lat: userPresence.lat,
          lon: userPresence.lon,
          recordedAt: userPresence.recordedAt,
        })
        .from(userPresence)
        .where(eq(userPresence.userId, auth.userId))
        .limit(1)

      // Unprojected, since this reply goes to the person who raised it.
      const user = toPublicUser(
        actor ?? { id: auth.userId, displayName: name, avatarColor: "#888888", avatarUrl: null },
      )
      const toAlert = (alert: SosAlertRow): SosAlert => ({
        id: alert.id,
        circleId: alert.circleId,
        user,
        startedAt: alert.startedAt.toISOString(),
        resolvedAt: null,
        resolvedBy: null,
        note: alert.note,
        lastLat: presence?.lat ?? null,
        lastLon: presence?.lon ?? null,
        lastFixAt: presence?.recordedAt?.toISOString() ?? null,
      })
      const notified = new Set(members.map((member) => member.userId))
      notified.delete(auth.userId)

      return reply.code(raised.created.length > 0 ? 201 : 200).send({
        ...toAlert(raised.alerts[0]!),
        notifiedMembers: notified.size,
        alerts: raised.alerts.map(toAlert),
      } satisfies RaiseSosResponse)
    },
  )

  app.post(
    "/sos/:alertId/resolve",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["safety"],
        summary: "Mark an SOS as resolved",
        description:
          "The person who raised it, or any admin of that circle, may resolve it. The person " +
          "who raised it closes their alert in every circle it is open in, since they have one " +
          "emergency at a time, even through an alert an admin already closed. An admin closes " +
          "the one in their own circle. Every circle closed gets its own feed entry, and each " +
          "of its members one notice.",
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
      const own = alert.userId === auth.userId
      // An admin may have closed this circle's copy and left the raiser's
      // others open, and the raiser's app may only know this one's id.
      if (alert.resolvedAt && !own) return { ok: true, alreadyResolved: true }

      await requireMembership(request, alert.circleId, own ? "member" : "admin")

      // The read above is a courtesy, not a guard, since two admins tapping at
      // the same moment both pass it. Putting the same condition in the WHERE
      // makes the close itself the arbiter, so only one request writes each
      // row, its feed entry and its pushes, and the loser gets the answer a
      // retry after a lost response would have got anyway.
      const closed = await db
        .update(sosAlerts)
        .set({ resolvedAt: new Date(), resolvedBy: auth.userId })
        .where(
          and(
            own ? eq(sosAlerts.userId, auth.userId) : eq(sosAlerts.id, alert.id),
            isNull(sosAlerts.resolvedAt),
          ),
        )
        .returning()
      if (closed.length === 0) return { ok: true, alreadyResolved: true }

      const [actor] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)
      const name = singleLine(actor?.displayName ?? "") || "Someone"

      // One all clear each, naming the alert their alarm named. An admin
      // closes one circle's alert, and that whole circle hears it.
      const notices = own
        ? assignRecipients(
            closed,
            await db
              .select({ circleId: circleMembers.circleId, userId: circleMembers.userId })
              .from(circleMembers)
              .where(
                inArray(
                  circleMembers.circleId,
                  closed.map((row) => row.circleId),
                ),
              ),
            new Set(),
          )
        : null

      for (const row of closed) {
        await recordEvent(db, {
          circleId: row.circleId,
          type: "sos_resolved",
          actorUserId: auth.userId,
          payload: { alertId: row.id },
          summary: `${name} marked the SOS as resolved`,
          notify: {
            title: "SOS resolved",
            body: `${name} marked the alert as resolved.`,
            channel: "alerts",
            excludeActor: false,
            data: { alertId: row.id },
            ...(notices ? { onlyUserIds: notices.get(row.id) ?? [] } : {}),
          },
        })
        // Clears the banner on maps open on a circle other than the one the
        // resolve came from.
        await getBus()?.publish(circleTopic(row.circleId), {
          type: "sos",
          circleId: row.circleId,
          alertId: row.id,
          userId: row.userId,
        })
      }

      const answered = closed.find((row) => row.id === alert.id) ?? closed[0]!
      return { ok: true, resolvedAt: answered.resolvedAt?.toISOString() ?? null }
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
        .select({
          alert: sosAlerts,
          user: users,
          resolver,
          presence: userPresence,
          subject,
          settings: circles.settings,
        })
        .from(sosAlerts)
        .innerJoin(circles, eq(circles.id, sosAlerts.circleId))
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
        const seen = alertPosition(
          {
            alert: row.alert,
            member: row.subject,
            presence: row.presence,
            allowSharingPause: row.settings.allowSharingPause,
          },
          auth.userId,
          now,
        )

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

      const match = placeAt(nearby, { lat: request.body.lat, lon: request.body.lon })

      const [created] = await db
        .insert(checkIns)
        .values({
          circleId: membership.circleId,
          userId: auth.userId,
          lat: request.body.lat,
          lon: request.body.lon,
          note: request.body.note ?? null,
          placeId: match?.id ?? null,
          sharedAs: shared,
        })
        .returning()
      if (!created) throw badRequest("Could not record the check-in.")

      const [actor] = await db
        .select({ displayName: users.displayName })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)
      const name = singleLine(actor?.displayName ?? "") || "Someone"

      // The row keeps what she reported. The feed line is coarsened to what
      // this circle may know now, and the events route strips its place again
      // on every read if she later stops sharing precisely.
      const seen = projectCheckIn(
        shared,
        { lat: created.lat, lon: created.lon },
        match ? { id: match.id, name: match.name } : null,
      )
      const where = seen.placeName ? ` at ${seen.placeName}` : ""
      const checkedIn = singleLine(`in${where}.${created.note ? ` "${created.note}"` : ""}`)

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
          body: `${name} checked ${checkedIn}`,
          group: outingGroup(auth.userId, name, `Checked ${checkedIn}`),
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
        description:
          "Each one is shown no more exactly than the circle could see its maker when it was " +
          "made, and no more exactly than it can see them now. Approximate gives the grid cell " +
          "and no place, paused or gone from the circle gives no position at all. Your own are " +
          "always exact.",
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
        // position behind in it. Turning it back up does not bring one back,
        // since it was made under the state stored with it. Your own are
        // always yours.
        const current: SharingState = row.subject
          ? effectiveSharingState(
              row.subject.sharingState,
              row.subject.pausedUntil,
              now,
              row.subject.resumeToState,
            )
          : "paused"
        const state: SharingState =
          row.checkIn.userId === membership.userId
            ? "precise"
            : row.checkIn.sharedAs
              ? lessPrecise(row.checkIn.sharedAs, current)
              : current
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
          "Sends one member a notification asking where they are, or a short message, and " +
          "records it in the circle's feed. A bare ask for a location also asks their phone " +
          "for a fix, the way POST /circles/{circleId}/members/{userId}/refresh does, and " +
          "`asked` says what became of that in the same words. A message asks nothing of the " +
          "phone and reaches a member who paused sharing, since a message is not a location. " +
          "A bare ask to a paused member sends nothing and answers `notified: paused`, and " +
          "one to a member sharing approximately is sent without waking the phone and " +
          "answers `asked: unsupported`, as the refresh route does. Somebody no longer in " +
          "the circle is sent nothing and answers `notified: gone`. The same words to the " +
          "same person within a minute are not sent twice (`notified: held`). Rate limited " +
          "so it cannot be used to badger someone.",
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
      config: { rateLimit: { max: DEFAULTS.maxNudgesPerTenMinutes, timeWindow: "10 minutes" } },
    },
    async (request): Promise<NudgeResponse> => {
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
      const now = new Date()
      const quickKey = request.body?.quickKey ?? null
      const messageBody =
        request.body?.body ??
        (quickKey ? (QUICK_MESSAGES.find((m) => m.key === quickKey)?.body ?? null) : null)
      // Their page stays up after they leave, and a 404 for pressing its
      // button is a 4xx in ordinary use. It says no more than the 404 did.
      if (!target) return { ok: true, notified: "gone", asked: messageBody ? null : "unsupported" }

      // Through the same helper the map reads, so a pause that has run out
      // stops counting here at the moment it stops hiding her on the map. A
      // stale phone during a lapsed pause is the case a nudge is for. A pause
      // answers a bare ask for a location and nothing else.
      const targetState = effectiveSharingState(
        target.sharingState,
        target.pausedUntil,
        now,
        target.resumeToState,
      )
      if (!messageBody && targetState === "paused") {
        return { ok: true, notified: "paused", asked: "paused" }
      }

      const recent = await db
        .select({ payload: events.payload })
        .from(events)
        .where(
          and(
            eq(events.circleId, membership.circleId),
            eq(events.type, "nudge_requested"),
            eq(events.actorUserId, auth.userId),
            sql`${events.payload}->>'targetUserId' = ${target.userId}`,
            gte(events.occurredAt, new Date(now.getTime() - NUDGE_HELD_MS)),
          ),
        )
      const repeated = recent.some(
        (row) => ((row.payload as { body?: string | null }).body ?? null) === messageBody,
      )
      if (repeated) return { ok: true, notified: "held", asked: messageBody ? null : "held" }

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
          group: messagesGroup(auth.userId, name, oneLine || "Asked where you are"),
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

      // The notification only moves an app that gets to run when it lands,
      // so a bare ask goes to the phone as well, for a member sharing
      // precisely. What became of it says whether their phone is connected
      // or reported a moment ago, which the member's page and Live withhold
      // from anyone they share less with, so this does too.
      const asked = messageBody
        ? null
        : targetState === "precise"
          ? await askPhoneForFix(db, target.userId, now)
          : "unsupported"
      return { ok: true, notified: "sent", asked }
    },
  )
}
