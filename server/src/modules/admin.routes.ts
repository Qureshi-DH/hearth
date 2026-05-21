import { REGISTRATION_MODES } from "@hearth/shared"
import { desc, eq, gte, sql } from "drizzle-orm"
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
import { drainOutbox } from "../services/push"
import { getServerSettings, updateServerSettings } from "../services/settings"
import { getPushDriver, uptimeSeconds } from "../runtime"

const VERSION = process.env.npm_package_version ?? "0.1.0"

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

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
          nativeMotion: z.boolean().optional(),
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
      if (request.body.isAdmin === false) {
        const [{ count } = { count: 0 }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(eq(users.isAdmin, true))
        if (count <= 1) throw badRequest("The server must keep at least one administrator.")
      }

      const [updated] = await db
        .update(users)
        .set({ ...request.body, updatedAt: new Date() })
        .where(eq(users.id, request.params.userId))
        .returning()
      if (!updated) throw notFound("No such account.")

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
        [pointStats],
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
        db
          .select({
            count: sql<number>`count(*)::int`,
            oldest: sql<Date | null>`min(${locationPoints.recordedAt})`,
          })
          .from(locationPoints),
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
        locationPoints: pointStats?.count ?? 0,
        oldestPointAt: pointStats?.oldest ? new Date(pointStats.oldest).toISOString() : null,
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
      const rows = await db
        .select()
        .from(notificationOutbox)
        .where(
          request.query.status ? eq(notificationOutbox.status, request.query.status) : undefined,
        )
        .orderBy(desc(notificationOutbox.id))
        .limit(request.query.limit)

      return rows.map((row) => ({
        id: String(row.id),
        userId: row.userId,
        title: row.title,
        body: row.body,
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
