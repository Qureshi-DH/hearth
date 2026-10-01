import type {
  AdminAuditEntry,
  AdminCircleSummary,
  AdminOutboxEntry,
  AdminStats,
  AdminUserSummary,
  CircleRole,
} from "@hearth/shared"
import { desc, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import {
  auditLog,
  circleMembers,
  circles,
  notificationOutbox,
  places,
  sessions,
  users,
} from "../db/schema"
import { getConfig } from "../env"
import {
  toAdminAuditEntry,
  toAdminCircleSummary,
  toAdminOutboxEntry,
  toAdminUserSummary,
} from "../lib/serialize"
import { uptimeSeconds } from "../runtime"
import { VERSION } from "../modules/system.routes"

/**
 * Below this many fixes the table is counted. Above it the planner's own
 * estimate stands in, because an exact count reads every row and the
 * dashboard asks for it every minute.
 */
const EXACT_COUNT_BELOW = 1_000_000

export async function serverStats(db: Database): Promise<AdminStats> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [
    [userCount],
    [activeCount],
    [circleCount],
    [placeCount],
    pointCount,
    oldest,
    [queueDepth],
    dbSize,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(users),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(sql`${users.lastSeenAt} >= ${dayAgo.toISOString()}::timestamptz`),
    db.select({ count: sql<number>`count(*)::int` }).from(circles),
    db.select({ count: sql<number>`count(*)::int` }).from(places),
    locationPointCount(db),
    oldestPointAt(db),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.status, "pending")),
    databaseSizeBytes(db),
  ])

  return {
    users: userCount?.count ?? 0,
    activeUsers24h: activeCount?.count ?? 0,
    circles: circleCount?.count ?? 0,
    places: placeCount?.count ?? 0,
    locationPoints: pointCount,
    oldestPointAt: oldest,
    pushQueueDepth: queueDepth?.count ?? 0,
    databaseSizeBytes: dbSize,
    uptimeSeconds: uptimeSeconds(),
    pushProvider: getConfig().PUSH_PROVIDER,
    version: VERSION,
  }
}

async function locationPointCount(db: Database): Promise<number> {
  const [estimate] = (await db.execute(
    sql`select reltuples::bigint as rows from pg_class where oid = 'location_points'::regclass`,
  )) as unknown as Array<{ rows: string | number }>
  const rows = Number(estimate?.rows ?? -1)
  if (rows >= EXACT_COUNT_BELOW) return rows
  const [exact] = (await db.execute(
    sql`select count(*)::int as rows from location_points`,
  )) as unknown as Array<{ rows: number }>
  return exact?.rows ?? 0
}

/**
 * Per account, so each answer comes off the (user_id, recorded_at) index from
 * one entry. Over the whole table min() has nothing to lead with and reads
 * every fix the server holds.
 */
async function oldestPointAt(db: Database): Promise<string | null> {
  const rows = (await db.execute(sql`
    select min(p.oldest) as oldest
    from users u
    cross join lateral (
      select min(lp.recorded_at) as oldest from location_points lp where lp.user_id = u.id
    ) p
  `)) as unknown as { oldest: Date | string | null }[]
  const raw = rows[0]?.oldest
  return raw ? new Date(raw).toISOString() : null
}

/** Some managed Postgres roles are not allowed to read the database size. */
async function databaseSizeBytes(db: Database): Promise<number | null> {
  try {
    const rows = (await db.execute(
      sql`select pg_database_size(current_database())::bigint as size`,
    )) as unknown as { size: string | number }[]
    const raw = rows[0]?.size
    return raw == null ? null : Number(raw)
  } catch {
    return null
  }
}

