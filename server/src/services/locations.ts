import {
  DEFAULTS,
  activityFromSpeed,
  agreedMaxSpeedMps,
  agreedSpeedMps,
  haversineMeters,
  isValidLatLng,
  plausibleActivity,
  type ActivityType,
  type LocationFixInput,
  type LocationSource,
} from "@hearth/shared"
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import {
  circleMembers,
  circles,
  events,
  locationPoints,
  userPresence,
  users,
  type CircleSettingsJson,
} from "../db/schema"
import { circleTopic } from "../lib/bus"
import { getBus } from "../runtime"
import { recordEvent } from "./feed"
import { evaluateGeofenceBatch } from "./geofence"
import { phoneGroup } from "./notification-groups"
import { effectiveSharingState, loadRawPresenceByCircle, preciseSinceOnLapse } from "./presence"

/** Fixes older than this are almost certainly a buggy client clock. */
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000
/** Small tolerance for devices whose clock runs slightly fast. */
const MAX_FUTURE_MS = 5 * 60 * 1000
const LOW_BATTERY_COOLDOWN_MS = 6 * 60 * 60 * 1000
const INCIDENT_COOLDOWN_MS = 60 * 60 * 1000
/**
 * The stop counts as sudden only if the last fix that was still moving was
 * doing more than this. Every ordinary journey ends with a crawl onto a drive
 * or up to a drive-through window, and a stop that follows one of those
 * happened over the minute before, not in the gap the alert would blame.
 */
const INCIDENT_MOVING_AT_STOP_MPS = 2
/**
 * The same bar, raised, for a stop whose stillness rests entirely on fixes too
 * coarse to place someone inside a city block. Nothing there can show the car
 * stayed put, only that nobody can prove it moved, so the story has to be
 * crash shaped on its own: still at road speed at the last measurement anyone
 * has, and then nothing. A car that had already slowed to the speed of a ramp
 * or a car park before its fixes went dark is a car arriving somewhere.
 */
const INCIDENT_MOVING_AT_COARSE_STOP_MPS = DEFAULTS.incidentMinSpeedMps
/** Bounds the window read. The tracker's 30 s cadence fills 300 s with ten. */
const INCIDENT_WINDOW_MAX_FIXES = 200
/** Bounds the read of the run so far. Two consecutive fixes make a run. */
const SPEED_RUN_MAX_PRIOR_FIXES = 200

/**
 * How the phone itself said the member was travelling. The activity recogniser
 * is the only thing that can tell a bike from a car at 60 km/h, and a family
 * reading "driving" about a teenager on Park Street is being told something
 * that is not true. Anything else, including a label the OS never made up its
 * mind about, is reported as driving.
 */
const TRAVEL_VERBS: Partial<Record<ActivityType, string>> = {
  walking: "walking",
  running: "running",
  cycling: "cycling",
  driving: "driving",
}

export interface IngestOptions {
  userId: string
  /** Also the dedupe key, which is why it is never optional. */
  deviceId: string
  points: LocationFixInput[]
  now?: Date
}

export interface IngestResult {
  accepted: number
  rejected: number
  placeEvents: number
}

interface AlertCircle {
  id: string
  settings: CircleSettingsJson
}

/** The alert bookkeeping as it stood before this batch touched presence. */
interface AlertPresence {
  recordedAt: Date | null
  incidentFlaggedAt: Date | null
  lowBatteryNotifiedAt: Date | null
  lowBatteryNotifiedLevel: number | null
}

/** What a speeding run is judged on, from history or from a batch. */
interface RunFix {
  recordedAt: Date
  lat: number
  lon: number
  accuracyMeters: number | null
  speedMps: number | null
  activity: ActivityType | null
}

interface NormalizedFix {
  recordedAt: Date
  lat: number
  lon: number
  accuracyMeters: number | null
  altitudeMeters: number | null
  altitudeAccuracyMeters: number | null
  speedMps: number | null
  headingDegrees: number | null
  activity: ActivityType
  batteryLevel: number | null
  isCharging: boolean | null
  isMoving: boolean | null
  source: LocationSource
}

function normalize(input: LocationFixInput, now: Date): NormalizedFix | null {
  if (!isValidLatLng({ lat: input.lat, lon: input.lon })) return null

  const recordedAt = new Date(input.recordedAt)
  if (Number.isNaN(recordedAt.getTime())) return null
  const delta = recordedAt.getTime() - now.getTime()
  if (delta > MAX_FUTURE_MS) return null
  if (-delta > MAX_BACKDATE_MS) return null

  // Every column this feeds is a Postgres `real`, and a double too small for
  // float32 (5e-324, 1e-300, either sign) is finite and inside the bounds yet
  // still "out of range for type real" on insert, which loses the whole batch
  // over one sentinel field. It lands as the zero the column would have held.
  // Everything else keeps its full precision: rounding the lot to float32 would
  // put a battery reading of exactly 15% a hair above the threshold it means to
  // equal, and the alert that threshold exists for would never fire.
  const clampFinite = (value: number | null | undefined, min: number, max: number) => {
    if (value == null || !Number.isFinite(value)) return null
    const clamped = Math.min(max, Math.max(min, value))
    return Math.fround(clamped) === 0 ? 0 : clamped
  }

  const speedMps = clampFinite(input.speedMps, 0, 400)

  return {
    recordedAt,
    lat: input.lat,
    lon: input.lon,
    accuracyMeters: clampFinite(input.accuracyMeters, 0, 100_000),
    altitudeMeters: clampFinite(input.altitudeMeters, -12_000, 100_000),
    altitudeAccuracyMeters: clampFinite(input.altitudeAccuracyMeters, 0, 100_000),
    speedMps,
    headingDegrees: clampFinite(input.headingDegrees, 0, 360),
    activity: input.activity ?? activityFromSpeed(speedMps),
    batteryLevel: clampFinite(input.batteryLevel, 0, 1),
    isCharging: input.isCharging ?? null,
    isMoving: input.isMoving ?? null,
    source: input.source ?? "background",
  }
}

