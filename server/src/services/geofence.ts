import { DEFAULTS, evaluateGeofence } from "@hearth/shared"
import { and, eq, inArray, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, placeEvents, placeMemberships, places, users } from "../db/schema"
import { recordEvent } from "./feed"

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
 * Two safeguards keep this from spamming the family. Fixes worse than
 * `geofenceMaxAccuracyMeters` are skipped, because a 2 km cell-tower fix would
 * "arrive" everywhere at once. Leaving requires clearing the radius plus a
 * buffer, so a phone resting on a boundary cannot oscillate.
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
  } = {},
): Promise<GeofenceTransition[]> {
  const usable = fixes
    .filter(
      (fix) =>
        fix.accuracyMeters == null || fix.accuracyMeters <= DEFAULTS.geofenceMaxAccuracyMeters,
    )
    .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())

  if (usable.length === 0) return []

  const memberships = await db
    .select({ circleId: circleMembers.circleId })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId))
  const allowed = options.visibleCircleIds ? new Set(options.visibleCircleIds) : null
  const circleIds = memberships
    .map((row) => row.circleId)
    .filter((id) => !allowed || allowed.has(id))
  if (circleIds.length === 0) return []

  const placeRows = await db.select().from(places).where(inArray(places.circleId, circleIds))
  if (placeRows.length === 0) return []

  const existing = await db
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

  const transitions: GeofenceTransition[] = []
  const finalState = new Map<string, { isInside: boolean; since: Date }>()

  for (const place of placeRows) {
    let wasInside = known.get(place.id) ?? false
    let since: Date | null = null
    let firstEvaluation = !seenBefore.has(place.id)

    for (const fix of usable) {
      // A straggler older than what this fence has already seen cannot rewind
      // its state. Skipping it is what makes retried uploads idempotent here.
      if (fix.recordedAt.getTime() <= (evaluatedUntil.get(place.id) ?? -Infinity)) continue
      const isInside = evaluateGeofence({
        point: { lat: fix.lat, lon: fix.lon },
        center: { lat: place.lat, lon: place.lon },
        radiusMeters: place.radiusMeters,
        wasInside,
        exitBufferMeters: DEFAULTS.geofenceExitBufferMeters,
      })

      if (isInside === wasInside && !firstEvaluation) continue

      // The first evaluation only counts as an event if they are inside.
      // "Not at the park" is not news.
      const shouldEmit = !firstEvaluation || isInside
      firstEvaluation = false
      wasInside = isInside
      since = fix.recordedAt

      if (!shouldEmit) continue

      transitions.push({
        placeId: place.id,
        placeName: place.name,
        circleId: place.circleId,
        type: isInside ? "arrive" : "leave",
        occurredAt: fix.recordedAt,
        pointId: fix.pointId ?? null,
      })
    }

    const changed = wasInside !== (known.get(place.id) ?? false)
    if (changed || !seenBefore.has(place.id)) {
      finalState.set(place.id, {
        isInside: wasInside,
        since: since ?? usable[usable.length - 1]!.recordedAt,
      })
    }
  }

  const lastFixAt = usable[usable.length - 1]!.recordedAt

  for (const [placeId, state] of finalState) {
    await db
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
        set: { isInside: state.isInside, since: state.since, lastEvaluatedAt: lastFixAt },
      })
  }

  const untouched = placeRows
    .map((place) => place.id)
    .filter((id) => !finalState.has(id) && seenBefore.has(id))
  if (untouched.length > 0) {
    await db
      .update(placeMemberships)
      .set({ lastEvaluatedAt: lastFixAt })
      .where(and(eq(placeMemberships.userId, userId), inArray(placeMemberships.placeId, untouched)))
  }

  if (transitions.length === 0) return []

  await db.insert(placeEvents).values(
    transitions.map((transition) => ({
      placeId: transition.placeId,
      circleId: transition.circleId,
      userId,
      type: transition.type,
      occurredAt: transition.occurredAt,
      pointId: transition.pointId,
    })),
  )

  const [actor] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const name = actor?.displayName ?? "Someone"

  for (const transition of transitions) {
    const verb = transition.type === "arrive" ? "arrived at" : "left"
    await recordEvent(db, {
      circleId: transition.circleId,
      type: transition.type === "arrive" ? "place_arrive" : "place_leave",
      actorUserId: userId,
      payload: {
        placeId: transition.placeId,
        placeName: transition.placeName,
        occurredAt: transition.occurredAt.toISOString(),
      },
      summary: `${name} ${verb} ${transition.placeName}`,
      notify: {
        title: transition.placeName,
        body: `${name} ${verb} ${transition.placeName}`,
        data: { placeId: transition.placeId, userId },
      },
    })
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
      now(),
      now()
    from places p
    join circle_members cm on cm.circle_id = p.circle_id
    join user_presence up on up.user_id = cm.user_id
    where p.id = ${placeId}
      and up.lat is not null
      and up.lon is not null
    on conflict (place_id, user_id) do nothing
  `)
}
