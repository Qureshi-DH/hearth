import { createHash, randomBytes, randomUUID } from "node:crypto"

import { AVATAR_COLORS } from "@hearth/shared"

/**
 * Crockford base32 without I, L, O and U. It stays unambiguous when a parent
 * reads an invite code aloud, and cannot accidentally spell anything rude.
 */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export const newId = (): string => randomUUID()

/** Rejection sampling, so the code is uniform rather than modulo-biased. */
export function inviteCode(length = 8): string {
  const out: string[] = []
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 256 - (256 % CODE_ALPHABET.length)) continue
      out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!)
      if (out.length === length) break
    }
  }
  return out.join("")
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url")

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex")

/** Stable per-user colour so avatars stay recognisable across devices. */
export function avatarColorFor(seed: string): string {
  const digest = createHash("sha256").update(seed).digest()
  return AVATAR_COLORS[digest[0]! % AVATAR_COLORS.length]!
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase()
