import { sql } from "drizzle-orm"
import type { FastifyInstance } from "fastify"

import { buildApp } from "../app"
import { closeDb, getDb } from "../db/client"
import { runMigrations } from "../db/migrate"
import { loadConfig, resetConfig } from "../env"
import { createBus } from "../lib/bus"
import { resetRuntime, setRuntime } from "../runtime"
import { forgetSettledDays } from "../services/admin-overview"
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
      forgetSettledDays()
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

/**
 * The phone has said nothing since its last fix. An upload marks the phone
 * as heard whatever it carried, so a test that stages a dead phone by
 * uploading an old fix has to take the upload itself back to when the fix
 * was taken.
 */
export async function silentSinceLastFix(userId: string): Promise<void> {
  await getDb().execute(
    sql`update user_presence set last_heard_at = recorded_at where user_id = ${userId}::uuid`,
  )
}

/** The session claim a token carries, read without verifying it. */
export const sessionIdOf = (accessToken: string): string => {
  const [, claims] = accessToken.split(".")
  return (JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as { sid: string }).sid
}

type Headers = Record<string, string>

export async function createCircle(app: FastifyInstance, headers: Headers, name = "Family") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/circles",
    headers,
    payload: { name, emoji: "🏠" },
  })
  if (response.statusCode !== 201) throw new Error(`create circle: ${response.body}`)
  return response.json() as { id: string; invite: { code: string } }
}

export async function joinCircle(app: FastifyInstance, headers: Headers, code: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/invites/${code}/accept`,
    headers,
  })
  if (response.statusCode !== 200) throw new Error(`join circle: ${response.body}`)
}

export async function createPlace(
  app: FastifyInstance,
  headers: Headers,
  circleId: string,
  place: { name: string; lat: number; lon: number; radiusMeters?: number },
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/places`,
    headers,
    payload: { icon: "home", radiusMeters: 150, ...place },
  })
  if (response.statusCode !== 201) throw new Error(`create place: ${response.body}`)
  return response.json() as { id: string }
}

export interface Fix {
  lat: number
  lon: number
  recordedAt: string
  accuracyMeters?: number
  speedMps?: number
  batteryLevel?: number
  isCharging?: boolean
}

export async function uploadFixes(app: FastifyInstance, headers: Headers, points: Fix[]) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/locations/batch",
    headers,
    payload: { points },
  })
  if (response.statusCode !== 200) throw new Error(`upload: ${response.body}`)
  return response.json() as { accepted: number; placeEvents: number }
}

export async function setSharing(
  app: FastifyInstance,
  headers: Headers,
  circleId: string,
  sharingState: "precise" | "approximate" | "paused",
) {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/circles/${circleId}/sharing`,
    headers,
    payload: { sharingState },
  })
  if (response.statusCode !== 200) throw new Error(`sharing: ${response.body}`)
}

export async function checkIn(
  app: FastifyInstance,
  headers: Headers,
  circleId: string,
  at: { lat: number; lon: number },
  note?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/circles/${circleId}/check-in`,
    headers,
    payload: { lat: at.lat, lon: at.lon, note: note ?? null },
  })
  if (response.statusCode !== 201) throw new Error(`check-in: ${response.body}`)
}

/** A signed-in phone that has accepted notifications through Expo. */
export async function enablePush(userId: string, token: string) {
  await getDb().execute(
    sql`update sessions set push_provider = 'expo', push_token = ${token}
        where user_id = ${userId}::uuid`,
  )
}

/**
 * Setting a scenario up queues "someone joined the circle" notifications,
 * which a test about some other notification is better off without.
 */
export async function clearOutbox() {
  await getDb().execute(sql`delete from notification_outbox`)
}
