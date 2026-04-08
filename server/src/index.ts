import { sql } from "drizzle-orm"

import { buildApp } from "./app"
import { closeDb, getDb } from "./db/client"
import { runMigrations } from "./db/migrate"
import { users } from "./db/schema"
import { loadConfig } from "./env"
import { startScheduler } from "./jobs/scheduler"
import { createBus } from "./lib/bus"
import { avatarColorFor, normalizeEmail } from "./lib/ids"
import { hashPassword } from "./lib/password"
import { setRuntime } from "./runtime"
import { createPushDriver } from "./services/push"

/**
 * Only ever runs against an empty user table, so restarting a live server with
 * ADMIN_EMAIL still set cannot resurrect or overwrite an account.
 */
async function bootstrapAdmin(email: string, password: string): Promise<boolean> {
  const db = getDb()
  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
  if (count > 0) return false

  const normalized = normalizeEmail(email)
  await db.insert(users).values({
    email: email.trim(),
    emailNormalized: normalized,
    passwordHash: await hashPassword(password),
    displayName: email.split("@")[0] ?? "Admin",
    avatarColor: avatarColorFor(normalized),
    isAdmin: true,
  })
  return true
}

async function main(): Promise<void> {
  const config = loadConfig()

  if (config.MIGRATE_ON_START) {
    await runMigrations()
  }

  const [bus, pushDriver] = await Promise.all([
    createBus(config.REDIS_URL),
    Promise.resolve(createPushDriver(config)),
  ])
  setRuntime({ bus, pushDriver })

  const app = await buildApp()

  if (config.ADMIN_EMAIL && config.ADMIN_PASSWORD) {
    const created = await bootstrapAdmin(config.ADMIN_EMAIL, config.ADMIN_PASSWORD)
    if (created) {
      app.log.info({ email: config.ADMIN_EMAIL }, "created bootstrap administrator")
    }
  }

  const scheduler = config.ENABLE_JOBS ? startScheduler(getDb(), config, app.log) : { stop() {} }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info({ signal }, "shutting down")
    scheduler.stop()
    try {
      await app.close()
      await bus.close()
      await closeDb()
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown")
    }
    process.exit(0)
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "unhandled promise rejection")
  })

  await app.listen({ host: config.HOST, port: config.PORT })

  app.log.info(
    {
      url: config.PUBLIC_URL,
      docs: config.ENABLE_SWAGGER ? `${config.PUBLIC_URL}/docs` : null,
      push: config.PUSH_PROVIDER,
      realtime: bus.kind,
      registration: config.REGISTRATION_MODE,
    },
    "Hearth is listening",
  )
}

main().catch((error: unknown) => {
  console.error("Failed to start Hearth:", error)
  process.exit(1)
})
