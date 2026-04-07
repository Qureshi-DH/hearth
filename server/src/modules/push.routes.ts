import { PUSH_PROVIDERS } from "@hearth/shared"
import { eq } from "drizzle-orm"
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { getDb } from "../db/client"
import { sessions } from "../db/schema"
import { getConfig } from "../env"
import { badRequest } from "../lib/errors"
import { sha256 } from "../lib/ids"
import { requireAuth } from "../plugins/auth"
import { enqueuePush } from "../services/push"

export const pushRoutes: FastifyPluginAsyncZod = async (app) => {
  const db = getDb()

  app.get(
    "/push/config",
    {
      schema: {
        tags: ["push"],
        summary: "How this server delivers notifications",
        description:
          "The app calls this before asking for notification permission, so it knows which " +
          "transport to set up (or that it should not ask at all).",
      },
    },
    async () => {
      const config = getConfig()
      return {
        provider: config.PUSH_PROVIDER,
        webPushPublicKey: config.PUSH_PROVIDER === "webpush" ? config.VAPID_PUBLIC_KEY : null,
        ntfyBaseUrl: config.PUSH_PROVIDER === "ntfy" ? config.NTFY_BASE_URL : null,
      }
    },
  )

  app.post(
    "/push/register",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["push"],
        summary: "Register this device for notifications",
        description:
          "The token is stored against the current session, so signing the device out also " +
          "stops its notifications. For ntfy the server derives a per-device topic instead of " +
          "trusting a client-supplied one.",
        body: z.object({
          provider: z.enum(PUSH_PROVIDERS),
          token: z.string().min(1).max(4096).optional(),
        }),
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const config = getConfig()

      if (request.body.provider !== config.PUSH_PROVIDER) {
        throw badRequest(
          `This server delivers push via "${config.PUSH_PROVIDER}", not "${request.body.provider}".`,
        )
      }

      let token = request.body.token ?? null

      if (config.PUSH_PROVIDER === "ntfy") {
        // Anyone who knows an ntfy topic can read it, and a client-chosen name
        // would be guessable.
        token = `${config.NTFY_TOPIC_PREFIX}-${sha256(`${config.jwtSecret}:${auth.sessionId}`).slice(0, 32)}`
      } else if (!token) {
        throw badRequest("A push token is required for this provider.")
      }

      await db
        .update(sessions)
        .set({ pushProvider: request.body.provider, pushToken: token })
        .where(eq(sessions.id, auth.sessionId))

      return {
        ok: true,
        provider: request.body.provider,
        ntfyTopic: config.PUSH_PROVIDER === "ntfy" ? token : null,
        ntfyBaseUrl: config.PUSH_PROVIDER === "ntfy" ? config.NTFY_BASE_URL : null,
      }
    },
  )

  app.delete(
    "/push/register",
    {
      preHandler: app.authenticate,
      schema: { tags: ["push"], summary: "Turn off notifications for this device" },
    },
    async (request) => {
      const auth = requireAuth(request)
      await db
        .update(sessions)
        .set({ pushProvider: null, pushToken: null })
        .where(eq(sessions.id, auth.sessionId))
      return { ok: true }
    },
  )

  app.post(
    "/push/test",
    {
      preHandler: app.authenticate,
      schema: {
        tags: ["push"],
        summary: "Send yourself a test notification",
        description: "Queued like any other notification, so it exercises the real path.",
      },
      config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
    },
    async (request) => {
      const auth = requireAuth(request)
      await enqueuePush(db, [
        {
          userId: auth.userId,
          title: "Hearth",
          body: "Notifications are working.",
          channel: "default",
          data: { type: "test" },
        },
      ])
      return { ok: true, queued: true }
    },
  )
}
