import {
  ACTIVITY_TYPES,
  DEFAULTS,
  LOCATION_SOURCES,
  PRESENCE_ISSUES,
  type RefreshMemberResponse,
  type TrailFix,
  type WatchResponse,
} from "@hearth/shared"
import { and, asc, eq, gt, gte, lte, ne, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, circles, locationPoints, sessions, trips, userPresence } from "../db/schema"
import { AppError, badRequest, forbidden } from "../lib/errors"
import { requireAuth, requireMembership } from "../plugins/auth"
import { getPushDriver } from "../runtime"
import { pingIntervalSeconds } from "../services/reporting"
import { ingestPoints, markHeard } from "../services/locations"
import {
  effectiveSharingState,
  getCirclePresence,
  preciseStretch,
  presenceIssues,
} from "../services/presence"
import { sendControl } from "../services/control"
import { enqueuePush, recentSilentPushes } from "../services/push"
import { liveUntil } from "../services/sos"
import { askPhoneForFix } from "../services/wake"
import { endWatches, holdWatch, pushForWatch, watchesOf } from "../services/watch"

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

  app.post(
    "/locations/batch",
    {
      preHandler: app.authenticate,
      config: {
        // Background uploads are chatty, so they get a budget of their own.
        rateLimit: { max: 240, timeWindow: "1 minute" },
        acceptsUploadKey: true,
      },
      schema: {
        tags: ["locations"],
        summary: "Upload location fixes",
        description:
          "Accepts a batch of fixes from one device. A duplicate (same device and timestamp) " +
          "changes nothing, except that one re-reported as still takes that activity, so a " +
          "client may safely retry a failed upload. The response carries the tracking policy " +
          "the device should apply from now on, and `watchedUntil` while the device should " +
          "report live, because somebody has the member's page open or the member has an SOS " +
          "open in a circle they share precisely with. For an SOS the window is two minutes ahead and " +
          "named again on every upload, so it ends soon after the alert is resolved, and half an " +
          "hour after it was raised or last pressed again whatever happens. An Android " +
          "phone's native tracker may send the session's `uploadKey` as its bearer token instead " +
          "of an access token.",
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

      // What the server pings on, which the app's own foreground check follows.
      const minInterval = pingIntervalSeconds(policyRows.map((row) => row.settings))
      const distanceFilter = policyRows.length
        ? Math.min(...policyRows.map((row) => row.settings.distanceFilterMeters))
        : DEFAULTS.distanceFilterMeters

      // An open SOS rides the same field as a watch, because every app that
      // reads it already goes Live on it.
      const watchedUntil = (await liveUntil(db, auth.userId))?.toISOString() ?? null

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
      // Generous, because every phone is already held to one ask per ten
      // minutes, and the map asks on each return to it. A 429 here is a 4xx
      // in ordinary use, which a firewall can answer by locking the house out.
      config: { rateLimit: { max: 120, timeWindow: "10 minutes" } },
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
      // Generous for the same reason as the map's. The phone is held to one
      // ask per half minute whoever opens the page, however often.
      config: { rateLimit: { max: 180, timeWindow: "10 minutes" } },
      schema: {
        tags: ["locations"],
        summary: "Ask one person's phone for a fresh fix now",
        description:
          "Called when someone opens a member's page. The phone is asked over its control " +
          "channel when it has one open, and by silent push otherwise, at most once per half " +
          "minute per phone whoever is looking. A phone heard from in the last half minute is " +
          "left alone (`fresh`). Only members sharing precisely are asked. Anyone else, and " +
          "somebody who has left the circle, is answered `unsupported`.",
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
        })
        .from(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, request.params.userId),
          ),
        )
        .limit(1)
      // The page asks on every focus, including the one that follows her
      // leaving, and a 404 there is a 4xx in ordinary use.
      if (!target) return { asked: "unsupported" } satisfies RefreshMemberResponse
      const now = new Date()
      const state = effectiveSharingState(
        target.sharingState,
        target.pausedUntil,
        now,
        target.resumeToState,
      )
      if (state !== "precise") return { asked: "unsupported" } satisfies RefreshMemberResponse
      return {
        asked: await askPhoneForFix(db, request.params.userId, now),
      } satisfies RefreshMemberResponse
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
          "Called while someone has a member's Live page open. The member's phone is asked " +
          "to report at full accuracy, a fix a second, for the watch window, over its control " +
          "channel when it has one open and says it has the ask within three seconds, by " +
          "silent push otherwise, and by its next upload reply, and the page keeps calling to " +
          "hold it. Each viewer holds a window of their own, and the phone's is the latest of " +
          "them. A parked phone goes live too. Only members sharing precisely can be watched, " +
          "and anyone else, somebody who has left the circle, or a caller no longer in it, is " +
          "answered `watching: false`. " +
          "The reply says what became of the ask: `socket` when the channel carried it, `sent` " +
          "when a push was queued by this call, `held` when the phone was pushed moments ago or " +
          "is uploading, `no_device` when the member has no push token, `unsupported` when the " +
          "push provider cannot carry a silent push. A phone that has said nothing for twenty " +
          "seconds is pushed again once the last push is ninety seconds old, three times per " +
          "window at most. `lastFixAt` is the last position, `lastHeardAt` the last upload of " +
          "any kind, `issues` what the phone itself said stands between it and reporting, and " +
          "`supports` that this server takes the release and fills the trail.",
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
            supports: z.object({ release: z.boolean(), trail: z.boolean() }).optional(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      // A Live page left open by somebody just removed from the circle holds
      // every minute, and refusing each one is a 4xx in ordinary use. The
      // answer says nothing about the member either way.
      const membership = await requireMembership(request, request.params.circleId).catch(
        (error: unknown) => {
          if (error instanceof AppError && error.statusCode === 403) return null
          throw error
        },
      )
      if (!membership) {
        await endWatches(db, watchesOf(request.params.userId, auth.userId), new Date())
        return nothingToWatch
      }
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
      const now = new Date()
      const state = target
        ? effectiveSharingState(target.sharingState, target.pausedUntil, now, target.resumeToState)
        : null
      // Approximate is a choice about how closely they want to be seen, and
      // live updates from their phone would be thrown away by the projection
      // anyway. The rest of the reply is precise information too. The page
      // holds every minute, including the one after she left the circle, and
      // a 404 there is a 4xx in ordinary use.
      if (state !== "precise") {
        await endWatches(db, watchesOf(request.params.userId, auth.userId), now)
        return nothingToWatch
      }

      const seconds = DEFAULTS.watchWindowSeconds
      // The window is recorded whatever the push does. A phone in the middle
      // of a drive uploads with every fix and reads it off the reply, so the
      // push is the fast path for a phone that has nothing to say yet.
      await holdWatch(db, {
        userId: request.params.userId,
        viewerId: auth.userId,
        circleId: membership.circleId,
        seconds,
        now,
      })
      const [presence] = await db
        .select({
          recordedAt: userPresence.recordedAt,
          lastHeardAt: userPresence.lastHeardAt,
          activity: userPresence.activity,
          health: userPresence.health,
        })
        .from(userPresence)
        .where(eq(userPresence.userId, request.params.userId))
        .limit(1)
      const heardAt = [presence?.recordedAt, presence?.lastHeardAt]
        .filter((at): at is Date => at != null)
        .sort((a, b) => b.getTime() - a.getTime())[0]
      const pushed = await pushForWatch(db, request.params.userId, now, heardAt ?? null, seconds)

      return {
        watching: true,
        seconds,
        pushed,
        lastFixAt: presence?.recordedAt?.toISOString() ?? null,
        lastHeardAt: heardAt?.toISOString() ?? null,
        activity: presence?.activity ?? null,
        issues: presenceIssues(presence?.health, presence?.recordedAt),
        supports: { release: true, trail: true },
      } satisfies WatchResponse
    },
  )

  app.delete(
    "/circles/:circleId/members/:userId/watch",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["locations"],
        summary: "Stop following one person live",
        description:
          "Called when a Live page closes or the app goes to the background. Takes away this " +
          "viewer's hold on the member's watch window. When nobody else is watching, the " +
          "window ends, and the phone hears it in its next upload reply and over its control " +
          "channel as `watch` with no seconds left, unless the member has an SOS open. Only " +
          "the caller's own hold is touched, so this is always answered 200.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      await endWatches(db, watchesOf(request.params.userId, auth.userId))
      return { ok: true as const }
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
          "currently sharing approximately or not at all. In those cases, and for somebody " +
          "who has left the circle, the answer is an empty list rather than a refusal.",
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
        // Empty rather than refused, like the trips list. A refusal is a 4xx,
        // and a firewall in front of the server can answer one by locking out
        // every phone behind the address.
        if (circle && !circle.settings.allowHistory) return []

        const [target] = await db
          .select({
            sharingState: circleMembers.sharingState,
            pausedUntil: circleMembers.pausedUntil,
            resumeToState: circleMembers.resumeToState,
            preciseSince: circleMembers.preciseSince,
            joinedAt: circleMembers.joinedAt,
          })
          .from(circleMembers)
          .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
          .limit(1)
        if (!target) return []
        const stretch = preciseStretch(target, new Date())
        if (!stretch) return []
        // Accepting an invite does not hand the circle everything from before
        // you joined, a pause does not become visible once it is over, and a
        // circle never sees further back than its own retention even when
        // another circle's setting kept the points alive.
        const retentionDays = circle?.settings.historyRetentionDays ?? DEFAULTS.historyRetentionDays
        earliestVisible = new Date(
          Math.max(
            target.joinedAt.getTime(),
            stretch.since?.getTime() ?? 0,
            Date.now() - retentionDays * 24 * 60 * 60 * 1000,
          ),
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

  app.get(
    "/circles/:circleId/members/:userId/live-trail",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["locations"],
        summary: "The fixes a Live page missed",
        description:
          "What a Live page fills its trail from when it comes back to the front or its socket " +
          "reconnects. The member's fixes after `since`, oldest first, from the device the map " +
          "follows, and from no further back than the watch window. The same fixes reached the " +
          "page as they arrived, so this works whether or not the circle keeps history. Empty " +
          "for a member sharing approximately or not at all, and for somebody who has left " +
          "the circle.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        querystring: z.object({ since: isoTimestamp }),
        response: {
          200: z.array(
            z.object({
              lat: z.number(),
              lon: z.number(),
              recordedAt: z.string(),
              accuracyMeters: z.number().nullable(),
            }),
          ),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { circleId, userId } = request.params
      await requireMembership(request, circleId)
      const now = new Date()
      let earliest = now.getTime() - DEFAULTS.watchWindowSeconds * 1000

      if (userId !== auth.userId) {
        const [target] = await db
          .select({
            sharingState: circleMembers.sharingState,
            pausedUntil: circleMembers.pausedUntil,
            resumeToState: circleMembers.resumeToState,
            preciseSince: circleMembers.preciseSince,
            joinedAt: circleMembers.joinedAt,
          })
          .from(circleMembers)
          .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
          .limit(1)
        if (!target) return []
        const stretch = preciseStretch(target, now)
        if (!stretch) return []
        earliest = Math.max(earliest, target.joinedAt.getTime(), stretch.since?.getTime() ?? 0)
      }

      const [presence] = await db
        .select({ deviceId: userPresence.deviceId })
        .from(userPresence)
        .where(eq(userPresence.userId, userId))
        .limit(1)
      const from = new Date(Math.max(Date.parse(request.query.since), earliest))
      const rows = await db
        .select({
          lat: locationPoints.lat,
          lon: locationPoints.lon,
          recordedAt: locationPoints.recordedAt,
          accuracyMeters: locationPoints.accuracyMeters,
        })
        .from(locationPoints)
        .where(
          and(
            eq(locationPoints.userId, userId),
            gt(locationPoints.recordedAt, from),
            lte(locationPoints.recordedAt, now),
            presence?.deviceId ? eq(locationPoints.deviceId, presence.deviceId) : undefined,
          ),
        )
        .orderBy(asc(locationPoints.recordedAt))
        .limit(DEFAULTS.watchWindowSeconds * 2)

      return rows.map((row) => ({
        lat: row.lat,
        lon: row.lon,
        recordedAt: row.recordedAt.toISOString(),
        accuracyMeters: row.accuracyMeters,
      })) satisfies TrailFix[]
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
