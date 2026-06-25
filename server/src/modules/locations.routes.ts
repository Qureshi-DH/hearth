import { ACTIVITY_TYPES, DEFAULTS, LOCATION_SOURCES } from "@hearth/shared"
import { and, asc, eq, gte, lte, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, circles, locationPoints, sessions, trips, userPresence } from "../db/schema"
import { badRequest, forbidden } from "../lib/errors"
import { requireAuth, requireMembership } from "../plugins/auth"
import { ingestPoints } from "../services/locations"
import { getCirclePresence } from "../services/presence"

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

export const locationRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

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

      return {
        accepted: result.accepted,
        rejected: result.rejected,
        placeEvents: result.placeEvents,
        serverTime: new Date().toISOString(),
        policy: {
          minUpdateIntervalSeconds: minInterval,
          distanceFilterMeters: distanceFilter,
        },
      }
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
