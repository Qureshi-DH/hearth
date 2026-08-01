import { DEFAULTS, haversineMeters, pathDistanceMeters, type FeedEvent } from "@hearth/shared"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import {
  circleMembers,
  circles,
  locationPoints,
  places,
  trips,
  userPresence,
  users,
} from "../db/schema"
import { broadcastEvent, recordEvent } from "./feed"
import { effectiveSharingState } from "./presence"

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

/**
 * How long after a breadcrumb lands the detector still owes it a pass. A day
 * out of signal drains a queue recorded far below the lookback above, so the
 * floor has to drop to reach it, and `received_at` is what separates those
 * breadcrumbs from the old ones this user has already been scanned on.
 * Generous on purpose: a restart between the upload and the next sweep must
 * not be able to swallow the drive.
 */
const BACKFILL_ARRIVAL_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Ingest refuses fixes older than this, so nothing below it can be a late
 * arrival and the probe for one never grows with the retention window.
 */
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How recently a journey has to have ended for finishing it to be worth a
 * buzz. The feed line is always written, dated when the drive actually ended,
 * but a phone that comes back on Wi-Fi hands over a whole day at once, and
 * "Aisha travelled 12 km" about yesterday's commute is the false alarm that
 * costs the family's trust. Comfortably wider than one idle gap plus a sweep
 * interval, so an ordinary drive still announces itself.
 */
const TRIP_PUSH_FRESHNESS_MS = 60 * 60 * 1000

/** Any real journey gets at least this far from where it started. */
const MIN_EXCURSION_METERS = 150

/**
 * How far apart two fixes across a silence have to be, when neither is at a
 * named place, before the silence reads as travel rather than a stop. Well
 * beyond the stop radius and any accuracy the ingest accepts.
 */
const MIN_BRIDGED_DISTANCE_METERS = DEFAULTS.tripMinDistanceMeters

/**
 * A fix at one place and the next at another, hours apart, says nothing
 * about when the phone moved. Closer to walking pace across the silence, it
 * says the phone went straight there.
 */
const MIN_BRIDGED_PACE_MPS = 1

/**
 * How far apart two receivers riding in one vehicle can look at the same
 * instant. Wide enough for a sparse sampler interpolated across a bend and for
 * the seconds of clock skew between two handsets, far tighter than the gap
 * between two people who merely happened to be moving at the same time.
 */
const SAME_JOURNEY_TOLERANCE_METERS = 250

/** How much of a run has to sit on a recorded path to be the same journey. */
const SAME_JOURNEY_AGREEMENT = 0.8

/** And how much of the run has to fall inside that journey's window at all. */
const SAME_JOURNEY_OVERLAP = 0.6

interface Fix {
  recordedAt: Date
  lat: number
  lon: number
  speedMps: number | null
}

/** Where a device was, without the extras a trip's totals are built from. */
type Trace = Pick<Fix, "recordedAt" | "lat" | "lon">

interface Candidate extends Fix {
  id: number
  deviceId: string | null
}

interface PlaceRow {
  id: string
  circleId: string
  name: string
  lat: number
  lon: number
  radiusMeters: number
}

/** A frame the caller sends once the transaction it holds has committed. */
export interface PendingBroadcast {
  circleId: string
  event: FeedEvent
}

/** Who may be told a journey finished, and the name to tell them. */
interface Audience {
  name: string
  circleIds: string[]
}

/** What one detection pass needs beyond the breadcrumbs themselves. */
interface Pass {
  userId: string
  now: Date
  gapMs: number
  places: PlaceRow[]
  /** Read on the first trip of the pass, so a quiet pass costs no queries. */
  audience: () => Promise<Audience>
  broadcasts: PendingBroadcast[]
}

