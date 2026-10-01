import type {
  AdminOverview,
  AdminPhone,
  AdminPhoneState,
  DeviceHealth,
  Platform,
} from "@hearth/shared"
import { DEFAULTS } from "@hearth/shared"
import { sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { presenceIssues } from "./presence"
import { heardAt, parked, silentPastCutoff } from "./reporting"

const DAYS = 14

/**
 * Finished days barely change, so they are counted again only this often,
 * and today is counted on every call. A busy server holds millions of fixes
 * in the window, and the dashboard asks every minute from every open tab.
 */
const SETTLED_DAYS_MS = 10 * 60_000

interface DayCount {
  day: string
  fixes: number
  people: number
}

interface Settled {
  /** The day these were counted up to, so a new day starts a new count. */
  today: string
  countedAt: number
  days: DayCount[]
}

const settledByZone = new Map<string, Settled>()

/** Each zone a viewer sat in keeps its own count. These are for the few administrators there are. */
const MAX_ZONES = 16

/** For tests, which change the data under a count that would otherwise be reused. */
export function forgetSettledDays(): void {
  settledByZone.clear()
}

/**
 * The dashboard's numbers. Days are the viewer's own, so a fix at half past
 * midnight in Karachi counts on the day it happened there, not on the UTC
 * one before it.
 */
export async function adminOverview(
  db: Database,
  timeZone: string,
  now = new Date(),
): Promise<AdminOverview> {
  const days = await lastDays(db, timeZone)
  const today = days.at(-1)!
  const [settled, todays, notifications, phones] = await Promise.all([
    settledDays(db, timeZone, days, now),
    countDays(db, timeZone, today.startsAt, null),
    notificationsByDay(db, timeZone, days[0]!.startsAt),
    phoneList(db, now),
  ])

  const counts = new Map([...settled, ...todays].map((row) => [row.day, row]))
  const byStatus = (statuses: string[]) =>
    days.map(({ day }) =>
      notifications
        .filter((row) => row.day === day && statuses.includes(row.status))
        .reduce((sum, row) => sum + row.n, 0),
    )

  return {
    days: days.map(({ day }) => day),
    fixes: days.map(({ day }) => counts.get(day)?.fixes ?? 0),
    activeAccounts: days.map(({ day }) => counts.get(day)?.people ?? 0),
    notifications: {
      sent: byStatus(["sent"]),
      failed: byStatus(["failed"]),
      skipped: byStatus(["skipped"]),
      waiting: byStatus(["pending", "sending"]),
    },
    phones,
  }
}

/** The window's days in the viewer's zone, oldest first, with the instant each one starts. */
async function lastDays(db: Database, timeZone: string) {
  const rows = (await db.execute(sql`
    select to_char(day, 'YYYY-MM-DD') as day,
           (day at time zone ${timeZone})::text as starts_at
    from generate_series(
      date_trunc('day', now() at time zone ${timeZone}) - ${`${DAYS - 1} days`}::interval,
      date_trunc('day', now() at time zone ${timeZone}),
      '1 day'::interval
    ) as day
    order by day
  `)) as unknown as Array<{ day: string; starts_at: string }>
  return rows.map((row) => ({ day: row.day, startsAt: row.starts_at }))
}

async function settledDays(
  db: Database,
  timeZone: string,
  days: Array<{ day: string; startsAt: string }>,
  now: Date,
): Promise<DayCount[]> {
  const today = days.at(-1)!
  const kept = settledByZone.get(timeZone)
  if (kept && kept.today === today.day && now.getTime() - kept.countedAt < SETTLED_DAYS_MS) {
    return kept.days
  }
  const counted = await countDays(db, timeZone, days[0]!.startsAt, today.startsAt)
  if (!settledByZone.has(timeZone) && settledByZone.size >= MAX_ZONES) {
    settledByZone.delete(settledByZone.keys().next().value!)
  }
  settledByZone.set(timeZone, { today: today.day, countedAt: now.getTime(), days: counted })
  return counted
}

/**
 * Fixes and the people who sent them, per day, between two instants. Walked
 * person by person, so each count is a range over the (user, time) index
 * rather than a scan of every fix the server holds.
 */
async function countDays(
  db: Database,
  timeZone: string,
  from: string,
  until: string | null,
): Promise<DayCount[]> {
  const rows = (await db.execute(sql`
    select to_char(counted.day, 'YYYY-MM-DD') as day,
           sum(counted.n)::int as fixes,
           count(*)::int as people
    from users u
    cross join lateral (
      select (p.recorded_at at time zone ${timeZone})::date as day, count(*)::int as n
      from location_points p
      where p.user_id = u.id
        and p.recorded_at >= ${from}::timestamptz
        and (${until}::timestamptz is null or p.recorded_at < ${until}::timestamptz)
      group by 1
    ) counted
    group by counted.day
  `)) as unknown as DayCount[]
  return rows
}

async function notificationsByDay(db: Database, timeZone: string, from: string) {
  return (await db.execute(sql`
    select to_char((created_at at time zone ${timeZone})::date, 'YYYY-MM-DD') as day,
           status, count(*)::int as n
    from notification_outbox
    where silent = false and created_at >= ${from}::timestamptz
    group by 1, 2
  `)) as unknown as Array<{ day: string; status: string; n: number }>
}

/**
 * The phone each active account used last, and how it is doing by the same
 * rule that decides when the family is told it went offline. A browser
 * session, such as the portal's own, is not a phone, so it never stands in
 * for one.
 */
async function phoneList(db: Database, now: Date): Promise<AdminPhone[]> {
  const reportingSince = new Date(now.getTime() - DEFAULTS.staleAfterSeconds * 1000)
  const rows = (await db.execute(sql`
    select u.id, u.display_name, u.avatar_color,
           s.device_name, s.platform, s.app_version,
           ${heardAt} as last_heard_at,
           user_presence.health,
           case
             when s.platform is null then 'none'
             when ${heardAt} is null then 'never'
             when ${silentPastCutoff(now)} then 'offline'
             when ${heardAt} >= ${reportingSince.toISOString()}::timestamptz then 'reporting'
             when ${parked} then 'parked'
             else 'quiet'
           end as state
    from users u
    left join user_presence on user_presence.user_id = u.id
    left join lateral (
      select device_name, platform, app_version
      from sessions
      where user_id = u.id and revoked_at is null and platform in ('ios', 'android')
      order by last_used_at desc nulls last, created_at desc
      limit 1
    ) s on true
    where u.is_active
    order by lower(u.display_name)
  `)) as unknown as Array<{
    id: string
    display_name: string
    avatar_color: string
    device_name: string | null
    platform: Platform | null
    app_version: string | null
    last_heard_at: string | Date | null
    health: DeviceHealth | null
    state: AdminPhoneState
  }>

  return rows.map((row) => ({
    userId: row.id,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    deviceName: row.device_name,
    platform: row.platform,
    appVersion: row.app_version,
    lastHeardAt: row.last_heard_at ? new Date(row.last_heard_at).toISOString() : null,
    state: row.state,
    issues: presenceIssues(row.health),
  }))
}
