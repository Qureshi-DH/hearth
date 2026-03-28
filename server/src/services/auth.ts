import type { AuthResponse, DeviceInfo } from "@hearth/shared"
import { and, eq, isNull } from "drizzle-orm"
import type { FastifyInstance } from "fastify"

import type { Database } from "../db/client"
import { sessions, users, type User } from "../db/schema"
import { getConfig } from "../env"
import { unauthorized } from "../lib/errors"
import { randomToken, sha256 } from "../lib/ids"
import { toCurrentUser } from "../lib/serialize"
import type { AccessTokenClaims } from "../plugins/auth"

export interface IssueOptions {
  device: DeviceInfo
  ip?: string | null
  userAgent?: string | null
}

/**
 * One session per user and device. Signing in again from the same phone
 * rotates the credential in place rather than piling up rows, which keeps the
 * "your devices" screen honest.
 */
export async function issueSession(
  app: FastifyInstance,
  db: Database,
  user: User,
  options: IssueOptions,
): Promise<AuthResponse> {
  const config = getConfig()
  const refreshToken = randomToken()
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  const [session] = await db
    .insert(sessions)
    .values({
      userId: user.id,
      refreshTokenHash: sha256(refreshToken),
      deviceId: options.device.deviceId,
      deviceName: options.device.deviceName ?? null,
      platform: options.device.platform ?? null,
      appVersion: options.device.appVersion ?? null,
      osVersion: options.device.osVersion ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      lastUsedAt: new Date(),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [sessions.userId, sessions.deviceId],
      set: {
        refreshTokenHash: sha256(refreshToken),
        deviceName: options.device.deviceName ?? null,
        platform: options.device.platform ?? null,
        appVersion: options.device.appVersion ?? null,
        osVersion: options.device.osVersion ?? null,
        ip: options.ip ?? null,
        userAgent: options.userAgent ?? null,
        lastUsedAt: new Date(),
        expiresAt,
        revokedAt: null,
      },
    })
    .returning({ id: sessions.id })

  if (!session) throw new Error("failed to create session")

  const claims: AccessTokenClaims = { sub: user.id, sid: session.id, adm: user.isAdmin }
  const accessToken = app.jwt.sign(claims)

  await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id))

  return {
    accessToken,
    refreshToken,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: toCurrentUser(user),
  }
}

/**
 * The presented token is rotated on every use, so a replayed one fails the
 * second time. That is the cheap version of reuse detection.
 */
export async function rotateSession(
  app: FastifyInstance,
  db: Database,
  refreshToken: string,
): Promise<AuthResponse> {
  const config = getConfig()
  const hash = sha256(refreshToken)

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.refreshTokenHash, hash), isNull(sessions.revokedAt)))
    .limit(1)

  if (!row) throw unauthorized("Refresh token is not valid.")
  if (row.session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("Session expired; sign in again.")
  }
  if (!row.user.isActive) throw unauthorized("This account has been deactivated.")

  const nextRefresh = randomToken()
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  await db
    .update(sessions)
    .set({ refreshTokenHash: sha256(nextRefresh), lastUsedAt: new Date(), expiresAt })
    .where(eq(sessions.id, row.session.id))

  const claims: AccessTokenClaims = {
    sub: row.user.id,
    sid: row.session.id,
    adm: row.user.isAdmin,
  }

  return {
    accessToken: app.jwt.sign(claims),
    refreshToken: nextRefresh,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: toCurrentUser(row.user),
  }
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date(), refreshTokenHash: randomToken(48), pushToken: null })
    .where(eq(sessions.id, sessionId))
}

export async function revokeAllSessions(
  db: Database,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))

  const targets = rows.filter((row) => row.id !== exceptSessionId)
  for (const target of targets) await revokeSession(db, target.id)
  return targets.length
}
