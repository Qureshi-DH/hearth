import { and, inArray } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, events } from "../db/schema"
import { effectiveSharingState } from "./presence"

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
 * showing it. A crash alert is not in this list: a family is told about a
 * possible incident whatever was switched a moment before it.
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
