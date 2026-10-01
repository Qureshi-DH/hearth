import type {
  AdminAuditEntry,
  AdminCircleSummary,
  AdminOutboxEntry,
  AdminUserSummary,
  CircleRole,
  CurrentUser,
  FeedEvent,
  Place,
  PortalSession,
  PublicUser,
  SessionSummary,
  Trip,
} from "@hearth/shared"

import type {
  AuditRow,
  Circle as CircleRow,
  FeedEventRow,
  OutboxRow,
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

/** What the portal keeps of a session. The refresh token goes into a cookie instead. */
export function toPortalSession(session: PortalSession): PortalSession {
  return { accessToken: session.accessToken, expiresIn: session.expiresIn, user: session.user }
}

export function toAdminUserSummary(
  row: User,
  extras: { circleCount: number; deviceCount: number; longestSilenceSeconds: number | null },
): AdminUserSummary {
  return {
    ...toPublicUser(row),
    email: row.email,
    isAdmin: row.isAdmin,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: iso(row.lastSeenAt),
    ...extras,
  }
}

export function toAdminCircleSummary(
  row: Pick<CircleRow, "id" | "name" | "emoji" | "createdAt" | "settings">,
  members: Array<{ userId: string; displayName: string; role: CircleRole }>,
  placeCount: number,
): AdminCircleSummary {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    createdAt: row.createdAt.toISOString(),
    memberCount: members.length,
    placeCount,
    members,
    settings: {
      historyRetentionDays: row.settings.historyRetentionDays,
      allowHistory: row.settings.allowHistory,
      allowSharingPause: row.settings.allowSharingPause,
      speedAlertKmh: row.settings.speedAlertKmh,
      incidentDetection: row.settings.incidentDetection,
    },
  }
}

export function toAdminAuditEntry(row: AuditRow, names: Map<string, string>): AdminAuditEntry {
  const target = row.targetType === "user" && row.targetId ? row.targetId : null
  return {
    id: String(row.id),
    actorUserId: row.actorUserId,
    actorName: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    targetName: target ? (names.get(target) ?? null) : null,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Being a server admin is not being in every circle. The text of a
 * notification says where somebody arrived and what was said to them, so it
 * is shown only for the admin's own. The rest is enough to debug a provider.
 */
export function toAdminOutboxEntry(
  row: OutboxRow,
  userName: string | null,
  viewerId: string,
): AdminOutboxEntry {
  const own = row.userId === viewerId
  return {
    id: String(row.id),
    userId: row.userId,
    userName,
    title: own ? row.title : null,
    body: own ? row.body : null,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    sentAt: iso(row.sentAt),
  }
}
