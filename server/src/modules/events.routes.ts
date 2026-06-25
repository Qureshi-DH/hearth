import { and, desc, eq, gt, lt, notInArray, or, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, events } from "../db/schema"
import { requireAuth, requireMembership } from "../plugins/auth"
import { hydrateEvents } from "../services/feed"
import { POSITION_DERIVED_EVENT_TYPES, sharesPreciselySql } from "../services/presence"

const circleIdParam = z.object({ circleId: z.string().uuid() })

/**
 * The feed is the one place a member's trail outlives the state they shared it
 * under: an arrival names a place, and it stays readable long after they turn
 * sharing down, to somebody who joined afterwards and never saw it live. The
 * map, the history and the trips endpoints all re-check the subject's current
 * state on every read, so the feed does too. Your own trail is always yours.
 */
const readableBy = (viewerId: string) =>
  or(
    notInArray(events.type, [...POSITION_DERIVED_EVENT_TYPES]),
    eq(events.actorUserId, viewerId),
    sharesPreciselySql(events.circleId, events.actorUserId),
  )

export const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/circles/:circleId/events",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["events"],
        summary: "Activity feed",
        description:
          "Newest first. Pass the previous page's `nextCursor` to page backwards through history.",
        params: circleIdParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          cursor: z.string().optional(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      const limit = request.query.limit

      // A cursor is an events.id, so a bigint. Number.isSafeInteger is the one
      // predicate that covers the lot: 1.5, 1e-7 and 1e26 all survived
      // Number.isFinite and then made Postgres reject the bind and 500.
      const cursorId = request.query.cursor ? Number(request.query.cursor) : null
      if (cursorId !== null && (!Number.isSafeInteger(cursorId) || cursorId < 0)) {
        return { items: [], nextCursor: null }
      }

      const rows = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.circleId, membership.circleId),
            readableBy(auth.userId),
            cursorId !== null ? lt(events.id, cursorId) : undefined,
          ),
        )
        .orderBy(desc(events.id))
        .limit(limit + 1)

      const page = rows.slice(0, limit)
      const items = await hydrateEvents(db, page)

      return {
        items,
        nextCursor: rows.length > limit ? String(page[page.length - 1]?.id ?? "") : null,
      }
    },
  )

  app.post(
    "/circles/:circleId/events/read",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["events"],
        summary: "Mark the feed as read",
        params: circleIdParam,
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)
      const now = new Date()

      await db
        .update(circleMembers)
        .set({ feedReadAt: now })
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, auth.userId),
          ),
        )

      return { ok: true, readAt: now.toISOString() }
    },
  )

  app.get(
    "/circles/:circleId/events/unread-count",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["events"],
        summary: "Unread badge count",
        params: circleIdParam,
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const membership = await requireMembership(request, request.params.circleId)

      const [member] = await db
        .select({ feedReadAt: circleMembers.feedReadAt })
        .from(circleMembers)
        .where(
          and(
            eq(circleMembers.circleId, membership.circleId),
            eq(circleMembers.userId, auth.userId),
          ),
        )
        .limit(1)

      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(events)
        .where(
          and(
            eq(events.circleId, membership.circleId),
            // The badge counts what the feed will show. Counting more than that
            // leaves "1 unread" over an empty list, and the number on its own
            // still says how often a paused member has been arriving somewhere.
            readableBy(auth.userId),
            // When the row appeared, not when it happened. A backlog replayed
            // after an outage is new to whoever has not seen it yet.
            member?.feedReadAt ? gt(events.createdAt, member.feedReadAt) : sql`true`,
          ),
        )

      return { unread: row?.count ?? 0 }
    },
  )
}
