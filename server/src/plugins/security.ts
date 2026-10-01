import cors from "@fastify/cors"
import helmet from "@fastify/helmet"
import rateLimit from "@fastify/rate-limit"
import type { FastifyInstance } from "fastify"
import fp from "fastify-plugin"

import { getConfig } from "../env"
import { rateLimitKey } from "./auth"

export const securityPlugin = fp(async (app: FastifyInstance) => {
  const config = getConfig()

  await app.register(helmet, {
    // The API serves JSON and the Swagger UI. A strict CSP would break the UI.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })

  await app.register(cors, {
    // Native clients send no Origin header and need no CORS, so the default
    // grants nothing and a web client opts in through CORS_ORIGINS. The API
    // takes a bearer token. The one cookie, the admin portal's, is only sent
    // to its own origin, so credentialed cross-origin requests never apply.
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: false,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  })

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Authenticated callers are bucketed per account, so one chatty phone on a
    // shared NAT cannot rate-limit the rest of the family. The limiter runs in
    // onRequest, before authenticate, hence the self-contained token decode.
    keyGenerator: (request) => rateLimitKey(app, request),
    allowList: (request) => request.url === "/healthz" || request.url === "/readyz",
  })
})
