import { randomBytes } from "node:crypto"

import { PUSH_PROVIDERS, REGISTRATION_MODES } from "@hearth/shared"
import { z } from "zod"

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

const bool = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean" ? value : ["1", "true", "yes", "on"].includes(value.toLowerCase()),
  )

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /**
   * "::" binds dual-stack. "0.0.0.0" listens on IPv4 only, and macOS/iOS
   * resolve "localhost" to ::1 first, so a simulator pointed at
   * http://localhost:4000 gets ECONNREFUSED while curl works.
   */
  HOST: z.string().default("::"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** The address phones reach. Invite links, the join page and the API docs all quote it. */
  PUBLIC_URL: z.string().default("http://localhost:4000"),
  /** Deep-link scheme registered by the mobile app. */
  APP_SCHEME: z.string().default("hearth"),
  SERVER_NAME: z.string().default("Hearth"),
  TRUST_PROXY: bool.default(false),
  /** Comma-separated allowlist. Empty blocks every browser origin, which native clients never need. */
  CORS_ORIGINS: z.string().optional(),

  DATABASE_URL: z.string(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  MIGRATE_ON_START: bool.default(true),

  /** Only needed for realtime fan-out across several instances. */
  REDIS_URL: z.string().optional(),

  JWT_SECRET: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(60),

  REGISTRATION_MODE: z.enum(REGISTRATION_MODES).default("invite"),
  /**
   * The one account that exists on first boot. Required in production: with
   * invite or closed registration nobody could get in without it, and with
   * open registration the first stranger to sign up would become the admin.
   */
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  /** Defaults to the part of ADMIN_EMAIL before the @. */
  ADMIN_NAME: z.string().trim().min(1).max(80).optional(),

  PUSH_PROVIDER: z.enum(PUSH_PROVIDERS).default("none"),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /** Public ntfy URL, as phones subscribe to it. */
  NTFY_BASE_URL: z.string().optional(),
  /** Optional in-network URL the server publishes to (e.g. http://ntfy:80 in compose). */
  NTFY_INTERNAL_URL: z.string().optional(),
  NTFY_TOKEN: z.string().optional(),
  NTFY_TOPIC_PREFIX: z.string().default("hearth"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

  /**
   * S3 compatible object storage for avatars. MinIO is what the compose stack
   * runs, but any S3 works. Leave S3_ENDPOINT empty and uploads stay off, in
   * which case avatars fall back to initials on a colour.
   */
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("hearth"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  /** MinIO serves buckets as a path, not a subdomain. */
  S3_FORCE_PATH_STYLE: bool.default(true),

  MAP_STYLE_URL: z.string().default("https://tiles.openfreemap.org/styles/liberty"),
  MAP_STYLE_URL_DARK: z.string().default("https://tiles.openfreemap.org/styles/dark"),
  MAP_ATTRIBUTION: z.string().default("© OpenStreetMap contributors"),

  /** Hard ceiling applied on top of each circle's own retention setting. */
  MAX_HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),

  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  JOB_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  ENABLE_JOBS: bool.default(true),
  ENABLE_SWAGGER: bool.default(true),
})

export type RawEnv = z.infer<typeof schema>

export interface AppConfig extends RawEnv {
  jwtSecret: string
  corsOrigins: string[]
  isProduction: boolean
  isTest: boolean
}

let cached: AppConfig | null = null

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // `ADMIN_NAME=` in a .env file, or an empty compose variable, means "not
  // set". Parsed as an empty string it fails validation and the server never
  // boots, which is the first thing a new self-hoster would meet.
  const parsed = schema.safeParse(
    Object.fromEntries(Object.entries(source).filter(([, value]) => value !== "")),
  )
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    throw new Error(`Invalid configuration:\n${issues}\n\nSee .env.example for the full list.`)
  }

  const env = parsed.data
  const isProduction = env.NODE_ENV === "production"

  let jwtSecret = env.JWT_SECRET
  if (!jwtSecret || jwtSecret.length < 32) {
    if (isProduction) {
      throw new Error(
        "JWT_SECRET must be set to at least 32 characters in production. " +
          "Generate one with: openssl rand -base64 48",
      )
    }
    // An ephemeral secret keeps `pnpm dev` zero-config. Every restart
    // invalidates the tokens issued before it.
    jwtSecret = randomBytes(48).toString("base64url")
  }

  if (isProduction && (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD)) {
    throw new Error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must both be set in production. They create the " +
        "account that exists on first boot. Without them the server starts with no users, " +
        "and either nobody can get in or, with open registration, the first stranger to " +
        "sign up becomes the administrator.",
    )
  }

  if (env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length < 10) {
    throw new Error("ADMIN_PASSWORD must be at least 10 characters.")
  }

  if (env.PUSH_PROVIDER === "webpush" && (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY)) {
    throw new Error(
      "PUSH_PROVIDER=webpush requires VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY. " +
        "Generate a pair with: pnpm --filter @hearth/server exec npx web-push generate-vapid-keys",
    )
  }
  if (env.PUSH_PROVIDER === "ntfy" && !env.NTFY_BASE_URL) {
    throw new Error("PUSH_PROVIDER=ntfy requires NTFY_BASE_URL (e.g. https://ntfy.example.com).")
  }

  cached = {
    ...env,
    jwtSecret,
    corsOrigins: csv(env.CORS_ORIGINS),
    isProduction,
    isTest: env.NODE_ENV === "test",
  }
  return cached
}

export function getConfig(): AppConfig {
  if (!cached) return loadConfig()
  return cached
}

export function resetConfig(): void {
  cached = null
}
