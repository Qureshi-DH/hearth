import { DEFAULTS, haversineMeters } from "@hearth/shared"
import { and, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, events, userPresence } from "../db/schema"
import { effectiveSharingState } from "./presence"
import { heardAt } from "./reporting"

/**
 * What a recipient may still be told when a notification finally goes out,
 * checked again at that moment rather than only when it was queued. A
 * backlog can sit behind a broken provider for hours, and a card rebuilt
 * from earlier lines repeats news that may no longer be theirs to see.
 */

export interface ScopedRow {
  id: number
  userId: string
  circleId: string | null
  data: Record<string, unknown>
}

/** The rows whose recipient is no longer in the circle the row came from. */
export async function rowsForFormerMembers(db: Database, rows: ScopedRow[]): Promise<Set<number>> {
  const scoped = rows.filter((row): row is ScopedRow & { circleId: string } => !!row.circleId)
  if (scoped.length === 0) return new Set()

  const memberRows = await db
    .select({ userId: circleMembers.userId, circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(
      and(
        inArray(circleMembers.userId, [...new Set(scoped.map((row) => row.userId))]),
        inArray(circleMembers.circleId, [...new Set(scoped.map((row) => row.circleId))]),
      ),
    )

  const key = (userId: string, circleId: string) => `${userId}:${circleId}`
  const stillIn = new Set(memberRows.map((row) => key(row.userId, row.circleId)))
  return new Set(
    scoped.filter((row) => !stillIn.has(key(row.userId, row.circleId))).map((row) => row.id),
  )
}

/**
 * News of where somebody went is dropped if they stopped sharing precisely
 * with that circle while it waited in the outbox, the same way the feed stops
 * showing it. A possible incident is checked the same way by the drain, but
 * is not in this list, which also decides the lines a rebuilt card repeats,
 * and an incident never joins a card.
 */
export const PLACE_NEWS = new Set(["place_arrive", "place_leave", "speed_alert", "trip_completed"])

/** The rows of place news whose subject has since stopped sharing precisely with that circle. */
export async function placeNewsNoLongerShared(
  db: Database,
  rows: ScopedRow[],
  now: Date,
  types: Set<string> = PLACE_NEWS,
): Promise<Set<number>> {
  const news = rows.filter(
    (row) =>
      row.circleId && types.has(String(row.data.type)) && Number.isFinite(Number(row.data.eventId)),
  )
  if (news.length === 0) return new Set()

  const actors = await db
    .select({ id: events.id, actor: events.actorUserId })
    .from(events)
    .where(inArray(events.id, [...new Set(news.map((row) => Number(row.data.eventId)))]))
  const actorOf = new Map(actors.map((row) => [row.id, row.actor]))
  const actorIds = [...new Set(actors.map((row) => row.actor).filter((id): id is string => !!id))]
  const states =
    actorIds.length === 0
      ? []
      : await db
          .select({
            circleId: circleMembers.circleId,
            userId: circleMembers.userId,
            sharingState: circleMembers.sharingState,
            pausedUntil: circleMembers.pausedUntil,
            resumeToState: circleMembers.resumeToState,
          })
          .from(circleMembers)
          .where(inArray(circleMembers.userId, actorIds))
  const precise = new Set(
    states
      .filter(
        (row) =>
          effectiveSharingState(row.sharingState, row.pausedUntil, now, row.resumeToState) ===
          "precise",
      )
      .map((row) => `${row.userId}:${row.circleId}`),
  )

  return new Set(
    news
      .filter((row) => {
        const actor = actorOf.get(Number(row.data.eventId))
        return actor != null && !precise.has(`${actor}:${row.circleId}`)
      })
      .map((row) => row.id),
  )
}

/**
 * "Phone offline" rows whose phone has spoken since they were queued. Held
 * back by a provider outage, one would otherwise reach the family after the
 * phone came back, telling them something that has stopped being true.
 */
export async function offlineNewsOvertaken(
  db: Database,
  rows: Array<ScopedRow & { createdAt: Date }>,
): Promise<Set<number>> {
  const news = rows.filter(
    (row) => row.data.type === "device_offline" && Number.isFinite(Number(row.data.eventId)),
  )
  if (news.length === 0) return new Set()

  const heard = await db
    .select({
      eventId: events.id,
      heardAtMs: sql<number | null>`(extract(epoch from ${heardAt}) * 1000)::float8`,
    })
    .from(events)
    .innerJoin(userPresence, eq(userPresence.userId, events.actorUserId))
    .where(inArray(events.id, [...new Set(news.map((row) => Number(row.data.eventId)))]))
  const heardAtOf = new Map(heard.map((row) => [row.eventId, row.heardAtMs ?? 0]))

  return new Set(
    news
      .filter((row) => (heardAtOf.get(Number(row.data.eventId)) ?? 0) > row.createdAt.getTime())
      .map((row) => row.id),
  )
}

/**
 * Further than a car drifts at a standstill or a phone's fix wanders, so a
 * newer fix this far from the stop is the person driving on.
 */
const MOVED_ON_METERS = 300

/**
 * Possible-incident rows whose person has a newer fix, sharp enough to
 * trust, well away from where they stopped. "They have not moved since" is
 * then not true, however late the provider let the alert through.
 */
export async function incidentsMovedOn(db: Database, rows: ScopedRow[]): Promise<Set<number>> {
  const news = rows.filter(
    (row) => row.data.type === "possible_incident" && Number.isFinite(Number(row.data.eventId)),
  )
  if (news.length === 0) return new Set()

  const ids = [...new Set(news.map((row) => Number(row.data.eventId)))]
  const found = (await db.execute(sql`
    select e.id::text as event_id, stop.lat as stop_lat, stop.lon as stop_lon,
           p.lat, p.lon, p.accuracy_meters
    from events e
    join user_presence p on p.user_id = e.actor_user_id
    join lateral (
      select lp.lat, lp.lon from location_points lp
      where lp.user_id = e.actor_user_id
        and lp.recorded_at <= (e.payload->>'at')::timestamptz
      order by lp.recorded_at desc
      limit 1
    ) stop on true
    where e.type = 'possible_incident'
      and e.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      and p.recorded_at > (e.payload->>'at')::timestamptz
  `)) as unknown as Array<{
    event_id: string
    stop_lat: number
    stop_lon: number
    lat: number | null
    lon: number | null
    accuracy_meters: number | null
  }>

  const movedOn = new Set(
    found
      .filter(
        (row) =>
          row.lat !== null &&
          row.lon !== null &&
          (row.accuracy_meters ?? Infinity) <= DEFAULTS.geofenceMaxAccuracyMeters &&
          haversineMeters(
            { lat: row.stop_lat, lon: row.stop_lon },
            { lat: row.lat, lon: row.lon },
          ) > MOVED_ON_METERS,
      )
      .map((row) => Number(row.event_id)),
  )
  return new Set(news.filter((row) => movedOn.has(Number(row.data.eventId))).map((row) => row.id))
}
