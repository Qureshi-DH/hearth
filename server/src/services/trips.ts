import { DEFAULTS, haversineMeters, pathDistanceMeters } from "@hearth/shared"
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, locationPoints, places, trips, userPresence } from "../db/schema"

const MAX_POINTS_PER_PASS = 5000

interface Candidate {
  id: number
  recordedAt: Date
  lat: number
  lon: number
  speedMps: number | null
}

/**
 * A trip is a run of fixes with no gap longer than `tripIdleGapSeconds` that
 * covers enough ground over enough time. Anything smaller is someone walking
 * around the house with GPS drift, and gets discarded.
 *
 * Only points older than one idle gap are considered, so a journey still under
 * way is never cut in half and then re-detected as two trips.
 */
export async function detectTripsForUser(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const settleBefore = new Date(now.getTime() - DEFAULTS.tripIdleGapSeconds * 1000)

  const [presence] = await db
    .select({ processedUntil: userPresence.tripsProcessedUntil })
    .from(userPresence)
    .where(eq(userPresence.userId, userId))
    .limit(1)

  const since = presence?.processedUntil ?? new Date(0)

  const rows = await db
    .select({
      id: locationPoints.id,
      recordedAt: locationPoints.recordedAt,
      lat: locationPoints.lat,
      lon: locationPoints.lon,
      speedMps: locationPoints.speedMps,
    })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        gt(locationPoints.recordedAt, since),
        lt(locationPoints.recordedAt, settleBefore),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(MAX_POINTS_PER_PASS)

  if (rows.length === 0) return 0

  const segments = segmentByIdleGap(rows, DEFAULTS.tripIdleGapSeconds * 1000)
  const placeRows = await placesVisibleTo(db, userId)

  // The newest segment counts as closed only if the device has been quiet for
  // a full idle gap since. Otherwise the journey may still be under way, and
  // cutting it here would turn one drive into two trips. Leave it for the next
  // pass.
  const last = segments[segments.length - 1]!
  const lastFixAt = last[last.length - 1]!.recordedAt.getTime()
  const [newer] = await db
    .select({ recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        gt(locationPoints.recordedAt, last[last.length - 1]!.recordedAt),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(1)
  const quietSince = newer ? newer.recordedAt.getTime() : now.getTime()
  const lastIsClosed = quietSince - lastFixAt > DEFAULTS.tripIdleGapSeconds * 1000

  const closed = lastIsClosed ? segments : segments.slice(0, -1)

  let created = 0
  for (const segment of closed) {
    if (await persistSegment(db, userId, segment, placeRows)) created += 1
  }

  // Advance only past what actually settled. An open segment is re-read in
  // full next pass, so the watermark stops just before it.
  const watermark = lastIsClosed
    ? last[last.length - 1]!.recordedAt
    : new Date(last[0]!.recordedAt.getTime() - 1)
  if (closed.length > 0 || lastIsClosed) await advanceWatermark(db, userId, watermark)
  else if (segments.length > 1) await advanceWatermark(db, userId, watermark)
  return created
}

export function segmentByIdleGap(points: Candidate[], gapMs: number): Candidate[][] {
  const segments: Candidate[][] = []
  let current: Candidate[] = []

  for (const point of points) {
    const previous = current[current.length - 1]
    if (previous && point.recordedAt.getTime() - previous.recordedAt.getTime() > gapMs) {
      segments.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

async function persistSegment(
  db: Database,
  userId: string,
  segment: Candidate[],
  placeRows: { id: string; lat: number; lon: number; radiusMeters: number }[],
): Promise<boolean> {
  if (segment.length < 3) return false

  const first = segment[0]!
  const last = segment[segment.length - 1]!
  const durationSeconds = (last.recordedAt.getTime() - first.recordedAt.getTime()) / 1000
  if (durationSeconds < DEFAULTS.tripMinDurationSeconds) return false

  const distance = pathDistanceMeters(segment.map((p) => ({ lat: p.lat, lon: p.lon })))
  if (distance < DEFAULTS.tripMinDistanceMeters) return false

  // A loop back to its own start is still a trip, but a jittery stationary
  // phone is not. Require real displacement, or a much longer path.
  const displacement = haversineMeters(
    { lat: first.lat, lon: first.lon },
    { lat: last.lat, lon: last.lon },
  )
  if (displacement < 150 && distance < DEFAULTS.tripMinDistanceMeters * 3) return false

  const speeds = segment
    .map((p) => p.speedMps)
    .filter((value): value is number => value != null && Number.isFinite(value))
  const maxSpeed = speeds.length > 0 ? Math.max(...speeds) : null
  const avgSpeed = durationSeconds > 0 ? distance / durationSeconds : null

  const [trip] = await db
    .insert(trips)
    .values({
      userId,
      startedAt: first.recordedAt,
      endedAt: last.recordedAt,
      distanceMeters: Math.round(distance),
      maxSpeedMps: maxSpeed,
      avgSpeedMps: avgSpeed,
      pointCount: segment.length,
      startLat: first.lat,
      startLon: first.lon,
      endLat: last.lat,
      endLon: last.lon,
      startPlaceId: placeContaining(placeRows, first) ?? null,
      endPlaceId: placeContaining(placeRows, last) ?? null,
    })
    .returning({ id: trips.id })

  if (!trip) return false

  await db
    .update(locationPoints)
    .set({ tripId: trip.id })
    .where(
      inArray(
        locationPoints.id,
        segment.map((p) => p.id),
      ),
    )

  return true
}

function placeContaining(
  placeRows: { id: string; lat: number; lon: number; radiusMeters: number }[],
  point: { lat: number; lon: number },
): string | undefined {
  for (const place of placeRows) {
    if (haversineMeters(point, { lat: place.lat, lon: place.lon }) <= place.radiusMeters) {
      return place.id
    }
  }
  return undefined
}

async function placesVisibleTo(db: Database, userId: string) {
  return db
    .select({
      id: places.id,
      lat: places.lat,
      lon: places.lon,
      radiusMeters: places.radiusMeters,
    })
    .from(places)
    .innerJoin(circleMembers, eq(circleMembers.circleId, places.circleId))
    .where(eq(circleMembers.userId, userId))
}

async function advanceWatermark(db: Database, userId: string, until: Date): Promise<void> {
  await db
    .insert(userPresence)
    .values({ userId, tripsProcessedUntil: until })
    .onConflictDoUpdate({
      target: userPresence.userId,
      set: {
        tripsProcessedUntil: sql`greatest(coalesce(${userPresence.tripsProcessedUntil}, to_timestamp(0)), excluded.trips_processed_until)`,
      },
    })
}
