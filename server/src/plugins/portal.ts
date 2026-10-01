import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import fastifyStatic from "@fastify/static"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

/**
 * The admin portal talks to this server and nothing else, so its policy
 * allows 'self' and nothing more. A script that somehow got into the page
 * could neither load more of itself from elsewhere nor send anything out.
 */
export const PORTAL_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

export interface Portal {
  /** Whether a request that matched no route is a browser asking for a portal page. */
  wants(request: FastifyRequest): boolean
  send(reply: FastifyReply): FastifyReply
}

/**
 * Where the built portal is: named in the environment, beside the bundled
 * server as the image lays it out, or in the workspace for a server run
 * from source. Null when it has not been built.
 */
export function findPortalDir(explicit?: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = explicit
    ? [explicit]
    : [
        resolve(here, "admin"),
        resolve(here, "../../apps/admin/dist"),
        resolve(here, "../../../apps/admin/dist"),
      ]
  return candidates.find((dir) => existsSync(resolve(dir, "index.html"))) ?? null
}

/**
 * Serves the portal's files at the root, and hands back the page for any
 * other browser route, so a bookmark to /accounts opens the portal there.
 * Everything is revalidated rather than cached: the whole portal is a few
 * files, and an upgrade shows at the next load. The build leaves gzip and
 * brotli copies beside each file, served to a browser that takes them.
 */
export async function registerPortal(app: FastifyInstance, dir: string): Promise<Portal> {
  await app.register(fastifyStatic, {
    root: dir,
    prefix: "/",
    wildcard: false,
    index: ["index.html"],
    preCompressed: true,
    cacheControl: false,
    setHeaders(reply, path) {
      reply.header("cache-control", "no-cache")
      // The path is the file actually sent, which for most browsers is the
      // compressed copy, so the page's policy has to find that one too.
      if (/\.html(?:\.(?:br|gz))?$/.test(path)) {
        reply.header("content-security-policy", PORTAL_POLICY)
      }
    },
  })

  // Read once. An upgrade is a restart, and the page itself is a shell that
  // names the two files beside it.
  const page = await readFile(resolve(dir, "index.html"))
  return {
    wants(request) {
      if (request.method !== "GET") return false
      const path = request.url.split("?")[0] ?? "/"
      if (path.startsWith("/api/") || extname(path) !== "") return false
      return request.headers.accept?.includes("text/html") ?? false
    },
    send(reply) {
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-cache")
        .header("content-security-policy", PORTAL_POLICY)
        .send(page)
    },
  }
}
