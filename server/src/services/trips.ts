import { DEFAULTS, haversineMeters, pathDistanceMeters } from "@hearth/shared"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, locationPoints, places, trips, userPresence } from "../db/schema"

const MAX_POINTS_PER_PASS = 5000

/**
 * How far behind the watermark every pass re-reads. A device that lost signal
 * uploads its backlog long after the other devices on the account have pushed
 * the watermark past it, and the watermark only ever moves forward, so without
 * this the whole drive is skipped and never looked at again. Re-reading is
 * safe because a breadcrumb that already became a trip carries its trip id and
 * is filtered out below.
 */
const BACKFILL_LOOKBACK_MS = 6 * 60 * 60 * 1000

/** Any real journey gets at least this far from where it started. */
const MIN_EXCURSION_METERS = 150

interface Fix {
  recordedAt: Date
  lat: number
  lon: number
  speedMps: number | null
}

interface Candidate extends Fix {
  id: number
  deviceId: string | null
}

type PlaceRow = { id: string; lat: number; lon: number; radiusMeters: number }

/**
 * A trip is a run of fixes from one device with no gap longer than
 * `tripIdleGapSeconds` that covers enough ground over enough time. Anything
 * smaller is someone walking around the house with GPS drift, and gets
 * discarded.
 *
 * Only points older than one idle gap are considered, so a journey still under
 * way is never cut in half and then re-detected as two trips.
 */
