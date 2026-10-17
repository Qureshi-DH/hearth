import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod"
import { z } from "zod"

import { AppError, notFound } from "../lib/errors"
import { AVATAR_PREFIX, getObject, storageEnabled } from "../services/storage"

/** The 128 random bits in the name are what stands in for a permission. */
const KEY_PATTERN = /^avatars\/[0-9a-f]{32}\.(jpg|png|webp)$/

/** One transparent pixel. */
const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
)

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
        description:
          "A picture that is no longer stored, because its owner replaced or removed it or " +
          "the server's storage was switched off, answers 200 with one transparent pixel, " +
          "`x-hearth-media: missing` and `cache-control: no-store`. Other phones keep the old " +
          "address until their roster refreshes, and a 404 for each would be a 4xx in " +
          "ordinary use. Storage that is failing answers 503, which no phone keeps. An " +
          "address the server could never have made is still a 404.",
        params: z.object({ "*": z.string().max(200) }),
      },
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const key = request.params["*"]
      if (!key.startsWith(AVATAR_PREFIX) || !KEY_PATTERN.test(key)) throw notFound()

      let object: Awaited<ReturnType<typeof getObject>> = null
      try {
        object = storageEnabled() ? await getObject(key) : null
      } catch (error) {
        // A 5xx, which a phone does not keep, rather than the blank, which it
        // would go on showing under this address once storage is back.
        request.log.warn({ err: error }, "image storage did not answer")
        throw new AppError(503, "storage_unavailable", "Image storage is not answering.")
      }
      if (!object) {
        return reply
          .header("content-type", "image/png")
          .header("x-hearth-media", "missing")
          .header("cache-control", "no-store")
          .send(EMPTY_PNG)
      }

      reply.header("content-type", object.contentType)
      if (object.contentLength) reply.header("content-length", String(object.contentLength))
      // The key changes whenever the image does, so this can never go stale.
      reply.header("cache-control", "public, max-age=31536000, immutable")
      return reply.send(object.body)
    },
  )
}
