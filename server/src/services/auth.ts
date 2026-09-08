import type { AuthResponse, DeviceInfo } from "@hearth/shared"
import { and, eq, isNull, sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"

import type { Database } from "../db/client"
import { auditLog, sessions, users, type SpentRefreshJson, type User } from "../db/schema"
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

/** Enough spent tokens to span a couple of hours of rotations. */
const SPENT_KEPT = 16

type Executor = Pick<Database, "select" | "update" | "insert" | "execute">

/**
 * One live session per user and device. Signing in again from the same phone
 * ends the session it had there and starts a new one with a new id, so a
 * socket or an access token bound to the old session stops working with it.
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

  const { session, replaced } = await db.transaction(async (tx) => {
    // Two sign-ins racing from one phone must not both find nothing to
    // replace and then collide on the one-live-session index.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`hearth:session:${user.id}:${options.device.deviceId}`}))`,
    )
    const old = await tx
      .update(sessions)
      .set(revokedColumns())
      .where(
        and(
          eq(sessions.userId, user.id),
          eq(sessions.deviceId, options.device.deviceId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id })
    const [created] = await tx
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
      .returning({ id: sessions.id })
    return { session: created, replaced: old.map((row) => row.id) }
  })

  if (!session) throw new Error("failed to create session")
  for (const id of replaced) await announceRevoked(user.id, id)

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

type SessionRow = typeof sessions.$inferSelect

/**
 * The presented token is rotated on every use, so a replayed one never works
 * twice. The session also remembers the tokens it rotated away from, which is
 * what turns "that token is not valid" into knowing a spent token was
 * presented at all.
 *
 * A spent token from the device it was issued to, within the life of one
 * access token and for the first time, is a retry of a rotation whose answer
 * was lost, and is answered. A spent token presented a moment after it was
 * spent, from anywhere, is an app firing its refresh twice, and is only
 * refused. Anything else is somebody else holding the family's token, and
 * the session ends so the thief does not go on refreshing alongside them.
 */
export async function rotateSession(
  app: FastifyInstance,
  db: Database,
  refreshToken: string,
  origin: RotateOptions,
): Promise<AuthResponse> {
  const hash = sha256(refreshToken)
  const config = getConfig()

  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.refreshTokenHash, hash), isNull(sessions.revokedAt)))
      .limit(1)
      .for("update", { of: sessions })
    if (current) {
      return {
        kind: "rotated" as const,
        ...(await rotate(tx, current.session, current.user, hash, origin)),
      }
    }

    const [spentRow] = await tx
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          sql`${sessions.spentRefresh} @> ${JSON.stringify([{ h: hash }])}::jsonb`,
          isNull(sessions.revokedAt),
        ),
      )
      .limit(1)
      .for("update", { of: sessions })
    if (!spentRow) return { kind: "unknown" as const }

    const spent = spentRow.session.spentRefresh.find((entry) => entry.h === hash)!
    if (spent.displaced) return { kind: "unknown" as const }
    const age = Date.now() - Date.parse(spent.at)
    const sameDevice = origin.deviceId != null && origin.deviceId === spentRow.session.deviceId
    if (sameDevice && !spent.retried && age <= config.ACCESS_TOKEN_TTL_SECONDS * 1000) {
      return {
        kind: "rotated" as const,
        ...(await rotate(
          tx,
          spentRow.session,
          spentRow.user,
          spentRow.session.refreshTokenHash,
          origin,
          hash,
        )),
      }
    }
    if (age <= REFRESH_RETRY_GRACE_MS && !spent.retried) return { kind: "unknown" as const }

    await tx.update(sessions).set(revokedColumns()).where(eq(sessions.id, spentRow.session.id))
    await tx.insert(auditLog).values({
      actorUserId: spentRow.session.userId,
      action: "session.refresh_reuse",
      targetType: "session",
      targetId: spentRow.session.id,
      meta: { deviceId: spentRow.session.deviceId, spentAt: spent.at, retried: spent.retried },
      ip: origin.ip ?? null,
    })
    return {
      kind: "revoked" as const,
      userId: spentRow.session.userId,
      sessionId: spentRow.session.id,
    }
  })

  if (outcome.kind === "revoked") {
    await announceRevoked(outcome.userId, outcome.sessionId)
    throw unauthorized("Refresh token is not valid.")
  }
  if (outcome.kind === "unknown") throw unauthorized("Refresh token is not valid.")

  const claims: AccessTokenClaims = { sub: outcome.user.id, sid: outcome.session.id }
  return {
    accessToken: app.jwt.sign(claims),
    refreshToken: outcome.refreshToken,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
    user: toCurrentUser(outcome.user),
  }
}

/**
 * Issues the next token. `spentHash` is the token leaving service: the one
 * presented on an ordinary rotation, or the live one a retry displaces. A
 * retry also marks the token it answered, so it is answered only once.
 */
async function rotate(
  tx: Executor,
  session: SessionRow,
  user: User,
  spentHash: string,
  origin: RotateOptions,
  retriedHash?: string,
): Promise<{ session: SessionRow; user: User; refreshToken: string }> {
  const config = getConfig()
  if (session.expiresAt.getTime() <= Date.now()) {
    throw unauthorized("Session expired; sign in again.")
  }
  if (!user.isActive) throw unauthorized("This account has been deactivated.")

  const nextRefresh = randomToken()
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  const spentRefresh: SpentRefreshJson[] = [
    ...session.spentRefresh.map((entry) =>
      entry.h === retriedHash ? { ...entry, retried: true } : entry,
    ),
    {
      h: spentHash,
      at: new Date().toISOString(),
      retried: false,
      ...(retriedHash ? { displaced: true } : {}),
    },
  ].slice(-SPENT_KEPT)

  // The address and agent move with the token. They are the only record of who
  // is actually holding a session, and frozen at what sign-in wrote they would
  // name the owner's own phone for as long as somebody else refreshed with a
  // stolen token, which is precisely the case they exist to answer.
  await tx
    .update(sessions)
    .set({
      refreshTokenHash: sha256(nextRefresh),
      spentRefresh,
      lastUsedAt: new Date(),
      expiresAt,
      ip: origin.ip ?? null,
      userAgent: origin.userAgent ?? null,
    })
    .where(eq(sessions.id, session.id))

  return { session, user, refreshToken: nextRefresh }
}

function revokedColumns() {
  return {
    revokedAt: new Date(),
    refreshTokenHash: randomToken(48),
    spentRefresh: [] as SpentRefreshJson[],
    pushToken: null,
  }
}

/**
 * A socket opened before the revocation holds no session row of its own, so
 * without word of it it keeps streaming live positions until its next
 * re-authorisation pass, which is up to a minute away.
 */
async function announceRevoked(userId: string, sessionId: string): Promise<void> {
  try {
    await getBus()?.publish(userTopic(userId), { type: "session_revoked", sessionId })
  } catch {
    // Fan-out is best effort. The row is already revoked, every request reads
    // it, and the socket's own timer is the backstop.
  }
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  const [row] = await db
    .update(sessions)
    .set(revokedColumns())
    .where(eq(sessions.id, sessionId))
    .returning({ userId: sessions.userId })
  if (row) await announceRevoked(row.userId, sessionId)
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
