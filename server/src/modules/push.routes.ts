import { lookup } from "node:dns/promises"

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
        // would be guessable. Keyed to the account and the phone rather than
        // the session, so signing in again does not move the topic out from
        // under the ntfy app that is subscribed to it.
        const [session] = await db
          .select({ deviceId: sessions.deviceId })
          .from(sessions)
          .where(eq(sessions.id, auth.sessionId))
          .limit(1)
        const device = session?.deviceId ?? auth.sessionId
        token = `${config.NTFY_TOPIC_PREFIX}-${sha256(`${config.jwtSecret}:${auth.userId}:${device}`).slice(0, 32)}`
      } else if (!token) {
        throw badRequest("A push token is required for this provider.")
      } else if (config.PUSH_PROVIDER === "webpush") {
        await assertReachableSubscription(token)
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

/**
 * A stored web push subscription becomes an outbound request from the server,
 * so an unchecked endpoint turns any signed-in member into a probe of whatever
 * the host can reach. On a home LAN that is the router, the NAS and everything
 * else on the compose network.
 */
async function assertReachableSubscription(token: string): Promise<void> {
  let subscription: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  let endpoint: URL
  try {
    subscription = JSON.parse(token)
    endpoint = new URL(String(subscription.endpoint))
  } catch {
    throw badRequest("That is not a valid web push subscription.")
  }

  if (endpoint.protocol !== "https:") {
    throw badRequest("A web push endpoint must be an https URL.")
  }
  if (typeof subscription.keys?.p256dh !== "string" || typeof subscription.keys.auth !== "string") {
    throw badRequest("That web push subscription is missing its keys.")
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(endpoint.hostname, { all: true })
  } catch {
    throw badRequest("That web push endpoint does not resolve.")
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw badRequest("That web push endpoint is not a public address.")
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^::ffff:/, "")
  const octets = value.split(".").map(Number)
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet))) {
    const [first = -1, second = -1] = octets
    if (first === 0 || first === 10 || first === 127) return true
    if (first === 169 && second === 254) return true
    if (first === 172 && second >= 16 && second <= 31) return true
    if (first === 192 && second === 168) return true
    if (first === 100 && second >= 64 && second <= 127) return true
    return false
  }
  if (value === "::" || value === "::1") return true
  // Unique local (fc00::/7) and link local (fe80::/10).
  return /^f[cd]/.test(value) || /^fe[89ab]/.test(value)
}
