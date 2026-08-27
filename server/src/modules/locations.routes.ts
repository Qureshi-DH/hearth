import {
  ACTIVITY_TYPES,
  DEFAULTS,
  LOCATION_SOURCES,
  PRESENCE_ISSUES,
  type RefreshMemberResponse,
  type WatchResponse,
} from "@hearth/shared"
import { and, asc, eq, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, circles, locationPoints, sessions, trips, userPresence } from "../db/schema"
import { badRequest, forbidden, notFound } from "../lib/errors"
import { requireAuth, requireMembership } from "../plugins/auth"
import { getPushDriver } from "../runtime"
import { ingestPoints, markHeard } from "../services/locations"
import { effectiveSharingState, getCirclePresence, presenceIssues } from "../services/presence"
import { sendControl } from "../services/control"
import { enqueuePush, recentSilentPushes } from "../services/push"

// Accuracy fields are deliberately not constrained here. A platform sentinel
// in one optional field would otherwise fail the whole array, and the client
// treats a 400 as a poison batch and discards every fix in it. normalize()
// clamps these into range instead.
const fixSchema = z.object({
  recordedAt: z.string().datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyMeters: z.number().nullish(),
  altitudeMeters: z.number().nullish(),
  altitudeAccuracyMeters: z.number().nullish(),
  speedMps: z.number().nullish(),
  headingDegrees: z.number().nullish(),
  activity: z.enum(ACTIVITY_TYPES).nullish(),
  batteryLevel: z.number().min(0).max(1).nullish(),
  isCharging: z.boolean().nullish(),
  isMoving: z.boolean().nullish(),
  source: z.enum(LOCATION_SOURCES).optional(),
})

// Postgres has no year zero, so "0000-01-01T00:00:00Z" clears zod's calendar
// check and then aborts the query inside the driver, turning a query string
// into a 500 on routes that read and delete history. Nothing Hearth stores is
// stamped outside this window, so the edge is where it gets rejected.
const MIN_TIMESTAMP_MS = Date.UTC(1970, 0, 1)
const MAX_TIMESTAMP_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

const isoTimestamp = z
  .string()
  .datetime()
  .refine((value) => {
    const ms = Date.parse(value)
    return ms >= MIN_TIMESTAMP_MS && ms <= MAX_TIMESTAMP_MS
  }, "Timestamp is out of the supported range.")

/**
 * A silent push is the only way to ask a phone in the background for a fix,
 * and iOS delivers only a few an hour, so nobody looking at the map may spend
 * them faster than this on any one phone.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000
/** A phone heard from this recently has nothing new to say. */
const FRESH_ENOUGH_MS = 2 * 60 * 1000
/**
 * A page opened on one person asks their phone at once, and again on the
 * next open, but not twice in the same half minute: the fix takes a few
 * seconds and the channel or the push has already carried the ask.
 */
const MEMBER_REFRESH_FRESH_MS = 30 * 1000
/**
 * Watching is spent more freely: a page open on one person is worth more
 * than a glance at everyone. The page calls every minute to hold the window,
 * so a phone that has not uploaded since the first push is asked again on
 * the second call, and a phone that is not going to answer is not chased
 * all evening.
 */
const WATCH_REPUSH_AFTER_MS = 90 * 1000
const WATCH_PUSHES_PER_WINDOW = 3
/**
 * How long a phone with its channel open is given to answer an ask down it
 * before the next hold stops trusting the channel. An answer takes a second
 * or two; a socket iOS let die without a close keeps its stamp for minutes,
 * and the page would otherwise re-ask down the dead socket every minute for
 * the whole window.
 */
const CONTROL_ANSWER_GRACE_MS = 20 * 1000

const nothingToWatch: WatchResponse = {
  watching: false,
  seconds: 0,
  pushed: "unsupported",
  lastFixAt: null,
  lastHeardAt: null,
  activity: null,
  issues: [],
}

