import { API_PREFIX } from "@hearth/shared"
import type { FastifyRequest } from "fastify"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { auditLog, type User } from "../db/schema"
import { getConfig } from "../env"
import { readCookie, serializeCookie } from "../lib/cookies"
import { emailSchema } from "../lib/email"
import { AppError, forbidden, unauthorized } from "../lib/errors"
import { toPortalSession } from "../lib/serialize"
import { issueSession, revokeSessionByRefreshToken, rotateSession } from "../services/auth"

/**
 * A portal left open in a browser is a way into every member's account, so
 * its session ends after a working day however often it renews.
 */
const PORTAL_SESSION_MS = 12 * 60 * 60 * 1000

const PORTAL_COOKIE = "hearth_portal"
const COOKIE_PATH = `${API_PREFIX}/auth/portal`

export interface PortalRouteOptions {
  /** The app's own credential check, so both sign-ins spend the same budgets. */
  checkCredentials: (request: FastifyRequest, email: string, password: string) => Promise<User>
  rateLimit: { max: number; timeWindow: string }
}

/**
 * The admin portal signs in here rather than through /auth/login. Its
 * refresh token goes into a cookie the page's script cannot read and no other
 * site can send, so it cannot be copied off the page. A script running on
 * the page could still ask for a renewal, which is why the page allows no
 * script but its own. Only an administrator gets a session.
 */
export const portalRoutes: FastifyPluginAsyncZod<PortalRouteOptions> = async (app, options) => {
  const db = getDb()
  const config = getConfig()
  const publicHost = new URL(config.PUBLIC_URL).host

  /**
   * Secure when the page is on https: the request's own, or the public
   * address behind a proxy that ends TLS. A Secure cookie set for a page
   * opened over plain http on the LAN would be dropped, and the next renewal
   * would sign the administrator out without a word.
   */
  function cookie(request: FastifyRequest, value: string, maxAgeSeconds?: number) {
    const secure =
      request.protocol === "https" ||
      (config.PUBLIC_URL.startsWith("https://") && request.headers.host === publicHost)
    return serializeCookie(PORTAL_COOKIE, value, { path: COOKIE_PATH, secure, maxAgeSeconds })
  }

  /**
   * SameSite keeps other sites from sending the cookie, but a sibling
   * subdomain counts as the same site. A browser's Origin says where the page
   * really was.
   */
  function requireOwnOrigin(request: FastifyRequest) {
    const origin = request.headers.origin
    if (origin && !isOwnOrigin(origin, request.headers.host, publicHost)) {
      throw forbidden("That request did not come from this server's portal.")
    }
  }

  const device = (deviceId: string) => ({
    deviceId,
    deviceName: "Admin portal",
    platform: "web" as const,
  })

  app.post(
    "/auth/portal/login",
    {
      config: { rateLimit: options.rateLimit },
      schema: {
        tags: ["auth"],
        summary: "Sign in to the admin portal",
        description:
          "Administrators only. The refresh token is set as an HttpOnly cookie scoped to " +
          "the portal's session routes, and only the access token is in the body. The " +
          "session lasts twelve hours and renewing does not extend it.",
        body: z.object({
          email: emailSchema,
          password: z.string().min(1).max(512),
          deviceId: z.string().min(6).max(128),
        }),
      },
    },
    async (request, reply) => {
      const user = await options.checkCredentials(
        request,
        request.body.email,
        request.body.password,
      )
      if (!user.isAdmin) throw forbidden("Only a server administrator can sign in here.")
      const session = await issueSession(app, db, user, {
        device: device(request.body.deviceId),
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
        lifetimeMs: PORTAL_SESSION_MS,
      })
      await db.insert(auditLog).values({
        actorUserId: user.id,
        action: "portal.sign_in",
        targetType: "user",
        targetId: user.id,
        meta: {},
        ip: request.ip,
      })
      reply.header("set-cookie", cookie(request, session.refreshToken))
      return toPortalSession(session)
    },
  )

  app.post(
    "/auth/portal/refresh",
    {
      config: { rateLimit: options.rateLimit },
      schema: {
        tags: ["auth"],
        summary: "Renew an admin portal session from its cookie",
        body: z.object({ deviceId: z.string().min(6).max(128) }),
      },
    },
    async (request, reply) => {
      requireOwnOrigin(request)
      const token = readCookie(request, PORTAL_COOKIE)
      if (!token) throw unauthorized("Sign in to the admin portal.")

      let session
      try {
        session = await rotateSession(app, db, token, {
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          deviceId: request.body.deviceId,
          keepExpiry: true,
        })
      } catch (error) {
        // A cookie for a session that is over is no use to keep.
        if (error instanceof AppError && error.statusCode === 401) {
          reply.header("set-cookie", cookie(request, "", 0))
        }
        throw error
      }
      if (!session.user.isAdmin) {
        await revokeSessionByRefreshToken(db, session.refreshToken)
        reply.header("set-cookie", cookie(request, "", 0))
        throw forbidden("This account is no longer a server administrator.")
      }
      reply.header("set-cookie", cookie(request, session.refreshToken))
      return toPortalSession(session)
    },
  )

  app.post(
    "/auth/portal/logout",
    {
      schema: {
        tags: ["auth"],
        summary: "Sign out of the admin portal",
        description: "Ends the session the cookie belongs to. Needs no access token.",
      },
    },
    async (request, reply) => {
      requireOwnOrigin(request)
      const token = readCookie(request, PORTAL_COOKIE)
      if (token) await revokeSessionByRefreshToken(db, token)
      reply.header("set-cookie", cookie(request, "", 0))
      return { ok: true }
    },
  )
}

/** Whether an Origin header names this server, by the host it was asked on or its public one. */
function isOwnOrigin(origin: string, host: string | undefined, publicHost: string): boolean {
  try {
    const from = new URL(origin).host
    return from === host || from === publicHost
  } catch {
    return false
  }
}