/**
 * The phone spoke. Recorded before anything is judged about what it said, so
 * a batch that is old, a duplicate or rejected outright still proves the
 * phone is alive, and every wake it was owed counts as answered.
 */
export async function markHeard(db: Database, userId: string, now: Date): Promise<void> {
  await db
    .insert(userPresence)
    .values({ userId, lastHeardAt: now, wakeCount: 0 })
    .onConflictDoUpdate({
      target: userPresence.userId,
      set: { lastHeardAt: now, wakeCount: 0 },
    })
}

/**
 * Order matters here. History insert first, then the presence snapshot, then
 * the geofence replay, the alerts, and the websocket fan-out. Everything after
 * the insert can fail without corrupting history.
 */
export async function ingestPoints(db: Database, options: IngestOptions): Promise<IngestResult> {
  const now = options.now ?? new Date()
  const normalized: NormalizedFix[] = []
  let rejected = 0

  for (const raw of options.points.slice(0, DEFAULTS.maxLocationBatchSize)) {
    const fix = normalize(raw, now)
    if (fix) normalized.push(fix)
    else rejected += 1
  }
  rejected += Math.max(0, options.points.length - DEFAULTS.maxLocationBatchSize)

  if (normalized.length === 0) return { accepted: 0, rejected, placeEvents: 0 }

  normalized.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())

  // Collapse duplicate timestamps from the same device before the unique index
  // sees them. ON CONFLICT cannot resolve a conflict inside one statement.
  const deduped = new Map<number, NormalizedFix>()
  for (const fix of normalized) deduped.set(fix.recordedAt.getTime(), fix)
  const fixes = [...deduped.values()]
  rejected += normalized.length - fixes.length

  const inserted = await db
    .insert(locationPoints)
    .values(
      fixes.map((fix) => ({
        userId: options.userId,
        deviceId: options.deviceId,
        recordedAt: fix.recordedAt,
        lat: fix.lat,
        lon: fix.lon,
        accuracyMeters: fix.accuracyMeters,
        altitudeMeters: fix.altitudeMeters,
        altitudeAccuracyMeters: fix.altitudeAccuracyMeters,
        speedMps: fix.speedMps,
        headingDegrees: fix.headingDegrees,
        activity: fix.activity,
        batteryLevel: fix.batteryLevel,
        isCharging: fix.isCharging,
        isMoving: fix.isMoving,
        source: fix.source,
      })),
    )
    // A retry is free, and so is the one re-report that matters. The park fix
    // is taken in the same tick as the fix that settled the phone, and Android
    // hands back the cached position with the same timestamp, so the only fix
    // that ever says "still" collided with the one before it and was dropped.
    // A stop re-reported at the same instant adopts the word; nothing else
    // about the fix is rewritten, and no other re-report is.
    .onConflictDoUpdate({
      target: [locationPoints.userId, locationPoints.deviceId, locationPoints.recordedAt],
      set: { activity: sql`excluded.activity`, source: sql`excluded.source` },
      setWhere: sql`excluded.activity = 'still'`,
    })
    .returning({
      id: locationPoints.id,
      recordedAt: locationPoints.recordedAt,
      adopted: sql<boolean>`(xmax <> 0)`,
    })

  const idByTime = new Map(inserted.map((row) => [row.recordedAt.getTime(), row.id]))
  const latest = fixes[fixes.length - 1]!
  // A stop adopted onto an existing fix is not a new position: it enters the
  // presence row below and nothing else.
  const newTimes = new Set(
    inserted.filter((row) => !row.adopted).map((row) => row.recordedAt.getTime()),
  )
  const latestLanded = idByTime.has(latest.recordedAt.getTime())

  // Read before the upsert below overwrites it. The alerts need the state as
  // it stood when this batch arrived, and the stored timestamp is what tells
  // them whether this batch is the newest one.
  const [presence] = await db
    .select({
      recordedAt: userPresence.recordedAt,
      incidentFlaggedAt: userPresence.incidentFlaggedAt,
      lowBatteryNotifiedAt: userPresence.lowBatteryNotifiedAt,
      lowBatteryNotifiedLevel: userPresence.lowBatteryNotifiedLevel,
    })
    .from(userPresence)
    .where(eq(userPresence.userId, options.userId))
    .limit(1)

  const offlineCutoff = new Date(now.getTime() - DEFAULTS.offlineAfterSeconds * 1000)

  await db
    .insert(userPresence)
    .values({
      userId: options.userId,
      lastPointId: idByTime.get(latest.recordedAt.getTime()) ?? null,
      lat: latest.lat,
      lon: latest.lon,
      accuracyMeters: latest.accuracyMeters,
      recordedAt: latest.recordedAt,
      speedMps: latest.speedMps,
      headingDegrees: latest.headingDegrees,
      activity: latest.activity,
      batteryLevel: latest.batteryLevel,
      isCharging: latest.isCharging,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userPresence.userId,
      set: {
        lastPointId: sql`coalesce(excluded.last_point_id, ${userPresence.lastPointId})`,
        lat: sql`excluded.lat`,
        lon: sql`excluded.lon`,
        accuracyMeters: sql`excluded.accuracy_meters`,
        recordedAt: sql`excluded.recorded_at`,
        speedMps: sql`excluded.speed_mps`,
        headingDegrees: sql`excluded.heading_degrees`,
        activity: sql`excluded.activity`,
        batteryLevel: sql`excluded.battery_level`,
        isCharging: sql`excluded.is_charging`,
        // Only a fix that is itself current re-arms the offline sweep. A phone
        // whose clock runs slow uploads perfectly well yet always looks overdue
        // to the sweep, and clearing the latch for it would push "phone
        // offline" on every scheduler tick for as long as the skew lasts.
        offlineNotifiedAt: sql`case when excluded.recorded_at > ${offlineCutoff.toISOString()}::timestamptz then null else ${userPresence.offlineNotifiedAt} end`,
        updatedAt: sql`excluded.updated_at`,
      },
      // An out-of-order retry must never rewind "where are they now". The
      // same instant is not a rewind: a stop re-reported on the settle fix's
      // timestamp has to reach the row, or the sweep goes on judging a phone
      // parked at Home by the rule for one last seen on the road. Only a
      // re-report the history insert took gets that far, so a retried copy
      // of the older word cannot undo the stop.
      setWhere: sql`${userPresence.recordedAt} is null
        or ${userPresence.recordedAt} < excluded.recorded_at
        or (${userPresence.recordedAt} = excluded.recorded_at and ${latestLanded})`,
    })

  // A buffered or retried upload can be older than the presence row it lost
  // to. The upsert already refuses to rewind, and the alerts have to refuse
  // too, or a stale 4% reading raises "low battery" about a phone that has
  // been on the charger for hours.
  const isCurrent =
    !presence?.recordedAt || presence.recordedAt.getTime() < latest.recordedAt.getTime()

  // That refusal leaves the whole row alone, updated_at included, so a phone
  // that lands after a day abroad and drains a queue of yesterday's fixes has
  // nothing anywhere that says it is back. The scheduler's scan for a member
  // worth looking at is what reads this.
  if (!isCurrent) {
    await db
      .update(userPresence)
      .set({ updatedAt: now })
      .where(eq(userPresence.userId, options.userId))
  }

  // Only genuinely new fixes enter the geofence replay. A retried batch or an
  // out-of-order straggler must not re-derive transitions the circle has
  // already been told about.
  const freshFixes = fixes.filter((fix) => newTimes.has(fix.recordedAt.getTime()))

  await resumeExpiredPauses(db, options.userId, now)
  const sharing = await sharingStateByCircle(db, options.userId, now)

  const transitions = await evaluateGeofenceBatch(
    db,
    options.userId,
    freshFixes.map((fix) => ({
      lat: fix.lat,
      lon: fix.lon,
      accuracyMeters: fix.accuracyMeters,
      recordedAt: fix.recordedAt,
      pointId: idByTime.get(fix.recordedAt.getTime()) ?? null,
    })),
    {
      visibleCircleIds: [...sharing.entries()].filter(([, s]) => s === "precise").map(([id]) => id),
      now,
    },
  )

  // Newest the server has seen is not the same as recent. A phone flushing a
  // weekend of queued fixes passes that test on its oldest batch first, so the
  // alerts need the wall clock as well. History, presence and the geofence
  // replay still take the old batch.
  const isRecent = now.getTime() - latest.recordedAt.getTime() < DEFAULTS.staleAfterSeconds * 1000

  // The drive belongs to the device. The member row moves with whichever
  // device uploaded last, so a tablet on the kitchen table landing its fix a
  // moment after the phone's batch would make the phone's fast run "not
  // current" and the alert would never fire. The device's own history
  // decides whether this batch is its newest word.
  const deviceCurrent =
    isCurrent ||
    (freshFixes.length > 0 &&
      (
        await db
          .select({ id: locationPoints.id })
          .from(locationPoints)
          .where(
            and(
              eq(locationPoints.userId, options.userId),
              eq(locationPoints.deviceId, options.deviceId),
              gt(locationPoints.recordedAt, latest.recordedAt),
            ),
          )
          .limit(1)
      ).length === 0)

  if (isCurrent || deviceCurrent) {
    const alertCircleIds = [...sharing.entries()]
      .filter(([, state]) => state !== "paused")
      .map(([id]) => id)
    const alertCircles: AlertCircle[] =
      alertCircleIds.length > 0
        ? await db
            .select({ id: circles.id, settings: circles.settings })
            .from(circles)
            .where(inArray(circles.id, alertCircleIds))
        : []

    if (deviceCurrent) {
      await maybeRaiseDrivingAlerts(
        db,
        options.userId,
        options.deviceId,
        freshFixes,
        now,
        alertCircles.filter((circle) => sharing.get(circle.id) === "precise"),
        presence,
        isRecent,
      )
    }
    // A battery reading keeps its meaning until the phone counts as offline.
    // The presence window is shorter because it is about where somebody is, and
    // a phone that has said nothing since it reported 4 percent is the case the
    // family most wants to hear about.
    const batteryStillMeansSomething =
      now.getTime() - latest.recordedAt.getTime() < DEFAULTS.offlineAfterSeconds * 1000
    if (isCurrent && batteryStillMeansSomething) {
      await maybeRaiseBatteryAlert(db, options.userId, latest, now, alertCircles)
    }
  }

  await broadcastPresence(db, options.userId, [...sharing.keys()])

  return { accepted: inserted.length, rejected, placeEvents: transitions.length }
}

