import { DEFAULTS, haversineMeters, type FeedEvent } from "@hearth/shared"
import { and, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, placeEvents, placeMemberships, places, users } from "../db/schema"
import { broadcastEvent, recordEvent } from "./feed"

/**
 * A crossing cancelled this quickly was a transit, not a visit. Driving through
 * a fence puts one fix inside and the next one back outside, and an arrival the
 * family is told about and then told to forget is worse than no arrival at all.
 */
const TRANSIENT_VISIT_MS = 2 * 60 * 1000

export interface GeofenceFix {
  lat: number
  lon: number
  accuracyMeters?: number | null
  recordedAt: Date
  pointId?: number | null
}

export interface GeofenceTransition {
  placeId: string
  placeName: string
  circleId: string
  type: "arrive" | "leave"
  occurredAt: Date
  pointId: number | null
}

/**
 * Places and current membership load once and fold over in memory, so a
 * catch-up upload costs a constant number of queries rather than four per
 * point.
 *
 * Several safeguards keep this from spamming the family. Fixes worse than
 * `geofenceMaxAccuracyMeters` are dropped outright, because a 2 km cell-tower
 * fix would "arrive" everywhere at once, and every fix that survives still has
 * to clear the boundary by half its own error circle before it may change
 * anything. Leaving requires clearing the radius plus a buffer, so a phone
 * resting on a boundary cannot oscillate.
 */
