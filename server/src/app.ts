import net from "node:net"

import multipart from "@fastify/multipart"
import websocket from "@fastify/websocket"
import { API_PREFIX } from "@hearth/shared"
import Fastify, { type FastifyInstance } from "fastify"
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodFastifySchemaValidationError,
} from "fastify-type-provider-zod"

import { getConfig } from "./env"
import { MAX_AVATAR_BYTES } from "./services/storage"
import { AppError } from "./lib/errors"
import { loggerOptions } from "./logger"
import { adminRoutes } from "./modules/admin.routes"
import { authRoutes } from "./modules/auth.routes"
import { circleRoutes } from "./modules/circles.routes"
import { eventRoutes } from "./modules/events.routes"
import { locationRoutes } from "./modules/locations.routes"
import { mediaRoutes } from "./modules/media.routes"
import { placeRoutes } from "./modules/places.routes"
import { findPortalDir, registerPortal, type Portal } from "./plugins/portal"
import { pushRoutes } from "./modules/push.routes"
import { safetyRoutes } from "./modules/safety.routes"
import { healthRoutes, joinRoutes, systemRoutes } from "./modules/system.routes"
import { tripRoutes } from "./modules/trips.routes"
import { registerWebsocket } from "./modules/ws.routes"
import { authPlugin } from "./plugins/auth"
import { securityPlugin } from "./plugins/security"

declare const __HEARTH_VERSION__: string | undefined

/** Baked in by tsup for the bundle. Falls back to the package manager in dev. */
const VERSION =
  typeof __HEARTH_VERSION__ === "string"
    ? __HEARTH_VERSION__
    : (process.env.npm_package_version ?? "0.0.0-dev")

/** A reverse proxy reaches the API over loopback or a private network. */
const proxyPeers = new net.BlockList()
proxyPeers.addSubnet("127.0.0.0", 8, "ipv4")
proxyPeers.addSubnet("10.0.0.0", 8, "ipv4")
proxyPeers.addSubnet("172.16.0.0", 12, "ipv4")
proxyPeers.addSubnet("192.168.0.0", 16, "ipv4")
proxyPeers.addSubnet("169.254.0.0", 16, "ipv4")
proxyPeers.addAddress("::1", "ipv6")
proxyPeers.addSubnet("fc00::", 7, "ipv6")
proxyPeers.addSubnet("fe80::", 10, "ipv6")

/**
 * `trustProxy: true` believes the whole X-Forwarded-For chain, and the
 * left-hand end of that chain is whatever the caller typed. The rate limiter
 * and the login throttle are keyed on request.ip, so a caller that picks its
 * own address gets a fresh bucket per request and unlimited password guesses.
 * Trusting only the immediate peer, and only when it sits on a private
 * network, leaves request.ip as the address the proxy itself appended.
 *
 * Two proxies in a row still attribute the request to the second one. That
 * under-counts, which costs an operator nothing but a shared rate-limit
 * bucket, where over-trusting costs them the throttle.
 */
export function proxyTrust(
  trustProxy: boolean,
): ((address: string, hop: number) => boolean) | false {
  if (!trustProxy) return false
  return (address, hop) =>
    hop === 0 &&
    net.isIP(address) !== 0 &&
    proxyPeers.check(address, net.isIPv6(address) ? "ipv6" : "ipv4")
}

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig()

  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: proxyTrust(config.TRUST_PROXY),
    // Location batches are the largest thing a client sends.
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Auth registers first. The rate limiter's key generator decodes bearer
  // tokens with app.jwt.
  await app.register(authPlugin)
  await app.register(securityPlugin)
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  })
  await app.register(multipart, {
    limits: { files: 1, fileSize: MAX_AVATAR_BYTES },
  })

  if (config.ENABLE_SWAGGER) {
    const swagger = await import("@fastify/swagger")
    const swaggerUi = await import("@fastify/swagger-ui")

    await app.register(swagger.default, {
      openapi: {
        info: {
          title: "Hearth API",
          version: VERSION,
          description:
            "Self-hosted family location sharing. All endpoints live under `/api/v1` and, " +
            "unless marked otherwise, require a bearer access token.",
        },
        servers: [{ url: config.PUBLIC_URL }],
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
          },
        },
        security: [{ bearerAuth: [] }],
        tags: [
          { name: "system", description: "Health and capability discovery" },
          { name: "auth", description: "Accounts, sessions and devices" },
          { name: "account", description: "Data export and deletion" },
          { name: "circles", description: "Families and their members" },
          { name: "invites", description: "Joining a circle" },
          { name: "locations", description: "Uploading and reading positions" },
          { name: "places", description: "Geofences and arrive/leave events" },
          { name: "events", description: "Activity feed" },
          { name: "safety", description: "SOS, check-ins and nudges" },
          { name: "trips", description: "Journeys derived from history" },
          { name: "push", description: "Notification transport registration" },
          { name: "admin", description: "Server administration" },
        ],
      },
      transform: jsonSchemaTransform,
    })

    // The reference shares an origin with the admin portal, so a hole in it
    // would be a hole in the portal. It gets a content policy of its own.
    await app.register(swaggerUi.default, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
      staticCSP: true,
    })
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const issues = error.validation as ZodFastifySchemaValidationError[]
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "The request body or parameters are not valid.",
          details: issues.map((issue) => ({
            path: issue.instancePath.replace(/^\//, "").replace(/\//g, "."),
            message: issue.message ?? "Invalid value.",
          })),
        },
      })
    }

    const failure = error as { statusCode?: number; code?: string; message?: string }
    const statusCode = failure.statusCode ?? 500

    if (statusCode === 429) {
      return reply.code(429).send({
        error: { code: "too_many_requests", message: "Too many requests; slow down." },
      })
    }

    if (statusCode >= 500) {
      request.log.error({ err: error }, "unhandled error")
      return reply.code(500).send({
        error: {
          code: "internal_error",
          // Never leak stack traces or driver messages to a client.
          message: "Something went wrong on the server.",
        },
      })
    }

    return reply.code(statusCode).send({
      error: {
        code: failure.code ?? "request_error",
        message: failure.message ?? "Request could not be processed.",
      },
    })
  })

  const portalDir = config.ENABLE_ADMIN_PORTAL ? findPortalDir(config.ADMIN_PORTAL_DIR) : null
  const portal: Portal | null = portalDir ? await registerPortal(app, portalDir) : null

  // A browser asking for a portal page the router does not know, a bookmark
  // to /accounts, gets the portal, which works out the page itself. Limited
  // like every other route, since anyone can ask for a path that is not one.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (request, reply) => {
    if (portal?.wants(request)) return portal.send(reply)
    return reply.code(404).send({
      error: { code: "not_found", message: `No route for ${request.method} ${request.url}.` },
    })
  })

  await app.register(healthRoutes)
  await app.register(joinRoutes)

  await app.register(
    async (api) => {
      await api.register(systemRoutes)
      await api.register(mediaRoutes)
      await api.register(authRoutes)
      await api.register(circleRoutes)
      await api.register(locationRoutes)
      await api.register(placeRoutes)
      await api.register(eventRoutes)
      await api.register(safetyRoutes)
      await api.register(tripRoutes)
      await api.register(pushRoutes)
      await api.register(adminRoutes)
      await registerWebsocket(api)
    },
    { prefix: API_PREFIX },
  )

  return app
}
