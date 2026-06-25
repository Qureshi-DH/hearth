import { DEFAULTS, PLACE_ICONS } from "@hearth/shared"
import { and, desc, eq, inArray, or } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, placeEvents, placeMemberships, places, users } from "../db/schema"
import { badRequest, notFound } from "../lib/errors"
import { toPlace, toPublicUser } from "../lib/serialize"
import { requireAuth, requireMembership } from "../plugins/auth"
import { recordEvent } from "../services/feed"
import { primePlaceMemberships } from "../services/geofence"
import { effectiveSharingState, sharesPreciselySql } from "../services/presence"

const circleIdParam = z.object({ circleId: z.string().uuid() })
const placeParams = circleIdParam.extend({ placeId: z.string().uuid() })

const radiusSchema = z
  .number()
  .int()
  .min(DEFAULTS.minPlaceRadiusMeters)
  .max(DEFAULTS.maxPlaceRadiusMeters)

/**
 * Everything here is invisible on screen and therefore useless in a name, or
 * changes how the text around it reads. U+202A-U+202E embed and override the
 * writing direction, which is what lets "Clinic" be followed by reversed text
 * that appears to come from somewhere else. The zero-width joiners U+200C and
 * U+200D are deliberately absent: Persian and several Indic scripts need ZWNJ
 * inside ordinary words, and ZWJ is what holds an emoji sequence together.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B\u202A-\u202E\u2060\uFEFF]/gu

/** Anything Unicode calls a combining mark. */
const COMBINING_RUN = /\p{M}{4,}/gu

/**
 * A place name is read back to the whole circle in push titles and feed lines,
 * both of which are one line of text. Left raw, a member can put a newline in
 * a name and forge a second line in everybody else's notifications, or stack
 * seventy accents on one letter and smear them over the rows underneath.
 *
 * This runs at the point the name is stored rather than at the point each
 * summary is built, because a name is a single-line field by nature and there
 * is nothing in it worth keeping that survives only as a line break.
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
 * Counted in code points, so an emoji or an accented letter costs what it looks
 * like it costs rather than what UTF-16 happens to store it in.
 */
const placeName = z
  .string()
  .max(400)
  .describe("At most 80 characters once invisible and direction-changing ones are removed.")
  .transform(singleLine)
  .refine((value) => value.length > 0 && [...value].length <= 80, {
    message: "A place name has to be between 1 and 80 characters.",
  })

const placeFields = {
  name: placeName,
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

  /**
   * A member's fences are only evaluated for the circles they share precisely
   * with, so a row belonging to anyone else is frozen at their last precise
   * fix. Priming a new place fills those rows in too. Reporting either would
   * keep asserting a doorstep they may have left hours ago, which is the one
   * thing `approximate` and `paused` exist to prevent.
   */
  async function membersInsideByPlace(
    circleId: string,
    placeIds: string[],
  ): Promise<Map<string, string[]>> {
    const now = new Date()
    const rows = await db
      .select({
        placeId: placeMemberships.placeId,
        userId: placeMemberships.userId,
        sharingState: circleMembers.sharingState,
        pausedUntil: circleMembers.pausedUntil,
        resumeToState: circleMembers.resumeToState,
      })
      .from(placeMemberships)
      .innerJoin(
        circleMembers,
        and(
          eq(circleMembers.circleId, circleId),
          eq(circleMembers.userId, placeMemberships.userId),
        ),
      )
      .where(and(inArray(placeMemberships.placeId, placeIds), eq(placeMemberships.isInside, true)))

    const byPlace = new Map<string, string[]>()
    for (const row of rows) {
      const state = effectiveSharingState(row.sharingState, row.pausedUntil, now, row.resumeToState)
      if (state !== "precise") continue
      byPlace.set(row.placeId, [...(byPlace.get(row.placeId) ?? []), row.userId])
    }
    return byPlace
  }

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

      const byPlace = await membersInsideByPlace(
        membership.circleId,
        rows.map((row) => row.place.id),
      )

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

      const inside = await membersInsideByPlace(membership.circleId, [created.id])

      return reply.code(201).send(toPlace(created, null, inside.get(created.id) ?? []))
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
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const rows = await db
        .select({ event: placeEvents, placeName: places.name })
        .from(placeEvents)
        .innerJoin(places, eq(places.id, placeEvents.placeId))
        .where(
          and(
            eq(placeEvents.placeId, request.params.placeId),
            eq(placeEvents.circleId, membership.circleId),
            // Every row here says where somebody was and what the circle calls
            // that spot, so it answers to the state they share now rather than
            // the state they shared when they walked in. Same rule as the feed,
            // and for the same reason: turning sharing down has to take the
            // trail with it, including for somebody who joined afterwards.
            // Your own arrivals are always yours to read.
            or(
              eq(placeEvents.userId, auth.userId),
              sharesPreciselySql(placeEvents.circleId, placeEvents.userId),
            ),
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