export async function evaluateGeofenceBatch(
  db: Database,
  userId: string,
  fixes: GeofenceFix[],
  options: {
    /**
     * Circles allowed to learn about arrivals and departures. A member sharing
     * "approximate" or "paused" with a circle must not have that circle told
     * they just reached a specific address. That is the point of those modes.
     */
    visibleCircleIds?: string[]
    /** Wall clock, so a replayed backlog can be told apart from live movement. */
    now?: Date
  } = {},
): Promise<GeofenceTransition[]> {
  const now = options.now ?? new Date()
  const usable = fixes
    .filter(
      (fix) =>
        fix.accuracyMeters == null || fix.accuracyMeters <= DEFAULTS.geofenceMaxAccuracyMeters,
    )
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())

  if (usable.length === 0) return []

  const visible = options.visibleCircleIds
  if (visible && visible.length === 0) return []

  // The membership join is what keeps a caller from writing arrivals into a
  // circle this user does not belong to. Joining it here also spares the
  // upload path a second read of the rows it already has.
  const placeRows = await db
    .select({
      id: places.id,
      circleId: places.circleId,
      name: places.name,
      lat: places.lat,
      lon: places.lon,
      radiusMeters: places.radiusMeters,
    })
    .from(places)
    .innerJoin(
      circleMembers,
      and(eq(circleMembers.circleId, places.circleId), eq(circleMembers.userId, userId)),
    )
    .where(visible ? inArray(places.circleId, visible) : undefined)
  if (placeRows.length === 0) return []

  const lastFixAt = usable[usable.length - 1]!.recordedAt
  const transitions: GeofenceTransition[] = []

  const broadcasts: Array<{ circleId: string; event: FeedEvent }> = []

  // The new state and the events it produced commit together. If
  // `lastEvaluatedAt` moved on its own and the process then died, every fix in
  // this batch would be skipped as a straggler on the retry, and the arrival
  // nobody was told about could never be recovered.
  await db.transaction(async (tx) => {
    // One person's two signed-in devices can upload at the same moment. The
    // membership read below is what decides the transitions, so without
    // serialising here both uploads see "outside" and both announce the same
    // arrival. Blocking rather than skipping, because the batch that loses the
    // race still has fixes that have to be evaluated.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hearth:geofence:${userId}`}))`)

    const existing = await tx
      .select()
      .from(placeMemberships)
      .where(
        and(
          eq(placeMemberships.userId, userId),
          inArray(
            placeMemberships.placeId,
            placeRows.map((place) => place.id),
          ),
        ),
      )

    const known = new Map(existing.map((row) => [row.placeId, row.isInside]))
    const seenBefore = new Set(existing.map((row) => row.placeId))
    const evaluatedUntil = new Map(
      existing.map((row) => [row.placeId, row.lastEvaluatedAt.getTime()]),
    )

    const finalState = new Map<string, { isInside: boolean; since: Date }>()

    for (const place of placeRows) {
      let wasInside = known.get(place.id) ?? false
      let since: Date | null = null
      let firstEvaluation = !seenBefore.has(place.id)
      const crossings: GeofenceTransition[] = []

      for (const fix of usable) {
        // A straggler older than what this fence has already seen cannot rewind
        // its state. Skipping it is what makes retried uploads idempotent here.
        if (fix.recordedAt.getTime() <= (evaluatedUntil.get(place.id) ?? -Infinity)) continue

        const distance = haversineMeters(
          { lat: fix.lat, lon: fix.lon },
          { lat: place.lat, lon: place.lon },
        )
        // A fix is a circle, not a point. A crossing counts only once half the
        // error circle is clear of the boundary, so a coarse fix can still
        // decide a wide fence but never a doorstep one. Anything less certain
        // than that keeps the state it already had, which is the honest answer
        // and the only one the exit buffer is narrow enough to absorb.
        // Half the error circle, not all of it. Shrinking the fence by the
        // whole radius means a fix even slightly coarser than the fence can
        // never enter it, and never entering means never leaving either, so an
        // ordinary indoor blend would freeze a small place for good. Half still
        // refuses a fix far too vague to decide the fence at all.
        const accuracy = fix.accuracyMeters ?? 0
        const margin = accuracy / 2
        const isInside = wasInside
          ? distance - margin <= place.radiusMeters + DEFAULTS.geofenceExitBufferMeters
          : distance + margin <= place.radiusMeters

        if (isInside === wasInside && !firstEvaluation) continue

        // The first evaluation only counts as an event if they are inside.
        // "Not at the park" is not news.
        const shouldEmit = !firstEvaluation || isInside
        firstEvaluation = false
        wasInside = isInside
        since = fix.recordedAt

        if (!shouldEmit) continue

        crossings.push({
          placeId: place.id,
          placeName: place.name,
          circleId: place.circleId,
          type: isInside ? "arrive" : "leave",
          occurredAt: fix.recordedAt,
          pointId: fix.pointId ?? null,
        })
      }

      // Crossings for one fence always alternate, so a pair closer together
      // than a transit takes cancels out. Dropping both halves leaves the
      // membership exactly where it started, which is where the person is.
      const kept: GeofenceTransition[] = []
      for (const crossing of crossings) {
        const previous = kept[kept.length - 1]
        if (
          previous &&
          crossing.occurredAt.getTime() - previous.occurredAt.getTime() < TRANSIENT_VISIT_MS
        ) {
          kept.pop()
          continue
        }
        kept.push(crossing)
      }
      transitions.push(...kept)

      const changed = wasInside !== (known.get(place.id) ?? false)
      if (changed || !seenBefore.has(place.id)) {
        finalState.set(place.id, { isInside: wasInside, since: since ?? lastFixAt })
      }
    }

    const untouched = placeRows
      .map((place) => place.id)
      .filter(
        (id) =>
          !finalState.has(id) &&
          seenBefore.has(id) &&
          (evaluatedUntil.get(id) ?? -Infinity) < lastFixAt.getTime(),
      )

    for (const [placeId, state] of finalState) {
      await tx
        .insert(placeMemberships)
        .values({
          placeId,
          userId,
          isInside: state.isInside,
          since: state.since,
          lastEvaluatedAt: lastFixAt,
        })
        .onConflictDoUpdate({
          target: [placeMemberships.placeId, placeMemberships.userId],
          set: {
            isInside: state.isInside,
            since: state.since,
            // Forward only. The straggler guard above is what makes an
            // out-of-order upload safe, and rewinding this watermark hands
            // those already-judged fixes back to the fence.
            lastEvaluatedAt: sql`greatest(${placeMemberships.lastEvaluatedAt}, excluded.last_evaluated_at)`,
          },
        })
    }

    if (untouched.length > 0) {
      await tx
        .update(placeMemberships)
        .set({
          lastEvaluatedAt: sql`greatest(${placeMemberships.lastEvaluatedAt}, ${lastFixAt.toISOString()}::timestamptz)`,
        })
        .where(
          and(eq(placeMemberships.userId, userId), inArray(placeMemberships.placeId, untouched)),
        )
    }

    if (transitions.length === 0) return

    await tx.insert(placeEvents).values(
      transitions.map((transition) => ({
        placeId: transition.placeId,
        circleId: transition.circleId,
        userId,
        type: transition.type,
        occurredAt: transition.occurredAt,
        pointId: transition.pointId,
      })),
    )

    const [actor] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const name = actor?.displayName ?? "Someone"

    for (const transition of transitions) {
      const verb = transition.type === "arrive" ? "arrived at" : "left"
      // A backlog uploaded after an outage replays crossings that really
      // happened, days ago. They belong in the feed, but pushing them now would
      // tell the family someone is at the park while they are at work.
      const isCurrent =
        now.getTime() - transition.occurredAt.getTime() < DEFAULTS.staleAfterSeconds * 1000
      const dto = await recordEvent(tx as unknown as Database, {
        deferBroadcast: true,
        circleId: transition.circleId,
        type: transition.type === "arrive" ? "place_arrive" : "place_leave",
        actorUserId: userId,
        occurredAt: transition.occurredAt,
        payload: {
          placeId: transition.placeId,
          placeName: transition.placeName,
          occurredAt: transition.occurredAt.toISOString(),
        },
        summary: `${name} ${verb} ${transition.placeName}`,
        notify: isCurrent
          ? {
              title: transition.placeName,
              body: `${name} ${verb} ${transition.placeName}`,
              data: { placeId: transition.placeId, userId },
            }
          : undefined,
      })
      broadcasts.push({ circleId: transition.circleId, event: dto })
    }
  })

  for (const { circleId, event } of broadcasts) {
    await broadcastEvent(circleId, event)
  }

  return transitions
}

/**
 * Without this, everyone already standing inside a new place fires a spurious
 * "arrived" on their next fix.
 */
export async function primePlaceMemberships(db: Database, placeId: string): Promise<void> {
  await db.execute(sql`
    insert into place_memberships (place_id, user_id, is_inside, since, last_evaluated_at)
    select
      p.id,
      cm.user_id,
      -- Haversine, inlined: runs once per place creation, not per fix.
      (2 * 6371008.8 * asin(sqrt(
        power(sin(radians(up.lat - p.lat) / 2), 2) +
        cos(radians(p.lat)) * cos(radians(up.lat)) *
        power(sin(radians(up.lon - p.lon) / 2), 2)
      ))) <= p.radius_meters,
      -- Both stamps come from the fix this decision was made on. A watermark
      -- stamped in the present would make every fix already in flight look
      -- like a straggler, so the fence would ignore the next real crossing.
      coalesce(up.recorded_at, now()),
      coalesce(up.recorded_at, now())
    from places p
    join circle_members cm on cm.circle_id = p.circle_id
    join user_presence up on up.user_id = cm.user_id
    where p.id = ${placeId}
      and up.lat is not null
      and up.lon is not null
    on conflict (place_id, user_id) do nothing
  `)
}