export const locationRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  /**
   * What the watch did about the phone, in the words the Live page shows.
   * "Held" is the ordinary answer on the calls that hold a window open, and
   * the re-push is for a phone that has not uploaded since the first push,
   * because that is the one the push may never have reached.
   */
  async function pushForWatch(
    userId: string,
    now: Date,
    heardAt: Date | null,
    seconds: number,
    previousAskAt: Date | null,
  ): Promise<WatchResponse["pushed"]> {
    // A phone with its channel open has the ask already; nothing is pushed.
    // Unless the last ask went down it and nothing has been heard since: a
    // phone that took the ask uploads within seconds, so that silence is a
    // channel that is not what its stamp says.
    const unanswered =
      previousAskAt != null &&
      now.getTime() - previousAskAt.getTime() >= CONTROL_ANSWER_GRACE_MS &&
      now.getTime() - previousAskAt.getTime() <= seconds * 1000 &&
      (heardAt == null || heardAt.getTime() <= previousAskAt.getTime())
    if (!unanswered && (await sendControl(db, userId, { command: "watch", seconds }, now))) {
      return "socket"
    }
    if (getPushDriver()?.provider !== "expo") return "unsupported"
    const [device] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          eq(sessions.pushProvider, "expo"),
          isNotNull(sessions.pushToken),
        ),
      )
      .limit(1)
    if (!device) return "no_device"

    const pushes = await recentSilentPushes(
      db,
      userId,
      "watch",
      new Date(now.getTime() - seconds * 1000),
    )
    if (pushes.length > 0) {
      const newest = pushes[0]!
      const first = pushes[pushes.length - 1]!
      const answered = heardAt != null && heardAt.getTime() > first.createdAt.getTime()
      if (
        answered ||
        pushes.length >= WATCH_PUSHES_PER_WINDOW ||
        now.getTime() - newest.createdAt.getTime() < WATCH_REPUSH_AFTER_MS
      ) {
        return "held"
      }
    }
    await enqueuePush(db, [
      { userId, title: "", body: "", silent: true, data: { type: "watch", seconds } },
    ])
    return "sent"
  }

  app.post(
    "/locations/batch",
    {
      preHandler: app.authenticate,
      config: {
        // Background uploads are chatty, so they get a budget of their own.
        rateLimit: { max: 240, timeWindow: "1 minute" },
      },
      schema: {
        tags: ["locations"],
        summary: "Upload location fixes",
        description:
          "Accepts a batch of fixes from one device. Duplicates (same device and timestamp) " +
          "are ignored, so a client may safely retry a failed upload. The response carries " +
          "the tracking policy the device should apply from now on.",
        body: z.object({
          points: z.array(fixSchema).min(1).max(DEFAULTS.maxLocationBatchSize),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)

      const [session] = await db
        .select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(eq(sessions.id, auth.sessionId))
        .limit(1)
      if (!session) throw forbidden("This device is no longer registered.")

      // Before the batch is judged: a phone that reached the server is alive
      // whatever it carried, and the sweep must not call it offline.
      await markHeard(db, auth.userId, new Date())

      const result = await ingestPoints(db, {
        userId: auth.userId,
        deviceId: session.deviceId,
        points: request.body.points,
      })

      // The strictest circle wins. If one circle wants fast updates the device
      // has to provide them, and the others see more fixes than they need.
      const policyRows = await db
        .select({ settings: circles.settings })
        .from(circleMembers)
        .innerJoin(circles, eq(circles.id, circleMembers.circleId))
        .where(eq(circleMembers.userId, auth.userId))

      const minInterval = policyRows.length
        ? Math.min(...policyRows.map((row) => row.settings.minUpdateIntervalSeconds))
        : DEFAULTS.minUpdateIntervalSeconds
      const distanceFilter = policyRows.length
        ? Math.min(...policyRows.map((row) => row.settings.distanceFilterMeters))
        : DEFAULTS.distanceFilterMeters

      const [watch] = await db
        .select({ until: userPresence.watchedUntil })
        .from(userPresence)
        .where(eq(userPresence.userId, auth.userId))
        .limit(1)
      const watchedUntil =
        watch?.until && watch.until.getTime() > Date.now() ? watch.until.toISOString() : null

      return {
        accepted: result.accepted,
        rejected: result.rejected,
        placeEvents: result.placeEvents,
        serverTime: new Date().toISOString(),
        policy: {
          minUpdateIntervalSeconds: minInterval,
          distanceFilterMeters: distanceFilter,
        },
        watchedUntil,
      }
    },
  )

  app.post(
    "/circles/:circleId/locations/refresh",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
      schema: {
        tags: ["locations"],
        summary: "Ask the circle's quiet phones for a fresh fix",
        description:
          "Called when someone opens the map. Every member who has not reported for a couple " +
          "of minutes gets a silent push asking for one fix, at most once every ten minutes " +
          "per phone whoever is looking. Members who paused sharing are left alone. Nothing " +
          "is sent on a push provider that cannot carry a silent push.",
        params: z.object({ circleId: z.string().uuid() }),
        response: { 200: z.object({ asked: z.number().int() }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      const canPush = getPushDriver()?.provider === "expo"

      const now = new Date()
      const rows = await db
        .select({
          userId: circleMembers.userId,
          sharingState: circleMembers.sharingState,
          pausedUntil: circleMembers.pausedUntil,
          resumeToState: circleMembers.resumeToState,
          recordedAt: userPresence.recordedAt,
          lastHeardAt: userPresence.lastHeardAt,
        })
        .from(circleMembers)
        .leftJoin(userPresence, eq(userPresence.userId, circleMembers.userId))
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            ne(circleMembers.userId, auth.userId),
          ),
        )

      let asked = 0
      for (const row of rows) {
        const state = effectiveSharingState(
          row.sharingState,
          row.pausedUntil,
          now,
          row.resumeToState,
        )
        if (state === "paused") continue
        const heardAt = Math.max(row.recordedAt?.getTime() ?? 0, row.lastHeardAt?.getTime() ?? 0)
        if (now.getTime() - heardAt < FRESH_ENOUGH_MS) continue
        if (await sendControl(db, row.userId, { command: "wake" }, now)) {
          asked += 1
          continue
        }
        if (!canPush) continue
        const askedLately = await recentSilentPushes(
          db,
          row.userId,
          "wake",
          new Date(now.getTime() - REFRESH_INTERVAL_MS),
        )
        if (askedLately.length > 0) continue
        await enqueuePush(db, [
          { userId: row.userId, title: "", body: "", silent: true, data: { type: "wake" } },
        ])
        asked += 1
      }
      return { asked }
    },
  )

  app.post(
    "/circles/:circleId/members/:userId/refresh",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
      schema: {
        tags: ["locations"],
        summary: "Ask one person's phone for a fresh fix now",
        description:
          "Called when someone opens a member's page. The phone is asked over its control " +
          "channel when it has one open, and by silent push otherwise, at most once per half " +
          "minute per phone whoever is looking. A phone heard from in the last half minute is " +
          "left alone (`fresh`). Only members sharing precisely are asked.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        response: {
          200: z.object({
            asked: z.enum(["socket", "pushed", "held", "fresh", "no_device", "unsupported"]),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      if (request.params.userId === auth.userId) {
        throw badRequest("You do not need to ask yourself.")
      }
      const [target] = await db
        .select({
          sharingState: circleMembers.sharingState,
          pausedUntil: circleMembers.pausedUntil,
          resumeToState: circleMembers.resumeToState,
          recordedAt: userPresence.recordedAt,
          lastHeardAt: userPresence.lastHeardAt,
        })
        .from(circleMembers)
        .leftJoin(userPresence, eq(userPresence.userId, circleMembers.userId))
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, request.params.userId),
          ),
        )
        .limit(1)
      if (!target) throw notFound("That person is not in this circle.")
      const now = new Date()
      const state = effectiveSharingState(
        target.sharingState,
        target.pausedUntil,
        now,
        target.resumeToState,
      )
      if (state !== "precise") return { asked: "unsupported" } satisfies RefreshMemberResponse
      const heardAt = Math.max(
        target.recordedAt?.getTime() ?? 0,
        target.lastHeardAt?.getTime() ?? 0,
      )
      if (now.getTime() - heardAt < MEMBER_REFRESH_FRESH_MS) {
        return { asked: "fresh" } satisfies RefreshMemberResponse
      }
      if (await sendControl(db, request.params.userId, { command: "wake" }, now)) {
        return { asked: "socket" } satisfies RefreshMemberResponse
      }
      if (getPushDriver()?.provider !== "expo") {
        return { asked: "unsupported" } satisfies RefreshMemberResponse
      }
      const [device] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, request.params.userId),
            isNull(sessions.revokedAt),
            eq(sessions.pushProvider, "expo"),
            isNotNull(sessions.pushToken),
          ),
        )
        .limit(1)
      if (!device) return { asked: "no_device" } satisfies RefreshMemberResponse
      const askedLately = await recentSilentPushes(
        db,
        request.params.userId,
        "wake",
        new Date(now.getTime() - MEMBER_REFRESH_FRESH_MS),
      )
      if (askedLately.length > 0) return { asked: "held" } satisfies RefreshMemberResponse
      await enqueuePush(db, [
        {
          userId: request.params.userId,
          title: "",
          body: "",
          silent: true,
          data: { type: "wake" },
        },
      ])
      return { asked: "pushed" } satisfies RefreshMemberResponse
    },
  )

  app.post(
    "/circles/:circleId/members/:userId/watch",
    {
      preHandler: app.authenticate,
      config: { rateLimit: { max: 60, timeWindow: "10 minutes" } },
      schema: {
        tags: ["locations"],
        summary: "Follow one person live for a while",
        description:
          "Called while someone has a member's page open. The member's phone is asked to " +
          "report at full accuracy every few seconds for the watch window, over its control " +
          "channel when it has one open, by silent push otherwise, and by its next upload " +
          "reply, and the page keeps calling to hold it. A phone that has stopped reports " +
          "once instead. Only members sharing precisely can be watched. The reply says what " +
          "became of the ask: `socket` when the channel carried it, `sent` when a push was queued by this call, " +
          "`held` when the phone was pushed moments ago or has uploaded since, `no_device` " +
          "when the member has no push token, `unsupported` when the push provider cannot " +
          "carry a silent push. A phone that has not uploaded since the first push is asked " +
          "again after ninety seconds, three times per window at most. `lastFixAt` is the " +
          "last position, `lastHeardAt` the last upload of any kind, and `issues` what the " +
          "phone itself said stands between it and reporting.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        response: {
          200: z.object({
            watching: z.boolean(),
            seconds: z.number().int(),
            pushed: z.enum(["socket", "sent", "held", "no_device", "unsupported"]),
            lastFixAt: z.string().nullable(),
            lastHeardAt: z.string().nullable(),
            activity: z.enum(ACTIVITY_TYPES).nullable(),
            issues: z.array(z.enum(PRESENCE_ISSUES)),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      if (request.params.userId === auth.userId) {
        throw badRequest("You do not need to watch yourself.")
      }
      const [target] = await db
        .select({
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
      const state = effectiveSharingState(
        target.sharingState,
        target.pausedUntil,
        new Date(),
        target.resumeToState,
      )
      // Approximate is a choice about how closely they want to be seen, and
      // live updates from their phone would be thrown away by the projection
      // anyway. The rest of the reply is precise information too.
      if (state !== "precise") return nothingToWatch

      const seconds = DEFAULTS.watchWindowSeconds
      const now = new Date()
      // When the last ask was made, from the window it opened. The page holds
      // its window with an ask a minute, and whether the phone answered the
      // last one decides how this one is sent.
      const [before] = await db
        .select({ watchedUntil: userPresence.watchedUntil })
        .from(userPresence)
        .where(eq(userPresence.userId, request.params.userId))
        .limit(1)
      const previousAskAt = before?.watchedUntil
        ? new Date(before.watchedUntil.getTime() - seconds * 1000)
        : null
      // The window is recorded whatever the push does. A phone in the middle
      // of a drive uploads every few seconds and reads it off the reply, so
      // the push is the fast path for a phone that has nothing to say yet.
      const watchedUntil = new Date(now.getTime() + seconds * 1000)
      const [presence] = await db
        .insert(userPresence)
        .values({ userId: request.params.userId, watchedUntil })
        .onConflictDoUpdate({ target: userPresence.userId, set: { watchedUntil } })
        .returning({
          recordedAt: userPresence.recordedAt,
          lastHeardAt: userPresence.lastHeardAt,
          activity: userPresence.activity,
          health: userPresence.health,
        })
      const heardAt = [presence?.recordedAt, presence?.lastHeardAt]
        .filter((at): at is Date => at != null)
        .sort((a, b) => b.getTime() - a.getTime())[0]
      const pushed = await pushForWatch(
        request.params.userId,
        now,
        heardAt ?? null,
        seconds,
        previousAskAt,
      )

      return {
        watching: true,
        seconds,
        pushed,
        lastFixAt: presence?.recordedAt?.toISOString() ?? null,
        lastHeardAt: heardAt?.toISOString() ?? null,
        activity: presence?.activity ?? null,
        issues: presenceIssues(presence?.health),
      } satisfies WatchResponse
    },
  )

  app.get(
    "/circles/:circleId/locations",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["locations"],
        summary: "Where everyone in the circle is now",
        description:
          "Coordinates are projected per viewer: paused members return null, and " +
          "approximate members are snapped to a coarse grid.",
        params: z.object({ circleId: z.string().uuid() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      return getCirclePresence(db, membership.circleId, auth.userId)
    },
  )

  app.get(
    "/circles/:circleId/members/:userId/history",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["locations"],
        summary: "Breadcrumb history for one member",
        description:
          "Only available when the circle allows history, and never for a member who is " +
          "currently sharing approximately or not at all.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        querystring: z.object({
          from: isoTimestamp.optional(),
          to: isoTimestamp.optional(),
          limit: z.coerce.number().int().min(1).max(5000).default(1000),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { circleId, userId } = request.params
      await requireMembership(request, circleId)

      const isSelf = auth.userId === userId
      let earliestVisible: Date | null = null

      if (!isSelf) {
        const [circle] = await db
          .select({ settings: circles.settings })
          .from(circles)
          .where(eq(circles.id, circleId))
          .limit(1)
        if (circle && !circle.settings.allowHistory) {
          throw forbidden("This circle has location history turned off.")
        }

        const [target] = await db
          .select({ sharingState: circleMembers.sharingState, joinedAt: circleMembers.joinedAt })
          .from(circleMembers)
          .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
          .limit(1)
        if (!target) throw forbidden("That person is not in this circle.")
        if (target.sharingState !== "precise") {
          throw forbidden("That member is not sharing precise location with this circle.")
        }
        // Accepting an invite does not hand the circle everything from before
        // you joined, and a circle never sees further back than its own
        // retention even when another circle's setting kept the points alive.
        const retentionDays = circle?.settings.historyRetentionDays ?? DEFAULTS.historyRetentionDays
        earliestVisible = new Date(
          Math.max(target.joinedAt.getTime(), Date.now() - retentionDays * 24 * 60 * 60 * 1000),
        )
      }

      const to = request.query.to ? new Date(request.query.to) : new Date()
      let from = request.query.from
        ? new Date(request.query.from)
        : new Date(to.getTime() - 24 * 60 * 60 * 1000)
      if (from.getTime() > to.getTime()) throw badRequest("`from` must be before `to`.")
      if (earliestVisible && from < earliestVisible) from = earliestVisible

      const rows = await db
        .select({
          id: locationPoints.id,
          recordedAt: locationPoints.recordedAt,
          lat: locationPoints.lat,
          lon: locationPoints.lon,
          accuracyMeters: locationPoints.accuracyMeters,
          speedMps: locationPoints.speedMps,
          activity: locationPoints.activity,
          batteryLevel: locationPoints.batteryLevel,
          tripId: locationPoints.tripId,
        })
        .from(locationPoints)
        .where(
          and(
            eq(locationPoints.userId, userId),
            gte(locationPoints.recordedAt, from),
            lte(locationPoints.recordedAt, to),
          ),
        )
        .orderBy(asc(locationPoints.recordedAt))
        .limit(request.query.limit)

      return rows.map((row) => ({
        id: String(row.id),
        recordedAt: row.recordedAt.toISOString(),
        lat: row.lat,
        lon: row.lon,
        accuracyMeters: row.accuracyMeters,
        speedMps: row.speedMps,
        activity: row.activity,
        batteryLevel: row.batteryLevel,
        tripId: row.tripId,
      }))
    },
  )

  app.delete(
    "/me/history",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["locations"],
        summary: "Erase your own breadcrumbs",
        description: "Deletes stored history for a time range. The live position is unaffected.",
        querystring: z.object({
          before: isoTimestamp.optional(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const before = request.query.before ? new Date(request.query.before) : new Date()

      // Trips are derived from breadcrumbs, so erasing history has to take them
      // too. Otherwise the route just deleted is still readable as a trip.
      const deleted = await db.transaction(async (tx) => {
        // The driver reports the affected rows, so a full erase does not
        // materialise every deleted id just to count them.
        const points = await tx
          .delete(locationPoints)
          .where(
            and(eq(locationPoints.userId, auth.userId), lte(locationPoints.recordedAt, before)),
          )
        await tx.delete(trips).where(and(eq(trips.userId, auth.userId), lte(trips.endedAt, before)))
        // The trip watermark never moves backwards. Rewinding it would make the
        // detector re-segment the breadcrumbs that survived the cutoff and
        // insert a second copy of every trip they already belong to.
        await tx
          .update(userPresence)
          .set({
            lastPointId: null,
            tripsProcessedUntil: sql`greatest(${userPresence.tripsProcessedUntil}, ${before.toISOString()}::timestamptz)`,
          })
          .where(eq(userPresence.userId, auth.userId))
        return points.count
      })

      return { ok: true, deleted }
    },
  )

  app.get(
    "/me/stats",
    {
      preHandler: app.authenticate,
      schema: { tags: ["locations"], summary: "How much data this server holds about you" },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [row] = await db
        .select({
          points: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${locationPoints.recordedAt})`,
          newest: sql<Date | null>`max(${locationPoints.recordedAt})`,
        })
        .from(locationPoints)
        .where(eq(locationPoints.userId, auth.userId))

      return {
        locationPoints: row?.points ?? 0,
        oldestPointAt: row?.oldest ? new Date(row.oldest).toISOString() : null,
        newestPointAt: row?.newest ? new Date(row.newest).toISOString() : null,
      }
    },
  )
}