export async function listAccounts(
  db: Database,
  options: { query?: string; limit: number },
): Promise<AdminUserSummary[]> {
  const like = options.query ? `%${options.query.toLowerCase()}%` : null
  const rows = await db
    .select()
    .from(users)
    .where(
      like
        ? sql`${users.emailNormalized} like ${like} or lower(${users.displayName}) like ${like}`
        : undefined,
    )
    .orderBy(desc(users.createdAt))
    .limit(options.limit)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)

  const [circleCounts, deviceCounts, silences] = await Promise.all([
    db
      .select({ userId: circleMembers.userId, count: sql<number>`count(*)::int` })
      .from(circleMembers)
      .where(inArray(circleMembers.userId, ids))
      .groupBy(circleMembers.userId),
    db
      .select({ userId: sessions.userId, count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(sql`${inArray(sessions.userId, ids)} and ${sessions.revokedAt} is null`)
      .groupBy(sessions.userId),
    longestSilences(db, ids),
  ])
  const circlesOf = new Map(circleCounts.map((row) => [row.userId, row.count]))
  const devicesOf = new Map(deviceCounts.map((row) => [row.userId, row.count]))

  return rows.map((row) =>
    toAdminUserSummary(row, {
      circleCount: circlesOf.get(row.id) ?? 0,
      deviceCount: devicesOf.get(row.id) ?? 0,
      longestSilenceSeconds: silences.get(row.id) ?? null,
    }),
  )
}

/**
 * Gaps between consecutive fixes over the last day, and the gap still open
 * since the last one, so a phone that went quiet reads as such before the
 * sweep says so. Account by account, each a range over the
 * (user_id, recorded_at) index, rather than a day of every account's fixes.
 */
async function longestSilences(db: Database, ids: string[]): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    select u.id as user_id,
           greatest(
             coalesce(extract(epoch from g.longest_gap), 0),
             extract(epoch from now() - g.last_fix)
           )::int as longest
    from users u
    cross join lateral (
      select max(gap) as longest_gap, max(recorded_at) as last_fix
      from (
        select recorded_at, recorded_at - lag(recorded_at) over (order by recorded_at) as gap
        from location_points
        where user_id = u.id and recorded_at > now() - interval '24 hours'
      ) day
    ) g
    where u.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) and g.last_fix is not null
  `)) as unknown as Array<{ user_id: string; longest: number }>
  return new Map(rows.map((row) => [row.user_id, row.longest]))
}

/** Who is in each circle and how it is set up, never where anybody is. */
export async function listCircles(db: Database): Promise<AdminCircleSummary[]> {
  const [circleRows, memberRows, placeRows] = await Promise.all([
    db
      .select({
        id: circles.id,
        name: circles.name,
        emoji: circles.emoji,
        createdAt: circles.createdAt,
        settings: circles.settings,
      })
      .from(circles)
      .orderBy(desc(circles.createdAt)),
    db
      .select({
        circleId: circleMembers.circleId,
        userId: circleMembers.userId,
        role: circleMembers.role,
        displayName: users.displayName,
      })
      .from(circleMembers)
      .innerJoin(users, eq(users.id, circleMembers.userId)),
    db
      .select({ circleId: places.circleId, count: sql<number>`count(*)::int` })
      .from(places)
      .groupBy(places.circleId),
  ])
  const placeCounts = new Map(placeRows.map((row) => [row.circleId, row.count]))
  const rank: Record<CircleRole, number> = { owner: 0, admin: 1, member: 2 }

  return circleRows.map((circle) => {
    const members = memberRows
      .filter((row) => row.circleId === circle.id)
      .sort((a, b) => rank[a.role] - rank[b.role] || a.displayName.localeCompare(b.displayName))
      .map((row) => ({ userId: row.userId, displayName: row.displayName, role: row.role }))
    return toAdminCircleSummary(circle, members, placeCounts.get(circle.id) ?? 0)
  })
}

export async function auditEntries(db: Database, limit: number): Promise<AdminAuditEntry[]> {
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit)
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.actorUserId) ids.add(row.actorUserId)
    if (row.targetType === "user" && row.targetId) ids.add(row.targetId)
  }
  const named =
    ids.size === 0
      ? []
      : await db
          .select({ id: users.id, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, [...ids]))
  const names = new Map(named.map((user) => [user.id, user.displayName]))
  return rows.map((row) => toAdminAuditEntry(row, names))
}

export async function outboxEntries(
  db: Database,
  options: { status?: AdminOutboxEntry["status"]; limit: number; viewerId: string },
): Promise<AdminOutboxEntry[]> {
  const rows = await db
    .select({ row: notificationOutbox, userName: users.displayName })
    .from(notificationOutbox)
    .leftJoin(users, eq(users.id, notificationOutbox.userId))
    .where(options.status ? eq(notificationOutbox.status, options.status) : undefined)
    .orderBy(desc(notificationOutbox.id))
    .limit(options.limit)
  return rows.map(({ row, userName }) => toAdminOutboxEntry(row, userName, options.viewerId))
}
