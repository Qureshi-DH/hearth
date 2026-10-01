import { REGISTRATION_MODES } from "@hearth/shared"
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb, type Database } from "../db/client"
import { auditLog, sessions, users } from "../db/schema"
import { badRequest, notFound } from "../lib/errors"
import { toSessionSummary } from "../lib/serialize"
import { requireAuth } from "../plugins/auth"
import { passwordGuesses } from "../plugins/password-guesses"
import {
  auditEntries,
  listAccounts,
  listCircles,
  outboxEntries,
  serverStats,
} from "../services/admin"
import { adminOverview } from "../services/admin-overview"
import { confirmPassword, revokeAllSessions, revokeSession, setPassword } from "../services/auth"
import { serverChecks } from "../services/checks"
import { drainOutbox } from "../services/push"
import { getServerSettings, updateServerSettings } from "../services/settings"
import { getPushDriver } from "../runtime"

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()
  const guarded = passwordGuesses(app)

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
    async (request) => listAccounts(db, { query: request.query.q, limit: request.query.limit }),
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
      // Two administrators demoting or deactivating each other at the same
      // moment would each count the other and both pass, leaving nobody. The
      // guards and the update run under one lock, so the second sees the
      // first.
      const { before, updated } = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hearth:admins'))`)
        if (request.body.isAdmin === false) {
          const [{ count } = { count: 0 }] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(eq(users.isAdmin, true))
          if (count <= 1) throw badRequest("The server must keep at least one administrator.")
        }
        // A deactivated administrator cannot sign in, so deactivating the last
        // one locks the server out just as thoroughly as demoting them, and
        // only a hand-edit of the database gets it back.
        if (request.body.isActive === false) {
          const [{ count } = { count: 0 }] = await tx
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

        const [previous] = await tx
          .select({ isAdmin: users.isAdmin })
          .from(users)
          .where(eq(users.id, request.params.userId))
          .limit(1)

        const [row] = await tx
          .update(users)
          .set({ ...request.body, updatedAt: new Date() })
          .where(eq(users.id, request.params.userId))
          .returning()
        return { before: previous, updated: row }
      })
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
    async () => serverStats(db),
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
    async (request) =>
      outboxEntries(db, {
        status: request.query.status,
        limit: request.query.limit,
        viewerId: requireAuth(request).userId,
      }),
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
    async (request) => auditEntries(db, request.query.limit),
  )

  const userParams = z.object({ userId: z.string().uuid() })

  app.get(
    "/admin/users/:userId/sessions",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["admin"], summary: "An account's signed-in devices", params: userParams },
    },
    async (request) => {
      const auth = requireAuth(request)
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, request.params.userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .orderBy(sql`${sessions.lastUsedAt} desc nulls last`)
      return rows.map((row) => toSessionSummary(row, auth.sessionId))
    },
  )

  app.delete(
    "/admin/users/:userId/sessions/:sessionId",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Sign one of an account's devices out",
        description: "For a lost or stolen phone. The device has to sign in again.",
        params: userParams.extend({ sessionId: z.string().uuid() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [session] = await db
        .select({ id: sessions.id, deviceName: sessions.deviceName })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, request.params.sessionId),
            eq(sessions.userId, request.params.userId),
            isNull(sessions.revokedAt),
          ),
        )
        .limit(1)
      if (!session) throw notFound("That device is not signed in.")
      await revokeSession(db, session.id)
      await db.insert(auditLog).values({
        actorUserId: auth.userId,
        action: "session.revoke",
        targetType: "user",
        targetId: request.params.userId,
        meta: { sessionId: session.id, deviceName: session.deviceName },
        ip: request.ip,
      })
      return { ok: true }
    },
  )

  app.post(
    "/admin/users/:userId/sessions/revoke-all",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Sign an account out everywhere",
        description: "Your own session is kept when the account is yours.",
        params: userParams,
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const keep = request.params.userId === auth.userId ? auth.sessionId : undefined
      const count = await revokeAllSessions(db, request.params.userId, keep)
      await db.insert(auditLog).values({
        actorUserId: auth.userId,
        action: "session.revoke_all",
        targetType: "user",
        targetId: request.params.userId,
        meta: { count },
        ip: request.ip,
      })
      return { ok: true, revokedSessions: count }
    },
  )

  app.post(
    "/admin/users/:userId/password",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "Set a new password for an account",
        description:
          "Hearth sends no email, so this is how somebody who forgot their password gets " +
          "back in. The account is signed out everywhere, and the password is never logged.",
        params: userParams,
        body: z.object({
          password: z.string().min(1).max(512),
          // Setting somebody's password is a way into their account, and
          // from there to where their family is. The administrator proves
          // it is them at the keyboard, not whoever found the portal open.
          currentPassword: z.string().min(1).max(512),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      if (request.params.userId === auth.userId) {
        throw badRequest(
          "Change your own password from Your account, which asks for the current one.",
        )
      }
      await guarded(request, () => confirmPassword(db, auth.userId, request.body.currentPassword))
      if (!(await setPassword(db, request.params.userId, request.body.password))) {
        throw notFound("No such account.")
      }
      await revokeAllSessions(db, request.params.userId)
      await db.insert(auditLog).values({
        actorUserId: auth.userId,
        action: "user.password",
        targetType: "user",
        targetId: request.params.userId,
        meta: {},
        ip: request.ip,
      })
      return { ok: true }
    },
  )

  app.get(
    "/admin/circles",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "The circles on this server",
        description:
          "Who is in each circle and how it is set up. Running the server is not being in " +
          "every circle, so no position or place coordinate is included.",
      },
    },
    async () => listCircles(db),
  )

  app.get(
    "/admin/checks",
    {
      preHandler: app.requireAdmin,
      schema: { tags: ["admin"], summary: "What about this server's setup needs attention" },
    },
    async () => serverChecks(db),
  )

  app.get(
    "/admin/overview",
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ["admin"],
        summary: "The portal's dashboard: activity by day and whether each phone is reporting",
        querystring: z.object({ tz: z.string().max(64).optional() }),
      },
    },
    async (request) => {
      const timeZone = request.query.tz ?? "UTC"
      if (!(await isTimeZone(db, timeZone))) throw badRequest(`${timeZone} is not a time zone.`)
      return adminOverview(db, timeZone)
    },
  )
}

/**
 * A zone name such as Asia/Karachi, or UTC, that the database knows. A bare
 * offset such as "+05:00" is turned away even where Postgres would take it:
 * it reads one as POSIX, where the sign means the opposite, and every day
 * would shift.
 */
async function isTimeZone(db: Database, name: string): Promise<boolean> {
  if (!/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(name)) return false
  zoneNames ??= db
    .execute(sql`select name from pg_timezone_names`)
    .then((rows) => new Set((rows as unknown as Array<{ name: string }>).map((row) => row.name)))
  return (await zoneNames).has(name)
}

/** Read once. The database's zone list changes only with its own upgrade. */
let zoneNames: Promise<Set<string>> | null = null
