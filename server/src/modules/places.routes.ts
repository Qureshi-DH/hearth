import { DEFAULTS, PLACE_ICONS } from "@hearth/shared"
import { and, desc, eq, inArray } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { placeEvents, placeMemberships, places, users } from "../db/schema"
import { badRequest, notFound } from "../lib/errors"
import { toPlace, toPublicUser } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { recordEvent } from "../services/feed"
import { primePlaceMemberships } from "../services/geofence"

const circleIdParam = z.object({ circleId: z.string().uuid() })
const placeParams = circleIdParam.extend({ placeId: z.string().uuid() })

const radiusSchema = z
  .number()
  .int()
  .min(DEFAULTS.minPlaceRadiusMeters)
  .max(DEFAULTS.maxPlaceRadiusMeters)

const placeFields = {
  name: z.string().trim().min(1).max(80),
  icon: z.enum(PLACE_ICONS).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  address: z.string().max(300).nullish(),
}

const placeBody = z.object({
  ...placeFields,
  radiusMeters: radiusSchema.default(DEFAULTS.defaultPlaceRadiusMeters),
})

// `.partial()` on the create schema would keep the radius default, silently
// resizing every renamed place and wiping its memberships.
const placePatch = z.object({ ...placeFields, radiusMeters: radiusSchema }).partial()

export const placeRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/circles/:circleId/places",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["places"],
        summary: "List the circle's places",
        description: "Each place reports who is currently inside it.",
        params: circleIdParam,
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId)

      const rows = await db
        .select({ place: places, creator: users })
        .from(places)
        .leftJoin(users, eq(users.id, places.createdBy))
        .where(eq(places.circleId, membership.circleId))
        .orderBy(places.name)

      if (rows.length === 0) return []

      const inside = await db
        .select({ placeId: placeMemberships.placeId, userId: placeMemberships.userId })
        .from(placeMemberships)
        .where(
          and(
            inArray(
              placeMemberships.placeId,
              rows.map((row) => row.place.id),
            ),
            eq(placeMemberships.isInside, true),
          ),
        )

      const byPlace = new Map<string, string[]>()
      for (const row of inside) {
        byPlace.set(row.placeId, [...(byPlace.get(row.placeId) ?? []), row.userId])
      }

      return rows.map((row) =>
        toPlace(
          row.place,
          row.creator ? toPublicUser(row.creator) : null,
          byPlace.get(row.place.id) ?? [],
        ),
      )
    },
  )

  app.post(
    "/circles/:circleId/places",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["places"],
        summary: "Create a place (geofence)",
        description:
          "Members already standing inside the new place are recorded as such immediately, " +
          "so nobody gets a spurious 'arrived' notification a minute later.",
        params: circleIdParam,
        body: placeBody,
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const [created] = await db
        .insert(places)
        .values({
          circleId: membership.circleId,
          name: request.body.name,
          icon: request.body.icon ?? null,
          color: request.body.color ?? null,
          lat: request.body.lat,
          lon: request.body.lon,
          radiusMeters: request.body.radiusMeters,
          address: request.body.address ?? null,
          createdBy: auth.userId,
        })
        .returning()
      if (!created) throw badRequest("Could not create the place.")

      await primePlaceMemberships(db, created.id)

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "place_created",
        actorUserId: auth.userId,
        payload: { placeId: created.id, placeName: created.name },
        summary: `Added the place "${created.name}"`,
      })

      const inside = await db
        .select({ userId: placeMemberships.userId })
        .from(placeMemberships)
        .where(and(eq(placeMemberships.placeId, created.id), eq(placeMemberships.isInside, true)))

      return reply.code(201).send(
        toPlace(
          created,
          null,
          inside.map((row) => row.userId),
        ),
      )
    },
  )

  app.patch(
    "/circles/:circleId/places/:placeId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["places"],
        summary: "Update a place",
        params: placeParams,
        body: placePatch,
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const [updated] = await db
        .update(places)
        .set({ ...request.body, updatedAt: new Date() })
        .where(and(eq(places.id, request.params.placeId), eq(places.circleId, membership.circleId)))
        .returning()
      if (!updated) throw notFound("No such place.")

      // Moving or resizing a fence invalidates who is "inside" it.
      if (
        request.body.lat !== undefined ||
        request.body.lon !== undefined ||
        request.body.radiusMeters !== undefined
      ) {
        await db.delete(placeMemberships).where(eq(placeMemberships.placeId, updated.id))
        await primePlaceMemberships(db, updated.id)
      }

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "place_updated",
        actorUserId: auth.userId,
        payload: { placeId: updated.id, placeName: updated.name },
        summary: `Updated the place "${updated.name}"`,
      })

      return toPlace(updated, null, [])
    },
  )

  app.delete(
    "/circles/:circleId/places/:placeId",
    {
      preHandler: app.authenticate,
      schema: { tags: ["places"], summary: "Delete a place", params: placeParams },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const [deleted] = await db
        .delete(places)
        .where(and(eq(places.id, request.params.placeId), eq(places.circleId, membership.circleId)))
        .returning({ id: places.id, name: places.name })
      if (!deleted) throw notFound("No such place.")

      await recordEvent(db, {
        circleId: membership.circleId,
        type: "place_deleted",
        actorUserId: auth.userId,
        payload: { placeId: deleted.id, placeName: deleted.name },
        summary: `Removed the place "${deleted.name}"`,
      })

      return { ok: true }
    },
  )

  app.get(
    "/circles/:circleId/places/:placeId/events",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["places"],
        summary: "Arrive/leave history for a place",
        params: placeParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
    },
    async (request) => {
      const membership = await requireMembership(request, request.params.circleId)

      const rows = await db
        .select({ event: placeEvents, placeName: places.name })
        .from(placeEvents)
        .innerJoin(places, eq(places.id, placeEvents.placeId))
        .where(
          and(
            eq(placeEvents.placeId, request.params.placeId),
            eq(placeEvents.circleId, membership.circleId),
          ),
        )
        .orderBy(desc(placeEvents.occurredAt))
        .limit(request.query.limit)

      return rows.map((row) => ({
        id: String(row.event.id),
        placeId: row.event.placeId,
        placeName: row.placeName,
        userId: row.event.userId,
        type: row.event.type,
        occurredAt: row.event.occurredAt.toISOString(),
      }))
    },
  )
}
