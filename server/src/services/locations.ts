import {
  DEFAULTS,
  activityFromSpeed,
  isValidLatLng,
  type ActivityType,
  type LocationFixInput,
  type LocationSource,
} from "@hearth/shared"
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm"

import type { Database } from "../db/client"
import {
  circleMembers,
  circles,
  locationPoints,
  sosAlerts,
  userPresence,
  users,
  type CircleSettingsJson,
} from "../db/schema"
import { circleTopic } from "../lib/bus"
import { getBus } from "../runtime"
import { recordEvent } from "./feed"
import { evaluateGeofenceBatch } from "./geofence"
import { effectiveSharingState, loadRawPresenceByCircle } from "./presence"

/** Fixes older than this are almost certainly a buggy client clock. */
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000
/** Small tolerance for devices whose clock runs slightly fast. */
const MAX_FUTURE_MS = 5 * 60 * 1000
const LOW_BATTERY_COOLDOWN_MS = 6 * 60 * 60 * 1000

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
  speedAlertedAt: Date | null
  overSpeedCount: number
  incidentFlaggedAt: Date | null
  lowBatteryNotifiedAt: Date | null
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

  const clampFinite = (value: number | null | undefined, min: number, max: number) =>
    value == null || !Number.isFinite(value) ? null : Math.min(max, Math.max(min, value))

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
    .onConflictDoNothing({
      target: [locationPoints.userId, locationPoints.deviceId, locationPoints.recordedAt],
    })
    .returning({ id: locationPoints.id, recordedAt: locationPoints.recordedAt })

  const idByTime = new Map(inserted.map((row) => [row.recordedAt.getTime(), row.id]))
  const latest = fixes[fixes.length - 1]!

  // Read before the upsert below overwrites it. The alerts need the state as
  // it stood when this batch arrived, and the stored timestamp is what tells
  // them whether this batch is the newest one.
  const [presence] = await db
    .select({
      recordedAt: userPresence.recordedAt,
      speedAlertedAt: userPresence.speedAlertedAt,
      overSpeedCount: userPresence.overSpeedCount,
      incidentFlaggedAt: userPresence.incidentFlaggedAt,
      lowBatteryNotifiedAt: userPresence.lowBatteryNotifiedAt,
    })
    .from(userPresence)
    .where(eq(userPresence.userId, options.userId))
    .limit(1)

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
        lastPointId: sql`excluded.last_point_id`,
        lat: sql`excluded.lat`,
        lon: sql`excluded.lon`,
        accuracyMeters: sql`excluded.accuracy_meters`,
        recordedAt: sql`excluded.recorded_at`,
        speedMps: sql`excluded.speed_mps`,
        headingDegrees: sql`excluded.heading_degrees`,
        activity: sql`excluded.activity`,
        batteryLevel: sql`excluded.battery_level`,
        isCharging: sql`excluded.is_charging`,
        offlineNotifiedAt: sql`null`,
        updatedAt: sql`excluded.updated_at`,
      },
      // An out-of-order retry must never rewind "where are they now".
      setWhere: sql`${userPresence.recordedAt} is null or ${userPresence.recordedAt} < excluded.recorded_at`,
    })

  // Only genuinely new fixes enter the geofence replay. A retried batch or an
  // out-of-order straggler must not re-derive transitions the circle has
  // already been told about.
  const freshFixes = fixes.filter((fix) => idByTime.has(fix.recordedAt.getTime()))

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
    },
  )

  // A buffered or retried upload can be older than the presence row it lost
  // to. The upsert already refuses to rewind, and the alerts have to refuse
  // too, or a stale 4% reading raises "low battery" about a phone that has
  // been on the charger for hours.
  const isCurrent =
    !presence?.recordedAt || presence.recordedAt.getTime() < latest.recordedAt.getTime()

  if (isCurrent) {
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

    await maybeRaiseDrivingAlerts(
      db,
      options.userId,
      freshFixes,
      now,
      alertCircles.filter((circle) => sharing.get(circle.id) === "precise"),
      presence,
    )
    await maybeRaiseBatteryAlert(db, options.userId, latest, now, alertCircles, presence)
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
  fixes: NormalizedFix[],
  now: Date,
  preciseCircles: AlertCircle[],
  presence: AlertPresence | undefined,
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

  if (speedCircles.length > 0) {
    const lowestThresholdKmh = Math.min(...speedCircles.map((row) => row.settings.speedAlertKmh))
    let streak = presence?.overSpeedCount ?? 0
    let peakMps = 0

    for (const fix of fixes) {
      const kmh = (fix.speedMps ?? 0) * 3.6
      if (kmh > lowestThresholdKmh) {
        streak += 1
        peakMps = Math.max(peakMps, fix.speedMps ?? 0)
      } else {
        streak = 0
      }
    }

    const cooledDown =
      !presence?.speedAlertedAt ||
      now.getTime() - presence.speedAlertedAt.getTime() > DEFAULTS.speedAlertCooldownSeconds * 1000

    // The emit test uses the same un-rounded speed as the streak, and the
    // cooldown is only spent when a circle is actually told. Otherwise
    // 50.4 km/h against a 50 km/h threshold buys half an hour of silence and
    // notifies nobody.
    const overThreshold = speedCircles.filter(
      (circle) => peakMps * 3.6 > circle.settings.speedAlertKmh,
    )

    if (streak >= DEFAULTS.speedAlertConsecutiveFixes && cooledDown && overThreshold.length > 0) {
      const peakKmh = Math.round(peakMps * 3.6)
      await db
        .update(userPresence)
        .set({ speedAlertedAt: now, overSpeedCount: 0 })
        .where(eq(userPresence.userId, userId))

      for (const circle of overThreshold) {
        await recordEvent(db, {
          circleId: circle.id,
          type: "speed_alert",
          actorUserId: userId,
          payload: { speedKmh: peakKmh, thresholdKmh: circle.settings.speedAlertKmh },
          summary: `${name} was driving at ${peakKmh} km/h`,
          notify: {
            title: "Speed alert",
            body: `${name} was driving at ${peakKmh} km/h.`,
            channel: "alerts",
          },
        })
      }
    } else {
      await db
        .update(userPresence)
        .set({ overSpeedCount: streak })
        .where(eq(userPresence.userId, userId))
    }
  }

  if (incidentCircles.length === 0) return
  const alreadyFlagged =
    presence?.incidentFlaggedAt &&
    now.getTime() - presence.incidentFlaggedAt.getTime() < 60 * 60 * 1000
  if (alreadyFlagged) return

  const sorted = [...fixes].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
  const latest = sorted[sorted.length - 1]!
  if ((latest.speedMps ?? 0) > DEFAULTS.incidentStoppedSpeedMps) return

  const windowStart = new Date(
    latest.recordedAt.getTime() - DEFAULTS.incidentDecelerationWindowSeconds * 1000,
  )
  const [fastest] = await db
    .select({ speedMps: locationPoints.speedMps, recordedAt: locationPoints.recordedAt })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        gte(locationPoints.recordedAt, windowStart),
        lte(locationPoints.recordedAt, latest.recordedAt),
        gte(locationPoints.speedMps, DEFAULTS.incidentMinSpeedMps),
      ),
    )
    .orderBy(desc(locationPoints.speedMps))
    .limit(1)
  if (!fastest) return

  // A normal arrival keeps moving afterwards, on foot. Real stillness is the
  // other half of the signal.
  const stillnessSince = new Date(
    latest.recordedAt.getTime() - DEFAULTS.incidentStillnessSeconds * 1000,
  )
  const [moved] = await db
    .select({ id: locationPoints.id })
    .from(locationPoints)
    .where(
      and(
        eq(locationPoints.userId, userId),
        gte(locationPoints.recordedAt, stillnessSince),
        gte(locationPoints.speedMps, DEFAULTS.incidentStoppedSpeedMps),
      ),
    )
    .limit(1)
  if (moved) return

  await db
    .update(userPresence)
    .set({ incidentFlaggedAt: now })
    .where(eq(userPresence.userId, userId))

  const fromKmh = Math.round((fastest.speedMps ?? 0) * 3.6)
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
    })
    .from(circleMembers)
    .where(eq(circleMembers.userId, userId))
  return new Map(
    rows.map((row) => [
      row.circleId,
      effectiveSharingState(row.sharingState, row.pausedUntil, now),
    ]),
  )
}

