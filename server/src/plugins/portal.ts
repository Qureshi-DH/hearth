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
 * The page names its own base, which is what lets it work under a path, and
 * 'self' keeps an injected base from pointing anywhere else.
 */
export const PORTAL_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
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
 * Serves the portal's files, and hands back the page for any other browser
 * route, so a bookmark to /accounts opens the portal there. Everything is
 * revalidated rather than cached. The whole portal is a few files, and an
 * upgrade shows at the next load. The build leaves gzip and brotli copies
 * beside each file, served to a browser that takes them.
 *
 * The page is the one file written here rather than sent as built. It names
 * its files relative to a base the server fills in, so the same build works
 * at the root of a domain and under a path.
 */
export async function registerPortal(
  app: FastifyInstance,
  dir: string,
  base: string,
): Promise<Portal> {
  await app.register(fastifyStatic, {
    root: dir,
    prefix: "/",
    wildcard: false,
    index: false,
    globIgnore: ["index.html", "index.html.*"],
    preCompressed: true,
    cacheControl: false,
    setHeaders(reply) {
      reply.header("cache-control", "no-cache")
    },
  })

  // Read once. An upgrade is a restart, and the page itself is a shell that
  // names the two files beside it.
  const page = withBase(await readFile(resolve(dir, "index.html"), "utf8"), base)
  const send = (reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-cache")
      .header("content-security-policy", PORTAL_POLICY)
      .send(page)

  for (const url of ["/", "/index.html"]) {
    app.get(url, { schema: { hide: true } }, (_request, reply) => send(reply))
  }

  return {
    wants(request) {
      if (request.method !== "GET") return false
      const path = request.url.split("?")[0] ?? "/"
      if (path.startsWith("/api/") || extname(path) !== "") return false
      return request.headers.accept?.includes("text/html") ?? false
    },
    send,
  }
}

/**
 * The base goes first in the head, before anything that names a file. The
 * meta carries it to the script, since the page's policy allows no inline
 * script to set it.
 */
function withBase(page: string, base: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(page)
  if (!head) throw new Error("The admin portal's index.html has no <head> to put its base in.")
  const value = escapeAttribute(base)
  const at = head.index + head[0].length
  return `${page.slice(0, at)}<base href="${value}/" /><meta name="hearth-base" content="${value}" />${page.slice(at)}`
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