type TripColumns = ReturnType<typeof tripColumns>

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
  /**
   * Where to leave the websocket frames for the journeys this pass announced.
   * The sweep calls this inside a transaction it commits afterwards, and a
   * publish cannot be unsent, so a caller holding one passes an array and
   * flushes it after the commit. Without one the frames go out here.
   */
  deferred?: PendingBroadcast[],
): Promise<number> {
  const gapMs = DEFAULTS.tripIdleGapSeconds * 1000
  const settleBefore = new Date(now.getTime() - gapMs)

  const [presence] = await db
    .select({ processedUntil: userPresence.tripsProcessedUntil })
    .from(userPresence)
    .where(eq(userPresence.userId, userId))
    .limit(1)

  const since = presence?.processedUntil ?? new Date(0)
  const scanFrom = await scanFloor(db, userId, since, now)

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
        notHeartbeat(),
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

  let audience: Promise<Audience> | null = null
  const pass: Pass = {
    userId,
    now,
    gapMs,
    places: await placesVisibleTo(db, userId),
    audience: () => (audience ??= loadAudience(db, userId, now)),
    broadcasts: [],
  }

  let created = 0
  // The oldest segment still under way across the account's devices. The
  // watermark has to stop short of it, or the rest of that journey is never
  // read again.
  let openFrom: Date | null = null

  // Silence between two fixes is a stop only if the phone was where it had
  // been. A fix at the door and the next, ten minutes later, a kilometre
  // away at a pace a person could have kept is a journey the tracker did not
  // narrate, and the same goes for two named places however near. A parked
  // phone that drifted a street over an hour has not travelled. And a
  // silence with another journey's fixes inside it, which this pass does not
  // read because they are already filed, is not a silence at all.
  const filed = await filedTimes(db, userId, scanFrom, settleBefore)
  const bridges = (from: Candidate, to: Candidate) => {
    const seconds = (to.recordedAt.getTime() - from.recordedAt.getTime()) / 1000
    if (seconds <= 0) return false
    const metres = haversineMeters(from, to)
    if (metres / seconds < MIN_BRIDGED_PACE_MPS) return false
    if (filedBetween(filed.get(from.deviceId), from.recordedAt, to.recordedAt)) return false
    const origin = placeContaining(pass.places, from)
    const destination = placeContaining(pass.places, to)
    if (origin && destination && origin !== destination) return true
    return metres >= MIN_BRIDGED_DISTANCE_METERS
  }

  for (const [deviceId, points] of groupByDevice(rows)) {
    const runs = segmentByStops(points, gapMs, DEFAULTS.tripStopRadiusMeters, bridges)
    const last = runs[runs.length - 1]!
    const lastIsClosed =
      truncated ||
      last.closedByStop ||
      (await hasGoneQuiet(db, userId, deviceId, last.points, gapMs, now))
    const closed = lastIsClosed ? runs : runs.slice(0, -1)

    for (const run of closed) {
      if (await persistSegment(db, pass, deviceId, run.points)) created += 1
    }

    if (!lastIsClosed) {
      const start = last.points[0]!.recordedAt
      if (!openFrom || start < openFrom) openFrom = start
    }
  }

  // Advance only past what actually settled. An open segment is re-read in
  // full next pass, so the watermark stops just before it.
  const watermark = openFrom ? new Date(openFrom.getTime() - 1) : rows[rows.length - 1]!.recordedAt
  if (watermark > since) await advanceWatermark(db, userId, watermark)

  if (deferred) deferred.push(...pass.broadcasts)
  else for (const pending of pass.broadcasts) await broadcastEvent(pending.circleId, pending.event)

  return created
}

/**
 * Where this pass starts reading. One lookback behind the watermark normally,
 * but a phone that was out of signal hands over breadcrumbs recorded far below
 * that, and the watermark only ever moves forward, so the floor drops to the
 * oldest of those instead. `received_at` is what tells the two apart: a fix
 * recorded yesterday and received today has never been offered a pass, while
 * one received when it was recorded has already been judged and is left alone.
 */
