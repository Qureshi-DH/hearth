import { PLATFORMS } from "@hearth/shared"
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { Readable } from "node:stream"
import { z } from "zod"

import { getDb } from "../db/client"
import { getConfig } from "../env"
import {
  checkIns,
  circleMembers,
  circles,
  locationPoints,
  places,
  sessions,
  trips,
  users,
  type LocationPoint,
} from "../db/schema"
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  tooManyRequests,
  unauthorized,
} from "../lib/errors"
import { avatarColorFor, normalizeEmail } from "../lib/ids"
import { hashPassword, validatePasswordStrength, verifyPassword } from "../lib/password"
import { toCurrentUser, toSessionSummary } from "../lib/serialize"
import { loadCurrentUser, requireAuth } from "../plugins/auth"
import { issueSession, revokeAllSessions, revokeSession, rotateSession } from "../services/auth"
import { acceptInvite, previewInvite } from "../services/invites"
import { registrationMode } from "../services/settings"
import {
  avatarKey,
  avatarPath,
  deleteObject,
  keyFromAvatarPath,
  MAX_AVATAR_BYTES,
  putObject,
  sniffImageType,
  storageEnabled,
} from "../services/storage"

const DeviceSchema = z.object({
  deviceId: z.string().min(6).max(128),
  deviceName: z.string().max(120).nullish(),
  platform: z.enum(PLATFORMS).nullish(),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
})

/** How many breadcrumbs the export holds in memory at once. */
const EXPORT_PAGE_SIZE = 5_000

