import { sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"

import { buildApp } from "../app"
import { closeDb, getDb } from "../db/client"
import { runMigrations } from "../db/migrate"
import { loadConfig, resetConfig } from "../env"
import { createBus } from "../lib/bus"
import { resetRuntime, setRuntime } from "../runtime"
import { createPushDriver } from "../services/push"

/**
 * Boots the real Fastify app against a real Postgres and truncates every table
 * between specs. Nothing about the database layer is mocked. The geofence and
 * presence logic lives in SQL as much as in TypeScript, so stubbing it would
 * test nothing.
 */
export interface TestContext {
  app: FastifyInstance
  reset(): Promise<void>
  close(): Promise<void>
}

export async function startTestApp(): Promise<TestContext> {
  resetConfig()
  const databaseUrl =
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgres://hearth:hearth@localhost:55432/hearth"

  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    JWT_SECRET: "test-secret-test-secret-test-secret-test-secret",
    REGISTRATION_MODE: "open",
    PUSH_PROVIDER: "none",
    ENABLE_JOBS: "false",
    ENABLE_SWAGGER: "false",
    RATE_LIMIT_MAX: "100000",
  })

  await runMigrations()
  const bus = await createBus()
  setRuntime({ bus, pushDriver: createPushDriver(config) })

  const app = await buildApp()
  await app.ready()

  const db = getDb()

  return {
    app,
    async reset() {
      await db.execute(sql`
        truncate table
          audit_log, notification_outbox, trips, check_ins, sos_alerts, events,
          place_events, place_memberships, places, user_presence, location_points,
          invites, circle_members, circles, sessions, server_settings, users
        restart identity cascade
      `)
    },
    async close() {
      await app.close()
      await bus.close()
      await closeDb()
      resetRuntime()
      resetConfig()
    },
  }
}

export async function registerUser(
  app: FastifyInstance,
  overrides: { email?: string; displayName?: string; inviteCode?: string; deviceId?: string } = {},
) {
  const email = overrides.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password: "correct-horse-battery",
      displayName: overrides.displayName ?? email.split("@")[0],
      inviteCode: overrides.inviteCode,
      device: {
        deviceId: overrides.deviceId ?? `device-${Math.random().toString(36).slice(2, 12)}`,
        deviceName: "Test Phone",
        platform: "ios",
      },
    },
  })
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`)
  }
  const body = response.json() as {
    accessToken: string
    refreshToken: string
    user: { id: string; email: string; isAdmin: boolean }
  }
  return {
    ...body,
    email,
    headers: { authorization: `Bearer ${body.accessToken}` },
  }
}