/**
 * The unprojected row travels on the server-internal bus. Every socket
 * projects it for its own viewer, so precise, approximate and paused all come
 * out of one query no matter how many sockets are listening.
 */
export async function broadcastPresence(
  db: Database,
  userId: string,
  circleIds?: string[],
): Promise<void> {
  const bus = getBus()
  if (!bus) return

  const ids =
    circleIds ??
    (
      await db
        .select({ circleId: circleMembers.circleId })
        .from(circleMembers)
        .where(eq(circleMembers.userId, userId))
    ).map((row) => row.circleId)

  const byCircle = await loadRawPresenceByCircle(db, userId, ids)
  for (const [circleId, raw] of byCircle) {
    await bus.publish(circleTopic(circleId), {
      type: "location",
      circleId,
      userId,
      raw,
    })
  }
}

/**
 * Both alerts are per-circle opt-ins, and both reach only circles the member
 * shares precisely with. Telling a circle "they were doing 140" is precise
 * information about someone who chose to be approximate.
 *
 * The incident check is a prompt to check on someone, not a crash detector.
 * Fixes 30 seconds apart cannot tell a collision from parking hard, so it is
 * off by default and named for what it can actually claim.
 */
async function maybeRaiseDrivingAlerts(
  db: Database,
  userId: string,
  deviceId: string,
  fixes: NormalizedFix[],
  now: Date,
  preciseCircles: AlertCircle[],
  presence: AlertPresence | undefined,
  /** Whether this batch still describes the present, or replays a drained queue. */
  isLive: boolean,
): Promise<void> {
  if (fixes.length === 0) return

  const speedCircles = preciseCircles.filter((row) => (row.settings.speedAlertKmh ?? 0) > 0)
  const incidentCircles = preciseCircles.filter((row) => row.settings.incidentDetection)
  if (speedCircles.length === 0 && incidentCircles.length === 0) return

  const [actor] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const name = actor?.displayName ?? "Someone"

  const sorted = [...fixes].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
  const latest = sorted[sorted.length - 1]!

  if (speedCircles.length > 0) {
    const lowestThresholdKmh = Math.min(...speedCircles.map((row) => row.settings.speedAlertKmh))

    // The run belongs to the phone in the car. Carried on the member row it
    // belonged to whichever device uploaded last, so a tablet on the kitchen
    // table reporting 0 m/s between the phone's uploads broke the streak every
    // time and a household with two devices was never told about a fast drive
    // at all. Reading the device's own tail instead costs one bounded query and
    // is the same fixes the loop below would have seen in one batch.
    const runFrom = new Date(sorted[0]!.recordedAt.getTime() - DEFAULTS.staleAfterSeconds * 1000)
    const priorFixes = (
      await db
        .select({
          recordedAt: locationPoints.recordedAt,
          lat: locationPoints.lat,
          lon: locationPoints.lon,
          accuracyMeters: locationPoints.accuracyMeters,
          speedMps: locationPoints.speedMps,
          activity: locationPoints.activity,
        })
        .from(locationPoints)
        .where(
          and(
            eq(locationPoints.userId, userId),
            eq(locationPoints.deviceId, deviceId),
            gte(locationPoints.recordedAt, runFrom),
            lt(locationPoints.recordedAt, sorted[0]!.recordedAt),
          ),
        )
        .orderBy(desc(locationPoints.recordedAt))
        .limit(SPEED_RUN_MAX_PRIOR_FIXES)
    ).reverse()

    // A run is a streak of over-threshold fixes, with whatever measured no
    // speed in between: a cell-derived fix reports none mid-drive, and it
    // confirms nothing, but reading it as a zero would break a run the car
    // never came out of. The run that satisfied the streak rule decides both
    // the speed reported and which circles hear it, through the same rule the
    // trip card uses, so the family is never told a number the card denies.
    let streak = 0
    let run: RunFix[] = []

    let alertPeakMps = 0
    // What the phone called the run, and when the run ended. The alert is
    // about that stretch, so it is worded and dated from it rather than from
    // whatever the batch happened to end with.
    let runActivities = new Set<ActivityType>()
    let runEndAt: Date | null = null
    let alertActivities = new Set<ActivityType>()
    let alertAt: Date | null = null
    const closeRun = () => {
      if (streak < DEFAULTS.speedAlertConsecutiveFixes) return
      const runPeakMps = agreedMaxSpeedMps(run, DEFAULTS.staleAfterSeconds * 1000) ?? 0
      if (runPeakMps > alertPeakMps) {
        alertPeakMps = runPeakMps
        alertActivities = new Set(runActivities)
        alertAt = runEndAt
      }
    }

    // The timestamps apply the gap rule: a gap means that run ended, or one
    // fast fix on Friday and another on Monday add up to a streak.
    let previousAt: number | null = null

    const breakRun = () => {
      closeRun()
      streak = 0
      run = []
      runActivities = new Set()
      runEndAt = null
    }

    const runFixes: RunFix[] = [...priorFixes, ...sorted]
    for (const fix of runFixes) {
      const recordedAt = fix.recordedAt.getTime()
      if (previousAt !== null && recordedAt - previousAt >= DEFAULTS.staleAfterSeconds * 1000) {
        breakRun()
      }
      previousAt = recordedAt

      const speedMps = fix.speedMps
      if (speedMps == null) {
        if (streak > 0) run.push(fix)
        continue
      }

      if (speedMps * 3.6 > lowestThresholdKmh) {
        streak += 1
        run.push(fix)
        // A fix with no label at all is not a dissenting opinion about how the
        // run was travelling, so it does not force the wording back to driving.
        if (fix.activity) runActivities.add(fix.activity)
        runEndAt = fix.recordedAt
      } else {
        breakRun()
      }
    }
    // A run that ended before the batch did still happened. Testing only the
    // streak left standing at the end drops every drive that finishes at a
    // traffic light, which is most of them.
    closeRun()

    // The emit test uses the same un-rounded speed as the streak, and the
    // cooldown is only spent when a circle is actually told. Otherwise
    // 50.4 km/h against a 50 km/h threshold buys half an hour of silence and
    // notifies nobody.
    const overThreshold = speedCircles.filter(
      (circle) => alertPeakMps * 3.6 > circle.settings.speedAlertKmh,
    )

    let telling: AlertCircle[] = []
    if (overThreshold.length > 0 && !isLive) {
      // A backlog replays a run into the feed without pushing, so it must not
      // spend the cooldown the live part of the same drive will need. It only
      // has to avoid writing the same run twice as its batches arrive.
      const happenedAt = (alertAt ?? latest.recordedAt).getTime()
      const windowMs = DEFAULTS.speedAlertCooldownSeconds * 1000
      const already = await db
        .select({ circleId: events.circleId })
        .from(events)
        .where(
          and(
            eq(events.actorUserId, userId),
            eq(events.type, "speed_alert"),
            inArray(
              events.circleId,
              overThreshold.map((circle) => circle.id),
            ),
            gt(events.occurredAt, new Date(happenedAt - windowMs)),
            lt(events.occurredAt, new Date(happenedAt + windowMs)),
          ),
        )
      const written = new Set(already.map((row) => row.circleId))
      telling = overThreshold.filter((circle) => !written.has(circle.id))
    } else if (overThreshold.length > 0) {
      const cooldownStart = new Date(now.getTime() - DEFAULTS.speedAlertCooldownSeconds * 1000)
      const circleIds = sql.join(
        overThreshold.map((circle) => sql`${circle.id}::uuid`),
        sql`, `,
      )
      // Claiming the cooldown is the emit decision, so it is one statement:
      // read the latch first and two devices flushing the same run both pass a
      // latch neither has spent yet.
      //
      // The latch that matters is the per-circle one, because the threshold is
      // per circle and so is sharing. A circle that was paused for the last run,
      // or whose own stricter threshold this drive is the first ever to cross,
      // has been told nothing and has no cooldown to be inside. The member row
      // is still read under a lock and still moves: it is what serialises two
      // devices, and an aged member window releases every circle at once.
      const claimed = (await db.execute(sql`
        with previous as (
          select speed_alerted_at as at
          from user_presence
          where user_id = ${userId}::uuid
          for update
        ),
        member as (
          update user_presence
          set speed_alerted_at = ${now.toISOString()}::timestamptz
          where user_id = ${userId}::uuid
          returning user_id
        )
        update circle_members
        set speed_alerted_at = ${now.toISOString()}::timestamptz
        from previous
        where circle_members.user_id = ${userId}::uuid
          and circle_members.circle_id in (${circleIds})
          and (circle_members.speed_alerted_at is null
               or circle_members.speed_alerted_at < ${cooldownStart.toISOString()}::timestamptz
               or previous.at is null
               or previous.at < ${cooldownStart.toISOString()}::timestamptz)
        returning circle_members.circle_id as circle_id
      `)) as unknown as Array<{ circle_id: string }>
      const claimedIds = new Set(claimed.map((row) => row.circle_id))
      telling = overThreshold.filter((circle) => claimedIds.has(circle.id))
    }

    if (telling.length > 0) {
      const peakKmh = Math.round(alertPeakMps * 3.6)
      const label = alertActivities.size === 1 ? [...alertActivities][0]! : undefined
      const verb = label ? TRAVEL_VERBS[plausibleActivity(label, alertPeakMps)] : undefined
      const wording = `${name} was ${verb ?? "driving"} at ${peakKmh} km/h`
      const happenedAt = alertAt ?? latest.recordedAt
      for (const circle of telling) {
        await recordEvent(db, {
          circleId: circle.id,
          type: "speed_alert",
          actorUserId: userId,
          occurredAt: happenedAt,
          payload: {
            speedKmh: peakKmh,
            thresholdKmh: circle.settings.speedAlertKmh,
            at: happenedAt.toISOString(),
          },
          summary: wording,
          // A queue that drained an hour late replays a run that really
          // happened, and it belongs in the feed at the time it happened.
          // Buzzing a parent about it now would say the car is doing 150
          // while it is on a driveway.
          notify: isLive
            ? { title: "Speed alert", body: `${wording}.`, channel: "alerts" }
            : undefined,
        })
      }
    }

    // Left on the member row as a record of where the run stands, and no longer
    // read back by anything. The run above is rebuilt from the driving device's
    // own history each time, so a tablet uploading beside the phone can no
    // longer wipe a count the next alert depends on.
    await db
      .update(userPresence)
      .set({ overSpeedCount: telling.length > 0 ? 0 : streak })
      .where(eq(userPresence.userId, userId))
  }

  // Everything below is a claim about right now: they stopped hard and have not
  // moved since. A backlog says nothing about the present, and the stop it
  // describes was over before the queue drained.
  if (!isLive) return
  if (incidentCircles.length === 0) return
  const alreadyFlagged =
    presence?.incidentFlaggedAt &&
    now.getTime() - presence.incidentFlaggedAt.getTime() < INCIDENT_COOLDOWN_MS
  if (alreadyFlagged) return

  // A null speed is an unknown speed, not a measured zero. The platform sends
  // it whenever it has no Doppler to offer, which is most of what a phone
  // reports from a tunnel or a car park, so only a speed the device actually
  // measured can rule the stop out here. Everything else is settled from
  // position below.
  if ((latest.speedMps ?? 0) > DEFAULTS.incidentStoppedSpeedMps) return

  // A heartbeat is the app asking where a parked phone is, on a timer, while
  // somebody looks at the map. It says nothing about how the phone came to a
  // stop, so it neither anchors this check nor counts towards the stillness.
  // Otherwise a car pulling onto the drive with the app on the mount reads as
  // three minutes of not having moved, right behind the fixes that had it at
  // road speed a minute earlier, and every ordinary arrival becomes an alert.
  if (latest.source === "heartbeat") return

  const windowStart = new Date(
    latest.recordedAt.getTime() - DEFAULTS.incidentDecelerationWindowSeconds * 1000,
  )

  // One device's own history. The stop and the speed it came off have to be the
  // same phone, or a tablet on the kitchen table supplies the stillness for a
  // car that is still on the motorway. Read newest first so the limit keeps the
  // fixes nearest the stop, then flip it: everything below reads forwards.
  const windowFixes = (
    await db
      .select({
        recordedAt: locationPoints.recordedAt,
        speedMps: locationPoints.speedMps,
        lat: locationPoints.lat,
        lon: locationPoints.lon,
        accuracyMeters: locationPoints.accuracyMeters,
      })
      .from(locationPoints)
      .where(
        and(
          eq(locationPoints.userId, userId),
          eq(locationPoints.deviceId, deviceId),
          gte(locationPoints.recordedAt, windowStart),
          lte(locationPoints.recordedAt, latest.recordedAt),
          ne(locationPoints.source, "heartbeat"),
        ),
      )
      .orderBy(desc(locationPoints.recordedAt))
      .limit(INCIDENT_WINDOW_MAX_FIXES)
  ).reverse()
  if (windowFixes.length < 2) return

  // Two fixes are only in different places if they are further apart than the
  // pair of error circles they sit in. Under that, the phone has not been shown
  // to have moved, and above it, it has.
  const movedBetween = (a: (typeof windowFixes)[number], b: (typeof windowFixes)[number]) =>
    haversineMeters(a, b) > (a.accuracyMeters ?? 0) + (b.accuracyMeters ?? 0)
  // A fix that cannot place someone inside a city block is the fix a phone
  // reports from a tunnel or an underground car park. It is not thrown away:
  // whether it moved is decided by `movedBetween` on its own error bars, so
  // 6 km of tunnel is still movement and five metres is still stillness. What
  // it may not do is supply a number of its own. Same bar the geofence sets
  // before it will act on a fix at all.
  const believable = (fix: (typeof windowFixes)[number]) =>
    fix.accuracyMeters == null || fix.accuracyMeters <= DEFAULTS.geofenceMaxAccuracyMeters

  let lastMovingIndex = -1
  for (let i = 0; i < windowFixes.length; i += 1) {
    const speed = windowFixes[i]!.speedMps
    if (speed != null && speed > DEFAULTS.incidentStoppedSpeedMps) lastMovingIndex = i
  }
  if (lastMovingIndex < 0 || lastMovingIndex === windowFixes.length - 1) return

  // Movement between two fixes belongs to the interval, not to the fix that
  // ended it, so the earliest the stillness can have begun is the later of the
  // two. Without this a drive on cell coverage, which reports no speed at all,
  // reads as three minutes of not having moved while the car covers six
  // kilometres of tunnel.
  let stillFromIndex = lastMovingIndex + 1
  for (let i = stillFromIndex + 1; i < windowFixes.length; i += 1) {
    if (movedBetween(windowFixes[i - 1]!, windowFixes[i]!)) stillFromIndex = i
  }

  const stillFor = latest.recordedAt.getTime() - windowFixes[stillFromIndex]!.recordedAt.getTime()
  if (stillFor < DEFAULTS.incidentStillnessSeconds * 1000) return

  const settled = windowFixes.slice(stillFromIndex)
  const stopFix = settled[0]
  const stillTo = settled[settled.length - 1]
  if (!stopFix || !stillTo) return
  if (movedBetween(stopFix, stillTo)) return

  // "Stopped suddenly" has to be true of the stop itself, not only of the fast
  // stretch somewhere behind it. An arrival decelerates through this band and a
  // collision does not.
  const lastMoving = windowFixes[lastMovingIndex]!
  const stopBarMps = settled.some(believable)
    ? INCIDENT_MOVING_AT_STOP_MPS
    : INCIDENT_MOVING_AT_COARSE_STOP_MPS
  if ((lastMoving.speedMps ?? 0) < stopBarMps) return

  // And the stop has to have come off real speed. A second fix agreeing is the
  // strongest form of that, and a neighbour that measured something slower is a
  // contradiction: the parked phone emitting one impossible sample between two
  // measured zeroes is the case this exists for. A neighbour that measured
  // nothing contradicts nothing, and at the mouth of a tunnel that lone reading
  // is the only speed anybody will ever have. The search ends at the stop, so a
  // fix taken after it can never supply the speed the stop is blamed on.
  let fromMps = 0
  for (let i = 0; i <= lastMovingIndex; i += 1) {
    const fix = windowFixes[i]!
    if (fix.speedMps == null || !believable(fix)) continue
    const before = i > 0 ? windowFixes[i - 1]!.speedMps : null
    const after = i + 1 < windowFixes.length ? windowFixes[i + 1]!.speedMps : null
    const supported =
      before == null && after == null
        ? fix.speedMps
        : Math.max(
            agreedSpeedMps(before, fix.speedMps) ?? 0,
            agreedSpeedMps(fix.speedMps, after) ?? 0,
          )
    if (supported > fromMps) fromMps = supported
  }
  if (fromMps < DEFAULTS.incidentMinSpeedMps) return

  // Claiming the cooldown is the emit decision, the same way the speed alert
  // above claims its own. Read it first and two devices reporting the same stop
  // both pass a latch neither has spent yet.
  const claimed = await db
    .update(userPresence)
    .set({ incidentFlaggedAt: now })
    .where(
      and(
        eq(userPresence.userId, userId),
        or(
          isNull(userPresence.incidentFlaggedAt),
          lt(userPresence.incidentFlaggedAt, new Date(now.getTime() - INCIDENT_COOLDOWN_MS)),
        ),
      ),
    )
    .returning({ userId: userPresence.userId })
  if (claimed.length === 0) return

  const fromKmh = Math.round(fromMps * 3.6)
  for (const circle of incidentCircles) {
    await recordEvent(db, {
      circleId: circle.id,
      type: "possible_incident",
      actorUserId: userId,
      payload: { fromSpeedKmh: fromKmh, at: latest.recordedAt.toISOString() },
      summary: `${name} stopped suddenly after driving at ${fromKmh} km/h`,
      notify: {
        title: `Check on ${name}`,
        body: `They stopped suddenly after driving at ${fromKmh} km/h and have not moved since.`,
        channel: "sos",
        priority: "high",
      },
    })
  }
}

