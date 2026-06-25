import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { notFound } from "../lib/errors"
import { AVATAR_PREFIX, getObject, storageEnabled } from "../services/storage"

/** The 128 random bits in the name are what stands in for a permission. */
const KEY_PATTERN = /^avatars\/[0-9a-f]{32}\.(jpg|png|webp)$/

/**
 * Serving objects through the API keeps the bucket off the public internet, so
 * a self-hoster needs one hostname and one certificate rather than exposing
 * MinIO alongside the app.
 *
 * This is the one read route with no token check. The app draws avatars with
 * an image view that sends no headers of its own, so asking for one here would
 * turn every face in the app into a broken image. Holding the key is the whole
 * permission, and what that costs is a removed member keeping a working link
 * to a face they had already loaded, until that person replaces the photo and
 * the old object is deleted. Making removal revoke instead means signing and
 * dating the link wherever a user is serialized, and teaching the client to go
 * back for a fresh one, so the trade is deliberate rather than forgotten.
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
