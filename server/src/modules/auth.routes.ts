import { PLATFORMS } from "@hearth/shared"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import {
  checkIns,
  circleMembers,
  circles,
  locationPoints,
  places,
  sessions,
  trips,
  users,
} from "../db/schema"
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors"
import { avatarColorFor, normalizeEmail } from "../lib/ids"
import { hashPassword, validatePasswordStrength, verifyPassword } from "../lib/password"
import { toCurrentUser, toSessionSummary } from "../lib/serialize"
import { loadCurrentUser, requireAuth } from "../plugins/auth"
import { issueSession, revokeAllSessions, revokeSession, rotateSession } from "../services/auth"
import { acceptInvite, previewInvite } from "../services/invites"
import { registrationMode } from "../services/settings"

const DeviceSchema = z.object({
  deviceId: z.string().min(6).max(128),
  deviceName: z.string().max(120).nullish(),
  platform: z.enum(PLATFORMS).nullish(),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
})

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), "Enter a valid email address.")

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.post(
    "/auth/register",
    {
      schema: {
        tags: ["auth"],
        summary: "Create an account",
        description:
          "Subject to the server's registration mode. The very first account created on a " +
          "fresh server always succeeds and is granted the administrator flag.",
        body: z.object({
          email: emailSchema,
          password: z.string().min(1).max(512),
          displayName: z.string().trim().min(1).max(80),
          inviteCode: z.string().trim().min(4).max(16).optional(),
          device: DeviceSchema,
        }),
      },
    },
    async (request, reply) => {
      const { email, password, displayName, inviteCode, device } = request.body

      const strengthError = validatePasswordStrength(password)
      if (strengthError) throw badRequest(strengthError)

      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .limit(1)
      const isFirstUser = count === 0

      if (!isFirstUser) {
        const mode = await registrationMode(db)
        if (mode === "closed") {
          throw forbidden("This server is not accepting new accounts.")
        }
        if (mode === "invite") {
          if (!inviteCode) throw badRequest("An invite code is required on this server.")
          const preview = await previewInvite(db, inviteCode)
          if (!preview.valid) throw badRequest("That invite code is not valid.")
        }
      }

      const emailNormalized = normalizeEmail(email)
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.emailNormalized, emailNormalized))
        .limit(1)
      if (existing) throw conflict("An account with that email already exists.")

      const [created] = await db
        .insert(users)
        .values({
          email: email.trim(),
          emailNormalized,
          passwordHash: await hashPassword(password),
          displayName,
          avatarColor: avatarColorFor(emailNormalized),
          isAdmin: isFirstUser,
        })
        .returning()

      if (!created) throw badRequest("Could not create the account.")

      if (inviteCode) {
        // A bad code must not strand an account that was just created.
        try {
          await acceptInvite(db, inviteCode, created.id)
        } catch (error) {
          request.log.warn({ err: error }, "invite redemption failed during registration")
        }
      }

      const tokens = await issueSession(app, db, created, {
        device,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      })
      return reply.code(201).send(tokens)
    },
  )

  app.post(
    "/auth/login",
    {
      schema: {
        tags: ["auth"],
        summary: "Sign in and bind a device",
        body: z.object({
          email: emailSchema,
          password: z.string().min(1).max(512),
          device: DeviceSchema,
        }),
      },
    },
    async (request) => {
      const { email, password, device } = request.body
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.emailNormalized, normalizeEmail(email)))
        .limit(1)

      // Same error and roughly the same work either way, so the response does
      // not reveal whether the address is registered.
      const ok = user ? await verifyPassword(password, user.passwordHash) : await burnTime(password)
      if (!user || !ok) throw unauthorized("Email or password is incorrect.")
      if (!user.isActive) throw forbidden("This account has been deactivated.")

      return issueSession(app, db, user, {
        device,
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      })
    },
  )

  app.post(
    "/auth/refresh",
    {
      schema: {
        tags: ["auth"],
        summary: "Exchange a refresh token for a new pair",
        description: "Refresh tokens are single-use; each call rotates the token.",
        body: z.object({ refreshToken: z.string().min(10).max(512) }),
      },
    },
    async (request) => rotateSession(app, db, request.body.refreshToken),
  )

  app.post(
    "/auth/logout",
    {
      preHandler: app.authenticate,
      schema: { tags: ["auth"], summary: "Revoke the current session" },
    },
    async (request) => {
      const auth = requireAuth(request)
      await revokeSession(db, auth.sessionId)
      return { ok: true }
    },
  )

  app.get(
    "/auth/me",
    { preHandler: app.authenticate, schema: { tags: ["auth"], summary: "Current account" } },
    async (request) => toCurrentUser(await loadCurrentUser(request)),
  )

  app.patch(
    "/auth/me",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["auth"],
        summary: "Update profile",
        body: z.object({
          displayName: z.string().trim().min(1).max(80).optional(),
          avatarUrl: z.string().url().max(2048).nullish(),
          locale: z.string().max(16).nullish(),
          units: z.enum(["metric", "imperial"]).optional(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [updated] = await db
        .update(users)
        .set({ ...request.body, updatedAt: new Date() })
        .where(eq(users.id, auth.userId))
        .returning()
      if (!updated) throw notFound()
      return toCurrentUser(updated)
    },
  )

  app.post(
    "/auth/password",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["auth"],
        summary: "Change password",
        description: "Revokes every other session on success.",
        body: z.object({
          currentPassword: z.string().min(1).max(512),
          newPassword: z.string().min(1).max(512),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const user = await loadCurrentUser(request)

      if (!(await verifyPassword(request.body.currentPassword, user.passwordHash))) {
        throw unauthorized("Current password is incorrect.")
      }
      const strengthError = validatePasswordStrength(request.body.newPassword)
      if (strengthError) throw badRequest(strengthError)

      await db
        .update(users)
        .set({ passwordHash: await hashPassword(request.body.newPassword), updatedAt: new Date() })
        .where(eq(users.id, user.id))

      const revoked = await revokeAllSessions(db, user.id, auth.sessionId)
      return { ok: true, revokedSessions: revoked }
    },
  )

  app.get(
    "/auth/sessions",
    { preHandler: app.authenticate, schema: { tags: ["auth"], summary: "List signed-in devices" } },
    async (request) => {
      const auth = requireAuth(request)
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, auth.userId), isNull(sessions.revokedAt)))
        .orderBy(desc(sessions.lastUsedAt))
      return rows.map((row) => toSessionSummary(row, auth.sessionId))
    },
  )

  app.delete(
    "/auth/sessions/:sessionId",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["auth"],
        summary: "Sign a device out",
        params: z.object({ sessionId: z.string().uuid() }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [row] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, request.params.sessionId), eq(sessions.userId, auth.userId)))
        .limit(1)
      if (!row) throw notFound("No such device.")
      await revokeSession(db, row.id)
      return { ok: true }
    },
  )

  app.post(
    "/auth/sessions/revoke-all",
    {
      preHandler: app.authenticate,
      schema: { tags: ["auth"], summary: "Sign out everywhere else" },
    },
    async (request) => {
      const auth = requireAuth(request)
      const revoked = await revokeAllSessions(db, auth.userId, auth.sessionId)
      return { ok: true, revokedSessions: revoked }
    },
  )

  app.get(
    "/me/export",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["account"],
        summary: "Export everything this server holds about you",
        description: "A single JSON document: profile, circles, breadcrumbs, places and trips.",
      },
    },
    async (request, reply) => {
      const user = await loadCurrentUser(request)

      const [memberships, history, myTrips, myCheckIns] = await Promise.all([
        db
          .select({
            circleId: circleMembers.circleId,
            circleName: circles.name,
            role: circleMembers.role,
            joinedAt: circleMembers.joinedAt,
            sharingState: circleMembers.sharingState,
          })
          .from(circleMembers)
          .innerJoin(circles, eq(circles.id, circleMembers.circleId))
          .where(eq(circleMembers.userId, user.id)),
        db
          .select()
          .from(locationPoints)
          .where(eq(locationPoints.userId, user.id))
          .orderBy(desc(locationPoints.recordedAt))
          .limit(100_000),
        db.select().from(trips).where(eq(trips.userId, user.id)),
        db.select().from(checkIns).where(eq(checkIns.userId, user.id)),
      ])

      const placesCreated = await db.select().from(places).where(eq(places.createdBy, user.id))

      reply.header("content-disposition", `attachment; filename="hearth-export-${user.id}.json"`)
      return {
        exportedAt: new Date().toISOString(),
        profile: toCurrentUser(user),
        circles: memberships,
        locationHistory: history,
        trips: myTrips,
        checkIns: myCheckIns,
        placesCreated,
      }
    },
  )

  app.delete(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["account"],
        summary: "Delete your account and all of your data",
        description:
          "Irreversible. Circles you solely own are deleted with you; circles with other " +
          "members survive and ownership transfers to the longest-standing admin.",
        body: z.object({ password: z.string().min(1).max(512) }),
      },
    },
    async (request) => {
      const user = await loadCurrentUser(request)
      if (!(await verifyPassword(request.body.password, user.passwordHash))) {
        throw unauthorized("Password is incorrect.")
      }

      const owned = await db
        .select({ circleId: circleMembers.circleId })
        .from(circleMembers)
        .where(and(eq(circleMembers.userId, user.id), eq(circleMembers.role, "owner")))

      for (const { circleId } of owned) {
        const others = await db
          .select({
            userId: circleMembers.userId,
            role: circleMembers.role,
            joinedAt: circleMembers.joinedAt,
          })
          .from(circleMembers)
          .where(eq(circleMembers.circleId, circleId))

        const candidates = others
          .filter((row) => row.userId !== user.id)
          .sort((a, b) => {
            if (a.role !== b.role) return a.role === "admin" ? -1 : 1
            return a.joinedAt.getTime() - b.joinedAt.getTime()
          })

        const heir = candidates[0]
        if (heir) {
          await db
            .update(circleMembers)
            .set({ role: "owner" })
            .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, heir.userId)))
        } else {
          await db.delete(circles).where(eq(circles.id, circleId))
        }
      }

      // Every other table cascades from users.id.
      await db.delete(users).where(eq(users.id, user.id))
      return { ok: true }
    },
  )
}

/** Spends about what a real verification spends, so timing gives nothing away. */
async function burnTime(password: string): Promise<boolean> {
  await hashPassword(password)
  return false
}
