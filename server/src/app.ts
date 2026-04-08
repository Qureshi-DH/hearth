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
import { AppError } from "./lib/errors"
import { loggerOptions } from "./logger"
import { adminRoutes } from "./modules/admin.routes"
import { authRoutes } from "./modules/auth.routes"
import { circleRoutes } from "./modules/circles.routes"
import { eventRoutes } from "./modules/events.routes"
import { locationRoutes } from "./modules/locations.routes"
import { messageRoutes } from "./modules/messages.routes"
import { placeRoutes } from "./modules/places.routes"
import { pushRoutes } from "./modules/push.routes"
import { safetyRoutes } from "./modules/safety.routes"
import { healthRoutes, joinRoutes, systemRoutes } from "./modules/system.routes"
import { tripRoutes } from "./modules/trips.routes"
import { registerWebsocket } from "./modules/ws.routes"
import { authPlugin } from "./plugins/auth"
import { securityPlugin } from "./plugins/security"

const VERSION = process.env.npm_package_version ?? "0.1.0"

export async function buildApp(): Promise<FastifyInstance> {
  const config = getConfig()

  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: config.TRUST_PROXY,
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
          { name: "messages", description: "Short notes between members" },
          { name: "safety", description: "SOS, check-ins and nudges" },
          { name: "trips", description: "Journeys derived from history" },
          { name: "push", description: "Notification transport registration" },
          { name: "admin", description: "Server administration" },
        ],
      },
      transform: jsonSchemaTransform,
    })

    await app.register(swaggerUi.default, {
      routePrefix: "/docs",
      uiConfig: { docExpansion: "list", deepLinking: true },
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

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: "not_found", message: `No route for ${request.method} ${request.url}.` },
    }),
  )

  await app.register(healthRoutes)
  await app.register(joinRoutes)

  await app.register(
    async (api) => {
      await api.register(systemRoutes)
      await api.register(authRoutes)
      await api.register(circleRoutes)
      await api.register(locationRoutes)
      await api.register(placeRoutes)
      await api.register(eventRoutes)
      await api.register(messageRoutes)
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