async function scanFloor(db: Database, userId: string, since: Date, now: Date): Promise<Date> {
  const floor = new Date(Math.max(0, since.getTime() - BACKFILL_LOOKBACK_MS))

  const [late] = await db
    .select({ recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        isNull(locationPoints.tripId),
        lte(locationPoints.recordedAt, floor),
        gt(locationPoints.recordedAt, new Date(now.getTime() - MAX_BACKDATE_MS)),
        gt(locationPoints.receivedAt, new Date(now.getTime() - BACKFILL_ARRIVAL_WINDOW_MS)),
        notHeartbeat(),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(1)

  if (!late) return floor
  // The scan's lower bound is exclusive, so step back off the fix itself.
  return new Date(late.recordedAt.getTime() - 1)
}

/** A run of fixes and whether the rows themselves show it ended. */
export interface Run {
  points: Candidate[]
  /**
   * The run was followed, in these rows, by a gap longer than the idle gap or
   * by the phone staying inside the stop radius for longer than it. Either is
   * the journey over, whatever came after. A run without this may still be
   * under way and is judged by hasGoneQuiet.
   */
  closedByStop: boolean
}

/**
 * Splits breadcrumbs into journeys. A gap longer than the idle gap is one
 * boundary; the other is a stop the phone kept reporting from. A phone that
 * arrives somewhere and goes on delivering a fix every few minutes from the
 * same spot used to hold the run open all day, so the morning's drive to work
 * and the evening's drive home came out as one trip. Now a stretch of fixes
 * inside the stop radius for longer than the idle gap ends the journey at its
 * first fix, the fixes inside the stop belong to no journey, and the next
 * journey starts with the first fix that leaves it.
 */
export function segmentByStops(
  points: Candidate[],
  gapMs: number,
  stopRadiusMeters: number,
  /**
   * Whether a gap between two fixes is a journey the phone kept to itself
   * rather than a stop: a fix at the door and the next one, ten minutes
   * later, at a friend's door. The caller knows the places.
   */
  bridges: (from: Candidate, to: Candidate) => boolean = () => false,
): Run[] {
  const runs: Run[] = []
  let current: Candidate[] = []
  let i = 0

  while (i < points.length) {
    const point = points[i]!
    const previous = current[current.length - 1]
    if (previous && point.recordedAt.getTime() - previous.recordedAt.getTime() > gapMs) {
      // Silence ends a journey unless the fix after it shows the phone kept
      // travelling through it, which is the caller's call to make.
      if (!bridges(previous, point)) {
        runs.push({ points: current, closedByStop: true })
        current = []
      }
    }
    current.push(point)

    // How long the phone then stayed within the stop radius of this fix,
    // reporting all the while. A fix from the same spot after a gap is a
    // gap, and the gap is its own boundary.
    let j = i + 1
    while (
      j < points.length &&
      points[j]!.recordedAt.getTime() - points[j - 1]!.recordedAt.getTime() <= gapMs &&
      haversineMeters(point, points[j]!) <= stopRadiusMeters
    ) {
      j += 1
    }
    const stayedMs = points[j - 1]!.recordedAt.getTime() - point.recordedAt.getTime()
    if (j - 1 > i && stayedMs > gapMs) {
      // The journey ends with the fix that arrived. The last fix inside the
      // stop is the one that left, and it begins the next journey.
      runs.push({ points: current, closedByStop: true })
      current = []
      i = j - 1
      continue
    }
    i += 1
  }
  if (current.length > 0) runs.push({ points: current, closedByStop: false })
  return runs
}

/** @deprecated kept for the tests that grew up on it; segmentByStops is the detector's. */
export function segmentByIdleGap(points: Candidate[], gapMs: number): Candidate[][] {
  return segmentByStops(points, gapMs, Infinity).map((run) => run.points)
}

/**
 * One account can hold a session per device, and each of them uploads. Merged
 * into a single sequence, a tablet left at home teleports the driving phone's
 * path across town and back on every fix it sends, which multiplies the trip's
 * distance and its average speed.
 */
function groupByDevice(rows: Candidate[]): Array<[string | null, Candidate[]]> {
  const byDevice = new Map<string | null, Candidate[]>()
  for (const row of rows) {
    const bucket = byDevice.get(row.deviceId)
    if (bucket) bucket.push(row)
    else byDevice.set(row.deviceId, [row])
  }
  // Densest reporter first, so when two devices rode along together the copy
  // that becomes the trip is the better sampled one. The sort is stable, so
  // devices that reported equally often keep earliest-fix-first order.
  return [...byDevice].sort((a, b) => b[1].length - a[1].length)
}

const deviceMatches = (deviceId: string | null) =>
  deviceId === null ? isNull(locationPoints.deviceId) : eq(locationPoints.deviceId, deviceId)

/**
 * A parked phone with the app open reports on a timer. Those fixes say the
 * phone is still there, not that it is going anywhere, so they must neither
 * extend a trip nor keep it from closing: read as candidates they would pad a
 * drive with stationary points, and read as "still reporting" they would hold
 * the idle gap open for as long as the app stayed on screen.
 */
const notHeartbeat = () => ne(locationPoints.source, "heartbeat")

/**
 * The newest segment counts as closed only if this device has been quiet for a
 * full idle gap since. Otherwise the journey may still be under way, and
 * cutting it here would turn one drive into two trips.
 *
 * Breadcrumbs that already belong to a trip do not count as reporting. A
 * retried upload lands the START of a drive whose remainder is already a trip,
 * and treating the fixes on the far side of it as "still to come" holds that
 * segment open on every pass, so it is never merged into the trip it belongs
 * to and its breadcrumbs belong to nothing for good.
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
        isNull(locationPoints.tripId),
        notHeartbeat(),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(1)
  const quietSince = newer ? newer.recordedAt.getTime() : now.getTime()
  return quietSince - lastFixAt.getTime() > gapMs
}

async function persistSegment(
  db: Database,
  pass: Pass,
  deviceId: string | null,
  segment: Candidate[],
): Promise<boolean> {
  const first = segment[0]!
  const last = segment[segment.length - 1]!

  // The head of this run may already be a trip. A device draining a backlog
  // hands us the rest of a journey after the sweep that closed it, and a run
  // long enough to fill a whole page is closed early on purpose. Growing that
  // trip keeps one drive one trip instead of cutting it at whichever boundary
  // the upload or the page limit happened to fall on.
  const previous = await lastTrippedPoint(db, pass.userId, deviceId, first.recordedAt)
  const joinsPrevious =
    previous && first.recordedAt.getTime() - previous.recordedAt.getTime() <= pass.gapMs

  // And so may its tail. The upload holding the first half of a drive can fail
  // while the batches behind it get through, so the retry has to find the trip
  // that already owns the rest of the journey rather than file the beginning
  // of it as a second one.
  const next = await firstTrippedPoint(db, pass.userId, deviceId, last.recordedAt)
  const joinsNext = next && next.recordedAt.getTime() - last.recordedAt.getTime() <= pass.gapMs

  if (joinsPrevious && joinsNext && previous.tripId !== next.tripId) {
    // This run closes the gap between two trips, so by the same idle gap that
    // decides every other boundary the three of them are one journey.
    await absorbTrip(db, pass, previous.tripId, next.tripId, segment)
    return false
  }
  if (joinsPrevious) {
    await extendTrip(db, pass, previous.tripId, segment)
    return false
  }
  if (joinsNext) {
    await extendTrip(db, pass, next.tripId, segment)
    return false
  }

  const columns = tripColumns(segment, pass.places)
  // Three fixes make a path. Two make one only when each is inside a place
  // the family named, and not the same one: a phone that reported at the
  // door and again at a friend's has been somewhere, however little it said
  // on the way.
  const placeToPlace =
    columns.startPlaceId != null &&
    columns.endPlaceId != null &&
    columns.startPlaceId !== columns.endPlaceId
  if (segment.length < 3 && !(segment.length === 2 && placeToPlace)) return false

  const durationSeconds = (columns.endedAt.getTime() - columns.startedAt.getTime()) / 1000
  if (durationSeconds < DEFAULTS.tripMinDurationSeconds) return false
  if (columns.distanceMeters < DEFAULTS.tripMinDistanceMeters) return false

  // A loop back to its own start is still a trip, but a jittery stationary
  // phone is not. Path length from noise grows with the number of samples, so
  // a limit on it is really a limit on how densely the phone reported. How far
  // the phone ever got from where it started does not grow with sampling.
  if (excursionMeters(segment) < MIN_EXCURSION_METERS) return false

  // An afternoon pottering about a large garden clears everything above too:
  // the path grows with every wander and the excursion can pass 150 m inside
  // a place drawn 200 m wide. A journey that starts inside a place has to
  // leave it. A walk to a friend's house is a journey; a walk to the shed is
  // not.
  if (!leavesStartPlace(segment, pass.places)) return false

  // A phone in the cradle and a tablet in the footwell both report the drive
  // they shared, and one journey is one line in the history. The second copy
  // is left as breadcrumbs rather than filed as a journey of its own.
  if (await duplicatesRecordedJourney(db, pass.userId, segment)) return false

  const [trip] = await db
    .insert(trips)
    .values({ userId: pass.userId, ...columns })
    .returning({ id: trips.id })

  if (!trip) return false

  await claimPoints(db, trip.id, segment)
  // Only here, never on the two merge paths above. A trip that grows when a
  // straggler lands has already been announced, and one drive is one line.
  await announceTrip(db, pass, columns)
  return true
}

/** When each device's already filed fixes in the window were recorded, oldest first. */
async function filedTimes(
  db: Database,
  userId: string,
  after: Date,
  before: Date,
): Promise<Map<string | null, number[]>> {
  const rows = await db
    .select({ deviceId: locationPoints.deviceId, recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        gt(locationPoints.recordedAt, after),
        lt(locationPoints.recordedAt, before),
        isNotNull(locationPoints.tripId),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(MAX_POINTS_PER_PASS)
  const byDevice = new Map<string | null, number[]>()
  for (const row of rows) {
    const bucket = byDevice.get(row.deviceId)
    if (bucket) bucket.push(row.recordedAt.getTime())
    else byDevice.set(row.deviceId, [row.recordedAt.getTime()])
  }
  return byDevice
}

function filedBetween(times: number[] | undefined, from: Date, to: Date): boolean {
  if (!times) return false
  let low = 0
  let high = times.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (times[mid]! <= from.getTime()) low = mid + 1
    else high = mid
  }
  return low < times.length && times[low]! < to.getTime()
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

/** The first breadcrumb from this device, after `after`, that belongs to a trip. */
async function firstTrippedPoint(
  db: Database,
  userId: string,
  deviceId: string | null,
  after: Date,
): Promise<{ tripId: string; recordedAt: Date } | null> {
  const [row] = await db
    .select({ tripId: locationPoints.tripId, recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        deviceMatches(deviceId),
        gt(locationPoints.recordedAt, after),
        isNotNull(locationPoints.tripId),
      ),
    )
    .orderBy(asc(locationPoints.recordedAt))
    .limit(1)
  return row?.tripId ? { tripId: row.tripId, recordedAt: row.recordedAt } : null
}

async function extendTrip(
  db: Database,
  pass: Pass,
  tripId: string,
  segment: Candidate[],
): Promise<void> {
  await claimPoints(db, tripId, segment)
  await recomputeTrip(db, pass, tripId)
}

/**
 * Folds `victim` into `target` and drops it. The breadcrumbs move first, so a
 * pass interrupted between the two statements leaves every fix on a trip that
 * exists rather than on one that does not.
 */
async function absorbTrip(
  db: Database,
  pass: Pass,
  targetId: string,
  victimId: string,
  segment: Candidate[],
): Promise<void> {
  await claimPoints(db, targetId, segment)
  await db
    .update(locationPoints)
    .set({ tripId: targetId })
    .where(and(eq(locationPoints.userId, pass.userId), eq(locationPoints.tripId, victimId)))
  await db.delete(trips).where(eq(trips.id, victimId))
  await recomputeTrip(db, pass, targetId)
}

/**
 * Recompute from every breadcrumb the trip now owns rather than patching the
 * stored totals, so the summary matches the path the detail screen draws.
 */
async function recomputeTrip(db: Database, pass: Pass, tripId: string): Promise<void> {
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

  await db.update(trips).set(tripColumns(points, pass.places)).where(eq(trips.id, tripId))
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

/**
 * Tells the circles that may hear it that a journey finished.
 *
 * A distance, a top speed and "Home to School" are all things derived from
 * where somebody was, so this goes only to circles they currently share
 * precisely with, and only where the circle keeps history at all. The places
 * are resolved against that circle's own, or the line would name somewhere
 * defined in a circle these members cannot see.
 */
async function announceTrip(db: Database, pass: Pass, columns: TripColumns): Promise<void> {
  const audience = await pass.audience()
  if (audience.circleIds.length === 0) return

  // Pushing a drive that finished hours ago would announce a backlog as if it
  // were happening now. The feed still gets the line, dated when it happened.
  const fresh = pass.now.getTime() - columns.endedAt.getTime() < TRIP_PUSH_FRESHNESS_MS

  for (const circleId of audience.circleIds) {
    const from = placeNameIn(pass.places, circleId, {
      lat: columns.startLat,
      lon: columns.startLon,
    })
    const to = placeNameIn(pass.places, circleId, { lat: columns.endLat, lon: columns.endLon })
    const summary = tripSummary(audience.name, columns.distanceMeters, from, to)

    const event = await recordEvent(db, {
      circleId,
      type: "trip_completed",
      actorUserId: pass.userId,
      occurredAt: columns.endedAt,
      deferBroadcast: true,
      payload: {
        distanceMeters: columns.distanceMeters,
        durationSeconds: Math.max(
          0,
          Math.round((columns.endedAt.getTime() - columns.startedAt.getTime()) / 1000),
        ),
        startPlaceName: from,
        endPlaceName: to,
        endedAt: columns.endedAt.toISOString(),
      },
      summary,
      notify: fresh ? { title: "Trip finished", body: `${summary}.` } : undefined,
    })
    pass.broadcasts.push({ circleId, event })
  }
}

function tripSummary(
  name: string,
  distanceMeters: number,
  from: string | null,
  to: string | null,
): string {
  const distance =
    distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${distanceMeters} m`
  if (from && to) return `${name} travelled ${distance} from ${from} to ${to}`
  if (to) return `${name} travelled ${distance} to ${to}`
  if (from) return `${name} travelled ${distance} from ${from}`
  return `${name} travelled ${distance}`
}

async function loadAudience(db: Database, userId: string, now: Date): Promise<Audience> {
  const [actor] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const rows = await db
    .select({
      circleId: circleMembers.circleId,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      resumeToState: circleMembers.resumeToState,
      settings: circles.settings,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(eq(circleMembers.userId, userId))

  return {
    name: actor?.displayName ?? "Someone",
    circleIds: rows
      .filter(
        (row) =>
          row.settings.allowHistory &&
          effectiveSharingState(row.sharingState, row.pausedUntil, now, row.resumeToState) ===
            "precise",
      )
      .map((row) => row.circleId),
  }
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

/**
 * Whether this run is a second device's copy of a journey already on record.
 *
 * Time overlap alone would be wrong: a phone in a car and a tablet somebody
 * else took on a bus move at the same moment and are two journeys. So the run
 * is compared against where the recorded journey actually was at each of these
 * instants, and only a run that travelled with it counts as the same drive.
 */
async function duplicatesRecordedJourney(
  db: Database,
  userId: string,
  segment: Candidate[],
): Promise<boolean> {
  const first = segment[0]!
  const last = segment[segment.length - 1]!
  const spanMs = last.recordedAt.getTime() - first.recordedAt.getTime()

  const overlapping = await db
    .select({ id: trips.id, startedAt: trips.startedAt, endedAt: trips.endedAt })
    .from(trips)
    .where(
      and(
        eq(trips.userId, userId),
        lt(trips.startedAt, last.recordedAt),
        gt(trips.endedAt, first.recordedAt),
      ),
    )

  for (const trip of overlapping) {
    const shared =
      Math.min(last.recordedAt.getTime(), trip.endedAt.getTime()) -
      Math.max(first.recordedAt.getTime(), trip.startedAt.getTime())
    // A brush past the end of an earlier drive is a different journey, however
    // close the two happened to pass.
    if (spanMs > 0 && shared / spanMs < SAME_JOURNEY_OVERLAP) continue

    const path = await db
      .select({
        recordedAt: locationPoints.recordedAt,
        lat: locationPoints.lat,
        lon: locationPoints.lon,
      })
      .from(locationPoints)
      .where(eq(locationPoints.tripId, trip.id))
      .orderBy(asc(locationPoints.recordedAt))

    if (rodeAlong(segment, path)) return true
  }

  return false
}

/**
 * Whether these fixes sit on that path at the same instants. Each one is
 * measured against where the path was between the two fixes either side of it,
 * not against the nearest recorded fix: two receivers in one car sample on
 * their own schedules, and at motorway speed the nearest recorded fix can be
 * half a sampling interval down the road.
 */
function rodeAlong(segment: Candidate[], path: Trace[]): boolean {
  if (path.length < 2) return false
  const from = path[0]!.recordedAt.getTime()
  const to = path[path.length - 1]!.recordedAt.getTime()

  let bracket = 0
  let compared = 0
  let agreed = 0

  for (const fix of segment) {
    const at = fix.recordedAt.getTime()
    if (at < from || at > to) continue
    while (bracket + 2 < path.length && path[bracket + 1]!.recordedAt.getTime() < at) bracket += 1
    compared += 1
    const where = positionBetween(path[bracket]!, path[bracket + 1]!, at)
    if (haversineMeters(fix, where) <= SAME_JOURNEY_TOLERANCE_METERS) agreed += 1
  }

  if (compared < 3) return false
  return agreed / compared >= SAME_JOURNEY_AGREEMENT
}

function positionBetween(from: Trace, to: Trace, atMs: number): { lat: number; lon: number } {
  const span = to.recordedAt.getTime() - from.recordedAt.getTime()
  const travelled =
    span > 0 ? Math.min(1, Math.max(0, (atMs - from.recordedAt.getTime()) / span)) : 0
  return {
    lat: from.lat + (to.lat - from.lat) * travelled,
    lon: from.lon + (to.lon - from.lon) * travelled,
  }
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

/**
 * Whether a run that began inside a place ever got clear of it. The buffer
 * is the one the arrival detector uses on the way out, so a run the feed
 * never called "left" cannot be filed as a trip either.
 */
function leavesStartPlace(points: Fix[], placeRows: PlaceRow[]): boolean {
  const first = points[0]!
  const startPlaceId = placeContaining(placeRows, first)
  if (!startPlaceId) return true
  const place = placeRows.find((row) => row.id === startPlaceId)
  if (!place) return true
  const clear = place.radiusMeters + DEFAULTS.geofenceExitBufferMeters
  return points.some((point) => haversineMeters(point, { lat: place.lat, lon: place.lon }) > clear)
}

function placeContaining(placeRows: PlaceRow[], point: { lat: number; lon: number }) {
  for (const place of placeRows) {
    if (haversineMeters(point, { lat: place.lat, lon: place.lon }) <= place.radiusMeters) {
      return place.id
    }
  }
  return undefined
}

function placeNameIn(
  placeRows: PlaceRow[],
  circleId: string,
  point: { lat: number; lon: number },
): string | null {
  for (const place of placeRows) {
    if (place.circleId !== circleId) continue
    if (haversineMeters(point, { lat: place.lat, lon: place.lon }) <= place.radiusMeters) {
      return place.name
    }
  }
  return null
}

async function placesVisibleTo(db: Database, userId: string) {
  return db
    .select({
      id: places.id,
      circleId: places.circleId,
      name: places.name,
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
