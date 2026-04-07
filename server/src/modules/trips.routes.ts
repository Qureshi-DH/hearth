import { and, desc, eq, gte, inArray, lte } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, circles, locationPoints, places, trips } from "../db/schema"
import { forbidden, notFound } from "../lib/errors"
import { toTrip } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"

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
          "put for five minutes. Visible only to members of a circle the person shares " +
          "precise location with.",
        params: z.object({ circleId: z.string().uuid(), userId: z.string().uuid() }),
        querystring: z.object({
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const { circleId, userId } = request.params
      await requireMembership(request, circleId)

      if (userId !== auth.userId) {
        const [target] = await db
          .select({ sharingState: circleMembers.sharingState })
          .from(circleMembers)
          .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, userId)))
          .limit(1)
        if (!target) throw forbidden("That person is not in this circle.")
        if (target.sharingState !== "precise") {
          throw forbidden("That member is not sharing precise location with this circle.")
        }
        const [circle] = await db
          .select({ settings: circles.settings })
          .from(circles)
          .where(eq(circles.id, circleId))
          .limit(1)
        if (circle && !circle.settings.allowHistory) {
          throw forbidden("This circle has location history turned off.")
        }
      }

      const rows = await db
        .select()
        .from(trips)
        .where(
          and(
            eq(trips.userId, userId),
            request.query.from ? gte(trips.startedAt, new Date(request.query.from)) : undefined,
            request.query.to ? lte(trips.endedAt, new Date(request.query.to)) : undefined,
          ),
        )
        .orderBy(desc(trips.startedAt))
        .limit(request.query.limit)

      return withPlaceNames(rows)
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
        params: z.object({ tripId: z.string().uuid() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [trip] = await db
        .select()
        .from(trips)
        .where(eq(trips.id, request.params.tripId))
        .limit(1)
      if (!trip) throw notFound("No such trip.")

      if (trip.userId !== auth.userId) {
        // A trip path is history, so it clears the same bar as the history
        // endpoint. The owner shares precisely and the circle allows history.
        const shared = await db
          .select({
            circleId: circleMembers.circleId,
            sharingState: circleMembers.sharingState,
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
        const allowed = shared.some(
          (row) =>
            mine.has(row.circleId) && row.sharingState === "precise" && row.settings.allowHistory,
        )
        if (!allowed) throw forbidden("You cannot view this trip.")
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

      const [detailed] = await withPlaceNames([trip])
      return {
        ...detailed,
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
}
