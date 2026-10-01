import type { FastifyRequest } from "fastify"

/** One cookie the browser sent, or null. */
export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1 || part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

export interface CookieOptions {
  path: string
  secure: boolean
  /** Zero clears the cookie. Absent, it lasts until the browser closes. */
  maxAgeSeconds?: number
}

/**
 * Always HttpOnly and SameSite=Strict: the only cookie this server sets holds
 * a session, and neither the page's own script nor another site may use it.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    "HttpOnly",
    "SameSite=Strict",
  ]
  if (options.secure) parts.push("Secure")
  if (options.maxAgeSeconds != null) parts.push(`Max-Age=${options.maxAgeSeconds}`)
  return parts.join("; ")
}
