import { createHmac, timingSafeEqual } from "node:crypto"

import { getConfig } from "../env"

/**
 * What an Android phone's native tracker uploads with. Android runs no
 * JavaScript timer for an app in the background, so a wake or a Live
 * request answered natively cannot wait for JavaScript to refresh an access
 * token. The key names its session and is signed by the server, so it lives
 * exactly as long as the session, is worth nothing once the session is
 * revoked, and opens the upload route and no other.
 */
const PREFIX = "hk1."
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function sign(sessionId: string): string {
  const key = createHmac("sha256", getConfig().jwtSecret).update("hearth upload key").digest()
  return createHmac("sha256", key).update(sessionId).digest("base64url")
}

export function uploadKeyFor(sessionId: string): string {
  return `${PREFIX}${sessionId}.${sign(sessionId)}`
}

export function isUploadKey(token: string): boolean {
  return token.startsWith(PREFIX)
}

/** The session a key was signed for, or null for anything the server did not sign. */
export function sessionOfUploadKey(token: string): string | null {
  if (!isUploadKey(token)) return null
  const rest = token.slice(PREFIX.length)
  const dot = rest.indexOf(".")
  const sessionId = rest.slice(0, dot)
  if (dot < 0 || !SESSION_ID.test(sessionId)) return null
  const given = Buffer.from(rest.slice(dot + 1))
  const expected = Buffer.from(sign(sessionId))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return sessionId
}

/** Only the Android app answers natively, so nothing else is handed a key. */
export function uploadKeyField(platform: string | null | undefined, sessionId: string) {
  return platform === "android" ? { uploadKey: uploadKeyFor(sessionId) } : {}
}
