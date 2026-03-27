import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

/**
 * `promisify` cannot see scrypt's 4-argument overload, so the shape is stated
 * explicitly rather than sprinkling casts at every call site.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/**
 * Not argon2 or bcrypt. Both pull in native bindings, the most common reason a
 * self-hosted Node app fails to build on someone's NAS or Raspberry Pi. scrypt
 * is memory-hard, in-tree, and needs no toolchain.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLength: 64 } as const
const PREFIX = "scrypt"

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password.normalize("NFKC"), salt, PARAMS.keyLength, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 256 * 1024 * 1024,
  })
  return [
    PREFIX,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$")
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== PREFIX) return false

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4]!, "base64url")
  const expected = Buffer.from(parts[5]!, "base64url")
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false

  const derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  })

  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** Length beats complexity rules, so there is no character-class check. */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters."
  if (password.length > 512) return "Password must be at most 512 characters."
  const common = ["password", "12345678", "qwertyui", "letmein", "hearth123"]
  if (common.some((entry) => password.toLowerCase().includes(entry))) {
    return "Password is too easy to guess."
  }
  return null
}
