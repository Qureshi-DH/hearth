import { PLATFORMS, type DeviceHealth } from "@hearth/shared"
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm"
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
  userPresence,
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
import { clientBucket } from "../lib/net"
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

/**
 * Format characters that either draw nothing or reverse what follows them.
 * ZWJ and the variation selectors are deliberately absent: ZWJ is what holds an
 * emoji family together, and stripping either would break ordinary names.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u180E\u200B\u202A-\u202E\u2060\uFEFF]/gu

/** Anything Unicode calls a combining mark. */
const COMBINING_RUN = /\p{M}{4,}/gu

/**
 * A display name is read back to every circle the account is in: push titles,
 * feed lines, the member list, "was driving at 50 km/h". All of those are one
 * line of text. Left raw, a member can put a newline in their name and forge a
 * second line in everybody else's notifications, flip the reading direction of
 * the rest of the line, or stack seventy accents on one letter and smear them
 * over the rows underneath.
 *
 * It runs where the name is stored rather than where each line is built,
 * because a display name is a single-line field by nature and nothing in it
 * that only survives as a line break is worth keeping.
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
const displayNameSchema = z
  .string()
  .max(400)
  .describe("At most 80 characters once invisible and direction-changing ones are removed.")
  .transform(singleLine)
  .refine((value) => value.length > 0 && [...value].length <= 80, {
    message: "A display name has to be between 1 and 80 characters.",
  })

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
      return `login:${email}:${clientBucket(request.ip)}`
    },
  })

  // And a budget per account across every address, so a password cannot be
  // worked through slowly from a botnet either. Generous, because anyone who
  // knows the email can spend it: running out stops new sign-ins to that
  // account for the hour and touches no phone that is already signed in.
  const accountAttempts = app.createRateLimit({
    max: 100,
    timeWindow: "1 hour",
    keyGenerator: (request) => {
      const body = request.body as { email?: unknown } | undefined
      const email = typeof body?.email === "string" ? normalizeEmail(body.email) : ""
      return `login-account:${email}`
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
          displayName: displayNameSchema,
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

      // No exemption for the first account: the registration mode is enforced
      // whether or not the server has any users yet. In invite and closed mode
      // that is what keeps an empty server from being claimed, since a valid
      // invite can only come from an account that does not exist yet.
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
          // The zero-config escape hatch for a server started with no
          // ADMIN_EMAIL, and the reason an open-mode server must be given one:
          // without a seeded administrator, open mode hands the server to the
          // first stranger who finds it. env.ts refuses to start without
          // ADMIN_EMAIL in production for exactly that reason.
          isAdmin: isFirstUser,
        })
        .onConflictDoNothing({ target: users.emailNormalized })
        .returning()

      // Two signups racing on the same address both clear the check above, and
      // the loser would otherwise surface the unique violation as a 500.
      if (!created) throw conflict("An account with that email already exists.")

      // Fires at most once in a server's life, and only for the configuration
      // that has no seeded administrator to hand the role to instead. Silently
      // handing it to a stranger is the part that would be hard to notice.
      if (isFirstUser && !config.ADMIN_EMAIL) {
        request.log.warn(
          { userId: created.id, registrationMode: mode },
          "the first account on this empty server was made an administrator: set ADMIN_EMAIL " +
            "and ADMIN_PASSWORD so the role goes to you at boot instead",
        )
      }

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
      const overall = await accountAttempts(request)
      if (!overall.isAllowed && overall.isExceeded) {
        throw tooManyRequests("Too many sign-in attempts for this account. Try again in an hour.")
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
        description:
          "Refresh tokens are single-use. Each call rotates the token. A spent token " +
          "presented again ends the session, unless it comes from the device the session " +
          "belongs to within one access token's lifetime, which is a client racing itself " +
          "rather than a thief; send `deviceId` so that can be told apart.",
        body: z.object({
          refreshToken: z.string().min(10).max(512),
          deviceId: z.string().min(6).max(128).optional(),
        }),
      },
    },
    async (request) =>
      rotateSession(app, db, request.body.refreshToken, {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        deviceId: request.body.deviceId ?? null,
      }),
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
          displayName: displayNameSchema.optional(),
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
      // A lapsed row can no longer refresh, so it is not a signed-in device
      // whatever the prune job has got round to.
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, auth.userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        )
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

      // Only places in circles this person still belongs to. A place they
      // created before leaving is the circle's now, and the family may have
      // moved it to an address the former member has no business learning.
      const placesCreated = await db
        .select({ place: places })
        .from(places)
        .innerJoin(
          circleMembers,
          and(eq(circleMembers.circleId, places.circleId), eq(circleMembers.userId, user.id)),
        )
        .where(eq(places.createdBy, user.id))
        .then((rows) => rows.map((row) => row.place))

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

  app.patch(
    "/me/health",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["account"],
        summary: "What stands between this phone and reporting",
        description:
          "The phone's own account of its permissions and switches: the location permission " +
          "level, Location Services, Background App Refresh on iOS, battery optimisation and " +
          "background restriction on Android, power saving on either, and whether the " +
          "location service died without being asked. The circle sees it under the member's " +
          "name instead of a mystery, and a quiet phone that has said why is reported as such " +
          "rather than as offline.",
        body: z.object({
          locationPermission: z.enum(["always", "foreground", "denied", "unknown"]),
          locationServices: z.boolean(),
          backgroundRefresh: z.enum(["available", "denied", "restricted"]).optional(),
          batteryOptimised: z.boolean().optional(),
          backgroundRestricted: z.boolean().optional(),
          lowPowerMode: z.boolean().optional(),
          manufacturer: z.string().max(80).optional(),
          serviceStopped: z.boolean().optional(),
        }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const health: DeviceHealth = { ...request.body, reportedAt: new Date().toISOString() }
      await db
        .insert(userPresence)
        .values({ userId: auth.userId, health })
        .onConflictDoUpdate({ target: userPresence.userId, set: { health } })
      return { ok: true as const }
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
