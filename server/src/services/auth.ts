import type { AuthResponse, DeviceInfo } from "@hearth/shared"
import { and, eq, isNull } from "drizzle-orm"
import type { FastifyInstance } from "fastify"

import type { Database } from "../db/client"
import { auditLog, sessions, users, type User } from "../db/schema"
import { getConfig } from "../env"
import { userTopic } from "../lib/bus"
import { unauthorized } from "../lib/errors"
import { randomToken, sha256 } from "../lib/ids"
import { toCurrentUser } from "../lib/serialize"
import type { AccessTokenClaims } from "../plugins/auth"
import { getBus } from "../runtime"

export interface IssueOptions {
  device: DeviceInfo
  ip?: string | null
  userAgent?: string | null
}

export interface RotateOptions {
  ip?: string | null
  userAgent?: string | null
  /** The device the client says it is, so a replay can be told from a race. */
  deviceId?: string | null
}

/**
 * How soon after a rotation a superseded token is still explained by the
 * client rather than by a thief. An app that fires its refresh twice, or
 * retries one whose response never arrived, presents the spent token within
 * seconds. Ending the family's session over that would be its own outage,
 * so the session is kept; a device that cannot name itself is refused.
 *
 * The device the token was issued to gets longer, and gets an answer. A
 * phone on the road refreshes, the server rotates, and the response is lost
 * to the network: the phone still holds the spent token and presents it
 * again at its next upload, minutes later. Refused, it would sign itself
 * out and stop reporting until somebody opened it. Within the life of one
 * access token that presentation is the retry it looks like, and it is
 * given a fresh pair; after that it is a theft.
 */
const REFRESH_RETRY_GRACE_MS = 30_000

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
        // Signing in again is a new session on the row the old one used. The
        // token that session rotated away from would otherwise still match
        // here, and replaying it would end a session it never belonged to.
        previousRefreshTokenHash: null,
        previousRotatedAt: null,
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

  const claims: AccessTokenClaims = { sub: user.id, sid: session.id }
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
 * The presented token is rotated on every use, so a replayed one never works
 * twice. The session also remembers the hash it rotated away from, which is
 * what turns "that token is not valid" into knowing a spent token was
 * presented at all. Long after the rotation there is no innocent explanation
 * for that, so the session ends rather than leaving the thief refreshing
 * alongside the family.
 */
export async function rotateSession(
  app: FastifyInstance,
  db: Database,
  refreshToken: string,
  origin: RotateOptions,
): Promise<AuthResponse> {
  const hash = sha256(refreshToken)

  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.refreshTokenHash, hash), isNull(sessions.revokedAt)))
    .limit(1)

  if (!row) {
    const retried = await retriedRotation(db, hash, origin)
    if (!retried) {
      await containReuse(db, hash, origin)
      throw unauthorized("Refresh token is not valid.")
    }
    return rotate(app, db, retried.session, retried.user, hash, origin, { retry: true })
  }

  return rotate(app, db, row.session, row.user, hash, origin, { retry: false })
}

type SessionRow = typeof sessions.$inferSelect

async function rotate(
  app: FastifyInstance,
  db: Database,
  session: SessionRow,
  user: User,
  hash: string,
  origin: RotateOptions,
  { retry }: { retry: boolean },
): Promise<AuthResponse> {
  const config = getConfig()
  if (session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("Session expired; sign in again.")
  }
  if (!user.isActive) throw unauthorized("This account has been deactivated.")

  const nextRefresh = randomToken()
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  // The address and agent move with the token. They are the only record of who
  // is actually holding a session, and frozen at what sign-in wrote they would
  // name the owner's own phone for as long as somebody else refreshed with a
  // stolen token, which is precisely the case they exist to answer.
  await db
    .update(sessions)
    .set({
      refreshTokenHash: sha256(nextRefresh),
      // Kept so the next request can tell a token that was spent here from a
      // string that was never a token at all. A retry keeps the rotation it
      // missed as the one it is measured from, so the grace a spent token
      // gets is counted once and not from every retry.
      previousRefreshTokenHash: hash,
      ...(retry ? {} : { previousRotatedAt: new Date() }),
      lastUsedAt: new Date(),
      expiresAt,
      ip: origin.ip ?? null,
      userAgent: origin.userAgent ?? null,
    })
    .where(eq(sessions.id, session.id))

  const claims: AccessTokenClaims = { sub: user.id, sid: session.id }

  return {
    accessToken: app.jwt.sign(claims),
    refreshToken: nextRefresh,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: toCurrentUser(user),
  }
}

/**
 * The session a spent token belongs to, when the device the token was
 * issued to presents it within the life of the access token it went with:
 * the retry of a rotation whose answer never arrived. Anything else is
 * containReuse's business.
 */
async function retriedRotation(
  db: Database,
  hash: string,
  origin: RotateOptions,
): Promise<{ session: SessionRow; user: User } | null> {
  if (origin.deviceId == null) return null
  const [spent] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.previousRefreshTokenHash, hash), isNull(sessions.revokedAt)))
    .limit(1)
  if (!spent || spent.session.deviceId !== origin.deviceId) return null
  const rotatedAt = spent.session.previousRotatedAt?.getTime() ?? 0
  if (Date.now() - rotatedAt > getConfig().ACCESS_TOKEN_TTL_SECONDS * 1000) return null
  return spent
}

/**
 * Refusing the replay is not enough on its own. The thief holds a copy of a
 * token the family is still refreshing, so the session it belongs to is the
 * thing that has to end. Signing in again costs the family one password and
 * costs the thief the account.
 */
async function containReuse(db: Database, hash: string, origin: RotateOptions): Promise<void> {
  const [spent] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      deviceId: sessions.deviceId,
      rotatedAt: sessions.previousRotatedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.previousRefreshTokenHash, hash), isNull(sessions.revokedAt)))
    .limit(1)

  if (!spent) return
  const sameDevice = origin.deviceId != null && origin.deviceId === spent.deviceId
  const grace = sameDevice ? getConfig().ACCESS_TOKEN_TTL_SECONDS * 1000 : REFRESH_RETRY_GRACE_MS
  if (Date.now() - (spent.rotatedAt?.getTime() ?? 0) <= grace) return

  await revokeSession(db, spent.id)
  await db.insert(auditLog).values({
    actorUserId: spent.userId,
    action: "session.refresh_reuse",
    targetType: "session",
    targetId: spent.id,
    meta: { deviceId: spent.deviceId, rotatedAt: spent.rotatedAt?.toISOString() ?? null },
    ip: origin.ip ?? null,
  })
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  const [row] = await db
    .update(sessions)
    .set({
      revokedAt: new Date(),
      refreshTokenHash: randomToken(48),
      previousRefreshTokenHash: null,
      previousRotatedAt: null,
      pushToken: null,
    })
    .where(eq(sessions.id, sessionId))
    .returning({ userId: sessions.userId })

  if (!row) return

  // A socket opened before this ran holds no session row of its own, so
  // without word of the revocation it keeps streaming live positions until its
  // next re-authorisation pass, which is up to a minute away.
  try {
    await getBus()?.publish(userTopic(row.userId), { type: "session_revoked", sessionId })
  } catch {
    // Fan-out is best effort. The row is already revoked, every request reads
    // it, and the socket's own timer is the backstop.
  }
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
