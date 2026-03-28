import fastifyJwt from "@fastify/jwt"
import { roleAtLeast, type CircleRole } from "@hearth/shared"
import { and, eq } from "drizzle-orm"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import fp from "fastify-plugin"

import { getDb } from "../db/client"
import { circleMembers, users } from "../db/schema"
import { getConfig } from "../env"
import { forbidden, unauthorized } from "../lib/errors"

export interface AuthContext {
  userId: string
  sessionId: string
  isAdmin: boolean
}

export interface AccessTokenClaims {
  sub: string
  sid: string
  adm: boolean
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext
  }
  interface FastifyInstance {
    /** preHandler that rejects unauthenticated requests. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    /** preHandler that additionally requires the server admin flag. */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenClaims
    user: AccessTokenClaims
  }
}

export function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization
  if (header?.startsWith("Bearer ")) return header.slice(7).trim()
  // Query-string tokens end up in proxy and request logs, so they are honoured
  // for the websocket upgrade only, where RN clients cannot set headers.
  if (!isWebsocketUpgrade(request)) return null
  const query = request.query as Record<string, unknown> | undefined
  const fromQuery = query?.access_token
  if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery
  return null
}

export function isWebsocketUpgrade(request: FastifyRequest): boolean {
  return request.headers.upgrade?.toLowerCase() === "websocket"
}

/**
 * Runs in `onRequest`, before `authenticate`, so it decodes the bearer token
 * itself. A bad token falls back to the IP bucket and is rejected properly
 * later.
 */
export function rateLimitKey(app: FastifyInstance, request: FastifyRequest): string {
  const token = extractToken(request)
  if (!token) return `ip:${request.ip}`
  try {
    const claims = app.jwt.verify<AccessTokenClaims>(token)
    return `user:${claims.sub}`
  } catch {
    return `ip:${request.ip}`
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  const config = getConfig()

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, iss: "hearth" },
    verify: { allowedIss: "hearth" },
  })

  app.decorate("authenticate", async (request: FastifyRequest) => {
    const token = extractToken(request)
    if (!token) throw unauthorized("Missing bearer token.")
    let claims: AccessTokenClaims
    try {
      claims = app.jwt.verify<AccessTokenClaims>(token)
    } catch {
      throw unauthorized("Invalid or expired token.")
    }
    request.auth = { userId: claims.sub, sessionId: claims.sid, isAdmin: claims.adm === true }
  })

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply)
    if (!request.auth?.isAdmin) throw forbidden("Administrator access required.")
  })
})

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized()
  return request.auth
}

export interface Membership {
  circleId: string
  userId: string
  role: CircleRole
  sharingState: "precise" | "approximate" | "paused"
  pausedUntil: Date | null
  nickname: string | null
}

/** Returns the membership row so callers do not have to re-query it. */
export async function requireMembership(
  request: FastifyRequest,
  circleId: string,
  minRole: CircleRole = "member",
): Promise<Membership> {
  const auth = requireAuth(request)
  const db = getDb()
  const [row] = await db
    .select({
      circleId: circleMembers.circleId,
      userId: circleMembers.userId,
      role: circleMembers.role,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      nickname: circleMembers.nickname,
    })
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.userId, auth.userId)))
    .limit(1)

  // Same answer for a circle that does not exist and one the caller is not in,
  // so circle ids cannot be probed for existence.
  if (!row) throw forbidden("You are not a member of this circle.")
  if (!roleAtLeast(row.role, minRole)) {
    throw forbidden(`This action requires the ${minRole} role.`)
  }
  return row
}

export async function loadCurrentUser(request: FastifyRequest) {
  const auth = requireAuth(request)
  const db = getDb()
  const [row] = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1)
  if (!row) throw unauthorized("Account no longer exists.")
  if (!row.isActive) throw forbidden("This account has been deactivated.")
  return row
}