async function maybeRaiseBatteryAlert(
  db: Database,
  userId: string,
  latest: NormalizedFix,
  now: Date,
  activeCircles: AlertCircle[],
  presence: AlertPresence | undefined,
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
    // Reset only after a real recovery, so the next drain can alert again.
    const recovered = activeCircles.every((circle) => level > thresholdFor(circle) + 0.1)
    if (presence?.lowBatteryNotifiedAt && recovered) {
      await db
        .update(userPresence)
        .set({ lowBatteryNotifiedAt: null })
        .where(eq(userPresence.userId, userId))
    }
    return
  }

  const lastNotified = presence?.lowBatteryNotifiedAt?.getTime() ?? 0
  if (now.getTime() - lastNotified < LOW_BATTERY_COOLDOWN_MS) return

  await db
    .update(userPresence)
    .set({ lowBatteryNotifiedAt: now })
    .where(eq(userPresence.userId, userId))

  const percent = Math.round(level * 100)
  for (const circle of lowCircles) {
    await recordEvent(db, {
      circleId: circle.id,
      type: "low_battery",
      actorUserId: userId,
      payload: { batteryLevel: level },
      summary: `Battery at ${percent}%`,
      notify: {
        title: "Low battery",
        body: `Their phone is at ${percent}%.`,
        channel: "alerts",
      },
    })
  }
}

export async function resumeExpiredPauses(db: Database, userId: string, now: Date): Promise<void> {
  const expired = await db
    .update(circleMembers)
    .set({
      sharingState: sql`coalesce(${circleMembers.resumeToState}, 'precise')`,
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

  for (const row of expired) {
    await recordEvent(db, {
      circleId: row.circleId,
      type: "sharing_resumed",
      actorUserId: userId,
      summary: "Resumed sharing location",
    })
  }
}

export async function activeSosFor(db: Database, userId: string) {
  return db
    .select()
    .from(sosAlerts)
    .where(and(eq(sosAlerts.userId, userId), isNull(sosAlerts.resolvedAt)))
}
