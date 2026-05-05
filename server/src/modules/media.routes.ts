import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { notFound } from "../lib/errors"
import { AVATAR_PREFIX, getObject, storageEnabled } from "../services/storage"

/** Random keys, so possessing the URL is the permission. */
const KEY_PATTERN = /^avatars\/[0-9a-f]{32}\.(jpg|png|webp)$/

/**
 * Serving objects through the API keeps the bucket off the public internet, so
 * a self-hoster needs one hostname and one certificate rather than exposing
 * MinIO alongside the app.
 */
export const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/media/*",
    {
      schema: {
        tags: ["system"],
        summary: "Fetch a stored image",
        params: z.object({ "*": z.string().max(200) }),
      },
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const key = request.params["*"]
      if (!storageEnabled() || !key.startsWith(AVATAR_PREFIX) || !KEY_PATTERN.test(key)) {
        throw notFound()
      }

      const object = await getObject(key)
      if (!object) throw notFound()

      reply.header("content-type", object.contentType)
      if (object.contentLength) reply.header("content-length", String(object.contentLength))
      // The key changes whenever the image does, so this can never go stale.
      reply.header("cache-control", "public, max-age=31536000, immutable")
      return reply.send(object.body)
    },
  )
}