const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .refine((value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value), "Enter a valid email address.")

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()
  const config = getConfig()

  // A password check runs a full scrypt, which costs orders of magnitude more
  // than an ordinary request, so the credential routes get their own budget.
  // The floor is what matters: these routes are keyed by address, and behind a
  // reverse proxy that is one bucket for the whole household, so a fraction of
  // RATE_LIMIT_MAX alone would turn a sensible tightening of the global dial
  // into one login a minute for everyone. It still scales upward for anyone
  // who raises the global figure.
  const credentialLimit = {
    max: Math.max(30, Math.floor(config.RATE_LIMIT_MAX / 20)),
    timeWindow: "1 minute",
  }

  // Keyed by account AND address together. Keyed by account alone, anyone who
  // knows a member's email could hold them locked out for ever without a
  // credential. Keyed by address alone, one guessed account would exhaust the
  // budget for everyone behind the same router.
  const loginAttempts = app.createRateLimit({
    max: 8,
    timeWindow: "5 minutes",
    keyGenerator: (request) => {
      const body = request.body as { email?: unknown } | undefined
      const email = typeof body?.email === "string" ? normalizeEmail(body.email) : ""
      return `login:${email}:${request.ip}`
    },
  })

  app.post(
    "/auth/register",
    {
      config: { rateLimit: credentialLimit },
      schema: {
        tags: ["auth"],
        summary: "Create an account",
        description:
          "Subject to the server's registration mode, with no exemption for the first " +
          "account. The administrator is created from ADMIN_EMAIL at boot instead.",
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

      // No exemption for the first account. The admin comes from ADMIN_EMAIL at
      // boot, so an empty server is never claimable by whoever finds it first.
      const mode = await registrationMode(db)
      if (mode === "closed") {
        throw forbidden("This server is not accepting new accounts.")
      }
      if (mode === "invite") {
        if (!inviteCode) throw badRequest("An invite code is required on this server.")
        const preview = await previewInvite(db, inviteCode)
        if (!preview.valid) throw badRequest("That invite code is not valid.")
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
        .onConflictDoNothing({ target: users.emailNormalized })
        .returning()

      // Two signups racing on the same address both clear the check above, and
      // the loser would otherwise surface the unique violation as a 500.
      if (!created) throw conflict("An account with that email already exists.")

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
      config: { rateLimit: credentialLimit },
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

      const attempt = await loginAttempts(request)
      if (!attempt.isAllowed && attempt.isExceeded) {
        throw tooManyRequests("Too many sign-in attempts for this account. Try again shortly.")
      }

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
      config: { rateLimit: credentialLimit },
      schema: {
        tags: ["auth"],
        summary: "Exchange a refresh token for a new pair",
        description: "Refresh tokens are single-use. Each call rotates the token.",
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
    "/auth/me/avatar",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["auth"],
        summary: "Upload a profile picture",
        description:
          "multipart/form-data with one image field. JPEG, PNG or WebP, at most 2 MB. " +
          "The app resizes before uploading, which also drops the photo's EXIF.",
        consumes: ["multipart/form-data"],
      },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request) => {
      if (!storageEnabled()) throw badRequest("This server has no image storage configured.")
      const auth = requireAuth(request)

      const upload = await request.file({ limits: { fileSize: MAX_AVATAR_BYTES } })
      if (!upload) throw badRequest("No image was uploaded.")

      let buffer: Buffer
      try {
        buffer = await upload.toBuffer()
      } catch {
        throw badRequest("That image is larger than 2 MB.")
      }

      // The declared content type is whatever the client felt like sending.
      const contentType = sniffImageType(buffer)
      if (!contentType) throw badRequest("That file is not a JPEG, PNG or WebP image.")

      const [current] = await db
        .select({ avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)

      const key = avatarKey(contentType)
      await putObject(key, buffer, contentType)

      const [updated] = await db
        .update(users)
        .set({ avatarUrl: avatarPath(key), updatedAt: new Date() })
        .where(eq(users.id, auth.userId))
        .returning()
      if (!updated) throw notFound()

      // Only once the row points at the new object, so a failure here leaves an
      // orphan rather than an avatar that 404s.
      const previous = keyFromAvatarPath(current?.avatarUrl ?? null)
      if (previous) await deleteObject(previous)

      return toCurrentUser(updated)
    },
  )

  app.delete(
    "/auth/me/avatar",
    {
      preHandler: app.authenticate,
      schema: { tags: ["auth"], summary: "Remove the profile picture" },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [current] = await db
        .select({ avatarUrl: users.avatarUrl })
        .from(users)
        .where(eq(users.id, auth.userId))
        .limit(1)

      const [updated] = await db
        .update(users)
        .set({ avatarUrl: null, updatedAt: new Date() })
        .where(eq(users.id, auth.userId))
        .returning()
      if (!updated) throw notFound()

      const key = keyFromAvatarPath(current?.avatarUrl ?? null)
      if (key) await deleteObject(key)

      return toCurrentUser(updated)
    },
  )

  app.post(
    "/auth/password",
    {
      preHandler: app.authenticate,
      config: { rateLimit: credentialLimit },
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
      // A full history is minutes of streaming. Under the global budget alone,
      // a few hundred of these at once is the whole server.
      config: { rateLimit: { max: 3, timeWindow: "10 minutes" } },
      schema: {
        tags: ["account"],
        summary: "Export everything this server holds about you",
        description:
          "A single JSON document: profile, circles, breadcrumbs, places, trips and check-ins.",
      },
    },
    async (request, reply) => {
      const user = await loadCurrentUser(request)

      const [memberships, myTrips, myCheckIns] = await Promise.all([
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
        db.select().from(trips).where(eq(trips.userId, user.id)),
        db.select().from(checkIns).where(eq(checkIns.userId, user.id)),
      ])

      const placesCreated = await db.select().from(places).where(eq(places.createdBy, user.id))

      /**
       * Every other part of this document is bounded by how many circles and
       * trips one person has. The breadcrumbs are not: a phone reporting every
       * half minute leaves a quarter of a million rows inside the default
       * retention window, and holding all of them plus the string they
       * serialise into is more memory than the small boxes this server is meant
       * to run on have. Streaming a page at a time keeps that flat, and keeps
       * the export honest to its own summary rather than cut off at a limit.
       */
      async function* document(): AsyncGenerator<string> {
        const head = JSON.stringify({
          exportedAt: new Date().toISOString(),
          profile: toCurrentUser(user),
          circles: memberships,
          trips: myTrips,
          checkIns: myCheckIns,
          placesCreated,
        })
        yield `${head.slice(0, -1)},"locationHistory":[`

        let before: Date | null = null
        let first = true
        for (;;) {
          const page: LocationPoint[] = await db
            .select()
            .from(locationPoints)
            .where(
              before
                ? and(eq(locationPoints.userId, user.id), lte(locationPoints.recordedAt, before))
                : eq(locationPoints.userId, user.id),
            )
            .orderBy(desc(locationPoints.recordedAt))
            .limit(EXPORT_PAGE_SIZE)

          // Keyset, not OFFSET: a fix uploaded from the road while the export
          // runs shifts an offset window and duplicates a row. Rows sharing the
          // page's final timestamp are held back instead, because the next page
          // starts at that timestamp and is the one that emits them.
          const boundary =
            page.length === EXPORT_PAGE_SIZE ? page[page.length - 1]!.recordedAt : null
          const trimmed = boundary
            ? page.filter((row) => row.recordedAt.getTime() !== boundary.getTime())
            : page
          // Holding the ties back can only empty a page if every row in it
          // shares one timestamp, which would need a device per row. Emitting
          // that page whole is what stops the loop spinning on it.
          const last = boundary === null || trimmed.length === 0
          const emit = last ? page : trimmed

          if (emit.length > 0) {
            const chunk = emit.map((row) => JSON.stringify(row)).join(",")
            yield first ? chunk : `,${chunk}`
            first = false
          }

          if (last) break
          before = boundary
        }

        yield "]}"
      }

      reply.header("content-disposition", `attachment; filename="hearth-export-${user.id}.json"`)
      reply.header("content-type", "application/json; charset=utf-8")
      return Readable.from(document())
    },
  )

  app.delete(
    "/me",
    {
      preHandler: app.authenticate,
      config: { rateLimit: credentialLimit },
      schema: {
        tags: ["account"],
        summary: "Delete your account and all of your data",
        description:
          "Irreversible. Circles you solely own are deleted with you. Circles with other " +
          "members survive, and ownership passes to the longest-standing admin, or to the " +
          "longest-standing member when there is no admin.",
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

      // The rows that belong to them go with them. The ones that only credit
      // them, like who created a circle or resolved an alert, are set null, so
      // deleting an account never deletes somebody else's circle.
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
