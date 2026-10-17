import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import type { Database } from "../db/client"
import { circles, events, sessions, sosAlerts, users } from "../db/schema"

/*
 * The parts of GET /me/export a person reads rather than a program. Circles
 * and people go by name, times are ISO, and the ids that only mean something
 * inside the database are left out.
 */

const FEED_PAGE_SIZE = 5_000

const iso = (value: Date | null) => value?.toISOString() ?? null

export async function exportSosAlerts(db: Database, userId: string) {
  const resolver = alias(users, "resolver")
  const rows = await db
    .select({
      circle: circles.name,
      note: sosAlerts.note,
      startedAt: sosAlerts.startedAt,
      resolvedAt: sosAlerts.resolvedAt,
      resolvedBy: resolver.displayName,
    })
    .from(sosAlerts)
    .innerJoin(circles, eq(circles.id, sosAlerts.circleId))
    .leftJoin(resolver, eq(resolver.id, sosAlerts.resolvedBy))
    .where(eq(sosAlerts.userId, userId))
    .orderBy(desc(sosAlerts.startedAt))

  return rows.map((row) => ({
    circle: row.circle,
    note: row.note,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    resolvedBy: row.resolvedBy ?? null,
  }))
}

/**
 * Every session the server still holds, signed out ones too until they are
 * pruned, with the address and browser string each was used from. The
 * refresh token's hash and the push token stay behind, since they are keys
 * rather than facts about the person.
 */
export async function exportDevices(db: Database, userId: string, currentSessionId: string) {
  const rows = await db
    .select({
      id: sessions.id,
      deviceName: sessions.deviceName,
      platform: sessions.platform,
      appVersion: sessions.appVersion,
      osVersion: sessions.osVersion,
      pushProvider: sessions.pushProvider,
      hasPushToken: sql<boolean>`${sessions.pushToken} is not null`,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))

  return rows.map((row) => ({
    device: row.deviceName,
    platform: row.platform,
    appVersion: row.appVersion,
    osVersion: row.osVersion,
    thisDevice: row.id === currentSessionId,
    notifications: row.hasPushToken ? row.pushProvider : null,
    ipAddress: row.ip,
    userAgent: row.userAgent,
    signedInAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    expiresAt: row.expiresAt.toISOString(),
    signedOutAt: iso(row.revokedAt),
  }))
}

/**
 * What the person did, and what others did to or for them, such as a role
 * change, a removal, a nudge sent to them or an SOS of theirs being resolved.
 */
function aboutUser(userId: string) {
  return or(
    eq(events.actorUserId, userId),
    sql`${events.payload} ->> 'userId' = ${userId}`,
    sql`${events.payload} ->> 'targetUserId' = ${userId}`,
    sql`${events.payload} ->> 'alertId' in (
      select id::text from ${sosAlerts} where ${sosAlerts.userId} = ${userId}::uuid
    )`,
  )
}

/** Paged, since a feed is never pruned and years of arrivals add up. */
export async function* exportActivityFeed(db: Database, userId: string) {
  let before: number | null = null
  for (;;) {
    const page = await db
      .select({
        id: events.id,
        circle: circles.name,
        type: events.type,
        summary: events.summary,
        payload: events.payload,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .innerJoin(circles, eq(circles.id, events.circleId))
      .where(before === null ? aboutUser(userId) : and(aboutUser(userId), lt(events.id, before)))
      .orderBy(desc(events.id))
      .limit(FEED_PAGE_SIZE)

    if (page.length > 0) {
      yield page.map((row) => ({
        occurredAt: row.occurredAt.toISOString(),
        circle: row.circle,
        type: row.type,
        summary: row.summary,
        details: Object.fromEntries(
          Object.entries(row.payload).filter(([key]) => !/(^id|Id)$/.test(key)),
        ),
      }))
    }
    if (page.length < FEED_PAGE_SIZE) return
    before = page[page.length - 1]!.id
  }
}