export async function detectTripsForUser(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const gapMs = DEFAULTS.tripIdleGapSeconds * 1000
  const settleBefore = new Date(now.getTime() - gapMs)

  const [presence] = await db
    .select({ processedUntil: userPresence.tripsProcessedUntil })
    .from(userPresence)
    .where(eq(userPresence.userId, userId))
    .limit(1)

  const since = presence?.processedUntil ?? new Date(0)
  const scanFrom = new Date(Math.max(0, since.getTime() - BACKFILL_LOOKBACK_MS))

  const rows = await db
    .select({
      id: locationPoints.id,
      deviceId: locationPoints.deviceId,
      recordedAt: locationPoints.recordedAt,
      lat: locationPoints.lat,
      lon: locationPoints.lon,
      speedMps: locationPoints.speedMps,
    })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        gt(locationPoints.recordedAt, scanFrom),
        lt(locationPoints.recordedAt, settleBefore),
        isNull(locationPoints.tripId),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(MAX_POINTS_PER_PASS)

  if (rows.length === 0) return 0

  // A full page was cut wherever the limit fell, so its newest fixes say
  // nothing about whether the device then went quiet. Close every segment in
  // it regardless: a run longer than one page would otherwise never close, the
  // watermark would never move, and this user's trips would stop for good. The
  // continuation joins the same trip on the next pass.
  const truncated = rows.length === MAX_POINTS_PER_PASS

  const placeRows = await placesVisibleTo(db, userId)

  let created = 0
  // The oldest segment still under way across the account's devices. The
  // watermark has to stop short of it, or the rest of that journey is never
  // read again.
  let openFrom: Date | null = null

  for (const [deviceId, points] of groupByDevice(rows)) {
    const segments = segmentByIdleGap(points, gapMs)
    const last = segments[segments.length - 1]!
    const lastIsClosed = truncated || (await hasGoneQuiet(db, userId, deviceId, last, gapMs, now))
    const closed = lastIsClosed ? segments : segments.slice(0, -1)

    for (const segment of closed) {
      if (await persistSegment(db, userId, deviceId, segment, placeRows, gapMs)) created += 1
    }

    if (!lastIsClosed) {
      const start = last[0]!.recordedAt
      if (!openFrom || start < openFrom) openFrom = start
    }
  }

  // Advance only past what actually settled. An open segment is re-read in
  // full next pass, so the watermark stops just before it.
  const watermark = openFrom ? new Date(openFrom.getTime() - 1) : rows[rows.length - 1]!.recordedAt
  if (watermark > since) await advanceWatermark(db, userId, watermark)
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

/**
 * One account can hold a session per device, and each of them uploads. Merged
 * into a single sequence, a tablet left at home teleports the driving phone's
 * path across town and back on every fix it sends, which multiplies the trip's
 * distance and its average speed.
 */
function groupByDevice(rows: Candidate[]): Map<string | null, Candidate[]> {
  const byDevice = new Map<string | null, Candidate[]>()
  for (const row of rows) {
    const bucket = byDevice.get(row.deviceId)
    if (bucket) bucket.push(row)
    else byDevice.set(row.deviceId, [row])
  }
  return byDevice
}

const deviceMatches = (deviceId: string | null) =>
  deviceId === null ? isNull(locationPoints.deviceId) : eq(locationPoints.deviceId, deviceId)

/**
 * The newest segment counts as closed only if this device has been quiet for a
 * full idle gap since. Otherwise the journey may still be under way, and
 * cutting it here would turn one drive into two trips.
 */
async function hasGoneQuiet(
  db: Database,
  userId: string,
  deviceId: string | null,
  segment: Candidate[],
  gapMs: number,
  now: Date,
): Promise<boolean> {
  const lastFixAt = segment[segment.length - 1]!.recordedAt
  const [newer] = await db
    .select({ recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        deviceMatches(deviceId),
        gt(locationPoints.recordedAt, lastFixAt),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(1)
  const quietSince = newer ? newer.recordedAt.getTime() : now.getTime()
  return quietSince - lastFixAt.getTime() > gapMs
}

async function persistSegment(
  db: Database,
  userId: string,
  deviceId: string | null,
  segment: Candidate[],
  placeRows: PlaceRow[],
  gapMs: number,
): Promise<boolean> {
  const first = segment[0]!

  // The head of this run may already be a trip. A device draining a backlog
  // hands us the rest of a journey after the sweep that closed it, and a run
  // long enough to fill a whole page is closed early on purpose. Growing that
  // trip keeps one drive one trip instead of cutting it at whichever boundary
  // the upload or the page limit happened to fall on.
  const previous = await lastTrippedPoint(db, userId, deviceId, first.recordedAt)
  if (previous && first.recordedAt.getTime() - previous.recordedAt.getTime() <= gapMs) {
    await extendTrip(db, previous.tripId, segment, placeRows)
    return false
  }

  if (segment.length < 3) return false

  const columns = tripColumns(segment, placeRows)
  const durationSeconds = (columns.endedAt.getTime() - columns.startedAt.getTime()) / 1000
  if (durationSeconds < DEFAULTS.tripMinDurationSeconds) return false
  if (columns.distanceMeters < DEFAULTS.tripMinDistanceMeters) return false

  // A loop back to its own start is still a trip, but a jittery stationary
  // phone is not. Path length from noise grows with the number of samples, so
  // a limit on it is really a limit on how densely the phone reported. How far
  // the phone ever got from where it started does not grow with sampling.
  if (excursionMeters(segment) < MIN_EXCURSION_METERS) return false

  const [trip] = await db
    .insert(trips)
    .values({ userId, ...columns })
    .returning({ id: trips.id })

  if (!trip) return false

  await claimPoints(db, trip.id, segment)
  return true
}

/** The last breadcrumb from this device that already belongs to a trip. */
async function lastTrippedPoint(
  db: Database,
  userId: string,
  deviceId: string | null,
  before: Date,
): Promise<{ tripId: string; recordedAt: Date } | null> {
  const [row] = await db
    .select({ tripId: locationPoints.tripId, recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        deviceMatches(deviceId),
        lt(locationPoints.recordedAt, before),
        isNotNull(locationPoints.tripId),
      ),
    )
    .orderBy(desc(locationPoints.recordedAt))
    .limit(1)
  return row?.tripId ? { tripId: row.tripId, recordedAt: row.recordedAt } : null
}

async function extendTrip(
  db: Database,
  tripId: string,
  segment: Candidate[],
  placeRows: PlaceRow[],
): Promise<void> {
  await claimPoints(db, tripId, segment)

  // Recompute from every breadcrumb the trip now owns rather than patching the
  // stored totals, so the summary matches the path the detail screen draws.
  const points = await db
    .select({
      recordedAt: locationPoints.recordedAt,
      lat: locationPoints.lat,
      lon: locationPoints.lon,
      speedMps: locationPoints.speedMps,
    })
    .from(locationPoints)
    .where(eq(locationPoints.tripId, tripId))
    .orderBy(asc(locationPoints.recordedAt))
  if (points.length === 0) return

  await db.update(trips).set(tripColumns(points, placeRows)).where(eq(trips.id, tripId))
}

async function claimPoints(db: Database, tripId: string, segment: Candidate[]): Promise<void> {
  await db
    .update(locationPoints)
    .set({ tripId })
    .where(
      inArray(
        locationPoints.id,
        segment.map((p) => p.id),
      ),
    )
}

function tripColumns(points: Fix[], placeRows: PlaceRow[]) {
  const first = points[0]!
  const last = points[points.length - 1]!
  const distance = pathDistanceMeters(points.map((p) => ({ lat: p.lat, lon: p.lon })))
  const durationSeconds = (last.recordedAt.getTime() - first.recordedAt.getTime()) / 1000

  return {
    startedAt: first.recordedAt,
    endedAt: last.recordedAt,
    distanceMeters: Math.round(distance),
    maxSpeedMps: confirmedMaxSpeedMps(points),
    avgSpeedMps: durationSeconds > 0 ? distance / durationSeconds : null,
    pointCount: points.length,
    startLat: first.lat,
    startLon: first.lon,
    endLat: last.lat,
    endLon: last.lon,
    startPlaceId: placeContaining(placeRows, first) ?? null,
    endPlaceId: placeContaining(placeRows, last) ?? null,
  }
}

/**
 * A single sample is not evidence: a provider switch emits one impossible
 * velocity, and this number is shown on every trip card. Report the fastest
 * speed two consecutive fixes agree on, the same confirmation the speed alert
 * waits for before it fires.
 */
function confirmedMaxSpeedMps(points: Fix[]): number | null {
  let confirmed: number | null = null
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1]!.speedMps
    const current = points[i]!.speedMps
    if (previous == null || current == null) continue
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue
    const agreed = Math.min(previous, current)
    if (confirmed === null || agreed > confirmed) confirmed = agreed
  }
  return confirmed
}

/** The furthest any fix in the segment got from where the segment started. */
function excursionMeters(points: Fix[]): number {
  const first = points[0]!
  let farthest = 0
  for (const point of points) {
    const distance = haversineMeters(first, point)
    if (distance > farthest) farthest = distance
  }
  return farthest
}

function placeContaining(placeRows: PlaceRow[], point: { lat: number; lon: number }) {
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
