import type {
  CurrentUser,
  FeedEvent,
  Place,
  PublicUser,
  SessionSummary,
  Trip,
} from "@hearth/shared"

import type {
  FeedEventRow,
  Place as PlaceRow,
  Session as SessionRow,
  TripRow,
  User,
} from "../db/schema"

export const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null

export function toPublicUser(
  row: Pick<User, "id" | "displayName" | "avatarColor" | "avatarUrl">,
): PublicUser {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    avatarUrl: row.avatarUrl,
  }
}

export function toCurrentUser(row: User): CurrentUser {
  return {
    ...toPublicUser(row),
    email: row.email,
    isAdmin: row.isAdmin,
    locale: row.locale,
    units: row.units,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toSessionSummary(row: SessionRow, currentSessionId: string): SessionSummary {
  return {
    id: row.id,
    deviceName: row.deviceName,
    platform: row.platform ?? null,
    appVersion: row.appVersion,
    osVersion: row.osVersion,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    current: row.id === currentSessionId,
    pushEnabled: Boolean(row.pushToken),
  }
}

export function toFeedEvent(row: FeedEventRow, actor: PublicUser | null): FeedEvent {
  return {
    id: String(row.id),
    circleId: row.circleId,
    type: row.type,
    actor,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
    summary: row.summary,
  }
}

export function toPlace(
  row: PlaceRow,
  createdBy: PublicUser | null,
  membersInside: string[],
): Place {
  return {
    id: row.id,
    circleId: row.circleId,
    name: row.name,
    icon: row.icon,
    color: row.color,
    lat: row.lat,
    lon: row.lon,
    radiusMeters: row.radiusMeters,
    address: row.address,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy,
    membersInside,
  }
}

export function toTrip(
  row: TripRow,
  startPlaceName: string | null,
  endPlaceName: string | null,
): Trip {
  return {
    id: row.id,
    userId: row.userId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    distanceMeters: row.distanceMeters,
    durationSeconds: Math.max(
      0,
      Math.round((row.endedAt.getTime() - row.startedAt.getTime()) / 1000),
    ),
    maxSpeedMps: row.maxSpeedMps,
    avgSpeedMps: row.avgSpeedMps,
    pointCount: row.pointCount,
    startLat: row.startLat,
    startLon: row.startLon,
    endLat: row.endLat,
    endLon: row.endLon,
    startPlaceName,
    endPlaceName,
  }
}
