import { DEFAULTS, coarsenLocation, type MemberPresence, type SharingState } from "@hearth/shared"
import { and, eq, isNull } from "drizzle-orm"

import type { Database } from "../db/client"
import { circleMembers, placeMemberships, places, sosAlerts, userPresence } from "../db/schema"

export function effectiveSharingState(
  state: SharingState,
  pausedUntil: Date | null,
  now: Date,
): SharingState {
  if (state !== "paused") return state
  // A pause with an expiry lapses on read, so the read path needs no write.
  if (pausedUntil && pausedUntil.getTime() <= now.getTime()) return "precise"
  return "paused"
}

export interface PresenceRow {
  userId: string
  sharingState: SharingState
  pausedUntil: Date | null
  lat: number | null
  lon: number | null
  accuracyMeters: number | null
  recordedAt: Date | null
  batteryLevel: number | null
  isCharging: boolean | null
  activity: MemberPresence["activity"]
  speedMps: number | null
  headingDegrees: number | null
}

export function projectPresence(
  row: PresenceRow,
  viewerId: string,
  extras: {
    atPlace: MemberPresence["atPlace"]
    sosAlertId: string | null
    now?: Date
  },
): MemberPresence {
  const now = extras.now ?? new Date()
  const isSelf = row.userId === viewerId
  const state = isSelf ? "precise" : effectiveSharingState(row.sharingState, row.pausedUntil, now)

  const hasFix = row.lat != null && row.lon != null
  const stale =
    !row.recordedAt || now.getTime() - row.recordedAt.getTime() > DEFAULTS.staleAfterSeconds * 1000

  if (state === "paused" || !hasFix) {
    return {
      userId: row.userId,
      lat: null,
      lon: null,
      accuracyMeters: null,
      recordedAt: state === "paused" ? null : (row.recordedAt?.toISOString() ?? null),
      batteryLevel: state === "paused" ? null : row.batteryLevel,
      isCharging: state === "paused" ? null : row.isCharging,
      activity: null,
      speedMps: null,
      headingDegrees: null,
      approximate: false,
      sharingState: state,
      stale: state === "paused" ? false : stale,
      atPlace: state === "paused" ? null : extras.atPlace,
      sosAlertId: extras.sosAlertId,
    }
  }

  const approximate = state === "approximate"
  const point = approximate
    ? coarsenLocation({ lat: row.lat!, lon: row.lon! })
    : { lat: row.lat!, lon: row.lon! }

  return {
    userId: row.userId,
    lat: point.lat,
    lon: point.lon,
    // Widening the accuracy circle keeps the UI honest about the fuzzing.
    accuracyMeters: approximate ? Math.max(row.accuracyMeters ?? 0, 750) : row.accuracyMeters,
    recordedAt: row.recordedAt?.toISOString() ?? null,
    batteryLevel: row.batteryLevel,
    isCharging: row.isCharging,
    activity: approximate ? null : row.activity,
    speedMps: approximate ? null : row.speedMps,
    headingDegrees: approximate ? null : row.headingDegrees,
    approximate,
    sharingState: state,
    stale,
    // "At Home" pins someone to a doorstep. That is precise information, so
    // viewers on the coarse grid do not get it.
    atPlace: approximate ? null : extras.atPlace,
    sosAlertId: extras.sosAlertId,
  }
}

export interface RawCirclePresence {
  rows: PresenceRow[]
  atPlaceByUser: Record<string, MemberPresence["atPlace"]>
  sosByUser: Record<string, string>
}

/**
 * The websocket layer fetches this once per bus message and projects it for
 * every connected viewer in memory, rather than re-querying per socket.
 */
export async function loadRawCirclePresence(
  db: Database,
  circleId: string,
  onlyUserId?: string,
): Promise<RawCirclePresence> {
  const rows = await db
    .select({
      userId: circleMembers.userId,
      sharingState: circleMembers.sharingState,
      pausedUntil: circleMembers.pausedUntil,
      lat: userPresence.lat,
      lon: userPresence.lon,
      accuracyMeters: userPresence.accuracyMeters,
      recordedAt: userPresence.recordedAt,
      batteryLevel: userPresence.batteryLevel,
      isCharging: userPresence.isCharging,
      activity: userPresence.activity,
      speedMps: userPresence.speedMps,
      headingDegrees: userPresence.headingDegrees,
    })
    .from(circleMembers)
    .leftJoin(userPresence, eq(userPresence.userId, circleMembers.userId))
    .where(
      and(
        eq(circleMembers.circleId, circleId),
        onlyUserId ? eq(circleMembers.userId, onlyUserId) : undefined,
      ),
    )

  const insideRows = await db
    .select({
      userId: placeMemberships.userId,
      placeId: places.id,
      placeName: places.name,
      placeIcon: places.icon,
    })
    .from(placeMemberships)
    .innerJoin(places, eq(places.id, placeMemberships.placeId))
    .where(
      and(
        eq(places.circleId, circleId),
        eq(placeMemberships.isInside, true),
        onlyUserId ? eq(placeMemberships.userId, onlyUserId) : undefined,
      ),
    )

  const atPlaceByUser: Record<string, MemberPresence["atPlace"]> = {}
  for (const row of insideRows) {
    if (!atPlaceByUser[row.userId]) {
      atPlaceByUser[row.userId] = { id: row.placeId, name: row.placeName, icon: row.placeIcon }
    }
  }

  const activeSos = await db
    .select({ id: sosAlerts.id, userId: sosAlerts.userId })
    .from(sosAlerts)
    .where(
      and(
        eq(sosAlerts.circleId, circleId),
        isNull(sosAlerts.resolvedAt),
        onlyUserId ? eq(sosAlerts.userId, onlyUserId) : undefined,
      ),
    )
  const sosByUser: Record<string, string> = {}
  for (const row of activeSos) sosByUser[row.userId] = row.id

  return { rows, atPlaceByUser, sosByUser }
}

/** Pure, so it is safe to call once per connected socket. */
export function projectCirclePresence(
  raw: RawCirclePresence,
  viewerId: string,
  now: Date = new Date(),
): MemberPresence[] {
  return raw.rows.map((row) =>
    projectPresence(
      // The JSON round trip through the bus turns these back into strings.
      {
        ...row,
        pausedUntil: row.pausedUntil ? new Date(row.pausedUntil) : null,
        recordedAt: row.recordedAt ? new Date(row.recordedAt) : null,
      },
      viewerId,
      {
        atPlace: raw.atPlaceByUser[row.userId] ?? null,
        sosAlertId: raw.sosByUser[row.userId] ?? null,
        now,
      },
    ),
  )
}

export async function getCirclePresence(
  db: Database,
  circleId: string,
  viewerId: string,
): Promise<MemberPresence[]> {
  return projectCirclePresence(await loadRawCirclePresence(db, circleId), viewerId)
}

export async function getMemberPresence(
  db: Database,
  circleId: string,
  userId: string,
  viewerId: string,
): Promise<MemberPresence | null> {
  const all = await getCirclePresence(db, circleId, viewerId)
  return all.find((entry) => entry.userId === userId) ?? null
}
