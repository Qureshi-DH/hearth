import { and, desc, eq, gt, lt, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { circleMembers, events } from "../db/schema"
import { requireAuth, requireMembership } from "../plugins/auth"
import { hydrateEvents } from "../services/feed"

const circleIdParam = z.object({ circleId: z.string().uuid() })

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
      const membership = await requireMembership(request, request.params.circleId)
      const limit = request.query.limit

      const cursorId = request.query.cursor ? Number(request.query.cursor) : null
      if (cursorId !== null && !Number.isFinite(cursorId)) {
        return { items: [], nextCursor: null }
      }

      const rows = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.circleId, membership.circleId),
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
            member?.feedReadAt ? gt(events.occurredAt, member.feedReadAt) : sql`true`,
          ),
        )

      return { unread: row?.count ?? 0 }
    },
  )
}