export async function sharingStateByCircle(
  db: Database,
  userId: string,
  now: Date,
): Promise<Map<string, "precise" | "approximate" | "paused">> {
  const rows = await db
    .select({
      circleId: circleMembers.circleId,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      resumeToState: circleMembers.resumeToState,
    })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId))
  return new Map(
    rows.map((row) => [
      row.circleId,
      effectiveSharingState(row.sharingState, row.pausedUntil, now, row.resumeToState),
    ]),
  )
}

async function maybeRaiseBatteryAlert(
  db: Database,
  userId: string,
  latest: NormalizedFix,
  now: Date,
  activeCircles: AlertCircle[],
): Promise<void> {
  if (activeCircles.length === 0) return
  const level = latest.batteryLevel
  if (level == null) return

  const thresholdFor = (circle: AlertCircle) =>
    circle.settings.lowBatteryThreshold ?? DEFAULTS.lowBatteryThreshold
  const lowCircles =
    latest.isCharging === true
      ? []
      : activeCircles.filter((circle) => level <= thresholdFor(circle))

  if (lowCircles.length === 0) {
    // Reset only after a real recovery, so the next drain can alert again. The
    // band is capped at a full battery: a high enough threshold would otherwise
    // put recovery above any level a phone can report, latching the alert off
    // for good.
    const recovered = activeCircles.every(
      (circle) => level >= Math.min(thresholdFor(circle) + 0.1, 1),
    )
    if (recovered) {
      // Both latches, or the next drain is announced to nobody: the per-circle
      // rows are what the claim below reads, and a stale one reads as "already
      // told" for a drain that has not happened yet.
      await db
        .update(userPresence)
        .set({ lowBatteryNotifiedAt: null, lowBatteryNotifiedLevel: null })
        .where(eq(userPresence.userId, userId))
      await db
        .update(circleMembers)
        .set({ lowBatteryNotifiedAt: null, lowBatteryNotifiedLevel: null })
        .where(eq(circleMembers.userId, userId))
    }
    return
  }

  // Each circle carries its own latch. A user-level one is spent by whichever
  // circle is told first, so a circle that was paused at that moment, or whose
  // threshold is stricter, hears nothing for the rest of the drain. The claim
  // is the emit decision and it reads what it claims, so two devices flushing
  // together cannot both pass a latch neither has spent.
  const cooldownStart = new Date(now.getTime() - LOW_BATTERY_COOLDOWN_MS)
  const claimed = (await db.execute(sql`
    update circle_members
    set low_battery_notified_at = ${now.toISOString()}::timestamptz,
        low_battery_notified_level = ${level}::real
    where user_id = ${userId}::uuid
      and circle_id in (${sql.join(
        lowCircles.map((circle) => sql`${circle.id}::uuid`),
        sql`, `,
      )})
      and (low_battery_notified_at is null
           or low_battery_notified_at < ${cooldownStart.toISOString()}::timestamptz)
    returning circle_id
  `)) as unknown as Array<{ circle_id: string }>
  if (claimed.length === 0) return

  // Kept in step so the recovery reset above still has something to clear.
  await db
    .update(userPresence)
    .set({ lowBatteryNotifiedAt: now, lowBatteryNotifiedLevel: level })
    .where(eq(userPresence.userId, userId))

  const told = new Set(claimed.map((row) => row.circle_id))
  const notifyCircles = lowCircles.filter((circle) => told.has(circle.id))

  // Each notification stands on its own in the tray. "Their phone" under a
  // title that names nobody read as a riddle next to the others.
  const [subject] = await db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const name = subject?.displayName ?? "Someone"
  const percent = Math.round(level * 100)
  for (const circle of notifyCircles) {
    await recordEvent(db, {
      circleId: circle.id,
      type: "low_battery",
      actorUserId: userId,
      payload: { batteryLevel: level },
      summary: `Battery at ${percent}%`,
      notify: {
        title: `${name}'s battery is low`,
        body: `${name}'s phone is at ${percent}%.`,
        channel: "alerts",
        group: phoneGroup(userId, name, `Battery at ${percent}%`),
      },
    })
  }
}

