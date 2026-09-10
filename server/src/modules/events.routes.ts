import type { FeedEvent } from "@hearth/shared"
import { and, desc, eq, getTableColumns, gt, inArray, notInArray, or, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb, type Database } from "../db/client"
import { circleMembers, events } from "../db/schema"
import { requireAuth, requireMembership } from "../plugins/auth"
import { hydrateEvents } from "../services/feed"
import {
  effectiveSharingState,
  POSITION_DERIVED_EVENT_TYPES,
  sharesPreciselySql,
} from "../services/presence"

const circleIdParam = z.object({ circleId: z.string().uuid() })

/**
 * The feed is ordered by when things happened, and a phone that uploads a
 * backlog after an outage writes the morning's arrivals at lunchtime, so the
 * row id alone is no cursor. The cursor is the last row's moment and id, the
 * id breaking ties between events from the same instant. The moment is
 * carried in microseconds, which is what Postgres stores: a JavaScript Date
 * holds milliseconds, and a cursor rounded to those sat just before every
 * row stamped inside the same millisecond and skipped them.
 */
const occurredMicros = sql<string>`(extract(epoch from ${events.occurredAt}) * 1000000)::bigint`

const formatCursor = (row: { micros: string; id: number }) => `${row.micros}.${row.id}`

/** No row can have happened later than this, so no cursor can point past it. */
const cursorHorizonMicros = () => (Date.now() + 24 * 60 * 60 * 1000) * 1000

// Number.isSafeInteger is the one predicate that covers the lot: 1.5, 1e-7
// and 1e26 all survived Number.isFinite and then made Postgres reject the
// bind and 500.
function parseCursor(raw: string): { micros: string; id: number } | null {
  const [micros, id, ...rest] = raw.split(".")
  if (rest.length > 0 || !micros || !id || !/^\d+$/.test(micros)) return null
  const at = Number(micros)
  const rowId = Number(id)
  if (!Number.isSafeInteger(at) || at > cursorHorizonMicros()) return null
  if (!Number.isSafeInteger(rowId) || rowId < 0) return null
  return { micros, id: rowId }
}

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

/**
 * A check-in says "I'm fine" and, when it was written, where. The "I'm fine"
 * survives a change of sharing state; the where follows the member's state
 * now, the same way the check-ins list and the map do. Somebody who stopped
 * sharing precisely, or left, still checked in, just not at a place.
 */
async function withCheckInsProjected(
  db: Database,
  circleId: string,
  viewerId: string,
  items: FeedEvent[],
): Promise<FeedEvent[]> {
  const others = items.filter(
    (item) => item.type === "check_in" && item.actor && item.actor.id !== viewerId,
  )
  if (others.length === 0) return items

  const now = new Date()
  const rows = await db
    .select({
      userId: circleMembers.userId,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      resumeToState: circleMembers.resumeToState,
    })
    .from(circleMembers)
    .where(
      and(
        eq(circleMembers.circleId, circleId),
        inArray(circleMembers.userId, [...new Set(others.map((item) => item.actor!.id))]),
      ),
    )
  const precise = new Set(
    rows
      .filter(
        (row) =>
          effectiveSharingState(row.sharingState, row.pausedUntil, now, row.resumeToState) ===
          "precise",
      )
      .map((row) => row.userId),
  )

  return items.map((item) => {
    if (item.type !== "check_in" || !item.actor || item.actor.id === viewerId) return item
    if (precise.has(item.actor.id)) return item
    const payload = (item.payload ?? {}) as Record<string, unknown>
    return {
      ...item,
      payload: { ...payload, lat: null, lon: null, placeId: null },
      summary: `${item.actor.displayName} checked in`,
    }
  })
}

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
          "In the order things happened, newest first. Pass the previous page's `nextCursor` " +
          "to page backwards through history.",
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

      const cursor = request.query.cursor ? parseCursor(request.query.cursor) : null
      if (request.query.cursor && !cursor) return { items: [], nextCursor: null }

      const rows = await db
        .select({ ...getTableColumns(events), micros: occurredMicros })
        .from(events)
        .where(
          and(
            eq(events.circleId, membership.circleId),
            readableBy(auth.userId),
            cursor
              ? sql`(${events.occurredAt}, ${events.id}) < (timestamptz 'epoch' + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(desc(events.occurredAt), desc(events.id))
        .limit(limit + 1)

      const page = rows.slice(0, limit)
      const items = await withCheckInsProjected(
        db,
        membership.circleId,
        auth.userId,
        await hydrateEvents(
          db,
          page.map(({ micros: _micros, ...row }) => row),
        ),
      )
      const last = page[page.length - 1]

      return {
        items,
        nextCursor: rows.length > limit && last ? formatCursor(last) : null,
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
