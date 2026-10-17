import { DEFAULTS, haversineMeters } from "@hearth/shared"
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, circles, locationPoints, places, trips } from "../db/schema"
import { forbidden, notFound } from "../lib/errors"
import { toTrip } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { preciseStretch } from "../services/presence"

// Postgres has no year zero, so "0000-01-01T00:00:00Z" satisfies zod's calendar
// check and then aborts the query inside the driver, turning a query string
// into a 500 that logs the statement and its bound parameters. No trip is
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

export const tripRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/circles/:circleId/members/:userId/trips",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["trips"],
        summary: "Journeys derived from a member's breadcrumbs",
        description:
          "Trips are detected server-side by splitting history wherever the device stayed " +
          "put long enough to count as a stop. Visible only to members of a circle the " +
          "person shares precise location with, in a circle that allows history. Anyone " +
          "else in the circle gets an empty list rather than a refusal, as they do for " +
          "somebody who has left it.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        querystring: z.object({
          from: isoTimestamp.optional(),
          to: isoTimestamp.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { circleId, userId } = request.params
      await requireMembership(request, circleId)

      let earliestVisible: Date | null = null

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
        // Empty rather than refused. The member page asks whatever she
        // shares, and a refusal is a 4xx a firewall in front of the server
        // can answer by locking out every phone in the house.
        if (!target) return []
        const stretch = preciseStretch(target, new Date())
        if (!stretch) return []
        const [circle] = await db
          .select({ settings: circles.settings })
          .from(circles)
          .where(eq(circles.id, circleId))
          .limit(1)
        if (circle && !circle.settings.allowHistory) return []
        // The same bound the breadcrumb history uses: nothing from before this
        // person joined or last started sharing precisely, and nothing older
        // than the circle's own retention.
        const retentionDays = circle?.settings.historyRetentionDays ?? DEFAULTS.historyRetentionDays
        earliestVisible = new Date(
          Math.max(
            target.joinedAt.getTime(),
            stretch.since?.getTime() ?? 0,
            Date.now() - retentionDays * 24 * 60 * 60 * 1000,
          ),
        )
      }

      const requestedFrom = request.query.from ? new Date(request.query.from) : null
      const from =
        earliestVisible && (!requestedFrom || requestedFrom < earliestVisible)
          ? earliestVisible
          : requestedFrom

      const rows = await db
        .select()
        .from(trips)
        .where(
          and(
            eq(trips.userId, userId),
            from ? gte(trips.startedAt, from) : undefined,
            request.query.to ? lte(trips.endedAt, new Date(request.query.to)) : undefined,
          ),
        )
        .orderBy(desc(trips.startedAt))
        .limit(request.query.limit)

      if (userId === auth.userId) return withPlaceNames(rows)
      return withCirclePlaceNames(rows, [circleId])
    },
  )

  app.get(
    "/me/trips",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["trips"],
        summary: "Your own trips",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const rows = await db
        .select()
        .from(trips)
        .where(eq(trips.userId, auth.userId))
        .orderBy(desc(trips.startedAt))
        .limit(request.query.limit)
      return withPlaceNames(rows)
    },
  )

  app.get(
    "/trips/:tripId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["trips"],
        summary: "One trip, with its full path",
        description:
          "Clears the same bar as the trips list. A trip the viewer cannot see is a 403 and " +
          "one that no longer exists is a 404. With `soft=true` in the request " +
          "both come back as 200 with `{ id, visible: false }`, and a trip that is served " +
          "carries `visible: true`. A list on screen outlives the sharing it was read under, " +
          "and a trip can be folded into its neighbour when a late backlog arrives, so the " +
          "app asks for the soft answer. Older apps render any 200 as a trip and do not.",
        params: z.object({ tripId: z.string().uuid() }),
        querystring: z.object({ soft: z.enum(["true", "false"]).optional() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const soft = request.query.soft === "true"
      const unavailable = (error: Error) => {
        if (soft) return { id: request.params.tripId, visible: false as const }
        throw error
      }

      const [trip] = await db
        .select()
        .from(trips)
        .where(eq(trips.id, request.params.tripId))
        .limit(1)
      if (!trip) return unavailable(notFound("No such trip."))

      // Null while the trip is the viewer's own, where every place they can
      // see is theirs to read.
      let viewerCircleIds: string[] | null = null

      if (trip.userId !== auth.userId) {
        // A trip path is history, so it clears the same bar as the history
        // endpoint. The owner shares precisely and the circle allows history.
        const shared = await db
          .select({
            circleId: circleMembers.circleId,
            sharingState: circleMembers.sharingState,
            pausedUntil: circleMembers.pausedUntil,
            resumeToState: circleMembers.resumeToState,
            preciseSince: circleMembers.preciseSince,
            joinedAt: circleMembers.joinedAt,
            settings: circles.settings,
          })
          .from(circleMembers)
          .innerJoin(circles, eq(circles.id, circleMembers.circleId))
          .where(eq(circleMembers.userId, trip.userId))
        const mine = new Set(
          (
            await db
              .select({ circleId: circleMembers.circleId })
              .from(circleMembers)
              .where(eq(circleMembers.userId, auth.userId))
          ).map((row) => row.circleId),
        )
        const now = new Date()
        const qualifying = shared.flatMap((row) => {
          const stretch = preciseStretch(row, now)
          return mine.has(row.circleId) && stretch && row.settings.allowHistory
            ? [{ ...row, since: stretch.since?.getTime() ?? 0 }]
            : []
        })
        if (qualifying.length === 0) return unavailable(forbidden("You cannot view this trip."))

        // And the same lower bound, which the trips list and the breadcrumb
        // history both apply: nothing from before this person joined, nothing
        // older than the circle's retention. Whichever of the circles we share
        // reaches furthest back is the one that decides, because that circle
        // would show these breadcrumbs in the list.
        const earliestVisible = Math.min(
          ...qualifying.map((row) => {
            const retentionDays = row.settings.historyRetentionDays ?? DEFAULTS.historyRetentionDays
            return Math.max(
              row.joinedAt.getTime(),
              row.since,
              Date.now() - retentionDays * 24 * 60 * 60 * 1000,
            )
          }),
        )
        // The whole trip, not just the part of the path that falls inside the
        // window: the summary is derived from position too, and its start
        // coordinates and place name are exactly what the list withholds.
        if (trip.startedAt.getTime() < earliestVisible) {
          return unavailable(forbidden("You cannot view this trip."))
        }

        viewerCircleIds = qualifying.map((row) => row.circleId)
      }

      const path = await db
        .select({
          recordedAt: locationPoints.recordedAt,
          lat: locationPoints.lat,
          lon: locationPoints.lon,
          speedMps: locationPoints.speedMps,
        })
        .from(locationPoints)
        .where(eq(locationPoints.tripId, trip.id))
        .orderBy(locationPoints.recordedAt)

      const [detailed] = viewerCircleIds
        ? await withCirclePlaceNames([trip], viewerCircleIds)
        : await withPlaceNames([trip])
      return {
        ...detailed,
        visible: true as const,
        path: path.map((point) => ({
          recordedAt: point.recordedAt.toISOString(),
          lat: point.lat,
          lon: point.lon,
          speedMps: point.speedMps,
        })),
      }
    },
  )

  async function withPlaceNames(rows: (typeof trips.$inferSelect)[]) {
    const placeIds = [
      ...new Set(
        rows
          .flatMap((row) => [row.startPlaceId, row.endPlaceId])
          .filter((id): id is string => Boolean(id)),
      ),
    ]

    const names = new Map<string, string>()
    if (placeIds.length > 0) {
      const placeRows = await db
        .select({ id: places.id, name: places.name })
        .from(places)
        .where(inArray(places.id, placeIds))
      for (const place of placeRows) names.set(place.id, place.name)
    }

    return rows.map((row) =>
      toTrip(
        row,
        row.startPlaceId ? (names.get(row.startPlaceId) ?? null) : null,
        row.endPlaceId ? (names.get(row.endPlaceId) ?? null) : null,
      ),
    )
  }

  /**
   * The same trips, named the way these circles name things. The detector
   * stores one place id, chosen from every place the person who made the trip
   * can see, so reading that id back would hand a circle a label written
   * inside one it is not a member of. The coordinates decide instead, against
   * the places these circles hold themselves.
   */
  async function withCirclePlaceNames(
    rows: (typeof trips.$inferSelect)[],
    circleIds: string[],
  ): Promise<ReturnType<typeof toTrip>[]> {
    if (rows.length === 0) return []

    const placeRows = await db
      .select({
        name: places.name,
        lat: places.lat,
        lon: places.lon,
        radiusMeters: places.radiusMeters,
      })
      .from(places)
      .where(inArray(places.circleId, circleIds))

    const nameFor = (point: { lat: number; lon: number }) =>
      placeRows.find((place) => haversineMeters(point, place) <= place.radiusMeters)?.name ?? null

    return rows.map((row) =>
      toTrip(
        row,
        nameFor({ lat: row.startLat, lon: row.startLon }),
        nameFor({ lat: row.endLat, lon: row.endLon }),
      ),
    )
  }
}