export async function resumeExpiredPauses(db: Database, userId: string, now: Date): Promise<void> {
  const expired = await db
    .update(circleMembers)
    .set({
      sharingState: sql`coalesce(${circleMembers.resumeToState}, 'precise')`,
      preciseSince: preciseSinceOnLapse,
      pausedUntil: null,
      resumeToState: null,
    })
    .where(
      and(
        eq(circleMembers.userId, userId),
        eq(circleMembers.sharingState, "paused"),
        lte(circleMembers.pausedUntil, now),
      ),
    )
    .returning({ circleId: circleMembers.circleId })

  if (expired.length > 0) {
    // The fence stopped being evaluated for this circle while the pause ran, so
    // its rows describe wherever the member was when it started. Picking up
    // from there would replay a crossing nobody was allowed to see, and the
    // family would be told about a departure hours after it happened.
    await db.execute(sql`
      update place_memberships pm
      set last_evaluated_at = greatest(pm.last_evaluated_at, up.recorded_at)
      from user_presence up
      where up.user_id = ${userId}::uuid
        and pm.user_id = ${userId}::uuid
        and up.recorded_at is not null
        and pm.place_id in (
          select id from places where circle_id in (${sql.join(
            expired.map((row) => sql`${row.circleId}::uuid`),
            sql`, `,
          )})
        )
    `)
  }

  for (const row of expired) {
    await recordEvent(db, {
      circleId: row.circleId,
      type: "sharing_resumed",
      actorUserId: userId,
      summary: "Resumed sharing location",
    })
  }
}
