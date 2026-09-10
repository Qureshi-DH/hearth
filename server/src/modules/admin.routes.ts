import { REGISTRATION_MODES } from "@hearth/shared"
import { and, desc, eq, gte, ne, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import {
  auditLog,
  circleMembers,
  circles,
  locationPoints,
  notificationOutbox,
  places,
  sessions,
  users,
} from "../db/schema"
import { getConfig } from "../env"
import { badRequest, notFound } from "../lib/errors"
import { requireAuth } from "../plugins/auth"
import { revokeAllSessions } from "../services/auth"
import { drainOutbox } from "../services/push"
import { getServerSettings, updateServerSettings } from "../services/settings"
import { getPushDriver, uptimeSeconds } from "../runtime"
import { VERSION } from "./system.routes"

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  /**
   * `min(recorded_at)` over the whole table has no index to lead with and reads
   * every breadcrumb on the server. Per user it does have one: the
   * (user_id, recorded_at) index answers each account from a single entry, and
   * a household has a handful of accounts against millions of points.
   */
  async function oldestPointAt(): Promise<string | null> {
    const rows = (await db.execute(sql`
      select min(p.recorded_at) as oldest
      from users u
      cross join lateral (
        select lp.recorded_at
        from location_points lp
        where lp.user_id = u.id
        order by lp.recorded_at
        limit 1
      ) p
    `)) as unknown as { oldest: Date | string | null }[]
    const raw = rows[0]?.oldest
    return raw ? new Date(raw).toISOString() : null
  }

  /** Some managed Postgres roles are not allowed to read the database size. */
  async function databaseSizeBytes(): Promise<number | null> {
    try {
      const rows = (await db.execute(
        sql`select pg_database_size(current_database())::bigint as size`,
      )) as unknown as { size: string | number }[]
      const raw = rows[0]?.size
      return raw == null ? null : Number(raw)
    } catch {
      return null
    }
  }

  app.get(
    "/admin/settings",
    { preHandler: app.requireAdmin, schema: { tags: ["admin"], summary: "Read server settings" } },
    async () => getServerSettings(db),
  )

  app.patch(
    "/admin/settings",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Change server settings",
        description: "Overrides the environment defaults without a redeploy.",
        body: z.object({
          serverName: z.string().trim().min(1).max(80).optional(),
          registrationMode: z.enum(REGISTRATION_MODES).optional(),
          maxHistoryRetentionDays: z.number().int().min(1).max(3650).nullish(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const next = await updateServerSettings(db, request.body)
      await db.insert(auditLog).values({
        actorUserId: auth.userId,
        action: "settings.update",
        targetType: "server",
        meta: request.body,
        ip: request.ip,
      })
      return next
    },
  )

  app.get(
    "/admin/users",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "List accounts",
        querystring: z.object({
          q: z.string().max(120).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(users)
        .where(
          request.query.q
            ? sql`${users.emailNormalized} like ${`%${request.query.q.toLowerCase()}%`} or lower(${users.displayName}) like ${`%${request.query.q.toLowerCase()}%`}`
            : undefined,
        )
        .orderBy(desc(users.createdAt))
        .limit(request.query.limit)

      const counts = await db
        .select({
          userId: circleMembers.userId,
          circleCount: sql<number>`count(*)::int`,
        })
        .from(circleMembers)
        .groupBy(circleMembers.userId)
      const circleCounts = new Map(counts.map((row) => [row.userId, row.circleCount]))

      const devices = await db
        .select({ userId: sessions.userId, deviceCount: sql<number>`count(*)::int` })
        .from(sessions)
        .where(sql`${sessions.revokedAt} is null`)
        .groupBy(sessions.userId)
      const deviceCounts = new Map(devices.map((row) => [row.userId, row.deviceCount]))

      // Gaps between consecutive fixes over the last day, and the gap still
      // open since the last one, so a phone that went quiet reads as such
      // before the sweep says so.
      const silences = (await db.execute(sql`
        with recent as (
          select user_id, recorded_at,
                 recorded_at - lag(recorded_at) over (partition by user_id order by recorded_at) as gap
          from location_points
          where recorded_at > now() - interval '24 hours'
        )
        select user_id,
               greatest(
                 coalesce(extract(epoch from max(gap)), 0),
                 extract(epoch from now() - max(recorded_at))
               )::int as longest
        from recent
        group by user_id
      `)) as unknown as Array<{ user_id: string; longest: number }>
      const longestSilence = new Map(silences.map((row) => [row.user_id, row.longest]))

      return rows.map((row) => ({
        id: row.id,
        email: row.email,
        displayName: row.displayName,
        avatarColor: row.avatarColor,
        avatarUrl: row.avatarUrl,
        isAdmin: row.isAdmin,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        circleCount: circleCounts.get(row.id) ?? 0,
        deviceCount: deviceCounts.get(row.id) ?? 0,
        longestSilenceSeconds: longestSilence.get(row.id) ?? null,
      }))
    },
  )

  app.patch(
    "/admin/users/:userId",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Activate, deactivate, or promote an account",
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({
          isActive: z.boolean().optional(),
          isAdmin: z.boolean().optional(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)

      if (request.params.userId === auth.userId && request.body.isAdmin === false) {
        throw badRequest("You cannot remove your own administrator access.")
      }
      if (request.params.userId === auth.userId && request.body.isActive === false) {
        throw badRequest("You cannot deactivate your own account.")
      }
      if (request.body.isAdmin === false) {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.isAdmin, true))
        if (count <= 1) throw badRequest("The server must keep at least one administrator.")
      }
      // A deactivated administrator cannot sign in, so deactivating the last
      // one locks the server out just as thoroughly as demoting them, and only
      // a hand-edit of the database gets it back.
      if (request.body.isActive === false) {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(
            and(
              eq(users.isAdmin, true),
              eq(users.isActive, true),
              ne(users.id, request.params.userId),
            ),
          )
        if (count === 0) throw badRequest("The server must keep at least one administrator.")
      }

      const [before] = await db
        .select({ isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, request.params.userId))
        .limit(1)

      const [updated] = await db
        .update(users)
        .set({ ...request.body, updatedAt: new Date() })
        .where(eq(users.id, request.params.userId))
        .returning()
      if (!updated) throw notFound("No such account.")

      // Deactivation has to end the sessions too, or the account keeps its
      // access token and its websocket until they expire. Demotion is the same
      // move against an administrator who has gone bad, so it ends them as
      // well, but only when it actually took something away.
      const demoted = request.body.isAdmin === false && before?.isAdmin === true
      if (request.body.isActive === false || demoted) await revokeAllSessions(db, updated.id)

      await db.insert(auditLog).values({
        actorUserId: auth.userId,
        action: "user.update",
        targetType: "user",
        targetId: updated.id,
        meta: request.body,
        ip: request.ip,
      })

      return { ok: true }
    },
  )

  app.get(
    "/admin/stats",
    { preHandler: app.requireAdmin, schema: { tags: ["admin"], summary: "Server statistics" } },
    async () => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

      const [
        [userCount],
        [activeCount],
        [circleCount],
        [placeCount],
        [pointCount],
        oldest,
        [queueDepth],
        dbSize,
      ] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(users),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(gte(users.lastSeenAt, dayAgo)),
        db.select({ count: sql<number>`count(*)::int` }).from(circles),
        db.select({ count: sql<number>`count(*)::int` }).from(places),
        db.select({ count: sql<number>`count(*)::int` }).from(locationPoints),
        oldestPointAt(),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(notificationOutbox)
          .where(eq(notificationOutbox.status, "pending")),
        databaseSizeBytes(),
      ])

      return {
        users: userCount?.count ?? 0,
        activeUsers24h: activeCount?.count ?? 0,
        circles: circleCount?.count ?? 0,
        places: placeCount?.count ?? 0,
        locationPoints: pointCount?.count ?? 0,
        oldestPointAt: oldest,
        pushQueueDepth: queueDepth?.count ?? 0,
        databaseSizeBytes: dbSize,
        uptimeSeconds: uptimeSeconds(),
        pushProvider: getConfig().PUSH_PROVIDER,
        version: VERSION,
      }
    },
  )

  app.get(
    "/admin/push/queue",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Inspect the notification outbox",
        querystring: z.object({
          status: z.enum(["pending", "sent", "failed", "skipped"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const rows = await db
        .select()
        .from(notificationOutbox)
        .where(
          request.query.status ? eq(notificationOutbox.status, request.query.status) : undefined,
        )
        .orderBy(desc(notificationOutbox.id))
        .limit(request.query.limit)

      // Being a server admin is not being in every circle. The text of a
      // notification says where somebody arrived and what was said to them,
      // so it is shown only for the admin's own; the rest is enough to debug
      // a provider.
      return rows.map((row) => ({
        id: String(row.id),
        userId: row.userId,
        title: row.userId === auth.userId ? row.title : null,
        body: row.userId === auth.userId ? row.body : null,
        channel: row.channel,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      }))
    },
  )

  app.post(
    "/admin/push/drain",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Flush the notification queue now",
        description: "Useful after fixing a misconfigured provider.",
      },
    },
    async () => {
      const driver = getPushDriver()
      if (!driver) throw badRequest("Push subsystem is not initialised.")
      return drainOutbox(db, driver, { batchSize: 200 })
    },
  )

  app.get(
    "/admin/audit",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Recent administrative actions",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
    },
    async (request) => {
      const rows = await db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(request.query.limit)
      return rows.map((row) => ({
        id: String(row.id),
        actorUserId: row.actorUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        meta: row.meta,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      }))
    },
  )
}
